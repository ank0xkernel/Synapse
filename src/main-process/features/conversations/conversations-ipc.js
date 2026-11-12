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
  let lastState = null;
  const store = createConversationStore({ filePath: path.join(app.getPath('userData'), 'conversations', 'history.json'), log });
  const sync = createConversationSync({
    store,
    remote: webSync.remote,
    log,
    onStatus: (status) => {
      if (status.state !== lastState) console.log(`[conversations] sync ${status.state} pending=${status.pending}${status.error ? ` (${status.error})` : ''}`);
      lastState = status.state;
      sendToWindow('conversations:status', status);
    },
    onRemoteChange: (change) => {
      sendToWindow('conversations:remote', change);
      // The open conversation was deleted on the website: its screen problems go with it.
      if (change?.currentDeleted) currentChanged();
    },
    onSettings: (settings) => sendToWindow('conversations:settings', settings)
  });

  const changed = (value) => { sync.notifyLocalChange(); return value; };
  // Screen problems belong to the open conversation; listeners reload them when it changes.
  const currentListeners = new Set();
  const beforeListeners = new Set();
  // Pending problem saves belong to the conversation that is still open: write them before it changes.
  const beforeChange = () => {
    for (const fn of beforeListeners) { try { fn(); } catch (error) { log('error', `problem save failed: ${error.message}`); } }
  };
  const currentChanged = (value) => {
    for (const fn of currentListeners) { try { fn(store.getProblems()); } catch (error) { log('error', `problem reload failed: ${error.message}`); } }
    return value;
  };

  ipcMain.handle('conversations:append', (_e, message) => changed(store.appendMessage(message)));
  ipcMain.handle('conversations:new', () => { beforeChange(); return currentChanged(changed(store.startNew())); });
  ipcMain.handle('conversations:list', () => store.list());
  ipcMain.handle('conversations:current', () => store.current());
  ipcMain.handle('conversations:open', (_e, id) => {
    if (!ID.test(String(id))) return null;
    beforeChange();
    return currentChanged(store.open(String(id)));
  });
  ipcMain.handle('conversations:rename', (_e, { id, title } = {}) => (ID.test(String(id)) ? changed(store.rename(String(id), title)) : null));
  ipcMain.handle('conversations:delete', (_e, id) => {
    if (!ID.test(String(id))) return false;
    const wasCurrent = store.current()?.id === String(id).toLowerCase();
    const removed = changed(store.remove(String(id)));
    return wasCurrent ? currentChanged(removed) : removed;
  });
  ipcMain.handle('conversations:sync', () => sync.syncNow());
  ipcMain.handle('conversations:status', () => sync.status());
  ipcMain.handle('conversations:settings', () => store.getSettings());
  ipcMain.handle('conversations:set-response-mode', (_e, mode) => {
    if (!['quick', 'professional', 'technical', 'star', 'detailed'].includes(mode)) return null;
    return changed(store.queueSettings({ responseMode: mode }));
  });

  return {
    start: () => {
      // linked() decrypts the stored device token with safeStorage (Keychain). "unlinked" after a rebuild means the Keychain key no longer opens it.
      const linked = webSync.remote.linked();
      const locked = linked ? null : webSync.remote.locked?.();
      console.log(`[conversations] web link: ${linked ? 'linked' : locked ? `LOCKED (saved link exists, Keychain refused this build: ${webSync.remote.lockedReason?.()})` : 'unlinked'}; secure storage ${webSync.remote.secureStorage?.() ? 'available' : 'UNAVAILABLE'}; ${store.list().length} saved conversation(s)`);
      return sync.start();
    },
    syncNow: () => sync.syncNow(),
    problems: {
      load: () => store.getProblems(),
      save: (problems) => store.setProblems(problems),
      onCurrentChange: (fn) => { currentListeners.add(fn); return () => currentListeners.delete(fn); },
      onBeforeCurrentChange: (fn) => { beforeListeners.add(fn); return () => beforeListeners.delete(fn); }
    },
    cleanup: () => {
      sync.stop();
      try { store.flush(); } catch (error) { log('error', `conversation store flush failed: ${error.message}`); }
    }
  };
}

module.exports = { registerConversationsIpc };
