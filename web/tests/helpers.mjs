import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://localhost/synapse_web_test';

export const RESUME_LINES = [
  'Skills',
  'Languages: Python, TypeScript, JavaScript, SQL',
  'Frameworks: React, Node, Express, PostgreSQL, Docker',
  'Experience',
  'Acme Corp - Backend Engineer (Jan 2022 - Present)',
  'Built payment APIs with Node and PostgreSQL',
  'Projects',
  'Synapse Notes - Personal project (2023)',
  'Built a React notes app with TypeScript',
  'Education',
  'B.Tech Computer Science, Example University, Grade: 8.1/10'
];

export const JD_TEXT = `Backend Engineer
Responsibilities
Design and operate services on AWS and Kubernetes
Own PostgreSQL schemas and Redis caching
Requirements
Strong Python or Node experience
Experience with Docker and Kubernetes
Nice to have
Kafka`;

/** Real PDF (made with macOS cupsfilter from RESUME_LINES), so extraction is tested against genuine PDF structure. */
export function makePdf() {
  return fs.readFileSync(path.join(root, 'tests', 'fixtures', 'resume.pdf'));
}

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export async function startServer() {
  if (!fs.existsSync(path.join(root, '.next', 'BUILD_ID'))) throw new Error('No production build. Run `npm run build` before `npm test`.');
  const mig = spawnSync('node', ['scripts/migrate.mjs'], { cwd: root, env: { ...process.env, DATABASE_URL: DB_URL }, encoding: 'utf8' });
  if (mig.status !== 0) throw new Error(`migrate failed: ${mig.stderr}${mig.stdout}`);
  const db = new pg.Pool({ connectionString: DB_URL, max: 2 });
  await db.query('TRUNCATE users, login_attempts CASCADE');
  const port = await freePort();
  const env = { ...process.env, DATABASE_URL: DB_URL, INSECURE_COOKIES: '1', PORT: String(port), NODE_ENV: 'production' };
  delete env.GEMINI_API_KEY;
  const proc = spawn(path.join(root, 'node_modules/.bin/next'), ['start', '-p', String(port)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  // CI sets this so server-side warnings (e.g. pdf_parse_failed) show up in the job log.
  if (process.env.SHOW_SERVER_LOG) proc.stderr.pipe(process.stderr);
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/login`)).ok) break;
    } catch {}
    if (proc.exitCode !== null) throw new Error(`server exited: ${log}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return { base, db, stop: async () => { proc.kill(); await db.end(); }, log: () => log };
}

let ipCounter = 10;
/** A tiny cookie-keeping HTTP client with a distinct fake client IP. */
export function client(base) {
  const ip = `10.0.0.${ipCounter++}`;
  const c = {
    cookie: '',
    ip,
    async req(method, url, body, opts = {}) {
      const headers = { 'x-forwarded-for': ip, ...(opts.headers || {}) };
      if (c.cookie && !opts.noCookie) headers.cookie = c.cookie;
      if (opts.origin !== null) headers.origin = opts.origin ?? base;
      let payload = body;
      if (body !== undefined && !(body instanceof FormData) && !Buffer.isBuffer(body)) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
      const set = res.headers.getSetCookie?.() ?? [];
      for (const sc of set) {
        const [pair] = sc.split(';');
        const [name, val] = pair.split('=');
        if (name === 'synapse_session') c.cookie = val ? pair : '';
      }
      return res;
    },
    async json(method, url, body, opts) {
      const res = await c.req(method, url, body, opts);
      let data = null;
      try { data = await res.json(); } catch {}
      return { status: res.status, data, res };
    },
    async upload(buf, name = 'resume.pdf', extra = {}) {
      const f = new FormData();
      f.set('file', new Blob([buf]), name);
      for (const [k, v] of Object.entries(extra)) f.set(k, v);
      return c.json('POST', '/api/resumes', f);
    }
  };
  return c;
}

export async function signup(base, email, password = 'correct horse battery') {
  const c = client(base);
  const r = await c.json('POST', '/api/auth/signup', { email, password, name: email.split('@')[0] });
  if (r.status !== 200) throw new Error(`signup failed: ${r.status} ${JSON.stringify(r.data)}`);
  return c;
}
