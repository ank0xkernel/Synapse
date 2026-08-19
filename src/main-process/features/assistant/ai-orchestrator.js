'use strict';

const OllamaMetalService = require('../../../services/ai/ollama-metal-service');
const ModePromptManager = require('../../../services/ai/mode-prompt-manager');
const TemplateCache = require('../../../services/ai/template-cache');
const TextInserter = require('../simulator/text-inserter');
const ContextFusionEngine = require('../../../services/ai/context-fusion-engine');
const SpeculativeDraftEngine = require('../../../services/ai/speculative-draft-engine');
const AnswerNudgeEngine = require('../../../services/ai/answer-nudge-engine');
const ConversationMemory = require('../../../services/ai/conversation-memory');

class AiOrchestrator {
  constructor(options = {}) {
    this.ollamaService = new OllamaMetalService(options.ollamaOptions);
    this.modeManager = new ModePromptManager();
    this.fusionEngine = new ContextFusionEngine();
    this.templateCache = new TemplateCache(this.fusionEngine.vectorService);
    this.textInserter = new TextInserter();
    this.speculativeEngine = new SpeculativeDraftEngine(this.ollamaService);
    this.mobileServer = options.mobileServer || null;
    this.nudgeEngine = new AnswerNudgeEngine(this.mobileServer);
    this.memory = new ConversationMemory(5);
    this.lastAnswerText = '';

    // processQuestion() below is Ollama-only — it always was, the class was
    // just never given a way to know that wasn't the active provider. That
    // silence is what let it 404 against a wrong model on every question
    // under a Gemini config (default model here is codeqwen:7b-chat-v1.5-
    // q4_K_M; nothing enforces that it matches what's actually pulled).
    // getActiveAiProvider is the same source of truth start-application.js
    // uses everywhere else, so this can never disagree with the real setting.
    this.getActiveAiProvider = typeof options.getActiveAiProvider === 'function'
      ? options.getActiveAiProvider
      : () => 'ollama';
  }

  async initialize() {
    console.log('[AiOrchestrator] Initializing OllamaMetalService...');
    await this.ollamaService.initialize();
    
    // Stagger fusion engine initialization to prevent CPU spike
    await new Promise(res => setTimeout(res, 1500));
    console.log('[AiOrchestrator] Initializing ContextFusionEngine...');
    await this.fusionEngine.initialize();
    
    // Stagger template cache initialization
    await new Promise(res => setTimeout(res, 1500));
    console.log('[AiOrchestrator] Initializing TemplateCache...');
    await this.templateCache.initialize();
  }

  setMobileServer(mobileServer) {
    this.mobileServer = mobileServer;
    this.nudgeEngine.mobileServer = mobileServer;
  }

  setInterviewMode(mode) {
    this.modeManager.setMode(mode);
  }

  /** Insertion pace for "send to editor", 1-10. Driven by the mobile companion. */
  setTypingSpeed(level) {
    return this.textInserter.setSpeed(level);
  }

  getTypingSpeed() {
    return this.textInserter.getSpeed();
  }

  /**
   * Load Resume bullets and JD requirements into Deep Fusion Engine
   * @param {Array<{id: string, text: string}>} resumeBullets 
   * @param {Array<{id: string, text: string}>} jdPoints 
   */
  async loadResumeAndJdContext(resumeBullets = [], jdPoints = []) {
    await this.fusionEngine.loadContext(resumeBullets, jdPoints);
  }

  /** User-initiated only: sends the last answer to the focused editor. */
  sendLastAnswerToEditor() {
    if (!this.lastAnswerText) {
      console.log('[AiOrchestrator] No answer available to insert yet.');
      return Promise.resolve({ method: 'skipped', chars: 0 });
    }

    console.log('[AiOrchestrator] Sending last answer to the focused editor...');
    return this.textInserter.insertText(this.lastAnswerText);
  }

  processMicTranscript(text) {
    if (this.nudgeEngine) {
      this.nudgeEngine.processMicTranscript(text);
    }
  }

