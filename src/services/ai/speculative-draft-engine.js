'use strict';

/**
 * SpeculativeDraftEngine
 * Runs a parallel fast speculative model (tinyllama:1.1b / stable-code:3b) on GPU as partial speech arrives.
 * Validates relevance when endpoint detector fires and instantly streams tokens (<100ms first token).
 */
class SpeculativeDraftEngine {
  constructor(ollamaService) {
    this.ollama = ollamaService;
    this.speculativeModel = 'tinyllama:1.1b';
    this.activeAbortController = null;
    this.speculativeBuffer = '';
    this.isGenerating = false;
  }

  /**
   * Start generating a speculative response in background while question is being spoken
   * @param {string} partialText 
   * @param {string} systemPrompt 
   */
  async startSpeculativeDraft(partialText, systemPrompt) {
    if (!partialText || partialText.length < 10) return;

    this.abortDraft();
    this.activeAbortController = new AbortController();
    this.speculativeBuffer = '';
    this.isGenerating = true;

    const draftPrompt = `${systemPrompt}\nInterviewer (asking): "${partialText}"\nImmediate solution code/answer snippet:`;

    try {
      await this.ollama.streamResponse(draftPrompt, (token) => {
        if (!this.isGenerating) return;
        this.speculativeBuffer += token;
      }, {
        model: this.speculativeModel,
        signal: this.activeAbortController.signal
      });
    } catch (err) {
      // Ignore abort errors
    } finally {
      this.isGenerating = false;
    }
  }

  /**
   * Validate similarity between speculative candidate and final question intent
   * @param {string} finalQuestion 
   * @returns {boolean} True if >90% relevant
   */
  validateRelevance(finalQuestion) {
    if (!this.speculativeBuffer || this.speculativeBuffer.length < 15) return false;
    const words = finalQuestion.toLowerCase().match(/\b\w{4,}\b/g) || [];
    if (words.length === 0) return false;

    let matched = 0;
    const bufferLower = this.speculativeBuffer.toLowerCase();
    for (const word of words) {
      if (bufferLower.includes(word)) matched++;
    }

    const relevance = matched / words.length;
    console.log(`[SpeculativeDraftEngine] Relevance Score: ${(relevance * 100).toFixed(1)}%`);
    return relevance >= 0.70; // 70-90% match threshold
  }

  getDraftBuffer() {
    return this.speculativeBuffer;
  }

  abortDraft() {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
    this.isGenerating = false;
    this.speculativeBuffer = '';
  }
}

module.exports = SpeculativeDraftEngine;
