'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SECOND_BRAIN_CONFIG, resolveStoreDir } = require('./config');
const { isSensitiveFile } = require('./security-scrubber');
const { astAnalyzer } = require('./ast-analyzer');
const { chunker } = require('./chunker');
const { knowledgeGraph, VERIFICATION_LEVELS } = require('./knowledge-graph');

/**
 * Incremental Indexer
 *
 * Implements content hashing (SHA-256), change detection, deleted-file pruning,
 * and persistent manifest caching to ensure non-blocking background indexing.
 */

class IncrementalIndexer {
  constructor(bm25Indexer, vectorIndexer, storageDir = null) {
    this.bm25Indexer = bm25Indexer;
    this.vectorIndexer = vectorIndexer;
    this.storageDir = storageDir || resolveStoreDir();
    this.manifestPath = path.join(this.storageDir, 'file-manifest.json');
    this.storePath = path.join(this.storageDir, 'index-store.json');

    // filePath -> { hash, mtimeMs, chunkIds, symbolCount, projectId }
    this.manifest = new Map();
    this.isIndexing = false;
    this.stats = {
      totalFiles: 0,
      totalChunks: 0,
      totalSymbols: 0,
      lastIndexedAt: null,
      projectStats: {}
    };

    this.loadManifest();
  }

  loadManifest() {
    try {
      if (fs.existsSync(this.manifestPath)) {
        const raw = fs.readFileSync(this.manifestPath, 'utf8');
        const data = JSON.parse(raw);
        if (data.entries) {
          this.manifest = new Map(Object.entries(data.entries));
        }
        if (data.stats) {
          this.stats = data.stats;
        }
      }
    } catch {
      this.manifest.clear();
    }
  }

