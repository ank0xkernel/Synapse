#!/usr/bin/env node
/**
 * Mode C local OCR: ocr-service.js unit tests against a scripted fake helper,
 * plus a real Apple Vision integration run on macOS with swiftc.
 *
 * Run: node tests/test-mode-c-ocr.mjs
 */
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createOcrService, resolveOcrHelperPath } = require(path.join(__dirname, '../src/services/screen-intel/ocr-service.js'));
const { buildNativeOcr } = require(path.join(__dirname, '../scripts/build-native-ocr.js'));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  FAIL ${name} ${detail}`); }
}

async function rejection(promise) {
  try { await promise; return null; } catch (error) { return error; }
}

const IMAGE = { jpeg: Buffer.from('fake-jpeg-bytes'), mime: 'image/jpeg', width: 10, height: 10 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake helper. onRequest(request, child) decides how to answer; default replies ok.
function fakeSpawner(onRequest) {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.requests = [];
    child.send = (obj) => child.stdout.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`));
    child.crash = (code = 139) => child.emit('close', code, null);
    child.stdin = {
      on() {},
      end() {},
      write(line) {
        const request = JSON.parse(line);
        child.requests.push(request);
        onRequest(request, child);
      }
    };
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null, 'SIGKILL')); };
    children.push(child);
    setImmediate(() => child.send({ event: 'ready', version: '9.9.9', revision: 1 }));
    return child;
  };
  return { spawn, children };
}

const okReply = (request, text = 'hello') => ({
  id: request.id, ok: true, width: 10, height: 10, ms: 7,
  lines: [{ text, confidence: 0.9, box: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 } }]
});

const base = { helperPath: '/fake/synapse-ocr', platform: 'darwin', fileExists: () => true, backoffMs: 5 };

console.log('resolveOcrHelperPath');
check('dev path', resolveOcrHelperPath({ appRoot: '/app' }) === '/app/native/macos-ocr/build/synapse-ocr');
check('packaged path', resolveOcrHelperPath({ isPackaged: true, resourcesPath: '/res' }) === '/res/native/synapse-ocr');

console.log('happy path');
{
  const { spawn, children } = fakeSpawner((req, c) => c.send(okReply(req)));
  const svc = createOcrService({ ...base, spawn });
  check('engine is vision before spawn', svc.getEngine() === 'vision');
  check('no spawn before first recognize', children.length === 0);
  const result = await svc.recognize(IMAGE, { sessionId: 's', regionId: 'r' });
  check('lines passed through with box', result.lines.length === 1 && result.lines[0].text === 'hello' && result.lines[0].box.x === 0.1);
  check('engine vision and durationMs from helper', result.engine === 'vision' && result.durationMs === 7);
  check('request carried base64 image and code-safe options',
    children[0].requests[0].image === IMAGE.jpeg.toString('base64') && children[0].requests[0].languageCorrection === false);
  await svc.recognize(IMAGE);
  check('helper reused', children.length === 1);
  const stats = svc.getStats();
  check('stats', stats.requests === 2 && stats.failures === 0 && stats.avgMs === 7 && stats.restarts === 0, JSON.stringify(stats));
  const probe = await svc.probe();
  check('probe reports version', probe.available && probe.engine === 'vision' && probe.version === '9.9.9', JSON.stringify(probe));
  svc.dispose();
}

console.log('id correlation');
{
  const held = [];
  const { spawn } = fakeSpawner((req) => held.push(req));
  const svc = createOcrService({ ...base, spawn });
  const a = svc.recognize(IMAGE);
  const b = svc.recognize(IMAGE);
  await sleep(20);
  check('two requests in flight with distinct ids', held.length === 2 && held[0].id !== held[1].id);
  svc.dispose();
  const [ra, rb] = await Promise.all([rejection(a), rejection(b)]);
  check('dispose rejects both with CANCELLED', ra?.code === 'CANCELLED' && rb?.code === 'CANCELLED');
}
{
  const held = [];
  const { spawn, children } = fakeSpawner((req) => held.push(req));
  const svc = createOcrService({ ...base, spawn });
  const a = svc.recognize({ ...IMAGE, jpeg: Buffer.from('image-A') });
  const b = svc.recognize({ ...IMAGE, jpeg: Buffer.from('image-B') });
  await sleep(20);
  for (const req of [...held].reverse()) children[0].send(okReply(req, Buffer.from(req.image, 'base64').toString()));
  const [ra, rb] = await Promise.all([a, b]);
  check('replies in reverse order reach the right caller', ra.lines[0].text === 'image-A' && rb.lines[0].text === 'image-B', `${ra.lines[0].text} ${rb.lines[0].text}`);
  svc.dispose();
}

