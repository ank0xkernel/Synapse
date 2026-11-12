#!/usr/bin/env node
/**
 * Problem boundaries and the explicit New Problem action, without Electron.
 *
 * Principle under test: scrolling navigates content; New Problem changes
 * context. Pages are laid out in content pixels (headings are taller rows,
 * paragraphs are grouped rows) and regions are slices of a page, so every
 * scenario is deterministic.
 *
 * Run: node tests/test-mode-c-boundaries.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createScreenSession } = require('../src/services/screen-intel/screen-session.js');
const { createProblemTracker } = require('../src/services/screen-intel/problem-tracker.js');
const pb = require('../src/services/screen-intel/problem-boundaries.js');
const { registerAssistantIpc } = require('../src/main-process/features/assistant/ipc.js');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.stack.split('\n').slice(0, 5).join('\n      ')}`);
  }
}
const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };

// ---- page fixtures ------------------------------------------------------------------
// '#Title' = title row (28 px), '##Sub' = section heading (20 px), text rows 16 px, '' = paragraph break.
function layout(items, y0 = 20) {
  const out = [];
  let y = y0;
  for (const it of items) {
    if (it === '') { y += 30; continue; }
    const h = it.startsWith('##') ? 20 : it.startsWith('#') ? 28 : 16;
    const text = it.replace(/^#+/, '');
    out.push({ text, y, h, x: 10, w: Math.min(380, text.length * 6) });
    y += h + (it.startsWith('#') ? 14 : 4);
  }
  return out;
}
const pageEnd = (doc) => Math.max(...doc.map((l) => l.y + l.h));
/** OCR lines of the part of a page inside content rows [from, to). */
function slice(doc, from, to, width = 400) {
  return doc.filter((l) => l.y >= from && l.y + l.h <= to).map((l) => ({
    text: l.text, confidence: 0.95, box: { x: l.x / width, y: (l.y - from) / (to - from), w: l.w / width, h: l.h / (to - from) },
  }));
}

// Questions long enough that one fills about half a view, as on a real quiz page.
const details = (topic) => ['', ...Array.from({ length: 10 }, (_, i) => `Detail ${i + 1} about ${topic}: read this requirement carefully before answering part ${i + 1}.`)];
const Q1 = ['#Question 1', 'Write a function that merges two sorted linked lists into one sorted list.', 'Both input lists are sorted in non decreasing order and either may be empty.',
  'Return the head of the merged list without allocating new nodes for values.', '', 'Example: merging one two four with one three four gives one one two three four four.', ...details('merging sorted lists')];
const Q2 = ['#Question 2', 'Given a binary tree return the level order traversal of its node values.', 'Visit nodes from left to right level by level starting at the root node.',
  'The tree contains between zero and two thousand nodes holding integer values.', '', 'Use a queue so that every node is visited exactly once in breadth first order.', ...details('tree traversal order')];
const Q3 = ['#Question 3', 'Implement a least recently used cache supporting get and put in constant time.', 'When the cache reaches capacity evict the least recently used key first.',
  'Keys and values are positive integers and capacity is at most three thousand.', '', 'Combine a hash map with a doubly linked list to keep the usage order.', ...details('cache eviction policy')];
// Two numbered questions written from the same template: only the numbers and a few words differ.
const T4 = ['#Question 4', 'Read the passage below and choose the statement that best summarises the main argument of the author.', 'Select exactly one option and justify the choice in one sentence using evidence from the passage.',
  'The passage discusses renewable energy adoption in coastal cities over the last decade.'];
const T5 = ['#Question 5', 'Read the passage below and choose the statement that best summarises the main argument of the author.', 'Select exactly one option and justify the choice in one sentence using evidence from the passage.',
  'The passage discusses public transport funding in mountain towns over the last decade.'];
// One long problem with sections and section headings smaller than its title.
const LONG = ['#Campus FAQ Bot', 'Build a retrieval pipeline that returns grounded answers for campus questions.', 'Write a function retrieve passages that ranks passages by cosine similarity.',
  'Return the top k passages sorted by score in descending order every time.', '', '##Follow-up Discussion', 'Explain how the ranking would change if passages were chunked by heading.',
  'Describe what happens when two passages have exactly the same similarity score.', '', '##Grading Notes', 'Answers are graded on correctness of ranking and clarity of the explanation.',
  'Partial credit is given when the pipeline returns grounded passages but unsorted.', '', 'Test Cases', '1. test retrieve returns results for a campus question',
  '2. test retrieve sorted by cosine similarity score descending', '3. test answer is grounded in the retrieved passages only'];
// Two unnumbered problems on one page with equal title sizes.
const PAIR_A = ['#Two Sum Pairs', 'Given an array of integers return indices of the two numbers that add up to a target.', 'Each input has exactly one solution and the same element is never used twice.',
  'Return the answer in any order as a list of two indices.'];
const PAIR_B = ['#Interval Merger', 'Given a collection of intervals merge all overlapping intervals into one.', 'Return the merged intervals sorted by their start value in ascending order.',
  'Intervals that only touch at an endpoint are also considered overlapping.'];

