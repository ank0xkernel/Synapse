#!/usr/bin/env node
/**
 * Resume-grounding keyword coverage — focused test suite.
 *
 * Real interview-session bug report: the assistant answered a follow-up
 * question without any reference to the candidate's actual resume. Root
 * cause, found by reading prompts.js directly: buildRetrievedContextBlock()
 * has a hard gate --
 *
 *   if (classification === 'GENERAL_TECHNICAL') return '';
 *
 * -- and classification comes from detectResumeJdDomain()'s keyword list.
 * A completely natural interview follow-up like "give me an example, where
 * have you implemented React Native in your project?" or "have you used
 * this in production?" matched none of the old keywords ("implemented",
 * "used", "have you" were all absent), so it classified GENERAL_TECHNICAL
 * and retrieval was skipped entirely -- the model then answered from
 * general knowledge with nothing grounding it in the resume.
 *
 * Exercises the REAL production modules (prompts.js, interview-context.js,
 * conversation-tracker.js), same discipline as the Phase 6-9 suites: no
 * reimplementation, no live Gemini call, prompt STRUCTURE only.
 *
 * Run: node tests/test-resume-grounding-coverage.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const prompts = require(path.join(__dirname, '../src/services/ai/prompts.js'));
const interviewContext = require(path.join(__dirname, '../src/services/context/interview-context.js'));

const { createConversationTracker, formatActiveContextBlock } = await import(
  '../src/windows/assistant/renderer/features/auto-answer/conversation-tracker.js'
);

let passed = 0;
let failed = 0;
const failures = [];
let currentCategory = '';

function section(title) {
  currentCategory = title;
  console.log(`\n${title}`);
}
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ category: currentCategory, name, message: err.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}
function assertTrue(cond, msg) { if (!cond) throw new Error(msg || 'expected true'); }
function assertFalse(cond, msg) { if (cond) throw new Error(msg || 'expected false'); }
function normalizeWhitespace(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }
function assertContains(haystack, needle, msg) {
  if (!normalizeWhitespace(haystack).includes(normalizeWhitespace(needle))) {
    throw new Error(`${msg || 'expected substring'}: "${needle}" not found`);
  }
}

const { detectResumeJdDomain } = prompts.__testing;

// ─────────────────────────────────────────────────────────────────────────
section('A. detectResumeJdDomain — real reported phrasings now classify as resume-related');
// ─────────────────────────────────────────────────────────────────────────

const REPORTED_PHRASINGS = [
  'give me an example, where have you implemented React Native in your project',
  'have you implemented this anywhere?',
  'have you used this in production?',
  'did you use Redis in your last role?',
  'do you use TypeScript regularly?',
  'give me an example of that',
  'what was your approach to this?',
  'have you ever worked with Kafka?'
];

for (const phrase of REPORTED_PHRASINGS) {
  test(`A. "${phrase}" is now classified resume-related`, () => {
    const { isResumeRelated } = detectResumeJdDomain(phrase);
    assertTrue(isResumeRelated, 'expected isResumeRelated=true');
  });
}

test('A-neg. A genuinely generic definitional question stays ungrounded ("What is React?")', () => {
  const { isResumeRelated, isJdRelated, isGeneralInterview } = detectResumeJdDomain('What is React?');
  assertFalse(isResumeRelated);
  assertFalse(isJdRelated);
  assertFalse(isGeneralInterview);
});

test('A-neg2. A generic conceptual question stays ungrounded ("What is a hash map?")', () => {
  const { isResumeRelated, isJdRelated } = detectResumeJdDomain('What is a hash map?');
  assertFalse(isResumeRelated);
  assertFalse(isJdRelated);
});

// ─────────────────────────────────────────────────────────────────────────
section('B. End-to-end: the exact reported scenario through the real prompt builder');
// ─────────────────────────────────────────────────────────────────────────

const MOCK_CONTEXT = {
  role: 'Frontend Engineer', company: 'TestCo', interviewType: 'auto', seniority: 'mid',
  jobDescription: 'Looking for a frontend engineer with React Native experience.',
  background: [
    'Built a cross-platform mobile app for CampusConnect using React Native and TypeScript, integrating with a Django REST backend.',
    'Implemented offline-first data sync in the React Native app using WatermelonDB.'
  ].join('\n'),
  focusAreas: '', avoidTopics: '', answerStyle: 'balanced', extraNotes: '', updatedAt: null
};
function withMockContext(fn) {
  const original = interviewContext.load;
  interviewContext.load = () => MOCK_CONTEXT;
  try { return fn(); } finally { interviewContext.load = original; }
}

function buildPromptFor(tracker, question) {
  const r = tracker.resolveQuestion(question);
  const activeContext = formatActiveContextBlock(r);
  const contextString = `Host: ${r.resolved}`;
  const promptText = withMockContext(() => prompts.buildAskAiSessionPrompt({
    contextString, transcriptContext: contextString, activeContext,
    relation: r.relation, confidence: r.confidence
  }));
  return { result: r, promptText };
}

test('B1. "What is React?" alone renders with no forced evidence gate (correct: a generic definition needs no resume padding)', () => {
  const t = createConversationTracker();
  const { promptText } = buildPromptFor(t, 'What is React?');
  assertContains(promptText, 'No specific resume/JD evidence was retrieved');
});

test('B2. The immediate follow-up now retrieves the React Native resume evidence instead of answering blind', () => {
  const t = createConversationTracker();
  t.resolveQuestion('What is React?');
  t.recordAnswer('React is a JavaScript library for building user interfaces.');
  const { promptText } = buildPromptFor(t, 'give me an example, where have you implemented React Native in your project');
  assertContains(promptText, 'RELEVANT CANDIDATE EVIDENCE');
  assertContains(promptText, 'React Native');
  assertContains(promptText, 'CampusConnect');
});

test('B3. "have you used this in production?" after a topic is established also retrieves real evidence', () => {
  const t = createConversationTracker();
  t.resolveQuestion('Tell me about WatermelonDB.');
  t.recordAnswer('WatermelonDB is a reactive database for React and React Native apps.');
  const { promptText } = buildPromptFor(t, 'have you used this in production?');
  assertContains(promptText, 'RELEVANT CANDIDATE EVIDENCE');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log(`Resume-grounding coverage tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  [${f.category}] ${f.name}`);
    console.log(`    ${f.message}`);
  }
  process.exit(1);
} else {
  console.log('All resume-grounding coverage tests passed.');
}
