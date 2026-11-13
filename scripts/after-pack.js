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

  // macOS remembers Screen Recording, Microphone and Keychain grants per code
  // signature. A certificate gives every build the same identity, so grants
  // survive rebuilds. Ad-hoc signatures have no stable identity: macOS may
  // treat each build as a new app and ask for permission again.
  const identity = resolveSigningIdentity();
  const signFlags = (identifier) => (identity
    ? ['--sign', identity, '--identifier', identifier]
    : ['--sign', '-', '--identifier', identifier, `-r=designated => identifier "${identifier}"`]);
  if (identity) {
    console.log(`[after-pack] Signing with identity "${identity}"`);
  } else {
    console.warn('[after-pack] WARNING: no code-signing identity found; signing ad hoc. macOS may re-ask for Screen Recording and Keychain access after every rebuild. Create a "Synapse Local Signing" code-signing certificate (see BUILD_INSTRUCTIONS.md) or set SYNAPSE_SIGN_IDENTITY.');
  }

  try {
    // 1. Sign embedded native helper binaries with stable identifier & requirement
    const nativeHelpers = [
      ['synapse-audio-capture', 'com.synapse.synapse-audio-capture'],
      ['synapse-ocr', 'com.synapse.synapse-ocr']
    ];
    for (const [name, identifier] of nativeHelpers) {
      const helperBinary = path.join(appPath, 'Contents', 'Resources', 'native', name);
      if (!fs.existsSync(helperBinary)) continue;
      execFileSync('codesign', [
        '--force',
        ...signFlags(identifier),
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
            ...signFlags(helperId)
          ];
          if (fs.existsSync(inheritEntitlementsPath)) {
            helperArgs.push('--entitlements', inheritEntitlementsPath);
          }
          helperArgs.push(fullEntryPath);
          execFileSync('codesign', helperArgs, { stdio: 'inherit' });
          console.log(`[after-pack] Signed helper: ${entry} with identifier "${helperId}"`);
        } else if (entry.endsWith('.framework') || entry.endsWith('.dylib')) {
          execFileSync('codesign', ['--force', '--sign', identity || '-', fullEntryPath], { stdio: 'inherit' });
        }
      }
    }

    // 3. Seal the top-level app bundle (without --deep to preserve nested helper identities)
    const signArgs = [
      '--force',
      ...signFlags(bundleId)
    ];

    if (fs.existsSync(entitlementsPath)) {
      signArgs.push('--entitlements', entitlementsPath);
    }
    signArgs.push(appPath);

    execFileSync('codesign', signArgs, { stdio: 'inherit' });
    console.log(`[after-pack] Signed ${appPath} as ${bundleId} (${identity ? `identity "${identity}"` : 'ad hoc'})`);
  } catch (error) {
    console.warn(`[after-pack] codesign failed (non-fatal, app still runs unsigned): ${error.message}`);
  }
};

const DEFAULT_LOCAL_IDENTITY = 'Synapse Local Signing';

/** SYNAPSE_SIGN_IDENTITY, else a "Synapse Local Signing" certificate in the login keychain, else null (ad hoc). */
function resolveSigningIdentity() {
  if (process.env.SYNAPSE_SIGN_IDENTITY) return process.env.SYNAPSE_SIGN_IDENTITY;
  try {
    const identities = execFileSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' });
    return identities.includes(`"${DEFAULT_LOCAL_IDENTITY}"`) ? DEFAULT_LOCAL_IDENTITY : null;
  } catch (_) {
    return null;
  }
}
