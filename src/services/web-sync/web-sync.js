'use strict';

/**
 * Desktop side of docs/desktop-web-contract.md (v1).
 *
 *   link()        browser sign-in with PKCE + loopback; token into the Keychain
 *   check()       one GET /context with If-None-Match; applies a newer bundle
 *                 only when canAutoApply() says nothing local would be lost
 *   applyPending  write the fetched bundle into the local interview context
 *                 the AI reads (the user confirmed, or auto-apply)
 *   unlink()      revoke on the server, delete token, cache and web-sourced context
 *
 * No polling: check() runs when the user presses Refresh or starts listening.
 * Live answers never wait on this module.
 */

const os = require('os');
const { createPkcePair, createState, startLoopbackReceiver } = require('./pkce-loopback');

const STATUS = Object.freeze({
  UNLINKED: 'unlinked',
  NOT_CHECKED: 'not-checked',
  LINKING: 'linking',
  CHECKING: 'checking',
  UP_TO_DATE: 'up-to-date',
  NEWER_AVAILABLE: 'newer-available',
  NO_CONTEXT: 'no-context',
  OFFLINE: 'offline',
  AUTH_EXPIRED: 'auth-expired',
  ERROR: 'error'
});

/** Only https, or http to this machine for local development. */
function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch (_) {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  return url.origin;
}

function isBundle(body) {
  return body && body.ok === true && typeof body.version === 'string' && body.schema_version === 1;
}

