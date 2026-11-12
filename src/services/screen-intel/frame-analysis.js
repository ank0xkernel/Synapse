'use strict';

// Pure grayscale frame analysis: tile diffing and scroll-shift estimation.
// No dependencies; runs in plain Node and in an Electron preload.

const INK_THRESHOLD = 40;
const MATCH_TOLERANCE = 28;
const MIN_INK_SAMPLES = 40;

function toGray(rgba, width, height, out) {
  const n = width * height;
  const gray = out && out.length === n ? out : new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i += 1, p += 4) {
    gray[i] = (rgba[p] * 77 + rgba[p + 1] * 151 + rgba[p + 2] * 28) >> 8;
  }
  return gray;
}

function maskedTiles(maskRects, cols, rows, tile) {
  const flags = new Uint8Array(cols * rows);
  for (const m of maskRects) {
    const tx0 = Math.max(0, Math.floor(m.x / tile));
    const ty0 = Math.max(0, Math.floor(m.y / tile));
    const tx1 = Math.min(cols - 1, Math.floor((m.x + m.w - 1) / tile));
    const ty1 = Math.min(rows - 1, Math.floor((m.y + m.h - 1) / tile));
    for (let ty = ty0; ty <= ty1; ty += 1) {
      for (let tx = tx0; tx <= tx1; tx += 1) flags[ty * cols + tx] = 1;
    }
  }
  return flags;
}

function tileComponents(changed, cols, rows, tile, width, height) {
  const seen = new Uint8Array(changed.length);
  const rects = [];
  const stack = [];
  for (let start = 0; start < changed.length; start += 1) {
    if (!changed[start] || seen[start]) continue;
    let minX = cols;
    let minY = rows;
    let maxX = -1;
    let maxY = -1;
    let tiles = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const idx = stack.pop();
      const tx = idx % cols;
      const ty = (idx - tx) / cols;
      tiles += 1;
      if (tx < minX) minX = tx;
      if (tx > maxX) maxX = tx;
      if (ty < minY) minY = ty;
      if (ty > maxY) maxY = ty;
      const neighbours = [
        tx > 0 ? idx - 1 : -1,
        tx < cols - 1 ? idx + 1 : -1,
        ty > 0 ? idx - cols : -1,
        ty < rows - 1 ? idx + cols : -1,
      ];
      for (const nb of neighbours) {
        if (nb >= 0 && changed[nb] && !seen[nb]) {
          seen[nb] = 1;
          stack.push(nb);
        }
      }
    }
    const x = minX * tile;
    const y = minY * tile;
    rects.push({
      x,
      y,
      w: Math.min(width, (maxX + 1) * tile) - x,
      h: Math.min(height, (maxY + 1) * tile) - y,
      tiles,
    });
  }
  return rects;
}

function diffTiles(prev, curr, width, height, options = {}) {
  const tile = options.tile || 16;
  const threshold = options.threshold === undefined ? 12 : options.threshold;
  const minChanged = options.minChangedPixels === undefined ? 3 : options.minChangedPixels;
  const maskRects = options.maskRects || [];
  const cols = Math.ceil(width / tile);
  const rows = Math.ceil(height / tile);
  const changed = new Uint8Array(cols * rows);
  const masked = maskRects.length ? maskedTiles(maskRects, cols, rows, tile) : null;
  let changedCount = 0;
  let evaluated = 0;
  for (let ty = 0; ty < rows; ty += 1) {
    const y0 = ty * tile;
    const y1 = Math.min(height, y0 + tile);
    for (let tx = 0; tx < cols; tx += 1) {
      const idx = ty * cols + tx;
      if (masked && masked[idx]) continue;
      evaluated += 1;
      const x0 = tx * tile;
      const x1 = Math.min(width, x0 + tile);
      let count = 0;
      for (let y = y0; y < y1 && count < minChanged; y += 1) {
        const row = y * width;
        for (let x = x0; x < x1; x += 1) {
          const d = curr[row + x] - prev[row + x];
          if (d > threshold || d < -threshold) count += 1;
        }
      }
      if (count >= minChanged) {
        changed[idx] = 1;
        changedCount += 1;
      }
    }
  }
  return {
    cols,
    rows,
    tile,
    changed,
    changedCount,
    evaluatedTiles: evaluated,
    changedFraction: evaluated ? changedCount / evaluated : 0,
    rects: changedCount ? tileComponents(changed, cols, rows, tile, width, height) : [],
  };
}

