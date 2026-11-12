#!/usr/bin/env node
/**
 * Mode C vision core: frame analysis, container tracking and the capture
 * engine, driven by a deterministic synthetic assessment page.
 *
 * Run: node tests/test-mode-c-vision.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fa = require('../src/services/screen-intel/frame-analysis.js');
const { createCaptureEngine } = require('../src/services/screen-intel/capture-engine.js');
const { createFixture, makeFakeCropFrame, fakeOcrFor } = require('./fixtures/mode-c-fixture.cjs');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n      ${error.stack.split('\n').slice(0, 3).join('\n      ')}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || 'eq'}: expected ${expected}, got ${actual}`);
}

const fx = createFixture();
const W = fx.width;
const H = fx.height;
const PANEL = fx.panels.right.rect;
const LEFT = fx.panels.left.rect;

function rig({ crop, options } = {}) {
  const events = [];
  const state = { leftY: 0, rightY: 0, rightX: 0 };
  const r = {
    events,
    state,
    t: 1000,
    fail: false,
    released: [],
  };
  const baseCrop = makeFakeCropFrame(fx);
  r.engine = createCaptureEngine({
    sessionId: 's1',
    display: { id: 1, width: W, height: H, scaleFactor: 2 },
    cropFrame: crop || ((ref, rect) => {
      if (r.fail) throw new Error('capture window lost the frame');
      return baseCrop(ref, rect);
    }),
    emit: (e) => events.push(e),
    now: () => r.t,
    options,
    releaseFrameRef: (ref) => r.released.push(ref),
  });
  r.go = (patch = {}, dt = 33, extra = {}) => {
    Object.assign(state, patch);
    const f = fx.frame({ ...state, ...extra });
    r.t += dt;
    r.engine.pushFrame({ gray: f.gray, width: W, height: H, t: r.t, frameRef: f.frameRef });
  };
  r.idle = (ms, step = 100, extra = {}) => {
    for (let waited = 0; waited < ms; waited += step) r.go({}, step, extra);
  };
  r.scroll = (key, to, step, extra = {}) => {
    let v = state[key];
    while (v !== to) {
      v = to > v ? Math.min(to, v + step) : Math.max(to, v - step);
      r.go({ [key]: v }, 33, extra);
    }
  };
  r.of = (type) => events.filter((e) => e.type === type);
  r.regions = (kind) => events.filter((e) => e.type === 'region' && (!kind || e.kind === kind));
  r.noErrors = () => assert(r.of('error').length === 0, `unexpected error events: ${JSON.stringify(r.of('error'))}`);
  r.container = (side) => {
    const list = r.engine.getContainers().filter((c) => c.id !== 'root');
    return list.find((c) => (side === 'left' ? c.screenRect.x < 400 : c.screenRect.x > 400));
  };
  return r;
}

// scroll value implied by a region's content rect (content origin is the
// container's rect origin at scroll 0).
const scrollYOf = (reg, c) => reg.contentRect.y - (reg.screenRect.y - c.screenRect.y);
const scrollXOf = (reg, c) => reg.contentRect.x - (reg.screenRect.x - c.screenRect.x);

function assertNoHoles(intervals, from, to, label) {
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  let reach = from;
  for (const [a, b] of sorted) {
    assert(a <= reach + 1, `${label}: hole in [${reach}, ${a}]`);
    reach = Math.max(reach, b);
  }
  assert(reach >= to - 1, `${label}: coverage stops at ${reach}, need ${to}`);
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const rectNear = (r, p, tol) => near(r.x, p.x, tol) && near(r.y, p.y, tol) && near(r.x + r.w, p.x + p.w, tol) && near(r.y + r.h, p.y + p.h, tol);

console.log('frame-analysis');

await test('fixture: right notebook is taller than 5 viewports and has real text', () => {
  assert(fx.panels.right.contentHeight > 5 * PANEL.h, `right content ${fx.panels.right.contentHeight}`);
  assert(fx.panels.right.contentWidth > PANEL.w + 600, 'right panel needs horizontal room');
  assert(fx.allLines('left').some((l) => l.kind === 'test_case'), 'left has test cases');
  assert(fx.allLines('right').some((l) => l.kind === 'error'), 'right has a traceback');
  assert(fx.allLines('right').some((l) => l.kind === 'code' && l.box.x > 12 + 24), 'code has indentation');
});

await test('toGray converts RGBA to luminance', () => {
  const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
  const g = fa.toGray(rgba, 3, 1);
  eq(g[0], 255);
  eq(g[1], 0);
  assert(g[2] > 60 && g[2] < 90, `red luminance ${g[2]}`);
});

await test('diffTiles: components merge adjacent tiles, masks never count', () => {
  const a = new Uint8Array(160 * 160).fill(200);
  const b = a.slice();
  for (let y = 20; y < 60; y += 1) for (let x = 20; x < 60; x += 1) b[y * 160 + x] = 40;
  const d = fa.diffTiles(a, b, 160, 160, {});
  eq(d.rects.length, 1, 'one merged component');
  assert(d.rects[0].x === 16 && d.rects[0].y === 16 && d.rects[0].w === 48 && d.rects[0].h === 48, JSON.stringify(d.rects[0]));
  const m = fa.diffTiles(a, b, 160, 160, { maskRects: [{ x: 0, y: 0, w: 160, h: 160 }] });
  eq(m.changedCount, 0, 'fully masked');
  const partial = fa.diffTiles(a, b, 160, 160, { maskRects: [{ x: 16, y: 16, w: 48, h: 16 }] });
  assert(partial.changedCount < d.changedCount, 'masked tiles are skipped');
});

await test('estimateShift: exact and noisy shifts, both axes', () => {
  const a = fx.render({ rightY: 500 });
  for (const shift of [3, 25, 140, 300, -90]) {
    const b = fx.render({ rightY: 500 + shift });
    const e = fa.estimateShift(a, b, W, H, PANEL, { axis: 'y' });
    assert(e && e.shift === shift && e.confidence > 0.8, `shift ${shift} -> ${JSON.stringify(e)}`);
  }
  const noisyA = fx.render({ rightY: 500, noise: { jitter: 2, blur: true, seed: 3 } });
  const noisyB = fx.render({ rightY: 560, noise: { jitter: 2, blur: true, seed: 4 } });
  const n = fa.estimateShift(noisyA, noisyB, W, H, PANEL, { axis: 'y' });
  assert(n && n.shift === 60 && n.confidence > 0.7, `noisy -> ${JSON.stringify(n)}`);
  const tableY = fx.allLines('right').find((l) => l.kind === 'table').box.y - 40;
  const hx = fa.estimateShift(fx.render({ rightY: tableY }), fx.render({ rightY: tableY, rightX: 140 }), W, H, PANEL, { axis: 'x' });
  assert(hx && hx.shift === 140, `x shift -> ${JSON.stringify(hx)}`);
});

await test('estimateShift: blank and periodic content are not trusted', () => {
  const blank = new Uint8Array(W * H).fill(250);
  const flat = fa.estimateShift(blank, blank, W, H, PANEL, { axis: 'y' });
  assert(flat === null, 'blank area has no answer');
  const stripes = (offset) => {
    const g = new Uint8Array(W * H).fill(250);
    for (let y = 0; y < H; y += 1) if (((y + offset) % 20) < 6) g.fill(20, y * W, (y + 1) * W);
    return g;
  };
  const p = fa.estimateShift(stripes(0), stripes(7), W, H, PANEL, { axis: 'y' });
  assert(p === null || p.confidence < 0.4, `periodic stripes must be ambiguous: ${JSON.stringify(p)}`);
});

await test('estimateShift: rejects a jump larger than the usable overlap', () => {
  const e = fa.estimateShift(fx.render({ rightY: 0 }), fx.render({ rightY: 900 }), W, H, PANEL, { axis: 'y' });
  assert(e === null || e.confidence < 0.6 || e.matchedFraction < 0.8, `jump must not be trusted: ${JSON.stringify(e)}`);
});

console.log('capture engine');

await test('first frame emits initial root regions that tile the full frame along panel dividers, reporting masks', async () => {
  const r = rig();
  const mask = { x: 900, y: 500, w: 300, h: 200 };
  r.engine.setMaskRects([mask]);
  r.go();
  assert(r.events.length >= 1 && r.events.every((e) => e.type === 'region' && e.kind === 'initial' && e.containerId === 'root'), JSON.stringify(r.events.map((e) => [e.type, e.kind])));
  const tiles = r.events.map((e) => e.screenRect).sort((a, b) => a.x - b.x);
  let edge = 0;
  for (const tile of tiles) {
    assert(tile.x === edge && tile.y === 0 && tile.h === H, `tiles must abut with no hole or overlap: ${JSON.stringify(tiles)}`);
    edge += tile.w;
  }
  eq(edge, W, 'tiles cover the full width');
  const masked = r.events.filter((e) => e.maskRects.length);
  eq(masked.length, 1, 'the mask is reported by the one tile that contains it');
  eq(masked[0].maskRects[0].x, 900);
  const reg = r.events.find((e) => e.screenRect.x === 0);
  eq(reg.sessionId, 's1');
  assert(typeof reg.t === 'number' && typeof reg.captureId === 'string', 'envelope fields');
  const ocr = await fakeOcrFor(fx).recognize(reg.image);
  assert(ocr.lines.some((l) => l.text === 'Campus FAQ Bot'), 'fake OCR reads the heading from the initial crop');
  assert(!ocr.lines.some((l) => l.text.length > 0 && l.box.x + l.box.w > 1.0001), 'boxes stay inside the crop');
});

await test('unchanged frames: zero events and trivial work', () => {
  const r = rig();
  r.go();
  const before = r.events.length;
  r.idle(3000, 100);
  eq(r.events.length, before, 'no events for identical frames');
  eq(r.engine.getMetrics().changedFrames, 0);
  assert(r.engine.nextIntervalMs() >= 400, `static interval ${r.engine.nextIntervalMs()}`);
});

await test('vertical scroll of the right panel: one container, no holes, truthful positions', () => {
  const r = rig();
  r.go();
  r.scroll('rightY', 1500, 30);
  r.idle(600);
  r.noErrors();
  const containers = r.engine.getContainers().filter((c) => c.id !== 'root');
  eq(containers.length, 1, 'exactly one container');
  const c = containers[0];
  assert(rectNear(c.screenRect, PANEL, 40), `container rect ${JSON.stringify(c.screenRect)} vs panel`);
  eq(c.scroll.y, 1500);
  eq(c.axis, 'y');
  assert(r.of('gap').length === 0, 'no gap while tracking');
  const bands = r.regions('scroll').filter((e) => e.containerId === c.id);
  assert(bands.length >= 2, `bands ${bands.length}`);
  for (const b of bands) {
    assert(near(scrollYOf(b, c), b.image.state.rightY, 2), `band at ${scrollYOf(b, c)} but frame was scrolled to ${b.image.state.rightY}`);
    assert(b.overlap.top >= 0 && b.overlap.top <= 48 && b.overlap.bottom <= 48, 'overlap margin bounded');
  }
  assertNoHoles([[0, c.screenRect.h], ...bands.map((b) => [b.contentRect.y, b.contentRect.y + b.contentRect.h])], 0, 1500 + c.screenRect.h, 'right panel');
  const totalBand = bands.reduce((n, b) => n + b.contentRect.h, 0);
  assert(totalBand < (1500 + c.screenRect.h) * 1.5, `bands re-capture too much: ${totalBand}`);
  assert(r.of('motion').some((m) => m.phase === 'start') && r.of('motion').some((m) => m.phase === 'settled'), 'motion start and settled');
  const ocr = fakeOcrFor(fx);
  return Promise.all(bands.map(async (b) => {
    const res = await ocr.recognize(b.image);
    const want = fx.linesInRect('right', { x: 0, y: b.image.state.rightY + (b.screenRect.y - PANEL.y), w: 5000, h: b.screenRect.h });
    assert(res.lines.length > 0 && want.length > 0, 'band holds readable lines');
  }));
});

await test('scrolling back over covered content emits nothing', () => {
  const r = rig();
  r.go();
  r.scroll('rightY', 1200, 30);
  r.idle(600);
  const mark = r.events.filter((e) => e.type === 'region' || e.type === 'gap' || e.type === 'stale' || e.type === 'uncaptured').length;
  r.scroll('rightY', 0, 30);
  r.idle(600);
  const after = r.events.filter((e) => e.type === 'region' || e.type === 'gap' || e.type === 'stale' || e.type === 'uncaptured').length;
  eq(after, mark, 'no region/gap/stale after scrolling back');
  r.noErrors();
});

await test('panel discovered on a large first jump: the root capture is reused, scroll-back emits nothing', () => {
  const r = rig();
  r.go();
  const jump = Math.round(PANEL.h * 0.4);
  r.go({ rightY: jump }, 400); // first frame after an idle interval
  r.scroll('rightY', 1200, 30);
  r.idle(600);
  r.noErrors();
  const c = r.container('right');
  assert(c, 'panel was not recognised on the first jump');
  const inPanel = r.regions().filter((e) => e.containerId === c.id);
  // Content 0..PANEL.h was read by the initial root capture.
  const reread = inPanel.filter((e) => e.contentRect.y + e.contentRect.h <= PANEL.h - 48);
  eq(reread.length, 0, `initially captured content re-read: ${JSON.stringify(reread.map((e) => e.contentRect))}`);
  const mark = r.regions().length;
  r.scroll('rightY', 0, 30);
  r.idle(600);
  eq(r.regions().length, mark, 'regions after scrolling back to the top');
});

await test('scroll before the panel is recognised is measured and carried: no hole, nothing re-read', () => {
  const r = rig();
  r.go();
  // First scroll frame: noise over part of the panel makes it unexplainable.
  r.go({ rightY: 150 }, 400, { overlay: { x: PANEL.x + 40, y: PANEL.y + 40, w: 320, h: 320, seed: 9 } });
  eq(r.of('container').length, 0, 'panel recognised on the noisy frame; this test needs it not to be');
  r.scroll('rightY', 1200, 30);
  r.idle(600);
  r.noErrors();
  const c = r.container('right');
  assert(c, 'panel not recognised');
  eq(r.of('gap').length, 0, 'gaps');
  const bands = r.regions().filter((e) => e.containerId === c.id);
  assertNoHoles([[0, PANEL.h], ...bands.map((b) => [b.contentRect.y, b.contentRect.y + b.contentRect.h])], 0, 1200 + c.screenRect.h, 'carried coverage');
  const reread = bands.filter((e) => e.contentRect.y + e.contentRect.h <= PANEL.h - 48);
  eq(reread.length, 0, 'initially captured content re-read');
  eq(c.scroll.y, 1200, 'tracked scroll matches the page');
});

await test('panel discovered while the root had a pending edit there: no full-width refresh over the other panel', () => {
  const r = rig();
  r.go();
  const idx = fx.allLines('right').findIndex((l) => l.kind === 'code' && l.box.y > 150 && l.box.y < 500);
  const edit = { panel: 'right', line: idx, text: 'return faq.get(key, FALLBACK)' };
  r.go({}, 100, { edit }); // root now has an unsettled change inside the panel
  r.scroll('rightY', 600, 60, { edit });
  r.idle(800, 100, { edit });
  r.noErrors();
  assert(r.container('right'), 'panel not recognised');
  const overLeft = [...r.regions('refresh'), ...r.of('stale')].filter((e) => (e.containerId || 'root') === 'root'
    && (e.screenRect ? e.screenRect.x < LEFT.x + LEFT.w : true));
  eq(overLeft.length, 0, `root refresh/stale reached the question panel: ${JSON.stringify(overLeft.map((e) => e.screenRect || e.contentRect))}`);
});

await test('left and right panels are tracked independently, alternating', () => {
  const r = rig();
  r.go();
  for (const y of [300, 600, 900]) {
    r.scroll('rightY', y, 30);
    r.scroll('leftY', y / 2, 30);
  }
  r.idle(600);
  r.noErrors();
  const left = r.container('left');
  const right = r.container('right');
  assert(left && right, 'two containers');
  eq(r.engine.getContainers().filter((c) => c.id !== 'root').length, 2);
  assert(rectNear(left.screenRect, LEFT, 40), `left rect ${JSON.stringify(left.screenRect)}`);
  assert(rectNear(right.screenRect, PANEL, 40), `right rect ${JSON.stringify(right.screenRect)}`);
  eq(left.scroll.y, 450);
  eq(right.scroll.y, 900);
  for (const reg of r.regions('scroll')) {
    const c = reg.containerId === left.id ? left : right;
    assert(reg.screenRect.x >= c.screenRect.x && reg.screenRect.x + reg.screenRect.w <= c.screenRect.x + c.screenRect.w, 'region stays inside its own container');
    const truth = reg.containerId === left.id ? reg.image.state.leftY : reg.image.state.rightY;
    assert(near(scrollYOf(reg, c), truth, 2), `${reg.containerId} band at ${scrollYOf(reg, c)}, truth ${truth}`);
  }
  assertNoHoles([[0, right.screenRect.h], ...r.regions('scroll').filter((e) => e.containerId === right.id).map((b) => [b.contentRect.y, b.contentRect.y + b.contentRect.h])], 0, 900 + right.screenRect.h, 'right');
  assertNoHoles([[0, left.screenRect.h], ...r.regions('scroll').filter((e) => e.containerId === left.id).map((b) => [b.contentRect.y, b.contentRect.y + b.contentRect.h])], 0, 450 + left.screenRect.h, 'left');
});

await test('rapid scroll: a gap and a new segment, never a wrong shift', () => {
  const r = rig();
  r.go();
  r.scroll('rightY', 120, 30);
  r.idle(400);
  const c0 = r.container('right');
  const firstSegment = c0.segmentId;
  r.go({ rightY: 1200 });
  r.go({ rightY: 2400 });
  r.go({ rightY: 3000 });
  r.idle(600);
  r.noErrors();
  const gaps = r.of('gap');
  eq(gaps.length, 1, 'one gap');
  eq(gaps[0].reason, 'fast-scroll');
  eq(gaps[0].fromSegmentId, firstSegment);
  assert(gaps[0].toSegmentId !== firstSegment, 'new segment');
  for (const e of r.of('container')) {
    if (e.container.id === c0.id && e.container.segmentId === firstSegment) assert(e.container.scroll.y <= 120, `old segment mis-tracked to ${e.container.scroll.y}`);
  }
  const fresh = r.regions().filter((e) => e.containerId === c0.id && e.segmentId === gaps[0].toSegmentId);
  assert(fresh.length >= 1, 'new viewport captured in the new segment');
  const base = fresh[0].image.state.rightY - scrollYOf(fresh[0], r.container('right'));
  eq(fresh[0].image.state.rightY, 3000);
  r.scroll('rightY', 3300, 30);
  r.idle(600);
  const cont = r.regions('scroll').filter((e) => e.containerId === c0.id && e.segmentId === gaps[0].toSegmentId);
  for (const b of cont) assert(near(base + scrollYOf(b, r.container('right')), b.image.state.rightY, 2), 'tracking resumes with the right positions inside the new segment');
  eq(r.of('gap').length, 1, 'still one gap');
});

await test('steps of 60-90% of the viewport: track or gap, never mis-track', () => {
  for (const frac of [0.6, 0.7, 0.8, 0.9]) {
    const r = rig();
    r.go();
    r.scroll('rightY', 90, 30);
    r.idle(400);
    const step = Math.round(PANEL.h * frac);
    for (let i = 1; i <= 5; i += 1) r.go({ rightY: 90 + step * i });
    r.idle(800);
    r.noErrors();
    const c = r.container('right');
    const bySegment = new Map();
    for (const reg of r.regions().filter((e) => e.containerId === c.id && e.kind !== 'initial')) {
      const off = reg.image.state.rightY - scrollYOf(reg, c);
      if (!bySegment.has(reg.segmentId)) bySegment.set(reg.segmentId, off);
      assert(near(off, bySegment.get(reg.segmentId), 2), `frac ${frac}: segment ${reg.segmentId} drifted (${off} vs ${bySegment.get(reg.segmentId)})`);
    }
    const tracked = r.of('gap').length === 0;
    if (frac >= 0.9) assert(!tracked, `frac ${frac} must gap`);
    console.log(`      frac ${frac}: ${tracked ? 'tracked' : 'gap'} (${r.regions().length} regions)`);
  }
});

await test('horizontal scroll inside the panel is tracked on the x axis', () => {
  const tableY = fx.allLines('right').find((l) => l.kind === 'table').box.y - 40;
  const r = rig();
  r.go({ rightY: tableY });
  r.go();
  r.scroll('rightX', 600, 60);
  r.idle(600);
  r.noErrors();
  const c = r.container('right');
  assert(c, 'container');
  assert(c.axis === 'x' || c.axis === 'both', `axis ${c.axis}`);
  eq(c.scroll.x, 600);
  const bands = r.regions('scroll').filter((e) => e.containerId === c.id);
  assert(bands.length >= 1, 'horizontal bands captured');
  for (const b of bands) assert(near(scrollXOf(b, c), b.image.state.rightX, 2), `x band at ${scrollXOf(b, c)} vs ${b.image.state.rightX}`);
  assertNoHoles([[0, c.screenRect.w], ...bands.map((b) => [b.contentRect.x, b.contentRect.x + b.contentRect.w])], 0, 600 + c.screenRect.w, 'horizontal');
});

await test('resampling noise: no phantom events when static, scrolling still tracked', () => {
  const r = rig();
  const noise = (seed) => ({ noise: { jitter: 2, blur: true, seed } });
  r.go({}, 33, noise(1));
  const initialEvents = r.events.length;
  for (let i = 2; i < 30; i += 1) r.go({}, 100, noise(i));
  eq(r.events.length, initialEvents, `noise-only frames produced ${r.events.length - initialEvents} events`);
  let seed = 100;
  for (let y = 40; y <= 800; y += 40) r.go({ rightY: y }, 33, noise((seed += 1)));
  for (let i = 0; i < 8; i += 1) r.go({}, 100, noise((seed += 1)));
  r.noErrors();
  const c = r.container('right');
  assert(c && c.scroll.y === 800, 'tracked through noise');
  eq(r.of('gap').length, 0);
  for (const b of r.regions('scroll')) assert(near(scrollYOf(b, c), b.image.state.rightY, 2), 'noisy band positions are true');
});

await test('caret blink does not create containers, stale content or regions', () => {
  const r = rig();
  r.go();
  const base = r.events.length;
  let on = false;
  for (let i = 0; i < 50; i += 1) {
    on = !on;
    r.go({}, 100, { caret: on });
  }
  r.idle(1500, 100);
  eq(r.events.length, base, `caret produced ${JSON.stringify(r.events.slice(base).map((e) => e.type))}`);
  eq(r.engine.getContainers().length, 1);
});

await test('in-place edit: stale then refresh once, only after typing settles', () => {
  const r = rig();
  r.go();
  const idx = fx.allLines('right').findIndex((l) => l.kind === 'code' && l.box.y > 150 && l.box.y < 500);
  const line = fx.allLines('right')[idx];
  const target = 'return faq.get(key, FALLBACK)';
  const base = r.events.length;
  for (let i = 1; i <= 10; i += 1) r.go({}, 100, { edit: { panel: 'right', line: idx, text: target.slice(0, i * 2) } });
  eq(r.events.length, base, 'nothing emitted per keystroke');
  const finalEdit = { panel: 'right', line: idx, text: target };
  r.go({}, 100, { edit: finalEdit });
  r.idle(1500, 100, { edit: finalEdit });
  r.noErrors();
  const stale = r.of('stale');
  const refresh = r.regions('refresh');
  eq(stale.length, 1, 'one stale');
  eq(refresh.length, 1, 'one refresh');
  assert(r.events.indexOf(stale[0]) < r.events.indexOf(refresh[0]), 'stale precedes refresh');
  eq(stale[0].reason, 'in-place-change');
  const sr = refresh[0].screenRect;
  const lineScreenY = PANEL.y + line.box.y;
  assert(sr.y <= lineScreenY && sr.y + sr.h >= lineScreenY + line.box.h, `refresh ${JSON.stringify(sr)} covers line at ${lineScreenY}`);
  eq(refresh[0].image.state.edit.text, target);
  eq(r.engine.getContainers().length, 1, 'edit does not make a container');
});

await test('an overlay scrollbar fading after a scroll is not an edit; a real edit at the edge still is', () => {
  const r = rig();
  r.go();
  const thumb = { x: PANEL.x + PANEL.w - 10, y: PANEL.y + 200, w: 8, h: 240, seed: 3 };
  r.scroll('rightY', 600, 30, { overlay: thumb }); // thumb shows while scrolling
  r.idle(300, 100, { overlay: thumb });
  r.idle(1500); // and fades once scrolling stops
  r.noErrors();
  eq(r.of('stale').length, 0, `scrollbar fade treated as an edit: ${JSON.stringify(r.of('stale').map((e) => e.contentRect))}`);
  const idx = fx.allLines('right').findIndex((l) => l.kind === 'code' && l.box.y > 600 && l.box.y < 900);
  const edit = { panel: 'right', line: idx, text: 'return faq.get(key, FALLBACK)' };
  r.idle(1500, 100, { edit });
  eq(r.of('stale').length, 1, 'a real in-place edit must still refresh');
});

await test('scene change: new epoch, containers reset, fresh initial region', () => {
  const r = rig();
  r.go();
  r.scroll('rightY', 200, 40);
  r.idle(500);
  assert(r.engine.getContainers().length > 1, 'container exists before');
  r.go({ leftY: 1400, rightY: 2600 });
  r.idle(800);
  r.noErrors();
  const sc = r.of('scene-change');
  eq(sc.length, 1);
  eq(sc[0].epoch, 2);
  const after = r.events.slice(r.events.indexOf(sc[0]) + 1).filter((e) => e.type === 'region');
  assert(after.length >= 1 && after.every((e) => e.kind === 'initial' && e.epoch === 2), JSON.stringify(after.map((e) => [e.kind, e.epoch])));
  eq(after.reduce((sum, e) => sum + e.screenRect.w, 0), W, 'the new scene is captured across the full width');
  eq(after[0].image.state.rightY, 2600);
  eq(r.engine.getContainers().length, 1, 'only root remains');
});

await test('masked overlay is excluded from diffing; unmasked it is noticed', () => {
  const overlay = (seed) => ({ overlay: { x: 900, y: 500, w: 320, h: 200, seed } });
  const masked = rig();
  masked.engine.setMaskRects([{ x: 900, y: 500, w: 320, h: 200 }]);
  masked.go({}, 33, overlay(1));
  const base = masked.events.length;
  for (let i = 2; i < 30; i += 1) masked.go({}, 100, overlay(i));
  masked.idle(1500, 100, overlay(30));
  eq(masked.events.length, base, 'masked overlay animation emits nothing');
  const open = rig();
  open.go({}, 33, overlay(1));
  for (let i = 2; i < 30; i += 1) open.go({}, 100, overlay(i));
  open.idle(1500, 100, overlay(30));
  assert(open.events.length > 1, 'control: the same animation unmasked is detected');
});

await test('cropFrame failure: uncaptured + error, nothing marked covered, later recovery', () => {
  const r = rig();
  r.go();
  r.fail = true;
  r.scroll('rightY', 600, 40);
  r.idle(300);
  assert(r.of('uncaptured').length >= 1, 'uncaptured emitted');
  assert(r.of('error').some((e) => e.code === 'CROP_FAILED'), 'error emitted, not swallowed');
  eq(r.regions('scroll').length, 0, 'no band claimed');
  const c = r.container('right');
  const covered = c.covered.reduce((n, x) => n + x.h, 0);
  assert(covered <= c.screenRect.h + 1, `coverage grew while captures failed: ${covered}`);
  r.fail = false;
  r.idle(4000);
  const bands = r.regions('scroll');
  assert(bands.length >= 1, 'recovered after the capture window came back');
  const after = r.container('right');
  assertNoHoles([[0, after.screenRect.h], ...bands.map((b) => [b.contentRect.y, b.contentRect.y + b.contentRect.h])], 0, 600 + after.screenRect.h, 'recovered');
});

await test('requestRecapture: true only for visible content, re-cropped from the latest frame', () => {
  const r = rig();
  r.go();
  r.scroll('rightY', 400, 40);
  r.idle(500);
  const c = r.container('right');
  const visible = { x: c.viewport.x, y: c.viewport.y + 100, w: 300, h: 120 };
  const before = r.regions('recapture').length;
  assert(r.engine.requestRecapture({ containerId: c.id, contentRect: visible }) === true, 'visible content recaptured');
  const rec = r.regions('recapture');
  eq(rec.length, before + 1);
  eq(rec[rec.length - 1].image.state.rightY, 400);
  assert(r.engine.requestRecapture({ containerId: c.id, contentRect: { x: 0, y: 0, w: 100, h: 100 } }) === false, 'scrolled-away content is refused');
  assert(r.engine.requestRecapture({ containerId: 'nope', contentRect: visible }) === false, 'unknown container refused');
});

await test('frame refs are released once the engine no longer needs them', () => {
  const r = rig();
  r.go();
  r.scroll('rightY', 200, 40);
  r.idle(500);
  assert(r.released.length > 5, `released ${r.released.length}`);
  const before = r.regions('initial').length;
  r.engine.dispose();
  const f = fx.frame({});
  r.engine.pushFrame({ gray: f.gray, width: W, height: H, t: 99999, frameRef: f.frameRef });
  eq(r.regions('initial').length, before, 'disposed engine ignores frames');
});

await test('performance: unchanged and scrolling frames on 1280x800', () => {
  const r = rig();
  r.go();
  const still = fx.frame({});
  let t0 = performance.now();
  for (let i = 0; i < 60; i += 1) r.engine.pushFrame({ gray: still.gray, width: W, height: H, t: 5000 + i * 100, frameRef: still.frameRef });
  const unchangedAvg = (performance.now() - t0) / 60;
  const frames = [];
  for (let y = 25; y <= 1000; y += 25) frames.push(fx.frame({ rightY: y }));
  t0 = performance.now();
  frames.forEach((f, i) => r.engine.pushFrame({ gray: f.gray, width: W, height: H, t: 10000 + i * 33, frameRef: f.frameRef }));
  const scrollAvg = (performance.now() - t0) / frames.length;
  console.log(`      unchanged ${unchangedAvg.toFixed(2)} ms/frame, scrolling ${scrollAvg.toFixed(2)} ms/frame, max ${r.engine.getMetrics().maxProcessMs.toFixed(1)} ms`);
  assert(unchangedAvg < 9, `unchanged avg ${unchangedAvg}`);
  assert(scrollAvg < 75, `scrolling avg ${scrollAvg}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
