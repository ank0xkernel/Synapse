'use strict';

const { EventEmitter } = require('events');

/**
 * LogBuffer
 *
 * A bounded in-memory ring of recent main-process console output, so the
 * dashboard's log panel can show what the app is actually doing.
 *
 * The dashboard previously received two hardcoded strings ("[System Watchdog]
 * 10s Heartbeat OK", "[Ollama Metal] VRAM Warm") that were emitted whether or
 * not the watchdog or Ollama were running at all — the panel looked healthy on
 * a machine where neither had ever started.
 *
 * `install()` wraps the console methods rather than replacing the transport, so
 * everything still reaches stdout exactly as before.
 */

const MAX_ENTRIES = 500;

const LEVELS = ['log', 'info', 'warn', 'error'];

class LogBuffer extends EventEmitter {
  constructor(maxEntries = MAX_ENTRIES) {
    super();
    this.maxEntries = maxEntries;
    this.entries = [];
    this.seq = 0;
    this.installed = false;
    this.originals = {};
    // The panel is a diagnostic surface, not a security boundary, but there is
    // no reason to spool secrets into a buffer that gets served over the LAN.
    this.redactors = [
      /\b(AIza[0-9A-Za-z_-]{20,})\b/g,
      /\b([0-9a-f]{32,})\b/gi,
      /(api[_-]?key["'\s:=]+)([^\s"',}]+)/gi
    ];
  }

  redact(text) {
    let safe = text;
    safe = safe.replace(this.redactors[0], '[redacted-key]');
    safe = safe.replace(this.redactors[1], (match) => `[redacted-${match.length}-hex]`);
    safe = safe.replace(this.redactors[2], (_m, prefix) => `${prefix}[redacted]`);
    return safe;
  }

  formatArgs(args) {
    return args
      .map((arg) => {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return arg.stack || arg.message;
        try {
          return JSON.stringify(arg);
        } catch (_) {
          return String(arg);
        }
      })
      .join(' ');
  }

  push(level, message) {
    const entry = {
      id: ++this.seq,
      at: new Date().toISOString(),
      level,
      message: this.redact(message)
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }

    this.emit('entry', entry);
    return entry;
  }

  /** Recent entries, oldest first. `sinceId` supports incremental polling. */
  recent(limit = 200, sinceId = 0) {
    const filtered = sinceId > 0
      ? this.entries.filter((entry) => entry.id > sinceId)
      : this.entries;

    return filtered.slice(-Math.max(1, Math.min(limit, this.maxEntries)));
  }

  /** Wraps console.* so normal logging also lands in the ring. Idempotent. */
  install(consoleLike = console) {
    if (this.installed) return;
    this.installed = true;

    for (const level of LEVELS) {
      const original = consoleLike[level];
      if (typeof original !== 'function') continue;

      this.originals[level] = original;
      consoleLike[level] = (...args) => {
        try {
          this.push(level, this.formatArgs(args));
        } catch (_) {
          // Never let diagnostics break the thing being diagnosed.
        }
        original.apply(consoleLike, args);
      };
    }
  }

  uninstall(consoleLike = console) {
    if (!this.installed) return;

    for (const [level, original] of Object.entries(this.originals)) {
      consoleLike[level] = original;
    }

    this.originals = {};
    this.installed = false;
  }
}

const sharedBuffer = new LogBuffer();

module.exports = {
  LogBuffer,
  logBuffer: sharedBuffer
};
