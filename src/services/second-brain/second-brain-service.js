'use strict';

const path = require('path');
const { SECOND_BRAIN_CONFIG } = require('./config');
const { projectRegistry } = require('./project-registry');
const { BM25Indexer } = require('./bm25-indexer');
const { VectorIndexer } = require('./vector-indexer');
const { IncrementalIndexer } = require('./incremental-indexer');
const { HybridRetriever } = require('./hybrid-retriever');
const { knowledgeGraph } = require('./knowledge-graph');
const { resumeMapper } = require('./resume-mapper');
const { engineeringMemory } = require('./engineering-memory');

/**
 * SecondBrainService
 *
 * Unified orchestrator for repository intelligence, persistent knowledge graphs,
 * hybrid RAG retrieval, and personal engineering memory.
 */

class SecondBrainService {
  constructor() {
    this.bm25Indexer = new BM25Indexer(SECOND_BRAIN_CONFIG.bm25Weight);
    this.vectorIndexer = new VectorIndexer(128);
    this.indexer = new IncrementalIndexer(this.bm25Indexer, this.vectorIndexer);
    this.retriever = new HybridRetriever(this.bm25Indexer, this.vectorIndexer);
    this.initialized = false;
    this.initPromise = null;
  }

  async initialize() {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      // 1. Discover local project directories
      projectRegistry.discoverProjects();

      // 2. Try loading persisted indices
      const loaded = this.indexer.loadIndices();
      if (!loaded || this.bm25Indexer.documents.size === 0) {
        // Initial indexing run
        const projects = projectRegistry.getDiscoveredProjects();
        await this.indexer.indexAll(projects);
      }

      this.initialized = true;
    })();

    return this.initPromise;
  }

  getHealth() {
    return this.indexer.getHealth();
  }

  getProjects() {
    return projectRegistry.getAllProjects();
  }

  getProject(id) {
    return projectRegistry.getProject(id);
  }

  async reindex(force = true) {
    projectRegistry.discoverProjects();
    const projects = projectRegistry.getDiscoveredProjects();
    return await this.indexer.indexAll(projects, force);
  }

  retrieveContext(query, options = {}) {
    if (!query || typeof query !== 'string') return '';
    return this.retriever.buildEvidenceContextBlock(query, options);
  }

  query(queryText, options = {}) {
    const targetProject = options.projectId || this.retriever.detectProjectTarget(queryText);
    const results = this.retriever.retrieve(queryText, {
      projectId: targetProject,
      limit: options.limit || 8
    });
    const resumeMapping = targetProject ? resumeMapper.getMappingForProject(targetProject) : null;
    const project = targetProject ? projectRegistry.getProject(targetProject) : null;

    return {
      query: queryText,
      targetProjectId: targetProject,
      project,
      resumeMapping,
      results: results.map((r) => ({
        id: r.chunk.id,
        projectId: r.chunk.projectId,
        filePath: r.chunk.filePath,
        startLine: r.chunk.startLine,
        endLine: r.chunk.endLine,
        symbols: r.chunk.symbols,
        summary: r.chunk.summary,
        rrfScore: r.rrfScore,
        sources: r.sources,
        textSnippet: r.chunk.text.slice(0, 500)
      }))
    };
  }

  // Engineering Memory delegation
  getProfessionalMemory() {
    return engineeringMemory.getProfessionalMemory();
  }

  getSessionMemory() {
    return engineeringMemory.getSessionMemory();
  }

  recordTurn(question, answerSummary, projectId = null) {
    engineeringMemory.recordQuestionTurn(question, answerSummary, projectId);
  }

  setUserFact(key, fact) {
    engineeringMemory.setUserReviewedFact(key, fact);
  }

  getUserFacts() {
    return engineeringMemory.getAllUserReviewedFacts();
  }
}

const secondBrainService = new SecondBrainService();

module.exports = {
  SecondBrainService,
  secondBrainService
};

