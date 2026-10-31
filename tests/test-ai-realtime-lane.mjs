#!/usr/bin/env node
/**
 * Live-answer latency path: gemini-service.js realtime lane, gemini-runtime.js
 * key failover, thinking config, response modes, and latency stage tracking.
 * The provider is a simulated model object with the SDK's call shape.
 *
 * Run: node tests/test-ai-realtime-lane.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const GeminiService = require(path.join(__dirname, '../src/services/ai/gemini-service.js'));
const { createGeminiRuntime } = require(path.join(__dirname, '../src/main-process/features/assistant/gemini-runtime.js'));
const { RESPONSE_MODES, buildResponseModeBlock, getResponseMode, resolveResponseModeId } = require(path.join(__dirname, '../src/services/ai/response-modes.js'));
const { createQuestionLatencyTracker } = require(path.join(__dirname, '../src/services/latency/question-latency-tracker.js'));

const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;
let passed = 0;
let failed = 0;
async function test(name, fn) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    await fn();
    passed += 1;
    realLog(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    realLog(`  ✗ ${name}\n      ${error.message}`);
  } finally {
    console.log = realLog;
    console.warn = realWarn;
    console.error = realError;
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}
const section = (title) => realLog(`\n${title}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Simulated model. `behaviour(payload, callIndex)` may throw or return a delay in ms. */
function fakeModel(behaviour = () => 50) {
  const calls = [];
  const model = {
    calls,
    async generateContentStream(payload, options = {}) {
      const index = calls.length;
      calls.push({ payload, at: Date.now() });
      const delay = await behaviour(payload, index);
      return {
        stream: (async function* stream() {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, delay);
            options.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            }, { once: true });
          });
          yield { text: () => 'answer' };
        })()
      };
    },
    async generateContent(payload) {
      calls.push({ payload, at: Date.now() });
      const delay = await behaviour(payload, calls.length - 1);
      await sleep(delay);
      return { response: { text: () => 'answer' } };
    }
  };
  return model;
}

function service(model, modelName = 'gemini-3.5-flash-lite') {
  const svc = new GeminiService('key', { modelName });
  svc.model = model;
  return svc;
}

const askOptions = (extra = {}) => ({ transcriptContext: 'Host: What is a hash map?', onChunk: () => {}, tag: 'askAi', ...extra });

section('realtime lane');

await test('A live answer does not wait behind a slow background request', async () => {
  const model = fakeModel((_payload, index) => (index === 0 ? 2000 : 50));
  const svc = service(model);
  const background = svc.generateText('notes', { onChunk: () => {} });
  await sleep(20);
  const started = Date.now();
  await svc.askAiWithSessionContext(askOptions());
  const elapsed = Date.now() - started;
  assert(elapsed < 500, `answer took ${elapsed} ms behind background work`);
  await background;
});

await test('A live answer ignores the self-imposed rate window; background work still respects it', async () => {
  const svc = service(fakeModel(() => 10));
  svc.rateLimitWindowMs = 400;
  svc.maxRequestsPerWindow = 1;
  svc.requestTimestamps = [Date.now()];
  const realtimeStart = Date.now();
  await svc.askAiWithSessionContext(askOptions());
  assert(Date.now() - realtimeStart < 200, 'realtime waited on the window');
  const backgroundStart = Date.now();
  await svc.generateText('notes', { onChunk: () => {} });
  assert(Date.now() - backgroundStart >= 150, 'background skipped the window');
});

await test('Realtime concurrency is bounded (3 in flight, the 4th waits for a slot)', async () => {
  let inFlight = 0;
  let peak = 0;
  const model = fakeModel(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await sleep(80);
    inFlight -= 1;
    return 0;
  });
  const svc = service(model);
  await Promise.all([1, 2, 3, 4, 5].map((i) => svc.generateText(`q${i}`, { priority: 'realtime', onChunk: () => {} })));
  assert(peak === 3, `peak concurrency ${peak}`);
});