  saveManifest() {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
      const data = {
        updatedAt: new Date().toISOString(),
        stats: this.stats,
        entries: Object.fromEntries(this.manifest)
      };
      fs.writeFileSync(this.manifestPath, JSON.stringify(data, null, 2), 'utf8');

      // Also persist indices
      const indexBundle = {
        updatedAt: new Date().toISOString(),
        bm25: this.bm25Indexer.exportData(),
        vector: this.vectorIndexer.exportData(),
        graph: knowledgeGraph.exportData()
      };
      fs.writeFileSync(this.storePath, JSON.stringify(indexBundle), 'utf8');
    } catch {
      // Non-fatal
    }
  }

  loadIndices() {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, 'utf8');
        const bundle = JSON.parse(raw);
        if (bundle.bm25) this.bm25Indexer.importData(bundle.bm25);
        if (bundle.vector) this.vectorIndexer.importData(bundle.vector);
        if (bundle.graph) knowledgeGraph.importData(bundle.graph);
        return true;
      }
    } catch {
      // Fallback
    }
    return false;
  }

  computeHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  scanProjectFiles(project) {
    const rootPath = project.rootPath;
    if (!rootPath || !fs.existsSync(rootPath)) return [];

    const discovered = [];
    const scanDir = (dir, depth = 0) => {
      if (depth > 12) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const name = entry.name;
        if (name.startsWith('.') && name !== '.env.example') continue;
        if (SECOND_BRAIN_CONFIG.ignoredDirectories.has(name)) continue;

        const fullPath = path.join(dir, name);
        if (entry.isDirectory()) {
          scanDir(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(name).toLowerCase();
          if (SECOND_BRAIN_CONFIG.supportedExtensions.has(ext) && !isSensitiveFile(fullPath)) {
            try {
              const stat = fs.statSync(fullPath);
              if (stat.size <= SECOND_BRAIN_CONFIG.maxFileSizeBytes) {
                discovered.push({ fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
              }
            } catch {
              // Skip unreadable files
            }
          }
        }
      }
    };

    scanDir(rootPath);
    return discovered;
  }

  async indexProject(project, force = false) {
    if (!project || !project.isDiscovered) return { indexed: 0, skipped: 0, deleted: 0 };

    const projectId = project.id;
    const files = this.scanProjectFiles(project);
    const seenPaths = new Set();

    let indexedCount = 0;
    let skippedCount = 0;
    let deletedCount = 0;
    let projectSymbols = 0;

    // Register project node in knowledge graph
    knowledgeGraph.addNode({
      id: `project:${projectId}`,
      label: project.name,
      type: 'project',
      projectId,
      verificationLevel: VERIFICATION_LEVELS.VERIFIED_CODE,
      properties: {
        rootPath: project.rootPath,
        summary: project.verifiedSummary,
        technologies: project.primaryStack
      }
    });

    for (const tech of project.primaryStack) {
      const techId = `tech:${tech.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      knowledgeGraph.addNode({
        id: techId,
        label: tech,
        type: 'technology',
        projectId,
        verificationLevel: VERIFICATION_LEVELS.VERIFIED_CODE
      });
      knowledgeGraph.addEdge(`project:${projectId}`, techId, 'USES_TECH');
    }

    for (const file of files) {
      const filePath = file.fullPath;
      seenPaths.add(filePath);
      const manifestEntry = this.manifest.get(filePath);

      let content = '';
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      const contentHash = this.computeHash(content);

      if (!force && manifestEntry && manifestEntry.hash === contentHash && manifestEntry.mtimeMs === file.mtimeMs) {
        skippedCount++;
        projectSymbols += (manifestEntry.symbolCount || 0);
        continue;
      }

      // Re-index file: extract symbols, create chunks, add to graph and indices
      const symbols = astAnalyzer.analyzeFile(filePath, content);
      projectSymbols += symbols.length;

      // Add symbols to knowledge graph
      for (const sym of symbols) {
        const symId = `sym:${projectId}:${path.basename(filePath)}:${sym.name}:${sym.line}`;
        knowledgeGraph.addNode({
          id: symId,
          label: sym.name,
          type: sym.kind,
          projectId,
          file: filePath,
          lineRange: `L${sym.line}`,
          verificationLevel: VERIFICATION_LEVELS.VERIFIED_CODE,
          properties: { signature: sym.signature }
        });
        knowledgeGraph.addEdge(`project:${projectId}`, symId, 'IMPLEMENTS_SYMBOL');
      }

      // Chunk file
      const chunks = chunker.chunkFile(filePath, content, symbols, projectId);
      const chunkIds = [];

      for (const chunk of chunks) {
        chunkIds.push(chunk.id);
        this.bm25Indexer.addChunk(chunk);
        this.vectorIndexer.addChunk(chunk);
      }

      this.manifest.set(filePath, {
        hash: contentHash,
        mtimeMs: file.mtimeMs,
        chunkIds,
        symbolCount: symbols.length,
        projectId
      });

      indexedCount++;
    }

    // Clean up deleted files for this project
    for (const [recordedPath, meta] of this.manifest.entries()) {
      if (meta.projectId === projectId && !seenPaths.has(recordedPath)) {
        this.manifest.delete(recordedPath);
        deletedCount++;
      }
    }

    // Update project stats
    this.stats.projectStats[projectId] = {
      files: seenPaths.size,
      symbols: projectSymbols,
      lastIndexedAt: new Date().toISOString()
    };

    return { indexed: indexedCount, skipped: skippedCount, deleted: deletedCount };
  }

  async indexAll(projects, force = false) {
    if (this.isIndexing) return this.stats;
    this.isIndexing = true;

    try {
      let totalFiles = 0;
      let totalSymbols = 0;

      for (const proj of projects) {
        if (!proj.isDiscovered) continue;
        const res = await this.indexProject(proj, force);
        const pStat = this.stats.projectStats[proj.id] || {};
        totalFiles += (pStat.files || 0);
        totalSymbols += (pStat.symbols || 0);
      }

      this.stats.totalFiles = totalFiles;
      this.stats.totalChunks = this.bm25Indexer.documents.size;
      this.stats.totalSymbols = totalSymbols;
      this.stats.lastIndexedAt = new Date().toISOString();

      this.saveManifest();
    } finally {
      this.isIndexing = false;
    }

    return this.stats;
  }

  getHealth() {
    return {
      status: this.isIndexing ? 'indexing' : (this.stats.totalFiles > 0 ? 'healthy' : 'unindexed'),
      totalFiles: this.stats.totalFiles,
      totalChunks: this.bm25Indexer.documents.size,
      totalSymbols: this.stats.totalSymbols,
      lastIndexedAt: this.stats.lastIndexedAt,
      projectsCount: Object.keys(this.stats.projectStats).length,
      projectStats: this.stats.projectStats
    };
  }
}

module.exports = {
  IncrementalIndexer
};

