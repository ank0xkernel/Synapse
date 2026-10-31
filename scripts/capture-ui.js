#!/usr/bin/env node
'use strict';

// Launches the real app in screenshot-capture mode and waits for it to quit.
//
//   node scripts/capture-ui.js <out-dir> [scene,scene...] [WIDTHxHEIGHT]
//
// Scenes: home, answer, streaming, settings, onboarding, status, compact, error.

const { spawn } = require('child_process');
const path = require('path');
const electronBinary = require('electron');

const outDir = path.resolve(process.argv[2] || 'ui-captures');
const env = {
  ...process.env,
  SYNAPSE_UI_CAPTURE: outDir,
  SYNAPSE_UI_SCENES: process.argv[3] || '',
  SYNAPSE_UI_CAPTURE_SIZE: process.argv[4] || '900x560'
};
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
const interesting = /\[ui-capture\]|Uncaught|SyntaxError|TypeError|ReferenceError|did-fail-load|render-process-gone|recover|Renderer console.*(error|Error)/;
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (data) => {
    for (const line of String(data).split('\n')) {
      if (interesting.test(line)) console.log(line);
    }
  });
}
const timeout = setTimeout(() => child.kill('SIGKILL'), 180000);
child.on('exit', (code) => {
  clearTimeout(timeout);
  process.exit(code ?? 0);
});
