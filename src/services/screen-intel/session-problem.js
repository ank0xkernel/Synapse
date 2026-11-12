'use strict';

// Problem identity inside a screen session: decides, from analysed text and
// layout, which problem the screen shows and which captured content belongs
// to which problem.
//
// Every region is stamped with the problem known when it was captured, and
// that stamp is never rewritten by a later switch: a late OCR result keeps
// its problem. Inside one scrolling panel, boundaries between problems are
// positional cuts (see problem-boundaries.js); lines are attributed by
// position there. Scrolling alone never starts a problem: the active problem
// only follows the viewport across a confirmed boundary, after the scroll
// settles. Nothing of a previous problem is discarded.

const { spanOf, INFLIGHT } = require('./region-ledger');
const { SAME_THRESHOLD, MIN_SHINGLES, shinglesOf, instructionTextOf, isGenericHeading, normTitle } = require('./problem-tracker');
const pb = require('./problem-boundaries');

// A refresh this large, with different instructions, means the panel now shows
// other content (next question), not an edit of the same one.
const REPLACEMENT_VIEWPORT_FRACTION = 0.5;
const MAX_PAST_EPOCHS = 12;
const DEAD_RECORD_TTL_MS = 60000;
const DIGEST_INTERVAL_MS = 3000;
const DEAD = new Set(['superseded', 'cancelled']);
const LIVE = new Set(['analysed', 'retired']);

const keyOf = (epoch, containerId, segmentId) => `${epoch}|${containerId}|${segmentId}`;
const recKey = (r) => keyOf(r.epoch, r.containerId, r.segmentId);

function mergeEvidence(parts) {
  const withTitle = parts.find((p) => p.title);
  return {
    text: parts.map((p) => p.text).filter(Boolean).join('\n'),
    title: withTitle ? withTitle.title : '',
    titleHeight: (parts.find((p) => p.titleHeight) || {}).titleHeight || null,
    headings: parts.flatMap((p) => p.headings),
    identifiers: parts.flatMap((p) => p.identifiers),
  };
}

function groupByKey(records) {
  const groups = new Map();
  for (const r of records) groups.set(recKey(r), (groups.get(recKey(r)) || []).concat([r]));
  return groups;
}

