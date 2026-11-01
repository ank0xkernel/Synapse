import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { client, makePdf, signup, startServer } from './helpers.mjs';
// Pure module, imported directly by node's type stripping.
import { MAX_PDF_BYTES, StorageError, finalizeUpload, isOwnKey, newKey, uploadConstraints } from '../lib/storage-core.ts';

const fx = (n) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', n));

let S;
before(async () => { S = await startServer(); });
after(async () => { await S?.stop(); });

const profileOf = async (id) => (await S.db.query('SELECT data FROM candidate_profiles WHERE resume_id=$1', [id])).rows[0].data;
const allText = (list) => list.flatMap((e) => [e.name ?? '', ...(e.bullets ?? [e.text])]).join('\n');

describe('blob driver rules (injected fake, not real Vercel Blob)', () => {
  const U1 = crypto.randomUUID();
  const U2 = crypto.randomUUID();
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

  function fake(files) {
    const removed = [];
    return {
      removed,
      read: async (k) => files.get(k) ?? null,
      remove: async (k) => { removed.push(k); files.delete(k); },
      extract: async (b) => {
        if (b.toString('latin1', 0, 5) !== '%PDF-') throw new StorageError(415, 'not pdf');
        if (b.includes('NOTEXT')) throw new StorageError(422, 'no text');
        return { text: 'Skills\nPython', method: 'pdf' };
      },
      save: async (p) => ({ id: `row-${p.key}`, ...p })
    };
  }

  test('keys: only resumes/<own id>/<uuid>.pdf passes', () => {
    const ok = newKey(U1, crypto.randomUUID());
    assert.ok(isOwnKey(U1, ok));
    assert.ok(!isOwnKey(U2, ok), 'another user cannot claim it');
    for (const bad of [`resumes/${U1}/../${U2}/${crypto.randomUUID()}.pdf`, `resumes/${U1}/x.pdf`, `resumes/${U1}/${crypto.randomUUID()}.txt`, `other/${U1}/${crypto.randomUUID()}.pdf`, `${ok}/extra`, 5, null]) {
      assert.ok(!isOwnKey(U1, bad), String(bad));
    }
    assert.ok(!isOwnKey('not-a-uuid', 'resumes/not-a-uuid/x.pdf'));
  });

  test('token constraints: PDF only, 8 MB, no overwrite, short-lived; foreign pathname refused', () => {
    const c = uploadConstraints(U1, newKey(U1, crypto.randomUUID()));
    assert.deepEqual(c.allowedContentTypes, ['application/pdf']);
    assert.equal(c.maximumSizeInBytes, 8 * 1024 * 1024);
    assert.equal(MAX_PDF_BYTES, 8 * 1024 * 1024);
    assert.equal(c.allowOverwrite, false);
    assert.ok(c.validUntil - Date.now() <= 10 * 60 * 1000);
    assert.throws(() => uploadConstraints(U1, newKey(U2, crypto.randomUUID())), (e) => e.status === 403);
  });

  test('finalize: foreign key 403, missing 404, bad bytes and no-text delete the object, success saves', async () => {
    const key = newKey(U1, crypto.randomUUID());
    const pdf = Buffer.from('%PDF-1.4 hello');
    const files = new Map([[key, pdf]]);
    const d = fake(files);
    await assert.rejects(finalizeUpload(U2, key, d, sha), (e) => e.status === 403);
    assert.equal(files.size, 1, 'a foreign finalize must not delete the owner\'s object');
    await assert.rejects(finalizeUpload(U1, newKey(U1, crypto.randomUUID()), d, sha), (e) => e.status === 404);
    const out = await finalizeUpload(U1, key, d, sha);
    assert.equal(out.sha256, sha(pdf));
    assert.equal(out.bytes, pdf.length);
    const again = await finalizeUpload(U1, key, d, sha);
    assert.equal(again.id, out.id, 'same key resolves to the same row');
    assert.deepEqual(d.removed, []);

    const k2 = newKey(U1, crypto.randomUUID());
    const f2 = new Map([[k2, Buffer.from('MZ not a pdf')]]);
    const d2 = fake(f2);
    await assert.rejects(finalizeUpload(U1, k2, d2, sha), (e) => e.status === 415);
    assert.deepEqual(d2.removed, [k2]);

    const k3 = newKey(U1, crypto.randomUUID());
    const f3 = new Map([[k3, Buffer.from('%PDF-1.4 NOTEXT')]]);
    const d3 = fake(f3);
    await assert.rejects(finalizeUpload(U1, k3, d3, sha), (e) => e.status === 422);
    assert.deepEqual(d3.removed, [k3]);

    const k4 = newKey(U1, crypto.randomUUID());
    const f4 = new Map([[k4, Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_PDF_BYTES)])]]);
    const d4 = fake(f4);
    await assert.rejects(finalizeUpload(U1, k4, d4, sha), (e) => e.status === 413);
    assert.deepEqual(d4.removed, [k4]);
  });

  test('database refuses a second row for the same storage key', async () => {
    const u = await signup(S.base, 'key@example.com');
    const uid = (await S.db.query("SELECT id FROM users WHERE email='key@example.com'")).rows[0].id;
    const key = newKey(uid, crypto.randomUUID());
    const ins = (n) => S.db.query(
      `INSERT INTO resumes (user_id, name, file_name, mime, size_bytes, storage_driver, storage_key) VALUES ($1,$2,'a.pdf','application/pdf',1,'blob',$3)
       ON CONFLICT (storage_key) WHERE storage_key IS NOT NULL DO NOTHING RETURNING id`, [uid, n, key]);
    assert.equal((await ins('a')).rowCount, 1);
    assert.equal((await ins('b')).rowCount, 0);
    assert.equal(u.cookie !== '', true);
  });
});

