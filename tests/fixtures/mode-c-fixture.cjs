'use strict';

// Deterministic synthetic assessment page rendered to grayscale frames, plus a
// fake crop function and a fake OCR that reads the fixture's own ground truth.

const { LEFT, RIGHT } = require('./mode-c-fixture-text.cjs');

const GLYPH_W = 12;
const LINE_H = 22;
const PAD = 12;
const BAR_H = 48;
const TABLE_X = [0, 300, 600, 900, 1200, 1500];
const TABLE_W = 1800;

const glyphCache = new Map();
function glyph(ch) {
  if (glyphCache.has(ch)) return glyphCache.get(ch);
  const code = ch.charCodeAt(0);
  let seed = (code * 2654435761) >>> 0;
  const bits = [];
  let ink = 0;
  for (let i = 0; i < 35; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const on = (seed >>> 24) % 100 < 46 ? 1 : 0;
    bits.push(on);
    ink += on;
  }
  if (ink < 12) for (let i = 0; i < 12; i += 1) bits[(i * 3 + code) % 35] = 1;
  glyphCache.set(ch, ch === ' ' ? null : bits);
  return glyphCache.get(ch);
}

function wrap(text, max) {
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > max) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

function buildPanel(name, rect, build) {
  const items = [];
  const st = { y: PAD, width: rect.w, name };
  const text = (x, y, str, kind) => {
    const trimmed = str.replace(/^ +/, '');
    const indent = str.length - trimmed.length;
    if (!trimmed) return;
    items.push({ type: 'text', panel: name, kind, indent, text: trimmed, x: PAD + x + indent * GLYPH_W, y, w: trimmed.length * GLYPH_W, h: LINE_H });
  };
  const box = (x, y, w, h, fill, border) => items.push({ type: 'rect', x, y, w, h, fill, border });
  build({ st, text, box, items });
  return { name, rect, items, contentHeight: st.y + PAD, contentWidth: st.contentWidth || rect.w };
}

function buildLeft(rect) {
  const maxChars = Math.floor((rect.w - 2 * PAD) / GLYPH_W);
  return buildPanel('left', rect, ({ st, text, box }) => {
    for (const row of LEFT) {
      const [type, a, b, c] = row;
      if (type === 'heading') {
        st.y += 10;
        text(0, st.y, a, 'heading');
        st.y += LINE_H;
        box(PAD, st.y, rect.w - 2 * PAD, 2, 150, null);
        st.y += 10;
      } else if (type === 'para') {
        for (const l of wrap(a, maxChars)) {
          text(0, st.y, l, 'instruction');
          st.y += LINE_H;
        }
        st.y += 8;
      } else if (type === 'num' || type === 'bullet') {
        const prefix = type === 'num' ? `${LEFT.filter((r) => r[0] === 'num').indexOf(row) + 1}. ` : '- ';
        wrap(prefix + a, maxChars).forEach((l, i) => {
          text(0, st.y, i ? `  ${l}` : l, type === 'num' ? 'instruction' : 'markdown');
          st.y += LINE_H;
        });
        st.y += 4;
      } else if (type === 'case') {
        const h = 6 + LINE_H * 5 + 8;
        box(PAD, st.y, rect.w - 2 * PAD, h, 242, 170);
        st.y += 6;
        text(8, st.y, `Test Case ${a}`, 'test_case');
        st.y += LINE_H;
        text(8, st.y, 'Input:', 'test_case');
        st.y += LINE_H;
        text(8, st.y, b.slice(0, 28), 'test_case');
        st.y += LINE_H;
        text(8, st.y, 'Expected Output:', 'test_case');
        st.y += LINE_H;
        text(8, st.y, c.slice(0, 28), 'test_case');
        st.y += LINE_H + 8 + 10;
      }
    }
  });
}

function buildRight(rect) {
  const inner = rect.w - 2 * PAD;
  return buildPanel('right', rect, ({ st, text, box }) => {
    st.contentWidth = TABLE_W + 2 * PAD;
    const kindOf = { md: 'markdown', code: 'code', out: 'output', error: 'error' };
    for (const [type, lines] of RIGHT) {
      const isTable = type === 'table';
      const h = 10 + lines.length * LINE_H + 10;
      const fill = { md: 255, code: 236, out: 250, error: 222, table: 246 }[type];
      box(PAD, st.y, isTable ? TABLE_W : inner, h, fill, type === 'md' ? null : 175);
      let y = st.y + 10;
      for (const line of lines) {
        if (isTable) {
          line.forEach((cell, i) => text(TABLE_X[i] + 8, y, cell, 'table'));
        } else {
          text(8, y, line, kindOf[type]);
        }
        y += LINE_H;
      }
      st.y += h + 14;
    }
  });
}

