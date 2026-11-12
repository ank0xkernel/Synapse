#!/usr/bin/env node
/**
 * Desktop conversation history and website sync, end to end: the REAL
 * desktop store and sync engine (src/services/conversations) against the
 * REAL web app (`next start` from web/, local Postgres `synapse_web_test`).
 * The website side is a signed-in cookie client, as a browser would be.
 *
 * Skips (exit 0; exit 1 when REQUIRE_WEB_E2E is set, as in CI) without a
 * web production build or local Postgres.
 *
 * Run: node tests/test-conversation-sync-e2e.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const WEB = path.join(__dirname, '..', 'web');

const { createConversationStore } = require(path.join(__dirname, '../src/services/conversations/conversation-store.js'));
const { createConversationSync } = require(path.join(__dirname, '../src/services/conversations/conversation-sync.js'));
const { toStored, toChatType } = await import(path.join(__dirname, '../src/windows/assistant/renderer/features/conversations/conversation-history.js'));

let passed = 0;
let failed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.stack?.split('\n').slice(0, 3).join('\n      ')}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-conv-'));
const storeAt = (name) => createConversationStore({ filePath: path.join(tmp, name, 'history.json'), writeDelayMs: 0 });
const uuid = () => crypto.randomUUID();

// ─── Local behaviour (no network) ────────────────────────────────────────
await step('chat records map to stored roles; system notices and empty text are not saved', async () => {
  const at = new Date('2026-11-12T10:00:00Z');
  assert(toStored({ id: 'a', type: 'voice-system', content: 'Tell me about yourself', timestamp: at }).role === 'transcript');
  assert(toStored({ id: 'a', type: 'voice-system', content: 'x', timestamp: at }).meta.speaker === 'host');
  assert(toStored({ id: 'a', type: 'voice-mic', content: 'x', timestamp: at }).meta.speaker === 'me');
  assert(toStored({ id: 'a', type: 'ai-response', content: 'x', problemId: 'p1', timestamp: at }).meta.problemId === 'p1');
  assert(toStored({ id: 'a', type: 'system', content: 'Cleared' }) === null);
  assert(toStored({ id: 'a', type: 'active-context', content: 'ctx' }) === null);
  assert(toStored({ id: 'a', type: 'voice-mic', content: '   ' }) === null);
  assert(toChatType({ role: 'assistant', meta: {} }) === 'ai-response');
  assert(toChatType({ role: 'user', meta: {} }) === 'voice-mic', 'web user messages show as "You"');
  assert(toChatType({ role: 'transcript', meta: { speaker: 'host' } }) === 'voice-system');
});

await step('history survives a restart, including the open conversation and the unsynced queue', async () => {
  const a = storeAt('restart');
  a.appendMessage({ role: 'transcript', content: 'Design a rate limiter', meta: { speaker: 'host' } });
  a.appendMessage({ role: 'assistant', content: 'Use a token bucket', meta: { interrupted: true } });
  a.flush();
  const b = storeAt('restart');
  const cur = b.current();
  assert(cur && cur.messages.length === 2, 'open conversation restored');
  assert(cur.title === 'Design a rate limiter', `title from first message, got ${cur.title}`);
  assert(cur.messages[1].meta.interrupted === true, 'interrupted flag kept');
  assert(b.pendingCount() === 3, `1 conversation + 2 messages queued, got ${b.pendingCount()}`);
  b.startNew();
  b.appendMessage({ role: 'transcript', content: 'Second interview' });
  assert(b.list().length === 2, 'clear starts a new conversation and keeps the old one');
});

await step('a corrupt history file is kept aside and the app starts with an empty history', async () => {
  const dir = path.join(tmp, 'corrupt');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'history.json'), '{not json');
  const s = storeAt('corrupt');
  assert(s.list().length === 0);
  assert(fs.readdirSync(dir).some((f) => f.startsWith('history.json.corrupt-')), 'unreadable file preserved for recovery');
});

// ─── Against the real website ────────────────────────────────────────────
if (!fs.existsSync(path.join(WEB, '.next', 'BUILD_ID')) || !fs.existsSync(path.join(WEB, 'node_modules', 'pg'))) {
  console.log(`Conversation sync E2E: website part SKIPPED (no web production build). ${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : process.env.REQUIRE_WEB_E2E ? 1 : 0);
}
const { startServer, signup } = await import(path.join(WEB, 'tests', 'helpers.mjs'));
let S;
try {
  S = await startServer();
} catch (error) {
  console.log(`Conversation sync E2E: website part SKIPPED (${error.message.split('\n')[0]}). ${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : process.env.REQUIRE_WEB_E2E ? 1 : 0);
}

const web = await signup(S.base, 'sync-e2e@example.com');
const token = (await web.json('POST', '/api/device-tokens', { name: 'E2E Mac' })).data.token;
const me = await (await fetch(`${S.base}/api/desktop/v1/me`, { headers: { authorization: `Bearer ${token}` } })).json();

let offline = false;
let loseNextResponse = false;
const remote = {
  linked: () => true,
  accountId: () => me.account.id,
  async fetch(p, options = {}) {
    if (offline) throw new TypeError('fetch failed');
    const response = await fetch(`${S.base}${p}`, { ...options, headers: { ...(options.headers || {}), authorization: `Bearer ${token}` } });
    if (loseNextResponse) { loseNextResponse = false; throw new TypeError('fetch failed'); } // the server did the work; the answer is lost
    return response;
  }
};

const store = storeAt('desktop');
const remoteChanges = [];
const sync = createConversationSync({
  store,
  remote,
  onRemoteChange: (c) => remoteChanges.push(c),
  setTimer: () => 0, clearTimer: () => {}, setRepeat: () => 0, clearRepeat: () => {} // tests drive syncNow() directly
});

let convId;
await step('offline: messages stay queued on this Mac and the status says so', async () => {
  offline = true;
  store.appendMessage({ role: 'transcript', content: 'What is consistent hashing?', meta: { speaker: 'host' }, createdAt: new Date(Date.now() - 3000) });
  store.appendMessage({ role: 'assistant', content: 'A ring of hash slots...', meta: { type: 'ai-response' }, createdAt: new Date(Date.now() - 2000) });
  convId = store.current().id;
  const status = await sync.syncNow();
  assert(status.state === 'offline', `state ${status.state}`);
  assert(status.pending === 3, `pending ${status.pending}`);
});

await step('back online: the queue is pushed and the website shows the conversation in order', async () => {
  offline = false;
  const status = await sync.syncNow();
  assert(status.state === 'synced', `state ${status.state}: ${status.error}`);
  assert(status.pending === 0, `pending ${status.pending}`);
  const got = await web.json('GET', `/api/conversations/${convId}`);
  assert(got.status === 200, `web GET ${got.status}`);
  assert(got.data.conversation.title === 'What is consistent hashing?');
  assert(got.data.messages.map((m) => m.role).join(',') === 'transcript,assistant');
});

await step('a push whose response was lost is resent without duplicating anything', async () => {
  store.appendMessage({ role: 'transcript', content: 'Follow-up: virtual nodes?', meta: { speaker: 'host' } });
  loseNextResponse = true;
  const failedRun = await sync.syncNow();
  assert(failedRun.state === 'offline', `state ${failedRun.state}`);
  const ok = await sync.syncNow();
  assert(ok.state === 'synced', `state ${ok.state}`);
  const got = await web.json('GET', `/api/conversations/${convId}`);
  assert(got.data.messages.length === 3, `expected 3 messages on the web, got ${got.data.messages.length}`);
});

await step('a message written on the website reaches the open desktop conversation', async () => {
  // No GEMINI_API_KEY in tests: the user message is stored and the reply is a 503.
  const r = await web.json('POST', `/api/conversations/${convId}/messages`, { id: uuid(), content: 'Typed on the website' });
  assert(r.status === 503, `send ${r.status}`);
  remoteChanges.length = 0;
  await sync.syncNow();
  const added = remoteChanges.flatMap((c) => c.addedToCurrent);
  assert(added.some((m) => m.content === 'Typed on the website' && m.role === 'user'), 'shown in the open conversation');
  assert(store.current().messages.length === 4);
});

await step('renames travel both ways and the later one wins', async () => {
  store.rename(convId, 'Renamed on desktop');
  await sync.syncNow();
  assert((await web.json('GET', `/api/conversations/${convId}`)).data.conversation.title === 'Renamed on desktop');
  await new Promise((r) => setTimeout(r, 20));
  await web.json('PATCH', `/api/conversations/${convId}`, { title: 'Renamed on web' });
  await sync.syncNow();
  assert(store.get(convId).title === 'Renamed on web', `desktop title ${store.get(convId).title}`);
});

await step('the answer style chosen on the desktop is saved to the account', async () => {
  store.queueSettings({ responseMode: 'star' });
  await sync.syncNow();
  const prefs = await web.json('GET', '/api/preferences');
  assert(prefs.data.settings.responseMode === 'star', JSON.stringify(prefs.data));
});

await step('a delete on the website removes the conversation from the desktop', async () => {
  await web.json('DELETE', `/api/conversations/${convId}`);
  remoteChanges.length = 0;
  await sync.syncNow();
  assert(store.get(convId) === null, 'gone locally');
  assert(remoteChanges.some((c) => c.currentDeleted), 'the open conversation is reported deleted');
  assert(store.current() === null);
});

await step('a delete on the desktop removes it from the website', async () => {
  store.appendMessage({ role: 'transcript', content: 'Short-lived' });
  const id = store.current().id;
  await sync.syncNow();
  assert((await web.json('GET', `/api/conversations/${id}`)).status === 200);
  store.remove(id);
  await sync.syncNow();
  assert((await web.json('GET', `/api/conversations/${id}`)).status === 404);
});

await step('a conversation started on the website appears in desktop history', async () => {
  const id = uuid();
  await web.json('POST', `/api/conversations/${id}/messages`, { id: uuid(), content: 'Started on the web' });
  await sync.syncNow();
  const c = store.get(id);
  assert(c && c.source === 'web' && c.messages.length === 1, JSON.stringify(c));
  store.flush();
  const fresh = storeAt('desktop');
  assert(fresh.get(id), 'and is on disk after a restart');
});

await step('a revoked device token stops sync with a clear message and keeps the queue', async () => {
  const id = (await web.json('GET', '/api/device-tokens')).data?.tokens?.[0]?.id
    ?? (await S.db.query('SELECT id FROM device_tokens WHERE name = $1', ['E2E Mac'])).rows[0].id;
  await web.json('DELETE', `/api/device-tokens/${id}`);
  store.appendMessage({ role: 'transcript', content: 'After revoke' });
  const status = await sync.syncNow();
  assert(status.state === 'auth-expired', `state ${status.state}`);
  assert(status.pending > 0, 'queue kept for after relinking');
});

await S.stop();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nConversation sync E2E: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed ? 1 : 0);