function createProblemIdentity({ getRun, tracker, isVisible, now, log, onProblemChange, onReplaced = () => {}, digestOf = () => '' }) {
  let cutSeq = 0;
  const nextCutId = () => { cutSeq += 1; return `k${cutSeq}`; };

  function epochSettled(run, epoch) {
    const c = run.ledger.counts({ epoch });
    return c.captured + c.analysing + c.new === 0;
  }

  const liveRecordsOf = (run, epoch) => run.ledger.list({ epoch, status: 'analysed' }).filter((r) => !r.duplicateOf);

  /** Problem a region captured now belongs to, when it is already known. */
  function stampFor(run, epoch) {
    if (run.explicitEpochs.has(epoch)) return run.explicitEpochs.get(epoch);
    return run.evaluatedEpochs.get(epoch) === 'identified' ? tracker.problemOfEpoch(epoch) : null;
  }

  /** Owner of one line: a problem id, pb.HELD, or null when nothing is known yet. */
  function ownerOfLine(run, rec, y) {
    if (rec.cutEntry) return pb.attributeAt(rec.cutEntry, y);
    const entry = run.cuts.get(recKey(rec));
    if (entry) return pb.attributeAt(entry, y);
    return rec.problemId || tracker.problemOfEpoch(rec.epoch) || null;
  }

  function coversViewport(run, rec) {
    const c = run.containers.get(rec.containerId);
    if (!c || !c.viewport || !rec.contentRect) return false;
    const axis = c.axis === 'x' ? 'x' : 'y';
    const [a, b] = spanOf(rec.contentRect, axis);
    const [v0, v1] = spanOf(c.viewport, axis);
    return Math.max(0, Math.min(b, v1) - Math.max(a, v0)) >= REPLACEMENT_VIEWPORT_FRACTION * (v1 - v0);
  }

  function activate(run, id) {
    if (!id || tracker.activeId() === id) return false;
    tracker.activate(id);
    tracker.setEpochProblem(run.epoch, id);
    return true;
  }

  /** Everything of the screen captured before it was identified, including failed regions retried later. */
  function stampUnassigned(run, epoch, id) {
    for (const r of run.ledger.list({ epoch })) if (!r.problemId) r.problemId = id;
  }

  // ---- first identification of a screen --------------------------------------
  /**
   * Reads the whole screen once. A panel holding several problems (a
   * numbered question list) is split at its boundary headings first, so the
   * problem is identified from the part the user is looking at, not from a
   * mix of two.
   */
  function identifyEpoch(run) {
    const epoch = run.epoch;
    const explicit = run.explicitEpochs.get(epoch) || null;
    const parts = [];
    const plans = [];
    for (const [key, list] of groupByKey(liveRecordsOf(run, epoch))) {
      const containerId = list[0].containerId;
      const blocks = pb.blocksOf(list);
      const title = blocks.find((b) => b.kind === 'heading' && !isGenericHeading(normTitle(b.text.split('\n')[0])));
      const heads = pb.boundaryHeadings(blocks, { titleHeight: title ? title.contentRect.h : null, allowTitleLevel: containerId !== 'root' })
        .filter((h) => h.identifier || !title || Math.abs(h.pos - title.y0) > pb.POS_TOL);
      if (!heads.length) { parts.push(pb.evidenceBetween(blocks, -Infinity)); continue; }
      const stops = [-Infinity, ...heads.map((h) => h.pos), Infinity];
      const pieces = stops.slice(0, -1).map((from, i) => pb.evidenceBetween(blocks, from, stops[i + 1]));
      const c = run.containers.get(containerId);
      const axis = c && c.axis === 'x' ? 'x' : 'y';
      const center = c && c.viewport ? pb.readingLine(...spanOf(c.viewport, axis)) : null;
      let focus = center === null ? 0 : stops.findIndex((s, i) => center >= s && center < stops[i + 1]);
      if (focus < 0 || shinglesOf(pieces[focus].text).size < MIN_SHINGLES) {
        const sizes = pieces.map((p) => shinglesOf(p.text).size);
        focus = sizes.indexOf(Math.max(...sizes));
      }
      plans.push({ key, heads, focus });
      parts.push(pieces[focus]);
    }
    const evidence = mergeEvidence(parts);
    let problemId;
    let decision;
    if (explicit) {
      const p = tracker.get(explicit);
      // A problem switched to explicitly only learns text that matches it; a brand-new one learns this screen.
      if (p && (!p.bound || (tracker.similarityTo(explicit, evidence) ?? 0) >= SAME_THRESHOLD)) tracker.learn(explicit, evidence);
      if (shinglesOf(evidence.text).size < MIN_SHINGLES && !(p && p.bound)) return 'explicit';
      problemId = explicit;
      decision = 'explicit';
    } else {
      const result = tracker.observe({ evidence, epoch });
      if (result.decision === 'undetermined') { run.evaluatedEpochs.set(epoch, 'undetermined'); return result.decision; }
      problemId = result.problem.id;
      decision = result.decision;
    }
    run.evaluatedEpochs.set(epoch, 'identified');
    tracker.setEpochProblem(epoch, problemId);
    for (const plan of plans) {
      const entry = { base: plan.focus === 0 ? problemId : null, cuts: [] };
      pb.mergeHeadings(entry, plan.heads, nextCutId);
      if (plan.focus > 0) Object.assign(entry.cuts[plan.focus - 1], { status: 'confirmed', problemId });
      run.cuts.set(plan.key, entry);
    }
    stampUnassigned(run, epoch, problemId);
    return decision;
  }

  // ---- boundaries while scrolling ----------------------------------------------
  function firstSegmentOf(run, epoch, containerId) {
    const segs = run.ledger.list({ epoch, containerId }).map((r) => r.segmentId);
    return segs.length ? Math.min(...segs) : null;
  }

  function dominantStamp(list) {
    const counts = new Map();
    for (const r of list) if (r.problemId) counts.set(r.problemId, (counts.get(r.problemId) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }

  function applyDecision(entry, cut, d, evidence) {
    if (d.status === 'confirmed') {
      const id = d.problemId || tracker.create({ origin: 'auto', title: cut.title, activate: false }).id;
      Object.assign(cut, { status: 'confirmed', problemId: id, decision: d.decision });
      tracker.learn(id, evidence);
    } else if (d.status === 'dismissed') {
      cut.status = 'dismissed';
      const above = pb.ownerAbove(entry, cut);
      if (above && above !== pb.HELD) tracker.learn(above, { ...evidence, headings: [cut.norm], identifiers: cut.identifier ? [cut.identifier] : [] });
    } else {
      cut.status = d.status;
    }
  }

  /** Proposes and decides boundaries in every panel of the current screen. */
  function scanBoundaries(run) {
    const epoch = run.epoch;
    for (const [key, list] of groupByKey(liveRecordsOf(run, epoch).filter((r) => !r.cutEntry))) {
      const { containerId, segmentId } = list[0];
      let entry = run.cuts.get(key);
      const blocks = pb.blocksOf(list);
      const base = entry ? entry.base : dominantStamp(list) || tracker.problemOfEpoch(epoch) || tracker.activeId();
      if (!base && !entry) continue;
      const ownerAt = (pos) => (entry ? pb.attributeAt(entry, pos - pb.POS_TOL - 1) : base);
      const reference = tracker.get(entry && entry.base ? entry.base : base);
      const heads = pb.boundaryHeadings(blocks, { titleHeight: reference ? reference.titleHeight : null, allowTitleLevel: containerId !== 'root' })
        .filter((h) => {
          const owner = tracker.get(ownerAt(h.pos));
          return !(owner && (owner.headings.has(h.norm) || (h.identifier && owner.identifiers.has(h.identifier))));
        });
      if (!entry && !heads.length) continue;
      if (!entry) { entry = { base, cuts: [] }; run.cuts.set(key, entry); }
      pb.mergeHeadings(entry, heads, nextCutId);
      const gapSegment = segmentId !== firstSegmentOf(run, epoch, containerId);
      const top = blocks.length ? blocks[0].y0 : 0;
      for (const cut of entry.cuts) {
        if (cut.status !== 'watching' && cut.status !== 'possible') continue;
        const evidence = pb.evidenceBetween(blocks, cut.pos, pb.partEnd(entry, cut));
        const structural = gapSegment && cut.pos <= top + pb.POS_TOL;
        const above = pb.ownerAbove(entry, cut);
        applyDecision(entry, cut, pb.decideCut({ cut, evidence, above, known: pb.knownOwnerAbove(entry, cut), tracker, structural }), evidence);
      }
      if (entry.base === null) {
        const first = pb.liveCuts(entry)[0];
        const found = tracker.bestMatch(pb.evidenceBetween(blocks, -Infinity, first ? first.pos : Infinity)).problem;
        if (found) entry.base = found.id;
      }
    }
  }

  /**
   * The active problem follows the viewport across confirmed boundaries: the
   * owner of the reading line of the panel the user scrolled last, unless
   * that line sits right at a boundary. Never while anything moves; held
   * (undecided) content never becomes active.
   */
  function followViewport(run) {
    if (run.motion.size) return false;
    const ids = [run.lastSettledContainer, ...run.containers.keys()].filter((id) => id && run.containers.has(id));
    for (const id of ids) {
      const c = run.containers.get(id);
      const entry = c.viewport && run.cuts.get(keyOf(run.epoch, id, c.segmentId));
      if (!entry) continue;
      const axis = c.axis === 'x' ? 'x' : 'y';
      const [v0, v1] = spanOf(c.viewport, axis);
      const owner = pb.ownerInView(entry, v0, v1);
      return Boolean(owner && owner !== pb.HELD) && activate(run, owner);
    }
    return false;
  }

  // ---- in-place replacement of a panel -------------------------------------------
  /**
   * The panel now shows other instructions in place (next question, no scene
   * change). What was read of it before, now scrolled out of view, is the
   * previous problem's text: it is retired (kept for that problem, no longer
   * counted as on screen), never discarded. The engine forgets its coverage
   * outside the view so the new content there is captured when scrolled to.
   */
  function handleReplacement(run, rec) {
    const previous = tracker.activeId();
    const retired = new Map([...run.cuts].filter(([key]) => key.startsWith(`${run.epoch}|${rec.containerId}|`)));
    for (const key of retired.keys()) run.cuts.delete(key);
    for (const old of liveRecordsOf(run, run.epoch)) {
      if (old.containerId !== rec.containerId || old.seq >= rec.seq || isVisible(old)) continue;
      const entry = retired.get(recKey(old));
      if (entry) old.cutEntry = entry;
      if (!old.problemId) old.problemId = previous;
      run.ledger.releaseImage(old.id);
      run.ledger.setStatus(old.id, 'retired', { error: { code: 'PROBLEM_CHANGED', message: 'The panel now shows different content.' } });
    }
    // The visible part was superseded when the refresh arrived, before anyone
    // knew it was a different problem: it is the previous problem's text too.
    // (Usually by the 'stale' overlay that announced the change, which the refresh then replaced.)
    const superseded = run.ledger.list({ epoch: run.epoch, containerId: rec.containerId, status: 'superseded' });
    const by = new Set([rec.id, ...superseded.filter((r) => r.supersededBy === rec.id).map((r) => r.id)]);
    for (const old of superseded) {
      if (!by.has(old.supersededBy) || !old.lines.length) continue;
      if (!old.problemId) old.problemId = previous;
      run.ledger.setStatus(old.id, 'retired', { error: { code: 'PROBLEM_CHANGED', message: 'The panel now shows different content.' } });
    }
    const visible = liveRecordsOf(run, run.epoch).filter((r) => r.containerId === rec.containerId && isVisible(r) && r.seq >= rec.seq);
    const evidence = instructionTextOf(visible);
    const found = tracker.bestMatch(evidence, { exclude: previous ? [previous] : [] }).problem;
    const next = found || tracker.create({ origin: 'auto', activate: false });
    tracker.learn(next.id, evidence);
    for (const r of visible) r.problemId = next.id;
    activate(run, next.id);
    try { onReplaced(rec.containerId); } catch (error) { log('replace-hook-failed', error); }
    return found ? 'revisit' : 'new';
  }

  function notify(run, before, decision) {
    const after = tracker.activeId();
    if (!after || after === before) return;
    run.problemChangedAt = now();
    if (before) refreshDigest(before, true);
    log('problem-change', { from: before, to: after, decision });
    if (typeof onProblemChange === 'function') {
      try { onProblemChange({ ...tracker.describe(), previousId: before, decision, sessionId: run.sessionId }); } catch (error) { log('problem-listener-failed', error); }
    }
  }

  const digestAt = new Map();
  /** Keeps a bounded copy of a problem's read text, for recovery after a restart. */
  function refreshDigest(id, force = false) {
    if (!id || (!force && now() - (digestAt.get(id) || -Infinity) < DIGEST_INTERVAL_MS)) return;
    digestAt.set(id, now());
    try { tracker.setDigest(id, digestOf(id)); } catch (error) { log('digest-failed', error); }
  }

  /** Called after each analysis result. Only real text decides; nothing is assumed from timing. */
  function evaluateProblem(run, rec) {
    if (run !== getRun() || rec.epoch !== run.epoch) return;
    const before = tracker.activeId();
    const identified = run.evaluatedEpochs.get(run.epoch) === 'identified';
    let decision = null;
    if (rec.kind === 'refresh' && identified && before && coversViewport(run, rec)) {
      const sim = tracker.similarityToActive([rec]);
      if (sim !== null && sim < SAME_THRESHOLD) decision = handleReplacement(run, rec);
    }
    if (!decision) {
      if (!epochSettled(run, run.epoch)) return;
      if (!identified) decision = identifyEpoch(run);
      if (run.evaluatedEpochs.get(run.epoch) === 'identified') {
        scanBoundaries(run);
        if (followViewport(run)) decision = 'scroll';
      }
    }
    notify(run, before, decision);
    refreshDigest(tracker.activeId());
  }

  /** Decides the current screen again from what is already read (after the problem registry was replaced). */
  function reevaluate() {
    const run = getRun();
    if (!run.sessionId || run.stopped) return; // a stopped screen is not read into the new registry
    const latest = liveRecordsOf(run, run.epoch).sort((a, b) => b.seq - a.seq)[0];
    if (latest) evaluateProblem(run, latest);
  }

  /** The scroll of a panel settled: the active problem may follow it across a boundary. */
  function onMotionSettled(run, containerId) {
    if (run !== getRun()) return;
    if (containerId) run.lastSettledContainer = containerId;
    if (run.evaluatedEpochs.get(run.epoch) !== 'identified') return;
    const before = tracker.activeId();
    if (followViewport(run)) notify(run, before, 'scroll');
  }

  // ---- what the UI and the prompt see ---------------------------------------------
  function candidateOf(run) {
    for (const [key, entry] of run.cuts) {
      const [epoch, containerId, segmentId] = key.split('|');
      const c = run.containers.get(containerId);
      if (Number(epoch) !== run.epoch || !c || !c.viewport || String(c.segmentId) !== segmentId) continue;
      const [v0, v1] = spanOf(c.viewport, c.axis === 'x' ? 'x' : 'y');
      const cut = pb.liveCuts(entry).find((k) => (k.status === 'possible' || k.status === 'watching') && k.pos < v1 && pb.partEnd(entry, k) > v0);
      if (cut) return { id: cut.id, title: cut.title, status: cut.status === 'possible' ? 'possible' : 'checking', containerId };
    }
    return null;
  }

  /** identified: the current screen's problem is known; detecting: still reading; undetermined: not enough instructions to tell. */
  function describeProblem() {
    const run = getRun();
    if (!run.sessionId) return null;
    const p = tracker.describe();
    const verdict = run.evaluatedEpochs.get(run.epoch) || (run.explicitEpochs.has(run.epoch) ? 'identified' : null);
    const status = verdict === 'undetermined' && run.explicitEpochs.has(run.epoch) ? 'identified' : verdict || 'detecting';
    const currentIsActive = status === 'identified' && p && tracker.problemOfEpoch(run.epoch) === p.id;
    return {
      id: currentIsActive ? p.id : null, title: currentIsActive ? p.title : '', origin: currentIsActive ? p.origin : null,
      status, changedAt: run.problemChangedAt, since: p ? p.since : null, candidate: candidateOf(run),
    };
  }

  /** Context options: lines are kept only when they belong to the problem on screen now. */
  function problemContextOptions(forProblemId) {
    const run = getRun();
    const problem = forProblemId ? null : describeProblem();
    const activeProblemId = forProblemId || (problem && problem.id) || null;
    const saved = activeProblemId ? tracker.get(activeProblemId) : null;
    return {
      problem,
      activeProblemId,
      attribute: (rec, y) => ownerOfLine(run, rec, y),
      candidate: problem ? problem.candidate : null,
      // Text read before a restart (or in another conversation's session) is only available as this saved copy.
      savedDigest: saved ? saved.restoredDigest : '',
    };
  }

  /**
   * Bounds the ledger in long sessions. The current screen keeps everything
   * except records that ended (superseded/cancelled) over a minute ago.
   * Earlier screens keep only analysed or retired text that belongs to a known
   * problem, for the last MAX_PAST_EPOCHS screens.
   */
  function pruneLedger() {
    const run = getRun();
    const cutoff = now() - DEAD_RECORD_TTL_MS;
    const known = (r) => tracker.knows(r.problemId || tracker.problemOfEpoch(r.epoch)) || Boolean(r.cutEntry) || run.cuts.has(recKey(r));
    const past = Array.from(new Set(run.ledger.all().filter((r) => r.epoch !== run.epoch && known(r)).map((r) => r.epoch)))
      .sort((a, b) => b - a)
      .slice(0, MAX_PAST_EPOCHS);
    const keepPast = new Set(past);
    const removed = run.ledger.prune((r) => {
      if (r.epoch === run.epoch) return !(DEAD.has(r.status) && (r.updatedAt || r.capturedAt || 0) < cutoff);
      // Work still running on a screen left by New Problem finishes for the previous problem.
      return keepPast.has(r.epoch) && (LIVE.has(r.status) || INFLIGHT.has(r.status)) && !r.duplicateOf;
    });
    if (removed) {
      for (const id of run.recap.keys()) if (!run.ledger.get(id)) run.recap.delete(id);
      const epochs = new Set(run.ledger.all().map((r) => r.epoch));
      for (const key of run.cuts.keys()) if (!epochs.has(Number(key.split('|')[0]))) run.cuts.delete(key);
    }
    return removed;
  }

  /** Moves a panel's boundaries when a gap closes and two segments become one. */
  function remapCuts(run, containerId, epoch, from, into, delta) {
    const moved = run.cuts.get(keyOf(epoch, containerId, from));
    if (!moved) return;
    run.cuts.delete(keyOf(epoch, containerId, from));
    const target = run.cuts.get(keyOf(epoch, containerId, into));
    const shifted = moved.cuts.map((c) => ({ ...c, pos: c.pos + delta }));
    if (!target) { run.cuts.set(keyOf(epoch, containerId, into), { base: moved.base, cuts: shifted }); return; }
    pb.mergeHeadings(target, shifted.map(({ id, status, problemId, ...h }) => h), nextCutId);
    for (const c of shifted) {
      const t = target.cuts.find((x) => Math.abs(x.pos - c.pos) <= pb.POS_TOL);
      if (t && t.status === 'watching' && c.status !== 'watching') Object.assign(t, { status: c.status, problemId: c.problemId });
    }
  }

  return {
    evaluateProblem, reevaluate, onMotionSettled, describeProblem, problemContextOptions, pruneLedger, stampFor, ownerOfLine,
    remapCuts, refreshDigest, candidateOf, activate: (id) => activate(getRun(), id), notify, liveRecordsOf, applyDecision, keyOf,
  };
}

function attachProblemState(run, tracker) {
  run.problems = tracker;
  tracker.newRun();
  run.evaluatedEpochs = new Map();
  run.explicitEpochs = new Map();
  run.cuts = new Map();
  run.lastSettledContainer = null;
  run.problemChangedAt = null;
}

module.exports = { createProblemIdentity, attachProblemState, REPLACEMENT_VIEWPORT_FRACTION };
