/**
 * Session status sheet and first-run setup.
 *
 * Every state shown here comes from a real check over IPC (native capture
 * probe, permission status, settings, interview context, companion server,
 * the live transcription sources). Nothing is assumed: an unknown value is
 * shown as unknown, and setup steps only pass when their check passes.
 */

import { initContextPanel } from '../context/context-panel.js';

const ONBOARDED_KEY = 'synapse.onboarded';
const api = () => window.electronAPI || {};

function setRow(root, key, { tone = 'idle', detail = '', value = '' } = {}) {
  const row = root?.querySelector(`[data-check="${key}"]`);
  if (!row) return;
  row.dataset.tone = tone;
  const detailEl = row.querySelector('.check-detail');
  const valueEl = row.querySelector('.check-value');
  if (detailEl) detailEl.textContent = detail;
  if (valueEl) valueEl.textContent = value;
}

/** The companion's first non-virtual LAN address (status.urls holds {name, url, virtual} objects). */
function companionUrl(companion) {
  const entries = companion?.urls || [];
  const entry = entries.find((item) => item && !item.virtual) || entries[0];
  const url = typeof entry === 'string' ? entry : entry?.url || entry?.address;
  return url || `port ${companion?.port ?? 7823}`;
}

function describeBackend(backend) {
  if (backend === 'process-tap') return 'Core Audio tap';
  if (backend === 'screencapturekit') return 'ScreenCaptureKit';
  return backend || '';
}

function friendlyCaptureError(code, message) {
  if (code === 'PERMISSION_DENIED') return 'Permission needed: allow Synapse in System Settings → Privacy & Security → Screen & System Audio Recording.';
  if (code === 'UNSUPPORTED_OS' || code === 'unsupported-os') return 'Needs macOS 13 or later for direct capture.';
  if (code === 'helper-missing') return 'Capture helper is missing. Reinstall Synapse.';
  return message || code || 'Capture is unavailable.';
}

