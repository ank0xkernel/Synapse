'use strict';

// Runs every tests/test-*.mjs file in its own Node process and fails if any
// file fails. Each suite exits non-zero on its own failures.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const testsDir = path.join(__dirname, '..', 'tests');
const files = fs.readdirSync(testsDir).filter((name) => /^test-.*\.mjs$/.test(name)).sort();
const failed = [];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--no-warnings', path.join(testsDir, file)], { stdio: 'inherit' });
  if (result.status !== 0) failed.push(file);
}

console.log(`\n${files.length - failed.length}/${files.length} test files passed.`);
if (failed.length) {
  console.log(`Failed: ${failed.join(', ')}`);
  process.exit(1);
}
