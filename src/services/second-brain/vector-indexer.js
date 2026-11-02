'use strict';

/**
 * Dense Semantic Vector Indexer
 *
 * Provides conceptual semantic vector retrieval with cosine similarity.
 * Uses a deterministic dense embedding algorithm (128-dim subword & character
 * n-gram feature hashing with L2 unit normalization) for fast, zero-dependency,
 * private local execution on any Mac.
 */

class VectorIndexer {
  constructor(dim = 128) {
    this.dim = dim;
    this.vectors = new Map(); // chunkId -> { chunk, vector }
  }

  clear() {
    this.vectors.clear();
  }

  // Generate a deterministic dense float vector for text
  embed(text) {
    if (!text || typeof text !== 'string') return new Float32Array(this.dim);

    const vec = new Float32Array(this.dim);
    const cleaned = text.toLowerCase().replace(/[^a-z0-9_]/g, ' ');
    const words = cleaned.split(/\s+/).filter((w) => w.length > 1);

    // Feature 1: Word hashing
    for (const w of words) {
      const h = this.hashString(w);
      const idx = Math.abs(h) % this.dim;
      vec[idx] += 1.0;
    }

    // Feature 2: Character 3-gram hashing for subword conceptual similarity
    const compact = cleaned.replace(/\s+/g, ' ');
    for (let i = 0; i <= compact.length - 3; i++) {
      const tri = compact.slice(i, i + 3);
      const h = this.hashString(tri);
      const idx = Math.abs(h * 31) % this.dim;
      vec[idx] += 0.35;
    }

    // L2 Normalize
    let norm = 0;
    for (let i = 0; i < this.dim; i++) {
      norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dim; i++) {
        vec[i] /= norm;
      }
    }

    return vec;
  }

  hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }

  addChunk(chunk) {
    if (!chunk || !chunk.id) return;
    const textToEmbed = `${chunk.filePath} ${chunk.summary || ''} ${chunk.symbols ? chunk.symbols.join(' ') : ''}\n${chunk.text}`;
    const vector = this.embed(textToEmbed);
    this.vectors.set(chunk.id, {
      chunk,
      vector
    });
  }

  search(query, options = {}) {
    if (!query || typeof query !== 'string') return [];
    if (this.vectors.size === 0) return [];

    const queryVec = this.embed(query);
    const projectIdFilter = options.projectId || null;
    const results = [];

    for (const [chunkId, { chunk, vector }] of this.vectors.entries()) {
      if (projectIdFilter && chunk.projectId !== projectIdFilter) continue;

      // Cosine similarity = dot product of unit-normalized vectors
      let dot = 0;
      for (let i = 0; i < this.dim; i++) {
        dot += queryVec[i] * vector[i];
      }

      if (dot > 0.05) {
        results.push({
          chunk,
          score: dot,
          retrievalType: 'vector'
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    const limit = options.limit || 10;
    return results.slice(0, limit);
  }

  exportData() {
    return {
      dim: this.dim,
      entries: Array.from(this.vectors.values()).map(({ chunk, vector }) => ({
        chunk,
        vector: Array.from(vector)
      }))
    };
  }

  importData(data) {
    this.clear();
    if (data && Array.isArray(data.entries)) {
      for (const entry of data.entries) {
        this.vectors.set(entry.chunk.id, {
          chunk: entry.chunk,
          vector: new Float32Array(entry.vector)
        });
      }
    }
  }
}

module.exports = {
  VectorIndexer
};

