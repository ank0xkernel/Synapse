/**
 * Diagnostic snapshot.
 *
 * Phase 13: this app has never had a way for the user to hand back objective
 * runtime evidence about their own audio session — every prior phase's
 * conclusion was either "the code looks right" (static analysis) or
 * "couldn't launch the app" (this execution environment can't run the GUI).
 * This closes that gap: a pure function that turns already-existing raw
 * state (frame timestamps, chunk counters, silence tracking, native capture
 * state) into one structured, technical-metrics-only report the user can
 * copy and send back.
 *
 * Deliberately NOT a new tracking system: every raw input here already
 * exists somewhere in the app (audio-pipeline.js's silence tracker,
 * transcription-manager.js's watchdog state, assembly-ai/service.js's chunk
 * counters, native-system-audio.js's helper state, question-latency-tracker.js's
 * own reports). This module only assembles and labels what's already
 * tracked -- it introduces no new continuous state of its own.
 */

export const MicState = Object.freeze({
  OK: 'MIC_OK',
  SILENT: 'MIC_SILENT',
  NOT_AVAILABLE: 'MIC_NOT_AVAILABLE'
});

export const SystemAudioState = Object.freeze({
  OK: 'SYSTEM_AUDIO_OK',
  SILENT: 'SYSTEM_AUDIO_SILENT',
  CAPTURE_FAILED: 'SYSTEM_AUDIO_CAPTURE_FAILED'
});

export const AssemblyAiState = Object.freeze({
  CONNECTED: 'ASSEMBLYAI_CONNECTED',
  DISCONNECTED: 'ASSEMBLYAI_DISCONNECTED'
});

export const PcmState = Object.freeze({
  FLOWING: 'PCM_FLOWING',
  SILENT: 'PCM_SILENT',
  STALLED: 'PCM_STALLED'
});

// Mirrors transcription-manager.js's own FRAME_STALL_THRESHOLD_MS (3000ms,
// 30x the ~100ms normal frame cadence) -- same threshold, not a second
// independent one that could quietly drift out of sync with it.
const FRAME_STALL_MS = 3000;

/**
 * PCM_FLOWING / PCM_SILENT / PCM_STALLED for one source, from raw frame
 * timing + the existing silence tracker's own "signal confirmed" read.
 * `null` when the source isn't active at all -- there is nothing to grade.
 */
function derivePcmState({ active, lastFrameAt, silenceInfo, now }) {
  if (!active) return null;
  if (!lastFrameAt || now - lastFrameAt > FRAME_STALL_MS) return PcmState.STALLED;
  return silenceInfo?.signalConfirmed ? PcmState.FLOWING : PcmState.SILENT;
}

/**
 * MIC_OK / MIC_SILENT / MIC_NOT_AVAILABLE, reusing the EXISTING
 * sourceStatuses status string ('off'/'connecting'/'listening'/'error')
 * as the primary signal rather than inventing a parallel availability
 * check -- 'error' already means the stream failed to open at all.
 * `null` for 'off'/'connecting': genuinely nothing to report yet, not a
 * guessed default.
 */
function deriveMicState({ status, pcmState }) {
  if (status === 'error') return MicState.NOT_AVAILABLE;
  if (status !== 'listening') return null;
  return pcmState === PcmState.FLOWING ? MicState.OK : MicState.SILENT;
}

/**
 * SYSTEM_AUDIO_OK / SILENT / CAPTURE_FAILED. CAPTURE_FAILED needs both halves
 * of the snapshot: the renderer sees silence, the main process knows whether
 * the native capture helper reported an error (native-system-audio.js).
 */
function deriveSystemAudioState({ status, pcmState, captureError }) {
  if (status === 'error') return SystemAudioState.CAPTURE_FAILED;
  if (status !== 'listening') return null;
  if (pcmState === PcmState.FLOWING) return SystemAudioState.OK;
  return captureError ? SystemAudioState.CAPTURE_FAILED : SystemAudioState.SILENT;
}

function computeAvgFramesPerSecond(chunkCount, startedAt, now) {
  if (!startedAt || !chunkCount) return 0;
  const elapsedSeconds = (now - startedAt) / 1000;
  return elapsedSeconds > 0 ? Math.round((chunkCount / elapsedSeconds) * 10) / 10 : 0;
}

