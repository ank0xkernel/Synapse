'use strict';

// Content-space bookkeeping for scroll containers. Content coordinates map to
// screen as: screen = origin + content - scroll. Coordinates are only
// comparable inside one segment; a gap starts a new segment.

function area(r) {
  return r.w > 0 && r.h > 0 ? r.w * r.h : 0;
}

function intersect(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

function unionRect(a, b) {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}

function iou(a, b) {
  const i = intersect(a, b);
  if (!i) return 0;
  const ia = area(i);
  return ia / (area(a) + area(b) - ia);
}

function subtractRect(a, b) {
  const i = intersect(a, b);
  if (!i) return [{ ...a }];
  const out = [];
  if (i.y > a.y) out.push({ x: a.x, y: a.y, w: a.w, h: i.y - a.y });
  if (i.y + i.h < a.y + a.h) out.push({ x: a.x, y: i.y + i.h, w: a.w, h: a.y + a.h - (i.y + i.h) });
  if (i.x > a.x) out.push({ x: a.x, y: i.y, w: i.x - a.x, h: i.h });
  if (i.x + i.w < a.x + a.w) out.push({ x: i.x + i.w, y: i.y, w: a.x + a.w - (i.x + i.w), h: i.h });
  return out;
}

function contains(a, b) {
  return b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
}

function tryMerge(a, b) {
  if (contains(a, b)) return a;
  if (contains(b, a)) return b;
  if (a.x === b.x && a.w === b.w && a.y <= b.y + b.h && b.y <= a.y + a.h) return unionRect(a, b);
  if (a.y === b.y && a.h === b.h && a.x <= b.x + b.w && b.x <= a.x + a.w) return unionRect(a, b);
  return null;
}

function mergeAdjacent(input) {
  const rects = input.filter((r) => area(r) > 0).map((r) => ({ ...r }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < rects.length && !merged; i += 1) {
      for (let j = i + 1; j < rects.length && !merged; j += 1) {
        const m = tryMerge(rects[i], rects[j]);
        if (m) {
          rects[i] = { ...m };
          rects.splice(j, 1);
          merged = true;
        }
      }
    }
  }
  return rects;
}

class RectSet {
  constructor() {
    this.rects = [];
  }

  add(r) {
    this.rects = mergeAdjacent(this.rects.concat([r]));
  }

  remove(r) {
    this.rects = mergeAdjacent(this.rects.flatMap((c) => subtractRect(c, r)));
  }

  uncovered(view) {
    let pieces = [{ ...view }];
    for (const c of this.rects) pieces = pieces.flatMap((p) => subtractRect(p, c));
    return mergeAdjacent(pieces);
  }

  clipped(r) {
    return this.rects.map((c) => intersect(c, r)).filter(Boolean);
  }

  intersects(r) {
    return this.rects.some((c) => intersect(c, r));
  }

  clear() {
    this.rects = [];
  }
}

function createContainer({ id, screenRect, axis, epoch, segmentId }) {
  return {
    id,
    screenRect: { ...screenRect },
    origin: { x: screenRect.x, y: screenRect.y },
    axis,
    scroll: { x: 0, y: 0 },
    epoch,
    segmentId,
    segments: [{ id: segmentId, covered: new RectSet(), stale: new RectSet() }],
    extent: null,
    moving: false,
    lastMoveT: 0,
    lost: null,
    retry: null,
  };
}

function currentSegment(c) {
  return c.segments[c.segments.length - 1];
}

function viewport(c, scroll = c.scroll) {
  return {
    x: scroll.x + c.screenRect.x - c.origin.x,
    y: scroll.y + c.screenRect.y - c.origin.y,
    w: c.screenRect.w,
    h: c.screenRect.h,
  };
}

function contentToScreen(c, r, scroll = c.scroll) {
  return { x: r.x - scroll.x + c.origin.x, y: r.y - scroll.y + c.origin.y, w: r.w, h: r.h };
}

function screenToContent(c, r, scroll = c.scroll) {
  return { x: r.x + scroll.x - c.origin.x, y: r.y + scroll.y - c.origin.y, w: r.w, h: r.h };
}

function updateExtent(c) {
  const v = viewport(c);
  c.extent = c.extent
    ? {
        x0: Math.min(c.extent.x0, v.x),
        y0: Math.min(c.extent.y0, v.y),
        x1: Math.max(c.extent.x1, v.x + v.w),
        y1: Math.max(c.extent.y1, v.y + v.h),
      }
    : { x0: v.x, y0: v.y, x1: v.x + v.w, y1: v.y + v.h };
}

function startSegment(c, segmentId) {
  c.segmentId = segmentId;
  c.segments.push({ id: segmentId, covered: new RectSet(), stale: new RectSet() });
  c.extent = null;
  updateExtent(c);
}

// The part of a new container already captured by the root coverage is not new.
// Root coverage inside the container's rect is handed over to the container.
function seedFromRoot(c, rootCovered) {
  const seg = currentSegment(c);
  for (const r of rootCovered.clipped(c.screenRect)) seg.covered.add(screenToContent(c, r, { x: 0, y: 0 }));
  rootCovered.remove(c.screenRect);
  updateExtent(c);
}

function matchContainer(containers, rect, minShare = 0.5) {
  let best = null;
  let bestShare = 0;
  const rectArea = area(rect);
  for (const c of containers) {
    const i = intersect(c.screenRect, rect);
    if (!i) continue;
    const share = Math.max(area(i) / rectArea, iou(c.screenRect, rect));
    if (share >= minShare && share > bestShare) {
      best = c;
      bestShare = share;
    }
  }
  return best;
}

function snapshot(c) {
  return {
    id: c.id,
    screenRect: { ...c.screenRect },
    origin: { ...c.origin },
    axis: c.axis,
    scroll: { ...c.scroll },
    segmentId: c.segmentId,
    epoch: c.epoch,
    viewport: viewport(c),
    extent: c.extent ? { ...c.extent } : null,
    covered: currentSegment(c).covered.rects.map((r) => ({ ...r })),
    stale: currentSegment(c).stale.rects.map((r) => ({ ...r })),
    moving: c.moving,
    lost: Boolean(c.lost),
  };
}

module.exports = {
  area,
  intersect,
  unionRect,
  iou,
  subtractRect,
  contains,
  mergeAdjacent,
  RectSet,
  createContainer,
  currentSegment,
  viewport,
  contentToScreen,
  screenToContent,
  updateExtent,
  startSegment,
  seedFromRoot,
  matchContainer,
  snapshot,
};
