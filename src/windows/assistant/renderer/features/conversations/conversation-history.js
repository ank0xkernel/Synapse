/**
 * Saves the desktop chat to the local conversation history (main process,
 * src/services/conversations) and drives the History sheet: reopen, rename,
 * delete, start new, and the sync state with the website.
 *
 * What is saved: transcripts, typed context, screen text and finished or
 * interrupted answers. System notices and Mode C's in-context toggles are not:
 * they only mean something with the screen in front of you. Screenshots are
 * saved as their text, never as images.
 */

const api = () => window.electronAPI || {};

const TYPE_TO_ROLE = {
  voice: ['transcript', 'me'],
  'voice-mic': ['transcript', 'me'],
  'voice-system': ['transcript', 'host'],
  screenshot: ['screen', null],
  'ai-response': ['assistant', null]
};

/** Stored role and meta for a chat record, or null when that type is not saved. */
export function toStored(record, extra = {}) {
  const mapped = TYPE_TO_ROLE[record?.type];
  const content = String(record?.content || '').trim();
  if (!mapped || !content) return null;
  const [role, speaker] = mapped;
  const meta = { type: record.type, ...extra };
  if (speaker) meta.speaker = speaker;
  if (record.problemId) meta.problemId = record.problemId;
  return { id: record.id, role, content, meta, createdAt: (record.timestamp instanceof Date ? record.timestamp : new Date()).toISOString() };
}

/** Chat type to show a stored message as. Messages written on the website map to the closest desktop type. */
export function toChatType(message) {
  if (message?.meta?.type && TYPE_TO_ROLE[message.meta.type]) return message.meta.type;
  if (message?.role === 'assistant') return 'ai-response';
  if (message?.role === 'screen') return 'screenshot';
  if (message?.role === 'transcript' && message?.meta?.speaker === 'host') return 'voice-system';
  return 'voice-mic';
}

export function persistMessage(record, extra) {
  const stored = toStored(record, extra);
  if (stored) api().conversationsAppend?.(stored);
}

const STATUS_TEXT = {
  idle: 'Saved on this Mac.',
  unlinked: 'Saved on this Mac only. Link your website account (Resume & context) to sync.',
  syncing: 'Syncing with the website…',
  synced: 'Synced with the website.',
  offline: null,
  'auth-expired': null,
  locked: null,
  error: null
};