function backgroundLevel(buf, width, r) {
  const hist = new Uint32Array(64);
  for (let y = r.y; y < r.y + r.h; y += 3) {
    const row = y * width;
    for (let x = r.x; x < r.x + r.w; x += 3) hist[buf[row + x] >> 2] += 1;
  }
  let best = 0;
  for (let i = 1; i < 64; i += 1) if (hist[i] > hist[best]) best = i;
  return best * 4 + 2;
}

function buildProfile(buf, width, r, vertical, length, cross, bands) {
  const out = new Float32Array(bands * length);
  const alongStep = vertical ? width : 1;
  const crossStep = vertical ? 1 : width;
  const base = r.y * width + r.x;
  for (let b = 0; b < bands; b += 1) {
    const c0 = Math.floor((b * cross) / bands);
    const c1 = Math.floor(((b + 1) * cross) / bands);
    const samples = Math.max(1, Math.ceil((c1 - c0) / 2));
    for (let i = 0; i < length; i += 1) {
      let sum = 0;
      let p = base + i * alongStep + c0 * crossStep;
      for (let c = c0; c < c1; c += 2) {
        sum += buf[p];
        p += 2 * crossStep;
      }
      out[b * length + i] = sum / samples;
    }
  }
  return out;
}

// Normalised profile SAD for every candidate shift. curr[i] ~ prev[i + s].
function profileCosts(pc, pp, length, bands, maxShift, bg) {
  const energyC = new Float64Array(length + 1);
  const energyP = new Float64Array(length + 1);
  for (let i = 0; i < length; i += 1) {
    let ec = 0;
    let ep = 0;
    for (let b = 0; b < bands; b += 1) {
      ec += Math.abs(pc[b * length + i] - bg);
      ep += Math.abs(pp[b * length + i] - bg);
    }
    energyC[i + 1] = energyC[i] + ec;
    energyP[i + 1] = energyP[i] + ep;
  }
  const costs = new Float64Array(2 * maxShift + 1);
  for (let s = -maxShift; s <= maxShift; s += 1) {
    const i0 = Math.max(0, -s);
    const i1 = Math.min(length, length - s);
    let sum = 0;
    let n = 0;
    for (let b = 0; b < bands; b += 1) {
      const ob = b * length;
      for (let i = i0; i < i1; i += 2) {
        sum += Math.abs(pc[ob + i] - pp[ob + i + s]);
        n += 1;
      }
    }
    if (!n) {
      costs[s + maxShift] = Infinity;
      continue;
    }
    const span = (i1 - i0) * bands;
    const energy = (energyC[i1] - energyC[i0] + energyP[i1 + s] - energyP[i0 + s]) / (2 * span);
    costs[s + maxShift] = sum / n / (2 + energy);
  }
  return costs;
}

function pickCandidates(costs, maxShift, count) {
  const order = [];
  for (let i = 0; i < costs.length; i += 1) if (Number.isFinite(costs[i])) order.push(i);
  order.sort((a, b) => costs[a] - costs[b]);
  const picked = [];
  for (const idx of order) {
    const s = idx - maxShift;
    if (picked.every((p) => Math.abs(p - s) >= 3)) picked.push(s);
    if (picked.length >= count) break;
  }
  if (!picked.some((p) => Math.abs(p) < 3)) picked.push(0);
  return picked;
}

// Pixel-level check of shift s over the overlap, restricted to "ink" pixels so
// large flat areas cannot make a wrong shift look good.
function verifyShift(prev, curr, width, r, vertical, length, cross, s, bg) {
  const i0 = Math.max(0, -s);
  const i1 = Math.min(length, length - s);
  const alongStep = vertical ? width : 1;
  const crossStep = vertical ? 1 : width;
  const base = r.y * width + r.x;
  let union = 0;
  let matched = 0;
  for (let i = i0; i < i1; i += 1) {
    let pc = base + i * alongStep;
    let pp = base + (i + s) * alongStep;
    for (let c = 0; c < cross; c += 3) {
      const a = curr[pc];
      const b = prev[pp];
      const da = a - bg;
      const db = b - bg;
      if (da > INK_THRESHOLD || da < -INK_THRESHOLD || db > INK_THRESHOLD || db < -INK_THRESHOLD) {
        union += 1;
        const d = a - b;
        if (d <= MATCH_TOLERANCE && d >= -MATCH_TOLERANCE) matched += 1;
      }
      pc += 3 * crossStep;
      pp += 3 * crossStep;
    }
  }
  return { union, fraction: union ? matched / union : 0 };
}

