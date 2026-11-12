'use strict';

// Compiles the native macOS OCR helper (native/macos-ocr/SynapseOcr.swift)
// into a universal binary. Called by run-electron.js (only when the binary is
// missing or older than its source) and by run-build.js before packaging.
//
//   node scripts/build-native-ocr.js          build if stale
//   node scripts/build-native-ocr.js --force  always rebuild

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'native', 'macos-ocr', 'SynapseOcr.swift');
const OUTPUT_DIR = path.join(ROOT, 'native', 'macos-ocr', 'build');
const OUTPUT = path.join(OUTPUT_DIR, 'synapse-ocr');
// VNRecognizeTextRequest.automaticallyDetectsLanguage needs macOS 13.
const DEPLOYMENT_TARGET = '13.0';
const ARCHES = ['arm64', 'x86_64'];

function isStale() {
  if (!fs.existsSync(OUTPUT)) return true;
  return fs.statSync(SOURCE).mtimeMs > fs.statSync(OUTPUT).mtimeMs;
}

function hasSwiftc() {
  try {
    execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function buildNativeOcr({ force = false, log = console.log } = {}) {
  if (process.platform !== 'darwin') {
    log('[native-ocr] Skipped: not macOS');
    return { built: false, reason: 'not-macos' };
  }
  if (!force && !isStale()) {
    return { built: false, reason: 'up-to-date', path: OUTPUT };
  }
  if (!hasSwiftc()) {
    log('[native-ocr] Skipped: swiftc not found (install Xcode Command Line Tools)');
    return { built: false, reason: 'no-swiftc' };
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const slices = [];

  for (const arch of ARCHES) {
    const slice = path.join(OUTPUT_DIR, `synapse-ocr-${arch}`);
    log(`[native-ocr] Compiling ${arch} slice...`);
    execFileSync('xcrun', [
      'swiftc', '-O',
      '-swift-version', '5',
      '-target', `${arch}-apple-macos${DEPLOYMENT_TARGET}`,
      '-framework', 'Vision',
      '-framework', 'AppKit',
      '-framework', 'CoreGraphics',
      '-framework', 'CoreText',
      '-framework', 'ImageIO',
      '-o', slice,
      SOURCE
    ], { stdio: 'inherit' });
    slices.push(slice);
  }

  execFileSync('lipo', ['-create', '-output', OUTPUT, ...slices], { stdio: 'inherit' });
  for (const slice of slices) fs.rmSync(slice, { force: true });

  // Ad-hoc signature; after-pack.js deep-signs the packaged bundle.
  execFileSync('codesign', ['--force', '--sign', '-', OUTPUT], { stdio: 'inherit' });

  log(`[native-ocr] Built ${OUTPUT}`);
  return { built: true, path: OUTPUT };
}

module.exports = { buildNativeOcr, NATIVE_OCR_BINARY: OUTPUT };

if (require.main === module) {
  try {
    buildNativeOcr({ force: process.argv.includes('--force') });
  } catch (error) {
    console.error('[native-ocr] Build failed:', error.message);
    process.exit(1);
  }
}
