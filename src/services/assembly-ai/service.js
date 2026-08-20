const https = require('https');
const {
  createSttHistoryManager,
  normalizeSttSource
} = require('./stt-history');
const { looksLikeMistranscription } = require('../stt/language-detect');

const ASSEMBLY_AI_SAMPLE_RATE = 16000;

function createAssemblyAiService({
  WebSocket,
  desktopCapturer,
  getAssemblyApiKey,
  getSpeechModel,
  getGeminiService,
  sendToRenderer,
  // Multilingual escalation. 'fast' = AssemblyAI only (English, ~300ms).
  // 'multilingual' = Gemini only (Hindi/Hinglish accurate, ~2-4s).
  // 'auto' = AssemblyAI first, suppressed and replaced by Gemini when its
  // output looks like mangled non-English.
  getSttMode = () => 'auto',
  geminiSpeech = null
}) {
  let assemblyWsMic = null;
  let assemblyWsSystem = null;
  let isStreamingMic = false;
  let isStreamingSystem = false;

  const sttChunkCounters = { mic: 0, system: 0 };
  const sttDroppedChunkCounters = { mic: 0, system: 0 };

  function emitSttDebug({ source = null, level = 'info', event = 'event', message = '', meta = null } = {}) {
    const payload = {
      ts: new Date().toISOString(),
      source: source === 'mic' || source === 'system' ? source : null,
      level,
      event,
      message,
      meta
    };

    sendToRenderer('stt-debug', payload);
  }

  const sttHistoryManager = createSttHistoryManager({
    getGeminiService,
    emitSttDebug,
    mergeWindowMs: 3500
  });

  /**
   * Single exit for every final transcript, whichever engine produced it, so
   * the renderer, the mobile companion and the LLM history can never diverge.
   */
  function emitFinalTranscript(source, text, engine, language) {
    sendToRenderer('vosk-final', { source, text, engine, language });
    sttHistoryManager.queueSttHistorySegment(source, text);
  }

  if (geminiSpeech && typeof geminiSpeech.setTranscriptHandler === 'function') {
    geminiSpeech.setTranscriptHandler(({ source, text, language, engine }) => {
      emitFinalTranscript(source, text, engine, language);
    });
  }

  function cleanupAssemblyWs(ws) {
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'Terminate' }));
      }
      ws.terminate();
    } catch (error) {
      console.error('Error cleaning up AssemblyAI WebSocket:', error);
    }
  }

  function resetSourceState(source) {
    const resolvedSource = normalizeSttSource(source);
    sttChunkCounters[resolvedSource] = 0;
    sttDroppedChunkCounters[resolvedSource] = 0;
    sttHistoryManager.resetSttHistoryBuffer(resolvedSource);

    if (resolvedSource === 'mic') {
      isStreamingMic = false;
      assemblyWsMic = null;
    } else {
      isStreamingSystem = false;
      assemblyWsSystem = null;
    }
  }

  function cleanupTransientResources() {
    sttHistoryManager.flushAllSttHistoryBuffers('cleanup');
    cleanupAssemblyWs(assemblyWsMic);
    cleanupAssemblyWs(assemblyWsSystem);

    assemblyWsMic = null;
    assemblyWsSystem = null;
    isStreamingMic = false;
    isStreamingSystem = false;

    sttChunkCounters.mic = 0;
    sttChunkCounters.system = 0;
    sttDroppedChunkCounters.mic = 0;
    sttDroppedChunkCounters.system = 0;

    sttHistoryManager.resetSttHistoryBuffer('mic');
    sttHistoryManager.resetSttHistoryBuffer('system');
  }

  function isSourceStreaming(source) {
    return source === 'system' ? isStreamingSystem : isStreamingMic;
  }

  function getSourceSocket(source) {
    return source === 'system' ? assemblyWsSystem : assemblyWsMic;
  }

  function setSourceSocket(source, socket) {
    if (source === 'system') {
      assemblyWsSystem = socket;
    } else {
      assemblyWsMic = socket;
    }
  }

  function setSourceStreaming(source, active) {
    if (source === 'system') {
      isStreamingSystem = active;
    } else {
      isStreamingMic = active;
    }
  }

  function startAssemblyAiStream(source) {
    const resolvedSource = normalizeSttSource(source);
    const apiKey = getAssemblyApiKey();

    if (!apiKey) {
      console.error('AssemblyAI API key not configured in app settings');
      emitSttDebug({
        source: resolvedSource,
        level: 'error',
        event: 'missing-api-key',
        message: 'AssemblyAI API key not configured in Settings'
      });
      sendToRenderer('vosk-error', {
        source: resolvedSource,
        error: 'AssemblyAI API key not configured. Add it in Settings.'
      });
      return { success: false, error: 'AssemblyAI API key not configured. Add it in Settings.' };
    }

    if (isSourceStreaming(resolvedSource)) {
      emitSttDebug({
        source: resolvedSource,
        event: 'start-skipped',
        message: 'Start requested while source is already streaming'
      });
      return {
        success: true,
        message: resolvedSource === 'system' ? 'System audio already streaming' : 'Mic already streaming'
      };
    }

    try {
      const queryParams = new URLSearchParams({
        sample_rate: String(ASSEMBLY_AI_SAMPLE_RATE),
        format_turns: 'true',
        speech_model: getSpeechModel(),
        // Endpointing. The defaults (~560ms confident silence, 0.7 confidence)
        // are tuned for transcription accuracy; we are optimising for how fast
        // the answer starts. Dropping both means end_of_turn fires roughly
        // 300ms sooner, which is the single largest slice of the delay between
        // the host stopping and the first token appearing.
        min_end_of_turn_silence_when_confident: '240',
        end_of_turn_confidence_threshold: '0.4',
        max_turn_silence: '1200'
      });

      const wsUrl = `wss://streaming.assemblyai.com/v3/ws?${queryParams.toString()}`;

      console.log(`Connecting to AssemblyAI for source: ${resolvedSource}`);
      emitSttDebug({
        source: resolvedSource,
        event: 'start-request',
        message: 'Opening AssemblyAI WebSocket',
        meta: { speechModel: getSpeechModel() }
      });

      sttChunkCounters[resolvedSource] = 0;
      sttDroppedChunkCounters[resolvedSource] = 0;
      sttHistoryManager.resetSttHistoryBuffer(resolvedSource);

      sendToRenderer('vosk-status', {
        source: resolvedSource,
        status: 'loading',
        message: `Connecting (${resolvedSource})...`
      });

      const ws = new WebSocket(wsUrl, {
        headers: { Authorization: apiKey }
      });

      setSourceSocket(resolvedSource, ws);

      ws.on('open', () => {
        if (getSourceSocket(resolvedSource) !== ws) return; // superseded by a newer connection
        console.log(`AssemblyAI WebSocket connected [${resolvedSource}]`);
        setSourceStreaming(resolvedSource, true);
        emitSttDebug({
          source: resolvedSource,
          event: 'ws-open',
          message: 'AssemblyAI WebSocket connected'
        });
      });

      ws.on('message', (rawMessage) => {
        if (getSourceSocket(resolvedSource) !== ws) return; // superseded by a newer connection
        try {
          const msg = JSON.parse(rawMessage.toString());

          switch (msg.type) {
            case 'Begin':
              console.log(`AssemblyAI session started [${resolvedSource}]:`, msg.id);
              emitSttDebug({
                source: resolvedSource,
                event: 'session-begin',
                message: 'AssemblyAI session started',
                meta: { id: msg.id }
              });
              sendToRenderer('vosk-status', {
                source: resolvedSource,
                status: 'listening',
                message: `Listening (${resolvedSource === 'system' ? 'Host' : 'You'})...`
              });
              break;

            case 'Turn':
              if (msg.transcript) {
                if (msg.end_of_turn) {
                  console.log(`AssemblyAI final [${resolvedSource}]:`, msg.transcript);

                  const mode = getSttMode();
                  const suspect = mode !== 'fast' && geminiSpeech && looksLikeMistranscription(msg.transcript);

                  if (suspect) {
                    // Do not surface phonetic debris. The Gemini transcript for
                    // this same audio is already in flight and will land as the
                    // real final a couple of seconds behind.
                    emitSttDebug({
                      source: resolvedSource,
                      level: 'error',
                      event: 'turn-suppressed',
                      message: 'Transcript looks like mangled non-English — deferring to Gemini',
                      meta: { text: msg.transcript.slice(0, 80) }
                    });
                    sendToRenderer('stt-language-escalation', { source: resolvedSource });

                    // Submit the retained audio for this turn to Gemini. If
                    // nothing was retained (the utterance never closed) fall
                    // back to the AssemblyAI text so the turn is not lost.
                    const escalated = geminiSpeech.escalate(resolvedSource);
                    if (!escalated) {
                      emitSttDebug({
                        source: resolvedSource,
                        level: 'error',
                        event: 'escalation-fallback',
                        message: 'No retained audio — emitting the AssemblyAI transcript as-is'
                      });
                      emitFinalTranscript(resolvedSource, msg.transcript, 'assemblyai', 'en');
                    }
                    break;
                  }

                  emitSttDebug({
                    source: resolvedSource,
                    event: 'turn-final',
                    message: 'Final transcript received',
                    meta: { chars: msg.transcript.length, engine: 'assemblyai' }
                  });
                  emitFinalTranscript(resolvedSource, msg.transcript, 'assemblyai', 'en');
                } else {
                  sendToRenderer('vosk-partial', {
                    source: resolvedSource,
                    text: msg.transcript
                  });
                }
              }
              break;

            case 'Termination':
              console.log(
                `AssemblyAI terminated [${resolvedSource}]. Duration:`,
                msg.audio_duration_seconds,
                's'
              );
              emitSttDebug({
                source: resolvedSource,
                event: 'termination',
                message: 'AssemblyAI stream terminated',
                meta: { durationSeconds: msg.audio_duration_seconds }
              });
              sttHistoryManager.flushSttHistoryBuffer(resolvedSource, 'termination');
              resetSourceState(resolvedSource);
              sendToRenderer('vosk-stopped', { source: resolvedSource });
              break;

            default:
              console.log(`AssemblyAI message [${resolvedSource}]:`, msg.type);
          }
        } catch (parseError) {
          console.error(`Failed to parse AssemblyAI message [${resolvedSource}]:`, parseError);
          emitSttDebug({
            source: resolvedSource,
            level: 'error',
            event: 'parse-error',
            message: parseError.message
          });
        }
      });

      ws.on('error', (error) => {
        if (getSourceSocket(resolvedSource) !== ws) return; // superseded by a newer connection
        console.error(`AssemblyAI WebSocket error [${resolvedSource}]:`, error.message);
        emitSttDebug({
          source: resolvedSource,
          level: 'error',
          event: 'ws-error',
          message: error.message
        });
        sttHistoryManager.flushSttHistoryBuffer(resolvedSource, 'ws-error');
        sendToRenderer('vosk-error', {
          source: resolvedSource,
          error: `Connection error (${resolvedSource}): ${error.message}`,
          // Distinguishes a live socket dying (worth reconnecting) from the
          // missing-API-key vosk-error sent before any socket exists (not
          // worth reconnecting — it would just fail the same way forever).
          unexpected: true
        });
        resetSourceState(resolvedSource);
      });

      ws.on('close', (code, reason) => {
        if (getSourceSocket(resolvedSource) !== ws) {
          // This socket was already superseded by a newer connection for this
          // source (e.g. a fast stop+restart, or a reacquire). Its belated
          // close/termination is old news — acting on it would clobber the
          // live connection's state or falsely flag it as unexpectedly dead.
          console.log(`AssemblyAI WebSocket closed [${resolvedSource}] (stale, ignoring):`, code, reason?.toString());
          return;
        }
        console.log(`AssemblyAI WebSocket closed [${resolvedSource}]:`, code, reason?.toString());
        emitSttDebug({
          source: resolvedSource,
          event: 'ws-close',
          message: 'AssemblyAI WebSocket closed',
          meta: { code, reason: reason?.toString() || '' }
        });

        /*
         * Root cause of "host transcription silently stops": every requested
         * stop (stopVoiceRecognition(), or AssemblyAI's own Termination
         * message in response to it) flips isStreamingSystem/Mic to false
         * BEFORE this handler ever runs — that is what the guard below is
         * actually testing. If it is still true here, nothing asked for this
         * closure: the socket died on its own (network blip, provider-side
         * timeout, auth hiccup), and previously this just tore the session
         * down with no way back — the renderer had no signal to tell "you
         * asked for this" apart from "this happened to you", so it could
         * never distinguish a clean stop from a dead connection worth
         * recovering. `unexpected: true` is that missing signal.
         */
        if (isSourceStreaming(resolvedSource)) {
          sttHistoryManager.flushSttHistoryBuffer(resolvedSource, 'ws-close');
          resetSourceState(resolvedSource);
          sendToRenderer('vosk-stopped', {
            source: resolvedSource,
            unexpected: true,
            code,
            reason: reason?.toString() || ''
          });
        }
      });

      return { success: true };
    } catch (error) {
      console.error(`Error starting AssemblyAI stream [${resolvedSource}]:`, error.message);
      emitSttDebug({
        source: resolvedSource,
        level: 'error',
        event: 'start-failed',
        message: error.message
      });
      setSourceStreaming(resolvedSource, false);
      return { success: false, error: error.message };
    }
  }

  function handleAudioChunk({ source, data }) {
    const resolvedSource = normalizeSttSource(source);
    const ws = getSourceSocket(resolvedSource);

    // Gemini buffers the same frames in parallel. In 'auto' it only speaks up
    // when AssemblyAI garbles the utterance; in 'multilingual' it is the only
    // engine that reports. Buffering is in-memory and costs nothing until an
    // utterance is actually submitted.
    if (geminiSpeech && getSttMode() !== 'fast') {
      try {
        geminiSpeech.handleAudioChunk(resolvedSource, Buffer.from(data));
      } catch (error) {
        emitSttDebug({
          source: resolvedSource,
          level: 'error',
          event: 'gemini-buffer-failed',
          message: error.message
        });
      }
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(Buffer.from(data));
      sttChunkCounters[resolvedSource] += 1;

      if (sttChunkCounters[resolvedSource] % 50 === 0) {
        emitSttDebug({
          source: resolvedSource,
          event: 'chunk-heartbeat',
          message: 'Streaming audio chunks',
          meta: {
            chunks: sttChunkCounters[resolvedSource],
            dropped: sttDroppedChunkCounters[resolvedSource]
          }
        });
      }
      return;
    }

    sttDroppedChunkCounters[resolvedSource] += 1;
    if (sttDroppedChunkCounters[resolvedSource] % 25 === 0) {
      emitSttDebug({
        source: resolvedSource,
        level: 'error',
        event: 'chunk-dropped',
        message: 'Audio chunk dropped because WebSocket is not open',
        meta: {
          dropped: sttDroppedChunkCounters[resolvedSource],
          readyState: ws ? ws.readyState : 'no-ws'
        }
      });
    }
  }

  function stopVoiceRecognition({ source } = {}) {
    emitSttDebug({
      source: source === 'system' || source === 'mic' ? source : null,
      event: 'ipc-stop',
      message: `Stop requested for ${source || 'default'}`
    });

    const stopSource = (src) => {
      const resolvedSource = normalizeSttSource(src);
      const ws = getSourceSocket(resolvedSource);

      if (!ws) {
        sttHistoryManager.flushSttHistoryBuffer(resolvedSource, 'stop-noop');
        emitSttDebug({
          source: resolvedSource,
          event: 'stop-noop',
          message: 'Stop requested but no active socket found'
        });
        sttChunkCounters[resolvedSource] = 0;
        sttDroppedChunkCounters[resolvedSource] = 0;
        return;
      }

      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'Terminate' }));
        }
      } catch (error) {
        console.error(`Error stopping [${resolvedSource}]:`, error.message);
        emitSttDebug({
          source: resolvedSource,
          level: 'error',
          event: 'stop-error',
          message: error.message
        });
      }

      sttHistoryManager.flushSttHistoryBuffer(resolvedSource, 'stop-request');
      sendToRenderer('vosk-status', {
        source: resolvedSource,
        status: 'stopped',
        message: 'Stopped'
      });

      setSourceStreaming(resolvedSource, false);
      sttChunkCounters[resolvedSource] = 0;
      sttDroppedChunkCounters[resolvedSource] = 0;

      emitSttDebug({
        source: resolvedSource,
        event: 'stop-issued',
        message: 'Terminate frame sent to AssemblyAI'
      });
    };

    if (source === 'all') {
      stopSource('mic');
      stopSource('system');
    } else {
      stopSource(source === 'system' ? 'system' : 'mic');
    }

    return { success: true };
  }

  function reportSystemAudioStatus(payload = {}) {
    const status = String(payload.status || 'unknown');

    sendToRenderer('system-audio-status', {
      status,
      message: String(payload.message || ''),
      device: payload.device || null,
      capturing: status === 'capturing',
      ts: Date.now()
    });

    emitSttDebug({
      source: 'system',
      level: status === 'error' || status === 'missing-device' ? 'error' : 'info',
      event: `system-audio-${status}`,
      message: payload.message || status,
      meta: { device: payload.device || null }
    });
  }

  function reportAnswerSuperseded() {
    sendToRenderer('answer-superseded', { ts: Date.now() });
  }

  async function getDesktopSources() {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      return sources.map((source) => ({ id: source.id, name: source.name }));
    } catch (error) {
      console.error('Error getting desktop sources:', error.message);
      return [];
    }
  }

  async function transcribeAudio(base64Audio) {
    const apiKey = getAssemblyApiKey();

    if (!apiKey) {
      return { success: false, error: 'AssemblyAI API key not configured. Add it in Settings.' };
    }

    try {
      const audioBuffer = Buffer.from(base64Audio, 'base64');

      const uploadUrl = await new Promise((resolve, reject) => {
        const request = https.request({
          hostname: 'api.assemblyai.com',
          path: '/v2/upload',
          method: 'POST',
          headers: {
            Authorization: apiKey,
            'Content-Type': 'application/octet-stream',
            'Content-Length': audioBuffer.length
          }
        }, (response) => {
          let data = '';
          response.on('data', (chunk) => {
            data += chunk;
          });
          response.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.upload_url) {
                resolve(result.upload_url);
              } else {
                reject(new Error(result.error || 'Upload failed'));
              }
            } catch (_error) {
              reject(new Error('Failed to parse upload response'));
            }
          });
        });

        request.on('error', reject);
        request.write(audioBuffer);
        request.end();
      });

      const transcriptId = await new Promise((resolve, reject) => {
        const body = JSON.stringify({ audio_url: uploadUrl, language_code: 'en' });

        const request = https.request({
          hostname: 'api.assemblyai.com',
          path: '/v2/transcript',
          method: 'POST',
          headers: {
            Authorization: apiKey,
            'Content-Type': 'application/json'
          }
        }, (response) => {
          let data = '';
          response.on('data', (chunk) => {
            data += chunk;
          });
          response.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.id) {
                resolve(result.id);
              } else {
                reject(new Error(result.error || 'Transcript creation failed'));
              }
            } catch (_error) {
              reject(new Error('Failed to parse transcript response'));
            }
          });
        });

        request.on('error', reject);
        request.write(body);
        request.end();
      });

      const pollTranscript = () => new Promise((resolve, reject) => {
        const request = https.request({
          hostname: 'api.assemblyai.com',
          path: `/v2/transcript/${transcriptId}`,
          method: 'GET',
          headers: { Authorization: apiKey }
        }, (response) => {
          let data = '';
          response.on('data', (chunk) => {
            data += chunk;
          });
          response.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (_error) {
              reject(new Error('Failed to parse poll response'));
            }
          });
        });

        request.on('error', reject);
        request.end();
      });

      let transcript;
      while (true) {
        transcript = await pollTranscript();
        if (transcript.status === 'completed') break;
        if (transcript.status === 'error') {
          throw new Error(transcript.error || 'Transcription failed');
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      const geminiService = getGeminiService();
      if (transcript.text && geminiService) {
        geminiService.addToHistory('user', transcript.text.trim());
      }

      return { success: true, transcript: transcript.text || '' };
    } catch (error) {
      console.error('Error in transcribe-audio:', error.message);
      return { success: false, error: error.message };
    }
  }

  function dispose() {
    cleanupTransientResources();
    sttHistoryManager.dispose();
  }

  function resetSttHistoryBuffers() {
    sttHistoryManager.resetSttHistoryBuffer('mic');
    sttHistoryManager.resetSttHistoryBuffer('system');
  }

  /**
   * Phase 13: sttChunkCounters/sttDroppedChunkCounters and the WebSocket
   * streaming flags were already tracked (they drive the existing
   * chunk-heartbeat/chunk-dropped debug events) but had no external getter.
   * Exposes them read-only for the diagnostic snapshot IPC handler --
   * technical counters only, no transcript content, no keys.
   */
  function getDiagnosticState() {
    return {
      mic: {
        streaming: isStreamingMic,
        framesSent: sttChunkCounters.mic,
        framesDropped: sttDroppedChunkCounters.mic
      },
      system: {
        streaming: isStreamingSystem,
        framesSent: sttChunkCounters.system,
        framesDropped: sttDroppedChunkCounters.system
      }
    };
  }

  return {
    dispose,
    emitSttDebug,
    flushAllSttHistoryBuffers: sttHistoryManager.flushAllSttHistoryBuffers,
    getDesktopSources,
    getDiagnosticState,
    handleAudioChunk,
    reportAnswerSuperseded,
    reportSystemAudioStatus,
    resetSttHistoryBuffers,
    startAssemblyAiStream,
    stopVoiceRecognition,
    transcribeAudio
  };
}

module.exports = {
  createAssemblyAiService
};
