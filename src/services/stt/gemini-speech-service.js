'use strict';

/**
 * Multilingual speech-to-text via Gemini.
 *
 * AssemblyAI's streaming models are English-only in practice. Measured against
 * spoken Hinglish they do not degrade gracefully — they shred it into English
 * phonetic debris ("aapne apne pichhle project" -> "Apne, acne, pitch, lay,
 * project"), which is the "random garbled text" this app was showing. Gemini
 * transcribes the same audio exactly, including code-switching, so it handles
 * the Hindi/Hinglish path.
 *
 * The trade-off is latency: Gemini is a request/response API over a complete
 * utterance, ~2-4s, where AssemblyAI streams partials in ~300ms. So this
 * service is not a drop-in replacement — it is the accurate half of a router
 * (see stt-router.js), used when the audio is not plain English.
 *
 * It emits the same `vosk-partial` / `vosk-final` events as the AssemblyAI
 * service, so every downstream consumer (auto-answer, mobile companion,
 * history) works unchanged.
 */

const https = require('https');
const { detectLanguage } = require('./language-detect');

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

// Endpointing. Speech is detected by RMS; an utterance closes after a run of
// silence. 700ms is long enough to survive a mid-sentence breath and short
// enough that the answer does not feel delayed.
const SILENCE_RMS_THRESHOLD = 0.006;
const SILENCE_CLOSE_MS = 700;
const MIN_UTTERANCE_MS = 400;
const MAX_UTTERANCE_MS = 20000;

const TRANSCRIBE_PROMPT = [
  'Transcribe this audio exactly as spoken. It may be English, Hindi, or Hinglish',
  '(Hindi-English code-switching).',
  'Preserve code-switching faithfully: write Hindi words in Devanagari and English words in Latin script.',
  'Do not translate. Do not summarise. Do not add commentary.',
  'If the audio contains no intelligible speech, output exactly: [NO_SPEECH]'
].join(' ');

/** Wraps raw PCM16 mono in a RIFF header so Gemini can decode it. */
function pcm16ToWav(pcmBuffer, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  const dataSize = pcmBuffer.length;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // PCM chunk size
  header.writeUInt16LE(1, 20);           // format = PCM
  header.writeUInt16LE(1, 22);           // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28); // byte rate
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);              // block align
  header.writeUInt16LE(16, 34);          // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

