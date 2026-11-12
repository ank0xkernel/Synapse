'use strict';

// Frame planning: decides, without mutating engine state, what each changed
// region of a frame means (scroll shift, in-place edit, lost track, new container).

const fa = require('./frame-analysis');
const ct = require('./container-tracker');
const dt = require('./capture-dirty');

function createPlanner(S, opt, containerList) {
  function usableRect(c) {
    let pieces = [c.screenRect];
    for (const m of S.masks) pieces = pieces.flatMap((p) => ct.subtractRect(p, m));
    pieces = pieces.filter((p) => p.w >= 16 && p.h >= 32);
    if (!pieces.length) return c.screenRect;
    return pieces.reduce((a, b) => (ct.area(b) > ct.area(a) ? b : a));
  }

  function bestShift(frameGray, rect, axes) {
    let best = null;
    for (const axis of axes) {
      const est = fa.estimateShift(S.prev.gray, frameGray, S.width, S.height, rect, {
        axis,
        minOverlapFraction: opt.minOverlapFraction,
        minOverlapPx: opt.minOverlapPx,
      });
      if (est && est.confidence >= opt.minConfidence && est.matchedFraction >= opt.minMatchedFraction) {
        if (!best || est.confidence > best.confidence) best = { ...est, axis };
        if (est.shift !== 0) break;
      }
    }
    return best;
  }

  function cluster(rects) {
    const out = rects.map((r) => ({ ...r }));
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < out.length && !merged; i += 1) {
        for (let j = i + 1; j < out.length && !merged; j += 1) {
          if (dt.near(out[i], out[j], opt.clusterGapPx / 2)) {
            out[i] = { ...ct.unionRect(out[i], out[j]), tiles: out[i].tiles + out[j].tiles };
            out.splice(j, 1);
            merged = true;
          }
        }
      }
    }
    return out;
  }

  /**
   * A changed area is often only part of a scrolling panel (the rest looked
   * alike between the two frames). Grows the rect along the scroll axis for as
   * long as whole rows moved by exactly the estimated shift, so one panel
   * never becomes two overlapping containers that each get some of its shifts.
   */
  function growAlongShift(gray, rect, est) {
    const W = S.width;
    const H = S.height;
    const others = containerList().map((c) => c.screenRect);
    const vertical = est.axis !== 'x';
    const span = vertical ? [rect.x, rect.x + rect.w] : [rect.y, rect.y + rect.h];
    const tol = opt.diffThreshold / 2;
    const lineMoved = (p) => {
      const q = p + est.shift;
      if (p < 0 || q < 0 || p >= (vertical ? H : W) || q >= (vertical ? H : W)) return false;
      if (others.some((o) => (vertical ? p >= o.y && p < o.y + o.h && o.x < span[1] && o.x + o.w > span[0]
        : p >= o.x && p < o.x + o.w && o.y < span[1] && o.y + o.h > span[0]))) return false;
      let sum = 0;
      for (let a = span[0]; a < span[1]; a += 1) {
        const cur = vertical ? gray[p * W + a] : gray[a * W + p];
        const old = vertical ? S.prev.gray[q * W + a] : S.prev.gray[a * W + q];
        sum += Math.abs(cur - old);
      }
      return sum / Math.max(1, span[1] - span[0]) <= tol;
    };
    let lo = vertical ? rect.y : rect.x;
    let hi = vertical ? rect.y + rect.h : rect.x + rect.w;
    while (lineMoved(lo - 1)) lo -= 1;
    while (lineMoved(hi)) hi += 1;
    return vertical ? { ...rect, y: lo, h: hi - lo } : { ...rect, x: lo, w: hi - lo };
  }

  function planFrame(frame, diff) {
    const actions = [];
    let unexplained = 0;
    const known = containerList();
    const byContainer = new Map();
    const leftover = [];
    for (const comp of diff.rects) {
      const c = ct.matchContainer(known, comp, 0.5);
      if (c) byContainer.set(c, (byContainer.get(c) || []).concat([comp]));
      else leftover.push(comp);
    }
    for (const [c, comps] of byContainer) {
      const tiles = comps.reduce((n, r) => n + r.tiles, 0);
      if (c.lost) {
        actions.push({ type: 'lost-touch', c });
        continue;
      }
      if (tiles <= opt.tinyTiles) {
        actions.push({ type: 'dirty', c, comps });
        continue;
      }
      const preferred = c.axis === 'both' ? ['y', 'x'] : [c.axis, c.axis === 'y' ? 'x' : 'y'];
      const est = bestShift(frame.gray, usableRect(c), preferred);
      if (est && est.shift !== 0) {
        actions.push({ type: 'shift', c, est });
      } else if (est) {
        actions.push({ type: 'dirty', c, comps });
        unexplained += tiles;
      } else if (tiles / Math.max(1, (c.screenRect.w * c.screenRect.h) / (opt.tile * opt.tile)) >= opt.lostChangedFraction) {
        actions.push({ type: 'lost', c });
        unexplained += tiles;
      } else {
        actions.push({ type: 'dirty', c, comps });
        unexplained += tiles;
      }
    }
    for (const cl of cluster(leftover)) {
      if (cl.tiles <= opt.tinyTiles) {
        actions.push({ type: 'dirty', c: S.root, comps: [cl] });
        continue;
      }
      const sizeOk = cl.w >= opt.minContainerPx && cl.h >= opt.minContainerPx;
      const est = sizeOk ? bestShift(frame.gray, cl, ['y', 'x']) : null;
      if (est && est.shift !== 0) {
        actions.push({ type: 'new-container', rect: growAlongShift(frame.gray, cl, est), est });
      } else {
        actions.push({ type: 'dirty', c: S.root, comps: [cl] });
        unexplained += cl.tiles;
      }
    }
    return { actions, unexplained };
  }

  return { planFrame };
}

module.exports = { createPlanner };
