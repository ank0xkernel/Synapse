'use strict';

const { normText } = require('./context-lines');

const TOL = 2;
const FLIGHT = ['new', 'captured', 'analysing'];

const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const contains = (outer, inner) => inner.x >= outer.x - TOL && inner.y >= outer.y - TOL
  && inner.x + inner.w <= outer.x + outer.w + TOL && inner.y + inner.h <= outer.y + outer.h + TOL;
function intersection(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y };
}

function fnv(text, seed) {
  let h = seed;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
const fingerprintOf = (text) => { const n = normText(text); return n ? fnv(n, 2166136261) + fnv(n, 5381) : null; };

module.exports = { TOL, FLIGHT, intersects, contains, intersection, fingerprintOf };
