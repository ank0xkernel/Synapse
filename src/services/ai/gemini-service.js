// ============================================================================
// GEMINI AI SERVICE - Invisibrain AI Assistant
// ============================================================================
// Two lanes:
//   realtime    live interview answers. Start immediately (bounded
//               concurrency), never wait behind background work, never wait
//               on the self-imposed rate window. A provider 429 is surfaced at
//               once so the runtime can fail over to another key.
//   background  screenshots, notes, insights, emails. Serialized and kept
//               inside the sliding rate window, with retry backoff.
// ============================================================================

const { GoogleGenerativeAI } = require('@google/generative-ai');
const {
  getDefaultGeminiModel,
  resolveGeminiModel,
  resolveProgrammingLanguage
} = require('../../config');
const {
  buildAnswerQuestionPrompt,
  buildAskAiSessionPrompt,
  buildFollowUpEmailPrompt,
  buildInsightsPrompt,
  buildMeetingNotesPrompt,
  buildScreenshotAnalysisPrompt,
  buildSuggestResponsePrompt
} = require('./prompts');
const { getResponseMode } = require('./response-modes');

class GeminiService {
  constructor(apiKey, options = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.modelName = resolveGeminiModel(options.modelName);
    this.programmingLanguage = resolveProgrammingLanguage(options.programmingLanguage);
    this.genAI = new GoogleGenerativeAI(this.apiKey);

    this.requestQueue = [];
    // Sliding-window rate limiting (see waitForRateLimit below) — replaces a
    // flat 6000ms minimum gap between EVERY request, which measured at
    // ~4.8s of pure artificial delay on the second of two questions asked
    // ~1.2s apart (a normal rapid-follow-up interview pace): the fixed
    // interval enforced 10 RPM by spacing every single request evenly,
    // even when the actual rolling-minute request count was nowhere near
    // the cap. This enforces the identical real constraint (never more than
    // maxRequestsPerWindow requests in any trailing rateLimitWindowMs) but
    // only waits when a burst has genuinely used up that budget.
    this.requestTimestamps = [];
    this.maxRequestsPerWindow = 10; // matches the free tier's 15 RPM with the same safety margin the old 10 RPM figure had
    this.rateLimitWindowMs = 60000;
    this.maxRetries = 3;
    this.isProcessing = false;

    // Realtime lane. Three concurrent answers covers an answer plus a
    // superseding follow-up plus a manual ask; beyond that a request waits
    // for a slot rather than piling onto the provider.
    this.maxRealtimeConcurrent = 3;
    this.realtimeInFlight = 0;
    this.realtimeWaiters = [];
    // Models that rejected thinkingConfig; requests to them omit it.
    this.thinkingUnsupportedModels = new Set();

    this.dailyTokenCount = 0;
    this.maxDailyTokens = 4000000;
    this.lastResetTime = Date.now();

    this.conversationHistory = [];
    this.maxHistoryLength = 20;

    // Cancellation — keyed by a caller-supplied tag (e.g. 'askAi') rather
    // than a request id, since the caller (ipc.js) knows which logical slot
    // it wants to interrupt but never sees an id until the promise already
    // resolves. Only meaningful for the one tag callers actually cancel
    // today; an untagged request is simply never cancellable.
    this.activeRequestsByTag = new Map();

    this._initializeModel();
  }

  isAbortError(error) {
    return error?.name === 'AbortError' || /aborted|abort error/i.test(String(error?.message || ''));
  }

