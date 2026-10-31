'use strict';

/**
 * Stores the desktop's web credential (device token + account) encrypted
 * with Electron safeStorage, whose key lives in the macOS Keychain. The
 * plaintext token never leaves the main process: the renderer only ever
 * receives the account email and status.
 *
 * If safeStorage is unavailable (no keychain access), nothing is stored and
 * the user is told; the token is never written in plaintext.
 */

const fs = require('fs');
const path = require('path');

function createCredentialStore({ safeStorage, filePath }) {
  function available() {
    try {
      return Boolean(safeStorage && safeStorage.isEncryptionAvailable());
    } catch (_) {
      return false;
    }
  }

  function save(credential) {
    if (!available()) {
      const error = new Error('Secure storage (macOS Keychain) is not available, so the link was not saved.');
      error.code = 'SECURE_STORAGE_UNAVAILABLE';
      throw error;
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(credential));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, encrypted, { mode: 0o600 });
  }

  /** @returns {object|null} null when nothing is stored or it cannot be decrypted */
  function load() {
    if (!fs.existsSync(filePath) || !available()) return null;
    try {
      return JSON.parse(safeStorage.decryptString(fs.readFileSync(filePath)));
    } catch (_) {
      return null;
    }
  }

  function clear() {
    fs.rmSync(filePath, { force: true });
  }

  return { available, save, load, clear };
}

module.exports = { createCredentialStore };
