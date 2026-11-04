'use strict';

/**
 * screen-permission-manager.js
 *
 * Centralized Screen Capture Permission & Capability Manager for Synapse Desktop.
 *
 * Provides authoritative detection of macOS Screen Recording permissions (TCC),
 * active capture capability validation via Electron desktopCapturer, restart-required
 * detection, and granular diagnostic states:
 *
 * - GRANTED: Permission verified and capture capability established.
 * - DENIED: Permission denied by macOS TCC.
 * - NOT_DETERMINED: Permission not yet requested or undetermined.
 * - RESTART_REQUIRED: Permission granted in macOS System Settings while running,
 *                     requiring an application restart before Mach capture rights activate.
 * - CAPTURE_INITIALIZATION_FAILED: Permission granted, but capture subsystem failed to initialize.
 * - CAPTURE_UNAVAILABLE: No active displays detected or screen capture hardware unavailable.
 */

const PERMISSION_STATES = Object.freeze({
  GRANTED: 'GRANTED',
  DENIED: 'DENIED',
  NOT_DETERMINED: 'NOT_DETERMINED',
  RESTART_REQUIRED: 'RESTART_REQUIRED',
  CAPTURE_INITIALIZATION_FAILED: 'CAPTURE_INITIALIZATION_FAILED',
  CAPTURE_UNAVAILABLE: 'CAPTURE_UNAVAILABLE'
});