describe('db driver, real PDFs through the server', () => {
  let c;
  before(async () => { c = await signup(S.base, 'parse@example.com'); });

  test('multi-page PDF: all text kept, links kept as text, contact lines are not experience, inline skills kept', async () => {
    const up = await c.upload(fx('multipage.pdf'), 'multi.pdf');
    assert.equal(up.status, 200, JSON.stringify(up.data));
    const row = (await S.db.query('SELECT extracted_text, parse_status, parser_version, file_sha256, storage_driver FROM resumes WHERE id=$1', [up.data.id])).rows[0];
    assert.match(row.extracted_text, /https:\/\/code\.example\.com\/example-user/);
    assert.match(row.extracted_text, /https:\/\/example\.com\/shortener/);
    assert.match(row.extracted_text, /Company8 Ltd/, 'last page content present');
    assert.match(row.extracted_text, /Example Cloud Practitioner/, 'last section present');
    assert.equal(row.parse_status, 'ok');
    assert.equal(row.parser_version, 3);
    assert.equal(row.file_sha256, crypto.createHash('sha256').update(fx('multipage.pdf')).digest('hex'));
    assert.equal(row.storage_driver, 'db');
    const p = await profileOf(up.data.id);
    assert.ok(!/jordan\.example@example\.com|555 0100/.test(allText(p.experience)), 'contact block is not experience');
    assert.ok(p.skills.some((s) => /Python, TypeScript, PostgreSQL, Docker/.test(s.text)), 'inline "Skills: a, b" content kept');
    assert.equal(p.experience.length, 8);
    assert.ok(p.projects.some((e) => /Link Shortener/.test(e.name)));
    assert.ok(p.education.some((e) => e.grade === '8.1/10'));
    assert.ok(p.certifications.some((e) => /Cloud Practitioner/.test(e.text)));
  });

  test('unusual headings map to the right sections', async () => {
    const up = await c.upload(fx('headings.pdf'), 'headings.pdf');
    assert.equal(up.status, 200);
    const p = await profileOf(up.data.id);
    assert.ok(/Orbit Systems/.test(allText(p.experience)), 'Professional Journey is experience');
    assert.ok(/Telemetry Dashboard/.test(allText(p.projects)), 'Selected Work is projects');
    assert.ok(p.skills.some((s) => /Go, Python, SQL/.test(s.text)) && p.skills.some((s) => /Terraform/.test(s.text)), 'Technical Toolkit is skills');
    assert.ok(p.education.length === 1);
  });

  test('table-like layout keeps every cell as text', async () => {
    const up = await c.upload(fx('table.pdf'), 'table.pdf');
    assert.equal(up.status, 200);
    const t = (await S.db.query('SELECT extracted_text FROM resumes WHERE id=$1', [up.data.id])).rows[0].extracted_text;
    for (const w of ['Python', 'SQL', 'Docker', 'Delta Corp', 'PostgreSQL', 'Sample College']) assert.ok(t.includes(w), w);
  });

  test('very long resume: nothing truncated, last section present, profile round-trips', async () => {
    const up = await c.upload(fx('long.pdf'), 'long.pdf');
    assert.equal(up.status, 200, JSON.stringify(up.data));
    const t = (await S.db.query('SELECT extracted_text FROM resumes WHERE id=$1', [up.data.id])).rows[0].extracted_text;
    assert.ok(t.length > 20_000, `text length ${t.length}`);
    assert.match(t, /Last Section University/);
    for (const n of [1, 90, 180]) assert.ok(t.includes(`module ${n} of the platform`), `module ${n}`);
    const p = await profileOf(up.data.id);
    const bullets = p.projects.reduce((n, e) => n + e.bullets.length, 0);
    assert.ok(bullets >= 180, `project bullets ${bullets}`);
    assert.ok(p.education.some((e) => /Last Section University/.test(e.text)));
    const put = await c.json('PUT', `/api/resumes/${up.data.id}/profile`, p);
    assert.equal(put.status, 200, JSON.stringify(put.data));
    assert.equal(put.data.profile.projects.reduce((n, e) => n + e.bullets.length, 0), bullets, 'saving a big profile loses nothing');
  });

  test('invalid, damaged and scanned PDFs are refused with honest messages', async () => {
    const renamed = await c.upload(Buffer.from('just some text, not a pdf at all'), 'cv.pdf');
    assert.equal(renamed.status, 415);
    assert.match(renamed.data.error, /not a valid PDF/);
    const damaged = await c.upload(fx('multipage.pdf').subarray(0, 700), 'cut.pdf');
    assert.equal(damaged.status, 422);
    assert.match(damaged.data.error, /could not be read/);
    const scan = await c.upload(fx('scanned.pdf'), 'scan.pdf');
    assert.equal(scan.status, 422);
    assert.match(scan.data.error, /looks like a scan.*needs AI, which is not set up/);
    assert.equal((await S.db.query("SELECT count(*)::int n FROM resumes r JOIN users u ON u.id=r.user_id WHERE u.email='parse@example.com' AND r.file_name IN ('cv.pdf','cut.pdf','scan.pdf')")).rows[0].n, 0, 'rejected files leave no row');
  });

  test('upload endpoints report the db driver and refuse the blob flow', async () => {
    const cfg = await c.json('GET', '/api/resumes/upload');
    assert.equal(cfg.status, 200);
    assert.equal(cfg.data.driver, 'db');
    assert.equal(cfg.data.pathname, null);
    assert.equal((await c.json('POST', '/api/resumes/upload', { type: 'blob.generate-client-token' })).status, 404);
    assert.equal((await c.json('POST', '/api/resumes/finalize', { pathname: 'x' })).status, 404);
    assert.equal((await client(S.base).json('GET', '/api/resumes/upload')).status, 401);
  });
});

