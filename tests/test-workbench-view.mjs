#!/usr/bin/env node
/** Workbench view-model. Run: node tests/test-workbench-view.mjs */
import assert from 'node:assert/strict';
import {
  STATUS_LABELS, actionControls, canStart, classifyDiff, describeSuggestion, diffLineClass, firstChangedLine, groupEvidence, statusLabel
} from '../src/windows/assistant/renderer/features/workbench/workbench-view.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message.split('\n').join('\n      ')}`);
  }
}

const STATUSES = ['suggested', 'pending_approval', 'approved', 'rejected', 'running', 'executed', 'verified', 'failed', 'cancelled'];

test('every action status has its own label', () => {
  const labels = STATUSES.map(statusLabel);
  assert.equal(new Set(labels).size, STATUSES.length);
  assert.equal(statusLabel('executed'), 'Ran');
  assert.equal(statusLabel('verified'), 'Verified');
  assert.equal(Object.keys(STATUS_LABELS).length, STATUSES.length);
  assert.equal(statusLabel('bogus'), 'Unknown status');
});

test('evidence groups by kind in display order, unknown kinds fall to Unknown, empty groups dropped', () => {
  const groups = groupEvidence([
    { kind: 'inference', label: 'a' }, { kind: 'screen', label: 'b' }, { kind: 'weird', label: 'c' }, { kind: 'screen', label: 'd' }
  ]);
  assert.deepEqual(groups.map((g) => g.label), ['Seen on screen', 'Model reasoning (unverified)', 'Unknown']);
  assert.deepEqual(groups[0].items.map((i) => i.label), ['b', 'd']);
  assert.deepEqual(groupEvidence(undefined), []);
});

test('first changed line from the first hunk', () => {
  assert.equal(firstChangedLine('--- a/x\n+++ b/x\n@@ -10,3 +12,4 @@\n ctx\n+add\n@@ -40 +43 @@\n'), 12);
  assert.equal(firstChangedLine('--- /dev/null\n+++ b/new.js\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n'), 1);
  assert.equal(firstChangedLine('--- a/x\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-a\n'), 1);
  assert.equal(firstChangedLine('no hunks here'), null);
  assert.equal(firstChangedLine(''), null);
});

test('diff line classes, including no-newline marker', () => {
  assert.equal(diffLineClass('+added'), 'add');
  assert.equal(diffLineClass('-removed'), 'del');
  assert.equal(diffLineClass('+++ b/x'), 'meta');
  assert.equal(diffLineClass('--- a/x'), 'meta');
  assert.equal(diffLineClass('@@ -1 +1 @@'), 'hunk');
  assert.equal(diffLineClass('\\ No newline at end of file'), 'note');
  assert.equal(diffLineClass(' context'), 'ctx');
  assert.deepEqual(classifyDiff('@@ -1 +1 @@\n-a\n+b\n').map((l) => l.kind), ['hunk', 'del', 'add']);
});

test('Start needs a project, a non-empty request and no run in flight', () => {
  assert.equal(canStart({ activeProjectId: 'p', request: 'fix it', busy: false }), true);
  assert.equal(canStart({ activeProjectId: null, request: 'fix it', busy: false }), false);
  assert.equal(canStart({ activeProjectId: 'p', request: '   ', busy: false }), false);
  assert.equal(canStart({ activeProjectId: 'p', request: 'x', busy: true }), false);
});

test('invalid edits cannot be approved; pending commands can', () => {
  assert.equal(actionControls({ type: 'edit', status: 'pending_approval', valid: false, path: 'a' }).approve, false);
  assert.equal(actionControls({ type: 'edit', status: 'pending_approval', valid: true, path: 'a' }).approve, true);
  assert.equal(actionControls({ type: 'command', status: 'executed' }).approve, false);
});

test('suggestion model: high, low, none (screen available or not), error', () => {
  const projects = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }];
  const high = describeSuggestion({ success: true, suggestion: { projectId: 'a', confidence: 'high', candidates: [{ projectId: 'a', score: 9, evidence: ['x'] }] }, screenAvailable: true }, projects);
  assert.equal(high.kind, 'high');
  assert.equal(high.text, 'Looks like Alpha');
  assert.equal(high.options.length, 1);
  const low = describeSuggestion({ success: true, suggestion: { projectId: null, confidence: 'low', candidates: [{ projectId: 'a', score: 2, evidence: [] }, { projectId: 'b', score: 1, evidence: [] }] }, screenAvailable: true }, projects);
  assert.equal(low.kind, 'low');
  assert.deepEqual(low.options.map((o) => o.name), ['Alpha', 'Beta']);
  const none = describeSuggestion({ success: true, suggestion: { projectId: null, confidence: 'none', candidates: [] }, screenAvailable: true }, projects);
  assert.equal(none.kind, 'none');
  assert.match(none.text, /No registered project matches/);
  assert.match(describeSuggestion({ success: true, suggestion: { projectId: null, confidence: 'none', candidates: [] }, screenAvailable: false }, projects).text, /No screen content/);
  assert.equal(describeSuggestion({ success: false, error: 'boom' }, projects).kind, 'error');
});

console.log(`\nWorkbench view tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed ? 1 : 0);