  /**
   * Aborts the in-flight request registered under `tag`, if any. The
   * fetch-level abort stops local streaming (onChunk fires no further
   * chunks) even though, per the SDK's own docs, the server-side generation
   * may continue briefly — acceptable here since the goal is "stop showing
   * the user a stale answer," not billing precision.
   */
  cancel(tag) {
    const controller = this.activeRequestsByTag.get(tag);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  _initializeModel() {
    // Tuned for a live conversation rather than an essay: the answer has to
    // land while the question is still hanging in the air. Capping output is
    // what actually makes it feel fast — an uncapped model will happily spend
    // several seconds producing more than anyone can say out loud.
    const generationConfig = {
      temperature: 0.7,
      topP: 0.95,
      maxOutputTokens: 800
    };

    try {
      console.log('Initializing Gemini model:', this.modelName);
      this.model = this.genAI.getGenerativeModel({
        model: this.modelName,
        generationConfig
      });
    } catch (error) {
      const fallbackModel = getDefaultGeminiModel();
      console.warn(`Primary model failed, using fallback ${fallbackModel}:`, error);
      this.modelName = fallbackModel;
      this.model = this.genAI.getGenerativeModel({
        model: fallbackModel,
        generationConfig
      });
    }

    // Tracks how many times each question has been asked, so asking again
    // produces a genuinely different answer instead of the same paragraph.
    this._askCounts = this._askCounts || new Map();
  }

  /**
   * Recognises a repeated ask and returns an instruction that pushes the model
   * somewhere new.
   *
   * Asking twice almost always means "that answer did not work for me". Without
   * this the model is near-deterministic on an identical prompt and simply
   * restates itself, which reads like it is not listening.
   *
   * @param {string} question
   * @returns {string} prompt fragment, empty on the first ask
   */
  _repeatVariationInstruction(question) {
    const key = String(question || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);

    if (!key) {
      return '';
    }

    this._askCounts = this._askCounts || new Map();
    const seen = (this._askCounts.get(key) || 0) + 1;
    this._askCounts.set(key, seen);

    // Keep the map from growing across a long session.
    if (this._askCounts.size > 200) {
      this._askCounts.delete(this._askCounts.keys().next().value);
    }

    if (seen === 1) {
      return '';
    }

    const angles = [
      'Give a DIFFERENT answer from your previous one. Change the angle: lead with a different point, use a different example, and do not reuse the same opening sentence.',
      'This has now been asked several times, so the earlier answers clearly missed. Try a distinctly different approach — if you were abstract before, get concrete and specific; if you were long, be blunt.',
      'Previous answers were not useful. Give the shortest, most direct version you can, and open with the single most important point.'
    ];

    return `\n\n${angles[Math.min(seen - 2, angles.length - 1)]}\n`;
  }

  updateConfiguration(options = {}) {
    const previousProgrammingLanguage = this.programmingLanguage;
    const nextApiKey = String(options.apiKey ?? this.apiKey ?? '').trim();
    const nextModelName = resolveGeminiModel(options.modelName ?? this.modelName);
    const nextProgrammingLanguage = resolveProgrammingLanguage(
      options.programmingLanguage ?? this.programmingLanguage
    );

    const apiKeyChanged = nextApiKey !== this.apiKey;
    const modelChanged = nextModelName !== this.modelName;
    const programmingLanguageChanged = nextProgrammingLanguage !== previousProgrammingLanguage;

    if (apiKeyChanged) {
      this.apiKey = nextApiKey;
      this.genAI = new GoogleGenerativeAI(this.apiKey);
    }

    if (apiKeyChanged || modelChanged) {
      this.modelName = nextModelName;
      this._initializeModel();
    }

    this.programmingLanguage = nextProgrammingLanguage;

    return {
      apiKeyChanged,
      modelChanged,
      programmingLanguageChanged
    };
  }

  checkAndResetDailyLimit() {
    const now = Date.now();
    const dayInMs = 24 * 60 * 60 * 1000;

    if (now - this.lastResetTime >= dayInMs) {
      console.log('Resetting daily token count');
      this.dailyTokenCount = 0;
      this.lastResetTime = now;
    }
  }

  estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }

  isQuotaExhaustedError(error) {
    const message = String(error?.message || '').toLowerCase();

    return (
      message.includes('quota exceeded') ||
      message.includes('exceeded your current quota') ||
      message.includes('generate_content_free_tier_requests') ||
      message.includes('generaterequestsperdayperprojectpermodel') ||
      message.includes('perdayperprojectpermodel') ||
      message.includes('daily request limit')
    );
  }

  isAuthenticationError(error) {
    const message = String(error?.message || '').toLowerCase();

    return (
      message.includes('api key not valid') ||
      message.includes('invalid api key') ||
      message.includes('api_key_invalid') ||
      message.includes('401') ||
      message.includes('403') ||
      message.includes('permission denied') ||
      message.includes('permission_denied') ||
      message.includes('unauthorized') ||
      message.includes('forbidden')
    );
  }

