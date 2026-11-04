'use strict';

const { spawn } = require('child_process');
const electronBinary = require('electron');
const path = require('path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const testPath = path.join(__dirname, '..', 'tests', 'verify-pipeline-live.js');
const child = spawn(electronBinary, [testPath], { stdio: 'inherit', env });

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

