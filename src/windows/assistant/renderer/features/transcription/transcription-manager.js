import { LOOPBACK_ERROR_CODE, isDeviceStillPresent } from '../assembly-ai/loopback-device.js';

const MAX_MONITOR_LOG_ENTRIES = 80;

// Re-acquire backoff after the loopback device disappears mid-call.
const REACQUIRE_DELAYS_MS = [500, 1500, 3000, 5000];

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
    isChatNearBottom = () => true
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
    let reacquireAttempt = 0;
    let reacquireTimer = null;
    let deviceChangeHandler = null;
    let frameWatchdogTimer = null;
    let silenceWatchdogTimer = null;
    let lastSilenceWarningAt = 0;
    let silenceWarningActive = false;

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

    function setMicActive(active) {
        isMicActive = !!active;
        transcriptionSourceState.setSourceActive('mic', isMicActive);
    }

    function setSystemActive(active) {
        isSystemActive = !!active;
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

        monitorLogList.innerHTML = '';
        const entriesToRender = [...monitorLogEntries].reverse();
        for (const item of entriesToRender) {
            const row = document.createElement('div');
            row.className = `monitor-log-entry ${item.level === 'error' ? 'error' : ''}`.trim();

            const sourcePrefix = item.source ? `${sourceLabel(item.source)} ` : '';
            const metaText = item.meta ? ` ${safeJson(item.meta)}` : '';
            row.textContent = `${formatMonitorTime(item.timestamp)} ${sourcePrefix}${item.event}: ${item.message}${metaText}`;
            monitorLogList.appendChild(row);
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

    async function stopMicRecording() {
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
                device: meta.device || activeLoopbackDevice?.label || null
            });
        } catch (_) {
            // Status reporting must never take the capture path down.
        }
    }

    function showLoopbackSetupPrompt(error) {
        const available = Array.isArray(error?.availableInputs) ? error.availableInputs : [];
        addChatMessage(
            'system',
            'No loopback audio device found, so Synapse cannot hear the other person.\n\n'
            + 'Synapse needs BlackHole 2ch installed and your call audio routed through it.\n'
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

        const delay = REACQUIRE_DELAYS_MS[Math.min(reacquireAttempt, REACQUIRE_DELAYS_MS.length - 1)];
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
                addChatMessage('system', 'Host audio signal detected — routing looks correct now.');
                return;
            }

            if (!silent || sinceMs < SILENCE_WARNING_THRESHOLD_MS) return;

            const now = Date.now();
            if (now - lastSilenceWarningAt < SILENCE_RENOTIFY_MS) return;
            lastSilenceWarningAt = now;
            silenceWarningActive = true;

            // Best-effort: name the actual current output device instead of a
            // generic "check your settings" — this is a real, on-demand re-probe
            // (see get-audio-routing-status in start-application.js), not a
            // cached guess. If it's unavailable for any reason, fall back to the
            // still-correct generic guidance rather than blocking the warning.
            let routing = null;
            try {
                routing = await window.electronAPI?.getAudioRoutingStatus?.();
            } catch (_) {
                routing = null;
            }

            console.log(
                `[AUDIO_HEALTH] source=system routing=misconfigured `
                + `output=${routing?.defaultOutputName || 'unknown'} `
                + `peak=${Number.isFinite(peakDb) ? peakDb.toFixed(1) : '-inf'}dBFS `
                + `rms=${Number.isFinite(rmsDb) ? rmsDb.toFixed(1) : '-inf'}dBFS `
                + `silent_for=${Math.round(sinceMs / 1000)}s`
            );
            addMonitorLog('error', 'system-audio-silent', `Host audio has been silent for ${Math.round(sinceMs / 1000)}s while active`, 'system', { sinceMs, peakDb, rmsDb, defaultOutputName: routing?.defaultOutputName });

            const message = (routing?.applicable && routing?.defaultOutputName && !routing.ok)
                ? `Interviewer audio isn't reaching Synapse. Your Mac is currently sending audio to "${routing.defaultOutputName}" — select the output device that includes BlackHole in System Settings → Sound → Output, then it'll pick up automatically.`
                : "Host audio is connected but silent. In macOS System Settings → Sound → Output, make sure it's set to BlackHole (or a Multi-Output Device that includes BlackHole) — otherwise the call audio never reaches Synapse even though capture looks healthy.";
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

        try {
            // Acquire the device before opening the cloud socket: a missing
            // BlackHole should not cost an AssemblyAI session that can only
            // ever stream silence.
            const { stream, device } = await audioPipeline.getSystemAudioStream();
            systemMediaStream = stream;
            activeLoopbackDevice = device;

            const result = await window.electronAPI.startVoiceRecognition('system');
            if (result && result.error) throw new Error(result.error);

            systemAudioContext = new AudioContext();
            await systemAudioContext.resume();
            resetSourceSampleQueue('system');
            systemScriptProcessor = await buildAudioProcessor(systemAudioContext, systemMediaStream, 'system', () => isSystemActive);

            watchLoopbackStream(systemMediaStream);
            attachDeviceChangeWatcher();
            startFrameWatchdog();
            startSilenceWatchdog();
            reacquireAttempt = 0;

            setSystemActive(true);
            addChatMessage('system', `Listening to host audio via ${device.label}.`);
            showFeedback(isReacquire ? 'System audio re-acquired' : 'System audio on', 'success');
            addMonitorLog('info', 'source-active', `Host source active on ${device.label}`, 'system');
            reportSystemAudioStatus('capturing', `Capturing ${device.label}`, { device: device.label });
        } catch (error) {
            console.error('Failed to start system audio:', error);
            const isMissingDevice = error?.code === LOOPBACK_ERROR_CODE;

            showFeedback(isMissingDevice ? 'BlackHole not found' : `System audio failed: ${error.message}`, 'error');
            addMonitorLog('error', 'source-failed', error.message, 'system');
            stopFrameWatchdog();
            stopSilenceWatchdog();
            stopAudioResources(systemAudioContext, systemMediaStream, systemScriptProcessor);
            systemAudioContext = null;
            systemMediaStream = null;
            systemScriptProcessor = null;
            activeLoopbackDevice = null;
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
        } else {
            if (systemPartialDiv) {
                systemPartialDiv.remove();
                systemPartialDiv = null;
            }
            systemPartialText = '';
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
        showFeedback(`Error (${sourceLabel(source)}): ${error}`, 'error');
        addChatMessage('system', `Transcription error (${sourceLabel(source)}): ${error}`);
        addMonitorLog('error', 'status-error', error, source);
        flushFinalTranscript(source, 'status-error');

        if (source === 'system') {
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
            addMonitorLog('error', 'stt-socket-lost', 'AssemblyAI connection error — reconnecting', 'system');
            setSourceStatus(source, 'error', `${sourceLabel(source)} disconnected — reconnecting…`);
            updateTranscriptionUI();
            scheduleLoopbackReacquire('assemblyai-socket-error');
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

        setSourceStatus(source, 'off', `${sourceLabel(source)} stopped`);
        addMonitorLog('info', 'stopped-event', 'Stop acknowledged by backend', source);
    }

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
        handleVoskStopped
    };
}
