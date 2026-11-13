#!/usr/bin/env node
/**
 * Code indentation rebuilt from OCR box geometry (context-lines.js). Lines are
 * laid out like a monospaced editor: x = left + column * pitch, so the
 * expected indentation is known exactly.
 *
 * Run: node tests/test-mode-c-indent.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mapLines, dedupeLines, toBlocks, classify } = require('../src/services/screen-intel/context-lines.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message.split('\n').join('\n      ')}`);
  }
}

const RECT = { x: 0, y: 0, w: 1000, h: 2000 };
/**
 * rows: [column, text] or [column, text, { x, pitch }] per line. A column of
 * null leaves a blank row (no OCR line). Width uses the line's own length.
 */
function record(rows, { left = 100, pitch = 8.4, lineH = 22, id = 'r1', y0 = 40, rect = RECT } = {}) {
  const lines = [];
  rows.forEach(([col, text, o = {}], i) => {
    if (col === null) return;
    const p = o.pitch || pitch;
    const x = o.x !== undefined ? o.x : left + col * p;
    lines.push({ text, confidence: 0.95, box: { x: x / rect.w, y: (y0 + i * lineH) / rect.h, w: (text.length * p) / rect.w, h: 16 / rect.h } });
  });
  return { id, contentRect: rect, overlap: {}, lines };
}
const codeOf = (records) => toBlocks(dedupeLines(records.flatMap(mapLines))).filter((b) => b.kind === 'code').map((b) => b.text).join('\n---\n');
const expectCode = (records, expected) => assert.equal(codeOf(records), expected.join('\n'));

test('function with an empty list, a loop and a nested call', () => {
  expectCode([record([[0, 'def step(passages, top_k=3):'], [4, 'scores = []'], [4, 'for passage in passages:'], [8, 'scores.append(score(passage))'], [4, 'return scores[:top_k]']])], [
    'def step(passages, top_k=3):', '    scores = []', '    for passage in passages:', '        scores.append(score(passage))', '    return scores[:top_k]',
  ]);
});

test('numeric list and nested loops three levels deep', () => {
  expectCode([record([[0, 'values = [1, 2, 3]'], [0, 'for a in values:'], [4, 'for b in values:'], [8, 'if a != b:'], [12, 'print(a * b)']])], [
    'values = [1, 2, 3]', 'for a in values:', '    for b in values:', '        if a != b:', '            print(a * b)',
  ]);
});

test('multiline expression keeps its continuation indent', () => {
  expectCode([record([[0, 'response = client.create('], [4, 'model="gpt-4o-mini",'], [4, 'messages=['], [8, '{"role": "user"},'], [4, '],'], [0, ')']])], [
    'response = client.create(', '    model="gpt-4o-mini",', '    messages=[', '        {"role": "user"},', '    ],', ')',
  ]);
});

test('a blank line inside a function is kept and does not change indentation of what follows', () => {
  expectCode([record([[0, 'def answer(query):'], [4, 'context = build(query)'], [null, ''], [4, 'return context']])], [
    'def answer(query):', '    context = build(query)', '', '    return context',
  ]);
});

test('two top-level functions separated by a blank line stay two code blocks', () => {
  assert.equal(codeOf([record([[0, 'def a(x):'], [4, 'return x'], [null, ''], [null, ''], [0, 'def b(y):'], [4, 'return y']])]),
    'def a(x):\n    return x\n---\ndef b(y):\n    return y');
});

for (const prompt of ['In [1]:', 'In [27]:', 'In [ ]:', 'ln [3]:', 'In [31:']) {
  test(`notebook prompt "${prompt}" left of the code is not the baseline`, () => {
    expectCode([record([[0, `${prompt} # checkpoint`, { x: 20 }], [0, 'def step(passages, top_k=3):'], [4, 'scores = []'], [4, 'return scores']])], [
      `${prompt} # checkpoint`, 'def step(passages, top_k=3):', '    scores = []', '    return scores',
    ]);
  });
}

test('an output line printed left of the code is not the baseline', () => {
  expectCode([record([[0, 'def step(passages):'], [4, 'return sorted(passages)'], [0, 'result 20: 740 rows ok', { x: 70 }]])], [
    'def step(passages):', '    return sorted(passages)', 'result 20: 740 rows ok',
  ]);
});

test('character pitch is measured, so a wider font still gives 4 spaces, not 6', () => {
  expectCode([record([[0, 'def step(x):'], [4, 'y = x + 1'], [4, 'return y']], { pitch: 12.6 })], ['def step(x):', '    y = x + 1', '    return y']);
});