console.log('helper error reply');
{
  const { spawn } = fakeSpawner((req, c) => c.send({ id: req.id, ok: false, error: { code: 'BAD_REQUEST', message: 'bad image' } }));
  const svc = createOcrService({ ...base, spawn });
  const error = await rejection(svc.recognize(IMAGE));
  check('error reply surfaces code and message', error?.code === 'BAD_REQUEST' && /bad image/.test(error.message));
  check('counted as failure', svc.getStats().failures === 1);
  svc.dispose();
}

console.log('timeout');
{
  const { spawn, children } = fakeSpawner(() => {});
  const svc = createOcrService({ ...base, spawn, requestTimeoutMs: 40 });
  const error = await rejection(svc.recognize(IMAGE));
  check('timeout rejects OCR_FAILED', error?.code === 'OCR_FAILED' && /timed out/.test(error.message));
  await sleep(10);
  check('hung helper killed', children[0].killed);
  svc.dispose();
}
{
  let calls = 0;
  const { spawn, children } = fakeSpawner((req, c) => { calls += 1; if (calls > 1) c.send(okReply(req, 'after-restart')); });
  const svc = createOcrService({ ...base, spawn, requestTimeoutMs: 40 });
  await rejection(svc.recognize(IMAGE));
  const result = await svc.recognize(IMAGE);
  check('next request after timeout uses a fresh helper', children.length === 2 && result.lines[0].text === 'after-restart');
  check('restart counted', svc.getStats().restarts === 1);
  svc.dispose();
}

console.log('crash, restart, restart limit');
{
  const { spawn, children } = fakeSpawner((req, c) => c.crash());
  const svc = createOcrService({ ...base, spawn, visionFallback: async () => 'fallback line' });
  const errors = [];
  for (let i = 0; i < 4; i += 1) errors.push(await rejection(svc.recognize(IMAGE)));
  check('4 crashes each reject in-flight with OCR_FAILED', errors.every((e) => e?.code === 'OCR_FAILED'), errors.map((e) => e?.code).join());
  check('helper respawned 3 times (4 processes)', children.length === 4 && svc.getStats().restarts === 3, `children=${children.length}`);
  const result = await svc.recognize(IMAGE);
  check('after limit, fallback serves requests', result.engine === 'gemini' && result.lines[0].text === 'fallback line');
  check('no further spawn after limit', children.length === 4);
  check('getEngine is fallback', svc.getEngine() === 'fallback');
  svc.dispose();
}
{
  let n = 0;
  const { spawn } = fakeSpawner((req, c) => { n += 1; if (n === 1) c.crash(); else c.send(okReply(req, 'recovered')); });
  const svc = createOcrService({ ...base, spawn });
  const first = await rejection(svc.recognize(IMAGE));
  const second = await svc.recognize(IMAGE);
  check('single crash then recovery', first?.code === 'OCR_FAILED' && second.lines[0].text === 'recovered');
  svc.dispose();
}
{
  const { spawn } = fakeSpawner((req, c) => c.crash());
  const svc = createOcrService({ ...base, spawn });
  let last;
  for (let i = 0; i < 5; i += 1) last = await rejection(svc.recognize(IMAGE));
  check('limit without fallback rejects with a reason', last?.code === 'UNAVAILABLE' && /crashed/.test(last.message), `${last?.code} ${last?.message}`);
  svc.dispose();
}

console.log('abort');
{
  const { spawn, children } = fakeSpawner(() => {});
  const svc = createOcrService({ ...base, spawn });
  const controller = new AbortController();
  const promise = svc.recognize(IMAGE, { signal: controller.signal });
  await sleep(20);
  controller.abort();
  const error = await rejection(promise);
  check('abort rejects CANCELLED', error?.code === 'CANCELLED');
  children[0].send(okReply(children[0].requests[0]));
  const next = svc.recognize(IMAGE);
  await sleep(10);
  children[0].send(okReply(children[0].requests[1], 'next'));
  check('late helper result discarded, service still works', (await next).lines[0].text === 'next');
  check('abort is not counted as failure', svc.getStats().failures === 0);
  const pre = new AbortController();
  pre.abort();
  const early = await rejection(svc.recognize(IMAGE, { signal: pre.signal }));
  check('pre-aborted signal rejects without spawning work', early?.code === 'CANCELLED' && children[0].requests.length === 2);
  svc.dispose();
}

