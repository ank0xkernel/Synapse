'use strict';

// Mode C (continuous screen intelligence) in the main process: owns the hidden
// capture window, the local OCR helper and the screen session, and exposes them
// to the assistant window over IPC.

const path = require('path');
const { createScreenSession } = require('../../../services/screen-intel/screen-session');
const { createOcrService, resolveOcrHelperPath } = require('../../../services/screen-intel/ocr-service');

const START_TIMEOUT_MS = 8000;
const REPLY_TIMEOUT_MS = 4000;
const CONTEXT_CHAR_BUDGET = 24000;
const MAX_EVIDENCE_IMAGES = 3;
const EXTRACT_PROMPT = 'Transcribe every piece of text visible in this image exactly as written. Keep line breaks and code indentation. Output only the transcribed text, with no commentary.';

// Vision returns a syntax-highlighted code line as several fragments on one
// baseline. Join them so a line of code stays one line.
function joinLineFragments(lines) {
  const boxed = lines.filter((line) => line.box);
  const out = lines.filter((line) => !line.box);
  boxed.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const rows = [];
  for (const line of boxed) {
    const mid = line.box.y + line.box.h / 2;
    const row = rows.find((r) => Math.abs(r.mid - mid) < r.h * 0.45);
    if (row) row.items.push(line);
    else rows.push({ mid, h: line.box.h, items: [line] });
  }
  for (const row of rows) {
    row.items.sort((a, b) => a.box.x - b.box.x);
    let current = null;
    for (const item of row.items) {
      const charWidth = item.box.w / Math.max(1, item.text.length);
      const gap = current ? item.box.x - (current.box.x + current.box.w) : Infinity;
      if (current && gap < charWidth * 3) {
        const right = Math.max(current.box.x + current.box.w, item.box.x + item.box.w);
        const bottom = Math.max(current.box.y + current.box.h, item.box.y + item.box.h);
        current.text = `${current.text} ${item.text}`;
        current.confidence = Math.min(current.confidence, item.confidence);
        current.box.y = Math.min(current.box.y, item.box.y);
        current.box.w = right - current.box.x;
        current.box.h = bottom - current.box.y;
      } else {
        current = { ...item, box: { ...item.box } };
        out.push(current);
      }
    }
  }
  return out.sort((a, b) => (a.box && b.box ? a.box.y - b.box.y || a.box.x - b.box.x : 0));
}

