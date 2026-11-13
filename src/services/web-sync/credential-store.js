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

  let lockedReason = null;

  /**
   * @returns {object|null} null when nothing is stored or it cannot be decrypted.
   * A stored file that cannot be decrypted sets locked() instead of looking unlinked:
   * on macOS that is the Keychain refusing this build the key (ad-hoc builds get a new
   * code hash on every rebuild). The file is kept, so approving Keychain access restores it.
   */
  function load() {
    if (!fs.existsSync(filePath)) { lockedReason = null; return null; }
    if (!available()) { lockedReason = 'Secure storage (macOS Keychain) is not available.'; return null; }
    try {
      const value = JSON.parse(safeStorage.decryptString(fs.readFileSync(filePath)));
      lockedReason = null;
      return value;
    } catch (error) {
      lockedReason = error.message || 'decrypt failed';
      return null;
    }
  }

  /** Why a stored credential could not be opened, or null. Call after load(). */
  function locked() {
    return lockedReason;
  }

  function clear() {
    fs.rmSync(filePath, { force: true });
    lockedReason = null;
  }

  return { available, save, load, clear, locked, filePath };
}

module.exports = { createCredentialStore };