function computeRms(pcmBuffer) {
  if (!pcmBuffer || pcmBuffer.length < 2) return 0;
  let sum = 0;
  const samples = Math.floor(pcmBuffer.length / 2);
  for (let index = 0; index < samples; index += 1) {
    const sample = pcmBuffer.readInt16LE(index * 2) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

// An escalation request can only arrive after AssemblyAI has finished its own
// turn, so retained audio must outlive the utterance by a little.
const RETAIN_WINDOW_MS = 12000;

function createGeminiSpeechService({
  getApiKey,
  getModel = () => 'gemini-3.5-flash-lite',
  getMode = () => 'auto',
  emitSttDebug = () => {},
  onTranscript = () => {}
}) {
  // Last closed utterance per source, kept only long enough to re-transcribe if
  // the English engine turns out to have garbled it.
  const retained = { mic: null, system: null };

  function shouldTranscribeEagerly() {
    return getMode() === 'multilingual';
  }

  /**
   * Called when AssemblyAI's transcript looks like mangled non-English. Submits
   * the retained audio for that source to Gemini.
   */
  function escalate(source) {
    const resolvedSource = source === 'system' ? 'system' : 'mic';
    const held = retained[resolvedSource];

    if (!held) {
      emitSttDebug({
        source: resolvedSource,
        level: 'error',
        event: 'gemini-escalation-miss',
        message: 'Escalation requested but no retained audio for this turn'
      });
      return false;
    }

    if (Date.now() - held.capturedAt > RETAIN_WINDOW_MS) {
      retained[resolvedSource] = null;
      return false;
    }

    retained[resolvedSource] = null;
    submitForTranscription(resolvedSource, held.pcm, 'escalation');
    return true;
  }

  // The router installs the real handler after construction, so the two
  // services can be wired in either order.
  let transcriptHandler = onTranscript;

  function setTranscriptHandler(handler) {
    if (typeof handler === 'function') transcriptHandler = handler;
  }

  const buffers = {
    mic: createSourceBuffer(),
    system: createSourceBuffer()
  };

  function createSourceBuffer() {
    return {
      chunks: [],
      bytes: 0,
      hasSpeech: false,
      silenceMs: 0,
      startedAt: 0,
      inFlight: 0
    };
  }

  function reset(source) {
    buffers[source] = createSourceBuffer();
  }

  function transcribe(wavBuffer) {
    const apiKey = getApiKey();
    if (!apiKey) {
      return Promise.reject(new Error('No Gemini API key configured.'));
    }

    const body = JSON.stringify({
      contents: [{
        parts: [
          { text: TRANSCRIBE_PROMPT },
          { inline_data: { mime_type: 'audio/wav', data: wavBuffer.toString('base64') } }
        ]
      }],
      // Transcription is a transcription — sampling variety only invents words.
      generationConfig: { temperature: 0, candidateCount: 1 }
    });

    return new Promise((resolve, reject) => {
      const request = https.request({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${getModel()}:generateContent?key=${apiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 15000
      }, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              reject(new Error(`${parsed.error.status}: ${parsed.error.message}`));
              return;
            }
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
            resolve(text.trim());
          } catch (error) {
            reject(new Error(`Malformed Gemini response: ${error.message}`));
          }
        });
      });

      request.on('timeout', () => { request.destroy(); reject(new Error('Gemini transcription timed out')); });
      request.on('error', reject);
      request.write(body);
      request.end();
    });
  }

  /**
   * Closes the current utterance.
   *
   * In 'auto' the audio is retained but NOT sent: AssemblyAI has already
   * transcribed it for free and a second Gemini call per turn would double the
   * API cost and the CPU for nothing. The retained buffer is only submitted if
   * AssemblyAI's output comes back looking like mangled non-English, via
   * escalate(). In 'multilingual' every utterance is submitted directly.
   */
  async function flushUtterance(source, reason, { force = false } = {}) {
    const buffer = buffers[source];
    const durationMs = (buffer.bytes / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000;

    if (!buffer.hasSpeech || durationMs < MIN_UTTERANCE_MS) {
      reset(source);
      return;
    }

    const pcm = Buffer.concat(buffer.chunks, buffer.bytes);
    reset(source);

    if (!force && !shouldTranscribeEagerly()) {
      // Hold it for a possible escalation and stop here.
      retained[source] = { pcm, capturedAt: Date.now() };
      return;
    }

    retained[source] = null;
    submitForTranscription(source, pcm, reason);
  }

  /** Sends one utterance to Gemini and publishes the transcript. */
  async function submitForTranscription(source, pcm, reason) {
    const durationMs = (pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000;
    buffers[source].inFlight += 1;
    const startedAt = Date.now();

    emitSttDebug({
      source,
      event: 'gemini-stt-request',
      message: 'Transcribing utterance with Gemini',
      meta: { reason, durationMs: Math.round(durationMs) }
    });

    try {
      const raw = await transcribe(pcm16ToWav(pcm));
      const text = raw.replace(/\[NO_SPEECH\]/gi, '').trim();

      if (!text) {
        emitSttDebug({ source, event: 'gemini-stt-empty', message: 'No speech in utterance' });
        return;
      }

      const detection = detectLanguage(text);

      emitSttDebug({
        source,
        event: 'gemini-stt-final',
        message: 'Gemini transcript ready',
        meta: {
          latencyMs: Date.now() - startedAt,
          language: detection.language,
          chars: text.length
        }
      });

      transcriptHandler({ source, text, language: detection.language, engine: 'gemini' });
    } catch (error) {
      emitSttDebug({
        source,
        level: 'error',
        event: 'gemini-stt-failed',
        message: error.message
      });
    } finally {
      buffers[source].inFlight = Math.max(0, buffers[source].inFlight - 1);
    }
  }

  /**
   * Feed the same PCM16 frames that go to AssemblyAI. Returns true when the
   * frame closed an utterance, so a caller can align its own state.
   */
  function handleAudioChunk(source, data) {
    const resolvedSource = source === 'system' ? 'system' : 'mic';
    const buffer = buffers[resolvedSource];
    const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data);

    if (pcm.length === 0) return false;

    const frameMs = (pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000;
    const isSpeech = computeRms(pcm) > SILENCE_RMS_THRESHOLD;

    // Leading silence is dropped so the utterance starts at the first word;
    // trailing silence is kept because it is what closes the turn.
    if (!buffer.hasSpeech && !isSpeech) return false;

    if (!buffer.hasSpeech && isSpeech) {
      buffer.hasSpeech = true;
      buffer.startedAt = Date.now();
    }

    buffer.chunks.push(pcm);
    buffer.bytes += pcm.length;
    buffer.silenceMs = isSpeech ? 0 : buffer.silenceMs + frameMs;

    const durationMs = (buffer.bytes / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000;

    if (buffer.silenceMs >= SILENCE_CLOSE_MS) {
      flushUtterance(resolvedSource, 'silence');
      return true;
    }

    // A monologue with no real pause would otherwise buffer forever and blow
    // past the request size limit.
    if (durationMs >= MAX_UTTERANCE_MS) {
      flushUtterance(resolvedSource, 'max-duration');
      return true;
    }

    return false;
  }

  function flushAll(reason = 'manual') {
    flushUtterance('mic', reason);
    flushUtterance('system', reason);
  }

  function dispose() {
    reset('mic');
    reset('system');
    retained.mic = null;
    retained.system = null;
  }

  return {
    dispose,
    escalate,
    flushAll,
    handleAudioChunk,
    resetSource: reset,
    setTranscriptHandler,
    // exported for tests
    _internals: { pcm16ToWav, computeRms }
  };
}

module.exports = { createGeminiSpeechService };