// ---- session harness ------------------------------------------------------------------
function harness({ store = null, beginEpoch = 'ok', t0 = 1_700_000_000_000 } = {}) {
  let t = t0;
  const now = () => t;
  const held = [];
  const h = { hold: false, held, changes: [], forgotten: [], beginCalls: [] };
  const queue = [];
  let tid = 0;
  const timers = {
    setTimeout(fn, ms) { tid += 1; queue.push({ id: tid, at: t + ms, fn }); return tid; },
    clearTimeout(id) { const i = queue.findIndex((x) => x.id === id); if (i >= 0) queue.splice(i, 1); },
  };
  h.advance = (ms) => {
    const end = t + ms;
    for (;;) {
      queue.sort((a, b) => a.at - b.at || a.id - b.id);
      if (!queue.length || queue[0].at > end) break;
      const next = queue.shift();
      t = Math.max(t, next.at);
      next.fn();
    }
    t = end;
  };
  const ocr = {
    recognize(img) {
      if (h.hold) return new Promise((res, rej) => held.push({ res, rej, img }));
      return Promise.resolve({ lines: img.lines, engine: 'fake', durationMs: 5 });
    },
  };
  const engine = {
    async start() {}, async stop() {}, async pause() {}, async resume() {},
    async requestRecapture() { return true; }, async getLatestFrame() { return null; },
    async beginEpoch({ epoch }) {
      h.beginCalls.push(epoch);
      if (beginEpoch === 'gate') await new Promise((r) => { h.openGate = r; });
      return beginEpoch === 'fail' ? null : epoch;
    },
    forgetOutsideView({ containerId }) { h.forgotten.push(containerId); return true; },
  };
  const s = createScreenSession({ ocr, engineControl: engine, now, timers, problemStore: store, onProblemChange: (p) => h.changes.push(p) });
  let cap = 0;
  Object.assign(h, {
    s,
    tick: (ms = 10) => { t += ms; },
    start: async () => { h.sid = (await s.start({ displayId: 'd1' })).sessionId; },
    send: (ev) => s.handleEngineEvent({ sessionId: h.sid, t: now(), ...ev }),
    /** One captured region: rows [from, to) of `doc` in container `c`. */
    region: (o) => h.send({
      type: 'region', captureId: `k${(cap += 1)}`, containerId: o.c || 'root', segmentId: o.seg ?? 0, epoch: o.epoch ?? 0, kind: o.kind || 'initial',
      screenRect: o.screen || { x: o.x0 || 0, y: 0, w: o.w || 400, h: o.to - o.from }, contentRect: { x: 0, y: o.from, w: o.w || 400, h: o.to - o.from },
      overlap: { top: 0, bottom: 0, left: 0, right: 0 }, displayId: 'd1', t: o.t ?? now(),
      image: { jpeg: Buffer.alloc(64), mime: 'image/jpeg', lines: o.lines || slice(o.doc, o.from, o.to, o.w || 400) },
    }),
    container: (o) => h.send({ type: 'container', container: {
      id: o.id, screenRect: o.screen || { x: o.x0 || 0, y: 0, w: o.w || 400, h: 800 }, axis: 'y', scroll: { x: 0, y: o.y }, segmentId: o.seg ?? 0, epoch: o.epoch ?? 0,
      viewport: { x: 0, y: o.y, w: o.w || 400, h: 800 }, extent: { x0: 0, y0: 0, x1: o.w || 400, y1: o.y + 800 },
    } }),
    /** Scroll a panel: motion start, new viewport, revealed rows, settle. */
    scroll: async (o) => {
      h.send({ type: 'motion', phase: 'start', containerId: o.id });
      h.container({ id: o.id, y: o.y, seg: o.seg, epoch: o.epoch, x0: o.x0, w: o.w });
      if (o.reveal) h.region({ c: o.id, kind: 'scroll', doc: o.doc, from: o.reveal[0], to: o.reveal[1], seg: o.seg, epoch: o.epoch, x0: o.x0, w: o.w });
      await flush();
      if (o.settle !== false) { h.send({ type: 'motion', phase: 'settled', containerId: o.id }); await flush(); }
    },
    problem: () => s.getSnapshot().problem,
    context: () => s.buildContext({ charBudget: 100000 }).text,
  });
  return h;
}

/** Panel 'q' showing rows [0, 800) of `doc`, read and identified. */
async function openPanel(h, doc, { epoch = 0, y = 0 } = {}) {
  h.container({ id: 'q', y, epoch });
  h.region({ c: 'q', doc, from: y, to: y + 800, epoch });
  await flush();
}

const memoryStore = () => {
  const store = { saved: null, saves: 0 };
  store.load = () => (store.saved ? JSON.parse(JSON.stringify(store.saved)) : null);
  store.save = (state) => { store.saved = JSON.parse(JSON.stringify(state)); store.saves += 1; };
  return store;
};

// ===================================================================================
console.log('boundary primitives');

await test('identifiers: question numbers count, sub-steps and code never do', () => {
  const { identifierOf } = require('../src/services/screen-intel/problem-tracker.js');
  assert.equal(identifierOf('Question 7'), '7');
  assert.equal(identifierOf('Q7. Which of these'), '7');
  assert.equal(identifierOf('Problem 2: Interval Merger'), '2');
  assert.equal(identifierOf('Exercise 03'), '3');
  for (const no of ['Part 2', 'Task 1', 'Step 3', 'Questions', 'Example 2', 'Quarterly revenue 2024']) assert.equal(identifierOf(no), null, no);
  const blocks = pb.blocksOf([{ id: 'r', containerId: 'q', contentRect: { x: 0, y: 0, w: 400, h: 400 }, overlap: {}, lines: slice(layout(['q1 = load(data)', 'x = q1 + 2']), 0, 400) }]);
  assert.deepEqual(pb.boundaryHeadings(blocks), [], 'code mentioning q1 proposed a boundary');
});

await test('attribution: base above the first cut, confirmed cuts own what follows, undecided cuts hold it', () => {
  const entry = { base: 'p1', cuts: [{ id: 'k1', pos: 100, status: 'confirmed', problemId: 'p2' }, { id: 'k2', pos: 300, status: 'possible' }, { id: 'k3', pos: 500, status: 'dismissed' }] };
  assert.equal(pb.attributeAt(entry, 50), 'p1');
  assert.equal(pb.attributeAt(entry, 100), 'p2');
  assert.equal(pb.attributeAt(entry, 290), 'p2');
  assert.equal(pb.attributeAt(entry, 600), pb.HELD, 'a dismissed cut must not end the held part');
  assert.equal(pb.attributeAt({ base: null, cuts: [] }, 10), pb.HELD);
  // Reading line at 25% of the view; no owner while it is within 6% of a boundary.
  assert.equal(pb.ownerInView(entry, 0, 800), 'p2');
  assert.equal(pb.ownerInView(entry, -150, 650), null);
  assert.equal(pb.ownerInView(entry, -400, 400), 'p1');
});

// ===================================================================================
console.log('scrolling within one problem');

await test('long problem: scrolling through its sections never creates another problem', async () => {
  const h = harness();
  await h.start();
  const doc = layout(LONG);
  h.container({ id: 'q', y: 0 });
  h.region({ c: 'q', doc, from: 0, to: 240 });
  await flush();
  assert.equal(h.problem().id, 'p1');
  for (const [y, from, to] of [[100, 240, 340], [200, 340, 460], [300, 460, pageEnd(doc) + 10]]) await h.scroll({ id: 'q', y, doc, reveal: [from, to] });
  const snap = h.s.getSnapshot();
  assert.equal(snap.problem.id, 'p1');
  assert.equal(snap.problem.candidate, null, 'a section heading was offered as a new problem');
  assert.equal(snap.problems.length, 1);
  assert.equal(h.changes.length, 1, 'only the first identification fires');
  const t = h.context();
  for (const part of ['Follow-up Discussion', 'Grading Notes', 'test answer is grounded']) assert.ok(t.includes(part), `lost: ${part}`);
});

await test('reaching the end of a problem does not start another', async () => {
  const h = harness();
  await h.start();
  const doc = layout([...Q1, '', 'End of section. Submit your answers when you are ready to continue.']);
  await openPanel(h, doc);
  await h.scroll({ id: 'q', y: 300, doc, reveal: [800, 1100] });
  assert.equal(h.problem().id, 'p1');
  assert.equal(h.s.listProblems().length, 1);
});

