'use strict';

// What the user decides about problems: start a new one, return to an earlier
// one, or settle a boundary the session was unsure about. Scrolling navigates
// content; these actions change context.
//
// Starting or returning to a problem begins a new screen epoch in the capture
// engine, so the problem starts with a clean coverage state and a fresh read
// of what is visible. Work already running on the previous screen finishes
// and stays with the previous problem (its regions carry its stamp).

const pb = require('./problem-boundaries');

// A second New Problem is refused while the new one is still empty: for this
// long at least, and after that until it has read anything at all.
const EMPTY_GRACE_MS = 10000;

function createExplicitProblems({ getRun, tracker, identity, engineControl, adoptEpoch, now, log, refresh }) {
  let inFlight = null;
  let bindNext = null;

  /** Problem to bind to the first screen of the next run (chosen while monitoring was stopped). */
  function takePendingBind() { const id = bindNext; bindNext = null; return tracker.knows(id) ? id : null; }
  /** The registry was replaced (another conversation): a problem chosen for the next screen no longer exists. */
  function clearPendingBind() { bindNext = null; }

  /** Undecided boundaries in view become the start of this problem: the user just said so. */
  function claimVisibleCandidates(run, problemId) {
    const candidate = identity.candidateOf(run);
    if (!candidate) return;
    for (const entry of run.cuts.values()) {
      const cut = entry.cuts.find((k) => k.id === candidate.id);
      if (cut) Object.assign(cut, { status: 'confirmed', problemId, decision: 'explicit' });
    }
  }

  async function transition(problem, decision) {
    const run = getRun();
    const before = tracker.activeId();
    if (!run.sessionId || run.stopped) {
      bindNext = problem.id;
      tracker.activate(problem.id);
      identity.notify(run, before, decision);
      refresh();
      return { success: true, problem: tracker.describe(), pending: 'next-start' };
    }
    claimVisibleCandidates(run, problem.id);
    const target = run.epoch + 1;
    run.explicitEpochs.set(target, problem.id);
    let epoch = null;
    try {
      epoch = await engineControl.beginEpoch({ epoch: target });
    } catch (error) {
      log('begin-epoch-failed', error);
    }
    if (tracker.get(problem.id) !== problem) {
      // The problem registry was replaced (another conversation opened) while the engine answered.
      run.explicitEpochs.delete(target);
      return { success: false, code: 'REGISTRY_CHANGED', message: 'The conversation changed. Press New problem again.' };
    }
    if (run !== getRun() || run.stopped) {
      run.explicitEpochs.delete(target);
      bindNext = problem.id;
      tracker.activate(problem.id);
      identity.notify(run, before, decision);
      return { success: true, problem: tracker.describe(), pending: 'next-start' };
    }
    tracker.activate(problem.id);
    if (Number.isFinite(epoch) && epoch > run.epoch) {
      if (epoch !== target) { run.explicitEpochs.delete(target); run.explicitEpochs.set(epoch, problem.id); }
      tracker.setEpochProblem(epoch, problem.id);
      run.lateEpoch = run.epoch;
      run.lateUntil = now();
      adoptEpoch(epoch, { preserveInflight: true });
    } else {
      // The engine could not start a new screen (capture restarting): what it captures from now on, and the
      // next screen it reports, are this problem's. Earlier regions keep their stamps.
      run.explicitEpochs.delete(target);
      tracker.setEpochProblem(run.epoch, problem.id);
      run.bindNextEpoch = problem.id;
    }
    identity.notify(run, before, decision);
    refresh();
    return { success: true, problem: tracker.describe(), pending: Number.isFinite(epoch) ? null : 'next-screen' };
  }

  function once(fn) {
    if (inFlight) return inFlight.then(() => ({ success: false, code: 'BUSY', message: 'A problem change is already in progress.', problem: tracker.describe() }));
    inFlight = Promise.resolve().then(fn).finally(() => { inFlight = null; });
    return inFlight;
  }

  /** True while the active problem is one the user just started and it is still empty. */
  function activeIsEmptyNew() {
    const active = tracker.get(tracker.activeId());
    if (!active || active.origin !== 'explicit' || active.bound) return false;
    const read = getRun().ledger.list({ status: 'analysed' }).some((r) => r.problemId === active.id);
    return now() - active.createdAt < EMPTY_GRACE_MS || !read;
  }

  /**
   * Starts a new, independent problem. Refused while the active problem is a
   * new one that is still empty: a second press would only create a duplicate.
   */
  function newProblem() {
    return once(async () => {
      if (activeIsEmptyNew()) {
        return { success: false, code: 'ALREADY_NEW', message: 'A new problem was just started and has not read anything yet.', problem: tracker.describe() };
      }
      const problem = tracker.create({ origin: 'explicit', activate: false });
      return transition(problem, 'explicit');
    });
  }

  /** Returns to an earlier problem; its saved context comes back. */
  function activateProblem(id) {
    return once(async () => {
      const problem = tracker.get(id);
      if (!problem) return { success: false, code: 'UNKNOWN_PROBLEM', message: 'That problem is no longer available.' };
      const run = getRun();
      if (tracker.activeId() === id && tracker.problemOfEpoch(run.epoch) === id) return { success: true, unchanged: true, problem: tracker.describe() };
      return transition(problem, 'switch');
    });
  }

  /** Settles a possible boundary: 'new' starts a problem there, 'same' keeps it in the problem above. */
  function resolveCandidate(cutId, choice) {
    const run = getRun();
    const found = [...run.cuts.entries()].map(([key, entry]) => ({ key, entry, cut: entry.cuts.find((k) => k.id === cutId) })).find((x) => x.cut);
    if (!found || !['possible', 'watching'].includes(found.cut.status) || !['new', 'same'].includes(choice)) {
      return { success: false, code: 'NO_CANDIDATE', message: 'There is no undecided problem boundary to settle.' };
    }
    const { key, entry, cut } = found;
    const records = identity.liveRecordsOf(run, run.epoch).filter((r) => identity.keyOf(r.epoch, r.containerId, r.segmentId) === key);
    const blocks = pb.blocksOf(records);
    const evidence = pb.evidenceBetween(blocks, cut.pos, pb.partEnd(entry, cut));
    const before = tracker.activeId();
    if (choice === 'new') {
      const problem = tracker.create({ origin: 'explicit', title: cut.title, activate: false });
      identity.applyDecision(entry, cut, { status: 'confirmed', decision: 'confirmed', problemId: problem.id }, evidence);
      identity.activate(problem.id);
    } else {
      identity.applyDecision(entry, cut, { status: 'dismissed', decision: 'same' }, evidence);
      identity.activate(pb.ownerAbove(entry, cut));
    }
    identity.notify(run, before, choice === 'new' ? 'confirmed' : 'same');
    refresh();
    return { success: true, problem: tracker.describe() };
  }

  return { newProblem, activateProblem, resolveCandidate, takePendingBind, clearPendingBind };
}

module.exports = { createExplicitProblems };
