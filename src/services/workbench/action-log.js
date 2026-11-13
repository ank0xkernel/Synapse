'use strict';

const fs = require('fs');
const path = require('path');
const { redactSecrets } = require('./command-runner');

const MAX_STRING = 8 * 1024;

function clean(value, depth = 0) {
  if (typeof value === 'string') {
    const text = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...[truncated ${value.length - MAX_STRING} chars]` : value;
    return redactSecrets(text);
  }
  if (depth > 6 || value === null || typeof value !== 'object') return typeof value === 'function' ? undefined : value;
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[redactSecrets(k)] = clean(v, depth + 1);
  return out;
}

/** Append-only JSONL audit trail. One line per entry; synchronous so order is exact. */
function createActionLog({ filePath, maxBytes = 5 * 1024 * 1024 } = {}) {
  if (!filePath) throw new Error('filePath is required');
  let seq = 0;
  let seqLoaded = false;

  function loadSeq() {
    if (seqLoaded) return;
    seqLoaded = true;
    for (const line of [...readLines(`${filePath}.1`), ...readLines(filePath)].slice(-50)) { if (Number.isInteger(line.seq) && line.seq > seq) seq = line.seq; }
  }

  function record(entry) {
    loadSeq();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    try {
      if (fs.statSync(filePath).size >= maxBytes) fs.renameSync(filePath, `${filePath}.1`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    seq += 1;
    const full = { ...clean(entry && typeof entry === 'object' ? entry : { value: entry }), ts: new Date().toISOString(), seq };
    fs.appendFileSync(filePath, `${JSON.stringify(full)}\n`, { mode: 0o600 });
    return full;
  }

  function list({ limit = 100, runId } = {}) {
    const rows = [...readLines(`${filePath}.1`), ...readLines(filePath)];
    const picked = runId === undefined ? rows : rows.filter((r) => r.runId === runId);
    return picked.reverse().slice(0, limit);
  }

  return { record, list };
}

function readLines(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') rows.push(row);
    } catch (_) { /* skip corrupt line */ }
  }
  return rows;
}

module.exports = { createActionLog };
