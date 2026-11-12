'use strict';

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/**
 * Bounded priority queue. Jobs: { regionId, attempt, isVisible?() }.
 * runner(job) is called with job.signal set. When the queue is full the lowest
 * priority job (maybe the new one) is evicted and handed to onOverflow; it is
 * never dropped silently.
 */
function createAnalysisQueue({ maxQueued = 8, concurrency = 1, now = Date.now, runner, onOverflow, onError, onChange } = {}) {
  if (typeof runner !== 'function') throw new TypeError('runner required');
  const queued = [];
  const running = new Map();
  const waits = [];
  const latencies = [];
  const counters = { completed: 0, failed: 0, cancelled: 0, overflowed: 0 };
  let seq = 0;
  let paused = false;
  let disposed = false;

  const keep = (arr, v) => { arr.push(v); if (arr.length > 200) arr.shift(); };
  const visible = (job) => (typeof job.isVisible === 'function' ? Boolean(job.isVisible()) : false);
  // true when a should run before b: visible first, then newest first
  const better = (a, b) => {
    const va = visible(a);
    const vb = visible(b);
    if (va !== vb) return va;
    return a.seq > b.seq;
  };
  const changed = () => { if (onChange) onChange(); };

  function settle(job, ok) {
    // a cancelled running job already left `running`; its late settle is ignored
    if (!running.delete(job.id)) return;
    keep(latencies, now() - job.startedAt);
    if (ok) counters.completed += 1; else counters.failed += 1;
    pump();
    changed();
  }

  function pump() {
    while (!disposed && !paused && running.size < concurrency && queued.length) {
      let bestIdx = 0;
      for (let i = 1; i < queued.length; i += 1) if (better(queued[i], queued[bestIdx])) bestIdx = i;
      const job = queued.splice(bestIdx, 1)[0];
      job.startedAt = now();
      keep(waits, job.startedAt - job.enqueuedAt);
      job.controller = new AbortController();
      job.signal = job.controller.signal;
      running.set(job.id, job);
      Promise.resolve()
        .then(() => runner(job))
        .then(
          () => settle(job, true),
          (error) => {
            settle(job, false);
            if (onError) onError(job, error);
          },
        );
    }
  }

  function enqueue(input) {
    if (disposed) throw new Error('queue disposed');
    seq += 1;
    const job = { ...input, id: `j${seq}`, seq, enqueuedAt: now() };
    queued.push(job);
    if (queued.length > maxQueued) {
      let worst = queued[0];
      for (const candidate of queued) if (better(worst, candidate)) worst = candidate;
      queued.splice(queued.indexOf(worst), 1);
      counters.overflowed += 1;
      if (onOverflow) onOverflow(worst);
    }
    pump();
    changed();
    return job;
  }

  function cancelWhere(predicate) {
    const hit = [];
    for (let i = queued.length - 1; i >= 0; i -= 1) {
      if (predicate(queued[i])) hit.push(queued.splice(i, 1)[0]);
    }
    for (const job of Array.from(running.values())) {
      if (predicate(job)) {
        running.delete(job.id);
        job.controller.abort();
        hit.push(job);
      }
    }
    counters.cancelled += hit.length;
    if (hit.length) { pump(); changed(); }
    return hit;
  }

  return {
    enqueue,
    cancelWhere,
    cancel: (id) => cancelWhere((job) => job.id === id).length > 0,
    pause() { paused = true; changed(); },
    resume() { paused = false; pump(); changed(); },
    get paused() { return paused; },
    get depth() { return queued.length; },
    get runningCount() { return running.size; },
    get maxQueued() { return maxQueued; },
    hasRoom: () => queued.length < maxQueued,
    stats() {
      return {
        depth: queued.length,
        running: running.size,
        ...counters,
        waitMsP50: percentile(waits, 50),
        waitMsP95: percentile(waits, 95),
        latencyMsP50: percentile(latencies, 50),
        latencyMsP95: percentile(latencies, 95),
      };
    },
    dispose() {
      cancelWhere(() => true);
      disposed = true;
    },
  };
}

module.exports = { createAnalysisQueue, percentile };
