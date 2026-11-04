const fs = require('fs');
const path = require('path');
const { desktopCapturer, screen, systemPreferences, shell } = require('electron');
const screenshot = require('screenshot-desktop');
const { createScreenPermissionManager } = require('./screen-permission-manager');

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

  async function takeStealthScreenshot() {
    if (screenshotInProgress) {
      console.log('Screenshot already in progress, skipping');
      return null;
    }

    const mainWindow = getMainWindow();
    const appEnvironment = getAppEnvironment();

    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Main window not available');
    }

    screenshotInProgress = true;
    try {
      console.log('Capturing screen...');
      const currentOpacity = mainWindow.getOpacity();
      const screenshotDelay = appEnvironment?.screenshotDelay || 300;

      mainWindow.setOpacity(0.01);
      await new Promise((resolve) => setTimeout(resolve, screenshotDelay));

      const screenshotsDir = ensureScreenshotsDir();
      const screenshotPath = path.join(screenshotsDir, `capture-${Date.now()}.png`);

      let capturedBuffer = null;
      if (desktopCapturer && typeof desktopCapturer.getSources === 'function') {
        try {
          const targetDisplay = resolveTargetDisplay(null, mainWindow) || (screen?.getPrimaryDisplay ? screen.getPrimaryDisplay() : null);
          const bounds = targetDisplay?.bounds || { width: 1920, height: 1080 };
          const scaleFactor = targetDisplay?.scaleFactor || 2;
          const rawWidth = Math.round(bounds.width * scaleFactor);
          const rawHeight = Math.round(bounds.height * scaleFactor);
          const maxDim = 2048;
          let targetWidth = rawWidth;
          let targetHeight = rawHeight;
          if (targetWidth > maxDim || targetHeight > maxDim) {
            const scale = Math.min(maxDim / targetWidth, maxDim / targetHeight);
            targetWidth = Math.round(targetWidth * scale);
            targetHeight = Math.round(targetHeight * scale);
          }

          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: targetWidth, height: targetHeight }
          });

          if (sources && sources.length > 0) {
            let matched = null;
            if (targetDisplay) {
              const targetIdStr = String(targetDisplay.id);
              matched = sources.find((s) => (
                s.display_id === targetIdStr ||
                s.id === `screen:${targetIdStr}:0` ||
                (typeof s.id === 'string' && s.id.startsWith(`screen:${targetIdStr}`))
              ));
            }
            if (!matched) matched = sources[0];
            if (matched && matched.thumbnail && !matched.thumbnail.isEmpty()) {
              capturedBuffer = matched.thumbnail.toPNG();
            }
          }
        } catch (capturerErr) {
          console.warn('[ScreenManager] desktopCapturer in stealth screenshot failed, falling back:', capturerErr.message);
        }
      }

      if (capturedBuffer && capturedBuffer.length > 0) {
        fs.writeFileSync(screenshotPath, capturedBuffer);
      } else {
        await screenshot({ filename: screenshotPath });
      }

      const screenshotEntry = {
        id: nextScreenshotId(),
        path: screenshotPath,
        timestamp: new Date().toISOString()
      };

      screenshots.push(screenshotEntry);
      if (screenshots.length > appEnvironment.maxScreenshots) {
        cleanupScreenshotFile(screenshots.shift());
      }

      console.log(`Screenshot saved: ${screenshotPath}`);
      console.log(`Total screenshots: ${screenshots.length}`);

      sendToRenderer('screenshot-taken-stealth', {
        count: screenshots.length,
        screenshotId: screenshotEntry.id,
        timestamp: screenshotEntry.timestamp
      });

      return screenshotPath;
    } catch (error) {
      console.error('Stealth screenshot error:', error);
      throw error;
    } finally {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setOpacity(currentOpacity);
        }
      } catch (_) {}
      screenshotInProgress = false;
    }
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
    const pre = checkScreenRecordingPermission();
    if (pre && pre.authorized && (!desktopCapturer || typeof desktopCapturer.getSources !== 'function')) {
      return pre;
    }
    return permManager.validateCaptureCapability();
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

  async function captureScreenInMemory({ displayId = null } = {}) {
    if (screenshotInProgress) {
      const error = new Error('Screen capture already in progress');
      error.code = 'CAPTURE_IN_PROGRESS';
      throw error;
    }

    screenshotInProgress = true;
    let mainWindow = null;
    let currentOpacity = 1.0;
    let wasVisible = false;
    let wasFocused = false;

    try {
      const perm = await validateScreenCaptureCapability();
      if (!perm.authorized) {
        const isRestart = perm.state === 'RESTART_REQUIRED' || perm.restartRequired;
        const error = new Error(perm.message || (isRestart
          ? 'Screen recording permission was enabled in System Settings, but macOS requires Synapse to restart before capture can activate.'
          : 'Screen Recording permission is not granted. Enable Synapse under System Settings → Privacy & Security → Screen & System Audio Recording.'));
        error.code = isRestart ? 'RESTART_REQUIRED' : 'SCREEN_RECORDING_DENIED';
        error.state = perm.state;
        error.restartRequired = Boolean(isRestart);
        throw error;
      }

      mainWindow = getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        throw new Error('Main window not available');
      }

      currentOpacity = mainWindow.getOpacity();
      wasVisible = mainWindow.isVisible();
      wasFocused = mainWindow.isFocused();

      mainWindow.setOpacity(0.01);
      const appEnvironment = getAppEnvironment?.() || {};
      const screenshotDelay = Math.min(appEnvironment?.screenshotDelay || 150, 300);
      await new Promise((resolve) => setTimeout(resolve, screenshotDelay));

      let imageBuffer = null;

      // 1. High-resolution in-memory capture via Electron desktopCapturer with active display detection & Retina scaling
      if (desktopCapturer && typeof desktopCapturer.getSources === 'function') {
        try {
          const targetDisplay = resolveTargetDisplay(displayId, mainWindow) || (screen?.getPrimaryDisplay ? screen.getPrimaryDisplay() : null);
          const bounds = targetDisplay?.bounds || { width: 1920, height: 1080 };
          const scaleFactor = targetDisplay?.scaleFactor || 2;
          const rawWidth = Math.round(bounds.width * scaleFactor);
          const rawHeight = Math.round(bounds.height * scaleFactor);

          // Preserve text legibility for code & terminal while budgeting dimensions for vision models (max 2048px)
          const MAX_CAPTURE_DIMENSION = 2048;
          let targetWidth = rawWidth;
          let targetHeight = rawHeight;
          if (targetWidth > MAX_CAPTURE_DIMENSION || targetHeight > MAX_CAPTURE_DIMENSION) {
            const scale = Math.min(MAX_CAPTURE_DIMENSION / targetWidth, MAX_CAPTURE_DIMENSION / targetHeight);
            targetWidth = Math.round(targetWidth * scale);
            targetHeight = Math.round(targetHeight * scale);
          }

          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: targetWidth, height: targetHeight }
          });

          if (sources && sources.length > 0) {
            let matched = null;
            if (targetDisplay) {
              const targetIdStr = String(targetDisplay.id);
              matched = sources.find((s) => (
                s.display_id === targetIdStr ||
                s.id === `screen:${targetIdStr}:0` ||
                (typeof s.id === 'string' && s.id.startsWith(`screen:${targetIdStr}`))
              ));
            }

            if (!matched && displayId != null) {
              matched = sources.find((s) => s.display_id === String(displayId));
            }

            if (!matched) {
              matched = sources[0];
            }

            if (matched && matched.thumbnail && !matched.thumbnail.isEmpty()) {
              // Frame validation: verify image is not a completely black or empty frame
              const bitmap = matched.thumbnail.toBitmap();
              let nonBlackPixels = 0;
              const step = 16;
              for (let i = 0; i < bitmap.length; i += step) {
                if (bitmap[i] > 10 || bitmap[i + 1] > 10 || bitmap[i + 2] > 10) {
                  nonBlackPixels++;
                }
              }
              const sampledCount = bitmap.length / step;
              if (nonBlackPixels > 0 || sampledCount === 0) {
                imageBuffer = matched.thumbnail.toJPEG(88);
              } else {
                console.warn('[ScreenManager] desktopCapturer returned a black frame, falling back');
              }
            }
          }
        } catch (capturerErr) {
          console.warn('[ScreenManager] desktopCapturer capture failed, trying fallback:', capturerErr.message);
        }
      }

      // 2. In-memory buffer fallback via screenshot-desktop
      if (!imageBuffer || imageBuffer.length === 0) {
        try {
          const fallback = await screenshot({ format: 'png' });
          if (fallback && fallback.length > 0) {
            imageBuffer = fallback;
          }
        } catch (fallbackErr) {
          console.warn('[ScreenManager] screenshot-desktop in-memory fallback failed:', fallbackErr.message);
        }
      }

      if (!imageBuffer || imageBuffer.length === 0) {
        throw new Error('Screen capture produced an empty or unavailable image. Ensure the screen is not protected or sleeping.');
      }

      if (imageBuffer.length < 500) {
        throw new Error('Screen content is protected or unavailable.');
      }

      const mimeType = imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8 ? 'image/jpeg' : 'image/png';
      return {
        data: imageBuffer.toString('base64'),
        mimeType,
        byteLength: imageBuffer.length,
        timestamp: new Date().toISOString()
      };
    } finally {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setOpacity(currentOpacity);
          if (wasVisible && !mainWindow.isVisible()) {
            mainWindow.showInactive();
          }
          if (wasFocused && !mainWindow.isFocused()) {
            mainWindow.focus();
          }
        }
      } catch (_) {}
      screenshotInProgress = false;
    }
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
  createScreenshotManager
};
