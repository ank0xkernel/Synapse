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
// control, interview context editor, status panel and logs).
const COMPANION_HTML_PATH = path.join(__dirname, 'companion.html');

// ── Security / resource limits ───────────────────────────────────────────────
const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 4;
const MAX_SOCKETS = 4;
const WS_MAX_PAYLOAD = 64 * 1024;
const HEARTBEAT_MS = 20 * 1000;
const MAX_MISSED_PONGS = 2;
const CHUNK_BATCH_MS = 50;
const MAX_SOCKET_BACKLOG = 1024 * 1024;
const ANSWER_CAP = 16 * 1024;
const QUESTION_CAP = 500;
const HISTORY_ITEMS = 10;
const USED_CODE_TTL_MS = 90 * 1000;
const WS_PROTOCOL = 'synapse.v1';
const WS_AUTH_PROTOCOL_PREFIX = 'synapse.auth.';

// Only these events ever reach a phone. Anything else the desktop broadcasts
// (settings, resume/context traffic, ...) is dropped at the door.
const PHONE_CHANNELS = new Set([
  'ai-stream-start', 'ai-stream-chunk', 'ai-stream-end',
  'synapse-haptic', 'synapse-token', 'synapse-complete', 'synapse-error',
  'synapse-mode', 'synapse-nudge', 'synapse-queue',
  'vosk-final', 'vosk-partial', 'vosk-status', 'vosk-stopped', 'vosk-error',
  'system-audio-status', 'native-system-audio-status',
  'screenshot-taken-stealth', 'clear-done', 'answer-superseded',
  'mic-state', 'autopilot-state', 'typing-speed', 'history', 'error'
]);

const cap = (value, n) => String(value == null ? '' : value).slice(0, n);
const sha256 = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex');

/**
 * Persists the "companion enabled" choice in a small JSON file. The shared
 * app-state sanitizer drops unknown keys, so the flag lives in its own file.
 */
function createFileEnabledStore(filePath) {
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8')).companionEnabled === true;
      } catch (_) {
        return false;
      }
    },
    save(value) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify({ companionEnabled: !!value })}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  };
}

/**
 * Mobile companion server.
 *
 * Disabled by default: nothing listens until start()/setEnabled(true). The
 * choice is persisted through `enabledStore` (default: off, nothing persisted).
 *
 * Transport is plain HTTP/WS on the trusted LAN. It is NOT end-to-end
 * encrypted: anyone who can sniff the Wi-Fi can read answers and the session
 * token. Authentication is the rotating TOTP code; the code is exchanged for a
 * per-phone session token (12 h absolute / 60 min idle, at most 4 at once).
 */
