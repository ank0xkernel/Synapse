const {
  app,
  dialog,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  safeStorage,
  screen,
  shell,
  systemPreferences
} = require('electron');
const WebSocket = require('ws');

const {
  loadApplicationEnvironment,
  normalizeGeminiApiKeys,
  saveApplicationEnvironment
} = require('../bootstrap/environment');
const {
  getAssemblyAiSpeechModels,
  getDefaultAssemblyAiSpeechModel,
  getKeyboardShortcuts,
  resolveAssemblyAiSpeechModel,
  setShortcutOverrides
} = require('../config');
const {
  getAppStatePath,
  loadAppState,
  saveAppState
} = require('../services/state/app-state');
const { createAssistantWindow } = require('../windows/assistant/window');
const { createSafeSender } = require('./shared/safe-send');
const appProtocol = require('./shared/app-protocol');
const { createGeminiRuntime } = require('./features/assistant/gemini-runtime');
const { createScreenshotManager } = require('./features/assistant/screenshot-manager');
const { registerAssistantIpc } = require('./features/assistant/ipc');
const { registerContextIpc } = require('./features/context/context-ipc');
const { registerWebSyncIpc } = require('./features/context/web-sync-ipc');
const { createAssemblyAiService } = require('../services/assembly-ai/service');
const { createGeminiSpeechService } = require('../services/stt/gemini-speech-service');
const { createQuestionLatencyTracker } = require('../services/latency/question-latency-tracker');
const { registerAssemblyAiIpc } = require('../services/assembly-ai/ipc');
const { createNativeSystemAudio, resolveHelperPath } = require('../services/native-audio/native-system-audio');
const { registerSettingsIpc } = require('./features/settings/ipc');
const { createWindowController } = require('./features/window/window-controller');
const { DEFAULT_WINDOW_OPACITY_LEVEL } = require('./features/window/window-constants');
const { logStartupConfiguration } = require('./startup-logging');
const { createMobileServer } = require('./features/mobile-server/server');
const systemCapabilities = require('../services/system-capabilities');
const interviewContext = require('../services/context/interview-context');
const WhisperCoreMLService = require('../services/stt/whisper-coreml-service');
const WhisperMicService = require('../services/stt/whisper-mic-service');
const AiOrchestrator = require('./features/assistant/ai-orchestrator');
const TrayController = require('./features/window/tray-controller');
const SystemWatchdog = require('./features/watchdog/system-watchdog');

function resolveStartupOptions(argv = process.argv) {
  const normalizedArgs = Array.isArray(argv)
    ? argv.map((value) => String(value || '').trim().toLowerCase())
    : [];

  const hasFlag = (flag) => normalizedArgs.includes(flag);

  return {
    startHidden: hasFlag('--start-hidden') || hasFlag('--background')
  };
}

/**
 * macOS gates every audio *input* behind the microphone TCC entry — the mic,
 * and the legacy BlackHole fallback input. Native system capture has its own
 * permission. Without an explicit request the getUserMedia call in the renderer fails silently: the
 * transcription UI just never produces text, with nothing in the log to explain
 * why. Called lazily from the start-voice-recognition IPC.
 */
async function ensureMicrophoneAccess() {
  if (process.platform !== 'darwin') {
    return true;
  }

  try {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    console.log(`[Permissions] Microphone access status: ${status}`);

    if (status === 'granted') {
      return true;
    }

    if (status === 'denied' || status === 'restricted') {
      console.warn(
        '[Permissions] Microphone access is denied. Transcription cannot work until you '
        + 'enable it in System Settings → Privacy & Security → Microphone.'
      );
      return false;
    }

    const granted = await systemPreferences.askForMediaAccess('microphone');
    console.log(`[Permissions] Microphone access ${granted ? 'granted' : 'refused'} by user.`);
    return granted;
  } catch (error) {
    console.error('[Permissions] Microphone access check failed:', error.message);
    return false;
  }
}

