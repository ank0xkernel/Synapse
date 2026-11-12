'use strict';

// Local OCR: owns the long-lived synapse-ocr helper (Apple Vision) and an
// optional injected vision-model fallback. Pure CommonJS, no electron.

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_RESTARTS_PER_MINUTE = 3;
const RESTART_WINDOW_MS = 60000;

function resolveOcrHelperPath({
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  appRoot = path.join(__dirname, '..', '..', '..')
} = {}) {
  return isPackaged
    ? path.join(resourcesPath, 'native', 'synapse-ocr')
    : path.join(appRoot, 'native', 'macos-ocr', 'build', 'synapse-ocr');
}

function ocrError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function mapFallbackError(error) {
  if (error && error.code === 'CANCELLED') return error;
  if (error && error.name === 'AbortError') return ocrError('CANCELLED', 'OCR cancelled');
  const message = String((error && error.message) || error);
  let code = 'OCR_FAILED';
  if (/quota|429|rate.?limit/i.test(message)) code = 'QUOTA_EXHAUSTED';
  else if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|network/i.test(message)) code = 'NETWORK';
  return ocrError(code, message);
}

function createOcrService({
  helperPath,
  visionFallback = null,
  spawn = childProcess.spawn,
  log = () => {},
  requestTimeoutMs = 15000,
  backoffMs = 100,
  platform = process.platform,
  fileExists = (file) => fs.existsSync(file)
} = {}) {
  let child = null;
  let ready = null; // { promise, resolve, version }
  let helperVersion = null;
  let tripped = null; // reason the helper is no longer used
  let disposed = false;
  let seq = 0;
  let crashes = 0;
  let spawning = null;
  const restartTimes = [];
  const pending = new Map();
  const stats = { requests: 0, failures: 0, ms: 0, successes: 0, restarts: 0 };

  function helperReason() {
    if (tripped) return tripped;
    if (platform !== 'darwin') return 'Apple Vision OCR is only available on macOS';
    if (!helperPath || !fileExists(helperPath)) return `OCR helper not found at ${helperPath || '(no path)'}; run npm run build:native:ocr`;
    return null;
  }

  function getEngine() {
    if (!helperReason()) return 'vision';
    return visionFallback ? 'fallback' : 'none';
  }

  function settle(id, fn) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.signal) entry.signal.removeEventListener('abort', entry.onAbort);
    fn(entry);
  }

  function failAll(code, message) {
    for (const id of [...pending.keys()]) settle(id, (entry) => entry.reject(ocrError(code, message)));
  }

  function onLine(raw) {
    const text = raw.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      log(`[ocr] unparseable helper output: ${text.slice(0, 120)}`);
      return;
    }
    if (msg.event === 'ready') {
      helperVersion = msg.version || null;
      if (ready) ready.resolve();
      return;
    }
    settle(msg.id, (entry) => {
      if (msg.ok) entry.resolve(msg);
      else entry.reject(ocrError(msg.error?.code || 'OCR_FAILED', msg.error?.message || 'OCR failed'));
    });
  }

  function onChildGone(proc, reason) {
    if (child !== proc) return;
    child = null;
    ready = null;
    if (disposed) return;
    crashes += 1;
    log(`[ocr] helper exited: ${reason}`);
    failAll('OCR_FAILED', `OCR helper exited: ${reason}`);
  }

  function launch() {
    const now = Date.now();
    while (restartTimes.length && now - restartTimes[0] > RESTART_WINDOW_MS) restartTimes.shift();
    if (crashes > 0) {
      if (restartTimes.length >= MAX_RESTARTS_PER_MINUTE) {
        tripped = `OCR helper crashed more than ${MAX_RESTARTS_PER_MINUTE} times in a minute`;
        return null;
      }
      restartTimes.push(now);
      stats.restarts += 1;
    }
    let proc;
    try {
      proc = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      tripped = `OCR helper failed to start: ${error.message}`;
      return null;
    }
    child = proc;
    let resolveReady;
    const promise = new Promise((resolve) => { resolveReady = resolve; });
    ready = { promise, resolve: resolveReady };
    let buffer = '';
    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        onLine(line);
      }
    });
    if (proc.stderr) proc.stderr.on('data', (chunk) => log(`[ocr] helper stderr: ${chunk.toString('utf8').trim()}`));
    proc.stdin.on('error', () => {});
    proc.on('error', (error) => {
      if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) tripped = `OCR helper cannot run: ${error.message}`;
      onChildGone(proc, error.message);
    });
    proc.on('close', (code, signal) => onChildGone(proc, `code=${code} signal=${signal}`));
    return proc;
  }

  async function ensureChild() {
    if (child) return child;
    if (spawning) return spawning;
    spawning = (async () => {
      if (crashes > 0) await new Promise((r) => setTimeout(r, backoffMs * 2 ** Math.min(crashes - 1, 4)));
      return disposed ? null : launch();
    })();
    try {
      return await spawning;
    } finally {
      spawning = null;
    }
  }

  function killChild() {
    const proc = child;
    if (!proc) return;
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    onChildGone(proc, 'killed');
  }

  function viaHelper(imageRef, { signal, sessionId, regionId }) {
    return new Promise((resolve, reject) => {
      ensureChild().then((proc) => {
        if (!proc) return reject(ocrError('OCR_FAILED', tripped || 'OCR helper unavailable'));
        if (signal?.aborted) return reject(ocrError('CANCELLED', 'OCR cancelled'));
        const id = `ocr-${++seq}`;
        const entry = { resolve, reject, signal };
        entry.timer = setTimeout(() => {
          settle(id, (e) => e.reject(ocrError('OCR_FAILED', `OCR timed out after ${requestTimeoutMs}ms`)));
          killChild(); // a hung helper would block every later request
        }, requestTimeoutMs);
        if (signal) {
          entry.onAbort = () => settle(id, (e) => e.reject(ocrError('CANCELLED', 'OCR cancelled')));
          signal.addEventListener('abort', entry.onAbort, { once: true });
        }
        pending.set(id, entry);
        const body = JSON.stringify({
          id,
          image: Buffer.from(imageRef.jpeg).toString('base64'),
          level: 'accurate',
          languages: ['en-US'],
          languageCorrection: false
        });
        try {
          proc.stdin.write(`${body}\n`);
        } catch (error) {
          settle(id, (e) => e.reject(ocrError('OCR_FAILED', `OCR helper write failed: ${error.message}`)));
        }
      }, reject);
    }).then((msg) => ({
      lines: (msg.lines || []).map((l) => ({ text: l.text, box: l.box || null, confidence: l.confidence })),
      engine: 'vision',
      durationMs: msg.ms
    }));
  }

  async function viaFallback(imageRef, { signal, sessionId, regionId }) {
    if (!visionFallback) {
      throw ocrError('UNAVAILABLE', `Local OCR unavailable: ${helperReason()}. No vision fallback is configured.`);
    }
    const started = Date.now();
    let aborted;
    const abortPromise = new Promise((_, rej) => {
      aborted = () => rej(ocrError('CANCELLED', 'OCR cancelled'));
      if (signal) signal.addEventListener('abort', aborted, { once: true });
    });
    try {
      const out = await Promise.race([Promise.resolve(visionFallback(imageRef, { signal, sessionId, regionId })), abortPromise]);
      const text = typeof out === 'string' ? out : out?.text;
      if (typeof text !== 'string') throw ocrError('OCR_FAILED', 'Vision fallback returned no text field');
      return {
        lines: text.split(/\r?\n/).filter((l) => l.trim()).map((l) => ({ text: l, box: null, confidence: 0.5 })),
        engine: (out && out.engine) || 'gemini',
        durationMs: Date.now() - started
      };
    } catch (error) {
      throw mapFallbackError(error);
    } finally {
      if (signal) signal.removeEventListener('abort', aborted);
    }
  }

  async function recognize(imageRef, opts = {}) {
    stats.requests += 1;
    try {
      if (disposed) throw ocrError('CANCELLED', 'OCR service disposed');
      if (opts.signal?.aborted) throw ocrError('CANCELLED', 'OCR cancelled');
      if (!imageRef || !imageRef.jpeg) throw ocrError('OCR_FAILED', 'imageRef.jpeg is required');
      let result;
      if (!helperReason()) {
        try {
          result = await viaHelper(imageRef, opts);
        } catch (error) {
          // The helper tripped while this request waited to spawn it.
          if (!tripped || error.code === 'CANCELLED') throw error;
          result = await viaFallback(imageRef, opts);
        }
      } else {
        result = await viaFallback(imageRef, opts);
      }
      stats.successes += 1;
      stats.ms += result.durationMs || 0;
      return result;
    } catch (error) {
      if (error.code !== 'CANCELLED') stats.failures += 1;
      throw error;
    }
  }

  async function probe() {
    const reason = helperReason();
    if (reason) {
      return { available: Boolean(visionFallback), engine: getEngine(), reason };
    }
    const proc = await ensureChild();
    if (!proc) return { available: Boolean(visionFallback), engine: getEngine(), reason: helperReason() };
    const timeout = new Promise((resolve) => setTimeout(() => resolve(false), requestTimeoutMs));
    const ok = await Promise.race([ready.promise.then(() => true), timeout]);
    if (!ok) return { available: Boolean(visionFallback), engine: getEngine(), reason: 'OCR helper did not report ready' };
    return { available: true, engine: 'vision', version: helperVersion };
  }

  function getStats() {
    return {
      requests: stats.requests,
      failures: stats.failures,
      avgMs: stats.successes ? Math.round(stats.ms / stats.successes) : 0,
      restarts: stats.restarts
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    failAll('CANCELLED', 'OCR service disposed');
    const proc = child;
    child = null;
    ready = null;
    if (proc) {
      try { proc.stdin.end(); } catch { /* closed */ }
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }

  return { recognize, probe, getEngine, getStats, dispose };
}

module.exports = { createOcrService, resolveOcrHelperPath };