  async processPartialQuestion(partialText) {
    if (partialText && partialText.length > 15) {
      const mode = this.modeManager.detectMode(partialText);
      const fused = await this.fusionEngine.getFusedContext(partialText);
      const prompt = this.modeManager.buildPrompt(mode, [fused.fusionPromptBlock], [], partialText);
      this.speculativeEngine.startSpeculativeDraft(partialText, prompt);
    }
  }

  /**
   * Process a finalized user question, apply persona grounding, stream or use speculative tokens
   * @param {string} question 
   * @param {function(string): void} onToken 
   */
  async processQuestion(question, onToken) {
    if (!question || !question.trim()) return;

    // Single-authoritative-path guard. This method only ever talks to
    // Ollama — it has no Gemini branch — so if Gemini is the configured
    // provider this call is a misroute, not a request to actually answer
    // with. Refusing loudly beats what happened before: a live Gemini
    // config silently hit Ollama's default model name, which was not even
    // the model installed on this machine, and returned HTTP 404 on every
    // single question with nothing in the UI explaining why.
    const activeProvider = this.getActiveAiProvider();
    if (activeProvider !== 'ollama') {
      const message = `AiOrchestrator.processQuestion() is Ollama-only but the active provider is "${activeProvider}". `
        + 'Refusing rather than silently misrouting — use the Gemini Ask AI path (askAiWithSessionContext) instead.';
      console.error(`[AiOrchestrator] ${message}`);
      if (this.mobileServer) {
        this.mobileServer.broadcastError(message);
      }
      return;
    }

    console.log(`[AiOrchestrator] Processing Question: "${question}"`);

    // Check Speculative Draft Relevance
    if (this.speculativeEngine.validateRelevance(question)) {
      console.log('[AiOrchestrator] Speculative Draft Hit! Streaming pre-generated tokens (<100ms first token)...');
      const draft = this.speculativeEngine.getDraftBuffer();
      if (this.mobileServer) {
        this.mobileServer.broadcastHapticAlert();
        this.mobileServer.broadcastToken(draft);
        this.mobileServer.broadcastComplete();
      }
      this.lastAnswerText = draft;
      this.nudgeEngine.setIdealAnswer(draft);
      this.memory.addTurn(question, draft);
      return;
    }

    this.speculativeEngine.abortDraft();

    // 1. Detect Mode & Check Follow-up
    const mode = this.modeManager.detectMode(question);
    const isFollowUp = this.memory.isFollowUp(question);
    const historyBlock = this.memory.getHistoryContextSnippet();

    console.log(`[AiOrchestrator] Detected Mode: ${mode.toUpperCase()} (Follow-up: ${isFollowUp})`);

    if (this.mobileServer && typeof this.mobileServer.broadcast === 'function') {
      this.mobileServer.broadcast('synapse-mode', { mode, isFollowUp });
    }

    // 2. Persona Deep Fusion & Template Lookup (<2ms)
    const fused = await this.fusionEngine.getFusedContext(question);
    const templateSnippets = await this.templateCache.findMatchingTemplates(question, 1);

    // 3. Zero-Copy Prompt Assembly
    const fullPrompt = `${historyBlock}${this.modeManager.buildPrompt(mode, [fused.fusionPromptBlock], templateSnippets, question)}`;

    // 4. Stream Tokens
    let isFirstToken = true;
    this.lastAnswerText = '';

    try {
      await this.ollamaService.streamResponse(fullPrompt, (token) => {
        if (isFirstToken) {
          isFirstToken = false;
          console.log('[AiOrchestrator] First LLM token generated!');
          if (this.mobileServer) {
            this.mobileServer.broadcastHapticAlert();
          }
        }

        this.lastAnswerText += token;
        if (onToken) onToken(token);
        if (this.mobileServer) {
          this.mobileServer.broadcastToken(token);
        }
      });

      this.nudgeEngine.setIdealAnswer(this.lastAnswerText);
      this.memory.addTurn(question, this.lastAnswerText);

      if (this.mobileServer) {
        this.mobileServer.broadcastComplete();
        this.mobileServer.broadcast('history', { items: this.memory.history });
      }
    } catch (error) {
      console.error('[AiOrchestrator] Error during LLM generation:', error.message);
      if (this.mobileServer) {
        this.mobileServer.broadcastError(error.message);
      }
    }
  }
}

module.exports = AiOrchestrator;
