// Vercel build command. Applies additive migrations on production and preview deploys, then builds.
// Anywhere else (local, CI, no DATABASE_URL) it only builds, so a build never touches a database by accident.
// Preview deploys must use their own DATABASE_URL (a Neon branch), never the production one.
import { spawnSync } from 'node:child_process';

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: process.env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const env = process.env.VERCEL_ENV;
if ((env === 'production' || env === 'preview') && process.env.DATABASE_URL) {
  console.log(`build:vercel: applying migrations (VERCEL_ENV=${env})`);
  run('node', ['scripts/migrate.mjs']);
} else {
  console.log('build:vercel: skipping migrations (needs VERCEL_ENV production or preview and DATABASE_URL)');
}
run('npx', ['next', 'build']);
