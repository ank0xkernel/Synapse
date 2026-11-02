'use strict';

const path = require('path');
const { SECOND_BRAIN_CONFIG } = require('./config');
const { knowledgeGraph, VERIFICATION_LEVELS } = require('./knowledge-graph');
const { resumeMapper } = require('./resume-mapper');

/**
 * Hybrid Retriever
 *
 * Combines BM25 keyword matching, dense vector cosine similarity,
 * knowledge graph relationship expansion, and reciprocal rank fusion (RRF)
 * into a low-latency, compact evidence block.
 */

class HybridRetriever {
  constructor(bm25Indexer, vectorIndexer) {
    this.bm25Indexer = bm25Indexer;
    this.vectorIndexer = vectorIndexer;
  }

  detectProjectTarget(query) {
    const q = String(query || '').toLowerCase();

    if (q.includes('jumpstart go') || (q.includes('jumpstart') && (q.includes('pickup') || q.includes('dropoff') || q.includes('voice') || q.includes('announcement') || q.includes('gate') || q.includes('pwa')))) {
      return 'jumpstart_go';
    }
    if (q.includes('jumpstart inventory') || q.includes('inventory os') || (q.includes('jumpstart') && q.includes('inventory'))) {
      return 'jumpstart_inventory';
    }
    if (q.includes('novaris')) {
      return 'novaris';
    }
    if (q.includes('evox') || q.includes('evox ventures')) {
      return 'evox_ventures';
    }
    if (q.includes('shuttle') || q.includes('shuttle tracker') || q.includes('bus tracking')) {
      return 'shuttle_tracker';
    }
    if (q.includes('gems lord') || q.includes('gemslord')) {
      return 'gems_lord';
    }
    if (q.includes('chhota vyapar') || q.includes('chotavyapar')) {
      return 'chhota_vyapar';
    }
    if (q.includes('manisha wires') || q.includes('manisha wire') || q.includes('mwpl')) {
      return 'manisha_wires';
    }
    if (q.includes('campusconnect') || q.includes('campus connect')) {
      return 'campus_connect';
    }
    if (q.includes('kundli') || q.includes('astrology') || q.includes('vedic') || q.includes('vimshottari') || q.includes('ashtakavarga')) {
      return 'astrology_engine';
    }
    if (q.includes('synapse') || q.includes('second brain') || q.includes('coreaudio') || q.includes('invisibrain')) {
      return 'synapse';
    }

    return null;
  }

  retrieve(query, options = {}) {
    if (!query || typeof query !== 'string') return [];

    const targetProject = options.projectId || this.detectProjectTarget(query);
    const limit = options.limit || SECOND_BRAIN_CONFIG.retrievalMaxSnippets;

    // 1. BM25 Search
    const bm25Results = this.bm25Indexer.search(query, {
      projectId: targetProject,
      limit: 15
    });

    // 2. Vector Search
    const vectorResults = this.vectorIndexer.search(query, {
      projectId: targetProject,
      limit: 15
    });

    // 3. Reciprocal Rank Fusion (RRF)
    const fusedScores = new Map(); // chunkId -> { chunk, rrfScore, sources }
    const RRF_K = 60;

    bm25Results.forEach((res, rank) => {
      const id = res.chunk.id;
      const score = (1 / (RRF_K + rank + 1)) * SECOND_BRAIN_CONFIG.bm25Weight;
      fusedScores.set(id, {
        chunk: res.chunk,
        rrfScore: score,
        bm25Score: res.score,
        vectorScore: 0,
        sources: ['bm25']
      });
    });

    vectorResults.forEach((res, rank) => {
      const id = res.chunk.id;
      const score = (1 / (RRF_K + rank + 1)) * SECOND_BRAIN_CONFIG.vectorWeight;
      if (fusedScores.has(id)) {
        const item = fusedScores.get(id);
        item.rrfScore += score;
        item.vectorScore = res.score;
        item.sources.push('vector');
      } else {
        fusedScores.set(id, {
          chunk: res.chunk,
          rrfScore: score,
          bm25Score: 0,
          vectorScore: res.score,
          sources: ['vector']
        });
      }
    });

    // 4. Knowledge Graph symbol boost
    for (const [id, item] of fusedScores.entries()) {
      if (item.chunk.symbols && item.chunk.symbols.length > 0) {
        for (const sym of item.chunk.symbols) {
          const graphNodes = knowledgeGraph.searchNodes(sym);
          if (graphNodes.length > 0) {
            item.rrfScore += 0.005; // Modest graph-relevance boost
            break;
          }
        }
      }
    }

    let ranked = Array.from(fusedScores.values()).sort((a, b) => b.rrfScore - a.rrfScore);

    // If no target project was identified, require high confidence match so generic questions
    // like "What is a red-black tree?" or "What is React?" do not hallucinate loose code chunks
    if (!targetProject) {
      ranked = ranked.filter((item) => item.bm25Score > 4.0 && item.sources.length >= 2);
    }

    return ranked.slice(0, limit);
  }

  buildEvidenceContextBlock(query, options = {}) {
    const targetProject = options.projectId || this.detectProjectTarget(query);
    const results = this.retrieve(query, { projectId: targetProject, limit: SECOND_BRAIN_CONFIG.retrievalMaxSnippets });
    const resumeMapping = targetProject ? resumeMapper.getMappingForProject(targetProject) : null;

    if (results.length === 0 && !resumeMapping) {
      return '';
    }

    let block = '=== VERIFIED PROJECT & ENGINEERING EVIDENCE ===\n';
    block += 'This section contains verified source code and architecture facts from the candidate\'s local repositories.\n';
    block += 'Strict Rule: Ground your answer strictly in these verified implementations. Never invent technologies or architecture.\n\n';

    if (resumeMapping) {
      block += `[PROJECT PROFILE: ${resumeMapping.projectId.toUpperCase()}]\n`;
      block += `Verified Purpose: ${resumeMapping.verifiedImplementation.summary}\n`;
      block += `Primary Technologies: ${resumeMapping.verifiedImplementation.technologies.join(', ')}\n`;
      block += 'Verified Flows:\n';
      for (const flow of resumeMapping.verifiedImplementation.flows) {
        block += ` - ${flow}\n`;
      }
      block += '\n';
    }

    if (results.length > 0) {
      block += '--- RELEVANT CODE SNIPPETS & ARTIFACTS ---\n';
      let currentTokens = 0;
      for (const { chunk, rrfScore, sources } of results) {
        const header = `[FILE: ${chunk.filePath}#L${chunk.startLine}-L${chunk.endLine}] [PROJECT: ${chunk.projectId}] [RETRIEVAL: ${sources.join('+')}]\n`;
        const codeSnippet = `${chunk.text.slice(0, 800)}\n\n`;

        // Check token budget (~4 chars per token)
        const estTokens = (header.length + codeSnippet.length) / 4;
        if (currentTokens + estTokens > SECOND_BRAIN_CONFIG.retrievalTokenBudget) {
          break;
        }

        block += header + codeSnippet;
        currentTokens += estTokens;
      }
    }

    block += '=== END PROJECT & ENGINEERING EVIDENCE ===';
    return block;
  }
}

module.exports = {
  HybridRetriever
};
