'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

// Names that almost always belong to virtual adapters (Docker, WSL, VPN,
// hypervisors). Phones cannot route to these IPs, so we want the real
// Wi-Fi/Ethernet adapter to appear first in the URL list.
const VIRTUAL_ADAPTER_PATTERNS = [
  /vethernet/i,
  /wsl/i,
  /vmware/i,
  /virtualbox/i,
  /hyper-?v/i,
  /docker/i,
  /tailscale/i,
  /zerotier/i,
  /\btap\b/i,
  /\btun\b/i,
  /loopback/i,
  /^ppp/i,
  /openvpn/i,
  /utun/i
];

function isVirtualAdapter(name = '') {
  return VIRTUAL_ADAPTER_PATTERNS.some((re) => re.test(name));
}

function getLanAddresses() {
  const real = [];
  const virtual = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const entry = { name, address: iface.address, virtual: isVirtualAdapter(name) };
        if (entry.virtual) virtual.push(entry); else real.push(entry);
      }
    }
  }
  return [...real, ...virtual];
}

const MOBILE_PORT = 7823;
// The single consolidated Web Companion page (login gate, live remote
// control, interview context editor, status panel and logs) — replaces the
// three previously separate surfaces (mobile.html, /dashboard, /context).
const COMPANION_HTML_PATH = path.join(__dirname, 'companion.html');

