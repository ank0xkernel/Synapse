import { LOOPBACK_ERROR_CODE, isDeviceStillPresent, checkSpeakerSeparationHealth } from '../assembly-ai/loopback-device.js';
import { buildDiagnosticReport } from '../diagnostics/diagnostic-snapshot.js';
import { createEchoFilter } from './echo-filter.js';

const MAX_MONITOR_LOG_ENTRIES = 80;

// Re-acquire backoff after capture or the transcription socket drops. Each
// delay gets ±25% jitter so the mic and system sources (and other clients
// rate-limited at the same moment) do not reconnect in lockstep.
const REACQUIRE_DELAYS_MS = [500, 1500, 3000, 5000];
function reacquireDelay(attempt) {
    const base = REACQUIRE_DELAYS_MS[Math.min(attempt, REACQUIRE_DELAYS_MS.length - 1)];
    return Math.round(base * (0.75 + Math.random() * 0.5));
}

// Frame-stall watchdog. The AudioWorklet posts a message on every audio
// quantum regardless of whether the signal is speech or silence, so frames
// arrive roughly every TARGET_FRAME_MS (100ms, see audio-pipeline.js)
// continuously while genuinely running. Neither track.readyState nor the
// AssemblyAI socket notice if the worklet/graph itself stalls — the track
// stays 'live' and the socket stays open even though nothing is reaching
// either of them. STALL_THRESHOLD_MS is deliberately generous (30x the
// normal cadence) so GC pauses and resampler flushes can never false-trigger
// it; CHECK_INTERVAL_MS just needs to be well under that.
const FRAME_STALL_THRESHOLD_MS = 3000;
const FRAME_WATCHDOG_INTERVAL_MS = 2000;

// Silence watchdog. Distinct from the frame watchdog above: that one confirms
// frames keep arriving at all; this one confirms they aren't all zeros. A
// long threshold is deliberate — real conversations have multi-second gaps,
// and a false positive here sends the user chasing a System Settings problem
// that doesn't exist. 12s of unbroken digital silence on the host channel
// while it is supposed to be live is not a normal conversational pause.
const SILENCE_WARNING_THRESHOLD_MS = 12000;
// Once flagged, don't re-warn every watchdog tick while it stays silent —
// once a minute is enough to be noticed without spamming the chat.
const SILENCE_RENOTIFY_MS = 60000;

