'use strict';

const fs = require('fs');
const path = require('path');
const { net, protocol } = require('electron');
const { pathToFileURL } = require('url');

/**
 * A privileged `synapse://` scheme for the app's own renderer assets.
 *
 * The assistant window used to be loaded over `file://` with
 * `webSecurity: false`, because Chromium refuses to load an ES module
 * (`<script type="module">`) from a file URL under CORS. Disabling web security
 * to work around that also disables it for everything else the window touches,
 * and it is what produced the "Disabled webSecurity" and
 * "allowRunningInsecureContent" warnings on every launch.
 *
 * Registering our own scheme as standard + secure lets module scripts, fetch and
 * a real CSP all work with web security left on.
 */

const SCHEME = 'synapse';

// The window is addressed as synapse://assistant/<file>; each host maps to one
// directory, and nothing outside those directories is reachable.
const ROOTS = {
  assistant: path.join(__dirname, '..', '..', 'windows', 'assistant')
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

/** Must be called before `app.whenReady()`. */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    }
  ]);
}

/** Resolves a request URL to a file inside an allowed root, or null. */
function resolveRequestPath(requestUrl) {
  const parsed = new URL(requestUrl);
  const root = ROOTS[parsed.hostname];

  if (!root) {
    return null;
  }

  const relative = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  const resolved = path.resolve(root, relative || 'index.html');
  const rootWithSep = path.resolve(root) + path.sep;

  // Containment check: a crafted `..` path must not escape the asset directory.
  if (resolved !== path.resolve(root) && !resolved.startsWith(rootWithSep)) {
    return null;
  }

  return resolved;
}

/** Must be called after `app.whenReady()`. */
function registerHandler() {
  protocol.handle(SCHEME, async (request) => {
    let filePath;

    try {
      filePath = resolveRequestPath(request.url);
    } catch (_) {
      return new Response('Bad request', { status: 400 });
    }

    if (!filePath) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
    } catch (_) {
      return new Response('Not found', { status: 404 });
    }

    const response = await net.fetch(pathToFileURL(filePath).toString());
    const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()];

    if (contentType) {
      const headers = new Headers(response.headers);
      headers.set('Content-Type', contentType);
      return new Response(response.body, { status: response.status, headers });
    }

    return response;
  });
}

function urlFor(host, file) {
  return `${SCHEME}://${host}/${file}`;
}

module.exports = {
  SCHEME,
  registerHandler,
  registerScheme,
  urlFor
};
