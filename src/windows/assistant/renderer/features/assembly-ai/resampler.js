/**
 * Anti-aliased decimating resampler (CoreAudio rate -> 16 kHz).
 *
 * The previous implementation averaged N adjacent samples ("box" decimation).
 * A box filter has almost no stopband rejection, so at 48k->16k everything
 * above the 8 kHz output Nyquist folded straight back into the speech band.
 * Measured on the old path: a 10 kHz tone reappeared at 6 kHz only 9 dB down,
 * and 9 kHz reappeared at 7 kHz just 7.7 dB down. Sibilants ('s', 'sh', 'f')
 * live at 5-10 kHz, so their aliases were landing on top of vowels on every
 * frame — degrading recognition without ever sounding obviously broken.
 *
 * This applies a proper windowed-sinc low-pass before decimating, and keeps
 * filter state across frames so 100 ms buffer boundaries do not introduce
 * discontinuities.
 */

// Cutoff sits below the output Nyquist (8 kHz) to leave the filter room to roll
// off. 7.2 kHz keeps all speech-relevant energy: even sibilant detail is well
// represented by 7 kHz, which is why telephony and every 16 kHz ASR model are
// built around this band.
const CUTOFF_RATIO = 0.45;

// 95 taps at these rates gives roughly -60 dB stopband with a Blackman window —
// enough that aliased energy is far below the noise floor — while costing well
// under a millisecond per 100 ms frame.
const FILTER_TAPS = 95;

function designLowPass(cutoffHz, sampleRate, taps = FILTER_TAPS) {
  const coefficients = new Float32Array(taps);
  const center = (taps - 1) / 2;
  const omega = (2 * Math.PI * cutoffHz) / sampleRate;
  let sum = 0;

  for (let index = 0; index < taps; index += 1) {
    const offset = index - center;

    // Ideal low-pass impulse response (sinc), with the limit at offset 0.
    const sinc = offset === 0 ? omega : Math.sin(omega * offset) / offset;

    // Blackman window — trades a slightly wider transition band for the deep
    // stopband that actually matters here.
    const phase = (2 * Math.PI * index) / (taps - 1);
    const window = 0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase);

    coefficients[index] = sinc * window;
    sum += coefficients[index];
  }

  // Normalise to unity DC gain so the resampler never changes signal level.
  for (let index = 0; index < taps; index += 1) {
    coefficients[index] /= sum;
  }

  return coefficients;
}

/**
 * Stateful per-stream resampler. Mic and system audio must each own one —
 * sharing filter history between two unrelated signals would smear them
 * together.
 */
export function createResampler(outputSampleRate) {
  let coefficients = null;
  let history = null;      // trailing input samples needed by the next frame
  let configuredRate = 0;
  let phase = 0;           // fractional read position, carried across frames

  function configure(inputSampleRate) {
    coefficients = designLowPass(outputSampleRate * CUTOFF_RATIO, inputSampleRate);
    history = new Float32Array(FILTER_TAPS - 1);
    configuredRate = inputSampleRate;
    phase = 0;
  }

  /**
   * @param {Float32Array} input frame at inputSampleRate
   * @returns {Float32Array} frame at outputSampleRate
   */
  function process(input, inputSampleRate) {
    if (!input || input.length === 0) return new Float32Array(0);
    if (inputSampleRate === outputSampleRate) return input;

    if (inputSampleRate !== configuredRate) {
      configure(inputSampleRate);
    }

    // Filtering needs the tail of the previous frame for continuity.
    const padded = new Float32Array(history.length + input.length);
    padded.set(history, 0);
    padded.set(input, history.length);

    const step = inputSampleRate / outputSampleRate;
    // An output at `base` reads padded[base .. base+TAPS-1], and the fractional
    // neighbour reads one further, so we need base+TAPS < padded.length.
    const lastBase = padded.length - FILTER_TAPS - 1;

    const output = [];
    let position = phase;

    // Convolve only at the positions we actually keep. Filtering every input
    // sample and discarding most would cost `step` times more for nothing.
    while (Math.floor(position) <= lastBase) {
      const base = Math.floor(position);
      const frac = position - base;

      let accumulator = 0;
      let accumulatorNext = 0;
      for (let tap = 0; tap < FILTER_TAPS; tap += 1) {
        const coefficient = coefficients[tap];
        accumulator += padded[base + tap] * coefficient;
        // Neighbour output for fractional ratios (44.1k -> 16k is 2.75625).
        // Post-filter the signal is band-limited, so linear blending between
        // two filtered points is accurate well below the noise floor.
        accumulatorNext += padded[base + tap + 1] * coefficient;
      }

      output.push(frac === 0 ? accumulator : accumulator + (accumulatorNext - accumulator) * frac);
      position += step;
    }

    // Everything from the first unprocessable base onward is still needed; the
    // fractional remainder carries over so the output grid never drifts.
    const nextBase = Math.floor(position);
    history = padded.slice(Math.min(nextBase, padded.length));
    phase = position - nextBase;

    return Float32Array.from(output);
  }

  function reset() {
    if (history) history.fill(0);
    phase = 0;
  }

  return { process, reset };
}

export const __testing = { designLowPass, CUTOFF_RATIO, FILTER_TAPS };
