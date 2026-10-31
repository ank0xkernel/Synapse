const { createEventListener } = require('./helpers');

function createEventActions(ipcRenderer) {
  const onScreenshotTakenStealth = createEventListener(ipcRenderer, {
    channel: 'screenshot-taken-stealth',
    label: 'onScreenshotTakenStealth'
  });

  const onAnalysisStart = createEventListener(ipcRenderer, {
    channel: 'analysis-start',
    label: 'onAnalysisStart'
  });

  const onAnalysisResult = createEventListener(ipcRenderer, {
    channel: 'analysis-result',
    label: 'onAnalysisResult'
  });

  const onSetStealthMode = createEventListener(ipcRenderer, {
    channel: 'set-stealth-mode',
    label: 'onSetStealthMode'
  });

  const onEmergencyClear = createEventListener(ipcRenderer, {
    channel: 'emergency-clear',
    label: 'onEmergencyClear'
  });

  const onClickThroughChanged = createEventListener(ipcRenderer, {
    channel: 'click-through-changed',
    label: 'onClickThroughChanged'
  });

  const onError = createEventListener(ipcRenderer, {
    channel: 'error',
    label: 'onError'
  });

  const onVoiceTranscript = createEventListener(ipcRenderer, {
    channel: 'voice-transcript',
    label: 'onVoiceTranscript'
  });

  const onVoiceError = createEventListener(ipcRenderer, {
    channel: 'voice-error',
    label: 'onVoiceError'
  });

  const onVoskStatus = createEventListener(ipcRenderer, {
    channel: 'vosk-status',
    label: 'onVoskStatus'
  });

  const onVoskPartial = createEventListener(ipcRenderer, {
    channel: 'vosk-partial',
    label: 'onVoskPartial'
  });

  const onVoskFinal = createEventListener(ipcRenderer, {
    channel: 'vosk-final',
    label: 'onVoskFinal'
  });

  const onVoskError = createEventListener(ipcRenderer, {
    channel: 'vosk-error',
    label: 'onVoskError'
  });

  const onVoskStopped = createEventListener(ipcRenderer, {
    channel: 'vosk-stopped',
    label: 'onVoskStopped'
  });

  const onToggleVoiceRecognition = createEventListener(ipcRenderer, {
    channel: 'toggle-voice-recognition',
    label: 'onToggleVoiceRecognition'
  });

  const onTriggerAskAi = createEventListener(ipcRenderer, {
    channel: 'trigger-ask-ai',
    label: 'onTriggerAskAi'
  });

  // Generic shortcut dispatch: payload is { command: '<command bar id>' }.
  const onTriggerCommand = createEventListener(ipcRenderer, {
    channel: 'trigger-command',
    label: 'onTriggerCommand'
  });

  const onAiStreamStart = createEventListener(ipcRenderer, {
    channel: 'ai-stream-start',
    label: 'onAiStreamStart'
  });

  const onAiStreamChunk = createEventListener(ipcRenderer, {
    channel: 'ai-stream-chunk',
    label: 'onAiStreamChunk'
  });

  const onAiStreamEnd = createEventListener(ipcRenderer, {
    channel: 'ai-stream-end',
    label: 'onAiStreamEnd'
  });

  const rawOnSttDebug = createEventListener(ipcRenderer, {
    channel: 'stt-debug',
    label: 'onSttDebug'
  });

  const onMobileServerStatus = createEventListener(ipcRenderer, {
    channel: 'mobile-server-status',
    label: 'onMobileServerStatus'
  });

  const onClearFromMobile = createEventListener(ipcRenderer, {
    channel: 'clear-from-mobile',
    label: 'onClearFromMobile'
  });

  // Remote control from the mobile companion. Both settings own their state in
  // the renderer (auto-answer keeps it in localStorage, mic state lives in the
  // audio pipeline), so the phone cannot set them directly over HTTP — the
  // command has to arrive here and be applied by the owning module.
  const onSetAutoAnswer = createEventListener(ipcRenderer, {
    channel: 'set-auto-answer',
    label: 'onSetAutoAnswer'
  });

  const onSetMicEnabled = createEventListener(ipcRenderer, {
    channel: 'set-mic-enabled',
    label: 'onSetMicEnabled'
  });

  const onNativeSystemAudioFrame = createEventListener(ipcRenderer, {
    channel: 'native-system-audio-frame',
    label: 'onNativeSystemAudioFrame'
  });

  const onNativeSystemAudioStatus = createEventListener(ipcRenderer, {
    channel: 'native-system-audio-status',
    label: 'onNativeSystemAudioStatus'
  });

  const onWebSyncState = createEventListener(ipcRenderer, {
    channel: 'web-sync:state',
    label: 'onWebSyncState'
  });

  return {
    onWebSyncState,
    onNativeSystemAudioFrame,
    onNativeSystemAudioStatus,
    onScreenshotTakenStealth,
    onAnalysisStart,
    onAnalysisResult,
    onSetStealthMode,
    onEmergencyClear,
    onError,
    onVoiceTranscript,
    onVoiceError,
    onVoskStatus,
    onVoskPartial,
    onVoskFinal,
    onVoskError,
    onVoskStopped,
    onAiStreamStart,
    onAiStreamChunk,
    onAiStreamEnd,
    onToggleVoiceRecognition,
    onTriggerAskAi,
    onTriggerCommand,
    onSttDebug: (callback) => rawOnSttDebug((data) => callback(data || {})),
    onMobileServerStatus,
    onClearFromMobile,
    onSetAutoAnswer,
    onSetMicEnabled,
    onClickThroughChanged
  };
}

module.exports = {
  createEventActions
};
