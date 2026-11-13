'use strict';

// Production screen pipeline fed from an offscreen Electron page instead of
// the display stream: the real capture engine, Apple Vision OCR (through the
// same line joining as controller.js) and screen session. Only the frame
// source differs from the app. Must run inside Electron.

const { joinLineFragments } = require('../../src/main-process/features/screen-intel/controller');
const { createCaptureEngine } = require('../../src/services/screen-intel/capture-engine');
const { toGray } = require('../../src/services/screen-intel/frame-analysis');
const { createScreenSession } = require('../../src/services/screen-intel/screen-session');
const { createOcrService, resolveOcrHelperPath } = require('../../src/services/screen-intel/ocr-service');

function createOffscreenRig(page, { width: W, height: H }) {
  const ocrService = createOcrService({ helperPath: resolveOcrHelperPath({ isPackaged: false }), log: () => {} });
  const ocr = { recognize: async (ref, options) => { const r = await ocrService.recognize(ref, options); return { ...r, lines: joinLineFragments(r.lines) }; } };
  const gray = new Uint8Array(W * H);
  let engine = null;
  let timer = null;
  let paused = false;
  let onFrame = null;
  let latest = null;
  const grabMs = [];

  const tick = async () => {
    if (!engine) return;
    if (!paused) {
      const t0 = Date.now();
      const image = await page.webContents.capturePage();
      if (!engine) return;
      latest = image;
      toGray(image.resize({ width: W, height: H }).toBitmap(), W, H, gray);
      engine.pushFrame({ gray, width: W, height: H, t: Date.now(), frameRef: image });
      grabMs.push(Date.now() - t0);
      if (onFrame) { const done = onFrame; onFrame = null; done(); }
    }
    timer = setTimeout(tick, engine.nextIntervalMs());
  };

  const engineControl = {
    start: async ({ sessionId }) => {
      engine = createCaptureEngine({
        sessionId,
        display: { id: 1, width: W, height: H, scaleFactor: 1 },
        cropFrame: (image, rect) => {
          const scale = image.getSize().width / W;
          const crop = image.crop({ x: Math.round(rect.x * scale), y: Math.round(rect.y * scale), width: Math.round(rect.w * scale), height: Math.round(rect.h * scale) });
          return { jpeg: crop.toJPEG(92), mime: 'image/jpeg', width: crop.getSize().width, height: crop.getSize().height };
        },
        emit: (event) => {
          if (process.env.RIG_TRACE) {
            const { type, containerId, kind, contentRect, epoch, container, phase } = event;
            console.log(`    [rig ${Date.now() % 100000}] ${type} ${JSON.stringify({ containerId, kind, contentRect, epoch, phase, container: container && { id: container.id, viewport: container.viewport, epoch: container.epoch } })}`);
          }
          session.handleEngineEvent(event.type === 'region' ? { ...event, masks: event.maskRects || [] } : event);
        }
      });
      tick();
    },
    pause: () => { paused = true; },
    resume: () => new Promise((resolve) => { onFrame = resolve; paused = false; }),
    stop: () => { clearTimeout(timer); if (engine) engine.dispose(); engine = null; },
    requestRecapture: async (request) => (engine ? engine.requestRecapture(request) : false),
    beginEpoch: async ({ epoch }) => (engine ? engine.beginEpoch(epoch) : null),
    forgetOutsideView: async ({ containerId }) => (engine ? engine.forgetOutsideView(containerId) : false),
    getLatestFrame: async () => (latest ? { jpeg: latest.toJPEG(90), mime: 'image/jpeg' } : null)
  };
  const session = createScreenSession({ ocr, engineControl, emitState: () => {} });
  return {
    session,
    ocr,
    getSnapshot: session.getSnapshot,
    getLatestFrame: engineControl.getLatestFrame,
    start: async () => { try { return { success: true, ...(await session.start({ displayId: 1 })) }; } catch (error) { return { success: false, error: error.message }; } },
    engineMetrics: () => (engine ? { ...engine.getMetrics(), grabMsAvg: grabMs.length ? Math.round(grabMs.reduce((a, b) => a + b, 0) / grabMs.length) : null } : null),
    dispose: () => { session.dispose(); ocrService.dispose(); }
  };
}

module.exports = { createOffscreenRig };