function xorshift(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

function createFixture({ width = 1280, height = 800 } = {}) {
  const leftRect = { x: 16, y: BAR_H + 8, w: 400, h: height - BAR_H - 24 };
  const rightRect = { x: 480, y: BAR_H + 8, w: width - 480 - 16, h: height - BAR_H - 24 };
  const left = buildLeft(leftRect);
  const right = buildRight(rightRect);
  const panels = {
    left: { rect: leftRect, contentHeight: left.contentHeight, contentWidth: leftRect.w, model: left },
    right: { rect: rightRect, contentHeight: right.contentHeight, contentWidth: right.contentWidth, model: right },
  };
  const barItem = { type: 'text', panel: 'bar', kind: 'heading', indent: 0, text: 'Newton School - Campus FAQ Bot', x: 16, y: 14, w: 30 * GLYPH_W, h: LINE_H };

  function fillRect(buf, x, y, w, h, v, clip) {
    const x0 = Math.max(x, clip.x);
    const y0 = Math.max(y, clip.y);
    const x1 = Math.min(x + w, clip.x + clip.w, width);
    const y1 = Math.min(y + h, clip.y + clip.h, height);
    for (let yy = y0; yy < y1; yy += 1) buf.fill(v, yy * width + x0, yy * width + Math.max(x0, x1));
  }

  function drawText(buf, sx, sy, str, v, clip) {
    for (let i = 0; i < str.length; i += 1) {
      const g = glyph(str[i]);
      if (!g) continue;
      const gx = sx + i * GLYPH_W;
      for (let r = 0; r < 7; r += 1) {
        for (let c = 0; c < 5; c += 1) {
          if (g[r * 5 + c]) fillRect(buf, gx + c * 2, sy + 4 + r * 2, 2, 2, v, clip);
        }
      }
    }
  }

  function applyEdit(model, edit) {
    const texts = model.items.filter((it) => it.type === 'text');
    const target = texts[edit.line];
    return target ? new Map([[target, edit.text]]) : new Map();
  }

  function drawPanel(buf, panel, sx, sy, edit) {
    const clip = panel.rect;
    fillRect(buf, clip.x, clip.y, clip.w, clip.h, 255, clip);
    const overrides = edit && edit.panel === panel.model.name ? applyEdit(panel.model, edit) : new Map();
    for (const it of panel.model.items) {
      const x = clip.x + it.x - sx;
      const y = clip.y + it.y - sy;
      if (y > clip.y + clip.h || y + (it.h || LINE_H) < clip.y) continue;
      if (it.type === 'rect') {
        const bx = clip.x + it.x - sx;
        fillRect(buf, bx, y, it.w, it.h, it.fill, clip);
        if (it.border !== null) {
          fillRect(buf, bx, y, it.w, 1, it.border, clip);
          fillRect(buf, bx, y + it.h - 1, it.w, 1, it.border, clip);
          fillRect(buf, bx, y, 1, it.h, it.border, clip);
          fillRect(buf, bx + it.w - 1, y, 1, it.h, it.border, clip);
        }
      } else {
        drawText(buf, x, y, overrides.get(it) !== undefined ? overrides.get(it) : it.text, 20, clip);
      }
    }
  }

  function render({ leftY = 0, rightY = 0, rightX = 0, overlay, caret = false, edit, noise } = {}) {
    const buf = new Uint8Array(width * height).fill(232);
    const full = { x: 0, y: 0, w: width, h: height };
    fillRect(buf, 0, 0, width, BAR_H, 40, full);
    drawText(buf, barItem.x, barItem.y, barItem.text, 225, full);
    drawPanel(buf, panels.left, 0, leftY, edit);
    drawPanel(buf, panels.right, rightX, rightY, edit);
    if (caret) fillRect(buf, rightRect.x + 300, rightRect.y + 300, 2, 14, 10, full);
    if (overlay) {
      const rnd = xorshift((overlay.seed || 1) * 7919);
      for (let y = overlay.y; y < overlay.y + overlay.h; y += 8) {
        for (let x = overlay.x; x < overlay.x + overlay.w; x += 8) fillRect(buf, x, y, 8, 8, 40 + (rnd() % 180), full);
      }
    }
    if (noise) applyNoise(buf, noise);
    return buf;
  }

  function applyNoise(buf, { jitter = 2, blur = false, seed = 1 }) {
    if (blur) {
      const src = buf.slice();
      for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
          const i = y * width + x;
          buf[i] = Math.round(src[i] * 0.6 + 0.1 * (src[i - 1] + src[i + 1] + src[i - width] + src[i + width]));
        }
      }
    }
    if (jitter) {
      const rnd = xorshift(seed * 104729);
      for (let i = 0; i < buf.length; i += 1) {
        const v = buf[i] + ((rnd() % (2 * jitter + 1)) - jitter);
        buf[i] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }

  function stateOf(s = {}) {
    return { leftY: s.leftY || 0, rightY: s.rightY || 0, rightX: s.rightX || 0, edit: s.edit || null };
  }

  function frame(state) {
    const gray = render(state);
    return { gray, width, height, frameRef: { fixture: true, state: stateOf(state) } };
  }

  function panelOf(ref) {
    if (typeof ref === 'string') return panels[ref];
    if (ref && ref.panel) return panels[ref.panel];
    const r = ref.screenRect || ref.rect || ref;
    let best = null;
    let bestA = 0;
    for (const p of Object.values(panels)) {
      const w = Math.min(p.rect.x + p.rect.w, r.x + r.w) - Math.max(p.rect.x, r.x);
      const h = Math.min(p.rect.y + p.rect.h, r.y + r.h) - Math.max(p.rect.y, r.y);
      if (w > 0 && h > 0 && w * h > bestA) {
        best = p;
        bestA = w * h;
      }
    }
    return best;
  }

  const allLines = (panel) => panelOf(panel).model.items.filter((it) => it.type === 'text').map((it) => ({ text: it.text, kind: it.kind, box: { x: it.x, y: it.y, w: it.w, h: it.h } }));

  function linesInRect(panelRef, contentRect) {
    return allLines(panelRef).filter((l) => l.box.x >= contentRect.x && l.box.y >= contentRect.y && l.box.x + l.box.w <= contentRect.x + contentRect.w && l.box.y + l.box.h <= contentRect.y + contentRect.h);
  }

  function lineAt(panelRef, contentY) {
    return allLines(panelRef).find((l) => contentY >= l.box.y && contentY < l.box.y + l.box.h) || null;
  }

  // Text items fully visible (inside the panel viewport) for a state, in screen px.
  function visibleItems(state) {
    const s = stateOf(state);
    const out = [{ panel: 'bar', text: barItem.text, kind: barItem.kind, box: { x: barItem.x, y: barItem.y, w: barItem.w, h: barItem.h } }];
    for (const [name, p] of Object.entries(panels)) {
      const ox = name === 'right' ? s.rightX : 0;
      const oy = name === 'right' ? s.rightY : s.leftY;
      const texts = p.model.items.filter((it) => it.type === 'text');
      texts.forEach((it, idx) => {
        const text = s.edit && s.edit.panel === name && s.edit.line === idx ? s.edit.text : it.text;
        const box = { x: p.rect.x + it.x - ox, y: p.rect.y + it.y - oy, w: text.length * GLYPH_W, h: it.h };
        const inside = box.x >= p.rect.x && box.y >= p.rect.y && box.x + box.w <= p.rect.x + p.rect.w && box.y + box.h <= p.rect.y + p.rect.h;
        if (inside) out.push({ panel: name, text, kind: it.kind, box });
      });
    }
    return out;
  }

  return { width, height, panels, render, frame, linesInRect, lineAt, allLines, visibleItems, stateOf };
}

function makeFakeImageRef(frameRef, rect) {
  return { fixture: true, screenRect: { ...rect }, state: frameRef.state, width: rect.w, height: rect.h };
}

const makeFakeCropFrame = () => (frameRef, rect) => makeFakeImageRef(frameRef, rect);

function fakeOcrFor(fixture) {
  return {
    async recognize(imageRef, { signal } = {}) {
      if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
      const r = imageRef.screenRect;
      const lines = fixture
        .visibleItems(imageRef.state)
        .filter((it) => it.box.x >= r.x && it.box.y >= r.y && it.box.x + it.box.w <= r.x + r.w && it.box.y + it.box.h <= r.y + r.h)
        .map((it) => ({
          text: it.text,
          box: { x: (it.box.x - r.x) / r.w, y: (it.box.y - r.y) / r.h, w: it.box.w / r.w, h: it.box.h / r.h },
          confidence: 0.99,
        }));
      return { lines, engine: 'fake', durationMs: 0 };
    },
  };
}

module.exports = { createFixture, makeFakeImageRef, makeFakeCropFrame, fakeOcrFor, GLYPH_W, LINE_H };
