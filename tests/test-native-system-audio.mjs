#!/usr/bin/env node
/**
 * native-system-audio.js (the main-process owner of the macOS capture helper)
 * plus a real-binary integration check.
 *
 * Unit part: a fake child process stands in for the helper, so framing,
 * restart, permission handling and cleanup are tested deterministically.
 * Integration part (macOS only): builds and runs the real helper, captures
 * while a system sound plays through whatever output is selected, and checks
 * that real (non-silent) audio arrives without any output-device change.
 *
 * Run: node tests/test-native-system-audio.mjs
 */
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { execFileSync, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createNativeSystemAudio, FRAME_SAMPLES } = require(path.join(__dirname, '../src/services/native-audio/native-system-audio.js'));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}
function section(title) {
  console.log(`\n${title}`);
}
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake helper process: tests push stdout bytes / stderr events into it. */
function createFakeSpawn() {
  const spawned = [];
  const spawn = (binary, args) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { end() {} };
    proc.args = args;
    proc.killed = [];
    proc.kill = (signal) => {
      proc.killed.push(signal);
      setImmediate(() => proc.emit('exit', 0, signal));
    };
    proc.event = (event) => proc.stderr.emit('data', Buffer.from(`${JSON.stringify(event)}\n`));
    proc.pcm = (floats) => proc.stdout.emit('data', Buffer.from(new Float32Array(floats).buffer));
    spawned.push(proc);
    return proc;
  };
  return { spawn, spawned };
}

function makeManager(overrides = {}) {
  const fake = createFakeSpawn();
  const frames = [];
  const statuses = [];
  const manager = createNativeSystemAudio({
    binaryPath: '/fake/synapse-audio-capture',
    platform: 'darwin',
    spawn: fake.spawn,
    fileExists: () => true,
    execFile: (_bin, _args, _opts, callback) => callback(null, JSON.stringify({ processTap: true, screenCaptureKit: true, recommendedBackend: 'process-tap', osVersion: '26.0.0' })),
    onFrame: (frame) => frames.push(frame),
    onStatus: (status) => statuses.push(status),
    log: () => {},
    restartDelaysMs: [5, 5],
    readyTimeoutMs: 200,
    ...overrides
  });
  return { manager, fake, frames, statuses };
}

section('probe()');

await test('Not macOS -> unavailable, helper never spawned', async () => {
  const { manager, fake } = makeManager({ platform: 'linux' });
  const info = await manager.probe();
  assert(info.available === false && info.reason === 'not-macos');
  const result = await manager.start();
  assert(result.success === false);
  assert(fake.spawned.length === 0);
});

await test('Missing helper binary -> unavailable with reason helper-missing', async () => {
  const { manager } = makeManager({ fileExists: () => false });
  const info = await manager.probe();
  assert(info.reason === 'helper-missing');
});

await test('Supported Mac -> available, recommended backend passed through', async () => {
  const { manager } = makeManager();
  const info = await manager.probe();
  assert(info.available === true);
  assert(info.recommendedBackend === 'process-tap');
});

section('start() / ready / framing');

await test('start() resolves on ready and passes excluded PIDs to the helper', async () => {
  const { manager, fake } = makeManager();
  const pending = manager.start({ excludePids: [111, 222, -1] });
  await tick();
  const proc = fake.spawned[0];
  assert(proc.args.includes('--exclude-pid') && proc.args.includes('111') && proc.args.includes('222'));
  assert(!proc.args.includes('-1'), 'invalid PIDs are dropped');
  proc.event({ type: 'ready', backend: 'process-tap', sourceSampleRate: 48000, sourceChannels: 2 });
  const result = await pending;
  assert(result.success === true && result.backend === 'process-tap');
  await manager.stop();
});

await test('PCM split across arbitrary byte boundaries reassembles into exact 100 ms frames', async () => {
  const { manager, fake, frames } = makeManager();
  const pending = manager.start();
  await tick();
  const proc = fake.spawned[0];
  proc.event({ type: 'ready', backend: 'process-tap' });
  await pending;

  const samples = new Float32Array(FRAME_SAMPLES * 2 + 10).map((_, i) => (i % 100) / 100);
  const bytes = Buffer.from(samples.buffer);
  // Deliberately misaligned chunk sizes (not multiples of 4).
  for (let offset = 0; offset < bytes.length; offset += 4097) {
    proc.stdout.emit('data', bytes.subarray(offset, Math.min(offset + 4097, bytes.length)));
  }
  assert(frames.length === 2, `expected 2 full frames, got ${frames.length}`);
  assert(frames[0].length === FRAME_SAMPLES);
  assert(Math.abs(frames[1][5] - samples[FRAME_SAMPLES + 5]) < 1e-6, 'sample values survive reassembly');
  await manager.stop();
  assert(frames.length === 3 && frames[2].length === 10, 'stop flushes the partial tail frame');
});

await test('Fatal PERMISSION_DENIED -> start fails with that code and does not restart', async () => {
  const { manager, fake, statuses } = makeManager();
  const pending = manager.start();
  await tick();
  fake.spawned[0].event({ type: 'error', code: 'PERMISSION_DENIED', message: 'denied', fatal: true });
  const result = await pending;
  assert(result.success === false && result.code === 'PERMISSION_DENIED');
  await tick(30);
  assert(fake.spawned.length === 1, 'no restart after a permission denial');
  assert(statuses.some((s) => s.status === 'error' && s.code === 'PERMISSION_DENIED'));
});

await test('Helper never becomes ready -> READY_TIMEOUT, helper killed', async () => {
  const { manager, fake } = makeManager({ readyTimeoutMs: 30 });
  const result = await manager.start();
  assert(result.success === false && result.code === 'READY_TIMEOUT');
  assert(fake.spawned[0].killed.includes('SIGTERM'));
});

