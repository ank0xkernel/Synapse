#!/usr/bin/env node
'use strict';

/**
 * Real Gemini time-to-first-token, through the same GeminiService the app
 * uses (realtime lane, per-mode budgets, thinking config). Separates the cold
 * path (fresh process, no open connection) from warm requests.
 *
 *   GEMINI_API_KEY=... node scripts/benchmark-gemini-live.js [--model gemini-3.5-flash-lite] [--runs 8]
 *
 * Uses about (runs + 1) x 3 requests of your quota. Reads the key from the
 * environment only, never from the app's stored settings.
 */

const path = require('path');
const GeminiService = require(path.join(__dirname, '..', 'src', 'services', 'ai', 'gemini-service.js'));

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('Set GEMINI_API_KEY in the environment first.');
  process.exit(1);
}

function arg(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const modelName = arg('--model', 'gemini-3.5-flash-lite');
const runs = Math.max(2, Number(arg('--runs', '8')) || 8);
const transcript = [
  'Host: Thanks for joining. Let us start with your recent work.',
  'You: Sure, happy to.',
  'Host: How would you design a rate limiter for a public API that has bursty traffic?'
].join('\n');

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

async function measure(service, responseMode, thinkingLevel) {
  const started = Date.now();
  let firstTokenAt = null;
  const prompt = `${transcript}\n\nAnswer the latest Host question as the candidate.`;
  const generation = { maxOutputTokens: 400, thinkingLevel };
  await service.generateText(prompt, {
    priority: 'realtime',
    generation,
    onChunk: () => {
      if (firstTokenAt === null) firstTokenAt = Date.now();
    }
  });
  return { responseMode, ttftMs: firstTokenAt === null ? null : firstTokenAt - started, totalMs: Date.now() - started };
}

async function main() {
  console.log(`Model: ${modelName}, ${runs} warm runs per variant\n`);
  const service = new GeminiService(apiKey, { modelName });
  console.log = ((original) => (...args) => {
    if (!String(args[0] || '').startsWith('[Gemini API]') && !String(args[0] || '').startsWith('Initializing')) original(...args);
  })(console.log);

  const cold = await measure(service, 'cold', 'low');
  console.log(`Cold (first request, new connection): TTFT ${cold.ttftMs} ms, total ${cold.totalMs} ms`);

  for (const [label, thinkingLevel] of [['thinking=low', 'low'], ['thinking=model default', null]]) {
    const samples = [];
    for (let i = 0; i < runs; i += 1) {
      const result = await measure(service, label, thinkingLevel);
      if (result.ttftMs !== null) samples.push(result.ttftMs);
    }
    console.log(`Warm, ${label.padEnd(22)} P50 ${percentile(samples, 50)} ms   P95 ${percentile(samples, 95)} ms   (n=${samples.length})`);
  }

  console.log('\nTTFT here is from request dispatch to the first streamed token, the provider part of the app\'s geminiFirst segment.');
}

main().catch((error) => {
  console.error('Benchmark failed:', error.message);
  process.exit(1);
});
