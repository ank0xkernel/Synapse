/**
 * Loopback (system audio) device discovery.
 *
 * macOS has no OS-level loopback: Chromium's `chromeMediaSource: 'desktop'`
 * audio capture is implemented on Windows and Linux only, and Electron did not
 * gain a macOS path for it until v31 (`setDisplayMediaRequestHandler` with
 * `audio: 'loopback'`). We are on Electron 28, so the only way to hear the far
 * end of a call is a virtual output device — BlackHole — which the OS exposes
 * as a normal *audio input*. That means we select it by deviceId through
 * getUserMedia, exactly like a microphone.
 */

// Ordered by how confident we are that the match really is a loopback sink.
// An aggregate/multi-output device may or may not be one, so it ranks last.
const LOOPBACK_PATTERNS = [
  { pattern: /blackhole/i, priority: 100, name: 'BlackHole' },
  { pattern: /soundflower/i, priority: 80, name: 'Soundflower' },
  { pattern: /loopback/i, priority: 75, name: 'Loopback' },
  { pattern: /vb-?cable|virtual\s*cable/i, priority: 70, name: 'VB-Cable' },
  { pattern: /aggregate|multi-?output/i, priority: 40, name: 'Aggregate device' }
];

export const LOOPBACK_ERROR_CODE = 'LOOPBACK_DEVICE_MISSING';

export class LoopbackDeviceError extends Error {
  constructor(message, { availableInputs = [] } = {}) {
    super(message);
    this.name = 'LoopbackDeviceError';
    this.code = LOOPBACK_ERROR_CODE;
    this.availableInputs = availableInputs;
  }
}

function classifyDevice(label) {
  const text = String(label || '');
  for (const entry of LOOPBACK_PATTERNS) {
    if (entry.pattern.test(text)) {
      return entry;
    }
  }
  return null;
}

async function listAudioInputs() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === 'audioinput');
}

/**
 * enumerateDevices() returns entries with empty labels until the page has been
 * granted microphone access at least once. Without labels we cannot tell
 * BlackHole from the built-in mic, so we take a throwaway stream purely to
 * unlock them and release it immediately.
 */
async function primeDeviceLabels() {
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return true;
  } catch (_error) {
    return false;
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

export async function findLoopbackDevice({ allowPrompt = true } = {}) {
  let inputs = await listAudioInputs();

  const labelsMissing = inputs.length > 0 && inputs.every((device) => !device.label);
  if (labelsMissing && allowPrompt) {
    await primeDeviceLabels();
    inputs = await listAudioInputs();
  }

  const candidates = inputs
    .map((device) => {
      const match = classifyDevice(device.label);
      if (!match) return null;
      return {
        deviceId: device.deviceId,
        label: device.label,
        driver: match.name,
        priority: match.priority
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.priority - a.priority);

  return {
    device: candidates[0] || null,
    candidates,
    availableInputs: inputs.map((device) => device.label || '(unlabelled input)')
  };
}

export async function requireLoopbackDevice(options = {}) {
  const { device, availableInputs } = await findLoopbackDevice(options);

  if (!device) {
    throw new LoopbackDeviceError(
      'No loopback audio device found. Install BlackHole 2ch and route your call audio through it '
      + 'so Synapse can hear the other person.',
      { availableInputs }
    );
  }

  return device;
}

/**
 * A device can disappear mid-call (user switches output, unplugs an interface).
 * Used by the watchdog to decide between re-acquire and hard failure.
 */
export async function isDeviceStillPresent(deviceId) {
  if (!deviceId) return false;
  const inputs = await listAudioInputs();
  return inputs.some((device) => device.deviceId === deviceId);
}

export function describeLoopbackDevice(device) {
  if (!device) return 'none';
  return `${device.label} (${device.driver})`;
}

/**
 * The mic/system speaker split (see audio-pipeline.js) is a hardcoded tag
 * applied at each getUserMedia() call, not inferred from audio content — it's
 * deterministic BY CONSTRUCTION as long as the two calls actually reach two
 * different physical devices. getMicAudioStream() takes no deviceId, so it
 * captures whatever the OS default input is. The one way that invariant
 * breaks: the loopback device has also been set as the system default input
 * (some users do this by hand while wiring up BlackHole). When that happens
 * both channels observe the host, and any question they ask over the mic
 * channel goes unanswered — a missed trigger, not a false one, but confusing
 * enough to name loudly rather than let it look like the app is broken.
 */
export async function checkSpeakerSeparationHealth() {
  const [loopback, defaultInputId] = await Promise.all([
    findLoopbackDevice({ allowPrompt: false }).then((r) => r.device),
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        const id = stream.getAudioTracks()[0]?.getSettings?.().deviceId || null;
        stream.getTracks().forEach((track) => track.stop());
        return id;
      })
      .catch(() => null)
  ]);

  if (!loopback || !defaultInputId) {
    return { ok: true, reason: 'inconclusive' }; // can't assert a problem without both readings
  }

  const collision = loopback.deviceId === defaultInputId;
  return {
    ok: !collision,
    reason: collision
      ? `The system default microphone is currently the loopback device (${loopback.label}). `
        + 'Host and mic channels will both hear the call, and questions on the mic channel '
        + 'will not be answered. Set a real microphone as the default input in System Settings.'
      : 'ok'
  };
}
