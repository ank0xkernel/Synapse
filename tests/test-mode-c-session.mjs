#!/usr/bin/env node
/**
 * Mode C session core: state machine, region ledger, bounded queue, context
 * reconstruction and the session that ties them together. Driven by scripted
 * engine events and a fake OCR; no Electron, no real capture.
 *
 * Run: node tests/test-mode-c-session.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { STATES, TRANSITIONS, createStateMachine } = require('../src/services/screen-intel/mode-c-state.js');
const { createScreenSession, deriveState } = require('../src/services/screen-intel/screen-session.js');
const { createRegionLedger } = require('../src/services/screen-intel/region-ledger.js');
const { createAnalysisQueue } = require('../src/services/screen-intel/analysis-queue.js');
const { GAP_MARKER } = require('../src/services/screen-intel/context-builder.js');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.stack.split('\n').slice(0, 4).join('\n      ')}`);
  }
}

const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };
const count = (text, needle) => text.split(needle).length - 1;

// ---- harness ----------------------------------------------------------------
function harness({ limits = {}, handler = null, hold = false, displayId = 'd1' } = {}) {
  let t = 1_700_000_000_000;
  const now = () => t;
  const queue = [];
  let tid = 0;
  const timers = {
    setTimeout(fn, ms) { tid += 1; queue.push({ id: tid, at: t + ms, fn }); return tid; },
    clearTimeout(id) { const i = queue.findIndex((x) => x.id === id); if (i >= 0) queue.splice(i, 1); },
    pending: () => queue.length,
    advance(ms) {
      const end = t + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at || a.id - b.id);
        if (!queue.length || queue[0].at > end) break;
        const next = queue.shift();
        t = Math.max(t, next.at);
        next.fn();
      }
      t = end;
    },
  };
  const held = [];
  const h = { calls: [], held, hold };
  const ocr = {
    recognize(img, ctx) {
      h.calls.push({ img, ctx });
      if (h.hold) return new Promise((res, rej) => held.push({ res, rej, img, ctx }));
      if (h.handler) return Promise.resolve(h.handler(img, ctx, h.calls.length));
      return Promise.resolve({ lines: img.lines, engine: 'fake', durationMs: 5 });
    },
  };
  h.handler = handler;
  const engine = {
    starts: [], stops: 0, pauses: 0, resumes: 0, recaptures: [], recaptureResult: true,
    async start(a) { engine.starts.push(a); },
    async stop() { engine.stops += 1; },
    async pause() { engine.pauses += 1; },
    async resume() { engine.resumes += 1; },
    async requestRecapture(a) { engine.recaptures.push(a); return engine.recaptureResult; },
    async getLatestFrame() { return null; },
  };
  const emitted = [];
  const s = createScreenSession({ ocr, engineControl: engine, now, emitState: (x) => emitted.push(x), limits, timers });
  Object.assign(h, { s, engine, timers, emitted, now, advance: (ms) => timers.advance(ms), displayId, sid: null });
  h.start = async () => { const r = await s.start({ displayId }); h.sid = r.sessionId; return r; };
  h.send = (ev) => s.handleEngineEvent({ sessionId: h.sid, t: now(), ...ev });
  h.snap = () => s.getSnapshot();
  h.release = async (i, result) => { await flush(); held[i].res(result); await flush(); };
  return h;
}

let capSeq = 0;
const R0 = { top: 0, bottom: 0, left: 0, right: 0 };
const ln = (text, x, y, w = text.length * 0.01, h = 0.03, confidence = 0.95) => ({ text, box: { x, y, w, h }, confidence });
const region = (o) => ({
  type: 'region', captureId: `c${(capSeq += 1)}`, containerId: o.c || 'root', segmentId: o.seg ?? 0, epoch: o.epoch ?? 0,
  kind: o.kind || 'initial', screenRect: o.screen || o.rect, contentRect: o.rect, overlap: o.overlap || R0, displayId: 'd1', masks: o.masks,
  image: { jpeg: Buffer.alloc(o.bytes || 100), mime: 'image/jpeg', width: o.rect.w, height: o.rect.h, lines: o.lines || [] },
});
const container = (o) => ({
  type: 'container',
  container: { id: o.id, screenRect: o.screen, axis: o.axis || 'y', scroll: { x: 0, y: o.viewport.y }, segmentId: o.seg ?? 0, epoch: o.epoch ?? 0,
    viewport: o.viewport, extent: o.extent || { x0: o.viewport.x, y0: o.viewport.y, x1: o.viewport.x + o.viewport.w, y1: o.viewport.y + o.viewport.h } },
});
const FULL = { x: 0, y: 0, w: 1000, h: 800 };
const cellsOf = (snap, id) => snap.containers.find((c) => c.id === id).segments.flatMap((s) => s.cells);
const sumCounts = (c) => Object.entries(c).filter(([k]) => k !== 'gaps').reduce((n, [, v]) => n + v, 0);

// ---- state machine ------------------------------------------------------------
console.log('mode-c-state');
await test('transition table only references declared states and is closed', () => {
  const names = new Set(Object.values(STATES));
  assert.deepEqual(new Set(Object.keys(TRANSITIONS)), names);
  for (const [from, targets] of Object.entries(TRANSITIONS)) {
    for (const to of targets) { assert.ok(names.has(to), `${from} -> ${to}`); assert.notEqual(from, to); }
  }
});
await test('invalid transitions are rejected and recorded, valid ones apply', () => {
  const changes = [];
  const sm = createStateMachine({ onChange: (c) => changes.push(c) });
  assert.equal(sm.can(STATES.MONITORING), false);
  assert.equal(sm.transition(STATES.MONITORING, 'skip'), false);
  assert.equal(sm.state, STATES.IDLE);
  assert.equal(sm.rejected().length, 1);
  assert.deepEqual([sm.rejected()[0].from, sm.rejected()[0].to], [STATES.IDLE, STATES.MONITORING]);
  assert.equal(sm.transition(STATES.INITIAL_CAPTURE), true);
  assert.equal(sm.transition(STATES.INITIAL_ANALYSIS), true);
  assert.equal(changes.length, 2);
  assert.equal(sm.transition(STATES.STOPPED), true);
  assert.equal(sm.transition(STATES.VIEW_FULLY_ANALYSED), false, 'STOPPED cannot jump to analysed');
  assert.equal(sm.transition(STATES.INITIAL_CAPTURE), true, 'restart goes through INITIAL_CAPTURE');
});
await test('deriveState follows facts, not assumptions', () => {
  const base = { started: true, frameCaptured: true, initialSettled: true };
  assert.equal(deriveState({}), STATES.IDLE);
  assert.equal(deriveState({ started: true }), STATES.INITIAL_CAPTURE);
  assert.equal(deriveState({ ...base, busy: true, initialSettled: false }), STATES.INITIAL_ANALYSIS);
  assert.equal(deriveState({ ...base, busy: true }), STATES.PROCESSING_NEW_CONTENT);
  assert.equal(deriveState({ ...base, viewAnalysed: true, busy: true }), STATES.PROCESSING_NEW_CONTENT);
  assert.equal(deriveState({ ...base, viewAnalysed: true, failed: 1 }), STATES.ANALYSIS_FAILED);
  assert.equal(deriveState({ ...base, viewAnalysed: true }), STATES.VIEW_FULLY_ANALYSED);
  assert.equal(deriveState({ ...base }), STATES.MONITORING);
});

// ---- session flow ---------------------------------------------------------------
console.log('screen-session: initial analysis and scrolling');
await test('initial capture -> analysis -> VIEW_ANALYSED_FIRST only after OCR resolves', async () => {
  const h = harness({ hold: true });
  await h.start();
  assert.equal(h.snap().state, STATES.INITIAL_CAPTURE);
  h.send(container({ id: 'root', screen: FULL, viewport: FULL }));
  h.send(region({ rect: FULL, lines: [ln('Hello world', 0.1, 0.1)] }));
  let snap = h.snap();
  assert.equal(snap.state, STATES.INITIAL_ANALYSIS);
  assert.equal(snap.message.code, 'INITIAL');
  assert.equal(snap.message.text, 'Analysing current screen');
  assert.notEqual(snap.message.code, 'VIEW_ANALYSED_FIRST');
  assert.equal(snap.view, 'analysing');
  assert.equal(snap.counts.analysed, 0);
  await h.release(0, { lines: [ln('Hello world', 0.1, 0.1)], engine: 'fake', durationMs: 7 });
  snap = h.snap();
  assert.equal(snap.state, STATES.VIEW_FULLY_ANALYSED);
  assert.deepEqual([snap.message.code, snap.message.text, snap.message.hint], ['VIEW_ANALYSED_FIRST', 'Current screen fully analysed.', 'Scroll to analyse more.']);
  assert.equal(snap.view, 'analysed');
  assert.equal(snap.counts.analysed, 1);
  assert.equal(snap.lastAnalysisDurationMs, 7);
  assert.ok(snap.lastCaptureAt && snap.lastAnalysisAt);
});

await test('scroll -> NEW_CONTENT while analysing, NEW_ANALYSED once covered and settled', async () => {
  const h = harness();
  await h.start();
  h.send(container({ id: 'root', screen: FULL, viewport: FULL }));
  h.send(region({ rect: FULL, lines: [ln('top of page', 0.1, 0.1)] }));
  await flush();
  assert.equal(h.snap().message.code, 'VIEW_ANALYSED_FIRST');
  h.send({ type: 'motion', phase: 'start', containerId: 'root' });
  assert.equal(h.snap().state, STATES.SCROLL_DETECTED);
  assert.equal(h.snap().message.text, 'New content detected. Analysing...');
  const scrolled = { x: 0, y: 800, w: 1000, h: 800 };
  h.hold = true;
  h.send(container({ id: 'root', screen: FULL, viewport: scrolled, extent: { x0: 0, y0: 0, x1: 1000, y1: 1600 } }));
  h.send(region({ kind: 'scroll', rect: scrolled, screen: FULL, lines: [ln('below the fold', 0.1, 0.1)] }));
  assert.equal(h.snap().state, STATES.PROCESSING_NEW_CONTENT);
  assert.equal(h.snap().message.code, 'NEW_CONTENT');
  assert.equal(h.snap().view, 'analysing');
  await h.release(0, { lines: [ln('below the fold', 0.1, 0.1)], engine: 'fake', durationMs: 4 });
  h.send({ type: 'motion', phase: 'settled', containerId: 'root' });
  const snap = h.snap();
  assert.equal(snap.state, STATES.VIEW_FULLY_ANALYSED);
  assert.deepEqual([snap.message.code, snap.message.text, snap.message.hint], ['NEW_ANALYSED', 'New content analysed.', 'Scroll to continue.']);
  assert.ok(snap.lastNewContentAt);
  assert.deepEqual(cellsOf(snap, 'root').map((c) => [c.start, c.end, c.status]), [[0, 800, 'analysed'], [800, 1600, 'analysed']]);
});

await test('view is not "fully analysed" when the viewport extends past captured content', async () => {
  const h = harness();
  await h.start();
  h.send(container({ id: 'root', screen: FULL, viewport: FULL }));
  h.send(region({ rect: FULL, lines: [ln('x', 0.1, 0.1)] }));
  await flush();
  assert.equal(h.snap().view, 'analysed');
  h.send(container({ id: 'root', screen: FULL, viewport: { x: 0, y: 400, w: 1000, h: 800 }, extent: { x0: 0, y0: 0, x1: 1000, y1: 1200 } }));
  assert.equal(h.snap().view, 'needs_update');
  assert.notEqual(h.snap().state, STATES.VIEW_FULLY_ANALYSED);
});

await test('two scroll containers are tracked independently', async () => {
  const h = harness();
  await h.start();
  const left = { x: 0, y: 0, w: 500, h: 800 };
  const right = { x: 500, y: 0, w: 500, h: 800 };
  h.send(container({ id: 'c1', screen: left, viewport: left }));
  h.send(container({ id: 'c2', screen: right, viewport: { x: 0, y: 0, w: 500, h: 800 } }));
  h.send(region({ c: 'c1', rect: left, lines: [ln('left question', 0.1, 0.1)] }));
  h.send(region({ c: 'c2', screen: right, rect: { x: 0, y: 0, w: 500, h: 800 }, lines: [ln('right notebook', 0.1, 0.1)] }));
  await flush();
  const leftBefore = JSON.stringify(cellsOf(h.snap(), 'c1'));
  h.hold = true;
  const below = { x: 0, y: 800, w: 500, h: 800 };
  h.send(container({ id: 'c2', screen: right, viewport: below, extent: { x0: 0, y0: 0, x1: 500, y1: 1600 } }));
  h.send(region({ c: 'c2', kind: 'scroll', screen: right, rect: below, lines: [ln('cell 2', 0.1, 0.1)] }));
  await flush();
  let snap = h.snap();
  assert.equal(JSON.stringify(cellsOf(snap, 'c1')), leftBefore, 'left panel cells untouched while right is analysing');
  assert.deepEqual(cellsOf(snap, 'c2').map((c) => c.status), ['analysed', 'analysing']);
  await h.release(0, { lines: [ln('cell 2', 0.1, 0.1)], engine: 'fake', durationMs: 3 });
  snap = h.snap();
  assert.equal(JSON.stringify(cellsOf(snap, 'c1')), leftBefore);
  assert.deepEqual(cellsOf(snap, 'c2').map((c) => c.status), ['analysed', 'analysed']);
  assert.equal(snap.containers.length, 2);
});

// ---- context reconstruction -------------------------------------------------------
console.log('context-builder');
await test('overlap dedupe keeps repeated lines in different places, drops the same line seen twice', async () => {
  const h = harness();
  await h.start();
  const a = { x: 0, y: 0, w: 1000, h: 500 };
  const b = { x: 0, y: 400, w: 1000, h: 500 };
  h.send(region({ rect: a, lines: [ln('return answer', 0.1, 0.1), ln('return answer', 0.1, 0.5), ln('shared boundary line', 0.1, 0.9)] }));
  // region B: boundary line sits at content y=450 -> box y=(450-400)/500=0.1 (within the 100px overlap)
  h.send(region({ kind: 'scroll', rect: b, overlap: { top: 100, bottom: 0, left: 0, right: 0 },
    lines: [ln('shared boundary line', 0.1, 0.1), ln('return answer', 0.1, 0.7), ln('final line here', 0.1, 0.9)] }));
  await flush();
  const text = h.s.buildContext({}).text;
  assert.equal(count(text, 'shared boundary line'), 1);
  assert.equal(count(text, 'return answer'), 3, 'three distinct occurrences survive');
  assert.equal(count(text, 'final line here'), 1);
});

await test('identical content in an overlapping region is marked duplicateOf and not added twice', async () => {
  const h = harness();
  await h.start();
  const lines = [ln('unique sentence one', 0.1, 0.1), ln('unique sentence two', 0.1, 0.3)];
  h.send(region({ rect: FULL, lines }));
  await flush();
  h.send(region({ kind: 'scroll', rect: { x: 0, y: 200, w: 1000, h: 800 }, lines }));
  await flush();
  const regions = h.snap().regions.slice().reverse();
  const last = h.s.getRegion(regions[regions.length - 1].id);
  assert.ok(last.duplicateOf, 'same fingerprint, same container+segment, overlapping rect');
  assert.equal(h.snap().metrics.duplicatesSkipped, 1);
  assert.equal(count(h.s.buildContext({}).text, 'unique sentence one'), 1);
});

await test('Python indentation is recovered from box.x', async () => {
  const h = harness();
  await h.start();
  const rows = [['def solve(nums):', 0.1], ['total = 0', 0.14], ['for n in nums:', 0.14], ['total += n', 0.18], ['return total', 0.14]];
  const lines = rows.map(([t, x], i) => ln(t, x, 0.1 + i * 0.04, t.length * 0.01));
  h.send(region({ rect: FULL, lines }));
  await flush();
  const ctx = h.s.buildContext({});
  const block = ctx.sections[0].blocks[0];
  assert.equal(block.kind, 'code');
  assert.equal(block.text, ['def solve(nums):', '    total = 0', '    for n in nums:', '        total += n', '    return total'].join('\n'));
});

await test('blocks are classified: instruction, test case, code, output, error, table', async () => {
  const h = harness();
  await h.start();
  const rows = [];
  let y = 0.04;
  const block = (...items) => { items.forEach((item, i) => rows.push(Array.isArray(item) ? { t: item[0], x: item[1], y: y + i * 0.035 } : { t: item, x: 0.1, y: y + i * 0.035 })); y += items.length * 0.035 + 0.07; };
  block('Given an array of integers, return the sum of all values.');
  block('Test Case 1', 'Input: nums = [1, 2, 3]', 'Expected Output: 6');
  block('for i in range(3):', ['print(i)', 0.14]);
  block('Out[3]: 6');
  block('Traceback (most recent call last):', '  File "main.py", line 3, in <module>', 'ValueError: bad input');
  const out = rows.map((r) => ln(r.t.trim(), r.x, r.y, r.t.trim().length * 0.01));
  const tableY = y;
  for (let i = 0; i < 3; i += 1) {
    out.push(ln(['Name', 'Alice', 'Bob'][i], 0.1, tableY + i * 0.035, 0.05));
    out.push(ln(['Score', '90', '85'][i], 0.6, tableY + i * 0.035, 0.05));
  }
  h.send(region({ rect: { x: 0, y: 0, w: 1000, h: 1000 }, lines: out }));
  await flush();
  const ctx = h.s.buildContext({});
  assert.deepEqual(ctx.sections[0].blocks.map((b) => b.kind), ['instruction', 'test_case', 'code', 'output', 'error', 'table']);
  for (const b of ctx.sections[0].blocks) assert.ok(b.confidence > 0 && b.confidence <= 1);
  assert.match(ctx.sections[0].blocks[1].text, /Expected Output: 6/);
  assert.match(ctx.sections[0].blocks[5].text, /Name \| Score/);
  assert.ok(ctx.imageRegionIds.length >= 1, 'table region image is attached as visual evidence');
});

await test('buildContext: panel headers, reading order, markers, truthful coverage, nothing invented', async () => {
  const h = harness();
  await h.start();
  const left = { x: 0, y: 0, w: 500, h: 800 };
  const right = { x: 500, y: 0, w: 500, h: 800 };
  h.send(container({ id: 'c2', screen: right, viewport: { x: 0, y: 0, w: 500, h: 800 } }));
  h.send(container({ id: 'c1', screen: left, viewport: left }));
  const supplied = ['alpha question line', 'beta question line', 'notebook cell one', 'notebook cell two'];
  // OCR returns lines bottom-to-top: reading order must be rebuilt
  h.send(region({ c: 'c1', rect: left, lines: [ln(supplied[1], 0.1, 0.6), ln(supplied[0], 0.1, 0.2)] }));
  h.send(region({ c: 'c2', screen: right, rect: { x: 0, y: 0, w: 500, h: 800 }, lines: [ln(supplied[3], 0.1, 0.6), ln(supplied[2], 0.1, 0.2)] }));
  await flush();
  h.send({ type: 'uncaptured', containerId: 'c1', reason: 'fast scroll' });
  h.send({ type: 'gap', containerId: 'c2', fromSegmentId: 0, toSegmentId: 1, reason: 'fast-scroll' });
  const ctx = h.s.buildContext({});
  const t = ctx.text;
  assert.match(t, /Panel 1 \(left, x=0\.\.500\)/);
  assert.match(t, /Panel 2 \(right, x=500\.\.1000\)/);
  assert.ok(t.indexOf('Panel 1') < t.indexOf('alpha question line'));
  assert.ok(t.indexOf('alpha question line') < t.indexOf('beta question line'));
  assert.ok(t.indexOf('beta question line') < t.indexOf('Panel 2'));
  assert.ok(t.indexOf('notebook cell one') < t.indexOf('notebook cell two'));
  assert.ok(t.includes(GAP_MARKER));
  assert.match(t, /pending: waiting to be captured again/);
  assert.equal(ctx.coverage.complete, false);
  assert.equal(ctx.coverage.gaps, 1);
  assert.equal(ctx.coverage.pending, 1);
  assert.match(t, /INCOMPLETE: 1 gap\(s\), 1 pending/);
  assert.match(t, /Do not invent or assume content/);
  const structural = (l) => !l || /^(===|##|\[|```|INCOMPLETE|Do not invent|Everything captured)/.test(l);
  for (const l of t.split('\n').map((x) => x.trim()).filter((x) => !structural(x))) assert.ok(supplied.includes(l), `unsupplied text in context: "${l}"`);
  assert.deepEqual(ctx.sections.map((s) => s.containerId), ['c1', 'c2']);
});

// Contract: an earlier screen joins the context only when it shows the same
// problem as the current one. A screen too short to identify never does.
const PROBLEM_A = 'Campus FAQ Bot. Write a function retrieve passages that returns the top k passages ranked by cosine similarity to the query embedding';
const PROBLEM_A_MORE = 'Write a function retrieve passages that returns the top k passages ranked by cosine similarity. Test cases follow below for the bot';
const PROBLEM_B = 'Matrix Spiral. Given an m by n integer matrix return all of its elements in spiral order starting from the top left corner going clockwise';

await test('a fully analysed screen states complete coverage; an unidentified earlier screen is left out', async () => {
  const h = harness();
  await h.start();
  h.send(region({ rect: FULL, lines: [ln('old screen text', 0.1, 0.1)] }));
  await flush();
  h.send({ type: 'scene-change', epoch: 1 });
  h.send(region({ epoch: 1, rect: FULL, lines: [ln('new screen text', 0.1, 0.1)] }));
  await flush();
  const ctx = h.s.buildContext({});
  assert.equal(ctx.coverage.complete, true);
  assert.match(ctx.text, /Everything captured on the current screen was analysed/);
  assert.ok(ctx.text.includes('new screen text'));
  assert.ok(!ctx.text.includes('old screen text'), 'an unidentified earlier screen must not join the context');
  assert.ok(ctx.coverage.notes.some((n) => /earlier screen\(s\) showing other or unidentified content were left out/.test(n)));
});

await test('earlier screens of the same problem follow under "Previously seen", oldest dropped over budget; other problems never do', async () => {
  const h = harness();
  await h.start();
  const filler = Array.from({ length: 6 }, (_, i) => ln(`Constraint ${i + 1}: the passages list holds at most one thousand entries and top k is at most ten`, 0.05, 0.2 + i * 0.1, 0.9));
  h.send(region({ rect: FULL, lines: [ln(PROBLEM_A, 0.05, 0.1, 0.9), ...filler] }));
  await flush();
  h.send({ type: 'scene-change', epoch: 1 });
  h.send(region({ epoch: 1, rect: FULL, lines: [ln(PROBLEM_A_MORE, 0.05, 0.1, 0.9)] }));
  await flush();
  assert.equal(h.snap().problem.id, 'p1');
  const t = h.s.buildContext({}).text;
  assert.ok(t.indexOf(PROBLEM_A_MORE) < t.indexOf('Previously seen') && t.indexOf('Previously seen') < t.indexOf(PROBLEM_A));
  // The earlier screen is ~600 chars: a budget of the full text length fits
  // the current screen only.
  const tight = h.s.buildContext({ charBudget: t.length });
  assert.ok(!tight.text.includes('Constraint 1:'), 'over budget the earlier screen is dropped first');
  assert.ok(tight.text.includes(PROBLEM_A_MORE));
  assert.ok(tight.coverage.notes.some((n) => /Dropped earlier screen/.test(n)));
  h.send({ type: 'scene-change', epoch: 2 });
  h.send(region({ epoch: 2, rect: FULL, lines: [ln(PROBLEM_B, 0.05, 0.1, 0.9)] }));
  await flush();
  assert.equal(h.snap().problem.id, 'p2');
  const b = h.s.buildContext({}).text;
  assert.ok(b.includes(PROBLEM_B));
  assert.ok(!b.includes('Campus FAQ Bot') && !b.includes('retrieve passages'), 'problem A text leaked into problem B context');
  assert.match(b, /Earlier screens of other problems were removed/);
});

await test('gap is recorded and shown, then closed by a segment merge that unifies coordinates', async () => {
  const h = harness();
  await h.start();
  const seg = (y) => ({ x: 0, y, w: 1000, h: 800 });
  const names = ['alpha line number one', 'bravo line number two', 'charlie line number three'];
  h.send(container({ id: 'c1', screen: FULL, viewport: seg(0) }));
  h.send(region({ c: 'c1', rect: seg(0), lines: [ln('first line of panel', 0.1, 0.1), ln(names[0], 0.1, 0.75), ln(names[1], 0.1, 0.8), ln(names[2], 0.1, 0.85)] }));
  await flush();
  h.send({ type: 'gap', containerId: 'c1', fromSegmentId: 0, toSegmentId: 1, reason: 'fast-scroll' });
  let snap = h.snap();
  assert.equal(snap.counts.gaps, 1);
  assert.equal(snap.containers[0].gaps, 1);
  assert.ok(h.s.buildContext({}).text.includes(GAP_MARKER));
  // segment 1 has its own coordinates: the three lines at y=600/640/680 of segment 0 appear at y=20/60/100
  h.send(container({ id: 'c1', screen: FULL, seg: 1, viewport: seg(0) }));
  h.send(region({ c: 'c1', seg: 1, kind: 'scroll', rect: seg(0), lines: [ln(names[0], 0.1, 0.025), ln(names[1], 0.1, 0.075), ln(names[2], 0.1, 0.125), ln('brand new content', 0.1, 0.3)] }));
  await flush();
  snap = h.snap();
  assert.equal(snap.counts.gaps, 0, 'merge closes the gap');
  assert.equal(snap.containers[0].gaps, 0);
  assert.deepEqual(snap.containers[0].segments.map((s) => s.id), [0], 'segments unified');
  const ctx = h.s.buildContext({});
  assert.ok(!ctx.text.includes(GAP_MARKER));
  assert.equal(count(ctx.text, names[1]), 1, 'overlap lines appear once after unification');
  assert.ok(ctx.text.indexOf(names[2]) < ctx.text.indexOf('brand new content'));
  assert.equal(cellsOf(snap, 'c1').at(-1).end, 1380, 'segment 1 shifted by 580 into segment 0 coordinates');
  assert.equal(ctx.coverage.gaps, 0);
});

// ---- failures and retries -----------------------------------------------------------
console.log('screen-session: failure, retry, backoff, overflow');
await test('OCR failure -> ANALYSIS_FAILED + FAILED message, never analysed; manual retry succeeds', async () => {
  const h = harness({ handler: () => { throw Object.assign(new Error('vision exploded'), { code: 'OCR_FAILED' }); } });
  await h.start();
  h.send(region({ rect: FULL, lines: [ln('retry me please', 0.1, 0.1)] }));
  await flush();
  let snap = h.snap();
  assert.equal(snap.state, STATES.ANALYSIS_FAILED);
  assert.deepEqual([snap.message.code, snap.message.text, snap.message.action], ['FAILED', 'Unable to analyse new content', 'retry']);
  assert.equal(snap.counts.analysed, 0);
  assert.equal(snap.counts.failed, 1);
  assert.deepEqual(snap.error, { code: 'OCR_FAILED', message: 'vision exploded' });
  h.advance(2000); await flush();
  assert.equal(h.calls.length, 2, 'OCR_FAILED gets exactly one automatic retry');
  h.advance(60000); await flush();
  assert.equal(h.calls.length, 2, 'and no more');
  assert.equal(h.timers.pending(), 0, 'no retry timers left');
  assert.equal(h.snap().counts.analysed, 0);
  h.handler = null;
  assert.equal(h.s.retry(), 1);
  await flush();
  snap = h.snap();
  assert.equal(snap.counts.analysed, 1);
  assert.equal(snap.counts.failed, 0);
  assert.equal(snap.state, STATES.VIEW_FULLY_ANALYSED);
});

await test('NETWORK failure backs off 2s then 8s, shows OFFLINE, never reports analysed early', async () => {
  const h = harness({ handler: (img, ctx, n) => { if (n < 3) throw Object.assign(new Error('offline'), { code: 'NETWORK' }); return { lines: img.lines, engine: 'fake', durationMs: 1 }; } });
  await h.start();
  h.send(region({ rect: FULL, lines: [ln('network text', 0.1, 0.1)] }));
  await flush();
  let snap = h.snap();
  assert.equal(snap.state, STATES.ANALYSIS_FAILED);
  assert.deepEqual([snap.message.code, snap.message.text], ['OFFLINE', 'Network unavailable. Analysis will resume when it returns.']);
  h.advance(1999); await flush();
  assert.equal(h.calls.length, 1);
  h.advance(1); await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.snap().counts.analysed, 0);
  h.advance(7999); await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.snap().counts.analysed, 0);
  h.advance(1); await flush();
  assert.equal(h.calls.length, 3);
  snap = h.snap();
  assert.equal(snap.counts.analysed, 1);
  assert.equal(snap.state, STATES.VIEW_FULLY_ANALYSED);
});

await test('QUOTA_EXHAUSTED pauses the queue until the backoff expires and shows QUOTA', async () => {
  const h = harness({ handler: (img, ctx, n) => { if (n === 1) throw Object.assign(new Error('429'), { code: 'QUOTA_EXHAUSTED' }); return { lines: img.lines, engine: 'fake', durationMs: 1 }; } });
  await h.start();
  h.send(region({ rect: FULL, lines: [ln('quota one', 0.1, 0.1)] }));
  await flush();
  h.send(region({ kind: 'scroll', rect: { x: 0, y: 800, w: 1000, h: 800 }, lines: [ln('quota two', 0.1, 0.1)] }));
  await flush();
  let snap = h.snap();
  assert.deepEqual([snap.message.code, snap.message.text], ['QUOTA', 'AI quota reached. Analysis will resume automatically.']);
  assert.equal(h.calls.length, 1, 'second region does not start while quota-paused');
  assert.equal(snap.counts.analysed, 0);
  h.advance(2000); await flush();
  assert.equal(h.calls.length, 3);
  snap = h.snap();
  assert.equal(snap.counts.analysed, 2);
  assert.notEqual(snap.message.code, 'QUOTA');
});

await test('queue overflow marks the region pending (nothing silently lost) and recovers via requestRecapture', async () => {
  const h = harness({ hold: true, limits: { maxQueued: 2 } });
  await h.start();
  const band = (i) => ({ x: 0, y: i * 100, w: 500, h: 100 });
  for (let i = 0; i < 4; i += 1) h.send(region({ c: 'c1', screen: { x: 0, y: 0, w: 500, h: 800 }, kind: i ? 'scroll' : 'initial', rect: band(i), lines: [ln(`band ${i}`, 0.1, 0.3)] }));
  let snap = h.snap();
  assert.equal(snap.counts.pending, 1);
  assert.equal(sumCounts(snap.counts), 4, 'every emitted region is still accounted for');
  const pending = snap.regions.find((r) => r.status === 'pending');
  assert.equal(pending.hasImage, false, 'image released');
  assert.equal(pending.error.code, 'QUEUE_OVERFLOW');
  assert.equal(snap.metrics.queueOverflowed, 1);
  assert.equal(h.engine.recaptures.length, 0, 'no recapture while the queue is full');
  await h.release(0, { lines: [], engine: 'fake', durationMs: 1 });
  h.hold = false;
  h.send(container({ id: 'c1', screen: { x: 0, y: 0, w: 500, h: 800 }, viewport: { x: 0, y: 0, w: 500, h: 400 } }));
  assert.equal(h.engine.recaptures.length, 1);
  const pendingRec = h.s.getRegion(pending.id);
  assert.deepEqual(h.engine.recaptures[0], { containerId: 'c1', contentRect: pendingRec.contentRect });
  h.send(region({ c: 'c1', screen: { x: 0, y: 0, w: 500, h: 800 }, kind: 'recapture', rect: pendingRec.contentRect, lines: [ln('recaptured band', 0.1, 0.3)] }));
  await flush();
  snap = h.snap();
  assert.equal(snap.counts.pending, 0);
  assert.equal(h.s.getRegion(pending.id).status, 'superseded');
  assert.equal(sumCounts(snap.counts), 5);
});

await test('uncaptured movement -> UNCAPTURED message with retry; retry requests a recapture', async () => {
  const h = harness();
  await h.start();
  h.send(container({ id: 'root', screen: FULL, viewport: FULL }));
  h.send(region({ rect: FULL, lines: [ln('base', 0.1, 0.1)] }));
  await flush();
  h.send({ type: 'uncaptured', containerId: 'root', reason: 'capture timeout' });
  await flush();
  const snap = h.snap();
  assert.equal(snap.state, STATES.ANALYSIS_PENDING);
  assert.deepEqual([snap.message.code, snap.message.text, snap.message.action], ['UNCAPTURED', "Screen movement detected, but new content hasn't been captured yet.", 'retry']);
  assert.equal(snap.view, 'needs_update');
  h.send({ type: 'uncaptured', containerId: 'root', reason: 'capture timeout' });
  assert.equal(h.snap().counts.pending, 1, 'repeated reports do not multiply placeholders');
  assert.ok(h.engine.recaptures.length >= 1, 'visible pending placeholder triggers recapture');
  const before = h.engine.recaptures.length;
  assert.ok(h.s.retry() >= 1);
  assert.equal(h.engine.recaptures.length, before + 1);
});

await test('stale supersedes: partial change cancels the running job, late result is dropped; refresh replaces content', async () => {
  const h = harness({ hold: true });
  await h.start();
  h.send(region({ rect: FULL, lines: [ln('old cell output', 0.1, 0.1)] }));
  await flush();
  const signal = h.held[0].ctx.signal;
  assert.equal(signal.aborted, false);
  h.send({ type: 'stale', containerId: 'root', contentRect: { x: 0, y: 100, w: 1000, h: 50 }, reason: 'in-place-change' });
  assert.equal(signal.aborted, true, 'running job cancelled');
  await h.release(0, { lines: [ln('LATE RESULT', 0.1, 0.1)], engine: 'fake', durationMs: 1 });
  let snap = h.snap();
  assert.equal(snap.counts.analysed, 0);
  assert.equal(snap.metrics.lateResultsDropped, 1);
  assert.ok(!h.s.buildContext({}).text.includes('LATE RESULT'));
  assert.equal(snap.counts.stale, 1);
  // refresh over the whole area supersedes the stale marker and the pending region
  h.hold = false;
  h.send(region({ kind: 'refresh', rect: FULL, lines: [ln('new cell output', 0.1, 0.1)] }));
  await flush();
  snap = h.snap();
  assert.equal(snap.counts.analysed, 1);
  assert.equal(snap.counts.stale, 0);
  assert.equal(snap.counts.pending, 0);
  assert.equal(snap.state, STATES.VIEW_FULLY_ANALYSED);
  const t = h.s.buildContext({}).text;
  assert.ok(t.includes('new cell output') && !t.includes('old cell output'));
});

await test('a refresh that fully covers a queued/running region supersedes it and cancels the job', async () => {
  const h = harness({ hold: true });
  await h.start();
  h.send(region({ rect: FULL, lines: [ln('obsolete', 0.1, 0.1)] }));
  await flush();
  const signal = h.held[0].ctx.signal;
  h.send(region({ kind: 'refresh', rect: FULL, lines: [ln('fresh', 0.1, 0.1)] }));
  assert.equal(signal.aborted, true);
  const first = h.snap().regions.find((r) => r.kind === 'initial');
  assert.equal(first.status, 'superseded');
  await h.release(0, { lines: [ln('obsolete', 0.1, 0.1)], engine: 'fake', durationMs: 1 });
  assert.equal(h.snap().metrics.lateResultsDropped, 1);
});

// ---- lifecycle ----------------------------------------------------------------------
console.log('screen-session: lifecycle');
await test('single active session; stop then start gives a fresh session and clean ledger; stale events dropped', async () => {
  const h = harness();
  const first = await h.start();
  const again = await h.s.start({ displayId: 'd1' });
  assert.equal(again.sessionId, first.sessionId);
  assert.equal(h.engine.starts.length, 1);
  h.send(region({ rect: FULL, lines: [ln('session one', 0.1, 0.1)] }));
  await flush();
  assert.equal(h.snap().regions.length, 1);
  await h.s.stop();
  assert.equal(h.snap().state, STATES.STOPPED);
  assert.equal(h.snap().message.text, 'Screen monitoring stopped');
  assert.equal(h.snap().monitoring, 'stopped');
  const oldSid = h.sid;
  const second = await h.start();
  assert.notEqual(second.sessionId, oldSid);
  assert.equal(h.snap().regions.length, 0);
  assert.equal(h.snap().metrics.regionsTotal, 0);
  h.s.handleEngineEvent({ sessionId: oldSid, type: 'region', ...region({ rect: FULL }) , sessionId: oldSid });
  assert.equal(h.snap().metrics.staleEventsDropped, 1);
  assert.equal(h.snap().metrics.regionsTotal, 0);
  const third = await h.s.restart();
  assert.notEqual(third.sessionId, second.sessionId);
  assert.equal(h.engine.stops, 2);
});

await test('pause and resume drive the engine and the derived state', async () => {
  const h = harness();
  await h.start();
  h.send(container({ id: 'root', screen: FULL, viewport: FULL }));
  h.send(region({ rect: FULL, lines: [ln('paused text', 0.1, 0.1)] }));
  await flush();
  await h.s.pause();
  let snap = h.snap();
  assert.equal(snap.state, STATES.PAUSED);
  assert.deepEqual([snap.message.code, snap.message.text, snap.monitoring], ['PAUSED', 'Screen monitoring paused', 'paused']);
  assert.equal(h.engine.pauses, 1);
  h.send(region({ kind: 'scroll', rect: { x: 0, y: 800, w: 1000, h: 800 }, lines: [ln('ignored while paused', 0.1, 0.1)] }));
  assert.equal(h.snap().metrics.regionsTotal, 1, 'nothing ingested while paused');
  await h.s.resume();
  snap = h.snap();
  assert.equal(h.engine.resumes, 1);
  assert.equal(snap.monitoring, 'active');
  assert.equal(snap.state, STATES.VIEW_FULLY_ANALYSED);
});

await test('a region captured just before Pause but delivered after it is kept, not silently lost', async () => {
  const h = harness();
  await h.start();
  h.send(container({ id: 'root', screen: FULL, viewport: FULL }));
  h.send(region({ rect: FULL, lines: [ln('first view', 0.1, 0.1)] }));
  await flush();
  await h.s.pause();
  h.send({ ...region({ kind: 'scroll', rect: { x: 0, y: 800, w: 1000, h: 800 }, lines: [ln('captured before pause', 0.1, 0.1)] }), t: h.now() - 40 });
  await flush();
  assert.equal(h.snap().metrics.regionsTotal, 2, 'in-flight region dropped by pause');
  assert.match(h.s.buildContext({}).text, /captured before pause/);
});

await test('Stop during start stops the engine once it opens, and a new start waits for that, then succeeds', async () => {
  const h = harness();
  let release;
  h.engine.start = (a) => { h.engine.starts.push(a); return new Promise((r) => { release = r; }); };
  const first = h.s.start({ displayId: 'd1' });
  await flush();
  await h.s.stop();
  const second = h.s.start({ displayId: 'd1' });
  const releaseFirst = release;
  h.engine.start = async (a) => { h.engine.starts.push(a); };
  releaseFirst();
  await first;
  const r2 = await second;
  assert.equal(h.engine.stops >= 2, true, `engine left running after Stop during start (stops=${h.engine.stops})`);
  assert.ok(r2.sessionId);
  assert.equal(h.snap().monitoring, 'active');
  assert.equal(h.engine.starts.length, 2);
});

await test('suspend/lock pause capture and mark needs_update; resume/unlock resume it', async () => {
  const h = harness();
  await h.start();
  h.send(container({ id: 'root', screen: FULL, viewport: FULL }));
  h.send(region({ rect: FULL, lines: [ln('before sleep', 0.1, 0.1)] }));
  await flush();
  assert.equal(h.snap().view, 'analysed');
  await h.s.notifySystem('suspend');
  assert.equal(h.snap().state, STATES.PAUSED);
  assert.equal(h.snap().view, 'needs_update');
  assert.equal(h.engine.pauses, 1);
  await h.s.notifySystem('lock');
  assert.equal(h.engine.pauses, 1, 'already paused: engine not paused twice');
  await h.s.notifySystem('resume');
  assert.equal(h.snap().state, STATES.PAUSED, 'still locked');
  assert.equal(h.engine.resumes, 0);
  await h.s.notifySystem('unlock');
  assert.equal(h.engine.resumes, 1);
  assert.equal(h.snap().monitoring, 'active');
});

await test('user pause survives a system resume', async () => {
  const h = harness();
  await h.start();
  await h.s.pause();
  await h.s.notifySystem('suspend');
  await h.s.notifySystem('resume');
  assert.equal(h.snap().state, STATES.PAUSED);
  assert.equal(h.engine.resumes, 0);
});

await test('display-changed marks old regions stale/inaccessible and restarts capture on the same session', async () => {
  const h = harness({ hold: true });
  await h.start();
  h.send(region({ rect: FULL, lines: [ln('display one', 0.1, 0.1)] }));
  await flush();
  h.send(region({ kind: 'scroll', rect: { x: 0, y: 800, w: 1000, h: 800 }, lines: [] }));
  await h.release(0, { lines: [ln('display one', 0.1, 0.1)], engine: 'fake', durationMs: 1 });
  const sid = h.sid;
  await h.s.notifySystem('display-changed', { displayId: 'd2' });
  const snap = h.snap();
  assert.equal(snap.sessionId, sid);
  assert.equal(h.engine.stops, 1);
  assert.deepEqual(h.engine.starts.map((s) => [s.sessionId, s.displayId]), [[sid, 'd1'], [sid, 'd2']]);
  const statuses = snap.regions.map((r) => r.status).sort();
  assert.deepEqual(statuses, ['inaccessible', 'stale']);
  assert.notEqual(snap.state, STATES.STOPPED);
  h.hold = false;
  h.send(region({ epoch: 1, rect: FULL, lines: [ln('display two', 0.1, 0.1)] }));
  await flush();
  assert.equal(h.snap().counts.analysed, 1);
});

await test('permission-revoked stops with a clear PERMISSION error and never loops', async () => {
  const h = harness();
  await h.start();
  h.send(region({ rect: FULL, lines: [ln('secret', 0.1, 0.1)] }));
  await flush();
  await h.s.notifySystem('permission-revoked');
  let snap = h.snap();
  assert.equal(snap.state, STATES.STOPPED);
  assert.deepEqual([snap.message.code, snap.message.text], ['PERMISSION', 'Screen Recording permission is not available.']);
  assert.equal(snap.error.code, 'PERMISSION');
  assert.equal(snap.monitoring, 'stopped');
  await h.s.notifySystem('permission-revoked');
  assert.equal(h.engine.stops, 1);
  assert.equal(h.engine.starts.length, 1, 'no automatic restart');
  h.send(region({ rect: FULL }));
  assert.equal(h.snap().metrics.staleEventsDropped, 1);
});

await test('capture-window-lost restarts the engine on the same session; engine failure surfaces as ANALYSIS_FAILED', async () => {
  const h = harness();
  await h.start();
  h.send(region({ rect: FULL, lines: [ln('x', 0.1, 0.1)] }));
  await flush();
  await h.s.notifySystem('capture-window-lost');
  assert.equal(h.engine.starts.length, 2);
  h.engine.start = async () => { throw new Error('window gone'); };
  await h.s.notifySystem('capture-window-lost');
  const snap = h.snap();
  assert.equal(snap.state, STATES.ANALYSIS_FAILED);
  assert.equal(snap.error.code, 'ENGINE_RESTART_FAILED');
});

await test('a panel scrolled back to its first screenful counts as analysed: that range was read in the root capture', async () => {
  const h = harness();
  await h.start();
  h.send(container({ id: 'root', screen: FULL, viewport: FULL }));
  h.send(region({ rect: FULL, lines: [ln('panel intro', 0.3, 0.1)] }));
  await flush();
  const screen = { x: 200, y: 0, w: 800, h: 800 };
  const panel = (y) => ({ ...container({ id: 'c1', screen, seg: 1, viewport: { x: 0, y, w: 800, h: 800 } }).container, origin: { x: 200, y: 0 } });
  // The panel scrolled by 300: the engine captures only the newly revealed 800..1100.
  h.send({ type: 'container', container: panel(300) });
  h.send(region({ c: 'c1', seg: 1, kind: 'scroll', screen: { x: 200, y: 500, w: 800, h: 300 }, rect: { x: 0, y: 800, w: 800, h: 300 }, lines: [ln('panel more', 0.3, 0.5)] }));
  await flush();
  assert.equal(h.snap().state, STATES.VIEW_FULLY_ANALYSED, 'scrolled view: root 300..800 plus own 800..1100');
  h.send({ type: 'container', container: panel(0) });
  await flush();
  assert.equal(h.snap().state, STATES.VIEW_FULLY_ANALYSED, 'scrolled back to the top: 0..800 is root text, nothing left to read');
  // Root text outside the panel's columns is not evidence for it.
  const h2 = harness();
  await h2.start();
  h2.send(container({ id: 'root', screen: FULL, viewport: FULL }));
  h2.send(region({ rect: { x: 0, y: 0, w: 150, h: 800 }, lines: [ln('sidebar', 0.05, 0.1)] }));
  h2.send({ type: 'container', container: { ...container({ id: 'c1', screen, seg: 1, viewport: { x: 0, y: 0, w: 800, h: 800 } }).container, origin: { x: 200, y: 0 } } });
  await flush();
  assert.notEqual(h2.snap().state, STATES.VIEW_FULLY_ANALYSED);
});

await test('refreshView (Reanalyze) asks for fresh crops of every read region in view, and only those', async () => {
  const h = harness();
  await h.start();
  h.send(container({ id: 'root', screen: FULL, viewport: FULL }));
  h.send(region({ rect: { x: 0, y: 0, w: 1000, h: 400 }, lines: [ln('top text', 0.1, 0.1)] }));
  h.send(region({ rect: { x: 0, y: 400, w: 1000, h: 400 }, lines: [ln('bottom text', 0.1, 0.1)] }));
  await flush();
  const before = h.engine.recaptures.length;
  const { requested } = h.s.refreshView();
  await flush();
  assert.equal(requested, 2);
  assert.equal(h.engine.recaptures.length - before, 2);
  assert.deepEqual(h.engine.recaptures.slice(before).map((r) => r.contentRect.y).sort((a, b) => a - b), [0, 400]);
  await h.s.stop();
  assert.equal(h.s.refreshView().requested, 0, 'nothing is requested once monitoring stopped');
});

await test('permission revoked mid-session: the stream restart is refused and the session reports PERMISSION, not a generic failure', async () => {
  const h = harness();
  await h.start();
  h.send(region({ rect: FULL, lines: [ln('x', 0.1, 0.1)] }));
  await flush();
  h.engine.start = async () => { throw Object.assign(new Error('Screen Recording permission is not granted.'), { code: 'PERMISSION' }); };
  await h.s.notifySystem('capture-window-lost');
  const snap = h.snap();
  assert.equal(snap.state, STATES.STOPPED);
  assert.equal(snap.message.code, 'PERMISSION');
  assert.equal(snap.error.code, 'PERMISSION');
});

await test('engine start failure rejects and is reported, not swallowed', async () => {
  const h = harness();
  h.engine.start = async () => { throw new Error('no capture window'); };
  await assert.rejects(h.s.start({ displayId: 'd1' }), /no capture window/);
  assert.equal(h.snap().state, STATES.ANALYSIS_FAILED);
  assert.equal(h.snap().error.code, 'ENGINE_START_FAILED');
});

await test('image memory budget evicts analysed images LRU-first; queued images become pending, not lost', async () => {
  const h = harness({ limits: { imageBudgetBytes: 1000 } });
  await h.start();
  const band = (i) => ({ x: 0, y: i * 100, w: 500, h: 100 });
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    h.send(region({ c: 'c1', screen: band(0), kind: i ? 'scroll' : 'initial', rect: band(i), bytes: 600, lines: [ln(`band ${i}`, 0.1, 0.3)] }));
    await flush();
  }
  let snap = h.snap();
  assert.ok(snap.metrics.imageBytes <= 1000);
  ids.push(...snap.regions.slice().reverse().map((r) => r.id));
  assert.equal(h.s.getRegion(ids[0]).imageRef, null);
  assert.equal(h.s.getRegion(ids[0]).imageEvicted, true);
  assert.equal(h.s.getRegion(ids[0]).status, 'analysed', 'text survives image eviction');
  assert.ok(h.s.getRegion(ids[2]).imageRef, 'newest image kept');
  const h2 = harness({ hold: true, limits: { imageBudgetBytes: 1000 } });
  await h2.start();
  h2.send(region({ c: 'c1', screen: band(0), rect: band(0), bytes: 600, lines: [] }));
  await flush();
  h2.send(region({ c: 'c1', screen: band(0), kind: 'scroll', rect: band(1), bytes: 600, lines: [] }));
  snap = h2.snap();
  assert.ok(snap.metrics.imageBytes <= 1000);
  assert.equal(snap.counts.pending, 1);
  assert.equal(snap.counts.analysing, 1);
  assert.equal(sumCounts(snap.counts), 2);
});

await test('masked rects inside the initial region are recorded as inaccessible and excluded from text', async () => {
  const h = harness();
  await h.start();
  const mask = { x: 600, y: 0, w: 400, h: 100 };
  h.send(region({ rect: FULL, masks: [mask], lines: [ln('visible text', 0.1, 0.5), ln('hidden under app', 0.7, 0.03)] }));
  await flush();
  const snap = h.snap();
  assert.equal(snap.counts.inaccessible, 1);
  const ctx = h.s.buildContext({});
  assert.ok(ctx.text.includes('visible text'));
  assert.ok(!ctx.text.includes('hidden under app'));
  assert.match(ctx.text, /hidden behind the app window/);
});

await test('snapshots are throttled, change-only, and JSON-serialisable', async () => {
  const h = harness({ hold: true });
  await h.start();
  assert.equal(h.emitted.length, 1);
  h.send(region({ rect: FULL, lines: [] }));
  for (let i = 0; i < 5; i += 1) h.send({ type: 'motion', phase: i % 2 ? 'settled' : 'start', containerId: 'root' });
  await flush();
  assert.equal(h.emitted.length, 1, 'bursts inside the interval emit nothing');
  assert.ok(h.timers.pending() >= 1);
  h.advance(250);
  assert.equal(h.emitted.length, 2);
  assert.equal(h.emitted.at(-1).state, STATES.INITIAL_ANALYSIS);
  h.advance(250);
  assert.equal(h.emitted.length, 2, 'no change, no emit');
  for (const snap of h.emitted) assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
  const keys = Object.keys(h.emitted.at(-1));
  for (const k of ['sessionId', 'state', 'monitoring', 'view', 'message', 'startedAt', 'lastCaptureAt', 'lastAnalysisAt', 'analysingSince', 'lastAnalysisDurationMs', 'lastNewContentAt', 'counts', 'containers', 'regions', 'metrics', 'error']) {
    assert.ok(keys.includes(k), k);
  }
  assert.ok(h.emitted.at(-1).analysingSince !== null);
});

await test('regions in the snapshot are capped at 60 most recent', async () => {
  const h = harness();
  await h.start();
  for (let i = 0; i < 70; i += 1) {
    h.send(region({ c: 'c1', screen: FULL, kind: i ? 'scroll' : 'initial', rect: { x: 0, y: i * 10, w: 100, h: 10 }, lines: [ln(`row ${i}`, 0.1, 0.1)] }));
    if (i % 5 === 4) await flush();
  }
  await flush();
  const snap = h.snap();
  assert.equal(snap.regions.length, 60);
  assert.equal(snap.metrics.regionsTotal, 70);
  assert.equal(snap.counts.analysed + snap.counts.pending, 70 - snap.counts.captured - snap.counts.analysing);
});

await test('dispose cancels jobs and leaves no timers', async () => {
  const h = harness({ hold: true });
  await h.start();
  h.send(region({ rect: FULL, lines: [] }));
  await flush();
  const signal = h.held[0].ctx.signal;
  h.hold = false;
  h.handler = () => { throw Object.assign(new Error('offline'), { code: 'NETWORK' }); };
  h.send(region({ kind: 'scroll', rect: { x: 0, y: 800, w: 1000, h: 800 }, lines: [] }));
  await h.release(0, { lines: [], engine: 'fake', durationMs: 1 });
  assert.ok(h.timers.pending() > 0, 'backoff + snapshot timers exist before dispose');
  await h.s.dispose();
  assert.equal(signal.aborted, false, 'finished job unaffected');
  assert.equal(h.timers.pending(), 0);
  const before = h.emitted.length;
  h.send(region({ rect: FULL }));
  h.advance(60000);
  assert.equal(h.emitted.length, before);
  assert.equal(h.timers.pending(), 0);
});

await test('dispose aborts a running OCR call', async () => {
  const h = harness({ hold: true });
  await h.start();
  h.send(region({ rect: FULL, lines: [] }));
  await flush();
  const signal = h.held[0].ctx.signal;
  await h.s.dispose();
  assert.equal(signal.aborted, true);
  assert.equal(h.timers.pending(), 0);
});

// ---- ledger / queue units -----------------------------------------------------------
console.log('region-ledger and analysis-queue');
await test('ledger coverage separates analysed, failed, pending and uncovered holes per segment', () => {
  const led = createRegionLedger();
  const add = (y, status) => led.add({ containerId: 'c', segmentId: 0, epoch: 0, contentRect: { x: 0, y, w: 10, h: 100 }, status });
  add(0, 'analysed'); add(100, 'failed'); add(300, 'pending');
  const [seg] = led.coverage('c', { epoch: 0 });
  assert.deepEqual(seg.cells.map((c) => [c.start, c.end, c.status]), [[0, 100, 'analysed'], [100, 200, 'failed'], [200, 300, 'uncovered'], [300, 400, 'pending']]);
});

await test('queue: visible jobs first then newest; cancelWhere aborts running; overflow evicts via callback', async () => {
  const started = [];
  const overflow = [];
  const gate = [];
  const q = createAnalysisQueue({ maxQueued: 2, runner: (job) => { started.push(job.regionId); return new Promise((r) => gate.push(r)); }, onOverflow: (j) => overflow.push(j.regionId) });
  q.enqueue({ regionId: 'run', attempt: 1 });
  q.enqueue({ regionId: 'old', attempt: 1 });
  q.enqueue({ regionId: 'visible-old', attempt: 1, isVisible: () => true });
  q.enqueue({ regionId: 'new', attempt: 1 });
  assert.deepEqual(overflow, ['old'], 'oldest hidden job evicted, handed back, not dropped');
  const hit = q.cancelWhere((j) => j.regionId === 'run');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].signal.aborted, true);
  await flush();
  assert.equal(started[1], 'visible-old', 'visible job runs before newer hidden job');
  const s = q.stats();
  assert.equal(s.cancelled, 1);
  assert.equal(s.overflowed, 1);
  assert.equal(s.depth, 1);
  q.dispose();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
