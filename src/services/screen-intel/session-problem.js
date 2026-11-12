'use strict';

// Problem identity inside a screen session: decides, from analysed text only,
// when the screen moved to a different problem and which records belong to
// the previous one.

const { spanOf } = require('./region-ledger');
const { SAME_THRESHOLD, createProblemTracker } = require('./problem-tracker');

// A refresh this large, with different instructions, means the panel now shows
// other content (next question), not an edit of the same one.
const REPLACEMENT_VIEWPORT_FRACTION = 0.5;
const MAX_PAST_EPOCHS = 12;
const DEAD_RECORD_TTL_MS = 60000;
const DEAD = new Set(['superseded', 'cancelled']);

function createProblemIdentity({ getRun, isVisible, now, log, onProblemChange }) {
  function epochSettled(run, epoch) {
    const c = run.ledger.counts({ epoch });
    return c.captured + c.analysing + c.new === 0;
  }

  function coversViewport(run, rec) {
    const c = run.containers.get(rec.containerId);
    if (!c || !c.viewport || !rec.contentRect) return false;
    const axis = c.axis === 'x' ? 'x' : 'y';
    const [a, b] = spanOf(rec.contentRect, axis);
    const [v0, v1] = spanOf(c.viewport, axis);
    return Math.max(0, Math.min(b, v1) - Math.max(a, v0)) >= REPLACEMENT_VIEWPORT_FRACTION * (v1 - v0);
  }

  function liveRecordsOf(run, epoch) {
    return run.ledger.list({ epoch, status: 'analysed' }).filter((r) => !r.duplicateOf);
  }

  /** Called after each analysis result. Only real text decides; nothing is assumed from timing. */
  function evaluateProblem(run, rec) {
    if (run !== getRun() || rec.epoch !== run.epoch) return;
    const replaced = rec.kind === 'refresh' && run.evaluatedEpochs.has(run.epoch) && coversViewport(run, rec)
      && (() => { const sim = run.problems.similarityToActive([rec]); return sim !== null && sim < SAME_THRESHOLD; })();
    if (replaced) {
      // The panel now shows other instructions. Parts of it read before, now
      // scrolled out of view, belong to the previous content.
      for (const old of liveRecordsOf(run, run.epoch)) {
        if (old.containerId !== rec.containerId || old.seq >= rec.seq || isVisible(old)) continue;
        run.ledger.releaseImage(old.id);
        run.ledger.setStatus(old.id, 'superseded', { error: { code: 'PROBLEM_CHANGED', message: 'Replaced by different content in the same panel.' } });
      }
    } else if (run.evaluatedEpochs.get(run.epoch) === 'identified' || !epochSettled(run, run.epoch)) {
      return;
    }
    const before = run.problems.activeId();
    const result = run.problems.observe({ records: liveRecordsOf(run, run.epoch), epoch: run.epoch });
    run.evaluatedEpochs.set(run.epoch, result.decision === 'undetermined' ? 'undetermined' : 'identified');
    const after = run.problems.activeId();
    if (after && after !== before) {
      run.problemChangedAt = now();
      log('problem-change', { from: before, to: after, decision: result.decision });
      if (typeof onProblemChange === 'function') {
        try { onProblemChange({ ...run.problems.describe(), previousId: before, decision: result.decision, sessionId: run.sessionId }); } catch (error) { log('problem-listener-failed', error); }
      }
    }
  }

  /** identified: the current screen's problem is known; detecting: still reading; undetermined: not enough instructions to tell. */
  function problemStatus() {
    if (!getRun().sessionId) return null;
    const verdict = getRun().evaluatedEpochs.get(getRun().epoch);
    return verdict || 'detecting';
  }

  function describeProblem() {
    const p = getRun().problems.describe();
    const status = problemStatus();
    if (!status) return null;
    const currentIsActive = status === 'identified' && p && getRun().problems.problemOfEpoch(getRun().epoch) === p.id;
    return { id: currentIsActive ? p.id : null, title: currentIsActive ? p.title : '', status, changedAt: getRun().problemChangedAt, since: p ? p.since : null };
  }

  /**
   * Bounds the ledger in long sessions. The current screen keeps everything
   * except records that ended (superseded/cancelled) over a minute ago.
   * Earlier screens keep only analysed text, and only for the last
   * MAX_PAST_EPOCHS screens that belong to a known problem; that is all
   * context building can ever use from them.
   */
  function pruneLedger() {
    const run = getRun();
    const cutoff = now() - DEAD_RECORD_TTL_MS;
    const past = Array.from(new Set(run.ledger.all().map((r) => r.epoch)))
      .filter((e) => e !== run.epoch && run.problems.knows(run.problems.problemOfEpoch(e)))
      .sort((a, b) => b - a)
      .slice(0, MAX_PAST_EPOCHS);
    const keepPast = new Set(past);
    const removed = run.ledger.prune((r) => {
      if (r.epoch === run.epoch) return !(DEAD.has(r.status) && (r.updatedAt || r.capturedAt || 0) < cutoff);
      return keepPast.has(r.epoch) && r.status === 'analysed' && !r.duplicateOf;
    });
    if (removed) for (const id of run.recap.keys()) if (!run.ledger.get(id)) run.recap.delete(id);
    return removed;
  }

  /** Earlier screens join the context only when they show the current screen's problem. */
  function problemContextOptions() {
    const problem = describeProblem();
    const includeEpoch = (epoch) => Boolean(problem && problem.id) && getRun().problems.problemOfEpoch(epoch) === problem.id;
    return { problem, includeEpoch };
  }

  return { evaluateProblem, describeProblem, problemContextOptions, pruneLedger };
}

function attachProblemState(run, now) {
  run.problems = createProblemTracker({ now });
  run.evaluatedEpochs = new Map();
  run.problemChangedAt = null;
}

module.exports = { createProblemIdentity, attachProblemState, REPLACEMENT_VIEWPORT_FRACTION };