export function createTranscriptionManager({
    transcriptionSourceState,
    normalizeSourceRule,
    sourceLabelRule,
    audioPipeline,
    transcriptBufferManager,
    chatMessagesElement,
    transcriptionToggle,
    sourceSystemToggle,
    sourceMicToggle,
    monitorMasterState,
    monitorStatusSystem,
    monitorStatusMic,
    monitorLiveSystem,
    monitorLiveMic,
    monitorLogList,
    addChatMessage,
    showFeedback,
    isAutoScrollEnabled = () => true,
    isChatNearBottom = () => true,
    onStateChange = () => {}
}) {
    let micAudioContext = null;
    let micMediaStream = null;
    let micScriptProcessor = null;
    let isMicActive = false;

    let systemAudioContext = null;
    let systemMediaStream = null;
    let systemScriptProcessor = null;
    let isSystemActive = false;

    let activeLoopbackDevice = null;
    // 'native': the macOS helper captures what the Mac plays while the output
    // device stays as the user set it. 'legacy': BlackHole input, only when
    // the helper is unavailable (macOS older than 13). Decided on each start.
    let systemCaptureMode = null;
    let systemCaptureLabel = null;
    let nativeProbePromise = null;
    let reacquireAttempt = 0;
    let reacquireTimer = null;
    // Mirrors reacquireAttempt/reacquireTimer above, but for the mic source.
    // Real bug found by reading handleVoskError/handleVoskStopped: both only
    // ever auto-reconnected `source === 'system'` — an unexpected mic-socket
    // death (the exact same network-blip/provider-timeout causes already
    // handled for system audio) just left the mic permanently off with no
    // recovery, silently, for the rest of the session. That's a real,
    // reported "the app stops working for no reason" failure mode.
    let micReacquireAttempt = 0;
    let micReacquireTimer = null;
    let deviceChangeHandler = null;
    let frameWatchdogTimer = null;
    let silenceWatchdogTimer = null;
    let lastSilenceWarningAt = 0;
    let silenceWarningActive = false;

    // Legacy fallback only: the mic accidentally set to the same loopback
    // device that carries the interviewer. Warned once per session.
    let hasWarnedAboutMicLoopbackCollision = false;
    const echoFilter = createEchoFilter();
    // The last failure that needs the user's action (bad key, billing),
    // shown by the Session panel until a source connects successfully.
    let lastPermanentFailure = null;

    let micPartialText = '';
    let micPartialDiv = null;
    let systemPartialText = '';
    let systemPartialDiv = null;

    const selectedSources = transcriptionSourceState.selectedSources;
    const sourceStatuses = transcriptionSourceState.sourceStatuses;
    const monitorLogEntries = [];
    const monitorLastText = {
        system: 'No transcript yet',
        mic: 'No transcript yet'
    };

    function normalizeSource(source) {
        return normalizeSourceRule(source);
    }

    function sourceLabel(source) {
        return sourceLabelRule(normalizeSource(source));
    }

    function isSourceActive(source) {
        return source === 'system' ? isSystemActive : isMicActive;
    }

    // Phase 13: when each source last transitioned to active -- needed only
    // for the diagnostic snapshot's average-frames/sec figure (chunk count
    // divided by elapsed time since start). Set at the single existing
    // choke point every source-activation path already goes through, not a
    // new tracked moment.
    const sourceStartedAt = { mic: 0, system: 0 };

    function setMicActive(active) {
        isMicActive = !!active;
        if (isMicActive) sourceStartedAt.mic = Date.now();
        transcriptionSourceState.setSourceActive('mic', isMicActive);
    }

    function setSystemActive(active) {
        isSystemActive = !!active;
        if (isSystemActive) sourceStartedAt.system = Date.now();
        transcriptionSourceState.setSourceActive('system', isSystemActive);
    }

    function isAnyTranscriptionActive() {
        return isSystemActive || isMicActive;
    }

    function isAnySourceConnecting() {
        return transcriptionSourceState.isAnySourceConnecting();
    }

    function setSourceStatus(source, status, liveText) {
        const resolvedSource = normalizeSource(source);
        transcriptionSourceState.setSourceStatus(resolvedSource, status);
        if (status === 'listening') lastPermanentFailure = null;

        if (typeof liveText === 'string' && liveText.trim().length > 0) {
            monitorLastText[resolvedSource] = liveText.trim();
        }

        renderMonitorState();
    }

    function updateTranscriptionUI() {
        const anyActive = isAnyTranscriptionActive();
        const anyConnecting = !anyActive && isAnySourceConnecting();

        if (transcriptionToggle) {
            transcriptionToggle.classList.toggle('active', anyActive);
            transcriptionToggle.classList.toggle('listening', anyActive);
            transcriptionToggle.classList.toggle('connecting', anyConnecting);
        }

        if (sourceSystemToggle) {
            sourceSystemToggle.classList.toggle('selected', selectedSources.system);
            sourceSystemToggle.classList.toggle('running', isSystemActive);
        }

        if (sourceMicToggle) {
            sourceMicToggle.classList.toggle('selected', selectedSources.mic);
            sourceMicToggle.classList.toggle('running', isMicActive);
        }
    }

    function renderMonitorState() {
        updateTranscriptionUI();

        const statusMap = {
            off: 'Off',
            connecting: 'Connecting',
            listening: 'Listening',
            error: 'Error'
        };

        if (monitorStatusSystem) {
            monitorStatusSystem.className = `monitor-status-badge ${sourceStatuses.system}`;
            monitorStatusSystem.textContent = statusMap[sourceStatuses.system] || 'Off';
        }

        if (monitorStatusMic) {
            monitorStatusMic.className = `monitor-status-badge ${sourceStatuses.mic}`;
            monitorStatusMic.textContent = statusMap[sourceStatuses.mic] || 'Off';
        }

        if (monitorLiveSystem) {
            monitorLiveSystem.textContent = monitorLastText.system || 'No transcript yet';
        }

        if (monitorLiveMic) {
            monitorLiveMic.textContent = monitorLastText.mic || 'No transcript yet';
        }

        if (monitorMasterState) {
            monitorMasterState.classList.remove('active', 'connecting');
            if (isAnyTranscriptionActive()) {
                monitorMasterState.textContent = 'Running';
                monitorMasterState.classList.add('active');
            } else if (isAnySourceConnecting()) {
                monitorMasterState.textContent = 'Connecting';
                monitorMasterState.classList.add('connecting');
            } else {
                monitorMasterState.textContent = 'Idle';
            }
        }

        onStateChange();
    }

    function formatMonitorTime(timestamp = Date.now()) {
        return new Date(timestamp).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    function safeJson(value) {
        try {
            return JSON.stringify(value);
        } catch (_) {
            return '';
        }
    }

    function addMonitorLog(level, event, message, source = null, meta = null, timestamp = Date.now()) {
        const entry = {
            level: level || 'info',
            event: event || 'event',
            message: message || '',
            source: source ? normalizeSource(source) : null,
            meta,
            timestamp
        };

        monitorLogEntries.push(entry);
        if (monitorLogEntries.length > MAX_MONITOR_LOG_ENTRIES) {
            monitorLogEntries.shift();
        }

        if (!monitorLogList) {
            return;
        }

        // Newest first: insert one row and trim the oldest, instead of
        // rebuilding all rows on every event during a live session.
        const row = document.createElement('div');
        row.className = `monitor-log-entry ${entry.level === 'error' ? 'error' : ''}`.trim();
        const sourcePrefix = entry.source ? `${sourceLabel(entry.source)} ` : '';
        const metaText = entry.meta ? ` ${safeJson(entry.meta)}` : '';
        row.textContent = `${formatMonitorTime(entry.timestamp)} ${sourcePrefix}${entry.event}: ${entry.message}${metaText}`;
        monitorLogList.prepend(row);
        while (monitorLogList.childElementCount > MAX_MONITOR_LOG_ENTRIES) {
            monitorLogList.lastElementChild.remove();
        }
    }

    function resetFinalTranscriptBuffer(source) {
        transcriptBufferManager.resetFinalTranscriptBuffer(source);
    }

    function flushFinalTranscript(source, reason = 'pause-timeout') {
        transcriptBufferManager.flushFinalTranscript(source, reason);
    }

    function queueFinalTranscript(source, text) {
        transcriptBufferManager.queueFinalTranscript(source, text);
    }

    function flushAllFinalTranscripts(reason = 'flush-all') {
        transcriptBufferManager.flushAllFinalTranscripts(reason);
    }

    function setSourceSelected(source, enabled) {
        const resolvedSource = normalizeSource(source);
        transcriptionSourceState.setSourceSelected(resolvedSource, enabled);
        addMonitorLog('info', 'source-toggle', `${sourceLabel(resolvedSource)} ${enabled ? 'enabled' : 'disabled'}`, resolvedSource);
        updateTranscriptionUI();

        if (isAnyTranscriptionActive() || sourceStatuses[resolvedSource] === 'connecting') {
            ensureSourceRunning(resolvedSource, !!enabled).catch((error) => {
                console.error(`Failed to apply live source toggle for ${resolvedSource}:`, error);
                addMonitorLog('error', 'source-toggle-failed', error.message, resolvedSource);
            });
        }
    }

    async function ensureSourceRunning(source, shouldRun) {
        const resolvedSource = normalizeSource(source);
        if (shouldRun) {
            if (resolvedSource === 'system') {
                await startSystemAudioRecording();
            } else {
                await startMicRecording();
            }
        } else if (resolvedSource === 'system') {
            await stopSystemAudioRecording();
        } else {
            await stopMicRecording();
        }
    }

    async function startSelectedSources() {
        if (!selectedSources.system && !selectedSources.mic) {
            const message = 'Select at least one source (Host or Mic) before starting transcription.';
            showFeedback(message, 'error');
            addMonitorLog('error', 'start-blocked', message);
            return;
        }

        addMonitorLog('info', 'master-start', 'Starting selected transcription sources');

        if (selectedSources.system) {
            await ensureSourceRunning('system', true);
        }

        if (selectedSources.mic) {
            await ensureSourceRunning('mic', true);
        }
    }

    async function stopAllSources() {
        addMonitorLog('info', 'master-stop', 'Stopping all active transcription sources');
        if (isSystemActive || sourceStatuses.system === 'connecting') {
            await stopSystemAudioRecording();
        }
        if (isMicActive || sourceStatuses.mic === 'connecting') {
            await stopMicRecording();
        }
    }

    async function toggleMasterTranscription() {
        if (isAnyTranscriptionActive() || isAnySourceConnecting()) {
            await stopAllSources();
        } else {
            await startSelectedSources();
        }
        updateTranscriptionUI();
    }

    function resetSourceSampleQueue(source) {
        audioPipeline.resetSourceSampleQueue(source);
    }

    function drainSourceSampleQueue(source, { flushPartial = false } = {}) {
        audioPipeline.drainSourceSampleQueue(source, { flushPartial });
    }

    async function buildAudioProcessor(context, stream, source, activeCheck) {
        return audioPipeline.buildAudioProcessor(context, stream, source, activeCheck);
    }

    function stopAudioResources(ctx, stream, processor) {
        audioPipeline.stopAudioResources(ctx, stream, processor);
    }

    async function startMicRecording() {
        if (isMicActive || sourceStatuses.mic === 'connecting') return;
        setSourceStatus('mic', 'connecting', 'Connecting to mic...');
        addMonitorLog('info', 'start-request', 'Starting mic source', 'mic');
        resetFinalTranscriptBuffer('mic');

        try {
            const result = await window.electronAPI.startVoiceRecognition('mic');
            if (result && result.error) throw new Error(result.error);

            micMediaStream = await audioPipeline.getMicAudioStream();
            micAudioContext = new AudioContext();
            await micAudioContext.resume();
            resetSourceSampleQueue('mic');
            micScriptProcessor = await buildAudioProcessor(micAudioContext, micMediaStream, 'mic', () => isMicActive);
            micReacquireAttempt = 0;

            setMicActive(true);
            addChatMessage('system', 'Mic listening...');
            showFeedback('Mic on', 'success');
            addMonitorLog('info', 'source-active', 'Mic source active', 'mic');
        } catch (error) {
            console.error('Failed to start mic:', error);
            showFeedback(`Mic failed: ${error.message}`, 'error');
            addMonitorLog('error', 'source-failed', error.message, 'mic');
            stopAudioResources(micAudioContext, micMediaStream, micScriptProcessor);
            micAudioContext = null;
            micMediaStream = null;
            micScriptProcessor = null;
            setMicActive(false);
            resetSourceSampleQueue('mic');
            setSourceStatus('mic', 'error', `Mic error: ${error.message}`);
            try {
                await window.electronAPI.stopVoiceRecognition('mic');
            } catch (_) {}
        }

        updateTranscriptionUI();
    }

    async function stopMicRecording({ keepSelection = false } = {}) {
        if (!keepSelection) {
            // An explicit stop cancels any in-flight recovery; a recovery-driven
            // stop must not cancel the retry that scheduled it. Same rule as
            // stopSystemAudioRecording's keepSelection.
            clearMicReacquireTimer();
            micReacquireAttempt = 0;
        }
        if (!isMicActive && sourceStatuses.mic !== 'connecting') return;
        drainSourceSampleQueue('mic', { flushPartial: true });
        flushFinalTranscript('mic', 'stop-request');
        stopAudioResources(micAudioContext, micMediaStream, micScriptProcessor);
        micAudioContext = null;
        micMediaStream = null;
        micScriptProcessor = null;
        if (micPartialDiv) {
            micPartialDiv.remove();
            micPartialDiv = null;
        }
        micPartialText = '';
        try {
            await window.electronAPI.stopVoiceRecognition('mic');
        } catch (error) {
            addMonitorLog('error', 'stop-failed', error.message || 'Failed to stop mic source', 'mic');
        }
        setMicActive(false);
        resetSourceSampleQueue('mic');
        audioPipeline.resetChunkCounter('mic');
        setSourceStatus('mic', 'off', 'Mic stopped');
        addMonitorLog('info', 'source-stopped', 'Mic source stopped', 'mic');
        showFeedback('Mic off', 'info');
    }

    function reportSystemAudioStatus(status, message, meta = {}) {
        // Broadcast reaches the phone through the augmented sendToRenderer in
        // the main process, so the companion can show a live capture state.
        try {
            window.electronAPI.reportSystemAudioStatus({
                status,
                message: message || '',
                device: meta.device || systemCaptureLabel || null
            });
        } catch (_) {
            // Status reporting must never take the capture path down.
        }
    }

    function showLoopbackSetupPrompt(error) {
        const available = Array.isArray(error?.availableInputs) ? error.availableInputs : [];
        addChatMessage(
            'system',
            'This Mac is older than macOS 13, so Synapse cannot capture call audio natively, and no loopback audio device was found.\n\n'
            + 'On this macOS version Synapse needs BlackHole 2ch installed and your call audio routed through it.\n'
            + (available.length ? `Inputs currently visible: ${available.join(', ')}.\n` : '')
            + 'Open the setup guide for the 3-step fix.'
        );

        const container = document.createElement('div');
        container.className = 'chat-message system-message loopback-setup-prompt';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'action-btn';
        button.textContent = 'Open BlackHole setup guide';
        button.addEventListener('click', () => {
            window.electronAPI.openLoopbackSetupGuide();
        });
        container.appendChild(button);
        chatMessagesElement.appendChild(container);

        if (isAutoScrollEnabled() && isChatNearBottom()) {
            chatMessagesElement.scrollTop = chatMessagesElement.scrollHeight;
        }
    }

    /** The helper's capabilities do not change while the app runs; probe once. */
    function getNativeProbe() {
        if (!nativeProbePromise) {
            nativeProbePromise = Promise.resolve(window.electronAPI?.probeNativeSystemAudio?.())
                .then((info) => info || { available: false, reason: 'no-bridge' })
                .catch((error) => ({ available: false, reason: error.message }));
        }
        return nativeProbePromise;
    }

    function handleNativeStatus(payload = {}) {
        if (systemCaptureMode !== 'native') return;
        const { status } = payload;

        if (status === 'device-changed') {
            addMonitorLog('info', 'native-device-changed', `Output device is now "${payload.defaultOutput}"; capture follows it`, 'system', payload);
            return;
        }
        if (status === 'restarting') {
            addMonitorLog('info', 'native-restarting', `Native capture restarting (${payload.reason}, attempt ${payload.attempt})`, 'system', payload);
            reportSystemAudioStatus('reacquiring', `Native capture restarting (${payload.reason})`);
            return;
        }
        if (status === 'degraded') {
            addMonitorLog('error', 'native-dropped-audio', `Native capture dropped ${payload.droppedSamples} samples (consumer too slow)`, 'system', payload);
            return;
        }
        if (status === 'capturing') {
            addMonitorLog('info', 'native-capturing', `Native capture running via ${payload.backend}`, 'system', payload);
            return;
        }
        if ((status === 'failed' || status === 'error') && isSystemActive) {
            addMonitorLog('error', 'native-failed', `${payload.code || 'ERROR'}: ${payload.message || 'native capture failed'}`, 'system', payload);
            if (payload.code === 'PERMISSION_DENIED') {
                addChatMessage('system', permissionHelpText());
                stopSystemAudioRecording().catch(() => {});
                return;
            }
            scheduleLoopbackReacquire('native-failed');
        }
    }

    function permissionHelpText() {
        return 'Synapse needs permission to hear your Mac\'s audio. Open System Settings → Privacy & Security → '
            + 'Screen & System Audio Recording, allow Synapse, then turn Host audio back on. '
            + 'Your speaker or headphone selection does not need to change.';
    }

    function attachNativeListeners() {
        if (!window.electronAPI?.onNativeSystemAudioFrame) return;
        window.electronAPI.onNativeSystemAudioFrame((frame) => {
            // Frames that arrive before the source is marked active, or after a
            // stop, are dropped rather than queued into a stale session.
            if (systemCaptureMode !== 'native' || !isSystemActive) return;
            audioPipeline.ingestPcmFrame('system', frame);
        });
        window.electronAPI.onNativeSystemAudioStatus?.(handleNativeStatus);
    }

    /*
     * Wires up loopback-device.js's checkSpeakerSeparationHealth(), which
     * existed but was never actually called from anywhere in the app before
     * this — a real, already-written check for exactly the collision
     * described above, sitting dead. Runs once per system-audio session
     * (re-checking on every reacquire would be noise for a state that
     * essentially never changes mid-call) and only warns on an actual
     * collision, not on "inconclusive" (no default input could be read).
     */
    async function checkMicLoopbackCollision() {
        if (hasWarnedAboutMicLoopbackCollision) return;

        let health;
        try {
            health = await checkSpeakerSeparationHealth();
        } catch (_) {
            return; // best-effort — never let a diagnostic check break capture
        }

        if (health.ok) return;

        hasWarnedAboutMicLoopbackCollision = true;
        addMonitorLog('error', 'mic-loopback-collision', health.reason, 'mic');
        addChatMessage('system', `⚠️ ${health.reason}`);
    }

    function clearReacquireTimer() {
        if (reacquireTimer) {
            clearTimeout(reacquireTimer);
            reacquireTimer = null;
        }
    }

    /**
     * A loopback track ends when the user switches output device, unplugs an
     * interface, or the driver is reloaded. Left alone this looks identical to
     * "the other person went quiet" — the stream stays open and streams silence
     * forever. Detect it and re-acquire.
     */
    function watchLoopbackStream(stream) {
        const [track] = stream.getAudioTracks();
        if (!track) return;

        track.addEventListener('ended', () => {
            if (!isSystemActive) return;
            addMonitorLog('error', 'loopback-lost', 'Loopback track ended', 'system');
            scheduleLoopbackReacquire('track-ended');
        });

        track.addEventListener('mute', () => {
            if (!isSystemActive) return;
            addMonitorLog('error', 'loopback-muted', 'Loopback track muted', 'system');
            reportSystemAudioStatus('degraded', 'Loopback track muted');
        });

        track.addEventListener('unmute', () => {
            if (!isSystemActive) return;
            addMonitorLog('info', 'loopback-unmuted', 'Loopback track resumed', 'system');
            reportSystemAudioStatus('capturing', 'Loopback track resumed');
        });
    }

    function scheduleLoopbackReacquire(reason) {
        if (!selectedSources.system) return;
        clearReacquireTimer();

        const delay = reacquireDelay(reacquireAttempt);
        reacquireAttempt += 1;

        setSourceStatus('system', 'connecting', 'Re-acquiring system audio...');
        reportSystemAudioStatus('reacquiring', `Lost loopback (${reason}); retrying`);
        addMonitorLog('info', 'loopback-reacquire', `Retry ${reacquireAttempt} in ${delay}ms (${reason})`, 'system');

        reacquireTimer = setTimeout(async () => {
            reacquireTimer = null;
            await stopSystemAudioRecording({ keepSelection: true });

            if (!selectedSources.system) return;

            if (reacquireAttempt > REACQUIRE_DELAYS_MS.length) {
                addMonitorLog('error', 'loopback-giveup', 'Gave up re-acquiring loopback device', 'system');
                reportSystemAudioStatus('missing-device', 'Could not re-acquire the loopback device');
                setSourceStatus('system', 'error', 'System audio lost');
                addChatMessage('system', 'Lost the system-audio device and could not get it back. Check your output routing.');
                return;
            }

            await startSystemAudioRecording({ isReacquire: true });
        }, delay);
    }

    function clearMicReacquireTimer() {
        if (micReacquireTimer) {
            clearTimeout(micReacquireTimer);
            micReacquireTimer = null;
        }
    }

    /**
     * Mic-side equivalent of scheduleLoopbackReacquire — same bounded
     * backoff/retry shape, applied to the source that never had it. The mic
     * channel has no loopback device to lose (it just uses the OS default
     * input), so the only failure mode here is the AssemblyAI socket itself
     * dying (handleVoskError/handleVoskStopped, both `unexpected: true`),
     * not a device disappearing — hence no watchLoopbackStream/
     * attachDeviceChangeWatcher equivalent needed.
     */
    function scheduleMicReacquire(reason) {
        if (!selectedSources.mic) return;
        clearMicReacquireTimer();

        const delay = reacquireDelay(micReacquireAttempt);
        micReacquireAttempt += 1;

        setSourceStatus('mic', 'connecting', 'Reconnecting mic...');
        addMonitorLog('info', 'mic-reacquire', `Retry ${micReacquireAttempt} in ${delay}ms (${reason})`, 'mic');

        micReacquireTimer = setTimeout(async () => {
            micReacquireTimer = null;
            await stopMicRecording({ keepSelection: true });

            if (!selectedSources.mic) return;

            if (micReacquireAttempt > REACQUIRE_DELAYS_MS.length) {
                addMonitorLog('error', 'mic-reacquire-giveup', 'Gave up reconnecting the mic', 'mic');
                setSourceStatus('mic', 'error', 'Mic disconnected');
                addChatMessage('system', 'Lost the microphone connection and could not reconnect automatically. Toggle the mic off and back on to retry.');
                return;
            }

            await startMicRecording();
        }, delay);
    }

    function attachDeviceChangeWatcher() {
        if (deviceChangeHandler || !navigator.mediaDevices?.addEventListener) return;

        deviceChangeHandler = async () => {
            if (!isSystemActive || !activeLoopbackDevice) return;

            const present = await isDeviceStillPresent(activeLoopbackDevice.deviceId);
            if (!present) {
                addMonitorLog('error', 'loopback-removed', 'Loopback device removed from the system', 'system');
                scheduleLoopbackReacquire('device-removed');
            }
        };

        navigator.mediaDevices.addEventListener('devicechange', deviceChangeHandler);
    }

    /**
     * Catches the one failure mode track/device/socket watchers all miss: the
     * AudioWorklet graph itself stalls (a thrown exception inside its
     * onmessage handler, the AudioContext getting suspended by the OS, the
     * node silently disconnecting) while the MediaStreamTrack stays 'live'
     * and the AssemblyAI socket stays open. Nothing else would ever notice —
     * the host channel would just go quiet for the rest of the meeting with
     * no error anywhere.
     */
    function startFrameWatchdog() {
        stopFrameWatchdog();
        frameWatchdogTimer = setInterval(() => {
            if (!isSystemActive) return;

            const lastFrameAt = audioPipeline.getLastFrameAt('system');
            if (!lastFrameAt) return; // hasn't sent its first frame yet — not a stall

            const gap = Date.now() - lastFrameAt;
            if (gap > FRAME_STALL_THRESHOLD_MS) {
                addMonitorLog('error', 'worklet-stall', `No audio frames sent in ${gap}ms while active`, 'system', { gap });
                scheduleLoopbackReacquire('worklet-stall');
            }
        }, FRAME_WATCHDOG_INTERVAL_MS);
    }

    function stopFrameWatchdog() {
        if (frameWatchdogTimer) {
            clearInterval(frameWatchdogTimer);
            frameWatchdogTimer = null;
        }
    }

    /**
     * Catches the failure mode the frame watchdog structurally cannot see:
     * the worklet is posting frames right on schedule, the track is 'live',
     * the socket is open — and every frame is silence, because BlackHole is
     * selected correctly but nothing is actually being routed into it. This
     * is a macOS Sound Settings problem (Output must be BlackHole or a
     * Multi-Output Device containing it), not a code-recoverable one — so
     * unlike every other watchdog in this file, this does NOT call
     * scheduleLoopbackReacquire(). Re-opening the same device that already
     * isn't receiving audio would not fix a routing misconfiguration; it
     * would just loop forever. This tells the user what to actually check.
     */
    function startSilenceWatchdog() {
        stopSilenceWatchdog();
        lastSilenceWarningAt = 0;
        silenceWarningActive = false;
        silenceWatchdogTimer = setInterval(async () => {
            if (!isSystemActive) return;

            const { silent, sinceMs, peakDb, rmsDb, signalConfirmed } = audioPipeline.getSilenceInfo('system');

            if (signalConfirmed && silenceWarningActive) {
                // Recovery: signal came back after we'd told the user it was
                // missing (e.g. they just switched System Settings → Sound →
                // Output). Close the loop instead of leaving a stale warning
                // sitting in the chat with no resolution.
                silenceWarningActive = false;
                console.log(`[AUDIO_HEALTH] source=system routing=ok peak=${peakDb.toFixed(1)}dBFS rms=${rmsDb.toFixed(1)}dBFS signal=detected`);
                addMonitorLog('info', 'system-audio-recovered', 'Host audio signal returned after being silent', 'system', { peakDb, rmsDb });
                addChatMessage('system', 'Interviewer audio is coming through again.');
                return;
            }

            if (!silent || sinceMs < SILENCE_WARNING_THRESHOLD_MS) return;

            const now = Date.now();
            if (now - lastSilenceWarningAt < SILENCE_RENOTIFY_MS) return;
            lastSilenceWarningAt = now;
            silenceWarningActive = true;

            console.log(
                `[AUDIO_HEALTH] source=system mode=${systemCaptureMode} signal=silent `
                + `peak=${Number.isFinite(peakDb) ? peakDb.toFixed(1) : '-inf'}dBFS `
                + `rms=${Number.isFinite(rmsDb) ? rmsDb.toFixed(1) : '-inf'}dBFS `
                + `silent_for=${Math.round(sinceMs / 1000)}s`
            );
            addMonitorLog('error', 'system-audio-silent', `Host audio has been silent for ${Math.round(sinceMs / 1000)}s while active`, 'system', { sinceMs, peakDb, rmsDb, mode: systemCaptureMode });

            // Native capture hears everything the Mac plays, so long silence
            // means nothing is playing, or macOS is withholding audio because
            // permission is off (it delivers zeros instead of an error).
            const message = systemCaptureMode === 'native'
                ? `No interviewer audio for ${Math.round(sinceMs / 1000)}s. If the other person is talking and you can hear them, `
                  + 'check System Settings → Privacy & Security → Screen & System Audio Recording and make sure Synapse is allowed.'
                : "Host audio is connected but silent. On this macOS version, System Settings → Sound → Output must send audio to BlackHole (or a Multi-Output Device that includes it), otherwise the call audio never reaches Synapse.";
            addChatMessage('system', message);
        }, FRAME_WATCHDOG_INTERVAL_MS);
    }

    function stopSilenceWatchdog() {
        if (silenceWatchdogTimer) {
            clearInterval(silenceWatchdogTimer);
            silenceWatchdogTimer = null;
        }
    }

    async function startSystemAudioRecording({ isReacquire = false } = {}) {
        if (isSystemActive || sourceStatuses.system === 'connecting') return;
        setSourceStatus('system', 'connecting', 'Connecting to host audio...');
        addMonitorLog('info', 'start-request', 'Starting host audio source', 'system');
        resetFinalTranscriptBuffer('system');

        const probe = await getNativeProbe();
        systemCaptureMode = probe.available ? 'native' : 'legacy';
        if (!probe.available) {
            addMonitorLog('info', 'native-unavailable', `Native capture unavailable (${probe.reason}); using legacy loopback input`, 'system', probe);
        }

        try {
            if (systemCaptureMode === 'native') {
                // Capture first, then the cloud socket: a capture that cannot
                // start (permission, unsupported OS) should not cost an
                // AssemblyAI session that could only ever stream silence.
                const native = await window.electronAPI.startNativeSystemAudio();
                if (!native?.success) {
                    const nativeError = new Error(native?.error || 'Native system audio capture failed to start');
                    nativeError.code = native?.code;
                    throw nativeError;
                }
                systemCaptureLabel = `your Mac's audio output (${native.backend})`;

                const result = await window.electronAPI.startVoiceRecognition('system');
                if (result && result.error) throw new Error(result.error);
                resetSourceSampleQueue('system');
            } else {
                const { stream, device } = await audioPipeline.getSystemAudioStream();
                systemMediaStream = stream;
                activeLoopbackDevice = device;
                systemCaptureLabel = device.label;

                const result = await window.electronAPI.startLegacyLoopbackRecognition();
                if (result && result.error) throw new Error(result.error);

                systemAudioContext = new AudioContext();
                await systemAudioContext.resume();
                resetSourceSampleQueue('system');
                systemScriptProcessor = await buildAudioProcessor(systemAudioContext, systemMediaStream, 'system', () => isSystemActive);

                watchLoopbackStream(systemMediaStream);
                attachDeviceChangeWatcher();
            }

            startFrameWatchdog();
            startSilenceWatchdog();
            reacquireAttempt = 0;

            setSystemActive(true);
            addChatMessage('system', `Listening to interviewer audio from ${systemCaptureLabel}.`);
            showFeedback(isReacquire ? 'System audio re-acquired' : 'System audio on', 'success');
            addMonitorLog('info', 'source-active', `Host source active (${systemCaptureMode}: ${systemCaptureLabel})`, 'system');
            reportSystemAudioStatus('capturing', `Capturing ${systemCaptureLabel}`, { device: systemCaptureLabel });

            if (!isReacquire && systemCaptureMode === 'legacy') {
                checkMicLoopbackCollision();
            }
        } catch (error) {
            console.error('Failed to start system audio:', error);
            const isMissingDevice = error?.code === LOOPBACK_ERROR_CODE;
            const isPermissionDenied = error?.code === 'PERMISSION_DENIED';

            showFeedback(
                isMissingDevice ? 'BlackHole not found'
                    : isPermissionDenied ? 'System audio permission needed'
                        : `System audio failed: ${error.message}`,
                'error'
            );
            addMonitorLog('error', 'source-failed', `${error.code ? `${error.code}: ` : ''}${error.message}`, 'system');
            if (isPermissionDenied) addChatMessage('system', permissionHelpText());
            stopFrameWatchdog();
            stopSilenceWatchdog();
            if (systemCaptureMode === 'native') {
                await window.electronAPI.stopNativeSystemAudio().catch(() => {});
            }
            stopAudioResources(systemAudioContext, systemMediaStream, systemScriptProcessor);
            systemAudioContext = null;
            systemMediaStream = null;
            systemScriptProcessor = null;
            activeLoopbackDevice = null;
            systemCaptureLabel = null;
            setSystemActive(false);
            resetSourceSampleQueue('system');
            setSourceStatus('system', 'error', `Host error: ${error.message}`);
            reportSystemAudioStatus(
                isMissingDevice ? 'missing-device' : 'error',
                error.message
            );

            if (isMissingDevice) {
                showLoopbackSetupPrompt(error);
            }

            try {
                await window.electronAPI.stopVoiceRecognition('system');
            } catch (_) {}
        }

        updateTranscriptionUI();
    }

    async function stopSystemAudioRecording({ keepSelection = false } = {}) {
        if (!keepSelection) {
            // An explicit stop cancels any in-flight recovery; a recovery-driven
            // stop must not cancel the retry that scheduled it.
            clearReacquireTimer();
            reacquireAttempt = 0;
        }
        if (!isSystemActive && sourceStatuses.system !== 'connecting') return;
        stopFrameWatchdog();
        stopSilenceWatchdog();
        drainSourceSampleQueue('system', { flushPartial: true });
        flushFinalTranscript('system', 'stop-request');
        if (systemCaptureMode === 'native') {
            try {
                await window.electronAPI.stopNativeSystemAudio();
            } catch (error) {
                addMonitorLog('error', 'native-stop-failed', error.message || 'Failed to stop native capture', 'system');
            }
        }
        stopAudioResources(systemAudioContext, systemMediaStream, systemScriptProcessor);
        systemAudioContext = null;
        systemMediaStream = null;
        systemScriptProcessor = null;
        if (systemPartialDiv) {
            systemPartialDiv.remove();
            systemPartialDiv = null;
        }
        systemPartialText = '';
        try {
            await window.electronAPI.stopVoiceRecognition('system');
        } catch (error) {
            addMonitorLog('error', 'stop-failed', error.message || 'Failed to stop host source', 'system');
        }
        setSystemActive(false);
        activeLoopbackDevice = null;
        systemCaptureLabel = null;
        resetSourceSampleQueue('system');
        audioPipeline.resetChunkCounter('system');
        setSourceStatus('system', 'off', 'Host source stopped');
        addMonitorLog('info', 'source-stopped', 'Host source stopped', 'system');
        if (!keepSelection) {
            reportSystemAudioStatus('off', 'System audio stopped');
            showFeedback('System audio off', 'info');
        }
    }

    function createPartialDiv(icon) {
        const div = document.createElement('div');
        div.className = 'chat-message voice-message partial';
        const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        div.innerHTML = `
        <div class="message-header">
            <span class="message-icon">${icon}</span>
            <span class="message-time">${ts}</span>
            <span class="partial-indicator">Live</span>
        </div>
        <div class="message-content partial-text"></div>
    `;
        return div;
    }

    function handleVoskPartial(data) {
        const source = normalizeSource(data?.source);
        const text = data?.text;
        if (!text || text.trim().length === 0) return;
        if (!isSourceActive(source)) return;

        const trimmed = text.trim();
        const icon = source === 'system' ? '\u{1F50A}' : '\u{1F3A4}';
        monitorLastText[source] = `Live: ${trimmed}`;
        renderMonitorState();

        if (source === 'mic') {
            micPartialText = trimmed;
            if (!micPartialDiv) {
                micPartialDiv = createPartialDiv(icon);
                chatMessagesElement.appendChild(micPartialDiv);
            }
            micPartialDiv.querySelector('.message-content').textContent = trimmed;
        } else {
            systemPartialText = trimmed;
            echoFilter.noteHostPartial(trimmed);
            if (!systemPartialDiv) {
                systemPartialDiv = createPartialDiv(icon);
                chatMessagesElement.appendChild(systemPartialDiv);
            }
            systemPartialDiv.querySelector('.message-content').textContent = trimmed;
        }
        if (isAutoScrollEnabled() && isChatNearBottom()) {
            chatMessagesElement.scrollTop = chatMessagesElement.scrollHeight;
        }
    }

    function handleVoskFinal(data) {
        const source = normalizeSource(data?.source);
        const text = data?.text;
        if (!text || text.trim().length === 0) return;

        const finalText = text.trim();
        monitorLastText[source] = `Final: ${finalText}`;
        renderMonitorState();
        addMonitorLog('info', 'final', 'Final transcript received', source, {
            chars: finalText.length
        });

        if (source === 'mic') {
            if (micPartialDiv) {
                micPartialDiv.remove();
                micPartialDiv = null;
            }
            micPartialText = '';

            // The mic hearing the interviewer through the speakers is not the
            // user speaking. Only checked while host audio is live.
            if (isSystemActive) {
                const { echo, ratio } = echoFilter.check(finalText);
                if (echo) {
                    addMonitorLog('info', 'mic-echo-dropped', 'Mic final matched recent host speech; dropped as speaker echo', 'mic', {
                        chars: finalText.length,
                        overlap: Math.round(ratio * 100) / 100
                    });
                    return;
                }
            }
        } else {
            if (systemPartialDiv) {
                systemPartialDiv.remove();
                systemPartialDiv = null;
            }
            systemPartialText = '';
            echoFilter.noteHostFinal(finalText);
        }
        queueFinalTranscript(source, finalText);
    }

    function handleVoskStatus(data) {
        const source = normalizeSource(data?.source);
        const status = data?.status;
        const message = data?.message || '';
        console.log(`STT status [${source}]:`, status, message);

        if (status === 'loading') {
            setSourceStatus(source, 'connecting', `Connecting (${sourceLabel(source)})...`);
            showFeedback(`Connecting (${sourceLabel(source)})...`, 'info');
            addMonitorLog('info', 'status-loading', message || 'Connection requested', source);
        } else if (status === 'listening') {
            setSourceStatus(source, 'listening', `Listening (${sourceLabel(source)})...`);
            showFeedback(`Listening (${sourceLabel(source)})...`, 'success');
            addMonitorLog('info', 'status-listening', message || 'Source listening', source);
        } else if (status === 'stopped') {
            setSourceStatus(source, 'off', `${sourceLabel(source)} stopped`);
            showFeedback(`Stopped (${sourceLabel(source)})`, 'info');
            addMonitorLog('info', 'status-stopped', message || 'Source stopped', source);
        }
    }

    function handleVoskError(data) {
        const source = normalizeSource(data?.source);
        const error = data?.error || 'Unknown transcription error';
        // Only ws.on('error') (a live socket dying) sets this — the
        // missing-API-key vosk-error fires before any socket exists, and
        // retrying that would just fail identically forever.
        const unexpected = Boolean(data?.unexpected);
        console.error(`STT error [${source}]:`, error);
        addMonitorLog('error', data?.kind ? `stt-${data.kind}` : 'status-error', data?.detail ? `${error} (${data.detail})` : error, source);
        // Retryable failures reconnect quietly (the title bar shows
        // "Reconnecting"); only failures that need the user's action
        // interrupt the answer feed.
        if (!unexpected) {
            lastPermanentFailure = { kind: data?.kind || 'error', message: error, at: Date.now() };
            showFeedback(`Transcription stopped (${sourceLabel(source)})`, 'error');
            addChatMessage('system', `Transcription stopped (${sourceLabel(source)}): ${error}`);
        }
        flushFinalTranscript(source, 'status-error');

        if (source === 'system') {
            if (systemCaptureMode === 'native') {
                window.electronAPI?.stopNativeSystemAudio?.().catch(() => {});
            }
            stopFrameWatchdog();
            stopSilenceWatchdog();
            stopAudioResources(systemAudioContext, systemMediaStream, systemScriptProcessor);
            systemAudioContext = null;
            systemMediaStream = null;
            systemScriptProcessor = null;
            if (systemPartialDiv) {
                systemPartialDiv.remove();
                systemPartialDiv = null;
            }
            systemPartialText = '';
            setSystemActive(false);
            resetSourceSampleQueue('system');
            resetFinalTranscriptBuffer('system');
        } else {
            stopAudioResources(micAudioContext, micMediaStream, micScriptProcessor);
            micAudioContext = null;
            micMediaStream = null;
            micScriptProcessor = null;
            if (micPartialDiv) {
                micPartialDiv.remove();
                micPartialDiv = null;
            }
            micPartialText = '';
            setMicActive(false);
            resetSourceSampleQueue('mic');
            resetFinalTranscriptBuffer('mic');
        }

        if (source === 'system' && unexpected && selectedSources.system) {
            setSourceStatus(source, 'connecting', `${sourceLabel(source)} reconnecting…`);
            updateTranscriptionUI();
            scheduleLoopbackReacquire(`assemblyai-${data?.kind || 'socket-error'}`);
            return;
        }

        if (source === 'mic' && unexpected && selectedSources.mic) {
            setSourceStatus(source, 'connecting', `${sourceLabel(source)} reconnecting…`);
            updateTranscriptionUI();
            scheduleMicReacquire(`assemblyai-${data?.kind || 'socket-error'}`);
            return;
        }

        setSourceStatus(source, 'error', `Error: ${error}`);
        updateTranscriptionUI();
    }

    function handleVoskStopped(data) {
        const source = normalizeSource(data?.source);
        const unexpected = Boolean(data?.unexpected);
        console.log(`STT stopped [${source}]${unexpected ? ` — UNEXPECTED (code ${data?.code}, ${data?.reason || 'no reason given'})` : ''}`);
        flushFinalTranscript(source, 'stopped-event');
        if (source === 'system') {
            if (systemCaptureMode === 'native') {
                window.electronAPI?.stopNativeSystemAudio?.().catch(() => {});
            }
            stopFrameWatchdog();
            stopSilenceWatchdog();
            stopAudioResources(systemAudioContext, systemMediaStream, systemScriptProcessor);
            systemAudioContext = null;
            systemMediaStream = null;
            systemScriptProcessor = null;
            if (systemPartialDiv) {
                systemPartialDiv.remove();
                systemPartialDiv = null;
            }
            systemPartialText = '';
            setSystemActive(false);
            resetSourceSampleQueue('system');
            resetFinalTranscriptBuffer('system');
        } else {
            stopAudioResources(micAudioContext, micMediaStream, micScriptProcessor);
            micAudioContext = null;
            micMediaStream = null;
            micScriptProcessor = null;
            if (micPartialDiv) {
                micPartialDiv.remove();
                micPartialDiv = null;
            }
            micPartialText = '';
            setMicActive(false);
            resetSourceSampleQueue('mic');
            resetFinalTranscriptBuffer('mic');
        }

        /*
         * The AssemblyAI socket died on its own — nothing about the BlackHole
         * device changed, so watchLoopbackStream()'s 'ended'/'mute' listeners
         * never fire for this. Without this, an unexpected socket close was
         * indistinguishable from the user pressing stop: the host channel
         * just went dark for the rest of the meeting. Route it through the
         * same reacquire path already proven for device loss (bounded
         * retries, backoff, gives up with a visible error after exhausting
         * them) instead of building a second recovery mechanism.
         */
        if (source === 'system' && unexpected && selectedSources.system) {
            addMonitorLog('error', 'stt-socket-lost', `AssemblyAI connection lost unexpectedly (code ${data?.code}) — reconnecting`, 'system');
            addChatMessage('system', 'Lost the connection to the transcription service — reconnecting…');
            setSourceStatus(source, 'error', `${sourceLabel(source)} disconnected — reconnecting…`);
            scheduleLoopbackReacquire('assemblyai-socket-lost');
            return;
        }

        // Mic-side equivalent — see the comment on the mic state declarations
        // near the top of this file for why this was missing before: the mic
        // channel had no reconnect path at all, so a dead socket here just
        // looked like the app randomly stopped listening for the rest of the
        // interview.
        if (source === 'mic' && unexpected && selectedSources.mic) {
            addMonitorLog('error', 'stt-socket-lost', `AssemblyAI connection lost unexpectedly (code ${data?.code}) — reconnecting`, 'mic');
            addChatMessage('system', 'Lost the connection to the microphone transcription service — reconnecting…');
            setSourceStatus(source, 'error', `${sourceLabel(source)} disconnected — reconnecting…`);
            scheduleMicReacquire('assemblyai-socket-lost');
            return;
        }

        setSourceStatus(source, 'off', `${sourceLabel(source)} stopped`);
        addMonitorLog('info', 'stopped-event', 'Stop acknowledged by backend', source);
    }

    /**
     * Phase 13: assembles the diagnostic report the user can copy and send
     * back. Gathers the renderer's own already-tracked audio state (nothing
     * new is measured here beyond sourceStartedAt above), asks the main
     * process for its half over the one new IPC round trip, and hands both
     * to the pure buildDiagnosticReport() for labeling. If the main-process
     * call fails (e.g. IPC unavailable), still returns the renderer half
     * with the main-process fields left at their honest "not checked"
     * defaults rather than failing the whole export.
     */
    async function buildDiagnosticSnapshot() {
        let mainProcess = null;
        try {
            mainProcess = await window.electronAPI?.getDiagnosticSnapshot?.();
        } catch (_) {
            mainProcess = null;
        }

        return buildDiagnosticReport({
            now: Date.now(),
            mic: {
                active: isMicActive,
                status: sourceStatuses.mic,
                lastFrameAt: audioPipeline.getLastFrameAt('mic'),
                chunkCount: audioPipeline.getChunkCount('mic'),
                silenceInfo: audioPipeline.getSilenceInfo('mic'),
                startedAt: sourceStartedAt.mic
            },
            system: {
                active: isSystemActive,
                status: sourceStatuses.system,
                lastFrameAt: audioPipeline.getLastFrameAt('system'),
                chunkCount: audioPipeline.getChunkCount('system'),
                silenceInfo: audioPipeline.getSilenceInfo('system'),
                startedAt: sourceStartedAt.system
            },
            transcription: mainProcess?.transcription || null,
            nativeAudio: mainProcess?.nativeAudio || null,
            systemCaptureMode,
            latency: mainProcess?.latency || null,
            monitorLog: monitorLogEntries.slice()
        });
    }

    attachNativeListeners();

    return {
        selectedSources,
        sourceStatuses,
        normalizeSource,
        sourceLabel,
        addMonitorLog,
        updateTranscriptionUI,
        renderMonitorState,
        setSourceSelected,
        toggleMasterTranscription,
        flushAllFinalTranscripts,
        handleVoskPartial,
        handleVoskFinal,
        handleVoskStatus,
        handleVoskError,
        handleVoskStopped,
        buildDiagnosticSnapshot,
        getLastPermanentFailure: () => lastPermanentFailure
    };
}
