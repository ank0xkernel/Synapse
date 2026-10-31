'use strict';

/**
 * Browser sign-in for a desktop app: OAuth 2.0 for Native Apps (RFC 8252)
 * with a loopback redirect, and PKCE (RFC 7636, S256).
 *
 * The desktop never sees the web session cookie. It opens the system
 * browser at the web app's link page with a code_challenge, listens once on
 * http://127.0.0.1:<ephemeral port>/callback, checks `state`, and returns
 * the one-time code for exchange together with the code_verifier.
 */

const crypto = require('crypto');
const http = require('http');

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A fresh verifier (43–128 chars, here 64) and its S256 challenge. */
function createPkcePair() {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

function createState() {
  return base64url(crypto.randomBytes(24));
}

const RESULT_PAGE = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#0b0b0e;color:#ededf1;font:15px -apple-system,system-ui,sans-serif}
main{max-width:420px;padding:32px;text-align:center}h1{font-size:20px;font-weight:600;margin:0 0 8px}p{color:#a6a6b0;line-height:1.5;margin:0}</style>
<main><h1>${title}</h1><p>${body}</p></main>`;

/**
 * Starts a one-shot loopback receiver.
 * @param {{ state: string, timeoutMs?: number }} options
 * @returns {Promise<{ redirectUri: string, result: Promise<{ code: string }>, close: () => void }>}
 */
function startLoopbackReceiver({ state, timeoutMs = 5 * 60 * 1000 }) {
  return new Promise((resolveStart, rejectStart) => {
    let settle;
    const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    // The browser can answer before the caller awaits `result`; mark the
    // rejection handled here so it still reaches the caller when awaited
    // instead of crashing the process as unhandled.
    result.catch(() => {});
    let done = false;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const respond = (status, title, body) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(RESULT_PAGE(title, body));
      };
      // A callback with the wrong state is not ours (or is forged): reject it
      // and keep waiting for the real one.
      if (url.searchParams.get('state') !== state) {
        respond(400, 'Link request not recognized', 'Start the link again from Synapse Desktop.');
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error) {
        respond(200, 'Linking cancelled', 'You can close this tab and return to Synapse.');
        finish(new Error(error === 'access_denied' ? 'Linking was cancelled in the browser.' : `The website returned: ${error}`));
      } else if (code) {
        respond(200, 'Synapse Desktop is linked', 'You can close this tab and return to Synapse.');
        finish(null, { code });
      } else {
        respond(400, 'Link request incomplete', 'Start the link again from Synapse Desktop.');
      }
    });

    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      setImmediate(() => server.close());
      if (error) settle.reject(error);
      else settle.resolve(value);
    }

    const timer = setTimeout(() => finish(new Error('Linking timed out. Start it again from Synapse Desktop.')), timeoutMs);
    server.on('error', (error) => {
      clearTimeout(timer);
      rejectStart(error);
    });
    // Loopback only: never reachable from the network.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveStart({
        redirectUri: `http://127.0.0.1:${port}/callback`,
        result,
        close: () => finish(new Error('Linking was cancelled.'))
      });
    });
  });
}

module.exports = { createPkcePair, createState, startLoopbackReceiver, base64url };
