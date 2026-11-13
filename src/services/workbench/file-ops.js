'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { resolveInside, toRelative } = require('./path-guard');
const { unifiedDiff } = require('./unified-diff');

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const BOM = '﻿';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function codeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readFileState(abs, maxBytes) {
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw codeError('NOT_A_FILE', `Not a regular file: ${abs}`);
  if (stat.size > maxBytes) throw codeError('FILE_TOO_LARGE', `File is ${stat.size} bytes, limit is ${maxBytes}.`);
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8192).includes(0)) throw codeError('BINARY_FILE', 'File looks binary (NUL byte).');
  return buf;
}

function decode(buf) {
  let text = buf.toString('utf8');
  const bom = text.startsWith(BOM);
  if (bom) text = text.slice(1);
  return { text, bom, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

/** Writes via a temp file in the same directory, fsync, rename. Cleans the temp on failure. */
function atomicWrite(abs, data, mode) {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, abs);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw error;
  }
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) { count += 1; at = haystack.indexOf(needle, at + needle.length); }
  return count;
}

function createFileOps({ root, backupDir, log } = {}) {
  if (!root) throw codeError('INVALID_ROOT', 'root is required');
  const note = (entry) => { if (log && typeof log.record === 'function') { try { log.record(entry); } catch (_) { /* log must not break edits */ } } };
  let backupSeq = 0;

  function read(relPath, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    const abs = resolveInside(root, relPath, { mustExist: true });
    const buf = readFileState(abs, maxBytes);
    const { text, bom, eol } = decode(buf);
    return { path: toRelative(root, abs), content: text, sha256: sha(buf), encoding: 'utf8', eol, bom, bytes: buf.length };
  }

  function prepare(edit) {
    const abs = resolveInside(root, edit.path);
    const rel = toRelative(root, abs);
    const base = { id: edit.id, path: rel, kind: edit.kind, valid: false, before: { sha256: null, exists: false }, after: null, diff: '', risk: edit.kind === 'delete' ? 'delete' : 'write' };
    const invalid = (code, reason) => ({ ...base, invalidCode: code, invalidReason: reason });

    let current = null;
    try {
      const buf = readFileState(abs, DEFAULT_MAX_BYTES);
      current = { buf, ...decode(buf) };
      base.before = { sha256: sha(buf), exists: true };
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') current = null;
      else return invalid(error.code || 'READ_FAILED', error.message);
    }

    if (edit.kind === 'create') {
      if (current) return invalid('ALREADY_EXISTS', `File already exists: ${rel}`);
      const after = String(edit.content ?? '');
      return { ...base, valid: true, after, diff: unifiedDiff('', after, { path: rel }) };
    }
    if (edit.kind === 'delete') {
      if (!current) return invalid('NOT_FOUND', `File does not exist: ${rel}`);
      return { ...base, valid: true, after: null, diff: unifiedDiff(current.text, '', { path: rel }) };
    }
    if (edit.kind !== 'replace') return invalid('INVALID_KIND', `Unknown edit kind: ${edit.kind}`);
    if (!current) return invalid('NOT_FOUND', `File does not exist: ${rel}`);
    const search = String(edit.search ?? '');
    if (!search) return invalid('ANCHOR_NOT_FOUND', 'Search anchor is empty.');
    const replacement = String(edit.replace ?? '');

    // Exact match first; fall back to LF-normalised comparison on CRLF files.
    let text = current.text;
    let needle = search;
    let repl = replacement;
    let hits = countOccurrences(text, needle);
    let normalised = false;
    if (hits === 0 && current.eol === '\r\n') {
      text = text.replace(/\r\n/g, '\n');
      needle = search.replace(/\r\n/g, '\n');
      repl = replacement.replace(/\r\n/g, '\n');
      hits = countOccurrences(text, needle);
      normalised = true;
    }
    if (hits === 0) return invalid('ANCHOR_NOT_FOUND', `Anchor not found in ${rel}.`);
    if (hits > 1) return invalid('ANCHOR_AMBIGUOUS', `Anchor occurs ${hits} times in ${rel}; it must occur exactly once.`);
    const at = text.indexOf(needle);
    let after = text.slice(0, at) + repl + text.slice(at + needle.length);
    if (normalised) after = after.replace(/\n/g, '\r\n');
    return { ...base, valid: true, after, diff: unifiedDiff(current.text, after, { path: rel }), bom: current.bom };
  }

  function encode(prepared) {
    return Buffer.from((prepared.bom ? BOM : '') + prepared.after, 'utf8');
  }

  function stateOf(abs) {
    try {
      return { exists: true, sha256: sha(fs.readFileSync(abs)) };
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { exists: false, sha256: null };
      throw error;
    }
  }

  function backupPathFor(id, abs) {
    backupSeq += 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(backupDir, `${stamp}-${backupSeq}-${id || 'edit'}-${path.basename(abs)}`);
  }

  function apply(prepared) {
    const path0 = prepared && prepared.path;
    const failure = (code, message) => {
      const result = { ok: false, path: path0, error: { code, message } };
      note({ type: 'file.apply', id: prepared && prepared.id, path: path0, ok: false, code, message });
      return result;
    };
    if (!prepared || !prepared.valid) return failure('INVALID_EDIT', (prepared && prepared.invalidReason) || 'Edit is not valid.');
    if (!backupDir) return failure('NO_BACKUP_DIR', 'backupDir is required to apply edits.');
    let abs;
    try { abs = resolveInside(root, prepared.path); } catch (error) { return failure(error.code || 'INVALID_PATH', error.message); }

    let backupPath;
    try {
      const now = stateOf(abs);
      if (now.exists !== prepared.before.exists || now.sha256 !== prepared.before.sha256) {
        return failure('FILE_CHANGED', `${prepared.path} changed since the diff was prepared; nothing was written.`);
      }
      fs.mkdirSync(backupDir, { recursive: true });
      const mode = now.exists ? fs.statSync(abs).mode & 0o7777 : undefined;
      const original = now.exists ? fs.readFileSync(abs) : null;

      if (now.exists) {
        backupPath = backupPathFor(prepared.id, abs);
        fs.copyFileSync(abs, backupPath, fs.constants.COPYFILE_EXCL);
        if (sha(fs.readFileSync(backupPath)) !== now.sha256) throw codeError('BACKUP_FAILED', 'Backup copy does not match the original.');
      }

      if (prepared.kind === 'delete') {
        fs.unlinkSync(abs);
        if (fs.existsSync(abs)) throw codeError('VERIFY_FAILED', 'File still exists after delete.');
        const result = { ok: true, path: prepared.path, kind: 'delete', backupPath, bytesWritten: 0 };
        note({ type: 'file.apply', id: prepared.id, path: prepared.path, kind: 'delete', ok: true, backupPath });
        return result;
      }

      const data = encode(prepared);
      if (!now.exists) fs.mkdirSync(path.dirname(abs), { recursive: true });
      // Re-check the parent after mkdir: a symlinked new directory must not escape.
      resolveInside(root, prepared.path);
      atomicWrite(abs, data, mode);
      const written = stateOf(abs);
      if (written.sha256 !== sha(data)) {
        if (original) atomicWrite(abs, original, mode); else fs.unlinkSync(abs);
        return failure('VERIFY_FAILED', `Written content of ${prepared.path} did not match; original restored.`);
      }
      const result = { ok: true, path: prepared.path, kind: prepared.kind, bytesWritten: data.length, backupPath, created: !now.exists };
      note({ type: 'file.apply', id: prepared.id, path: prepared.path, kind: prepared.kind, ok: true, bytesWritten: data.length, backupPath });
      return result;
    } catch (error) {
      return failure(error.code || 'WRITE_FAILED', error.message);
    }
  }

  function undo(applyResult) {
    const fail = (code, message) => {
      note({ type: 'file.undo', path: applyResult && applyResult.path, ok: false, code, message });
      return { ok: false, path: applyResult && applyResult.path, error: { code, message } };
    };
    if (!applyResult || !applyResult.ok) return fail('INVALID_RESULT', 'Only a successful apply can be undone.');
    try {
      const abs = resolveInside(root, applyResult.path);
      if (applyResult.backupPath) {
        const backup = fs.readFileSync(applyResult.backupPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        atomicWrite(abs, backup, fs.existsSync(abs) ? fs.statSync(abs).mode & 0o7777 : undefined);
        if (sha(fs.readFileSync(abs)) !== sha(backup)) return fail('VERIFY_FAILED', 'Restored file does not match the backup.');
      } else if (applyResult.created) {
        fs.unlinkSync(abs);
        if (fs.existsSync(abs)) return fail('VERIFY_FAILED', 'Created file still exists after undo.');
      } else {
        return fail('NOTHING_TO_UNDO', 'No backup and no created file recorded.');
      }
      note({ type: 'file.undo', path: applyResult.path, ok: true });
      return { ok: true, path: applyResult.path };
    } catch (error) {
      return fail(error.code || 'UNDO_FAILED', error.message);
    }
  }

  return { read, prepare, apply, undo };
}

module.exports = { createFileOps };
