'use strict';

// Line diff (LCS table with common prefix/suffix trimmed) rendered as a
// standard unified diff. ponytail: O(n*m) table on the trimmed middle; fine
// for edited source files, switch to Myers if multi-thousand-line rewrites matter.

const NO_EOL = '\u0000noeol';

function splitLines(text) {
  if (!text) return { lines: [], noEol: false };
  const noEol = !text.endsWith('\n');
  const lines = text.split('\n');
  if (!noEol) lines.pop();
  // The marker makes "x" and "x\n" at EOF differ, as git reports them.
  else lines[lines.length - 1] += NO_EOL;
  return { lines, noEol };
}

function diffOps(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const ops = [];
  for (let i = 0; i < start; i += 1) ops.push([' ', i, i]);
  const n = endA - start;
  const m = endB - start;
  const w = m + 1;
  const table = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * w + j] = a[start + i] === b[start + j]
        ? table[(i + 1) * w + j + 1] + 1
        : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) { ops.push([' ', start + i, start + j]); i += 1; j += 1; }
    else if (i < n && (j >= m || table[(i + 1) * w + j] >= table[i * w + j + 1])) { ops.push(['-', start + i, -1]); i += 1; }
    else { ops.push(['+', -1, start + j]); j += 1; }
  }
  for (let k = endA; k < a.length; k += 1) ops.push([' ', k, endB + (k - endA)]);
  return ops;
}

function unifiedDiff(oldText, newText, { path: filePath = 'file', context = 3 } = {}) {
  const oldIn = splitLines(oldText || '');
  const newIn = splitLines(newText || '');
  const creation = !oldText && Boolean(newText);
  const deletion = Boolean(oldText) && !newText;
  const ops = diffOps(oldIn.lines, newIn.lines);
  const changed = [];
  ops.forEach((op, idx) => { if (op[0] !== ' ') changed.push(idx); });
  if (!changed.length) return '';

  // Group changes into hunks separated by more than 2*context unchanged ops.
  const hunks = [];
  let cur = null;
  for (const idx of changed) {
    const from = Math.max(0, idx - context);
    const to = Math.min(ops.length, idx + context + 1);
    if (cur && from <= cur.to) cur.to = to;
    else { cur = { from, to }; hunks.push(cur); }
  }
  const out = [
    `--- ${creation ? '/dev/null' : `a/${filePath}`}`,
    `+++ ${deletion ? '/dev/null' : `b/${filePath}`}`
  ];
  for (const { from, to } of hunks) {
    const slice = ops.slice(from, to);
    const oldCount = slice.filter((o) => o[0] !== '+').length;
    const newCount = slice.filter((o) => o[0] !== '-').length;
    const first = slice.find((o) => o[1] >= 0);
    const firstNew = slice.find((o) => o[2] >= 0);
    const oldStart = oldCount === 0 ? (first ? first[1] : 0) : first[1] + 1;
    const newStart = newCount === 0 ? (firstNew ? firstNew[2] : 0) : firstNew[2] + 1;
    out.push(`@@ -${oldStart}${oldCount === 1 ? '' : `,${oldCount}`} +${newStart}${newCount === 1 ? '' : `,${newCount}`} @@`);
    for (const [tag, oi, ni] of slice) {
      const raw = tag === '-' ? oldIn.lines[oi] : newIn.lines[ni];
      const noEol = raw.endsWith(NO_EOL);
      out.push(`${tag}${noEol ? raw.slice(0, -NO_EOL.length) : raw}`);
      if (noEol) out.push('\\ No newline at end of file');
    }
  }
  return `${out.join('\n')}\n`;
}

module.exports = { unifiedDiff };
