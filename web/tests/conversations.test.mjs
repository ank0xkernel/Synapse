import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { signup, startServer } from './helpers.mjs';

const uuid = () => crypto.randomUUID();

/** Stand-in for the Gemini REST API: records prompts, answers with a fixed text, or fails on demand. */
function startFakeGemini() {
  const state = { calls: [], fail: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      state.calls.push(body);
      if (state.fail) {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: `reply #${state.calls.length}` }], role: 'model' }, finishReason: 'STOP' }] }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, state })));
}

async function deviceToken(c) {
  const r = await c.json('POST', '/api/device-tokens', { name: 'Test Mac' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.token;
}

describe('without GEMINI_API_KEY', () => {
  let S;
  before(async () => { S = await startServer(); });
  after(async () => { await S?.stop(); });

  test('the message is saved, the reply is a clear 503, and no empty assistant row exists', async () => {
    const c = await signup(S.base, 'nokey@example.com');
    const id = uuid();
    const msg = uuid();
    const r = await c.json('POST', `/api/conversations/${id}/messages`, { id: msg, content: 'Hello there' });
    assert.equal(r.status, 503);
    assert.match(r.data.error, /GEMINI_API_KEY/);
    assert.match(r.data.error, /saved/);
    const got = await c.json('GET', `/api/conversations/${id}`);
    assert.equal(got.status, 200);
    assert.equal(got.data.conversation.title, 'Hello there');
    assert.deepEqual(got.data.messages.map((m) => [m.id, m.role]), [[msg, 'user']]);
  });
});

describe('conversations and desktop sync', () => {
  let S; let fake; let a; let b; let tokenA;
  before(async () => {
    fake = await startFakeGemini();
    S = await startServer({ GEMINI_API_KEY: 'test-key-not-real', GEMINI_BASE_URL: `http://127.0.0.1:${fake.server.address().port}` });
    a = await signup(S.base, 'conv-a@example.com');
    b = await signup(S.base, 'conv-b@example.com');
    tokenA = await deviceToken(a);
  });
  after(async () => { await S?.stop(); fake?.server.close(); });

  const dev = (method, path, body, token = tokenA) =>
    fetch(`${S.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

  test('sending creates the conversation, stores both sides, and a retry does not duplicate or re-ask', async () => {
    const id = uuid();
    const msg = uuid();
    const first = await a.json('POST', `/api/conversations/${id}/messages`, { id: msg, content: 'What is a B-tree?' });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.reply.role, 'assistant');
    assert.equal(first.data.reply.content, 'reply #1');
    assert.match(fake.state.calls[0], /What is a B-tree\?/);

    const retry = await a.json('POST', `/api/conversations/${id}/messages`, { id: msg, content: 'What is a B-tree?' });
    assert.equal(retry.status, 200);
    assert.equal(retry.data.reply.id, first.data.reply.id);
    assert.equal(fake.state.calls.length, 1, 'a retry must not call the AI again');

    const got = await a.json('GET', `/api/conversations/${id}`);
    assert.deepEqual(got.data.messages.map((m) => m.role), ['user', 'assistant']);
  });

  test('a provider failure keeps the user message; Retry then answers it once', async () => {
    const id = uuid();
    const msg = uuid();
    fake.state.fail = true;
    const failed = await a.json('POST', `/api/conversations/${id}/messages`, { id: msg, content: 'Explain CAP' });
    fake.state.fail = false;
    assert.equal(failed.status, 502);
    assert.match(failed.data.error, /saved/);
    const ok = await a.json('POST', `/api/conversations/${id}/messages`, { id: msg, content: 'Explain CAP' });
    assert.equal(ok.status, 200);
    const got = await a.json('GET', `/api/conversations/${id}`);
    assert.deepEqual(got.data.messages.map((m) => m.role), ['user', 'assistant']);
  });

  test('the prompt carries earlier turns of the conversation', async () => {
    const id = uuid();
    await a.json('POST', `/api/conversations/${id}/messages`, { id: uuid(), content: 'My name is Ada' });
    await a.json('POST', `/api/conversations/${id}/messages`, { id: uuid(), content: 'What is my name?' });
    const last = fake.state.calls.at(-1);
    assert.match(last, /My name is Ada/);
    assert.match(last, /What is my name\?/);
  });

  test('another account cannot read, rename, delete or append to a conversation', async () => {
    const id = uuid();
    await a.json('POST', `/api/conversations/${id}/messages`, { id: uuid(), content: 'private' });
    assert.equal((await b.json('GET', `/api/conversations/${id}`)).status, 404);
    assert.equal((await b.json('PATCH', `/api/conversations/${id}`, { title: 'pwned' })).status, 404);
    assert.equal((await b.json('DELETE', `/api/conversations/${id}`)).status, 404);
    const hijack = await b.json('POST', `/api/conversations/${id}/messages`, { id: uuid(), content: 'inject' });
    assert.equal(hijack.status, 404);
    const got = await a.json('GET', `/api/conversations/${id}`);
    assert.ok(!got.data.messages.some((m) => m.content === 'inject'));
    assert.ok(!(await b.json('GET', '/api/conversations')).data.conversations.some((c) => c.id === id));
  });

  test('a message id already used in another conversation is refused, never answered against an empty history', async () => {
    const msg = uuid();
    await a.json('POST', `/api/conversations/${uuid()}/messages`, { id: msg, content: 'first use' });
    const calls = fake.state.calls.length;
    const reused = await a.json('POST', `/api/conversations/${uuid()}/messages`, { id: msg, content: 'second use' });
    assert.equal(reused.status, 409, JSON.stringify(reused.data));
    assert.equal(fake.state.calls.length, calls, 'the AI was asked without the user turn');
  });

  test('AI replies are rate limited per account (10 a minute); the message is still saved', async () => {
    const c = await signup(S.base, 'conv-rate@example.com');
    const id = uuid();
    for (let i = 0; i < 10; i += 1) {
      const r = await c.json('POST', `/api/conversations/${id}/messages`, { id: uuid(), content: `question ${i}` });
      assert.equal(r.status, 200, JSON.stringify(r.data));
    }
    const msg = uuid();
    const limited = await c.json('POST', `/api/conversations/${id}/messages`, { id: msg, content: 'one too many' });
    assert.equal(limited.status, 429);
    assert.match(limited.data.error, /saved/);
    const got = await c.json('GET', `/api/conversations/${id}`);
    assert.ok(got.data.messages.some((m) => m.id === msg), 'the limited message was not saved');
    const other = await b.json('POST', `/api/conversations/${uuid()}/messages`, { id: uuid(), content: 'still allowed' });
    assert.equal(other.status, 200, 'one account\'s limit blocked another account');
  });

  test('cookie mutations from another origin are refused; sync refuses a missing or bad token', async () => {
    const r = await a.json('POST', `/api/conversations/${uuid()}/messages`, { id: uuid(), content: 'x' }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    assert.equal((await dev('GET', '/api/desktop/v1/sync', undefined, 'syn_' + 'x'.repeat(40))).status, 401);
    const noAuth = await fetch(`${S.base}/api/desktop/v1/sync`);
    assert.equal(noAuth.status, 401);
  });

  test('desktop push appears on the web, web edits reach the desktop, deletes win', async () => {
    const conv = uuid();
    const m1 = uuid(); const m2 = uuid();
    const t0 = new Date(Date.now() - 60_000).toISOString();
    const push = {
      conversations: [{ id: conv, title: 'Desktop session', created_at: t0, edited_at: t0 }],
      messages: [
        { id: m2, conversation_id: conv, role: 'assistant', content: 'answer', meta: { type: 'ai-response' }, created_at: new Date(Date.now() - 50_000).toISOString() },
        { id: m1, conversation_id: conv, role: 'transcript', content: 'question', meta: { speaker: 'host' }, created_at: new Date(Date.now() - 55_000).toISOString() }
      ]
    };
    const p = await dev('POST', '/api/desktop/v1/sync', push);
    assert.equal(p.status, 200, JSON.stringify(p.data));
    assert.equal(p.data.inserted, 2);
    // Resending the same batch (desktop timed out before reading the answer) changes nothing.
    assert.equal((await dev('POST', '/api/desktop/v1/sync', push)).data.inserted, 0);

    const web = await a.json('GET', `/api/conversations/${conv}`);
    assert.deepEqual(web.data.messages.map((m) => m.id), [m1, m2], 'ordered by when they were written, not by batch order');
    assert.equal(web.data.conversation.source, 'desktop');

    // Desktop's first pull, then a rename on the web shows up in the next pull.
    const first = await dev('GET', '/api/desktop/v1/sync');
    assert.equal(first.status, 200);
    assert.ok(first.data.conversations.some((c) => c.id === conv));
    assert.ok(first.data.messages.some((m) => m.id === m1));
    await a.json('PATCH', `/api/conversations/${conv}`, { title: 'Renamed on web' });
    const second = await dev('GET', `/api/desktop/v1/sync?cursor=${encodeURIComponent(first.data.cursor)}`);
    assert.equal(second.data.conversations.find((c) => c.id === conv)?.title, 'Renamed on web');

    // An older offline rename from the desktop does not overwrite the newer web rename.
    await dev('POST', '/api/desktop/v1/sync', { conversations: [{ id: conv, title: 'Stale desktop title', edited_at: t0 }] });
    assert.equal((await a.json('GET', `/api/conversations/${conv}`)).data.conversation.title, 'Renamed on web');

    // Delete on the web: the desktop's next pull carries the tombstone, content is gone,
    // and a late desktop append to the deleted conversation is dropped.
    await a.json('DELETE', `/api/conversations/${conv}`);
    const third = await dev('GET', `/api/desktop/v1/sync?cursor=${encodeURIComponent(second.data.cursor)}`);
    const tomb = third.data.conversations.find((c) => c.id === conv);
    assert.ok(tomb?.deleted_at, 'tombstone is sent');
    const late = await dev('POST', '/api/desktop/v1/sync', { messages: [{ id: uuid(), conversation_id: conv, role: 'user', content: 'late', meta: {} }] });
    assert.equal(late.data.inserted, 0);
    assert.equal((await a.json('GET', `/api/conversations/${conv}`)).status, 404);
    const { rows } = await S.db.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1', [conv]);
    assert.equal(rows[0].n, 0, 'message content is removed on delete');
  });

  test('a desktop cannot write into another account\'s conversation', async () => {
    const conv = uuid();
    await b.json('POST', `/api/conversations/${conv}/messages`, { id: uuid(), content: 'b private' });
    const r = await dev('POST', '/api/desktop/v1/sync', {
      conversations: [{ id: conv, title: 'hijack', edited_at: new Date().toISOString() }],
      messages: [{ id: uuid(), conversation_id: conv, role: 'user', content: 'hijack', meta: {} }]
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.refused, [conv]);
    assert.equal(r.data.inserted, 0);
    const got = await b.json('GET', `/api/conversations/${conv}`);
    assert.notEqual(got.data.conversation.title, 'hijack');
    assert.equal(got.data.messages.length >= 1 && got.data.messages.every((m) => m.content !== 'hijack'), true);
  });

  test('pull pages through a large batch written in one transaction without skipping or looping', async () => {
    const conv = uuid();
    const messages = Array.from({ length: 1200 }, (_, i) => ({
      id: uuid(), conversation_id: conv, role: 'transcript', content: `line ${i}`, meta: {}, created_at: new Date(Date.now() - 100_000 + i).toISOString()
    }));
    await dev('POST', '/api/desktop/v1/sync', { conversations: [{ id: conv, title: 'big' }], messages: messages.slice(0, 500) });
    await dev('POST', '/api/desktop/v1/sync', { messages: messages.slice(500, 1000) });
    await dev('POST', '/api/desktop/v1/sync', { messages: messages.slice(1000) });
    const seen = new Set();
    let cursor = null; let pages = 0;
    for (;;) {
      const r = await dev('GET', `/api/desktop/v1/sync${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(r.status, 200);
      for (const m of r.data.messages) if (m.conversation_id === conv) seen.add(m.id);
      cursor = r.data.cursor;
      if (!r.data.more) break;
      assert.ok(++pages < 20, 'pagination must terminate');
    }
    assert.equal(seen.size, 1200);
    // A follow-up pull re-sends only the 60 s overlap window (here: everything, it was just written) and still terminates.
    let again = 0;
    for (let r = await dev('GET', `/api/desktop/v1/sync?cursor=${encodeURIComponent(cursor)}`); r.data.more; again++) {
      assert.ok(again < 20, 'follow-up pagination must terminate');
      r = await dev('GET', `/api/desktop/v1/sync?cursor=${encodeURIComponent(r.data.cursor)}`);
    }
    assert.equal((await dev('GET', '/api/desktop/v1/sync?cursor=garbage')).status, 400);
  });

  test('settings: validated, later edit wins, visible to the desktop', async () => {
    const put = await a.json('PUT', '/api/preferences', { model: 'gemini-3.5-flash', responseMode: 'technical' });
    assert.equal(put.status, 200);
    assert.equal(put.data.settings.responseMode, 'technical');
    assert.equal((await a.json('PUT', '/api/preferences', { responseMode: 'nonsense' })).status, 400);
    assert.equal((await a.json('PUT', '/api/preferences', { model: 'x; DROP TABLE users' })).status, 400);
    const old = await dev('POST', '/api/desktop/v1/sync', { settings: { data: { responseMode: 'quick' }, updated_at: new Date(Date.now() - 3_600_000).toISOString() } });
    assert.equal(old.status, 200);
    const pulled = await dev('GET', '/api/desktop/v1/sync');
    assert.equal(pulled.data.settings.settings.responseMode, 'technical', 'an older desktop edit does not win');
  });

  test('pages render: list, new and an existing conversation', async () => {
    const list = await a.req('GET', '/conversations');
    assert.equal(list.status, 200);
    assert.match(await list.text(), /What is a B-tree\?/);
    assert.equal((await a.req('GET', '/conversations/new')).status, 200);
    assert.equal((await a.req('GET', `/conversations/${uuid()}`)).status, 404);
    const out = await a.req('GET', '/conversations', undefined, { noCookie: true });
    assert.equal(out.status, 307);
  });
});
