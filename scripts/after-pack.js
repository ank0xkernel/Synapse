'use strict';

// electron-builder afterPack hook. Runs once per build, after the app bundle
// is assembled but before it's zipped/dmg'd. Without a paid Apple Developer
// ID, electron-builder does not deep-sign the bundle, so this does an ad-hoc
// deep sign. Otherwise only the outer executable ends up ad-hoc signed (macOS
// does that itself on first launch on Apple Silicon) and the seal does not
// cover the app's resources, which is why `spctl`/`codesign --verify` complain
// the code "has no resources but signature indicates they must be present".
// A deep ad-hoc signature (`codesign --deep --force -s -`) is not a real
// identity: it does not satisfy Gatekeeper on another Mac, but it makes the
// seal internally consistent so the app runs on the Mac that built it without
// translocation or signature-mismatch friction.
//
// No .env is bundled: API keys are entered in Settings and stored per user,
// so a packaged build never carries the developer's local secrets.
const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin' || os.platform() !== 'darwin') {
    return; // codesign only exists on macOS; nothing to do for other targets
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  try {
    execFileSync('codesign', ['--deep', '--force', '--sign', '-', appPath], { stdio: 'inherit' });
    console.log(`[after-pack] Ad-hoc signed ${appPath}`);
  } catch (error) {
    console.warn(`[after-pack] codesign failed (non-fatal, app still runs unsigned): ${error.message}`);
  }
};
