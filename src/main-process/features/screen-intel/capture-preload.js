'use strict';

// Preload of the hidden Mode C capture window. Holds one desktop MediaStream,
// feeds downscaled grayscale frames to the capture engine and forwards the
// engine's events (with JPEG crops) to the main process. All pixel work happens
// in this process, never in the assistant window or the main process.

const { ipcRenderer } = require('electron');
const { createCaptureEngine } = require('../../../services/screen-intel/capture-engine');
const { toGray } = require('../../../services/screen-intel/frame-analysis');

const JPEG_QUALITY = 0.92;
const BLACK_LEVEL = 10;

let run = null;

function report(sessionId, code, message) {
  ipcRenderer.send('mc:event', { type: 'error', code, message, sessionId, t: Date.now() });
}

async function encode(canvas) {
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
  return { jpeg: Buffer.from(await blob.arrayBuffer()), mime: 'image/jpeg', width: canvas.width, height: canvas.height };
}

function stopRun() {
  if (!run) return;
  const ended = run;
  run = null;
  clearTimeout(ended.timer);
  ended.engine.dispose();
  if (ended.stream) {
    for (const track of ended.stream.getTracks()) {
      track.onended = null;
      track.stop();
    }
  }
  ended.video.srcObject = null;
}

// Bumped by every start and stop: a start that is overtaken by a stop while
// the stream is still opening closes the late stream instead of keeping it.
let startToken = 0;

function openStream({ sourceId, display }) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: Math.round(display.width * display.scaleFactor),
        maxHeight: Math.round(display.height * display.scaleFactor),
        maxFrameRate: 15
      }
    }
  });
}

function watchTracks(current) {
  for (const track of current.stream.getVideoTracks()) {
    track.onended = () => {
      if (run === current && current.stream) report(current.sessionId, 'STREAM_ENDED', 'The screen capture stream ended.');
    };
  }
}

function isBlack(gray) {
  for (let i = 0; i < gray.length; i += 97) if (gray[i] > BLACK_LEVEL) return false;
  return true;
}

async function startRun(config) {
  stopRun();
  startToken += 1;
  const token = startToken;
  const { sessionId, display } = config;
  const stream = await openStream(config);
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = stream;
  const overtaken = () => {
    if (token === startToken) return false;
    for (const t of stream.getTracks()) t.stop();
    video.srcObject = null;
    return true;
  };
  if (overtaken()) throw Object.assign(new Error('Capture was stopped while starting.'), { name: 'AbortError' });
  await video.play();
  if (overtaken()) throw Object.assign(new Error('Capture was stopped while starting.'), { name: 'AbortError' });

  const analysis = new OffscreenCanvas(display.width, display.height);
  const analysisCtx = analysis.getContext('2d', { willReadFrequently: true });
  const gray = new Uint8Array(display.width * display.height);

  // Events leave in the order the engine produced them, even though region
  // crops finish encoding asynchronously.
  let outbox = Promise.resolve();
  const emit = (event) => {
    outbox = outbox.then(async () => {
      if (event.type !== 'region') return ipcRenderer.send('mc:event', event);
      try {
        ipcRenderer.send('mc:event', { ...event, image: await encode(event.image) });
      } catch (error) {
        ipcRenderer.send('mc:event', { type: 'uncaptured', containerId: event.containerId, reason: `encode-failed: ${error.message}`, sessionId, t: Date.now() });
      }
      return undefined;
    });
  };

  // Synchronous: copies the pixels out of the full-resolution frame now,
  // because the frame is released once the engine moves on.
  const cropFrame = (bitmap, rect) => {
    const scale = bitmap.width / display.width;
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(rect.w * scale)), Math.max(1, Math.round(rect.h * scale)));
    canvas.getContext('2d').drawImage(bitmap, rect.x * scale, rect.y * scale, rect.w * scale, rect.h * scale, 0, 0, canvas.width, canvas.height);
    return canvas;
  };

  const engine = createCaptureEngine({
    sessionId,
    display,
    cropFrame,
    emit,
    releaseFrameRef: (bitmap) => bitmap.close()
  });
  engine.setMaskRects(config.maskRects || []);

  const current = { sessionId, config, stream, video, engine, timer: null, paused: false, frames: 0, grabMs: 0, onFrame: null };
  run = current;
  watchTracks(current);

  const tick = async () => {
    if (run !== current) return;
    if (!current.paused && video.readyState >= 2) {
      const started = performance.now();
      try {
        const bitmap = await createImageBitmap(video);
        if (run !== current) {
          bitmap.close();
          return;
        }
        analysisCtx.drawImage(bitmap, 0, 0, display.width, display.height);
        toGray(analysisCtx.getImageData(0, 0, display.width, display.height).data, display.width, display.height, gray);
        if (current.frames === 0 && isBlack(gray)) {
          bitmap.close();
          report(sessionId, 'BLACK_FRAME', 'Screen capture returned a black frame. The content may be protected or Screen Recording permission is missing.');
        } else {
          current.frames += 1;
          engine.pushFrame({ gray, width: display.width, height: display.height, t: Date.now(), frameRef: bitmap });
          current.grabMs = performance.now() - started;
          if (current.onFrame) {
            const done = current.onFrame;
            current.onFrame = null;
            done();
          }
        }
      } catch (error) {
        report(sessionId, 'FRAME_FAILED', error.message);
      }
    }
    current.timer = setTimeout(tick, engine.nextIntervalMs());
  };
  tick();
}

