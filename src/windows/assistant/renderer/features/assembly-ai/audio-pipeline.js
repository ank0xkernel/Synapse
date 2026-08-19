import { normalizeSource } from './source-state.js';
import { describeLoopbackDevice, requireLoopbackDevice, findLoopbackDevice } from './loopback-device.js';
import { createResampler } from './resampler.js';
import { createAudioQualityMonitor, formatQualityReport } from './audio-quality.js';

const TARGET_SAMPLE_RATE = 16000;
const TARGET_FRAME_MS = 100;
const MIN_FRAME_MS = 50;
const TARGET_FRAME_SAMPLES = Math.round((TARGET_SAMPLE_RATE * TARGET_FRAME_MS) / 1000);
const MIN_FRAME_SAMPLES = Math.round((TARGET_SAMPLE_RATE * MIN_FRAME_MS) / 1000);
const WORKLET_MODULE_PATH = 'pcm-capture-worklet.js';

export function createAudioPipeline({ sendAudioChunk, addMonitorLog, debugAudio = false }) {
  // Quality diagnostics are opt-in: computing RMS/peak/clip stats on every
  // frame is cheap per-frame but non-zero, and this runs continuously for the
  // life of the call. Gated behind debugAudio so normal operation pays nothing.
  const qualityMonitor = debugAudio
    ? createAudioQualityMonitor({
      onReport: (report) => {
        console.log(formatQualityReport(report));
        addMonitorLog('info', 'audio-quality', `RMS ${report.rmsDb.toFixed(1)}dBFS, SNR ${report.snrDb !== null ? report.snrDb.toFixed(1) + 'dB' : 'n/a'}, clip ${report.clippingPct.toFixed(2)}%`, report.source, report);
      }
    })
    : null;
  const workletLoadedContexts = new WeakSet();
  const sourceSampleQueues = {
    mic: { chunks: [], length: 0 },
    system: { chunks: [], length: 0 }
  };
  const audioChunkCounters = { mic: 0, system: 0 };
  // When each source last actually sent a frame — the AudioWorklet posts a
  // message on every audio quantum regardless of whether the signal is
  // speech or silence, so this timestamp going stale means the pipeline
  // itself stopped producing frames, not "the host went quiet." A watchdog
  // can use this to detect a stall the track/socket-level checks miss
  // entirely: the MediaStreamTrack stays 'live' and the AssemblyAI socket
  // stays open even when nothing is actually reaching either of them.
  const lastFrameAt = { mic: 0, system: 0 };

  // Silence tracker. Host audio can be "healthy" at every layer this file and
  // transcription-manager.js already watch — track.readyState 'live', the
  // AudioWorklet posting frames on schedule, the AssemblyAI socket open and
  // streaming — while every one of those frames is pure digital silence. That
  // happens when BlackHole is correctly selected as the capture device (the
  // getUserMedia call above succeeds) but macOS's audio OUTPUT was never
  // routed to it: System Settings > Sound > Output has to be BlackHole, or a
  // Multi-Output Device that includes it, or the call audio never reaches the
  // loopback input in the first place. No existing watchdog catches this —
  // they all confirm frames keep arriving, none of them look at what's in
  // them. This does, using the same per-sample pass sendPcmFrame already
  // makes for NaN/Infinity rejection, so it costs nothing extra to run always
  // (unlike qualityMonitor's RMS/SNR stats above, which are opt-in).
  const SILENCE_PEAK_THRESHOLD = 0.0008; // ~ -62 dBFS. Real captured audio, even quiet, clears this by a wide margin.
  // Hysteresis on the positive direction: a single loud transient (a click, a
  // frame-boundary artifact) should not flip the UI to "signal detected" and
  // back within one frame. Requiring 3 consecutive frames (~300ms at the
  // 100ms frame size below) is enough to reject a blip without adding
  // perceptible delay to noticing real speech.
  const SIGNAL_CONFIRM_FRAMES = 3;
  const silenceTracker = {
    mic: { silentSinceMs: 0, lastPeak: 0, lastRms: 0, consecutiveSignalFrames: 0, signalConfirmed: false },
    system: { silentSinceMs: 0, lastPeak: 0, lastRms: 0, consecutiveSignalFrames: 0, signalConfirmed: false }
  };

  /** Linear amplitude (0..1) to dBFS. -Infinity at exact digital silence, by definition. */
  function linearToDb(value) {
    return value > 0 ? 20 * Math.log10(value) : -Infinity;
  }

  function trackSignalHealth(source, peak, rms) {
    const tracker = silenceTracker[source];
    if (!tracker) return;
    tracker.lastPeak = peak;
    tracker.lastRms = rms;

    if (peak > SILENCE_PEAK_THRESHOLD) {
      tracker.silentSinceMs = 0;
      tracker.consecutiveSignalFrames += 1;
      if (tracker.consecutiveSignalFrames >= SIGNAL_CONFIRM_FRAMES) {
        tracker.signalConfirmed = true;
      }
    } else {
      tracker.consecutiveSignalFrames = 0;
      tracker.signalConfirmed = false;
      if (!tracker.silentSinceMs) {
        tracker.silentSinceMs = Date.now();
      }
    }
  }

  /**
   * Real signal-level info for `source`, not just "a frame arrived":
   * - silent/sinceMs: unbroken run of near-zero frames (drives the silence watchdog)
   * - peakDb/rmsDb: the most recent frame's actual level, for diagnostics
   * - signalConfirmed: hysteresis-debounced "real audio is present" (see SIGNAL_CONFIRM_FRAMES)
   */
  function getSilenceInfo(source) {
    const tracker = silenceTracker[normalizeSource(source)];
    if (!tracker) {
      return { silent: false, sinceMs: 0, peakDb: -Infinity, rmsDb: -Infinity, signalConfirmed: false };
    }
    return {
      silent: !!tracker.silentSinceMs,
      sinceMs: tracker.silentSinceMs ? Date.now() - tracker.silentSinceMs : 0,
      peakDb: linearToDb(tracker.lastPeak),
      rmsDb: linearToDb(tracker.lastRms),
      signalConfirmed: tracker.signalConfirmed
    };
  }

  function convertToPCM16(float32Data) {
    const int16Data = new Int16Array(float32Data.length);
    for (let index = 0; index < float32Data.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, float32Data[index]));
      int16Data[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return int16Data;
  }

  // One resampler per source: each owns its own filter history, and sharing
  // state between mic and system audio would smear two unrelated signals
  // together at every frame boundary.
  const resamplers = {
    mic: createResampler(TARGET_SAMPLE_RATE),
    system: createResampler(TARGET_SAMPLE_RATE)
  };

  function downsampleFloat32Buffer(input, inputSampleRate, source, outputSampleRate = TARGET_SAMPLE_RATE) {
    if (inputSampleRate <= 0 || outputSampleRate <= 0 || input.length === 0) {
      return input;
    }

    if (inputSampleRate === outputSampleRate) {
      return input;
    }

    return resamplers[normalizeSource(source)].process(input, inputSampleRate);
  }

  async function ensureWorkletModule(context) {
    if (workletLoadedContexts.has(context)) {
      return;
    }

    await context.audioWorklet.addModule(WORKLET_MODULE_PATH);
    workletLoadedContexts.add(context);
  }

  function assertHasAudioTrack(stream, source, context) {
    const audioTracks = stream?.getAudioTracks?.() || [];
    if (audioTracks.length === 0) {
      throw new Error(`${context} returned no audio track — nothing would be transcribed.`);
    }
    addMonitorLog('info', 'audio-track', `Capturing "${audioTracks[0].label || 'unnamed'}"`, source, {
      track: audioTracks[0].label,
      settings: audioTracks[0].getSettings ? audioTracks[0].getSettings() : null
    });
    return audioTracks;
  }

  /**
   * Host / far-end audio.
   *
   * This used to go through `chromeMediaSource: 'desktop'`, which does not
   * capture audio on macOS. Worse, the "flat syntax" retry silently degraded to
   * the *default microphone*: `chromeMediaSource` is not a standard
   * MediaTrackConstraint, and outside a `mandatory` block Chromium drops keys it
   * does not recognise, leaving `audio: {}`. The host source was therefore
   * recording the user's own voice. We now bind explicitly to the loopback
   * device by deviceId, and never fall back to a default device.
   */
  async function getSystemAudioStream() {
    const device = await requireLoopbackDevice();

    addMonitorLog('info', 'loopback-device', `Using ${describeLoopbackDevice(device)}`, 'system', {
      deviceId: device.deviceId,
      driver: device.driver
    });

    // Voice DSP is actively harmful on a loopback feed. Echo cancellation is
    // designed to remove whatever correlates with the speaker output — which
    // here *is* the signal — and can null the stream to near silence. Noise
    // suppression and AGC likewise chew up call audio.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: device.deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    });

    try {
      assertHasAudioTrack(stream, 'system', `Loopback device "${device.label}"`);
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      throw error;
    }

    return { stream, device };
  }

  /**
   * Candidate ("USER") microphone.
   *
   * Speaker separation here is deterministic by construction only as long as
   * this call and getSystemAudioStream() actually land on two different
   * physical devices. Historically this took no deviceId at all and simply
   * captured the OS default input — which breaks silently if the loopback
   * device (BlackHole) has *also* been set as the system default input, a
   * real setup mistake some users make while wiring up routing by hand. When
   * that happens both channels hear the host, and anything the host says
   * lands on the mic channel too — which auto-answer.js deliberately never
   * triggers on. Net effect: the host's own questions go unanswered, and it
   * looks like the app stopped working rather than like a device conflict.
   *
   * We now check for that collision explicitly and bind to a real
   * alternative input by deviceId when one exists, instead of trusting the
   * OS default blindly.
   */
  async function getMicAudioStream() {
    const loopback = await findLoopbackDevice({ allowPrompt: false }).then((r) => r.device).catch(() => null);

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false
    });

    try {
      assertHasAudioTrack(stream, 'mic', 'Microphone');
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      throw error;
    }

    if (!loopback) {
      return stream;
    }

    const defaultDeviceId = stream.getAudioTracks()[0]?.getSettings?.().deviceId || null;
    if (defaultDeviceId !== loopback.deviceId) {
      return stream;
    }

    // Collision: the default mic IS the loopback device. Stop it and look for
    // a real alternative input rather than silently letting mic == system.
    stream.getTracks().forEach((track) => track.stop());
    addMonitorLog('error', 'mic-loopback-collision', `Default microphone is the loopback device (${describeLoopbackDevice(loopback)}) — both channels would hear the host. Searching for a real microphone.`, 'mic', { loopbackDeviceId: loopback.deviceId });

    const inputs = await navigator.mediaDevices.enumerateDevices()
      .then((devices) => devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== loopback.deviceId));

    if (inputs.length === 0) {
      throw new Error(
        `No usable microphone found: the only detected input is the loopback device (${describeLoopbackDevice(loopback)}). `
        + 'Set a real microphone as the system default input in System Settings > Sound, then restart the mic source.'
      );
    }

    const fallback = inputs[0];
    addMonitorLog('info', 'mic-loopback-fallback', `Binding mic explicitly to "${fallback.label || fallback.deviceId}" to avoid the loopback collision.`, 'mic', { deviceId: fallback.deviceId });

    const fallbackStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: fallback.deviceId },
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      },
      video: false
    });

    try {
      assertHasAudioTrack(fallbackStream, 'mic', `Microphone "${fallback.label || fallback.deviceId}"`);
    } catch (error) {
      fallbackStream.getTracks().forEach((track) => track.stop());
      throw error;
    }

    return fallbackStream;
  }

  function resetSourceSampleQueue(source) {
    const resolvedSource = normalizeSource(source);
    sourceSampleQueues[resolvedSource] = { chunks: [], length: 0 };
    resamplers[resolvedSource].reset();
  }

  function appendSourceSamples(source, samples) {
    if (!samples || samples.length === 0) {
      return;
    }

    const resolvedSource = normalizeSource(source);
    sourceSampleQueues[resolvedSource].chunks.push(samples);
    sourceSampleQueues[resolvedSource].length += samples.length;
  }

  function pullSourceSamples(source, count) {
    const resolvedSource = normalizeSource(source);
    const queue = sourceSampleQueues[resolvedSource];
    const output = new Float32Array(count);
    let written = 0;

    while (written < count && queue.chunks.length > 0) {
      const first = queue.chunks[0];
      const take = Math.min(first.length, count - written);
      output.set(first.subarray(0, take), written);
      written += take;

      if (take === first.length) {
        queue.chunks.shift();
      } else {
        queue.chunks[0] = first.subarray(take);
      }

      queue.length -= take;
    }

    if (written === count) {
      return output;
    }

    return output.subarray(0, written);
  }

  function sendPcmFrame(source, floatSamples) {
    if (!floatSamples || floatSamples.length < MIN_FRAME_SAMPLES) {
      return;
    }

    const resolvedSource = normalizeSource(source);

    // A NaN or Infinity anywhere in the frame becomes garbage once cast to
    // Int16, and STT will happily hallucinate words out of it. Drop the frame
    // instead of transcribing noise. Track peak amplitude in the same pass —
    // it's already touching every sample, so this is free.
    let peak = 0;
    let sumSquares = 0;
    for (let index = 0; index < floatSamples.length; index += 1) {
      const sample = floatSamples[index];
      if (!Number.isFinite(sample)) {
        addMonitorLog('error', 'frame-rejected', 'Dropped a frame containing non-finite samples', resolvedSource);
        qualityMonitor?.noteRejected(resolvedSource);
        return;
      }
      const abs = sample < 0 ? -sample : sample;
      if (abs > peak) peak = abs;
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / floatSamples.length);

    trackSignalHealth(resolvedSource, peak, rms);
    qualityMonitor?.observe(resolvedSource, floatSamples);

    const pcm = convertToPCM16(floatSamples);

    // Contract with AssemblyAI: 16 kHz mono PCM16. A frame that is not an even
    // number of bytes would desynchronise the stream from this point on.
    if (pcm.buffer.byteLength % 2 !== 0) {
      addMonitorLog('error', 'frame-rejected', 'Dropped a misaligned PCM frame', resolvedSource, {
        bytes: pcm.buffer.byteLength
      });
      return;
    }

    sendAudioChunk(resolvedSource, pcm.buffer);
    audioChunkCounters[resolvedSource] += 1;
    lastFrameAt[resolvedSource] = Date.now();

    if (audioChunkCounters[resolvedSource] % 50 === 0) {
      const health = getSilenceInfo(resolvedSource);
      // Structured, grep-able, and metadata-only — peak/RMS are numbers, never
      // the samples themselves. This is the "everything looks fine" heartbeat;
      // the silence watchdog in transcription-manager.js owns the failure case.
      console.log(
        `[AUDIO_HEALTH] source=${resolvedSource} chunks=${audioChunkCounters[resolvedSource]} `
        + `peak=${Number.isFinite(health.peakDb) ? health.peakDb.toFixed(1) : '-inf'}dBFS `
        + `rms=${Number.isFinite(health.rmsDb) ? health.rmsDb.toFixed(1) : '-inf'}dBFS `
        + `signal=${health.signalConfirmed ? 'detected' : 'silent'}`
      );
      addMonitorLog('info', 'chunk-heartbeat', `Chunks sent: ${audioChunkCounters[resolvedSource]}`, resolvedSource, {
        chunks: audioChunkCounters[resolvedSource],
        frameSamples: floatSamples.length,
        peakDb: health.peakDb,
        rmsDb: health.rmsDb,
        signalConfirmed: health.signalConfirmed
      });
    }
  }

  function drainSourceSampleQueue(source, { flushPartial = false } = {}) {
    const resolvedSource = normalizeSource(source);
    const queue = sourceSampleQueues[resolvedSource];

    while (queue.length >= TARGET_FRAME_SAMPLES) {
      const frame = pullSourceSamples(resolvedSource, TARGET_FRAME_SAMPLES);
      sendPcmFrame(resolvedSource, frame);
    }

    if (flushPartial && queue.length >= MIN_FRAME_SAMPLES) {
      const tailFrame = pullSourceSamples(resolvedSource, queue.length);
      sendPcmFrame(resolvedSource, tailFrame);
    }
  }

  async function buildAudioProcessor(context, stream, source, activeCheck) {
    await ensureWorkletModule(context);

    const src = context.createMediaStreamSource(stream);
    // BlackHole 2ch is stereo. The worklet only reads input[0], so without an
    // explicit downmix we would transcribe the left channel alone and lose
    // anything panned right. 'explicit' + channelCount 1 makes the graph fold
    // the channels together before the processor sees them.
    const node = new AudioWorkletNode(context, 'pcm-capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers'
    });

    const silentGain = context.createGain();
    silentGain.gain.value = 0;

    node.port.onmessage = (event) => {
      if (!activeCheck()) {
        return;
      }

      try {
        const chunk = event.data instanceof Float32Array ? event.data : new Float32Array(event.data || []);
        const normalizedChunk = downsampleFloat32Buffer(chunk, context.sampleRate, source);
        appendSourceSamples(source, normalizedChunk);
        drainSourceSampleQueue(source);
      } catch (error) {
        addMonitorLog('error', 'audio-process-failed', error.message || 'Audio processing failed', source);
      }
    };

    src.connect(node);
    node.connect(silentGain);
    silentGain.connect(context.destination);

    return {
      disconnect: () => {
        try {
          node.port.onmessage = null;
        } catch (_) {
          // no-op
        }
        try {
          src.disconnect();
        } catch (_) {
          // no-op
        }
        try {
          node.disconnect();
        } catch (_) {
          // no-op
        }
        try {
          silentGain.disconnect();
        } catch (_) {
          // no-op
        }
      }
    };
  }

  function stopAudioResources(context, stream, processor) {
    try {
      processor?.disconnect();
    } catch (_) {
      // no-op
    }

    try {
      context?.close();
    } catch (_) {
      // no-op
    }

    stream?.getTracks().forEach((track) => track.stop());
  }

  function resetChunkCounter(source) {
    const resolvedSource = normalizeSource(source);
    audioChunkCounters[resolvedSource] = 0;
    lastFrameAt[resolvedSource] = 0;
    const tracker = silenceTracker[resolvedSource];
    if (tracker) {
      tracker.silentSinceMs = 0;
      tracker.lastPeak = 0;
      tracker.lastRms = 0;
      tracker.consecutiveSignalFrames = 0;
      tracker.signalConfirmed = false;
    }
  }

  /** 0 means "no frame has ever been sent for this source since the last reset". */
  function getLastFrameAt(source) {
    return lastFrameAt[normalizeSource(source)] || 0;
  }

  return {
    buildAudioProcessor,
    drainSourceSampleQueue,
    getLastFrameAt,
    getMicAudioStream,
    getSilenceInfo,
    getSystemAudioStream,
    resetChunkCounter,
    resetSourceSampleQueue,
    stopAudioResources
  };
}
