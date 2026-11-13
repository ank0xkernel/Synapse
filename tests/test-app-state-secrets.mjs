// API key persistence: keys live in the Keychain-backed store (safeStorage),
// never in app-state.json, and no ordinary save can blank them.
// Run: node tests/test-app-state-secrets.mjs

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const appStatePath = require.resolve('../src/services/state/app-state.js');

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
  if (!condition) throw new Error(message);
}

function fakeSafeStorage({ available = true, decryptFails = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
    decryptString: (b) => {
      if (decryptFails) throw new Error('Keychain denied');
      return Buffer.from(b.toString().replace(/^enc:/, ''), 'base64').toString();
    }
  };
}

// Fresh module per scenario: the secret store is module state.
function setup({ safeStorage = fakeSafeStorage(), legacy = null, current = null } = {}) {
  delete require.cache[appStatePath];
  const mod = require(appStatePath);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-secrets-'));
  const app = { isPackaged: true, getPath: () => userData };
  if (legacy) {
    fs.mkdirSync(path.join(userData, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'cache', 'app-state.json'), typeof legacy === 'string' ? legacy : JSON.stringify(legacy));
  }
  if (current) {
    fs.mkdirSync(path.join(userData, 'state'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'state', 'app-state.json'), typeof current === 'string' ? current : JSON.stringify(current));
  }
  if (safeStorage) mod.configureSecretStore(app, safeStorage);
  const stateFile = path.join(userData, 'state', 'app-state.json');
  const secretsFile = path.join(userData, 'state', 'api-keys.bin');
  const cleanup = () => fs.rmSync(userData, { recursive: true, force: true });
  return { mod, app, userData, stateFile, secretsFile, cleanup };
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

await test('Plaintext keys from the legacy state file move into the encrypted store and out of the JSON', () => {
  const t = setup({ legacy: { geminiApiKey: 'g-key', assemblyAiApiKey: 'a-key', aiProvider: 'gemini' } });
  const state = t.mod.loadAppState(t.app);
  assert(state.geminiApiKey === 'g-key' && state.assemblyAiApiKey === 'a-key', 'Keys must load after migration');
  assert(fs.existsSync(t.secretsFile), 'Encrypted key file must exist');
  assert(!fs.readFileSync(t.secretsFile, 'utf8').includes('g-key'), 'Key file must not contain plaintext');
  const json = readJson(t.stateFile);
  assert(json.geminiApiKey === null && json.assemblyAiApiKey === null, 'app-state.json must not hold keys');
  assert(json.aiProvider === 'gemini', 'Provider must persist');
  assert(!fs.existsSync(path.join(t.userData, 'cache', 'app-state.json')), 'Legacy plaintext file must be removed after migration');
  t.cleanup();
});

await test('Keys survive a restart (new module instance, same userData)', () => {
  const t = setup();
  t.mod.saveAppState(t.app, { geminiApiKey: 'persisted', aiProvider: 'gemini', geminiModel: 'm1' });
  delete require.cache[appStatePath];
  const again = require(appStatePath);
  again.configureSecretStore(t.app, fakeSafeStorage());
  const state = again.loadAppState(t.app);
  assert(state.geminiApiKey === 'persisted', 'Key must be restored on next launch');
  assert(state.geminiModel === 'm1' && state.aiProvider === 'gemini', 'Provider settings must be restored');
  t.cleanup();
});

await test('Saving an unrelated setting never blanks a stored key', () => {
  const t = setup();
  t.mod.saveAppState(t.app, { geminiApiKey: 'keep-me' });
  t.mod.saveAppState(t.app, { themePreference: 'dark' });
  assert(t.mod.loadAppState(t.app).geminiApiKey === 'keep-me', 'Key must survive unrelated saves');
  t.cleanup();
});

await test('A corrupt state file is moved aside; keys in the store are unaffected', () => {
  const t = setup();
  t.mod.saveAppState(t.app, { geminiApiKey: 'safe', geminiModel: 'm' });
  fs.writeFileSync(t.stateFile, '{"geminiModel": "m", trunc');
  const state = t.mod.loadAppState(t.app);
  assert(state.geminiApiKey === 'safe', 'Key must survive a corrupt settings file');
  const aside = fs.readdirSync(path.dirname(t.stateFile)).filter((n) => n.includes('.corrupt-'));
  assert(aside.length === 1, 'Corrupt file must be kept for inspection');
  t.cleanup();
});

await test('Keychain refusing access: an empty-field save keeps the store; typing a new key saves it and keeps the unreadable file aside', () => {
  const t = setup();
  t.mod.saveAppState(t.app, { geminiApiKey: 'original' });
  const before = fs.readFileSync(t.secretsFile);
  delete require.cache[appStatePath];
  const locked = require(appStatePath);
  locked.configureSecretStore(t.app, fakeSafeStorage({ decryptFails: true }));
  // The settings form shows an empty field while locked; saving it must not wipe the store.
  locked.saveAppState(t.app, { geminiApiKey: '', themePreference: 'dark' });
  assert(fs.readFileSync(t.secretsFile).equals(before), 'Encrypted key file must be untouched by an empty-field save');
  assert(locked.loadAppState(t.app).themePreference === 'dark', 'Non-secret settings must still save while locked');
  assert(locked.getSecretStoreStatus().locked, 'Status must report locked');
  // A real replacement key: new store written, the unreadable one preserved.
  locked.configureSecretStore(t.app, fakeSafeStorage());
  fs.writeFileSync(t.secretsFile, Buffer.from('garbage-not-decryptable'));
  const garbageStore = fakeSafeStorage();
  garbageStore.decryptString = (b) => { if (b.toString().startsWith('garbage')) throw new Error('bad'); return fakeSafeStorage().decryptString(b); };
  locked.configureSecretStore(t.app, garbageStore);
  locked.saveAppState(t.app, { geminiApiKey: 'replacement' });
  assert(locked.loadAppState(t.app).geminiApiKey === 'replacement', 'New key must be saved and readable');
  const aside = fs.readdirSync(path.dirname(t.secretsFile)).filter((n) => n.includes('.unreadable-'));
  assert(aside.length === 1, 'Unreadable key file must be kept aside, not deleted');
  t.cleanup();
});

await test('Keychain unavailable: a save carrying a key still persists the other settings, then reports the key error', () => {
  const t = setup({ safeStorage: fakeSafeStorage({ available: false }) });
  let code = null;
  try { t.mod.saveAppState(t.app, { geminiApiKey: 'k', geminiModel: 'model-x', themePreference: 'dark' }); } catch (error) { code = error.code; }
  assert(code === 'SECURE_STORAGE_UNAVAILABLE', `Expected SECURE_STORAGE_UNAVAILABLE, got ${code}`);
  const json = readJson(t.stateFile);
  assert(json.geminiModel === 'model-x' && json.themePreference === 'dark', 'Non-secret settings must persist');
  assert(json.geminiApiKey === null, 'Key must not be written in plaintext');
  t.cleanup();
});

await test('Locked store with legacy plaintext keys: an unrelated save does not strip them', () => {
  const t = setup();
  t.mod.saveAppState(t.app, { geminiApiKey: 'stored' });
  const plain = { ...readJson(t.stateFile), geminiApiKey: 'plain-only-copy' };
  fs.writeFileSync(t.stateFile, JSON.stringify(plain));
  delete require.cache[appStatePath];
  const locked = require(appStatePath);
  locked.configureSecretStore(t.app, fakeSafeStorage({ decryptFails: true }));
  locked.saveAppState(t.app, { themePreference: 'light' });
  assert(readJson(t.stateFile).geminiApiKey === 'plain-only-copy', 'Plaintext key must stay until it is safely in the Keychain');
  t.cleanup();
});

await test('Keychain unavailable: legacy plaintext keys still load and are not discarded; new keys are refused', () => {
  const t = setup({ legacy: { geminiApiKey: 'old-plain' }, safeStorage: fakeSafeStorage({ available: false }) });
  const state = t.mod.loadAppState(t.app);
  assert(state.geminiApiKey === 'old-plain', 'Existing key must keep working');
  assert(readJson(t.stateFile).geminiApiKey === 'old-plain', 'Existing key must not be dropped from disk');
  let code = null;
  try { t.mod.saveAppState(t.app, { geminiApiKey: 'new' }); } catch (error) { code = error.code; }
  assert(code === 'SECURE_STORAGE_UNAVAILABLE', `Expected SECURE_STORAGE_UNAVAILABLE, got ${code}`);
  t.cleanup();
});

await test('Shortcut overrides and click-through persist (they were dropped by the sanitizer)', () => {
  const t = setup();
  t.mod.saveAppState(t.app, { shortcutOverrides: { ask: 'CommandOrControl+Shift+K' }, clickThroughEnabled: true });
  const state = t.mod.loadAppState(t.app);
  assert(state.shortcutOverrides.ask === 'CommandOrControl+Shift+K', 'Shortcut override must persist');
  assert(state.clickThroughEnabled === true, 'Click-through must persist');
  t.cleanup();
});

await test('State is not written into Chromium\'s userData/Cache directory', () => {
  const t = setup();
  t.mod.saveAppState(t.app, { geminiModel: 'x' });
  assert(t.mod.getAppStatePath(t.app) === t.stateFile, `Unexpected state path ${t.mod.getAppStatePath(t.app)}`);
  assert(!fs.existsSync(path.join(t.userData, 'cache', 'app-state.json')), 'Must not write to userData/cache');
  t.cleanup();
});

await test('Interview brief moves out of userData/cache (Chromium\'s Cache dir) without losing content', () => {
  const contextPath = require.resolve('../src/services/context/interview-context.js');
  delete require.cache[contextPath];
  const ctx = require(contextPath);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-brief-'));
  fs.mkdirSync(path.join(userData, 'cache'));
  fs.writeFileSync(path.join(userData, 'cache', 'interview-context.json'), JSON.stringify({ role: 'Backend Engineer', company: 'Acme' }));
  const storePath = ctx.configure({ isPackaged: true, getPath: () => userData });
  assert(storePath === path.join(userData, 'state', 'interview-context.json'), `Unexpected path ${storePath}`);
  assert(!fs.existsSync(path.join(userData, 'cache', 'interview-context.json')), 'Legacy file must be moved');
  assert(ctx.load().role === 'Backend Engineer', 'Brief content must survive the move');
  // A corrupt brief is moved aside, never silently replaced.
  fs.writeFileSync(storePath, '{"role": "x", trunc');
  ctx.load();
  assert(fs.readdirSync(path.join(userData, 'state')).some((n) => n.includes('.corrupt-')), 'Corrupt brief must be kept aside');
  fs.rmSync(userData, { recursive: true, force: true });
});

console.log(`\nApp state secret tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
if (failed) process.exit(1);