await test('A 429 on a live answer is surfaced immediately with isRateLimited, no backoff', async () => {
  const svc = service(fakeModel(() => {
    throw new Error('[429 Too Many Requests] Resource has been exhausted. "retryDelay": "7s"');
  }));
  const started = Date.now();
  let caught = null;
  try {
    await svc.askAiWithSessionContext(askOptions());
  } catch (error) {
    caught = error;
  }
  assert(caught?.isRateLimited === true, 'not tagged as rate-limited');
  assert(caught.retryAfterMs === 7000, `retryAfterMs ${caught.retryAfterMs}`);
  assert(Date.now() - started < 300, 'waited before surfacing the 429');
});

await test('Background requests keep their retry backoff on 503', async () => {
  const svc = service(fakeModel((_payload, index) => {
    if (index === 0) throw new Error('[503 Service Unavailable]');
    return 0;
  }));
  const started = Date.now();
  await svc.generateText('notes', { onChunk: () => {} });
  assert(Date.now() - started >= 1900, 'background did not back off');
});

section('thinking config');

await test('Gemini 3 live answers request a low thinking level and the mode\'s token budget', async () => {
  const model = fakeModel(() => 0);
  const svc = service(model, 'gemini-3.5-flash');
  await svc.askAiWithSessionContext(askOptions({ responseMode: 'quick' }));
  const config = model.calls[0].payload.generationConfig;
  assert(config.thinkingConfig?.thinkingLevel === 'low', JSON.stringify(config));
  assert(config.maxOutputTokens === RESPONSE_MODES.quick.maxOutputTokens);
});

await test('A model that rejects thinkingConfig is retried once without it, and remembered', async () => {
  const model = fakeModel((payload) => {
    if (payload.generationConfig.thinkingConfig) throw new Error('[400 Bad Request] Thinking level is not supported for this model.');
    return 0;
  });
  const svc = service(model, 'gemini-3.1-flash-lite');
  await svc.askAiWithSessionContext(askOptions());
  assert(model.calls.length === 2, `calls ${model.calls.length}`);
  await svc.askAiWithSessionContext(askOptions());
  assert(model.calls.length === 3, 'second answer should go straight through without thinkingConfig');
  assert(!model.calls[2].payload.generationConfig.thinkingConfig);
});

section('key failover');

function runtimeWithModels(keys, modelForKey) {
  const runtime = createGeminiRuntime();
  runtime.setKeys(keys);
  runtime.initializeGeminiService(keys[0]);
  const svc = runtime.getService();
  svc._initializeModel = function reinit() {
    this.model = modelForKey(this.apiKey);
  };
  svc.model = modelForKey(keys[0]);
  return runtime;
}

await test('Key A rate-limited -> answered on key B without waiting', async () => {
  const limited = fakeModel(() => { throw new Error('[429 Too Many Requests]'); });
  const healthy = fakeModel(() => 20);
  const runtime = runtimeWithModels(['key-a', 'key-b'], (key) => (key === 'key-a' ? limited : healthy));
  const started = Date.now();
  const text = await runtime.executeWithKeyFailover((svc) => svc.askAiWithSessionContext(askOptions()));
  assert(text === 'answer');
  assert(limited.calls.length === 1, `key A tried ${limited.calls.length}x`);
  assert(Date.now() - started < 400, `took ${Date.now() - started} ms`);
});

await test('Single rate-limited key -> exactly one capped retry, then a clear failure (no loop)', async () => {
  const limited = fakeModel(() => { throw new Error('[429 Too Many Requests] "retryDelay": "30s"'); });
  const runtime = runtimeWithModels(['only-key'], () => limited);
  const started = Date.now();
  let caught = null;
  try {
    await runtime.executeWithKeyFailover((svc) => svc.askAiWithSessionContext(askOptions()));
  } catch (error) {
    caught = error;
  }
  const elapsed = Date.now() - started;
  assert(runtime.isAllKeysUnavailableError(caught), 'expected the all-keys-unavailable error');
  assert(limited.calls.length === 2, `attempts ${limited.calls.length}`);
  assert(elapsed >= 1400 && elapsed < 2500, `retry delay must be capped at 1.5 s even though the provider asked for 30 s (took ${elapsed} ms)`);
});

