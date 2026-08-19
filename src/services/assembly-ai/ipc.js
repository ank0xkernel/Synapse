const { shell } = require('electron');
const path = require('path');

const SETUP_GUIDE_PATH = path.join(__dirname, '..', '..', '..', 'docs', 'BLACKHOLE-SETUP.md');

function registerAssemblyAiIpc({ ipcMain, assemblyAiService, ensureAudioInputAccess = async () => true }) {
  // Renderer-reported capture state. Goes out through the augmented sender so
  // the mobile companion sees whether host audio is actually being captured.
  ipcMain.on('system-audio-status', (_event, payload = {}) => {
    assemblyAiService.reportSystemAudioStatus(payload);
  });

  ipcMain.on('answer-superseded', () => {
    assemblyAiService.reportAnswerSuperseded();
  });

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

  ipcMain.handle('start-voice-recognition', async (_event, { source } = {}) => {
    const resolvedSource = source === 'system' ? 'system' : 'mic';
    console.log(`IPC: start-voice-recognition [${resolvedSource}]`);
    assemblyAiService.emitSttDebug({
      source: resolvedSource,
      event: 'ipc-start',
      message: 'Renderer requested source start'
    });

    // macOS exposes BlackHole as an audio *input*, so even host-audio capture
    // goes through the microphone TCC gate. Requesting here — rather than at
    // launch — means a session that never records never prompts.
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

    return assemblyAiService.startAssemblyAiStream(resolvedSource);
  });

  ipcMain.on('audio-chunk', (_event, payload = {}) => {
    assemblyAiService.handleAudioChunk(payload);
  });

  ipcMain.handle('stop-voice-recognition', (_event, { source } = {}) => {
    console.log(`IPC: stop-voice-recognition [${source}]`);
    return assemblyAiService.stopVoiceRecognition({ source });
  });

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
