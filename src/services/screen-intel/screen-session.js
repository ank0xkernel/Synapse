'use strict';

const { STATES, createStateMachine, deriveState } = require('./mode-c-state');
const { createRegionLedger, spanOf } = require('./region-ledger');
const { createAnalysisQueue } = require('./analysis-queue');
const { buildContext } = require('./context-builder');
const { TOL, FLIGHT, intersects, fingerprintOf } = require('./session-geometry');
const { createContinuity } = require('./session-continuity');
const { createEventHandlers } = require('./session-events');
const { MESSAGES, messageFor } = require('./session-messages');
const { buildSnapshot } = require('./session-snapshot');
const { createProblemIdentity, attachProblemState } = require('./session-problem');
const { createProblemTracker } = require('./problem-tracker');
const { createExplicitProblems } = require('./session-explicit');
const { createManualActions } = require('./session-actions');

const AUTO_RETRY_CODES = new Set(['NETWORK', 'QUOTA_EXHAUSTED']);

function createScreenSession({ ocr, engineControl, now = Date.now, emitState, onProblemChange, problemStore = null, limits = {}, log = () => {}, timers } = {}) {
  if (!ocr || typeof ocr.recognize !== 'function') throw new TypeError('ocr.recognize required');
  if (!engineControl) throw new TypeError('engineControl required');
  const L = {
    maxQueued: 8, imageBudgetBytes: 64 * 1024 * 1024, snapshotIntervalMs: 250, maxSnapshotRegions: 60,
    backoffMs: [2000, 8000, 30000], recaptureCooldownMs: 1000, maxRecaptureTries: 5, maxWindowRestarts: 3, pruneAboveRecords: 300, ...limits,
  };
  const T = timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };
  const sm = createStateMachine({ now });
  let R;
  let counter = 0;
  let starting = null;
  let disposed = false;
  let emitTimer = null;
  let lastEmitAt = -Infinity;
  let lastJson = null;
  let saveTimer = null;
  // Problems outlive a monitoring run and, through problemStore, the app.
  const tracker = createProblemTracker({ now, onChange: () => scheduleSave() });
  try { if (problemStore) tracker.importState(problemStore.load()); } catch (error) { log('problem-load-failed', error); }
  function scheduleSave() {
    if (!problemStore || saveTimer || disposed) return;
    saveTimer = T.setTimeout(() => { saveTimer = null; saveProblems(); }, 500);
  }
  function saveProblems() {
    if (saveTimer) { T.clearTimeout(saveTimer); saveTimer = null; }
    try { if (problemStore) problemStore.save(tracker.exportState()); } catch (error) { log('problem-save-failed', error); }
  }

  // ---- run (one per session id) -------------------------------------------------
  function freshRun(sessionId, displayId) {
    const run = {
      sessionId, displayId, epoch: 0, containers: new Map(), motion: new Set(), aliases: new Map(), recap: new Map(),
      retryTimers: new Map(), timers: new Set(), quotaUntil: 0, quotaTimer: null,
      frameCaptured: false, startedAt: sessionId ? now() : null, lastCaptureAt: null, lastAnalysisAt: null,
      lastAnalysisDurationMs: null, lastNewContentAt: null, paused: { user: false, sleep: false, lock: false, get system() { return this.sleep || this.lock; } }, needsUpdate: false,
      stopped: false, permissionRevoked: false, error: null, ocrDurations: [], windowRestarts: 0,
      metrics: { staleEventsDropped: 0, duplicatesSkipped: 0, lateResultsDropped: 0, rejectedTransitions: 0, recaptureErrors: 0, oldEpochDropped: 0, pausedDropped: 0 },
    };
    run.ledger = createRegionLedger({ now, imageBudgetBytes: L.imageBudgetBytes });
    attachProblemState(run, tracker);
    run.bindNextEpoch = sessionId && explicit ? explicit.takePendingBind() : null;
    run.queue = createAnalysisQueue({
      maxQueued: L.maxQueued, now,
      runner: (job) => runJob(run, job),
      onOverflow: (job) => handleOverflow(run, job),
      onError: (job, error) => { log('queue-runner-error', error); fail(run, 'INTERNAL', `Analysis job crashed: ${error && error.message}`); },
      onChange: () => { if (run === R) refresh(); },
    });
    return run;
  }
  R = freshRun(null, null);

  function after(run, ms, fn) {
    const handle = T.setTimeout(() => { run.timers.delete(handle); fn(); }, ms);
    run.timers.add(handle);
    return handle;
  }
  function clearTimersOf(run) {
    for (const h of run.timers) T.clearTimeout(h);
    run.timers.clear();
    run.retryTimers.clear();
    run.quotaTimer = null;
  }
  function fail(run, code, message) { run.error = { kind: 'engine', code, message }; if (run === R) refresh(); }

  // ---- derivation ---------------------------------------------------------------
  /**
   * A panel's first screenful is usually read as part of the full-screen root
   * capture, before the panel scrolls and becomes a container. The engine
   * seeds the container's coverage from that capture (seedFromRoot) and never
   * captures it again, so it counts here too, mapped the same way: content =
   * screen - origin at zero scroll. Only analysed root text in this epoch.
   */
  function rootCellsFor(c, axis) {
    if (c.id === 'root' || !c.screenRect) return [];
    const origin = c.origin || c.screenRect;
    const [s0, s1] = spanOf(c.screenRect, axis);
    const cross = axis === 'x' ? 'y' : 'x';
    const [c0, c1] = spanOf(c.screenRect, cross);
    const shift = axis === 'x' ? origin.x : origin.y;
    return R.ledger.list({ containerId: 'root', epoch: R.epoch, status: 'analysed' })
      .filter((r) => r.contentRect && r.epoch === c.epoch)
      .filter((r) => { const [a, b] = spanOf(r.contentRect, cross); return Math.min(b, c1) - Math.max(a, c0) >= 0.9 * (c1 - c0); })
      .map((r) => { const [a, b] = spanOf(r.contentRect, axis); return { start: Math.max(a, s0) - shift, end: Math.min(b, s1) - shift, status: 'analysed' }; })
      .filter((cell) => cell.end > cell.start);
  }

  function viewAnalysed() {
    if (!R.frameCaptured || R.queue.depth + R.queue.runningCount > 0 || !R.containers.size || R.needsUpdate) return false;
    for (const c of R.containers.values()) {
      const axis = c.axis === 'x' ? 'x' : 'y';
      const seg = R.ledger.coverage(c.id, { epoch: R.epoch, axis }).find((s) => s.id === c.segmentId);
      if (!c.viewport) return false;
      // Any own cell in view that is not analysed (failed, stale, pending)
      // still blocks below, even where root text covers the same range.
      const cells = [...rootCellsFor(c, axis), ...(seg ? seg.cells : [])].sort((a, b) => a.start - b.start);
      if (!cells.length) return false;
      const [v0, v1] = spanOf(c.viewport, axis);
      let cursor = v0;
      for (const cell of cells) {
        if (cell.end <= v0 || cell.start >= v1) continue;
        if (cell.status !== 'analysed' && cell.status !== 'inaccessible') return false;
        if (cell.start > cursor + TOL) return false;
        cursor = Math.max(cursor, cell.end);
      }
      if (cursor < v1 - TOL) return false;
    }
    return true;
  }

  function facts() {
    const led = R.ledger;
    const c = led.counts({ epoch: R.epoch });
    const failedRetry = led.list({ status: 'failed', epoch: R.epoch }).find((r) => r.nextRetryAt && r.error);
    let recapturing = 0;
    for (const s of R.recap.values()) if (s.inFlight) recapturing += 1;
    return {
      started: Boolean(R.sessionId), stopped: R.stopped, permissionRevoked: R.permissionRevoked,
      paused: R.paused.user || R.paused.system, engineError: Boolean(R.error && R.error.kind === 'engine'),
      frameCaptured: R.frameCaptured, busy: R.queue.depth + R.queue.runningCount > 0,
      quotaWait: R.queue.paused && R.quotaUntil > now(), capturing: c.new > 0 || recapturing > 0,
      motion: R.motion.size > 0, failed: c.failed, pending: c.pending, viewAnalysed: viewAnalysed(),
      initialSettled: c.analysed + c.failed + c.pending > 0,
      newContentAnalysed: led.list({ epoch: R.epoch, status: 'analysed' }).some((r) => r.kind !== 'initial'),
      uncapturedPlaceholders: led.list({ epoch: R.epoch, status: 'pending' }).filter((r) => r.kind === 'uncaptured').length,
      retryScheduledCode: failedRetry ? failedRetry.error.code : null,
    };
  }

  function computeView(f) {
    if (!f.frameCaptured || !f.started) return 'unknown';
    if (f.paused || R.needsUpdate) return 'needs_update';
    if (f.busy) return 'analysing';
    return f.viewAnalysed ? 'analysed' : 'needs_update';
  }

  function current() {
    const f = facts();
    const state = sm.state;
    return { f, state, message: messageFor(state, f), view: computeView(f) };
  }

  function refresh() {
    if (disposed) return;
    const f = facts();
    if (!sm.transition(deriveState(f), 'derived')) {
      R.metrics.rejectedTransitions += 1;
      log('rejected-transition', sm.rejected().slice(-1)[0]);
    }
    markDirty();
  }

  function getSnapshot() {
    const { state, message, view } = current();
    return { ...buildSnapshot(R, { state, message, view, now, maxRegions: L.maxSnapshotRegions }), problem: describeProblem(), problems: tracker.list() };
  }

  function emitNow() {
    if (emitTimer) { T.clearTimeout(emitTimer); emitTimer = null; }
    const snap = getSnapshot();
    const json = JSON.stringify(snap);
    if (json === lastJson) return;
    lastJson = json;
    lastEmitAt = now();
    if (typeof emitState === 'function') emitState(snap);
  }

  function markDirty() {
    if (disposed) return;
    const wait = lastEmitAt + L.snapshotIntervalMs - now();
    if (wait <= 0) emitNow();
    else if (!emitTimer) emitTimer = T.setTimeout(() => { emitTimer = null; emitNow(); }, wait);
  }

  // ---- queue plumbing -----------------------------------------------------------
  function isVisible(rec) {
    const c = R.containers.get(rec.containerId);
    if (!c || !c.viewport || rec.epoch !== R.epoch || !rec.contentRect) return false;
    const axis = c.axis === 'x' ? 'x' : 'y';
    const [a, b] = spanOf(rec.contentRect, axis);
    const [v0, v1] = spanOf(c.viewport, axis);
    return a < v1 && b > v0;
  }

  function enqueueRecord(run, rec, attempt) {
    rec.attempts = attempt;
    run.ledger.setStatus(rec.id, 'captured', { error: null, nextRetryAt: null });
    run.queue.enqueue({ regionId: rec.id, attempt, isVisible: () => isVisible(rec) });
  }

  function toPending(run, rec, code, message) {
    run.ledger.releaseImage(rec.id);
    run.ledger.setStatus(rec.id, 'pending', { error: { code, message }, nextRetryAt: null });
  }

  function handleOverflow(run, job) {
    const rec = run.ledger.get(job.regionId);
    if (rec && rec.status === 'captured') toPending(run, rec, 'QUEUE_OVERFLOW', 'Analysis queue was full; region must be captured again.');
  }

  function enforceBudget(run) {
    for (const id of run.ledger.enforceBudget()) run.queue.cancelWhere((j) => j.regionId === id);
  }

  function cancelJobs(run, id) { return run.queue.cancelWhere((j) => j.regionId === id).length > 0; }

  // ---- analysis -----------------------------------------------------------------
  async function runJob(run, job) {
    const rec = run.ledger.get(job.regionId);
    if (run !== R || !rec || rec.status !== 'captured' || rec.attempts !== job.attempt) return;
    if (!rec.imageRef) { toPending(run, rec, 'IMAGE_MISSING', 'Image no longer held; needs recapture.'); return; }
    run.ledger.setStatus(rec.id, 'analysing', { analysisStartedAt: now(), error: null });
    refresh();
    const valid = () => run === R && !R.stopped && run.ledger.get(rec.id) === rec && rec.status === 'analysing'
      && rec.attempts === job.attempt && !job.signal.aborted;
    let result;
    try {
      result = await ocr.recognize(rec.imageRef, { signal: job.signal, sessionId: run.sessionId, regionId: rec.id });
      if (!result || !Array.isArray(result.lines)) throw Object.assign(new Error('OCR returned no lines array'), { code: 'OCR_FAILED' });
    } catch (error) {
      if (!valid()) { run.metrics.lateResultsDropped += 1; return; }
      onFailure(run, rec, error);
      return;
    }
    if (!valid()) { run.metrics.lateResultsDropped += 1; refresh(); return; }
    applyResult(run, rec, result);
  }

  function applyResult(run, rec, result) {
    const lines = result.lines.filter((l) => l && typeof l.text === 'string' && l.text.trim())
      .map((l) => ({ text: l.text, box: l.box || null, confidence: Number.isFinite(l.confidence) ? l.confidence : null }));
    const text = lines.map((l) => l.text).join('\n');
    const fingerprint = fingerprintOf(text);
    const confs = lines.map((l) => l.confidence).filter((c) => c !== null);
    const durationMs = Number.isFinite(result.durationMs) ? result.durationMs : now() - rec.analysisStartedAt;
    const dup = fingerprint && rec.kind !== 'refresh' && rec.kind !== 'recapture' && run.ledger.list({ containerId: rec.containerId, epoch: rec.epoch, segmentId: rec.segmentId, status: 'analysed' })
      .find((o) => o.id !== rec.id && !o.duplicateOf && o.fingerprint === fingerprint && intersects(o.contentRect, rec.contentRect));
    run.ledger.setStatus(rec.id, 'analysed', {
      lines, text, fingerprint, durationMs, analysedAt: now(), error: null, nextRetryAt: null, engine: result.engine || null,
      confidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
      duplicateOf: dup ? dup.id : null, overlapWith: dup ? dup.id : null,
    });
    if (dup) { run.metrics.duplicatesSkipped += 1; run.ledger.releaseImage(rec.id); }
    run.lastAnalysisAt = now();
    run.lastAnalysisDurationMs = durationMs;
    run.ocrDurations.push(durationMs);
    if (run.ocrDurations.length > 200) run.ocrDurations.shift();
    if (rec.kind !== 'initial') run.lastNewContentAt = now();
    tryMerge(run, rec);
    evaluateProblem(run, rec);
    if (run === R && run.ledger.size > L.pruneAboveRecords) pruneLedger();
    recoverPending();
    refresh();
  }

  function onFailure(run, rec, error) {
    const code = (error && error.code) || 'OCR_FAILED';
    if (code === 'CANCELLED') { run.ledger.setStatus(rec.id, 'cancelled', { error: { code, message: 'Analysis cancelled' } }); refresh(); return; }
    const message = (error && error.message) || String(error);
    run.ledger.setStatus(rec.id, 'failed', { error: { code, message }, analysedAt: null });
    log('ocr-failed', { regionId: rec.id, code, message });
    const max = AUTO_RETRY_CODES.has(code) ? L.backoffMs.length : 1;
    if (rec.autoRetries < max) {
      const delay = L.backoffMs[Math.min(rec.autoRetries, L.backoffMs.length - 1)];
      rec.autoRetries += 1;
      rec.nextRetryAt = now() + delay;
      if (code === 'QUOTA_EXHAUSTED') pauseQuota(run, now() + delay);
      run.retryTimers.set(rec.id, after(run, delay, () => autoRetry(run, rec)));
    }
    evaluateProblem(run, rec);
    refresh();
  }

  function pauseQuota(run, until) {
    run.queue.pause();
    if (until <= run.quotaUntil) return;
    run.quotaUntil = until;
    if (run.quotaTimer) { T.clearTimeout(run.quotaTimer); run.timers.delete(run.quotaTimer); }
    run.quotaTimer = after(run, until - now(), () => { run.quotaTimer = null; run.quotaUntil = 0; run.queue.resume(); refresh(); });
  }

  function autoRetry(run, rec) {
    run.retryTimers.delete(rec.id);
    if (run !== R || rec.status !== 'failed') return;
    if (!rec.imageRef) { toPending(run, rec, rec.error.code, 'Image released before retry; needs recapture.'); recoverPending(); refresh(); return; }
    enqueueRecord(run, rec, rec.attempts + 1);
  }

  const identity = createProblemIdentity({
    getRun: () => R, tracker, isVisible, now, log, onProblemChange,
    onReplaced: (containerId) => engineControl.forgetOutsideView && engineControl.forgetOutsideView({ containerId }),
    digestOf: (id) => {
      const t = buildSessionContext({ charBudget: 9000, ...identity.problemContextOptions(id), savedDigest: '' }).text;
      const read = t.slice(t.indexOf('\n') + 1, t.lastIndexOf('=== COVERAGE ===')).trim().split('\n');
      // Lines read before a restart stay in the digest after what this run has read.
      return [...read, ...String(tracker.get(id)?.restoredDigest || '').split('\n').filter((l) => !read.includes(l))].join('\n');
    },
  });
  const { evaluateProblem, describeProblem, problemContextOptions, pruneLedger } = identity;
  const { tryMerge, normalise, supersede } = createContinuity({ getRun: () => R, cancelJobs, toPending, remapCuts: identity.remapCuts });
  const { adoptEpoch, handleEngineEvent } = createEventHandlers({
    run: () => R, isDisposed: () => disposed, T, now, log, refresh, enqueueRecord, enforceBudget, recoverPending, supersede, normalise, cancelJobs,
    notifySystem: (...a) => notifySystem(...a), stampFor: identity.stampFor, onMotionSettled: identity.onMotionSettled,
    onEpochAdopted: (run, epoch) => {
      const id = run.bindNextEpoch;
      run.bindNextEpoch = null;
      if (tracker.knows(id)) { run.explicitEpochs.set(epoch, id); tracker.setEpochProblem(epoch, id); }
    },
  });
  const explicit = createExplicitProblems({
    getRun: () => R, tracker, identity, now, log, refresh, adoptEpoch,
    engineControl: { beginEpoch: async (a) => (engineControl.beginEpoch ? engineControl.beginEpoch(a) : null) },
  });
  // ---- recapture ----------------------------------------------------------------
  function recapture(run, rec, force) {
    const st = run.recap.get(rec.id) || { tries: 0, lastAt: -Infinity, inFlight: false };
    run.recap.set(rec.id, st);
    if (force) st.tries = 0;
    if (st.inFlight || (!force && (st.tries >= L.maxRecaptureTries || now() - st.lastAt < L.recaptureCooldownMs))) return;
    st.inFlight = true;
    st.tries += 1;
    st.lastAt = now();
    new Promise((resolve) => resolve(engineControl.requestRecapture({ containerId: rec.containerId, contentRect: rec.contentRect }))).then(
      (ok) => { st.inFlight = false; if (run === R) { if (!ok) rec.recapture = 'refused'; refresh(); } },
      (error) => {
        st.inFlight = false;
        run.metrics.recaptureErrors += 1;
        log('recapture-failed', error);
        if (run === R) { rec.error = { code: 'RECAPTURE_FAILED', message: (error && error.message) || String(error) }; refresh(); }
      },
    );
    refresh();
  }

  function recoverPending() {
    if (R.stopped || R.paused.user || R.paused.system || !R.queue.hasRoom()) return;
    for (const rec of R.ledger.list({ status: ['pending', 'stale'], epoch: R.epoch })) {
      if (rec.kind === 'inaccessible' || !R.containers.has(rec.containerId) || !isVisible(rec)) continue;
      recapture(R, rec, false);
    }
  }

  // ---- lifecycle ----------------------------------------------------------------
  function start({ displayId = null } = {}) {
    if (disposed) return Promise.reject(new Error('session disposed'));
    if (R.sessionId && !R.stopped) return Promise.resolve({ sessionId: R.sessionId });
    if (starting) return starting.then(() => {}, () => {}).then(() => start({ displayId })); // stopped mid-start: let it unwind first
    counter += 1;
    const run = freshRun(`ss-${counter}-${now().toString(36)}`, displayId);
    R = run;
    refresh();
    starting = (async () => {
      try {
        await engineControl.start({ sessionId: run.sessionId, displayId });
        if (run.stopped) await engineControl.stop(); // Stop arrived while the stream was opening.
      } catch (error) {
        log('engine-start-failed', error);
        fail(run, 'ENGINE_START_FAILED', (error && error.message) || String(error));
        throw error;
      } finally {
        starting = null;
      }
      return { sessionId: run.sessionId };
    })();
    return starting;
  }

  async function stop() {
    const run = R;
    if (!run.sessionId || run.stopped) return;
    run.stopped = true;
    for (const rec of run.ledger.list({})) {
      if (FLIGHT.includes(rec.status)) run.ledger.setStatus(rec.id, 'cancelled', { error: { code: 'STOPPED', message: 'Monitoring stopped.' } });
    }
    run.queue.dispose();
    clearTimersOf(run);
    run.ledger.releaseAllImages();
    refresh();
    emitNow();
    try { await engineControl.stop(); } catch (error) {
      log('engine-stop-failed', error);
      if (run === R) { run.error = { kind: 'stop', code: 'ENGINE_STOP_FAILED', message: (error && error.message) || String(error) }; refresh(); }
    }
  }

  async function restart() {
    const displayId = R.displayId;
    await stop();
    return start({ displayId });
  }

  async function setEnginePaused(run, flag, paused) {
    const was = run.paused.user || run.paused.system;
    run.paused[flag] = paused;
    const is = run.paused.user || run.paused.system;
    if (paused) { run.needsUpdate = true; run.pausedAt = run.pausedAt || now(); } else if (!is) run.pausedAt = null;
    refresh();
    if (was === is) return;
    try {
      if (is) await engineControl.pause(); else await engineControl.resume();
    } catch (error) {
      log('engine-pause-resume-failed', error);
      fail(run, 'ENGINE_PAUSE_FAILED', (error && error.message) || String(error));
      return;
    }
    if (!is && run === R) { run.needsUpdate = false; refresh(); }
  }

  async function restartEngine(displayId) {
    const run = R;
    run.windowRestarts += 1;
    if (run.windowRestarts > L.maxWindowRestarts) { fail(run, 'CAPTURE_RESTART_LIMIT', 'Capture could not be restarted.'); return; }
    adoptEpoch(run.epoch + 1);
    try {
      await engineControl.stop();
      await engineControl.start({ sessionId: run.sessionId, displayId });
      if (run === R) { run.error = null; refresh(); }
    } catch (error) {
      log('engine-restart-failed', error);
      // Screen Recording revoked while running surfaces here: the stream ends
      // and reopening it is refused. Report the permission, not "analysis failed".
      if (error && /PERMISSION/i.test(error.code || '')) { await notifySystem('permission-revoked'); return; }
      fail(run, 'ENGINE_RESTART_FAILED', (error && error.message) || String(error));
    }
  }

  async function notifySystem(event, detail = {}) {
    const run = R;
    if (disposed || !run.sessionId || run.stopped) return;
    switch (event) {
      case 'suspend': await setEnginePaused(run, 'sleep', true); break;
      case 'lock': await setEnginePaused(run, 'lock', true); break;
      case 'resume': await setEnginePaused(run, 'sleep', false); break;
      case 'unlock': await setEnginePaused(run, 'lock', false); break;
      case 'display-changed': {
        const old = run.displayId;
        for (const rec of run.ledger.list({})) {
          if (rec.displayId != null && rec.displayId !== old) continue;
          if (FLIGHT.includes(rec.status) || rec.status === 'pending') {
            cancelJobs(run, rec.id);
            run.ledger.releaseImage(rec.id);
            run.ledger.setStatus(rec.id, 'inaccessible', { error: { code: 'DISPLAY_CHANGED', message: 'Display changed or was removed.' } });
          } else if (rec.status === 'analysed' || rec.status === 'failed') {
            run.ledger.setStatus(rec.id, 'stale', { error: { code: 'DISPLAY_CHANGED', message: 'Display changed after this was analysed.' } });
          }
        }
        if (detail.displayId !== undefined) run.displayId = detail.displayId;
        await restartEngine(run.displayId);
        break;
      }
      case 'capture-window-lost': await restartEngine(run.displayId); break;
      case 'permission-revoked':
        run.permissionRevoked = true;
        run.error = { kind: 'permission', code: 'PERMISSION', message: MESSAGES.PERMISSION.text };
        await stop();
        break;
      default: log('unknown-system-event', event);
    }
  }

  const { retry, reanalyse } = createManualActions({ getRun: () => R, T, refresh, enqueueRecord, toPending, recapture: (...a) => recapture(...a) });

  function getRegion(regionId) {
    const rec = R.ledger.get(regionId);
    if (!rec) return null;
    R.ledger.touch(regionId);
    const { imageRef, ...fields } = rec;
    return { ...fields, imageRef: imageRef || null };
  }

  function buildSessionContext(opts = {}) {
    const result = buildContext({ ledger: R.ledger, containers: Array.from(R.containers.values()), currentEpoch: R.epoch, ...(opts.activeProblemId ? {} : problemContextOptions()), ...opts });
    for (const id of result.imageRegionIds) R.ledger.touch(id);
    return result;
  }

  async function dispose() {
    await stop();
    saveProblems();
    disposed = true;
    if (emitTimer) { T.clearTimeout(emitTimer); emitTimer = null; }
    clearTimersOf(R);
  }

  return {
    start, stop, restart, dispose, retry, reanalyse, getSnapshot, getRegion, notifySystem, handleEngineEvent,
    pause: () => setEnginePaused(R, 'user', true),
    resume: () => setEnginePaused(R, 'user', false),
    buildContext: buildSessionContext,
    getProblem: describeProblem,
    newProblem: explicit.newProblem,
    activateProblem: explicit.activateProblem,
    resolveCandidate: explicit.resolveCandidate,
    listProblems: () => tracker.list(),
    /** Replaces the problem registry (another conversation was opened, or a new one started). */
    loadProblems(saved) {
      tracker.importState(saved);
      R.ledger.prune((r) => r.status !== 'retired'); // retired text of the old registry's problems goes; the screen is identified again
      for (const r of R.ledger.all()) { r.problemId = null; r.cutEntry = null; }
      attachProblemState(R, tracker);
      explicit.clearPendingBind(); Object.assign(R, { bindNextEpoch: null, lateEpoch: undefined });
      identity.reevaluate();
      refresh();
    },
    saveProblems,
  };
}

module.exports = { createScreenSession, deriveState, STATES };
