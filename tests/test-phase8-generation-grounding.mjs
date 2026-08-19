#!/usr/bin/env node
/**
 * Phase 8 — Generation Grounding test suite.
 *
 * Exercises the REAL production modules (conversation-tracker.js,
 * question-relation.js, semantic-reference.js, prompts.js), not
 * reimplementations. Phase 8 does not add a post-processing layer or a new
 * classifier -- it only makes the existing prompt state its evidence
 * priority explicitly. Every test here therefore verifies PROMPT STRUCTURE
 * (the instructions/labels/ordering actually reaching Gemini), not live
 * model output -- no Gemini call is made anywhere in this suite. See the
 * Phase 8 report's "What Was NOT Live-Verified" section.
 *
 * Run: node tests/test-phase8-generation-grounding.mjs
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
const { QuestionRelation } = await import(
  '../src/windows/assistant/renderer/features/auto-answer/question-relation.js'
);

// ─── tiny test harness ─────────────────────────────────────────────────────
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
// Normalized (not raw .includes()): the prompt's own source is written as
// word-wrapped multi-line template literals for readability, so a phrase
// that reads as one continuous sentence in the source can contain a literal
// "\n  " where the line wraps. Comparing on whitespace-collapsed text means
// a test asserts on the actual WORDS the prompt contains, not on how the
// source file happens to be wrapped -- matches how a human reading the
// rendered prompt would judge it.
function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}
function assertContains(haystack, needle, msg) {
  if (!normalizeWhitespace(haystack).includes(normalizeWhitespace(needle))) {
    throw new Error(`${msg || 'expected substring'}: "${needle}" not found`);
  }
}

// Deliberately: PostgreSQL/React verified in background, Redis ONLY in the
// JD (never in background) -- this is what lets test K prove [RESUME] and
// [JD] are kept structurally apart.
const MOCK_CONTEXT = {
  role: 'Backend Engineer', company: 'TestCo', interviewType: 'auto', seniority: 'mid',
  jobDescription: 'Looking for a backend engineer with Redis experience and Kafka exposure.',
  background: [
    'Built CampusConnect, a university management platform using PostgreSQL with a normalized relational schema for enrollment data and JWT authentication.',
    'Built the frontend in React with TypeScript.'
  ].join('\n'),
  focusAreas: '', avoidTopics: '', answerStyle: 'balanced', extraNotes: '', updatedAt: null
};
function withMockContext(fn) {
  const original = interviewContext.load;
  interviewContext.load = () => MOCK_CONTEXT;
  try { return fn(); } finally { interviewContext.load = original; }
}

function buildPromptFor(tracker, question, { recordedAnswer } = {}) {
  const r = tracker.resolveQuestion(question);
  if (recordedAnswer) tracker.recordAnswer(recordedAnswer);
  const activeContext = formatActiveContextBlock(r);
  const contextString = `Host: ${r.resolved}`;
  const promptText = withMockContext(() => prompts.buildAskAiSessionPrompt({
    contextString, transcriptContext: contextString, activeContext,
    relation: r.relation, confidence: r.confidence
  }));
  return { result: r, promptText };
}

// ─── A-M: scenario coverage ─────────────────────────────────────────────────
section('A-M. Scenario coverage');

test('A. New standalone technical question renders with no forced evidence gate', () => {
  const t = createConversationTracker();
  const { promptText } = buildPromptFor(t, 'What is a hash map?');
  assertContains(promptText, 'No specific resume/JD evidence was retrieved');
});

test('B. PostgreSQL -> MongoDB: COMPARISON guidance present, active topic preserved as PostgreSQL', () => {
  const t = createConversationTracker();
  t.resolveQuestion('Why did you choose PostgreSQL?');
  t.recordAnswer('I chose PostgreSQL for strong relational integrity.');
  const { result, promptText } = buildPromptFor(t, 'What about MongoDB?');
  assertTrue(result.relation === QuestionRelation.COMPARISON);
  assertContains(promptText, 'This turn is a COMPARISON');
  assertContains(promptText, 'Active topic: PostgreSQL');
});

test('C. CampusConnect -> authentication: REFINEMENT guidance present, scope narrowed', () => {
  const t = createConversationTracker();
  t.resolveQuestion('Tell me about CampusConnect.');
  t.recordAnswer('CampusConnect is a university management platform.');
  const { result, promptText } = buildPromptFor(t, 'Can you explain the authentication part?');
  assertTrue(result.relation === QuestionRelation.REFINEMENT);
  assertContains(promptText, 'This turn is a REFINEMENT');
  assertContains(promptText, 'do not restart the parent explanation');
});

test('D. PostgreSQL -> "How does that scale though?" -- Phase 7 resolution still reaches the final prompt', () => {
  const t = createConversationTracker();
  t.resolveQuestion('Why did you choose PostgreSQL?');
  t.recordAnswer('I chose PostgreSQL for strong relational integrity.');
  const { result, promptText } = buildPromptFor(t, 'How does that scale though?');
  assertTrue(result.relation === QuestionRelation.UNKNOWN, 'Phase 3 relation should still be UNKNOWN');
  assertContains(promptText, 'Resolved question: How does PostgreSQL scale though?');
  assertContains(promptText, 'RELEVANT CANDIDATE EVIDENCE', 'Phase 7 resolution should still unlock evidence retrieval');
});

test('E. Explicit correction: CORRECTION guidance present, overrides the old target', () => {
  const t = createConversationTracker();
  t.resolveQuestion('Tell me about Redis.');
  const { result, promptText } = buildPromptFor(t, 'No, I meant PostgreSQL.');
  assertTrue(result.relation === QuestionRelation.CORRECTION);
  assertContains(promptText, 'This turn is a CORRECTION');
  assertContains(promptText, 'Fully replace the old target');
});

test('F. New topic after previous discussion does not carry COMPARISON/CORRECTION/REFINEMENT guidance', () => {
  const t = createConversationTracker();
  t.resolveQuestion('Why did you choose PostgreSQL?');
  t.recordAnswer('Strong relational integrity.');
  const { result, promptText } = buildPromptFor(t, 'What is React?');
  assertTrue(result.relation === QuestionRelation.NEW_TOPIC);
  assertFalse(promptText.includes('This turn is a COMPARISON'));
  assertFalse(promptText.includes('This turn is a CORRECTION'));
  assertFalse(promptText.includes('This turn is a REFINEMENT'));
});

test('G. Candidate-specific question with verified evidence -> [RESUME] block present, directives say ground in it', () => {
  const t = createConversationTracker();
  const { promptText } = buildPromptFor(t, 'Tell me about your experience with PostgreSQL.');
  assertContains(promptText, '[RESUME]');
  assertContains(promptText, "candidate's own real, verified background");
});

test('H. Candidate-specific question with no matching evidence still gets the honesty instruction', () => {
  const t = createConversationTracker();
  const { promptText } = buildPromptFor(t, 'Have you used Kafka in a personal project?');
  assertContains(promptText, "say so honestly");
});

test('I. General technical question does not force resume grounding', () => {
  const t = createConversationTracker();
  const { promptText } = buildPromptFor(t, 'What is normalization?');
  assertContains(promptText, 'General technical knowledge -- fine for explaining a concept');
});

test('J. General technical question after candidate discussion still carries the hierarchy block', () => {
  const t = createConversationTracker();
  t.resolveQuestion('Tell me about CampusConnect.');
  t.recordAnswer('A university management platform.');
  const { promptText } = buildPromptFor(t, 'What is database normalization in general?');
  assertContains(promptText, '=== EVIDENCE PRIORITY ===');
});

test('K. Resume/JD conflict: Redis (JD-only, never in resume) is never presented as candidate experience', () => {
  const t = createConversationTracker();
  const { promptText } = buildPromptFor(t, 'Do you have Redis experience?');
  assertContains(promptText, '[JD]');
  assertContains(promptText, 'Redis');
  assertContains(promptText, 'not the candidate\'s own experience');
  assertContains(promptText, 'Never present a JD requirement as something the candidate has done');
});

test('L. Previous-answer-vs-current-question priority is explicit (tier 1 beats tier 3)', () => {
  const t = createConversationTracker();
  const { promptText } = buildPromptFor(t, 'What is a hash map?');
  assertContains(promptText, '1. The current question -- answer what is being asked NOW, not an earlier question.');
  assertContains(promptText, '3. The immediately preceding question and answer -- continuity, not the thing being asked now.');
});

test('M. Active topic vs newly introduced entity: MongoDB does not overwrite Active topic: PostgreSQL', () => {
  const t = createConversationTracker();
  t.resolveQuestion('Why did you choose PostgreSQL?');
  t.recordAnswer('Strong relational integrity.');
  const { promptText } = buildPromptFor(t, 'What about MongoDB?');
  assertContains(promptText, 'Active topic: PostgreSQL');
  assertFalse(/Active topic: MongoDB/.test(promptText));
});

// ─── N-T: structural instruction presence ──────────────────────────────────
section('N-T. Structural instruction presence');

test('N. Internal annotations are explicitly forbidden from spoken output', () => {
  const t = createConversationTracker();
  const { promptText } = buildPromptFor(t, 'What is a hash map?');
  assertContains(promptText, 'NEVER read any line of this block aloud');
  assertContains(promptText, 'Never name or describe your own internal reasoning process out loud');
});

test('O. Answer-first instruction exists', () => {
  const t = createConversationTracker();
  const { promptText } = buildPromptFor(t, 'What is a hash map?');
  assertContains(promptText, 'Start IMMEDIATELY with the answer');
  assertContains(promptText, 'Answer first, explain second, then STOP.');
});

test('P. Stop rule exists', () => {
  const t = createConversationTracker();
  const { promptText } = buildPromptFor(t, 'What is a hash map?');
  assertContains(promptText, 'stop the moment the question is actually answered rather than padding');
});

test('Q. Evidence hierarchy exists', () => {
  const t = createConversationTracker();
  const { promptText } = buildPromptFor(t, 'What is a hash map?');
  assertContains(promptText, '=== EVIDENCE PRIORITY ===');
  for (const line of ['1. The current question', '2. The resolved meaning', '3. The immediately preceding',
    '4. The active topic', '5. Verified candidate evidence', '6. General technical knowledge']) {
    assertContains(promptText, line);
  }
});

test('R. No-fabricated-candidate-experience instruction exists', () => {
  const t = createConversationTracker();
  const { promptText } = buildPromptFor(t, 'Do you have experience with Kafka?');
  assertContains(promptText, 'instead of inventing it');
  assertContains(promptText, 'Never invent an accomplishment they do not have');
});

test('S. Comparison behavior instruction exists', () => {
  const t = createConversationTracker();
  t.resolveQuestion('Why did you choose PostgreSQL?');
  t.recordAnswer('Strong relational integrity.');
  const { promptText } = buildPromptFor(t, 'What about MongoDB?');
  assertContains(promptText, 'do not answer the new subject in isolation as a generic definition.');
});

test('T. Refinement behavior instruction exists', () => {
  const t = createConversationTracker();
  t.resolveQuestion('Tell me about CampusConnect.');
  t.recordAnswer('A university management platform.');
  const { promptText } = buildPromptFor(t, 'Can you explain the authentication part?');
  assertContains(promptText, 'a narrower focus WITHIN a broader project');
});

// ─── Negative tests (Part 16): prove the model is instructed NOT to ────────
section('Negative tests — forbidden behaviors are explicitly instructed against');

test('Must not repeat internal annotation labels', () => {
  const t = createConversationTracker();
  t.resolveQuestion('Why did you choose PostgreSQL?');
  t.recordAnswer('Strong relational integrity.');
  const { promptText } = buildPromptFor(t, 'How does that scale though?');
  assertContains(promptText, 'never say things like "based on the resolved question" or "following up on"');
});

test('Must not claim unsupported candidate experience', () => {
  const t = createConversationTracker();
  const { promptText } = buildPromptFor(t, 'Do you have experience with Kafka?');
  assertContains(promptText, "haven't used that directly");
});

test('Must answer the current question, not the previous one', () => {
  const t = createConversationTracker();
  const { promptText } = buildPromptFor(t, 'What is a hash map?');
  assertContains(promptText, 'answer what is being asked NOW, not an earlier question');
});

test('Must not treat a JD requirement as candidate experience', () => {
  const t = createConversationTracker();
  const { promptText } = buildPromptFor(t, 'Do you have Redis experience?');
  assertContains(promptText, 'Never present a JD requirement as something the candidate has done');
});

test('Must not let general knowledge overwrite a verified candidate fact', () => {
  const t = createConversationTracker();
  const { promptText } = buildPromptFor(t, 'What is a hash map?');
  assertContains(promptText, 'must never overwrite\n   or contradict a verified candidate-specific fact');
});

test('Must not answer a comparison target in isolation', () => {
  const t = createConversationTracker();
  t.resolveQuestion('Why did you choose PostgreSQL?');
  t.recordAnswer('Strong relational integrity.');
  const { promptText } = buildPromptFor(t, 'What about MongoDB?');
  assertContains(promptText, 'do not answer the new subject in isolation');
});

test('Must not restart a project explanation unnecessarily on refinement', () => {
  const t = createConversationTracker();
  t.resolveQuestion('Tell me about CampusConnect.');
  t.recordAnswer('A university management platform.');
  const { promptText } = buildPromptFor(t, 'Can you explain the authentication part?');
  assertContains(promptText, 'do not restart the parent explanation from scratch');
});

test('Must not produce documentation-style/textbook language', () => {
  const t = createConversationTracker();
  const { promptText } = buildPromptFor(t, 'What is a hash map?');
  assertContains(promptText, 'Never open a definition with the textbook pattern');
});

test('Must not produce unnecessarily long answers', () => {
  const t = createConversationTracker();
  const { promptText } = buildPromptFor(t, 'What is a hash map?');
  assertContains(promptText, 'stop the moment the question is actually answered rather than padding');
});

// ─── summary ────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Phase 8 tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  [${f.category}] ${f.name}\n    ${f.message}`);
  }
  process.exitCode = 1;
} else {
  console.log('All Phase 8 tests passed.');
}
