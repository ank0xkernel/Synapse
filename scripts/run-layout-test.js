'use strict';

// Real-Electron layout regression test: opens the assistant window, runs the
// `layout` ui-capture scene (window sizes 600x380 to full screen, idle and busy
// title bar, every sheet, compact mode, 100/110/120 % zoom, keyboard order) plus
// the interaction and Mode C scenes, and exits non-zero on any overlapping,
// blocked, clipped, off-window or undersized control. Needs a display, so it is
// not part of `npm test`. Report and screenshots: printed output directory.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const outDir = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-layout-'));
const env = { ...process.env, SYNAPSE_UI_CAPTURE: outDir, SYNAPSE_UI_SCENES: 'layout,interactions,screen-intel' };
delete env.ELECTRON_RUN_AS_NODE;

const result = spawnSync(process.execPath, [path.join(__dirname, 'run-electron.js')], { env, encoding: 'utf8', timeout: 10 * 60 * 1000 });
const lines = `${result.stdout || ''}${result.stderr || ''}`.split('\n').filter((line) => line.includes('[ui-capture]') && !line.includes('wrote') && !line.includes(': ready'));
console.log(lines.join('\n'));
console.log(`Screenshots and layout-report.json: ${outDir}`);
const passed = result.status === 0 && lines.some((line) => /layout: (\d+)\/\1 checks clean/.test(line));
console.log(passed ? 'Layout test: PASSED' : `Layout test: FAILED (exit ${result.status ?? result.signal})`);
process.exit(passed ? 0 : 1);
