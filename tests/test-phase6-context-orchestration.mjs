#!/usr/bin/env node
/**
 * Phase 6 — Context Orchestration test suite.
 *
 * Exercises the REAL modules (conversation-tracker.js, question-relation.js,
 * context-bundle.js, prompts.js) end to end wherever practical, not
 * reimplementations of their logic. The one controlled input is
 * interview-context.js's `load()`, monkey-patched to deterministic mock
 * resume/JD text for the retrieval-focused tests (prompts.js `require`s the
 * same singleton module object this file does, so the patch is visible to
 * prompts.js's own internal calls without touching prompts.js itself).
 *
 * Categories: A) relation integration, B) context priority, C) retrieval,
 * D) duplication collapse, E) full-pipeline regression.
 *
 * Run: node tests/test-phase6-context-orchestration.mjs
 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const prompts = require(path.join(__dirname, '../src/services/ai/prompts.js'));
const interviewContext = require(path.join(__dirname, '../src/services/context/interview-context.js'));

const { createConversationTracker, formatActiveContextBlock } = await import(
  '../src/windows/assistant/renderer/features/auto-answer/conversation-tracker.js'
);
const { QuestionRelation, Confidence } = await import(
  '../src/windows/assistant/renderer/features/auto-answer/question-relation.js'
);
const { buildFilteredAiContextBundle } = await import(
  '../src/windows/assistant/renderer/features/ai-context/context-bundle.js'
);
const {
  isTranscriptMessageType,
  isResolvedQuestionMessageType,
  isScreenshotMessageType,
  isSystemMessageType,
  defaultIncludeInAiForMessageType
} = await import('../src/windows/assistant/renderer/features/ai-context/message-types.js');

const { __testing } = prompts;

// ─── tiny test harness ────────────────────────────────────────────────────
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

// ─── shared fixtures ───────────────────────────────────────────────────────

const REAL_CONTEXT = interviewContext.load();

const MOCK_CONTEXT = {
  role: 'Backend Engineer',
  company: 'TestCo',
  interviewType: 'auto',
  seniority: 'mid',
  jobDescription: [
    'Looking for a backend engineer experienced with PostgreSQL and relational database design.',
    'Experience with Kafka and distributed systems is a plus.'
  ].join('\n'),
  background: [
    'Built CampusConnect, a university management platform using PostgreSQL with a normalized relational schema for enrollment data.',
    'Implemented caching with Redis for dashboard queries.',
    'Built the frontend in React with TypeScript.'
  ].join('\n'),
  focusAreas: '',
  avoidTopics: '',
  answerStyle: 'balanced',
  extraNotes: '',
  updatedAt: null
};

function withMockContext(fn) {
  const original = interviewContext.load;
  interviewContext.load = () => MOCK_CONTEXT;
  try {
    fn();
  } finally {
    interviewContext.load = original;
  }
}

function makeMessage(id, type, content, extra = {}) {
  return { id, type, content, includeInAi: true, ...extra };
}

const isMessageIncludedForAi = (message) => defaultIncludeInAiForMessageType(message.type) && message.includeInAi !== false;

// ─── A. Relation integration (7) ───────────────────────────────────────────
section('A. Relation integration');

test('NEW_TOPIC is not follow-up-like and falls to domain classification', () => {
  const { classification, isFollowUpLike } = __testing.buildContextPolicy({
    relation: QuestionRelation.NEW_TOPIC,
    isResumeRelated: false,
    isJdRelated: false,
    isGeneralInterview: false
  });
  assert.equal(isFollowUpLike, false);
  assert.equal(classification, 'GENERAL_TECHNICAL');
});

test('FOLLOW_UP relation drives FOLLOW_UP classification regardless of keywords', () => {
  const { classification, isFollowUpLike } = __testing.buildContextPolicy({
    relation: QuestionRelation.FOLLOW_UP,
    isResumeRelated: false,
    isJdRelated: false,
    isGeneralInterview: false
  });
  assert.equal(isFollowUpLike, true);
  assert.equal(classification, 'FOLLOW_UP');
});

test('COMPARISON relation drives FOLLOW_UP classification', () => {
  const { classification } = __testing.buildContextPolicy({
    relation: QuestionRelation.COMPARISON,
    isResumeRelated: false,
    isJdRelated: false,
    isGeneralInterview: false
  });
  assert.equal(classification, 'FOLLOW_UP');
});

test('REFINEMENT relation drives FOLLOW_UP classification', () => {
  const { classification } = __testing.buildContextPolicy({
    relation: QuestionRelation.REFINEMENT,
    isResumeRelated: false,
    isJdRelated: false,
    isGeneralInterview: false
  });
  assert.equal(classification, 'FOLLOW_UP');
});

test('CLARIFICATION relation drives FOLLOW_UP classification', () => {
  const { classification } = __testing.buildContextPolicy({
    relation: QuestionRelation.CLARIFICATION,
    isResumeRelated: false,
    isJdRelated: false,
    isGeneralInterview: false
  });
  assert.equal(classification, 'FOLLOW_UP');
});

test('CORRECTION relation drives FOLLOW_UP classification', () => {
  const { classification } = __testing.buildContextPolicy({
    relation: QuestionRelation.CORRECTION,
    isResumeRelated: false,
    isJdRelated: false,
    isGeneralInterview: false
  });
  assert.equal(classification, 'FOLLOW_UP');
});

test('LOW-confidence UNKNOWN (conversation-tracker.js\'s own fallback shape) is not follow-up-like', () => {
  // This mirrors exactly what conversation-tracker.js hands back for an
  // unresolvable fragment: relation forced to UNKNOWN, confidence LOW.
  const { classification, isFollowUpLike } = __testing.buildContextPolicy({
    relation: QuestionRelation.UNKNOWN,
    isResumeRelated: false,
    isJdRelated: false,
    isGeneralInterview: false
  });
  assert.equal(isFollowUpLike, false);
  assert.equal(classification, 'GENERAL_TECHNICAL');
});

// ─── B. Context priority (7) ────────────────────────────────────────────────
section('B. Context priority');

test('current question is always present in the ACTIVE CONTEXT block', () => {
  const tracker = createConversationTracker();
  const result = tracker.resolveQuestion('What is React?');
  const block = formatActiveContextBlock(result);
  assert.match(block, /^Current question: What is React\?/);
});

test('resolved-question text (not the bare raw form) is what reaches RELEVANT RECENT CONVERSATION', () => {
  const tracker = createConversationTracker();
  tracker.resolveQuestion('Why did you choose PostgreSQL?');
  tracker.recordAnswer('I went with PostgreSQL for relational integrity.');
  const result = tracker.resolveQuestion('What about MongoDB?');
  assert.equal(result.wasResolved, true);
  assert.match(result.resolved, /comparing with PostgreSQL/);

  withMockContext(() => {
    const activeContext = formatActiveContextBlock(result);
    const contextString = `Host: Why did you choose PostgreSQL?\nAI: I went with PostgreSQL for relational integrity.\nHost: ${result.resolved}`;
    const promptText = prompts.buildAskAiSessionPrompt({
      contextString,
      transcriptContext: contextString,
      activeContext,
      relation: result.relation,
      confidence: result.confidence
    });
    // The raw form leads ACTIVE CONTEXT; the annotated/resolved form is what
    // the model sees as the actual thing the Host said in the conversation.
    assert.ok(promptText.includes('Current question: What about MongoDB?'));
    assert.ok(promptText.includes(result.resolved));
  });
});

test('previous question is carried once real prior context exists, absent on a first turn', () => {
  const tracker = createConversationTracker();
  const first = tracker.resolveQuestion('Why did you choose PostgreSQL?');
  assert.equal(first.previousQuestion, null);
  assert.equal(formatActiveContextBlock(first).includes('Previous question:'), false);

  const second = tracker.resolveQuestion('What about MongoDB?');
  assert.equal(second.previousQuestion, 'Why did you choose PostgreSQL?');
  assert.ok(formatActiveContextBlock(second).includes('Previous question: Why did you choose PostgreSQL?'));
});

test('previous answer is carried once recordAnswer() has been called', () => {
  const tracker = createConversationTracker();
  tracker.resolveQuestion('Why did you choose PostgreSQL?');
  tracker.recordAnswer('I went with PostgreSQL for relational integrity.');
  const result = tracker.resolveQuestion('What about MongoDB?');
  assert.equal(result.previousAnswer, 'I went with PostgreSQL for relational integrity.');
  assert.ok(formatActiveContextBlock(result).includes('Previous answer: I went with PostgreSQL for relational integrity.'));
});

test('active topic stays the prior anchor (PostgreSQL), not the newly-mentioned entity (MongoDB)', () => {
  const tracker = createConversationTracker();
  tracker.resolveQuestion('Why did you choose PostgreSQL?');
  const result = tracker.resolveQuestion('What about MongoDB?');
  assert.equal(result.topic, 'PostgreSQL');
  assert.ok(formatActiveContextBlock(result).includes('Active topic: PostgreSQL'));
});

test('relevant entities accumulate both the anchor and the newly-mentioned entity', () => {
  const tracker = createConversationTracker();
  tracker.resolveQuestion('Why did you choose PostgreSQL?');
  const result = tracker.resolveQuestion('What about MongoDB?');
  assert.ok(result.activeEntities.includes('PostgreSQL'));
  assert.ok(result.activeEntities.includes('MongoDB'));
  const line = formatActiveContextBlock(result).split('\n').find((l) => l.startsWith('Relevant entities:'));
  assert.ok(line.includes('PostgreSQL'));
  assert.ok(line.includes('MongoDB'));
});

test('irrelevant old messages are excluded from the rendered conversation once outside the char budget', () => {
  const messages = [
    makeMessage('m1', 'voice-system', 'This is an old unrelated line about the weather and lunch plans.'),
    makeMessage('m2', 'voice-system', 'What about MongoDB?'),
    makeMessage('m3', 'active-context', 'Current question: What about MongoDB?\nRelation: COMPARISON\nConfidence: HIGH\nActive topic: PostgreSQL')
  ];
  const bundle = buildFilteredAiContextBundle({
    messages,
    isMessageIncludedForAi,
    charBudget: 40, // small enough that only the newest line survives
    emitTruncationLog: false
  });
  assert.equal(bundle.contextString.includes('weather and lunch'), false);
  assert.ok(bundle.contextString.includes('MongoDB'));
  // activeContext always reflects the latest turn regardless of budget
  // pressure on the older transcript lines.
  assert.equal(bundle.relation, 'COMPARISON');
});

// ─── C. Retrieval (4) ────────────────────────────────────────────────────
section('C. Retrieval');

test('a bare query with no anchor terms does not match unrelated resume content', () => {
  const items = [
    'Built CampusConnect using PostgreSQL with a normalized relational schema for enrollment data.',
    'Implemented caching with Redis for dashboard queries.',
    'Built the frontend in React with TypeScript.'
  ];
  const bareScores = __testing.scoreItemsAgainstQuery(items, 'what about mongodb');
  assert.equal(bareScores.length, 0);
});

test('anchor-topic enrichment (as buildRetrievedContextBlock builds it) makes the same query match', () => {
  const items = [
    'Built CampusConnect using PostgreSQL with a normalized relational schema for enrollment data.',
    'Implemented caching with Redis for dashboard queries.',
    'Built the frontend in React with TypeScript.'
  ];
  const enrichedQuery = 'what about mongodb PostgreSQL PostgreSQL, MongoDB';
  const enrichedScores = __testing.scoreItemsAgainstQuery(items, enrichedQuery);
  assert.ok(enrichedScores.length > 0);
  assert.ok(enrichedScores[0].item.includes('PostgreSQL'));
});

test('GENERAL_TECHNICAL classification skips retrieval entirely; a domain classification retrieves', () => {
  withMockContext(() => {
    const skipped = __testing.buildRetrievedContextBlock('what is a hash map', 'GENERAL_TECHNICAL', '');
    assert.equal(skipped, '');

    const retrieved = __testing.buildRetrievedContextBlock('tell me about your database experience', 'RESUME_RELATED', '');
    assert.ok(retrieved.includes('[RESUME]'));
    assert.ok(retrieved.includes('RELEVANT CANDIDATE EVIDENCE'));
  });
});

test('JD evidence only appears for JD-gating classifications, not for RESUME_RELATED alone', () => {
  withMockContext(() => {
    const resumeOnly = __testing.buildRetrievedContextBlock('kafka distributed systems', 'RESUME_RELATED', '');
    assert.equal(resumeOnly.includes('[JD]'), false);

    const withJd = __testing.buildRetrievedContextBlock('kafka distributed systems', 'JD_RELATED', '');
    assert.ok(withJd.includes('[JD]'));
  });
});

// ─── D. Duplication collapse (3) ───────────────────────────────────────────
section('D. Duplication collapse');

test('a prior (non-current) conversation line is rendered exactly once, not 3-4x', () => {
  withMockContext(() => {
    const priorLine = 'Host: Why did you choose PostgreSQL over other databases for CampusConnect?';
    const contextString = [
      priorLine,
      'AI: I went with PostgreSQL for relational integrity.',
      'Host: What about MongoDB? — comparing with PostgreSQL, following up on: "Why did you choose PostgreSQL over other databases for CampusConnect?"'
    ].join('\n');
    const activeContext = [
      'Current question: What about MongoDB?',
      'Relation: COMPARISON',
      'Confidence: HIGH',
      'Active topic: PostgreSQL',
      'Previous question: Why did you choose PostgreSQL over other databases for CampusConnect?'
    ].join('\n');

    const promptText = prompts.buildAskAiSessionPrompt({
      contextString,
      transcriptContext: contextString,
      sessionSummary: 'Host said: Why did you choose PostgreSQL over other databases for CampusConnect?',
      activeContext,
      relation: 'COMPARISON',
      confidence: 'HIGH'
    });

    const occurrences = promptText.split(priorLine).length - 1;
    assert.equal(occurrences, 1, `expected exactly 1 occurrence, found ${occurrences}`);
  });
});

test('Session summary is no longer rendered as its own block; RELEVANT RECENT CONVERSATION appears exactly once', () => {
  withMockContext(() => {
    const contextString = 'Host: What is a hash map?';
    const promptText = prompts.buildAskAiSessionPrompt({
      contextString,
      transcriptContext: contextString,
      sessionSummary: 'Host said: What is a hash map?'
    });
    assert.equal(promptText.includes('Session summary:'), false);
    const occurrences = (promptText.match(/RELEVANT RECENT CONVERSATION/g) || []).length;
    assert.equal(occurrences, 1);
  });
});

test('sessionSummary\'s unique fact (the previous answer) is preserved via ACTIVE CONTEXT, not lost', () => {
  withMockContext(() => {
    const tracker = createConversationTracker();
    tracker.resolveQuestion('Why did you choose PostgreSQL?');
    tracker.recordAnswer('I went with PostgreSQL for relational integrity and CampusConnect needed strong consistency.');
    const result = tracker.resolveQuestion('What about MongoDB?');
    const activeContext = formatActiveContextBlock(result);

    const promptText = prompts.buildAskAiSessionPrompt({
      contextString: `Host: Why did you choose PostgreSQL?\nAI: I went with PostgreSQL for relational integrity and CampusConnect needed strong consistency.\nHost: ${result.resolved}`,
      transcriptContext: `Host: Why did you choose PostgreSQL?\nHost: ${result.resolved}`,
      sessionSummary: '', // deliberately empty -- the old carrier of this fact
      activeContext,
      relation: result.relation,
      confidence: result.confidence
    });

    assert.ok(promptText.includes('Previous answer: I went with PostgreSQL for relational integrity and CampusConnect needed strong consistency.'));
  });
});

// ─── E. Full-pipeline regression (5) ───────────────────────────────────────
section('E. Full-pipeline regression');

test('Example: PostgreSQL -> MongoDB comparison preserves the requested prompt hierarchy end to end', () => {
  withMockContext(() => {
    const tracker = createConversationTracker();
    tracker.resolveQuestion('Why did you choose PostgreSQL?');
    tracker.recordAnswer('I went with PostgreSQL because CampusConnect needed strong relational integrity.');
    const result = tracker.resolveQuestion('What about MongoDB?');
    assert.equal(result.relation, QuestionRelation.COMPARISON);
    assert.equal(result.topic, 'PostgreSQL');

    const activeContext = formatActiveContextBlock(result);
    const contextString = `Host: Why did you choose PostgreSQL for CampusConnect?\nAI: I went with PostgreSQL because CampusConnect needed strong relational integrity.\nHost: ${result.resolved}`;
    const promptText = prompts.buildAskAiSessionPrompt({
      contextString,
      transcriptContext: contextString,
      activeContext,
      relation: result.relation,
      confidence: result.confidence
    });

    const iActiveContext = promptText.indexOf('=== ACTIVE CONTEXT ===');
    const iEvidence = promptText.indexOf('RELEVANT CANDIDATE EVIDENCE');
    const iConversation = promptText.indexOf('RELEVANT RECENT CONVERSATION');
    const iPersona = promptText.indexOf('You are Invisibrain');
    assert.ok(iActiveContext >= 0 && iEvidence > iActiveContext, 'ACTIVE CONTEXT must precede evidence');
    assert.ok(iConversation > iEvidence, 'evidence must precede the conversation block');
    assert.ok(iPersona > iConversation, 'general instructions (persona/style) must come last');
  });
});

test('Example: CampusConnect -> "the authentication part" refinement tracks the subtopic', () => {
  const tracker = createConversationTracker();
  tracker.resolveQuestion('Tell me about CampusConnect.');
  tracker.recordAnswer('CampusConnect is a university management platform with role-based dashboards.');
  const result = tracker.resolveQuestion('Can you explain the authentication part?');
  assert.equal(result.relation, QuestionRelation.REFINEMENT);
  assert.match(result.resolved, /"authentication" part of CampusConnect/);
  const block = formatActiveContextBlock(result);
  assert.ok(block.includes('Relation: REFINEMENT'));
});

test('Example: an explicit correction redirects the anchor to the corrected question', () => {
  const tracker = createConversationTracker();
  tracker.resolveQuestion('Tell me about your backend work.');
  const result = tracker.resolveQuestion('No, I meant the database design specifically.');
  assert.equal(result.relation, QuestionRelation.CORRECTION);
  assert.match(result.resolved, /correcting the previous question/);

  const { classification, isFollowUpLike } = __testing.buildContextPolicy({
    relation: result.relation,
    isResumeRelated: false,
    isJdRelated: false,
    isGeneralInterview: false
  });
  assert.equal(isFollowUpLike, true);
  assert.equal(classification, 'FOLLOW_UP');
});

test('screenshot-analysis path is unaffected: no ACTIVE CONTEXT, classifyQuery still drives it, no crash', () => {
  withMockContext(() => {
    const promptText = prompts.buildScreenshotAnalysisPrompt({
      contextString: 'Host: What is on the screen?',
      additionalContext: 'Tell me about my resume experience with databases',
      screenshotCount: 1
    });
    assert.equal(promptText.includes('=== ACTIVE CONTEXT ==='), false);
    assert.ok(promptText.includes('RELEVANT CANDIDATE EVIDENCE'));
    assert.ok(promptText.includes('=== SCREEN INPUT ==='));
  });
});

test('a genuine new topic after a follow-up chain does not stay pinned to the stale anchor', () => {
  const tracker = createConversationTracker();
  tracker.resolveQuestion('Why did you choose PostgreSQL?');
  tracker.resolveQuestion('What about MongoDB?');
  const result = tracker.resolveQuestion('What is React?');
  assert.equal(result.relation, QuestionRelation.NEW_TOPIC);
  assert.equal(result.wasResolved, false);

  const { classification } = __testing.buildContextPolicy({
    relation: result.relation,
    isResumeRelated: false,
    isJdRelated: false,
    isGeneralInterview: false
  });
  assert.notEqual(classification, 'FOLLOW_UP');
});

// ─── summary ────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Phase 6 tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  [${f.category}] ${f.name}\n    ${f.message}`);
  }
  process.exitCode = 1;
} else {
  console.log('All Phase 6 tests passed.');
}
