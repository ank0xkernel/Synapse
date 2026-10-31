'use strict';

// Build launcher. electron-builder spawns helpers that misbehave when
// ELECTRON_RUN_AS_NODE is inherited from the shell, so we strip it here too.
// Detects the current platform and picks a sensible default target.

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const platformArgs = (() => {
  switch (os.platform()) {
    case 'win32':  return ['--win', 'portable'];
    case 'darwin': return ['--mac'];
    case 'linux':  return ['--linux'];
    default:       return [];
  }
})();

const args = [...platformArgs, ...process.argv.slice(2)];

// The packaged app ships the native system-audio helper as an extra resource,
// so it must exist (and be current) before electron-builder runs.
if (os.platform() === 'darwin') {
  const { buildNativeAudio } = require('./build-native-audio');
  try {
    buildNativeAudio({ force: true });
  } catch (error) {
    console.error('[run-build] Native audio helper build failed:', error.message);
    process.exit(1);
  }
}

// Invoke electron-builder via Node directly to avoid spawning the .cmd
// shim on Windows (which needs shell:true and triggers a deprecation
// warning). The CLI module path is stable across versions.
const builderCli = require.resolve('electron-builder/out/cli/cli.js');
const child = spawn(process.execPath, [builderCli, ...args], {
  stdio: 'inherit',
  env
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('[run-build] Failed to spawn electron-builder:', err.message);
  process.exit(1);
});