  isRetryableError(error) {
    const message = String(error?.message || '');

    return (
      message.includes('429') ||
      message.includes('500') ||
      message.includes('503') ||
      message.includes('RATE_LIMIT')
    );
  }

  isRateLimitError(error) {
    const message = String(error?.message || '');
    return message.includes('429') || /RATE_LIMIT|RESOURCE_EXHAUSTED|resource has been exhausted/i.test(message);
  }

  /** A 400 caused by thinkingConfig on a model that does not support it. */
  isThinkingConfigError(error) {
    const message = String(error?.message || '');
    return message.includes('400') && /thinking/i.test(message);
  }

  /** Reads the provider's suggested retry delay ("retryDelay":"7s" / "retry in 7.2s"), in ms. */
  parseRetryAfterMs(error) {
    const message = String(error?.message || '');
    const match = /retryDelay"?\s*:?\s*"?(\d+(?:\.\d+)?)s/i.exec(message) || /retry in (\d+(?:\.\d+)?)\s*s/i.exec(message);
    return match ? Math.round(Number(match[1]) * 1000) : null;
  }

  /**
   * Per-request generation config. Gemini 3 models think at a high level by
   * default, which spends seconds before the first visible token and eats
   * into maxOutputTokens; a live answer needs a low level.
   */
  buildGenerationConfig({ maxOutputTokens = 800, thinkingLevel = 'low' } = {}) {
    const config = { temperature: 0.7, topP: 0.95, maxOutputTokens };
    if (thinkingLevel && /^gemini-3/.test(this.modelName) && !this.thinkingUnsupportedModels.has(this.modelName)) {
      config.thinkingConfig = { thinkingLevel };
    }
    return config;
  }

  /** Wraps the raw prompt/parts with a per-request generationConfig. */
  buildRequestPayload(request) {
    const parts = typeof request.data === 'string'
      ? [{ text: request.data }]
      : request.data.map((part) => (typeof part === 'string' ? { text: part } : part));
    return {
      contents: [{ role: 'user', parts }],
      generationConfig: this.buildGenerationConfig(request.generation || {})
    };
  }

  emitTiming(request, stage, extra = {}) {
    if (typeof request.onTiming !== 'function') return;
    try {
      request.onTiming({ stage, at: Date.now(), ...extra });
    } catch (_) {
      // Instrumentation must never break a request.
    }
  }

  async acquireRealtimeSlot() {
    if (this.realtimeInFlight < this.maxRealtimeConcurrent) {
      this.realtimeInFlight += 1;
      return;
    }
    await new Promise((resolve) => this.realtimeWaiters.push(resolve));
    this.realtimeInFlight += 1;
  }

  releaseRealtimeSlot() {
    this.realtimeInFlight -= 1;
    const next = this.realtimeWaiters.shift();
    if (next) next();
  }

  async runRealtime(request) {
    await this.acquireRealtimeSlot();
    try {
      // Counted in the window so background work sees the real request rate,
      // but a live answer never waits on it.
      this.requestTimestamps.push(Date.now());
      return await this._executeRequest(request);
    } finally {
      this.releaseRealtimeSlot();
    }
  }

  dispatch(request) {
    if (request.priority === 'realtime') {
      this.runRealtime(request).then(request.resolve, request.reject);
      return;
    }
    this.requestQueue.push(request);
    this.processQueue();
  }

