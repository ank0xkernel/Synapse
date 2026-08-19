#!/usr/bin/env node
'use strict';

/**
 * Synapse Part 2 Benchmark Suite
 * Measures latency & accuracy across Mode Detection, Dense Semantic Embeddings,
 * Template Pre-Fetching, and Ollama Metal First-Token Generation.
 */

const ModePromptManager = require('../src/services/ai/mode-prompt-manager');
const SemanticVectorService = require('../src/services/ai/semantic-vector-service');
const TemplateCache = require('../src/services/ai/template-cache');
const OllamaMetalService = require('../src/services/ai/ollama-metal-service');

async function runPart2Benchmark() {
  console.log('⚡ Starting Synapse Part 2 Sub-450ms Benchmark Suite...\n');

  // 1. Mode Detection Benchmark (<1ms)
  const modeManager = new ModePromptManager();
  const testQuestions = [
    { text: 'How do you implement an LRU Cache with O(1) time complexity?', expected: 'coding' },
    { text: 'Design a distributed rate limiter for 100k requests per second.', expected: 'systemDesign' },
    { text: 'Tell me about a time you had a technical disagreement with a team member.', expected: 'behavioral' }
  ];

  console.log('[1] Testing Mode Classifier Latency & Accuracy...');
  const modeStart = Date.now();
  let correctModes = 0;
  for (const q of testQuestions) {
    const mode = modeManager.detectMode(q.text);
    if (mode === q.expected) correctModes++;
    console.log(`  - Question: "${q.text.substring(0, 35)}..." -> Mode: ${mode.toUpperCase()} (Match: ${mode === q.expected})`);
  }
  const modeDuration = Date.now() - modeStart;
  console.log(`  -> Mode Classification Duration: ${modeDuration}ms (Accuracy: ${correctModes}/${testQuestions.length})\n`);

  // 2. Dense Semantic Vector Search Benchmark (<2ms)
  console.log('[2] Testing Dense Semantic Vector Search Latency...');
  const vectorService = new SemanticVectorService();
  await vectorService.initialize();
  await vectorService.indexDocuments([
    { id: 'jd1', text: 'Senior Software Engineer role focusing on C++, Python, algorithms, system design, and low latency.' },
    { id: 'co1', text: 'High frequency trading firm engineering real-time order matching engines.' }
  ]);

  const searchStart = Date.now();
  const results = await vectorService.search('LRU Cache implementation', 2);
  const searchDuration = Date.now() - searchStart;
  console.log(`  -> Semantic Search Duration: ${searchDuration}ms (Retrieved ${results.length} snippets)\n`);

  // 3. Template Cache Retrieval Benchmark (<1ms)
  console.log('[3] Testing Algorithm Template Pre-Fetch Cache...');
  const templateCache = new TemplateCache(vectorService);
  await templateCache.initialize();
  const templateStart = Date.now();
  const templates = await templateCache.findMatchingTemplates('LRU Cache', 1);
  const templateDuration = Date.now() - templateStart;
  console.log(`  -> Template Retrieval Duration: ${templateDuration}ms (Template: ${templates[0] ? templates[0].substring(0, 40) : 'none'}...)\n`);

  // 4. Ollama Metal First-Token Latency Benchmark (<150ms)
  console.log('[4] Testing Ollama Metal Warm First Token Latency...');
  const ollama = new OllamaMetalService({ model: 'codeqwen:7b-chat-v1.5-q4_K_M' });
  await ollama.initialize();

  const prompt = modeManager.buildPrompt('coding', results, templates, 'How to implement LRU Cache?');
  const promptStart = Date.now();
  let firstTokenTime = 0;

  try {
    await ollama.streamResponse(prompt, (token) => {
      if (!firstTokenTime) {
        firstTokenTime = Date.now();
      }
    });

    const llmFirstTokenDuration = firstTokenTime ? (firstTokenTime - promptStart) : 0;
    console.log(`  -> Ollama Metal First Token Latency: ${llmFirstTokenDuration}ms\n`);

    // 5. Total Part 2 Pipeline Latency Summary
    const totalLatency = 200 /* STT + Endpoint */ + modeDuration + searchDuration + templateDuration + llmFirstTokenDuration + 20 /* WS */;
    console.log('==================================================');
    console.log(`⚡ TOTAL PART 2 PIPELINE LATENCY: ${totalLatency}ms`);
    console.log('==================================================');

    if (totalLatency <= 450) {
      console.log('✅ BENCHMARK PASSED: Total Latency is under 450ms target threshold!');
    } else {
      console.warn(`⚠️ BENCHMARK NOTICE: Total Latency ${totalLatency}ms (Target: < 450ms).`);
    }

  } catch (error) {
    console.error('❌ LLM Benchmark Error:', error.message);
  }
}

runPart2Benchmark();
