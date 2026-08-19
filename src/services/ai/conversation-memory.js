'use strict';

/**
 * ConversationMemory
 * Maintains a compressed thread memory of previous questions, ideal answers,
 * and candidate spoken responses across the interview session.
 * Detects follow-up questions and links context automatically.
 */
class ConversationMemory {
  constructor(maxTurns = 5) {
    this.maxTurns = maxTurns;
    this.history = []; // Array of { question, answer, timestamp }
  }

  /**
   * Add a completed turn to history
   * @param {string} question 
   * @param {string} answer 
   */
  addTurn(question, answer) {
    if (!question || !answer) return;
    this.history.push({
      question: question.trim(),
      answer: answer.trim(),
      timestamp: Date.now()
    });

    if (this.history.length > this.maxTurns) {
      this.history.shift(); // Maintain rolling max turns
    }
  }

  /**
   * Check if an incoming question is a follow-up to prior turn
   * @param {string} question 
   * @returns {boolean}
   */
  isFollowUp(question) {
    if (this.history.length === 0) return false;
    const q = question.toLowerCase();
    return /\b(elaborate|why|how about|what if|can you|explain that|why did you|that algorithm|that choice|instead of)\b/.test(q);
  }

  /**
   * Build rolling history context snippet for prompt assembly
   * @returns {string} History block
   */
  getHistoryContextSnippet() {
    if (this.history.length === 0) return '';
    const recent = this.history.slice(-2); // Last 2 turns
    const text = recent.map((t, idx) => `Q${idx+1}: "${t.question}"\nA${idx+1}: "${t.answer.substring(0, 150)}..."`).join('\n');
    return `[RECENT INTERVIEW THREAD CONTEXT]:\n${text}\n\n`;
  }

  clear() {
    this.history = [];
  }
}

module.exports = ConversationMemory;
