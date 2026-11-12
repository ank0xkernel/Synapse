'use strict';

// Where one problem ends and the next begins inside one scrolling panel.
//
// A boundary ("cut") sits at a content position. It is only ever proposed at a
// heading that looks like the start of a problem: one carrying a problem
// identifier ("Question 7", "Q7.", "Problem 2") or a heading as large as the
// title of the problem above it. Whether it really starts a different problem
// is then decided from the instruction text under it, never from the heading
// words alone:
//
//   same       the text under it is the problem above (a section of it)
//   revisit    the text is a problem seen before
//   new        a different identifier with different instructions, or a
//              title-sized heading at the top of replaced panel content
//   possible   a title-sized heading over different text, with nothing else
//              agreeing: held out of every context until the user decides
//   watching   too little text under it yet to decide: held, decided later
//
// Pure functions; the session owns the cut state.

const { mapLines, dedupeLines, toBlocks } = require('./context-lines');
const { evidenceOfBlocks, identifierOf, isGenericHeading, normTitle, shinglesOf, MIN_SHINGLES, SAME_THRESHOLD } = require('./problem-tracker');

const HELD = 'held';
const POS_TOL = 4;
// Where in the view the user reads: the problem there is the one on screen.
// A band around it must agree, so a small scroll at a boundary changes nothing.
const READING_LINE = 0.25;
const HYSTERESIS = 0.06;
const TITLE_LEVEL = 0.9;
const MAX_IDENTIFIER_ROW_WORDS = 8;
const NON_PROSE = new Set(['code', 'output', 'error']);

/** Layout blocks of one panel segment, read the way the context builder reads them. */
function blocksOf(records) {
  return toBlocks(dedupeLines(records.flatMap(mapLines))).sort((a, b) => a.y0 - b.y0);
}

/**
 * Headings that could start a problem. `titleHeight` is the row height of the
 * title of the problem above; without it only identifiers count, because a
 * large heading means nothing without something to compare it with.
 */
function boundaryHeadings(blocks, { titleHeight = null, allowTitleLevel = true } = {}) {
  const out = [];
  for (const b of blocks) {
    if (NON_PROSE.has(b.kind)) continue;
    const first = b.text.split('\n')[0].trim();
    const norm = normTitle(first);
    const id = identifierOf(first);
    const identifier = id && first.split(/\s+/).length <= MAX_IDENTIFIER_ROW_WORDS ? id : null;
    const heading = b.kind === 'heading' && !isGenericHeading(norm);
    const titleLevel = allowTitleLevel && heading && titleHeight > 0 && b.contentRect.h >= TITLE_LEVEL * titleHeight;
    if (!identifier && !titleLevel) continue;
    out.push({ pos: b.y0, title: first.slice(0, 80), norm, identifier, titleLevel, height: b.contentRect.h });
  }
  return out;
}

/** Instruction evidence of the blocks in [from, to). */
function evidenceBetween(blocks, from, to = Infinity) {
  return evidenceOfBlocks(blocks.filter((b) => b.y0 >= from - POS_TOL && b.y0 < to - POS_TOL));
}

const liveCuts = (entry) => entry.cuts.filter((c) => c.status !== 'dismissed');

/**
 * Who owns content position y: a problem id, HELD (undecided boundary or an
 * unknown problem above the first boundary), or null when nothing is known.
 */
function attributeAt(entry, y) {
  let owner = entry.base === null ? HELD : entry.base;
  for (const cut of liveCuts(entry)) {
    if (y + POS_TOL < cut.pos) break;
    owner = cut.status === 'confirmed' ? cut.problemId : HELD;
  }
  return owner;
}

/** Owner of the content just above a cut. */
function ownerAbove(entry, cut) {
  let owner = entry.base === null ? HELD : entry.base;
  for (const c of liveCuts(entry)) {
    if (c === cut || c.pos >= cut.pos) break;
    owner = c.status === 'confirmed' ? c.problemId : HELD;
  }
  return owner;
}

/** The nearest problem above a cut, skipping held parts. */
function knownOwnerAbove(entry, cut) {
  let owner = entry.base;
  for (const c of liveCuts(entry)) {
    if (c === cut || c.pos >= cut.pos) break;
    if (c.status === 'confirmed') owner = c.problemId;
  }
  return owner || null;
}

/** End of the part a cut opens: the next live cut, or the end of the panel. */
function partEnd(entry, cut) {
  const next = liveCuts(entry).find((c) => c.pos > cut.pos + POS_TOL);
  return next ? next.pos : Infinity;
}

/**
 * Decides one cut from the evidence under it. `tracker` is only read.
 * `structural` is true when the panel content was replaced (fast jump or
 * in-place re-render) and the heading opens the new content.
 */
function decideCut({ cut, evidence, above, known: knownAbove = null, tracker, structural = false }) {
  if (shinglesOf(evidence.text).size < MIN_SHINGLES) return { status: 'watching', decision: 'watching' };
  const aboveId = above && above !== HELD ? above : null;
  const aboveP = aboveId ? tracker.get(aboveId) : null;
  const identifierChanged = Boolean(cut.identifier) && !(aboveP && aboveP.identifiers.has(cut.identifier));
  // Content right under held text is never a "revisit" of the problem above that held text.
  const known = tracker.bestMatch(evidence, { exclude: [aboveId, knownAbove].filter(Boolean) }).problem;
  // A revisit needs the identifiers to agree: two numbered questions sharing a template are two problems.
  if (known && !(cut.identifier && known.identifiers.size && !known.identifiers.has(cut.identifier))) {
    return { status: 'confirmed', decision: 'revisit', problemId: known.id };
  }
  if (identifierChanged) return { status: 'confirmed', decision: 'new' };
  const sim = aboveId ? tracker.similarityTo(aboveId, evidence) : null;
  if (sim !== null && sim >= SAME_THRESHOLD) return { status: 'dismissed', decision: 'same' };
  if (structural && cut.titleLevel) return { status: 'confirmed', decision: 'new' };
  return { status: 'possible', decision: 'possible' };
}

/** Adds cuts for headings not already known (within POS_TOL). Returns the cuts added. */
function mergeHeadings(entry, heads, nextId) {
  const added = [];
  for (const h of heads) {
    if (entry.cuts.some((c) => Math.abs(c.pos - h.pos) <= POS_TOL)) continue;
    const cut = { id: nextId(), ...h, status: 'watching', problemId: null };
    entry.cuts.push(cut);
    added.push(cut);
  }
  entry.cuts.sort((a, b) => a.pos - b.pos);
  return added;
}

/** Content position the user is reading in the view [v0, v1). */
const readingLine = (v0, v1) => v0 + READING_LINE * (v1 - v0);

/**
 * Owner of the reading line of the view, or null while it sits within the
 * hysteresis band of a boundary (no decision near an edge).
 */
function ownerInView(entry, v0, v1) {
  const line = readingLine(v0, v1);
  const margin = HYSTERESIS * (v1 - v0);
  const owner = attributeAt(entry, line);
  return attributeAt(entry, line - margin) === owner && attributeAt(entry, line + margin) === owner ? owner : null;
}

module.exports = {
  HELD, POS_TOL, blocksOf, boundaryHeadings, evidenceBetween, attributeAt, ownerAbove, knownOwnerAbove, partEnd, decideCut, mergeHeadings, ownerInView, readingLine, liveCuts,
};
