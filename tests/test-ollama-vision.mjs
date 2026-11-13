// Ollama provider: screenshots reach a vision model as `images`, and a
// text-only model fails clearly instead of answering as if it had looked.
// Uses a local HTTP stand-in for the Ollama API. Run: node tests/test-ollama-vision.mjs

import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const OllamaService = require('../src/services/ai/ollama-service.js');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const chats = [];
let showReply = { capabilities: ['completion', 'vision'] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = body ? JSON.parse(body) : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/show') return res.end(JSON.stringify(showReply));
    if (req.url === '/api/chat') {
      chats.push(json);
      if (json.stream) return res.end(`${JSON.stringify({ message: { content: 'streamed answer' } })}\n`);
      return res.end(JSON.stringify({ message: { content: 'plain answer' } }));
    }
    res.statusCode = 404;
    return res.end('{}');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

const image = { inlineData: { data: 'aGVsbG8=', mimeType: 'image/jpeg' } };

await test('Vision model: every screenshot part is forwarded as base64 in `images`, labels stay in the prompt', async () => {
  chats.length = 0;
  showReply = { capabilities: ['completion', 'vision'] };
  const service = new OllamaService({ baseUrl, modelName: 'llama3.2-vision' });
  const text = await quiet(() => service.analyzeScreenshots([{ text: '[Image 1: full screen]' }, image, { text: '[Image 2: left half]' }, image], ''));
  assert(text === 'plain answer', `Unexpected answer ${text}`);
  const user = chats[0].messages.find((m) => m.role === 'user');
  assert(Array.isArray(user.images) && user.images.length === 2, `Expected 2 images, got ${user.images?.length}`);
  assert(user.images[0] === 'aGVsbG8=', 'Image must be raw base64');
  assert(user.content.includes('[Image 2: left half]'), 'Crop labels must stay in the prompt');
  assert(!user.content.includes('requires a vision-capable model'), 'No "pretend" note in the prompt');
});

await test('Streaming works with images', async () => {
  chats.length = 0;
  const service = new OllamaService({ baseUrl, modelName: 'llama3.2-vision' });
  let streamed = '';
  const text = await quiet(() => service.analyzeScreenshots([image], '', { onChunk: ({ text: t }) => { streamed += t; } }));
  assert(text === 'streamed answer' && streamed === 'streamed answer', 'Streamed text must arrive');
  assert(chats[0].stream === true && chats[0].messages[1].images.length === 1, 'Stream request must carry the image');
});

await test('Text-only model: MODEL_NO_VISION, and no chat request is sent', async () => {
  chats.length = 0;
  showReply = { capabilities: ['completion'] };
  const service = new OllamaService({ baseUrl, modelName: 'llama3.2' });
  let error = null;
  try { await quiet(() => service.analyzeScreenshots([image], '')); } catch (e) { error = e; }
  assert(error?.code === 'MODEL_NO_VISION', `Expected MODEL_NO_VISION, got ${error?.code}: ${error?.message}`);
  assert(error.message.includes('llama3.2'), 'Error must name the model');
  assert(chats.length === 0, 'Must not ask a text-only model to describe an image');
});

await test('Older Ollama without `capabilities`: a CLIP projector family counts as vision', async () => {
  showReply = { details: { family: 'llama', families: ['llama', 'clip'] } };
  const service = new OllamaService({ baseUrl, modelName: 'llava' });
  assert(await service.supportsVision() === true, 'clip family must be detected as vision');
  showReply = { details: { family: 'llama', families: ['llama'] } };
  const textOnly = new OllamaService({ baseUrl, modelName: 'mistral' });
  assert(await textOnly.supportsVision() === false, 'plain llama family is not vision');
});

await test('Text requests are unaffected and never query /api/show', async () => {
  chats.length = 0;
  showReply = null;
  const service = new OllamaService({ baseUrl, modelName: 'llama3.2' });
  const text = await quiet(() => service.generateText('hello'));
  assert(text === 'plain answer', 'Text answer expected');
  assert(!chats[0].messages[1].images, 'No images on a text request');
});

await test('`model` mirrors modelName so the shared "model initialized" checks pass', () => {
  const service = new OllamaService({ baseUrl, modelName: 'qwen2.5vl' });
  assert(service.model === 'qwen2.5vl', `Expected model getter, got ${service.model}`);
});

server.close();
console.log(`\nOllama vision tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
if (failed) process.exit(1);
