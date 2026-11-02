'use strict';

/**
 * BM25 Inverted Index
 *
 * Implements standard Okapi BM25 ranking (k1=1.5, b=0.75) for fast,
 * deterministic keyword, technology, symbol, and filename retrieval.
 */

class BM25Indexer {
  constructor(k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.invertedIndex = new Map(); // term -> Array<{ chunkId, freq }>
    this.documents = new Map();     // chunkId -> { chunk, termsCount }
    this.avgDocLength = 0;
  }

  clear() {
    this.invertedIndex.clear();
    this.documents.clear();
    this.avgDocLength = 0;
  }

  tokenize(text) {
    if (!text || typeof text !== 'string') return [];
    // Split on punctuation/spaces, and split camelCase identifiers
    const rawTokens = text
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[^a-z0-9_.\-#/]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2);
    return rawTokens;
  }

  addChunk(chunk) {
    if (!chunk || !chunk.id) return;

    // Searchable text combines file path, symbols, summary, and chunk code
    const searchable = `${chunk.filePath} ${chunk.symbols ? chunk.symbols.join(' ') : ''} ${chunk.summary || ''} ${chunk.text}`;
    const tokens = this.tokenize(searchable);
    const docLength = tokens.length;

    const termFreqs = new Map();
    for (const token of tokens) {
      termFreqs.set(token, (termFreqs.get(token) || 0) + 1);
    }

    for (const [term, freq] of termFreqs.entries()) {
      if (!this.invertedIndex.has(term)) {
        this.invertedIndex.set(term, []);
      }
      this.invertedIndex.get(term).push({ chunkId: chunk.id, freq });
    }

    this.documents.set(chunk.id, {
      chunk,
      termsCount: docLength
    });

    this.recomputeAvgLength();
  }

  recomputeAvgLength() {
    const totalDocs = this.documents.size;
    if (totalDocs === 0) {
      this.avgDocLength = 0;
      return;
    }
    let totalLen = 0;
    for (const doc of this.documents.values()) {
      totalLen += doc.termsCount;
    }
    this.avgDocLength = totalLen / totalDocs;
  }

  search(query, options = {}) {
    if (!query || typeof query !== 'string') return [];
    const queryTerms = [...new Set(this.tokenize(query))];
    if (queryTerms.length === 0) return [];

    const totalDocs = this.documents.size;
    if (totalDocs === 0) return [];

    const projectIdFilter = options.projectId || null;
    const scores = new Map();

    for (const term of queryTerms) {
      const postings = this.invertedIndex.get(term);
      if (!postings) continue;

      const df = postings.length;
      // Standard BM25 IDF
      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));

      for (const { chunkId, freq } of postings) {
        const docEntry = this.documents.get(chunkId);
        if (!docEntry) continue;
        if (projectIdFilter && docEntry.chunk.projectId !== projectIdFilter) continue;

        const docLen = docEntry.termsCount;
        const denominator = freq + this.k1 * (1 - this.b + (this.b * docLen) / (this.avgDocLength || 1));
        const score = idf * ((freq * (this.k1 + 1)) / denominator);

        scores.set(chunkId, (scores.get(chunkId) || 0) + score);
      }
    }

    const results = [];
    for (const [chunkId, score] of scores.entries()) {
      if (score <= 0) continue;
      const docEntry = this.documents.get(chunkId);
      results.push({
        chunk: docEntry.chunk,
        score,
        retrievalType: 'bm25'
      });
    }

    results.sort((a, b) => b.score - a.score);
    const limit = options.limit || 10;
    return results.slice(0, limit);
  }

  exportData() {
    return {
      documents: Array.from(this.documents.values()).map((d) => d.chunk)
    };
  }

  importData(data) {
    this.clear();
    if (data && Array.isArray(data.documents)) {
      for (const chunk of data.documents) {
        this.addChunk(chunk);
      }
    }
  }
}

module.exports = {
  BM25Indexer
};

