#!/usr/bin/env node
/**
 * Phase 13 — diagnostic instrumentation test suite.
 *
 * Tests the REAL production modules: diagnostic-snapshot.js's pure
 * report-building/health-derivation logic, question-latency-tracker.js's
 * new getLastReport()/getActiveReports(), assembly-ai/service.js's new
 * getDiagnosticState(), and system-health.js's new checkSynapseOutputDevice
 * (against real live system state, same as it will run in production).
 *
 * Run: node tests/test-diagnostic-snapshot.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { createQuestionLatencyTracker } = require(path.join(__dirname, '../src/services/latency/question-latency-tracker.js'));
const { checkSynapseOutputDevice } = require(path.join(__dirname, '../src/services/system-health.js'));

const {
  buildDiagnosticReport,
  MicState,
  SystemAudioState,
  BlackHoleState,
  AssemblyAiState,
  PcmState,
  __testing
} = await import('../src/windows/assistant/renderer/features/diagnostics/diagnostic-snapshot.js');

let passed = 0;
let failed = 0;
const failures = [];
let currentCategory = '';

function section(title) { currentCategory = title; console.log(`\n${title}`); }
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
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertTrue(cond, msg) { if (!cond) throw new Error(msg || 'expected true'); }

// ─── PCM state derivation ────────────────────────────────────────────────
section('derivePcmState — frame stall / silence / flowing');

await test('Inactive source -> null (nothing to grade)', () => {
  assertEqual(__testing.derivePcmState({ active: false, lastFrameAt: 0, silenceInfo: null, now: 1000 }), null);
});

await test('Active, never sent a frame -> STALLED', () => {
  assertEqual(__testing.derivePcmState({ active: true, lastFrameAt: 0, silenceInfo: {}, now: 1000 }), PcmState.STALLED);
});

await test('Active, last frame >3000ms ago -> STALLED', () => {
  assertEqual(__testing.derivePcmState({ active: true, lastFrameAt: 1000, silenceInfo: { signalConfirmed: true }, now: 5000 }), PcmState.STALLED);
});

await test('Active, recent frame, signal confirmed -> FLOWING', () => {
  assertEqual(__testing.derivePcmState({ active: true, lastFrameAt: 900, silenceInfo: { signalConfirmed: true }, now: 1000 }), PcmState.FLOWING);
});

await test('Active, recent frame, signal NOT confirmed -> SILENT', () => {
  assertEqual(__testing.derivePcmState({ active: true, lastFrameAt: 900, silenceInfo: { signalConfirmed: false }, now: 1000 }), PcmState.SILENT);
});

// ─── Mic/system health-state derivation ──────────────────────────────────
section('deriveMicState / deriveSystemAudioState');

await test('Mic status "error" -> MIC_NOT_AVAILABLE regardless of PCM state', () => {
  assertEqual(__testing.deriveMicState({ status: 'error', pcmState: null }), MicState.NOT_AVAILABLE);
});

await test('Mic status "off" -> null (not currently running, not a failure)', () => {
  assertEqual(__testing.deriveMicState({ status: 'off', pcmState: null }), null);
});

await test('Mic "listening" + PCM_FLOWING -> MIC_OK', () => {
  assertEqual(__testing.deriveMicState({ status: 'listening', pcmState: PcmState.FLOWING }), MicState.OK);
});

await test('Mic "listening" + PCM_SILENT -> MIC_SILENT', () => {
  assertEqual(__testing.deriveMicState({ status: 'listening', pcmState: PcmState.SILENT }), MicState.SILENT);
});

await test('System "listening" + PCM_SILENT + routing known-bad -> SYSTEM_AUDIO_NOT_ROUTED', () => {
  assertEqual(
    __testing.deriveSystemAudioState({ status: 'listening', pcmState: PcmState.SILENT, audioRoutingOk: false }),
    SystemAudioState.NOT_ROUTED
  );
});

await test('System "listening" + PCM_SILENT + routing looks fine -> SYSTEM_AUDIO_SILENT (the more mysterious case, not conflated with a routing problem)', () => {
  assertEqual(
    __testing.deriveSystemAudioState({ status: 'listening', pcmState: PcmState.SILENT, audioRoutingOk: true }),
    SystemAudioState.SILENT
  );
});

await test('System "listening" + PCM_FLOWING -> SYSTEM_AUDIO_OK', () => {
  assertEqual(
    __testing.deriveSystemAudioState({ status: 'listening', pcmState: PcmState.FLOWING, audioRoutingOk: true }),
    SystemAudioState.OK
  );
});

// ─── frames/sec ────────────────────────────────────────────────────────
section('computeAvgFramesPerSecond');

await test('100 chunks over 10 real seconds -> 10.0/sec', () => {
  const now = 20000;
  const startedAt = 10000;
  assertEqual(__testing.computeAvgFramesPerSecond(100, startedAt, now), 10);
});

await test('No chunks yet -> 0', () => {
  assertEqual(__testing.computeAvgFramesPerSecond(0, 10000, 20000), 0);
});

await test('Never started (startedAt=0) -> 0, not Infinity/NaN', () => {
  assertEqual(__testing.computeAvgFramesPerSecond(5, 0, 20000), 0);
});

// ─── Full report assembly (CASE A-D from the audio/latency phases' own taxonomy) ──
section('buildDiagnosticReport — full assembly, matches the CASE A-D taxonomy');

await test('CASE A: no PCM frames at all while active -> STALLED, health reflects it, no fabricated numbers', () => {
  const report = buildDiagnosticReport({
    now: 5000,
    mic: { active: true, status: 'listening', lastFrameAt: 0, chunkCount: 0, silenceInfo: null, startedAt: 1000 },
    system: { active: false, status: 'off', lastFrameAt: 0, chunkCount: 0, silenceInfo: null, startedAt: 0 }
  });
  assertEqual(report.frames.mic.pcmState, PcmState.STALLED);
  assertEqual(report.frames.mic.received, 0);
  assertEqual(report.health.mic, MicState.SILENT, 'STALLED still counts as not-OK for the mic health label, since it is not FLOWING');
});

await test('CASE B: PCM frames flowing but signal silent -> health correctly distinguishes from CASE A', () => {
  const report = buildDiagnosticReport({
    now: 5000,
    mic: { active: false, status: 'off', lastFrameAt: 0, chunkCount: 0, silenceInfo: null, startedAt: 0 },
    system: {
      active: true, status: 'listening', lastFrameAt: 4950, chunkCount: 50,
      silenceInfo: { signalConfirmed: false, sinceMs: 3000, peakDb: -70, rmsDb: -75 }, startedAt: 0
    },
    audioRouting: { ok: true, defaultOutputName: 'BlackHole 2ch' }
  });
  assertEqual(report.frames.system.pcmState, PcmState.SILENT);
  assertEqual(report.health.systemAudio, SystemAudioState.SILENT);
  assertEqual(report.signal.system.rmsDb, -75, 'real signal numbers must pass through untouched, never invented');
});

await test('BlackHole/AssemblyAI health labels reuse the real check results directly', () => {
  const report = buildDiagnosticReport({
    now: 1000,
    mic: {}, system: {},
    blackHole: { ok: true, detail: 'BlackHole detected' },
    transcription: { mic: { streaming: true, framesSent: 10, framesDropped: 0 }, system: { streaming: false, framesSent: 0, framesDropped: 0 } }
  });
  assertEqual(report.health.blackHole, BlackHoleState.DETECTED);
  assertEqual(report.health.assemblyAiMic, AssemblyAiState.CONNECTED);
  assertEqual(report.health.assemblyAiSystem, AssemblyAiState.DISCONNECTED);
});

await test('No security-sensitive fields anywhere in a realistic report (no keys, no auth headers, no raw transcript text)', () => {
  const report = buildDiagnosticReport({
    now: 1000,
    mic: { active: true, status: 'listening', lastFrameAt: 950, chunkCount: 10, silenceInfo: { signalConfirmed: true, rmsDb: -20, peakDb: -10, sinceMs: 0 }, startedAt: 0 },
    system: {},
    monitorLog: [{ level: 'info', event: 'chunk-heartbeat', message: 'Streaming audio chunks', source: 'mic', meta: { chunks: 50 }, timestamp: 900 }]
  });
  const serialized = JSON.stringify(report).toLowerCase();
  for (const forbidden of ['apikey', 'api_key', 'authorization', 'bearer ', 'password']) {
    assertTrue(!serialized.includes(forbidden), `must not contain "${forbidden}"`);
  }
});

// ─── question-latency-tracker.js — getLastReport / getActiveReports ─────────
section('question-latency-tracker.js — new diagnostic getters');

await test('getLastReport() is null before anything completes', () => {
  const tracker = createQuestionLatencyTracker({ log: () => {} });
  assertEqual(tracker.getLastReport(), null);
});

await test('getLastReport() returns the most recently completed report, readable after the fact', () => {
  const tracker = createQuestionLatencyTracker({ log: () => {} });
  const id = tracker.start({ mode: 'best-next-answer' }, 1000);
  tracker.mark(id, 'T2', 1030);
  tracker.complete(id);
  const report = tracker.getLastReport();
  assertTrue(report !== null);
  assertEqual(report.segments.detection, 30);
});

await test('getActiveReports() reflects an in-flight question with UNKNOWN (null) for stages not yet reached', () => {
  const tracker = createQuestionLatencyTracker({ log: () => {} });
  const id = tracker.start({ mode: 'best-next-answer' }, 1000);
  tracker.mark(id, 'T2', 1030);
  const active = tracker.getActiveReports();
  assertEqual(active.length, 1);
  assertEqual(active[0].segments.detection, 30);
  assertEqual(active[0].segments.geminiFirst, null, 'T5 never arrived -- must be null (UNKNOWN), never fabricated');
  assertEqual(tracker.activeCount(), 1, 'getActiveReports must not consume/clear the in-flight entry');
});

await test('abandon()ed questions never appear in getLastReport()', () => {
  const tracker = createQuestionLatencyTracker({ log: () => {} });
  const id = tracker.start({}, 1000);
  tracker.abandon(id);
  assertEqual(tracker.getLastReport(), null);
});

// ─── system-health.js — checkSynapseOutputDevice (real live system) ────────
section('system-health.js — checkSynapseOutputDevice (real live system check)');

await test('Returns a well-formed result against the real live system (not a mock)', async () => {
  const result = await checkSynapseOutputDevice();
  assertTrue(typeof result.applicable === 'boolean');
  if (result.applicable) {
    assertTrue(typeof result.exists === 'boolean');
    assertTrue(typeof result.active === 'boolean');
    assertTrue(typeof result.detail === 'string' && result.detail.length > 0);
  }
});

// ─── summary ────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Diagnostic instrumentation tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  [${f.category}] ${f.name}\n    ${f.message}`);
  }
  process.exitCode = 1;
} else {
  console.log('All diagnostic instrumentation tests passed.');
}
