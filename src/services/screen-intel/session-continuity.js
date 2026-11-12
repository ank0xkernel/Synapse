'use strict';

const { mapLines } = require('./context-lines');
const { detectSegmentMerge } = require('./context-builder');
const { intersects, contains, intersection, FLIGHT } = require('./session-geometry');

function createContinuity({ getRun, cancelJobs, toPending, remapCuts = () => {} }) {
function tryMerge(run, rec) {
  for (const gap of run.ledger.openGaps({ containerId: rec.containerId, epoch: rec.epoch })) {
    if (gap.toSegmentId !== rec.segmentId) continue;
    const lines = (seg) => run.ledger.list({ containerId: rec.containerId, epoch: rec.epoch, segmentId: seg, status: 'analysed' })
      .filter((r) => !r.duplicateOf).flatMap(mapLines);
    const merge = detectSegmentMerge(lines(gap.fromSegmentId), lines(gap.toSegmentId));
    if (!merge) continue;
    const c = run.containers.get(rec.containerId);
    const axis = c && c.axis === 'x' ? 'x' : 'y';
    const dx = axis === 'x' ? merge.offset.x : 0;
    const dy = axis === 'x' ? 0 : merge.offset.y;
    run.ledger.remapSegment(rec.containerId, rec.epoch, gap.toSegmentId, gap.fromSegmentId, dx, dy);
    remapCuts(run, rec.containerId, rec.epoch, gap.toSegmentId, gap.fromSegmentId, axis === 'x' ? dx : dy);
    run.aliases.set(`${rec.containerId}:${rec.epoch}:${gap.toSegmentId}`, { to: gap.fromSegmentId, dx, dy });
    run.ledger.closeGap(gap);
    if (c && c.segmentId === gap.toSegmentId) Object.assign(c, shiftContainer(c, gap.fromSegmentId, dx, dy));
  }
}

function shiftContainer(c, segmentId, dx, dy) {
  const mv = (r) => (r ? { ...r, x: r.x + dx, y: r.y + dy } : r);
  return {
    segmentId, viewport: mv(c.viewport),
    extent: c.extent ? { x0: c.extent.x0 + dx, y0: c.extent.y0 + dy, x1: c.extent.x1 + dx, y1: c.extent.y1 + dy } : c.extent,
  };
}

function normalise(ev) {
  const a = getRun().aliases.get(`${ev.containerId || (ev.container && ev.container.id)}:${ev.epoch ?? (ev.container && ev.container.epoch)}:${ev.segmentId ?? (ev.container && ev.container.segmentId)}`);
  if (!a) return ev;
  const mv = (r) => (r ? { ...r, x: r.x + a.dx, y: r.y + a.dy } : r);
  if (ev.type === 'region') return { ...ev, segmentId: a.to, contentRect: mv(ev.contentRect) };
  return { ...ev, container: { ...ev.container, ...shiftContainer(ev.container, a.to, a.dx, a.dy) } };
}

/** Newer content replaces older content for the same rect and cancels obsolete work. */
function supersede(run, fresh, mode) {
  for (const old of run.ledger.list({ containerId: fresh.containerId, epoch: fresh.epoch, segmentId: fresh.segmentId })) {
    if (old.id === fresh.id || old.seq > fresh.seq || old.status === 'superseded' || old.status === 'cancelled' || old.kind === 'inaccessible') continue;
    if (!old.contentRect || !intersects(old.contentRect, fresh.contentRect)) continue;
    const inflight = FLIGHT.includes(old.status);
    if (contains(fresh.contentRect, old.contentRect)) {
      if (inflight) cancelJobs(run, old.id);
      run.ledger.releaseImage(old.id);
      run.ledger.setStatus(old.id, 'superseded', { nextRetryAt: null, supersededBy: fresh.id });
    } else if (mode === 'stale' && inflight) {
      cancelJobs(run, old.id);
      toPending(run, old, 'INVALIDATED', 'Content changed while it was being analysed; needs recapture.');
    } else {
      old.maskRects = [...old.maskRects, intersection(old.contentRect, fresh.contentRect)];
    }
  }
}

return { tryMerge, shiftContainer, normalise, supersede };
}

module.exports = { createContinuity };
