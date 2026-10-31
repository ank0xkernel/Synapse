#!/usr/bin/env node
'use strict';

/**
 * Measures the latency Synapse itself adds on top of the AI provider: queue
 * waits, self-imposed rate limiting, retry backoff and key failover.
 *
 * The provider is simulated with a fixed time-to-first-token so that every
 * millisecond above that number is Synapse's own overhead. This does NOT
 * measure Gemini's real network latency; run scripts/benchmark-gemini-live.js
 * with GEMINI_API_KEY set for that.
 *
 *   node scripts/benchmark-ai-pipeline.js [--json]
 */

const path = require('path');
const GeminiService = require(path.join(__dirname, '..', 'src', 'services', 'ai', 'gemini-service.js'));
const { createGeminiRuntime } = require(path.join(__dirname, '..', 'src', 'main-process', 'features', 'assistant', 'gemini-runtime.js'));

const PROVIDER_TTFT_MS = 400;
const PROVIDER_STREAM_MS = 600;
const SCREENSHOT_ANALYSIS_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Simulated Gemini model object with the SDK's call shape. */
function createFakeModel({ failuresBeforeSuccess = 0, failureMessage = '[429 Too Many Requests] Resource has been exhausted (e.g. check quota).', slowMs = null } = {}) {
  let failuresLeft = failuresBeforeSuccess;

  function maybeFail() {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      const error = new Error(failureMessage);
      throw error;
    }
  }

  async function waitAbortable(ms, signal) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        const error = new Error('This operation was aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  }

  return {
    async generateContentStream(_data, options = {}) {
      await waitAbortable(30, options.signal);
      maybeFail();
      const ttft = slowMs ?? PROVIDER_TTFT_MS;
      return {
        stream: (async function* stream() {
          await waitAbortable(ttft, options.signal);
          yield { text: () => 'First words of the answer. ' };
          await waitAbortable(PROVIDER_STREAM_MS, options.signal);
          yield { text: () => 'Rest of the answer.' };
        })()
      };
    },
    async generateContent(_data, options = {}) {
      await waitAbortable(30, options.signal);
      maybeFail();
      await waitAbortable(slowMs ?? (PROVIDER_TTFT_MS + PROVIDER_STREAM_MS), options.signal);
      return { response: { text: () => 'Non-streamed answer.' } };
    }
  };
}

function makeService(modelOptions) {
  const service = new GeminiService('fake-key', {});
  service.model = createFakeModel(modelOptions);
  // Keep the simulated model across any re-initialisation inside the service.
  const originalInit = service._initializeModel?.bind(service);
  service._initializeModel = () => {
    originalInit?.();
    service.model = createFakeModel(modelOptions);
  };
  return service;
}

/** Time from calling the answer path to its first streamed chunk. */
async function timeToFirstChunk(run) {
  const started = Date.now();
  let firstChunkAt = null;
  try {
    await run(() => {
      if (firstChunkAt === null) firstChunkAt = Date.now();
    });
  } catch (error) {
    return { failedAfterMs: Date.now() - started, error: String(error.message || error).slice(0, 80) };
  }
  return firstChunkAt === null ? null : firstChunkAt - started;
}

function askAnswer(service, onChunk) {
  return service.askAiWithSessionContext({ transcriptContext: 'Host: How would you design a rate limiter?', onChunk, tag: 'askAi' });
}

async function scenarioIdle() {
  const service = makeService();
  return timeToFirstChunk((onChunk) => askAnswer(service, onChunk));
}

async function scenarioBehindScreenshot() {
  const service = makeService({ slowMs: null });
  // A long multimodal analysis starts first...
  const slowModel = createFakeModel({ slowMs: SCREENSHOT_ANALYSIS_MS });
  const fastModel = createFakeModel();
  let call = 0;
  service.model = {
    generateContentStream: (...args) => (call++ === 0 ? slowModel : fastModel).generateContentStream(...args),
    generateContent: (...args) => (call++ === 0 ? slowModel : fastModel).generateContent(...args)
  };
  const background = service.generateMultimodal([{ text: 'analyze this screen' }], { onChunk: () => {} });
  await sleep(50);
  // ...then the interviewer asks a question.
  const ttfc = await timeToFirstChunk((onChunk) => askAnswer(service, onChunk));
  await background.catch(() => {});
  return ttfc;
}

async function scenarioBurstEleventhQuestion() {
  const service = makeService();
  // Ten answers already sent within the last minute (a fast-paced interview
  // with follow-ups and superseded questions).
  const now = Date.now();
  service.requestTimestamps = Array.from({ length: 10 }, (_, i) => now - 50000 + i * 1000);
  return timeToFirstChunk((onChunk) => askAnswer(service, onChunk));
}

async function scenarioRateLimited429SingleKey() {
  const runtime = createGeminiRuntime();
  runtime.setKeys(['key-a']);
  runtime.initializeGeminiService('key-a');
  const service = runtime.getService();
  service.model = createFakeModel({ failuresBeforeSuccess: 1 });
  service._initializeModel = () => { service.model = createFakeModel(); };
  return timeToFirstChunk((onChunk) => runtime.executeWithKeyFailover((svc) => askAnswer(svc, onChunk)));
}

async function scenarioRateLimited429TwoKeys() {
  const runtime = createGeminiRuntime();
  runtime.setKeys(['key-a', 'key-b']);
  runtime.initializeGeminiService('key-a');
  const service = runtime.getService();
  let firstKeyCalls = 0;
  const failing = createFakeModel({ failuresBeforeSuccess: 99 });
  const healthy = createFakeModel();
  service._initializeModel = function reinit() {
    this.model = this.apiKey === 'key-a' ? failing : healthy;
  };
  service.model = failing;
  const original = failing.generateContentStream;
  failing.generateContentStream = (...args) => {
    firstKeyCalls += 1;
    return original(...args);
  };
  const ttfc = await timeToFirstChunk((onChunk) => runtime.executeWithKeyFailover((svc) => askAnswer(svc, onChunk)));
  return { ttfc, firstKeyCalls };
}

async function main() {
  const results = {
    providerTtftMs: PROVIDER_TTFT_MS,
    idle: await scenarioIdle(),
    behindScreenshotAnalysis: await scenarioBehindScreenshot(),
    eleventhQuestionInAMinute: await scenarioBurstEleventhQuestion(),
    rateLimited429SingleKey: await scenarioRateLimited429SingleKey(),
    rateLimited429TwoKeys: await scenarioRateLimited429TwoKeys()
  };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(results));
    return;
  }

  const overhead = (ms) => {
    if (ms === null) return 'no answer';
    if (typeof ms === 'object') return `FAILED after ${ms.failedAfterMs} ms (${ms.error})`;
    return `${ms} ms (Synapse overhead ≈ ${Math.max(0, ms - PROVIDER_TTFT_MS - 30)} ms)`;
  };
  console.log(`Simulated provider time-to-first-token: ${PROVIDER_TTFT_MS} ms (+30 ms request setup)\n`);
  console.log(`Idle, one question:                       ${overhead(results.idle)}`);
  console.log(`Question while a screenshot analysis runs: ${overhead(results.behindScreenshotAnalysis)}`);
  console.log(`11th question within one minute:          ${overhead(results.eleventhQuestionInAMinute)}`);
  console.log(`One 429, single API key:                  ${overhead(results.rateLimited429SingleKey)}`);
  console.log(`Key A rate-limited, key B healthy:        ${overhead(results.rateLimited429TwoKeys.ttfc)} (key A tried ${results.rateLimited429TwoKeys.firstKeyCalls}x)`);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
