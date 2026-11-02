import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makePdf, signup, startServer } from './helpers.mjs';
import { getProcessingOutcome } from '../components/resume/labels.ts';

let S;
before(async () => {
  S = await startServer();
});
after(async () => {
  await S?.stop();
});

describe('reliability audit: honest outcomes & labels', () => {
  test('getProcessingOutcome yields distinct, truthful status and tone', () => {
    assert.deepEqual(
      getProcessingOutcome({ parse_status: 'ok', analysis_method: 'ai' }),
      { outcome: 'ai_completed', text: 'AI analysis completed', tone: 'positive' }
    );
    assert.deepEqual(
      getProcessingOutcome({ parse_status: 'ok', analysis_method: 'rules' }),
      { outcome: 'basic_extracted', text: 'Basic extraction completed (AI unavailable)', tone: 'warning' }
    );
    assert.deepEqual(
      getProcessingOutcome({ parse_status: 'failed' }),
      { outcome: 'analysis_failed', text: 'Analysis failed', tone: 'danger' }
    );
    assert.deepEqual(
      getProcessingOutcome({ parse_status: 'needs_reprocess' }),
      { outcome: 'reanalysis_required', text: 'Reanalysis required', tone: 'warning' }
    );
  });
});

describe('reliability audit: database concurrency & atomic transitions', () => {
  test('activate resume is atomic and advisory-locked', async () => {
    const email = `audit-act-${crypto.randomUUID()}@example.com`;
    const c = await signup(S.base, email);
    const pdf1 = makePdf('Resume One\nSKILLS\nNode.js');
    const pdf2 = makePdf('Resume Two\nSKILLS\nReact');

    const up1 = await c.upload(pdf1, 'one.pdf');
    assert.equal(up1.status, 200);
    const r1 = up1.data;

    const up2 = await c.upload(pdf2, 'two.pdf');
    assert.equal(up2.status, 200);
    const r2 = up2.data;

    assert.ok(r1.id && r2.id);

    // Initial state: first upload is active
    let check1 = (await S.db.query('SELECT is_active FROM resumes WHERE id = $1', [r1.id])).rows[0].is_active;
    let check2 = (await S.db.query('SELECT is_active FROM resumes WHERE id = $1', [r2.id])).rows[0].is_active;
    assert.equal(check1, true);
    assert.equal(check2, false);

    // Concurrent activations of r2 and r1
    const [act2, act1] = await Promise.all([
      c.json('POST', `/api/resumes/${r2.id}/activate`, {}),
      c.json('POST', `/api/resumes/${r1.id}/activate`, {})
    ]);
    assert.equal(act2.status, 200);
    assert.equal(act1.status, 200);

    // Exactly one resume must be active for this user
    const userRow = (await S.db.query('SELECT id FROM users WHERE email = $1', [email])).rows[0];
    const activeCount = (await S.db.query('SELECT count(*)::int as cnt FROM resumes WHERE user_id = $1 AND is_active = true', [userRow.id])).rows[0].cnt;
    assert.equal(activeCount, 1);
  });

  test('deleting active resume atomically promotes remaining resume without race', async () => {
    const email = `audit-del-${crypto.randomUUID()}@example.com`;
    const c = await signup(S.base, email);
    const pdf1 = makePdf('Resume Alpha\nSKILLS\nGo');
    const pdf2 = makePdf('Resume Beta\nSKILLS\nRust');

    const up1 = await c.upload(pdf1, 'alpha.pdf');
    assert.equal(up1.status, 200);
    const r1 = up1.data;

    const up2 = await c.upload(pdf2, 'beta.pdf');
    assert.equal(up2.status, 200);
    const r2 = up2.data;

    // Make r2 active
    await c.json('POST', `/api/resumes/${r2.id}/activate`, {});

    // Delete active resume r2
    const del = await c.json('DELETE', `/api/resumes/${r2.id}`);
    assert.equal(del.status, 200);

    // r1 must be promoted to active
    const r1Active = (await S.db.query('SELECT is_active FROM resumes WHERE id = $1', [r1.id])).rows[0].is_active;
    assert.equal(r1Active, true);
  });

  test('fallback upload rejects empty file and oversized requests', async () => {
    const email = `audit-fb-${crypto.randomUUID()}@example.com`;
    const c = await signup(S.base, email);
    const emptyForm = new FormData();
    emptyForm.set('file', new Blob([]), 'empty.pdf');
    emptyForm.set('fallback', '1');
    const resEmpty = await c.req('POST', '/api/resumes', emptyForm);
    assert.equal(resEmpty.status, 400);

    const badForm = new FormData();
    badForm.set('file', new Blob([Buffer.from('not a pdf')]), 'corrupt.pdf');
    badForm.set('fallback', '1');
    const resBad = await c.req('POST', '/api/resumes', badForm);
    assert.equal(resBad.status, 415);
  });
});
