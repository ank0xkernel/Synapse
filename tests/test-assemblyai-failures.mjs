#!/usr/bin/env node
/**
 * AssemblyAI streaming failures: classification against the documented v3
 * close-code table, and the service's real lifecycle with a fake WebSocket
 * (one session per source, one report per failure, no retry loop on a
 * permanent error, the key never leaves the socket headers).
 *
 * Mocked: the WebSocket server. Real: failure-classifier.js and service.js.
 * Run: node tests/test-assemblyai-failures.mjs
 */
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { classifyStreamingFailure } = require(path.join(__dirname, '../src/services/assembly-ai/failure-classifier.js'));
const { createAssemblyAiService } = require(path.join(__dirname, '../src/services/assembly-ai/service.js'));

let passed = 0;
let failed = 0;
const realLog = console.log;
const realError = console.error;
async function test(name, fn) {
  console.log = () => {};
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
    console.error = realError;
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}
const section = (title) => realLog(`\n${title}`);

section('classifier: documented v3 close codes');

const cases = [
  [{ code: 1008, errorText: 'Unauthorized Connection: API key is disabled' }, 'auth', false],
  [{ code: 1008, errorText: 'Unauthorized Connection: Invalid API key' }, 'auth', false],
  [{ code: 1008, errorText: 'Unauthorized Connection: Missing Authorization header' }, 'auth', false],
  [{ code: 1008, errorText: 'Unauthorized Connection: Insufficient funds' }, 'billing', false],
  [{ code: 1008, errorText: 'Unauthorized Connection: No metronome account found' }, 'billing', false],
  [{ code: 1008, errorText: 'Unauthorized Connection: Too many concurrent sessions' }, 'rate-limit', true],
  [{ code: 1011, errorText: 'Error authenticating connection' }, 'server', true],
  [{ code: 3005, errorText: 'Session Cancelled: An error occurred' }, 'server', true],
  [{ code: 3006, errorText: 'Session terminated due to inactivity: No messages received for 30 seconds' }, 'inactivity', true],
  [{ code: 3006, errorText: 'Invalid JSON: {' }, 'config', false],
  [{ code: 3007, errorText: 'Input duration violation: 20 ms. Expected between 50 and 1000 ms' }, 'config', false],
  [{ code: 3008, errorText: 'Session Expired: Maximum session duration exceeded' }, 'expired', true],
  [{ code: 1006, errorText: '' }, 'network', true],
  [{ code: 1000, errorText: '' }, 'normal', false],
  [{ socketError: 'Unexpected server response: 401' }, 'auth', false],
  [{ socketError: 'Unexpected server response: 409' }, 'auth', false],
  [{ socketError: 'Unexpected server response: 429' }, 'rate-limit', true],
  [{ socketError: 'Unexpected server response: 410' }, 'config', false],
  [{ socketError: 'Unexpected server response: 503' }, 'server', true],
  [{ socketError: 'getaddrinfo ENOTFOUND streaming.assemblyai.com' }, 'network', true]
];

for (const [input, kind, retryable] of cases) {
  const label = input.socketError || `${input.code} ${input.errorText}`.trim();
  await test(`${label.slice(0, 70)} -> ${kind}${retryable ? ' (retry)' : ' (stop)'}`, () => {
    const result = classifyStreamingFailure(input);
    assert(result.kind === kind, `kind ${result.kind}`);
    assert(result.retryable === retryable, `retryable ${result.retryable}`);
    if (kind !== 'normal') assert(result.message.length > 20, 'actionable message present');
  });
}

section('service lifecycle with a fake WebSocket server');

const API_KEY = 'aai-secret-test-key-1234567890';

function createHarness() {
  const sockets = [];
  class FakeWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }
    open() { this.readyState = FakeWebSocket.OPEN; this.emit('open'); }
    message(payload) { this.emit('message', Buffer.from(JSON.stringify(payload))); }
    serverClose(code, reason = '') { this.readyState = FakeWebSocket.CLOSED; this.emit('close', code, Buffer.from(reason)); }
    send(data) { this.sent.push(data); }
    terminate() { this.readyState = FakeWebSocket.CLOSED; }
    close() { this.readyState = FakeWebSocket.CLOSED; }
  }

  const events = [];
  const debug = [];
  const service = createAssemblyAiService({
    WebSocket: FakeWebSocket,
    desktopCapturer: null,
    getAssemblyApiKey: () => API_KEY,
    getSpeechModel: () => 'universal-streaming-english',
    getGeminiService: () => null,
    sendToRenderer: (channel, data) => {
      events.push({ channel, data });
      if (channel === 'stt-debug') debug.push(data);
    },
    getSttMode: () => 'fast',
    geminiSpeech: null
  });
  return { service, sockets, events, FakeWebSocket };
}

