#!/usr/bin/env node
/**
 * Phase 7 — Semantic Reference Resolution test suite.
 *
 * Exercises the REAL modules (semantic-reference.js, conversation-tracker.js,
 * question-relation.js, prompts.js), not reimplementations. Categories:
 * A-J against the resolver/tracker directly (the lettered cases from the
 * spec), K-M multi-turn integration, N full prompt-pipeline regression.
 *
 * Run: node tests/test-phase7-semantic-reference.mjs
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
const { resolveSemanticReference, ReferenceType } = await import(
  '../src/windows/assistant/renderer/features/auto-answer/semantic-reference.js'
);

// ─── tiny test harness (same shape as the Phase 6 suite) ─────────────────
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

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertTrue(cond, msg) {
  if (!cond) throw new Error(msg || 'expected true');
}
function assertContains(haystack, needle, msg) {
  if (!String(haystack || '').includes(needle)) {
    throw new Error(`${msg || 'expected substring'}: "${needle}" not found in ${JSON.stringify(haystack)}`);
  }
}

const MOCK_CONTEXT = {
  role: 'Backend Engineer', company: 'TestCo', interviewType: 'auto', seniority: 'mid',
  jobDescription: 'Looking for a backend engineer experienced with PostgreSQL.',
  background: 'Built CampusConnect using PostgreSQL with a normalized relational schema.',
  focusAreas: '', avoidTopics: '', answerStyle: 'balanced', extraNotes: '', updatedAt: null
};
function withMockContext(fn) {
  const original = interviewContext.load;
  interviewContext.load = () => MOCK_CONTEXT;
  try { fn(); } finally { interviewContext.load = original; }
}

// ─── A-J: lettered cases against the resolver directly ─────────────────────
section('A-J. Resolver — lettered cases from the spec');

test('A. Explicit topic: "How does that scale?" -> PostgreSQL', () => {
  const r = resolveSemanticReference({
    utterance: 'How does that scale though?', ownEntities: [],
    activeTopic: 'PostgreSQL', activeEntities: ['PostgreSQL']
  });
  assertTrue(r.resolved, 'expected a resolution');
  assertEqual(r.resolvedTopic, 'PostgreSQL');
  assertContains(r.canonicalQuestion, 'PostgreSQL');
});

test('B. Pronoun: "Why is that better?" -> active topic', () => {
  const r = resolveSemanticReference({
    utterance: 'Why is that better?', ownEntities: [],
    activeTopic: 'PostgreSQL', activeEntities: ['PostgreSQL']
  });
  assertTrue(r.resolved);
  assertEqual(r.resolvedTopic, 'PostgreSQL');
  assertContains(r.canonicalQuestion, 'PostgreSQL');
});

test('C. Ellipsis: "And security?" -> active topic', () => {
  const r = resolveSemanticReference({
    utterance: 'And security?', ownEntities: ['security'],
    activeTopic: 'PostgreSQL', activeEntities: ['PostgreSQL', 'security']
  });
  assertTrue(r.resolved);
  assertEqual(r.referenceType, ReferenceType.ELLIPTICAL_REFERENCE);
  assertEqual(r.resolvedTopic, 'PostgreSQL');
});

test('D. Possessive: "What about its performance?" -> active topic', () => {
  const r = resolveSemanticReference({
    utterance: 'What about its performance?', ownEntities: ['performance'],
    activeTopic: 'PostgreSQL', activeEntities: ['PostgreSQL']
  });
  assertTrue(r.resolved);
  assertEqual(r.resolvedTopic, 'PostgreSQL');
  assertContains(r.canonicalQuestion, "PostgreSQL's performance");
});

test('E. Concept reference: "How did you implement that?" -> previous answer/project concept', () => {
  const r = resolveSemanticReference({
    utterance: 'How did you implement that?', ownEntities: [],
    activeTopic: 'CampusConnect', activeEntities: ['CampusConnect']
  });
  assertTrue(r.resolved);
  assertEqual(r.resolvedTopic, 'CampusConnect');
});

test('F. Explicit new topic: "How does Redis scale?" -> Redis, NOT PostgreSQL', () => {
  const r = resolveSemanticReference({
    utterance: 'How does Redis scale?', ownEntities: ['Redis'],
    activeTopic: 'PostgreSQL', activeEntities: ['PostgreSQL']
  });
  assertEqual(r.resolved, false, 'must not resolve -- utterance already names its own subject');
  assertEqual(r.resolvedTopic, null);
});

test('G. Comparison: "What about MongoDB?" is left to conversation-tracker.js, not force-resolved to PostgreSQL', () => {
  const r = resolveSemanticReference({
    utterance: 'What about MongoDB?', ownEntities: ['MongoDB'],
    activeTopic: 'PostgreSQL', activeEntities: ['PostgreSQL']
  });
  assertEqual(r.resolved, false, 'MongoDB is a hard entity of its own -- resolver must not touch it');
});

test('H. Refinement: "Can you explain the authentication part?" is a question-relation.js frame, not this resolver\'s job', () => {
  // question-relation.js already recognizes this (REFINEMENT); the resolver
  // is not even invoked for that branch (see conversation-tracker.js). This
  // test documents the boundary rather than exercising the resolver itself.
  const r = resolveSemanticReference({
    utterance: 'Can you explain the authentication part?', ownEntities: ['authentication'],
    activeTopic: 'CampusConnect', activeEntities: ['CampusConnect']
  });
  // "the authentication part" has a specific modifier before "part" (not one
  // of the resolver's own CONCEPT_NOUNS), so the resolver correctly finds no
  // reference of its own kind here either -- consistent, not a regression.
  assertEqual(r.resolved, false);
});

test('I. Correction: "No, I meant the database design." stays about database design, not overwritten', () => {
  const r = resolveSemanticReference({
    utterance: 'No, I meant the database design.', ownEntities: ['database'],
    activeTopic: 'backend', activeEntities: ['backend', 'database']
  });
  assertEqual(r.resolved, false, '"the database design" already names its own specific subject');
});

test('J. Ambiguous: "Why is that?" with nothing tracked -> LOW / no unsafe resolution', () => {
  const r = resolveSemanticReference({
    utterance: 'Why is that?', ownEntities: [],
    activeTopic: null, activeEntities: [], previousQuestionEntities: [], previousAnswerEntities: []
  });
  assertEqual(r.resolved, false);
  assertEqual(r.confidence, 'LOW');
  assertEqual(r.canonicalQuestion, null);
});

test('extra: "What about transaction performance?" is NOT rewritten onto the active topic', () => {
  const r = resolveSemanticReference({
    utterance: 'What about transaction performance?', ownEntities: [],
    activeTopic: 'PostgreSQL', activeEntities: ['PostgreSQL']
  });
  assertEqual(r.resolved, false, 'a specific compound noun phrase of its own must not be overridden');
});

// ─── K-M: multi-turn integration against the real tracker ──────────────────
section('K-M. Multi-turn integration (real conversation-tracker.js)');

test('K. Multi-turn: Q1->A1, Q2->A2, Q3 pronoun follow-up resolves to the latest active topic', () => {
  const t = createConversationTracker();
  t.resolveQuestion('Tell me about your backend experience.');
  t.recordAnswer('I mostly work with Node and Express.');
  t.resolveQuestion('Why did you choose PostgreSQL?');
  t.recordAnswer('I chose PostgreSQL for strong relational consistency.');
  const r3 = t.resolveQuestion('How does that scale though?');
  assertEqual(r3.canonicalQuestion, 'How does PostgreSQL scale though?');
});

test('L. Topic switch then pronoun: PostgreSQL -> MongoDB -> "How does that scale?" -> MongoDB', () => {
  const t = createConversationTracker();
  t.resolveQuestion('Why did you choose PostgreSQL?');
  t.recordAnswer('Strong relational consistency for CampusConnect.');
  t.resolveQuestion('What about MongoDB?'); // COMPARISON -- MongoDB becomes the most recent tracked entity
  const r3 = t.resolveQuestion('How does that scale?');
  assertEqual(r3.resolutionReason !== null, true, 'expected a Phase 7 resolution');
  assertContains(r3.canonicalQuestion, 'MongoDB');
  assertEqual(r3.canonicalQuestion.includes('PostgreSQL'), false, 'must not have resolved back to the old anchor');
});

test('M. Regression: a clear standalone question stays unresolved and unchanged', () => {
  const t = createConversationTracker();
  t.resolveQuestion('Why did you choose PostgreSQL?');
  t.recordAnswer('Strong relational consistency.');
  const r = t.resolveQuestion('What is React?');
  assertEqual(r.relation, QuestionRelation.NEW_TOPIC);
  assertEqual(r.resolved, 'What is React?');
  assertEqual(r.canonicalQuestion, null, 'NEW_TOPIC must never be run through the reference resolver');
});

test('M2. Regression: an already frame-resolved turn (COMPARISON) is not re-processed by the resolver', () => {
  const t = createConversationTracker();
  t.resolveQuestion('Why did you choose PostgreSQL?');
  t.recordAnswer('Strong relational consistency.');
  const r = t.resolveQuestion('What about MongoDB?');
  assertEqual(r.relation, QuestionRelation.COMPARISON);
  assertEqual(r.canonicalQuestion, r.resolved, 'canonicalQuestion should mirror the existing Phase 3 resolution');
  assertEqual(r.resolutionReason, null, 'the resolver itself must not have run for this branch');
  const block = formatActiveContextBlock(r);
  assertEqual(block.includes('Resolved question:'), false, 'must not duplicate what RELEVANT RECENT CONVERSATION already shows');
});

test('M3. Regression: "Can you explain the authentication part?" (REFINEMENT) still resolves via question-relation.js, unaffected by Phase 7', () => {
  const t = createConversationTracker();
  t.resolveQuestion('Tell me about CampusConnect.');
  t.recordAnswer('CampusConnect is a university management platform.');
  const r = t.resolveQuestion('Can you explain the authentication part?');
  assertEqual(r.relation, QuestionRelation.REFINEMENT);
  assertContains(r.resolved, '"authentication" part of CampusConnect');
});

// ─── N. Full prompt-pipeline regression ─────────────────────────────────────
section('N. Full prompt-pipeline integration');

test('N1. A Phase-7-only resolution (relation UNKNOWN) still unlocks RELEVANT CANDIDATE EVIDENCE retrieval', () => {
  withMockContext(() => {
    const t = createConversationTracker();
    t.resolveQuestion('Why did you choose PostgreSQL?');
    t.recordAnswer('Strong relational consistency for CampusConnect.');
    const r = t.resolveQuestion('How does that scale though?');
    assertEqual(r.relation, QuestionRelation.UNKNOWN);
    const activeContext = formatActiveContextBlock(r);

    const contextString = `Host: Why did you choose PostgreSQL?\nAI: Strong relational consistency for CampusConnect.\nHost: How does that scale though?`;
    const promptText = prompts.buildAskAiSessionPrompt({
      contextString, transcriptContext: contextString, activeContext,
      relation: r.relation, confidence: r.confidence
    });
    assertTrue(promptText.includes('RELEVANT CANDIDATE EVIDENCE'), 'retrieval should have fired via hasResolvedReference');
    assertContains(promptText, 'Resolved question: How does PostgreSQL scale though?');
  });
});

test('N2. The resolved-question scaffolding is never mistaken for something the Host said aloud (instruction present)', () => {
  withMockContext(() => {
    const t = createConversationTracker();
    t.resolveQuestion('Why did you choose PostgreSQL?');
    t.recordAnswer('Strong relational consistency.');
    const r = t.resolveQuestion('How does that scale though?');
    const activeContext = formatActiveContextBlock(r);
    const contextString = `Host: Why did you choose PostgreSQL?\nHost: How does that scale though?`;
    const promptText = prompts.buildAskAiSessionPrompt({ contextString, transcriptContext: contextString, activeContext, relation: r.relation, confidence: r.confidence });
    assertContains(promptText, 'Resolved question:');
    assertContains(promptText, 'never say things like "based on the resolved question"');
  });
});

test('N3. A turn with no reference at all produces no "Resolved question" line and does not force retrieval open', () => {
  withMockContext(() => {
    const t = createConversationTracker();
    const r = t.resolveQuestion('What is a hash map?');
    const activeContext = formatActiveContextBlock(r);
    assertEqual(activeContext.includes('Resolved question:'), false);
  });
});

// ─── summary ────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Phase 7 tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  [${f.category}] ${f.name}\n    ${f.message}`);
  }
  process.exitCode = 1;
} else {
  console.log('All Phase 7 tests passed.');
}
