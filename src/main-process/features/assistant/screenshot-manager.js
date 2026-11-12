const fs = require('fs');
const path = require('path');
const { desktopCapturer, screen, systemPreferences, shell, nativeImage } = require('electron');
const screenshot = require('screenshot-desktop');
const { createScreenPermissionManager } = require('./screen-permission-manager');

// Full display resolution up to 4K. The vision request gets this frame plus
// left/right crops (see buildVisionImageParts), so small sidebar text keeps
// its pixels instead of being averaged away by an early downscale.
const MAX_CAPTURE_DIMENSION = 3840;
// Below this width a half-screen crop adds no detail the full frame lacks.
const MIN_WIDTH_FOR_CROPS = 1600;
const VISION_JPEG_QUALITY = 85;

function captureError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/**
 * Full frame plus left and right halves for the vision model. Models scale
 * every image down to a fixed token budget, so on a Retina screen a sidebar's
 * small print is lost in the full frame alone; each half gets its own budget,
 * which roughly doubles the detail the model sees there. Text parts label
 * each image so the model knows the crops are the same screen.
 * @param {Electron.NativeImage} image
 */
function buildVisionImageParts(image) {
  const { width, height } = image.getSize();
  const part = (img) => ({ inlineData: { data: img.toJPEG(VISION_JPEG_QUALITY).toString('base64'), mimeType: 'image/jpeg' } });
  const parts = [{ text: `[Image 1: the full screen, ${width}x${height}px]` }, part(image)];
  if (width >= MIN_WIDTH_FOR_CROPS) {
    const half = Math.ceil(width / 2);
    parts.push(
      { text: '[Image 2: left half of the same screen at full resolution]' },
      part(image.crop({ x: 0, y: 0, width: half, height })),
      { text: '[Image 3: right half of the same screen at full resolution]' },
      part(image.crop({ x: width - half, y: 0, width: half, height }))
    );
  }
  return parts;
}

function isBlackFrame(image) {
  const bitmap = image.toBitmap();
  let nonBlackPixels = 0;
  for (let i = 0; i < bitmap.length && nonBlackPixels === 0; i += 64) {
    if (bitmap[i] > 10 || bitmap[i + 1] > 10 || bitmap[i + 2] > 10) nonBlackPixels += 1;
  }
  return bitmap.length > 0 && nonBlackPixels === 0;
}