section('recovery and cleanup');

await test('Unexpected helper exit while capturing -> bounded restart, then failed', async () => {
  const { manager, fake, statuses } = makeManager();
  const pending = manager.start();
  await tick();
  fake.spawned[0].event({ type: 'ready', backend: 'process-tap' });
  await pending;

  fake.spawned[0].emit('exit', 1, null); // crash 1
  await tick(20);
  assert(fake.spawned.length === 2, 'restarted once');
  fake.spawned[1].emit('exit', 1, null); // crash 2
  await tick(20);
  assert(fake.spawned.length === 3, 'restarted twice');
  fake.spawned[2].emit('exit', 1, null); // crash 3: budget (2 delays) exhausted
  await tick(20);
  assert(fake.spawned.length === 3, 'no unbounded restart loop');
  assert(statuses.some((s) => s.status === 'failed'));
  assert(manager.getState().wanted === false);
});

await test('stop() sends SIGTERM, resolves on exit, and suppresses restart', async () => {
  const { manager, fake } = makeManager();
  const pending = manager.start();
  await tick();
  fake.spawned[0].event({ type: 'ready', backend: 'process-tap' });
  await pending;
  await manager.stop();
  assert(fake.spawned[0].killed[0] === 'SIGTERM');
  await tick(20);
  assert(fake.spawned.length === 1, 'an intentional stop is never restarted');
  assert(manager.isRunning() === false);
});

await test('Dropped samples in stats surface as a degraded status', async () => {
  const { manager, fake, statuses } = makeManager();
  const pending = manager.start();
  await tick();
  fake.spawned[0].event({ type: 'ready', backend: 'process-tap' });
  await pending;
  fake.spawned[0].event({ type: 'stats', droppedSamples: 1600, samplesOut: 32000 });
  assert(statuses.some((s) => s.status === 'degraded' && s.droppedSamples === 1600));
  assert(manager.getState().lastStats.samplesOut === 32000);
  await manager.stop();
});

if (process.platform === 'darwin') {
  section('integration: real helper, current output device untouched');

  const { buildNativeAudio, NATIVE_AUDIO_BINARY } = require(path.join(__dirname, '../scripts/build-native-audio.js'));

  await test('Helper builds as a universal (arm64 + x86_64) binary', async () => {
    buildNativeAudio({ log: () => {} });
    const archs = execFileSync('lipo', ['-archs', NATIVE_AUDIO_BINARY]).toString();
    assert(archs.includes('arm64') && archs.includes('x86_64'), `got: ${archs}`);
  });

  await test('Captures real audio of a played sound, and the output device is the same afterwards', async () => {
    const before = JSON.parse(execFileSync(NATIVE_AUDIO_BINARY, ['probe']).toString());
    let peak = 0;
    let samples = 0;
    const manager = createNativeSystemAudio({
      binaryPath: NATIVE_AUDIO_BINARY,
      log: () => {},
      onFrame: (frame) => {
        samples += frame.length;
        for (const value of frame) peak = Math.max(peak, Math.abs(value));
      }
    });
    const result = await manager.start({ excludePids: [process.pid] });
    assert(result.success, `start failed: ${result.code} ${result.error}`);
    await new Promise((resolve) => execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], resolve));
    await tick(500);
    await manager.stop();
    const after = JSON.parse(execFileSync(NATIVE_AUDIO_BINARY, ['probe']).toString());

    assert(samples > 16000, `expected > 1 s of PCM, got ${samples} samples`);
    assert(peak > 0.01, `expected audible signal, peak was ${peak} (permission denied, or output muted?)`);
    assert(before.defaultOutput === after.defaultOutput, `output changed: ${before.defaultOutput} -> ${after.defaultOutput}`);
    console.log(`      backend=${result.backend} output="${after.defaultOutput}" peak=${(20 * Math.log10(peak)).toFixed(1)}dBFS samples=${samples}`);
  });

  const { spawn } = await import('node:child_process');
  const helperEvents = (proc, sink) => {
    let buffer = '';
    proc.stderr.on('data', (chunk) => {
      buffer += String(chunk);
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try { sink.push(JSON.parse(line)); } catch (_) { /* ignore */ }
      }
    });
  };

  await test('Helper exits on its own when the parent goes away (stdin EOF), releasing the tap', async () => {
    const proc = spawn(NATIVE_AUDIO_BINARY, ['capture'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const events = [];
    helperEvents(proc, events);
    proc.stdout.resume();
    await tick(800);
    const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
    proc.stdin.end();
    const code = await Promise.race([exited, tick(4000).then(() => 'timeout')]);
    assert(code === 0, `expected clean exit, got ${code}`);
    assert(events.some((e) => e.type === 'stopped' && e.reason === 'parent-exited'));
  });

  await test('Consumer stops reading -> helper drops (and counts) audio instead of buffering without bound', async () => {
    const proc = spawn(NATIVE_AUDIO_BINARY, ['capture'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const events = [];
    helperEvents(proc, events);
    proc.stdout.pause(); // never read: the pipe fills, then the helper must start dropping
    await tick(7000);
    proc.kill('SIGTERM');
    await new Promise((resolve) => proc.on('exit', resolve));
    const stats = events.filter((e) => e.type === 'stats');
    const last = stats[stats.length - 1];
    assert(last, 'helper emitted stats');
    assert(last.droppedSamples > 0, `expected drops, got ${JSON.stringify(last)}`);
    assert(stats.every((s) => s.pendingSamples <= 32000), 'pending audio stays within the 2 s bound');
  });
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Native system audio tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
