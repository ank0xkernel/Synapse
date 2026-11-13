'use strict';

const normText = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();

function median(values) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function inRect(px, py, r) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/** Maps one analysed record's OCR lines into content coordinates. */
function mapLines(record) {
  const rect = record.contentRect;
  const ov = record.overlap || {};
  const lines = (record.lines || []).filter((l) => l && String(l.text || '').trim());
  const out = [];
  lines.forEach((l, i) => {
    const text = String(l.text).replace(/\s+$/, '');
    let x; let y; let w; let h; let noBox = false;
    if (l.box) {
      x = rect.x + l.box.x * rect.w;
      y = rect.y + l.box.y * rect.h;
      w = l.box.w * rect.w;
      h = l.box.h * rect.h;
    } else {
      noBox = true;
      h = rect.h / lines.length;
      y = rect.y + i * h;
      x = rect.x;
      w = rect.w;
    }
    const cx = x + w / 2;
    const cy = y + h / 2;
    if ((record.maskRects || []).some((m) => inRect(cx, cy, m))) return;
    const margin = !noBox && (y + h <= rect.y + (ov.top || 0) || y >= rect.y + rect.h - (ov.bottom || 0)
      || x + w <= rect.x + (ov.left || 0) || x >= rect.x + rect.w - (ov.right || 0));
    const norm = normText(text);
    // Spacing-free key for dedupe: two crops of the same pixels can come back
    // as "scores.append(" and "scores. append(" (Vision whitespace varies).
    out.push({ text, norm, key: norm.replace(/\s+/g, ''), x, y, w, h, noBox, margin, conf: l.confidence, regionId: record.id });
  });
  return out;
}

/**
 * Drops lines already supplied by an earlier region. A match needs the same
 * normalized text AND a nearby position, so repeated lines in different places
 * both survive. A margin copy loses to a non-margin copy. A read cut short at
 * a region edge ("return scores[: top_k") is the same line as the full read
 * starting at the same spot; the longer one is kept.
 */
const sameLineText = (a, b) => a === b || (Math.min(a.length, b.length) >= 8 && (a.startsWith(b) || b.startsWith(a)));

function dedupeLines(lines) {
  const kept = [];
  for (const line of lines) {
    if (line.noBox) { kept.push(line); continue; }
    const tol = Math.max(6, line.h * 0.6);
    const idx = kept.findIndex((k) => !k.noBox && k.regionId !== line.regionId && sameLineText(k.key, line.key)
      && Math.abs(k.y - line.y) <= tol && Math.abs(k.x - line.x) <= Math.max(tol, 12));
    if (idx < 0) kept.push(line);
    else if ((kept[idx].margin && !line.margin) || (kept[idx].margin === line.margin && line.key.length > kept[idx].key.length)) kept[idx] = line;
  }
  return kept;
}

/** Joins boxes sharing a visual row; wide horizontal gaps become ' | ' cells. */
function buildRows(lines) {
  const sorted = lines.slice().sort((a, b) => (a.noBox || b.noBox ? 0 : a.y - b.y || a.x - b.x));
  const rows = [];
  for (const line of sorted) {
    const prev = rows[rows.length - 1];
    const last = prev && prev.parts[prev.parts.length - 1];
    const overlap = last && !line.noBox && !last.noBox
      && Math.min(last.y + last.h, line.y + line.h) - Math.max(last.y, line.y) > 0.5 * Math.min(last.h, line.h);
    if (overlap) prev.parts.push(line);
    else rows.push({ parts: [line] });
  }
  return rows.map((row) => {
    const parts = row.parts.slice().sort((a, b) => a.x - b.x);
    let text = parts[0].text;
    let cells = 1;
    for (let i = 1; i < parts.length; i += 1) {
      const prev = parts[i - 1];
      const pitch = prev.w / Math.max(1, prev.text.trim().length);
      const gap = parts[i].x - (prev.x + prev.w);
      if (gap > 3 * pitch) { text += ` | ${parts[i].text}`; cells += 1; } else text += ` ${parts[i].text}`;
    }
    const x = Math.min(...parts.map((p) => p.x));
    const y = Math.min(...parts.map((p) => p.y));
    const x1 = Math.max(...parts.map((p) => p.x + p.w));
    const y1 = Math.max(...parts.map((p) => p.y + p.h));
    const confs = parts.map((p) => p.conf).filter((c) => Number.isFinite(c));
    return {
      text, cells, x, y, w: x1 - x, h: y1 - y, single: parts.length === 1, noBox: parts[0].noBox,
      regionIds: Array.from(new Set(parts.map((p) => p.regionId))),
      conf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
    };
  });
}