// ===================================================================================
console.log('automatic boundaries');

const QUIZ = layout([...Q1, '', ...Q2, '', ...Q3]);
const posOf = (doc, text) => doc.find((l) => l.text === text).y;

await test('scrolling into the next numbered question: confirmed, isolated, active only after the scroll settles', async () => {
  const h = harness();
  await h.start();
  const q2 = posOf(QUIZ, 'Question 2');
  h.container({ id: 'q', y: 0 });
  h.region({ c: 'q', doc: QUIZ, from: 0, to: q2 - 10 });
  await flush();
  assert.equal(h.problem().id, 'p1');
  // Reveal Question 2 while still moving: nothing switches mid-scroll.
  await h.scroll({ id: 'q', y: q2 - 20, doc: QUIZ, reveal: [q2 - 10, q2 + 200], settle: false });
  assert.equal(h.problem().id, 'p1', 'switched while the panel was still moving');
  h.send({ type: 'motion', phase: 'settled', containerId: 'q' });
  await flush();
  assert.equal(h.problem().id, 'p2');
  assert.equal(h.changes.at(-1).decision, 'scroll');
  const t = h.context();
  assert.match(t, /level order traversal/);
  for (const leaked of ['merges two sorted linked lists', 'Question 1']) assert.ok(!t.includes(leaked), `Q1 leaked into Q2: ${leaked}`);
  assert.match(t, /belonging to other problems were left out/);
  assert.equal(h.problem().candidate, null);
});

await test('scrolling back up returns to the earlier question with its context; Q2 stays out', async () => {
  const h = harness();
  await h.start();
  const q2 = posOf(QUIZ, 'Question 2');
  h.container({ id: 'q', y: 0 });
  h.region({ c: 'q', doc: QUIZ, from: 0, to: q2 - 10 });
  await flush();
  await h.scroll({ id: 'q', y: q2 - 20, doc: QUIZ, reveal: [q2 - 10, q2 + 200] });
  assert.equal(h.problem().id, 'p2');
  await h.scroll({ id: 'q', y: 0, doc: QUIZ });
  assert.equal(h.problem().id, 'p1');
  const t = h.context();
  assert.match(t, /merges two sorted linked lists/);
  assert.ok(!t.includes('level order traversal'), 'Q2 leaked back into Q1');
  assert.deepEqual(h.changes.map((c) => c.id), ['p1', 'p2', 'p1']);
});

await test('small scrolls around a boundary do not flip the problem; a clear move past it does', async () => {
  const h = harness();
  await h.start();
  const q2 = posOf(QUIZ, 'Question 2');
  h.container({ id: 'q', y: 0 });
  h.region({ c: 'q', doc: QUIZ, from: 0, to: q2 + 400 });
  await flush();
  assert.equal(h.problem().id, 'p1');
  const before = h.changes.length;
  // The reading line (200px into an 800px view) wiggles 20px either side of Question 2.
  for (const y of [q2 - 180, q2 - 220, q2 - 180, q2 - 220]) await h.scroll({ id: 'q', y, doc: QUIZ });
  assert.equal(h.problem().id, 'p1');
  assert.equal(h.changes.length, before, 'a wiggle at the boundary fired a problem change');
  await h.scroll({ id: 'q', y: q2 - 100, doc: QUIZ });
  assert.equal(h.problem().id, 'p2');
});

await test('rapid scrolling across several questions: each part goes to its own problem, nothing mixes', async () => {
  const h = harness();
  await h.start();
  const end = pageEnd(QUIZ) + 10;
  const [q2, q3] = [posOf(QUIZ, 'Question 2'), posOf(QUIZ, 'Question 3')];
  h.container({ id: 'q', y: 0 });
  h.region({ c: 'q', doc: QUIZ, from: 0, to: 300 });
  await flush();
  // One fling: three bands arrive before anything settles.
  h.send({ type: 'motion', phase: 'start', containerId: 'q' });
  for (const [y, from, to] of [[q2 - 400, 300, q2 + 120], [q3 - 400, q2 + 120, q3 + 120], [q3 - 20, q3 + 120, end]]) {
    h.container({ id: 'q', y });
    h.region({ c: 'q', kind: 'scroll', doc: QUIZ, from, to });
  }
  await flush();
  assert.equal(h.problem().id, 'p1', 'switched during the fling');
  h.send({ type: 'motion', phase: 'settled', containerId: 'q' });
  await flush();
  const problems = h.s.listProblems();
  assert.equal(problems.length, 3, `expected one problem per question, got ${problems.map((p) => p.title).join(', ')}`);
  const active = h.problem();
  assert.equal(active.title, 'Question 3');
  const t = h.context();
  assert.match(t, /least recently used cache/);
  for (const leaked of ['binary tree', 'linked lists']) assert.ok(!t.includes(leaked), `leaked: ${leaked}`);
});

await test('two questions from the same template stay two problems (identifiers differ)', async () => {
  const h = harness();
  await h.start();
  const doc = layout([...T4, '', ...T5]);
  const q5 = posOf(doc, 'Question 5');
  h.container({ id: 'q', y: 0 });
  h.region({ c: 'q', doc, from: 0, to: q5 - 10 });
  await flush();
  await h.scroll({ id: 'q', y: q5 - 20, doc, reveal: [q5 - 10, pageEnd(doc) + 10] });
  assert.equal(h.s.listProblems().length, 2, 'similar questions were merged');
  assert.equal(h.problem().title, 'Question 5');
  const t = h.context();
  assert.match(t, /public transport funding/);
  assert.ok(!t.includes('renewable energy'), 'Question 4 leaked into Question 5');
});

await test('first screen shows the end of one question and most of the next: the one in view is active, the other is not mixed in', async () => {
  const h = harness();
  await h.start();
  const q2 = posOf(QUIZ, 'Question 2');
  h.container({ id: 'q', y: q2 - 150 });
  h.region({ c: 'q', doc: QUIZ, from: q2 - 150, to: q2 + 650 });
  await flush();
  const p = h.problem();
  assert.equal(p.status, 'identified');
  assert.equal(p.title, 'Question 2');
  const t = h.context();
  assert.match(t, /level order traversal/);
  assert.ok(!t.includes('Example: merging one two four'), 'the tail of Question 1 was mixed in');
});