const errorsOf = (events) => events.filter((event) => event.channel === 'vosk-error');

await test('Connects to the documented v3 endpoint with the key only in the Authorization header', () => {
  const { service, sockets } = createHarness();
  service.startAssemblyAiStream('system');
  const socket = sockets[0];
  assert(socket.url.startsWith('wss://streaming.assemblyai.com/v3/ws?'), socket.url);
  assert(socket.url.includes('sample_rate=16000'), 'sample rate matches the 16 kHz PCM the capture path sends');
  assert(!socket.url.includes(API_KEY), 'key not in URL');
  assert(socket.options.headers.Authorization === API_KEY, 'raw key in Authorization, no Bearer prefix');
});

await test('A second start while the first socket is still connecting does not open a second session', () => {
  const { service, sockets } = createHarness();
  service.startAssemblyAiStream('system');
  service.startAssemblyAiStream('system');
  assert(sockets.length === 1, `opened ${sockets.length} sockets`);
});

await test('Disabled key (Error frame + close 1008) -> one permanent auth error, no reconnect signal', () => {
  const { service, sockets, events } = createHarness();
  service.startAssemblyAiStream('system');
  const socket = sockets[0];
  socket.open();
  socket.message({ type: 'Begin', id: 'session-1' });
  socket.message({ type: 'Error', error_code: 1008, error: 'Unauthorized Connection: API key is disabled' });
  socket.serverClose(1008, 'See Error message for details');
  const errors = errorsOf(events);
  assert(errors.length === 1, `${errors.length} error events`);
  assert(errors[0].data.kind === 'auth' && errors[0].data.permanent === true && errors[0].data.unexpected === false);
  assert(!events.some((event) => event.channel === 'vosk-stopped' && event.data.unexpected), 'no unexpected-stop (would trigger a reconnect loop)');
});

await test('Too many new sessions (1008) -> retryable, renderer reconnects with backoff', () => {
  const { service, sockets, events } = createHarness();
  service.startAssemblyAiStream('mic');
  sockets[0].open();
  sockets[0].message({ type: 'Error', error_code: 1008, error: 'Unauthorized Connection: Too many concurrent sessions' });
  sockets[0].serverClose(1008, 'See Error message for details');
  const [error] = errorsOf(events);
  assert(error.data.kind === 'rate-limit' && error.data.unexpected === true);
});

await test('Handshake rejected (error then close) -> reported exactly once', () => {
  const { service, sockets, events } = createHarness();
  service.startAssemblyAiStream('system');
  sockets[0].emit('error', new Error('Unexpected server response: 401'));
  sockets[0].serverClose(1006, '');
  const errors = errorsOf(events);
  assert(errors.length === 1, `${errors.length} error events`);
  assert(errors[0].data.kind === 'auth' && errors[0].data.permanent);
});

await test('Network drop mid-session -> retryable network error', () => {
  const { service, sockets, events } = createHarness();
  service.startAssemblyAiStream('system');
  sockets[0].open();
  sockets[0].serverClose(1006, '');
  const [error] = errorsOf(events);
  assert(error.data.kind === 'network' && error.data.unexpected === true);
});

await test('Requested stop -> Terminate sent, no error reported', () => {
  const { service, sockets, events } = createHarness();
  service.startAssemblyAiStream('system');
  sockets[0].open();
  service.stopVoiceRecognition({ source: 'system' });
  assert(sockets[0].sent.some((frame) => String(frame).includes('"Terminate"')), 'Terminate frame sent');
  sockets[0].serverClose(1000, '');
  assert(errorsOf(events).length === 0, 'no error for a clean stop');
});

await test('After a permanent failure, a new start opens a fresh socket (no stale state)', () => {
  const { service, sockets } = createHarness();
  service.startAssemblyAiStream('system');
  sockets[0].open();
  sockets[0].message({ type: 'Error', error_code: 1008, error: 'Unauthorized Connection: Invalid API key' });
  sockets[0].serverClose(1008, '');
  service.startAssemblyAiStream('system');
  assert(sockets.length === 2, 'second start allowed after failure');
});

await test('The API key never appears in anything sent to the renderer', () => {
  const { service, sockets, events } = createHarness();
  service.startAssemblyAiStream('system');
  sockets[0].emit('error', new Error('Unexpected server response: 401'));
  assert(!JSON.stringify(events).includes(API_KEY), 'key leaked to renderer events');
});

realLog(`\n${'─'.repeat(60)}`);
realLog(`AssemblyAI failure tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
