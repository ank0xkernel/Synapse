'use strict';

/**
 * Syncs the local conversation store with the website over the linked
 * device token (docs/desktop-web-contract.md, section 5).
 *
 *   push: the outbox, in batches; the server is idempotent, so a batch whose
 *         answer was lost is simply sent again.
 *   pull: changes since the server-issued cursor, page by page.
 *
 * Runs at start, a moment after each local change, every 2 minutes while
 * linked, and when the window gains focus. Never blocks a live answer: it is
 * all background I/O. Failures back off (5 s doubling to 5 min) and keep the
 * queue on disk, so nothing is lost while offline.
 */

const INTERVAL_MS = 120000;
const CHANGE_DEBOUNCE_MS = 2000;
const MAX_PAGES = 50;

function createConversationSync({
  store,
  // { linked(): bool, accountId(): string|null, fetch(path, opts): Promise<Response> }
  remote,
  onStatus = () => {},
  onRemoteChange = () => {},
  onSettings = () => {},
  log = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  setRepeat = setInterval,
  clearRepeat = clearInterval,
  now = () => Date.now()
}) {
  let status = { state: 'idle', lastSyncedAt: null, error: null, pending: store.pendingCount() };
  let running = null;
  let rerun = false;
  let failures = 0;
  let retryTimer = null;
  let changeTimer = null;
  let interval = null;

  function emit(patch) {
    status = { ...status, ...patch, pending: store.pendingCount() };
    onStatus(status);
    return status;
  }

  async function json(response) {
    try { return await response.json(); } catch (_) { return null; }
  }

  async function pushAll() {
    for (let i = 0; i < 1000; i++) {
      const batch = store.buildPush();
      if (!batch) return;
      const response = await remote.fetch('/api/desktop/v1/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch)
      });
      if (response.status === 401) throw Object.assign(new Error('Website sign-in expired. Link this Mac again.'), { code: 'AUTH' });
      if (response.status === 400 || response.status === 413) {
        // The server will never accept this batch; keeping it would block every later change.
        const body = await json(response);
        log('warn', `conversation push rejected: ${body?.error || response.status}; dropping ${batch.messages.length} message(s)`);
        store.ackPush(batch);
        continue;
      }
      if (!response.ok) throw new Error(`The website answered HTTP ${response.status}.`);
      const body = await json(response);
      store.ackPush(batch, { refused: Array.isArray(body?.refused) ? body.refused : [] });
    }
  }

  async function pullAll() {
    let cursor = store.getCursor();
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await remote.fetch(`/api/desktop/v1/sync${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (response.status === 401) throw Object.assign(new Error('Website sign-in expired. Link this Mac again.'), { code: 'AUTH' });
      if (response.status === 400 && cursor) { cursor = null; store.setCursor(null); continue; }
      if (!response.ok) throw new Error(`The website answered HTTP ${response.status}.`);
      const body = await json(response);
      if (!body || body.ok !== true || typeof body.cursor !== 'string') throw new Error('The website sent an unexpected sync response.');
      const change = store.applyPull(body);
      if (change.changed) onRemoteChange(change);
      if (body.settings?.settings) {
        const previous = store.getSettings();
        if (JSON.stringify(previous) !== JSON.stringify(body.settings.settings)) {
          store.setSettings(body.settings.settings);
          onSettings(body.settings.settings);
        }
      }
      cursor = body.cursor;
      store.setCursor(cursor);
      if (!body.more) return;
    }
  }

  async function run() {
    if (!remote.linked()) {
      const locked = remote.locked?.();
      return emit(locked ? { state: 'locked', error: locked } : { state: 'unlinked', error: null });
    }
    store.bindAccount(remote.accountId());
    emit({ state: 'syncing', error: null });
    try {
      await pushAll();
      await pullAll();
      failures = 0;
      return emit({ state: 'synced', lastSyncedAt: new Date(now()).toISOString(), error: null });
    } catch (error) {
      if (error.code === 'AUTH') return emit({ state: 'auth-expired', error: error.message });
      failures += 1;
      const delay = Math.min(5000 * 2 ** (failures - 1), 300000);
      clearTimer(retryTimer);
      retryTimer = setTimer(() => { syncNow(); }, delay);
      const offline = /fetch failed|network|ENOTFOUND|ECONN|timed? ?out|abort/i.test(`${error.name} ${error.message} ${error.cause?.code || ''}`);
      return emit({
        state: offline ? 'offline' : 'error',
        error: offline ? 'Offline. Changes are saved on this Mac and will sync when the website is reachable.' : error.message
      });
    }
  }

  /** One sync at a time; a request during a run schedules exactly one more. */
  function syncNow() {
    if (running) { rerun = true; return running; }
    running = run().finally(() => {
      running = null;
      if (rerun) { rerun = false; syncNow(); }
    });
    return running;
  }

  /** Call after any local change; coalesces bursts (a streaming session writes often). */
  function notifyLocalChange() {
    emit({});
    clearTimer(changeTimer);
    changeTimer = setTimer(() => { syncNow(); }, CHANGE_DEBOUNCE_MS);
  }

  function start() {
    if (!interval) interval = setRepeat(() => { if (remote.linked()) syncNow(); }, INTERVAL_MS);
    return syncNow();
  }

  function stop() {
    clearRepeat(interval);
    clearTimer(retryTimer);
    clearTimer(changeTimer);
    interval = null;
  }

  return { start, stop, syncNow, notifyLocalChange, status: () => ({ ...status, pending: store.pendingCount() }) };
}

module.exports = { createConversationSync };
