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
  // The model reduces every image to the same token budget, so a full frame
  // above 2048px only adds upload size; detail comes from the crops below.
  const overview = Math.max(width, height) > 2048
    ? image.resize(width >= height ? { width: 2048, quality: 'best' } : { height: 2048, quality: 'best' })
    : image;
  const parts = [{ text: `[Image 1: the full screen, ${width}x${height}px]` }, part(overview)];
  for (const tile of visionTiles(width, height)) {
    parts.push({ text: `[Image ${parts.length / 2 + 1}: ${tile.label} of the same screen at full resolution]` }, part(image.crop(tile.rect)));
  }
  return parts;
}

/**
 * Tiles along the screen's long side, so each tile is close to square and
 * keeps its detail when the model scales it down: halves on a 16:10 or 16:9
 * screen, thirds on a 32:9 ultra-wide, top/bottom on a portrait monitor.
 * None below MIN_WIDTH_FOR_CROPS on the long side, where the full frame
 * already holds every pixel the model will look at.
 */
function visionTiles(width, height) {
  const long = Math.max(width, height);
  if (long < MIN_WIDTH_FOR_CROPS) return [];
  const count = Math.min(3, Math.max(2, Math.round(long / Math.min(width, height))));
  const horizontal = width >= height;
  const names = count === 2
    ? (horizontal ? ['left half', 'right half'] : ['top half', 'bottom half'])
    : (horizontal ? ['left third', 'middle third', 'right third'] : ['top third', 'middle third', 'bottom third']);
  const size = Math.ceil(long / count);
  return names.map((label, i) => {
    const start = Math.min(i * size, long - size);
    return {
      label,
      rect: horizontal ? { x: start, y: 0, width: size, height } : { x: 0, y: start, width, height: size }
    };
  });
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

  // Earlier builds kept manual screenshots as PNG files here until exit; a
  // crash left them behind. Screenshots now live only in memory, so any such
  // folder holds leftovers of transient captures and is removed.
  function removeLegacyScreenshotsDir() {
    if (!app || typeof app.getPath !== 'function') return;
    const dir = app.isPackaged
      ? path.join(app.getPath('userData'), 'screenshots')
      : path.join(__dirname, '..', '..', '..', '..', '.screenshots');
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[ScreenCapture] could not remove leftover screenshots in ${dir}: ${error.message}`);
    }
  }
  removeLegacyScreenshotsDir();

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

  /** Manual Capture Screen. The PNG stays in memory until cleared or the app exits. */
  async function takeStealthScreenshot() {
    const appEnvironment = getAppEnvironment() || {};
    const { image, meta } = await runExclusiveCapture(null, Math.min(appEnvironment.screenshotDelay || 300, 500));

    const screenshotEntry = {
      id: nextScreenshotId(),
      png: image.toPNG(),
      timestamp: new Date(meta.capturedAt).toISOString()
    };

    screenshots.push(screenshotEntry);
    if (screenshots.length > (appEnvironment.maxScreenshots || 5)) screenshots.shift();

    sendToRenderer('screenshot-taken-stealth', {
      count: screenshots.length,
      screenshotId: screenshotEntry.id,
      timestamp: screenshotEntry.timestamp
    });

    return { success: true, screenshotId: screenshotEntry.id, timestamp: screenshotEntry.timestamp };
  }

  /** Image parts for the stored screenshots, optionally only the given ids. */
  async function buildImagePartsFromScreenshots({ includeIds = null } = {}) {
    const includeIdSet = Array.isArray(includeIds)
      ? new Set(includeIds.filter((id) => typeof id === 'string' && id.trim().length > 0))
      : null;
    const entries = screenshots.filter((entry) => !includeIdSet || includeIdSet.has(entry.id));
    // The MIME type comes from the bytes, never from what the entry claims.
    const mimeOf = (imageData) => (imageData.length > 2 && imageData[0] === 0xff && imageData[1] === 0xd8 ? 'image/jpeg' : 'image/png');
    const imageParts = entries.map((entry) => ({
      inlineData: { data: entry.png.toString('base64'), mimeType: mimeOf(entry.png) }
    }));
    return { imageParts, entries };
  }

  function clearStealth() {
    screenshots = [];
    screenshotSequence = 0;
    console.log('All screenshots and context cleared');
    return { success: true };
  }

  function cleanupTransientResources() {
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
