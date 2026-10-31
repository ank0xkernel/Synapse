const { invokeWithFallback } = require('./helpers');

function createInvokeActions(ipcRenderer) {
  return {
    toggleStealth: invokeWithFallback(ipcRenderer, {
      channel: 'toggle-stealth',
      label: 'toggleStealth',
      fallback: (error) => ({ error: error.message })
    }),

    setCompactMode: invokeWithFallback(ipcRenderer, {
      channel: 'set-compact-mode',
      label: 'setCompactMode',
      fallback: (error) => ({ error: error.message })
    }),

    emergencyHide: invokeWithFallback(ipcRenderer, {
      channel: 'emergency-hide',
      label: 'emergencyHide',
      fallback: (error) => ({ error: error.message })
    }),

    takeStealthScreenshot: invokeWithFallback(ipcRenderer, {
      channel: 'take-stealth-screenshot',
      label: 'takeStealthScreenshot',
      fallback: (error) => ({ error: error.message })
    }),

    analyzeStealth: invokeWithFallback(ipcRenderer, {
      channel: 'analyze-stealth',
      label: 'analyzeStealth',
      fallback: (error) => ({ error: error.message })
    }),

    analyzeStealthWithContext: invokeWithFallback(ipcRenderer, {
      channel: 'analyze-stealth-with-context',
      label: 'analyzeStealthWithContext',
      fallback: (error) => ({ error: error.message })
    }),

    askAiWithSessionContext: invokeWithFallback(ipcRenderer, {
      channel: 'ask-ai-with-session-context',
      label: 'askAiWithSessionContext',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    cancelAskAi: invokeWithFallback(ipcRenderer, {
      channel: 'cancel-ask-ai',
      label: 'cancelAskAi',
      fallback: () => ({ success: false, cancelled: false })
    }),

    clearStealth: invokeWithFallback(ipcRenderer, {
      channel: 'clear-stealth',
      label: 'clearStealth',
      fallback: (error) => ({ error: error.message })
    }),

    getScreenshotsCount: invokeWithFallback(ipcRenderer, {
      channel: 'get-screenshots-count',
      label: 'getScreenshotsCount',
      fallback: () => 0
    }),

    getInterviewContextStatus: invokeWithFallback(ipcRenderer, {
      channel: 'get-interview-context-status',
      label: 'getInterviewContextStatus',
      fallback: () => ({ hasResume: false, hasJd: false, role: '', company: '', updatedAt: null })
    }),

    getWindowBounds: invokeWithFallback(ipcRenderer, {
      channel: 'get-window-bounds',
      label: 'getWindowBounds',
      fallback: (error) => ({ error: error.message })
    }),

    setWindowBounds: invokeWithFallback(ipcRenderer, {
      channel: 'set-window-bounds',
      label: 'setWindowBounds',
      fallback: (error) => ({ error: error.message })
    }),

    setWindowSizePreset: invokeWithFallback(ipcRenderer, {
      channel: 'set-window-size-preset',
      label: 'setWindowSizePreset',
      transformArgs: (args) => [{ preset: args[0] }],
      fallback: (error) => ({ error: error.message })
    }),

    startVoiceRecognition: invokeWithFallback(ipcRenderer, {
      channel: 'start-voice-recognition',
      label: 'startVoiceRecognition',
      transformArgs: (args) => [{ source: args[0] }],
      fallback: (error) => ({ error: error.message })
    }),

    stopVoiceRecognition: invokeWithFallback(ipcRenderer, {
      channel: 'stop-voice-recognition',
      label: 'stopVoiceRecognition',
      transformArgs: (args) => [{ source: args[0] }],
      fallback: (error) => ({ error: error.message })
    }),

    // Legacy BlackHole input path: needs the microphone permission gate.
    startLegacyLoopbackRecognition: invokeWithFallback(ipcRenderer, {
      channel: 'start-voice-recognition',
      label: 'startLegacyLoopbackRecognition',
      transformArgs: () => [{ source: 'system', legacyLoopback: true }],
      fallback: (error) => ({ error: error.message })
    }),

    probeNativeSystemAudio: invokeWithFallback(ipcRenderer, {
      channel: 'native-system-audio-probe',
      label: 'probeNativeSystemAudio',
      transformArgs: (args) => [{ fresh: Boolean(args[0]?.fresh) }],
      fallback: (error) => ({ available: false, reason: error.message })
    }),

    companionGetState: invokeWithFallback(ipcRenderer, { channel: 'companion:get-state', label: 'companionGetState', fallback: () => null }),
    companionSetEnabled: invokeWithFallback(ipcRenderer, {
      channel: 'companion:set-enabled',
      label: 'companionSetEnabled',
      transformArgs: (args) => [args[0] === true],
      fallback: () => null
    }),
    companionRevokeSessions: invokeWithFallback(ipcRenderer, { channel: 'companion:revoke-sessions', label: 'companionRevokeSessions', fallback: () => null }),

    webSyncState: invokeWithFallback(ipcRenderer, { channel: 'web-sync:state', label: 'webSyncState', fallback: () => null }),
    webSyncLink: invokeWithFallback(ipcRenderer, {
      channel: 'web-sync:link',
      label: 'webSyncLink',
      transformArgs: (args) => [{ baseUrl: String(args[0] || '') }],
      fallback: () => null
    }),
    webSyncCancelLink: invokeWithFallback(ipcRenderer, { channel: 'web-sync:cancel-link', label: 'webSyncCancelLink', fallback: () => null }),
    webSyncCheck: invokeWithFallback(ipcRenderer, { channel: 'web-sync:check', label: 'webSyncCheck', fallback: () => null }),
    webSyncApply: invokeWithFallback(ipcRenderer, { channel: 'web-sync:apply', label: 'webSyncApply', fallback: () => null }),
    webSyncUnlink: invokeWithFallback(ipcRenderer, { channel: 'web-sync:unlink', label: 'webSyncUnlink', fallback: () => null }),
    webSyncViewPdf: invokeWithFallback(ipcRenderer, {
      channel: 'web-sync:view-pdf',
      label: 'webSyncViewPdf',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    getContext: invokeWithFallback(ipcRenderer, {
      channel: 'context:get',
      label: 'getContext',
      fallback: () => null
    }),

    updateContext: invokeWithFallback(ipcRenderer, {
      channel: 'context:update',
      label: 'updateContext',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    importResume: invokeWithFallback(ipcRenderer, {
      channel: 'context:import-resume',
      label: 'importResume',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    removeResume: invokeWithFallback(ipcRenderer, {
      channel: 'context:remove-resume',
      label: 'removeResume',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    testNativeSystemAudio: invokeWithFallback(ipcRenderer, {
      channel: 'native-system-audio-test',
      label: 'testNativeSystemAudio',
      fallback: (error) => ({ success: false, code: 'IPC_FAILED', error: error.message })
    }),

    getMediaAccessStatus: invokeWithFallback(ipcRenderer, {
      channel: 'get-media-access-status',
      label: 'getMediaAccessStatus',
      fallback: () => ({ microphone: 'unknown' })
    }),

    requestMicrophoneAccess: invokeWithFallback(ipcRenderer, {
      channel: 'request-microphone-access',
      label: 'requestMicrophoneAccess',
      fallback: () => ({ granted: false })
    }),

    runAiTestAnswer: invokeWithFallback(ipcRenderer, {
      channel: 'ai-test-answer',
      label: 'runAiTestAnswer',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    startNativeSystemAudio: invokeWithFallback(ipcRenderer, {
      channel: 'native-system-audio-start',
      label: 'startNativeSystemAudio',
      fallback: (error) => ({ success: false, code: 'IPC_FAILED', error: error.message })
    }),

    stopNativeSystemAudio: invokeWithFallback(ipcRenderer, {
      channel: 'native-system-audio-stop',
      label: 'stopNativeSystemAudio',
      fallback: () => ({ success: false })
    }),

    sendAudioChunk: (source, audioData) => {
      ipcRenderer.send('audio-chunk', { source, data: audioData });
    },

    getDesktopSources: invokeWithFallback(ipcRenderer, {
      channel: 'get-desktop-sources',
      label: 'getDesktopSources',
      fallback: () => []
    }),

    reportSystemAudioStatus: (payload) => {
      ipcRenderer.send('system-audio-status', payload);
    },

    // Barge-in: a newer question arrived mid-answer, so the phone should stop
    // presenting the old one as current.
    reportAnswerSuperseded: () => {
      ipcRenderer.send('answer-superseded', {});
    },

    openLoopbackSetupGuide: invokeWithFallback(ipcRenderer, {
      channel: 'open-loopback-setup-guide',
      label: 'openLoopbackSetupGuide',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    transcribeAudio: invokeWithFallback(ipcRenderer, {
      channel: 'transcribe-audio',
      label: 'transcribeAudio',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    addVoiceTranscript: invokeWithFallback(ipcRenderer, {
      channel: 'add-voice-transcript',
      label: 'addVoiceTranscript',
      fallback: (error) => ({ error: error.message })
    }),

    suggestResponse: invokeWithFallback(ipcRenderer, {
      channel: 'suggest-response',
      label: 'suggestResponse',
      fallback: (error) => ({ error: error.message })
    }),

    generateMeetingNotes: invokeWithFallback(ipcRenderer, {
      channel: 'generate-meeting-notes',
      label: 'generateMeetingNotes',
      fallback: (error) => ({ error: error.message })
    }),

    generateFollowUpEmail: invokeWithFallback(ipcRenderer, {
      channel: 'generate-follow-up-email',
      label: 'generateFollowUpEmail',
      fallback: (error) => ({ error: error.message })
    }),

    answerQuestion: invokeWithFallback(ipcRenderer, {
      channel: 'answer-question',
      label: 'answerQuestion',
      fallback: (error) => ({ error: error.message })
    }),

    getConversationInsights: invokeWithFallback(ipcRenderer, {
      channel: 'get-conversation-insights',
      label: 'getConversationInsights',
      fallback: (error) => ({ error: error.message })
    }),

    clearConversationHistory: invokeWithFallback(ipcRenderer, {
      channel: 'clear-conversation-history',
      label: 'clearConversationHistory',
      fallback: (error) => ({ error: error.message })
    }),

    getConversationHistory: invokeWithFallback(ipcRenderer, {
      channel: 'get-conversation-history',
      label: 'getConversationHistory',
      fallback: (error) => ({ error: error.message })
    }),

    getSettings: invokeWithFallback(ipcRenderer, {
      channel: 'get-settings',
      label: 'getSettings',
      fallback: (error) => ({ error: error.message })
    }),

    saveSettings: invokeWithFallback(ipcRenderer, {
      channel: 'save-settings',
      label: 'saveSettings',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    saveShortcut: invokeWithFallback(ipcRenderer, {
      channel: 'save-shortcut',
      label: 'saveShortcut',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    listOllamaModels: invokeWithFallback(ipcRenderer, {
      channel: 'ollama-list-models',
      label: 'listOllamaModels',
      fallback: (error) => ({ ok: false, error: error.message })
    }),

    setThemePreference: invokeWithFallback(ipcRenderer, {
      channel: 'set-theme-preference',
      label: 'setThemePreference',
      transformArgs: (args) => [{ theme: args[0] }],
      fallback: (error) => ({ success: false, error: error.message })
    }),

    closeApp: invokeWithFallback(ipcRenderer, {
      channel: 'close-app',
      label: 'closeApp',
      fallback: (error) => ({ error: error.message })
    }),

    getMobileServerStatus: invokeWithFallback(ipcRenderer, {
      channel: 'mobile-server-get-status',
      label: 'getMobileServerStatus',
      fallback: () => ({ listening: false, port: 7823, urls: [], clientCount: 0, error: null })
    }),

    getMobilePasscode: invokeWithFallback(ipcRenderer, {
      channel: 'mobile-server-get-passcode',
      label: 'getMobilePasscode',
      fallback: () => ''
    }),

    getDiagnosticSnapshot: invokeWithFallback(ipcRenderer, {
      channel: 'get-diagnostic-snapshot',
      label: 'getDiagnosticSnapshot',
      fallback: () => null
    }),

    submitFinalQuestion: invokeWithFallback(ipcRenderer, {
      channel: 'assistant:final-question',
      label: 'submitFinalQuestion',
      transformArgs: (args) => [args[0]],
      fallback: (error) => ({ success: false, error: error.message })
    }),

    reportQuestionQueue: (payload) => {
      ipcRenderer.send('report-question-queue', payload);
    }
  };
}

module.exports = {
  createInvokeActions
};