await test('Single rate-limited key that recovers -> answer after the one retry', async () => {
  const model = fakeModel((_payload, index) => {
    if (index === 0) throw new Error('[429 Too Many Requests] "retryDelay": "0.3s"');
    return 10;
  });
  const runtime = runtimeWithModels(['only-key'], () => model);
  const started = Date.now();
  const text = await runtime.executeWithKeyFailover((svc) => svc.askAiWithSessionContext(askOptions()));
  assert(text === 'answer');
  assert(Date.now() - started < 1000, 'used the provider\'s short delay (floored at 250 ms)');
});

section('response modes');

await test('Each mode puts its own instruction in the prompt, last, after the persona', async () => {
  const prompts = require(path.join(__dirname, '../src/services/ai/prompts.js'));
  for (const id of Object.keys(RESPONSE_MODES)) {
    const text = prompts.buildAskAiSessionPrompt({ contextString: 'Host: Tell me about a conflict.', transcriptContext: 'Host: Tell me about a conflict.', responseMode: id });
    const block = text.indexOf(`RESPONSE MODE: ${RESPONSE_MODES[id].label.toUpperCase()}`);
    assert(block > text.indexOf('You are Invisibrain'), `${id}: mode block missing or before the persona`);
    assert(text.includes(RESPONSE_MODES[id].instruction), `${id}: instruction text missing`);
  }
});

await test('Every mode carries the no-fabrication rule', () => {
  for (const id of Object.keys(RESPONSE_MODES)) {
    assert(/Never invent an employer, project, metric, or result/.test(buildResponseModeBlock(id)), id);
  }
});

await test('Modes differ in budget: quick < professional < technical < detailed', () => {
  const budget = (id) => getResponseMode(id).maxOutputTokens;
  assert(budget('quick') < budget('professional') && budget('professional') < budget('technical') && budget('technical') < budget('detailed'));
});

await test('Unknown or missing mode falls back to professional', () => {
  assert(resolveResponseModeId('essay') === 'professional');
  assert(resolveResponseModeId(undefined) === 'professional');
  assert(getResponseMode('<script>').id === 'professional');
});

section('latency stages');

await test('T4 is the final dispatch, so retry time is reported as retries, not provider time', () => {
  const tracker = createQuestionLatencyTracker({ log: () => {} });
  const id = tracker.start({ responseMode: 'quick' }, 1000);
  tracker.mark(id, 'T2', 1010);
  tracker.mark(id, 'T3', 1020);
  tracker.mark(id, 'T4', 1030, { overwrite: true });
  tracker.addRetry(id, 0, 'rate-limited');
  tracker.mark(id, 'T4', 1530, { overwrite: true });
  tracker.note(id, { model: 'gemini-3.5-flash', thinking: 'low' });
  tracker.mark(id, 'T5', 1900);
  const report = tracker.complete(id);
  assert(report.segments.geminiFirst === 370, `geminiFirst ${report.segments.geminiFirst}`);
  assert(report.segments.requestSetup === 510);
  assert(report.retries.count === 1 && report.retries.reasons[0] === 'rate-limited');
  assert(report.meta.model === 'gemini-3.5-flash' && report.meta.responseMode === 'quick');
});

await test('Service timing hooks report dispatch and first token for the latency tracker', async () => {
  const events = [];
  const svc = service(fakeModel(() => 30));
  await svc.askAiWithSessionContext(askOptions({ onTiming: (event) => events.push(event) }));
  const stages = events.map((event) => event.stage);
  assert(stages[0] === 'dispatched' && stages.includes('first-token'), stages.join(','));
  assert(events[0].model === 'gemini-3.5-flash-lite');
});

realLog(`\n${'─'.repeat(60)}`);
realLog(`AI realtime lane tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