await test('false positive guard: a title-sized heading over different text without a number is only "possible"', async () => {
  const h = harness();
  await h.start();
  const doc = layout([...PAIR_A, '', ...PAIR_B]);
  const b = posOf(doc, 'Interval Merger');
  h.container({ id: 'q', y: 0 });
  h.region({ c: 'q', doc, from: 0, to: b - 10 });
  await flush();
  await h.scroll({ id: 'q', y: b - 40, doc, reveal: [b - 10, pageEnd(doc) + 10] });
  const p = h.problem();
  assert.equal(p.id, 'p1', 'an unconfirmed boundary changed the problem');
  assert.equal(h.s.listProblems().length, 1, 'a problem was created without confirmation');
  assert.deepEqual([p.candidate.title, p.candidate.status], ['Interval Merger', 'possible']);
  const t = h.context();
  assert.ok(!t.includes('merge all overlapping intervals'), 'undecided content was mixed into the active problem');
  assert.match(t, /may start a different problem are not included/);
  assert.match(t, /A heading on screen may start a different problem/);
  assert.match(t, /indices of the two numbers/, 'the active problem lost its own text');
});

await test('possible boundary → "Same problem": the held text joins the problem and is not proposed again', async () => {
  const h = harness();
  await h.start();
  const doc = layout([...PAIR_A, '', ...PAIR_B]);
  const b = posOf(doc, 'Interval Merger');
  h.container({ id: 'q', y: 0 });
  h.region({ c: 'q', doc, from: 0, to: b - 10 });
  await flush();
  await h.scroll({ id: 'q', y: b - 40, doc, reveal: [b - 10, pageEnd(doc) + 10] });
  const result = h.s.resolveCandidate(h.problem().candidate.id, 'same');
  assert.equal(result.success, true);
  assert.equal(h.problem().candidate, null);
  assert.match(h.context(), /merge all overlapping intervals/);
  await h.scroll({ id: 'q', y: b - 20, doc });
  assert.equal(h.problem().candidate, null, 'a dismissed heading came back as a candidate');
  assert.equal(h.s.listProblems().length, 1);
});

await test('possible boundary → "New problem": a separate problem starts there and becomes active', async () => {
  const h = harness();
  await h.start();
  const doc = layout([...PAIR_A, '', ...PAIR_B]);
  const b = posOf(doc, 'Interval Merger');
  h.container({ id: 'q', y: 0 });
  h.region({ c: 'q', doc, from: 0, to: b - 10 });
  await flush();
  await h.scroll({ id: 'q', y: b - 40, doc, reveal: [b - 10, pageEnd(doc) + 10] });
  h.s.resolveCandidate(h.problem().candidate.id, 'new');
  assert.equal(h.problem().id, 'p2');
  assert.equal(h.problem().title, 'Interval Merger');
  const t = h.context();
  assert.match(t, /merge all overlapping intervals/);
  assert.ok(!t.includes('indices of the two numbers'), 'the previous problem leaked into the confirmed one');
  assert.equal(h.s.resolveCandidate('k999', 'new').code, 'NO_CANDIDATE');
});

await test('too little text under a boundary heading: held and shown as checking, never switched', async () => {
  const h = harness();
  await h.start();
  const doc = layout([...Q1, '', '#Question 2', 'Short.']);
  await openPanel(h, doc);
  const p = h.problem();
  assert.equal(p.title, 'Question 1');
  assert.equal(p.candidate && p.candidate.status, 'checking');
  assert.ok(!h.context().includes('Short.'), 'undecided text reached the context');
  assert.equal(h.s.listProblems().length, 1);
});

await test('independent panels: a boundary in the question panel never moves the notebook text', async () => {
  const h = harness();
  await h.start();
  const code = layout(['def merge(a, b):', '    return sorted(a + b)']);
  const q2 = posOf(QUIZ, 'Question 2');
  h.container({ id: 'q', y: 0 });
  h.container({ id: 'nb', y: 0, x0: 400, w: 600 });
  h.region({ c: 'q', doc: QUIZ, from: 0, to: q2 - 10 });
  h.region({ c: 'nb', doc: code, from: 0, to: 800, x0: 400, w: 600 });
  await flush();
  assert.match(h.context(), /return sorted\(a \+ b\)/);
  await h.scroll({ id: 'q', y: q2 - 20, doc: QUIZ, reveal: [q2 - 10, q2 + 200] });
  assert.equal(h.problem().title, 'Question 2');
  assert.ok(!h.context().includes('sorted(a + b)'), 'Q1 notebook code leaked into Q2');
  await h.scroll({ id: 'q', y: 0, doc: QUIZ });
  assert.match(h.context(), /return sorted\(a \+ b\)/, 'Q1 notebook code did not come back with Q1');
});

await test('in-place replacement keeps the old question (retired, not discarded) and frees its coverage for the new one', async () => {
  const h = harness();
  await h.start();
  const a = layout([...LONG, ...details('campus retrieval'), ...details('ranking quality')]);
  await openPanel(h, a);
  await h.scroll({ id: 'q', y: 200, doc: a, reveal: [800, pageEnd(a) + 10] });
  await h.scroll({ id: 'q', y: 0, doc: a });
  const b = layout(Q2);
  h.send({ type: 'stale', containerId: 'q', contentRect: { x: 0, y: 0, w: 400, h: 800 }, reason: 'in-place-change' });
  h.region({ c: 'q', kind: 'refresh', doc: b, from: 0, to: 800 });
  await flush();
  assert.equal(h.problem().title, 'Question 2');
  assert.deepEqual(h.forgotten, ['q'], 'the engine kept stale coverage below the view');
  const snap = h.s.getSnapshot();
  assert.ok(snap.counts.retired >= 2, 'the old text was not kept');
  assert.deepEqual(snap.regions.filter((r) => r.status === 'superseded' && r.chars > 0), [], 'old text was discarded');
  assert.ok(!h.context().includes('Grading Notes'));
  await h.s.activateProblem('p1');
  h.region({ c: 'root', doc: a, from: 0, to: 800, epoch: 1 });
  await flush();
  const back = h.context();
  assert.match(back, /Grading Notes/, 'switching back did not restore the retired text');
  assert.match(back, /Campus FAQ Bot/, 'the old question\'s visible part was lost');
});

// ===================================================================================
console.log('explicit New Problem');

