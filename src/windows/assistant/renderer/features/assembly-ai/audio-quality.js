/**
 * Audio quality diagnostics.
 *
 * "The loopback level reads -23 dB" only proves the driver is passing signal —
 * it says nothing about clipping, a dead channel content-free of speech, or a
 * noise floor high enough to bury consonants. This measures what actually
 * matters for STT, aggregated over a rolling ~1s window so it can run
 * continuously without becoming the thing that costs CPU.
 */

const WINDOW_SAMPLES_AT_16K = 16000; // ~1 second of audio per report

// Anything above this magnitude touches full scale — softclipped or hard
// clipped either way once it round-trips through Int16.
const CLIP_THRESHOLD = 0.98;

// Below this RMS a frame is being treated as silence for the speech-ratio
// calculation. Matches the threshold the endpoint detector already uses.
const SILENCE_RMS = 0.008;

function createSourceWindow() {
  return {
    sampleCount: 0,
    sumSquares: 0,
    peak: 0,
    clippedSamples: 0,
    silentFrames: 0,
    totalFrames: 0,
    speechSumSquares: 0,
    speechSamples: 0,
    noiseSumSquares: 0,
    noiseSamples: 0,
    droppedFrames: 0,
    rejectedFrames: 0,
    lastFrameAt: 0,
    maxGapMs: 0
  };
}

const dbfs = (linear) => (linear <= 1e-9 ? -Infinity : 20 * Math.log10(linear));

export function createAudioQualityMonitor({ onReport = () => {} } = {}) {
  const windows = { mic: createSourceWindow(), system: createSourceWindow() };

  function noteRejected(source) {
    windows[source].rejectedFrames += 1;
  }

  function noteDropped(source) {
    windows[source].droppedFrames += 1;
  }

  /** Feed one frame of Float32 samples in [-1, 1] before quantization. */
  function observe(source, samples) {
    const win = windows[source];
    if (!win || !samples || samples.length === 0) return;

    const now = performance.now();
    if (win.lastFrameAt > 0) {
      const gap = now - win.lastFrameAt;
      // A frame arriving much later than the ~100ms cadence means the pipeline
      // stalled (main thread block, worklet starvation) — that gap is silence
      // AssemblyAI never saw as a gap, which can misalign endpointing.
      if (gap > win.maxGapMs) win.maxGapMs = gap;
    }
    win.lastFrameAt = now;
    win.totalFrames += 1;

    let frameSumSquares = 0;
    let isSilentFrame = true;

    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      const magnitude = Math.abs(sample);

      frameSumSquares += sample * sample;
      if (magnitude > win.peak) win.peak = magnitude;
      if (magnitude >= CLIP_THRESHOLD) win.clippedSamples += 1;
    }

    win.sumSquares += frameSumSquares;
    win.sampleCount += samples.length;

    const frameRms = Math.sqrt(frameSumSquares / samples.length);
    isSilentFrame = frameRms < SILENCE_RMS;

    if (isSilentFrame) {
      win.silentFrames += 1;
      win.noiseSumSquares += frameSumSquares;
      win.noiseSamples += samples.length;
    } else {
      win.speechSumSquares += frameSumSquares;
      win.speechSamples += samples.length;
    }

    if (win.sampleCount >= WINDOW_SAMPLES_AT_16K) {
      flush(source);
    }
  }

  function flush(source) {
    const win = windows[source];
    if (win.sampleCount === 0) return;

    const rms = Math.sqrt(win.sumSquares / win.sampleCount);
    const noiseRms = win.noiseSamples > 0 ? Math.sqrt(win.noiseSumSquares / win.noiseSamples) : 0;
    const speechRms = win.speechSamples > 0 ? Math.sqrt(win.speechSumSquares / win.speechSamples) : 0;

    // SNR needs both a speech estimate and a noise floor to mean anything;
    // report null rather than a misleading number when either is absent.
    const snrDb = win.speechSamples > 0 && noiseRms > 1e-9
      ? dbfs(speechRms) - dbfs(noiseRms)
      : null;

    onReport({
      source,
      rmsDb: dbfs(rms),
      peakDb: dbfs(win.peak),
      noiseFloorDb: noiseRms > 0 ? dbfs(noiseRms) : null,
      snrDb,
      clippingPct: (win.clippedSamples / win.sampleCount) * 100,
      silentFramePct: win.totalFrames > 0 ? (win.silentFrames / win.totalFrames) * 100 : 0,
      droppedFrames: win.droppedFrames,
      rejectedFrames: win.rejectedFrames,
      maxFrameGapMs: Math.round(win.maxGapMs),
      windowSamples: win.sampleCount
    });

    windows[source] = createSourceWindow();
  }

  function reset(source) {
    windows[source] = createSourceWindow();
  }

  return { observe, flush, reset, noteDropped, noteRejected };
}

/** Renders a report object as the fixed-width block the spec calls for. */
export function formatQualityReport(report) {
  const fmt = (value, unit = '') => (value === null || value === undefined || !Number.isFinite(value)
    ? 'n/a'
    : `${value.toFixed(1)}${unit}`);

  return [
    `Audio Quality [${report.source}]`,
    '────────────────────────',
    'Sample rate:       16000 Hz',
    'Channels:          1',
    'Format:            PCM16',
    '',
    `RMS:               ${fmt(report.rmsDb, ' dBFS')}`,
    `Peak:              ${fmt(report.peakDb, ' dBFS')}`,
    `Noise floor:       ${fmt(report.noiseFloorDb, ' dBFS')}`,
    `SNR estimate:      ${fmt(report.snrDb, ' dB')}`,
    `Clipping:          ${fmt(report.clippingPct, '%')}`,
    `Silent frames:     ${fmt(report.silentFramePct, '%')}`,
    `Dropped frames:    ${report.droppedFrames}`,
    `Rejected frames:   ${report.rejectedFrames}`,
    `Max frame gap:     ${report.maxFrameGapMs} ms`
  ].join('\n');
}
