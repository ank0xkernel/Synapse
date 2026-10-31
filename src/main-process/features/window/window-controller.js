const {
  WINDOW_DEFAULT_WIDTH,
  WINDOW_DEFAULT_HEIGHT,
  WINDOW_MIN_WIDTH,
  WINDOW_MIN_HEIGHT,
  WINDOW_OPACITY_LEVEL_MIN,
  WINDOW_OPACITY_LEVEL_MAX,
  DEFAULT_WINDOW_OPACITY_LEVEL,
  STEALTH_WINDOW_OPACITY,
  WINDOW_NUDGE_STEP
} = require('./window-constants');
const { getKeyboardShortcutAccelerator } = require('../../../config');

function createWindowController({
  app,
  screen,
  globalShortcut,
  createAssistantWindow,
  getAppEnvironment,
  emitSttDebug,
  sendToRenderer,
  onTakeStealthScreenshot
}) {
  let mainWindow = null;
  let isVisible = true;
  let autoHideTimer = null;
  let isRecoveryReloadInProgress = false;
  let lastRecoveryReloadAt = 0;
  let activeWindowOpacityLevel = DEFAULT_WINDOW_OPACITY_LEVEL;

  const RECOVERY_RELOAD_COOLDOWN_MS = 5000;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function clampWindowOpacityLevel(level) {
    const parsedLevel = Number.parseInt(String(level ?? ''), 10);

    if (!Number.isFinite(parsedLevel)) {
      return DEFAULT_WINDOW_OPACITY_LEVEL;
    }

    return clamp(parsedLevel, WINDOW_OPACITY_LEVEL_MIN, WINDOW_OPACITY_LEVEL_MAX);
  }

  function setWindowOpacityLevel(level) {
    activeWindowOpacityLevel = clampWindowOpacityLevel(level);
    applyWindowOpacity();
    return activeWindowOpacityLevel;
  }

  function getWindowOpacityLevel() {
    return activeWindowOpacityLevel;
  }

  function getWindowOpacityFromLevel(level) {
    return clampWindowOpacityLevel(level) / 10;
  }

  function getVisibleWindowOpacity() {
    return getWindowOpacityFromLevel(activeWindowOpacityLevel);
  }

  function getStealthWindowOpacity() {
    return Math.min(getVisibleWindowOpacity(), STEALTH_WINDOW_OPACITY);
  }

  function getCurrentWindowOpacity() {
    return isVisible ? getVisibleWindowOpacity() : getStealthWindowOpacity();
  }

  function applyWindowOpacity() {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    mainWindow.setOpacity(getCurrentWindowOpacity());
  }

  /**
   * Click-through: mouse events pass through the overlay to whatever window
   * is behind it, instead of the overlay intercepting them. `forward: true`
   * keeps delivering move events to this window so hover/CSS states still
   * update — only clicks/scrolls fall through.
   *
   * This is deliberately NOT toggled from a button inside the overlay: the
   * instant click-through turns on, every button in the window — including
   * the one that turned it on — stops receiving clicks. The global shortcut
   * (registered in registerShortcuts(), works regardless of focus or
   * click-through state) is the only guaranteed way out, which is why it's
   * documented in config.js as the primary control, not a convenience.
   */
  let isClickThrough = false;

  function applyClickThrough() {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.setIgnoreMouseEvents(isClickThrough, { forward: true });
  }

  function setClickThrough(enabled) {
    isClickThrough = !!enabled;
    applyClickThrough();
    if (typeof sendToRenderer === 'function') {
      sendToRenderer('click-through-changed', { enabled: isClickThrough });
    }
    return isClickThrough;
  }

  function getClickThrough() {
    return isClickThrough;
  }

  function toggleClickThrough() {
    return setClickThrough(!isClickThrough);
  }

  function recoverMainWindowVisibility(reason, { reload = false } = {}) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    console.warn(`Window recovery triggered: ${reason}`);
    if (typeof emitSttDebug === 'function') {
      emitSttDebug({
        level: 'error',
        event: 'window-recovery',
        message: reason
      });
    }

    try {
      if (autoHideTimer) {
        clearTimeout(autoHideTimer);
        autoHideTimer = null;
      }

      isVisible = true;
      mainWindow.setOpacity(getVisibleWindowOpacity());
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      sendToRenderer('set-stealth-mode', false);
    } catch (error) {
      console.error('Window visibility recovery failed:', error);
    }

    if (!reload || !mainWindow.webContents || mainWindow.webContents.isDestroyed()) {
      return;
    }

    const now = Date.now();
    if (isRecoveryReloadInProgress || now - lastRecoveryReloadAt < RECOVERY_RELOAD_COOLDOWN_MS) {
      return;
    }

    isRecoveryReloadInProgress = true;
    lastRecoveryReloadAt = now;
    try {
      mainWindow.webContents.reload();
      if (typeof emitSttDebug === 'function') {
        emitSttDebug({
          event: 'window-reload',
          message: 'Triggered guarded renderer reload'
        });
      }
    } catch (error) {
      console.error('Window recovery reload failed:', error);
      isRecoveryReloadInProgress = false;
      return;
    }

    setTimeout(() => {
      isRecoveryReloadInProgress = false;
    }, 1500);
  }

  function attachWindowRecoveryHandlers() {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    mainWindow.on('unresponsive', () => {
      console.error('Main window became unresponsive');
      recoverMainWindowVisibility('window-unresponsive', { reload: true });
    });

    const contents = mainWindow.webContents;
    if (!contents || contents.isDestroyed()) {
      return;
    }

    contents.on('render-process-gone', (_event, details) => {
      console.error('Renderer process gone:', details);
      recoverMainWindowVisibility('render-process-gone', { reload: true });
    });

    contents.on('unresponsive', () => {
      console.error('WebContents became unresponsive');
      recoverMainWindowVisibility('webcontents-unresponsive', { reload: true });
    });

    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      console.error('WebContents did-fail-load:', {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame
      });
      recoverMainWindowVisibility('did-fail-load', { reload: !!isMainFrame });
    });

    contents.on('did-finish-load', () => {
      isRecoveryReloadInProgress = false;
    });
  }

  function createWindow({ launchHidden = false } = {}) {
    const appEnvironment = getAppEnvironment();
    mainWindow = createAssistantWindow({
      app,
      screen,
      defaultWidth: WINDOW_DEFAULT_WIDTH,
      defaultHeight: WINDOW_DEFAULT_HEIGHT,
      minWidth: WINDOW_MIN_WIDTH,
      minHeight: WINDOW_MIN_HEIGHT,
      hideFromScreenCapture: appEnvironment.hideFromScreenCapture,
      initialOpacity: launchHidden ? getStealthWindowOpacity() : getVisibleWindowOpacity(),
      initialClickThrough: isClickThrough,
      launchHidden,
      nodeEnv: appEnvironment.nodeEnv
    });

    attachWindowRecoveryHandlers();
    isVisible = !launchHidden;
    return mainWindow;
  }

  function getMainWindow() {
    return mainWindow;
  }

  function getSafeWindowBounds(nextBounds = {}) {
    const currentBounds = mainWindow ? mainWindow.getBounds() : {
      x: 0,
      y: 0,
      width: WINDOW_DEFAULT_WIDTH,
      height: WINDOW_DEFAULT_HEIGHT
    };

    const rawBounds = {
      x: Number.isFinite(nextBounds.x) ? Math.round(nextBounds.x) : currentBounds.x,
      y: Number.isFinite(nextBounds.y) ? Math.round(nextBounds.y) : currentBounds.y,
      width: Number.isFinite(nextBounds.width) ? Math.round(nextBounds.width) : currentBounds.width,
      height: Number.isFinite(nextBounds.height) ? Math.round(nextBounds.height) : currentBounds.height
    };

    const display = screen.getDisplayMatching(rawBounds);
    const workArea = display && display.workArea ? display.workArea : screen.getPrimaryDisplay().workArea;

    const width = clamp(rawBounds.width, WINDOW_MIN_WIDTH, workArea.width);
    const height = clamp(rawBounds.height, WINDOW_MIN_HEIGHT, workArea.height);
    const x = clamp(rawBounds.x, workArea.x, workArea.x + workArea.width - width);
    const y = clamp(rawBounds.y, workArea.y, workArea.y + workArea.height - height);

    return { x, y, width, height };
  }

  function setWindowBounds(nextBounds) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { error: 'Main window not available' };
    }

    const safeBounds = getSafeWindowBounds(nextBounds);
    mainWindow.setBounds(safeBounds, false);
    return mainWindow.getBounds();
  }

  function getWindowBounds() {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { error: 'Main window not available' };
    }

    return mainWindow.getBounds();
  }

  /*
   * Compact mode — shrinks the window to a thin status strip instead of
   * hiding it (that's toggleStealthMode, opacity-based, for when the window
   * needs to disappear entirely). Requested directly: during a live
   * interview the full chat/monitor panels cover too much of whatever is
   * underneath (the call window, a shared editor).
   *
   * Width is deliberately left untouched — only height shrinks. The header
   * row (status dot, timer, action buttons) that stays visible in compact
   * mode (see #app.compact-mode in styles.css) was laid out assuming the
   * window's normal width; shrinking width too would risk those buttons
   * overflowing or wrapping in a way this change cannot visually verify
   * before shipping. Shrinking height alone still removes the vast majority
   * of the window's on-screen footprint, which is what was actually asked
   * for ("minimize the whole thing" / "I want to see the screen").
   *
   * mainWindow.setMinimumSize() is the real, Electron-level floor (distinct
   * from getSafeWindowBounds' clamp to WINDOW_MIN_HEIGHT, which is a
   * separate, additional guard for ordinary drag-resizing) — it has to be
   * relaxed before setBounds can go below WINDOW_MIN_HEIGHT, and restored
   * on the way back out so the resize handles keep their normal floor the
   * rest of the time.
   */
  const COMPACT_MODE_HEIGHT = 64;
  const COMPACT_MODE_MIN_WIDTH = 260;
  let preCompactBounds = null;
  let isCompactModeActive = false;

  function setCompactMode(enabled) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { error: 'Main window not available' };
    }

    const next = Boolean(enabled);
    if (next === isCompactModeActive) {
      return { ...mainWindow.getBounds(), compact: isCompactModeActive };
    }

    if (next) {
      preCompactBounds = mainWindow.getBounds();
      mainWindow.setMinimumSize(COMPACT_MODE_MIN_WIDTH, COMPACT_MODE_HEIGHT);

      const display = screen.getDisplayMatching(preCompactBounds);
      const workArea = display && display.workArea ? display.workArea : screen.getPrimaryDisplay().workArea;
      const width = clamp(preCompactBounds.width, COMPACT_MODE_MIN_WIDTH, workArea.width);
      const x = clamp(preCompactBounds.x, workArea.x, workArea.x + workArea.width - width);
      const y = clamp(preCompactBounds.y, workArea.y, workArea.y + workArea.height - COMPACT_MODE_HEIGHT);

      mainWindow.setBounds({ x, y, width, height: COMPACT_MODE_HEIGHT }, false);
      isCompactModeActive = true;
    } else {
      mainWindow.setMinimumSize(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT);
      if (preCompactBounds) {
        mainWindow.setBounds(getSafeWindowBounds(preCompactBounds), false);
      }
      preCompactBounds = null;
      isCompactModeActive = false;
    }

    return { ...mainWindow.getBounds(), compact: isCompactModeActive };
  }

  function toggleStealthMode() {
    if (autoHideTimer) {
      clearTimeout(autoHideTimer);
      autoHideTimer = null;
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    const stealthModeEnabled = isVisible;
    isVisible = !stealthModeEnabled;
    if (isVisible && !mainWindow.isVisible()) {
      mainWindow.showInactive();
    }
    applyWindowOpacity();
    sendToRenderer('set-stealth-mode', stealthModeEnabled);
  }

  function emergencyHide() {
    if (autoHideTimer) {
      clearTimeout(autoHideTimer);
      autoHideTimer = null;
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    mainWindow.setOpacity(0.01);
    sendToRenderer('emergency-clear');

    autoHideTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        isVisible = true;
        applyWindowOpacity();
        sendToRenderer('set-stealth-mode', false);
      }
      autoHideTimer = null;
    }, 2000);
  }

  function moveToPosition(position) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const windowBounds = mainWindow.getBounds();

    let x;
    let y;

    switch (position) {
      case 'left':
        x = 20;
        y = windowBounds.y;
        break;
      case 'right':
        x = width - windowBounds.width - 20;
        y = windowBounds.y;
        break;
      case 'top':
        x = Math.floor((width - windowBounds.width) / 2);
        y = 40;
        break;
      case 'bottom':
        x = Math.floor((width - windowBounds.width) / 2);
        y = height - windowBounds.height - 40;
        break;
      default:
        return;
    }

    mainWindow.setPosition(x, y);
  }

  const NUDGE_DELTAS = {
    left:  { x: -WINDOW_NUDGE_STEP, y: 0 },
    right: { x:  WINDOW_NUDGE_STEP, y: 0 },
    up:    { x: 0, y: -WINDOW_NUDGE_STEP },
    down:  { x: 0, y:  WINDOW_NUDGE_STEP }
  };

  /**
   * Slides the overlay one step in `direction`, unlike moveToPosition() which
   * jumps it to a screen edge. Returns the resulting bounds so callers (and
   * tests) can see where it landed.
   */
  function nudgeWindow(direction) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { error: 'Main window not available' };
    }

    const delta = NUDGE_DELTAS[direction];
    if (!delta) {
      return { error: `Unknown nudge direction: ${direction}` };
    }

    const bounds = mainWindow.getBounds();

    // Routed through getSafeWindowBounds so the step is clamped to the work
    // area of whichever display the overlay currently sits on. Holding the key
    // therefore parks it flush against the edge instead of walking it
    // off-screen where it can never be recovered — the window is frameless and
    // click-through in stealth mode, so there is no dragging it back.
    const safeBounds = getSafeWindowBounds({
      x: bounds.x + delta.x,
      y: bounds.y + delta.y,
      width: bounds.width,
      height: bounds.height
    });

    mainWindow.setBounds(safeBounds, false);
    return mainWindow.getBounds();
  }

  function clampWindowSizePreset(preset) {
    const parsedPreset = Number.parseInt(String(preset ?? ''), 10);
    if (!Number.isFinite(parsedPreset)) {
      return 1;
    }

    return clamp(parsedPreset, 1, 4);
  }

  function getWindowSizeScaleForPreset(preset) {
    const clampedPreset = clampWindowSizePreset(preset);
    return 1 + ((clampedPreset - 1) * 0.25);
  }

  function setWindowSizePreset(preset) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { error: 'Main window not available' };
    }

    const clampedPreset = clampWindowSizePreset(preset);
    const scale = getWindowSizeScaleForPreset(clampedPreset);
    const currentBounds = mainWindow.getBounds();

    const width = Math.round(WINDOW_MIN_WIDTH * scale);
    const height = Math.round(WINDOW_MIN_HEIGHT * scale);

    const centerX = currentBounds.x + Math.round(currentBounds.width / 2);
    const centerY = currentBounds.y + Math.round(currentBounds.height / 2);

    const nextBounds = getSafeWindowBounds({
      x: centerX - Math.round(width / 2),
      y: centerY - Math.round(height / 2),
      width,
      height
    });

    mainWindow.setBounds(nextBounds, false);
    return {
      ...mainWindow.getBounds(),
      preset: clampedPreset
    };
  }

  // Collected per registration pass so a re-bind can report whether the new
  // combination was actually granted by the OS.
  let lastRegistrationFailures = [];

  function registerShortcuts() {
    lastRegistrationFailures = [];

    const registerShortcut = (shortcutId, handler) => {
      const accelerator = getKeyboardShortcutAccelerator(shortcutId);
      const isRegistered = globalShortcut.register(accelerator, handler);
      if (!isRegistered) {
        lastRegistrationFailures.push({ shortcutId, accelerator });
        console.warn(`Failed to register shortcut "${shortcutId}" (${accelerator})`);
      }
    };

    registerShortcut('toggleStealth', () => {
      toggleStealthMode();
    });

    registerShortcut('toggleClickThrough', () => {
      toggleClickThrough();
    });

    registerShortcut('takeScreenshot', async () => {
      if (typeof onTakeStealthScreenshot === 'function') {
        await onTakeStealthScreenshot();
      }
    });

    registerShortcut('askAi', async () => {
      if (typeof emitSttDebug === 'function') {
        emitSttDebug({
          event: 'shortcut-ask-ai',
          message: 'Global Ask AI shortcut triggered'
        });
      }
      sendToRenderer('trigger-ask-ai');
    });

    // These five were defined in config.js and listed in the Settings panel and
    // the empty-state hints, but were never registered — so the keys did
    // nothing while the UI advertised them. They dispatch through one generic
    // channel that the renderer's command bar resolves to the real control,
    // rather than five bespoke IPC channels doing the same job.
    const triggerCommand = (commandId) => () => {
      sendToRenderer('trigger-command', { command: commandId });
    };

    registerShortcut('screenAi', triggerCommand('screen'));
    registerShortcut('suggest', triggerCommand('suggest'));
    registerShortcut('notes', triggerCommand('notes'));
    registerShortcut('insights', triggerCommand('insights'));
    registerShortcut('clearChat', triggerCommand('clear'));

    registerShortcut('emergencyHide', () => {
      emergencyHide();
    });

    registerShortcut('toggleTranscription', () => {
      if (typeof emitSttDebug === 'function') {
        emitSttDebug({
          event: 'shortcut-toggle',
          message: 'Global transcription shortcut triggered'
        });
      }
      sendToRenderer('toggle-voice-recognition');
    });

    registerShortcut('moveWindowLeft', () => {
      nudgeWindow('left');
    });

    registerShortcut('moveWindowRight', () => {
      nudgeWindow('right');
    });

    registerShortcut('moveWindowUp', () => {
      nudgeWindow('up');
    });

    registerShortcut('moveWindowDown', () => {
      nudgeWindow('down');
    });

    registerShortcut('nudgeWindowLeft', () => {
      nudgeWindow('left');
    });

    registerShortcut('nudgeWindowRight', () => {
      nudgeWindow('right');
    });

    registerShortcut('nudgeWindowUp', () => {
      nudgeWindow('up');
    });

    registerShortcut('nudgeWindowDown', () => {
      nudgeWindow('down');
    });

    registerShortcut('windowSizePreset1', () => {
      setWindowSizePreset(1);
    });

    registerShortcut('windowSizePreset2', () => {
      setWindowSizePreset(2);
    });

    registerShortcut('windowSizePreset3', () => {
      setWindowSizePreset(3);
    });

    registerShortcut('windowSizePreset4', () => {
      setWindowSizePreset(4);
    });
  }

  /** Rebinds everything after an accelerator change. */
  function reapplyShortcuts() {
    globalShortcut.unregisterAll();
    registerShortcuts();
    return { ok: lastRegistrationFailures.length === 0, failures: [...lastRegistrationFailures] };
  }

  function unregisterShortcuts() {
    globalShortcut.unregisterAll();
  }

  function destroyWindow() {
    if (autoHideTimer) {
      clearTimeout(autoHideTimer);
      autoHideTimer = null;
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    mainWindow.setClosable(true);
    mainWindow.destroy();
    mainWindow = null;
  }

  function hasWindow() {
    return !!mainWindow && !mainWindow.isDestroyed();
  }

  function markVisible() {
    isVisible = true;
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.showInactive();
    }
    applyWindowOpacity();
  }

  return {
    applyWindowOpacity,
    clampWindowOpacityLevel,
    createWindow,
    destroyWindow,
    emergencyHide,
    getClickThrough,
    getMainWindow,
    getWindowBounds,
    getWindowOpacityLevel,
    hasWindow,
    markVisible,
    registerShortcuts,
    reapplyShortcuts,
    setClickThrough,
    setCompactMode,
    setWindowSizePreset,
    setWindowBounds,
    setWindowOpacityLevel,
    toggleClickThrough,
    toggleStealthMode,
    unregisterShortcuts
  };
}

module.exports = {
  createWindowController
};
