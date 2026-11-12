'use strict';

/**
 * Conversation history IPC for the desktop window: the renderer saves chat
 * messages here as they happen, and opens, renames or deletes past
 * conversations. Sync to the website runs in the background through the
 * linked device token. Nothing here goes to the phone companion.
 */

const path = require('path');
const { createConversationStore } = require('../../../services/conversations/conversation-store');
const { createConversationSync } = require('../../../services/conversations/conversation-sync');

const ID = /^[0-9a-f-]{36}$/i;

function registerConversationsIpc({ ipcMain, app, webSync, sendToWindow, log = () => {} }) {
  const store = createConversationStore({ filePath: path.join(app.getPath('userData'), 'conversations', 'history.json'), log });
  const sync = createConversationSync({
    store,
    remote: webSync.remote,
    log,
    onStatus: (status) => sendToWindow('conversations:status', status),
    onRemoteChange: (change) => sendToWindow('conversations:remote', change),
    onSettings: (settings) => sendToWindow('conversations:settings', settings)
  });

  const changed = (value) => { sync.notifyLocalChange(); return value; };

  ipcMain.handle('conversations:append', (_e, message) => changed(store.appendMessage(message)));
  ipcMain.handle('conversations:new', () => changed(store.startNew()));
  ipcMain.handle('conversations:list', () => store.list());
  ipcMain.handle('conversations:current', () => store.current());
  ipcMain.handle('conversations:open', (_e, id) => (ID.test(String(id)) ? store.open(String(id)) : null));
  ipcMain.handle('conversations:rename', (_e, { id, title } = {}) => (ID.test(String(id)) ? changed(store.rename(String(id), title)) : null));
  ipcMain.handle('conversations:delete', (_e, id) => (ID.test(String(id)) ? changed(store.remove(String(id))) : false));
  ipcMain.handle('conversations:sync', () => sync.syncNow());
  ipcMain.handle('conversations:status', () => sync.status());
  ipcMain.handle('conversations:settings', () => store.getSettings());
  ipcMain.handle('conversations:set-response-mode', (_e, mode) => {
    if (!['quick', 'professional', 'technical', 'star', 'detailed'].includes(mode)) return null;
    return changed(store.queueSettings({ responseMode: mode }));
  });

  return {
    start: () => sync.start(),
    syncNow: () => sync.syncNow(),
    cleanup: () => {
      sync.stop();
      try { store.flush(); } catch (error) { log('error', `conversation store flush failed: ${error.message}`); }
    }
  };
}

module.exports = { registerConversationsIpc };
