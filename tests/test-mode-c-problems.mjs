#!/usr/bin/env node
/**
 * Problem switching end to end, without Electron:
 *  - screen session: which problem is on screen, what context an answer gets
 *  - assistant IPC: obsolete answers are cancelled, never shown
 *  - renderer message store: answers about other problems leave the context
 *
 * Run: node tests/test-mode-c-problems.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createMessageStore } from '../src/windows/assistant/renderer/features/ai-context/message-store.js';
import { buildFilteredAiContextBundle } from '../src/windows/assistant/renderer/features/ai-context/context-bundle.js';

const require = createRequire(import.meta.url);
const { createScreenSession } = require('../src/services/screen-intel/screen-session.js');
const { createProblemTracker, containment, shinglesOf } = require('../src/services/screen-intel/problem-tracker.js');
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
    console.log(`  ✗ ${name}\n      ${error.stack.split('\n').slice(0, 4).join('\n      ')}`);
  }
}
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };

// ---- problems used across scenarios ---------------------------------------------
const A = [
  'Campus FAQ Bot',
  'Build a retrieval pipeline that returns grounded answers for campus questions.',
  'Write a function retrieve passages that ranks passages by cosine similarity to the query embedding.',
  'Return the top k passages sorted by score in descending order.',
];
const A_MORE = [
  'Test Cases',
  '1. test retrieve returns results for a campus question',
  '2. test retrieve sorted by cosine similarity score descending',
  '3. test answer is grounded in the retrieved passages only',
];
const B = [
  'Matrix Spiral Order',
  'Given an m by n integer matrix return all elements of the matrix in spiral order.',
  'Start from the top left corner and move clockwise around the matrix layer by layer.',
  'Constraints: m and n are between one and ten and values fit in a signed integer.',
];
const C = [
  'Valid Parentheses Checker',
  'Given a string containing only brackets determine whether the input string is valid.',
  'Open brackets must be closed by the same type of brackets in the correct order.',
  'Every close bracket has a corresponding open bracket of the same type.',
];
const CODE_V1 = ['def retrieve_passages(query, passages, top_k=3):', '    scores = []', '    return scores[:top_k]'];
const CODE_V2 = ['def retrieve_passages(query, passages, top_k=3):', '    scores = sorted(passages)', '    return scores[:top_k]'];

// ---- session harness ------------------------------------------------------------
function harness() {
  let t = 1_700_000_000_000;
  const held = [];
  const h = { hold: false, held, problems: [] };
  const ocr = {
    recognize(img) {
      if (h.hold) return new Promise((res, rej) => held.push({ res, rej, img }));
      if (img.fail) return Promise.reject(Object.assign(new Error(img.fail), { code: img.fail }));
      return Promise.resolve({ lines: img.lines, engine: 'fake', durationMs: 5 });
    },
  };
  const engine = {
    async start() {}, async stop() {}, async pause() {}, async resume() {},
    async requestRecapture() { return true; }, async getLatestFrame() { return null; },
  };
  const timers = { setTimeout: () => 0, clearTimeout: () => {} };
  const s = createScreenSession({ ocr, engineControl: engine, now: () => (t += 1), timers, onProblemChange: (p) => h.problems.push(p) });
  let cap = 0;
  Object.assign(h, {
    s,
    start: async () => { h.sid = (await s.start({ displayId: 'd1' })).sessionId; },
    send: (ev) => s.handleEngineEvent({ sessionId: h.sid, ...ev }),
    region: (o) => h.send({
      type: 'region', captureId: `k${(cap += 1)}`, containerId: o.c || 'root', segmentId: 0, epoch: o.epoch ?? 0, kind: o.kind || 'initial',
      screenRect: o.screen || o.rect, contentRect: o.rect, overlap: { top: 0, bottom: 0, left: 0, right: 0 }, displayId: 'd1',
      image: { jpeg: Buffer.alloc(64), mime: 'image/jpeg', lines: o.lines, fail: o.fail },
    }),
    container: (o) => h.send({ type: 'container', container: {
      id: o.id, screenRect: o.screen, axis: 'y', scroll: { x: 0, y: o.viewport.y }, segmentId: 0, epoch: o.epoch ?? 0, viewport: o.viewport,
      extent: { x0: o.viewport.x, y0: o.viewport.y, x1: o.viewport.x + o.viewport.w, y1: o.viewport.y + o.viewport.h },
    } }),
    problem: () => s.getSnapshot().problem,
    context: () => s.buildContext({ charBudget: 100000 }).text,
  });
  return h;
}
// One OCR line per text, stacked from y0 down.
const lines = (texts, y0 = 0.05, step = 0.08) => texts.map((text, i) => ({ text, box: { x: 0.05, y: y0 + i * step, w: Math.min(0.9, text.length * 0.008), h: 0.03 }, confidence: 0.95 }));
const LEFT = { x: 0, y: 0, w: 400, h: 800 };
const RIGHT = { x: 400, y: 0, w: 600, h: 800 };

async function twoPanelProblem(h, question, code, epoch = 0) {
  h.container({ id: 'q', screen: LEFT, viewport: { x: 0, y: 0, w: 400, h: 800 }, epoch });
  h.container({ id: 'nb', screen: RIGHT, viewport: { x: 0, y: 0, w: 600, h: 800 }, epoch });
  h.region({ c: 'q', rect: { x: 0, y: 0, w: 400, h: 800 }, screen: LEFT, lines: lines(question), epoch });
  h.region({ c: 'nb', rect: { x: 0, y: 0, w: 600, h: 800 }, screen: RIGHT, lines: lines(code), epoch });
  await flush();
}

console.log('problem tracker');

await test('containment: a partial view of a problem matches it; another problem does not', () => {
  const full = shinglesOf([...A, ...A_MORE].join(' '));
  assert.ok(containment(shinglesOf(A.join(' ')), full) >= 0.9);
  assert.ok(containment(shinglesOf(B.join(' ')), full) < 0.1);
});

await test('too little instruction text is undetermined, never a guess', () => {
  const tracker = createProblemTracker();
  const r = tracker.observe({ records: [{ contentRect: { x: 0, y: 0, w: 100, h: 100 }, lines: lines(['Run']) }], epoch: 0 });
  assert.equal(r.decision, 'undetermined');
  assert.equal(tracker.activeId(), null);
});

const BOILER = [
  'Example 1 Input: nums = [2, 7, 11, 15] and target = 9 Output: [0, 1]',
  'Explanation: because nums[0] + nums[1] == 9 we return [0, 1] as the answer.',
  'Constraints: 2 <= nums.length <= 10^4 and -10^9 <= nums[i] <= 10^9',
  'Follow-up: can you come up with an algorithm that is less than O(n^2) time complexity?',
];
const rec = (texts, id = 'r') => ({ id, containerId: 'q', contentRect: { x: 0, y: 0, w: 400, h: 2000 }, overlap: {}, lines: lines(texts, 0.02, 0.04) });

await test('shared boilerplate (examples, constraints) under different headings stays two problems; a later partial view of B is B', () => {
  const tracker = createProblemTracker();
  tracker.observe({ records: [rec(['Two Sum Pairs', 'Given an array of integers return indices of the two numbers that add up to a target value.', ...BOILER])], epoch: 0 });
  const b = tracker.observe({ records: [rec(['Three Sum Closest', 'Given an integer array find three integers whose sum is closest to the target and return that sum.', ...BOILER])], epoch: 1 });
  assert.equal(b.decision, 'new', 'B was merged into A because of shared template text');
  tracker.observe({ records: [rec(['Two Sum Pairs', 'Given an array of integers return indices of the two numbers that add up to a target value.', ...BOILER])], epoch: 2 });
  const partialB = tracker.observe({ records: [rec(['find three integers whose sum is closest to the target and return that sum.', ...BOILER])], epoch: 3 });
  assert.equal(partialB.problem.id, 'p2', `partial view of B matched ${partialB.problem.id}`);
});

await test('a scrolled view showing only the "Test Cases" section of A is still A', () => {
  const tracker = createProblemTracker();
  tracker.observe({ records: [rec(['Campus FAQ Bot', ...A.slice(1), ...A_MORE])], epoch: 0 });
  const scrolled = tracker.observe({ records: [rec(['Test Cases', ...A_MORE.slice(1), 'Return the top k passages sorted by score in descending order.'])], epoch: 1 });
  assert.equal(scrolled.decision, 'same');
  assert.equal(scrolled.problem.id, 'p1');
});

console.log('screen session: problem switching scenarios');

await test('1-2. solve problem A, scroll its instructions: one problem, no switch event', async () => {
  const h = harness();
  await h.start();
  await twoPanelProblem(h, A, CODE_V1);
  assert.equal(h.problem().status, 'identified');
  assert.equal(h.problem().id, 'p1');
  assert.equal(h.problem().title, 'Campus FAQ Bot');
  h.container({ id: 'q', screen: LEFT, viewport: { x: 0, y: 600, w: 400, h: 800 } });
  h.region({ c: 'q', kind: 'scroll', rect: { x: 0, y: 800, w: 400, h: 600 }, screen: { x: 0, y: 200, w: 400, h: 600 }, lines: lines(A_MORE) });
  await flush();
  assert.equal(h.problem().id, 'p1');
  assert.equal(h.problems.length, 1, 'only the first identification fires');
  assert.match(h.context(), /test retrieve sorted by cosine/);
});

await test('3-4. switch to problem B: context updates automatically and holds nothing of A', async () => {
  const h = harness();
  await h.start();
  await twoPanelProblem(h, A, CODE_V1);
  h.send({ type: 'scene-change', epoch: 1 });
  await twoPanelProblem(h, B, ['def spiral_order(matrix):', '    result = []', '    return result'], 1);
  assert.equal(h.problem().id, 'p2');
  assert.deepEqual(h.problems.map((p) => [p.previousId, p.id, p.decision]), [[null, 'p1', 'same'], ['p1', 'p2', 'new']]);
  const t = h.context();
  assert.match(t, /spiral order/);
  for (const leaked of ['Campus FAQ Bot', 'retrieve_passages', 'cosine similarity']) assert.ok(!t.includes(leaked), `A leaked: ${leaked}`);
  assert.match(t, /\[The screen shows problem p2\. Answer only this problem\.\]/);
});

await test('5. question asked right after a switch: status is "detecting" and the old problem is not offered', async () => {
  const h = harness();
  await h.start();
  await twoPanelProblem(h, A, CODE_V1);
  h.hold = true;
  h.send({ type: 'scene-change', epoch: 1 });
  h.region({ rect: { x: 0, y: 0, w: 1000, h: 800 }, lines: lines(B), epoch: 1 });
  await flush();
  assert.equal(h.problem().status, 'detecting');
  assert.equal(h.problem().id, null);
  const t = h.context();
  assert.ok(!t.includes('Campus FAQ Bot'), 'old problem offered while the new screen is being read');
  assert.match(t, /still being read/);
  h.held[0].res({ lines: h.held[0].img.lines, engine: 'fake' });
  await flush();
  assert.equal(h.problem().id, 'p2');
});

await test('6. scroll back / return to A: recognised as A again, A\'s earlier screens return, B\'s stay out', async () => {
  const h = harness();
  await h.start();
  await twoPanelProblem(h, A, CODE_V1);
  h.send({ type: 'scene-change', epoch: 1 });
  await twoPanelProblem(h, B, ['def spiral_order(matrix):'], 1);
  h.send({ type: 'scene-change', epoch: 2 });
  await twoPanelProblem(h, A.slice(0, 3), CODE_V1, 2);
  assert.equal(h.problem().id, 'p1');
  assert.equal(h.problems.at(-1).decision, 'revisit');
  const t = h.context();
  assert.match(t, /Previously seen \(earlier screens of this same problem/);
  assert.match(t, /Return the top k passages/, 'A\'s earlier screen should come back');
  assert.ok(!t.includes('spiral'), 'B leaked into A');
});

await test('7-8. code edit and new execution output keep the same problem and replace the old code', async () => {
  const h = harness();
  await h.start();
  await twoPanelProblem(h, A, CODE_V1);
  const nbView = { x: 0, y: 0, w: 600, h: 300 };
  h.send({ type: 'stale', containerId: 'nb', contentRect: nbView, reason: 'in-place-change' });
  h.region({ c: 'nb', kind: 'refresh', rect: nbView, screen: { x: 400, y: 0, w: 600, h: 300 }, lines: lines(CODE_V2, 0.1, 0.25) });
  await flush();
  h.region({ c: 'nb', kind: 'scroll', rect: { x: 0, y: 500, w: 600, h: 120 }, screen: { x: 400, y: 500, w: 600, h: 120 }, lines: lines(['Out[3]: [(passage one, 0.91), (passage two, 0.84)]'], 0.2) });
  await flush();
  assert.equal(h.problem().id, 'p1');
  assert.equal(h.problems.length, 1, 'a code edit is not a new problem');
  const t = h.context();
  assert.match(t, /scores = sorted\(passages\)/);
  assert.ok(!t.includes('scores = []'), 'old code still in context after the edit');
  assert.match(t, /Out\[3\]: \[\(passage one/);
});

await test('in-place switch of the question panel (next question, no scene change): old question text leaves', async () => {
  const h = harness();
  await h.start();
  await twoPanelProblem(h, A, CODE_V1);
  // A's lower half was read earlier at y=800.., then the user scrolled back up.
  h.container({ id: 'q', screen: LEFT, viewport: { x: 0, y: 600, w: 400, h: 800 } });
  h.region({ c: 'q', kind: 'scroll', rect: { x: 0, y: 800, w: 400, h: 600 }, screen: { x: 0, y: 200, w: 400, h: 600 }, lines: lines(A_MORE) });
  await flush();
  h.container({ id: 'q', screen: LEFT, viewport: { x: 0, y: 0, w: 400, h: 800 } });
  await flush();
  // "Next question": the panel re-renders with B in place.
  h.send({ type: 'stale', containerId: 'q', contentRect: { x: 0, y: 0, w: 400, h: 800 }, reason: 'in-place-change' });
  h.region({ c: 'q', kind: 'refresh', rect: { x: 0, y: 0, w: 400, h: 800 }, screen: LEFT, lines: lines(B) });
  await flush();
  assert.equal(h.problem().id, 'p2');
  const t = h.context();
  assert.match(t, /spiral order/);
  assert.ok(!t.includes('test retrieve sorted'), 'scrolled-out text of the old question survived');
});

await test('9. rapid switching A -> B -> C -> A -> B ends on B with one event per real switch', async () => {
  const h = harness();
  await h.start();
  const seq = [A, B, C, A, B];
  for (let i = 0; i < seq.length; i += 1) {
    if (i) h.send({ type: 'scene-change', epoch: i });
    h.region({ rect: { x: 0, y: 0, w: 1000, h: 800 }, lines: lines(seq[i]), epoch: i });
    await flush();
  }
  assert.deepEqual(h.problems.map((p) => p.id), ['p1', 'p2', 'p3', 'p1', 'p2']);
  assert.equal(h.problem().id, 'p2');
  const t = h.context();
  assert.ok(!t.includes('Parentheses') && !t.includes('Campus'), 'other problems leaked');
});

await test('10. OCR failure on the new screen: not identified, old problem not offered, failure shown', async () => {
  const h = harness();
  await h.start();
  await twoPanelProblem(h, A, CODE_V1);
  h.send({ type: 'scene-change', epoch: 1 });
  h.region({ rect: { x: 0, y: 0, w: 1000, h: 800 }, lines: [], fail: 'NETWORK', epoch: 1 });
  await flush();
  assert.notEqual(h.problem().status, 'identified');
  const t = h.context();
  assert.ok(!t.includes('Campus FAQ Bot'));
  assert.match(t, /FAILED analysis/);
});

console.log('assistant IPC: obsolete answers');

function ipcRig({ abortable = true, problemId = 'p1', viewAnalysed = true } = {}) {
  const handlers = {};
  const sent = [];
  const pending = [];
  const calls = [];
  const runtime = {
    getActiveAiProvider: () => (abortable ? 'gemini' : 'ollama'),
    hasApiKeys: () => true,
    getApiKeys: () => ['k'],
    getService: () => service,
    isAllKeysUnavailableError: () => false,
    cancelActive(tag) {
      if (!abortable) return false;
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
    analyzeScreenshots: (parts, text, opts) => { calls.push({ kind: 'screen', parts, text, opts }); return deferred(opts.tag, opts); },
    askAiWithSessionContext: (opts) => { calls.push({ kind: 'ask', opts }); return deferred(opts.tag, opts); },
    askAiWithSessionContextAndScreenshots: (parts, opts) => { calls.push({ kind: 'ask-images', parts, opts }); return deferred(opts.tag, opts); },
  };
  const screen = {
    monitoring: 'active',
    problemId,
    viewAnalysed,
    isActive: () => screen.monitoring === 'active',
    getSnapshot: () => ({ monitoring: screen.monitoring }),
    waitDelay: 0,
    waitForCurrentView: async () => {
      if (screen.waitDelay) await new Promise((r) => setTimeout(r, screen.waitDelay));
      return { ready: screen.viewAnalysed, waitedMs: 12 };
    },
    getPromptContext: () => ({ text: `=== SCREEN SESSION CONTEXT ===\nscreen of ${screen.problemId}`, imageParts: [], problem: { id: screen.problemId }, viewAnalysed: screen.viewAnalysed }),
    getLatestFrame: async () => ({ jpeg: Buffer.from('frame'), mime: 'image/jpeg' }),
    getProblem: () => ({ id: screen.problemId }),
  };
  const api = registerAssistantIpc({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, on: () => {} },
    screenshotManager: {
      validateScreenCaptureCapability: async () => ({ authorized: true }),
      hasScreenshots: () => false,
      getScreenshotsCount: () => 0,
    },
    windowController: {},
    geminiRuntime: runtime,
    assemblyAiService: { flushAllSttHistoryBuffers: () => {} },
    sendToRenderer: (ch, payload) => sent.push([ch, payload]),
    quitApplication: () => {},
    mobileServer: null,
    getScreenIntel: () => screen,
  });
  const invoke = (ch, payload) => handlers[ch]({}, payload);
  const chunks = (actionId) => sent.filter(([ch, p]) => ch === 'ai-stream-chunk' && p.actionId === actionId).map(([, p]) => p.text);
  return { api, invoke, pending, calls, sent, screen, chunks, service };
}

const origLog = console.log;
const quiet = async (fn) => { console.log = () => {}; try { return await fn(); } finally { console.log = origLog; } };

await test('problem change mid-stream cancels the screen answer; later chunks never reach the UI', async () => {
  const rig = ipcRig();
  const run = quiet(() => rig.invoke('analyze-screen', {}));
  await flush();
  rig.pending[0].chunk('answer for A ');
  rig.api.onScreenProblemChange({ id: 'p2' });
  const result = await run;
  assert.equal(result.cancelled, true);
  assert.equal(result.reason, 'problem-changed');
  assert.deepEqual(rig.chunks('screenIntelligence'), ['answer for A ']);
  assert.ok(rig.sent.some(([ch, p]) => ch === 'ai-stream-end' && p.actionId === 'screenIntelligence'));
});

await test('the same problem staying on screen does not cancel the answer', async () => {
  const rig = ipcRig();
  const run = quiet(() => rig.invoke('analyze-screen', {}));
  await flush();
  rig.api.onScreenProblemChange({ id: 'p1' });
  rig.pending[0].finish('done');
  const result = await run;
  assert.equal(result.success, true);
  assert.equal(result.problemId, 'p1');
  assert.ok(Number.isFinite(result.timings.totalMs));
});

await test('a second Analyze supersedes the first; only the second answer completes', async () => {
  const rig = ipcRig();
  const first = quiet(() => rig.invoke('analyze-screen', {}));
  await flush();
  rig.screen.problemId = 'p2';
  const second = quiet(() => rig.invoke('analyze-screen', {}));
  await flush();
  const r1 = await first;
  assert.equal(r1.cancelled, true);
  assert.equal(r1.reason, 'superseded');
  rig.pending[1].finish('answer for B');
  const r2 = await second;
  assert.equal(r2.success, true);
  assert.equal(r2.problemId, 'p2');
});

await test('provider that cannot abort (Ollama): result after a problem change is discarded, not shown', async () => {
  const rig = ipcRig({ abortable: false });
  const run = quiet(() => rig.invoke('analyze-screen', {}));
  await flush();
  rig.api.onScreenProblemChange({ id: 'p2' });
  rig.pending[0].chunk('late chunk');
  rig.pending[0].finish('stale full answer');
  const result = await run;
  assert.equal(result.cancelled, true);
  assert.deepEqual(rig.chunks('screenIntelligence'), []);
  assert.ok(!rig.sent.some(([ch, p]) => ch === 'analysis-result' && p.text === 'stale full answer'));
});

await test('cancel-analyze-screen stops the running answer', async () => {
  const rig = ipcRig();
  const run = quiet(() => rig.invoke('analyze-screen', {}));
  await flush();
  const c = await rig.invoke('cancel-analyze-screen');
  assert.equal(c.cancelled, true);
  const result = await run;
  assert.equal(result.cancelled, true);
  assert.equal(result.reason, 'user');
  const stages = rig.sent.filter(([ch]) => ch === 'screen-capture-status').map(([, p]) => p.stage);
  assert.equal(stages[stages.length - 1], 'cancelled', `status must end in cancelled, got ${stages.join(' > ')}`);
  assert.ok(!rig.sent.some(([ch]) => ch === 'analysis-result'), 'a cancelled run sends no final result');
});

await test('ask right after a switch: waits for the view, sends the new screen text and attaches the live frame while unread', async () => {
  const rig = ipcRig({ viewAnalysed: false, problemId: null });
  const run = quiet(() => rig.invoke('ask-ai-with-session-context', { transcriptContext: 'Host: how do I fix my code?' }));
  await flush();
  const call = rig.calls[0];
  assert.equal(call.kind, 'ask-images');
  assert.equal(call.parts[0].inlineData.data, Buffer.from('frame').toString('base64'));
  assert.match(call.opts.contextString, /SCREEN SESSION CONTEXT/);
  rig.pending[0].finish('fix');
  const result = await run;
  assert.equal(result.success, true);
  assert.equal(result.screenWaitMs, 12);
});

await test('ask with a fully read view sends text only; with monitoring stopped no screen context at all', async () => {
  const rig = ipcRig({ viewAnalysed: true });
  const run = quiet(() => rig.invoke('ask-ai-with-session-context', { transcriptContext: 'Host: explain' }));
  await flush();
  assert.equal(rig.calls[0].kind, 'ask');
  rig.pending[0].finish('ok');
  await run;
  rig.screen.monitoring = 'stopped';
  const run2 = quiet(() => rig.invoke('ask-ai-with-session-context', { transcriptContext: 'Host: explain' }));
  await flush();
  assert.ok(!/SCREEN SESSION CONTEXT/.test(rig.calls[1].opts.contextString), 'a stopped session leaked old screen text');
  rig.pending[1].finish('ok');
  await run2;
});

await test('ask with a fully read view still attaches the evidence crops its screen text refers to', async () => {
  const rig = ipcRig({ viewAnalysed: true });
  const crop = { inlineData: { data: Buffer.from('crop').toString('base64'), mimeType: 'image/jpeg' } };
  const base = rig.screen.getPromptContext;
  rig.screen.getPromptContext = () => ({ ...base(), imageParts: [crop] });
  const run = quiet(() => rig.invoke('ask-ai-with-session-context', { transcriptContext: 'Host: explain' }));
  await flush();
  const call = rig.calls[0];
  assert.equal(call.kind, 'ask-images');
  assert.deepEqual(call.parts, [crop], 'the live frame must not ride along once the view is read; the crop must');
  assert.equal(call.opts.screenshotCount, 1);
  rig.pending[0].finish('ok');
  assert.equal((await run).usedScreenshots, true);
});

await test('Ollama model without vision: ask gets the screen as text only, and the text is built without image claims', async () => {
  const rig = ipcRig({ abortable: false, viewAnalysed: false });
  const crop = { inlineData: { data: 'Y3JvcA==', mimeType: 'image/jpeg' } };
  const asked = [];
  const base = rig.screen.getPromptContext;
  rig.screen.getPromptContext = (opts = {}) => { asked.push(opts); return { ...base(), imageParts: opts.withImages === false ? [] : [crop] }; };
  let frames = 0;
  rig.screen.getLatestFrame = async () => { frames += 1; return { jpeg: Buffer.from('frame'), mime: 'image/jpeg' }; };
  rig.service.supportsVision = async () => false;
  const run = quiet(() => rig.invoke('ask-ai-with-session-context', { transcriptContext: 'Host: what does this code do?' }));
  await flush();
  assert.equal(rig.calls[0].kind, 'ask', 'a text-only model must not be sent images');
  assert.equal(rig.calls[0].opts.screenshotCount, 0);
  assert.deepEqual(asked.map((o) => o.withImages), [false]);
  assert.equal(frames, 0, 'no live frame is grabbed for a model that cannot read it');
  assert.match(rig.calls[0].opts.contextString, /SCREEN SESSION CONTEXT/);
  rig.pending[0].finish('ok');
  assert.equal((await run).usedScreenshots, false);
});

await test('empty image reply: the text-only retry says no screenshots are attached and the result says none were used', async () => {
  const rig = ipcRig({ viewAnalysed: false });
  const run = quiet(() => rig.invoke('ask-ai-with-session-context', { transcriptContext: 'Host: what is on screen?' }));
  await flush();
  assert.equal(rig.calls[0].kind, 'ask-images');
  rig.pending[0].finish('');
  await flush();
  const retry = rig.calls[1];
  assert.equal(retry.kind, 'ask');
  assert.equal(retry.opts.screenshotCount, 0, 'text-only prompt claimed attached screenshots');
  rig.pending[1].finish('answer from text');
  const result = await run;
  assert.equal(result.usedScreenshots, false);
});

await test('quota exhaustion is reported as an error, not a cancellation; slow answer then switch is cancelled', async () => {
  const rig = ipcRig();
  const run = quiet(() => rig.invoke('ask-ai-with-session-context', { transcriptContext: 'Host: q' }));
  await flush();
  rig.pending[0].done = true;
  rig.pending[0].reject(new Error('You exceeded your current quota'));
  const origError = console.error;
  console.error = () => {};
  const result = await run.finally(() => { console.error = origError; });
  assert.equal(result.success, false);
  assert.ok(!result.cancelled);
  assert.match(result.error, /quota/i);
  const slow = quiet(() => rig.invoke('ask-ai-with-session-context', { transcriptContext: 'Host: q' }));
  await flush();
  rig.api.onScreenProblemChange({ id: 'p9' });
  const r2 = await slow;
  assert.equal(r2.cancelled, true);
  assert.equal(r2.reason, 'problem-changed');
});

await test('a second Analyze during the screen wait cancels the first before any request is sent', async () => {
  const rig = ipcRig();
  rig.screen.waitDelay = 50;
  const first = quiet(() => rig.invoke('analyze-screen', {}));
  await flush();
  const second = quiet(() => rig.invoke('analyze-screen', {}));
  const r1 = await first;
  assert.equal(r1.cancelled, true);
  assert.equal(r1.reason, 'superseded');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(rig.calls.length, 1, 'the cancelled run still reached the provider');
  rig.pending[0].finish('only answer');
  assert.equal((await second).success, true);
});

await test('a paused session offers no screen text and no frame (it may show a screen that is gone)', async () => {
  const rig = ipcRig();
  rig.screen.monitoring = 'paused';
  const run = quiet(() => rig.invoke('ask-ai-with-session-context', { transcriptContext: 'Host: q', contextString: 'Host: q' }));
  await flush();
  assert.equal(rig.calls[0].kind, 'ask');
  assert.ok(!/SCREEN SESSION CONTEXT/.test(rig.calls[0].opts.contextString));
  rig.pending[0].finish('ok');
  await run;
});

await test('an answer started while the screen was being read takes the first identified problem, and a later switch cancels it', async () => {
  const rig = ipcRig({ problemId: null, viewAnalysed: false });
  const run = quiet(() => rig.invoke('analyze-screen', {}));
  await flush();
  rig.api.onScreenProblemChange({ id: 'p2' }); // the screen it was started on is identified
  rig.pending[0].chunk('answer for p2 ');
  rig.api.onScreenProblemChange({ id: 'p3' }); // then the user moves on
  const result = await run;
  assert.equal(result.cancelled, true);
  assert.equal(result.reason, 'problem-changed');
  assert.deepEqual(rig.chunks('screenIntelligence'), ['answer for p2 ']);
});

await test('problem changes while the frame is grabbed: text and frame are read again so both show the new screen', async () => {
  const rig = ipcRig({ problemId: 'p1' });
  let grabs = 0;
  rig.screen.getLatestFrame = async () => {
    grabs += 1;
    if (grabs === 1) rig.screen.problemId = 'p2'; // switch lands during the first grab
    return { jpeg: Buffer.from(`frame${grabs}`), mime: 'image/jpeg' };
  };
  const run = quiet(() => rig.invoke('analyze-screen', {}));
  await flush();
  const call = rig.calls[0];
  assert.equal(grabs, 2);
  assert.equal(call.parts[0].inlineData.data, Buffer.from('frame2').toString('base64'));
  assert.match(call.text, /screen of p2/);
  rig.pending[0].finish('ok');
  const result = await run;
  assert.equal(result.problemId, 'p2');
});

await test('screen still changing on the re-read: the frame goes alone, text that may not match is left out', async () => {
  const rig = ipcRig({ problemId: 'p1' });
  let grabs = 0;
  rig.screen.getLatestFrame = async () => { grabs += 1; rig.screen.problemId = `p${grabs + 1}`; return { jpeg: Buffer.from('f'), mime: 'image/jpeg' }; };
  const run = quiet(() => rig.invoke('analyze-screen', {}));
  await flush();
  assert.ok(!/screen of p/.test(rig.calls[0].text || ''), 'mismatched text was sent with the frame');
  rig.pending[0].finish('ok');
  await run;
});

console.log('provider stream: watchdog and cancel (fake model, real GeminiService)');

const GeminiService = require('../src/services/ai/gemini-service.js');
function serviceWith(streamFactory) {
  const svc = new GeminiService('test-key-not-used', {});
  svc.streamFirstChunkTimeoutMs = 60;
  svc.streamIdleTimeoutMs = 60;
  svc.isRetryableError = () => false;
  svc.model = {
    generateContentStream: async (_payload, { signal }) => {
      const response = new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Error reading from the stream')), { once: true }));
      return { response, stream: streamFactory(signal) };
    },
  };
  return svc;
}
const stalled = (chunks) => async function* stream(signal) {
  for (const text of chunks) yield { text: () => text };
  // Like a fetch body: an already-aborted signal rejects at once.
  const aborted = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  if (signal.aborted) throw aborted();
  await new Promise((_, reject) => signal.addEventListener('abort', () => reject(aborted()), { once: true }));
};
let unhandled = 0;
process.on('unhandledRejection', () => { unhandled += 1; });

await test('a stream that never starts times out with code TIMEOUT instead of waiting forever', async () => {
  const svc = serviceWith(stalled([]));
  const t0 = Date.now();
  const error = await quiet(() => svc.generateMultimodal([{ text: 'q' }], { onChunk: () => {}, priority: 'realtime', tag: 'screenIntelligence' })).then(() => null, (e) => e);
  assert.ok(error, 'resolved instead of timing out');
  assert.equal(error.code, 'TIMEOUT');
  assert.ok(!error.isCancelled);
  assert.ok(Date.now() - t0 < 2000);
});

await test('a stream that stalls after its first chunk times out; the chunk was delivered', async () => {
  const svc = serviceWith(stalled(['first part ']));
  const got = [];
  const error = await quiet(() => svc.generateMultimodal([{ text: 'q' }], { onChunk: ({ text }) => got.push(text), priority: 'realtime', tag: 'askAi' })).then(() => null, (e) => e);
  assert.equal(error && error.code, 'TIMEOUT');
  assert.deepEqual(got, ['first part ']);
});

await test('cancel during a stall is a cancellation, not a timeout, and leaves no unhandled rejection', async () => {
  const svc = serviceWith(stalled(['partial ']));
  svc.streamFirstChunkTimeoutMs = 5000;
  svc.streamIdleTimeoutMs = 5000;
  const run = quiet(() => svc.generateMultimodal([{ text: 'q' }], { onChunk: () => svc.cancel('screenIntelligence'), priority: 'realtime', tag: 'screenIntelligence' })).then(() => null, (e) => e);
  const error = await run;
  await flush();
  assert.equal(error && error.isCancelled, true);
  assert.notEqual(error.code, 'TIMEOUT');
  assert.equal(unhandled, 0, 'the SDK response promise rejected without a handler');
});

console.log('renderer: answers about other problems');

await test('answers about the previous problem leave the AI context; returning restores them; user choices stick', () => {
  let current = 'p1';
  const store = createMessageStore({ getActiveProblemId: () => current });
  const a1 = store.add('ai-response', 'def retrieve_passages answer for campus bot');
  store.add('voice-system', 'Can you walk me through it?');
  current = 'p2';
  const excluded = store.excludeOtherProblems('p2');
  assert.deepEqual(excluded.map((m) => m.id), [a1.id]);
  const b1 = store.add('ai-response', 'spiral order answer');
  const bundle = () => buildFilteredAiContextBundle({ messages: store.getMessages(), isMessageIncludedForAi: store.isIncludedForAi, charBudget: 10000, emitTruncationLog: false });
  assert.ok(!bundle().contextString.includes('retrieve_passages'), 'old answer still sent as context');
  assert.ok(bundle().contextString.includes('spiral order answer'));
  assert.ok(bundle().contextString.includes('walk me through'), 'transcript is not problem-scoped and stays');
  store.toggleInclusion(b1.id); // user excludes B's answer by hand
  current = 'p1';
  const back = store.excludeOtherProblems('p1');
  assert.deepEqual(back.restored.map((m) => m.id), [a1.id]);
  assert.ok(bundle().contextString.includes('retrieve_passages'));
  current = 'p2';
  store.excludeOtherProblems('p2');
  assert.equal(store.findById(b1.id).includeInAi, false, 'a user exclusion was undone automatically');
});

await test('answer started while the new screen is still being read keeps its context once it turns out to be about that screen', () => {
  let current = 'p1';
  const store = createMessageStore({ getActiveProblemId: () => current });
  store.add('ai-response', 'answer about A');
  current = null; // renderer: problem status "detecting" right after the switch
  const streaming = store.add('ai-response', 'answer about B, streamed during detection');
  assert.equal(streaming.problemId, null);
  current = 'p2';
  store.excludeOtherProblems('p2');
  assert.equal(store.findById(streaming.id).includeInAi, true, 'unstamped answer was excluded by the switch');
  store.assignProblem(streaming.id, 'p2', 'p2');
  assert.equal(store.findById(streaming.id).problemId, 'p2');
  assert.equal(store.findById(streaming.id).includeInAi, true);
  // Stamped with A, excluded by the switch, but the main process says it was about B: restored.
  const raced = store.add('ai-response', 'raced', { problemId: 'p1' });
  store.excludeOtherProblems('p2');
  assert.equal(store.findById(raced.id).includeInAi, false);
  assert.equal(store.assignProblem(raced.id, 'p2', 'p2'), true);
  assert.equal(store.findById(raced.id).includeInAi, true);
});

console.log(`\nProblem switching tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed ? 1 : 0);
