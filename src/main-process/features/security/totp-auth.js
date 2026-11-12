'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * TotpAuth
 * Time-based 6-digit passcode used to pair a phone or browser with this
 * machine over the LAN.
 *
 * The secret MUST be shared by every part of the app and stable across
 * restarts. Previously each `new TotpAuth()` generated its own random secret —
 * the tray menu and the /api/login handler therefore held different secrets,
 * and the handler built a fresh one per request, so the passcode shown to the
 * user could never authenticate. Use `TotpAuth.shared()` everywhere.
 */

const SECRET_DIR_NAME = 'cache';
const SECRET_FILE_NAME = 'totp-secret';
const TIME_STEP_SECONDS = 30;

// Accept the neighbouring steps so a code entered as it rotates still works —
// this is what the old verifyToken doc-comment promised but never implemented.
const ALLOWED_DRIFT_STEPS = 1;

let sharedInstance = null;

function resolveSecretPath() {
  const os = require('os');
  return path.join(os.homedir(), '.synapse-totp-secret');
}

/**
 * The Keychain-backed store for the secret (Electron safeStorage), or null
 * outside a ready Electron app (tests, scripts).
 */
function openSecureStore(app) {
  let electron = null;
  try { electron = require('electron'); } catch (_) { return null; }
  const electronApp = app || electron?.app;
  const safeStorage = electron?.safeStorage;
  if (!electronApp?.isReady?.() || !safeStorage?.isEncryptionAvailable?.()) return null;
  const { createCredentialStore } = require('../../../services/web-sync/credential-store');
  const dir = electronApp.isPackaged ? path.join(electronApp.getPath('userData'), 'state') : path.join(__dirname, '..', '..', '..', '..', SECRET_DIR_NAME);
  return createCredentialStore({ safeStorage, filePath: path.join(dir, 'totp-secret.bin') });
}

const isSecret = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);

/**
 * Loads the pairing secret from the Keychain-backed store. A plaintext secret
 * left in the home folder by an older build is moved in once, so paired phones
 * keep working; it is deleted only after the encrypted copy is written.
 */
function loadOrCreateSecret(app) {
  const store = openSecureStore(app);
  if (!store) return loadOrCreatePlaintextSecret();

  const stored = store.load();
  if (stored && isSecret(stored.secret)) return stored.secret;
  if (store.locked()) {
    // The Keychain refused this build: keep the plaintext path working rather
    // than minting a new secret that would unpair every phone.
    console.error(`[TotpAuth] Keychain did not release the pairing secret (${store.locked()}).`);
    return loadOrCreatePlaintextSecret();
  }

  const legacyPath = resolveSecretPath();
  let secret = null;
  try {
    const legacy = fs.readFileSync(legacyPath, 'utf8').trim();
    if (isSecret(legacy)) secret = legacy;
  } catch (_) { /* no legacy secret */ }
  secret = secret || crypto.randomBytes(20).toString('hex');

  try {
    store.save({ secret });
    fs.rmSync(legacyPath, { force: true });
    console.log('[TotpAuth] Pairing secret is stored in the macOS Keychain store.');
  } catch (error) {
    console.error(`[TotpAuth] Could not store the pairing secret securely (${error.message}).`);
  }
  return secret;
}

/** Fallback when no Keychain store is available. */
function loadOrCreatePlaintextSecret() {
  const secretPath = resolveSecretPath();

  try {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    if (/^[0-9a-f]{40}$/i.test(existing)) {
      return existing;
    }
    console.warn('[TotpAuth] Stored secret is malformed; regenerating.');
  } catch (_) {
    // First run, or the file is unreadable — fall through and create one.
  }

  const secret = crypto.randomBytes(20).toString('hex');

  try {
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    // The secret is equivalent to a password for this machine's pairing.
    fs.writeFileSync(secretPath, secret, { encoding: 'utf8', mode: 0o600 });
    console.log(`[TotpAuth] Generated a new pairing secret at ${secretPath}`);
  } catch (error) {
    console.error(
      `[TotpAuth] Could not persist the pairing secret (${error.message}). `
      + 'Passcodes will stop working after a restart.'
    );
  }

  return secret;
}

class TotpAuth {
  constructor(secret) {
    this.secret = secret || crypto.randomBytes(20).toString('hex');
  }

  /**
   * The process-wide instance backed by the persisted secret. Every caller must
   * use this, or generated and verified codes will not agree.
   * @param {import('electron').App} [app]
   */
  static shared(app) {
    if (!sharedInstance) {
      sharedInstance = new TotpAuth(loadOrCreateSecret(app));
    }
    return sharedInstance;
  }

  getSecret() {
    return this.secret;
  }

  /** Generates the code for a given counter step. */
  generateTokenForStep(counter) {
    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64BE(BigInt(counter), 0);

    const hmac = crypto.createHmac('sha1', Buffer.from(this.secret, 'hex'));
    hmac.update(buffer);
    const digest = hmac.digest();

    const offset = digest[digest.length - 1] & 0xf;
    const code =
      ((digest[offset] & 0x7f) << 24) |
      ((digest[offset + 1] & 0xff) << 16) |
      ((digest[offset + 2] & 0xff) << 8) |
      (digest[offset + 3] & 0xff);

    return String(code % 1000000).padStart(6, '0');
  }

  /**
   * Current 6-digit passcode.
   * @returns {string}
   */
  generateToken(timeStepSeconds = TIME_STEP_SECONDS) {
    const counter = Math.floor(Math.floor(Date.now() / 1000) / timeStepSeconds);
    return this.generateTokenForStep(counter);
  }

  /** Seconds until the current code rotates — lets the UI show a countdown. */
  secondsUntilRotation(timeStepSeconds = TIME_STEP_SECONDS) {
    return timeStepSeconds - (Math.floor(Date.now() / 1000) % timeStepSeconds);
  }

  /**
   * Validates a user-supplied passcode, tolerating one step of clock drift.
   * @param {string} token
   * @returns {boolean}
   */
  verifyToken(token) {
    const candidate = String(token || '').trim();
    if (!/^\d{6}$/.test(candidate)) {
      return false;
    }

    const currentStep = Math.floor(Math.floor(Date.now() / 1000) / TIME_STEP_SECONDS);

    let matched = false;
    for (let drift = -ALLOWED_DRIFT_STEPS; drift <= ALLOWED_DRIFT_STEPS; drift++) {
      const expected = this.generateTokenForStep(currentStep + drift);
      // Compare every candidate without short-circuiting, so verification takes
      // the same time regardless of which step matched.
      if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(candidate))) {
        matched = true;
      }
    }

    return matched;
  }
}

module.exports = TotpAuth;
