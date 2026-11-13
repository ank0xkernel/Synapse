'use strict';

const fs = require('fs');
const path = require('path');

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/** Realpath of the nearest existing ancestor, with the missing tail re-appended. */
function realpathLoose(target) {
  const tail = [];
  let current = target;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves relOrAbs against root and proves the real location (symlinks
 * followed) is the root or inside it. Returns the absolute real path.
 * Throws code OUTSIDE_PROJECT, NOT_FOUND or INVALID_PATH.
 */
function resolveInside(root, relOrAbs, { mustExist = false } = {}) {
  if (typeof relOrAbs !== 'string' || !relOrAbs) throw fail('INVALID_PATH', 'Path must be a non-empty string.');
  if (relOrAbs.includes('\0') || String(root).includes('\0')) throw fail('INVALID_PATH', 'Path contains a NUL byte.');
  const realRoot = fs.realpathSync(root);
  const candidate = path.resolve(realRoot, relOrAbs);
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    if (mustExist) {
      // A path that escapes lexically is reported as outside before missing.
      if (!isInside(realRoot, realpathLoose(candidate))) throw fail('OUTSIDE_PROJECT', `Path is outside the project: ${relOrAbs}`);
      throw fail('NOT_FOUND', `Path does not exist: ${relOrAbs}`);
    }
    real = realpathLoose(candidate);
  }
  if (!isInside(realRoot, real)) throw fail('OUTSIDE_PROJECT', `Path is outside the project: ${relOrAbs}`);
  return real;
}

function toRelative(root, abs) {
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch (_) { /* keep given root */ }
  return path.relative(realRoot, abs).split(path.sep).join('/');
}

module.exports = { resolveInside, toRelative, isInside };
