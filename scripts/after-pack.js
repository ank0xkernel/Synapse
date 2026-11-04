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
const fs = require('fs');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin' || os.platform() !== 'darwin') {
    return; // codesign only exists on macOS; nothing to do for other targets
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const bundleId = context.packager.appInfo.id || 'com.synapse.interviewcoach';
  const rootDir = path.join(__dirname, '..');
  const entitlementsPath = path.join(rootDir, 'assets', 'entitlements.mac.plist');
  const inheritEntitlementsPath = path.join(rootDir, 'assets', 'entitlements.mac.inherit.plist');

  try {
    // 1. Sign embedded native helper binaries with stable identifier & requirement
    const helperBinary = path.join(appPath, 'Contents', 'Resources', 'native', 'synapse-audio-capture');
    if (fs.existsSync(helperBinary)) {
      execFileSync('codesign', [
        '--force',
        '--sign', '-',
        '--identifier', 'com.synapse.synapse-audio-capture',
        '-r=designated => identifier "com.synapse.synapse-audio-capture"',
        helperBinary
      ], { stdio: 'inherit' });
      console.log(`[after-pack] Signed native helper: ${helperBinary}`);
    }

    // 2. Sign frameworks and nested helpers inside Contents/Frameworks
    const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');
    if (fs.existsSync(frameworksDir)) {
      const entries = fs.readdirSync(frameworksDir);
      for (const entry of entries) {
        const fullEntryPath = path.join(frameworksDir, entry);
        if (entry.endsWith('.app')) {
          let helperId = `${bundleId}.helper`;
          const helperPlist = path.join(fullEntryPath, 'Contents', 'Info.plist');
          if (fs.existsSync(helperPlist)) {
            try {
              const readId = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', helperPlist], { encoding: 'utf8' }).trim();
              if (readId) helperId = readId;
            } catch (_) {}
          }
          const helperArgs = [
            '--force',
            '--sign', '-',
            '--identifier', helperId,
            `-r=designated => identifier "${helperId}"`
          ];
          if (fs.existsSync(inheritEntitlementsPath)) {
            helperArgs.push('--entitlements', inheritEntitlementsPath);
          }
          helperArgs.push(fullEntryPath);
          execFileSync('codesign', helperArgs, { stdio: 'inherit' });
          console.log(`[after-pack] Signed helper: ${entry} with identifier "${helperId}"`);
        } else if (entry.endsWith('.framework') || entry.endsWith('.dylib')) {
          execFileSync('codesign', ['--force', '--sign', '-', fullEntryPath], { stdio: 'inherit' });
        }
      }
    }

    // 3. Seal the top-level app bundle (without --deep to preserve nested helper identities)
    const signArgs = [
      '--force',
      '--sign', '-',
      '--identifier', bundleId,
      `-r=designated => identifier "${bundleId}"`
    ];

    if (fs.existsSync(entitlementsPath)) {
      signArgs.push('--entitlements', entitlementsPath);
    }
    signArgs.push(appPath);

    execFileSync('codesign', signArgs, { stdio: 'inherit' });
    console.log(`[after-pack] Stable ad-hoc signed ${appPath} with requirement: designated => identifier "${bundleId}"`);
  } catch (error) {
    console.warn(`[after-pack] codesign failed (non-fatal, app still runs unsigned): ${error.message}`);
  }
};
