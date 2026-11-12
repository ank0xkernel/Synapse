'use strict';

const { spawn } = require('child_process');
const electronBinary = require('electron');
const path = require('path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// First non-flag argument is the test file; flags (e.g. --screen) go to it.
const args = process.argv.slice(2);
const fileArg = args.find((arg) => !arg.startsWith('--'));
const testPath = path.resolve(fileArg || path.join(__dirname, '..', 'tests', 'verify-pipeline-live.js'));
const child = spawn(electronBinary, [testPath, ...args.filter((arg) => arg !== fileArg)], { stdio: 'inherit', env });

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('[run-live-screen-test] Failed to spawn Electron:', err.message);
  process.exit(1);
});

