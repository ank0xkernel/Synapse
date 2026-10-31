#!/usr/bin/env node
/**
 * Website → desktop, end to end, against the REAL web app (`next start`
 * from web/, real local Postgres `synapse_web_test`) and the REAL desktop
 * sync code (services/web-sync + context-ipc's applyWebBundle + prompts.js).
 *
 * Simulated: only the human in the browser. "Approve" is the signed-in
 * website user calling the site's own /api/desktop/v1/link, then the
 * browser following the redirect to the desktop's real 127.0.0.1 listener.
 * Interview context is written to a temp dir, never the user's real one.
 *
 * Skips (exit 0, with the reason) when web/ has no production build or the
 * local Postgres is unavailable.
 *
 * Run: node tests/test-web-desktop-e2e.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const WEB = path.join(__dirname, '..', 'web');

if (!fs.existsSync(path.join(WEB, '.next', 'BUILD_ID')) || !fs.existsSync(path.join(WEB, 'node_modules', 'pg'))) {
  console.log('Website→desktop E2E: SKIPPED (no web production build; run `cd web && npm install && npm run build`)');
  process.exit(0);
}

const { startServer, signup, makePdf, JD_TEXT } = await import(path.join(WEB, 'tests', 'helpers.mjs'));

// Interview context goes to a throwaway directory.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-e2e-'));
const interviewContext = require(path.join(__dirname, '../src/services/context/interview-context.js'));
interviewContext.configure({ isPackaged: true, getPath: () => tmp });
const { applyWebBundle, clearWebContext } = require(path.join(__dirname, '../src/main-process/features/context/context-ipc.js'));
const { createWebSync } = require(path.join(__dirname, '../src/services/web-sync/web-sync.js'));
const { createCredentialStore } = require(path.join(__dirname, '../src/services/web-sync/credential-store.js'));
const prompts = require(path.join(__dirname, '../src/services/ai/prompts.js'));

let passed = 0;
let failed = 0;
async function step(name, fn) {
  const log = console.log;
  console.log = () => {};
  try {
    await fn();
    console.log = log;
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.log = log;
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

let S;
try {
  S = await startServer();
} catch (error) {
  console.log(`Website→desktop E2E: SKIPPED (${error.message.split('\n')[0]})`);
  process.exit(0);
}

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text).map((byte) => byte ^ 0x33),
  decryptString: (buffer) => Buffer.from(buffer).map((byte) => byte ^ 0x33).toString()
};
let offline = false;
const realFetch = globalThis.fetch;
const fetchImpl = (url, options) => (offline ? Promise.reject(new TypeError('fetch failed')) : realFetch(url, options));

const browserUser = await signup(S.base, 'desktop-e2e@example.com');
const otherUser = await signup(S.base, 'desktop-e2e-other@example.com');
let lastOpenedUrl = '';

// The "browser": a signed-in website user approves the consent page, then
// the browser navigates to the redirect (the desktop's loopback listener).
async function browserApprove(authorizeUrl) {
  lastOpenedUrl = authorizeUrl;
  const params = Object.fromEntries(new URL(authorizeUrl).searchParams);
  const approval = await browserUser.json('POST', '/api/desktop/v1/link', { approve: true, ...params });
  if (approval.status !== 200) throw new Error(`consent failed: ${approval.status} ${JSON.stringify(approval.data)}`);
  await realFetch(approval.data.redirect);
}

const webSync = createWebSync({
  credentialStore: createCredentialStore({ safeStorage: fakeSafeStorage, filePath: path.join(tmp, 'account.bin') }),
  cacheStore: createCredentialStore({ safeStorage: fakeSafeStorage, filePath: path.join(tmp, 'context-cache.bin') }),
  openExternal: (url) => { browserApprove(url).catch(() => {}); },
  applyBundle: applyWebBundle,
  clearWebContext,
  fetchImpl,
  deviceName: 'E2E MacBook'
});

let resumeId;
let otherResumeId;

console.log('\nwebsite side (real Next.js server + Postgres)');

await step('Upload a real PDF resume, add a job description, create and activate a session', async () => {
  const up = await browserUser.upload(makePdf(), 'Backend resume.pdf');
  assert(up.status === 200 || up.status === 201, `upload ${up.status}`);
  resumeId = up.data.id;
  const jd = await browserUser.json('POST', '/api/jds', { company: 'Globex', role: 'Backend Engineer', text: JD_TEXT, resumeId });
  const session = await browserUser.json('POST', '/api/sessions', { title: 'Globex round 1', company: 'Globex', role: 'Backend Engineer', resumeId, jdId: jd.data.id, responseMode: 'technical', notes: 'Ask about their payments platform' });
  assert(session.status === 200 || session.status === 201, `session ${session.status}`);
  assert((await browserUser.json('POST', `/api/sessions/${session.data.id}/activate`, {})).status === 200);
  otherResumeId = (await otherUser.upload(makePdf(), 'Not yours.pdf')).data.id;
});

console.log('\ndesktop side (real services/web-sync against that server)');

await step('Nothing is synced before linking (no fake "synced" state)', () => {
  const state = webSync.snapshot();
  assert(state.status === 'unlinked' && !state.account && !state.applied, JSON.stringify(state));
});

await step('Link: browser PKCE sign-in returns a token for the same account, then one check finds the context', async () => {
  const state = await webSync.link(S.base);
  assert(lastOpenedUrl.includes('code_challenge_method=S256') && /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fcallback/.test(lastOpenedUrl), lastOpenedUrl);
  assert(state.account?.email === 'desktop-e2e@example.com', JSON.stringify(state));
  assert(state.status === 'newer-available', `status ${state.status}: ${state.error}`);
  assert(state.pending.resumeName === 'Backend resume', JSON.stringify(state.pending));
});

await step('Nothing is applied until the user confirms', () => {
  assert(interviewContext.load().resumeSource !== 'web');
});

await step('Use this context: the website resume, JD, role and notes land in the local context the AI reads', () => {
  const state = webSync.applyPending();
  assert(state.status === 'up-to-date', state.status);
  const context = interviewContext.load();
  assert(context.resumeSource === 'web' && context.resumeFileName === 'Backend resume');
  assert(/Acme Corp/.test(context.background) && /Synapse Notes/.test(context.background), 'resume text from the website PDF');
  assert(context.company === 'Globex' && context.role === 'Backend Engineer');
  assert(/Kubernetes/.test(context.jobDescription));
  assert(/payments platform/.test(context.extraNotes));
  assert(context.structuredProfile.candidate.experience.length >= 1, 'experience extracted locally from the synced text');
});

await step('Live answer prompt contains the synced, verified resume facts', () => {
  const transcript = 'Host: Tell me about the payment APIs you built at Acme.';
  const text = prompts.buildAskAiSessionPrompt({ contextString: transcript, transcriptContext: transcript });
  assert(/Acme Corp/.test(text), 'resume evidence reaches the prompt');
  assert(/Globex/.test(text) && /Backend Engineer/.test(text), 'target role reaches the prompt');
});

await step('Refresh with nothing changed: 304, still up to date, no re-download', async () => {
  const state = await webSync.check();
  assert(state.status === 'up-to-date' && !state.pending, state.status);
});

await step('A profile edit on the website shows as newer context; applying it carries the user correction', async () => {
  const profile = (await S.db.query('SELECT data FROM candidate_profiles WHERE resume_id=$1', [resumeId])).rows[0].data;
  profile.custom_context.text = 'Prefers backend and platform roles';
  profile.skills.push({ text: 'Terraform', source: 'user' });
  const put = await browserUser.json('PUT', `/api/resumes/${resumeId}/profile`, profile);
  assert(put.status === 200, `profile ${put.status}`);
  const state = await webSync.check();
  assert(state.status === 'newer-available', state.status);
  webSync.applyPending();
  const context = interviewContext.load();
  assert(/Prefers backend and platform roles/.test(context.extraNotes), 'custom context from the website');
  assert(/CORRECTIONS FROM SYNAPSE WEB[\s\S]*Terraform/.test(context.background), 'user-edited skill carried over');
});

await step('Another account\'s resume PDF is not retrievable with this token (404)', async () => {
  const cred = createCredentialStore({ safeStorage: fakeSafeStorage, filePath: path.join(tmp, 'account.bin') }).load();
  const own = await realFetch(`${S.base}/api/desktop/v1/resumes/${resumeId}/pdf`, { headers: { Authorization: `Bearer ${cred.token}` } });
  assert(own.status === 200 && own.headers.get('content-type').includes('application/pdf'), `own ${own.status}`);
  const foreign = await realFetch(`${S.base}/api/desktop/v1/resumes/${otherResumeId}/pdf`, { headers: { Authorization: `Bearer ${cred.token}` } });
  assert(foreign.status === 404, `foreign ${foreign.status}`);
});

await step('Offline: keeps the applied context and says it may be stale (never "synced")', async () => {
  offline = true;
  const state = await webSync.check();
  offline = false;
  assert(state.status === 'offline' && /may be out of date/.test(state.error), JSON.stringify(state));
  assert(interviewContext.load().resumeSource === 'web', 'applied context kept');
});

await step('Revoked on the website: next check reports sign-in expired', async () => {
  const cred = createCredentialStore({ safeStorage: fakeSafeStorage, filePath: path.join(tmp, 'account.bin') }).load();
  // The website lists linked desktops server-side; the revoke is its real API.
  const linked = (await S.db.query("SELECT id FROM device_tokens WHERE name = 'E2E MacBook' AND revoked_at IS NULL")).rows[0];
  assert(linked, 'the linked desktop exists on the website');
  const revoke = await browserUser.json('DELETE', `/api/device-tokens/${linked.id}`);
  assert(revoke.status === 200 || revoke.status === 204, `revoke ${revoke.status}`);
  const state = await webSync.check();
  assert(state.status === 'auth-expired', state.status);
  const direct = await realFetch(`${S.base}/api/desktop/v1/me`, { headers: { Authorization: `Bearer ${cred.token}` } });
  assert(direct.status === 401);
});

await step('Unlink removes the token, the cache and the website-sourced context from this Mac', async () => {
  const state = await webSync.unlink();
  assert(state.status === 'unlinked' && !state.account && !state.applied);
  const context = interviewContext.load();
  assert(!context.background && context.resumeSource === '', 'no stale account data after unlink');
  assert(!fs.existsSync(path.join(tmp, 'account.bin')) && !fs.existsSync(path.join(tmp, 'context-cache.bin')));
});

await S.stop();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nWebsite→desktop E2E tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
