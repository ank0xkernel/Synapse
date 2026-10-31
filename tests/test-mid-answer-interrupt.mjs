#!/usr/bin/env node
/**
 * Mid-answer interrupt — focused test suite.
 *
 * Covers the fix for a real reported bug: the interviewer extends or
 * clarifies a question ("What is React?" -> mid-answer -> "give me an
 * example, where have you implemented React Native in your project?") and
 * Synapse finishes the stale first answer before ever starting the real
 * one, because the auto-answer queue was strict FIFO with no way to
 * interrupt an in-flight Gemini request.
 *
 * Two things changed, both tested against the real production modules:
 *  1. supersede-policy.js (new) — the pure decision of whether a new
 *     question should cancel the one currently in flight.
 *  2. gemini-service.js — tag-scoped AbortController plumbing so a request
 *     can actually be interrupted mid-stream, and abort is classified as a
 *     cancellation (isCancelled), never retried or treated as a failure.
 *
 * auto-answer.js itself wires these together but can't be imported under
 * plain Node (touches `document` at module scope) — same limitation noted
 * in test-latency-audio-reliability.mjs. Verified there by direct code
 * inspection instead.
 *
 * Run: node tests/test-mid-answer-interrupt.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const GeminiService = require(path.join(__dirname, '../src/services/ai/gemini-service.js'));
const { shouldSupersede, SUPERSEDE_UNKNOWN_WINDOW_MS } = await import('../src/windows/assistant/renderer/features/auto-answer/supersede-policy.js');
const { QuestionRelation } = await import('../src/windows/assistant/renderer/features/auto-answer/question-relation.js');

let passed = 0;
let failed = 0;
const failures = [];
let currentCategory = '';

function section(title) {
  currentCategory = title;
  console.log(`\n${title}`);
}
async function test(name, fn) {
  try {
    await fn();
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
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'assertion failed'}: expected ${expected}, got ${actual}`);
}

// ---------------------------------------------------------------------------
section('A. shouldSupersede — relation-driven decisions');
// ---------------------------------------------------------------------------

await test('A1. FOLLOW_UP while busy supersedes', () => {
  assertTrue(shouldSupersede(QuestionRelation.FOLLOW_UP, Date.now() - 500));
});
await test('A2. REFINEMENT while busy supersedes', () => {
  assertTrue(shouldSupersede(QuestionRelation.REFINEMENT, Date.now() - 500));
});
await test('A3. EXPANSION while busy supersedes', () => {
  assertTrue(shouldSupersede(QuestionRelation.EXPANSION, Date.now() - 500));
});
await test('A4. CLARIFICATION while busy supersedes', () => {
  assertTrue(shouldSupersede(QuestionRelation.CLARIFICATION, Date.now() - 500));
});
await test('A5. CONTINUATION while busy supersedes', () => {
  assertTrue(shouldSupersede(QuestionRelation.CONTINUATION, Date.now() - 500));
});
await test('A6. COMPARISON while busy supersedes', () => {
  assertTrue(shouldSupersede(QuestionRelation.COMPARISON, Date.now() - 500));
});
await test('A7. CORRECTION while busy supersedes ("no I meant X" invalidates the in-flight answer)', () => {
  assertTrue(shouldSupersede(QuestionRelation.CORRECTION, Date.now() - 500));
});
await test('A8. NEW_TOPIC while busy does NOT supersede — stays FIFO', () => {
  assertFalse(shouldSupersede(QuestionRelation.NEW_TOPIC, Date.now() - 500));
});
await test('A9. TOPIC_SWITCH while busy does NOT supersede — stays FIFO', () => {
  assertFalse(shouldSupersede(QuestionRelation.TOPIC_SWITCH, Date.now() - 500));
});
await test('A10. Nothing in flight (dispatchedAt null) never supersedes, regardless of relation', () => {
  assertFalse(shouldSupersede(QuestionRelation.FOLLOW_UP, null));
  assertFalse(shouldSupersede(QuestionRelation.CORRECTION, undefined));
});

// ---------------------------------------------------------------------------
section('B. shouldSupersede — UNKNOWN relation, time-windowed');
// ---------------------------------------------------------------------------

await test('B1. UNKNOWN arriving immediately after dispatch supersedes (the exact reported bug: "give me an example... React Native..." right after "What is React?")', () => {
  const dispatchedAt = 1_000_000;
  const now = dispatchedAt + 800; // interviewer keeps talking almost immediately
  assertTrue(shouldSupersede(QuestionRelation.UNKNOWN, dispatchedAt, now));
});
await test('B2. UNKNOWN arriving just under the window still supersedes', () => {
  const dispatchedAt = 1_000_000;
  const now = dispatchedAt + (SUPERSEDE_UNKNOWN_WINDOW_MS - 1);
  assertTrue(shouldSupersede(QuestionRelation.UNKNOWN, dispatchedAt, now));
});
await test('B3. UNKNOWN arriving at/after the window falls back to FIFO — plenty of time for a genuinely separate question', () => {
  const dispatchedAt = 1_000_000;
  const now = dispatchedAt + SUPERSEDE_UNKNOWN_WINDOW_MS;
  assertFalse(shouldSupersede(QuestionRelation.UNKNOWN, dispatchedAt, now));

  const muchLater = dispatchedAt + 30_000;
  assertFalse(shouldSupersede(QuestionRelation.UNKNOWN, dispatchedAt, muchLater));
});

// ---------------------------------------------------------------------------
section('C. The exact reported scenario, end to end through the real classifier');
// ---------------------------------------------------------------------------

await test('C1. "give me an example, where have you implemented React Native in your project?" classifies as UNKNOWN today (documents the EXPANSION_PATTERNS gap the time-window heuristic exists to cover)', async () => {
  const { classifyUtterance } = await import('../src/windows/assistant/renderer/features/auto-answer/question-relation.js');
  const { relation } = classifyUtterance(
    'give me an example, where have you implemented React Native in your project',
    { hasContext: true }
  );
  assertEqual(relation, QuestionRelation.UNKNOWN);
});
await test('C2. ...and because it is UNKNOWN + arrives quickly, shouldSupersede correctly says "interrupt and answer this instead"', () => {
  const dispatchedAt = Date.now() - 1200; // "What is React?" dispatched ~1.2s ago, still streaming
  assertTrue(shouldSupersede(QuestionRelation.UNKNOWN, dispatchedAt));
});
await test('C3. A real independent question ("What is Docker?") right after "What is React?" is NEW_TOPIC and does NOT interrupt', async () => {
  const { classifyUtterance } = await import('../src/windows/assistant/renderer/features/auto-answer/question-relation.js');
  const { relation } = classifyUtterance('What is Docker?', { hasContext: true });
  assertEqual(relation, QuestionRelation.NEW_TOPIC);
  assertFalse(shouldSupersede(relation, Date.now() - 500));
});

// ---------------------------------------------------------------------------
section('D. gemini-service.js — tag-scoped cancellation plumbing');
// ---------------------------------------------------------------------------

function pendingGeminiService() {
  const svc = new GeminiService('fake-key-for-testing');
  let capturedRequest = null;
  // Simulates an in-flight streaming request that only resolves/rejects
  // when the caller decides, so cancel() has something real to interrupt —
  // without ever making a real network call.
  svc._executeRequest = (request) => new Promise((resolve, reject) => {
    capturedRequest = request;
    if (request.controller) {
      request.controller.signal.addEventListener('abort', () => {
        const err = new Error('Request cancelled');
        err.isCancelled = true;
        reject(err);
      });
    }
  });
  return { svc, getCapturedRequest: () => capturedRequest };
}

await test('D1. A tagged request registers an AbortController in activeRequestsByTag while in flight', async () => {
  const { svc } = pendingGeminiService();
  const promise = svc.generateText('prompt', { tag: 'askAi' }).catch(() => {});
  await new Promise((r) => setImmediate(r));
  assertTrue(svc.activeRequestsByTag.has('askAi'), 'expected an active controller registered under askAi');
  svc.cancel('askAi');
  await promise;
});

await test('D2. cancel(tag) aborts the registered controller and the request rejects with isCancelled', async () => {
  const { svc } = pendingGeminiService();
  const promise = svc.generateText('prompt', { tag: 'askAi' });
  await new Promise((r) => setImmediate(r));

  const cancelled = svc.cancel('askAi');
  assertTrue(cancelled, 'cancel() should report it found and aborted something');

  let caught = null;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assertTrue(caught && caught.isCancelled === true, 'expected the request to reject with isCancelled=true');
});

await test('D3. cancel(tag) on an unknown/idle tag is a safe no-op', () => {
  const svc = new GeminiService('fake-key-for-testing');
  assertFalse(svc.cancel('askAi'));
  assertFalse(svc.cancel('nonexistent-tag'));
});

await test('D4. The tag slot is cleared once the request settles (success)', async () => {
  const svc = new GeminiService('fake-key-for-testing');
  svc._executeRequest = async (request) => { request.resolve('ok'); return 'ok'; };
  await svc.generateText('prompt', { tag: 'askAi' });
  assertFalse(svc.activeRequestsByTag.has('askAi'), 'expected the slot cleared after the request resolved');
});

await test('D5. The tag slot is cleared after a cancellation too, ready for the next question to reuse it immediately', async () => {
  const { svc } = pendingGeminiService();
  const first = svc.generateText('first', { tag: 'askAi' });
  await new Promise((r) => setImmediate(r));
  svc.cancel('askAi');
  await first.catch(() => {});
  assertFalse(svc.activeRequestsByTag.has('askAi'));
});

await test('D6. An untagged request is simply never cancellable (no controller, no tracking) — existing screenAi/suggest/notes/insights callers are unaffected', async () => {
  const svc = new GeminiService('fake-key-for-testing');
  svc._executeRequest = async (request) => { request.resolve('ok'); return 'ok'; };
  const result = await svc.generateText('prompt');
  assertEqual(result, 'ok');
  assertEqual(svc.activeRequestsByTag.size, 0);
});

await test('D7. isAbortError recognizes both a real AbortError and a message-based fallback', () => {
  const svc = new GeminiService('fake-key-for-testing');
  const domAbort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  assertTrue(svc.isAbortError(domAbort));
  assertTrue(svc.isAbortError(new Error('signal is aborted without reason')));
  assertFalse(svc.isAbortError(new Error('429 rate limit exceeded')));
});

// ---------------------------------------------------------------------------
section('E. _executeRequest — abort is never retried or misreported as quota/auth failure');
// ---------------------------------------------------------------------------

await test('E1. An aborted streaming request throws isCancelled and never reaches retry backoff', async () => {
  const svc = new GeminiService('fake-key-for-testing');
  let retryAttempts = 0;
  const controller = new AbortController();
  controller.abort();

  // Stand in for the SDK's own fetch-level rejection when the signal is
  // already aborted before the call is even made.
  svc.model = {
    generateContentStream: async (_data, options) => {
      retryAttempts += 1;
      if (options?.signal?.aborted) {
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        throw err;
      }
      throw new Error('unexpected: signal not aborted');
    }
  };

  const request = { type: 'text', data: 'prompt', onChunk: () => {}, controller };
  let caught = null;
  try {
    await svc._executeRequest(request);
  } catch (err) {
    caught = err;
  }
  assertTrue(caught && caught.isCancelled === true, 'expected isCancelled=true');
  assertEqual(retryAttempts, 1, 'a cancellation must not be retried like a transient network error');
});

// ---------------------------------------------------------------------------
console.log('\n' + '─'.repeat(60));
console.log(`Mid-answer interrupt tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  [${f.category}] ${f.name}`);
    console.log(`    ${f.message}`);
  }
  process.exit(1);
} else {
  console.log('All mid-answer interrupt tests passed.');
}