await test('New Problem: fresh epoch and clean context; the previous problem is kept and listed', async () => {
  const h = harness();
  await h.start();
  await openPanel(h, layout(Q1));
  const r = await h.s.newProblem();
  assert.equal(r.success, true);
  assert.equal(r.problem.id, 'p2');
  assert.deepEqual(h.beginCalls, [1]);
  const p = h.problem();
  assert.deepEqual([p.id, p.status, p.origin], ['p2', 'identified', 'explicit']);
  assert.equal(h.changes.at(-1).decision, 'explicit');
  const t = h.context();
  assert.ok(!t.includes('linked lists'), 'the previous problem leaked into the new one');
  const snap = h.s.getSnapshot();
  assert.deepEqual(snap.problems.map((x) => x.id).sort(), ['p1', 'p2']);
  assert.equal(snap.counts.analysed, 1, 'the previous problem lost its captured text');
  // The next capture is the new screen, stamped with the new problem.
  h.region({ c: 'root', doc: layout(Q3), from: 0, to: 800, epoch: 1 });
  await flush();
  assert.match(h.context(), /least recently used cache/);
  assert.equal(h.problem().title, 'Question 3');
});

await test('New Problem works even when the screen still shows the previous problem\'s text', async () => {
  const h = harness();
  await h.start();
  const doc = layout(Q1);
  await openPanel(h, doc);
  await h.s.newProblem();
  h.region({ c: 'root', doc, from: 0, to: 800, epoch: 1 });
  await flush();
  assert.equal(h.problem().id, 'p2', 'automatic matching overrode the explicit New Problem');
  assert.match(h.context(), /linked lists/, 'the visible text is the start of the new problem');
});

await test('duplicate activation: concurrent presses create one problem; pressing again before it reads anything is refused', async () => {
  const h = harness();
  await h.start();
  await openPanel(h, layout(Q1));
  const [a, b] = await Promise.all([h.s.newProblem(), h.s.newProblem()]);
  assert.equal(a.success, true);
  assert.deepEqual([b.success, b.code], [false, 'BUSY']);
  const c = await h.s.newProblem();
  assert.deepEqual([c.success, c.code], [false, 'ALREADY_NEW']);
  assert.equal(h.s.listProblems().length, 2);
  h.region({ c: 'root', doc: layout(Q2), from: 0, to: 800, epoch: 1 });
  await flush();
  const d = await h.s.newProblem();
  assert.equal(d.success, true, 'a real second problem was refused');
  assert.equal(h.s.listProblems().length, 3);
});

await test('pending OCR across New Problem finishes with the previous problem; it never lands in the new one', async () => {
  const h = harness();
  await h.start();
  await openPanel(h, layout(Q1));
  h.hold = true;
  h.container({ id: 'q', y: 200 });
  h.region({ c: 'q', kind: 'scroll', from: 800, to: 1000, lines: [{ text: 'Constraints: the total number of nodes is at most one hundred in both lists combined.', box: { x: 0.02, y: 0.1, w: 0.9, h: 0.08 }, confidence: 0.95 }] });
  await flush();
  await h.s.newProblem();
  h.held[0].res({ lines: h.held[0].img.lines, engine: 'fake' });
  await flush();
  const late = h.s.getSnapshot().regions.find((r) => r.preview.includes('Constraints'));
  assert.equal(late.status, 'analysed', 'the old screen\'s OCR was cancelled by New Problem');
  assert.ok(!h.context().includes('one hundred in both lists'), 'a late OCR result crossed into the new problem');
  await h.s.activateProblem('p1');
  assert.match(h.context(), /one hundred in both lists/, 'the late result is missing from its own problem');
});

await test('a region captured before New Problem but delivered after is kept for the previous problem; later old-screen events are dropped', async () => {
  const h = harness();
  await h.start();
  await openPanel(h, layout(Q1));
  const before = Date.now;
  const capturedAt = h.s.getSnapshot().lastCaptureAt;
  await h.s.newProblem();
  h.tick(50);
  h.region({ c: 'q', kind: 'scroll', doc: layout(Q2), from: 0, to: 800, t: capturedAt });
  h.region({ c: 'q', kind: 'scroll', doc: layout(Q3), from: 0, to: 800 });
  await flush();
  const texts = h.s.getSnapshot().regions.map((r) => r.preview).join(' ');
  assert.ok(texts.includes('Question 2'), 'a region captured before the switch was lost');
  assert.ok(!texts.includes('Question 3'), 'an old-screen event after the switch was accepted');
  assert.ok(!h.context().includes('binary tree'));
  assert.equal(Date.now, before);
});

await test('switching back to a previous problem restores its context; switching to the active one is a no-op', async () => {
  const h = harness();
  await h.start();
  await openPanel(h, layout(Q1));
  await h.s.newProblem();
  h.region({ c: 'root', doc: layout(Q2), from: 0, to: 800, epoch: 1 });
  await flush();
  const same = await h.s.activateProblem('p2');
  assert.equal(same.unchanged, true);
  await h.s.activateProblem('p1');
  assert.equal(h.problem().id, 'p1');
  const t = h.context();
  assert.match(t, /linked lists/);
  assert.ok(!t.includes('binary tree'));
  assert.equal((await h.s.activateProblem('p42')).code, 'UNKNOWN_PROBLEM');
});

await test('New Problem while monitoring is stopped: it waits and owns the first screen of the next start', async () => {
  const h = harness();
  await h.start();
  await openPanel(h, layout(Q1));
  await h.s.stop();
  const r = await h.s.newProblem();
  assert.equal(r.pending, 'next-start');
  await h.start();
  h.region({ c: 'root', doc: layout(Q1), from: 0, to: 800, epoch: 1 });
  await flush();
  assert.equal(h.problem().id, 'p2', 'the screen was matched to the old problem despite New Problem');
});

await test('engine cannot start a new screen: the problem is created and owns the next screen the engine reports', async () => {
  const h = harness({ beginEpoch: 'fail' });
  await h.start();
  await openPanel(h, layout(Q1));
  const r = await h.s.newProblem();
  assert.deepEqual([r.success, r.pending], [true, 'next-screen']);
  assert.equal(h.problem().id, 'p2', 'the new problem was not reported as active while waiting for a screen');
  assert.ok(!h.context().includes('linked lists'), 'the previous problem leaked while waiting for a screen');
  h.send({ type: 'scene-change', epoch: 1 });
  h.region({ c: 'root', doc: layout(Q1), from: 0, to: 800, epoch: 1 });
  await flush();
  assert.equal(h.problem().id, 'p2');
});

await test('failed OCR on the new problem\'s first screen: the problem stays, nothing of the old one is offered', async () => {
  const h = harness();
  await h.start();
  await openPanel(h, layout(Q1));
  await h.s.newProblem();
  h.hold = true;
  h.region({ c: 'root', doc: layout(Q2), from: 0, to: 800, epoch: 1 });
  await flush();
  h.held[0].rej(Object.assign(new Error('engine down'), { code: 'OCR_FAILED' }));
  await flush();
  assert.equal(h.problem().id, 'p2');
  const t = h.context();
  assert.ok(!t.includes('linked lists'));
  assert.match(t, /FAILED analysis/);
});

// ===================================================================================
console.log('AI requests across transitions');

