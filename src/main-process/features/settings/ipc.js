const { setShortcutOverrides } = require('../../../config');

function registerSettingsIpc({
  ipcMain,
  app,
  getAppEnvironment,
  setAppEnvironment,
  getAppState,
  setAppState,
  getAppStatePath,
  saveApplicationEnvironment,
  saveAppState,
  geminiRuntime,
  windowController,
  getAssemblyAiSpeechModel,
  setAssemblyAiSpeechModel,
  keyboardShortcuts,
  assemblyAiSpeechModels,
  defaultAssemblyAiSpeechModel
}) {
  // Listing Ollama's models is done here rather than with a fetch() in the
  // renderer. The renderer is served from the app's own origin, so a direct
  // call to http://localhost:11434 is cross-origin and Ollama does not send
  // permissive CORS headers for it — it only worked while the window ran with
  // web security disabled. The main process has no such restriction.
  ipcMain.handle('ollama-list-models', async (_event, baseUrl) => {
    const target = String(baseUrl || '').trim() || 'http://localhost:11434';

    let endpoint;
    try {
      endpoint = new URL('/api/tags', target).toString();
    } catch (_) {
      return { ok: false, error: 'That does not look like a valid URL.' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(endpoint, { signal: controller.signal });
      if (!response.ok) {
        return { ok: false, error: `Ollama API returned ${response.status}` };
      }

      const data = await response.json();
      const models = Array.isArray(data.models) ? data.models : [];
      return { ok: true, models: models.map((model) => ({ name: model.name })) };
    } catch (error) {
      const reason = error.name === 'AbortError'
        ? 'Ollama did not respond within 5s'
        : error.message;
      return { ok: false, error: `Could not reach Ollama at ${target} (${reason})` };
    } finally {
      clearTimeout(timer);
    }
  });

  // Persists a user-chosen accelerator and rebinds it immediately, so the new
  // key works without a restart. Rejects a combination the OS will not grant
  // (already claimed by another app) and rolls back rather than leaving the
  // shortcut silently dead.
  ipcMain.handle('save-shortcut', (_event, payload = {}) => {
    const shortcutId = String(payload.shortcutId || '').trim();
    const accelerator = String(payload.accelerator || '').trim();

    if (!shortcutId || !accelerator) {
      return { success: false, error: 'Missing shortcut id or accelerator.' };
    }

    const overrides = { ...(getAppState()?.shortcutOverrides || {}), [shortcutId]: accelerator };

    try {
      setShortcutOverrides(overrides);
      const result = windowController.reapplyShortcuts();

      if (!result.ok) {
        // Put the previous binding back so the app is never left half-bound.
        const reverted = { ...(getAppState()?.shortcutOverrides || {}) };
        delete reverted[shortcutId];
        setShortcutOverrides(reverted);
        windowController.reapplyShortcuts();
        return { success: false, error: `"${accelerator}" is already in use by another app.` };
      }

      setAppState(saveAppState(app, { shortcutOverrides: overrides }));
      console.log(`[Shortcuts] ${shortcutId} is now ${accelerator}`);
      return { success: true, shortcutId, accelerator };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-settings', () => {
    const appEnvironment = getAppEnvironment();
    const appState = getAppState();
    const geminiApiKey = typeof appState?.geminiApiKey === 'string' ? appState.geminiApiKey : '';
    const assemblyAiApiKey = typeof appState?.assemblyAiApiKey === 'string' ? appState.assemblyAiApiKey : '';

    return {
      aiProvider: geminiRuntime.getActiveAiProvider(),
      geminiApiKey,
      assemblyAiApiKey,
      hasGeminiApiKeys: geminiApiKey.split(',').map((value) => value.trim()).filter(Boolean).length > 0,
      hasAssemblyAiApiKey: assemblyAiApiKey.length > 0,
      geminiModel: geminiRuntime.getActiveGeminiModel(),
      geminiModels: geminiRuntime.getGeminiModels(),
      defaultGeminiModel: geminiRuntime.getDefaultGeminiModel(),
      ollamaBaseUrl: geminiRuntime.getActiveOllamaBaseUrl(),
      ollamaModel: geminiRuntime.getActiveOllamaModel(),
      defaultOllamaBaseUrl: geminiRuntime.getDefaultOllamaBaseUrl(),
      defaultOllamaModel: geminiRuntime.getDefaultOllamaModel(),
      programmingLanguage: geminiRuntime.getActiveProgrammingLanguage(),
      programmingLanguages: geminiRuntime.getProgrammingLanguages(),
      defaultProgrammingLanguage: geminiRuntime.getDefaultProgrammingLanguage(),
      assemblyAiSpeechModels,
      defaultAssemblyAiSpeechModel,
      assemblyAiSpeechModel: getAssemblyAiSpeechModel(),
      keyboardShortcuts,
      hideFromScreenCapture: appEnvironment.hideFromScreenCapture,
      startHidden: appEnvironment.startHidden,
      windowOpacityLevel: windowController.getWindowOpacityLevel(),
      themePreference: appState?.themePreference === 'dark' || appState?.themePreference === 'light'
        ? appState.themePreference
        : null
    };
  });

  ipcMain.handle('set-theme-preference', (_event, payload = {}) => {
    try {
      const requestedTheme = typeof payload === 'string'
        ? payload
        : payload?.theme;
      const normalizedTheme = String(requestedTheme || '').trim().toLowerCase();
      const themePreference = normalizedTheme === 'dark' ? 'dark' : 'light';

      const updatedAppState = saveAppState(app, { themePreference });
      setAppState(updatedAppState);

      return { success: true, themePreference };
    } catch (error) {
      console.error('Error saving theme preference:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('save-settings', async (_event, settings = {}) => {
    console.log('IPC: save-settings called');

    try {
      const appEnvironment = getAppEnvironment();
      const nextAiProvider = geminiRuntime.setActiveAiProvider(settings.aiProvider);
      const nextGeminiApiKey = String(settings.geminiApiKey || '').trim();
      const nextAssemblyAiApiKey = String(settings.assemblyAiApiKey || '').trim();
      const nextGeminiModel = geminiRuntime.setActiveGeminiModel(settings.geminiModel);
      const nextOllamaBaseUrl = geminiRuntime.setActiveOllamaBaseUrl(settings.ollamaBaseUrl);
      const nextOllamaModel = geminiRuntime.setActiveOllamaModel(settings.ollamaModel);
      const nextAssemblyModel = setAssemblyAiSpeechModel(settings.assemblyAiSpeechModel);
      const nextProgrammingLanguage = geminiRuntime.setActiveProgrammingLanguage(settings.programmingLanguage);
      const nextWindowOpacityLevel = windowController.setWindowOpacityLevel(settings.windowOpacityLevel);

      const updatedEnvironment = saveApplicationEnvironment(app, {
        hideFromScreenCapture: appEnvironment.hideFromScreenCapture,
        startHidden: appEnvironment.startHidden,
        maxScreenshots: appEnvironment.maxScreenshots,
        screenshotDelay: appEnvironment.screenshotDelay,
        nodeEnv: appEnvironment.nodeEnv,
        nodeOptions: appEnvironment.nodeOptions
      });

      const keyState = geminiRuntime.setKeys(nextGeminiApiKey, 0);
      const updatedAppState = saveAppState(app, {
        aiProvider: nextAiProvider,
        geminiApiKey: nextGeminiApiKey,
        assemblyAiApiKey: nextAssemblyAiApiKey,
        geminiApiKeyIndex: keyState.activeApiKeyIndex,
        geminiModel: nextGeminiModel,
        ollamaBaseUrl: nextOllamaBaseUrl,
        ollamaModel: nextOllamaModel,
        assemblyAiSpeechModel: nextAssemblyModel,
        programmingLanguage: nextProgrammingLanguage,
        windowOpacityLevel: nextWindowOpacityLevel
      });

      setAppEnvironment(updatedEnvironment);
      setAppState(updatedAppState);

      console.log('Saved app state to:', getAppStatePath(app));
      console.log('Settings saved to:', updatedEnvironment.envPath);
      console.log('Applied AI provider:', nextAiProvider);
      console.log('Applied programming language:', nextProgrammingLanguage);
      console.log(`Applied window opacity level: ${nextWindowOpacityLevel}/10`);

      if (nextAiProvider === 'ollama') {
        console.log(`Applied Ollama model: ${nextOllamaModel} at ${nextOllamaBaseUrl}`);
        geminiRuntime.initializeOllamaService(
          nextOllamaBaseUrl,
          nextOllamaModel,
          nextProgrammingLanguage
        );
      } else {
        console.log(`Applied Gemini API key index: ${keyState.activeApiKeyIndex + 1}/${keyState.geminiApiKeys.length}`);
        geminiRuntime.initializeGeminiService(
          keyState.activeApiKey,
          nextGeminiModel,
          nextProgrammingLanguage
        );
      }

      return { success: true };
    } catch (error) {
      console.error('Error saving settings:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = {
  registerSettingsIpc
};
