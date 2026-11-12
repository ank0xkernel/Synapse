'use strict';

/**
 * Local conversation history for the desktop app.
 *
 * One conversation = the chat between two clears. The store lives in a JSON
 * file in userData, so history survives restarts and works with no network.
 * Every local change is also queued in `outbox`; conversation-sync pushes the
 * queue to the website and merges what the website sends back.
 *
 * The file is plain JSON with mode 0600, deliberately not safeStorage: a
 * Keychain key that changes after a rebuild would make the whole history
 * unreadable. FileVault protects it at rest.
 *
 * Writes are atomic (temp file + rename) and debounced; flush() on quit.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROLES = new Set(['user', 'assistant', 'transcript', 'screen']);
const MAX_CONTENT = 100000;

function emptyState() {
  return { version: 1, currentId: null, accountId: null, cursor: null, settings: null, conversations: {}, outbox: { conv: {}, msg: {}, deleted: {} } };
}

function titleFrom(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

const iso = (v) => {
  const d = v ? new Date(v) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};

function createConversationStore({ filePath, now = () => Date.now(), writeDelayMs = 300, log = () => {} }) {
  let state = load();
  let timer = null;

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (raw && raw.version === 1 && raw.conversations && raw.outbox) {
        raw.outbox.deleted = raw.outbox.deleted || {};
        return raw;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Keep the unreadable file for recovery instead of overwriting it.
        try { fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`); } catch (_) {}
        log('warn', `conversation store unreadable, starting empty: ${error.message}`);
      }
    }
    return emptyState();
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }

  function save() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try { flush(); } catch (error) { log('error', `conversation store write failed: ${error.message}`); }
    }, writeDelayMs);
  }

  const nowIso = () => new Date(now()).toISOString();

  function summary(c) {
    const last = c.messages[c.messages.length - 1];
    return {
      id: c.id,
      title: c.title,
      summary: c.summary,
      source: c.source,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: c.messages.length,
      preview: last ? String(last.content).slice(0, 160) : '',
      current: c.id === state.currentId
    };
  }

  function list() {
    return Object.values(state.conversations).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map(summary);
  }

  function get(id) {
    const c = state.conversations[id];
    return c ? { ...summary(c), messages: c.messages.slice() } : null;
  }

  function current() {
    return state.currentId ? get(state.currentId) : null;
  }

  function createConversation(title) {
    const id = crypto.randomUUID();
    const at = nowIso();
    state.conversations[id] = { id, title: title || '', summary: '', source: 'desktop', createdAt: at, editedAt: at, updatedAt: at, messages: [] };
    state.outbox.conv[id] = at;
    return state.conversations[id];
  }

  /**
   * Appends to the current conversation, creating it on the first message.
   * Returns the stored message, or null when the input is not storable.
   */
  function appendMessage(input) {
    const role = String(input?.role || '');
    const content = String(input?.content || '').trim().slice(0, MAX_CONTENT);
    if (!ROLES.has(role) || !content) return null;
    let conv = state.currentId && state.conversations[state.currentId];
    if (!conv) {
      conv = createConversation(role === 'assistant' ? '' : titleFrom(content));
      state.currentId = conv.id;
    }
    const id = typeof input.id === 'string' && /^[0-9a-f-]{36}$/i.test(input.id) ? input.id.toLowerCase() : crypto.randomUUID();
    if (conv.messages.some((m) => m.id === id)) return null;
    const meta = input.meta && typeof input.meta === 'object' ? input.meta : {};
    const message = { id, role, content, meta, createdAt: iso(input.createdAt) };
    conv.messages.push(message);
    if (!conv.title && role !== 'assistant') {
      conv.title = titleFrom(content);
      conv.editedAt = nowIso();
      state.outbox.conv[conv.id] = conv.editedAt;
    }
    conv.updatedAt = nowIso();
    state.outbox.msg[id] = conv.id;
    save();
    return message;
  }

  /** The next message starts a new conversation; the old one stays in history. */
  function startNew() {
    state.currentId = null;
    save();
  }

  function open(id) {
    if (!state.conversations[id]) return null;
    state.currentId = id;
    save();
    return get(id);
  }

  function rename(id, title) {
    const c = state.conversations[id];
    const next = String(title || '').trim().slice(0, 200);
    if (!c || !next) return null;
    c.title = next;
    c.editedAt = nowIso();
    c.updatedAt = c.editedAt;
    state.outbox.conv[id] = c.editedAt;
    save();
    return summary(c);
  }

  function remove(id) {
    const c = state.conversations[id];
    if (!c) return false;
    delete state.conversations[id];
    delete state.outbox.conv[id];
    for (const [mid, cid] of Object.entries(state.outbox.msg)) if (cid === id) delete state.outbox.msg[mid];
    state.outbox.deleted[id] = nowIso();
    if (state.currentId === id) state.currentId = null;
    save();
    return true;
  }

  function pendingCount() {
    return Object.keys(state.outbox.conv).length + Object.keys(state.outbox.msg).length + Object.keys(state.outbox.deleted).length + (state.pendingSettings ? 1 : 0);
  }

  /**
   * The next batch to push, within the server's limits (500 items each, 4 MB
   * body). Returns null when nothing is queued.
   */
  function buildPush({ maxItems = 500, maxBytes = 3 * 1024 * 1024 } = {}) {
    const conversations = [];
    for (const id of Object.keys(state.outbox.deleted).slice(0, maxItems)) conversations.push({ id, title: '', summary: '', deleted: true });
    for (const id of Object.keys(state.outbox.conv)) {
      if (conversations.length >= maxItems) break;
      const c = state.conversations[id];
      if (c) conversations.push({ id, title: c.title, summary: c.summary, created_at: c.createdAt, edited_at: c.editedAt });
    }
    const messages = [];
    let bytes = 0;
    for (const [mid, cid] of Object.entries(state.outbox.msg)) {
      if (messages.length >= maxItems) break;
      const c = state.conversations[cid];
      const m = c?.messages.find((x) => x.id === mid);
      if (!m) { delete state.outbox.msg[mid]; continue; }
      const item = { id: m.id, conversation_id: cid, role: m.role, content: m.content, meta: m.meta, created_at: m.createdAt };
      const size = Buffer.byteLength(JSON.stringify(item));
      if (messages.length && bytes + size > maxBytes) break;
      bytes += size;
      messages.push(item);
    }
    // A message needs its conversation on the server; the server applies conversations before messages,
    // so a still-queued conversation row rides in the same batch.
    for (const m of messages) {
      if (state.outbox.conv[m.conversation_id] !== undefined && !conversations.some((x) => x.id === m.conversation_id)) {
        const c = state.conversations[m.conversation_id];
        conversations.push({ id: c.id, title: c.title, summary: c.summary, created_at: c.createdAt, edited_at: c.editedAt });
      }
    }
    const settings = state.pendingSettings || undefined;
    if (!conversations.length && !messages.length && !settings) return null;
    return { conversations, messages, ...(settings ? { settings } : {}) };
  }

  /** The server accepted `batch`; drop it from the queue unless it was edited again meanwhile. */
  function ackPush(batch, { refused = [] } = {}) {
    for (const c of batch.conversations) {
      if (c.deleted) { delete state.outbox.deleted[c.id]; continue; }
      if (state.outbox.conv[c.id] === c.edited_at) delete state.outbox.conv[c.id];
    }
    for (const m of batch.messages) delete state.outbox.msg[m.id];
    if (batch.settings && state.pendingSettings?.updated_at === batch.settings.updated_at) state.pendingSettings = null;
    // Refused: deleted on the website (or not this account's). A delete wins.
    for (const id of refused) dropLocal(id);
    save();
  }

  function dropLocal(id) {
    delete state.conversations[id];
    delete state.outbox.conv[id];
    for (const [mid, cid] of Object.entries(state.outbox.msg)) if (cid === id) delete state.outbox.msg[mid];
    if (state.currentId === id) state.currentId = null;
  }

  /**
   * Merges a pull page. Returns what changed for the open conversation so the
   * window can show it: messages added to it, or that it was deleted.
   */
  function applyPull({ conversations = [], messages = [] }) {
    const result = { changed: false, currentDeleted: false, addedToCurrent: [] };
    for (const r of conversations) {
      if (state.outbox.deleted[r.id]) continue; // deleted here, push pending
      const local = state.conversations[r.id];
      if (r.deleted_at) {
        if (local) {
          if (state.currentId === r.id) result.currentDeleted = true;
          dropLocal(r.id);
          result.changed = true;
        }
        continue;
      }
      if (!local) {
        state.conversations[r.id] = {
          id: r.id, title: r.title || '', summary: r.summary || '', source: r.source || 'web',
          createdAt: iso(r.created_at), editedAt: iso(r.edited_at), updatedAt: iso(r.updated_at), messages: []
        };
        result.changed = true;
      } else if (iso(r.edited_at) > local.editedAt && state.outbox.conv[r.id] === undefined) {
        local.title = r.title || '';
        local.summary = r.summary || '';
        local.editedAt = iso(r.edited_at);
        result.changed = true;
      }
    }
    for (const r of messages) {
      const c = state.conversations[r.conversation_id];
      if (!c || c.messages.some((m) => m.id === r.id)) continue;
      const message = { id: r.id, role: r.role, content: r.content, meta: r.meta || {}, createdAt: iso(r.created_at) };
      c.messages.push(message);
      c.messages.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      if (message.createdAt > c.updatedAt) c.updatedAt = message.createdAt;
      if (c.id === state.currentId) result.addedToCurrent.push(message);
      result.changed = true;
    }
    if (result.changed) save();
    return result;
  }

  function getCursor() { return state.cursor; }
  function setCursor(cursor) { state.cursor = cursor || null; save(); }

  /** A different web account: start its sync from scratch. Local history stays. */
  function bindAccount(accountId) {
    if (state.accountId === accountId) return false;
    state.accountId = accountId || null;
    state.cursor = null;
    save();
    return true;
  }

  function getSettings() { return state.pendingSettings?.data || state.settings; }
  /** From the website. A local change that has not been pushed yet is kept. */
  function setSettings(settings) { state.settings = settings; save(); }
  /** A local change (the answer-style picker); pushed with the next sync, later edit wins. */
  function queueSettings(patch) {
    const data = { ...(state.settings || {}), ...patch };
    state.settings = data;
    state.pendingSettings = { data, updated_at: nowIso() };
    save();
    return data;
  }

  return {
    appendMessage, startNew, open, rename, remove, list, get, current,
    buildPush, ackPush, applyPull, pendingCount,
    getCursor, setCursor, bindAccount, getSettings, setSettings, queueSettings, flush
  };
}

module.exports = { createConversationStore, titleFrom };
