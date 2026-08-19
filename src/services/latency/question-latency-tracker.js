'use strict';

/**
 * End-to-end latency instrumentation, T0 (question detected) through T6
 * (browser/phone renders the first answer chunk).
 *
 * Existing per-file console logs already report isolated numbers ("first
 * token generated!") but none of them share a clock or a question identity,
 * so there was no way to answer "how long did THIS question actually take."
 * This gives every question a single id and one shared timeline, and prints
 * the exact stage breakdown the spec calls for — not just a total.
 */

const STAGES = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6'];

const STAGE_LABELS = {
  T0: 'detected',
  T1: 'transcriptReady',
  T2: 'confirmed',
  T3: 'contextAssembled',
  T4: 'requestSent',
  T5: 'firstToken',
  T6: 'browserFirstChunk'
};

function createQuestionLatencyTracker({ onComplete = () => {}, log = console.log } = {}) {
  const inFlight = new Map();
  let sequence = 0;

  function nextId() {
    sequence += 1;
    return `q${Date.now().toString(36)}${sequence}`;
  }

  /**
   * Opens a new timeline and returns its id — call this first, always.
   * @param {number} [t0] wall-clock ms when the question was first detected,
   *   as measured in the renderer. Falls back to "now" for callers that live
   *   entirely in one process.
   */
  function start(meta = {}, t0 = Date.now()) {
    const id = nextId();
    inFlight.set(id, {
      id,
      meta,
      timestamps: { T0: t0 },
      done: false
    });
    return id;
  }

  /**
   * Records a stage timestamp. Safe to call for a stage more than once; first
   * arrival wins. Accepts an explicit wall-clock time for stages measured in
   * another process (e.g. T1 from the renderer's own vosk-partial handler).
   */
  function mark(id, stage, at = Date.now()) {
    const entry = inFlight.get(id);
    if (!entry || entry.done) return;
    if (!STAGES.includes(stage)) return;
    if (entry.timestamps[stage] !== undefined) return; // first arrival wins
    entry.timestamps[stage] = at;
  }

  function buildReport(entry) {
    const t = entry.timestamps;
    const seg = (from, to) => (t[from] !== undefined && t[to] !== undefined ? Math.round(t[to] - t[from]) : null);

    const segments = {
      detection: seg('T0', 'T2'),        // question confirmed after being seen
      context: seg('T2', 'T3'),          // context retrieval/assembly
      requestSetup: seg('T3', 'T4'),     // prompt build + request dispatch
      geminiFirst: seg('T4', 'T5'),      // provider time-to-first-token
      browser: seg('T5', 'T6')           // delivery to the UI
    };

    const total = t.T0 !== undefined && t.T6 !== undefined ? Math.round(t.T6 - t.T0) : null;

    return { id: entry.id, meta: entry.meta, segments, total, timestamps: t };
  }

  /** Closes the timeline at T6 and emits the report. Call once generation's first chunk lands. */
  function complete(id) {
    const entry = inFlight.get(id);
    if (!entry || entry.done) return null;

    mark(id, 'T6');
    entry.done = true;
    const report = buildReport(entry);
    inFlight.delete(id);

    logReport(report);
    onComplete(report);
    return report;
  }

  function logReport(report) {
    const fmt = (ms) => (ms === null ? 'n/a' : `${ms}ms`);
    log(
      `[QUESTION ${report.id}] `
      + `detection=${fmt(report.segments.detection)} `
      + `context=${fmt(report.segments.context)} `
      + `requestSetup=${fmt(report.segments.requestSetup)} `
      + `geminiFirst=${fmt(report.segments.geminiFirst)} `
      + `browser=${fmt(report.segments.browser)} `
      + `TOTAL=${fmt(report.total)}`
    );
  }

  /** Drops a timeline without reporting — for a question that got superseded/cancelled. */
  function abandon(id) {
    inFlight.delete(id);
  }

  function activeCount() {
    return inFlight.size;
  }

  return { start, mark, complete, abandon, activeCount, STAGE_LABELS };
}

module.exports = { createQuestionLatencyTracker, STAGES, STAGE_LABELS };
