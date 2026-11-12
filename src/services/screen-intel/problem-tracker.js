'use strict';

// Decides which problem the user is looking at. A problem is identified by the
// words of its instructions (headings, prose, test cases), never by code or
// outputs, which change while the user works on the same problem.
//
// Two screens are the same problem when enough of the smaller one's word
// shingles appear in the other. Too little instruction text means "not
// determined yet": the tracker keeps the current problem and says so instead
// of guessing.
//
// The registry outlives a monitoring run (Stop/Start) and can be exported and
// imported, so problems survive an app restart. Epoch numbers restart with
// every run, so the epoch -> problem map is per run (newRun()).

const { mapLines, toBlocks } = require('./context-lines');

const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const GENERIC_HEADING = /^(test cases?|examples?( \d+)?|sample (input|output)|input( format)?|output( format)?|constraints?|explanation|notes?|hints?|question|problem( statement)?|description|solution|approach)$/;
const INSTRUCTION_KINDS = new Set(['instruction', 'heading', 'text', 'test_case', 'table']);
// "Question 7", "Q7.", "Problem 2: …", "Exercise 3". Sub-steps ("Part 2",
// "Task 1", "Step 3") are deliberately not problem identifiers.
const IDENTIFIER = /^(?:question|problem|exercise|q)\s*(?:no\.?|#)?\s*[.:-]?\s*(\d{1,3})(?!\d)/i;
const SAME_THRESHOLD = 0.35;
// Two screens with different headings are the same problem only on near-identical text.
const DIFFERENT_TITLE_THRESHOLD = 0.8;
const MIN_SHINGLES = 12;
const MAX_SHINGLES = 4000;
const MAX_PROBLEMS = 50;
// Only the most recently active problems keep the word shingles needed to
// recognise them automatically. Older ones keep identity, title, timestamps
// and digest, so they stay listed and can still be switched to.
const RECOGNISABLE_PROBLEMS = 12;
const EXPORT_SHINGLES = 1500;
const MAX_DIGEST_CHARS = 8000;

function shinglesOf(text) {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9_]+/g, ' ').split(' ').filter((w) => w.length >= 2);
  const out = new Set();
  for (let i = 0; i + 2 < words.length; i += 1) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

function identifierOf(text) {
  const m = String(text || '').trim().match(IDENTIFIER);
  return m ? String(Number(m[1])) : null;
}

const isGenericHeading = (norm) => !norm || GENERIC_HEADING.test(norm);

/** Identity evidence from layout blocks: instruction text, title, real headings, identifiers. */
function evidenceOfBlocks(blocks) {
  const kept = blocks.filter((b) => INSTRUCTION_KINDS.has(b.kind));
  const realHeading = kept.find((b) => b.kind === 'heading' && !isGenericHeading(normTitle(b.text.split('\n')[0])));
  const first = realHeading || kept[0];
  const title = first ? first.text.split('\n')[0].trim().slice(0, 80) : '';
  // Only real headings are identity evidence (not the first visible line of a
  // scrolled view), and not generic section names every problem has.
  const headings = blocks.filter((b) => b.kind === 'heading').map((b) => normTitle(b.text.split('\n')[0])).filter((h) => !isGenericHeading(h));
  const identifiers = blocks.map((b) => identifierOf(b.text.split('\n')[0])).filter(Boolean);
  return {
    text: kept.map((b) => b.text).join('\n'),
    title,
    titleHeight: realHeading && realHeading.contentRect ? realHeading.contentRect.h : null,
    headings,
    identifiers,
  };
}

/** Instruction-like text of analysed records, plus a title guess. */
function instructionTextOf(records) {
  // Per panel: content coordinates of different panels overlap, and joining
  // them would merge a question line with a notebook line on the same row.
  const byPanel = new Map();
  for (const r of records) byPanel.set(r.containerId, (byPanel.get(r.containerId) || []).concat([r]));
  return evidenceOfBlocks([...byPanel.values()].flatMap((panel) => toBlocks(panel.flatMap(mapLines))));
}

/** |A ∩ B| / min(|A|, |B|): a partial view of a problem still matches the whole. */
function containment(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let hit = 0;
  for (const s of small) if (big.has(s)) hit += 1;
  return hit / small.size;
}