function createScreenIntelController({
  app,
  BrowserWindow,
  desktopCapturer,
  screen,
  powerMonitor,
  ipcMain,
  getMainWindow,
  sendToWindow,
  screenshotManager,
  geminiRuntime,
  isAssistantHiddenFromCapture = () => false,
  onProblemChange = () => {},
  problemStore = null,
  log = console.log
}) {
  let captureWindow = null;
  let activeDisplay = null;
  let requestSeq = 0;
  const waiting = new Map();
  let startWaiter = null;
  let disposed = false;

  const ocrService = createOcrService({
    helperPath: resolveOcrHelperPath({ isPackaged: app.isPackaged }),
    log,
    visionFallback: async (imageRef) => {
      const text = await geminiRuntime.executeWithKeyFailover((service) => {
        if (!service || typeof service.generateMultimodal !== 'function') {
          throw new Error('The active AI provider cannot read images.');
        }
        return service.generateMultimodal([
          { text: EXTRACT_PROMPT },
          { inlineData: { data: imageRef.jpeg.toString('base64'), mimeType: imageRef.mime || 'image/jpeg' } }
        ]);
      });
      return { text, engine: geminiRuntime.getActiveAiProvider() === 'ollama' ? 'ollama' : 'gemini' };
    }
  });

  const ocr = {
    async recognize(imageRef, options) {
      const result = await ocrService.recognize(imageRef, options);
      return { ...result, lines: joinLineFragments(result.lines) };
    }
  };

  function toCapture(channel, payload) {
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.webContents.send(channel, payload);
  }

  function ask(channel, payload = {}) {
    if (!captureWindow || captureWindow.isDestroyed()) return Promise.resolve(null);
    requestSeq += 1;
    const requestId = requestSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(requestId);
        resolve(null);
      }, REPLY_TIMEOUT_MS);
      waiting.set(requestId, { resolve, timer });
      toCapture(channel, { ...payload, requestId });
    });
  }

  function resolveDisplay(displayId) {
    const displays = screen.getAllDisplays();
    return displays.find((d) => String(d.id) === String(displayId))
      || screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      || screen.getPrimaryDisplay();
  }

  // The assistant window sits on top of the screen being read. Its rectangle
  // is excluded from analysis and reported as inaccessible, unless the window
  // is already hidden from capture by the OS.
  function currentMaskRects() {
    const win = getMainWindow();
    if (!activeDisplay || !win || win.isDestroyed() || !win.isVisible() || isAssistantHiddenFromCapture()) return [];
    const b = win.getBounds();
    const d = activeDisplay.bounds;
    const x0 = Math.max(b.x, d.x);
    const y0 = Math.max(b.y, d.y);
    const x1 = Math.min(b.x + b.width, d.x + d.width);
    const y1 = Math.min(b.y + b.height, d.y + d.height);
    return x1 > x0 && y1 > y0 ? [{ x: x0 - d.x, y: y0 - d.y, w: x1 - x0, h: y1 - y0 }] : [];
  }

  const pushMask = () => toCapture('mc:mask', currentMaskRects());

  function destroyCaptureWindow() {
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.destroy();
    captureWindow = null;
  }

  function ensureCaptureWindow() {
    if (captureWindow && !captureWindow.isDestroyed()) return Promise.resolve();
    captureWindow = new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        preload: path.join(__dirname, 'capture-preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        backgroundThrottling: false
      }
    });
    const win = captureWindow;
    win.webContents.on('render-process-gone', (_event, details) => {
      log(`[ScreenIntel] capture window process gone: ${details.reason}`);
      destroyCaptureWindow();
      session.notifySystem('capture-window-lost');
    });
    // A file page, not about:blank: navigator.mediaDevices needs a secure context.
    return win.loadFile(path.join(__dirname, 'capture.html'));
  }

  const engineControl = {
    async start({ sessionId, displayId }) {
      const permission = await screenshotManager.validateScreenCaptureCapability();
      if (!permission.authorized) {
        const error = new Error(permission.message || 'Screen Recording permission is not granted.');
        error.code = 'PERMISSION';
        throw error;
      }
      activeDisplay = resolveDisplay(displayId);
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      // Never monitor a different display than the one chosen.
      const source = sources.find((s) => s.display_id === String(activeDisplay.id)) || (sources.length === 1 ? sources[0] : null);
      log(`[ScreenIntel] monitoring display=${activeDisplay.id} ${activeDisplay.bounds.width}x${activeDisplay.bounds.height}@${activeDisplay.scaleFactor}x source=${source ? source.id : 'none'} of ${sources.length}`);
      if (!source) {
        const error = new Error(`Display ${activeDisplay.id} is not among the ${sources.length} capturable screens.`);
        error.code = 'CAPTURE_UNAVAILABLE';
        throw error;
      }
      await ensureCaptureWindow();
      const started = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          startWaiter = null;
          const error = new Error('Screen capture did not start in time.');
          error.code = 'CAPTURE_TIMEOUT';
          reject(error);
        }, START_TIMEOUT_MS);
        startWaiter = { sessionId, resolve, reject, timer };
      });
      toCapture('mc:start', {
        sessionId,
        sourceId: source.id,
        display: {
          id: activeDisplay.id,
          width: activeDisplay.bounds.width,
          height: activeDisplay.bounds.height,
          scaleFactor: activeDisplay.scaleFactor
        },
        maskRects: currentMaskRects()
      });
      await started;
    },
    pause: () => toCapture('mc:pause'),
    resume: async () => {
      pushMask();
      await ask('mc:resume');
    },
    stop: () => {
      toCapture('mc:stop');
      destroyCaptureWindow();
      activeDisplay = null;
    },
    requestRecapture: async (request) => Boolean(await ask('mc:recapture', request)),
    // New Problem: the engine starts a new screen epoch and answers with its number (null when not capturing).
    beginEpoch: async ({ epoch }) => {
      const value = await ask('mc:begin-epoch', { epoch });
      return Number.isFinite(value) ? value : null;
    },
    forgetOutsideView: ({ containerId }) => ask('mc:forget-outside', { containerId }),
    getLatestFrame: () => ask('mc:latest')
  };

  // Callers waiting for the current view to be read (see waitForCurrentView).
  const viewWaiters = new Set();
  // Waits only right after a screen change (problem not decided yet). During
  // ordinary scrolling the answer goes out at once; the live frame covers
  // whatever is not read yet.
  const viewReady = (snap) => snap.monitoring !== 'active' || !snap.problem || snap.problem.status !== 'detecting';
  function settleViewWaiters(snap) {
    for (const waiter of viewWaiters) if (viewReady(snap)) waiter.done(true);
  }

  const session = createScreenSession({
    ocr,
    engineControl,
    problemStore,
    log,
    emitState: (snapshot) => {
      sendToWindow('screen-intel:state', snapshot);
      settleViewWaiters(snapshot);
    },
    onProblemChange: (problem) => {
      log(`[ScreenIntel] problem ${problem.previousId || 'none'} -> ${problem.id} (${problem.decision})`);
      onProblemChange(problem);
    }
  });

  /**
   * Resolves once the visible screen is fully read and its problem decided, or
   * after timeoutMs. Lets an answer started right after a switch use the new
   * screen's text instead of whatever was read before. Never throws.
   */
  function waitForCurrentView({ timeoutMs = 1500 } = {}) {
    const t0 = Date.now();
    if (viewReady(session.getSnapshot())) return Promise.resolve({ ready: true, waitedMs: 0 });
    return new Promise((resolve) => {
      const waiter = {
        done(ready) {
          if (!viewWaiters.delete(waiter)) return;
          clearTimeout(waiter.timer);
          resolve({ ready, waitedMs: Date.now() - t0 });
        }
      };
      waiter.timer = setTimeout(() => waiter.done(viewReady(session.getSnapshot())), timeoutMs);
      viewWaiters.add(waiter);
    });
  }

  const fromCapture = (event) => captureWindow && !captureWindow.isDestroyed() && event.sender === captureWindow.webContents;

  ipcMain.on('mc:started', (event, { sessionId, error }) => {
    if (!fromCapture(event) || !startWaiter || startWaiter.sessionId !== sessionId) return;
    const waiter = startWaiter;
    startWaiter = null;
    clearTimeout(waiter.timer);
    if (error) waiter.reject(Object.assign(new Error(error.message), { code: error.code }));
    else waiter.resolve();
  });

  ipcMain.on('mc:reply', (event, { requestId, value }) => {
    if (!fromCapture(event)) return;
    const waiter = waiting.get(requestId);
    if (!waiter) return;
    waiting.delete(requestId);
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  });

  ipcMain.on('mc:event', (event, payload) => {
    if (!fromCapture(event) || !payload) return;
    if (payload.type === 'error') {
      log(`[ScreenIntel] capture error ${payload.code}: ${payload.message}`);
      if (payload.code === 'STREAM_ENDED') {
        session.notifySystem('capture-window-lost');
        return;
      }
    }
    if (payload.type === 'region' && payload.image && payload.image.jpeg) {
      // IPC delivers the JPEG as a Uint8Array.
      payload.image.jpeg = Buffer.from(payload.image.jpeg);
    }
    session.handleEngineEvent(payload.type === 'region' ? { ...payload, masks: payload.maskRects || [] } : payload);
  });

  function isActive() {
    return session.getSnapshot().monitoring === 'active';
  }

  async function start(options = {}) {
    try {
      const result = await session.start({ displayId: options.displayId });
      watchAssistantWindow();
      return { success: true, ...result };
    } catch (error) {
      log(`[ScreenIntel] start failed: ${error.message}`);
      return { success: false, error: error.message, code: error.code || 'START_FAILED' };
    }
  }

  let watchedWindow = null;
  function watchAssistantWindow() {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || win === watchedWindow) return;
    watchedWindow = win;
    for (const name of ['move', 'resize', 'show', 'hide']) win.on(name, pushMask);
  }

  function imageToDataUrl(imageRef) {
    return imageRef && imageRef.jpeg ? `data:${imageRef.mime || 'image/jpeg'};base64,${Buffer.from(imageRef.jpeg).toString('base64')}` : null;
  }

  /** Text read so far plus the original crops worth showing the model. Null when nothing has been read. */
  function getPromptContext({ charBudget = CONTEXT_CHAR_BUDGET } = {}) {
    const snapshot = session.getSnapshot();
    if (!snapshot.sessionId || snapshot.counts.analysed === 0) return null;
    const context = session.buildContext({ charBudget });
    const imageParts = [];
    for (const regionId of context.imageRegionIds.slice(0, MAX_EVIDENCE_IMAGES)) {
      const region = session.getRegion(regionId);
      if (region && region.imageRef && region.imageRef.jpeg) {
        imageParts.push({ inlineData: { data: Buffer.from(region.imageRef.jpeg).toString('base64'), mimeType: region.imageRef.mime || 'image/jpeg' } });
      }
    }
    return {
      problem: snapshot.problem,
      viewAnalysed: snapshot.view === 'analysed',
      text: [
        '=== SCREEN SESSION CONTEXT ===',
        // Callers attach imageParts with this text; the sentence must only
        // promise images that are actually sent.
        imageParts.length
          ? `Text below was read locally (OCR) from the parts of the screen the user has scrolled through in this session. ${imageParts.length} crop image(s) of those regions are attached; they are the original pixels and win wherever they disagree with this text.`
          : 'Text below was read locally (OCR) from the parts of the screen the user has scrolled through in this session. No crop images of it are attached, so OCR errors in it cannot be checked against pixels.',
        context.text
      ].join('\n'),
      imageParts,
      coverage: context.coverage
    };
  }

  const handlers = {
    'screen-intel:start': (_event, options) => start(options || {}),
    'screen-intel:pause': () => session.pause(),
    'screen-intel:resume': () => session.resume(),
    'screen-intel:stop': () => session.stop(),
    'screen-intel:restart': async () => {
      try {
        return { success: true, ...(await session.restart()) };
      } catch (error) {
        return { success: false, error: error.message, code: error.code };
      }
    },
    'screen-intel:retry': (_event, regionId) => session.retry(typeof regionId === 'string' ? regionId : undefined),
    'screen-intel:reanalyse': (_event, regionId) => session.reanalyse(String(regionId)),
    'screen-intel:get-state': () => session.getSnapshot(),
    'screen-intel:get-region': (_event, regionId) => {
      const region = session.getRegion(String(regionId));
      if (!region) return null;
      const { imageRef, lines, ...rest } = region;
      return { ...rest, imageDataUrl: imageToDataUrl(imageRef) };
    },
    'screen-intel:get-latest-frame': async () => imageToDataUrl(await engineControl.getLatestFrame()),
    'screen-intel:new-problem': () => session.newProblem(),
    'screen-intel:activate-problem': (_event, id) => (typeof id === 'string' && /^p\d{1,6}$/.test(id)
      ? session.activateProblem(id) : { success: false, code: 'BAD_REQUEST', message: 'Unknown problem.' }),
    'screen-intel:resolve-candidate': (_event, request) => {
      const { cutId, choice } = request || {};
      if (typeof cutId !== 'string' || !/^k\d{1,6}$/.test(cutId) || !['new', 'same'].includes(choice)) {
        return { success: false, code: 'BAD_REQUEST', message: 'Invalid boundary decision.' };
      }
      return session.resolveCandidate(cutId, choice);
    },
    'screen-intel:list-problems': () => session.listProblems(),
    'screen-intel:get-metrics': async () => ({ engine: await ask('mc:metrics'), ocr: ocrService.getStats(), ocrEngine: ocrService.getEngine() })
  };
  // These return screen pixels and text: only the assistant window may call them.
  const fromAssistant = (event) => {
    const win = getMainWindow();
    return Boolean(win && !win.isDestroyed() && event && event.sender === win.webContents);
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args) => (fromAssistant(event) ? handler(event, ...args) : { error: 'Not allowed from this window.' }));
  }

  const systemEvents = [
    [powerMonitor, 'suspend', 'suspend'],
    [powerMonitor, 'resume', 'resume'],
    [powerMonitor, 'lock-screen', 'lock'],
    [powerMonitor, 'unlock-screen', 'unlock'],
    [screen, 'display-added', 'display-changed'],
    [screen, 'display-removed', 'display-changed']
  ].map(([emitter, name, event]) => {
    const listener = () => {
      if (session.getSnapshot().monitoring !== 'stopped') session.notifySystem(event);
    };
    emitter.on(name, listener);
    return () => emitter.removeListener(name, listener);
  });
  const onMetrics = (_event, display, changed) => {
    if (activeDisplay && display.id === activeDisplay.id && changed.some((key) => key === 'bounds' || key === 'scaleFactor')) {
      session.notifySystem('display-changed');
    }
  };
  screen.on('display-metrics-changed', onMetrics);
  systemEvents.push(() => screen.removeListener('display-metrics-changed', onMetrics));

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const off of systemEvents) off();
    if (watchedWindow && !watchedWindow.isDestroyed()) {
      for (const name of ['move', 'resize', 'show', 'hide']) watchedWindow.removeListener(name, pushMask);
    }
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
    for (const channel of ['mc:started', 'mc:reply', 'mc:event']) ipcMain.removeAllListeners(channel);
    for (const waiter of [...viewWaiters]) waiter.done(false);
    for (const waiter of waiting.values()) clearTimeout(waiter.timer);
    waiting.clear();
    if (startWaiter) clearTimeout(startWaiter.timer);
    session.dispose();
    ocrService.dispose();
    destroyCaptureWindow();
  }

  return {
    start, isActive, getPromptContext, waitForCurrentView, getProblem: session.getProblem,
    loadProblems: session.loadProblems, saveProblems: session.saveProblems,
    getLatestFrame: engineControl.getLatestFrame, getSnapshot: session.getSnapshot, session, dispose
  };
}

module.exports = { createScreenIntelController, joinLineFragments };
