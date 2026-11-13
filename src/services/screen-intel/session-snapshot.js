'use strict';

const { percentile } = require('./analysis-queue');
const { panelLabels } = require('./context-builder');

/** Plain, JSON-serialisable UI snapshot built only from ledger/queue/run facts. */
function buildSnapshot(run, { state, message, view, now, maxRegions }) {
  const led = run.ledger;
  const containers = Array.from(run.containers.values());
  const labels = panelLabels(containers);
  const openGaps = led.openGaps({ epoch: run.epoch });
  const counts = led.counts();
  const analysing = led.list({ status: 'analysing' }).map((r) => r.analysisStartedAt).filter((t) => t !== null);
  const failed = led.list({ status: 'failed' }).sort((a, b) => b.seq - a.seq)[0];
  const q = run.queue.stats();
  const stopped = run.stopped || !run.sessionId;
  const paused = run.paused.user || run.paused.system;

  return {
    sessionId: run.sessionId,
    state,
    monitoring: stopped ? 'stopped' : paused ? 'paused' : 'active',
    view,
    message: { ...message },
    startedAt: run.startedAt,
    lastCaptureAt: run.lastCaptureAt,
    lastAnalysisAt: run.lastAnalysisAt,
    analysingSince: analysing.length ? Math.min(...analysing) : null,
    lastAnalysisDurationMs: run.lastAnalysisDurationMs,
    lastNewContentAt: run.lastNewContentAt,
    counts: { ...counts, gaps: openGaps.length },
    containers: containers.map((c) => {
      const axis = c.axis === 'x' ? 'x' : 'y';
      return {
        id: c.id,
        axis,
        label: labels.get(c.id).label,
        screenRect: c.screenRect,
        viewport: c.viewport,
        extent: c.extent,
        segments: led.coverage(c.id, { epoch: run.epoch, axis }).map((s) => ({
          id: s.id,
          cells: s.cells.map((cell) => ({ start: cell.start, end: cell.end, status: cell.status, regionId: cell.regionId })),
        })),
        gaps: openGaps.filter((g) => g.containerId === c.id).length,
      };
    }),
    regions: led.all().sort((a, b) => b.seq - a.seq).slice(0, maxRegions).map((r) => ({
      id: r.id,
      containerId: r.containerId,
      status: r.status,
      kind: r.kind,
      capturedAt: r.capturedAt,
      analysedAt: r.analysedAt,
      durationMs: r.durationMs,
      chars: r.text.length,
      preview: r.text.slice(0, 120),
      confidence: r.confidence,
      error: r.error ? { code: r.error.code, message: r.error.message } : null,
      hasImage: Boolean(r.imageRef),
    })),
    metrics: {
      queueDepth: q.depth,
      running: q.running,
      ocrMsP50: percentile(run.ocrDurations, 50),
      ocrMsP95: percentile(run.ocrDurations, 95),
      regionsTotal: led.size,
      imageBytes: led.imageBytes,
      staleEventsDropped: run.metrics.staleEventsDropped,
      duplicatesSkipped: run.metrics.duplicatesSkipped,
      lateResultsDropped: run.metrics.lateResultsDropped,
      queueOverflowed: q.overflowed,
      queueCancelled: q.cancelled,
      queueWaitMsP95: q.waitMsP95,
      rejectedTransitions: run.metrics.rejectedTransitions,
      recaptureErrors: run.metrics.recaptureErrors,
    },
    error: run.error ? { code: run.error.code, message: run.error.message }
      : failed && failed.error ? { code: failed.error.code, message: failed.error.message } : null,
  };
}

module.exports = { buildSnapshot };
