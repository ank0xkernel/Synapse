'use strict';

/**
 * Wires services/web-sync to Electron: Keychain-encrypted storage
 * (safeStorage), the system browser for sign-in, and IPC for the
 * Resume & context panel. Sync state goes to the desktop window only, never
 * to the phone companion broadcast.
 */

const fs = require('fs');
const path = require('path');
const { createCredentialStore } = require('../../../services/web-sync/credential-store');
const { createWebSync } = require('../../../services/web-sync/web-sync');
const { applyWebBundle, canReplaceWithWebContext, clearWebContext } = require('./context-ipc');

function registerWebSyncIpc({ ipcMain, app, shell, safeStorage, sendToWindow }) {
  const dir = path.join(app.getPath('userData'), 'web-sync');
  const previewDir = path.join(app.getPath('temp'), 'synapse-resume-preview');
  const credentialStore = createCredentialStore({ safeStorage, filePath: path.join(dir, 'account.bin') });
  // The cached bundle holds resume text, so it is encrypted the same way.
  const cacheStore = createCredentialStore({ safeStorage, filePath: path.join(dir, 'context-cache.bin') });

  const removePreviews = () => fs.rmSync(previewDir, { recursive: true, force: true });

  // Keychain key check for the log: was last launch's probe readable (same key), and is a new one writable?
  // A failed read after a rebuild explains a "locked" web link. The probe holds no secret.
  try {
    const probeFile = path.join(dir, 'keychain-probe.bin');
    let previous = 'none';
    if (fs.existsSync(probeFile)) {
      try { previous = safeStorage.decryptString(fs.readFileSync(probeFile)) === 'synapse-probe' ? 'readable (same key)' : 'mismatch'; } catch (_) { previous = 'UNREADABLE (key changed)'; }
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probeFile, safeStorage.encryptString('synapse-probe'), { mode: 0o600 });
    console.log(`[web-sync] keychain probe from last launch: ${previous}; new probe written`);
  } catch (error) {
    console.log(`[web-sync] keychain probe failed: ${error.message}`);
  }

  const webSync = createWebSync({
    credentialStore,
    cacheStore,
    openExternal: (url) => shell.openExternal(url),
    applyBundle: applyWebBundle,
    canAutoApply: () => canReplaceWithWebContext(cacheStore.load()?.bundle),
    clearWebContext: () => {
      clearWebContext();
      removePreviews();
    },
    onChange: (state) => sendToWindow('web-sync:state', state)
  });

  ipcMain.handle('web-sync:state', () => webSync.snapshot());
  ipcMain.handle('web-sync:link', (_event, { baseUrl } = {}) => webSync.link(baseUrl));
  ipcMain.handle('web-sync:cancel-link', () => webSync.cancelLink());
  ipcMain.handle('web-sync:check', () => webSync.check());
  ipcMain.handle('web-sync:apply', () => webSync.applyPending());
  ipcMain.handle('web-sync:unlink', () => webSync.unlink());
  ipcMain.handle('web-sync:view-pdf', async () => {
    try {
      const bytes = await webSync.fetchResumePdf();
      fs.mkdirSync(previewDir, { recursive: true });
      const file = path.join(previewDir, 'resume.pdf');
      fs.writeFileSync(file, bytes, { mode: 0o600 });
      const error = await shell.openPath(file);
      return error ? { success: false, error } : { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  return {
    webSync,
    /** One non-blocking freshness check before a live session; never applies. */
    checkBeforeSession: () => {
      if (credentialStore.load()) webSync.check().catch(() => {});
    },
    cleanup: removePreviews
  };
}

module.exports = { registerWebSyncIpc };
