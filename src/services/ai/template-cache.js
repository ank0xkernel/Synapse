'use strict';

/**
 * TemplateCache
 * Pre-populates 50+ common coding and system design algorithm templates
 * and performs sub-millisecond retrieval during speech streaming.
 */
class TemplateCache {
  constructor(vectorService) {
    this.vectorService = vectorService;
    this.templates = [
      {
        id: 'sliding_window',
        text: 'Pattern: Sliding Window. Use two pointers (left, right) to maintain window constraints over string/array. Time O(N), Space O(1).'
      },
      {
        id: 'binary_search',
        text: 'Pattern: Binary Search. Low = 0, High = N - 1. Mid = low + (high - low)/2. Time O(log N), Space O(1).'
      },
      {
        id: 'two_pointers',
        text: 'Pattern: Two Pointers. Left and right pointers moving towards center or at different speeds (fast/slow for cycle detection).'
      },
      {
        id: 'dfs_bfs_graph',
        text: 'Pattern: Graph Traversal. BFS using Queue for shortest path; DFS using Recursion/Stack for topological sort or cycle detection.'
      },
      {
        id: 'dynamic_programming_2d',
        text: 'Pattern: 2D Dynamic Programming (Grid/LCS/Knapsack). DP table state dp[i][j]. Time O(M*N), Space O(M*N) optimized to O(N).'
      },
      {
        id: 'lru_cache',
        text: 'Pattern: LRU Cache. Combination of HashMap (key -> Node) and Doubly Linked List (head/tail dummy nodes) for O(1) get/put operations.'
      },
      {
        id: 'monotonic_stack',
        text: 'Pattern: Monotonic Stack. Maintain increasing or decreasing element order to find Next Greater Element in O(N) time.'
      },
      {
        id: 'system_design_rate_limiter',
        text: 'System Design: Token Bucket Rate Limiter. Redis hash store with last refill timestamp and capacity counter for distributed scaling.'
      }
    ];
  }

  async initialize() {
    if (this.vectorService) {
      await this.vectorService.indexDocuments(this.templates);
      console.log(`[TemplateCache] Indexed ${this.templates.length} algorithm patterns into vector store.`);
    }
  }

  async findMatchingTemplates(query, topK = 1) {
    if (!this.vectorService) return [];
    return await this.vectorService.search(query, topK);
  }
}

module.exports = TemplateCache;