export function initPanels({
  getSourceStatuses = () => ({}),
  getTranscriptionFailure = () => null,
  openSettings = () => {},
  showFeedback = () => {}
} = {}) {
  const statusPanel = document.getElementById('status-panel');
  const onboarding = document.getElementById('onboarding');
  let lastFocus = null;

  // ─── Session status sheet ──────────────────────────────────────────────
  async function refreshStatus() {
    if (!statusPanel) return;
    statusPanel.setAttribute('aria-busy', 'true');
    const sources = getSourceStatuses();

    const [probe, settings, context, companion, media] = await Promise.all([
      api().probeNativeSystemAudio?.({ fresh: true }),
      api().getSettings?.(),
      api().getInterviewContextStatus?.(),
      api().getMobileServerStatus?.(),
      api().getMediaAccessStatus?.()
    ].map((promise) => Promise.resolve(promise).catch(() => null)));

    // System audio: what the native helper supports, plus whether it is live.
    if (sources.system === 'listening') {
      setRow(statusPanel, 'system-audio', { tone: 'ok', detail: `Capturing via ${describeBackend(probe?.recommendedBackend)}`, value: 'Live' });
    } else if (sources.system === 'error' && getTranscriptionFailure()) {
      setRow(statusPanel, 'system-audio', { tone: 'warn', detail: 'Capture works; it stopped because transcription failed (see below).', value: 'Stopped' });
    } else if (sources.system === 'error') {
      setRow(statusPanel, 'system-audio', { tone: 'error', detail: 'Capture stopped. See the event log below.', value: 'Error' });
    } else if (probe?.available) {
      setRow(statusPanel, 'system-audio', { tone: 'ready', detail: `${describeBackend(probe.recommendedBackend)} · no virtual audio device needed`, value: 'Ready' });
    } else {
      setRow(statusPanel, 'system-audio', { tone: 'error', detail: friendlyCaptureError(probe?.reason), value: 'Unavailable' });
    }

    setRow(statusPanel, 'playback', probe?.defaultOutput
      ? { tone: 'info', detail: 'Normal playback. Synapse never changes your output.', value: probe.defaultOutput }
      : { tone: 'idle', detail: 'Current output device could not be read.', value: 'Unknown' });

    const micPermission = media?.microphone || 'unknown';
    if (sources.mic === 'listening') {
      setRow(statusPanel, 'microphone', { tone: 'ok', detail: 'Transcribing your voice', value: 'Live' });
    } else if (micPermission === 'denied' || micPermission === 'restricted') {
      setRow(statusPanel, 'microphone', { tone: 'warn', detail: 'Access denied in System Settings → Privacy & Security → Microphone', value: 'Blocked' });
    } else {
      setRow(statusPanel, 'microphone', { tone: 'idle', detail: `Optional · permission ${micPermission === 'granted' ? 'granted' : 'not yet requested'}`, value: 'Off' });
    }

    const failure = getTranscriptionFailure();
    if (failure && sources.system !== 'listening' && sources.mic !== 'listening') {
      setRow(statusPanel, 'transcription', { tone: 'error', detail: failure.message, value: failure.kind === 'auth' ? 'Key rejected' : 'Stopped' });
    } else if (!settings?.hasAssemblyAiApiKey) {
      setRow(statusPanel, 'transcription', { tone: 'warn', detail: 'Add an AssemblyAI key in Settings', value: 'Not set up' });
    } else if (sources.system === 'listening' || sources.mic === 'listening') {
      setRow(statusPanel, 'transcription', { tone: 'ok', detail: `AssemblyAI · ${settings.assemblyAiSpeechModel || 'default model'}`, value: 'Streaming' });
    } else {
      setRow(statusPanel, 'transcription', { tone: 'ready', detail: `AssemblyAI · key saved, checked when listening starts`, value: 'Idle' });
    }

    if (settings?.aiProvider === 'ollama') {
      setRow(statusPanel, 'ai', { tone: 'ready', detail: `Ollama · ${settings.ollamaModel} at ${settings.ollamaBaseUrl}`, value: 'Local' });
    } else if (settings?.hasGeminiApiKeys) {
      setRow(statusPanel, 'ai', { tone: 'ready', detail: `Gemini · ${settings.geminiModel}`, value: 'Ready' });
    } else {
      setRow(statusPanel, 'ai', { tone: 'warn', detail: 'Add a Gemini API key in Settings', value: 'Not set up' });
    }

    if (context && (context.hasResume || context.hasJd)) {
      const parts = [context.hasResume ? 'Resume' : null, context.hasJd ? 'Job description' : null].filter(Boolean).join(' + ');
      const target = [context.role, context.company].filter(Boolean).join(' at ');
      setRow(statusPanel, 'profile', { tone: 'ok', detail: target ? `${parts} · ${target}` : parts, value: 'Loaded' });
    } else {
      setRow(statusPanel, 'profile', { tone: 'warn', detail: 'No resume or job description yet. Add them from the phone companion.', value: 'Empty' });
    }

    if (companion && companion.enabled === false) {
      setRow(statusPanel, 'companion', { tone: 'idle', detail: 'Off. Turn it on below when you want it.', value: 'Off' });
    } else if (companion?.listening) {
      const url = companionUrl(companion);
      const clients = companion.clientCount || 0;
      setRow(statusPanel, 'companion', { tone: clients ? 'ok' : 'ready', detail: url, value: clients ? `${clients} connected` : 'Waiting' });
    } else {
      setRow(statusPanel, 'companion', { tone: 'warn', detail: companion?.error || 'Companion server is not running', value: 'Off' });
    }

    statusPanel.removeAttribute('aria-busy');
  }

  function openSheet(sheet) {
    if (!sheet) return;
    lastFocus = document.activeElement;
    document.querySelectorAll('.sheet:not(.hidden)').forEach((open) => {
      if (open !== sheet) open.classList.add('hidden');
    });
    sheet.classList.remove('hidden');
    sheet.querySelector('[data-autofocus]')?.focus();
  }

  function closeSheet(sheet) {
    if (!sheet || sheet.classList.contains('hidden')) return;
    sheet.classList.add('hidden');
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  function openStatus() {
    openSheet(statusPanel);
    refreshStatus();
    refreshCompanion();
  }

  document.getElementById('status-btn')?.addEventListener('click', () => {
    if (statusPanel?.classList.contains('hidden')) openStatus();
    else closeSheet(statusPanel);
  });
  document.getElementById('close-status')?.addEventListener('click', () => closeSheet(statusPanel));
  document.getElementById('status-refresh')?.addEventListener('click', refreshStatus);
  document.getElementById('status-open-setup')?.addEventListener('click', () => {
    closeSheet(statusPanel);
    openOnboarding();
  });
  document.getElementById('status-audio-test')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Testing…';
    const result = await runAudioTest();
    button.disabled = false;
    button.textContent = 'Test audio';
    showFeedback(result.message, result.ok ? 'success' : 'error');
    refreshStatus();
  });

  // ─── Audio test (shared by status sheet and setup) ─────────────────────
  async function runAudioTest() {
    const result = await api().testNativeSystemAudio?.();
    if (!result?.success) {
      return { ok: false, message: friendlyCaptureError(result?.code, result?.error) };
    }
    if (!result.heard) {
      return {
        ok: false,
        message: `Capture ran but heard silence through "${result.defaultOutput || 'your output'}". Check the permission in System Settings → Privacy & Security → Screen & System Audio Recording, and that volume is not muted.`
      };
    }
    return { ok: true, message: `Heard the test sound through "${result.defaultOutput}" (${result.peakDb} dBFS). Your output was not changed.` };
  }

  // ─── First-run setup ───────────────────────────────────────────────────
  const steps = onboarding ? [...onboarding.querySelectorAll('[data-step]')] : [];
  const progress = onboarding?.querySelector('.setup-progress');
  let stepIndex = 0;

  function showStep(index) {
    stepIndex = Math.max(0, Math.min(steps.length - 1, index));
    steps.forEach((step, i) => { step.hidden = i !== stepIndex; });
    if (progress) {
      [...progress.children].forEach((dot, i) => {
        dot.dataset.state = i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'todo';
      });
    }
    onboarding.querySelector('[data-setup="back"]').hidden = stepIndex === 0;
    const next = onboarding.querySelector('[data-setup="next"]');
    next.textContent = stepIndex === steps.length - 1 ? 'Start using Synapse' : 'Continue';
    onStepShown(steps[stepIndex].dataset.step);
    steps[stepIndex].querySelector('h2')?.focus();
  }

  function setResult(name, tone, text) {
    const el = onboarding?.querySelector(`[data-result="${name}"]`);
    if (!el) return;
    el.dataset.tone = tone;
    el.textContent = text;
    el.hidden = !text;
  }

  async function onStepShown(name) {
    if (name === 'permissions') {
      const media = await api().getMediaAccessStatus?.();
      const probe = await api().probeNativeSystemAudio?.();
      setResult('permissions-audio', probe?.available ? 'ready' : 'error', probe?.available
        ? `Direct capture available (${describeBackend(probe.recommendedBackend)}). macOS asks for permission during the audio test.`
        : friendlyCaptureError(probe?.reason));
      const mic = media?.microphone || 'unknown';
      setResult('permissions-mic', mic === 'granted' ? 'ok' : 'idle', mic === 'granted' ? 'Microphone access granted.' : `Microphone access: ${mic.replace('-', ' ')}. Optional.`);
    }
    if (name === 'ai') {
      const settings = await api().getSettings?.();
      const ready = settings?.aiProvider === 'ollama' || settings?.hasGeminiApiKeys;
      setResult('ai', ready ? 'ok' : 'warn', ready
        ? `${settings.aiProvider === 'ollama' ? 'Ollama' : 'Gemini'} is configured (${settings.aiProvider === 'ollama' ? settings.ollamaModel : settings.geminiModel}).`
        : 'No AI key yet. Open Settings, add a Gemini key, then come back.');
      const transcriptionReady = settings?.hasAssemblyAiApiKey;
      setResult('transcription', transcriptionReady ? 'ok' : 'warn', transcriptionReady
        ? 'AssemblyAI key saved for live transcription.'
        : 'No AssemblyAI key yet. Live transcription needs one.');
    }
    if (name === 'profile') {
      const context = await api().getInterviewContextStatus?.();
      const companion = await api().getMobileServerStatus?.();
      const loaded = context && (context.hasResume || context.hasJd);
      setResult('profile', loaded ? 'ok' : 'idle', loaded
        ? `Loaded: ${[context.hasResume && 'resume', context.hasJd && 'job description'].filter(Boolean).join(' and ')}.`
        : 'Nothing loaded yet. You can skip this and add it later.');
      setResult('companion', companion?.listening ? 'ready' : 'warn', companion?.listening
        ? `Open ${companionUrl(companion)} on your phone to add your resume and job description.`
        : 'The phone companion is not running.');
    }
  }

  onboarding?.addEventListener('click', async (event) => {
    const action = event.target?.closest?.('[data-setup]')?.dataset.setup;
    if (!action) return;
    if (action === 'next') {
      if (stepIndex === steps.length - 1) finishOnboarding();
      else showStep(stepIndex + 1);
    } else if (action === 'back') {
      showStep(stepIndex - 1);
    } else if (action === 'skip') {
      finishOnboarding();
    } else if (action === 'request-mic') {
      const result = await api().requestMicrophoneAccess?.();
      setResult('permissions-mic', result?.granted ? 'ok' : 'warn', result?.granted
        ? 'Microphone access granted.'
        : 'Microphone access was not granted. You can enable it later in System Settings.');
    } else if (action === 'audio-test') {
      const button = event.target.closest('button');
      button.disabled = true;
      setResult('audio', 'busy', 'Listening for the test sound…');
      const result = await runAudioTest();
      button.disabled = false;
      setResult('audio', result.ok ? 'ok' : 'error', result.message);
    } else if (action === 'open-settings') {
      openSettings();
    } else if (action === 'test-answer') {
      const button = event.target.closest('button');
      button.disabled = true;
      setResult('test-answer', 'busy', 'Sending a test question…');
      const result = await api().runAiTestAnswer?.();
      button.disabled = false;
      setResult('test-answer', result?.success ? 'ok' : 'error', result?.success
        ? `Answered in ${result.firstTokenMs ?? result.totalMs} ms to first word (${result.model}): "${result.text}"`
        : `Test answer failed: ${result?.error || 'unknown error'}`);
    }
  });

  onboarding?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') finishOnboarding({ completed: false });
  });

  function openOnboarding() {
    if (!onboarding) return;
    lastFocus = document.activeElement;
    onboarding.classList.remove('hidden');
    showStep(0);
  }

  function finishOnboarding({ completed = true } = {}) {
    if (!onboarding) return;
    if (completed) {
      try { localStorage.setItem(ONBOARDED_KEY, '1'); } catch (_) { /* shown again next launch */ }
    }
    onboarding.classList.add('hidden');
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  // Escape closes the top sheet. Panels never trap the overlay: the live
  // answer view stays one keypress away.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const open = document.querySelector('.sheet:not(.hidden)');
    if (open && open !== document.getElementById('settings-panel')) closeSheet(open);
  });

  let onboarded = false;
  try { onboarded = localStorage.getItem(ONBOARDED_KEY) === '1'; } catch (_) { /* treat as first run */ }
  if (!onboarded) openOnboarding();

  const contextPanel = initContextPanel({ showFeedback, openSheet, closeSheet });

  // ─── Phone companion (off until the user turns it on) ──────────────────
  function renderCompanion(state) {
    const toggle = document.getElementById('companion-toggle');
    const detail = document.getElementById('companion-detail');
    if (!toggle || !detail) return;
    const on = Boolean(state?.enabled);
    toggle.textContent = on ? 'Turn off' : 'Turn on';
    toggle.setAttribute('aria-pressed', String(on));
    document.getElementById('companion-actions').hidden = !on;
    if (!state) {
      detail.textContent = 'Companion status unavailable.';
    } else if (!on) {
      detail.textContent = 'Off. Turn it on to follow answers on your phone over this Wi-Fi.';
    } else if (state.error) {
      detail.textContent = `Could not start: ${state.error}`;
    } else if (state.listening) {
      const url = companionUrl(state);
      const phones = state.clientCount || 0;
      detail.textContent = `On. Open ${url} on your phone and enter the pairing code. ${phones ? `${phones} phone${phones === 1 ? '' : 's'} connected.` : 'No phone connected yet.'}`;
    } else {
      detail.textContent = 'Starting…';
    }
  }

  async function refreshCompanion() {
    renderCompanion(await api().companionGetState?.());
  }

  document.getElementById('companion-toggle')?.addEventListener('click', async (event) => {
    const on = event.currentTarget.getAttribute('aria-pressed') === 'true';
    event.currentTarget.disabled = true;
    renderCompanion(await api().companionSetEnabled?.(!on));
    event.currentTarget.disabled = false;
    refreshStatus();
  });
  document.getElementById('companion-revoke')?.addEventListener('click', async () => {
    renderCompanion(await api().companionRevokeSessions?.());
    showFeedback('All phones signed out', 'info');
  });
  document.getElementById('companion-code')?.addEventListener('click', () => {
    document.getElementById('show-mobile-code-btn')?.click();
  });

  // Used by the development screenshot harness (src/main-process/dev/ui-capture.js).
  window.__synapseOpenContext = () => contextPanel?.open();
  window.__synapseOpenStatus = openStatus;
  window.__synapseOpenOnboarding = openOnboarding;
  window.__synapseCloseOnboarding = () => finishOnboarding({ completed: true });

  return { openStatus, refreshStatus, openOnboarding };
}