  async waitForRateLimit() {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter((t) => now - t < this.rateLimitWindowMs);

    if (this.requestTimestamps.length >= this.maxRequestsPerWindow) {
      // At the cap: wait only long enough for the OLDEST request in the
      // window to age out, not a flat per-request gap. A burst of requests
      // spaced well apart never reaches this branch at all.
      const oldest = this.requestTimestamps[0];
      const waitTime = this.rateLimitWindowMs - (now - oldest);
      if (waitTime > 0) {
        console.log(`Rate limit: waiting ${waitTime}ms (${this.maxRequestsPerWindow} requests already in the last ${this.rateLimitWindowMs / 1000}s)`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
      const afterWait = Date.now();
      this.requestTimestamps = this.requestTimestamps.filter((t) => afterWait - t < this.rateLimitWindowMs);
    }

    this.requestTimestamps.push(Date.now());
  }

  async processQueue() {
    if (this.isProcessing || this.requestQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift();

      try {
        await this.waitForRateLimit();
        const result = await this._executeRequest(request);
        request.resolve(result);
      } catch (error) {
        request.reject(error);
      }
    }

    this.isProcessing = false;
  }

  async _executeRequest(request, retryCount = 0) {
    try {
      this.checkAndResetDailyLimit();

      const estimatedTokens = this.estimateTokens(JSON.stringify(request.data));
      if (this.dailyTokenCount + estimatedTokens > this.maxDailyTokens) {
        throw new Error('Daily token limit reached');
      }

      const requestOptions = request.controller ? { signal: request.controller.signal } : undefined;
      if (request.type !== 'text' && request.type !== 'multimodal') {
        throw new Error(`Unsupported Gemini request type: ${request.type}`);
      }
      const payload = this.buildRequestPayload(request);
      this.emitTiming(request, 'dispatched', { attempt: retryCount + 1, model: this.modelName, thinking: payload.generationConfig.thinkingConfig?.thinkingLevel || null });

      // Streaming path: use generateContentStream when onChunk callback is provided
      if (typeof request.onChunk === 'function') {
        console.log(`[Gemini API] Streaming ${request.type} request started (${request.priority || 'background'})`);
        const streamResult = await this.model.generateContentStream(payload, requestOptions);
        let fullText = '';
        let chunkIndex = 0;

        for await (const chunk of streamResult.stream) {
          const chunkText = chunk.text();
          if (chunkText) {
            fullText += chunkText;
            chunkIndex += 1;
            if (!request._firstChunkSent) {
              request._firstChunkSent = true;
              this.emitTiming(request, 'first-token');
            }
            request.onChunk({ text: chunkText, index: chunkIndex });
          }
        }

        this.dailyTokenCount += this.estimateTokens(fullText);
        console.log(`[Gemini API] Streaming ${request.type} request completed (${chunkIndex} chunks, ${fullText.length} chars)`);
        return fullText;
      }

      console.log(`[Gemini API] Non-streaming ${request.type} request started (${request.priority || 'background'})`);
      const result = await this.model.generateContent(payload, requestOptions);

      this.dailyTokenCount += estimatedTokens;

      const responseText = result.response.text();
      console.log(`[Gemini API] Non-streaming ${request.type} request completed (${responseText.length} chars)`);
      return responseText;
    } catch (error) {
      // A deliberate cancel() call, not a failure — the fetch-level abort
      // surfaces here as a rejected generateContent(Stream) call. Must be
      // checked before the quota/retry logic below: retrying an
      // intentionally-interrupted request would re-issue the exact stale
      // question the caller just asked to stop answering, and
      // isSwitchEligibleError (gemini-runtime.js) would otherwise have no
      // reason to treat "Request cancelled" as anything but a hard failure.
      if (this.isAbortError(error) || request.controller?.signal?.aborted) {
        console.log(`[Gemini API] ${request.type} request cancelled`);
        const cancelledError = new Error('Request cancelled');
        cancelledError.isCancelled = true;
        throw cancelledError;
      }

      console.error(`Request error (attempt ${retryCount + 1}):`, error.message);

      if (this.isQuotaExhaustedError(error)) {
        console.error('Quota-exhausted error detected. Skipping retries.');
        throw error;
      }

      // Skip retries if streaming chunks were already sent to avoid duplicate content
      if (request._firstChunkSent) {
        throw error;
      }

      // The model does not accept thinkingConfig: remember that and resend
      // immediately without it. Not counted as a retry.
      if (this.isThinkingConfigError(error) && !this.thinkingUnsupportedModels.has(this.modelName)) {
        console.warn(`[Gemini API] ${this.modelName} rejected thinkingConfig; continuing without it`);
        this.thinkingUnsupportedModels.add(this.modelName);
        return this._executeRequest(request, retryCount);
      }

      if (request.priority === 'realtime') {
        // A live answer must not sit through 2 s + 4 s + 8 s of backoff on a
        // rate-limited key. Surface it now; the runtime fails over to the next
        // key, or retries once after the provider's own suggested delay.
        if (this.isRateLimitError(error)) {
          error.isRateLimited = true;
          error.retryAfterMs = this.parseRetryAfterMs(error);
          this.emitTiming(request, 'rate-limited', { retryAfterMs: error.retryAfterMs });
          throw error;
        }
        // Transient server errors (500/503) get one quick retry.
        if (retryCount === 0 && this.isRetryableError(error)) {
          this.emitTiming(request, 'retry', { delayMs: 300, reason: 'server-error' });
          await new Promise((resolve) => setTimeout(resolve, 300));
          return this._executeRequest(request, retryCount + 1);
        }
        throw error;
      }

      if (retryCount < this.maxRetries) {
        const isRetryable = this.isRetryableError(error);

        if (isRetryable) {
          const backoffTime = Math.pow(2, retryCount) * 2000;
          console.log(`Retrying in ${backoffTime}ms...`);
          this.emitTiming(request, 'retry', { delayMs: backoffTime, reason: 'backoff' });
          await new Promise((resolve) => setTimeout(resolve, backoffTime));
          return this._executeRequest(request, retryCount + 1);
        }
      }

      throw error;
    }
  }

  addToHistory(role, content) {
    this.conversationHistory.push({ role, content });

    if (this.conversationHistory.length > this.maxHistoryLength) {
      this.conversationHistory = this.conversationHistory.slice(-this.maxHistoryLength);
    }
  }

  clearHistory() {
    this.conversationHistory = [];
  }

  getContextString() {
    return this.conversationHistory
      .map((entry) => `${entry.role}: ${entry.content}`)
      .join('\n\n');
  }

  async generateText(prompt, options = {}) {
    const tag = options.tag || null;
    const controller = tag ? new AbortController() : null;
    if (tag && controller) this.activeRequestsByTag.set(tag, controller);

    try {
      return await new Promise((resolve, reject) => {
        this.dispatch({
          type: 'text',
          data: prompt,
          resolve,
          reject,
          controller,
          priority: options.priority === 'realtime' ? 'realtime' : 'background',
          generation: options.generation,
          onTiming: options.onTiming,
          onChunk: typeof options.onChunk === 'function' ? options.onChunk : null
        });
      });
    } finally {
      // Only clear the slot if it's still ours — a second request under the
      // same tag (the very thing cancellation makes room for) may already
      // have registered its own controller by the time this one unwinds.
      if (tag && this.activeRequestsByTag.get(tag) === controller) {
        this.activeRequestsByTag.delete(tag);
      }
    }
  }

  async generateMultimodal(parts, options = {}) {
    const tag = options.tag || null;
    const controller = tag ? new AbortController() : null;
    if (tag && controller) this.activeRequestsByTag.set(tag, controller);

    try {
      return await new Promise((resolve, reject) => {
        this.dispatch({
          type: 'multimodal',
          data: parts,
          resolve,
          reject,
          controller,
          priority: options.priority === 'realtime' ? 'realtime' : 'background',
          generation: options.generation,
          onTiming: options.onTiming,
          onChunk: typeof options.onChunk === 'function' ? options.onChunk : null
        });
      });
    } finally {
      if (tag && this.activeRequestsByTag.get(tag) === controller) {
        this.activeRequestsByTag.delete(tag);
      }
    }
  }

  async analyzeScreenshots(imageParts, additionalContext = '', options = {}) {
    const contextString = typeof options.contextStringOverride === 'string'
      ? options.contextStringOverride
      : this.getContextString();
    const prompt = buildScreenshotAnalysisPrompt({
      contextString,
      additionalContext,
      programmingLanguage: this.programmingLanguage
    });

    const streamOptions = { onChunk: options.onChunk };
    const result = await this.generateMultimodal([
      { text: prompt },
      ...imageParts
    ], streamOptions);

    this.addToHistory('assistant', `Screenshot analysis: ${result}`);
    return result;
  }

  async analyzeScreenshot(imageBase64, additionalContext = '') {
    return this.analyzeScreenshots(
      [
        {
          inlineData: {
            mimeType: 'image/png',
            data: imageBase64
          }
        }
      ],
      additionalContext
    );
  }

  /** Live answers: realtime lane, generation limits from the response mode. */
  realtimeOptions(options = {}) {
    const mode = getResponseMode(options.responseMode);
    return {
      onChunk: options.onChunk,
      tag: options.tag,
      onTiming: options.onTiming,
      priority: 'realtime',
      generation: { maxOutputTokens: mode.maxOutputTokens, thinkingLevel: mode.thinkingLevel }
    };
  }

  async askAiWithSessionContext(options = {}) {
    const contextString = typeof options.contextString === 'string'
      ? options.contextString
      : this.getContextString();
    const prompt = buildAskAiSessionPrompt({
      contextString,
      transcriptContext: options.transcriptContext || '',
      sessionSummary: options.sessionSummary || '',
      activeContext: options.activeContext || '',
      relation: options.relation || '',
      confidence: options.confidence || '',
      screenshotCount: options.screenshotCount || 0,
      programmingLanguage: this.programmingLanguage,
      responseMode: options.responseMode
    }) + this._repeatVariationInstruction(contextString);

    const result = await this.generateText(prompt, this.realtimeOptions(options));
    this.addToHistory('assistant', `Ask AI: ${result}`);
    return result;
  }

  async askAiWithSessionContextAndScreenshots(imageParts, options = {}) {
    const contextString = typeof options.contextString === 'string'
      ? options.contextString
      : this.getContextString();
    const prompt = buildAskAiSessionPrompt({
      contextString,
      transcriptContext: options.transcriptContext || '',
      sessionSummary: options.sessionSummary || '',
      activeContext: options.activeContext || '',
      relation: options.relation || '',
      confidence: options.confidence || '',
      screenshotCount: options.screenshotCount || imageParts.length,
      programmingLanguage: this.programmingLanguage,
      responseMode: options.responseMode
    });

    const result = await this.generateMultimodal([
      { text: prompt },
      ...imageParts
    ], this.realtimeOptions(options));

    this.addToHistory('assistant', `Ask AI: ${result}`);
    return result;
  }

  async suggestResponse(context, options = {}) {
    const contextString = typeof options.contextString === 'string'
      ? options.contextString
      : this.getContextString();
    const prompt = buildSuggestResponsePrompt({
      contextString,
      context
    });

    const streamOptions = { onChunk: options.onChunk };
    return this.generateText(prompt, streamOptions);
  }

  async generateMeetingNotes(options = {}) {
    const contextString = typeof options.contextString === 'string'
      ? options.contextString
      : this.getContextString();
    if (!contextString.trim()) {
      return 'No conversation history to summarize.';
    }
    const prompt = buildMeetingNotesPrompt({ contextString });
    const streamOptions = { onChunk: options.onChunk };
    return this.generateText(prompt, streamOptions);
  }

  async generateFollowUpEmail(options = {}) {
    if (this.conversationHistory.length === 0) {
      return 'No conversation history to create email from.';
    }

    const contextString = this.getContextString();
    const prompt = buildFollowUpEmailPrompt({ contextString });
    const streamOptions = { onChunk: options.onChunk };
    return this.generateText(prompt, streamOptions);
  }

  async answerQuestion(question, options = {}) {
    const contextString = this.getContextString();
    const prompt = buildAnswerQuestionPrompt({
      contextString,
      question,
      programmingLanguage: this.programmingLanguage
    });

    const result = await this.generateText(prompt, this.realtimeOptions(options));
    this.addToHistory('user', question);
    this.addToHistory('assistant', result);
    return result;
  }

  async getConversationInsights(options = {}) {
    const contextString = typeof options.contextString === 'string'
      ? options.contextString
      : this.getContextString();
    if (!contextString.trim()) {
      return 'Not enough conversation data for insights.';
    }
    const prompt = buildInsightsPrompt({ contextString });
    const streamOptions = { onChunk: options.onChunk };
    return this.generateText(prompt, streamOptions);
  }
}

module.exports = GeminiService;
