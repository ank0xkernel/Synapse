#!/usr/bin/env node
/**
 * Desktop account-link primitives: PKCE S256 pair (RFC 7636 test vector),
 * the one-shot 127.0.0.1 loopback receiver (state check, cancel, timeout),
 * and the encrypted credential store (never plaintext on disk).
 *
 * Run: node tests/test-web-link-primitives.mjs
 */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createPkcePair, createState, startLoopbackReceiver, base64url } = require(path.join(__dirname, '../src/services/web-sync/pkce-loopback.js'));
const { createCredentialStore } = require(path.join(__dirname, '../src/services/web-sync/credential-store.js'));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

await test('S256 challenge matches the RFC 7636 appendix B test vector', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  assert(challenge === 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', challenge);
});

await test('Fresh verifiers are 43–128 URL-safe chars and their challenge verifies', () => {
  const { verifier, challenge, method } = createPkcePair();
  assert(method === 'S256' && /^[A-Za-z0-9_-]{43,128}$/.test(verifier), verifier);
  assert(challenge === base64url(crypto.createHash('sha256').update(verifier).digest()));
  assert(createPkcePair().verifier !== verifier, 'verifiers are random');
});

await test('Loopback receiver listens on 127.0.0.1 only and returns the code for the matching state', async () => {
  const state = createState();
  const receiver = await startLoopbackReceiver({ state, timeoutMs: 5000 });
  assert(/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(receiver.redirectUri), receiver.redirectUri);
  const forged = await fetch(`${receiver.redirectUri}?code=evil&state=wrong`);
  assert(forged.status === 400, 'wrong state rejected');
  const ok = await fetch(`${receiver.redirectUri}?code=real-code&state=${state}`);
  assert(ok.status === 200);
  const { code } = await receiver.result;
  assert(code === 'real-code', 'the forged callback did not win');
});

await test('Cancel in the browser (error=access_denied) rejects with a clear message', async () => {
  const state = createState();
  const receiver = await startLoopbackReceiver({ state, timeoutMs: 5000 });
  await fetch(`${receiver.redirectUri}?error=access_denied&state=${state}`);
  let message = '';
  try { await receiver.result; } catch (error) { message = error.message; }
  assert(/cancelled/i.test(message), message);
});

await test('No callback within the timeout -> rejects and stops listening', async () => {
  const receiver = await startLoopbackReceiver({ state: createState(), timeoutMs: 80 });
  let message = '';
  try { await receiver.result; } catch (error) { message = error.message; }
  assert(/timed out/i.test(message), message);
  await new Promise((resolve) => setTimeout(resolve, 30));
  let refused = false;
  try { await fetch(receiver.redirectUri); } catch (_) { refused = true; }
  assert(refused, 'port closed after timeout');
});

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text).map((byte) => byte ^ 0x5a),
  decryptString: (buffer) => Buffer.from(buffer).map((byte) => byte ^ 0x5a).toString()
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-cred-'));

await test('Credential round-trips and is never stored in plaintext', () => {
  const store = createCredentialStore({ safeStorage: fakeSafeStorage, filePath: path.join(dir, 'web-account.bin') });
  store.save({ token: 'sdt_secret_token_value', account: { email: 'a@example.com' } });
  const raw = fs.readFileSync(path.join(dir, 'web-account.bin'));
  assert(!raw.toString('latin1').includes('sdt_secret_token_value'), 'plaintext token on disk');
  assert(store.load().token === 'sdt_secret_token_value');
  store.clear();
  assert(store.load() === null, 'cleared on logout');
});

await test('Without secure storage, saving refuses instead of writing plaintext', () => {
  const store = createCredentialStore({ safeStorage: { isEncryptionAvailable: () => false }, filePath: path.join(dir, 'none.bin') });
  let code = '';
  try { store.save({ token: 'x' }); } catch (error) { code = error.code; }
  assert(code === 'SECURE_STORAGE_UNAVAILABLE' && !fs.existsSync(path.join(dir, 'none.bin')));
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nWeb link primitive tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
