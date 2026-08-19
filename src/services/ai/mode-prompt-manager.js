'use strict';

/**
 * ModePromptManager
 * Handles interview mode selection (Coding, System Design, Behavioral)
 * and pre-compiled prompt template assembly (<1ms overhead).
 */
class ModePromptManager {
  constructor() {
    this.activeMode = 'auto'; // 'auto' | 'coding' | 'systemDesign' | 'behavioral'
    
    this.prompts = {
      coding: `You are a Principal Software Engineer solving a live coding challenge. Output ONLY clean, production-grade solution code with brief time/space complexity comments. Do not include markdown conversational preamble.`,
      systemDesign: `You are a Staff Systems Architect. Output a structured design with 4 headers: 1. Core Architecture 2. Data Flow & Storage 3. Scalability & Trade-offs 4. Diagram Specification. Be extremely concise and technical.`,
      behavioral: `You are an interview coach. Provide a natural, conversational response formatted in the STAR method (Situation, Task, Action, Result). Keep it punchy and ready to speak out loud.`
    };
  }

  setMode(mode) {
    if (['auto', 'coding', 'systemDesign', 'behavioral'].includes(mode)) {
      this.activeMode = mode;
      console.log(`[ModePromptManager] Active mode set to: ${this.activeMode}`);
    }
  }

  getMode() {
    return this.activeMode;
  }

  /**
   * Detect interview mode based on question text
   * @param {string} questionText 
   * @returns {'coding' | 'systemDesign' | 'behavioral'} Detected mode
   */
  detectMode(questionText = '') {
    if (this.activeMode !== 'auto') {
      return this.activeMode;
    }

    const q = questionText.toLowerCase();

    // Behavioral keywords
    if (/\b(tell me about a time|conflict|disagree|challenge|failure|project|leadership|describe a situation|weakness|strength)\b/.test(q)) {
      return 'behavioral';
    }

    // System Design keywords
    if (/\b(design|system|architecture|scale|database|microservice|load balancer|cache|sharding|pub\/sub|kafka|throughput|latency|replica|distributed)\b/.test(q)) {
      return 'systemDesign';
    }

    // Default to Coding mode
    return 'coding';
  }

  /**
   * Build complete prompt string with context injection
   * @param {'coding' | 'systemDesign' | 'behavioral'} mode 
   * @param {Array<string>} contextSnippets 
   * @param {Array<string>} templateSnippets 
   * @param {string} question 
   * @returns {string} Final prompt
   */
  buildPrompt(mode, contextSnippets = [], templateSnippets = [], question = '') {
    const systemPrompt = this.prompts[mode] || this.prompts.coding;
    
    let contextBlock = '';
    if (contextSnippets.length > 0) {
      contextBlock += `[JOB & COMPANY CONTEXT]:\n${contextSnippets.join('\n---\n')}\n\n`;
    }

    let templateBlock = '';
    if (templateSnippets.length > 0) {
      templateBlock += `[ALGORITHM TEMPLATES]:\n${templateSnippets.join('\n---\n')}\n\n`;
    }

    return `${systemPrompt}\n\n${contextBlock}${templateBlock}Interviewer Question: "${question}"\n\nAnswer:`;
  }
}

module.exports = ModePromptManager;
