'use strict';

const { exec } = require('child_process');
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
 * BlackHole is the macOS loopback device used to capture system audio. On other
 * platforms system audio is captured through desktopCapturer, so the check is
 * reported as not-applicable rather than failing.
 */
function checkBlackHole() {
  if (process.platform !== 'darwin') {
    return Promise.resolve({ ok: true, applicable: false, detail: 'Not required on this platform' });
  }

  return new Promise((resolve) => {
    exec('system_profiler SPAudioDataType -json', { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, applicable: true, detail: 'Could not enumerate audio devices' });
        return;
      }

      const found = /blackhole/i.test(stdout || '');
      resolve({
        ok: found,
        applicable: true,
        detail: found ? 'BlackHole detected' : 'BlackHole 2ch not installed'
      });
    });
  });
}

/**
 * BlackHole existing says nothing about whether it's actually receiving
 * anything — that requires macOS's audio OUTPUT to be routed to it (directly,
 * or via a Multi-Output/Aggregate device that includes it), which is a manual
 * System Settings step this app cannot perform on the user's behalf. This
 * reports the one fact `checkBlackHole()` deliberately doesn't: which output
 * device macOS is actually using right now, and whether BlackHole is it.
 * `system_profiler`'s JSON does not expose Multi-Output/Aggregate sub-device
 * membership (verified directly — no key for it), so a device whose name
 * merely suggests it fans out to BlackHole is reported as "unverified", never
 * assumed correct. The silence watchdog (transcription-manager.js) remains
 * the authoritative "is audio actually arriving" signal; this only makes the
 * routing state visible without waiting 12s to find out.
 */
function checkAudioOutputRouting() {
  if (process.platform !== 'darwin') {
    return Promise.resolve({ applicable: false });
  }

  return new Promise((resolve) => {
    exec('system_profiler SPAudioDataType -json', { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve({ applicable: true, ok: false, detail: 'Could not enumerate audio devices' });
        return;
      }

      try {
        const items = JSON.parse(stdout || '{}')?.SPAudioDataType?.[0]?._items || [];
        const defaultOut = items.find((d) => d.coreaudio_default_audio_output_device === 'spaudio_yes');
        const name = defaultOut?._name || 'unknown';
        const isBlackHoleDirectly = /blackhole/i.test(name);
        // A real Aggregate/Multi-Output device reports this transport type;
        // its actual sub-device list isn't in this JSON, so membership is a
        // hint from the device existing at all, not a verified fact.
        const looksLikeRoutingDevice = /aggregate|multi-?output/i.test(name)
          || defaultOut?.coreaudio_device_transport === 'coreaudio_device_type_unknown';

        resolve({
          applicable: true,
          ok: isBlackHoleDirectly || looksLikeRoutingDevice,
          defaultOutputName: name,
          isBlackHoleDirectly,
          looksLikeRoutingDevice,
          detail: isBlackHoleDirectly
            ? 'BlackHole is the direct system output'
            : looksLikeRoutingDevice
              ? `"${name}" looks like a routing device — membership unverified`
              : `System output is "${name}", which does not appear to route to BlackHole`
        });
      } catch (parseError) {
        resolve({ applicable: true, ok: false, detail: `Could not parse audio device list: ${parseError.message}` });
      }
    });
  });
}

/**
 * Probes everything the dashboard shows, in parallel.
 * @param {{ollamaBaseUrl?: string, firstTokenMs?: number|null}} [options]
 */
async function probeAll(options = {}) {
  const [whisperOk, whisperMicOk, ollamaOk, blackHole, audioOutputRouting] = await Promise.all([
    checkWhisper(),
    checkWhisperMic(),
    checkOllama(options.ollamaBaseUrl),
    checkBlackHole(),
    checkAudioOutputRouting()
  ]);

  return {
    whisperOk,
    whisperMicOk,
    ollamaOk,
    blackHoleOk: blackHole.ok,
    blackHole,
    audioOutputRouting,
    firstTokenMs: options.firstTokenMs ?? null,
    checkedAt: new Date().toISOString()
  };
}

module.exports = {
  MIC_WHISPER_PORT,
  OLLAMA_PORT,
  checkAudioOutputRouting,
  checkBlackHole,
  checkOllama,
  checkWhisper,
  checkWhisperMic,
  probeAll
};
