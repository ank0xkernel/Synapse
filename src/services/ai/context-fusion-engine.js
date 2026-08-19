'use strict';

const SemanticVectorService = require('./semantic-vector-service');

/**
 * ContextFusionEngine
 * Deeply fuses PDF Resume accomplishments and JD requirements into dense 384-dim vector stores.
 * Dynamically retrieves top-3 matching resume bullets + top-3 JD points to ground AI responses
 * in the candidate's actual background.
 */
class ContextFusionEngine {
  constructor() {
    this.vectorService = new SemanticVectorService();
    this.resumeBullets = [];
    this.jdPoints = [];
  }

  async initialize() {
    await this.vectorService.initialize();
  }

  /**
   * Load and index candidate resume bullets and JD points
   * @param {Array<{id: string, text: string}>} resumeBullets 
   * @param {Array<{id: string, text: string}>} jdPoints 
   */
  async loadContext(resumeBullets = [], jdPoints = []) {
    this.resumeBullets = resumeBullets;
    this.jdPoints = jdPoints;

    const allDocs = [
      ...resumeBullets.map(r => ({ id: `resume_${r.id}`, text: `[RESUME ACHIEVEMENT]: ${r.text}` })),
      ...jdPoints.map(j => ({ id: `jd_${j.id}`, text: `[JD REQUIREMENT]: ${j.text}` }))
    ];

    await this.vectorService.indexDocuments(allDocs);
    console.log(`[ContextFusionEngine] Deep Fusion Index initialized with ${allDocs.length} total vectors.`);
  }

  /**
   * Retrieve top matched persona grounding context for an incoming question
   * @param {string} question 
   * @returns {Promise<{resumeMatches: Array<string>, jdMatches: Array<string>, fusionPromptBlock: string}>}
   */
  async getFusedContext(question) {
    if (!question) {
      return { resumeMatches: [], jdMatches: [], fusionPromptBlock: '' };
    }

    const matches = await this.vectorService.search(question, 6);
    const resumeMatches = matches.filter(m => m.includes('[RESUME ACHIEVEMENT]'));
    const jdMatches = matches.filter(m => m.includes('[JD REQUIREMENT]'));

    let fusionPromptBlock = '';
    if (resumeMatches.length > 0 || jdMatches.length > 0) {
      fusionPromptBlock = `[CANDIDATE PERSONA GROUNDING - ANSWER AS THIS PERSON]:\n` +
        `Specific Personal Experience:\n${resumeMatches.join('\n')}\n\n` +
        `Target Job Alignment:\n${jdMatches.join('\n')}\n\n`;
    }

    return {
      resumeMatches,
      jdMatches,
      fusionPromptBlock
    };
  }
}

module.exports = ContextFusionEngine;