function createMobileServer({
  getGeminiRuntime,
  getScreenshotManager,
  notifyDesktop,
  // Optional: supplied by the composition root so the dashboard's service
  // panel, restart buttons and JD indexing act on the real services.
  getAiOrchestrator = () => null,
  getLocalServices = () => ({}),
  getSystemAudioCapture = () => null
}) {
  const clients = new Set();
  const status = {
    listening: false,
    port: MOBILE_PORT,
    urls: [],
    clientCount: 0,
    error: null
  };

  // Bearer credential for every API call and WebSocket upgrade on this server.
  //
  // This was previously a 6-digit number, which is only 900k possibilities — a
  // LAN attacker can exhaust that in seconds. It is not typed by a human (the
  // human types the rotating TOTP code, which is exchanged for this), so there
  // is no reason to keep it short.
  const sessionToken = crypto.randomBytes(32).toString('hex');

  // Deliberately NOT copied onto `status`: getStatus() is surfaced to the
  // renderer and to /api/status, and leaking the bearer there defeats the gate.

  /** Constant-time compare that tolerates length mismatch without throwing. */
  function tokensMatch(candidate) {
    const a = Buffer.from(String(candidate || ''), 'utf8');
    const b = Buffer.from(sessionToken, 'utf8');
    if (a.length !== b.length) {
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  }

  /** Extracts a bearer token from the Authorization header or ?token= query. */
  function extractToken(req) {
    const header = req.headers?.authorization || '';
    const bearer = /^Bearer\s+(.+)$/i.exec(header);
    if (bearer) {
      return bearer[1].trim();
    }

    try {
      const parsed = new URL(req.url || '/', 'http://localhost');
      return parsed.searchParams.get('token') || '';
    } catch (_) {
      return '';
    }
  }

  function isAuthorized(req) {
    return tokensMatch(extractToken(req));
  }

  /** Guards a REST route. Returns true when the request may proceed. */
  function requireAuth(req, res) {
    if (isAuthorized(req)) {
      return true;
    }

    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    return false;
  }

  // ── Login throttling ───────────────────────────────────────────────────────
  // The TOTP space is 10^6 with a +/-1 step drift window, so roughly 3 codes are
  // valid at any moment. Unthrottled, that is guessable over a LAN; this keeps
  // an attacker to a few attempts per minute per address.
  const LOGIN_MAX_ATTEMPTS = 10;
  const LOGIN_WINDOW_MS = 60 * 1000;
  const loginAttempts = new Map();

  function loginRateLimited(remoteAddress) {
    const key = String(remoteAddress || 'unknown');
    const now = Date.now();
    const recent = (loginAttempts.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);

    if (recent.length >= LOGIN_MAX_ATTEMPTS) {
      loginAttempts.set(key, recent);
      return true;
    }

    recent.push(now);
    loginAttempts.set(key, recent);
    return false;
  }

  function broadcastHapticAlert() {
    broadcast('synapse-haptic', { timestamp: Date.now() });
  }

  function broadcastToken(token) {
    broadcast('synapse-token', { token });
  }

  function broadcastComplete() {
    broadcast('synapse-complete', { timestamp: Date.now() });
  }

  function broadcastError(message) {
    broadcast('synapse-error', { message });
  }

  function emitStatus() {
    if (typeof notifyDesktop === 'function') {
      try { notifyDesktop('mobile-server-status', { ...status }); } catch (_) { /* ignore */ }
    }
  }

  function refreshUrls() {
    status.urls = getLanAddresses().map(({ name, address, virtual }) => ({
      name,
      address,
      virtual: !!virtual,
      url: `http://${address}:${MOBILE_PORT}?token=${sessionToken}`
    }));
  }

  function setClientCount(n) {
    status.clientCount = n;
    emitStatus();
  }

  function broadcast(channel, data) {
    if (clients.size === 0) return;
    const message = JSON.stringify({ channel, data });
    for (const ws of clients) {
      if (ws.readyState === 1 /* WebSocket.OPEN */) {
        try { ws.send(message); } catch (_) { /* ignore dead socket */ }
      }
    }
  }

  function sendTo(ws, channel, data) {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify({ channel, data }));
    } catch (_) { /* ignore */ }
  }

  /** Reads and parses a bounded JSON request body. */
  function readJsonBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
      let body = '';
      let aborted = false;

      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > maxBytes) {
          aborted = true;
          req.destroy();
          reject(new Error('Request body too large'));
        }
      });

      req.on('end', () => {
        if (aborted) return;
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (_) {
          reject(new Error('Malformed JSON body'));
        }
      });

      req.on('error', (error) => {
        if (!aborted) reject(error);
      });
    });
  }

  /** Live health of the local stack, for the dashboard's service panel. */
  function probeServiceHealth() {
    const systemHealth = require('../../../services/system-health');
    const geminiRuntime = getGeminiRuntime && getGeminiRuntime();
    const { ollama } = getLocalServices() || {};

    let ollamaBaseUrl = null;
    try {
      ollamaBaseUrl = geminiRuntime?.getActiveOllamaBaseUrl?.() || null;
    } catch (_) { /* provider may not expose it */ }

    return systemHealth.probeAll({
      ollamaBaseUrl,
      firstTokenMs: ollama?.lastFirstTokenMs ?? null,
      getSystemAudioCapture
    });
  }

  /**
   * Splits a free-text block into retrievable points. Prefers bullet/newline
   * structure, and falls back to sentences for prose-style pastes.
   */
  function splitIntoPoints(text, prefix) {
    const raw = String(text || '').trim();
    if (!raw) return [];

    let parts = raw
      .split(/\r?\n+/)
      .map((line) => line.replace(/^\s*(?:[-*•●]|\d+[.)])\s*/, '').trim())
      .filter((line) => line.length > 0);

    if (parts.length <= 1) {
      parts = raw.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    }

    return parts
      .filter((text_) => text_.length >= 8)
      .slice(0, 200)
      .map((text_, index) => ({ id: `${prefix}-${index}`, text: text_ }));
  }

  /** Re-embeds the brief so retrieval scores against the current JD/background. */
  async function reindexContext(context) {
    const resumeBullets = splitIntoPoints(context.background, 'resume');
    const jdPoints = splitIntoPoints(context.jobDescription, 'jd');

    const orchestrator = getAiOrchestrator();
    if (!orchestrator || typeof orchestrator.loadResumeAndJdContext !== 'function') {
      // Gemini-only setups have no local fusion engine running; the brief is
      // still persisted and still reaches the prompt via toPromptBlock().
      return { indexed: false, resumeBullets: resumeBullets.length, jdPoints: jdPoints.length };
    }

    try {
      await orchestrator.loadResumeAndJdContext(resumeBullets, jdPoints);
      return { indexed: true, resumeBullets: resumeBullets.length, jdPoints: jdPoints.length };
    } catch (error) {
      console.error('[MobileServer] Context re-index failed:', error.message);
      return {
        indexed: false,
        resumeBullets: resumeBullets.length,
        jdPoints: jdPoints.length,
        error: error.message
      };
    }
  }

  /**
   * Turns an uploaded resume into plain text. PDFs are written to a temp file
   * because the parser works on paths, and the temp copy is always removed.
   */
  async function extractResumeText({ filename, contentBase64, text }) {
    if (typeof text === 'string' && text.trim()) {
      return text;
    }

    if (!contentBase64) {
      throw new Error('No file content was received.');
    }

    const name = String(filename || 'resume.txt');
    const buffer = Buffer.from(contentBase64, 'base64');

    if (!name.toLowerCase().endsWith('.pdf')) {
      return buffer.toString('utf8');
    }

    const tmpPath = path.join(
      os.tmpdir(),
      `synapse-resume-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`
    );

    try {
      await fs.promises.writeFile(tmpPath, buffer);
      const ResumeParser = require('../../../services/ai/resume-parser');
      const parser = new ResumeParser();
      const sections = await parser.parseResume(tmpPath);

      // parseResume returns structured sections; flatten to text for the brief.
      if (Array.isArray(sections)) {
        return sections
          .map((section) => (typeof section === 'string' ? section : section?.text || ''))
          .filter(Boolean)
          .join('\n');
      }

      if (sections && typeof sections === 'object') {
        return Object.values(sections)
          .flat()
          .map((entry) => (typeof entry === 'string' ? entry : entry?.text || ''))
          .filter(Boolean)
          .join('\n');
      }

      return String(sections || '');
    } finally {
      fs.promises.unlink(tmpPath).catch(() => {});
    }
  }

  /** Actually stops and restarts a named local service. */
  async function restartService(name) {
    const { whisperCoreML, whisperMic, ollama } = getLocalServices() || {};

    const targets = {
      whisper: whisperCoreML,
      'whisper-mic': whisperMic,
      ollama
    };

    const service = targets[name];

    if (!service) {
      return {
        ok: false,
        error: `Unknown or unavailable service "${name}". Expected one of: ${Object.keys(targets).join(', ')}.`
      };
    }

    if (typeof service.start !== 'function' && typeof service.initialize !== 'function') {
      return { ok: false, error: `Service "${name}" cannot be restarted from here.` };
    }

    try {
      console.log(`[MobileServer] Restarting service: ${name}`);
      if (typeof service.stop === 'function') {
        await service.stop();
      }
      // initialize() is the entry point for Ollama; start() for the Whisper servers.
      if (name === 'ollama' && typeof service.initialize === 'function') {
        await service.initialize();
      } else {
        await service.start();
      }
      console.log(`[MobileServer] Service restarted: ${name}`);
      return { ok: true, message: `${name} restarted` };
    } catch (error) {
      console.error(`[MobileServer] Restart of ${name} failed:`, error.message);
      return { ok: false, error: error.message };
    }
  }

  /*
   * Every asset here was served with a Content-Type and nothing else — no
   * Cache-Control, no ETag, no Last-Modified. With no validator and no explicit
   * policy, browsers fall back to *heuristic* caching (RFC 9111 §4.2.2) and are
   * free to reuse the response without revalidating. Mobile Safari does exactly
   * that, aggressively, for same-origin HTML on a LAN address.
   *
   * The practical consequence: the UI is edited on disk, the app is restarted,
   * the phone is reloaded — and the phone keeps rendering the previous build.
   * Every fix looks like it silently failed. These headers make the assets
   * always-revalidate, which is free here because the server is on the LAN and
   * the payloads are a few KB.
   */
  const NO_STORE = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0'
  };

  /** Sends a UI asset with caching disabled. */
  function sendAsset(res, body, contentType) {
    res.writeHead(200, { 'Content-Type': contentType, ...NO_STORE });
    res.end(body);
  }

  const httpServer = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    /*
     * The dashboard (3D "Sci-Fi Management Core") and the standalone
     * /context "Interview Brief" page were merged into the single companion
     * page served at '/' below — see companion.html. Their URLs still get
     * bookmarked (the tray menu handed one out for months), so a request for
     * any of them redirects to '/' instead of 404ing, carrying the ?token=
     * query string forward so an already-paired link keeps working.
     */
    if (url === '/dashboard' || url.startsWith('/dashboard/') || url === '/context') {
      let target = '/';
      try {
        const parsed = new URL(req.url || '/', 'http://localhost');
        const existingToken = parsed.searchParams.get('token');
        if (existingToken) target += `?token=${encodeURIComponent(existingToken)}`;
      } catch (_) { /* redirect without the token rather than fail the request */ }

      res.writeHead(302, { Location: target, ...NO_STORE });
      res.end();
      return;
    }

    // REST API Routes
    if (url === '/api/login' && req.method === 'POST') {
      if (loginRateLimited(req.socket?.remoteAddress)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Too many attempts. Wait a minute and try again.' }));
        return;
      }

      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4096) {
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          const { token } = JSON.parse(body);
          const TotpAuth = require('../security/totp-auth');
          // shared(), not new — a fresh instance would carry a fresh secret and
          // reject every passcode the tray displays.
          const totp = TotpAuth.shared();
          // Either the rotating passcode the user reads off the tray, or an
          // already-issued bearer being resumed by a returning client.
          if (totp.verifyToken(token) || tokensMatch(token)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, sessionToken }));
          } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid passcode' }));
          }
        } catch (e) { res.writeHead(400); res.end(); }
      });
      return;
    }

    if (url === '/api/status' && req.method === 'GET') {
      if (!requireAuth(req, res)) return;

      // Health is probed live. Reporting a hardcoded `true` here made the
      // dashboard's service panel decorative — it stayed green through a
      // crashed Whisper server or a stopped Ollama.
      probeServiceHealth().then((health) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          ...health,
          clientCount: clients.size
        }));
      }).catch((error) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      });
      return;
    }

    if (url === '/api/context' && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      const interviewContext = require('../../../services/context/interview-context');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, context: interviewContext.load() }));
      return;
    }

    if (url === '/api/context' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        // A brief is a few KB of text; anything larger is a mistake or abuse.
        if (body.length > 256 * 1024) {
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          const interviewContext = require('../../../services/context/interview-context');
          // Merge onto the existing brief rather than replacing it outright.
          // interviewContext.save() sanitizes against the full FIELDS schema
          // and blanks anything missing from the input — so an Agent Settings
          // save that sends only { interviewType, answerStyle, ... } would
          // otherwise silently erase the already-indexed resume/JD text the
          // /api/resume and /api/jd handlers just wrote. Those two handlers
          // already merge server-side for the same reason; this route did not.
          const current = interviewContext.load();
          const saved = interviewContext.save({ ...current, ...JSON.parse(body) });
          console.log('[MobileServer] Interview brief updated.');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, context: saved }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        }
      });
      return;
    }

    if (url === '/api/jd' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;

      readJsonBody(req, 64 * 1024)
        .then(async ({ jdText }) => {
          const interviewContext = require('../../../services/context/interview-context');

          // Persist into the brief so the JD reaches every prompt build...
          const current = interviewContext.load();
          const saved = interviewContext.save({ ...current, jobDescription: String(jdText || '') });

          // ...and re-embed it so retrieval actually scores against it. Without
          // this the JD was accepted, acknowledged, and silently discarded.
          const indexed = await reindexContext(saved);

          console.log(`[MobileServer] Job description updated (${saved.jobDescription.length} chars, ${indexed.jdPoints} indexed points).`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: 'Job description saved and indexed', ...indexed }));
        })
        .catch((error) => {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        });
      return;
    }

    if (url === '/api/resume' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;

      // 8 MB covers any realistic resume, PDF included.
      readJsonBody(req, 8 * 1024 * 1024)
        .then(async ({ filename, contentBase64, text }) => {
          const extracted = await extractResumeText({ filename, contentBase64, text });

          if (!extracted.trim()) {
            throw new Error('That file contained no readable text.');
          }

          const interviewContext = require('../../../services/context/interview-context');
          const current = interviewContext.load();
          const saved = interviewContext.save({ ...current, background: extracted });
          const indexed = await reindexContext(saved);

          console.log(`[MobileServer] Resume indexed (${extracted.length} chars, ${indexed.resumeBullets} bullets).`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            message: `Resume indexed (${indexed.resumeBullets} bullets)`,
            chars: extracted.length,
            ...indexed
          }));
        })
        .catch((error) => {
          console.error('[MobileServer] Resume upload failed:', error.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        });
      return;
    }

    if (url === '/api/restart-service' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;

      readJsonBody(req, 4096)
        .then(async ({ service }) => {
          const result = await restartService(String(service || '').trim());
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        })
        .catch((error) => {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        });
      return;
    }

    // REST twins of the WebSocket controls, for clients that are not holding a
    // socket open (the dashboard polls; the mobile companion uses the socket).
    if (url === '/api/toggle-autopilot' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;

      readJsonBody(req, 4096)
        .then(({ enabled }) => {
          const next = !!enabled;
          if (typeof notifyDesktop === 'function') {
            notifyDesktop('set-auto-answer', { enabled: next });
          }
          broadcast('autopilot-state', { enabled: next });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, enabled: next }));
        })
        .catch((error) => {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        });
      return;
    }

    if (url === '/api/set-typing-speed' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;

      readJsonBody(req, 4096)
        .then(({ speed }) => {
          const orchestrator = getAiOrchestrator();
          if (!orchestrator || typeof orchestrator.setTypingSpeed !== 'function') {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Typing simulator not ready' }));
            return;
          }
          const applied = orchestrator.setTypingSpeed(speed);
          broadcast('typing-speed', applied);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...applied }));
        })
        .catch((error) => {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        });
      return;
    }

    /*
     * Recall: surface the user's own indexed material for a spoken question.
     *
     * Deliberately retrieval-only. There is no model call anywhere in this
     * path — it embeds the query, ranks the documents that were indexed from
     * the user's own resume and notes, and returns those snippets verbatim
     * with their source id and similarity score. Nothing is written on the
     * user's behalf, and every line can be traced back to a document they
     * uploaded.
     *
     * The absence of generation is also why it is fast: no speculative draft,
     * no warm-model requirement, no token stream to abort when the topic
     * changes. Typical end-to-end is a couple of milliseconds plus embedding.
     */
    if (url === '/api/recall' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;

      readJsonBody(req, 8192)
        .then(async ({ question, topK }) => {
          const query = String(question || '').trim();
          if (!query) {
            throw new Error('A question is required.');
          }

          const orchestrator = getAiOrchestrator();
          const vectorService = orchestrator?.fusionEngine?.vectorService;
          const started = Date.now();
          const limit = Math.min(5, Math.max(1, Number(topK) || 3));

          // The vector index only exists when a local model is running. In a
          // Gemini-only setup (no fusion engine) it is never populated, so
          // fall back to the same lightweight keyword retrieval that already
          // injects resume/JD context into every AI answer — without this,
          // Recall had nothing to query and reported "not ready" forever,
          // regardless of whether a resume or JD had actually been saved.
          const hits = vectorService && typeof vectorService.searchWithSources === 'function'
            ? await vectorService.searchWithSources(query, limit)
            : require('../../../services/ai/prompts').retrieveContextMatches(query, { limit });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            question: query,
            elapsedMs: Date.now() - started,
            // `source` is derived from the id prefix ('resume-3' -> Resume) so
            // the UI can label each line without a second lookup — both the
            // vector-index hits and the keyword-retrieval fallback use it.
            hits: hits.map(({ id, text, score }) => ({
              id,
              text,
              score: Number(score.toFixed(4)),
              source: String(id || '').startsWith('jd') ? 'Job description' : 'Resume / notes'
            }))
          }));
        })
        .catch((error) => {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        });
      return;
    }

    if (url === '/api/logs' && req.method === 'GET') {
      if (!requireAuth(req, res)) return;

      const { logBuffer } = require('../../../services/logging/log-buffer');
      let sinceId = 0;
      let limit = 200;

      try {
        const params = new URL(req.url, 'http://localhost').searchParams;
        sinceId = Number(params.get('since')) || 0;
        limit = Number(params.get('limit')) || 200;
      } catch (_) { /* defaults */ }

      const entries = logBuffer.recent(limit, sinceId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        entries,
        lastId: entries.length ? entries[entries.length - 1].id : sinceId,
        // Kept for the existing panel, which renders plain strings.
        logs: entries.map((entry) => `[${entry.level.toUpperCase()}] ${entry.message}`)
      }));
      return;
    }

    if (url === '/' || url === '/index.html') {
      try {
        const html = fs.readFileSync(COMPANION_HTML_PATH, 'utf8');
        sendAsset(res, html, 'text/html; charset=utf-8');
      } catch (err) {
        res.writeHead(500);
        res.end('Companion UI unavailable');
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  // ── WebSocket server ───────────────────────────────────────────────────────

  // `noServer` + an explicit upgrade handler is what lets us reject an
  // unauthenticated socket before it is ever established. Attaching via
  // `{ server }` accepts every upgrade first and leaves authentication to the
  // message handler — which is how this server previously let any device on the
  // LAN issue `take-screenshot`, `ask-ai` and `send-answer-to-editor` without
  // presenting a passcode.
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    if (!isAuthorized(req)) {
      console.warn(
        `[MobileServer] Rejected unauthenticated WebSocket upgrade from ${req.socket?.remoteAddress}`
      );
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    setClientCount(clients.size);
    console.log(`[MobileServer] Client connected (total: ${clients.size})`);

    // Send initial state
    const screenshotMgr = getScreenshotManager();
    sendTo(ws, 'connected', {
      screenshotsCount: screenshotMgr ? screenshotMgr.getScreenshotsCount() : 0
    });

    ws.on('message', async (rawData, _isBinary) => {
      let msg;
      try {
        msg = JSON.parse(rawData.toString());
      } catch (_) {
        sendTo(ws, 'error', { message: 'Invalid message format' });
        return;
      }

      const geminiRuntime = getGeminiRuntime();
      const screenshotManager = getScreenshotManager();

      switch (msg.type) {

        // ── Send answer to the focused desktop editor ────────────────────────
        case 'send-answer-to-editor': {
          if (typeof notifyDesktop === 'function') {
            notifyDesktop('send-answer-to-editor', {});
          }
          break;
        }

        // ── Screenshot ─────────────────────────────────────────────────────
        case 'take-screenshot': {
          if (!screenshotManager) {
            sendTo(ws, 'error', { message: 'Screenshot manager not ready' });
            break;
          }
          try {
            await screenshotManager.takeStealthScreenshot();
            // screenshot-taken-stealth is emitted via augmented sendToRenderer → broadcast
          } catch (err) {
            sendTo(ws, 'error', { message: `Screenshot failed: ${err.message}` });
          }
          break;
        }

        // ── Ask AI ─────────────────────────────────────────────────────────
        case 'ask-ai': {
          if (!geminiRuntime || !geminiRuntime.hasApiKeys()) {
            sendTo(ws, 'error', { message: 'No API key configured. Add it in the desktop Settings.' });
            break;
          }

          const contextString = typeof msg.contextString === 'string' ? msg.contextString.trim() : '';

          if (!contextString && !screenshotManager?.hasScreenshots()) {
            sendTo(ws, 'error', { message: 'Take a screenshot or type a question first.' });
            break;
          }

          // Fire-and-forget; stream events go back via broadcast
          (async () => {
            try {
              broadcast('ai-stream-start', { actionId: 'askAi' });

              const onChunk = ({ text, index }) => {
                broadcast('ai-stream-chunk', { actionId: 'askAi', text, index });
              };

              let text = '';

              if (screenshotManager && screenshotManager.hasScreenshots()) {
                const { imageParts } = await screenshotManager.buildImagePartsFromScreenshots({ strict: false });
                if (imageParts.length > 0) {
                  text = await geminiRuntime.executeWithKeyFailover((svc) => {
                    if (!svc || !svc.model) throw new Error('AI model not initialized');
                    return svc.askAiWithSessionContextAndScreenshots(imageParts, {
                      contextString,
                      // Resume/JD retrieval classifies against this (see
                      // getLatestHostQuery in prompts.js) — passing '' here
                      // meant a question typed from the phone could never be
                      // classified as resume/JD-related, so it never matched
                      // anything. contextString is the closest thing this
                      // path has to a live query; falling back to it beats
                      // guaranteed silence.
                      transcriptContext: contextString,
                      sessionSummary: '',
                      screenshotCount: imageParts.length,
                      onChunk
                    });
                  });
                }
              }

              if (!text) {
                text = await geminiRuntime.executeWithKeyFailover((svc) => {
                  if (!svc || !svc.model) throw new Error('AI model not initialized');
                  return svc.askAiWithSessionContext({
                    contextString,
                    // Same fix as the screenshots branch above: '' meant
                    // resume/JD retrieval could never classify a query typed
                    // from the phone, so it never surfaced anything.
                    transcriptContext: contextString,
                    sessionSummary: '',
                    screenshotCount: 0,
                    onChunk
                  });
                });
              }

              broadcast('ai-stream-end', { actionId: 'askAi' });
            } catch (err) {
              console.error('[MobileServer] ask-ai error:', err.message);
              broadcast('ai-stream-end', { actionId: 'askAi' });
              broadcast('error', { message: err.message });
            }
          })();
          break;
        }

        // ── Clear conversation history ──────────────────────────────────────
        case 'clear-conversation': {
          try {
            const geminiService = geminiRuntime?.getService();
            if (geminiService) geminiService.clearHistory();
            if (screenshotManager?.clearStealth) screenshotManager.clearStealth();
            // Tell the desktop renderer to wipe its chat UI as well.
            if (typeof notifyDesktop === 'function') {
              notifyDesktop('clear-from-mobile', {});
            }
            broadcast('clear-done', {});
          } catch (err) {
            sendTo(ws, 'error', { message: `Clear failed: ${err.message}` });
          }
          break;
        }

        // ── Remote controls ────────────────────────────────────────────────
        //
        // These three own their state in different places: autopilot and mic
        // live in the renderer, typing speed lives on the orchestrator's
        // TextInserter. Each is applied at its owner and then echoed back to
        // every client so a second phone does not show a stale switch.

        case 'toggle-autopilot': {
          const enabled = !!msg.state;
          if (typeof notifyDesktop === 'function') {
            notifyDesktop('set-auto-answer', { enabled });
          }
          console.log(`[MobileServer] Autopilot ${enabled ? 'enabled' : 'disabled'} from mobile.`);
          broadcast('autopilot-state', { enabled });
          break;
        }

        case 'toggle-mic': {
          const enabled = !!msg.state;
          if (typeof notifyDesktop === 'function') {
            notifyDesktop('set-mic-enabled', { enabled });
          }
          console.log(`[MobileServer] Mic ${enabled ? 'unmuted' : 'muted'} from mobile.`);
          broadcast('mic-state', { enabled });
          break;
        }

        case 'set-typing-speed': {
          const orchestrator = getAiOrchestrator();
          if (!orchestrator || typeof orchestrator.setTypingSpeed !== 'function') {
            sendTo(ws, 'error', { message: 'Typing simulator not ready' });
            break;
          }
          const applied = orchestrator.setTypingSpeed(msg.speed);
          broadcast('typing-speed', applied);
          break;
        }

        default:
          sendTo(ws, 'error', { message: `Unknown command: ${msg.type}` });
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      setClientCount(clients.size);
      console.log(`[MobileServer] Client disconnected (total: ${clients.size})`);
    });

    ws.on('error', (err) => {
      console.error('[MobileServer] WebSocket error:', err.message);
      clients.delete(ws);
      setClientCount(clients.size);
    });
  });

  // ── Start listening ────────────────────────────────────────────────────────

  httpServer.listen(MOBILE_PORT, '0.0.0.0', () => {
    refreshUrls();
    status.listening = true;
    status.error = null;
    emitStatus();
    console.log(`[MobileServer] Listening on 0.0.0.0:${MOBILE_PORT}`);
    console.log(`[MobileServer] Local:   http://localhost:${MOBILE_PORT}`);
    for (const { name, url, virtual } of status.urls) {
      const tag = virtual ? '  [virtual — phone probably cannot reach]' : '';
      console.log(`[MobileServer] Network: ${url}  (${name})${tag}`);
    }
    console.log('[MobileServer] On the phone, open one of the Network URLs.');
    console.log('[MobileServer] If the phone cannot reach the PC, allow inbound TCP 7823 in Windows Firewall.');
  });

  httpServer.on('error', (err) => {
    status.listening = false;
    status.error = err.message;
    emitStatus();
    if (err.code === 'EADDRINUSE') {
      console.error(`[MobileServer] Port ${MOBILE_PORT} already in use — mobile companion disabled`);
    } else {
      console.error('[MobileServer] HTTP server error:', err.message);
    }
  });

  return {
    broadcast,
    broadcastHapticAlert,
    broadcastToken,
    broadcastComplete,
    broadcastError,
    sessionToken,
    getStatus: () => ({ ...status }),
    emitStatus,
    close() {
      try {
        wss.close();
        httpServer.close();
        status.listening = false;
        status.clientCount = 0;
        emitStatus();
      } catch (_) { /* ignore */ }
    }
  };
}

module.exports = { createMobileServer };
