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
      meta: { ...meta },
      timestamps: { T0: t0 },
      retries: [],
      done: false
    });
    return id;
  }

  /** Merges facts learned mid-flight (model, thinking level, attempts) into the timeline's meta. */
  function note(id, facts = {}) {
    const entry = inFlight.get(id);
    if (!entry || entry.done) return;
    Object.assign(entry.meta, facts);
  }

  /** Records a retry or rate-limit event so delays added by recovery are visible, not folded into "provider time". */
  function addRetry(id, delayMs = 0, reason = 'retry') {
    const entry = inFlight.get(id);
    if (!entry || entry.done) return;
    entry.retries.push({ delayMs: Math.max(0, Math.round(delayMs || 0)), reason });
  }

  /**
   * Records a stage timestamp. Safe to call for a stage more than once; first
   * arrival wins. Accepts an explicit wall-clock time for stages measured in
   * another process (e.g. T1 from the renderer's own vosk-partial handler).
   */
  function mark(id, stage, at = Date.now(), { overwrite = false } = {}) {
    const entry = inFlight.get(id);
    if (!entry || entry.done) return;
    if (!STAGES.includes(stage)) return;
    if (entry.timestamps[stage] !== undefined && !overwrite) return; // first arrival wins by default
    entry.timestamps[stage] = at;
  }

  function buildReport(entry) {
    const t = entry.timestamps;
    const seg = (from, to) => (t[from] !== undefined && t[to] !== undefined ? Math.round(t[to] - t[from]) : null);

    const segments = {
      detection: seg('T0', 'T2'),        // question confirmed after being seen
      context: seg('T2', 'T3'),          // context retrieval/assembly
      requestSetup: seg('T3', 'T4'),     // prompt build + realtime slot wait, until the final dispatch
      geminiFirst: seg('T4', 'T5'),      // provider time-to-first-token on the attempt that answered
      browser: seg('T5', 'T6')           // delivery to the UI
    };

    const total = t.T0 !== undefined && t.T6 !== undefined ? Math.round(t.T6 - t.T0) : null;
    const retries = entry.retries || [];

    return {
      id: entry.id,
      meta: entry.meta,
      segments,
      total,
      retries: { count: retries.length, delayMs: retries.reduce((sum, r) => sum + r.delayMs, 0), reasons: retries.map((r) => r.reason) },
      timestamps: t
    };
  }

  // Phase 13: the diagnostic snapshot needs to read back "what actually
  // happened on the last question" on demand (the user exports diagnostics
  // some time after asking, not necessarily the instant it completes) --
  // previously there was no way to see a report after logReport()/onComplete()
  // already fired once. Only the single most recent report is kept; this is
  // not a history log, just "what just happened."
  let lastReport = null;

  /** Closes the timeline at T6 and emits the report. Call once generation's first chunk lands. */
  function complete(id) {
    const entry = inFlight.get(id);
    if (!entry || entry.done) return null;

    mark(id, 'T6');
    entry.done = true;
    const report = buildReport(entry);
    inFlight.delete(id);
    lastReport = report;

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
      + (report.retries?.count ? ` retries=${report.retries.count} retryDelay=${report.retries.delayMs}ms(${report.retries.reasons.join(',')})` : '')
      + (report.meta?.model ? ` model=${report.meta.model}` : '')
      + (report.meta?.thinking ? ` thinking=${report.meta.thinking}` : '')
      + (report.meta?.responseMode ? ` mode=${report.meta.responseMode}` : '')
    );
  }

  /** Drops a timeline without reporting — for a question that got superseded/cancelled. */
  function abandon(id) {
    inFlight.delete(id);
  }

  function activeCount() {
    return inFlight.size;
  }

  /** Most recently completed report, or null if none has completed yet this session. */
  function getLastReport() {
    return lastReport;
  }

  /**
   * Partial reports for whatever is still in flight right now -- e.g. a
   * diagnostic export triggered while an answer is still generating. Never
   * invents a missing stage: buildReport()'s own seg() already returns null
   * for any timestamp that hasn't arrived yet, which the snapshot reports
   * as UNKNOWN rather than a guessed number.
   */
  function getActiveReports() {
    return [...inFlight.values()].map(buildReport);
  }

  return { start, mark, note, addRetry, complete, abandon, activeCount, getLastReport, getActiveReports, STAGE_LABELS };
}

module.exports = { createQuestionLatencyTracker, STAGES, STAGE_LABELS };
