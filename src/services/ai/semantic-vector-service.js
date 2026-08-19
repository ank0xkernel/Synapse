'use strict';

/**
 * SemanticVectorService
 * Computes dense vector embeddings for Job Descriptions, Company Info, and Role details
 * and executes cosine similarity searches in < 2ms.
 */
class SemanticVectorService {
  constructor() {
    this.documents = []; // Array of { id, text, vector, norm }
    this.pipeline = null;
    this.isLoaded = false;
  }

  async initialize() {
    try {
      // Lazy load @xenova/transformers if available, else fallback to fast dense n-gram embedding
      const { pipeline } = require('@xenova/transformers');
      this.pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      this.isLoaded = true;
      console.log('[SemanticVectorService] Loaded ONNX/Core ML all-MiniLM-L6-v2 embedding pipeline.');
    } catch (err) {
      console.error('[SemanticVectorService] @xenova/transformers initialization failed! No semantic matching available.', err);
      throw err;
    }
  }

  /**
   * Compute normalized embedding array for input text
   * @param {string} text 
   * @returns {Promise<Float32Array>} 384-dimensional vector
   */
  async embed(text) {
    if (!text || !text.trim()) return new Float32Array(384);

    if (this.pipeline) {
      const output = await this.pipeline(text, { pooling: 'mean', normalize: true });
      return new Float32Array(output.data);
    }

    throw new Error('SemanticVectorService is not properly initialized. Cannot compute embeddings.');
  }

  /**
   * Index documents into memory
   * @param {Array<{id: string, text: string}>} docs 
   */
  async indexDocuments(docs) {
    this.documents = [];
    for (const doc of docs) {
      if (!doc.text || !doc.text.trim()) continue;
      const vector = await this.embed(doc.text);
      this.documents.push({
        id: doc.id,
        text: doc.text.trim(),
        vector
      });
    }
    console.log(`[SemanticVectorService] Indexed ${this.documents.length} dense document vectors into memory.`);
  }

  /**
   * Fast Dot Product for normalized vectors (equivalent to Cosine Similarity)
   */
  dotProduct(a, b) {
    let dot = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
    }
    return dot;
  }

  /**
   * Search top-K matching document text snippets in < 2ms
   * @param {string} query 
   * @param {number} topK 
   * @returns {Promise<Array<string>>} Top matching texts
   */
  async search(query, topK = 3) {
    if (!query || this.documents.length === 0) return [];
    const startTime = Date.now();
    const queryVector = await this.embed(query);

    const scored = this.documents.map(doc => ({
      text: doc.text,
      score: this.dotProduct(queryVector, doc.vector)
    }));

    scored.sort((a, b) => b.score - a.score);

    const results = scored.slice(0, topK).map(s => s.text);
    console.log(`[SemanticVectorService] Dense vector search completed in ${Date.now() - startTime}ms.`);
    return results;
  }

  /**
   * Same ranking as search(), but keeps the document id and similarity score.
   *
   * search() maps the results down to bare strings, which is fine when the text
   * is about to be pasted into a prompt but useless for showing the user where
   * something came from. Recall needs provenance: the point is to prove the
   * line is from your own resume or notes rather than something a model wrote.
   *
   * @param {string} query
   * @param {number} topK
   * @param {number} minScore drop weak matches instead of padding to topK
   * @returns {Promise<Array<{id: string, text: string, score: number}>>}
   */
  async searchWithSources(query, topK = 3, minScore = 0.05) {
    if (!query || this.documents.length === 0) return [];

    const startTime = Date.now();
    const queryVector = await this.embed(query);

    const scored = this.documents.map((doc) => ({
      id: doc.id,
      text: doc.text,
      score: this.dotProduct(queryVector, doc.vector)
    }));

    scored.sort((a, b) => b.score - a.score);

    // A padded-out list of near-zero matches reads as confident and is noise;
    // returning two good hits beats returning three where one is irrelevant.
    const results = scored.slice(0, topK).filter((s) => s.score >= minScore);

    console.log(
      `[SemanticVectorService] Recall search: ${results.length} hit(s) in ${Date.now() - startTime}ms.`
    );
    return results;
  }
}

module.exports = SemanticVectorService;