/**
 * Builds the full diagnostic report from already-merged raw state (both the
 * renderer's own audio-capture facts and the main process's transcription/
 * routing/latency facts -- see transcription-manager.js's
 * buildDiagnosticSnapshot() and ipc.js's 'get-diagnostic-snapshot' handler
 * for where each half comes from). Pure -- no DOM, no IPC, fully testable.
 *
 * @param {object} raw
 * @returns {object} the exported diagnostic report
 */
export function buildDiagnosticReport(raw) {
  const now = raw.now || Date.now();

  const mic = raw.mic || {};
  const system = raw.system || {};

  const micPcmState = derivePcmState({
    active: mic.active, lastFrameAt: mic.lastFrameAt, silenceInfo: mic.silenceInfo, now
  });
  const systemPcmState = derivePcmState({
    active: system.active, lastFrameAt: system.lastFrameAt, silenceInfo: system.silenceInfo, now
  });

  const captureError = raw.nativeAudio?.state?.lastError || null;

  return {
    generatedAt: new Date(now).toISOString(),

    audioSession: {
      micActive: !!mic.active,
      systemAudioActive: !!system.active,
      micStatus: mic.status || 'off',
      systemStatus: system.status || 'off',
      micStartedAt: mic.startedAt ? new Date(mic.startedAt).toISOString() : null,
      systemStartedAt: system.startedAt ? new Date(system.startedAt).toISOString() : null
    },

    frames: {
      mic: {
        received: mic.chunkCount || 0,
        avgPerSecond: computeAvgFramesPerSecond(mic.chunkCount, mic.startedAt, now),
        lastFrameAgoMs: mic.lastFrameAt ? now - mic.lastFrameAt : null,
        pcmState: micPcmState
      },
      system: {
        received: system.chunkCount || 0,
        avgPerSecond: computeAvgFramesPerSecond(system.chunkCount, system.startedAt, now),
        lastFrameAgoMs: system.lastFrameAt ? now - system.lastFrameAt : null,
        pcmState: systemPcmState
      }
    },

    signal: {
      mic: mic.silenceInfo
        ? { rmsDb: mic.silenceInfo.rmsDb, peakDb: mic.silenceInfo.peakDb, silentForMs: mic.silenceInfo.sinceMs || 0 }
        : { rmsDb: null, peakDb: null, silentForMs: null },
      system: system.silenceInfo
        ? { rmsDb: system.silenceInfo.rmsDb, peakDb: system.silenceInfo.peakDb, silentForMs: system.silenceInfo.sinceMs || 0 }
        : { rmsDb: null, peakDb: null, silentForMs: null }
    },

    transcription: {
      mic: {
        websocketConnected: !!raw.transcription?.mic?.streaming,
        audioFramesSent: raw.transcription?.mic?.framesSent || 0,
        audioFramesDropped: raw.transcription?.mic?.framesDropped || 0
      },
      system: {
        websocketConnected: !!raw.transcription?.system?.streaming,
        audioFramesSent: raw.transcription?.system?.framesSent || 0,
        audioFramesDropped: raw.transcription?.system?.framesDropped || 0
      }
    },

    systemAudioCapture: {
      mode: raw.systemCaptureMode || null,
      probe: raw.nativeAudio?.probe || null,
      backend: raw.nativeAudio?.state?.backend || null,
      running: raw.nativeAudio?.state ? !!raw.nativeAudio.state.running : null,
      droppedSamples: raw.nativeAudio?.state?.lastStats?.droppedSamples ?? null,
      lastError: captureError
    },

    latency: raw.latency || null,

    health: {
      mic: deriveMicState({ status: mic.status, pcmState: micPcmState }),
      systemAudio: deriveSystemAudioState({ status: system.status, pcmState: systemPcmState, captureError }),
      assemblyAiMic: raw.transcription?.mic
        ? (raw.transcription.mic.streaming ? AssemblyAiState.CONNECTED : AssemblyAiState.DISCONNECTED)
        : null,
      assemblyAiSystem: raw.transcription?.system
        ? (raw.transcription.system.streaming ? AssemblyAiState.CONNECTED : AssemblyAiState.DISCONNECTED)
        : null
    },

    // Reused, not duplicated: transcription-manager.js's own monitor log
    // already carries structured, metadata-only events (see its own
    // addMonitorLog) -- included verbatim rather than re-derived.
    recentEvents: raw.monitorLog || []
  };
}

export const __testing = { derivePcmState, deriveMicState, deriveSystemAudioState, computeAvgFramesPerSecond };