ipcRenderer.on('mc:start', async (_event, config) => {
  try {
    await startRun(config);
    ipcRenderer.send('mc:started', { sessionId: config.sessionId });
  } catch (error) {
    stopRun();
    ipcRenderer.send('mc:started', { sessionId: config.sessionId, error: { code: error.name === 'NotAllowedError' ? 'PERMISSION' : 'STREAM_FAILED', message: error.message } });
  }
});

ipcRenderer.on('mc:stop', () => {
  startToken += 1;
  stopRun();
});

// Pause releases the screen stream itself, so macOS stops showing the
// recording indicator while paused. Engine state (panels, coverage) is kept.
function releaseStream(current) {
  for (const track of current.stream.getTracks()) {
    track.onended = null;
    track.stop();
  }
  current.video.srcObject = null;
  current.stream = null;
}

ipcRenderer.on('mc:pause', () => {
  if (!run) return;
  run.paused = true;
  if (run.stream) releaseStream(run);
});

// Re-opens the same source, then replies once a frame taken after the resume
// has been compared.
ipcRenderer.on('mc:resume', async (_event, { requestId }) => {
  const current = run;
  if (!current) return ipcRenderer.send('mc:reply', { requestId, value: false });
  try {
    if (!current.stream) {
      const stream = await openStream(current.config);
      if (run !== current || !current.paused) { for (const t of stream.getTracks()) t.stop(); return ipcRenderer.send('mc:reply', { requestId, value: false }); }
      current.stream = stream;
      current.video.srcObject = stream;
      await current.video.play();
      watchTracks(current);
    }
  } catch (error) {
    report(current.sessionId, error.name === 'NotAllowedError' ? 'PERMISSION' : 'STREAM_FAILED', `Could not resume screen capture: ${error.message}`);
    return ipcRenderer.send('mc:reply', { requestId, value: false });
  }
  current.onFrame = () => ipcRenderer.send('mc:reply', { requestId, value: true });
  current.paused = false;
  return undefined;
});

ipcRenderer.on('mc:mask', (_event, rects) => {
  if (run) run.engine.setMaskRects(rects || []);
});

ipcRenderer.on('mc:recapture', (_event, { requestId, containerId, contentRect }) => {
  ipcRenderer.send('mc:reply', { requestId, value: run ? run.engine.requestRecapture({ containerId, contentRect }) : false });
});

ipcRenderer.on('mc:begin-epoch', (_event, { requestId, epoch }) => {
  ipcRenderer.send('mc:reply', { requestId, value: run ? run.engine.beginEpoch(epoch) : null });
});

ipcRenderer.on('mc:forget-outside', (_event, { requestId, containerId }) => {
  ipcRenderer.send('mc:reply', { requestId, value: run ? run.engine.forgetOutsideView(containerId) : false });
});

ipcRenderer.on('mc:latest', async (_event, { requestId, maxWidth = 2048 }) => {
  let value = null;
  try {
    if (run && run.video.readyState >= 2) {
      const scale = Math.min(1, maxWidth / run.video.videoWidth);
      const canvas = new OffscreenCanvas(Math.round(run.video.videoWidth * scale), Math.round(run.video.videoHeight * scale));
      canvas.getContext('2d').drawImage(run.video, 0, 0, canvas.width, canvas.height);
      value = await encode(canvas);
    }
  } catch (error) {
    report(run && run.sessionId, 'FRAME_FAILED', error.message);
  }
  ipcRenderer.send('mc:reply', { requestId, value });
});

ipcRenderer.on('mc:metrics', (_event, { requestId }) => {
  ipcRenderer.send('mc:reply', {
    requestId,
    value: run ? { ...run.engine.getMetrics(), streamOpen: Boolean(run.stream), framesGrabbed: run.frames, lastGrabMs: run.grabMs, intervalMs: run.engine.nextIntervalMs(), containers: run.engine.getContainers() } : null
  });
});