test('six-space indentation in the source is kept as six, never snapped to a guess', () => {
  expectCode([record([[0, 'def step(x):'], [6, 'y = x + 1'], [6, 'return y']])], ['def step(x):', '      y = x + 1', '      return y']);
});

test('OCR noise in one box width does not change the indentation of the others', () => {
  expectCode([record([[0, 'def step(passages, top_k=3):'], [4, 'scores = [1', { pitch: 7.6 }], [4, 'return scores[:top_k]']])], [
    'def step(passages, top_k=3):', '    scores = [1', '    return scores[:top_k]',
  ]);
});

test('two overlapping captures of the same lines, read with different spacing, appear once', () => {
  const a = record([[0, 'def step(passages):'], [4, 'scores.append(score(passage))'], [4, 'return scores']], { id: 'a' });
  const b = record([[0, 'def step (passages):'], [4, 'scores. append(score(passage))'], [4, 'return scores']], { id: 'b' });
  const text = codeOf([a, b]);
  assert.equal((text.match(/append/g) || []).length, 1, text);
  assert.equal((text.match(/def step/g) || []).length, 1, text);
});

test('a line cut short at a region edge and its full read appear once, as the full read', () => {
  const a = record([[0, 'def step(passages):'], [4, 'return scores[: top_k']], { id: 'a' });
  const b = record([[0, 'def step(passages):'], [4, 'return scores [: top_k]']], { id: 'b' });
  const text = codeOf([a, b]);
  assert.equal((text.match(/return/g) || []).length, 1, text);
  assert.ok(text.includes('    return scores [: top_k]'), text);
});

test('different short lines at the same spot are not merged by the prefix rule', () => {
  const a = record([[0, 'x = 1']], { id: 'a' });
  const b = record([[0, 'x = 10']], { id: 'b' });
  const lines = dedupeLines([a, b].flatMap(mapLines));
  assert.equal(lines.length, 2, 'short keys below 8 characters must both survive');
});

const blocksOf = (records) => toBlocks(dedupeLines(records.flatMap(mapLines))).map((b) => ({ kind: b.kind, first: b.text.split('\n')[0].trim() }));

test('notebook: a prompt row starts a new cell even with no gap above it', () => {
  const b = blocksOf([record([[0, 'In [1]: x = 1', { x: 20 }], [0, 'In [2]: y = 2', { x: 20 }], [0, 'z = y + 1']])]);
  assert.deepEqual(b.map((x) => x.first), ['In [1]: x = 1', 'In [2]: y = 2']);
});

test('notebook: output printed straight under the code is its own output block', () => {
  const b = blocksOf([record([[0, 'In [1]: !pip install openai', { x: 20 }], [0, 'Requirement already satisfied: openai in /opt/conda', { x: 92 }], [0, 'Requirement already satisfied: anyio in /opt/conda', { x: 92 }]], { left: 100 })]);
  assert.deepEqual(b.map((x) => x.kind), ['code', 'output']);
});

test('notebook: an indented docstring inside a function stays code', () => {
  const b = blocksOf([record([[0, 'In [3]: def step(x):', { x: 20 }], [4, 'Returns the doubled value of x'], [4, 'for every input we see here'], [4, 'return x * 2']])]);
  assert.equal(b.length, 1);
  assert.equal(b[0].kind, 'code');
});

test('notebook: a bare pass or break is code, not output', () => {
  const b = blocksOf([record([[0, 'In [4]: for x in xs:', { x: 20 }], [4, 'pass'], [0, 'break']])]);
  assert.deepEqual(b.map((x) => x.kind), ['code']);
});

test('the original OCR text survives inside the rebuilt line (evidence kept, nothing rewritten)', () => {
  const text = codeOf([record([[0, 'def step (passages, top_k=3) :'], [4, 'return scores [: top_k]']])]);
  assert.ok(text.includes('def step (passages, top_k=3) :') && text.includes('    return scores [: top_k]'), text);
});

test('lettered answer options are question text, not code; lone attribute assignments stay code', () => {
  const rows = (texts) => texts.map((text) => ({ text, cells: 1 }));
  assert.equal(classify(rows(['A. x = 3', 'B.x = 5', 'C.X =7', 'D. x = 15'])).kind, 'instruction');
  assert.equal(classify(rows(['(A) 12', '(B) 15', '(C) 18'])).kind, 'instruction');
  assert.equal(classify(rows(['B.x = 5', 'C.y = 6', 'total = B.x + C.y'])).kind, 'code', 'letters not starting at A are not an option list');
  assert.equal(classify(rows(['self.x = 3', 'self.y = 4'])).kind, 'code');
});

console.log(`\nIndentation tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed ? 1 : 0);
