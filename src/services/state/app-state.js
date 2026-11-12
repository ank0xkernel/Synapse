const fs = require('fs');
const path = require('path');
const { createCredentialStore } = require('../web-sync/credential-store');

// Packaged builds keep state in userData/state. Not userData/cache: macOS paths
// are case-insensitive, so that is Chromium's own HTTP "Cache" directory.
const PACKAGED_STATE_DIR_NAME = 'state';
const DEV_STATE_DIR_NAME = 'cache';
const APP_STATE_FILE_NAME = 'app-state.json';
const SECRETS_FILE_NAME = 'api-keys.bin';

// API keys never go into app-state.json. They are encrypted with Electron
// safeStorage, whose key lives in the macOS Keychain (see credential-store.js).
const SECRET_FIELDS = ['geminiApiKey', 'assemblyAiApiKey'];

let secretStore = null;

function getDefaultAppState() {
  return {
    aiProvider: null,
    geminiApiKey: null,
    assemblyAiApiKey: null,
    geminiApiKeyIndex: 0,
    geminiModel: null,
    ollamaBaseUrl: null,
    ollamaModel: null,
    assemblyAiSpeechModel: null,
    // 'fast' (AssemblyAI only), 'multilingual' (Gemini only), 'auto' (default:
    // AssemblyAI, escalating to Gemini when it garbles non-English).
    sttMode: 'auto',
    programmingLanguage: null,
    windowOpacityLevel: 10,
    themePreference: null,
    clickThroughEnabled: false,
    shortcutOverrides: {}
  };
}

function sanitizeAppState(state) {
  const nextState = getDefaultAppState();

  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const aiProvider = String(state.aiProvider ?? '').trim().toLowerCase();
    if (aiProvider === 'gemini' || aiProvider === 'ollama') {
      nextState.aiProvider = aiProvider;
    }

    if (typeof state.geminiApiKey === 'string') {
      const geminiApiKey = state.geminiApiKey.trim();
      nextState.geminiApiKey = geminiApiKey || null;
    }

    if (typeof state.assemblyAiApiKey === 'string') {
      const assemblyAiApiKey = state.assemblyAiApiKey.trim();
      nextState.assemblyAiApiKey = assemblyAiApiKey || null;
    }

    const geminiApiKeyIndex = Number.parseInt(String(state.geminiApiKeyIndex ?? ''), 10);
    if (Number.isFinite(geminiApiKeyIndex) && geminiApiKeyIndex >= 0) {
      nextState.geminiApiKeyIndex = geminiApiKeyIndex;
    }

    if (typeof state.geminiModel === 'string' && state.geminiModel.trim()) {
      nextState.geminiModel = state.geminiModel.trim();
    }

    if (typeof state.ollamaBaseUrl === 'string' && state.ollamaBaseUrl.trim()) {
      nextState.ollamaBaseUrl = state.ollamaBaseUrl.trim();
    }

    if (typeof state.ollamaModel === 'string' && state.ollamaModel.trim()) {
      nextState.ollamaModel = state.ollamaModel.trim();
    }

    if (typeof state.assemblyAiSpeechModel === 'string' && state.assemblyAiSpeechModel.trim()) {
      nextState.assemblyAiSpeechModel = state.assemblyAiSpeechModel.trim();
    }

    const sttMode = String(state.sttMode ?? '').trim().toLowerCase();
    if (sttMode === 'fast' || sttMode === 'multilingual' || sttMode === 'auto') {
      nextState.sttMode = sttMode;
    }

    if (typeof state.programmingLanguage === 'string' && state.programmingLanguage.trim()) {
      nextState.programmingLanguage = state.programmingLanguage.trim();
    }

    const windowOpacityLevel = Number.parseInt(String(state.windowOpacityLevel ?? ''), 10);
    if (Number.isFinite(windowOpacityLevel)) {
      nextState.windowOpacityLevel = Math.min(Math.max(windowOpacityLevel, 1), 10);
    }

    const themePreference = String(state.themePreference ?? '').trim().toLowerCase();
    if (themePreference === 'dark' || themePreference === 'light') {
      nextState.themePreference = themePreference;
    }

    nextState.clickThroughEnabled = state.clickThroughEnabled === true;

    if (state.shortcutOverrides && typeof state.shortcutOverrides === 'object' && !Array.isArray(state.shortcutOverrides)) {
      for (const [id, accelerator] of Object.entries(state.shortcutOverrides)) {
        if (typeof accelerator === 'string' && accelerator.trim()) {
          nextState.shortcutOverrides[id] = accelerator.trim();
        }
      }
    }
  }

  return nextState;
}

