const { resolveResponseModeId, listResponseModes } = require('../../../services/ai/response-modes');

function registerAssistantIpc({
  ipcMain,
  screenshotManager,
  windowController,
  geminiRuntime,
  assemblyAiService,
  sendToRenderer,
  quitApplication,
  mobileServer,
  latencyTracker = null
}) {
  let chatContext = [];

  function getAllKeysUnavailableMessage() {
    return 'All configured Gemini API keys are currently unavailable (quota exhausted or invalid). Please wait and try again later.';
  }

  function mapGeminiErrorMessage(error, fallbackPrefix = 'Request failed') {
    const message = String(error?.message || '');
    const normalizedMessage = message.toLowerCase();

    if (geminiRuntime.isAllKeysUnavailableError?.(error)) {
      return getAllKeysUnavailableMessage();
    }

    if (normalizedMessage.includes('ollama service not available') || normalizedMessage.includes('econnrefused')) {
      return 'Cannot connect to Ollama. Make sure Ollama is running locally.';
    }

    if (normalizedMessage.includes('no api key configured') || normalizedMessage.includes('no gemini api key')) {
      return 'No Gemini API key configured. Add it in Settings.';
    }

    if (
      normalizedMessage.includes('api key not valid') ||
      normalizedMessage.includes('invalid api key') ||
      normalizedMessage.includes('api_key_invalid') ||
      normalizedMessage.includes('permission denied') ||
      normalizedMessage.includes('permission_denied') ||
      normalizedMessage.includes('unauthorized') ||
      normalizedMessage.includes('forbidden') ||
      normalizedMessage.includes('401') ||
      normalizedMessage.includes('403')
    ) {
      return 'Invalid Gemini API key. Please check the key values in Settings.';
    }

    if (
      normalizedMessage.includes('quota') ||
      normalizedMessage.includes('daily request limit') ||
      normalizedMessage.includes('exceeded your current quota')
    ) {
      return 'API quota exceeded. Please try again later.';
    }

    // Google retires models but keeps them visible in ListModels, so this comes
    // back as a 404 on an otherwise perfectly valid key. It was previously
    // caught by the generic 'model' branch (or even the network one) and shown
    // as "check your internet connection", which sent people debugging their
    // Wi-Fi instead of changing a dropdown.
    if (
      normalizedMessage.includes('no longer available') ||
      normalizedMessage.includes('not_found') ||
      (normalizedMessage.includes('404') && normalizedMessage.includes('model'))
    ) {
      return 'That Gemini model has been retired by Google. Open Settings and pick a current model.';
    }

    if (normalizedMessage.includes('network') || normalizedMessage.includes('fetch')) {
      return 'Network error. Please check your internet connection.';
    }

    if (normalizedMessage.includes('model')) {
      return 'AI model error. Please try a different model.';
    }

    return message ? `${fallbackPrefix}: ${message}` : fallbackPrefix;
  }

  async function analyzeForMeetingWithContext(contextInput = '') {
    const payload = typeof contextInput === 'object' && contextInput !== null
      ? contextInput
      : { contextString: String(contextInput || '') };

    const contextString = typeof payload.contextString === 'string' ? payload.contextString : '';
    const enabledScreenshotIds = Array.isArray(payload.enabledScreenshotIds) ? payload.enabledScreenshotIds : null;

    console.log('Starting context-aware analysis...');
    console.log('Context length:', contextString.length);
    console.log('API Keys configured:', geminiRuntime.getApiKeys().length);
    console.log('Model initialized:', !!(geminiRuntime.getService() && geminiRuntime.getService().model));
    console.log('Programming language preference:', geminiRuntime.getActiveProgrammingLanguage());
    console.log('Screenshots count:', screenshotManager.getScreenshotsCount());

    if (!geminiRuntime.hasApiKeys()) {
      sendToRenderer('analysis-result', {
        error: 'No Gemini API key configured. Add it in Settings.'
      });
      return;
    }

    if (!screenshotManager.hasScreenshots()) {
      sendToRenderer('analysis-result', {
        error: 'No screenshots to analyze. Take a screenshot first.'
      });
      return;
    }

    try {
      sendToRenderer('analysis-start');

      const { imageParts } = await screenshotManager.buildImagePartsFromScreenshots({
        strict: true,
        includeIds: enabledScreenshotIds
      });

      if (imageParts.length === 0) {
        sendToRenderer('analysis-result', {
          error: 'No enabled screenshots selected for analysis.'
        });
        return;
      }

      const onChunk = ({ text, index }) => {
        sendToRenderer('ai-stream-chunk', { actionId: 'screenAi', text, index });
      };
      sendToRenderer('ai-stream-start', { actionId: 'screenAi' });

      const text = await geminiRuntime.executeWithKeyFailover((geminiService) => {
        if (!geminiService || !geminiService.model) {
          throw new Error('AI model not initialized. Please check your API key.');
        }

        return geminiService.analyzeScreenshots(
          imageParts,
          '',
          { contextStringOverride: contextString, onChunk }
        );
      });

      chatContext.push({
        type: 'analysis',
        content: text,
        timestamp: new Date().toISOString(),
        screenshotCount: imageParts.length
      });

      sendToRenderer('ai-stream-end', { actionId: 'screenAi' });
      sendToRenderer('analysis-result', { text });
    } catch (error) {
      console.error('Analysis error details:', error);

      sendToRenderer('ai-stream-end', { actionId: 'screenAi' });
      sendToRenderer('analysis-result', {
        error: mapGeminiErrorMessage(error, 'Analysis failed')
      });
    }
  }

  async function analyzeForMeeting() {
    await analyzeForMeetingWithContext();
  }

  ipcMain.handle('get-screenshots-count', () => {
    return screenshotManager.getScreenshotsCount();
  });

  ipcMain.handle('get-window-bounds', () => {
    return windowController.getWindowBounds();
  });

  ipcMain.handle('set-window-bounds', (_event, nextBounds) => {
    return windowController.setWindowBounds(nextBounds);
  });

  ipcMain.handle('set-window-size-preset', (_event, payload = {}) => {
    const preset = typeof payload === 'number' ? payload : payload?.preset;
    return windowController.setWindowSizePreset(preset);
  });

  ipcMain.handle('toggle-stealth', () => {
    return windowController.toggleStealthMode();
  });

  ipcMain.handle('set-compact-mode', (_event, enabled) => {
    return windowController.setCompactMode(enabled);
  });

  ipcMain.handle('emergency-hide', () => {
    return windowController.emergencyHide();
  });

  ipcMain.handle('take-stealth-screenshot', async () => {
    return screenshotManager.takeStealthScreenshot();
  });

  ipcMain.handle('analyze-stealth', async () => {
    return analyzeForMeeting();
  });

  ipcMain.handle('analyze-stealth-with-context', async (_event, context) => {
    return analyzeForMeetingWithContext(context);
  });

  ipcMain.handle('ask-ai-with-session-context', async (_event, payload = {}) => {
    const mode = 'best-next-answer';
    const responseMode = resolveResponseModeId(payload?.responseMode);

    /*
     * Latency instrumentation, T0 (question detected in auto-answer.js)
     * through T6 (first chunk broadcast). T0 now arrives as
     * payload.questionT0 — auto-answer.js captures it the moment a question
     * is confirmed detected and carries it across the askBtn.click()
     * boundary via a bridge global (mirroring the existing
     * __synapseActiveQuestionId pattern), read once in
     * buildAskAiContextPayload(). Falls back to this handler's own
     * invocation time (the tracker's own default) for a manual Ask button /
     * ⌥⇧A press, which never goes through auto-answer.js and genuinely has
     * no earlier "detected" moment to report.
     */
    const questionT0 = typeof payload?.questionT0 === 'number' && payload.questionT0 > 0
      ? payload.questionT0
      : undefined;
    const latencyId = latencyTracker?.start({ mode, responseMode }, questionT0) ?? null;
    if (latencyId) latencyTracker.mark(latencyId, 'T2');

    // Stage timing reported by the service at the moment things actually
    // happen: T4 is the real dispatch to the provider (after prompt build and
    // any wait for a realtime slot), not the moment the call was made.
    const onTiming = (event) => {
      if (!latencyId) return;
      if (event.stage === 'dispatched') {
        // Last dispatch wins: after a retry or key failover, provider time is
        // measured on the attempt that actually answered.
        latencyTracker.mark(latencyId, 'T4', event.at, { overwrite: true });
        latencyTracker.note(latencyId, { model: event.model, thinking: event.thinking, attempts: event.attempt });
      } else if (event.stage === 'retry') {
        latencyTracker.addRetry(latencyId, event.delayMs, event.reason);
      } else if (event.stage === 'rate-limited') {
        latencyTracker.addRetry(latencyId, 0, 'rate-limited');
      }
    };

    try {
      assemblyAiService.flushAllSttHistoryBuffers('pre-ask-ai');

      if (!geminiRuntime.hasApiKeys()) {
        throw new Error('No Gemini API key configured. Add it in Settings.');
      }

      const transcriptContext = typeof payload?.transcriptContext === 'string'
        ? payload.transcriptContext.trim()
        : '';
      const sessionSummary = typeof payload?.sessionSummary === 'string'
        ? payload.sessionSummary.trim()
        : '';
      const contextString = typeof payload?.contextString === 'string'
        ? payload.contextString.trim()
        : '';
      const enabledScreenshotIds = Array.isArray(payload?.enabledScreenshotIds)
        ? payload.enabledScreenshotIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
        : null;
      // Phase 6: Phase 3's relation/confidence classification and the
      // explicit ACTIVE CONTEXT block built from it, computed renderer-side
      // (conversation-tracker.js) and carried across the process boundary as
      // plain strings, same trim-defensively pattern as the fields above.
      const activeContext = typeof payload?.activeContext === 'string'
        ? payload.activeContext.trim()
        : '';
      const relation = typeof payload?.relation === 'string' ? payload.relation.trim() : '';
      const confidence = typeof payload?.confidence === 'string' ? payload.confidence.trim() : '';

      if (!transcriptContext && !contextString && !screenshotManager.hasScreenshots()) {
        return {
          success: false,
          error: 'No transcript or screenshots available yet. Start transcription or capture a screenshot first.',
          mode,
          usedScreenshots: false
        };
      }

      let firstChunkSeen = false;
      const onChunk = ({ text, index }) => {
        if (!firstChunkSeen) {
          firstChunkSeen = true;
          if (latencyId) latencyTracker.mark(latencyId, 'T5'); // first Gemini token
        }
        sendToRenderer('ai-stream-chunk', { actionId: 'askAi', text, index });
        // Best available proxy for "browser rendered it": LAN broadcast is the
        // last point actually observable from the main process. True paint
        // time would need browser-side instrumentation, not built this pass.
        if (latencyId) latencyTracker.mark(latencyId, 'T6');
      };
      sendToRenderer('ai-stream-start', { actionId: 'askAi' });

      let usedScreenshots = false;
      let usedScreenshotCount = 0;
      let text = '';

      if (latencyId) latencyTracker.mark(latencyId, 'T3'); // context assembled (payload already trimmed above)

      if (screenshotManager.hasScreenshots()) {
        const { imageParts } = await screenshotManager.buildImagePartsFromScreenshots({
          strict: false,
          includeIds: enabledScreenshotIds
        });

        if (imageParts.length > 0) {
          usedScreenshots = true;
          usedScreenshotCount = imageParts.length;
          text = await geminiRuntime.executeWithKeyFailover((geminiService) => {
            if (!geminiService || !geminiService.model) {
              throw new Error('AI model not initialized. Please check your API key.');
            }

            return geminiService.askAiWithSessionContextAndScreenshots(imageParts, {
              contextString,
              transcriptContext,
              sessionSummary,
              activeContext,
              relation,
              confidence,
              screenshotCount: imageParts.length,
              responseMode,
              onChunk,
              onTiming,
              tag: 'askAi'
            });
          });
        }
      }

      if (!text) {
        text = await geminiRuntime.executeWithKeyFailover((geminiService) => {
          if (!geminiService || !geminiService.model) {
            throw new Error('AI model not initialized. Please check your API key.');
          }

          return geminiService.askAiWithSessionContext({
            contextString,
            transcriptContext,
            sessionSummary,
            activeContext,
            relation,
            confidence,
            screenshotCount: usedScreenshots ? usedScreenshotCount : 0,
            responseMode,
            onChunk,
            onTiming,
            tag: 'askAi'
          });
        });
      }

      chatContext.push({
        type: 'ask-ai',
        content: text,
        timestamp: new Date().toISOString(),
        screenshotCount: usedScreenshots ? usedScreenshotCount : 0
      });

      if (latencyId) latencyTracker.complete(latencyId);
      sendToRenderer('ai-stream-end', { actionId: 'askAi' });
      return { success: true, text, mode, responseMode, usedScreenshots };
    } catch (error) {
      // Deliberately interrupted via cancel-ask-ai below (the host updated/
      // extended the question while this was still generating) — not a
      // failure, so it must not log as an error, retry, or surface an error
      // toast. auto-answer.js is already mid-dispatch of the question that
      // caused this and will drain the queue the moment askBtn re-enables,
      // which returning here promptly is what actually unblocks.
      if (error?.isCancelled) {
        if (latencyId) latencyTracker.abandon(latencyId);
        sendToRenderer('ai-stream-end', { actionId: 'askAi' });
        return { success: false, cancelled: true, mode, usedScreenshots: false };
      }

      console.error('Error in ask-ai-with-session-context:', error);
      // A failed request never reached T5/T6 — completing it would report a
      // misleadingly huge "browser" segment covering the whole failure. Drop
      // the timeline instead of reporting a number that doesn't mean anything.
      if (latencyId) latencyTracker.abandon(latencyId);
      sendToRenderer('ai-stream-end', { actionId: 'askAi' });
      return {
        success: false,
        error: mapGeminiErrorMessage(error, 'Ask AI failed'),
        mode,
        usedScreenshots: false
      };
    }
  });

  /*
   * Interrupts the in-flight askAi request so a fast-follow question (the
   * interviewer extending or clarifying what they just asked while Synapse
   * is still mid-answer) doesn't sit queued behind a full answer to a
   * question that's already stale by the time its turn comes. Tag-scoped
   * to 'askAi' — the only path auto-answer.js drives — so a manual
   * screenshot analysis or suggest-response call in flight elsewhere is
   * never touched by this.
   */
  ipcMain.handle('get-response-modes', () => listResponseModes());

  ipcMain.handle('cancel-ask-ai', async () => {
    const cancelled = geminiRuntime.cancelActive('askAi');
    return { success: true, cancelled };
  });

  ipcMain.handle('clear-stealth', () => {
    chatContext = [];
    return screenshotManager.clearStealth();
  });

  ipcMain.handle('close-app', () => {
    setTimeout(() => {
      quitApplication();
    }, 0);

    return { success: true };
  });

  ipcMain.handle('add-voice-transcript', async (_event, transcript) => {
    const geminiService = geminiRuntime.getService();
    if (geminiService) {
      geminiService.addToHistory('user', transcript);
    }

    return { success: true };
  });

  ipcMain.handle('suggest-response', async (_event, context) => {
    try {
      assemblyAiService.flushAllSttHistoryBuffers('pre-suggest');
      if (!geminiRuntime.hasApiKeys()) {
        throw new Error('No Gemini API key configured. Add it in Settings.');
      }

      const payload = typeof context === 'object' && context !== null
        ? context
        : { context };
      const contextPrompt = typeof payload.context === 'string'
        ? payload.context
        : 'Current meeting conversation';
      const contextStringOverride = typeof payload.contextString === 'string'
        ? payload.contextString
        : '';

      const onChunk = ({ text, index }) => {
        sendToRenderer('ai-stream-chunk', { actionId: 'suggest', text, index });
      };
      sendToRenderer('ai-stream-start', { actionId: 'suggest' });

      const suggestions = await geminiRuntime.executeWithKeyFailover((geminiService) => {
        if (!geminiService || !geminiService.model) {
          throw new Error('Gemini service not initialized');
        }

        return geminiService.suggestResponse(contextPrompt, {
          contextString: contextStringOverride,
          onChunk
        });
      });

      sendToRenderer('ai-stream-end', { actionId: 'suggest' });
      return { success: true, suggestions };
    } catch (error) {
      console.error('Error generating suggestions:', error);
      sendToRenderer('ai-stream-end', { actionId: 'suggest' });
      return { success: false, error: mapGeminiErrorMessage(error, 'Failed to generate suggestions') };
    }
  });

  ipcMain.handle('generate-meeting-notes', async (_event, payload = {}) => {
    try {
      assemblyAiService.flushAllSttHistoryBuffers('pre-notes');
      if (!geminiRuntime.hasApiKeys()) {
        throw new Error('No Gemini API key configured. Add it in Settings.');
      }

      const contextStringOverride = typeof payload?.contextString === 'string'
        ? payload.contextString
        : '';

      const onChunk = ({ text, index }) => {
        sendToRenderer('ai-stream-chunk', { actionId: 'notes', text, index });
      };
      sendToRenderer('ai-stream-start', { actionId: 'notes' });

      const notes = await geminiRuntime.executeWithKeyFailover((geminiService) => {
        if (!geminiService || !geminiService.model) {
          throw new Error('Gemini service not initialized');
        }

        return geminiService.generateMeetingNotes({
          contextString: contextStringOverride,
          onChunk
        });
      });

      sendToRenderer('ai-stream-end', { actionId: 'notes' });
      return { success: true, notes };
    } catch (error) {
      console.error('Error generating meeting notes:', error);
      sendToRenderer('ai-stream-end', { actionId: 'notes' });
      return { success: false, error: mapGeminiErrorMessage(error, 'Failed to generate meeting notes') };
    }
  });

  ipcMain.handle('generate-follow-up-email', async () => {
    try {
      assemblyAiService.flushAllSttHistoryBuffers('pre-followup');
      if (!geminiRuntime.hasApiKeys()) {
        throw new Error('No Gemini API key configured. Add it in Settings.');
      }

      const email = await geminiRuntime.executeWithKeyFailover((geminiService) => {
        if (!geminiService || !geminiService.model) {
          throw new Error('Gemini service not initialized');
        }

        return geminiService.generateFollowUpEmail();
      });

      return { success: true, email };
    } catch (error) {
      console.error('Error generating email:', error);
      return { success: false, error: mapGeminiErrorMessage(error, 'Failed to generate follow-up email') };
    }
  });

  ipcMain.handle('answer-question', async (_event, question) => {
    try {
      assemblyAiService.flushAllSttHistoryBuffers('pre-answer');
      if (!geminiRuntime.hasApiKeys()) {
        throw new Error('No Gemini API key configured. Add it in Settings.');
      }

      const answer = await geminiRuntime.executeWithKeyFailover((geminiService) => {
        if (!geminiService || !geminiService.model) {
          throw new Error('Gemini service not initialized');
        }

        return geminiService.answerQuestion(question);
      });

      return { success: true, answer };
    } catch (error) {
      console.error('Error answering question:', error);
      return { success: false, error: mapGeminiErrorMessage(error, 'Failed to answer question') };
    }
  });

  ipcMain.handle('get-conversation-insights', async (_event, payload = {}) => {
    try {
      assemblyAiService.flushAllSttHistoryBuffers('pre-insights');
      if (!geminiRuntime.hasApiKeys()) {
        throw new Error('No Gemini API key configured. Add it in Settings.');
      }

      const contextStringOverride = typeof payload?.contextString === 'string'
        ? payload.contextString
        : '';

      const onChunk = ({ text, index }) => {
        sendToRenderer('ai-stream-chunk', { actionId: 'insights', text, index });
      };
      sendToRenderer('ai-stream-start', { actionId: 'insights' });

      const insights = await geminiRuntime.executeWithKeyFailover((geminiService) => {
        if (!geminiService || !geminiService.model) {
          throw new Error('Gemini service not initialized');
        }

        return geminiService.getConversationInsights({
          contextString: contextStringOverride,
          onChunk
        });
      });

      sendToRenderer('ai-stream-end', { actionId: 'insights' });
      return { success: true, insights };
    } catch (error) {
      console.error('Error getting insights:', error);
      sendToRenderer('ai-stream-end', { actionId: 'insights' });
      return { success: false, error: mapGeminiErrorMessage(error, 'Failed to get conversation insights') };
    }
  });

  ipcMain.handle('clear-conversation-history', async () => {
    const geminiService = geminiRuntime.getService();

    try {
      assemblyAiService.resetSttHistoryBuffers();
      if (geminiService) {
        geminiService.clearHistory();
      }

      chatContext = [];
      return { success: true };
    } catch (error) {
      console.error('Error clearing history:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-conversation-history', async () => {
    const geminiService = geminiRuntime.getService();

    try {
      if (!geminiService) {
        return { success: true, history: [] };
      }

      return { success: true, history: geminiService.conversationHistory };
    } catch (error) {
      console.error('Error getting history:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.on('report-question-queue', (event, payload) => {
    if (mobileServer && typeof mobileServer.broadcast === 'function') {
      mobileServer.broadcast('synapse-queue', payload);
    }
  });
}

module.exports = {
  registerAssistantIpc
};
