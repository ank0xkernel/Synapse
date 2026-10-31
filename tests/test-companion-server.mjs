#!/usr/bin/env node
/**
 * Companion server: opt-in start, TOTP login, per-phone sessions, WebSocket
 * limits and the bounded live-state snapshot. Starts the real server on
 * loopback with stub dependencies.
 *
 * Run: node tests/test-companion-server.mjs
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMobileServer } = require('../src/main-process/features/mobile-server/server.js');
const WebSocket = require('ws');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.stack || error.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const clock = { t: 1_700_000_000_000 };
const servers = [];
let codeCounter = 0;

/** Stub passcode check: any 6-digit code starting with 1 is "correct". */
const stubTotp = { verifyToken: (code) => /^1\d{5}$/.test(String(code)) };
const nextCode = () => String(100000 + (codeCounter += 1));

function makeServer(overrides = {}) {
  const store = { value: false, saves: [] };
  const desktopCalls = [];
  const server = createMobileServer({
    getGeminiRuntime: () => null,
    getScreenshotManager: () => ({ getScreenshotsCount: () => 0, hasScreenshots: () => false }),
    notifyDesktop: (channel, data) => {
      desktopCalls.push({ channel, data });
      // editorResult is a factory so a rejection is created only when the
      // server actually calls it (an eager Promise.reject is unhandled).
      if (channel === 'send-answer-to-editor') return overrides.editorResult ? overrides.editorResult() : Promise.resolve({ method: 'keyboard', chars: data.text.length });
      return undefined;
    },
    enabledStore: { load: () => store.value, save: (v) => { store.value = v; store.saves.push(v); } },
    getAddresses: () => [{ name: 'lo0', address: '127.0.0.1', virtual: false }],
    port: overrides.port ?? 0,
    totp: stubTotp,
    now: () => clock.t,
    heartbeatMs: overrides.heartbeatMs ?? 20000
  });
  servers.push(server);
  return { server, store, desktopCalls };
}

async function enabled(overrides) {
  const ctx = makeServer(overrides);
  await ctx.server.setEnabled(true);
  ctx.base = `http://127.0.0.1:${ctx.server.getStatus().port}`;
  return ctx;
}

