'use strict';

// electron-builder afterPack hook. Runs once per build, after the app bundle
// is assembled but before it's zipped/dmg'd. Two things it does not do for us
// automatically when there's no paid Apple Developer ID:
//
// 1. Deep ad-hoc sign the bundle. Without this, only the outer executable
//    ends up ad-hoc signed (macOS does that itself on first launch on Apple
//    Silicon) and the seal does not cover the app's resources, which is why
//    `spctl`/`codesign --verify` complain the code "has no resources but
//    signature indicates they must be present". A deep ad-hoc signature
//    (`codesign --deep --force -s -`) is not a real identity — it does not
//    satisfy Gatekeeper on a machine other than the one that built it — but
//    it does make the seal internally consistent, which is what matters for
//    running the app on the same Mac that built it without translocation/
//    signature-mismatch friction.
// 2. Lock down the bundled .env's permissions. It carries live API keys and
//    electron-builder's extraResources copy does not preserve or set a mode.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin' || os.platform() !== 'darwin') {
    return; // codesign only exists on macOS; nothing to do for other targets
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const envPath = path.join(appPath, 'Contents', 'Resources', '.env');

  try {
    if (fs.existsSync(envPath)) {
      fs.chmodSync(envPath, 0o600);
      console.log(`[after-pack] Locked down permissions on ${envPath}`);
    }
  } catch (error) {
    console.warn(`[after-pack] Could not chmod .env (non-fatal): ${error.message}`);
  }

  try {
    execFileSync('codesign', ['--deep', '--force', '--sign', '-', appPath], { stdio: 'inherit' });
    console.log(`[after-pack] Ad-hoc signed ${appPath}`);
  } catch (error) {
    console.warn(`[after-pack] codesign failed (non-fatal, app still runs unsigned): ${error.message}`);
  }
};
