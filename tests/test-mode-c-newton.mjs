#!/usr/bin/env node
/**
 * Mode C against two real screenshots of the Newton School "Campus FAQ Bot"
 * playground (tests/fixtures/newton-campus-faq). Between the frames the left
 * question panel scrolled and the right notebook jumped to unrelated cells.
 *
 * Needs macOS (sips + the Vision OCR helper). Prints "skipped" elsewhere.
 *
 * Run: node tests/test-mode-c-newton.mjs
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

const { estimateShift, findColumnDividers } = require(path.join(root, 'src/services/screen-intel/frame-analysis.js'));
const { createOcrService } = require(path.join(root, 'src/services/screen-intel/ocr-service.js'));
const { buildNativeOcr, NATIVE_OCR_BINARY } = require(path.join(root, 'scripts/build-native-ocr.js'));
// The production path joins Vision's per-colour fragments into lines before
// anything reads them (controller.js); test what the model actually receives.
const { joinLineFragments } = require(path.join(root, 'src/main-process/features/screen-intel/controller.js'));

const W = 1512;
const H = 982;
const LEFT_PANEL = { x: 56, y: 230, w: 330, h: 740 };
const RIGHT_PANEL = { x: 420, y: 290, w: 1080, h: 680 };

// sips writes an uncompressed BMP; rows are bottom-up unless height is negative.
function loadGray(name) {
  const out = path.join(os.tmpdir(), `synapse-newton-${process.pid}-${name}.bmp`);
  execFileSync('sips', ['-s', 'format', 'bmp', '-z', String(H), String(W), path.join(fixtures, name), '--out', out], { stdio: 'ignore' });
  const bmp = fs.readFileSync(out);
  fs.unlinkSync(out);
  const offset = bmp.readUInt32LE(10);
  const width = bmp.readInt32LE(18);
  const rawHeight = bmp.readInt32LE(22);
  const bytes = bmp.readUInt16LE(28) / 8;
  const height = Math.abs(rawHeight);
  const stride = Math.ceil((width * bytes) / 4) * 4;
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = offset + (rawHeight > 0 ? height - 1 - y : y) * stride;
    for (let x = 0; x < width; x += 1) {
      const p = row + x * bytes;
      gray[y * width + x] = (bmp[p] * 29 + bmp[p + 1] * 150 + bmp[p + 2] * 77) >> 8;
    }
  }
  return { gray, width, height };
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log('=== MODE C: REAL NEWTON SCHOOL SCREENSHOTS ===\n');

const top = loadGray('frame-1-top.png');
const scrolled = loadGray('frame-2-scrolled.png');

await test('frames decode to the analysis size', () => {
  assert(top.width === W && top.height === H, `got ${top.width}x${top.height}`);
});

await test('left question panel: scroll offset is measured, not guessed', () => {
  const result = estimateShift(top.gray, scrolled.gray, W, H, LEFT_PANEL, { axis: 'y', maxShift: 600 });
  console.log(`      left panel estimate: ${JSON.stringify(result)}`);
  assert(result, 'no shift found for a panel that visibly scrolled');
  // "Test Cases" moves from y=1113 to y=661 in the 2000px-wide rendering: 452 * 0.756 = 342.
  assert(Math.abs(result.shift - 342) <= 3, `expected about 342px, got ${result.shift}`);
});

await test('right notebook: unrelated content is not given a shift', () => {
  const result = estimateShift(top.gray, scrolled.gray, W, H, RIGHT_PANEL, { axis: 'y', maxShift: 600 });
  console.log(`      right panel estimate: ${JSON.stringify(result)}`);
  assert(result === null || result.confidence < 0.5, `claimed a shift of ${result?.shift} with confidence ${result?.confidence}`);
});

await test('the divider between question panel and notebook is found', () => {
  const dividers = findColumnDividers(top.gray, W, H);
  console.log(`      dividers at x=${JSON.stringify(dividers)}`);
  assert(dividers.some((x) => x >= 385 && x <= 415), 'no divider near x=400');
});

buildNativeOcr({ log: () => {} });
if (!fs.existsSync(NATIVE_OCR_BINARY)) {
  console.log('  skipped OCR checks: helper could not be built (swiftc missing?)');
} else {
  const ocr = createOcrService({ helperPath: NATIVE_OCR_BINARY, log: () => {} });
  const image = fs.readFileSync(path.join(fixtures, 'frame-2-scrolled.png'));
  let lines = [];
  const EXPECTED = [
    'def retrieve_passages(query, passages, top_k=3):',
    'def answer_question(query, passages, top_k=3):',
    'return results[:top_k]',
    'test_retrieve_sorted_1',
    'test_answer_quality_llm_eval_1'
  ];
  const SCALE = 2; // fixture pixels per analysis pixel (3024 / 1512)

  // Production OCRs each panel on its own (capture-engine crops the
  // container rect at native resolution); it never reads the whole frame.
  function cropPanel(rect) {
    const out = path.join(os.tmpdir(), `synapse-newton-${process.pid}-${rect.x}.png`);
    // sips treats an offset of 0 as "centre", so offsets start at 1.
    execFileSync('sips', ['-c', String(rect.h * SCALE), String(rect.w * SCALE), '--cropOffset',
      String(Math.max(1, rect.y * SCALE)), String(Math.max(1, rect.x * SCALE)), path.join(fixtures, 'frame-2-scrolled.png'), '--out', out], { stdio: 'ignore' });
    const data = fs.readFileSync(out);
    fs.unlinkSync(out);
    return data;
  }

  await test('panel OCR (production path) reads the later notebook cells and the test-case list exactly', async () => {
    const panels = await Promise.all([LEFT_PANEL, RIGHT_PANEL].map((rect) => ocr.recognize({ jpeg: cropPanel(rect), mime: 'image/png' }, {})));
    lines = joinLineFragments(panels[1].lines);
    const text = panels.flatMap((r) => joinLineFragments(r.lines)).map((line) => line.text).join('\n');
    console.log(`      ${panels[0].lines.length} + ${panels[1].lines.length} lines in ${panels[0].durationMs} + ${panels[1].durationMs} ms (${panels[1].engine})`);
    // Vision's whitespace differs between machines on the same macOS (seen on
    // CI: "retrieve_passages (query" on a macOS 26 runner, exact on a macOS 26
    // Mac). Criterion: every non-whitespace character exact; the exact-match
    // count is printed so spacing drift stays visible.
    const squash = (s) => s.replace(/\s+/g, '');
    const exact = EXPECTED.filter((e) => text.includes(e)).length;
    console.log(`      exact (including spaces) ${exact}/${EXPECTED.length}`);
    for (const expected of EXPECTED) assert(squash(text).includes(squash(expected)), `characters missing: ${expected}`);
  });

  // Whole-frame OCR is not a production path, but it shows how much Vision's
  // whitespace varies with the crop: the same pixels come back as
  // "retrieve_passages (query," there. Criterion here: every non-whitespace
  // character must match; the exact-match rate is printed, not hidden.
  await test('whole-frame OCR keeps every non-whitespace character (spacing varies with the crop)', async () => {
    const result = await ocr.recognize({ jpeg: image, mime: 'image/png', width: 3024, height: 1964 }, {});
    const text = joinLineFragments(result.lines).map((line) => line.text).join('\n');
    const squash = (s) => s.replace(/\s+/g, '');
    const exact = EXPECTED.filter((e) => text.includes(e)).length;
    const recalled = EXPECTED.filter((e) => squash(text).includes(squash(e))).length;
    // Measured, not asserted: the whole frame also drops the bottom-edge
    // test-case row that panel OCR reads (see the test above).
    console.log(`      whole frame: exact ${exact}/${EXPECTED.length}, characters ${recalled}/${EXPECTED.length}`);
    for (const expected of EXPECTED.slice(0, 3)) assert(squash(text).includes(squash(expected)), `code characters missing: ${expected}`);
  });

  await test('Python indentation is recoverable from line positions', () => {
    const find = (needle) => lines.find((line) => line.text.includes(needle));
    const def = find('def retrieve_passages');
    const body = find('query_embedding = get_embedding(query)');
    const nested = find('passage_embedding = get_embedding(passage)');
    assert(def && body && nested, 'expected code lines not found');
    assert(body.box.x > def.box.x && nested.box.x > body.box.x, `x positions: ${def.box.x}, ${body.box.x}, ${nested.box.x}`);
  });

  ocr.dispose();
}

console.log(`\nNewton screenshot tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed ? 1 : 0);
