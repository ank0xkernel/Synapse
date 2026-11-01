/**
 * "Synapse web account" section of the Resume & context panel. Renders the
 * state reported by services/web-sync (main process); it never invents one.
 * The device token never reaches this window: only the email and status do.
 */

const api = () => window.electronAPI || {};
const URL_KEY = 'synapse.webUrl';

const LABELS = {
  unlinked: ['Not linked', 'idle'],
  'not-checked': ['Linked · not checked yet', 'idle'],
  linking: ['Waiting for the browser…', 'busy'],
  checking: ['Checking…', 'busy'],
  'up-to-date': ['Up to date', 'ok'],
  'newer-available': ['Newer context available', 'warn'],
  'no-context': ['Nothing to sync yet', 'warn'],
  offline: ['Offline', 'warn'],
  'auth-expired': ['Sign-in expired', 'error'],
  error: ['Sync failed', 'error']
};

function when(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function initWebAccount({ onApplied = () => {}, showFeedback = () => {} } = {}) {
  const $ = (id) => document.getElementById(id);
  const root = $('ctx-web');
  if (!root) return null;
  const urlInput = $('ctx-web-url');
  try { urlInput.value = localStorage.getItem(URL_KEY) || ''; } catch (_) { /* default empty */ }

  let appliedVersion;
  function render(state) {
    if (!state) return;
    // Applied by a click or automatically: either way the context view must reload.
    const version = state.applied?.version || null;
    if (appliedVersion !== undefined && version !== appliedVersion) onApplied(state);
    appliedVersion = version;
    const [label, tone] = LABELS[state.status] || ['Unknown', 'idle'];
    root.dataset.status = state.status;
    const badge = $('ctx-web-badge');
    badge.textContent = label;
    badge.dataset.tone = tone;

    const linked = Boolean(state.account);
    const details = [];
    if (linked) details.push(`Signed in as ${state.account.email}`);
    if (state.applied?.resumeName) {
      details.push(`Using "${state.applied.resumeName}"${state.applied.role || state.applied.company ? ` for ${[state.applied.role, state.applied.company].filter(Boolean).join(' at ')}` : ''}, ${state.applied.auto ? 'synced automatically' : 'applied'} ${when(state.applied.appliedAt)}`);
    } else if (linked) {
      details.push('No website context applied yet');
    }
    if (state.applied?.checkedAt && state.status === 'up-to-date') details.push(`Last checked ${when(state.applied.checkedAt)}`);
    if (state.error) details.push(state.error);
    if (!linked && !state.error) details.push('Link this Mac to your Synapse website account to use the resume and job description you manage there.');
    if (!state.secureStorage) details.push('Secure storage (macOS Keychain) is unavailable, so linking is disabled.');
    $('ctx-web-detail').textContent = details.join(' · ');

    const pending = state.pending;
    $('ctx-web-pending').hidden = !pending;
    if (pending) {
      // Only shown when auto-apply held back: the context on this Mac was edited here.
      $('ctx-web-pending-detail').textContent = [
        'Not applied automatically because the context on this Mac was edited here; using it replaces those edits',
        pending.resumeName ? `Resume: ${pending.resumeName}` : 'No resume',
        pending.role || pending.company ? `${[pending.role, pending.company].filter(Boolean).join(' at ')}` : null,
        pending.sessionTitle ? `Session: ${pending.sessionTitle}` : null,
        pending.updatedAt ? `updated ${when(pending.updatedAt)}` : null
      ].filter(Boolean).join(' · ');
    }

    const busy = state.status === 'linking' || state.status === 'checking';
    const linkButton = $('ctx-web-link');
    $('ctx-web-url-field').hidden = linked && state.status !== 'auth-expired';
    linkButton.hidden = linked && state.status !== 'auth-expired';
    linkButton.textContent = state.status === 'linking' ? 'Cancel' : (state.status === 'auth-expired' ? 'Link again' : 'Link with browser');
    linkButton.disabled = !state.secureStorage || state.status === 'checking';
    $('ctx-web-apply').hidden = !pending;
    $('ctx-web-check').hidden = !linked || state.status === 'auth-expired';
    $('ctx-web-check').disabled = busy;
    $('ctx-web-pdf').hidden = !(linked && state.applied?.hasPdf);
    $('ctx-web-unlink').hidden = !linked;
  }

  $('ctx-web-link').addEventListener('click', async () => {
    if (root.dataset.status === 'linking') {
      render(await api().webSyncCancelLink?.());
      return;
    }
    const url = urlInput.value.trim();
    try { localStorage.setItem(URL_KEY, url); } catch (_) { /* not remembered */ }
    render(await api().webSyncLink?.(url));
  });
  $('ctx-web-check').addEventListener('click', async () => render(await api().webSyncCheck?.()));
  $('ctx-web-apply').addEventListener('click', async () => {
    const state = await api().webSyncApply?.();
    render(state);
    if (state && !state.error) showFeedback('Website context applied', 'success');
  });
  $('ctx-web-pdf').addEventListener('click', async () => {
    const result = await api().webSyncViewPdf?.();
    if (!result?.success) showFeedback(result?.error || 'Could not open the PDF', 'error');
  });
  $('ctx-web-unlink').addEventListener('click', async () => {
    render(await api().webSyncUnlink?.());
    showFeedback('Unlinked. Website context removed from this Mac.', 'info');
    onApplied(null);
  });

  window.electronAPI?.onWebSyncState?.(render);

  return { refresh: async () => render(await api().webSyncState?.()) };
}
