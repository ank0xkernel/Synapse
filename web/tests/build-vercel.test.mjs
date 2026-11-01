import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/build-vercel.mjs', import.meta.url));

// Only the missing-variable paths: they exit before migrations or `next build` run.
function build(extra) {
  const env = { PATH: process.env.PATH, ...extra };
  return spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 10_000 });
}

test('a production build without DATABASE_URL or BLOB_READ_WRITE_TOKEN fails and names both', () => {
  const r = build({ VERCEL_ENV: 'production' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /DATABASE_URL and BLOB_READ_WRITE_TOKEN not set for the production environment/);
});

test('a production build with a database but no Blob token fails', () => {
  const r = build({ VERCEL_ENV: 'production', DATABASE_URL: 'postgres://unused/never-contacted' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /BLOB_READ_WRITE_TOKEN not set for the production environment/);
  assert.doesNotMatch(r.stdout, /applying migrations/);
});

test('a preview build without DATABASE_URL fails', () => {
  const r = build({ VERCEL_ENV: 'preview' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /DATABASE_URL not set for the preview environment/);
});