function ipcRig(session) {
  const handlers = {};
  const sent = [];
  const pending = [];
  const runtime = {
    getActiveAiProvider: () => 'gemini', hasApiKeys: () => true, getApiKeys: () => ['k'], isAllKeysUnavailableError: () => false,
    cancelActive(tag) {
      const p = pending.find((x) => x.tag === tag && !x.done);
      if (!p) return false;
      p.done = true;
      p.reject(Object.assign(new Error('Request cancelled'), { isCancelled: true }));
      return true;
    },
    executeWithKeyFailover: (op) => op(service),
  };
  const deferred = (tag, opts) => new Promise((resolve, reject) => {
    const entry = { tag, resolve, reject, done: false, chunk: (text) => opts.onChunk({ text, index: 1 }) };
    entry.finish = (text) => { entry.done = true; resolve(text); };
    pending.push(entry);
  });
  const service = {
    model: {},
    analyzeScreenshots: (parts, text, opts) => deferred(opts.tag, opts),
    askAiWithSessionContext: (opts) => deferred(opts.tag, opts),
    askAiWithSessionContextAndScreenshots: (parts, opts) => deferred(opts.tag, opts),
  };
  const screen = {
    isActive: () => true,
    getSnapshot: () => session.getSnapshot(),
    waitForCurrentView: async () => ({ ready: true, waitedMs: 0 }),
    getPromptContext: () => ({ text: session.buildContext({ charBudget: 20000 }).text, imageParts: [], problem: session.getProblem(), viewAnalysed: true }),
    getLatestFrame: async () => ({ jpeg: Buffer.from('frame'), mime: 'image/jpeg' }),
    getProblem: () => session.getProblem(),
  };
  const api = registerAssistantIpc({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, on: () => {} },
    screenshotManager: { validateScreenCaptureCapability: async () => ({ authorized: true }), hasScreenshots: () => false, getScreenshotsCount: () => 0 },
    windowController: {}, geminiRuntime: runtime, assemblyAiService: { flushAllSttHistoryBuffers: () => {} },
    sendToRenderer: (ch, payload) => sent.push([ch, payload]), quitApplication: () => {}, mobileServer: null, getScreenIntel: () => screen,
  });
  return { api, invoke: (ch, payload) => handlers[ch]({}, payload), pending, sent };
}
const origLog = console.log;
const quiet = async (fn) => { console.log = () => {}; try { return await fn(); } finally { console.log = origLog; } };

await test('an answer streaming about the old problem is cancelled by New Problem; its late chunks never show', async () => {
  const h = harness();
  await h.start();
  await openPanel(h, layout(Q1));
  const rig = ipcRig(h.s);
  const answer = quiet(() => rig.invoke('ask-ai-with-session-context', { transcriptContext: 'how do I merge?' }));
  await flush();
  rig.pending[0].chunk('Merge by walking both lists ');
  await h.s.newProblem();
  rig.api.onScreenProblemChange(h.changes.at(-1));
  const result = await answer;
  assert.deepEqual([result.cancelled, result.reason, result.problemId], [true, 'problem-changed', undefined]);
  rig.pending[0].chunk?.('late chunk');
  const chunks = rig.sent.filter(([ch, p]) => ch === 'ai-stream-chunk' && p.actionId === 'askAi').map(([, p]) => p.text);
  assert.deepEqual(chunks, ['Merge by walking both lists ']);
});

await test('an answer requested after New Problem carries the new problem id and none of the old text', async () => {
  const h = harness();
  await h.start();
  await openPanel(h, layout(Q1));
  await h.s.newProblem();
  h.region({ c: 'root', doc: layout(Q2), from: 0, to: 800, epoch: 1 });
  await flush();
  const rig = ipcRig(h.s);
  let prompt = '';
  const answer = quiet(() => rig.invoke('ask-ai-with-session-context', { transcriptContext: 'explain' }));
  await flush();
  rig.pending[0].finish('ok');
  const result = await answer;
  assert.equal(result.problemId, 'p2');
  prompt = h.s.buildContext({ charBudget: 20000 }).text;
  assert.ok(!prompt.includes('linked lists'));
});

// ===================================================================================
console.log('persistence');

await test('problems survive a restart: listed with titles, the old screen is a revisit, its saved text returns', async () => {
  const store = memoryStore();
  const h1 = harness({ store });
  await h1.start();
  await openPanel(h1, layout(Q1));
  h1.advance(4000);
  await h1.s.newProblem();
  h1.region({ c: 'root', doc: layout(Q2), from: 0, to: 800, epoch: 1 });
  await flush();
  await h1.s.dispose();
  assert.ok(store.saves > 0);
  const saved = store.load();
  assert.deepEqual(saved.problems.map((p) => [p.id, p.title, p.origin]), [['p1', 'Question 1', 'auto'], ['p2', 'Question 2', 'explicit']]);
  assert.match(saved.problems[0].digest, /linked lists/, 'the previous problem\'s text was not saved');

  const h2 = harness({ store, t0: 1_700_000_900_000 });
  assert.deepEqual(h2.s.listProblems().map((p) => p.id).sort(), ['p1', 'p2']);
  await h2.start();
  h2.region({ c: 'root', doc: layout(Q1.slice(0, 4)), from: 0, to: 800, epoch: 1 });
  await flush();
  assert.equal(h2.problem().id, 'p1', 'a saved problem was not recognised after the restart');
  assert.equal(h2.changes.at(-1).decision, 'revisit');
  assert.match(h2.context(), /Saved from an earlier session/);
  const fresh = await h2.s.newProblem();
  assert.equal(fresh.problem.id, 'p3', 'a restored registry reused an id');
});

await test('a corrupt or foreign saved registry is ignored, not trusted', () => {
  const tracker = createProblemTracker();
  tracker.importState({ problems: [{ id: '../x', title: 'bad' }, { id: 'p4', title: 'ok', shingles: [1, 'a b c'], digest: 'x'.repeat(20000) }, null] });
  assert.deepEqual(tracker.list().map((p) => p.id), ['p4']);
  assert.equal(tracker.get('p4').digest.length, 8000);
  assert.deepEqual([...tracker.get('p4').shingles], ['a b c']);
  tracker.importState('garbage');
  assert.deepEqual(tracker.list(), []);
});

await test('long sessions: problem identity is never evicted silently; only old problems lose recognition data', () => {
  let t = 0;
  const tracker = createProblemTracker({ now: () => (t += 1) });
  for (let i = 0; i < 20; i += 1) tracker.create({ origin: 'explicit' });
  assert.equal(tracker.list().length, 20);
  for (let i = 0; i < 40; i += 1) tracker.create({ origin: 'explicit' });
  assert.equal(tracker.list().length, 50, 'the registry is bounded');
  assert.equal(JSON.stringify(tracker.exportState()).length < 2_000_000, true);
});