const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function initConversationHistory({ renderMessages, clearChatView, setResponseMode, showFeedback = () => {} }) {
  const panel = document.getElementById('history-panel');
  const list = document.getElementById('history-list');
  const statusEl = document.getElementById('history-sync-status');
  if (!panel || !list) return;
  let lastFocus = null;

  function paintStatus(status) {
    if (!statusEl || !status) return;
    let text = STATUS_TEXT[status.state] ?? status.error ?? '';
    if (status.state !== 'syncing' && status.error) text = status.error;
    if (status.pending > 0 && status.state !== 'synced') text += ` ${status.pending} change(s) waiting to sync.`;
    if (status.lastSyncedAt && status.state !== 'syncing') text += ` Last sync ${fmt.format(new Date(status.lastSyncedAt))}.`;
    statusEl.textContent = text.trim();
    statusEl.dataset.state = status.state;
  }

  function item(c) {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.dataset.current = String(Boolean(c.current));

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'history-open';
    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = c.title || 'Untitled conversation';
    const meta = document.createElement('span');
    meta.className = 'history-meta';
    meta.textContent = `${fmt.format(new Date(c.updatedAt))} · ${c.messageCount} message${c.messageCount === 1 ? '' : 's'}${c.current ? ' · open now' : ''}${c.source === 'web' ? ' · from web' : ''}`;
    const preview = document.createElement('span');
    preview.className = 'history-preview';
    preview.textContent = c.preview || '';
    open.append(title, meta, preview);
    open.addEventListener('click', () => openConversation(c.id));

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'btn btn-ghost btn-sm';
    rename.textContent = 'Rename';
    rename.setAttribute('aria-label', `Rename ${c.title || 'conversation'}`);
    rename.addEventListener('click', () => startRename(li, c));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-ghost btn-sm history-delete';
    del.textContent = 'Delete';
    del.setAttribute('aria-label', `Delete ${c.title || 'conversation'}`);
    del.addEventListener('click', async () => {
      // Two-step confirm: native dialogs block the overlay.
      if (del.dataset.armed !== 'true') {
        del.dataset.armed = 'true';
        del.textContent = 'Confirm delete';
        setTimeout(() => { del.dataset.armed = 'false'; del.textContent = 'Delete'; }, 4000);
        return;
      }
      await api().conversationsDelete?.(c.id);
      if (c.current) clearChatView();
      showFeedback('Conversation deleted', 'info');
      refresh();
    });

    const actions = document.createElement('span');
    actions.className = 'history-actions';
    actions.append(rename, del);
    li.append(open, actions);
    return li;
  }

  function startRename(li, c) {
    const form = document.createElement('form');
    form.className = 'history-rename';
    const input = document.createElement('input');
    input.className = 'input';
    input.value = c.title || '';
    input.maxLength = 200;
    input.setAttribute('aria-label', 'Conversation title');
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'btn btn-primary btn-sm';
    save.textContent = 'Save';
    form.append(input, save);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (input.value.trim()) await api().conversationsRename?.(c.id, input.value.trim());
      refresh();
    });
    input.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); refresh(); } });
    li.replaceChildren(form);
    input.focus();
    input.select();
  }

  async function refresh() {
    const items = (await api().conversationsList?.()) || [];
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'history-empty';
      empty.textContent = 'No conversations yet. Everything you capture is saved here as it happens.';
      list.replaceChildren(empty);
    } else {
      list.replaceChildren(...items.map(item));
    }
    paintStatus(await api().conversationsStatus?.());
  }

  async function openConversation(id) {
    const conv = await api().conversationsOpen?.(id);
    if (!conv) { showFeedback('That conversation is no longer available', 'error'); refresh(); return; }
    clearChatView({ keepConversation: true });
    renderMessages(conv.messages);
    close();
    showFeedback(`Opened “${conv.title || 'conversation'}”`, 'info');
  }

  function openSheet() {
    lastFocus = document.activeElement;
    document.querySelectorAll('.sheet:not(.hidden)').forEach((s) => { if (s !== panel) s.classList.add('hidden'); });
    panel.classList.remove('hidden');
    panel.querySelector('[data-autofocus]')?.focus();
    refresh();
    api().conversationsSync?.();
  }

  function close() {
    if (panel.classList.contains('hidden')) return;
    panel.classList.add('hidden');
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  document.getElementById('history-btn')?.addEventListener('click', () => (panel.classList.contains('hidden') ? openSheet() : close()));
  document.getElementById('close-history')?.addEventListener('click', close);
  document.getElementById('history-new')?.addEventListener('click', () => {
    clearChatView();
    close();
    showFeedback('New conversation', 'info');
  });
  document.getElementById('history-sync')?.addEventListener('click', async () => { await api().conversationsSync?.(); refresh(); });

  api().onConversationsStatus?.((status) => {
    paintStatus(status);
    if (status?.state === 'synced' && !panel.classList.contains('hidden')) refresh();
  });
  api().onConversationsRemote?.((change) => {
    if (change?.currentDeleted) {
      clearChatView({ keepConversation: true });
      showFeedback('This conversation was deleted on another device', 'info');
    } else if (change?.addedToCurrent?.length) {
      renderMessages(change.addedToCurrent);
    }
    if (!panel.classList.contains('hidden')) refresh();
  });
  api().onConversationsSettings?.((settings) => { if (settings?.responseMode) setResponseMode(settings.responseMode); });

  // Resume where the last run left off: the open conversation comes back after a restart.
  api().conversationsCurrent?.().then((conv) => { if (conv?.messages?.length) renderMessages(conv.messages); });
  api().conversationsSettings?.().then((settings) => { if (settings?.responseMode) setResponseMode(settings.responseMode); });
}
