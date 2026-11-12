'use strict';

// Decides which problem the user is looking at. A problem is identified by the
// words of its instructions (headings, prose, test cases), never by code or
// outputs, which change while the user works on the same problem.
//
// Two screens are the same problem when enough of the smaller one's word
// shingles appear in the other. Too little instruction text means "not
// determined yet": the tracker keeps the current problem and says so instead
// of guessing.

const { mapLines, toBlocks } = require('./context-lines');

const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const GENERIC_HEADING = /^(test cases?|examples?( \d+)?|sample (input|output)|input( format)?|output( format)?|constraints?|explanation|notes?|hints?|question|problem( statement)?|description|solution|approach)$/;
const INSTRUCTION_KINDS = new Set(['instruction', 'heading', 'text', 'test_case', 'table']);
const SAME_THRESHOLD = 0.35;
// Two screens with different headings are the same problem only on near-identical text.
const DIFFERENT_TITLE_THRESHOLD = 0.8;
const MIN_SHINGLES = 12;
const MAX_SHINGLES = 4000;
const MAX_PROBLEMS = 8;

function shinglesOf(text) {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9_]+/g, ' ').split(' ').filter((w) => w.length >= 2);
  const out = new Set();
  for (let i = 0; i + 2 < words.length; i += 1) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

/** Instruction-like text of analysed records, plus a title guess. */
function instructionTextOf(records) {
  // Per panel: content coordinates of different panels overlap, and joining
  // them would merge a question line with a notebook line on the same row.
  const byPanel = new Map();
  for (const r of records) byPanel.set(r.containerId, (byPanel.get(r.containerId) || []).concat([r]));
  const blocks = [...byPanel.values()].flatMap((panel) => toBlocks(panel.flatMap(mapLines)));
  const kept = blocks.filter((b) => INSTRUCTION_KINDS.has(b.kind));
  const realHeading = kept.find((b) => b.kind === 'heading');
  const first = realHeading || kept[0];
  const title = first ? first.text.split('\n')[0].trim().slice(0, 80) : '';
  // Only real headings are identity evidence (not the first visible line of a
  // scrolled view), and not generic section names every problem has.
  const headings = blocks.filter((b) => b.kind === 'heading').map((b) => normTitle(b.text.split('\n')[0]))
    .filter((h) => h && !GENERIC_HEADING.test(h));
  return { text: kept.map((b) => b.text).join('\n'), title, headings };
}

/** |A ∩ B| / min(|A|, |B|): a partial view of a problem still matches the whole. */
function containment(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let hit = 0;
  for (const s of small) if (big.has(s)) hit += 1;
  return hit / small.size;
}

function createProblemTracker({ now = Date.now } = {}) {
  let seq = 0;
  const problems = [];
  let active = null;
  const epochProblem = new Map();

  function remember(problem, shingles) {
    for (const s of shingles) {
      if (problem.shingles.size >= MAX_SHINGLES) break;
      problem.shingles.add(s);
    }
    problem.lastSeenAt = now();
  }

  /**
   * observe({ records, epoch, title }) -> { decision, problem, previous }
   * decision: 'undetermined' | 'same' | 'revisit' | 'new'
   */
  /**
   * Shingles that two or more known problems share are template text
   * ("Example 1 Input Output", "Constraints"), not identity. They are left
   * out of the comparison when enough distinctive text remains.
   */
  function distinctive(shingles) {
    const seen = new Map();
    for (const p of problems) for (const s of p.shingles) seen.set(s, (seen.get(s) || 0) + 1);
    const rest = new Set([...shingles].filter((s) => (seen.get(s) || 0) < 2));
    return rest.size >= MIN_SHINGLES ? rest : shingles;
  }

  /** Same problem? Different headings need far stronger agreement than the base threshold. */
  function matches(shingles, headings, p) {
    const score = containment(shingles, p.shingles);
    const titlesDiffer = headings.length > 0 && p.headings.size > 0 && !headings.some((h) => p.headings.has(h));
    return { score, ok: score >= (titlesDiffer ? DIFFERENT_TITLE_THRESHOLD : SAME_THRESHOLD) };
  }

  function observe({ records, epoch }) {
    const { text, title, headings } = instructionTextOf(records);
    const all = shinglesOf(text);
    if (all.size < MIN_SHINGLES) return { decision: 'undetermined', problem: active, previous: active };
    const shingles = distinctive(all);

    if (active && matches(shingles, headings, active).ok) {
      remember(active, all);
      if (!active.title && title) active.title = title;
      for (const h of headings) active.headings.add(h);
      epochProblem.set(epoch, active.id);
      return { decision: 'same', problem: active, previous: active };
    }
    const previous = active;
    let best = null;
    let bestScore = -1;
    for (const p of problems) {
      if (p === active) continue;
      const m = matches(shingles, headings, p);
      if (m.ok && m.score > bestScore) { best = p; bestScore = m.score; }
    }
    let decision = 'revisit';
    if (!best) {
      seq += 1;
      best = { id: `p${seq}`, title, shingles: new Set(), headings: new Set(), firstSeenAt: now(), lastSeenAt: now() };
      problems.push(best);
      const evict = problems.length > MAX_PROBLEMS ? problems.findIndex((p) => p !== best && p !== active) : -1;
      if (evict >= 0) problems.splice(evict, 1);
      decision = previous ? 'new' : 'same';
    }
    remember(best, all);
    if (title && !best.title) best.title = title;
    for (const h of headings) best.headings.add(h);
    best.activatedAt = now();
    active = best;
    epochProblem.set(epoch, best.id);
    return { decision, problem: best, previous };
  }

  /** Content similarity of some records to the active problem; null when there is too little text to tell. */
  function similarityToActive(records) {
    if (!active) return null;
    const shingles = shinglesOf(instructionTextOf(records).text);
    return shingles.size < MIN_SHINGLES ? null : containment(shingles, active.shingles);
  }

  function describe() {
    return active ? { id: active.id, title: active.title || '', since: active.activatedAt || active.firstSeenAt, known: problems.length } : null;
  }

  return {
    observe,
    similarityToActive,
    describe,
    activeId: () => (active ? active.id : null),
    problemOfEpoch: (epoch) => epochProblem.get(epoch) || null,
    knows: (id) => Boolean(id) && problems.some((p) => p.id === id),
    reset() { problems.length = 0; active = null; epochProblem.clear(); },
  };
}

module.exports = { createProblemTracker, shinglesOf, containment, instructionTextOf, SAME_THRESHOLD, MIN_SHINGLES };
