import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { JD_TEXT, RESUME_LINES, client, makePdf, signup, startServer } from './helpers.mjs';

let S; // server
before(async () => { S = await startServer(); });
after(async () => { await S?.stop(); });

const PW = 'correct horse battery';

describe('auth', () => {
  test('signup, session cookie, protected page, logout, login', async () => {
    const c = client(S.base);
    const r = await c.json('POST', '/api/auth/signup', { email: 'Auth@Example.com', password: PW, name: 'Auth' });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.email, 'auth@example.com');
    const cookieToken = c.cookie.split('=')[1];
    const row = (await S.db.query('SELECT token_hash FROM auth_sessions')).rows.find((x) => x.token_hash === crypto.createHash('sha256').update(cookieToken).digest('hex'));
    assert.ok(row, 'session token is stored only as a sha256 hash');
    const hash = (await S.db.query("SELECT password_hash FROM users WHERE email='auth@example.com'")).rows[0].password_hash;
    assert.match(hash, /^scrypt\$/);
    assert.ok(!hash.includes(PW));

    assert.equal((await c.req('GET', '/dashboard')).status, 200);
    const out = await c.json('POST', '/api/auth/logout', {});
    assert.equal(out.status, 200);
    assert.equal((await S.db.query('SELECT count(*) n FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE u.email=$1', ['auth@example.com'])).rows[0].n, '0');
    const anon = await c.req('GET', '/dashboard');
    assert.equal(anon.status, 307);
    assert.match(anon.headers.get('location'), /\/login$/);
    assert.equal((await c.json('POST', '/api/resumes', new FormData())).status, 401);

    const again = await c.json('POST', '/api/auth/login', { email: 'auth@example.com', password: PW });
    assert.equal(again.status, 200);
    assert.equal((await c.req('GET', '/dashboard')).status, 200);
  });

  test('duplicate email and weak password are rejected', async () => {
    const c = client(S.base);
    assert.equal((await c.json('POST', '/api/auth/signup', { email: 'auth@example.com', password: PW })).status, 409);
    assert.equal((await c.json('POST', '/api/auth/signup', { email: 'weak@example.com', password: 'short' })).status, 400);
  });

  test('wrong password is 401, then 5 failures lock out even the right password', async () => {
    await signup(S.base, 'rate@example.com');
    const c = client(S.base);
    for (let i = 0; i < 5; i++) {
      const r = await c.json('POST', '/api/auth/login', { email: 'rate@example.com', password: 'wrong-password-x' });
      assert.equal(r.status, 401);
    }
    const locked = await c.json('POST', '/api/auth/login', { email: 'rate@example.com', password: PW });
    assert.equal(locked.status, 429);
    assert.ok(locked.res.headers.get('retry-after'));
    // a different client IP is not locked
    const other = client(S.base);
    assert.equal((await other.json('POST', '/api/auth/login', { email: 'rate@example.com', password: PW })).status, 200);
  });

  test('unknown email gets the same 401 as a wrong password', async () => {
    const c = client(S.base);
    const r = await c.json('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'whatever-pass' });
    assert.equal(r.status, 401);
    assert.equal(r.data.error, 'Incorrect email or password');
  });

  test('state-changing requests need a same-origin Origin header', async () => {
    const c = await signup(S.base, 'csrf@example.com');
    assert.equal((await c.json('POST', '/api/device-tokens', { name: 'x' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await c.json('POST', '/api/device-tokens', { name: 'x' }, { origin: null })).status, 403);
    assert.equal((await c.json('POST', '/api/device-tokens', { name: 'x' })).status, 200);
  });

  test('security headers on pages; PDF route allows same-origin framing only', async () => {
    const c = await signup(S.base, 'hdr@example.com');
    const page = await c.req('GET', '/login');
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!csp.includes('unsafe-eval'));
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(page.headers.get('referrer-policy'));
    const up = await c.upload(makePdf());
    const pdf = await c.req('GET', `/api/resumes/${up.data.id}/file`);
    assert.match(pdf.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  });
});

describe('resumes', () => {
  let c; let first; let second;
  before(async () => { c = await signup(S.base, 'res@example.com'); });

  test('PDF upload extracts text, builds an unguessed profile, first resume is active', async () => {
    const up = await c.upload(makePdf(), 'My Resume.pdf');
    assert.equal(up.status, 200, JSON.stringify(up.data));
    first = up.data.id;
    const row = (await S.db.query('SELECT extracted_text, is_active, mime, length(file_bytes) n, name FROM resumes WHERE id=$1', [first])).rows[0];
    assert.match(row.extracted_text, /PostgreSQL/);
    assert.match(row.extracted_text, /Acme Corp/);
    assert.equal(row.is_active, true);
    assert.equal(row.mime, 'application/pdf');
    assert.ok(row.n > 500);
    assert.equal(row.name, 'My Resume');
    const prof = (await S.db.query('SELECT data FROM candidate_profiles WHERE resume_id=$1', [first])).rows[0].data;
    assert.ok(prof.skills.length > 0 && prof.skills.every((s) => s.source === 'extracted'));
    assert.ok(prof.experience.length > 0);
    assert.ok(prof.certifications.length === 0, 'sections absent from the resume stay empty');
    assert.ok(prof.achievements.length === 0);
  });

  test('summary, contact and non-core sections are saved, not dropped', async () => {
    const f = new FormData();
    f.set('text', ['Riya Sen', 'riya@example.com', 'CAREER OBJECTIVE', 'Data engineer who builds reliable pipelines.', 'EXPERIENCE',
      'Flipkart - Data Engineer (Jan 2021 - Present)', 'Moved nightly batch jobs to streaming with Kafka.', 'Tech Stack: Spark, Airflow',
      'Cut warehouse costs by 30% by partitioning hot tables.', 'PUBLICATIONS', 'Streaming at scale, VLDB workshop 2022.'].join('\n'));
    const up = await c.json('POST', '/api/resumes', f);
    assert.equal(up.status, 200, JSON.stringify(up.data));
    const p = (await S.db.query('SELECT data FROM candidate_profiles WHERE resume_id=$1', [up.data.id])).rows[0].data;
    assert.ok(p.summary.some((s) => /reliable pipelines/.test(s.text)), JSON.stringify(p.summary));
    assert.ok(p.contact.some((s) => s.text === 'Riya Sen'));
    assert.deepEqual(p.additional.map((a) => a.heading), ['PUBLICATIONS']);
    const exp = p.experience.flatMap((e) => e.bullets).join('\n');
    assert.match(exp, /Tech Stack: Spark/);
    assert.match(exp, /warehouse costs/, 'the bullet after a Tech Stack line stays in the job');
    assert.ok(p.experience.some((e) => e.technologies.includes('Kafka') && e.technologies.includes('Spark')));
    await c.json('DELETE', `/api/resumes/${up.data.id}`);
  });

  test('PDF preview route streams private bytes with the required headers', async () => {
    const res = await c.req('GET', `/api/resumes/${first}/file`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition'), /^inline/);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
    assert.deepEqual(buf, makePdf());
    assert.equal((await client(S.base).req('GET', `/api/resumes/${first}/file`)).status, 401);
  });

  test('second resume, activate, rename, edit text, delete active promotes another', async () => {
    const up = await c.upload(Buffer.from(RESUME_LINES.join('\n')), 'notes.txt', { name: 'Text version' });
    assert.equal(up.status, 200);
    second = up.data.id;
    const active = async () => (await S.db.query('SELECT id FROM resumes WHERE is_active AND id = ANY($1)', [[first, second]])).rows.map((r) => r.id);
    assert.deepEqual(await active(), [first]);
    assert.equal((await c.json('POST', `/api/resumes/${second}/activate`, {})).status, 200);
    assert.deepEqual(await active(), [second]);
    assert.equal((await c.json('PATCH', `/api/resumes/${second}`, { name: 'Renamed', extractedText: 'Skills\nPython and Rust daily' })).status, 200);
    const row = (await S.db.query('SELECT name, extracted_text FROM resumes WHERE id=$1', [second])).rows[0];
    assert.equal(row.name, 'Renamed');
    assert.match(row.extracted_text, /Rust/);
    assert.equal((await c.req('GET', `/api/resumes/${second}/file`)).status, 404, 'text resumes have no PDF');
    assert.equal((await c.json('DELETE', `/api/resumes/${second}`)).status, 200);
    assert.deepEqual(await active(), [first]);
    assert.equal((await c.json('PATCH', `/api/resumes/${second}`, { name: 'x' })).status, 404);
  });

  test('pasted text is accepted', async () => {
    const f = new FormData();
    f.set('text', RESUME_LINES.join('\n'));
    f.set('name', 'Pasted');
    const r = await c.json('POST', '/api/resumes', f);
    assert.equal(r.status, 200);
  });

  test('invalid uploads are rejected by content, size and type', async () => {
    const fake = await c.upload(Buffer.from('MZ\x90\x00 this is an exe renamed'), 'evil.pdf');
    assert.equal(fake.status, 415);
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(8 * 1024 * 1024)]);
    assert.equal((await c.upload(big, 'big.pdf')).status, 413);
    assert.equal((await c.upload(Buffer.from('x'), 'a.exe')).status, 415);
    assert.equal((await c.upload(Buffer.from([0x61, 0x00, 0x62]), 'bin.txt')).status, 415);
    assert.equal((await c.upload(Buffer.alloc(0), 'empty.pdf')).status, 400);
    assert.equal((await c.json('POST', '/api/resumes', new FormData())).status, 400);
    const broken = await c.upload(Buffer.from('%PDF-1.4\nnot really a pdf'), 'broken.pdf');
    assert.equal(broken.status, 422);
  });

  test('profile edits: unchanged items keep provenance, changed or new become user', async () => {
    const before = (await S.db.query('SELECT data FROM candidate_profiles WHERE resume_id=$1', [first])).rows[0].data;
    const edited = structuredClone(before);
    edited.skills[0].text = `${edited.skills[0].text}, Go`;
    edited.certifications.push({ text: 'AWS Certified Developer', source: 'extracted' }); // client cannot claim provenance
    edited.custom_context.text = 'Prefers backend roles';
    const r = await c.json('PUT', `/api/resumes/${first}/profile`, edited);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const p = r.data.profile;
    assert.equal(p.skills[0].source, 'user');
    assert.ok(p.skills.slice(1).every((s) => s.source === 'extracted'));
    assert.equal(p.certifications[0].source, 'user');
    assert.equal(p.experience[0].source, 'extracted');
    assert.equal((await c.json('PUT', `/api/resumes/${first}/profile`, { skills: 'nope' })).status, 400);
    assert.equal((await c.json('POST', `/api/resumes/${first}/profile`, { confirm: true })).data.profile.certifications.length, 0);
  });
});

describe('job descriptions and sessions', () => {
  let c; let resume; let jd; let sess;
  before(async () => {
    c = await signup(S.base, 'jd@example.com');
    resume = (await c.upload(makePdf())).data.id;
  });

  test('JD create, validate, edit', async () => {
    assert.equal((await c.json('POST', '/api/jds', { text: 'short' })).status, 400);
    const r = await c.json('POST', '/api/jds', { company: 'Globex', role: 'Backend Engineer', text: JD_TEXT, resumeId: resume, responseMode: 'technical' });
    assert.equal(r.status, 200);
    jd = r.data.id;
    const row = (await S.db.query('SELECT parsed, response_mode, resume_id FROM job_descriptions WHERE id=$1', [jd])).rows[0];
    assert.ok(row.parsed.technologies.includes('Kubernetes'));
    assert.equal(row.response_mode, 'technical');
    assert.equal((await c.json('PATCH', `/api/jds/${jd}`, { company: 'Globex Corp', role: 'Backend Engineer', text: `${JD_TEXT}\nGraphQL`, resumeId: resume, responseMode: 'star' })).status, 200);
    const after = (await S.db.query('SELECT company, parsed FROM job_descriptions WHERE id=$1', [jd])).rows[0];
    assert.equal(after.company, 'Globex Corp');
    assert.ok(after.parsed.technologies.includes('GraphQL'));
    assert.equal((await c.json('POST', '/api/jds', { text: JD_TEXT + ' more text', responseMode: 'bogus' })).status, 400);
  });

  test('session create, edit, reopen', async () => {
    const r = await c.json('POST', '/api/sessions', { title: 'Round 1', company: 'Globex', role: 'Backend', resumeId: resume, jdId: jd, interviewType: 'technical', responseMode: 'star', notes: 'Ask about Kafka', scheduledAt: '2030-01-01T10:00:00.000Z' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    sess = r.data.id;
    assert.equal((await c.json('PATCH', `/api/sessions/${sess}`, { title: 'Round 1 (updated)', company: 'Globex', role: 'Backend', resumeId: resume, jdId: jd, interviewType: 'technical', responseMode: 'quick', notes: 'Ask about Kafka and Redis', status: 'ready', scheduledAt: null })).status, 200);
    const page = await (await c.req('GET', `/sessions/${sess}`)).text();
    assert.match(page, /Round 1 \(updated\)/);
    assert.match(page, /Ask about Kafka and Redis/);
    const row = (await S.db.query('SELECT status, response_mode, scheduled_at FROM interview_sessions WHERE id=$1', [sess])).rows[0];
    assert.equal(row.status, 'ready');
    assert.equal(row.response_mode, 'quick');
    assert.equal(row.scheduled_at, null);
    assert.equal((await c.json('POST', '/api/sessions', { title: '' })).status, 400);
  });

  test('deterministic prep is computed from real inputs and persisted; AI is honestly unavailable without a key', async () => {
    const r = await c.json('POST', `/api/sessions/${sess}/prep`, { mode: 'deterministic' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const cmp = r.data.comparison;
    for (const t of ['Docker', 'PostgreSQL']) assert.ok(cmp.matched.includes(t), `${t} matched`);
    for (const t of ['Kubernetes', 'AWS', 'Redis', 'Kafka']) assert.ok(cmp.gaps.includes(t), `${t} is a gap`);
    assert.ok(!cmp.gaps.includes('Docker'));
    const row = (await S.db.query("SELECT source, kind FROM prep_results WHERE session_id=$1", [sess])).rows;
    assert.deepEqual(row, [{ source: 'deterministic', kind: 'comparison' }]);
    const ai = await c.json('POST', `/api/sessions/${sess}/prep`, { mode: 'ai' });
    assert.equal(ai.status, 503);
    assert.match(ai.data.error, /GEMINI_API_KEY/);
    assert.equal((await S.db.query("SELECT count(*) n FROM prep_results WHERE source='ai'")).rows[0].n, '0');
    const page = await (await c.req('GET', `/prep/${sess}`)).text();
    assert.match(page, /AI preparation needs GEMINI_API_KEY on the server/);
    assert.match(page, /Kubernetes/);
  });

  test('prep needs a resume and a JD', async () => {
    const r = await c.json('POST', '/api/sessions', { title: 'Bare' });
    assert.equal((await c.json('POST', `/api/sessions/${r.data.id}/prep`, { mode: 'deterministic' })).status, 400);
  });
});

describe('cross-user isolation', () => {
  let a; let b; let ids;
  before(async () => {
    a = await signup(S.base, 'owner@example.com');
    b = await signup(S.base, 'intruder@example.com');
    const resume = (await a.upload(makePdf())).data.id;
    const jd = (await a.json('POST', '/api/jds', { company: 'X', role: 'Y', text: JD_TEXT, resumeId: resume })).data.id;
    const sess = (await a.json('POST', '/api/sessions', { title: 'Private', resumeId: resume, jdId: jd })).data.id;
    await a.json('POST', `/api/sessions/${sess}/prep`, { mode: 'deterministic' });
    ids = { resume, jd, sess };
  });

  test('another user gets 404 for resume, PDF bytes, JD, session, prep and pages', async () => {
    const { resume, jd, sess } = ids;
    const expect404 = async (method, url, body) => {
      const r = await b.req(method, url, body);
      assert.equal(r.status, 404, `${method} ${url} -> ${r.status}`);
    };
    await expect404('GET', `/api/resumes/${resume}/file`);
    await expect404('PATCH', `/api/resumes/${resume}`, { name: 'pwn' });
    await expect404('DELETE', `/api/resumes/${resume}`);
    await expect404('POST', `/api/resumes/${resume}/activate`, {});
    await expect404('PUT', `/api/resumes/${resume}/profile`, { education: [], experience: [], projects: [], skills: [], achievements: [], certifications: [], custom_context: { text: '' } });
    await expect404('POST', `/api/resumes/${resume}/profile`, { confirm: true });
    await expect404('PATCH', `/api/jds/${jd}`, { text: JD_TEXT });
    await expect404('DELETE', `/api/jds/${jd}`);
    await expect404('PATCH', `/api/sessions/${sess}`, { title: 'pwn' });
    await expect404('DELETE', `/api/sessions/${sess}`);
    await expect404('POST', `/api/sessions/${sess}/activate`, {});
    await expect404('POST', `/api/sessions/${sess}/prep`, { mode: 'deterministic' });
    await expect404('GET', `/resumes/${resume}`);
    await expect404('GET', `/jobs/${jd}`);
    await expect404('GET', `/sessions/${sess}`);
    await expect404('GET', `/prep/${sess}`);
    // data still intact
    assert.equal((await S.db.query('SELECT count(*) n FROM resumes WHERE id=$1', [resume])).rows[0].n, '1');
    assert.equal((await S.db.query('SELECT title FROM interview_sessions WHERE id=$1', [sess])).rows[0].title, 'Private');
  });

  test("pages never leak the other user's data; referencing foreign rows is rejected", async () => {
    for (const p of ['/resumes', '/jobs', '/sessions', '/prep', '/profile', '/dashboard']) {
      const html = await (await b.req('GET', p)).text();
      assert.ok(!html.includes('Private') && !html.includes('Acme Corp'), p);
    }
    const r = await b.json('POST', '/api/sessions', { title: 'Mine', resumeId: ids.resume });
    assert.equal(r.status, 400);
    assert.equal((await b.json('POST', '/api/jds', { text: JD_TEXT, resumeId: ids.resume })).status, 400);
  });

  test('no enumeration endpoints and no malformed-id surprises', async () => {
    for (const p of ['/api/sessions', '/api/resumes', '/api/jds', '/api/device-tokens']) {
      assert.equal((await a.req('GET', p)).status, 405, p);
    }
    assert.equal((await a.req('GET', '/api/resumes/not-a-uuid/file')).status, 404);
    assert.equal((await a.req('GET', '/sessions/not-a-uuid')).status, 404);
  });

  test('desktop context never crosses accounts', async () => {
    const tb = (await b.json('POST', '/api/device-tokens', { name: 'b-laptop' })).data.token;
    const bad = await fetch(`${S.base}/api/desktop/v1/context?session=${ids.sess}`, { headers: { authorization: `Bearer ${tb}` } });
    assert.equal(bad.status, 404);
    const own = await fetch(`${S.base}/api/desktop/v1/context`, { headers: { authorization: `Bearer ${tb}` } });
    assert.equal(own.status, 404, 'user b has no context at all, and must not receive a stranger\'s');
  });
});

describe('desktop context', () => {
  let c; let token; let tokenId; let sess;
  before(async () => {
    c = await signup(S.base, 'desk@example.com');
    const resume = (await c.upload(makePdf())).data.id;
    const jd = (await c.json('POST', '/api/jds', { company: 'Globex', role: 'Backend', text: JD_TEXT, resumeId: resume })).data.id;
    sess = (await c.json('POST', '/api/sessions', { title: 'Desk', company: 'Globex', role: 'Backend', resumeId: resume, jdId: jd, responseMode: 'star', notes: 'be concise' })).data.id;
    const t = await c.json('POST', '/api/device-tokens', { name: 'mac' });
    token = t.data.token; tokenId = t.data.id;
  });
  const get = (path = '', headers = {}) => fetch(`${S.base}/api/desktop/v1/context${path}`, { headers: { authorization: `Bearer ${token}`, ...headers } });

  test('token is stored hashed and returned once', async () => {
    assert.match(token, /^syn_/);
    const row = (await S.db.query('SELECT token_hash, prefix FROM device_tokens WHERE id=$1', [tokenId])).rows[0];
    assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
    assert.ok(!JSON.stringify(row).includes(token));
    const html = await (await c.req('GET', '/desktop')).text();
    assert.ok(!html.includes(token));
  });

  test('falls back to the active resume, then serves the active session with an ETag and 304', async () => {
    let r = await get();
    assert.equal(r.status, 200);
    let body = await r.json();
    assert.equal(body.session, null);
    assert.match(body.resume.text, /PostgreSQL/);
    assert.equal(body.job_description, null);

    assert.equal((await c.json('POST', `/api/sessions/${sess}/activate`, {})).status, 200);
    r = await get();
    body = await r.json();
    assert.equal(body.schema_version, 1);
    assert.equal(`"${body.version}"`, r.headers.get('etag'));
    assert.equal(body.resume.has_pdf, true);
    assert.ok(body.resume.size > 500 && body.resume.updated_at);
    assert.equal(body.session.id, sess);
    assert.equal(body.settings.response_mode, 'star');
    assert.equal(body.settings.company, 'Globex');
    assert.equal(body.session.notes, 'be concise');
    assert.ok(body.job_description.parsed.technologies.includes('Kubernetes'));
    assert.ok(body.profile.skills.length > 0);
    assert.equal(r.headers.get('cache-control'), 'private, no-cache');
    const etag = r.headers.get('etag');
    assert.ok(etag);
    assert.equal(body.etag, etag);

    const cached = await get('', { 'if-none-match': etag });
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), '');

    await c.json('PATCH', `/api/sessions/${sess}`, { title: 'Desk', company: 'Globex', role: 'Backend', resumeId: body.resume.id, jdId: body.job_description.id, responseMode: 'quick', notes: 'be concise' });
    const changed = await get('', { 'if-none-match': etag });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('etag'), etag);
    assert.equal((await changed.json()).settings.response_mode, 'quick');
    assert.equal((await get(`?session=${sess}`)).status, 200);
    assert.equal((await get('?session=zzz')).status, 404);
  });

  test('missing, malformed, cookie-only and revoked credentials are 401', async () => {
    assert.equal((await fetch(`${S.base}/api/desktop/v1/context`)).status, 401);
    assert.equal((await fetch(`${S.base}/api/desktop/v1/context`, { headers: { authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await fetch(`${S.base}/api/desktop/v1/context`, { headers: { cookie: c.cookie } })).status, 401);
    assert.equal((await c.json('DELETE', `/api/device-tokens/${tokenId}`)).status, 200);
    assert.equal((await get()).status, 401);
    const row = (await S.db.query('SELECT last_used_at, revoked_at FROM device_tokens WHERE id=$1', [tokenId])).rows[0];
    assert.ok(row.last_used_at && row.revoked_at);
  });
});

describe('post-login redirect', () => {
  test('only same-site paths survive ?next=, including control-character tricks', async () => {
    const c = await signup(S.base, 'next@example.com');
    const cases = {
      '/resumes': '/resumes',
      '//evil.example': '/dashboard',
      '/\\evil.example': '/dashboard',
      '/%09/evil.example': '/dashboard',
      '/%0a/evil.example': '/dashboard',
      'https://evil.example': '/dashboard'
    };
    for (const [next, want] of Object.entries(cases)) {
      const r = await c.req('GET', `/login?next=${next}`);
      assert.equal(r.status, 307, next);
      assert.equal(r.headers.get('location'), want, next);
    }
  });
});

describe('account', () => {
  test('change password signs out other sessions; delete account removes everything', async () => {
    const c1 = await signup(S.base, 'acct@example.com');
    const c2 = client(S.base);
    assert.equal((await c2.json('POST', '/api/auth/login', { email: 'acct@example.com', password: PW })).status, 200);
    await c1.upload(makePdf());
    const dev = { authorization: `Bearer ${(await c1.json('POST', '/api/device-tokens', { name: 'mac' })).data.token}` };
    assert.equal((await fetch(`${S.base}/api/desktop/v1/me`, { headers: dev })).status, 200);
    assert.equal((await c1.json('POST', '/api/account/password', { current: 'wrong-password', next: 'a brand new password' })).status, 403);
    assert.equal((await c1.json('POST', '/api/account/password', { current: PW, next: 'a brand new password' })).status, 200);
    assert.equal((await c2.json('POST', '/api/device-tokens', { name: 'x' })).status, 401, 'other session was revoked');
    assert.equal((await fetch(`${S.base}/api/desktop/v1/me`, { headers: dev })).status, 401, 'linked desktop was revoked');
    assert.equal((await c1.json('POST', '/api/device-tokens', { name: 'x' })).status, 200);

    assert.equal((await c1.json('DELETE', '/api/account', { password: 'nope-nope-nope' })).status, 403);
    assert.equal((await c1.json('DELETE', '/api/account', { password: 'a brand new password' })).status, 200);
    const left = await S.db.query("SELECT (SELECT count(*) FROM users WHERE email='acct@example.com') u, (SELECT count(*) FROM resumes r LEFT JOIN users u ON u.id=r.user_id WHERE u.id IS NULL) orphans");
    assert.equal(left.rows[0].u, '0');
    assert.equal(left.rows[0].orphans, '0');
  });
});
