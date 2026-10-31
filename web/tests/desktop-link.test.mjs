import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { JD_TEXT, client, makePdf, signup, startServer } from './helpers.mjs';

let S;
before(async () => { S = await startServer(); });
after(async () => { await S?.stop(); });

const REDIRECT = 'http://127.0.0.1:53682/callback';
const b64 = (buf) => Buffer.from(buf).toString('base64url');
const pkce = () => {
  const verifier = b64(crypto.randomBytes(32));
  return { verifier, challenge: b64(crypto.createHash('sha256').update(verifier).digest()), state: b64(crypto.randomBytes(16)) };
};
const linkParams = (p, over = {}) => ({ client: 'synapse-desktop', redirect_uri: REDIRECT, code_challenge: p.challenge, code_challenge_method: 'S256', state: p.state, ...over });
const exchange = (body, ip = '10.9.9.9') =>
  fetch(`${S.base}/api/desktop/v1/token`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });

/** Runs the browser half: approve and return the code and state from the loopback redirect. */
async function approve(c, p, over = {}) {
  const r = await c.json('POST', '/api/desktop/v1/link', { approve: true, ...linkParams(p, over) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const u = new URL(r.data.redirect);
  assert.equal(`${u.origin}${u.pathname}`, REDIRECT);
  return { code: u.searchParams.get('code'), state: u.searchParams.get('state'), url: u };
}

describe('PKCE desktop sign-in', () => {
  let c; let other; let resumeId; let sessionId;
  before(async () => {
    c = await signup(S.base, 'link@example.com');
    other = await signup(S.base, 'link-other@example.com');
    resumeId = (await c.upload(makePdf())).data.id;
    const jd = (await c.json('POST', '/api/jds', { company: 'Globex', role: 'Backend', text: JD_TEXT, resumeId })).data.id;
    sessionId = (await c.json('POST', '/api/sessions', { title: 'Linked', resumeId, jdId: jd, responseMode: 'technical' })).data.id;
    await c.json('POST', `/api/sessions/${sessionId}/activate`, {});
  });

  test('consent page needs a web login and returns to the link afterwards', async () => {
    const p = pkce();
    const qs = new URLSearchParams(linkParams(p)).toString();
    const anon = await client(S.base).req('GET', `/desktop/link?${qs}`);
    assert.equal(anon.status, 307);
    const loc = anon.headers.get('location');
    assert.match(loc, /^\/login\?next=/);
    const back = new URL(new URL(loc, S.base).searchParams.get('next'), S.base);
    assert.equal(back.pathname, '/desktop/link');
    assert.deepEqual(Object.fromEntries(back.searchParams), linkParams(p));
    const page = (await (await c.req('GET', `/desktop/link?${qs}`)).text()).replace(/<!-- -->/g, '');
    assert.match(page, /Link Synapse Desktop to link@example.com\?/);
    assert.match(page, />Approve</);
    assert.match(page, />Cancel</);
  });

  test('happy path: approve, exchange, me, context, pdf, logout', async () => {
    const p = pkce();
    const { code, state } = await approve(c, p);
    assert.equal(state, p.state);
    assert.ok(code.length >= 40);
    const stored = (await S.db.query('SELECT code_hash, expires_at, used_at FROM auth_codes ORDER BY created_at DESC LIMIT 1')).rows[0];
    assert.equal(stored.code_hash, crypto.createHash('sha256').update(code).digest('hex'), 'only the hash is stored');
    assert.ok(stored.expires_at - Date.now() <= 121_000 && stored.expires_at - Date.now() > 100_000);

    const t = await exchange({ grant_type: 'authorization_code', code, code_verifier: p.verifier, redirect_uri: REDIRECT, device_name: 'Test Mac' });
    assert.equal(t.status, 200);
    const tok = await t.json();
    assert.equal(tok.token_type, 'Bearer');
    assert.match(tok.access_token, /^syn_/);
    assert.equal(tok.account.email, 'link@example.com');
    const days = (new Date(tok.expires_at) - Date.now()) / 86_400_000;
    assert.ok(days > 89 && days <= 90);
    const auth = { authorization: `Bearer ${tok.access_token}` };

    const me = await (await fetch(`${S.base}/api/desktop/v1/me`, { headers: auth })).json();
    assert.equal(me.account.email, 'link@example.com');
    assert.equal(me.token.name, 'Test Mac');
    assert.ok(me.token.created_at && me.token.expires_at);

    const ctxRes = await fetch(`${S.base}/api/desktop/v1/context`, { headers: auth });
    const ctx = await ctxRes.json();
    assert.equal(ctxRes.status, 200);
    assert.equal(ctx.resume.id, resumeId);
    assert.deepEqual(Object.keys(ctx.resume).sort(), ['has_pdf', 'id', 'name', 'size', 'text', 'updated_at']);
    assert.match(ctx.resume.text, /PostgreSQL/);
    assert.ok(ctx.profile.skills.every((x) => x.source === 'extracted'));
    assert.equal(ctx.job_description.company, 'Globex');
    assert.ok(ctx.job_description.parsed.technologies.includes('Kubernetes'));
    assert.equal(ctx.settings.response_mode, 'technical');

    const pdf = await fetch(`${S.base}/api/desktop/v1/resumes/${resumeId}/pdf`, { headers: auth });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), makePdf());

    const settings = (await (await c.req('GET', '/settings')).text()).replace(/<!-- -->/g, '');
    assert.match(settings, /Test Mac/);
    assert.match(settings, /Browser sign-in/);

    assert.equal((await fetch(`${S.base}/api/desktop/v1/logout`, { method: 'POST', headers: auth })).status, 204);
    assert.equal((await fetch(`${S.base}/api/desktop/v1/context`, { headers: auth })).status, 401);
    assert.equal((await fetch(`${S.base}/api/desktop/v1/me`, { headers: auth })).status, 401);
  });

  test('cancel redirects with access_denied and the state, and creates no code', async () => {
    const p = pkce();
    const before = (await S.db.query('SELECT count(*) n FROM auth_codes')).rows[0].n;
    const r = await c.json('POST', '/api/desktop/v1/link', { approve: false, ...linkParams(p) });
    const u = new URL(r.data.redirect);
    assert.equal(u.searchParams.get('error'), 'access_denied');
    assert.equal(u.searchParams.get('state'), p.state);
    assert.equal(u.searchParams.get('code'), null);
    assert.equal((await S.db.query('SELECT count(*) n FROM auth_codes')).rows[0].n, before);
  });

  test('non-loopback and malformed redirect_uri, method, state, client are rejected', async () => {
    const p = pkce();
    const before = (await S.db.query('SELECT count(*) n FROM auth_codes')).rows[0].n;
    const bad = [
      { redirect_uri: 'http://evil.example/callback' },
      { redirect_uri: 'https://127.0.0.1:53682/callback' },
      { redirect_uri: 'http://localhost:53682/callback' },
      { redirect_uri: 'http://127.0.0.1:80/callback' },
      { redirect_uri: 'http://127.0.0.1:70000/callback' },
      { redirect_uri: 'http://127.0.0.1:53682/other' },
      { redirect_uri: 'http://127.0.0.1:53682/callback?next=http://evil.example' },
      { redirect_uri: 'http://127.0.0.1:53682@evil.example/callback' },
      { redirect_uri: 'http://127.0.0.1.evil.example:53682/callback' },
      { code_challenge_method: 'plain' },
      { code_challenge: 'short' },
      { state: 'tooshort' },
      { state: 'x'.repeat(129) },
      { client: 'other-app' }
    ];
    for (const over of bad) {
      const r = await c.json('POST', '/api/desktop/v1/link', { approve: true, ...linkParams(p, over) });
      assert.equal(r.status, 400, JSON.stringify(over));
      const qs = new URLSearchParams(linkParams(p, over)).toString();
      const page = await (await c.req('GET', `/desktop/link?${qs}`)).text();
      assert.match(page, /Cannot link this app/, JSON.stringify(over));
    }
    assert.equal((await S.db.query('SELECT count(*) n FROM auth_codes')).rows[0].n, before);
    assert.equal((await client(S.base).json('POST', '/api/desktop/v1/link', { approve: true, ...linkParams(p) })).status, 401, 'needs a web session');
    assert.equal((await c.json('POST', '/api/desktop/v1/link', { approve: true, ...linkParams(p) }, { origin: 'https://evil.example' })).status, 403);
  });

  test('wrong verifier fails and burns the code; reuse fails; expired fails; redirect mismatch fails', async () => {
    const good = (p, code, over = {}) => ({ grant_type: 'authorization_code', code, code_verifier: p.verifier, redirect_uri: REDIRECT, ...over });

    let p = pkce();
    let { code } = await approve(c, p);
    let r = await exchange(good(p, code, { code_verifier: pkce().verifier }));
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_grant');
    assert.equal((await exchange(good(p, code))).status, 400, 'code is burned after a failed attempt');

    p = pkce();
    ({ code } = await approve(c, p));
    assert.equal((await exchange(good(p, code))).status, 200);
    r = await exchange(good(p, code));
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_grant', 'a code works once');

    p = pkce();
    ({ code } = await approve(c, p));
    await S.db.query('UPDATE auth_codes SET expires_at = now() - interval \'1 second\' WHERE code_hash = $1', [crypto.createHash('sha256').update(code).digest('hex')]);
    r = await exchange(good(p, code));
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_grant');

    p = pkce();
    ({ code } = await approve(c, p));
    r = await exchange(good(p, code, { redirect_uri: 'http://127.0.0.1:53683/callback' }));
    assert.equal((await r.json()).error, 'invalid_grant');

    r = await exchange({ grant_type: 'password', code: 'x' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_request');
    r = await exchange(good(p, 'a'.repeat(43), { code_verifier: 'short' }));
    assert.equal((await r.json()).error, 'invalid_request');
  });

  test('token endpoint is rate limited per IP after repeated failures', async () => {
    const ip = '10.77.0.1';
    const p = pkce();
    let last;
    for (let i = 0; i < 21; i++) last = await exchange({ grant_type: 'authorization_code', code: 'z'.repeat(43), code_verifier: p.verifier, redirect_uri: REDIRECT }, ip);
    assert.equal(last.status, 429);
    assert.equal((await last.json()).error, 'slow_down');
  });

  test('re-linking the same desktop replaces its token', async () => {
    const link = async () => {
      const p = pkce();
      const { code } = await approve(c, p);
      return (await (await exchange({ grant_type: 'authorization_code', code, code_verifier: p.verifier, redirect_uri: REDIRECT, device_name: 'Same Mac' })).json()).access_token;
    };
    const first = await link();
    const second = await link();
    const ctx = (t) => fetch(`${S.base}/api/desktop/v1/context`, { headers: { authorization: `Bearer ${t}` } });
    assert.equal((await ctx(first)).status, 401);
    assert.equal((await ctx(second)).status, 200);
  });

  test('cross-user: context session, PDF and resume ids are 404; revoked and expired tokens are 401; 304 on unchanged version', async () => {
    const p = pkce();
    const { code } = await approve(other, p);
    const tok = (await (await exchange({ grant_type: 'authorization_code', code, code_verifier: p.verifier, redirect_uri: REDIRECT, device_name: 'Other Mac' })).json()).access_token;
    const auth = { authorization: `Bearer ${tok}` };
    assert.equal((await fetch(`${S.base}/api/desktop/v1/resumes/${resumeId}/pdf`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${S.base}/api/desktop/v1/context?session=${sessionId}`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${S.base}/api/desktop/v1/context`, { headers: auth })).status, 404, 'no context of its own, never the other account\'s');
    assert.equal((await fetch(`${S.base}/api/desktop/v1/resumes/not-a-uuid/pdf`, { headers: auth })).status, 404);

    const p2 = pkce();
    const { code: code2 } = await approve(c, p2);
    const mine = (await (await exchange({ grant_type: 'authorization_code', code: code2, code_verifier: p2.verifier, redirect_uri: REDIRECT, device_name: 'Etag Mac' })).json()).access_token;
    const h = { authorization: `Bearer ${mine}` };
    const first = await fetch(`${S.base}/api/desktop/v1/context`, { headers: h });
    const etag = first.headers.get('etag');
    const v1 = (await first.json()).version;
    assert.equal((await fetch(`${S.base}/api/desktop/v1/context`, { headers: { ...h, 'if-none-match': etag } })).status, 304);
    await c.json('PATCH', `/api/resumes/${resumeId}`, { name: 'Renamed for desktop' });
    const changed = await fetch(`${S.base}/api/desktop/v1/context`, { headers: { ...h, 'if-none-match': etag } });
    assert.equal(changed.status, 200);
    assert.notEqual((await changed.json()).version, v1);

    await S.db.query("UPDATE device_tokens SET expires_at = now() - interval '1 minute' WHERE name = 'Etag Mac'");
    assert.equal((await fetch(`${S.base}/api/desktop/v1/context`, { headers: h })).status, 401, 'expired');
    const id = (await S.db.query("SELECT id FROM device_tokens WHERE name = 'Other Mac'")).rows[0].id;
    assert.equal((await other.json('DELETE', `/api/device-tokens/${id}`)).status, 200);
    assert.equal((await fetch(`${S.base}/api/desktop/v1/me`, { headers: auth })).status, 401, 'revoked from settings');
    assert.equal((await c.json('DELETE', `/api/device-tokens/${id}`)).status, 404, "cannot revoke another account's device");
  });
});
