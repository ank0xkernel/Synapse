'use strict';

const { contains, FLIGHT } = require('./session-geometry');

function createEventHandlers(ctx) {
  const { now, log, refresh, enqueueRecord, enforceBudget, recoverPending, supersede, normalise, cancelJobs, notifySystem } = ctx;
  const stampFor = ctx.stampFor || (() => null);
/**
 * Moves the session to a newer screen. A scene change cancels work on the
 * screen that is gone; an explicit problem switch (preserveInflight) lets it
 * finish, because that content is real and belongs to the previous problem.
 */
function adoptEpoch(epoch, { preserveInflight = false } = {}) {
  const R = ctx.run();
  if (!Number.isFinite(epoch) || epoch <= R.epoch) return;
  for (const rec of preserveInflight ? [] : R.ledger.list({}).filter((r) => r.epoch < epoch)) {
    if (FLIGHT.includes(rec.status)) {
      cancelJobs(R, rec.id);
      R.ledger.releaseImage(rec.id);
      R.ledger.setStatus(rec.id, 'cancelled', { error: { code: 'SCENE_CHANGED', message: 'Screen changed before analysis finished.' } });
    }
    const timer = R.retryTimers.get(rec.id);
    if (timer) { ctx.T.clearTimeout(timer); R.timers.delete(timer); R.retryTimers.delete(rec.id); rec.nextRetryAt = null; }
  }
  R.epoch = epoch;
  R.containers.clear();
  R.motion.clear();
  if (ctx.onEpochAdopted) ctx.onEpochAdopted(R, epoch);
}

/** A region of the screen left by an explicit problem switch, captured before the switch: kept for the previous problem. */
const lateForPreviousProblem = (R, ev) => R.lateEpoch !== undefined && ev.epoch === R.lateEpoch && Number.isFinite(ev.t) && ev.t <= R.lateUntil;

function onRegion(ev0) {
  const R = ctx.run();
  const ev = normalise(ev0);
  const late = ev.epoch < R.epoch && lateForPreviousProblem(R, ev);
  if (ev.epoch < R.epoch && !late) { R.metrics.oldEpochDropped += 1; return; }
  if (!late) adoptEpoch(ev.epoch);
  if (R.error && R.error.kind === 'engine') R.error = null;
  const t = now();
  let c = late ? null : R.containers.get(ev.containerId);
  if (late) {
    // Its panel belongs to the previous screen: no container bookkeeping here.
  } else if (!c) {
    const r = ev.contentRect;
    c = { id: ev.containerId, screenRect: ev.screenRect, axis: 'y', scroll: { x: 0, y: 0 }, segmentId: ev.segmentId, epoch: ev.epoch,
      viewport: { ...r }, extent: { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }, synthetic: true };
    R.containers.set(c.id, c);
  } else if (c.synthetic) {
    const r = ev.contentRect;
    c.viewport = { ...r };
    c.segmentId = ev.segmentId;
    c.extent = { x0: Math.min(c.extent.x0, r.x), y0: Math.min(c.extent.y0, r.y), x1: Math.max(c.extent.x1, r.x + r.w), y1: Math.max(c.extent.y1, r.y + r.h) };
  }
  const rec = R.ledger.add({
    sessionId: R.sessionId, captureId: ev.captureId, containerId: ev.containerId, segmentId: ev.segmentId, epoch: ev.epoch,
    kind: ev.kind, displayId: ev.displayId ?? R.displayId, windowId: ev.windowId ?? null, screenRect: ev.screenRect,
    contentRect: ev.contentRect, overlap: ev.overlap || { top: 0, bottom: 0, left: 0, right: 0 }, capturedAt: t,
    problemId: stampFor(R, ev.epoch),
  });
  R.frameCaptured = true;
  R.lastCaptureAt = t;
  for (const placeholder of R.ledger.list({ containerId: rec.containerId, epoch: rec.epoch, status: 'pending' })) {
    if (placeholder.kind === 'uncaptured' && contains(rec.contentRect, placeholder.contentRect)) {
      R.ledger.setStatus(placeholder.id, 'superseded');
    }
  }
  if (ev.kind === 'refresh' || ev.kind === 'recapture') supersede(R, rec, 'refresh');
  for (const mask of ev.masks || []) {
    const content = { x: mask.x - ev.screenRect.x + ev.contentRect.x, y: mask.y - ev.screenRect.y + ev.contentRect.y, w: mask.w, h: mask.h };
    rec.maskRects.push(content);
    R.ledger.add({ sessionId: R.sessionId, captureId: ev.captureId, containerId: ev.containerId, segmentId: ev.segmentId, epoch: ev.epoch,
      kind: 'inaccessible', status: 'inaccessible', displayId: rec.displayId, screenRect: mask, contentRect: content, capturedAt: t,
      error: { code: 'INACCESSIBLE', message: 'Covered by the app window.' } });
  }
  if (ev.image) {
    R.ledger.setImage(rec.id, ev.image);
    enqueueRecord(R, rec, 1);
  } else {
    R.ledger.setStatus(rec.id, 'pending', { error: { code: 'NO_IMAGE', message: 'Engine delivered a region without an image.' } });
  }
  enforceBudget(R);
  recoverPending();
  refresh();
}

function onStale(ev) {
  const R = ctx.run();
  const c = R.containers.get(ev.containerId);
  const rec = R.ledger.add({ sessionId: R.sessionId, containerId: ev.containerId, segmentId: c ? c.segmentId : 0, epoch: R.epoch, kind: 'stale',
    status: 'stale', displayId: R.displayId, contentRect: ev.contentRect, error: { code: 'STALE', message: ev.reason || 'in-place-change' } });
  supersede(R, rec, 'stale');
  recoverPending();
}

function onUncaptured(ev) {
  const R = ctx.run();
  const cid = ev.containerId || 'root';
  const c = R.containers.get(cid) || R.containers.get('root');
  const existing = R.ledger.list({ status: 'pending', epoch: R.epoch }).find((r) => r.kind === 'uncaptured' && r.containerId === cid);
  const error = { code: 'UNCAPTURED', message: ev.reason || 'uncaptured' };
  if (existing) { existing.error = error; recoverPending(); return; }
  R.ledger.add({ sessionId: R.sessionId, containerId: cid, segmentId: c ? c.segmentId : 0, epoch: R.epoch, kind: 'uncaptured', status: 'pending',
    displayId: R.displayId, contentRect: c && c.viewport ? { ...c.viewport } : { x: 0, y: 0, w: 0, h: 0 }, error });
  recoverPending();
}

function handleEngineEvent(ev) {
  const R = ctx.run();
  if (ctx.isDisposed() || !ev) return;
  if (!R.sessionId || ev.sessionId !== R.sessionId || R.stopped) { R.metrics.staleEventsDropped += 1; return; }
  // A region captured before the pause was already marked covered by the
  // engine; dropping it would lose that content silently. Only what happens
  // after the pause is ignored.
  const capturedBeforePause = ev.type === 'region' && Number.isFinite(ev.t) && R.pausedAt && ev.t < R.pausedAt;
  if ((R.paused.user || R.paused.system) && !capturedBeforePause) { R.metrics.pausedDropped += 1; return; }
  switch (ev.type) {
    case 'region': onRegion(ev); return;
    case 'container': {
      const norm = normalise(ev);
      if (norm.container.epoch < R.epoch) { R.metrics.oldEpochDropped += 1; return; }
      adoptEpoch(norm.container.epoch);
      R.containers.set(norm.container.id, { ...norm.container });
      recoverPending();
      break;
    }
    case 'motion':
      if (ev.phase === 'start') R.motion.add(ev.containerId || '*');
      else {
        R.motion.delete(ev.containerId || '*');
        if (!ev.containerId) R.motion.clear();
        recoverPending();
        if (ctx.onMotionSettled) ctx.onMotionSettled(R, ev.containerId || null);
      }
      break;
    case 'gap': R.ledger.addGap({ containerId: ev.containerId, fromSegmentId: ev.fromSegmentId, toSegmentId: ev.toSegmentId, reason: ev.reason, epoch: R.epoch }); break;
    case 'stale': onStale(ev); break;
    case 'scene-change': adoptEpoch(ev.epoch); break;
    case 'uncaptured': onUncaptured(ev); break;
    case 'error':
      if (/PERMISSION/i.test(ev.code || '')) { notifySystem('permission-revoked'); return; }
      R.error = { kind: 'engine', code: ev.code, message: ev.message };
      break;
    default: log('unknown-event', ev.type);
  }
  refresh();
}

return { adoptEpoch, handleEngineEvent };
}

module.exports = { createEventHandlers };
