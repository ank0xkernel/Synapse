'use strict';

// Manual actions from the Mode C bar: retry failed or pending regions, and
// reanalyse one region.

function createManualActions({ getRun: run, T, refresh, enqueueRecord, toPending, recapture }) {
  function retry(regionId) {
    const R = run();
    const targets = regionId ? [R.ledger.get(regionId)].filter(Boolean)
      : R.ledger.list({ status: ['failed', 'pending'], epoch: R.epoch });
    let acted = 0;
    for (const rec of targets) {
      if (rec.status === 'failed') {
        const timer = R.retryTimers.get(rec.id);
        if (timer) { T.clearTimeout(timer); R.timers.delete(timer); R.retryTimers.delete(rec.id); }
        rec.autoRetries = 0;
        if (rec.imageRef) enqueueRecord(R, rec, rec.attempts + 1);
        else { toPending(R, rec, rec.error.code, 'Image released; needs recapture.'); recapture(R, rec, true); }
        acted += 1;
      } else if (rec.status === 'pending' && rec.kind !== 'inaccessible') {
        recapture(R, rec, true);
        acted += 1;
      }
    }
    if (acted && R.queue.paused) {
      if (R.quotaTimer) { T.clearTimeout(R.quotaTimer); R.timers.delete(R.quotaTimer); R.quotaTimer = null; }
      R.quotaUntil = 0;
      R.queue.resume();
    }
    refresh();
    return acted;
  }

  function reanalyse(regionId) {
    const R = run();
    const rec = R.ledger.get(regionId);
    if (!rec || R.stopped || !['analysed', 'failed', 'pending'].includes(rec.status) || rec.kind === 'stale' || rec.kind === 'inaccessible') return false;
    Object.assign(rec, { lines: [], text: '', fingerprint: null, duplicateOf: null, confidence: null, autoRetries: 0 });
    if (rec.imageRef) enqueueRecord(R, rec, rec.attempts + 1);
    else { toPending(R, rec, 'IMAGE_MISSING', 'Image released; needs recapture.'); recapture(R, rec, true); }
    refresh();
    return true;
  }

  return { retry, reanalyse };
}

module.exports = { createManualActions };
