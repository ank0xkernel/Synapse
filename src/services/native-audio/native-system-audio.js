'use strict';

/**
 * Owns the native macOS system-audio helper (synapse-audio-capture, built from
 * native/macos-audio-capture/SynapseAudioCapture.swift).
 *
 * The helper captures what the Mac is playing through a Core Audio process tap
 * (macOS 14.2+) or ScreenCaptureKit (macOS 13.0+), while the user's output
 * device stays exactly as they set it. It writes 16 kHz mono Float32 PCM on
 * stdout and JSON status lines on stderr.
 *
 * This module turns that into: probe(), start(), stop(), a frame callback with
 * ~100 ms Float32Array frames, and a status callback. An unexpected helper exit
 * while capture is wanted is restarted with bounded backoff.
 */

const { spawn: defaultSpawn, execFile: defaultExecFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUTPUT_SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 1600; // 100 ms, matches audio-pipeline.js's TARGET_FRAME_MS
const BYTES_PER_SAMPLE = 4;
const READY_TIMEOUT_MS = 20000; // ScreenCaptureKit's own start timeout is 15 s
const STOP_GRACE_MS = 2000;
const RESTART_DELAYS_MS = [500, 1500, 4000];
const NON_RETRYABLE_CODES = new Set(['UNSUPPORTED_OS', 'PERMISSION_DENIED', 'BAD_ARGUMENT']);

function resolveHelperPath({ isPackaged = false, resourcesPath = process.resourcesPath, appRoot = path.join(__dirname, '..', '..', '..') } = {}) {
  return isPackaged
    ? path.join(resourcesPath, 'native', 'synapse-audio-capture')
    : path.join(appRoot, 'native', 'macos-audio-capture', 'build', 'synapse-audio-capture');
}

function createNativeSystemAudio({
  binaryPath,
  platform = process.platform,
  spawn = defaultSpawn,
  execFile = defaultExecFile,
  fileExists = (file) => fs.existsSync(file),
  onFrame = () => {},
  onStatus = () => {},
  log = console.log,
  restartDelaysMs = RESTART_DELAYS_MS,
  readyTimeoutMs = READY_TIMEOUT_MS
} = {}) {
  let child = null;
  let wanted = false;
  let backend = null;
  let lastStats = null;
  let lastError = null;
  let restartAttempt = 0;
  let restartTimer = null;
  let startOptions = {};
  let carry = Buffer.alloc(0);
  let pending = [];
  let pendingSamples = 0;
  let probeCache = null;

  function emitStatus(status, extra = {}) {
    try {
      onStatus({ status, backend, ...extra });
    } catch (error) {
      log(`[NativeAudio] status callback failed: ${error.message}`);
    }
  }

  function isSupportedPlatform() {
    return platform === 'darwin';
  }

  /** What this Mac supports. Cached: OS version and binary do not change while running. */
  function probe() {
    if (probeCache) return Promise.resolve(probeCache);

    if (!isSupportedPlatform()) {
      probeCache = { available: false, reason: 'not-macos' };
      return Promise.resolve(probeCache);
    }
    if (!binaryPath || !fileExists(binaryPath)) {
      return Promise.resolve({ available: false, reason: 'helper-missing', binaryPath });
    }

    return new Promise((resolve) => {
      execFile(binaryPath, ['probe'], { timeout: 5000 }, (error, stdout) => {
        if (error) {
          resolve({ available: false, reason: 'probe-failed', detail: error.message });
          return;
        }
        try {
          const info = JSON.parse(String(stdout).trim());
          probeCache = {
            available: Boolean(info.processTap || info.screenCaptureKit),
            reason: info.processTap || info.screenCaptureKit ? null : 'unsupported-os',
            ...info
          };
          resolve(probeCache);
        } catch (parseError) {
          resolve({ available: false, reason: 'probe-unparseable', detail: parseError.message });
        }
      });
    });
  }

  function flushFrames(force = false) {
    while (pendingSamples >= FRAME_SAMPLES || (force && pendingSamples > 0)) {
      const take = force ? pendingSamples : FRAME_SAMPLES;
      const frame = new Float32Array(take);
      let written = 0;
      while (written < take) {
        const head = pending[0];
        const needed = take - written;
        if (head.length <= needed) {
          frame.set(head, written);
          written += head.length;
          pending.shift();
        } else {
          frame.set(head.subarray(0, needed), written);
          pending[0] = head.subarray(needed);
          written += needed;
        }
      }
      pendingSamples -= take;
      try {
        onFrame(frame);
      } catch (error) {
        log(`[NativeAudio] frame callback failed: ${error.message}`);
      }
    }
  }

  /** stdout delivers arbitrary byte boundaries; keep the partial sample for next time. */
  function handlePcm(chunk) {
    const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const usable = buffer.length - (buffer.length % BYTES_PER_SAMPLE);
    if (usable > 0) {
      // Copy into an aligned buffer: Float32Array needs 4-byte alignment and a
      // Node Buffer slice is not guaranteed to have it.
      const aligned = new Float32Array(usable / BYTES_PER_SAMPLE);
      Buffer.from(aligned.buffer).set(buffer.subarray(0, usable));
      pending.push(aligned);
      pendingSamples += aligned.length;
      flushFrames();
    }
    carry = buffer.subarray(usable);
  }

  function handleEvent(event, settleStart) {
    switch (event.type) {
      case 'ready':
        backend = event.backend || null;
        restartAttempt = 0;
        lastError = null;
        log(`[NativeAudio] Capturing system audio via ${backend} (${event.sourceSampleRate} Hz, ${event.sourceChannels} ch, clock: ${event.clockDevice || 'n/a'})`);
        emitStatus('capturing', { sourceSampleRate: event.sourceSampleRate, clockDevice: event.clockDevice || null });
        settleStart({ success: true, backend });
        break;
      case 'stats':
        lastStats = event;
        if (event.droppedSamples > 0) {
          emitStatus('degraded', { droppedSamples: event.droppedSamples });
        }
        break;
      case 'device-changed':
        log(`[NativeAudio] Default output changed to "${event.defaultOutput}" — capture follows it`);
        emitStatus('device-changed', { defaultOutput: event.defaultOutput });
        break;
      case 'restarting':
        emitStatus('restarting', { reason: event.reason, attempt: event.attempt });
        break;
      case 'error':
        lastError = { code: event.code, message: event.message };
        log(`[NativeAudio] ${event.fatal ? 'Fatal' : 'Recoverable'} error ${event.code}: ${event.message}`);
        emitStatus(event.fatal ? 'error' : 'warning', { code: event.code, message: event.message });
        if (event.fatal) settleStart({ success: false, code: event.code, error: event.message });
        break;
      default:
        break;
    }
  }

  function spawnHelper(settleStart) {
    const args = ['capture', '--rate', String(OUTPUT_SAMPLE_RATE)];
    if (startOptions.backend) args.push('--backend', startOptions.backend);
    for (const pid of startOptions.excludePids || []) {
      if (Number.isInteger(pid) && pid > 0) args.push('--exclude-pid', String(pid));
    }

    carry = Buffer.alloc(0);
    pending = [];
    pendingSamples = 0;

    const proc = spawn(binaryPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child = proc;
    let stderrBuffer = '';

    proc.stdout.on('data', (chunk) => {
      if (child === proc) handlePcm(chunk);
    });

    proc.stderr.on('data', (chunk) => {
      stderrBuffer += String(chunk);
      let newline = stderrBuffer.indexOf('\n');
      while (newline !== -1) {
        const line = stderrBuffer.slice(0, newline).trim();
        stderrBuffer = stderrBuffer.slice(newline + 1);
        if (line) {
          try {
            handleEvent(JSON.parse(line), settleStart);
          } catch (_) {
            log(`[NativeAudio] helper: ${line}`);
          }
        }
        newline = stderrBuffer.indexOf('\n');
      }
    });

    proc.on('error', (error) => {
      lastError = { code: 'SPAWN_FAILED', message: error.message };
      settleStart({ success: false, code: 'SPAWN_FAILED', error: error.message });
    });

    proc.on('exit', (code, signal) => {
      if (child !== proc) return;
      child = null;
      flushFrames(true);
      settleStart({ success: false, code: lastError?.code || 'EXITED', error: lastError?.message || `Helper exited (code ${code}, signal ${signal})` });

      if (!wanted) {
        emitStatus('stopped');
        return;
      }

      const retryable = !NON_RETRYABLE_CODES.has(lastError?.code);
      if (!retryable || restartAttempt >= restartDelaysMs.length) {
        wanted = false;
        emitStatus('failed', { code: lastError?.code || 'EXITED', message: lastError?.message || 'Native capture stopped and could not be restarted' });
        return;
      }

      const delay = restartDelaysMs[restartAttempt];
      restartAttempt += 1;
      emitStatus('restarting', { reason: lastError?.code || 'exited', attempt: restartAttempt, delayMs: delay });
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (wanted && !child) spawnHelper(() => {});
      }, delay);
    });

    return proc;
  }

  /**
   * Starts capture. Resolves once the helper reports `ready` (or fails), so the
   * caller knows whether to open the transcription socket at all.
   * @param {{excludePids?: number[], backend?: string}} options
   */
  async function start(options = {}) {
    if (child) return { success: true, backend, alreadyRunning: true };

    const info = await probe();
    if (!info.available) {
      return { success: false, code: info.reason || 'UNAVAILABLE', error: `Native system audio capture is unavailable (${info.reason})` };
    }

    startOptions = options;
    wanted = true;
    restartAttempt = 0;
    lastError = null;
    backend = null;

    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => settle({ success: false, code: 'READY_TIMEOUT', error: 'Native capture did not become ready in time' }), readyTimeoutMs);

      function settle(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!result.success) {
          wanted = false;
          if (child) child.kill('SIGTERM');
        }
        resolve(result);
      }

      spawnHelper(settle);
    });
  }

  function stop() {
    wanted = false;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const proc = child;
    if (!proc) return Promise.resolve();

    return new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) { /* already gone */ }
      }, STOP_GRACE_MS);
      proc.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        proc.kill('SIGTERM');
      } catch (_) {
        clearTimeout(killTimer);
        resolve();
      }
    });
  }

  function getState() {
    return {
      running: Boolean(child),
      wanted,
      backend,
      lastStats,
      lastError,
      restartAttempt,
      binaryPath
    };
  }

  return { probe, start, stop, getState, isRunning: () => Boolean(child) };
}

module.exports = {
  createNativeSystemAudio,
  resolveHelperPath,
  OUTPUT_SAMPLE_RATE,
  FRAME_SAMPLES
};
