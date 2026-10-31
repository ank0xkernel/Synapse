'use strict';

const http = require('http');

const { WHISPER_HOST, WHISPER_PORT } = require('./stt/stt-constants');

/**
 * SystemHealth
 *
 * Live probes for the services the dashboard reports on. The dashboard used to
 * receive `whisperOk: true, ollamaOk: true` as literals, so its service panel
 * stayed green even when nothing was running — which is worse than no panel,
 * because it actively misleads you while you are debugging a dead pipeline.
 *
 * Every probe is bounded by a short timeout: this runs on a dashboard poll, and
 * a hung probe would stall the request.
 */

const MIC_WHISPER_PORT = 8081;
const OLLAMA_PORT = 11434;
const PROBE_TIMEOUT_MS = 1500;

/** Resolves true when an HTTP GET returns a 2xx within the timeout. */
function probeHttp(host, port, path, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = http.get({ host, port, path, timeout: timeoutMs }, (res) => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      // Drain so the socket can be reused/closed cleanly.
      res.resume();
      finish(ok);
    });

    req.on('timeout', () => {
      req.destroy();
      finish(false);
    });
    req.on('error', () => finish(false));
  });
}

function checkWhisper() {
  return probeHttp(WHISPER_HOST, WHISPER_PORT, '/health');
}

function checkWhisperMic() {
  return probeHttp(WHISPER_HOST, MIC_WHISPER_PORT, '/health');
}

/** Ollama has no /health; /api/tags is the cheapest liveness endpoint. */
function checkOllama(baseUrl) {
  let host = '127.0.0.1';
  let port = OLLAMA_PORT;

  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      host = parsed.hostname || host;
      port = Number(parsed.port) || port;
    } catch (_) {
      // Fall back to the defaults above.
    }
  }

  return probeHttp(host, port, '/api/tags');
}

/**
 * Projects the native capture helper's live state (native-system-audio.js)
 * into the same {ok, applicable, detail} shape the other probes use. `ok` is
 * null while capture is simply not running: that is not a fault.
 */
function describeSystemAudioCapture(probe, state) {
  if (process.platform !== 'darwin') {
    return { ok: null, applicable: false, detail: 'Native capture is macOS only' };
  }
  if (!probe || !probe.available) {
    return { ok: false, applicable: true, detail: `Native capture unavailable (${probe?.reason || 'unknown'})` };
  }
  if (state?.running && state.backend) {
    const dropped = state.lastStats?.droppedSamples || 0;
    return {
      ok: true,
      applicable: true,
      backend: state.backend,
      detail: dropped > 0 ? `Capturing via ${state.backend}, ${dropped} samples dropped` : `Capturing via ${state.backend}`
    };
  }
  if (state?.lastError) {
    return { ok: false, applicable: true, detail: `${state.lastError.code}: ${state.lastError.message}` };
  }
  return { ok: null, applicable: true, detail: `Ready (${probe.recommendedBackend}), not capturing` };
}

/**
 * Probes everything the dashboard shows, in parallel.
 * @param {{ollamaBaseUrl?: string, firstTokenMs?: number|null, getSystemAudioCapture?: () => Promise<{probe: object, state: object}|null>}} [options]
 */
async function probeAll(options = {}) {
  const [whisperOk, whisperMicOk, ollamaOk, capture] = await Promise.all([
    checkWhisper(),
    checkWhisperMic(),
    checkOllama(options.ollamaBaseUrl),
    Promise.resolve(options.getSystemAudioCapture ? options.getSystemAudioCapture() : null).catch(() => null)
  ]);

  return {
    whisperOk,
    whisperMicOk,
    ollamaOk,
    systemAudioCapture: describeSystemAudioCapture(capture?.probe, capture?.state),
    firstTokenMs: options.firstTokenMs ?? null,
    checkedAt: new Date().toISOString()
  };
}

module.exports = {
  MIC_WHISPER_PORT,
  OLLAMA_PORT,
  checkOllama,
  checkWhisper,
  checkWhisperMic,
  describeSystemAudioCapture,
  probeAll
};
