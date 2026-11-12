'use strict';

const DEFAULT_IMAGE_BUDGET = 64 * 1024 * 1024;
const OVERLAY_KINDS = new Set(['stale', 'inaccessible', 'uncaptured']);
const INFLIGHT = new Set(['new', 'captured', 'analysing']);
// Statuses whose rect no longer says anything about coverage.
const DEAD = new Set(['superseded', 'cancelled']);
// Best first: when records overlap, the best status wins the cell.
const RANK = ['analysed', 'analysing', 'captured', 'new', 'stale', 'failed', 'pending', 'inaccessible'];

function bytesOf(image) {
  if (!image) return 0;
  if (image.jpeg && typeof image.jpeg.length === 'number') return image.jpeg.length;
  if (typeof image.byteLength === 'number') return image.byteLength;
  return typeof image.bytes === 'number' ? image.bytes : 0;
}

function spanOf(rect, axis) {
  if (!rect) return null;
  return axis === 'x' ? [rect.x, rect.x + rect.w] : [rect.y, rect.y + rect.h];
}

function subtract(span, masks, axis) {
  let parts = [span];
  for (const mask of masks || []) {
    const m = spanOf(mask, axis);
    parts = parts.flatMap(([a, b]) => {
      if (m[1] <= a || m[0] >= b) return [[a, b]];
      const out = [];
      if (m[0] > a) out.push([a, m[0]]);
      if (m[1] < b) out.push([m[1], b]);
      return out;
    });
  }
  return parts;
}

