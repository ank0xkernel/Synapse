const fs = require('fs');
const path = require('path');
const { desktopCapturer, screen, systemPreferences } = require('electron');
const screenshot = require('screenshot-desktop');

function createScreenshotManager({ app, getMainWindow, getAppEnvironment, sendToRenderer, getScreenRecordingPermission }) {
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

      await screenshot({ filename: screenshotPath });

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
        if (!mainWindow.isDestroyed()) {
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
      return {
        inlineData: {
          data: imageData.toString('base64'),
          mimeType: 'image/png'
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
    if (process.platform !== 'darwin') {
      return { status: 'granted', authorized: true };
    }
    if (!systemPreferences || typeof systemPreferences.getMediaAccessStatus !== 'function') {
      return { status: 'unknown', authorized: true };
    }
    const status = systemPreferences.getMediaAccessStatus('screen');
    return {
      status,
      authorized: status === 'granted'
    };
  }

  async function captureScreenInMemory({ displayId = null } = {}) {
    if (screenshotInProgress) {
      const error = new Error('Screen capture already in progress');
      error.code = 'CAPTURE_IN_PROGRESS';
      throw error;
    }

    const perm = checkScreenRecordingPermission();
    if (perm.status === 'denied' || perm.status === 'restricted') {
      const error = new Error('Screen Recording permission is not granted. Enable Synapse under System Settings → Privacy & Security → Screen & System Audio Recording.');
      error.code = 'SCREEN_RECORDING_DENIED';
      throw error;
    }

    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Main window not available');
    }

    screenshotInProgress = true;
    const currentOpacity = mainWindow.getOpacity();
    const wasVisible = mainWindow.isVisible();
    const wasFocused = mainWindow.isFocused();

    try {
      mainWindow.setOpacity(0.01);
      const appEnvironment = getAppEnvironment?.() || {};
      const screenshotDelay = Math.min(appEnvironment?.screenshotDelay || 150, 300);
      await new Promise((resolve) => setTimeout(resolve, screenshotDelay));

      let imageBuffer = null;

      // 1. High-resolution in-memory capture via Electron desktopCapturer
      if (desktopCapturer && typeof desktopCapturer.getSources === 'function') {
        try {
          const primaryDisplay = screen ? screen.getPrimaryDisplay() : null;
          const bounds = primaryDisplay?.bounds || { width: 1920, height: 1080 };
          const scaleFactor = primaryDisplay?.scaleFactor || 2;
          const targetWidth = Math.round(bounds.width * scaleFactor);
          const targetHeight = Math.round(bounds.height * scaleFactor);

          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: targetWidth, height: targetHeight }
          });

          if (sources && sources.length > 0) {
            const matched = displayId
              ? sources.find((s) => s.display_id === String(displayId)) || sources[0]
              : sources[0];
            if (matched && matched.thumbnail && !matched.thumbnail.isEmpty()) {
              imageBuffer = matched.thumbnail.toJPEG(85);
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
        if (!mainWindow.isDestroyed()) {
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
    getScreenshotsCount,
    hasScreenshots,
    takeStealthScreenshot
  };
}

module.exports = {
  createScreenshotManager
};
