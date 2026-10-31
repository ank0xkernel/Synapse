// Vercel build command. Applies additive migrations on production and preview deploys, then builds.
// Anywhere else (local, CI, no VERCEL_ENV) it only builds, so a build never touches a database by accident.
// Preview deploys must use their own DATABASE_URL (a Neon branch), never the production one.
import { spawnSync } from 'node:child_process';

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: process.env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const env = process.env.VERCEL_ENV;
if (env === 'production' || env === 'preview') {
  // The server refuses to start without these (lib/env.ts), so a build that
  // skipped them would deploy "successfully" and then fail every request.
  // Fail here instead: Vercel keeps the last working deployment live.
  const missing = ['DATABASE_URL', ...(env === 'production' ? ['BLOB_READ_WRITE_TOKEN'] : [])].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`build:vercel: ${missing.join(' and ')} not set for the ${env} environment. In the Vercel project, open Storage and connect Neon Postgres (DATABASE_URL) and a Private Blob store (BLOB_READ_WRITE_TOKEN) to ${env}, then redeploy.`);
    process.exit(1);
  }
  console.log(`build:vercel: applying migrations (VERCEL_ENV=${env})`);
  run('node', ['scripts/migrate.mjs']);
} else {
  console.log('build:vercel: skipping migrations (not a Vercel production or preview build)');
}
run('npx', ['next', 'build']);