function createProblemTracker({ now = Date.now, onChange = () => {} } = {}) {
  let seq = 0;
  const problems = [];
  let active = null;
  let epochProblem = new Map();

  const changed = () => { try { onChange(); } catch (_) { /* listener errors never break tracking */ } };
  const byId = (id) => problems.find((p) => p.id === id) || null;

  function makeProblem({ origin = 'auto', title = '' } = {}) {
    seq += 1;
    const at = now();
    const p = {
      id: `p${seq}`, title, origin, shingles: new Set(), headings: new Set(), identifiers: new Set(), titleHeight: null,
      createdAt: at, lastActiveAt: at, activatedAt: at, bound: false, digest: '', digestAt: null, restoredDigest: '',
    };
    problems.push(p);
    trim();
    return p;
  }

  /** Bounded registry: identity is never evicted while the cap allows; shingles are. */
  function trim() {
    const byRecency = problems.slice().sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    byRecency.slice(RECOGNISABLE_PROBLEMS).forEach((p) => { if (p !== active) p.shingles.clear(); });
    while (problems.length > MAX_PROBLEMS) {
      const oldest = byRecency.pop();
      if (oldest === active) break;
      problems.splice(problems.indexOf(oldest), 1);
    }
  }

  function remember(problem, evidence) {
    for (const s of shinglesOf(evidence.text)) {
      if (problem.shingles.size >= MAX_SHINGLES) break;
      problem.shingles.add(s);
    }
    for (const h of evidence.headings || []) problem.headings.add(h);
    for (const i of evidence.identifiers || []) problem.identifiers.add(i);
    if (!problem.title && evidence.title) problem.title = evidence.title;
    if (!problem.titleHeight && evidence.titleHeight) problem.titleHeight = evidence.titleHeight;
    problem.bound = problem.bound || shinglesOf(evidence.text).size >= MIN_SHINGLES;
    problem.lastActiveAt = now();
  }

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

  /** Best known problem for some evidence, without changing anything. */
  function bestMatch(evidence, { exclude = [] } = {}) {
    const all = shinglesOf(evidence.text);
    if (all.size < MIN_SHINGLES) return { enough: false, problem: null, score: 0 };
    const shingles = distinctive(all);
    let best = null;
    let bestScore = -1;
    for (const p of problems) {
      if (exclude.includes(p.id) || !p.shingles.size) continue;
      const m = matches(shingles, evidence.headings || [], p);
      if (m.ok && m.score > bestScore) { best = p; bestScore = m.score; }
    }
    return { enough: true, problem: best, score: best ? bestScore : 0 };
  }

  /** Containment of the evidence in one problem; null when there is too little text to tell. */
  function similarityTo(id, evidence) {
    const p = byId(id);
    const shingles = shinglesOf(evidence.text);
    if (!p || shingles.size < MIN_SHINGLES) return null;
    return containment(shingles, p.shingles);
  }

  function setActive(p) {
    if (active === p) { p.lastActiveAt = now(); return; }
    active = p;
    p.activatedAt = now();
    p.lastActiveAt = p.activatedAt;
  }

  /**
   * observe({ records | evidence, epoch }) -> { decision, problem, previous }
   * decision: 'undetermined' | 'same' | 'revisit' | 'new'
   */
  function observe({ records, evidence, epoch }) {
    const ev = evidence || instructionTextOf(records || []);
    if (shinglesOf(ev.text).size < MIN_SHINGLES) return { decision: 'undetermined', problem: active, previous: active };
    const previous = active;
    const shingles = distinctive(shinglesOf(ev.text));
    if (active && active.shingles.size && matches(shingles, ev.headings, active).ok) {
      remember(active, ev);
      epochProblem.set(epoch, active.id);
      changed();
      return { decision: 'same', problem: active, previous };
    }
    const found = bestMatch(ev, { exclude: active ? [active.id] : [] }).problem;
    let decision = 'revisit';
    let best = found;
    if (!best) {
      best = makeProblem({ origin: 'auto' });
      decision = previous ? 'new' : 'same';
    }
    remember(best, ev);
    setActive(best);
    epochProblem.set(epoch, best.id);
    changed();
    return { decision, problem: best, previous };
  }

  /** A problem the user asked for (New Problem, active at once), or one found under a boundary. */
  function create({ origin = 'explicit', title = '', activate: makeActive = true } = {}) {
    const p = makeProblem({ origin, title });
    if (makeActive) setActive(p);
    changed();
    return p;
  }

  function activate(id) {
    const p = byId(id);
    if (!p) return null;
    setActive(p);
    changed();
    return p;
  }

  /** Teaches a problem the text now known to belong to it. */
  function learn(id, evidence) {
    const p = byId(id);
    if (!p) return null;
    remember(p, evidence);
    changed();
    return p;
  }

  function setDigest(id, text) {
    const p = byId(id);
    const next = String(text || '').slice(0, MAX_DIGEST_CHARS);
    if (!p || !next.trim() || p.digest === next) return;
    p.digest = next;
    p.digestAt = now();
    changed();
  }

  function summary(p) {
    return {
      id: p.id, title: p.title || '', origin: p.origin, createdAt: p.createdAt, lastActiveAt: p.lastActiveAt,
      active: p === active, recognisable: p.shingles.size > 0, hasDigest: Boolean(p.digest),
    };
  }

  function describe() {
    return active ? { id: active.id, title: active.title || '', origin: active.origin, since: active.activatedAt || active.createdAt, known: problems.length } : null;
  }

  /** Plain JSON for persistence; shingles of recently active problems only, bounded. */
  function exportState() {
    const recent = new Set(problems.slice().sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, RECOGNISABLE_PROBLEMS).map((p) => p.id));
    return {
      version: 1,
      seq,
      activeId: active ? active.id : null,
      problems: problems.map((p) => ({
        id: p.id, title: p.title, origin: p.origin, createdAt: p.createdAt, lastActiveAt: p.lastActiveAt, titleHeight: p.titleHeight,
        headings: [...p.headings], identifiers: [...p.identifiers], digest: p.digest, digestAt: p.digestAt,
        shingles: recent.has(p.id) ? [...p.shingles].slice(0, EXPORT_SHINGLES) : [],
      })),
    };
  }

  /**
   * Restores a saved registry. Nothing is active afterwards: the screen
   * decides (a saved problem shown again is a revisit).
   */
  function importState(saved) {
    problems.length = 0;
    active = null;
    epochProblem = new Map();
    seq = 0;
    if (!saved || !Array.isArray(saved.problems)) return;
    for (const raw of saved.problems.slice(-MAX_PROBLEMS)) {
      if (!raw || typeof raw.id !== 'string' || !/^p\d+$/.test(raw.id)) continue;
      const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now();
      problems.push({
        id: raw.id, title: String(raw.title || '').slice(0, 80), origin: raw.origin === 'explicit' ? 'explicit' : 'auto',
        shingles: new Set((raw.shingles || []).filter((s) => typeof s === 'string').slice(0, MAX_SHINGLES)),
        headings: new Set((raw.headings || []).filter((s) => typeof s === 'string')),
        identifiers: new Set((raw.identifiers || []).filter((s) => typeof s === 'string')),
        titleHeight: Number.isFinite(raw.titleHeight) ? raw.titleHeight : null,
        createdAt, lastActiveAt: Number.isFinite(raw.lastActiveAt) ? raw.lastActiveAt : createdAt, activatedAt: null,
        bound: true, digest: String(raw.digest || '').slice(0, MAX_DIGEST_CHARS), digestAt: Number.isFinite(raw.digestAt) ? raw.digestAt : null,
        // Text read before the restart: the only copy of it this run has.
        restoredDigest: String(raw.digest || '').slice(0, MAX_DIGEST_CHARS),
      });
      seq = Math.max(seq, Number(raw.id.slice(1)));
    }
    seq = Math.max(seq, Number(saved.seq) || 0);
  }

  return {
    observe,
    create,
    activate,
    learn,
    bestMatch,
    similarityTo,
    similarityToActive: (records) => (active ? similarityTo(active.id, instructionTextOf(records)) : null),
    setDigest,
    describe,
    get: byId,
    list: () => problems.slice().sort((a, b) => b.lastActiveAt - a.lastActiveAt).map(summary),
    activeId: () => (active ? active.id : null),
    problemOfEpoch: (epoch) => epochProblem.get(epoch) || null,
    setEpochProblem: (epoch, id) => { if (id) epochProblem.set(epoch, id); else epochProblem.delete(epoch); },
    knows: (id) => Boolean(id) && problems.some((p) => p.id === id),
    /** A new monitoring run: its epoch numbers start over. Problems stay. */
    newRun() { epochProblem = new Map(); },
    exportState,
    importState,
    reset() { problems.length = 0; active = null; epochProblem = new Map(); seq = 0; changed(); },
  };
}

module.exports = {
  createProblemTracker, shinglesOf, containment, instructionTextOf, evidenceOfBlocks, identifierOf, isGenericHeading, normTitle,
  SAME_THRESHOLD, MIN_SHINGLES, INSTRUCTION_KINDS,
};