function createMobileServer({
  getGeminiRuntime,
  getScreenshotManager,
  notifyDesktop,
  // Optional: supplied by the composition root so the dashboard's service
  // panel, restart buttons and JD indexing act on the real services.
  getAiOrchestrator = () => null,
  getLocalServices = () => ({}),
  getSystemAudioCapture = () => null,
  enabledStore = { load: () => false, save: () => {} },
  port = MOBILE_PORT,
  getAddresses = getLanAddresses,
  totp = null,
  now = Date.now,
  autoStart = true,
  heartbeatMs = HEARTBEAT_MS
}) {
  const clients = new Set();
  let enabled = false;
  try { enabled = enabledStore.load() === true; } catch (_) { enabled = false; }
  const status = {
    enabled,
    listening: false,
    port,
    urls: [],
    clientCount: 0,
    error: null
  };

  // ── Sessions ───────────────────────────────────────────────────────────────
  // Only the sha256 of each bearer is kept; the token itself exists on the
  // phone alone. Never copied onto `status`.
  const sessions = new Map(); // sha256(token) -> { createdAt, lastSeen }

  function sessionAlive(key) {
    const s = sessions.get(key);
    if (!s) return false;
    const t = now();
    return t - s.createdAt < SESSION_ABSOLUTE_MS && t - s.lastSeen < SESSION_IDLE_MS;
  }

  function closeSocketsOf(key) {
    for (const ws of clients) {
      if (ws.sessionKey === key) { try { ws.close(1008, 'Session ended'); } catch (_) { /* ignore */ } }
    }
  }

  function revokeSession(key) {
    sessions.delete(key);
    closeSocketsOf(key);
  }

  function issueSession() {
    while (sessions.size >= MAX_SESSIONS) {
      let oldest = null;
      for (const [key, s] of sessions) {
        if (oldest === null || s.createdAt < sessions.get(oldest).createdAt) oldest = key;
      }
      revokeSession(oldest);
    }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(sha256(token), { createdAt: now(), lastSeen: now() });
    return token;
  }

  function revokeAllSessions() {
    sessions.clear();
    for (const ws of clients) { try { ws.close(1008, 'Session ended'); } catch (_) { /* ignore */ } }
  }

  /** Bearer from `Authorization` or the WebSocket subprotocol list. Never from the URL. */
  function extractToken(req) {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers?.authorization || '');
    if (bearer) return bearer[1].trim();
    const offered = String(req.headers?.['sec-websocket-protocol'] || '').split(',').map((p) => p.trim());
    const auth = offered.find((p) => p.startsWith(WS_AUTH_PROTOCOL_PREFIX));
    return auth ? auth.slice(WS_AUTH_PROTOCOL_PREFIX.length) : '';
  }

  /** Returns the session key for a valid, unexpired bearer (and refreshes idle time), else null. */
  function authenticate(req) {
    const token = extractToken(req);
    if (!token) return null;
    const key = sha256(token);
    if (!sessions.has(key)) return null;
    if (!sessionAlive(key)) { revokeSession(key); return null; }
    sessions.get(key).lastSeen = now();
    return key;
  }

  /** Guards a REST route. Returns true when the request may proceed. */
  function requireAuth(req, res) {
    const key = authenticate(req);
    if (key) {
      req.sessionKey = key;
      return true;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    return false;
  }

  // ── Login throttling ───────────────────────────────────────────────────────
  // The TOTP space is 10^6 with a +/-1 step drift window, so roughly 3 codes are
  // valid at any moment. This keeps an attacker to a few attempts per minute per
  // address. A code that already logged someone in is single-use, so a code
  // sniffed off plain HTTP cannot be replayed.
  const LOGIN_MAX_ATTEMPTS = 10;
  const LOGIN_WINDOW_MS = 60 * 1000;
  const loginAttempts = new Map();
  const usedCodes = new Map(); // code -> expiry

  function loginRateLimited(remoteAddress) {
    const key = String(remoteAddress || 'unknown');
    const t = now();
    const recent = (loginAttempts.get(key) || []).filter((at) => t - at < LOGIN_WINDOW_MS);
    if (recent.length >= LOGIN_MAX_ATTEMPTS) {
      loginAttempts.set(key, recent);
      return true;
    }
    recent.push(t);
    loginAttempts.set(key, recent);
    return false;
  }

  function getTotp() {
    return totp || require('../security/totp-auth').shared();
  }

  // ── Live-state snapshot (bounded; updated O(1) per broadcast) ──────────────
  let seq = 0;
  let streamCounter = 0;
  const live = {
    listening: { system: 'off', mic: 'off' },
    errors: { system: null, mic: null },
    systemAudio: null,
    lastQuestion: '',
    answer: null, // { streamId, text, status, truncated, source }
    mic: null,
    autopilot: null,
    typingSpeed: null,
    screenshots: 0,
    mode: null,
    history: []
  };

  function newStreamId() {
    streamCounter += 1;
    return `${streamCounter.toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  }

  function startAnswer(source) {
    if (live.answer && live.answer.status === 'streaming') live.answer.status = 'cancelled';
    live.answer = { streamId: newStreamId(), text: '', status: 'streaming', truncated: false, source };
    return live.answer;
  }

  function appendAnswer(text) {
    const a = live.answer;
    const room = ANSWER_CAP - a.text.length;
    if (text.length > room) {
      a.text += text.slice(0, Math.max(0, room));
      a.truncated = true;
    } else {
      a.text += text;
    }
  }

  const answering = () => live.answer && live.answer.status === 'streaming';
  const sourceOf = (data) => (data && data.source === 'mic' ? 'mic' : 'system');

  /**
   * Folds a desktop event into the snapshot and returns what the phone should
   * receive ({ ch, data }) or null to drop it.
   */
  function track(channel, data) {
    data = data && typeof data === 'object' ? data : {};
    switch (channel) {
      case 'ai-stream-start':
        if (data.actionId !== 'askAi') return null;
        return { ch: channel, data: { actionId: 'askAi', streamId: startAnswer('ask').streamId } };

      case 'ai-stream-chunk': {
        if (data.actionId !== 'askAi' || !answering()) return null;
        if (data.streamId && data.streamId !== live.answer.streamId) return null;
        const text = String(data.text || '');
        appendAnswer(text);
        return { ch: channel, data: { actionId: 'askAi', streamId: live.answer.streamId, text, index: data.index } };
      }

      case 'ai-stream-end': {
        if (data.actionId !== 'askAi' || !answering()) return null;
        live.answer.status = 'done';
        return { ch: channel, data: { actionId: 'askAi', streamId: live.answer.streamId } };
      }

      case 'synapse-haptic':
        if (!(answering() && live.answer.source === 'local')) startAnswer('local');
        return { ch: channel, data: { timestamp: data.timestamp, streamId: live.answer.streamId } };

      case 'synapse-token': {
        if (!(answering() && live.answer.source === 'local')) startAnswer('local');
        const token = String(data.token || '');
        appendAnswer(token);
        return { ch: channel, data: { token, streamId: live.answer.streamId } };
      }

      case 'synapse-complete':
        if (!(answering() && live.answer.source === 'local')) return null;
        live.answer.status = 'done';
        return { ch: channel, data: { streamId: live.answer.streamId } };

      case 'error':
      case 'synapse-error':
        if (answering()) live.answer.status = 'failed';
        return { ch: channel, data: { message: cap(data.message, 300), streamId: live.answer ? live.answer.streamId : undefined } };

      case 'answer-superseded':
        if (answering()) live.answer.status = 'cancelled';
        return { ch: channel, data: {} };

      case 'history': {
        const items = (Array.isArray(data.items) ? data.items : []).slice(-HISTORY_ITEMS)
          .map((i) => ({ question: cap(i && i.question, 300), answer: cap(i && i.answer, 2000) }));
        live.history = items;
        return { ch: channel, data: { items } };
      }

      case 'vosk-status': {
        const source = sourceOf(data);
        live.listening[source] = cap(data.status, 24) || 'off';
        if (data.status === 'listening') live.errors[source] = null;
        return { ch: channel, data: { source, status: live.listening[source], message: cap(data.message, 200) } };
      }

      case 'vosk-stopped': {
        const source = sourceOf(data);
        live.listening[source] = 'stopped';
        return { ch: channel, data: { source } };
      }

      case 'vosk-error': {
        const source = sourceOf(data);
        live.listening[source] = 'error';
        const err = {
          source,
          error: cap(data.error, 300),
          kind: cap(data.kind, 40),
          permanent: !!data.permanent,
          unexpected: !!data.unexpected,
          detail: cap(data.detail, 300)
        };
        live.errors[source] = err;
        return { ch: channel, data: err };
      }

      case 'vosk-final':
        if (data.source !== 'system') return null;
        live.lastQuestion = cap(data.text, QUESTION_CAP);
        return { ch: channel, data: { source: 'system', text: live.lastQuestion } };

      case 'vosk-partial':
        if (data.source !== 'system') return null;
        return { ch: channel, data: { source: 'system', text: cap(data.text, QUESTION_CAP) } };

      case 'system-audio-status':
      case 'native-system-audio-status': {
        live.systemAudio = { status: cap(data.status, 24), device: cap(data.device, 120), message: cap(data.message, 200) };
        return { ch: 'system-audio-status', data: live.systemAudio };
      }

      case 'mic-state':
        live.mic = !!data.enabled;
        return { ch: channel, data: { enabled: live.mic } };

      case 'autopilot-state':
        live.autopilot = !!data.enabled;
        return { ch: channel, data: { enabled: live.autopilot } };

      case 'typing-speed':
        if (data.speed != null) live.typingSpeed = Number(data.speed) || null;
        return { ch: channel, data: { speed: data.speed } };

      case 'screenshot-taken-stealth':
        live.screenshots = Number(data.count) || 0;
        return { ch: channel, data: { count: live.screenshots } };

      case 'synapse-mode':
        live.mode = cap(data.mode, 40) || null;
        return { ch: channel, data: { mode: live.mode } };

      case 'clear-done':
        live.answer = null;
        live.lastQuestion = '';
        live.screenshots = 0;
        live.history = [];
        return { ch: channel, data: {} };

      default:
        return { ch: channel, data };
    }
  }

  function snapshot() {
    const sm = getScreenshotManager && getScreenshotManager();
    const a = live.answer;
    return {
      listening: { ...live.listening },
      errors: { ...live.errors },
      systemAudio: live.systemAudio,
      lastQuestion: live.lastQuestion,
      answer: a ? { streamId: a.streamId, text: a.text, status: a.status, truncated: a.truncated } : null,
      mic: live.mic,
      autopilot: live.autopilot,
      typingSpeed: live.typingSpeed,
      screenshots: sm ? sm.getScreenshotsCount() : live.screenshots,
      mode: live.mode,
      history: live.history
    };
  }

  // ── Outgoing messages ──────────────────────────────────────────────────────
  function rawSend(ws, ev) {
    if (ws.readyState !== 1 /* OPEN */) return;
    if (ws.bufferedAmount > MAX_SOCKET_BACKLOG) { ws.terminate(); return; }
    try { ws.send(JSON.stringify(ev)); } catch (_) { /* dead socket; heartbeat reaps it */ }
  }

  function flushPending(ws) {
    const p = ws.pending;
    if (!p) return;
    ws.pending = null;
    rawSend(ws, { type: p.type, data: { ...p.data, [p.field]: p.text }, seq: p.seq, ts: p.ts });
  }

  function armChunkTimer(ws) {
    ws.chunkTimer = setTimeout(() => {
      ws.chunkTimer = null;
      if (ws.pending) { flushPending(ws); armChunkTimer(ws); }
    }, CHUNK_BATCH_MS);
  }

  /** Answer chunks: first one goes out immediately, the rest coalesce to <= 1 send per 50 ms. */
  function deliver(ws, ev) {
    const field = ev.type === 'ai-stream-chunk' ? 'text' : ev.type === 'synapse-token' ? 'token' : null;
    if (!field) {
      flushPending(ws);
      rawSend(ws, ev);
      return;
    }
    if (ws.pending && ws.pending.data.streamId !== ev.data.streamId) flushPending(ws);
    if (ws.pending) {
      ws.pending.text += ev.data[field];
      ws.pending.seq = ev.seq;
      ws.pending.ts = ev.ts;
      if (ws.pending.text.length >= ANSWER_CAP) flushPending(ws);
      return;
    }
    if (!ws.chunkTimer) {
      rawSend(ws, ev);
      armChunkTimer(ws);
      return;
    }
    ws.pending = { type: ev.type, field, data: ev.data, text: ev.data[field], seq: ev.seq, ts: ev.ts };
  }

  function broadcast(channel, data) {
    if (!PHONE_CHANNELS.has(channel)) return;
    const out = track(channel, data);
    if (!out || clients.size === 0) {
      if (out) seq += 1;
      return;
    }
    const ev = { type: out.ch, data: out.data, seq: ++seq, ts: now() };
    for (const ws of clients) deliver(ws, ev);
  }

  /** Direct reply to one socket. Carries the current seq without consuming one. */
  function sendTo(ws, type, data) {
    flushPending(ws);
    rawSend(ws, { type, data, seq, ts: now() });
  }

  function broadcastHapticAlert() { broadcast('synapse-haptic', { timestamp: now() }); }
  function broadcastToken(token) { broadcast('synapse-token', { token }); }
  function broadcastComplete() { broadcast('synapse-complete', { timestamp: now() }); }
  function broadcastError(message) { broadcast('synapse-error', { message }); }

  function emitStatus() {
    if (typeof notifyDesktop === 'function') {
      try { notifyDesktop('mobile-server-status', getStatus()); } catch (_) { /* ignore */ }
    }
  }

  function getStatus() {
    return { ...status, urls: status.urls.map((u) => ({ ...u })) };
  }

  function setClientCount(n) {
    status.clientCount = n;
    emitStatus();
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
      // Same importer as the desktop's Import PDF: validates the PDF
      // signature, reports scanned PDFs, and keeps the raw text with its
      // section headings (the parser's flattened output drops them).
      const { extractResumeText: importResume } = require('../../../services/context/resume-import');
      const { text } = await importResume(tmpPath);
      return text;
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

  function handleRequest(req, res) {
    const url = (req.url || '/').split('?')[0];

    // The old /dashboard and /context pages were merged into '/'. Bookmarks
    // redirect there; no credential is ever carried in the URL.
    if (url === '/dashboard' || url.startsWith('/dashboard/') || url === '/context') {
      res.writeHead(302, { Location: '/', ...NO_STORE });
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

      readJsonBody(req, 4096)
        .then(({ token }) => {
          const code = String(token || '').trim();
          const t = now();
          // shared(), not new: a fresh instance would carry a fresh secret and
          // reject every passcode the tray displays. Login accepts only the
          // rotating code, never an existing bearer, and each code works once.
          if (!usedCodes.has(code) && getTotp().verifyToken(code)) {
            usedCodes.set(code, t + USED_CODE_TTL_MS);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              sessionToken: issueSession(),
              expiresInMs: SESSION_ABSOLUTE_MS,
              idleTimeoutMs: SESSION_IDLE_MS
            }));
          } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid passcode' }));
          }
        })
        .catch(() => { res.writeHead(400); res.end(); });
      return;
    }

    if (url === '/api/logout' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      revokeSession(req.sessionKey);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
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
          const saved = interviewContext.save({
            ...current,
            background: extracted,
            resumeFileName: contentBase64 ? String(filename || '').slice(0, 260) : '',
            resumeImportedAt: new Date().toISOString(),
            resumeSource: 'companion'
          });
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
  }

  // ── WebSocket server ───────────────────────────────────────────────────────

  // `noServer` + an explicit upgrade handler rejects an unauthenticated socket
  // before it is ever established. The bearer travels in the subprotocol list
  // (`synapse.auth.<token>`), never in the URL, so it stays out of logs and
  // history. The server only ever echoes the constant `synapse.v1`.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WS_MAX_PAYLOAD,
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false)
  });

  function onUpgrade(req, socket, head) {
    const key = enabled ? authenticate(req) : null;
    if (!key) {
      console.warn(
        `[MobileServer] Rejected unauthenticated WebSocket upgrade from ${req.socket?.remoteAddress}`
      );
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.sessionKey = key;
      wss.emit('connection', ws, req);
    });
  }

  wss.on('connection', (ws) => {
    if (clients.size >= MAX_SOCKETS) {
      ws.close(1013, 'Too many companion connections');
      return;
    }

    ws.missedPongs = 0;
    ws.pending = null;
    ws.chunkTimer = null;
    clients.add(ws);
    setClientCount(clients.size);
    console.log(`[MobileServer] Client connected (total: ${clients.size})`);

    ws.on('pong', () => { ws.missedPongs = 0; });

    // Current state first, so a reconnecting phone never replays stale history.
    sendTo(ws, 'snapshot', snapshot());

    ws.on('message', async (rawData, _isBinary) => {
      // Re-check on every command: the session may have expired or been revoked.
      if (!sessionAlive(ws.sessionKey)) {
        ws.close(1008, 'Session ended');
        return;
      }
      sessions.get(ws.sessionKey).lastSeen = now();

      let msg;
      try {
        msg = JSON.parse(rawData.toString());
      } catch (_) {
        sendTo(ws, 'error', { message: 'Invalid message format' });
        return;
      }
      if (!msg || typeof msg !== 'object') {
        sendTo(ws, 'error', { message: 'Invalid message format' });
        return;
      }

      const geminiRuntime = getGeminiRuntime();
      const screenshotManager = getScreenshotManager();

      switch (msg.type) {

        // ── Send answer to the focused desktop editor ────────────────────────
        case 'send-answer-to-editor': {
          // Types the answer this server tracked (cloud or local), and only
          // reports success once the desktop has actually inserted it.
          const a = live.answer;
          let failure = null;
          if (!a || !a.text) failure = 'No answer to send yet.';
          else if (a.status === 'streaming') failure = 'The answer is still being written.';
          else if (a.status !== 'done') failure = 'The last answer did not finish. Ask again first.';
          else if (a.truncated) failure = 'That answer is too long to send from the phone. Use the desktop shortcut.';
          else if (typeof notifyDesktop !== 'function') failure = 'Desktop is not ready.';

          if (failure) {
            sendTo(ws, 'editor-result', { ok: false, error: failure });
            break;
          }

          try {
            const result = await notifyDesktop('send-answer-to-editor', { text: a.text });
            if (!result || result.method === 'skipped' || !result.chars) {
              sendTo(ws, 'editor-result', { ok: false, error: 'Nothing was inserted. Another insertion may be running.' });
            } else {
              sendTo(ws, 'editor-result', { ok: true, method: result.method, chars: result.chars });
            }
          } catch (err) {
            sendTo(ws, 'editor-result', { ok: false, error: cap(err && err.message, 200) || 'Sending to the editor failed.' });
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
              // Error first so the stream is recorded as failed, not done.
              broadcast('error', { message: err.message });
              broadcast('ai-stream-end', { actionId: 'askAi' });
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

    function dropSocket() {
      clearTimeout(ws.chunkTimer);
      ws.pending = null;
      if (clients.delete(ws)) {
        setClientCount(clients.size);
        console.log(`[MobileServer] Client disconnected (total: ${clients.size})`);
      }
    }

    ws.on('close', dropSocket);

    ws.on('error', (err) => {
      console.error('[MobileServer] WebSocket error:', err.message);
      dropSocket();
    });
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  let servers = [];
  let timer = null;
  let generation = 0;
  let starting = null;

  /** Closes sockets whose session lapsed, reaps dead peers, prunes bookkeeping. */
  function sweep() {
    const t = now();
    for (const [key] of sessions) {
      if (!sessionAlive(key)) revokeSession(key);
    }
    for (const [addr, stamps] of loginAttempts) {
      if (!stamps.some((at) => t - at < LOGIN_WINDOW_MS)) loginAttempts.delete(addr);
    }
    for (const [code, expiry] of usedCodes) {
      if (expiry <= t) usedCodes.delete(code);
    }
    for (const ws of clients) {
      if (!sessionAlive(ws.sessionKey)) { try { ws.close(1008, 'Session ended'); } catch (_) { /* ignore */ } }
    }
  }

  function heartbeat() {
    for (const ws of clients) {
      if (ws.missedPongs >= MAX_MISSED_PONGS) { ws.terminate(); continue; }
      ws.missedPongs += 1;
      try { ws.ping(); } catch (_) { /* terminated next tick */ }
    }
    sweep();
  }

  /**
   * Binds one listener per LAN interface address instead of 0.0.0.0, so the
   * port is not exposed on interfaces a phone could not use anyway. Virtual/VPN
   * adapters are skipped unless nothing else exists; with no network at all it
   * falls back to loopback.
   */
  function bindTargets() {
    const all = getAddresses() || [];
    const real = all.filter((a) => !a.virtual);
    const picked = real.length ? real : all;
    const unique = [...new Map(picked.map((a) => [a.address, a])).values()];
    return unique.length ? unique : [{ name: 'loopback', address: '127.0.0.1', virtual: false }];
  }

  function createHttpServer() {
    const srv = http.createServer(handleRequest);
    srv.on('upgrade', onUpgrade);
    return srv;
  }

  function listenOn(srv, p, address) {
    return new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(p, address, () => { srv.off('error', reject); resolve(); });
    });
  }

  function closeServers() {
    for (const srv of servers) {
      try { srv.close(); srv.closeAllConnections?.(); } catch (_) { /* ignore */ }
    }
    servers = [];
  }

  /** Starts listening (idempotent). Does not persist; see setEnabled(). */
  async function start() {
    if (starting) return starting;
    if (servers.length) return getStatus();

    enabled = true;
    status.enabled = true;
    status.error = null;
    const myGeneration = ++generation;

    starting = (async () => {
      const opened = [];
      const failures = [];
      let boundPort = port;

      for (const target of bindTargets()) {
        const srv = createHttpServer();
        try {
          await listenOn(srv, boundPort, target.address);
          boundPort = srv.address().port;
          srv.on('error', (err) => console.error('[MobileServer] HTTP server error:', err.message));
          opened.push({ srv, target });
        } catch (err) {
          failures.push(`${target.address}: ${err.code === 'EADDRINUSE' ? `port ${boundPort} already in use` : err.message}`);
          try { srv.close(); } catch (_) { /* never listened */ }
        }
      }

      if (myGeneration !== generation) {
        // stop() ran while binding.
        for (const { srv } of opened) { try { srv.close(); } catch (_) { /* ignore */ } }
        return;
      }

      if (!opened.length) {
        status.listening = false;
        status.error = failures.join('; ') || 'Could not bind any address';
        console.error(`[MobileServer] Companion could not start: ${status.error}`);
        emitStatus();
        return;
      }

      servers = opened.map((o) => o.srv);
      status.port = boundPort;
      status.urls = opened.map(({ target }) => ({
        name: target.name,
        address: target.address,
        virtual: !!target.virtual,
        url: `http://${target.address}:${boundPort}`
      }));
      status.listening = true;
      status.error = failures.length ? failures.join('; ') : null;
      timer = setInterval(heartbeat, heartbeatMs);
      if (timer.unref) timer.unref();
      emitStatus();

      console.log(`[MobileServer] Companion enabled on port ${boundPort} (HTTP, LAN only, not end-to-end encrypted)`);
      for (const { name, url, virtual } of status.urls) {
        console.log(`[MobileServer] Network: ${url}  (${name})${virtual ? '  [virtual adapter]' : ''}`);
      }
      console.log('[MobileServer] Pair the phone with the rotating passcode from the tray menu.');
    })().finally(() => { starting = null; });

    await starting;
    return getStatus();
  }

  /** Stops listening, drops every socket and invalidates every phone session. */
  function stop() {
    enabled = false;
    status.enabled = false;
    generation += 1;
    if (timer) { clearInterval(timer); timer = null; }
    for (const ws of clients) {
      clearTimeout(ws.chunkTimer);
      try { ws.terminate(); } catch (_) { /* ignore */ }
    }
    clients.clear();
    sessions.clear();
    closeServers();
    status.listening = false;
    status.urls = [];
    status.clientCount = 0;
    emitStatus();
    return getStatus();
  }

  /** Persists the user's choice, then applies it. */
  async function setEnabled(value) {
    const next = value === true;
    let saveError = null;
    try {
      enabledStore.save(next);
    } catch (err) {
      saveError = `Could not save the setting: ${err.message}`;
      console.error(`[MobileServer] ${saveError}`);
    }
    if (next) await start(); else stop();
    if (saveError) status.error = saveError;
    return getStatus();
  }

  if (autoStart && enabled) {
    start().catch((err) => console.error('[MobileServer] Start failed:', err.message));
  }

  return {
    broadcast,
    broadcastHapticAlert,
    broadcastToken,
    broadcastComplete,
    broadcastError,
    start,
    stop,
    setEnabled,
    revokeSessions() { revokeAllSessions(); return getStatus(); },
    get isEnabled() { return enabled; },
    getStatus,
    getSnapshot: snapshot,
    emitStatus,
    sweep,
    close: stop
  };
}

module.exports = { createMobileServer, createFileEnabledStore, getLanAddresses };