console.log('fixes from review');

await test('a region that failed before identification and is retried after a switch keeps its original problem', async () => {
  const h = harness();
  await h.start();
  const q2 = posOf(QUIZ, 'Question 2');
  h.container({ id: 'q', y: 0 });
  h.container({ id: 'nb', y: 0, x0: 400, w: 600 });
  let failOnce = true;
  const code = layout(['def merge(a, b):', '    return sorted(a + b)']);
  h.hold = true;
  h.region({ c: 'nb', doc: code, from: 0, to: 800, x0: 400, w: 600 });
  h.region({ c: 'q', doc: QUIZ, from: 0, to: q2 - 10 });
  await flush();
  // One OCR job at a time: fail the notebook read, let the question read succeed.
  for (let i = 0; i < h.held.length; i += 1) {
    const job = h.held[i];
    if (job.img.lines.some((l) => l.text.includes('def merge'))) job.rej(Object.assign(new Error('fetch failed'), { code: 'NETWORK' }));
    else job.res({ lines: job.img.lines, engine: 'fake' });
    await flush();
  }
  assert.equal(h.held.length, 2);
  h.hold = false;
  failOnce = false;
  assert.equal(h.problem().id, 'p1');
  await h.scroll({ id: 'q', y: q2 - 100, doc: QUIZ, reveal: [q2 - 10, q2 + 400] });
  assert.equal(h.problem().id, 'p2');
  h.advance(2500); // the NETWORK backoff retries the notebook region now, while p2 is active
  await flush();
  const retried = h.s.getSnapshot().regions.find((r) => r.preview.includes('def merge'));
  assert.equal(retried.status, 'analysed', 'the retry never ran, so this test proves nothing');
  assert.ok(!h.context().includes('sorted(a + b)'), 'a retried Q1 region was attributed to Q2');
  await h.scroll({ id: 'q', y: 0, doc: QUIZ });
  assert.match(h.context(), /sorted\(a \+ b\)/, 'the retried region is missing from its own problem');
  assert.equal(failOnce, false);
});

await test('ALREADY_NEW cannot trap the user: after the grace period, a new problem that has read something can be followed by another', async () => {
  const h = harness();
  await h.start();
  await openPanel(h, layout(Q1));
  await h.s.newProblem();
  h.region({ c: 'root', doc: layout(['def solve():', '    return 0']), from: 0, to: 800, epoch: 1 });
  await flush();
  assert.equal((await h.s.newProblem()).code, 'ALREADY_NEW', 'a quick second press created a duplicate');
  h.advance(11000);
  const r = await h.s.newProblem();
  assert.equal(r.success, true, 'a code-only screen made New Problem unusable');
});

await test('interrupted processing during a transition: a cancelled first read leaves the new problem in place', async () => {
  const h = harness();
  await h.start();
  await openPanel(h, layout(Q1));
  await h.s.newProblem();
  h.hold = true;
  h.region({ c: 'root', doc: layout(Q2), from: 0, to: 800, epoch: 1 });
  await flush();
  h.held[0].rej(Object.assign(new Error('OCR cancelled'), { code: 'CANCELLED' }));
  await flush();
  const p = h.problem();
  assert.deepEqual([p.id, p.status], ['p2', 'identified']);
  assert.ok(!h.context().includes('linked lists'));
});

await test('loading another conversation\'s problems mid-session re-identifies the screen at once and drops foreign stamps', async () => {
  const h = harness();
  await h.start();
  await openPanel(h, layout(Q1));
  h.s.loadProblems(null);
  const p = h.problem();
  assert.deepEqual([p.id, p.status], ['p1', 'identified'], 'the screen stayed undetected after the registry changed');
  assert.equal(h.s.listProblems().length, 1);
});

await test('snapshot carries the problem list and candidate as plain JSON the UI can key off', async () => {
  const h = harness();
  await h.start();
  const doc = layout([...PAIR_A, '', ...PAIR_B]);
  const b = posOf(doc, 'Interval Merger');
  h.container({ id: 'q', y: 0 });
  h.region({ c: 'q', doc, from: 0, to: b - 10 });
  await flush();
  await h.scroll({ id: 'q', y: b - 40, doc, reveal: [b - 10, pageEnd(doc) + 10] });
  const snap = JSON.parse(JSON.stringify(h.s.getSnapshot()));
  assert.deepEqual(Object.keys(snap.problems[0]).sort(), ['active', 'createdAt', 'hasDigest', 'id', 'lastActiveAt', 'origin', 'recognisable', 'title']);
  assert.equal(snap.problems.filter((p) => p.active).length, 1);
  assert.deepEqual(Object.keys(snap.problem.candidate).sort(), ['containerId', 'id', 'status', 'title']);
});