function groupBlocks(rows) {
  const heights = rows.filter((r) => !r.noBox).map((r) => r.h);
  const gapLimit = 1.5 * (median(heights) || 0);
  const blocks = [];
  let current = null;
  let prev = null;
  for (const row of rows) {
    const split = !current || (!row.noBox && !prev.noBox && gapLimit > 0 && row.y - (prev.y + prev.h) > gapLimit);
    if (split) { current = []; blocks.push(current); }
    current.push(row);
    prev = row;
  }
  return blocks;
}

const CODE_KW = /^(def|class|import|from|for|while|if|elif|else|try|except|finally|with|return|yield|raise|print|function|const|let|var|async|await|public|private|static|void|int|package|switch|case|#include)\b/;
const ASSIGN = /^[A-Za-z_][\w.[\]'"]*\s*([+\-*/]?=)\s*\S/;
const CALL = /^[A-Za-z_][\w.]*\(.*\)\s*;?$/;
const ERROR_LINE = /^(Traceback \(most recent call last\)|Error:|Uncaught\b|[A-Za-z_.]*(Error|Exception)\b.*:|\s*File ".*", line \d+)/;

function codeStrength(text) {
  const t = text.trim();
  if (!t) return 0;
  if (CODE_KW.test(t) && /[:{(;,=]\s*$|\(|=/.test(t)) return 2;
  if (/^(pass|break|continue|return|raise)\s*;?$/.test(t)) return 2;
  if (ASSIGN.test(t) || CALL.test(t) || /^[}\])]+[;,]?$/.test(t) || /=>|==|\(\)|\[\]|\{\}/.test(t) && /[;:{]$|=>/.test(t)) return 2;
  if (/^(#|\/\/)\s?\S/.test(t) || /[;{}]\s*$/.test(t)) return 1;
  return 0;
}

const TEST_START = /^(test\s*cases?\b|sample\s*(input|output)\b|example\s*\d*\s*[:.-]?|input\b|expected\s*output\b)/i;
const INSTR_START = /^(given|write|implement|return|find|you are|your task|design|complete|print|calculate|determine|create|compute|consider|note\b|constraints?\b)/i;

function titleLike(row, medianH) {
  const t = row.text.trim();
  const words = t.split(/\s+/);
  if (!row.single || words.length > 7 || t.length > 70 || /[.,;]$/.test(t) || codeStrength(t)) return false;
  if (!/^[A-Z0-9]/.test(t)) return false;
  const caps = words.every((w) => /^[A-Z0-9]/.test(w)) || t === t.toUpperCase();
  return caps || (medianH > 0 && row.h >= 1.2 * medianH);
}

function classify(rows) {
  const texts = rows.map((r) => r.text.trim());
  const first = texts[0] || '';
  const strengths = texts.map(codeStrength);
  const codeRatio = strengths.filter(Boolean).length / texts.length;
  if (texts.some((t) => ERROR_LINE.test(t)) && (/^(Traceback|Error:)/.test(first) || texts.length <= 4 || codeRatio < 0.6)) {
    return { kind: 'error', confidence: /^Traceback/.test(first) ? 0.95 : 0.85 };
  }
  if (/^Out\s*\[\d+\]:?/.test(first)) return { kind: 'output', confidence: 0.9 };
  if (TEST_START.test(first)) {
    const markers = texts.filter((t) => TEST_START.test(t)).length;
    return { kind: 'test_case', confidence: markers >= 2 || /^(test|sample|example|expected)/i.test(first) ? 0.9 : 0.7 };
  }
  if (/^In\s*\[\d*\]:?/.test(first)) return { kind: 'code', confidence: 0.9 };
  // Lettered answer options ("A. x = 3", "B) 42") are question text even when
  // they look like assignments. Letters must run in order from A, so code
  // such as "B.x = 5" on its own is not taken for an option list.
  const letters = texts.map((t) => (t.match(/^\(?([A-H])[.)]\s*\S/) || [])[1]).filter(Boolean);
  if (letters.length >= 2 && letters.length * 2 >= texts.length && letters.every((l, i) => l === 'ABCDEFGH'[i])) {
    return { kind: 'instruction', confidence: 0.8 };
  }
  if (strengths.some((s) => s === 2) && codeRatio >= 0.5) {
    return { kind: 'code', confidence: Math.min(0.95, 0.6 + codeRatio * 0.35) };
  }
  const tabular = rows.filter((r) => r.cells >= 2).length;
  if (rows.length >= 3 && tabular >= 3 && tabular / rows.length >= 0.6) return { kind: 'table', confidence: 0.8 };
  if (/^output\b/i.test(first)) return { kind: 'output', confidence: 0.6 };
  const numbered = texts.filter((t) => /^\d+[.)]\s+\S/.test(t)).length;
  if (numbered >= 2 || INSTR_START.test(first)) return { kind: 'instruction', confidence: numbered >= 2 ? 0.8 : 0.7 };
  if (rows.length === 1 && titleLike(rows[0], 0)) return { kind: 'heading', confidence: 0.6 };
  return { kind: 'text', confidence: 0.5 };
}

/** Splits a leading title row off a multi-row block when it reads as a heading. */
function splitHeading(block) {
  if (block.length < 2) return [block];
  const heights = block.filter((r) => !r.noBox).map((r) => r.h);
  if (titleLike(block[0], median(heights)) && classify(block.slice(1)).kind !== 'code' && !TEST_START.test(block[0].text)) {
    return [[block[0]], block.slice(1)];
  }
  return [block];
}

// Notebook prompts as Vision reads them: "In [3]:", "In [ ]:", "ln [3]:",
// "In [31:" (closing bracket read as 1).
const NOTEBOOK_PROMPT = /^(In|ln|Out)\s*\[[\s\d]*[\]1l|]?\s*:/;

/**
 * Re-creates leading whitespace for code from box.x. The baseline is the
 * leftmost row that reads as code: a notebook prompt ("In [3]:") or an output
 * line printed further left must not shift every code line right.
 */
function applyIndentation(rows) {
  const boxed = rows.filter((r) => !r.noBox && r.single && codeStrength(r.text) > 0);
  const pitch = median(boxed.map((r) => r.w / Math.max(1, r.text.trim().length)));
  const boxedRows = rows.filter((r) => !r.noBox);
  const notPrompt = boxedRows.filter((r) => !NOTEBOOK_PROMPT.test(r.text.trim()));
  const codeRows = notPrompt.filter((r) => codeStrength(r.text) > 0);
  const basis = codeRows.length ? codeRows : notPrompt.length ? notPrompt : boxedRows;
  const left = Math.min(...basis.map((r) => r.x));
  return rows.map((r) => {
    const trimmed = r.text.replace(/^\s+/, '');
    if (!pitch || r.noBox || !Number.isFinite(left)) return trimmed;
    return ' '.repeat(Math.min(60, Math.max(0, Math.round((r.x - left) / pitch)))) + trimmed;
  });
}

/**
 * A blank line inside a function splits the visual block. An indented group
 * right after a code group, within three line heights, is the same code: it is
 * joined back so its indentation is measured against the same baseline.
 */
function joinCodeContinuations(groups) {
  const out = [];
  for (const group of groups) {
    const prev = out[out.length - 1];
    if (prev && !group[0].noBox && classify(prev).kind === 'code') {
      const code = prev.filter((r) => !r.noBox && codeStrength(r.text) > 0 && !NOTEBOOK_PROMPT.test(r.text.trim()));
      const last = prev[prev.length - 1];
      const pitch = median(code.map((r) => r.w / Math.max(1, r.text.trim().length)));
      const left = code.length ? Math.min(...code.map((r) => r.x)) : Infinity;
      const gap = group[0].y - (last.y + last.h);
      if (pitch && group[0].x >= left + 2 * pitch && gap <= 3 * last.h) {
        prev.push(...group);
        continue;
      }
    }
    out.push(group.slice());
  }
  return out;
}

/**
 * Notebook cell boundaries inside one visual group. A prompt row ("In [2]:")
 * always starts a new cell. In a cell that starts with an In prompt, output is
 * printed straight under the code with no blank line: it begins at the first
 * run of non-code rows at (or left of) the code's left edge, or at a single
 * non-code row printed left of the code. Indented rows (docstrings, strings
 * inside functions) stay code. Output parts are marked forcedKind 'output'.
 */
function splitNotebookCells(group) {
  const cells = [];
  let cur = [];
  for (const r of group) {
    if (cur.length && !r.noBox && NOTEBOOK_PROMPT.test(r.text.trim())) { cells.push(cur); cur = []; }
    cur.push(r);
  }
  if (cur.length) cells.push(cur);
  const out = [];
  for (const cell of cells) {
    const head = cell[0];
    if (cell.length < 2 || head.noBox || !/^(In|ln)\s*\[/.test(head.text.trim())) { out.push(cell); continue; }
    const pitch = median(cell.filter((r) => !r.noBox).map((r) => r.w / Math.max(1, r.text.trim().length)));
    const codeRows = cell.slice(1).filter((r) => !r.noBox && codeStrength(r.text) > 0);
    const promptChars = (head.text.trim().match(NOTEBOOK_PROMPT) || [''])[0].length + 1;
    const codeLeft = codeRows.length ? Math.min(...codeRows.map((r) => r.x)) : head.x + promptChars * pitch;
    const plain = (r) => r && !r.noBox && codeStrength(r.text) === 0;
    let cut = -1;
    for (let i = 1; i < cell.length && pitch; i += 1) {
      const r = cell[i];
      if (!plain(r)) continue;
      const atEdge = r.x <= codeLeft + pitch;
      const outdented = r.x < codeLeft - 0.5 * pitch;
      if ((atEdge && plain(cell[i + 1]) && cell[i + 1].x <= codeLeft + pitch) || outdented) { cut = i; break; }
    }
    if (cut > 0) {
      out.push(cell.slice(0, cut));
      out.push(Object.assign(cell.slice(cut), { forcedKind: 'output' }));
    } else {
      out.push(cell);
    }
  }
  return out;
}

/** Indented code text with blank lines restored where the rows have a visible gap. */
function codeText(block) {
  const texts = applyIndentation(block);
  const heights = block.filter((r) => !r.noBox).map((r) => r.h);
  const lineGap = 1.5 * (median(heights) || 0);
  const out = [];
  block.forEach((r, i) => {
    const prev = block[i - 1];
    if (prev && lineGap > 0 && !r.noBox && !prev.noBox && r.y - (prev.y + prev.h) > lineGap) out.push('');
    out.push(texts[i]);
  });
  return out.join('\n');
}

function toBlocks(lines) {
  const rows = buildRows(lines);
  const out = [];
  for (const raw of joinCodeContinuations(groupBlocks(rows)).flatMap(splitNotebookCells)) {
    for (const block of raw.forcedKind ? [raw] : splitHeading(raw)) {
      const { kind, confidence } = raw.forcedKind ? { kind: raw.forcedKind, confidence: 0.75 } : classify(block);
      const texts = kind === 'code' ? [codeText(block)] : block.map((r) => r.text);
      const confs = block.map((r) => r.conf).filter((c) => Number.isFinite(c));
      out.push({
        kind,
        confidence,
        text: texts.join('\n'),
        regionIds: Array.from(new Set(block.flatMap((r) => r.regionIds))),
        y0: Math.min(...block.map((r) => r.y)),
        contentRect: {
          x: Math.min(...block.map((r) => r.x)),
          y: Math.min(...block.map((r) => r.y)),
          w: Math.max(...block.map((r) => r.x + r.w)) - Math.min(...block.map((r) => r.x)),
          h: Math.max(...block.map((r) => r.y + r.h)) - Math.min(...block.map((r) => r.y)),
        },
        ocrConfidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
      });
    }
  }
  return out;
}

/**
 * Finds >= 3 consecutive identical normalized lines shared by two segments of
 * one container and returns the offset that maps segment B onto segment A.
 */
function detectSegmentMerge(linesA, linesB) {
  const A = linesA.filter((l) => !l.noBox).sort((p, q) => p.y - q.y || p.x - q.x);
  const B = linesB.filter((l) => !l.noBox).sort((p, q) => p.y - q.y || p.x - q.x);
  let best = null;
  let rival = 0;
  for (let i = 0; i < A.length; i += 1) {
    for (let j = 0; j < B.length; j += 1) {
      if (!A[i].norm || A[i].norm !== B[j].norm) continue;
      const dy = A[i].y - B[j].y;
      const dx = A[i].x - B[j].x;
      let n = 0;
      let chars = 0;
      while (i + n < A.length && j + n < B.length && A[i + n].norm && A[i + n].norm === B[j + n].norm
        && Math.abs((A[i + n].y - B[j + n].y) - dy) <= 4) { chars += A[i + n].norm.length; n += 1; }
      if (n < 3 || chars < 40) continue;
      const run = { matched: n, offset: { x: Math.round(dx), y: Math.round(dy) } };
      const sameOffset = (other) => Math.abs(other.offset.y - run.offset.y) <= 4 && Math.abs(other.offset.x - run.offset.x) <= 4;
      if (!best || n > best.matched) {
        if (best && !sameOffset(best)) rival = Math.max(rival, best.matched);
        best = run;
      } else if (!sameOffset(best)) {
        rival = Math.max(rival, n);
      }
    }
  }
  // Repetitive content (similar code cells, table rows) matches at several
  // offsets. Joining on an ambiguous match would interleave unrelated text, so
  // the segments stay separate unless one offset clearly wins.
  return best && best.matched > rival ? best : null;
}

module.exports = { normText, mapLines, dedupeLines, buildRows, toBlocks, classify, detectSegmentMerge, median };
