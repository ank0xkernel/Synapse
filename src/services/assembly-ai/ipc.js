const { shell } = require('electron');
const path = require('path');

const SETUP_GUIDE_PATH = path.join(__dirname, '..', '..', '..', 'docs', 'BLACKHOLE-SETUP.md');

/**
 * @param {object} deps
 * @param {object} deps.nativeSystemAudio  native-system-audio.js instance (macOS helper).
 *   Its frames reach the renderer through the onFrame callback wired in
 *   start-application.js, not through this module.
 */
function registerAssemblyAiIpc({
  ipcMain,
  assemblyAiService,
  ensureAudioInputAccess = async () => true,
  nativeSystemAudio = null,
  onListeningStart = () => {},
  createTestCapture = null,
  playTestSound = async () => {},
  getExcludedPids = () => []
}) {
  // Renderer-reported capture state. Goes out through the augmented sender so
  // the mobile companion sees whether host audio is actually being captured.
  ipcMain.on('system-audio-status', (_event, payload = {}) => {
    assemblyAiService.reportSystemAudioStatus(payload);
  });

  ipcMain.on('answer-superseded', () => {
    assemblyAiService.reportAnswerSuperseded();
  });

  // Only used by the legacy loopback fallback (macOS older than 13).
  ipcMain.handle('open-loopback-setup-guide', async () => {
    try {
      const error = await shell.openPath(SETUP_GUIDE_PATH);
      if (error) {
        return { success: false, error };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('start-voice-recognition', async (_event, { source, legacyLoopback = false } = {}) => {
    const resolvedSource = source === 'system' ? 'system' : 'mic';
    console.log(`IPC: start-voice-recognition [${resolvedSource}]`);
    assemblyAiService.emitSttDebug({
      source: resolvedSource,
      event: 'ipc-start',
      message: 'Renderer requested source start'
    });

    // The microphone TCC gate applies to the mic and to the legacy BlackHole
    // input. Native system capture has its own permission (System Audio
    // Recording / Screen Recording), requested by macOS when the helper starts.
    if (resolvedSource === 'mic' || legacyLoopback) {
      const granted = await ensureAudioInputAccess();
      if (!granted) {
        const error = 'Audio input permission denied. Enable it in System Settings → Privacy & Security → Microphone.';
        assemblyAiService.emitSttDebug({
          source: resolvedSource,
          level: 'error',
          event: 'permission-denied',
          message: error
        });
        return { success: false, error };
      }
    }

    // Questions follow soon after listening starts; warm the AI connection now.
    try {
      onListeningStart(resolvedSource);
    } catch (_) { /* best effort */ }

    return assemblyAiService.startAssemblyAiStream(resolvedSource);
  });

  ipcMain.on('audio-chunk', (_event, payload = {}) => {
    assemblyAiService.handleAudioChunk(payload);
  });

  ipcMain.handle('stop-voice-recognition', async (_event, { source } = {}) => {
    console.log(`IPC: stop-voice-recognition [${source}]`);
    return assemblyAiService.stopVoiceRecognition({ source });
  });

  ipcMain.handle('native-system-audio-probe', async (_event, { fresh = false } = {}) => {
    if (!nativeSystemAudio) return { available: false, reason: 'not-configured' };
    return nativeSystemAudio.probe({ fresh: Boolean(fresh) });
  });

  /**
   * Onboarding / status-panel audio test: captures ~2.5 s through a separate
   * helper instance while macOS plays a short system sound, and reports the
   * real peak level. The first run is also what triggers macOS's permission
   * prompt. Output routing is never touched.
   */
  ipcMain.handle('native-system-audio-test', async () => {
    if (!createTestCapture) return { success: false, code: 'NOT_CONFIGURED', error: 'Native capture is not configured' };
    let peak = 0;
    let samples = 0;
    const capture = createTestCapture((frame) => {
      samples += frame.length;
      for (let index = 0; index < frame.length; index += 1) {
        const value = Math.abs(frame[index]);
        if (value > peak) peak = value;
      }
    });
    const started = await capture.start({ excludePids: [] });
    if (!started.success) return { success: false, code: started.code, error: started.error };
    await playTestSound();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await capture.stop();
    const info = await capture.probe({ fresh: true });
    return {
      success: true,
      backend: started.backend,
      heard: peak > 0.0008,
      peakDb: peak > 0 ? Math.round(20 * Math.log10(peak) * 10) / 10 : null,
      samples,
      defaultOutput: info.defaultOutput || null
    };
  });

  ipcMain.handle('native-system-audio-start', async () => {
    if (!nativeSystemAudio) return { success: false, code: 'NOT_CONFIGURED', error: 'Native capture is not configured' };
    const result = await nativeSystemAudio.start({ excludePids: getExcludedPids() });
    assemblyAiService.emitSttDebug({
      source: 'system',
      level: result.success ? 'info' : 'error',
      event: result.success ? 'native-capture-ready' : 'native-capture-failed',
      message: result.success ? `Native capture via ${result.backend}` : `${result.code}: ${result.error}`
    });
    return result;
  });

  ipcMain.handle('native-system-audio-stop', async () => {
    if (nativeSystemAudio) await nativeSystemAudio.stop();
    return { success: true };
  });

  ipcMain.handle('native-system-audio-state', () => (nativeSystemAudio ? nativeSystemAudio.getState() : null));

  ipcMain.handle('get-desktop-sources', async () => {
    return assemblyAiService.getDesktopSources();
  });

  ipcMain.handle('transcribe-audio', async (_event, base64Audio) => {
    console.log('IPC: transcribe-audio called, size:', base64Audio?.length || 0);
    return assemblyAiService.transcribeAudio(base64Audio);
  });
}

module.exports = {
  registerAssemblyAiIpc
};
