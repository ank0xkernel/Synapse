'use strict';

// Vision core: turns a stream of downscaled grayscale frames into capture
// events (regions of newly revealed content, scroll containers, gaps, stale
// content). It never reads pixels beyond the frames it is given and never
// guesses a scroll shift it could not verify.

const fa = require('./frame-analysis');
const ct = require('./container-tracker');
const dt = require('./capture-dirty');
const { createPlanner } = require('./capture-plan');

const DEFAULTS = {
  tile: 16,
  diffThreshold: 12,
  minChangedPixels: 3,
  tinyTiles: 2,
  sceneFraction: 0.6,
  minConfidence: 0.6,
  minMatchedFraction: 0.8,
  minOverlapFraction: 0.25,
  minOverlapPx: 32,
  minContainerPx: 96,
  clusterGapPx: 48,
  lostChangedFraction: 0.25,
  flushFraction: 0.35,
  overlapPx: 48,
  settleMs: 250,
  inplaceSettleMs: 600,
  inplaceMaxWaitMs: 3000,
  lostMaxWaitMs: 1500,
  sceneMaxWaitMs: 1500,
  retryMs: 500,
  maxRetries: 6,
  caretMaxPixels: 80,
  caretMaxThickness: 3,
  minNetPixels: 6,
  refreshPadPx: 8,
  scrollbarMaxPx: 16,
  fastIntervalMs: 80,
  slowIntervalMs: 400,
  activeWindowMs: 1500,
};