console.log('missing helper and fallback');
{
  let seen;
  const svc = createOcrService({
    ...base, fileExists: () => false,
    visionFallback: async (image, opts) => { seen = opts; return 'line one\n\n  line two  \r\nline three'; }
  });
  const result = await svc.recognize(IMAGE, { sessionId: 's1', regionId: 'r1' });
  check('fallback lines split per non-empty line', result.lines.map((l) => l.text).join('|') === 'line one|  line two  |line three');
  check('fallback lines have null box and 0.5 confidence', result.lines.every((l) => l.box === null && l.confidence === 0.5));
  check('fallback engine defaults to gemini', result.engine === 'gemini');
  check('fallback receives ids', seen.sessionId === 's1' && seen.regionId === 'r1');
  check('getEngine fallback', svc.getEngine() === 'fallback');
  const probe = await svc.probe();
  check('probe explains why vision is off', probe.available === true && probe.engine === 'fallback' && /not found/.test(probe.reason));
  svc.dispose();

  const svc2 = createOcrService({ ...base, platform: 'linux', visionFallback: async () => ({ text: 'x', engine: 'ollama' }) });
  check('non-mac uses fallback and reports its engine', (await svc2.recognize(IMAGE)).engine === 'ollama');
  svc2.dispose();
}

console.log('fallback error mapping');
for (const [message, code] of [
  ['Gemini quota exceeded', 'QUOTA_EXHAUSTED'],
  ['HTTP 429 Too Many Requests', 'QUOTA_EXHAUSTED'],
  ['rate limit hit', 'QUOTA_EXHAUSTED'],
  ['fetch failed', 'NETWORK'],
  ['getaddrinfo ENOTFOUND generativelanguage.googleapis.com', 'NETWORK'],
  ['read ECONNRESET', 'NETWORK'],
  ['connect ETIMEDOUT', 'NETWORK'],
  ['model exploded', 'OCR_FAILED']
]) {
  const svc = createOcrService({ ...base, fileExists: () => false, visionFallback: async () => { throw new Error(message); } });
  const error = await rejection(svc.recognize(IMAGE));
  check(`"${message}" -> ${code}`, error?.code === code, `got ${error?.code}`);
  svc.dispose();
}
{
  const controller = new AbortController();
  const svc = createOcrService({ ...base, fileExists: () => false, visionFallback: () => new Promise(() => {}) });
  const promise = svc.recognize(IMAGE, { signal: controller.signal });
  controller.abort();
  check('abort cancels a hung fallback', (await rejection(promise))?.code === 'CANCELLED');
  svc.dispose();
}

console.log('missing helper without fallback');
{
  const svc = createOcrService({ ...base, fileExists: () => false });
  const error = await rejection(svc.recognize(IMAGE));
  check('UNAVAILABLE with human reason', error?.code === 'UNAVAILABLE' && /not found/.test(error.message), error?.message);
  check('getEngine none', svc.getEngine() === 'none');
  const probe = await svc.probe();
  check('probe unavailable', probe.available === false && probe.engine === 'none' && Boolean(probe.reason));
  svc.dispose();
}

console.log('dispose');
{
  const { spawn, children } = fakeSpawner(() => {});
  const svc = createOcrService({ ...base, spawn });
  const pendingCall = svc.recognize(IMAGE);
  await sleep(20);
  svc.dispose();
  check('in-flight rejected CANCELLED', (await rejection(pendingCall))?.code === 'CANCELLED');
  check('helper killed', children[0].killed);
  check('recognize after dispose rejects CANCELLED', (await rejection(svc.recognize(IMAGE)))?.code === 'CANCELLED');
}