function createWebSync({
  credentialStore,
  cacheStore,
  openExternal,
  applyBundle,
  clearWebContext,
  // True when applying cannot overwrite anything the user wrote on this Mac.
  canAutoApply = () => false,
  fetchImpl = fetch,
  deviceName = `Synapse on ${os.hostname().replace(/\.local$/, '')}`.slice(0, 60),
  now = () => Date.now(),
  onChange = () => {}
}) {
  let status = STATUS.UNLINKED;
  let error = null;
  let pending = null; // fetched bundle awaiting confirmation (in memory only)
  let linking = null;

  const credential = () => credentialStore.load();
  const cache = () => cacheStore.load();

  function snapshot() {
    const cred = credential();
    const cached = cache();
    if (!cred && status !== STATUS.LINKING) status = STATUS.UNLINKED;
    // Linked, but nothing checked yet this run: never claim "up to date".
    if (cred && status === STATUS.UNLINKED) status = STATUS.NOT_CHECKED;
    return {
      status,
      error,
      secureStorage: credentialStore.available(),
      account: cred ? { email: cred.account?.email || '', baseUrl: cred.baseUrl, expiresAt: cred.expiresAt } : null,
      applied: cached ? {
        version: cached.version,
        appliedAt: cached.appliedAt,
        auto: Boolean(cached.auto),
        checkedAt: cached.checkedAt || null,
        resumeName: cached.bundle?.resume?.name || null,
        resumeId: cached.bundle?.resume?.id || null,
        hasPdf: Boolean(cached.bundle?.resume?.has_pdf),
        sessionTitle: cached.bundle?.session?.title || null,
        company: cached.bundle?.settings?.company || cached.bundle?.job_description?.company || '',
        role: cached.bundle?.settings?.role || cached.bundle?.job_description?.role || '',
        responseMode: cached.bundle?.settings?.response_mode || null
      } : null,
      pending: pending ? {
        version: pending.version,
        resumeName: pending.resume?.name || null,
        sessionTitle: pending.session?.title || null,
        company: pending.settings?.company || pending.job_description?.company || '',
        role: pending.settings?.role || pending.job_description?.role || '',
        updatedAt: pending.updated_at || null
      } : null
    };
  }

  function set(nextStatus, nextError = null) {
    status = nextStatus;
    error = nextError;
    onChange(snapshot());
    return snapshot();
  }

  async function request(path, { method = 'GET', headers = {}, body } = {}) {
    const cred = credential();
    if (!cred) {
      const err = new Error('Not linked');
      err.code = 'UNLINKED';
      throw err;
    }
    return fetchImpl(`${cred.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cred.token}`, ...headers },
      body,
      signal: AbortSignal.timeout(15000)
    });
  }

  async function link(baseUrlInput) {
    const baseUrl = normalizeBaseUrl(baseUrlInput);
    if (!baseUrl) return set(STATUS.ERROR, 'Enter the website address, for example https://synapse.example.com (http only for localhost).');
    if (!credentialStore.available()) return set(STATUS.ERROR, 'Secure storage (macOS Keychain) is not available, so Synapse cannot keep a sign-in.');
    if (linking) linking.close();

    const pkce = createPkcePair();
    const state = createState();
    set(STATUS.LINKING);
    try {
      linking = await startLoopbackReceiver({ state });
      const authorize = new URL('/desktop/link', baseUrl);
      authorize.search = new URLSearchParams({
        client: 'synapse-desktop',
        redirect_uri: linking.redirectUri,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        state
      }).toString();
      await openExternal(authorize.toString());
      const { code } = await linking.result;

      const response = await fetchImpl(`${baseUrl}/api/desktop/v1/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: pkce.verifier, redirect_uri: linking.redirectUri, device_name: deviceName }),
        signal: AbortSignal.timeout(15000)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.access_token) {
        return set(STATUS.ERROR, body.error_description || body.error || `Sign-in failed (HTTP ${response.status}).`);
      }

      // A different account than before: drop the previous account's cache
      // and context before anything of the new account is shown.
      const previous = credential();
      if (previous && previous.account?.id !== body.account?.id) {
        cacheStore.clear();
        clearWebContext();
      }
      credentialStore.save({ token: body.access_token, account: body.account, baseUrl, expiresAt: body.expires_at });
      linking = null;
      set(STATUS.CHECKING);
      return check();
    } catch (err) {
      linking = null;
      return set(credential() ? status : STATUS.UNLINKED, err.message);
    }
  }

  function cancelLink() {
    if (linking) linking.close();
    linking = null;
    return set(credential() ? STATUS.UP_TO_DATE : STATUS.UNLINKED);
  }

  /** One conditional request; stores a newer bundle as pending, never applies it. */
  async function check() {
    if (!credential()) return set(STATUS.UNLINKED);
    const cached = cache();
    set(STATUS.CHECKING);
    let response;
    try {
      response = await request('/api/desktop/v1/context', {
        headers: cached?.version ? { 'If-None-Match': `"${cached.version}"` } : {}
      });
    } catch (err) {
      if (err.code === 'UNLINKED') return set(STATUS.UNLINKED);
      return set(STATUS.OFFLINE, cached
        ? 'Could not reach the website. Using the context you already applied; it may be out of date.'
        : 'Could not reach the website, and nothing has been synced yet.');
    }

    if (response.status === 304) {
      cacheStore.save({ ...cached, checkedAt: new Date(now()).toISOString() });
      pending = null;
      return set(STATUS.UP_TO_DATE);
    }
    if (response.status === 401) {
      return set(STATUS.AUTH_EXPIRED, 'Your website sign-in expired or was revoked. Link this Mac again.');
    }
    if (response.status === 404) {
      pending = null;
      return set(STATUS.NO_CONTEXT, 'No active resume on the website yet. Upload one there and mark it active.');
    }
    const body = await response.json().catch(() => null);
    if (!response.ok || !isBundle(body)) {
      return set(STATUS.ERROR, `The website answered with an unexpected response (HTTP ${response.status}). Nothing was changed.`);
    }
    if (cached?.version === body.version) {
      pending = null;
      cacheStore.save({ ...cached, checkedAt: new Date(now()).toISOString() });
      return set(STATUS.UP_TO_DATE);
    }
    pending = body;
    if (canAutoApply()) return applyPending({ auto: true });
    return set(STATUS.NEWER_AVAILABLE);
  }

  /** Writes the newer context; `auto` when no confirmation was needed. */
  function applyPending({ auto = false } = {}) {
    if (!pending) return set(status, 'There is no newer context to apply.');
    applyBundle(pending);
    const timestamp = new Date(now()).toISOString();
    cacheStore.save({ version: pending.version, bundle: pending, appliedAt: timestamp, checkedAt: timestamp, auto });
    pending = null;
    return set(STATUS.UP_TO_DATE);
  }

  async function unlink() {
    try {
      if (credential()) await request('/api/desktop/v1/logout', { method: 'POST' });
    } catch (_) {
      // Offline: the token is still deleted locally; it can be revoked on the website.
    }
    credentialStore.clear();
    cacheStore.clear();
    clearWebContext();
    pending = null;
    return set(STATUS.UNLINKED);
  }

  /** On-demand PDF for preview; returns a Buffer or throws. */
  async function fetchResumePdf() {
    const resumeId = cache()?.bundle?.resume?.id;
    if (!resumeId) throw new Error('No synced resume to preview.');
    const response = await request(`/api/desktop/v1/resumes/${encodeURIComponent(resumeId)}/pdf`);
    if (response.status === 401) {
      set(STATUS.AUTH_EXPIRED, 'Your website sign-in expired or was revoked. Link this Mac again.');
      throw new Error('Sign-in expired.');
    }
    if (!response.ok) throw new Error(response.status === 404 ? 'This resume has no PDF (it was pasted as text).' : `Could not download the PDF (HTTP ${response.status}).`);
    return Buffer.from(await response.arrayBuffer());
  }

  return { snapshot, link, cancelLink, check, applyPending, unlink, fetchResumePdf, STATUS };
}

module.exports = { createWebSync, normalizeBaseUrl, STATUS };