async function login(ctx, code = nextCode()) {
  const res = await fetch(`${ctx.base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: code })
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const get = (ctx, path, token) => fetch(`${ctx.base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

function connect(ctx, token, { urlToken = false } = {}) {
  const url = `ws://127.0.0.1:${ctx.server.getStatus().port}/${urlToken ? `?token=${token}` : ''}`;
  const ws = urlToken || !token ? new WebSocket(url) : new WebSocket(url, ['synapse.v1', `synapse.auth.${token}`]);
  const msgs = [];
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  ws.on('message', (raw) => msgs.push(JSON.parse(raw.toString())));
  const opened = new Promise((resolve, reject) => {
    ws.on('open', () => resolve(true));
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('error', () => resolve(false));
  });
  const waitFor = async (pred, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = msgs.find(pred);
      if (hit) return hit;
      await sleep(10);
    }
    throw new Error('timed out waiting for message');
  };
  return { ws, msgs, closed, opened, waitFor };
}

console.log('companion server');

await test('disabled by default: nothing listens (connection refused)', async () => {
  const port = await freePort();
  const { server } = makeServer({ port });
  const st = server.getStatus();
  assert.equal(st.enabled, false);
  assert.equal(st.listening, false);
  assert.equal(server.isEnabled, false);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`), /fetch failed/);
});

await test('enabling persists the choice, listens on the chosen address only, URLs carry no token', async () => {
  const ctx = await enabled();
  const st = ctx.server.getStatus();
  assert.equal(ctx.store.saves.at(-1), true);
  assert.equal(st.listening, true);
  assert.equal(st.enabled, true);
  assert.deepEqual(st.urls.map((u) => u.address), ['127.0.0.1']);
  assert.ok(!/token|\?/.test(JSON.stringify(st)), 'status leaked a token or query');
  const html = await get(ctx, '/');
  assert.equal(html.status, 200);
  assert.ok((await html.text()).includes('Synapse'));
});

await test('wrong passcode -> 401, then rate limited (429); window frees after a minute', async () => {
  const ctx = await enabled();
  const first = await login(ctx, '999999');
  assert.equal(first.status, 401);
  assert.equal(first.body.sessionToken, undefined);
  for (let i = 0; i < 9; i += 1) await login(ctx, '999999');
  assert.equal((await login(ctx, '999999')).status, 429);
  clock.t += 61_000;
  assert.equal((await login(ctx)).status, 200);
});

await test('correct passcode -> session token; code is single-use; a bearer is not a passcode', async () => {
  const ctx = await enabled();
  const code = nextCode();
  const ok = await login(ctx, code);
  assert.equal(ok.status, 200);
  assert.match(ok.body.sessionToken, /^[0-9a-f]{64}$/);
  assert.equal((await login(ctx, code)).status, 401, 'replayed code accepted');
  assert.equal((await login(ctx, ok.body.sessionToken)).status, 401);
});

await test('every route needs the session; token in the URL is ignored; token never appears in status', async () => {
  const ctx = await enabled();
  const { body } = await login(ctx);
  assert.equal((await get(ctx, '/api/logs')).status, 401);
  assert.equal((await get(ctx, `/api/logs?token=${body.sessionToken}`)).status, 401);
  assert.equal((await get(ctx, '/api/logs', body.sessionToken)).status, 200);
  assert.ok(!JSON.stringify(ctx.server.getStatus()).includes(body.sessionToken));
  const redirect = await fetch(`${ctx.base}/dashboard?token=abc`, { redirect: 'manual' });
  assert.equal(redirect.headers.get('location'), '/');
});

await test('WebSocket upgrade: rejected without token and with ?token=, accepted with session', async () => {
  const ctx = await enabled();
  const { body } = await login(ctx);
  assert.equal(await connect(ctx, '').opened, 401);
  assert.equal(await connect(ctx, body.sessionToken, { urlToken: true }).opened, 401);
  const good = connect(ctx, body.sessionToken);
  assert.equal(await good.opened, true);
  const snap = await good.waitFor((m) => m.type === 'snapshot');
  assert.equal(typeof snap.seq, 'number');
  assert.equal(typeof snap.ts, 'number');
  good.ws.close();
});

await test('snapshot on connect reflects prior broadcasts (not event history)', async () => {
  const ctx = await enabled();
  const { body } = await login(ctx);
  const s = ctx.server;
  s.broadcast('vosk-status', { source: 'system', status: 'listening' });
  s.broadcast('vosk-final', { source: 'system', text: 'x'.repeat(900) });
  s.broadcast('ai-stream-start', { actionId: 'askAi' });
  s.broadcast('ai-stream-chunk', { actionId: 'askAi', text: 'Hello ', index: 0 });
  s.broadcast('ai-stream-chunk', { actionId: 'askAi', text: 'world', index: 1 });
  s.broadcast('ai-stream-end', { actionId: 'askAi' });
  s.broadcast('mic-state', { enabled: true });
  s.broadcast('screenshot-taken-stealth', { count: 3 });
  s.broadcast('settings-secret', { geminiApiKey: 'nope' });
  const c = connect(ctx, body.sessionToken);
  await c.opened;
  const snap = await c.waitFor((m) => m.type === 'snapshot');
  assert.equal(snap.data.answer.text, 'Hello world');
  assert.equal(snap.data.answer.status, 'done');
  assert.ok(snap.data.answer.streamId);
  assert.equal(snap.data.lastQuestion.length, 500);
  assert.equal(snap.data.listening.system, 'listening');
  assert.equal(snap.data.mic, true);
  assert.equal(c.msgs.length, 1, 'only the snapshot, no replayed events');
  assert.ok(!JSON.stringify(snap).includes('nope'));
  c.ws.close();
});

await test('stale/foreign stream events are dropped; new answer supersedes the old', async () => {
  const ctx = await enabled();
  const { body } = await login(ctx);
  const c = connect(ctx, body.sessionToken);
  await c.opened;
  await c.waitFor((m) => m.type === 'snapshot');
  const s = ctx.server;

  s.broadcast('ai-stream-chunk', { actionId: 'askAi', text: 'orphan' }); // no stream open
  s.broadcast('ai-stream-start', { actionId: 'suggest' });               // not a live answer
  s.broadcast('ai-stream-start', { actionId: 'askAi' });
  const firstId = s.getSnapshot().answer.streamId;
  s.broadcast('ai-stream-chunk', { actionId: 'askAi', text: 'A' });
  s.broadcast('ai-stream-chunk', { actionId: 'askAi', text: 'stale', streamId: 'bogus' });
  s.broadcast('ai-stream-start', { actionId: 'askAi' }); // newer answer
  const secondId = s.getSnapshot().answer.streamId;
  assert.notEqual(firstId, secondId);
  s.broadcast('ai-stream-chunk', { actionId: 'askAi', text: 'late', streamId: firstId });
  s.broadcast('ai-stream-chunk', { actionId: 'askAi', text: 'B' });
  s.broadcast('ai-stream-end', { actionId: 'askAi' });
  s.broadcast('ai-stream-chunk', { actionId: 'askAi', text: 'after-end' });

  await c.waitFor((m) => m.type === 'ai-stream-end');
  const answer = s.getSnapshot().answer;
  assert.equal(answer.text, 'B');
  assert.equal(answer.status, 'done');
  const texts = c.msgs.filter((m) => m.type === 'ai-stream-chunk').map((m) => m.data.text).join('');
  assert.equal(texts, 'AB');
  const seqs = c.msgs.map((m) => m.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'seq must be monotonic');
  assert.ok(c.msgs.filter((m) => m.type === 'ai-stream-start').every((m) => m.data.streamId));
  c.ws.close();
});

await test('answer chunks are batched to <= 1 send per 50 ms without losing text', async () => {
  const ctx = await enabled();
  const { body } = await login(ctx);
  const c = connect(ctx, body.sessionToken);
  await c.opened;
  await c.waitFor((m) => m.type === 'snapshot');
  ctx.server.broadcast('ai-stream-start', { actionId: 'askAi' });
  for (let i = 0; i < 100; i += 1) ctx.server.broadcast('ai-stream-chunk', { actionId: 'askAi', text: `${i},` });
  ctx.server.broadcast('ai-stream-end', { actionId: 'askAi' });
  await c.waitFor((m) => m.type === 'ai-stream-end');
  const chunks = c.msgs.filter((m) => m.type === 'ai-stream-chunk');
  assert.ok(chunks.length <= 3, `expected coalescing, got ${chunks.length} sends`);
  const joined = chunks.map((m) => m.data.text).join('');
  assert.equal(joined, Array.from({ length: 100 }, (_, i) => `${i},`).join(''));
  c.ws.close();
});

await test('answer text in the snapshot is capped at 16 KB', async () => {
  const ctx = await enabled();
  ctx.server.broadcast('ai-stream-start', { actionId: 'askAi' });
  for (let i = 0; i < 40; i += 1) ctx.server.broadcast('ai-stream-chunk', { actionId: 'askAi', text: 'y'.repeat(1000) });
  const a = ctx.server.getSnapshot().answer;
  assert.equal(a.text.length, 16 * 1024);
  assert.equal(a.truncated, true);
});

await test('5th socket is rejected with close code 1013', async () => {
  const ctx = await enabled();
  const { body } = await login(ctx);
  const open = [];
  for (let i = 0; i < 4; i += 1) {
    const c = connect(ctx, body.sessionToken);
    assert.equal(await c.opened, true);
    await c.waitFor((m) => m.type === 'snapshot');
    open.push(c);
  }
  const fifth = connect(ctx, body.sessionToken);
  await fifth.opened;
  assert.equal(await fifth.closed, 1013);
  assert.equal(ctx.server.getStatus().clientCount, 4);
  open.forEach((c) => c.ws.close());
});

await test('oversized WebSocket message closes the socket (1009)', async () => {
  const ctx = await enabled();
  const { body } = await login(ctx);
  const c = connect(ctx, body.sessionToken);
  await c.opened;
  await c.waitFor((m) => m.type === 'snapshot');
  c.ws.send(JSON.stringify({ type: 'ask-ai', contextString: 'z'.repeat(70 * 1024) }));
  assert.equal(await c.closed, 1009);
});

await test('logout revokes the session and closes its sockets', async () => {
  const ctx = await enabled();
  const { body } = await login(ctx);
  const other = (await login(ctx)).body.sessionToken;
  const c = connect(ctx, body.sessionToken);
  await c.opened;
  await c.waitFor((m) => m.type === 'snapshot');
  const res = await fetch(`${ctx.base}/api/logout`, { method: 'POST', headers: { Authorization: `Bearer ${body.sessionToken}` } });
  assert.equal(res.status, 200);
  assert.equal(await c.closed, 1008);
  assert.equal((await get(ctx, '/api/logs', body.sessionToken)).status, 401);
  assert.equal((await get(ctx, '/api/logs', other)).status, 200, 'logout must only end the caller');
});

await test('sessions expire: 60 min idle and 12 h absolute', async () => {
  const ctx = await enabled();
  const idle = (await login(ctx)).body.sessionToken;
  clock.t += 59 * 60_000;
  assert.equal((await get(ctx, '/api/logs', idle)).status, 200); // refreshes idle timer
  clock.t += 61 * 60_000;
  assert.equal((await get(ctx, '/api/logs', idle)).status, 401);

  const long = (await login(ctx)).body.sessionToken;
  let last = 200;
  for (let i = 0; i < 14 && last === 200; i += 1) {
    clock.t += 55 * 60_000;
    last = (await get(ctx, '/api/logs', long)).status;
  }
  assert.equal(last, 401, 'session outlived 12 h');
});

await test('expired session closes its open socket on sweep', async () => {
  const ctx = await enabled();
  const { body } = await login(ctx);
  const c = connect(ctx, body.sessionToken);
  await c.opened;
  await c.waitFor((m) => m.type === 'snapshot');
  clock.t += 61 * 60_000;
  ctx.server.sweep();
  assert.equal(await c.closed, 1008);
});

await test('at most 4 sessions; the oldest is evicted', async () => {
  const ctx = await enabled();
  const tokens = [];
  for (let i = 0; i < 5; i += 1) {
    clock.t += 1000;
    tokens.push((await login(ctx)).body.sessionToken);
  }
  assert.equal((await get(ctx, '/api/logs', tokens[0])).status, 401);
  for (const t of tokens.slice(1)) assert.equal((await get(ctx, '/api/logs', t)).status, 200);
});

await test('send-to-editor: error ack with no answer, ok ack after the desktop inserts, error when it fails', async () => {
  const ctx = await enabled();
  const { body } = await login(ctx);
  const c = connect(ctx, body.sessionToken);
  await c.opened;
  await c.waitFor((m) => m.type === 'snapshot');

  c.ws.send(JSON.stringify({ type: 'send-answer-to-editor' }));
  const none = await c.waitFor((m) => m.type === 'editor-result');
  assert.equal(none.data.ok, false);
  assert.match(none.data.error, /No answer/);
  assert.equal(ctx.desktopCalls.filter((d) => d.channel === 'send-answer-to-editor').length, 0);

  ctx.server.broadcast('ai-stream-start', { actionId: 'askAi' });
  ctx.server.broadcast('ai-stream-chunk', { actionId: 'askAi', text: 'return 42;' });
  c.ws.send(JSON.stringify({ type: 'send-answer-to-editor' }));
  const mid = await c.waitFor((m) => m.type === 'editor-result' && m !== none);
  assert.equal(mid.data.ok, false, 'must not send a half-written answer');

  ctx.server.broadcast('ai-stream-end', { actionId: 'askAi' });
  c.msgs.length = 0;
  c.ws.send(JSON.stringify({ type: 'send-answer-to-editor' }));
  const ok = await c.waitFor((m) => m.type === 'editor-result');
  assert.equal(ok.data.ok, true);
  const call = ctx.desktopCalls.find((d) => d.channel === 'send-answer-to-editor');
  assert.equal(call.data.text, 'return 42;');
  c.ws.close();

  const failing = await enabled({ editorResult: () => Promise.reject(new Error('Accessibility permission is required')) });
  failing.server.broadcast('ai-stream-start', { actionId: 'askAi' });
  failing.server.broadcast('ai-stream-chunk', { actionId: 'askAi', text: 'x' });
  failing.server.broadcast('ai-stream-end', { actionId: 'askAi' });
  const f = connect(failing, (await login(failing)).body.sessionToken);
  await f.opened;
  await f.waitFor((m) => m.type === 'snapshot');
  f.ws.send(JSON.stringify({ type: 'send-answer-to-editor' }));
  const bad = await f.waitFor((m) => m.type === 'editor-result');
  assert.equal(bad.data.ok, false);
  assert.match(bad.data.error, /Accessibility/);
  f.ws.close();
});

await test('failed answers are recorded as failed, vosk-error/stopped reach the snapshot', async () => {
  const ctx = await enabled();
  const s = ctx.server;
  s.broadcast('ai-stream-start', { actionId: 'askAi' });
  s.broadcast('error', { message: 'quota' });
  s.broadcast('ai-stream-end', { actionId: 'askAi' });
  assert.equal(s.getSnapshot().answer.status, 'failed');
  s.broadcast('vosk-status', { source: 'system', status: 'listening' });
  s.broadcast('vosk-stopped', { source: 'system' });
  assert.equal(s.getSnapshot().listening.system, 'stopped');
  s.broadcast('vosk-error', { source: 'system', error: 'key rejected', kind: 'auth', permanent: true });
  assert.equal(s.getSnapshot().listening.system, 'error');
  assert.equal(s.getSnapshot().errors.system.error, 'key rejected');
  s.broadcast('history', { items: Array.from({ length: 30 }, (_, i) => ({ question: `q${i}`, answer: 'a' })) });
  assert.equal(s.getSnapshot().history.length, 10);
});

await test('heartbeat terminates a peer that never answers pings', async () => {
  const ctx = await enabled({ heartbeatMs: 30 });
  const { body } = await login(ctx);
  const c = connect(ctx, body.sessionToken);
  await c.opened;
  await c.waitFor((m) => m.type === 'snapshot');
  c.ws.pong = () => {}; // never answer
  c.ws._receiver.removeAllListeners('ping');
  c.ws.on('ping', () => {});
  await Promise.race([c.closed, sleep(1500).then(() => { throw new Error('socket not terminated'); })]);
});

await test('stop() closes sockets, invalidates sessions and stops listening; restart needs a fresh login', async () => {
  const ctx = await enabled();
  const { body } = await login(ctx);
  const c = connect(ctx, body.sessionToken);
  await c.opened;
  await c.waitFor((m) => m.type === 'snapshot');
  const port = ctx.server.getStatus().port;
  ctx.server.stop();
  await c.closed;
  assert.equal(ctx.server.getStatus().listening, false);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
  await ctx.server.start();
  const base2 = `http://127.0.0.1:${ctx.server.getStatus().port}`;
  const res = await fetch(`${base2}/api/logs`, { headers: { Authorization: `Bearer ${body.sessionToken}` } });
  assert.equal(res.status, 401);
});

await test('revokeSessions() drops every phone but leaves the server listening', async () => {
  const ctx = await enabled();
  const { body } = await login(ctx);
  const c = connect(ctx, body.sessionToken);
  await c.opened;
  await c.waitFor((m) => m.type === 'snapshot');
  ctx.server.revokeSessions();
  assert.equal(await c.closed, 1008);
  assert.equal(ctx.server.getStatus().listening, true);
  assert.equal((await get(ctx, '/api/logs', body.sessionToken)).status, 401);
});

await test('persisted enabled flag starts the server on creation; disabling persists false', async () => {
  const port = await freePort();
  const store = { value: true };
  const server = createMobileServer({
    getGeminiRuntime: () => null,
    getScreenshotManager: () => null,
    notifyDesktop: () => {},
    enabledStore: { load: () => store.value, save: (v) => { store.value = v; } },
    getAddresses: () => [{ name: 'lo0', address: '127.0.0.1' }],
    port,
    totp: stubTotp
  });
  servers.push(server);
  for (let i = 0; i < 50 && !server.getStatus().listening; i += 1) await sleep(20);
  assert.equal(server.getStatus().listening, true);
  await server.setEnabled(false);
  assert.equal(store.value, false);
  assert.equal(server.getStatus().listening, false);
});

for (const s of servers) s.stop();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