function createRegionLedger({ now = Date.now, imageBudgetBytes = DEFAULT_IMAGE_BUDGET } = {}) {
  const records = new Map();
  const gaps = [];
  let seq = 0;
  let useSeq = 0;
  let imageBytes = 0;

  function add(fields) {
    seq += 1;
    const record = {
      id: `r${seq}`,
      seq,
      sessionId: null,
      captureId: null,
      containerId: 'root',
      segmentId: 0,
      epoch: 0,
      kind: 'initial',
      displayId: null,
      windowId: null,
      screenRect: null,
      contentRect: null,
      overlap: { top: 0, bottom: 0, left: 0, right: 0 },
      capturedAt: now(),
      analysisStartedAt: null,
      analysedAt: null,
      durationMs: null,
      status: 'captured',
      imageRef: null,
      imageEvicted: false,
      lines: [],
      text: '',
      fingerprint: null,
      duplicateOf: null,
      overlapWith: null,
      confidence: null,
      attempts: 0,
      autoRetries: 0,
      nextRetryAt: null,
      maskRects: [],
      error: null,
      lastUsed: 0,
      ...fields,
    };
    const image = record.imageRef;
    record.imageRef = null;
    records.set(record.id, record);
    if (image) setImage(record.id, image);
    return record;
  }

  function setImage(id, image) {
    const record = records.get(id);
    if (!record) return;
    imageBytes -= bytesOf(record.imageRef);
    record.imageRef = image || null;
    record.imageEvicted = !image;
    imageBytes += bytesOf(image);
    useSeq += 1;
    record.lastUsed = useSeq;
  }

  function releaseImage(id) {
    const record = records.get(id);
    if (!record || !record.imageRef) return false;
    imageBytes -= bytesOf(record.imageRef);
    record.imageRef = null;
    record.imageEvicted = true;
    return true;
  }

  function touch(id) {
    const record = records.get(id);
    if (record) { useSeq += 1; record.lastUsed = useSeq; }
  }

  function setStatus(id, status, patch = {}) {
    const record = records.get(id);
    if (!record) return null;
    Object.assign(record, patch, { status, updatedAt: now() });
    return record;
  }

  /**
   * Evicts images LRU-first until under budget: finished regions, then failed
   * ones, then queued ones (those become 'pending' so they are never lost
   * silently). A region being analysed is never evicted. Returns ids of
   * regions turned pending so the caller can cancel their jobs.
   */
  function enforceBudget() {
    const turnedPending = [];
    const lru = (pred) => Array.from(records.values())
      .filter((r) => r.imageRef && pred(r))
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    while (imageBytes > imageBudgetBytes) {
      const done = lru((r) => !INFLIGHT.has(r.status) && r.status !== 'failed' && r.status !== 'pending');
      if (done) { releaseImage(done.id); continue; }
      const failed = lru((r) => r.status === 'failed' || r.status === 'pending');
      if (failed) { releaseImage(failed.id); continue; }
      const queued = lru((r) => r.status === 'captured' || r.status === 'new');
      if (!queued) break;
      releaseImage(queued.id);
      queued.status = 'pending';
      queued.error = { code: 'IMAGE_BUDGET', message: 'Image released under memory pressure; needs recapture.' };
      turnedPending.push(queued.id);
    }
    return turnedPending;
  }

  const all = () => Array.from(records.values());
  const list = (filter = {}) => all().filter((r) =>
    (filter.status === undefined || (Array.isArray(filter.status) ? filter.status.includes(r.status) : r.status === filter.status))
    && (filter.containerId === undefined || r.containerId === filter.containerId)
    && (filter.epoch === undefined || r.epoch === filter.epoch)
    && (filter.segmentId === undefined || r.segmentId === filter.segmentId));

  function counts(filter = {}) {
    const out = { analysed: 0, analysing: 0, captured: 0, new: 0, pending: 0, failed: 0, inaccessible: 0, stale: 0, superseded: 0, cancelled: 0 };
    for (const r of list(filter)) out[r.status] += 1;
    return out;
  }

  /**
   * Per-segment cells for one container+epoch, derived only from records.
   * Overlays (stale, inaccessible) beat older records; a newer analysed
   * record beats a stale overlay. Holes inside a segment are 'uncovered'.
   */
  function coverage(containerId, { epoch = 0, axis = 'y' } = {}) {
    const bySeg = new Map();
    for (const r of list({ containerId, epoch })) {
      if (DEAD.has(r.status) || !r.contentRect || r.contentRect.w * r.contentRect.h <= 0) continue;
      if (!bySeg.has(r.segmentId)) bySeg.set(r.segmentId, []);
      bySeg.get(r.segmentId).push(r);
    }
    const segments = [];
    for (const [id, recs] of Array.from(bySeg.entries()).sort((a, b) => a[0] - b[0])) {
      const spans = recs.flatMap((r) => subtract(spanOf(r.contentRect, axis), r.maskRects, axis).map(([a, b]) => ({ a, b, r })));
      const cuts = Array.from(new Set(spans.flatMap((s) => [s.a, s.b]))).sort((x, y) => x - y);
      const cells = [];
      for (let i = 0; i < cuts.length - 1; i += 1) {
        const [start, end] = [cuts[i], cuts[i + 1]];
        const cands = spans.filter((s) => s.a <= start && s.b >= end).map((s) => s.r);
        let cell;
        if (!cands.length) cell = { start, end, status: 'uncovered', regionId: null };
        else {
          const analysedAfter = (seqNo) => cands.some((c) => c.status === 'analysed' && c.seq > seqNo);
          const overlay = cands
            .filter((c) => OVERLAY_KINDS.has(c.kind) && !analysedAfter(c.seq) && ['stale', 'inaccessible', 'pending'].includes(c.status))
            .sort((p, q) => q.seq - p.seq)[0];
          const best = overlay || cands.slice().sort((p, q) => RANK.indexOf(p.status) - RANK.indexOf(q.status) || q.seq - p.seq)[0];
          cell = { start, end, status: best.status, regionId: best.id };
        }
        const last = cells[cells.length - 1];
        if (last && last.status === cell.status && last.regionId === cell.regionId && last.end === cell.start) last.end = cell.end;
        else cells.push(cell);
      }
      segments.push({ id, start: cuts[0], end: cuts[cuts.length - 1], cells });
    }
    return segments;
  }

  function addGap(gap) {
    const entry = { ...gap, openedAt: now(), closedAt: null };
    gaps.push(entry);
    return entry;
  }

  function openGaps(filter = {}) {
    return gaps.filter((g) => !g.closedAt && (filter.containerId === undefined || g.containerId === filter.containerId)
      && (filter.epoch === undefined || g.epoch === filter.epoch));
  }

  function closeGap(gap) { gap.closedAt = now(); }

  /** Moves every record of fromSegment into intoSegment, shifted by (dx, dy). */
  function remapSegment(containerId, epoch, fromSegment, intoSegment, dx, dy) {
    for (const r of list({ containerId, epoch, segmentId: fromSegment })) {
      r.segmentId = intoSegment;
      if (r.contentRect) r.contentRect = { ...r.contentRect, x: r.contentRect.x + dx, y: r.contentRect.y + dy };
      r.maskRects = r.maskRects.map((m) => ({ ...m, x: m.x + dx, y: m.y + dy }));
    }
  }

  /**
   * Removes records for which keep(record) is false (their images first), and
   * closed gaps of epochs no record uses any more. Returns how many records
   * were removed. Bounds memory in long sessions.
   */
  function prune(keep) {
    let removed = 0;
    for (const [id, r] of records) {
      if (keep(r)) continue;
      releaseImage(id);
      records.delete(id);
      removed += 1;
    }
    const epochs = new Set(Array.from(records.values(), (r) => r.epoch));
    for (let i = gaps.length - 1; i >= 0; i -= 1) if (!epochs.has(gaps[i].epoch)) gaps.splice(i, 1);
    return removed;
  }

  return {
    add, get: (id) => records.get(id), all, list, counts, update: setStatus, setStatus, setImage, releaseImage, touch,
    enforceBudget, coverage, addGap, openGaps, closeGap, remapSegment, prune,
    gaps: () => gaps.slice(),
    get imageBytes() { return imageBytes; },
    get size() { return records.size; },
    releaseAllImages() { for (const id of records.keys()) releaseImage(id); },
  };
}

module.exports = { createRegionLedger, bytesOf, spanOf, INFLIGHT, DEFAULT_IMAGE_BUDGET };
