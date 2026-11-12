'use strict';

// In-place change tracking: a dirty record keeps the pixels as they were before
// the first change, so a settled region can be compared with what was last
// captured (a caret blink returns to baseline; typing does not).

const ct = require('./container-tracker');

function cropPatch(gray, width, r) {
  const out = new Uint8Array(r.w * r.h);
  for (let y = 0; y < r.h; y += 1) {
    const src = (r.y + y) * width + r.x;
    out.set(gray.subarray(src, src + r.w), y * r.w);
  }
  return out;
}

function makeDirty(cid, rect, prevGray, width, t) {
  return { cid, rect: { ...rect }, before: cropPatch(prevGray, width, rect), firstT: t, lastT: t };
}

function near(a, b, gap) {
  return ct.intersect({ x: a.x - gap, y: a.y - gap, w: a.w + 2 * gap, h: a.h + 2 * gap }, b) !== null;
}

function mergeDirty(d, rect, prevGray, width, t) {
  const union = ct.unionRect(d.rect, rect);
  const before = cropPatch(prevGray, width, union);
  for (let y = 0; y < d.rect.h; y += 1) {
    const dst = (d.rect.y - union.y + y) * union.w + (d.rect.x - union.x);
    before.set(d.before.subarray(y * d.rect.w, (y + 1) * d.rect.w), dst);
  }
  d.rect = union;
  d.before = before;
  d.lastT = t;
}

// Net difference between the baseline patch and the current pixels.
// skip: rects (screen coords) whose pixels belong to someone else (a scroll
// panel inside the root) and must not count as a change of this region.
function netChange(d, gray, width, threshold, skip = []) {
  let count = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < d.rect.h; y += 1) {
    const row = (d.rect.y + y) * width + d.rect.x;
    const sy = d.rect.y + y;
    const rowSkip = skip.filter((r) => sy >= r.y && sy < r.y + r.h);
    for (let x = 0; x < d.rect.w; x += 1) {
      if (rowSkip.length && rowSkip.some((r) => d.rect.x + x >= r.x && d.rect.x + x < r.x + r.w)) continue;
      const diff = gray[row + x] - d.before[y * d.rect.w + x];
      if (diff > threshold || diff < -threshold) {
        count += 1;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (!count) return { count: 0, bbox: null };
  return { count, bbox: { x: d.rect.x + x0, y: d.rect.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
}

// A thin, small net change is a text caret, not an edit.
function isCaretLike(net, opts) {
  if (!net.bbox) return true;
  if (net.count < opts.minNetPixels) return true;
  return net.count <= opts.caretMaxPixels && (net.bbox.w <= opts.caretMaxThickness || net.bbox.h <= opts.caretMaxThickness);
}

module.exports = { makeDirty, mergeDirty, near, netChange, isCaretLike };
