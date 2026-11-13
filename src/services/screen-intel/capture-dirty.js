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

/**
 * True when a settled in-place change swapped the area's content for other
 * content (another page, another problem) rather than editing it. A text page
 * is mostly background, so a swap changes only a modest share of all tiles;
 * what gives it away is that nearly every tile holding ink, before or after,
 * changed. Typing, appended output or a toggled widget leave most existing
 * ink as it was. Tiles of `tile` px, sampled every second pixel.
 */
function isReplacement(d, gray, width, { tile, threshold, ink, minTiles, minInkFraction }) {
  const cols = Math.floor(d.rect.w / tile);
  const rows = Math.floor(d.rect.h / tile);
  if (cols * rows < minTiles) return false;
  let inked = 0;
  let changed = 0;
  for (let ty = 0; ty < rows; ty += 1) {
    for (let tx = 0; tx < cols; tx += 1) {
      let loB = 255;
      let hiB = 0;
      let loA = 255;
      let hiA = 0;
      let diffs = 0;
      for (let y = ty * tile; y < (ty + 1) * tile; y += 2) {
        const row = (d.rect.y + y) * width + d.rect.x;
        for (let x = tx * tile; x < (tx + 1) * tile; x += 2) {
          const b = d.before[y * d.rect.w + x];
          const a = gray[row + x];
          if (b < loB) loB = b;
          if (b > hiB) hiB = b;
          if (a < loA) loA = a;
          if (a > hiA) hiA = a;
          if (a - b > threshold || b - a > threshold) diffs += 1;
        }
      }
      if (hiB - loB > ink || hiA - loA > ink) {
        inked += 1;
        if (diffs >= 2) changed += 1;
      }
    }
  }
  return inked > 0 && changed >= minInkFraction * inked;
}

module.exports = { makeDirty, mergeDirty, near, netChange, isCaretLike, isReplacement };