const perf = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function createCaptureEngine({ sessionId, display, cropFrame, emit, now = Date.now, options = {}, releaseFrameRef }) {
  const opt = { ...DEFAULTS, ...options };
  const S = {
    width: display.width,
    height: display.height,
    epoch: 1,
    nextContainer: 1,
    nextSegment: 1,
    seq: 0,
    containers: new Map(),
    root: null,
    prev: null,
    latest: null,
    masks: [],
    dirty: [],
    scene: null,
    lastActivityT: 0,
    lastT: 0,
    disposed: false,
  };
  const holds = new Map();
  const metrics = {
    frames: 0, changedFrames: 0, regionsEmitted: 0, gaps: 0, errors: 0,
    lastProcessMs: 0, avgProcessMs: 0, maxProcessMs: 0, totalProcessMs: 0,
  };

  const send = (ev) => emit({ ...ev, sessionId, t: now() });
  const fail = (code, message) => {
    metrics.errors += 1;
    send({ type: 'error', code, message });
  };

  function hold(ref) {
    if (ref !== undefined && ref !== null) holds.set(ref, (holds.get(ref) || 0) + 1);
  }
  function drop(ref) {
    if (ref === undefined || ref === null || !holds.has(ref)) return;
    const n = holds.get(ref) - 1;
    if (n > 0) {
      holds.set(ref, n);
      return;
    }
    holds.delete(ref);
    if (releaseFrameRef) releaseFrameRef(ref);
  }

  const containerList = () => [...S.containers.values()].filter((c) => c !== S.root);

  function createRoot() {
    S.root = ct.createContainer({
      id: 'root',
      screenRect: { x: 0, y: 0, w: S.width, h: S.height },
      axis: 'both',
      epoch: S.epoch,
      segmentId: 0,
    });
    S.root.pendingKind = 'initial';
    S.containers.clear();
    S.containers.set('root', S.root);
  }

  function masksIn(r) {
    return S.masks.filter((m) => ct.intersect(m, r)).map((m) => ({ ...m }));
  }

  // Crops one band of a container from `frame` and records it as covered.
  // On crop failure nothing is marked covered, so it stays recoverable.
  function captureBand(c, piece, kind, frame, scroll, withMargin) {
    const view = ct.viewport(c, scroll);
    const m = withMargin ? opt.overlapPx : 0;
    const overlap = {
      left: piece.x > view.x ? Math.min(m, piece.x - view.x) : 0,
      top: piece.y > view.y ? Math.min(m, piece.y - view.y) : 0,
      right: piece.x + piece.w < view.x + view.w ? Math.min(m, view.x + view.w - piece.x - piece.w) : 0,
      bottom: piece.y + piece.h < view.y + view.h ? Math.min(m, view.y + view.h - piece.y - piece.h) : 0,
    };
    const wanted = {
      x: piece.x - overlap.left,
      y: piece.y - overlap.top,
      w: piece.w + overlap.left + overlap.right,
      h: piece.h + overlap.top + overlap.bottom,
    };
    const screenRect = fa.clampRect(ct.contentToScreen(c, wanted, scroll), S.width, S.height);
    if (screenRect.w < 1 || screenRect.h < 1) return true;
    const contentRect = ct.screenToContent(c, screenRect, scroll);
    let image;
    try {
      image = cropFrame(frame.ref, screenRect);
    } catch (error) {
      send({ type: 'uncaptured', containerId: c.id, reason: `crop-failed: ${error.message}` });
      fail('CROP_FAILED', error.message);
      return false;
    }
    const seg = ct.currentSegment(c);
    seg.covered.add(contentRect);
    seg.stale.remove(contentRect);
    metrics.regionsEmitted += 1;
    S.seq += 1;
    send({
      type: 'region',
      captureId: `${sessionId}-${S.seq}`,
      containerId: c.id,
      segmentId: c.segmentId,
      epoch: S.epoch,
      kind,
      screenRect,
      contentRect,
      overlap,
      image,
      displayId: display.id,
      maskRects: masksIn(screenRect),
    });
    return true;
  }

  function flushPieces(c, pieces, kind, frame, scroll, t) {
    let ok = true;
    const seg = ct.currentSegment(c);
    for (const piece of pieces) {
      const refresh = seg.stale.intersects(piece);
      // Initial pieces tile the frame along panel dividers; a margin would pull
      // half-cut text from the neighbouring panel into the crop.
      const done = captureBand(c, piece, refresh ? 'refresh' : kind, frame, scroll, !refresh && kind !== 'initial');
      ok = ok && done;
    }
    if (ok) {
      c.retry = null;
    } else {
      const n = (c.retry ? c.retry.n : 0) + (c.inRetry ? 1 : 0);
      if (n > opt.maxRetries) {
        c.retry = null;
        send({ type: 'uncaptured', containerId: c.id, reason: 'retry-exhausted' });
      } else {
        c.retry = { n, at: t + opt.retryMs * 2 ** n };
      }
    }
    return ok;
  }

  function splitAtDividers(pieces, frame) {
    const cuts = fa.findColumnDividers(frame.gray, S.width, S.height);
    return pieces.flatMap((p) => {
      const xs = [p.x, ...cuts.filter((x) => x > p.x && x < p.x + p.w), p.x + p.w];
      return xs.slice(1).map((x1, i) => ({ x: xs[i], y: p.y, w: x1 - xs[i], h: p.h }));
    });
  }

  function flushUncovered(c, frame, scroll, t) {
    let pieces = ct.currentSegment(c).covered.uncovered(ct.viewport(c, scroll));
    if (c === S.root) {
      for (const other of containerList()) pieces = pieces.flatMap((p) => ct.subtractRect(p, other.screenRect));
    }
    if (!pieces.length) {
      c.retry = null;
      return true;
    }
    if (c === S.root && c.pendingKind === 'initial') pieces = splitAtDividers(pieces, frame);
    return flushPieces(c, pieces, c.pendingKind || 'scroll', frame, scroll, t) && ((c.pendingKind = null), true);
  }

  // Overlay scrollbars fade in and out along a panel's right or bottom edge
  // after scrolling. That is not a content edit; refreshing it would re-read
  // a band of text that has not changed.
  function isScrollbarStrip(bbox, rect) {
    const max = opt.scrollbarMaxPx;
    const vertical = bbox.w <= max && bbox.x >= rect.x + rect.w - max - 4;
    const horizontal = bbox.h <= max && bbox.y >= rect.y + rect.h - max - 4;
    return vertical || horizontal;
  }

  function finalizeDirty(d, frame, t) {
    S.dirty = S.dirty.filter((x) => x !== d);
    const c = S.containers.get(d.cid);
    if (!c || c.lost) return;
    // A root change counts only outside the scroll panels: panel pixels move
    // with the panel and are handled by it (its edge is rarely tile-aligned).
    const skip = c === S.root ? containerList().map((o) => o.screenRect) : [];
    const net = dt.netChange(d, frame.gray, S.width, opt.diffThreshold, skip);
    if (dt.isCaretLike(net, opt) || isScrollbarStrip(net.bbox, c.screenRect)) return;
    const pad = opt.refreshPadPx;
    const band = fa.clampRect({ x: c.screenRect.x, y: net.bbox.y - pad, w: c.screenRect.w, h: net.bbox.h + 2 * pad }, S.width, S.height);
    const area = ct.intersect(band, c.screenRect);
    if (!area) return;
    const contentRect = ct.screenToContent(c, area);
    const seg = ct.currentSegment(c);
    seg.covered.remove(contentRect);
    seg.stale.add(contentRect);
    send({ type: 'stale', containerId: c.id, contentRect, reason: 'in-place-change' });
    flushPieces(c, [contentRect], 'refresh', frame, c.scroll, t);
  }

  function finalizeDirtyOf(cid, frame, t) {
    for (const d of S.dirty.filter((x) => x.cid === cid)) finalizeDirty(d, frame, t);
  }

  function addDirty(c, rect, t) {
    const clipped = ct.intersect(rect, c.screenRect);
    if (!clipped) return;
    const gap = opt.tile;
    const existing = S.dirty.find((d) => d.cid === c.id && dt.near(d.rect, clipped, gap));
    if (existing) dt.mergeDirty(existing, clipped, S.prev.gray, S.width, t);
    else S.dirty.push(dt.makeDirty(c.id, clipped, S.prev.gray, S.width, t));
  }

  const { planFrame } = createPlanner(S, opt, containerList);

  function announce(c) {
    send({ type: 'container', container: ct.snapshot(c) });
  }

  function applyShift(c, est, frame, t) {
    finalizeDirtyOf(c.id, S.prev, t);
    const prevScroll = { ...c.scroll };
    const prevView = ct.viewport(c, prevScroll);
    if (c.axis !== 'both' && c.axis !== est.axis) c.axis = 'both';
    c.scroll[est.axis] += est.shift;
    const view = ct.viewport(c);
    if (!c.moving) {
      c.moving = true;
      send({ type: 'motion', phase: 'start', containerId: c.id });
    }
    c.lastMoveT = t;
    const seg = ct.currentSegment(c);
    const leaving = seg.covered.uncovered(prevView).some((p) => ct.subtractRect(p, view).length > 0);
    if (leaving) flushUncovered(c, S.prev, prevScroll, t);
    ct.updateExtent(c);
    announce(c);
    const uncovered = seg.covered.uncovered(view).reduce((n, p) => n + ct.area(p), 0);
    if (uncovered >= opt.flushFraction * ct.area(view)) flushUncovered(c, frame, c.scroll, t);
  }

  /**
   * How far a panel scrolled between a dirty record's baseline (the frame
   * before its first change) and the previous frame, measured on real pixels.
   * Null when that cannot be trusted.
   */
  function scrollSinceBaseline(d, rect, axis) {
    const area = ct.intersect(d.rect, rect);
    if (!area) return null;
    const base = S.prev.gray.slice();
    for (let y = 0; y < d.rect.h; y += 1) base.set(d.before.subarray(y * d.rect.w, (y + 1) * d.rect.w), (d.rect.y + y) * S.width + d.rect.x);
    // Outside the dirty rect nothing changed since the baseline, so `base`
    // is a faithful baseline over the whole panel; measuring over the panel
    // (not just the dirty part) keeps enough overlap for larger jumps.
    const est = fa.estimateShift(base, S.prev.gray, S.width, S.height, rect, {
      axis, minOverlapFraction: opt.minOverlapFraction, minOverlapPx: opt.minOverlapPx,
    });
    return est && est.confidence >= opt.minConfidence && est.matchedFraction >= opt.minMatchedFraction ? est.shift : null;
  }

  function newContainer(action, frame, t) {
    // Scroll that happened before the panel was recognised, if measurable.
    let carried = 0;
    let measurable = true;
    for (const d of S.dirty.filter((x) => x.cid === 'root' && ct.intersect(x.rect, action.rect))) {
      if (ct.area(ct.intersect(d.rect, action.rect)) >= 0.8 * ct.area(d.rect)) {
        // Frames that changed here before the panel was recognised were its
        // scrolling, not an edit. Refreshing them would replace the earlier
        // full-screen text with an already-scrolled view and lose what was
        // between. When the scroll since then is measurable, the panel
        // continues from the root capture; otherwise the earlier text stays
        // and the panel is captured fresh, because its offset is unknown.
        S.dirty = S.dirty.filter((x) => x !== d);
        const since = measurable ? scrollSinceBaseline(d, action.rect, action.est.axis) : null;
        if (since === null || (carried && since !== carried)) measurable = false;
        else carried = since;
      } else {
        finalizeDirty(d, S.prev, t);
      }
    }
    if (!measurable) {
      carried = 0;
      ct.currentSegment(S.root).covered.remove(action.rect);
    }
    const id = `c${S.nextContainer}`;
    S.nextContainer += 1;
    const c = ct.createContainer({
      id,
      screenRect: action.rect,
      axis: action.est.axis,
      epoch: S.epoch,
      segmentId: S.nextSegment,
    });
    S.nextSegment += 1;
    // Content coordinates count from the root capture, so root coverage maps
    // straight in and the carried scroll places the current view after it.
    c.scroll[action.est.axis === 'x' ? 'x' : 'y'] = carried;
    ct.seedFromRoot(c, ct.currentSegment(S.root).covered);
    S.containers.set(id, c);
    announce(c);
    applyShift(c, action.est, frame, t);
  }

  function startLost(c, t) {
    flushUncovered(c, S.prev, c.scroll, t);
    finalizeDirtyOf(c.id, S.prev, t);
    c.lost = { startT: t, lastChangeT: t, fromSegment: c.segmentId };
    if (!c.moving) {
      c.moving = true;
      send({ type: 'motion', phase: 'start', containerId: c.id });
    }
  }

  function resolveLost(c, frame, t) {
    const from = c.lost.fromSegment;
    c.lost = null;
    S.dirty = S.dirty.filter((d) => d.cid !== c.id);
    ct.startSegment(c, S.nextSegment);
    S.nextSegment += 1;
    metrics.gaps += 1;
    send({ type: 'gap', containerId: c.id, fromSegmentId: from, toSegmentId: c.segmentId, reason: 'fast-scroll' });
    announce(c);
    flushUncovered(c, frame, c.scroll, t);
    c.moving = false;
    send({ type: 'motion', phase: 'settled', containerId: c.id });
  }

  function startScene(t) {
    S.epoch += 1;
    S.dirty = [];
    createRoot();
    S.scene = { startT: t, lastT: t };
    send({ type: 'scene-change', epoch: S.epoch });
  }

  function runTimers(frame, t) {
    for (const c of [...S.containers.values()]) {
      if (c.lost) {
        if (t - c.lost.lastChangeT >= opt.settleMs || t - c.lost.startT >= opt.lostMaxWaitMs) resolveLost(c, frame, t);
      } else if (c.moving && t - c.lastMoveT >= opt.settleMs) {
        c.moving = false;
        send({ type: 'motion', phase: 'settled', containerId: c.id });
        flushUncovered(c, frame, c.scroll, t);
      } else if (!c.moving && c.retry && t >= c.retry.at) {
        c.inRetry = true;
        flushUncovered(c, frame, c.scroll, t);
        c.inRetry = false;
      } else if (c === S.root && c.pendingKind && !c.retry && !S.scene) {
        flushUncovered(c, frame, c.scroll, t);
      }
    }
    for (const d of [...S.dirty]) {
      if (t - d.lastT >= opt.inplaceSettleMs || t - d.firstT >= opt.inplaceMaxWaitMs) finalizeDirty(d, frame, t);
    }
  }

  function execute(plan, frame, t) {
    for (const a of plan.actions) {
      if (a.type === 'shift') applyShift(a.c, a.est, frame, t);
      else if (a.type === 'new-container') newContainer(a, frame, t);
      else if (a.type === 'lost') startLost(a.c, t);
      else if (a.type === 'lost-touch') a.c.lost.lastChangeT = t;
      else if (a.type === 'dirty') for (const comp of a.comps) addDirty(a.c, comp, t);
    }
  }

  function storePrev(frame) {
    if (!S.prev) S.prev = { gray: new Uint8Array(frame.gray.length), ref: null };
    S.prev.gray.set(frame.gray);
    hold(frame.ref);
    drop(S.prev.ref);
    S.prev.ref = frame.ref;
  }

  function process(frame, t) {
    const dims = frame.width !== S.width || frame.height !== S.height;
    if (dims) {
      S.width = frame.width;
      S.height = frame.height;
      S.prev = null;
    }
    if (!S.prev) {
      if (dims && S.root) S.epoch += 1;
      S.dirty = [];
      createRoot();
      storePrev(frame);
      S.lastActivityT = t;
      flushUncovered(S.root, frame, S.root.scroll, t);
      return;
    }
    const diff = fa.diffTiles(S.prev.gray, frame.gray, S.width, S.height, {
      tile: opt.tile,
      threshold: opt.diffThreshold,
      minChangedPixels: opt.minChangedPixels,
      maskRects: S.masks,
    });
    if (diff.changedCount) {
      metrics.changedFrames += 1;
      S.lastActivityT = t;
      if (S.scene) {
        S.scene.lastT = t;
      } else {
        const plan = planFrame(frame, diff);
        if (plan.unexplained / Math.max(1, diff.evaluatedTiles) >= opt.sceneFraction) startScene(t);
        else execute(plan, frame, t);
      }
      storePrev(frame);
    }
    if (S.scene && (t - S.scene.lastT >= opt.settleMs || t - S.scene.startT >= opt.sceneMaxWaitMs)) {
      S.scene = null;
    }
    if (!S.scene) runTimers(frame, t);
  }

  function pushFrame(frame) {
    if (S.disposed) return;
    const t0 = perf();
    const t = frame.t === undefined ? now() : frame.t;
    S.lastT = t;
    metrics.frames += 1;
    hold(frame.frameRef);
    drop(S.latest && S.latest.ref);
    S.latest = { ref: frame.frameRef, gray: frame.gray };
    if (!frame.gray || frame.gray.length !== frame.width * frame.height) {
      fail('BAD_FRAME', 'gray length does not match width*height');
      return;
    }
    try {
      process({ gray: frame.gray, width: frame.width, height: frame.height, ref: frame.frameRef }, t);
    } catch (error) {
      fail('ENGINE_ERROR', error && error.stack ? error.stack : String(error));
    }
    const ms = perf() - t0;
    metrics.lastProcessMs = ms;
    metrics.totalProcessMs += ms;
    metrics.avgProcessMs = metrics.totalProcessMs / metrics.frames;
    if (ms > metrics.maxProcessMs) metrics.maxProcessMs = ms;
  }

  function requestRecapture({ containerId, contentRect }) {
    const c = S.containers.get(containerId);
    if (!c || c.lost || !S.latest || S.latest.ref === undefined) return false;
    if (!ct.contains(ct.viewport(c), contentRect)) return false;
    return captureBand(c, contentRect, 'recapture', S.latest, c.scroll, false);
  }

  function nextIntervalMs() {
    const busy = S.scene || S.dirty.length || containerList().some((c) => c.moving || c.lost || c.retry);
    if (busy || S.lastT - S.lastActivityT < opt.activeWindowMs) return opt.fastIntervalMs;
    return opt.slowIntervalMs;
  }

  function reset() {
    for (const ref of [...holds.keys()]) {
      holds.delete(ref);
      if (releaseFrameRef) releaseFrameRef(ref);
    }
    S.prev = null;
    S.latest = null;
    S.dirty = [];
    S.scene = null;
    S.epoch += 1;
    S.containers.clear();
    S.root = null;
  }

  return {
    pushFrame,
    setMaskRects(rects) {
      S.masks = (rects || []).map((r) => ({ ...r }));
    },
    requestRecapture,
    getContainers: () => [...S.containers.values()].map(ct.snapshot),
    getMetrics: () => ({ ...metrics, containers: containerList().length, pendingDirty: S.dirty.length, epoch: S.epoch }),
    nextIntervalMs,
    reset,
    dispose() {
      reset();
      S.disposed = true;
    },
  };
}

module.exports = { createCaptureEngine, DEFAULTS };
