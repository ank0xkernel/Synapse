#!/usr/bin/env node
/**
 * Audio & Latency Engineering Phase — focused test suite.
 *
 * Covers the two things actually changed this phase:
 *  1. gemini-service.js's rate limiter (flat 6000ms interval -> sliding
 *     window) — the single largest measured latency contributor.
 *  2. question-latency-tracker.js's T0 handling, now fed a real
 *     renderer-measured timestamp instead of always defaulting to "now".
 *
 * Both are tested against the REAL production modules, not
 * reimplementations. The renderer-side bridging (auto-answer.js /
 * renderer.js) that carries T0 across the askBtn.click() boundary is DOM-
 * coupled (document.getElementById, window globals at module scope) and
 * cannot run in plain Node the way conversation-tracker.js etc. can — it is
 * NOT independently tested here; it was verified by direct code inspection
 * following the exact, already-proven __synapseActiveQuestionId pattern
 * (see the Audio & Latency Engineering Report, section 5).
 *
 * Run: node tests/test-latency-audio-reliability.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const GeminiService = require(path.join(__dirname, '../src/services/ai/gemini-service.js'));
const { createQuestionLatencyTracker } = require(path.join(__dirname, '../src/services/latency/question-latency-tracker.js'));

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
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'assertion failed'}: expected ${expected}, got ${actual}`);
}
function assertLessThan(actual, bound, msg) {
  if (!(actual < bound)) throw new Error(`${msg || 'assertion failed'}: expected ${actual} < ${bound}`);
}
function assertAtLeast(actual, bound, msg) {
  if (!(actual >= bound)) throw new Error(`${msg || 'assertion failed'}: expected ${actual} >= ${bound}`);
}

function stubbedGeminiService() {
  const svc = new GeminiService('fake-key-for-testing');
  svc._executeRequest = async (request) => {
    request.resolve('stub response');
    return 'stub response';
  };
  return svc;
}

// ─── Rate limiter (the primary latency fix) ─────────────────────────────────
section('Gemini rate limiter — sliding window (replaces flat 6000ms interval)');

await test('Two requests spaced 1.2s apart (normal follow-up pacing) add zero artificial delay', async () => {
  const svc = stubbedGeminiService();
  const t0 = Date.now();
  await svc.generateText('question 1');
  const firstElapsed = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 1200));
  const t1 = Date.now();
  await svc.generateText('question 2');
  const secondElapsed = Date.now() - t1;
  assertLessThan(firstElapsed, 100, 'first request should resolve near-instantly');
  assertLessThan(secondElapsed, 100, 'second request should ALSO resolve near-instantly -- this is the actual fix; before it, this took ~4800ms');
});

await test('A burst up to the cap (10 requests) resolves with no added delay', async () => {
  const svc = stubbedGeminiService();
  const start = Date.now();
  const promises = Array.from({ length: 10 }, (_, i) => svc.generateText(`burst ${i}`));
  await Promise.all(promises);
  assertLessThan(Date.now() - start, 200, '10 requests within the cap should all resolve quickly');
});

await test('The 11th request within the rolling window is correctly throttled (real protection still holds)', async () => {
  const svc = stubbedGeminiService();
  // Manually seed 10 "recent" timestamps to avoid a real 60s test wait --
  // exercises the exact same code path waitForRateLimit() runs, just with a
  // pre-populated window instead of firing 10 real requests first.
  const now = Date.now();
  svc.requestTimestamps = Array.from({ length: 10 }, () => now - 100);

  let resolvedAt = null;
  // Deliberately not awaited to completion: waitForRateLimit() computes and
  // locks in a ~60s setTimeout the moment it runs, so once started this
  // promise cannot be fast-forwarded by mutating requestTimestamps
  // afterward -- checking it is still correctly PENDING after a short delay
  // is what actually proves the cap is enforced, without the test needing
  // to wait out a real minute. The "it eventually resolves once the window
  // frees up" half was verified separately (see the Audio & Latency
  // Engineering Report) via a direct, real ~60s run showing requests 11/12
  // resolving at ~60010ms right after the 10 seeded entries actually aged
  // out -- not re-asserted here to keep this suite fast.
  svc.generateText('the 11th request').then(() => { resolvedAt = Date.now(); });

  await new Promise((r) => setTimeout(r, 300));
  assertEqual(resolvedAt, null, 'the 11th request must still be waiting after 300ms -- the cap must still be enforced');
});

await test('requestTimestamps is pruned to entries still inside the window (no unbounded growth)', async () => {
  const svc = stubbedGeminiService();
  // Seed timestamps that have already aged out alongside real recent ones --
  // firing enough real requests to actually exercise this would mean
  // exceeding maxRequestsPerWindow within the test's own runtime, which
  // (correctly) triggers the real ~60s wait tested separately above. This
  // instead directly exercises waitForRateLimit()'s own pruning step.
  const now = Date.now();
  svc.requestTimestamps = [now - 70000, now - 65000, now - 61000, now - 100];
  await svc.generateText('one more request');
  assertEqual(svc.requestTimestamps.length, 2, 'the 3 aged-out entries should have been pruned, leaving only the recent one plus this new request');
});

await test('The old flat-interval properties are gone (confirms the fix actually replaced the mechanism, not just added to it)', () => {
  const svc = stubbedGeminiService();
  assertEqual(svc.minRequestInterval, undefined);
  assertEqual(svc.lastRequestTime, undefined);
  assertTrue(Array.isArray(svc.requestTimestamps));
  assertEqual(svc.maxRequestsPerWindow, 10);
  assertEqual(svc.rateLimitWindowMs, 60000);
});

// ─── Latency tracker T0 wiring ───────────────────────────────────────────────
section('question-latency-tracker.js — T0 handling');

await test('An explicit historical T0 is honored (not overwritten by "now")', () => {
  const tracker = createQuestionLatencyTracker({ log: () => {} });
  const realT0 = Date.now() - 850; // simulates a question detected 850ms before this IPC call arrived
  const id = tracker.start({ mode: 'best-next-answer' }, realT0);
  tracker.mark(id, 'T2'); // "now"
  const report = tracker.complete(id);
  assertAtLeast(report.segments.detection, 800, 'T0->T2 (detection) should reflect the real ~850ms gap, not ~0ms');
});

await test('Omitting T0 falls back to "now" (manual Ask button click has no earlier detected moment)', () => {
  const tracker = createQuestionLatencyTracker({ log: () => {} });
  const before = Date.now();
  const id = tracker.start({ mode: 'best-next-answer' }, undefined);
  tracker.mark(id, 'T2');
  const report = tracker.complete(id);
  assertLessThan(report.segments.detection, 50, 'with no real T0, detection segment should be ~0ms, not artificially inflated');
  assertTrue(report.timestamps.T0 >= before, 'T0 should have defaulted to a timestamp at/after start() was called');
});

await test('mark() first-arrival-wins semantics are unchanged (regression check, not a Phase behavior this task touched)', () => {
  const tracker = createQuestionLatencyTracker({ log: () => {} });
  const id = tracker.start({}, Date.now());
  tracker.mark(id, 'T2', 1000);
  tracker.mark(id, 'T2', 2000); // must be ignored -- first arrival wins
  const report = tracker.complete(id);
  assertEqual(report.timestamps.T2, 1000);
});

await test('abandon() drops the timeline without reporting (regression check)', () => {
  let reported = false;
  const tracker = createQuestionLatencyTracker({ log: () => {}, onComplete: () => { reported = true; } });
  const id = tracker.start({}, Date.now());
  tracker.abandon(id);
  assertEqual(tracker.activeCount(), 0);
  assertTrue(!reported, 'abandon() must never emit a report');
});

await test('A full T0->T6 report computes every documented segment correctly with a real T0', () => {
  const tracker = createQuestionLatencyTracker({ log: () => {} });
  const t0 = Date.now();
  const id = tracker.start({ mode: 'best-next-answer' }, t0);
  tracker.mark(id, 'T2', t0 + 30);   // IPC handler invoked
  tracker.mark(id, 'T3', t0 + 35);   // context assembled
  tracker.mark(id, 'T4', t0 + 40);   // request sent
  tracker.mark(id, 'T5', t0 + 640);  // first Gemini token
  // complete() marks T6 with Date.now() by default -- mark() explicitly
  // here first so the whole synthetic timeline stays internally consistent
  // (first-arrival-wins means complete()'s own internal mark becomes a
  // no-op once T6 already has a value).
  tracker.mark(id, 'T6', t0 + 680);
  const report = tracker.complete(id);
  assertEqual(report.segments.detection, 30);
  assertEqual(report.segments.context, 5);
  assertEqual(report.segments.requestSetup, 5);
  assertEqual(report.segments.geminiFirst, 600);
  assertEqual(report.segments.browser, 40);
  assertEqual(report.total, 680);
});

// ─── summary ────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Audio & Latency tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  [${f.category}] ${f.name}\n    ${f.message}`);
  }
} else {
  console.log('All Audio & Latency tests passed.');
}

// One test above deliberately leaves an unresolved ~60s rate-limit timer
// running (see its own comment) — without this, Node would keep the
// process alive waiting for that orphaned timer instead of exiting once the
// actual assertions are done.
process.exit(failed > 0 ? 1 : 0);
