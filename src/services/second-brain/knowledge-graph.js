'use strict';

/**
 * Project Knowledge Graph
 *
 * Implements a typed directed graph connecting:
 * Project -> Feature -> Component -> Function -> API -> Database -> Technology
 *
 * Every node and edge carries verifiable provenance:
 * - verificationLevel: VERIFIED_CODE | DOCUMENTED | RESUME_STATED | INFERRED
 * - file, line range, commit, evidence type, timestamp
 */

const VERIFICATION_LEVELS = Object.freeze({
  VERIFIED_CODE: 'VERIFIED_CODE',
  DOCUMENTED: 'DOCUMENTED',
  RESUME_STATED: 'RESUME_STATED',
  INFERRED: 'INFERRED'
});

class KnowledgeGraph {
  constructor() {
    this.nodes = new Map(); // id -> Node
    this.edges = [];        // Array<Edge>
    this.projectProfiles = new Map(); // projectId -> StructuredProjectProfile
  }

  clear() {
    this.nodes.clear();
    this.edges = [];
    this.projectProfiles.clear();
  }

  addNode(node) {
    if (!node || !node.id) return;
    this.nodes.set(node.id, {
      id: node.id,
      label: node.label || node.id,
      type: node.type, // 'project'|'feature'|'component'|'function'|'api'|'database'|'technology'
      projectId: node.projectId || '',
      verificationLevel: node.verificationLevel || VERIFICATION_LEVELS.VERIFIED_CODE,
      provenance: {
        file: node.file || null,
        lineRange: node.lineRange || null,
        commit: node.commit || null,
        evidenceType: node.evidenceType || 'code_symbol',
        timestamp: node.timestamp || new Date().toISOString()
      },
      properties: node.properties || {}
    });
  }

  addEdge(fromId, toId, relation, verificationLevel = VERIFICATION_LEVELS.VERIFIED_CODE) {
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) return;
    this.edges.push({
      from: fromId,
      to: toId,
      relation, // e.g. 'USES_TECH', 'HAS_FEATURE', 'CALLS_API', 'QUERIES_DB', 'IMPLEMENTED_IN'
      verificationLevel,
      timestamp: new Date().toISOString()
    });
  }

  setProjectProfile(projectId, profile) {
    this.projectProfiles.set(projectId, profile);
  }

  getProjectProfile(projectId) {
    return this.projectProfiles.get(projectId) || null;
  }

  getAllProfiles() {
    return Array.from(this.projectProfiles.values());
  }

  findRelated(nodeId, maxDepth = 2) {
    const visited = new Set([nodeId]);
    const relatedNodes = [];

    const queue = [{ id: nodeId, depth: 0 }];
    while (queue.length > 0) {
      const { id, depth } = queue.shift();
      if (depth >= maxDepth) continue;

      for (const edge of this.edges) {
        let neighbor = null;
        if (edge.from === id && !visited.has(edge.to)) neighbor = edge.to;
        else if (edge.to === id && !visited.has(edge.from)) neighbor = edge.from;

        if (neighbor && this.nodes.has(neighbor)) {
          visited.add(neighbor);
          const node = this.nodes.get(neighbor);
          relatedNodes.push({ node, edge, depth: depth + 1 });
          queue.push({ id: neighbor, depth: depth + 1 });
        }
      }
    }

    return relatedNodes;
  }

  searchNodes(keyword) {
    const term = String(keyword || '').toLowerCase();
    const results = [];
    for (const node of this.nodes.values()) {
      if (node.label.toLowerCase().includes(term) || (node.id && node.id.toLowerCase().includes(term))) {
        results.push(node);
      }
    }
    return results;
  }

  exportData() {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: this.edges,
      projectProfiles: Array.from(this.projectProfiles.entries())
    };
  }

  importData(data) {
    this.clear();
    if (!data) return;
    if (Array.isArray(data.nodes)) {
      for (const n of data.nodes) this.nodes.set(n.id, n);
    }
    if (Array.isArray(data.edges)) {
      this.edges = [...data.edges];
    }
    if (Array.isArray(data.projectProfiles)) {
      for (const [id, prof] of data.projectProfiles) {
        this.projectProfiles.set(id, prof);
      }
    }
  }
}

module.exports = {
  VERIFICATION_LEVELS,
  KnowledgeGraph,
  knowledgeGraph: new KnowledgeGraph()
};

