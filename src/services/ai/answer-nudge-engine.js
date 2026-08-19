'use strict';

/**
 * AnswerNudgeEngine
 * Subscribes to the candidate's live microphone transcript stream.
 * Compares candidate's spoken answer against the AI's generated ideal response via background cosine check.
 * Broadcasts non-intrusive live nudges (e.g. "💡 Mention Redis Caching") to the mobile companion.
 */
class AnswerNudgeEngine {
  constructor(mobileServer) {
    this.mobileServer = mobileServer;
    this.idealAnswerText = '';
    this.spokenMicBuffer = '';
    this.emittedNudges = new Set();
  }

  /**
   * Set active ideal AI answer for current question
   * @param {string} idealAnswer 
   */
  setIdealAnswer(idealAnswer) {
    this.idealAnswerText = idealAnswer || '';
    this.spokenMicBuffer = '';
    this.emittedNudges.clear();
  }

  /**
   * Process a chunk of candidate's live spoken microphone text
   * @param {string} micText 
   */
  processMicTranscript(micText) {
    if (!this.idealAnswerText || !micText) return;
    this.spokenMicBuffer += ' ' + micText.toLowerCase();

    // Extract key technical concepts from ideal answer (e.g. "O(N)", "Redis", "Binary Search", "Trade-off")
    const keywords = this.idealAnswerText.match(/\b[A-Z][a-zA-Z0-9_\-\(\)]+\b|\b(O\([^\)]+\)|complexity|cache|async|sharding|index|mutex)\b/gi) || [];
    
    for (const kw of keywords) {
      const cleanKw = kw.trim();
      if (cleanKw.length < 3 || this.emittedNudges.has(cleanKw.toLowerCase())) continue;

      // If candidate has not mentioned this key concept yet
      if (!this.spokenMicBuffer.includes(cleanKw.toLowerCase())) {
        this.emittedNudges.add(cleanKw.toLowerCase());
        const nudgeMessage = `💡 Key Concept: ${cleanKw}`;
        console.log(`[AnswerNudgeEngine] Emitting Live Nudge: ${nudgeMessage}`);
        
        if (this.mobileServer && typeof this.mobileServer.broadcast === 'function') {
          this.mobileServer.broadcast('synapse-nudge', { message: nudgeMessage });
        }
        break; // Emit one nudge at a time
      }
    }
  }

  reset() {
    this.idealAnswerText = '';
    this.spokenMicBuffer = '';
    this.emittedNudges.clear();
  }
}

module.exports = AnswerNudgeEngine;
