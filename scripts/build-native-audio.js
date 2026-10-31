'use strict';

// Compiles the native macOS system-audio capture helper
// (native/macos-audio-capture/SynapseAudioCapture.swift) into a universal
// binary. Called by run-electron.js (only when the binary is missing or older
// than its source) and by run-build.js before packaging.
//
//   node scripts/build-native-audio.js          build if stale
//   node scripts/build-native-audio.js --force  always rebuild

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'native', 'macos-audio-capture', 'SynapseAudioCapture.swift');
const OUTPUT_DIR = path.join(ROOT, 'native', 'macos-audio-capture', 'build');
const OUTPUT = path.join(OUTPUT_DIR, 'synapse-audio-capture');
// ScreenCaptureKit audio is the oldest backend the helper supports.
const DEPLOYMENT_TARGET = '13.0';
const ARCHES = ['arm64', 'x86_64'];

function isStale() {
  if (!fs.existsSync(OUTPUT)) return true;
  return fs.statSync(SOURCE).mtimeMs > fs.statSync(OUTPUT).mtimeMs;
}

function buildNativeAudio({ force = false, log = console.log } = {}) {
  if (process.platform !== 'darwin') {
    return { built: false, reason: 'not-macos' };
  }
  if (!force && !isStale()) {
    return { built: false, reason: 'up-to-date', path: OUTPUT };
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const slices = [];

  for (const arch of ARCHES) {
    const slice = path.join(OUTPUT_DIR, `synapse-audio-capture-${arch}`);
    log(`[native-audio] Compiling ${arch} slice...`);
    execFileSync('xcrun', [
      'swiftc', '-O',
      '-swift-version', '5',
      '-target', `${arch}-apple-macos${DEPLOYMENT_TARGET}`,
      '-o', slice,
      SOURCE
    ], { stdio: 'inherit' });
    slices.push(slice);
  }

  execFileSync('lipo', ['-create', '-output', OUTPUT, ...slices], { stdio: 'inherit' });
  for (const slice of slices) fs.rmSync(slice, { force: true });

  // Ad-hoc signature so the binary runs under hardened-runtime hosts in
  // development. electron-builder re-signs it with the real identity when
  // packaging.
  execFileSync('codesign', ['--force', '--sign', '-', OUTPUT], { stdio: 'inherit' });

  log(`[native-audio] Built ${OUTPUT}`);
  return { built: true, path: OUTPUT };
}

module.exports = { buildNativeAudio, NATIVE_AUDIO_BINARY: OUTPUT };

if (require.main === module) {
  try {
    buildNativeAudio({ force: process.argv.includes('--force') });
  } catch (error) {
    console.error('[native-audio] Build failed:', error.message);
    process.exit(1);
  }
}