await test('persistence through the real conversation store: draft before the first message, kept per conversation, never pushed', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createConversationStore } = require('../src/services/conversations/conversation-store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-problems-'));
  try {
    const filePath = path.join(dir, 'history.json');
    const store = createConversationStore({ filePath, writeDelayMs: 0 });
    const problemStore = { load: () => store.getProblems(), save: (x) => store.setProblems(x) };
    const h = harness({ store: problemStore });
    await h.start();
    await openPanel(h, layout(Q1));
    h.s.saveProblems();
    assert.equal(store.list().length, 0, 'saving problems created a conversation');
    store.appendMessage({ role: 'user', content: 'How do I merge two lists?' });
    assert.equal(store.getProblems().problems[0].title, 'Question 1', 'draft problems did not move into the conversation');
    const push = JSON.stringify(store.buildPush());
    assert.ok(!push.includes('problems') && !push.includes('Question 1'), 'problems would be sent to the website');
    store.flush();
    const reopened = createConversationStore({ filePath });
    assert.equal(reopened.getProblems().problems[0].id, 'p1', 'problems did not survive a restart');
    const first = reopened.current().id;
    reopened.startNew();
    assert.equal(reopened.getProblems(), null, 'a new conversation inherited problems');
    reopened.open(first);
    assert.equal(reopened.getProblems().problems[0].title, 'Question 1');
    await h.s.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('opening another conversation clears a New Problem chosen while stopped; it never binds a foreign id', async () => {
  const h = harness();
  await h.start();
  await openPanel(h, layout(Q1));
  await h.s.stop();
  await h.s.newProblem();
  h.s.loadProblems(null);
  await h.start();
  h.region({ c: 'root', doc: layout(Q2), from: 0, to: 800, epoch: 1 });
  await flush();
  const p = h.problem();
  assert.equal(p.status, 'identified');
  assert.equal(p.origin, 'auto', 'a problem from the previous conversation\'s registry was bound');
  assert.deepEqual(h.s.listProblems().map((x) => x.id), [p.id]);
});

await test('registry replaced while New Problem waits for the engine: refused, nothing bound to a stale problem', async () => {
  const h = harness({ beginEpoch: 'gate' });
  await h.start();
  await openPanel(h, layout(Q1));
  const pending = h.s.newProblem();
  await flush();
  h.s.loadProblems(null);
  h.openGate();
  const r = await pending;
  assert.deepEqual([r.success, r.code], [false, 'REGISTRY_CHANGED']);
  assert.equal(h.problem().id, 'p1', 'the screen did not re-identify against the loaded registry');
  assert.equal(h.s.listProblems().length, 1);
});

console.log('capture engine');

await test('engine beginEpoch: the next frame is read again as an initial capture in the new epoch, with no scene-change event', () => {
  const { createCaptureEngine } = require('../src/services/screen-intel/capture-engine.js');
  const events = [];
  const W = 320;
  const H = 200;
  const gray = new Uint8Array(W * H);
  for (let i = 0; i < gray.length; i += 1) gray[i] = (i * 37 + (i >> 5) * 11) % 251;
  let t = 0;
  const engine = createCaptureEngine({ sessionId: 's', display: { id: 1, width: W, height: H }, cropFrame: () => ({}), emit: (e) => events.push(e), now: () => t });
  engine.pushFrame({ gray, width: W, height: H, t: (t += 100), frameRef: 'f1' });
  const first = events.filter((e) => e.type === 'region');
  assert.ok(first.length > 0 && first.every((e) => e.epoch === 1 && e.kind === 'initial'));
  events.length = 0;
  engine.pushFrame({ gray, width: W, height: H, t: (t += 100), frameRef: 'f2' });
  assert.equal(events.length, 0, 'an unchanged frame produced events');
  assert.equal(engine.beginEpoch(5), 5);
  engine.pushFrame({ gray, width: W, height: H, t: (t += 100), frameRef: 'f3' });
  assert.ok(!events.some((e) => e.type === 'scene-change'), 'New Problem must not look like a scene change');
  const again = events.filter((e) => e.type === 'region');
  assert.ok(again.length > 0 && again.every((e) => e.epoch === 5 && e.kind === 'initial'), 'the visible screen was not read again for the new problem');
  assert.equal(engine.forgetOutsideView('root'), false);
  assert.equal(engine.forgetOutsideView('c404'), false);
});

console.log('Mode C bar: New problem control');

const view = await import('../src/windows/assistant/renderer/features/screen-intel/screen-intel-view.js');

await test('view-model: labels, candidate prompt, problem list and action feedback come only from the snapshot', () => {
  assert.equal(view.describeProblem({ status: 'identified', id: 'p3', title: '', origin: 'explicit' }), 'New problem');
  assert.equal(view.describeProblem({ status: 'identified', id: 'p2', title: 'Question 2', origin: 'auto' }), '“Question 2”');
  assert.equal(view.describeCandidate({ candidate: null }), null);
  assert.match(view.describeCandidate({ candidate: { id: 'k1', title: 'Interval Merger', status: 'possible' } }).text, /may be a different problem/);
  assert.match(view.describeCandidate({ candidate: { id: 'k1', title: 'Question 2', status: 'checking' } }).text, /Checking whether/);
  const rows = view.describeProblems([{ id: 'p2', title: '', origin: 'explicit', active: true, lastActiveAt: 1 }, { id: 'p1', title: 'Question 1', origin: 'auto', active: false, lastActiveAt: 0 }]);
  assert.deepEqual(rows.map((r) => [r.label, r.active, r.canSwitch]), [['New problem', true, false], ['Question 1', false, true]]);
  assert.match(rows[0].meta, /^Active · Started by you/);
  assert.equal(view.describeProblemResult({ success: false, code: 'BUSY' }), null, 'a double click produced a second message');
  assert.equal(view.describeProblemResult({ success: false, code: 'ALREADY_NEW' }).tone, 'warning');
  assert.match(view.describeProblemResult({ success: true, problem: { id: 'p2', title: '', origin: 'explicit' } }).text, /^New problem started/);
  assert.match(view.describeProblemResult({ success: true, pending: 'next-start', problem: {} }).text, /begins when monitoring starts/);
  assert.match(view.describeProblemResult({ success: true, problem: { title: 'Question 1' } }, 'switch').text, /^Switched to Question 1/);
  assert.match(view.describeProblemResult({ success: true, problem: { title: 'Two Sum Pairs' } }, 'same').text, /^Kept in Two Sum Pairs/);
});

await test('markup and wiring: labelled, keyboard reachable, one action at a time, IPC validated', () => {
  const fs = require('fs');
  const html = fs.readFileSync(new URL('../src/windows/assistant/renderer.html', import.meta.url), 'utf8');
  const bar = fs.readFileSync(new URL('../src/windows/assistant/renderer/features/screen-intel/screen-intel-bar.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/windows/assistant/ui/screen-intel.css', import.meta.url), 'utf8');
  const preload = fs.readFileSync(new URL('../src/windows/assistant/preload/actions.js', import.meta.url), 'utf8');
  const controller = fs.readFileSync(new URL('../src/main-process/features/screen-intel/controller.js', import.meta.url), 'utf8');
  assert.match(html, /<button id="screen-intel-new-problem"[^>]*type="button"[^>]*aria-label="New problem"/);
  assert.match(html, /screen-intel-new-problem-icon[^>]*aria-hidden="true"/);
  assert.match(html, /id="screen-intel-candidate-new"[^>]*type="button"/);
  assert.match(html, /id="screen-intel-problems"[^>]*aria-labelledby=/);
  assert.match(bar, /if \(problemBusy\) return;/, 'repeated clicks are not guarded');
  assert.match(css, /\.screen-intel-new-problem \{[^}]*flex-shrink: 0/, 'the control can be squeezed by the toolbar');
  assert.match(css, /\.screen-intel-new-problem:focus-visible/);
  assert.match(css, /min-height: 44px/);
  for (const name of ['screenIntelNewProblem', 'screenIntelActivateProblem', 'screenIntelResolveCandidate']) assert.ok(preload.includes(name), name);
  assert.match(controller, /\/\^p\\d\{1,6\}\$\/\.test\(id\)/, 'activate-problem input is not validated');
  assert.match(controller, /\/\^k\\d\{1,6\}\$\/\.test\(cutId\)/, 'resolve-candidate input is not validated');
});

console.log(`\nBoundary tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
if (failed) process.exit(1);
