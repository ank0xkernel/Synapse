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

function resolveSecretPath(app) {
  const os = require('os');
  return path.join(os.homedir(), '.synapse-totp-secret');
}

/** Loads the persisted secret, creating one on first run. */
function loadOrCreateSecret(app) {
  const secretPath = resolveSecretPath(app);

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