function createScreenPermissionManager({
  app,
  shell,
  systemPreferences,
  desktopCapturer,
  screen,
  openExternal = shell?.openExternal ? (url) => shell.openExternal(url) : null
} = {}) {
  let userDirectedToSettings = false;
  let lastObservedMediaStatus = null;
  let lastCapabilityValidation = null;
  let lastCapabilityValidationTime = 0;
  const CAPABILITY_CACHE_TTL_MS = 1500; // Fast 1.5s cache for repeated burst requests

  /**
   * Fast synchronous/preflight permission check using native macOS APIs.
   */
  function checkPermission({ forceFresh = false } = {}) {
    if (process.platform !== 'darwin') {
      return {
        state: PERMISSION_STATES.GRANTED,
        status: 'granted',
        authorized: true,
        message: 'Screen capture is available on this platform.',
        restartRequired: false
      };
    }

    if (!systemPreferences || typeof systemPreferences.getMediaAccessStatus !== 'function') {
      return {
        state: PERMISSION_STATES.GRANTED,
        status: 'unknown',
        authorized: true,
        message: 'System media access status not supported on this platform version.',
        restartRequired: false
      };
    }

    let status = 'unknown';
    try {
      status = systemPreferences.getMediaAccessStatus('screen');
    } catch (err) {
      console.warn('[ScreenPermissionManager] getMediaAccessStatus threw:', err.message);
      status = 'unknown';
    }

    // Verify displays exist if screen API is available
    if (screen && typeof screen.getAllDisplays === 'function') {
      const displays = screen.getAllDisplays() || [];
      if (displays.length === 0) {
        return {
          state: PERMISSION_STATES.CAPTURE_UNAVAILABLE,
          status: 'denied',
          authorized: false,
          message: 'No active displays detected for screen capture.',
          restartRequired: false
        };
      }
    }

    if (status === 'granted') {
      lastObservedMediaStatus = 'granted';
      userDirectedToSettings = false;
      return {
        state: PERMISSION_STATES.GRANTED,
        status: 'granted',
        authorized: true,
        message: 'Screen recording permission is granted and active.',
        restartRequired: false
      };
    }

    if (status === 'not-determined') {
      lastObservedMediaStatus = 'not-determined';
      return {
        state: PERMISSION_STATES.NOT_DETERMINED,
        status: 'not-determined',
        authorized: false,
        message: 'Screen recording permission has not yet been requested from macOS.',
        restartRequired: false
      };
    }

    // Status is 'denied' or 'restricted'
    // If the user was previously directed to System Settings, macOS requires an app restart
    // before Mach port capture rights are updated for this process.
    const restartRequired = userDirectedToSettings || (lastObservedMediaStatus === 'not-determined');
    lastObservedMediaStatus = status;

    return {
      state: restartRequired ? PERMISSION_STATES.RESTART_REQUIRED : PERMISSION_STATES.DENIED,
      status: 'denied',
      authorized: false,
      message: restartRequired
        ? 'Screen recording permission was enabled in System Settings, but macOS requires Synapse to restart before capture can activate.'
        : 'Screen recording permission is not granted. Enable Synapse under System Settings → Privacy & Security → Screen & System Audio Recording.',
      restartRequired
    };
  }

  /**
   * Deep capability validation: probes actual capture through desktopCapturer.
   * Distinguishes permission refusal from initialization failures or display unavailability.
   * Also catches cases where desktopCapturer succeeds despite a false-negative status.
   */
  async function validateCaptureCapability({ forceFresh = false } = {}) {
    const now = Date.now();
    if (!forceFresh && lastCapabilityValidation && (now - lastCapabilityValidationTime < CAPABILITY_CACHE_TTL_MS)) {
      return lastCapabilityValidation;
    }

    const preflight = checkPermission({ forceFresh });

    // Verify displays exist if screen API is available
    if (screen && typeof screen.getAllDisplays === 'function') {
      const displays = screen.getAllDisplays() || [];
      if (displays.length === 0) {
        const res = {
          state: PERMISSION_STATES.CAPTURE_UNAVAILABLE,
          status: 'denied',
          authorized: false,
          message: 'No active display screens found. Ensure your monitor is connected and awake.',
          restartRequired: false
        };
        lastCapabilityValidation = res;
        lastCapabilityValidationTime = now;
        return res;
      }
    }

    if (process.platform !== 'darwin') {
      lastCapabilityValidation = preflight;
      lastCapabilityValidationTime = now;
      return preflight;
    }

    // Active probe with desktopCapturer
    if (desktopCapturer && typeof desktopCapturer.getSources === 'function') {
      try {
        const probeSources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 16, height: 16 }
        });

        if (probeSources && probeSources.length > 0) {
          const hasValidThumbnail = probeSources.some((s) => s.thumbnail && !s.thumbnail.isEmpty());
          if (hasValidThumbnail) {
            // Screen capture capability is genuinely verified and functioning
            const res = {
              state: PERMISSION_STATES.GRANTED,
              status: 'granted',
              authorized: true,
              message: 'Screen capture capability verified.',
              restartRequired: false
            };
            lastCapabilityValidation = res;
            lastCapabilityValidationTime = now;
            return res;
          }
        }

        // If probeSources returned empty or completely empty thumbnails:
        if (preflight.status === 'granted') {
          const res = {
            state: PERMISSION_STATES.CAPTURE_INITIALIZATION_FAILED,
            status: 'denied',
            authorized: false,
            message: 'Screen capture initialization failed to acquire display sources despite permission being granted.',
            restartRequired: false
          };
          lastCapabilityValidation = res;
          lastCapabilityValidationTime = now;
          return res;
        }
      } catch (probeErr) {
        console.warn('[ScreenPermissionManager] Capture probe error:', probeErr.message);
        if (preflight.status === 'granted') {
          const res = {
            state: PERMISSION_STATES.CAPTURE_INITIALIZATION_FAILED,
            status: 'denied',
            authorized: false,
            message: `Screen capture could not initialize: ${probeErr.message}`,
            restartRequired: false
          };
          lastCapabilityValidation = res;
          lastCapabilityValidationTime = now;
          return res;
        }
      }
    }

    // If active capture was not verified, return preflight result
    lastCapabilityValidation = preflight;
    lastCapabilityValidationTime = now;
    return preflight;
  }

  /**
   * Opens macOS System Settings directly to Screen & System Audio Recording.
   */
  async function openSystemSettings() {
    userDirectedToSettings = true;
    lastCapabilityValidation = null;

    if (process.platform === 'darwin') {
      const url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
      if (typeof openExternal === 'function') {
        try {
          await openExternal(url);
          return { success: true, opened: url };
        } catch (err) {
          console.warn('[ScreenPermissionManager] Failed to open System Settings URL:', err.message);
        }
      }
    }
    return { success: false, error: 'Cannot open System Settings on this platform' };
  }

  /**
   * Safely restarts Synapse so that granted macOS permissions take effect.
   */
  function requestRelaunch() {
    if (app && typeof app.relaunch === 'function' && typeof app.exit === 'function') {
      console.log('[ScreenPermissionManager] Relaunching Synapse to apply macOS permissions...');
      app.relaunch();
      app.exit(0);
      return { success: true };
    }
    return { success: false, error: 'App relaunch not supported in current environment' };
  }

  function resetCache() {
    lastCapabilityValidation = null;
    lastCapabilityValidationTime = 0;
  }

  function setUserDirectedToSettings(value) {
    userDirectedToSettings = Boolean(value);
  }

  return {
    PERMISSION_STATES,
    checkPermission,
    validateCaptureCapability,
    openSystemSettings,
    requestRelaunch,
    resetCache,
    setUserDirectedToSettings
  };
}

module.exports = {
  PERMISSION_STATES,
  createScreenPermissionManager
};
