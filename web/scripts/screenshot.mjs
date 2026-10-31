// Visual QA: opens every page in a hidden Electron BrowserWindow at desktop and phone sizes and saves PNGs.
//   WEB_URL=http://localhost:3457 node scripts/screenshot.mjs
// Needs a running server (next start) with INSECURE_COOKIES=1 when served over http, and a migrated DB.
// Re-launches itself with the repo's Electron binary (ELECTRON_RUN_AS_NODE unset).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const OUT = process.env.SHOT_DIR || path.join(repoRoot, 'web', '.shots');
const BASE = process.env.WEB_URL || 'http://localhost:3457';
const PASSWORD = 'screenshot-password-1';

if (!process.versions.electron) {
  const bin = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(bin, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const pdf = fs.readFileSync(path.join(here, '..', 'tests', 'fixtures', 'resume.pdf'));

  /** Minimal API client that keeps the session cookie so both seeding and the browser share one login. */
  async function account(email) {
    let cookie = '';
    const call = async (method, url, body) => {
      const headers = { origin: BASE, ...(cookie ? { cookie } : {}) };
      let payload = body;
      if (body && !(body instanceof FormData)) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
      const res = await fetch(BASE + url, { method, headers, body: payload });
      for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); if (pair.startsWith('synapse_session=')) cookie = pair; }
      return { status: res.status, data: await res.json().catch(() => null) };
    };
    let created = false;
    let r = await call('POST', '/api/auth/login', { email, password: PASSWORD });
    if (r.status !== 200) { created = true; r = await call('POST', '/api/auth/signup', { email, password: PASSWORD, name: email.startsWith('full') ? 'Priya Raman' : '' }); }
    if (r.status !== 200) throw new Error(`cannot sign in ${email}: ${JSON.stringify(r.data)}`);
    return { call, token: cookie.split('=')[1], created };
  }

  async function seed(call) {
    const f = new FormData();
    f.set('file', new Blob([pdf]), 'Priya Raman - Backend.pdf');
    const resume = (await call('POST', '/api/resumes', f)).data.id;
    const jd = (await call('POST', '/api/jds', {
      company: 'Globex', role: 'Backend Engineer', resumeId: resume, responseMode: 'technical',
      text: 'Backend Engineer\nResponsibilities\nDesign and operate services on AWS and Kubernetes\nOwn PostgreSQL schemas and Redis caching\nRequirements\nStrong Python or Node experience\nExperience with Docker and Kubernetes\nNice to have\nKafka'
    })).data.id;
    const session = (await call('POST', '/api/sessions', {
      title: 'Globex backend, round 1', company: 'Globex', role: 'Backend Engineer', resumeId: resume, jdId: jd,
      interviewType: 'technical', responseMode: 'technical', status: 'ready', scheduledAt: '2031-03-14T09:30:00.000Z',
      notes: 'Panel of two engineers. Expect a system design question on caching.'
    })).data.id;
    await call('POST', `/api/sessions/${session}/prep`, { mode: 'deterministic' });
    await call('POST', `/api/sessions/${session}/activate`, {});
    await call('POST', '/api/device-tokens', { name: 'MacBook Pro' });
    return { resume, jd, session };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let shared; // one window for the whole run: extra renderer processes are not always permitted in sandboxed shells
  async function shoot(partition, token, set, pages, sizes) {
    const ses = session.defaultSession;
    await ses.clearStorageData({ storages: ['cookies'] });
    if (token) await ses.cookies.set({ url: BASE, name: 'synapse_session', value: token, path: '/' });
    const win = (shared ??= new BrowserWindow({ show: false, width: sizes[0][0], height: sizes[0][1], useContentSize: true, webPreferences: { plugins: true } }));
    win.webContents.removeAllListeners('did-fail-load');
    win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => console.log('did-fail-load', code, desc, url, isMain));
    for (const [w, h] of sizes) {
      win.setContentSize(w, h);
      for (const [name, url] of pages) {
        await win.loadURL(BASE + url).catch((e) => console.log(`load warning for ${url}: ${e.code}`));
        await sleep(700);
        const height = await win.webContents.executeJavaScript('Math.max(document.documentElement.scrollHeight, innerHeight)');
        const overflowX = await win.webContents.executeJavaScript('document.documentElement.scrollWidth - innerWidth');
        win.setContentSize(w, Math.min(height, 4000));
        await sleep(500);
        const img = await win.webContents.capturePage();
        const file = path.join(OUT, `${set}-${name}-${w}.png`);
        fs.writeFileSync(file, img.toPNG());
        const landed = new URL(win.webContents.getURL()).pathname;
        if (landed !== url.split('?')[0]) console.log(`REDIRECTED ${url} -> ${landed}`);
        console.log(`${overflowX > 0 ? 'OVERFLOW-X ' + overflowX + 'px ' : ''}${file}`);
        win.setContentSize(w, h);
      }
    }
    if (!win.isDestroyed()) win.loadURL('about:blank');
  }

  app.whenReady().then(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const sizes = [[1440, 900], [834, 1112], [390, 844]];
    const pub = [['landing', '/'], ['login', '/login'], ['signup', '/signup']];
    const full = await account('full-shots@example.com');
    // Seed once; rerun after deleting the account (or point at a fresh DB) to reseed.
    if (!full.created) throw new Error('full-shots@example.com already exists: delete it (rows cascade) and rerun to reseed.');
    const ids = await seed(full.call);
    const appPages = (ids) => [
      ['dashboard', '/dashboard'], ['resumes', '/resumes'], ...(ids ? [['resume-detail', `/resumes/${ids.resume}`]] : []),
      ['profile', '/profile'], ['jobs', '/jobs'], ['jobs-new', '/jobs/new'], ...(ids ? [['job-detail', `/jobs/${ids.jd}`]] : []),
      ['sessions', '/sessions'], ['sessions-new', '/sessions/new'], ...(ids ? [['session-detail', `/sessions/${ids.session}`]] : []),
      ['prep', '/prep'], ...(ids ? [['prep-detail', `/prep/${ids.session}`]] : []), ['desktop', '/desktop'], ['settings', '/settings']
    ];
    await shoot('anon', null, 'public', pub, sizes);
    await shoot('full', full.token, 'full', appPages(ids), sizes);
    const empty = await account('empty-shots@example.com');
    await shoot('empty', empty.token, 'empty', appPages(null), sizes);
    app.quit();
  }).catch((e) => { console.error(e); app.exit(1); });
}