function getAppStateDir(app) {
  // Dev: project cache/ next to package.json so devs can inspect state easily.
  if (!app || !app.isPackaged) {
    return path.join(__dirname, '..', '..', '..', DEV_STATE_DIR_NAME);
  }
  return path.join(app.getPath('userData'), PACKAGED_STATE_DIR_NAME);
}

function getAppStatePath(app) {
  return path.join(getAppStateDir(app), APP_STATE_FILE_NAME);
}

/** Earlier locations of app-state.json, newest first. Read once to migrate. */
function getLegacyStatePaths(app) {
  if (!app || !app.isPackaged) return [];
  const userData = app.getPath('userData');
  return [
    path.join(userData, 'cache', APP_STATE_FILE_NAME),
    path.join(path.dirname(userData), 'synapse-interview-coach', 'Cache', APP_STATE_FILE_NAME)
  ];
}

/**
 * Turns on Keychain-backed storage for API keys. Call once after the app is
 * ready (safeStorage needs it) and before the first loadAppState.
 */
function configureSecretStore(app, safeStorage) {
  secretStore = createCredentialStore({ safeStorage, filePath: path.join(getAppStateDir(app), SECRETS_FILE_NAME) });
  return getSecretStoreStatus();
}

/** For settings and diagnostics. Never contains key material. */
function getSecretStoreStatus() {
  if (!secretStore) return { configured: false, available: false, locked: null };
  return { configured: true, available: secretStore.available(), locked: secretStore.locked() };
}

// Atomic: a crash mid-write leaves the previous file, never a truncated one.
function writeFileAtomic(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, contents, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function pickSecrets(state) {
  const secrets = {};
  for (const field of SECRET_FIELDS) {
    if (typeof state?.[field] === 'string' && state[field].trim()) secrets[field] = state[field].trim();
  }
  return secrets;
}

function withoutSecrets(state) {
  const copy = { ...state };
  for (const field of SECRET_FIELDS) copy[field] = null;
  return copy;
}

function sameSecrets(a, b) {
  return SECRET_FIELDS.every((field) => (a[field] || null) === (b[field] || null));
}

/**
 * Keys from the Keychain store. Returns null when the store cannot be read
 * (unavailable, or the Keychain refused this build), which is different from
 * "no keys saved" ({}).
 */
function readStoredSecrets() {
  if (!secretStore || !secretStore.available()) return null;
  const value = secretStore.load();
  if (value === null && secretStore.locked()) {
    console.error(`[AppState] API keys are saved but the Keychain did not release them: ${secretStore.locked()}`);
    return null;
  }
  return value && typeof value === 'object' ? value : {};
}

function writeStateFile(app, state, { keepPlaintextSecrets }) {
  const persisted = keepPlaintextSecrets ? state : withoutSecrets(state);
  writeFileAtomic(getAppStatePath(app), `${JSON.stringify(persisted, null, 2)}\n`);
}

/** Reads the state file; a corrupt one is moved aside so it is never overwritten. */
function readStateFile(app) {
  const statePath = getAppStatePath(app);
  const candidates = fs.existsSync(statePath) ? [statePath] : getLegacyStatePaths(app);
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const state = sanitizeAppState(readJson(candidate));
      if (candidate !== statePath) console.log(`[AppState] Migrating settings from ${candidate}`);
      return { state, source: candidate };
    } catch (error) {
      const asidePath = `${candidate}.corrupt-${Date.now()}`;
      try { fs.renameSync(candidate, asidePath); } catch (_) { /* keep going with defaults */ }
      console.error(`[AppState] ${candidate} could not be parsed (${error.message}); moved to ${asidePath}`);
    }
  }
  return { state: getDefaultAppState(), source: null };
}