console.log('real Apple Vision integration');
await (async () => {
  if (process.platform !== 'darwin') { console.log('  skipped: not macOS'); return; }
  try { execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }); }
  catch { console.log('  skipped: swiftc not found'); return; }

  const build = buildNativeOcr({ log: () => {} });
  const helper = resolveOcrHelperPath({});
  check('helper built or up to date', fs.existsSync(helper), JSON.stringify(build));

  let selfTest = null;
  try {
    selfTest = JSON.parse(execFileSync(helper, ['--self-test'], { encoding: 'utf8' }));
  } catch (error) {
    check('--self-test exits 0', false, String(error.stdout || error.message));
  }
  if (selfTest) check('--self-test exits 0 and recognises expected text', selfTest.ok === true && selfTest.missing.length === 0);

  const page = [
    'Campus FAQ Bot',
    'Problem Statement',
    'Build a chatbot that answers student questions about the campus.',
    'The bot must read the FAQ list and reply with the closest answer.',
    'Questions are plain English and may contain spelling mistakes.',
    'Return the answer text only, with no extra commentary.',
    '',
    'Constraints',
    'Up to 100 FAQ entries. Each answer is below 200 characters.',
    'Response time should stay under two seconds.',
    '',
    'Test Case 1',
    'Input: What are the library timings?',
    'Expected Output: The library is open from 9 AM to 8 PM.',
    '',
    'Test Case 2',
    'Input: Where is the cafeteria?',
    'Expected Output: Block C, ground floor.',
    '',
    'Starter Code',
    'def answer(question, faq):',
    '    best = None',
    '    for entry in faq:',
    '        score = similarity(question, entry.question)',
    '        if best is None or score > best[0]:',
    '            best = (score, entry.answer)',
    '    return best[1]',
    '',
    'def similarity(a, b):',
    '    a_words = set(a.lower().split())',
    '    b_words = set(b.lower().split())',
    '    return len(a_words & b_words)'
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-ocr-test-'));
  const textFile = path.join(dir, 'page.txt');
  const pngFile = path.join(dir, 'page.png');
  fs.writeFileSync(textFile, `${page.join('\n')}\n`);
  execFileSync(helper, ['--render', pngFile, textFile]);
  const png = fs.readFileSync(pngFile);
  check('--render wrote a PNG', png.length > 1000 && png.subarray(1, 4).toString() === 'PNG');

  const svc = createOcrService({ helperPath: helper, requestTimeoutMs: 30000 });
  const probe = await svc.probe();
  check('real probe available via vision', probe.available && probe.engine === 'vision' && Boolean(probe.version), JSON.stringify(probe));

  // The helper decodes by content, so the PNG bytes go straight in.
  const imageRef = { jpeg: png, mime: 'image/png', width: 0, height: 0 };
  const result = await svc.recognize(imageRef, { sessionId: 'it', regionId: 'page' });
  const again = await svc.recognize(imageRef);
  console.log(`  measured: ${result.lines.length} lines, first call ${result.durationMs} ms, second call ${again.durationMs} ms (helper time)`);
  svc.dispose();

  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const find = (needle) => result.lines.find((l) => norm(l.text).includes(needle));
  for (const needle of ['Campus FAQ Bot', 'Test Case 1', 'Input: What are the library timings?', 'Expected Output: The library is open from 9 AM to 8 PM.', 'def answer(question, faq):', 'return best[1]']) {
    check(`recognised "${needle}"`, Boolean(find(needle)));
  }
  check('engine vision', result.engine === 'vision');
  check('boxes normalized within 0..1', result.lines.every((l) => l.box && l.box.x >= 0 && l.box.y >= 0 && l.box.x + l.box.w <= 1.001 && l.box.y + l.box.h <= 1.001 && l.box.w > 0 && l.box.h > 0));
  const ys = result.lines.map((l) => l.box.y);
  check('lines ordered top to bottom', ys.every((y, i) => i === 0 || y >= ys[i - 1] - 0.005));
  const forLine = find('for entry in faq:');
  const def = find('def answer(question, faq):');
  const ifLine = find('if best is None or score');
  const assign = find('best = (score, entry.answer)');
  check('indented body has larger x than its def', Boolean(forLine && def) && forLine.box.x > def.box.x + 0.01);
  check('deeper indent has larger x than shallower', Boolean(ifLine && forLine) && ifLine.box.x > forLine.box.x + 0.01);
  check('two-level nested line deeper again', Boolean(assign && ifLine) && assign.box.x > ifLine.box.x + 0.01);
  fs.rmSync(dir, { recursive: true, force: true });
})();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(`Failed: ${failures.join('; ')}`); process.exit(1); }
