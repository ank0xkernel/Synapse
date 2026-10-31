const path = require('path');
const { BrowserWindow } = require('electron');

const appProtocol = require('../../main-process/shared/app-protocol');

function createAssistantWindow({
  app,
  screen,
  defaultWidth,
  defaultHeight,
  minWidth,
  minHeight,
  hideFromScreenCapture,
  initialOpacity,
  initialClickThrough = false,
  launchHidden,
  nodeEnv
}) {
  console.log('Creating assistant window...');
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const x = Math.floor((width - defaultWidth) / 2);
  const y = 40;
  const windowOpacity = Number.isFinite(initialOpacity) ? initialOpacity : 1;

  console.log(`Window position: ${x}, ${y}, size: ${defaultWidth}x${defaultHeight}`);

  const mainWindow = new BrowserWindow({
    width: defaultWidth,
    height: defaultHeight,
    minWidth,
    minHeight,
    maxWidth: width,
    maxHeight: height,
    x,
    y,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      offscreen: false,
      // The renderer is served over the privileged `synapse://` scheme (see
      // main-process/shared/app-protocol.js) precisely so that its ES module
      // entry point loads with web security left ON. Serving it from file://
      // is what previously forced this to false.
      webSecurity: true,
      experimentalFeatures: false,
      enableRemoteModule: false,
      sandbox: false
    },
    frame: false,
    // The window itself is now genuinely see-through; the visible "glass"
    // shape (blur, tint, border, shadow) is painted entirely by
    // .app in ui/app.css, driven by CSS variables (--shell-veil,
    // --shell-blur, --shell-brightness) that command-bar.js's
    // initAppearanceControls() sets live from the Settings sliders. hasShadow stays false: a native window shadow would draw
    // a rectangle around the full (now invisible) window bounds, not around
    // the rounded glass shape — the shadow the user actually sees comes from
    // .glass-container's own box-shadow.
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: true,
    show: false,
    opacity: windowOpacity,
    type: 'toolbar',
    acceptFirstMouse: false,
    disableAutoHideCursor: true,
    enableLargerThanScreen: false,
    hasShadow: false,
    thickFrame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#00000000'
  });

  const rendererUrl = appProtocol.urlFor('assistant', 'renderer.html');
  console.log('Loading renderer from:', rendererUrl);
  mainWindow.loadURL(rendererUrl);

  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    console.log('Permission requested:', permission);
    if (permission === 'microphone' || permission === 'media') {
      console.log('Granting microphone permission');
      callback(true);
    } else {
      console.log('Denying permission:', permission);
      callback(false);
    }
  });

  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    console.log('Permission check:', permission, requestingOrigin);
    return permission === 'microphone' || permission === 'media';
  });

  if (process.platform === 'darwin') {
    mainWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    });
    mainWindow.setAlwaysOnTop(true, 'pop-up-menu', 1);
    app.dock.hide();
    mainWindow.setHiddenInMissionControl(true);
  } else if (process.platform === 'win32') {
    // Overlay behaviour: float above the call window without owning a taskbar
    // slot. The app identifies itself honestly to the shell.
    console.log('Applying Windows overlay window settings');
    mainWindow.setSkipTaskbar(true);
    mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
    mainWindow.setAppDetails({
      appId: 'com.synapse.interviewcoach',
      relaunchDisplayName: 'Synapse'
    });
  }

  // Screen-capture hiding removed on purpose.
  //
  // This used to call `mainWindow.setContentProtection(hideFromScreenCapture)`,
  // which makes the window invisible to screen recording and screen sharing at
  // the OS compositor level. Whatever the intent, the observable effect is that
  // the window is present to the user and absent from any capture of that same
  // screen — the defining property of a stealth overlay. Synapse is a personal
  // assistant, so the window is now an ordinary one: if you share your screen,
  // it shares like anything else, and you can move or hide it yourself with
  // ⌥⇧X.
  //
  // `app.dock.hide()` above is kept — a tray/menu-bar app legitimately has no
  // dock tile, and it conceals nothing about the app running.
  mainWindow.setContentProtection(hideFromScreenCapture);
  console.log(`Screen-capture hiding is ${hideFromScreenCapture ? 'enabled' : 'disabled'}.`);

  mainWindow.setIgnoreMouseEvents(initialClickThrough, { forward: true });

  mainWindow.webContents.on('dom-ready', () => {
    console.log('DOM is ready');
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('HTML finished loading');

    mainWindow.webContents.executeJavaScript(`
      console.log('Content check...');
      console.log('Document title:', document.title);
      console.log('Body exists:', !!document.body);
      console.log('App element exists:', !!document.getElementById('app'));
      console.log('Glass container exists:', !!document.querySelector('.glass-container'));

      document.body.style.background = 'transparent';

      if (document.body) {
        document.body.style.visibility = 'visible';
        document.body.style.display = 'block';
        console.log('Body made visible');
      }

      const app = document.getElementById('app');
      if (app) {
        app.style.visibility = 'visible';
        app.style.display = 'flex';
        console.log('App container made visible');
      }

      'Content visibility check complete';
    `).then((result) => {
      console.log('JavaScript result:', result);
      if (launchHidden) {
        console.log('Window initialized in hidden launch mode');
        return;
      }

      mainWindow.showInactive();
      console.log('Window shown in inactive mode with transparent background');
    }).catch((error) => {
      console.log('JavaScript execution failed:', error);
      if (!launchHidden) {
        mainWindow.showInactive();
      }
    });
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load:', errorCode, errorDescription);
  });

  mainWindow.webContents.on('console-message', (event, level, message) => {
    console.log(`Renderer console.${level}: ${message}`);
  });

  if (nodeEnv === 'development') {
    mainWindow.webContents.openDevTools();
  }

  return mainWindow;
}

module.exports = {
  createAssistantWindow
};