async function startApplication() {
  // One overlay per machine. Without this every launch opened another window
  // bound to the same shortcuts and the same port 7823, so you ended up with
  // two assistants fighting over the same state.
  if (!app.requestSingleInstanceLock()) {
    console.log('[Startup] Synapse is already running — focusing the existing window.');
    app.exit(0);
    return;
  }

  app.on('second-instance', () => {
    if (!windowController) {
      return;
    }

    if (!windowController.hasWindow()) {
      windowController.createWindow();
    }

    const existing = windowController.getMainWindow();
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      windowController.markVisible();
    }
  });

  // Privileged schemes must be declared before the app is ready, so this cannot
  // move into the whenReady handler below.
  appProtocol.registerScheme();

  // Command-line switches are only read while Chromium starts up. These used to
  // be appended inside the whenReady handler, by which point they had no
  // effect at all.
  //
  // Hardware video decode only. TLS verification and web security are left at
  // their secure defaults: this process sends API keys to Gemini/AssemblyAI,
  // and disabling certificate checks process-wide would expose them to any
  // machine-in-the-middle on the network.
  app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder');

  // The heap limit that NODE_OPTIONS used to try (and fail) to set.
  const heapMatch = /--max-old-space-size=(\d+)/.exec(process.env.NODE_OPTIONS || '');
  app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${heapMatch ? heapMatch[1] : '4096'}`);

  let appEnvironment = null;
  let appState = null;
  let isShuttingDown = false;
  const startupOptions = resolveStartupOptions();

  const geminiRuntime = createGeminiRuntime();

  const assemblyAiSpeechModels = getAssemblyAiSpeechModels();
  const defaultAssemblyAiSpeechModel = getDefaultAssemblyAiSpeechModel();
  const keyboardShortcuts = getKeyboardShortcuts();
  let activeAssemblyAiSpeechModel = defaultAssemblyAiSpeechModel;

  let screenshotManager = null;
  let webSyncControl = null;
  let windowController = null;

  const baseSendToRenderer = createSafeSender(() => {
    if (!windowController) {
      return null;
    }

    return windowController.getMainWindow();
  });

  // Mobile server reports its own status (listening, URLs, client count) to
  // the desktop renderer via the un-augmented sender — we don't want it
  // bouncing back to mobile clients.
  const mobileServer = createMobileServer({
    getGeminiRuntime:    () => geminiRuntime,
    getScreenshotManager: () => screenshotManager,
    // The dashboard's health panel, restart buttons and JD indexing all act on
    // these; without them those endpoints can only return canned answers.
    getAiOrchestrator:   () => aiOrchestrator,
    getLocalServices:    () => ({
      whisperCoreML: whisperCoreMLService,
      whisperMic:    whisperMicService,
      ollama:        aiOrchestrator?.ollamaService || null
    }),
    getSystemAudioCapture: async () => ({
      probe: await nativeSystemAudio.probe(),
      state: nativeSystemAudio.getState()
    }),
    // Companion access is off until the user enables it; the choice persists
    // in its own file (the shared app-state sanitizer drops unknown keys).
    enabledStore: require('./features/mobile-server/server').createFileEnabledStore(
      require('path').join(app.getPath('userData'), 'companion-settings.json')
    ),
    // Returns the insertion result for 'send-answer-to-editor' so the phone
    // is only told "sent" after the desktop really inserted the text.
    notifyDesktop:        (channel, data) => {
      if (channel === 'send-answer-to-editor') {
        const inserter = aiOrchestrator?.textInserter;
        if (!inserter || typeof inserter.insertText !== 'function') {
          return Promise.reject(new Error('The desktop text inserter is not ready.'));
        }
        return inserter.insertText(String(data?.text || ''));
      }
      baseSendToRenderer(channel, data);
      return undefined;
    }
  });

  // Augmented sender: events flow to both the Electron renderer and all
  // connected mobile WebSocket clients simultaneously.
  const sendToRenderer = (channel, data) => {
    baseSendToRenderer(channel, data);
    mobileServer.broadcast(channel, data);
  };

  // T2 (Ask AI invoked) -> T6 (first chunk broadcast) instrumentation. See
  // ipc.js's ask-ai-with-session-context handler for where each stage is
  // marked, and its comment for why T0/T1 aren't wired yet.
  const latencyTracker = createQuestionLatencyTracker();

  // Multilingual STT. Buffers the same frames AssemblyAI gets and transcribes
  // whole utterances with Gemini, which handles Hindi/Hinglish that the
  // AssemblyAI streaming models shred into phonetic debris.
  const geminiSpeechService = createGeminiSpeechService({
    getApiKey: () => normalizeGeminiApiKeys(appState?.geminiApiKey)[appState?.geminiApiKeyIndex || 0]
      || normalizeGeminiApiKeys(appState?.geminiApiKey)[0]
      || '',
    getModel: () => appState?.geminiModel || 'gemini-3.5-flash-lite',
    getMode: () => appState?.sttMode || 'auto',
    emitSttDebug: (payload) => assemblyAiService.emitSttDebug(payload)
  });

  const assemblyAiService = createAssemblyAiService({
    WebSocket,
    desktopCapturer,
    getAssemblyApiKey: () => appState?.assemblyAiApiKey || '',
    getSpeechModel: () => activeAssemblyAiSpeechModel,
    getGeminiService: () => geminiRuntime.getService(),
    sendToRenderer,
    getSttMode: () => appState?.sttMode || 'auto',
    geminiSpeech: geminiSpeechService
  });

  // Native macOS system-audio capture. Frames go to the renderer only (never
  // the augmented sender, which would broadcast raw audio to LAN clients);
  // status changes go everywhere so the companion can show capture state.
  const nativeSystemAudio = createNativeSystemAudio({
    binaryPath: resolveHelperPath({ isPackaged: app.isPackaged }),
    onFrame: (frame) => baseSendToRenderer('native-system-audio-frame', frame),
    onStatus: (status) => sendToRenderer('native-system-audio-status', status)
  });

  windowController = createWindowController({
    app,
    screen,
    globalShortcut,
    createAssistantWindow,
    getAppEnvironment: () => appEnvironment,
    emitSttDebug: assemblyAiService.emitSttDebug,
    sendToRenderer,
    onTakeStealthScreenshot: async () => {
      if (screenshotManager) {
        await screenshotManager.takeStealthScreenshot();
      }
    }
  });

  screenshotManager = createScreenshotManager({
    app,
    getMainWindow: () => windowController.getMainWindow(),
    getAppEnvironment: () => appEnvironment,
    sendToRenderer
  });

  function loadPersistedAppState() {
    appState = loadAppState(app);

    // Must land before registerShortcuts() so re-bound keys survive a restart.
    setShortcutOverrides(appState.shortcutOverrides || {});

    const activeAiProvider = geminiRuntime.setActiveAiProvider(appState.aiProvider);
    const keyState = geminiRuntime.setKeys(
      normalizeGeminiApiKeys(appState?.geminiApiKey),
      appState.geminiApiKeyIndex
    );
    const activeGeminiModel = geminiRuntime.setActiveGeminiModel(appState.geminiModel);
    const activeOllamaBaseUrl = geminiRuntime.setActiveOllamaBaseUrl(appState.ollamaBaseUrl);
    const activeOllamaModel = geminiRuntime.setActiveOllamaModel(appState.ollamaModel);
    activeAssemblyAiSpeechModel = resolveAssemblyAiSpeechModel(appState.assemblyAiSpeechModel);
    const activeProgrammingLanguage = geminiRuntime.setActiveProgrammingLanguage(appState.programmingLanguage);
    const activeWindowOpacityLevel = windowController.setWindowOpacityLevel(appState.windowOpacityLevel);
    const activeClickThrough = windowController.setClickThrough(appState.clickThroughEnabled === true);

    // Single-line, always-on confirmation of which provider is actually live —
    // the thing that was silently wrong for every question until this pass.
    console.log(
      activeAiProvider === 'ollama'
        ? `[AiProvider] Active: Ollama  Model: ${activeOllamaModel}  Base URL: ${activeOllamaBaseUrl}`
        : `[AiProvider] Active: Gemini  Model: ${activeGeminiModel}`
    );

    if (
      appState.aiProvider !== activeAiProvider ||
      appState.geminiApiKeyIndex !== keyState.activeApiKeyIndex ||
      appState.geminiModel !== activeGeminiModel ||
      appState.ollamaBaseUrl !== activeOllamaBaseUrl ||
      appState.ollamaModel !== activeOllamaModel ||
      appState.assemblyAiSpeechModel !== activeAssemblyAiSpeechModel ||
      appState.programmingLanguage !== activeProgrammingLanguage ||
      appState.windowOpacityLevel !== activeWindowOpacityLevel ||
      appState.clickThroughEnabled !== activeClickThrough
    ) {
      appState = saveAppState(app, {
        aiProvider: activeAiProvider,
        geminiApiKeyIndex: keyState.activeApiKeyIndex,
        geminiModel: activeGeminiModel,
        ollamaBaseUrl: activeOllamaBaseUrl,
        ollamaModel: activeOllamaModel,
        assemblyAiSpeechModel: activeAssemblyAiSpeechModel,
        programmingLanguage: activeProgrammingLanguage,
        windowOpacityLevel: activeWindowOpacityLevel,
        clickThroughEnabled: activeClickThrough
      });
    }

    console.log('Loaded app state from:', getAppStatePath(app));
    console.log('Restored AI provider from app state:', activeAiProvider);
    console.log(`Restored Gemini API key index from app state: ${keyState.activeApiKeyIndex + 1}/${keyState.geminiApiKeys.length}`);
    console.log('Restored Gemini model from app state:', activeGeminiModel);
    console.log('Restored Ollama config from app state:', activeOllamaModel, 'at', activeOllamaBaseUrl);
    console.log('Restored AssemblyAI speech model from app state:', activeAssemblyAiSpeechModel);
    console.log('Restored programming language from app state:', activeProgrammingLanguage);
    console.log(`Restored window opacity level from app state: ${activeWindowOpacityLevel}/10`);
    console.log(`Restored click-through from app state: ${activeClickThrough}`);
  }

  function cleanupTransientResources() {
    nativeSystemAudio.stop().catch(() => {});
    webSyncControl?.cleanup();
    assemblyAiService.dispose();
    screenshotManager.cleanupTransientResources();
    windowController.unregisterShortcuts();
    mobileServer.close();

    // Child processes and timers outlive the window unless stopped explicitly.
    if (systemWatchdog) systemWatchdog.stop();
    whisperCoreMLService.stop().catch(() => {});
    whisperMicService.stop().catch(() => {});
    if (aiOrchestrator?.ollamaService?.stop) {
      aiOrchestrator.ollamaService.stop().catch(() => {});
    }
  }

  function quitApplication() {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;

    cleanupTransientResources();
    windowController.destroyWindow();

    setTimeout(() => {
      app.exit(0);
    }, 50);
  }

  ipcMain.handle('mobile-server-get-status', () => mobileServer.getStatus());
  ipcMain.handle('mobile-server-get-passcode', () => {
    const TotpAuth = require('./features/security/totp-auth');
    return TotpAuth.shared(app).generateToken();
  });

  // Companion (phone) access. Off by default; urls never contain credentials.
  ipcMain.handle('companion:get-state', () => mobileServer.getStatus());
  ipcMain.handle('companion:set-enabled', (_event, enabled) => mobileServer.setEnabled(enabled === true));
  ipcMain.handle('companion:revoke-sessions', () => mobileServer.revokeSessions());

  /*
   * Real interview-session bug report: nothing in the assistant window ever
   * told the user whether the resume/JD/company they'd entered through the
   * web companion had actually been saved before the interview started —
   * the first sign of a missing save was a live answer with no grounding.
   * interviewContext.load() is a cheap, already-cached, synchronous read
   * (see interview-context.js) — this is a lightweight status projection of
   * it, not the raw text, so a resume that happens to be several KB doesn't
   * cross the IPC boundary just to answer "is anything loaded at all".
   */
  // Real permission state for the onboarding and status screens.
  ipcMain.handle('get-media-access-status', () => ({
    microphone: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'granted'
  }));
  ipcMain.handle('request-microphone-access', async () => ({ granted: await ensureMicrophoneAccess() }));

  /**
   * Onboarding "test answer": one tiny real request through the same realtime
   * lane and key failover as live answers. Reports time to first token.
   */
  ipcMain.handle('ai-test-answer', async () => {
    const started = Date.now();
    let firstTokenAt = null;
    try {
      const text = await geminiRuntime.executeWithKeyFailover((service) => {
        if (!service) throw new Error('AI service not initialized. Check your API key.');
        if (typeof service.generateText !== 'function') throw new Error('The selected provider does not support a test answer.');
        return service.generateText('Reply with exactly: Synapse is ready.', {
          priority: 'realtime',
          generation: { maxOutputTokens: 40, thinkingLevel: 'low' },
          onChunk: () => { if (firstTokenAt === null) firstTokenAt = Date.now(); }
        });
      });
      return {
        success: true,
        text: String(text || '').trim().slice(0, 120),
        firstTokenMs: firstTokenAt ? firstTokenAt - started : null,
        totalMs: Date.now() - started,
        model: geminiRuntime.getActiveGeminiModel()
      };
    } catch (error) {
      return { success: false, error: error.message, totalMs: Date.now() - started };
    }
  });

  ipcMain.handle('get-interview-context-status', () => {
    const context = interviewContext.load();
    return {
      hasResume: Boolean(String(context.background || '').trim()),
      hasJd: Boolean(String(context.jobDescription || '').trim()),
      role: context.role || '',
      company: context.company || '',
      updatedAt: context.updatedAt || null
    };
  });

  /*
   * Phase 13: the main-process half of the diagnostic snapshot. Gathers
   * facts that only exist here -- AssemblyAI's own chunk/streaming state,
   * the latency tracker's last completed (and any still-in-flight) report,
   * and the native capture helper's state -- into one call so the renderer
   * doesn't need several round trips. Technical metrics only: no
   * transcript content passes through here, no keys, no auth headers.
   */
  ipcMain.handle('get-diagnostic-snapshot', async () => {
    return {
      transcription: assemblyAiService.getDiagnosticState(),
      nativeAudio: {
        probe: await nativeSystemAudio.probe(),
        state: nativeSystemAudio.getState()
      },
      latency: latencyTracker
        ? { lastReport: latencyTracker.getLastReport(), activeReports: latencyTracker.getActiveReports() }
        : null
    };
  });

  registerContextIpc({
    ipcMain,
    dialog,
    getMainWindow: () => windowController.getMainWindow()
  });

  // Website account link and context sync (docs/desktop-web-contract.md).
  // State goes to this window only (baseSendToRenderer), never the phone.
  webSyncControl = registerWebSyncIpc({
    ipcMain,
    app,
    shell,
    safeStorage,
    sendToWindow: baseSendToRenderer
  });

  registerAssistantIpc({
    ipcMain,
    screenshotManager,
    windowController,
    geminiRuntime,
    assemblyAiService,
    sendToRenderer,
    quitApplication,
    mobileServer,
    latencyTracker
  });

  registerAssemblyAiIpc({
    ipcMain,
    assemblyAiService,
    ensureAudioInputAccess: ensureMicrophoneAccess,
    nativeSystemAudio,
    onListeningStart: () => {
      geminiRuntime.prewarmConnection();
      webSyncControl?.checkBeforeSession();
    },
    createTestCapture: (onFrame) => createNativeSystemAudio({
      binaryPath: resolveHelperPath({ isPackaged: app.isPackaged }),
      onFrame,
      log: () => {}
    }),
    playTestSound: () => new Promise((resolve) => {
      require('child_process').execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], () => resolve());
    }),
    // Keep Synapse's own sounds out of the interviewer channel.
    getExcludedPids: () => app.getAppMetrics().map((metric) => metric.pid)
  });

  registerSettingsIpc({
    ipcMain,
    app,
    getAppEnvironment: () => appEnvironment,
    setAppEnvironment: (nextEnvironment) => {
      appEnvironment = nextEnvironment;
    },
    getAppState: () => appState,
    setAppState: (nextAppState) => {
      appState = nextAppState;
    },
    getAppStatePath,
    saveApplicationEnvironment,
    saveAppState,
    geminiRuntime,
    windowController,
    getAssemblyAiSpeechModel: () => activeAssemblyAiSpeechModel,
    setAssemblyAiSpeechModel: (nextModel) => {
      activeAssemblyAiSpeechModel = resolveAssemblyAiSpeechModel(nextModel, activeAssemblyAiSpeechModel);
      return activeAssemblyAiSpeechModel;
    },
    keyboardShortcuts,
    assemblyAiSpeechModels,
    defaultAssemblyAiSpeechModel
  });

  const whisperCoreMLService = new WhisperCoreMLService();
  const whisperMicService = new WhisperMicService();
  const aiOrchestrator = new AiOrchestrator({
    mobileServer,
    getActiveAiProvider: () => geminiRuntime.getActiveAiProvider()
  });
  const trayController = new TrayController({ mobileServer, onQuit: quitApplication });
  let systemWatchdog = null;

  ipcMain.handle('assistant:final-question', async (_event, question) => {
    console.log('[IPC] Received assistant:final-question:', question);
    await aiOrchestrator.processQuestion(question);
    return { status: 'ok' };
  });

  app.whenReady().then(async () => {
    // Must be live before any window loads a synapse:// URL.
    appProtocol.registerHandler();

    try {
      appEnvironment = loadApplicationEnvironment(app);
    } catch (error) {
      console.error('Failed to load application environment:', error);
      dialog.showErrorBox('Synapse Configuration Error', error.message);
      app.exit(1);
      return;
    }

    loadPersistedAppState();

    // Point the brief at userData in packaged builds before anything reads it.
    console.log(`[Startup] Interview brief: ${interviewContext.configure(app)}`);

    trayController.initialize();
    // Permission is requested lazily, when a capture actually starts — see the
    // start-voice-recognition IPC. Prompting at launch trained users to grant
    // mic access for a session that may never record anything.

    // The local stack (a resident LLM plus two Whisper servers) is only worth
    // starting when it is actually going to be used and the machine can hold
    // it. Starting it unconditionally on a small machine pushes the desktop
    // into swap — which looks like the whole laptop freezing.
    const usingLocalProvider = geminiRuntime.getActiveAiProvider() === 'ollama';
    const machineCanRunLocal = systemCapabilities.canRunLocalLlm();
    const startLocalStack = usingLocalProvider && machineCanRunLocal;

    console.log(`[Startup] Machine: ${systemCapabilities.describeMachine()}`);

    if (usingLocalProvider && !machineCanRunLocal) {
      console.warn(
        `[Startup] Local provider selected, but this machine has under `
        + `${systemCapabilities.MIN_RAM_FOR_LOCAL_LLM_GB} GB RAM. Local services will not be `
        + `auto-started. Switch to the Gemini provider in Settings, or install a small model `
        + `(ollama pull qwen2.5-coder:1.5b) and start it manually.`
      );
    } else if (!usingLocalProvider) {
      console.log('[Startup] Gemini provider active — skipping local Ollama/Whisper startup.');
    }

    if (startLocalStack) {
      // 1. Core routing & memory
      aiOrchestrator.initialize()
        .catch((err) => console.error('[Synapse] AI Orchestrator init error:', err.message));

      // 2. Whisper server (staggered so the UI paints first)
      setTimeout(() => {
        whisperCoreMLService.start()
          .catch((err) => console.error('[Synapse] Whisper start error:', err.message));
      }, 4000);

      // 3. Secondary mic server
      setTimeout(() => {
        whisperMicService.start()
          .catch((err) => console.error('[Synapse] Whisper mic start error:', err.message));
      }, 7000);

      // 4. Watchdog. NOTE: these key names must match what SystemWatchdog reads
      // (whisperService / ollamaService) — they previously did not, leaving the
      // watchdog permanently inert.
      setTimeout(() => {
        systemWatchdog = new SystemWatchdog({
          ollamaService: aiOrchestrator.ollamaService,
          whisperService: whisperCoreMLService
        });
        trayController.watchdog = systemWatchdog;
        systemWatchdog.start();
      }, 10000);
    }

    whisperCoreMLService.on('status-change', ({ status }) => {
      if (status === 'ready') trayController.setStatus('ready');
      else if (status === 'starting') trayController.setStatus('warning');
      else if (status === 'error') trayController.setStatus('error');
    });

    logStartupConfiguration({
      appEnvironment,
      appState,
      geminiModels: geminiRuntime.getGeminiModels(),
      defaultGeminiModel: geminiRuntime.getDefaultGeminiModel(),
      assemblyAiSpeechModels,
      defaultAssemblyAiSpeechModel,
      programmingLanguages: geminiRuntime.getProgrammingLanguages(),
      defaultProgrammingLanguage: geminiRuntime.getDefaultProgrammingLanguage()
    });

    geminiRuntime.setActiveKeyIndexChangeHandler((nextIndex) => {
      if (!appState || appState.geminiApiKeyIndex === nextIndex) {
        return;
      }

      appState = saveAppState(app, { geminiApiKeyIndex: nextIndex });
      console.log(`Persisted Gemini API key index: ${nextIndex + 1}/${geminiRuntime.getApiKeys().length}`);
    });

    if (geminiRuntime.getActiveAiProvider() === 'ollama') {
      geminiRuntime.initializeOllamaService(
        geminiRuntime.getActiveOllamaBaseUrl(),
        geminiRuntime.getActiveOllamaModel(),
        geminiRuntime.getActiveProgrammingLanguage()
      );
    } else {
      geminiRuntime.initializeGeminiService(
        geminiRuntime.getActiveApiKey(),
        geminiRuntime.getActiveGeminiModel(),
        geminiRuntime.getActiveProgrammingLanguage()
      );
    }

    const launchHidden = startupOptions.startHidden || appEnvironment.startHidden;
    console.log('App is ready, creating window...');
    console.log(`Startup mode: ${launchHidden ? 'hidden' : 'visible'}`);
    windowController.createWindow({ launchHidden });
    windowController.registerShortcuts();

    if (!launchHidden) {
      windowController.markVisible();
    }

    if (appState?.windowOpacityLevel == null) {
      windowController.setWindowOpacityLevel(DEFAULT_WINDOW_OPACITY_LEVEL);
    }

    console.log(`Window setup complete (${launchHidden ? 'hidden launch' : 'visible launch'})`);

    // Development-only screenshot capture; inert unless the variable is set.
    if (process.env.SYNAPSE_UI_CAPTURE) {
      const { runUiCapture } = require('./dev/ui-capture');
      const [width, height] = String(process.env.SYNAPSE_UI_CAPTURE_SIZE || '900x560').split('x').map(Number);
      runUiCapture({
        app,
        getMainWindow: () => windowController.getMainWindow(),
        baseSendToRenderer,
        outDir: process.env.SYNAPSE_UI_CAPTURE,
        sceneNames: String(process.env.SYNAPSE_UI_SCENES || '').split(',').filter(Boolean),
        size: [width || 900, height || 560]
      }).catch((error) => {
        console.error('[ui-capture] failed:', error);
        app.exit(1);
      });
    }
  });

  app.on('window-all-closed', () => {
    // Menu-bar app: closing the overlay leaves the tray icon running.
  });

  app.on('activate', () => {
    if (!windowController.hasWindow()) {
      windowController.createWindow();
      windowController.markVisible();
    }
  });

  app.on('will-quit', () => {
    cleanupTransientResources();
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('new-window', (event) => {
      event.preventDefault();
    });

    contents.on('will-navigate', (event, navigationUrl) => {
      const mainWindow = windowController.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return;
      }

      if (navigationUrl !== mainWindow.webContents.getURL()) {
        event.preventDefault();
      }
    });
  });
}

module.exports = {
  startApplication
};