function clampRect(rect, width, height) {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(width, Math.round(rect.x + rect.w));
  const y1 = Math.min(height, Math.round(rect.y + rect.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Content moved by `shift` px inside `rect` (positive: user scrolled forward,
// content moved up/left). Returns null when no trustworthy answer exists
// (flat/blank area, too little overlap, nothing to compare).
function estimateShift(prev, curr, width, height, rect, options = {}) {
  const vertical = (options.axis || 'y') === 'y';
  const r = clampRect(rect, width, height);
  const length = vertical ? r.h : r.w;
  const cross = vertical ? r.w : r.h;
  if (length < 32 || cross < 16) return null;
  const minOverlap = Math.max(options.minOverlapPx || 32, Math.ceil(length * (options.minOverlapFraction || 0.25)));
  const maxShift = Math.min(options.maxShift === undefined ? length : options.maxShift, length - minOverlap);
  if (maxShift < 1) return null;
  const bands = Math.max(1, Math.min(4, Math.floor(cross / 16)));
  const bg = backgroundLevel(curr, width, r);
  const pc = buildProfile(curr, width, r, vertical, length, cross, bands);
  const pp = buildProfile(prev, width, r, vertical, length, cross, bands);
  const costs = profileCosts(pc, pp, length, bands, maxShift, bg);
  const candidates = pickCandidates(costs, maxShift, 4);
  const scored = candidates.map((s) => ({ s, ...verifyShift(prev, curr, width, r, vertical, length, cross, s, bg) }));
  // The profile minimum can land a pixel or two off when static edges (panel
  // borders) sit inside the rect, so refine the leaders on real pixels.
  scored.sort((a, b) => b.fraction - a.fraction);
  for (const lead of scored.slice(0, 2)) {
    for (const d of [-2, -1, 1, 2]) {
      const s = lead.s + d;
      if (Math.abs(s) > maxShift || scored.some((c) => c.s === s)) continue;
      scored.push({ s, ...verifyShift(prev, curr, width, r, vertical, length, cross, s, bg) });
    }
  }
  const usable = scored.filter((c) => c.union >= MIN_INK_SAMPLES);
  if (!usable.length) return null;
  usable.sort((a, b) => b.fraction - a.fraction || Math.abs(a.s) - Math.abs(b.s));
  const best = usable[0];
  const rival = usable.find((c) => c !== best && Math.abs(c.s - best.s) >= 3);
  const margin = rival ? best.fraction - rival.fraction : best.fraction;
  const confidence = best.fraction * Math.min(1, Math.max(0, margin / 0.2));
  return { shift: best.s, confidence, matchedFraction: best.fraction };
}

// X positions of full-height vertical edges (panel dividers). Apple Vision
// reads a single panel far better than a whole multi-panel screen, so the
// first capture is split along these before OCR.
function findColumnDividers(gray, width, height, { edge = 24, minCoverage = 0.55, minGapPx = 200 } = {}) {
  const counts = new Uint32Array(width);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 1; x < width; x += 1) {
      if (Math.abs(gray[row + x] - gray[row + x - 1]) > edge) counts[x] += 1;
    }
  }
  const candidates = [];
  for (let x = minGapPx; x < width - minGapPx; x += 1) {
    if (counts[x] >= minCoverage * height) candidates.push(x);
  }
  candidates.sort((a, b) => counts[b] - counts[a]);
  const dividers = [];
  for (const x of candidates) {
    if (dividers.every((d) => Math.abs(d - x) >= minGapPx)) dividers.push(x);
  }
  return dividers.sort((a, b) => a - b);
}

module.exports = { toGray, diffTiles, estimateShift, clampRect, findColumnDividers, INK_THRESHOLD, MATCH_TOLERANCE };