function createScreenshotManager({
  app,
  getMainWindow,
  getAppEnvironment,
  sendToRenderer,
  getScreenRecordingPermission,
  screenPermissionManager
} = {}) {
  const permManager = screenPermissionManager || createScreenPermissionManager({
    app,
    shell,
    systemPreferences,
    desktopCapturer,
    screen
  });
  let screenshots = [];
  let screenshotSequence = 0;
  let captureSequence = 0;
  let screenshotInProgress = false;

  function nextScreenshotId() {
    screenshotSequence += 1;
    return `ss-${Date.now()}-${screenshotSequence}`;
  }

  function normalizeScreenshotEntry(entry) {
    if (!entry) return null;

    if (typeof entry === 'string') {
      return {
        id: null,
        path: entry,
        timestamp: null
      };
    }

    if (typeof entry.path === 'string') {
      return {
        id: typeof entry.id === 'string' ? entry.id : null,
        path: entry.path,
        timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null
      };
    }

    return null;
  }

  function getScreenshotsDir() {
    return app.isPackaged
      ? path.join(app.getPath('userData'), 'screenshots')
      : path.join(__dirname, '..', '..', '..', '..', '.screenshots');
  }

  function ensureScreenshotsDir() {
    const screenshotsDir = getScreenshotsDir();
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }
    return screenshotsDir;
  }

  function cleanupScreenshotFile(entry) {
    const normalizedEntry = normalizeScreenshotEntry(entry);
    if (normalizedEntry && fs.existsSync(normalizedEntry.path)) {
      fs.unlinkSync(normalizedEntry.path);
    }
  }

  function resolveTargetDisplay(displayId, mainWindow) {
    if (!screen) return null;
    try {
      const displays = screen.getAllDisplays ? screen.getAllDisplays() : [];
      if (!displays || displays.length === 0) return null;

      if (displayId != null) {
        const found = displays.find((d) => String(d.id) === String(displayId));
        if (found) return found;
      }

      // 1. Prefer display containing the cursor (where the user's active focus is)
      if (typeof screen.getCursorScreenPoint === 'function' && typeof screen.getDisplayNearestPoint === 'function') {
        const cursorPoint = screen.getCursorScreenPoint();
        if (cursorPoint) {
          const cursorDisplay = screen.getDisplayNearestPoint(cursorPoint);
          if (cursorDisplay) return cursorDisplay;
        }
      }

      // 2. Display containing mainWindow
      if (mainWindow && !mainWindow.isDestroyed() && typeof screen.getDisplayMatching === 'function' && typeof mainWindow.getBounds === 'function') {
        const windowDisplay = screen.getDisplayMatching(mainWindow.getBounds());
        if (windowDisplay) return windowDisplay;
      }

      // 3. Primary display
      if (typeof screen.getPrimaryDisplay === 'function') {
        return screen.getPrimaryDisplay() || displays[0];
      }
      return displays[0];
    } catch (_) {
      return null;
    }
  }

  async function requireCapturePermission() {
    const perm = await validateScreenCaptureCapability();
    if (perm.authorized) return;
    const isRestart = perm.state === 'RESTART_REQUIRED' || perm.restartRequired;
    throw captureError(
      isRestart ? 'RESTART_REQUIRED' : (perm.state === 'CAPTURE_INITIALIZATION_FAILED' ? 'CAPTURE_INITIALIZATION_FAILED' : 'SCREEN_RECORDING_DENIED'),
      perm.message || 'Screen Recording permission is not granted.',
      { state: perm.state, restartRequired: Boolean(isRestart) }
    );
  }

  /**
   * One frame of one display. The frame always comes from the display that
   * was asked for: when that display is not among the sources, the capture
   * fails instead of quietly using another screen.
   */
  async function grabFrame(displayId, mainWindow) {
    const display = resolveTargetDisplay(displayId, mainWindow);
    if (!display) throw captureError('CAPTURE_UNAVAILABLE', 'No display is available to capture.');
    const id = String(display.id);
    const scaleFactor = display.scaleFactor || 1;
    let width = Math.round(display.bounds.width * scaleFactor);
    let height = Math.round(display.bounds.height * scaleFactor);
    if (width > MAX_CAPTURE_DIMENSION || height > MAX_CAPTURE_DIMENSION) {
      const scale = Math.min(MAX_CAPTURE_DIMENSION / width, MAX_CAPTURE_DIMENSION / height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }

    let image = null;
    let source = 'desktopCapturer';
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
      const matched = (sources || []).find((s) => s.display_id === id || (typeof s.id === 'string' && s.id.startsWith(`screen:${id}:`)))
        || (sources && sources.length === 1 ? sources[0] : null);
      if (!matched) {
        throw captureError('CAPTURE_DISPLAY_NOT_FOUND', `Display ${id} is not among the ${sources?.length || 0} capturable screens.`);
      }
      if (matched.thumbnail && !matched.thumbnail.isEmpty()) image = matched.thumbnail;
    } catch (error) {
      if (error.code === 'CAPTURE_DISPLAY_NOT_FOUND') throw error;
      console.warn(`[ScreenCapture] desktopCapturer failed: ${error.message}`);
    }

    // screencapture(1) grabs the main display only, so it is a valid
    // substitute only when there is just one display.
    if (!image && screen.getAllDisplays().length === 1) {
      try {
        const png = await screenshot({ format: 'png' });
        const fallback = png && png.length ? nativeImage.createFromBuffer(png) : null;
        if (fallback && !fallback.isEmpty()) {
          image = fallback;
          source = 'screencapture';
        }
      } catch (error) {
        console.warn(`[ScreenCapture] screencapture fallback failed: ${error.message}`);
      }
    }

    if (!image) throw captureError('CAPTURE_EMPTY_FRAME', 'Screen capture returned no image. The display may be asleep or protected.');
    if (isBlackFrame(image)) throw captureError('CAPTURE_BLACK_FRAME', 'Screen capture returned a black frame. The content may be protected or the display asleep.');

    captureSequence += 1;
    const size = image.getSize();
    return {
      image,
      meta: {
        captureId: `cap-${Date.now()}-${captureSequence}`,
        displayId: id,
        width: size.width,
        height: size.height,
        scaleFactor,
        source,
        capturedAt: Date.now()
      }
    };
  }

  /**
   * Dims the assistant window for the capture and always restores it, even
   * when the capture throws.
   */
  async function withWindowDimmed(mainWindow, delayMs, fn) {
    const previousOpacity = mainWindow.getOpacity();
    const wasVisible = mainWindow.isVisible();
    const wasFocused = mainWindow.isFocused();
    mainWindow.setOpacity(0.01);
    try {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return await fn();
    } finally {
      try {
        if (!mainWindow.isDestroyed()) {
          mainWindow.setOpacity(previousOpacity);
          if (wasVisible && !mainWindow.isVisible()) mainWindow.showInactive();
          if (wasFocused && !mainWindow.isFocused()) mainWindow.focus();
        }
      } catch (error) {
        console.error(`[ScreenCapture] could not restore the assistant window: ${error.message}`);
      }
    }
  }

  async function runExclusiveCapture(displayId, delayMs) {
    if (screenshotInProgress) {
      throw captureError('CAPTURE_IN_PROGRESS', 'A screen capture is already in progress.');
    }
    screenshotInProgress = true;
    const started = Date.now();
    try {
      await requireCapturePermission();
      const mainWindow = getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        throw captureError('WINDOW_UNAVAILABLE', 'The assistant window is not available.');
      }
      const frame = await withWindowDimmed(mainWindow, delayMs, () => grabFrame(displayId, mainWindow));
      const m = frame.meta;
      console.log(`[ScreenCapture] ${m.captureId} display=${m.displayId} ${m.width}x${m.height}@${m.scaleFactor}x source=${m.source} took=${Date.now() - started}ms`);
      return frame;
    } catch (error) {
      console.warn(`[ScreenCapture] failed code=${error.code || 'UNKNOWN'} after ${Date.now() - started}ms: ${error.message}`);
      throw error;
    } finally {
      screenshotInProgress = false;
    }
  }

  async function takeStealthScreenshot() {
    const appEnvironment = getAppEnvironment() || {};
    const { image, meta } = await runExclusiveCapture(null, Math.min(appEnvironment.screenshotDelay || 300, 500));

    const screenshotPath = path.join(ensureScreenshotsDir(), `capture-${meta.capturedAt}.png`);
    fs.writeFileSync(screenshotPath, image.toPNG());

    const screenshotEntry = {
      id: nextScreenshotId(),
      path: screenshotPath,
      timestamp: new Date(meta.capturedAt).toISOString()
    };

    screenshots.push(screenshotEntry);
    if (screenshots.length > (appEnvironment.maxScreenshots || 5)) {
      cleanupScreenshotFile(screenshots.shift());
    }

    sendToRenderer('screenshot-taken-stealth', {
      count: screenshots.length,
      screenshotId: screenshotEntry.id,
      timestamp: screenshotEntry.timestamp
    });

    return screenshotPath;
  }

  async function buildImagePartsFromScreenshots({ strict = true, includeIds = null } = {}) {
    const includeIdSet = Array.isArray(includeIds)
      ? new Set(includeIds.filter((id) => typeof id === 'string' && id.trim().length > 0))
      : null;

    const usableEntries = [];

    for (const entry of screenshots) {
      const normalizedEntry = normalizeScreenshotEntry(entry);
      if (!normalizedEntry) continue;

      if (includeIdSet && (!normalizedEntry.id || !includeIdSet.has(normalizedEntry.id))) {
        continue;
      }

      if (fs.existsSync(normalizedEntry.path)) {
        usableEntries.push(normalizedEntry);
        continue;
      }

      console.error(`Screenshot file not found: ${normalizedEntry.path}`);
      if (strict) {
        throw new Error(`Screenshot file not found: ${normalizedEntry.path}`);
      }
    }

    const imageParts = usableEntries.map((entry) => {
      const imageData = fs.readFileSync(entry.path);
      const isJpeg = imageData.length > 2 && imageData[0] === 0xff && imageData[1] === 0xd8;
      const mimeType = isJpeg ? 'image/jpeg' : 'image/png';
      return {
        inlineData: {
          data: imageData.toString('base64'),
          mimeType
        }
      };
    });

    return {
      imageParts,
      entries: usableEntries
    };
  }

  function clearStealth() {
    screenshots.forEach((entry) => {
      cleanupScreenshotFile(entry);
    });

    screenshots = [];
    screenshotSequence = 0;

    console.log('All screenshots and context cleared');
    return { success: true };
  }

  function cleanupTransientResources() {
    screenshots.forEach((entry) => {
      cleanupScreenshotFile(entry);
    });

    screenshots = [];
    screenshotSequence = 0;
  }

  function getScreenshotsCount() {
    return screenshots.length;
  }

  function hasScreenshots() {
    return screenshots.length > 0;
  }

  function checkScreenRecordingPermission() {
    if (typeof getScreenRecordingPermission === 'function') {
      return getScreenRecordingPermission();
    }
    return permManager.checkPermission();
  }

  async function validateScreenCaptureCapability() {
    if (typeof getScreenRecordingPermission === 'function') {
      const p = getScreenRecordingPermission();
      return {
        state: p.status === 'granted' ? 'GRANTED' : 'DENIED',
        status: p.status,
        authorized: p.authorized !== false && p.status === 'granted',
        message: p.status === 'granted'
          ? 'Screen capture authorized'
          : 'Screen Recording permission is not granted. Enable Synapse under System Settings → Privacy & Security → Screen & System Audio Recording.',
        restartRequired: false
      };
    }
    return permManager.validateCaptureCapability();
  }

  /**
   * One in-memory capture for a vision request. Returns the frame as a
   * NativeImage (for crops) with its capture metadata. Nothing touches disk.
   */
  async function captureScreenInMemory({ displayId = null } = {}) {
    const appEnvironment = getAppEnvironment?.() || {};
    return runExclusiveCapture(displayId, Math.min(appEnvironment.screenshotDelay || 150, 300));
  }

  return {
    buildImagePartsFromScreenshots,
    captureScreenInMemory,
    checkScreenRecordingPermission,
    cleanupTransientResources,
    clearStealth,
    getPermissionManager: () => permManager,
    getScreenshotsCount,
    hasScreenshots,
    takeStealthScreenshot,
    validateScreenCaptureCapability
  };
}

module.exports = {
  buildVisionImageParts,
  createScreenshotManager
};