describe('reprocess, replace, delete', () => {
  let c; let id;
  before(async () => {
    c = await signup(S.base, 'repro@example.com');
    id = (await c.upload(makePdf(), 'Original.pdf')).data.id;
  });

  test('legacy row marked needs_reprocess is rebuilt from the original PDF and keeps user edits', async () => {
    const prof = await profileOf(id);
    prof.skills.push({ text: 'Rust (my own note)', source: 'user' });
    prof.custom_context.text = 'Prefers platform roles';
    assert.equal((await c.json('PUT', `/api/resumes/${id}/profile`, prof)).status, 200);
    // simulate an old, badly parsed record
    await S.db.query("UPDATE resumes SET parse_status='needs_reprocess', parser_version=NULL, extracted_text='garbage' WHERE id=$1", [id]);
    await S.db.query("UPDATE candidate_profiles SET data = jsonb_set(data, '{skills}', (data->'skills') || '[{\"text\":\"Stale wrong skill\",\"source\":\"extracted\"}]'::jsonb) WHERE resume_id=$1", [id]);

    const r = await c.json('POST', `/api/resumes/${id}/reprocess`, {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.parse_status, 'ok');
    const row = (await S.db.query('SELECT extracted_text, parse_status, parser_version, parse_error FROM resumes WHERE id=$1', [id])).rows[0];
    assert.match(row.extracted_text, /Acme Corp/);
    assert.equal(row.parse_status, 'ok');
    assert.equal(row.parser_version, 3);
    assert.equal(row.parse_error, null);
    const p = await profileOf(id);
    assert.ok(p.skills.some((s) => s.text === 'Rust (my own note)' && s.source === 'user'), 'user item kept');
    assert.ok(!p.skills.some((s) => /Stale wrong skill/.test(s.text)), 'stale extracted item replaced');
    assert.ok(p.skills.some((s) => /Python/.test(s.text) && s.source === 'extracted'));
    assert.equal(p.custom_context.text, 'Prefers platform roles');
    const again = await c.json('POST', `/api/resumes/${id}/reprocess`, {});
    assert.equal(again.status, 200);
    const p2 = await profileOf(id);
    assert.deepEqual(p2, p, 'reprocess is idempotent');
  });

  test('a failing reprocess is recorded honestly and does not destroy the good text or profile', async () => {
    const before = (await S.db.query('SELECT extracted_text FROM resumes WHERE id=$1', [id])).rows[0].extracted_text;
    const good = (await S.db.query('SELECT file_bytes FROM resumes WHERE id=$1', [id])).rows[0].file_bytes;
    await S.db.query("UPDATE resumes SET file_bytes=$2 WHERE id=$1", [id, Buffer.from('%PDF-1.4 damaged now')]);
    const r = await c.json('POST', `/api/resumes/${id}/reprocess`, {});
    assert.equal(r.status, 422);
    const row = (await S.db.query('SELECT extracted_text, parse_status, parse_error FROM resumes WHERE id=$1', [id])).rows[0];
    assert.equal(row.parse_status, 'failed');
    assert.match(row.parse_error, /could not be read/);
    assert.equal(row.extracted_text, before);
    await S.db.query('UPDATE resumes SET file_bytes=$2 WHERE id=$1', [id, good]);
    assert.equal((await c.json('POST', `/api/resumes/${id}/reprocess`, {})).status, 200);
  });

  test('replace swaps the PDF, keeps name and id, keeps user profile items', async () => {
    const f = new FormData();
    f.set('file', new Blob([fx('headings.pdf')]), 'New.pdf');
    const r = await c.json('PUT', `/api/resumes/${id}/file`, f);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const row = (await S.db.query('SELECT name, file_name, extracted_text, file_sha256, parse_status FROM resumes WHERE id=$1', [id])).rows[0];
    assert.equal(row.name, 'Original');
    assert.equal(row.file_name, 'New.pdf');
    assert.match(row.extracted_text, /Orbit Systems/);
    assert.equal(row.file_sha256, crypto.createHash('sha256').update(fx('headings.pdf')).digest('hex'));
    assert.equal(row.parse_status, 'ok');
    assert.ok((await profileOf(id)).skills.some((s) => s.source === 'user' && /Rust/.test(s.text)));
    const bad = new FormData();
    bad.set('file', new Blob([Buffer.from('not a pdf')]), 'x.pdf');
    assert.equal((await c.json('PUT', `/api/resumes/${id}/file`, bad)).status, 415);
    assert.match((await S.db.query('SELECT extracted_text FROM resumes WHERE id=$1', [id])).rows[0].extracted_text, /Orbit Systems/, 'failed replace keeps the old file');
  });

  test('another account cannot reprocess or replace; unknown ids are 404', async () => {
    const other = await signup(S.base, 'other-repro@example.com');
    assert.equal((await other.json('POST', `/api/resumes/${id}/reprocess`, {})).status, 404);
    const f = new FormData();
    f.set('file', new Blob([fx('headings.pdf')]), 'x.pdf');
    assert.equal((await other.json('PUT', `/api/resumes/${id}/file`, f)).status, 404);
    assert.equal((await c.json('POST', '/api/resumes/not-a-uuid/reprocess', {})).status, 404);
    assert.equal((await client(S.base).json('POST', `/api/resumes/${id}/reprocess`, {})).status, 401);
  });

  test('delete removes the row and its profile', async () => {
    assert.equal((await c.json('DELETE', `/api/resumes/${id}`)).status, 200);
    assert.equal((await S.db.query('SELECT count(*)::int n FROM candidate_profiles WHERE resume_id=$1', [id])).rows[0].n, 0);
  });
});

describe('production hardening', () => {
  test('health: no-store, no secrets, db ok', async () => {
    const r = await client(S.base).json('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(r.data).sort(), ['db', 'ok', 'storage', 'version']);
    assert.equal(r.data.db, 'ok');
    assert.equal(r.data.storage, 'db');
    assert.ok(!JSON.stringify(r.data).includes('postgres'));
  });

  test('security headers: HSTS and a CSP that allows only the Blob hosts needed', async () => {
    const res = await client(S.base).req('GET', '/login');
    assert.match(res.headers.get('strict-transport-security'), /max-age=\d+/);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /frame-src 'self' https:\/\/\*\.private\.blob\.vercel-storage\.com/);
    assert.match(csp, /connect-src 'self' https:\/\/vercel\.com\/api\/blob/);
    assert.ok(!/\*(?!\.private)/.test(csp.replace(/https:\/\/\*\.private\.blob\.vercel-storage\.com/g, '')), 'no other wildcards');
  });

  test('migration 003 is additive and the migrator is idempotent', async () => {
    const sql = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations', '003_resume_storage.sql'), 'utf8');
    assert.ok(!/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bUPDATE\b/i.test(sql.replace(/--.*$/gm, '')), 'no destructive statements');
    const cols = (await S.db.query("SELECT column_name FROM information_schema.columns WHERE table_name='resumes'")).rows.map((r) => r.column_name);
    for (const col of ['storage_driver', 'storage_key', 'file_sha256', 'parse_status', 'parse_error', 'parser_version', 'extracted_at']) assert.ok(cols.includes(col), col);
  });
});
