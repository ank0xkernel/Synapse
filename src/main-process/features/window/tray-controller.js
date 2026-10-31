'use strict';

const { app, Tray, Menu, nativeImage, clipboard, dialog } = require('electron');
const path = require('path');
const TotpAuth = require('../security/totp-auth');

class TrayController {
  constructor(options = {}) {
    this.tray = null;
    this.status = 'ready'; // ready (green) | warning (yellow) | error (red)
    this.mobileServer = options.mobileServer || null;
    this.watchdog = options.watchdog || null;
    // Must be the shared instance so the code shown here is the code the
    // login endpoint will accept.
    this.totp = TotpAuth.shared(app);
    this.onQuit = options.onQuit || null;
  }

  initialize() {
    // Menu-bar app: no Dock tile, no app switcher entry. The tray icon remains
    // the app's visible, clickable presence.
    if (process.platform === 'darwin' && app.dock) {
      app.dock.hide();
      if (typeof app.setActivationPolicy === 'function') {
        app.setActivationPolicy('accessory');
      }
      console.log('[TrayController] Running as a menu-bar (accessory) app.');
    }

    // process.cwd() is the launch directory, not the app directory — it does not
    // resolve inside a packaged build. Resolve relative to the app root instead.
    const assetsDir = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar', 'assets')
      : path.join(__dirname, '..', '..', '..', '..', 'assets');

    let trayIcon = nativeImage.createFromPath(path.join(assetsDir, 'tray-icon.png'));
    if (trayIcon.isEmpty()) {
      trayIcon = nativeImage.createFromPath(path.join(assetsDir, 'icon.png'));
    }

    if (trayIcon.isEmpty()) {
      console.warn('[TrayController] Tray icon asset missing; run `npm run icons`.');
      trayIcon = nativeImage.createEmpty();
    } else {
      trayIcon = trayIcon.resize({ width: 16, height: 16 });
      trayIcon.setTemplateImage(process.platform === 'darwin');
    }

    this.tray = new Tray(trayIcon);
    this.tray.setToolTip('Synapse — Interview Practice Coach');
    this.updateContextMenu();
  }

  setStatus(status) {
    this.status = status;
    this.updateContextMenu();
  }

  async runSystemDiagnostics() {
    console.log('[TrayController] Triggering manual system check...');
    if (this.watchdog) {
      await this.watchdog.performHealthCheck();
      const statusMsg = this.watchdog.isHealthy 
        ? '🟢 All monitored Synapse local services are operational.'
        : '🔴 System check notice: One or more local services experienced a fault. Recovery triggered.';
      
      dialog.showMessageBox({
        type: this.watchdog.isHealthy ? 'info' : 'warning',
        title: 'Synapse Diagnostics',
        message: statusMsg
      });
    } else {
      dialog.showMessageBox({
        type: 'info',
        title: 'Synapse Diagnostics',
        message: '🟢 System Watchdog initialized.'
      });
    }
  }

  updateContextMenu() {
    if (!this.tray) return;

    const totpToken = this.totp.generateToken();
    const serverStatus = this.mobileServer ? this.mobileServer.getStatus() : null;
    const clientCount = serverStatus ? serverStatus.clientCount : 0;
    const companionOn = !!(serverStatus && serverStatus.listening);

    let statusEmoji = '🟢';
    if (this.status === 'warning') statusEmoji = '🟡';
    if (this.status === 'error') statusEmoji = '🔴';

    const menuTemplate = [
      {
        label: `Synapse Platform: ${statusEmoji} ${this.status.toUpperCase()}`,
        enabled: false
      },
      {
        label: 'Phone Companion (HTTP on local Wi-Fi)',
        type: 'checkbox',
        checked: !!(serverStatus && serverStatus.enabled),
        enabled: !!this.mobileServer,
        click: async (item) => {
          // Off until the user turns it on here; turning it off drops every phone.
          await this.mobileServer.setEnabled(item.checked);
          this.updateContextMenu();
        }
      },
      {
        label: companionOn ? `Show Passcode: ${totpToken}` : 'Show Passcode (companion is off)',
        enabled: companionOn,
        click: () => {
          // Re-read at click time: the menu label may have been built a while
          // ago and the code rotates every 30 seconds.
          const currentToken = this.totp.generateToken();
          const secondsLeft = this.totp.secondsUntilRotation();
          const live = this.mobileServer.getStatus();
          // `urls` is ordered real-adapters-first, so the first entry is the
          // best guess at an address a phone can reach. URLs carry no secret.
          const url = Array.isArray(live.urls) && live.urls.length > 0 ? live.urls[0].url : null;

          clipboard.writeText(currentToken);
          dialog.showMessageBox({
            type: 'info',
            title: 'Synapse Passcode',
            message: `Passcode: ${currentToken}`,
            detail: [
              `Rotates in ${secondsLeft}s and works once. Copied to clipboard.`,
              url ? `\nOn your phone (same Wi-Fi), open:\n${url}` : '',
              '\n\nThis link is plain HTTP on your local network, not end-to-end encrypted.'
            ].join('')
          });
        }
      },
      {
        label: `Mobile Clients Connected: ${clientCount}`,
        enabled: false
      },
      { type: 'separator' },
      {
        label: '🔍 Run System Check',
        click: () => this.runSystemDiagnostics()
      },
      { type: 'separator' },
      {
        label: 'Quit Synapse',
        click: () => {
          if (typeof this.onQuit === 'function') {
            this.onQuit();
          } else {
            app.quit();
          }
        }
      }
    ];

    const contextMenu = Menu.buildFromTemplate(menuTemplate);
    this.tray.setContextMenu(contextMenu);
  }
}

module.exports = TrayController;
