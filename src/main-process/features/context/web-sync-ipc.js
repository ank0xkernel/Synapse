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
const { applyWebBundle, clearWebContext } = require('./context-ipc');

function registerWebSyncIpc({ ipcMain, app, shell, safeStorage, sendToWindow }) {
  const dir = path.join(app.getPath('userData'), 'web-sync');
  const previewDir = path.join(app.getPath('temp'), 'synapse-resume-preview');
  const credentialStore = createCredentialStore({ safeStorage, filePath: path.join(dir, 'account.bin') });
  // The cached bundle holds resume text, so it is encrypted the same way.
  const cacheStore = createCredentialStore({ safeStorage, filePath: path.join(dir, 'context-cache.bin') });

  const removePreviews = () => fs.rmSync(previewDir, { recursive: true, force: true });

  const webSync = createWebSync({
    credentialStore,
    cacheStore,
    openExternal: (url) => shell.openExternal(url),
    applyBundle: applyWebBundle,
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