function loadAppState(app) {
  const { state, source } = readStateFile(app);
  const statePath = getAppStatePath(app);
  const plaintext = pickSecrets(state);
  const stored = readStoredSecrets();

  if (stored === null) {
    // Keychain unreadable: run on whatever plaintext keys an older version
    // left behind, and leave them on disk so nothing is lost.
    if (source && source !== statePath) {
      try {
        writeStateFile(app, state, { keepPlaintextSecrets: true });
      } catch (error) {
        console.error(`[AppState] Could not copy settings to ${statePath}: ${error.message}`);
      }
    }
    return state;
  }

  const merged = { ...state };
  for (const field of SECRET_FIELDS) merged[field] = stored[field] || plaintext[field] || null;

  // Move plaintext keys into the Keychain, then rewrite the file without them.
  // Any failure leaves the plaintext source in place and runs on the merged
  // state in memory: launch never fails over a migration.
  try {
    if (Object.keys(plaintext).length && !sameSecrets(stored, merged)) {
      secretStore.save(pickSecrets(merged));
      console.log(`[AppState] Moved ${Object.keys(plaintext).length} API key(s) into the macOS Keychain store`);
    }
    if (source !== statePath || Object.keys(plaintext).length) {
      writeStateFile(app, merged, { keepPlaintextSecrets: false });
      if (source && source !== statePath) fs.rmSync(source, { force: true });
    }
  } catch (error) {
    console.error(`[AppState] Settings migration did not complete (${error.message}); keeping the existing files.`);
  }
  return merged;
}

/**
 * Merges partialState into the saved state. API keys are written to the
 * Keychain store only when partialState carries them, so saving any other
 * setting can never blank a stored key. Non-secret settings are always
 * written, even when the keys cannot be; that failure is then thrown.
 */
function saveAppState(app, partialState = {}) {
  const currentState = loadAppState(app);
  const nextState = sanitizeAppState({ ...currentState, ...partialState });
  const touchesSecrets = SECRET_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(partialState, field));
  const storeAvailable = Boolean(secretStore && secretStore.available());
  let secretsError = null;

  if (touchesSecrets && !sameSecrets(currentState, nextState)) {
    if (!storeAvailable) {
      secretsError = Object.assign(new Error('The macOS Keychain is not available, so the API key was not saved. Synapse does not store keys in plain text.'), { code: 'SECURE_STORAGE_UNAVAILABLE' });
    } else if (readStoredSecrets() === null && !Object.keys(pickSecrets(nextState)).length) {
      // The form shows empty fields while the store is unreadable: an empty
      // save is not a request to delete keys the Keychain is withholding.
      secretsError = Object.assign(new Error('Your saved API keys are still in the Keychain but macOS did not release them. Restart Synapse and allow Keychain access, or enter the keys again.'), { code: 'SECURE_STORAGE_LOCKED' });
    } else {
      if (readStoredSecrets() === null) {
        // The user typed new keys while the old ones are unreadable (Keychain
        // item reset, or files copied from another Mac). Keep the unreadable
        // file beside the new one instead of deleting it.
        const asidePath = `${secretStore.filePath}.unreadable-${Date.now()}`;
        fs.renameSync(secretStore.filePath, asidePath);
        console.warn(`[AppState] Unreadable key store moved to ${asidePath}`);
      }
      secretStore.save(pickSecrets(nextState));
      console.log('[AppState] API keys saved to the macOS Keychain store');
    }
  }

  // Without a store the keys are whatever plaintext an older build left; keep
  // them. With a store that is locked, the in-memory keys came from that same
  // plaintext file (loadAppState above), so keep them too until a save succeeds.
  const keepPlaintextSecrets = !storeAvailable || (secretsError !== null || readStoredSecrets() === null);
  const persisted = secretsError ? { ...nextState, ...Object.fromEntries(SECRET_FIELDS.map((f) => [f, currentState[f]])) } : nextState;
  writeStateFile(app, persisted, { keepPlaintextSecrets });
  if (secretsError) throw secretsError;
  return nextState;
}

module.exports = {
  configureSecretStore,
  getDefaultAppState,
  getAppStatePath,
  getSecretStoreStatus,
  loadAppState,
  saveAppState
};
