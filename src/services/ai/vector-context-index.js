'use strict';

/**
 * VectorContextIndex
 * In-memory vector store for ultra-fast (<5ms) Cosine Similarity retrieval of pre-loaded
 * Job Description (JD), Company background, and Role specifics.
 */
class VectorContextIndex {
  constructor() {
    this.documents = []; // Array of { id, text, vector }
  }

  /**
   * Load context text (e.g. Job Description, Company Info) and build index
   * @param {Array<{id: string, text: string}>} docs 
   */
  async indexDocuments(docs) {
    this.documents = [];
    for (const doc of docs) {
      if (!doc.text || !doc.text.trim()) continue;
      const vector = this.computeTFIDFVector(doc.text);
      this.documents.push({
        id: doc.id,
        text: doc.text.trim(),
        vector
      });
    }
    console.log(`[VectorContextIndex] Indexed ${this.documents.length} context documents into memory.`);
  }

  /**
   * Simple, sub-millisecond term frequency vector computation
   * @param {string} text 
   * @returns {Map<string, number>} Normalized term frequency map
   */
  computeTFIDFVector(text) {
    const words = text.toLowerCase().match(/\b\w{3,}\b/g) || [];
    const counts = new Map();
    for (const word of words) {
      counts.set(word, (counts.get(word) || 0) + 1);
    }
    // Normalize magnitude
    let sumSq = 0;
    for (const count of counts.values()) {
      sumSq += count * count;
    }
    const mag = Math.sqrt(sumSq) || 1;
    const normalized = new Map();
    for (const [w, c] of counts.entries()) {
      normalized.set(w, c / mag);
    }
    return normalized;
  }

  /**
   * Calculate Cosine Similarity between two term maps
   * @param {Map<string, number>} v1 
   * @param {Map<string, number>} v2 
   * @returns {number} Similarity score [0, 1]
   */
  cosineSimilarity(v1, v2) {
    let dot = 0;
    for (const [term, val] of v1.entries()) {
      if (v2.has(term)) {
        dot += val * v2.get(term);
      }
    }
    return dot;
  }

  /**
   * Retrieve top-K relevant text chunks matching a query in < 5ms
   * @param {string} query 
   * @param {number} topK 
   * @returns {Array<string>} Matching text snippets
   */
  search(query, topK = 2) {
    if (!query || this.documents.length === 0) return [];
    const startTime = Date.now();
    const queryVector = this.computeTFIDFVector(query);

    const scored = this.documents.map(doc => ({
      text: doc.text,
      score: this.cosineSimilarity(queryVector, doc.vector)
    }));

    scored.sort((a, b) => b.score - a.score);

    const results = scored.slice(0, topK).map(s => s.text);
    console.log(`[VectorContextIndex] Vector search completed in ${Date.now() - startTime}ms.`);
    return results;
  }
}

module.exports = VectorContextIndex;
