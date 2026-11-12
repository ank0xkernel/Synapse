#!/usr/bin/env node
/**
 * Notebook cell extraction on the real Newton screenshots, through the
 * production path: panel crop -> Apple Vision -> joined lines -> blocks.
 * Ground truth: tests/fixtures/newton-campus-faq/notebook-cells.json.
 *
 * Prints per-frame metrics (detected, missing, duplicated, merged, wrong kind,
 * character accuracy) and fails when a cell is missing, merged with another,
 * of the wrong kind, out of order, or accuracy drops below 0.97.
 *
 * Needs macOS (sips + the Vision OCR helper). Prints "skipped" elsewhere.
 * Run: node tests/test-mode-c-notebook.mjs
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = path.join(__dirname, '..');
const fixtures = path.join(__dirname, 'fixtures', 'newton-campus-faq');

if (process.platform !== 'darwin') {
  console.log('skipped: needs macOS (sips and Apple Vision)');
  process.exit(0);
}

const { createOcrService } = require(path.join(root, 'src/services/screen-intel/ocr-service.js'));
const { buildNativeOcr, NATIVE_OCR_BINARY } = require(path.join(root, 'scripts/build-native-ocr.js'));
const { joinLineFragments } = require(path.join(root, 'src/main-process/features/screen-intel/controller.js'));
const { mapLines, dedupeLines, toBlocks } = require(path.join(root, 'src/services/screen-intel/context-lines.js'));

const truth = JSON.parse(fs.readFileSync(path.join(fixtures, 'notebook-cells.json'), 'utf8'));
const SCALE = 2;
const squash = (s) => s.replace(/\s+/g, '');

function crop(file, r) {
  const out = path.join(os.tmpdir(), `synapse-nb-${process.pid}-${file}`);
  execFileSync('sips', ['-c', String(r.h * SCALE), String(r.w * SCALE), '--cropOffset', String(r.y * SCALE), String(r.x * SCALE), path.join(fixtures, file), '--out', out], { stdio: 'ignore' });
  const data = fs.readFileSync(out);
  fs.unlinkSync(out);
  return data;
}

// Levenshtein similarity of the best-matching OCR line for one reference line.
function similarity(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

buildNativeOcr({ log: () => {} });
if (!fs.existsSync(NATIVE_OCR_BINARY)) {
  console.log('skipped: Vision OCR helper could not be built');
  process.exit(0);
}
const ocr = createOcrService({ helperPath: NATIVE_OCR_BINARY, log: () => {} });

let failed = 0;
const totals = { expected: 0, detected: 0, missing: 0, duplicated: 0, merged: 0, wrongKind: 0 };
console.log('=== NOTEBOOK CELL EXTRACTION: NEWTON SCREENSHOTS ===');
for (const frame of truth.frames) {
  const result = await ocr.recognize({ jpeg: crop(frame.file, truth.panel), mime: 'image/png' }, {});
  const lines = joinLineFragments(result.lines);
  const record = { id: frame.file, contentRect: { x: 0, y: 0, w: truth.panel.w, h: truth.panel.h }, overlap: {}, lines };
  const blocks = toBlocks(dedupeLines(mapLines(record)));
  const blockOf = (anchor) => blocks.map((b, i) => (squash(b.text).includes(squash(anchor)) ? i : -1)).filter((i) => i >= 0);

  const m = { expected: frame.cells.length, detected: 0, missing: [], duplicated: [], merged: [], wrongKind: [] };
  const firstBlock = [];
  for (const cell of frame.cells) {
    const hits = cell.anchors.map(blockOf);
    if (hits.some((h) => !h.length)) { m.missing.push(cell.id); firstBlock.push(null); continue; }
    m.detected += 1;
    if (hits.some((h) => h.length > 1)) m.duplicated.push(cell.id);
    if (hits.flat().some((i) => blocks[i].kind !== cell.kind)) m.wrongKind.push(`${cell.id}:${hits.flat().map((i) => blocks[i].kind).join('/')}`);
    firstBlock.push(Math.min(...hits.flat()));
  }
  frame.cells.forEach((a, i) => frame.cells.forEach((b, j) => {
    if (j <= i) return;
    const shared = a.anchors.flatMap(blockOf).filter((k) => b.anchors.flatMap(blockOf).includes(k));
    if (shared.length) m.merged.push(`${a.id}+${b.id}`);
  }));
  const order = firstBlock.filter((x) => x !== null);
  const ordered = order.every((x, i) => i === 0 || x >= order[i - 1]);
  // A notebook prompt ("In [2]: ") is UI, not the line's text.
  const text = lines.map((l) => l.text.replace(/^(In|ln|Out)\s*\[[\s\d]*\]?\s*:\s*/, ''));
  const scores = frame.reference.map((ref) => Math.max(...text.map((t) => similarity(ref, t))));
  const accuracy = scores.reduce((a, b) => a + b, 0) / scores.length;
  const exact = frame.reference.filter((ref) => text.includes(ref)).length;

  console.log(`\n${frame.file}: ${lines.length} OCR lines in ${result.durationMs} ms, ${blocks.length} blocks`);
  console.log(`  cells expected ${m.expected}, detected ${m.detected}, missing [${m.missing}], duplicated [${m.duplicated}], merged [${m.merged}], wrong kind [${m.wrongKind}], in order ${ordered}`);
  console.log(`  character accuracy ${accuracy.toFixed(3)} (exact lines ${exact}/${frame.reference.length})`);
  const problems = [];
  if (m.missing.length) problems.push(`missing ${m.missing}`);
  if (m.merged.length) problems.push(`merged ${m.merged}`);
  if (m.wrongKind.length) problems.push(`wrong kind ${m.wrongKind}`);
  if (!ordered) problems.push('cells out of order');
  if (accuracy < 0.97) problems.push(`accuracy ${accuracy.toFixed(3)} < 0.97`);
  console.log(problems.length ? `  ✗ ${problems.join('; ')}` : '  ✓ all cells extracted, separate, correctly typed and in order');
  if (problems.length) {
    failed += 1;
    for (const b of blocks) console.log(`      [${b.kind}] ${b.text.split('\n')[0].slice(0, 80)}`);
  }
  totals.expected += m.expected; totals.detected += m.detected; totals.missing += m.missing.length;
  totals.duplicated += m.duplicated.length; totals.merged += m.merged.length; totals.wrongKind += m.wrongKind.length;
}
ocr.dispose();
console.log(`\nTotals: ${JSON.stringify(totals)}`);
console.log(`Notebook extraction tests: ${truth.frames.length - failed} passed, ${failed} failed (${truth.frames.length} total)`);
process.exit(failed ? 1 : 0);
