/**
 * Workbench end to end on real fixture projects: screen text -> task ->
 * project index -> retrieved files -> plan -> approval -> real file writes and
 * real commands -> answer. Only the model is scripted (deterministic replies
 * keyed on the prompt); everything else is the production code on disk.
 *
 * Run: node tests/test-workbench-e2e.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createRunManager } = require('../src/services/workbench/run-manager.js');
const { createProjectStore } = require('../src/services/workbench/project-store.js');
const { scanProject } = require('../src/services/workbench/project-scanner.js');
const { createCodeIndex } = require('../src/services/workbench/code-index.js');
const { createFileOps } = require('../src/services/workbench/file-ops.js');
const { runCommand, classifyCommand } = require('../src/services/workbench/command-runner.js');
const { resolveInside } = require('../src/services/workbench/path-guard.js');
const { createActionLog } = require('../src/services/workbench/action-log.js');
const { matchProject } = require('../src/services/workbench/project-match.js');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (error) { failed += 1; console.log(`  ✗ ${name}\n      ${String(error.stack || error).split('\n').slice(0, 4).join('\n      ')}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(20); }
  throw new Error(`timed out waiting for ${label}`);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-wb-e2e-'));
function write(root, rel, text) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); }

// A small JavaScript project whose test fails until sum() is fixed.
function makeCalcProject(name) {
  const root = path.join(base, name);
  write(root, 'package.json', JSON.stringify({ name: 'calc-lib', version: '1.0.0', scripts: { test: 'node test/run.js' } }, null, 2));
  write(root, 'src/math.js', "'use strict';\n\nfunction sum(values) {\n  let total = 1;\n  for (const v of values) total += v;\n  return total;\n}\n\nfunction mean(values) {\n  return values.length ? sum(values) / values.length : 0;\n}\n\nmodule.exports = { sum, mean };\n");
  write(root, 'src/format.js', "'use strict';\n\nconst { mean } = require('./math');\n\nfunction report(values) {\n  return `mean=${mean(values)}`;\n}\n\nmodule.exports = { report };\n");
  write(root, 'test/run.js', "'use strict';\nconst assert = require('assert');\nconst { sum } = require('../src/math');\nassert.strictEqual(sum([1, 2, 3]), 6);\nconsole.log('all tests passed');\n");
  return root;
}

const SCREEN = 'calc-lib — math.js — Visual Studio Code\nBug report: sum([1, 2, 3]) returns 7 instead of 6. Fix sum in src/math.js so the tests pass.';
const FIX = { path: 'src/math.js', kind: 'replace', search: '  let total = 1;', replace: '  let total = 0;', reason: 'The accumulator must start at zero.', symbols: ['sum'] };

/** Scripted model: picks a reply by the stage its prompt belongs to, records every prompt. */
function scriptedModel(script) {
  const prompts = [];
  const fn = async (prompt, opts = {}) => {
    const stage = prompt.includes('structured task description') ? 'understand' : prompt.includes('You plan a change') ? 'plan' : 'answer';
    prompts.push({ stage, prompt });
    const reply = script[stage];
    if (typeof reply === 'function') return reply(prompt, opts, prompts);
    return reply;
  };
  fn.prompts = prompts;
  return fn;
}

const DEBUG_TASK = JSON.stringify({ kind: 'debugging', title: 'sum is off by one', statement: 'sum([1,2,3]) returns 7 instead of 6; fix sum in src/math.js so the tests pass.', requirements: ['sum returns the total of the values'], constraints: [], examples: ['sum([1,2,3]) -> 6'], language: 'JavaScript', needsProject: true, missing: [], subtasks: [], evidence: 'screen' });
const planWith = (edits, commands) => `\`\`\`json\n${JSON.stringify({ summary: 'Start the accumulator at zero.', approach: 'One-line fix in sum(); O(n).', files: [{ path: 'src/math.js', reason: 'defines sum', symbols: ['sum'] }], edits, commands, validation: ['npm test exits 0'], uncertainties: [] })}\n\`\`\``;

function rig(root, model, { persistPath = null, screenText = SCREEN } = {}) {
  const dir = fs.mkdtempSync(path.join(base, 'state-'));
  const projectStore = createProjectStore({ filePath: path.join(dir, 'projects.json'), log: () => {} });
  if (root) projectStore.setActive(projectStore.add(root).id);
  const actionLog = createActionLog({ filePath: path.join(dir, 'actions.jsonl') });
  const tools = new Map();
  const getProjectTools = async (project) => {
    if (!tools.has(project.id)) {
      tools.set(project.id, (async () => {
        const scan = await scanProject(project.root);
        const index = createCodeIndex(project.root, { log: () => {} });
        const built = await index.build({});
        return { scan, index, fileOps: createFileOps({ root: project.root, backupDir: path.join(dir, 'backups'), log: () => {} }), stats: { files: index.files().length, symbols: built.symbols ?? 0 } };
      })());
    }
    return tools.get(project.id);
  };
  const events = [];
  const manager = createRunManager({
    callModel: model, getScreenText: async () => ({ text: screenText, available: Boolean(screenText) }), projectStore, getProjectTools,
    runCommand, classifyCommand, resolveInside, actionLog, persistPath, emit: (run) => events.push(run), log: () => {}
  });
  return { manager, actionLog, projectStore, events, dir, getProjectTools };
}

const stageOf = (r, id) => r.manager.getRun(id).stage;

console.log('=== WORKBENCH END TO END ===\n');

await test('screen bug report -> plan -> approved edit -> approved test run: file fixed on disk, test verified, answer reflects real results', async () => {
  const root = makeCalcProject('calc-a');
  const model = scriptedModel({ understand: DEBUG_TASK, plan: planWith([FIX], [{ command: 'npm test', cwd: '.', purpose: 'Run the project tests', kind: 'validation' }]), answer: 'Fixed `src/math.js`; `npm test` passed.' });
  const r = rig(root, model);
  const runId = await r.manager.startTask({ request: 'fix this', useScreen: true });
  await until(() => stageOf(r, runId) === 'awaiting_approval' || stageOf(r, runId) === 'failed', 'approval');
  let run = r.manager.getRun(runId);
  assert.equal(run.stage, 'awaiting_approval', JSON.stringify(run.error));
  assert.equal(run.task.kind, 'debugging');
  assert.ok(run.evidence.some((e) => e.kind === 'screen'));
  assert.ok(run.evidence.some((e) => e.kind === 'filesystem' && e.label === 'src/math.js'), 'the file named on screen was read from disk');
  const planPrompt = model.prompts.find((p) => p.stage === 'plan').prompt;
  assert.match(planPrompt, /FILE src\/math\.js/);
  assert.match(planPrompt, /let total = 1;/, 'the plan prompt carries the real file content');
  const [edit, cmd] = run.actions;
  assert.equal(edit.status, 'pending_approval');
  assert.match(edit.diff, /^-  let total = 1;$/m);
  assert.match(edit.diff, /^\+  let total = 0;$/m);
  assert.ok(cmd.risks.includes('test'));
  assert.match(fs.readFileSync(path.join(root, 'src/math.js'), 'utf8'), /total = 1/, 'nothing written before approval');

  const early = await r.manager.approve(runId, cmd.id);
  assert.equal(early.code, 'EDITS_PENDING', 'a validation command cannot run before the edits are decided');
  assert.equal((await r.manager.approve(runId, edit.id)).status, 'executed');
  assert.match(fs.readFileSync(path.join(root, 'src/math.js'), 'utf8'), /let total = 0;/);
  assert.equal((await r.manager.approve(runId, cmd.id)).status, 'verified');
  await until(() => stageOf(r, runId) === 'done', 'done');
  run = r.manager.getRun(runId);
  assert.equal(run.answerStatus, 'verified');
  assert.equal(run.actions[1].result.exitCode, 0);
  assert.match(run.actions[1].result.stdout, /all tests passed/);
  const answerPrompt = model.prompts.find((p) => p.stage === 'answer').prompt;
  assert.match(answerPrompt, /edit src\/math\.js \(replace\): executed/);
  assert.match(answerPrompt, /npm test` in \.: verified, exit 0/);
  const log = r.actionLog.list({ limit: 50, runId });
  for (const s of ['approved', 'executed', 'verified']) assert.ok(log.some((e) => e.status === s), `audit log has ${s}`);
});

await test('rejected edit -> the test really fails -> Fix failures plans again with the real failure output', async () => {
  const root = makeCalcProject('calc-b');
  const model = scriptedModel({ understand: DEBUG_TASK, plan: planWith([FIX], [{ command: 'npm test', cwd: '.', purpose: 'tests', kind: 'validation' }]), answer: 'Tests still fail.' });
  const r = rig(root, model);
  const runId = await r.manager.startTask({ request: 'fix this' });
  await until(() => stageOf(r, runId) === 'awaiting_approval', 'approval');
  const [edit, cmd] = r.manager.getRun(runId).actions;
  r.manager.reject(runId, edit.id);
  assert.equal((await r.manager.approve(runId, cmd.id)).status, 'failed');
  await until(() => stageOf(r, runId) === 'done', 'done');
  const run = r.manager.getRun(runId);
  assert.equal(run.answerStatus, 'failed');
  assert.notEqual(run.actions[1].result.exitCode, 0);
  assert.match(run.actions[1].result.stderr, /AssertionError|Expected values/);
  const fix = await r.manager.fixFailures(runId);
  assert.equal(fix.success, true);
  await until(() => ['awaiting_approval', 'failed'].includes(stageOf(r, fix.runId)), 'second plan');
  const second = model.prompts.filter((p) => p.stage === 'plan')[1].prompt;
  assert.match(second, /PREVIOUS ATTEMPT FAILED/);
  assert.match(second, /AssertionError|Expected values/, 'the real failure output reaches the planner');
});

await test('plans that do not match the disk are shown but cannot be approved: missing anchor, path outside the project, cwd outside', async () => {
  const root = makeCalcProject('calc-c');
  const model = scriptedModel({
    understand: DEBUG_TASK,
    plan: planWith([{ ...FIX, search: 'let total = 42;' }, { path: '../escape.js', kind: 'create', content: 'x', reason: 'bad' }], [{ command: 'ls', cwd: '../..', purpose: 'bad cwd', kind: 'other' }]),
    answer: 'Nothing could be applied.'
  });
  const r = rig(root, model);
  const runId = await r.manager.startTask({ request: 'fix' });
  await until(() => stageOf(r, runId) === 'done', 'done');
  const run = r.manager.getRun(runId);
  assert.deepEqual(run.actions.map((a) => [a.valid, a.status]), [[false, 'suggested'], [false, 'suggested'], [false, 'suggested']]);
  assert.match(run.actions[0].invalidReason, /not found|ANCHOR/i);
  assert.ok(run.actions[2].risks.includes('outside_project'));
  assert.equal((await r.manager.approve(runId, run.actions[0].id)).code, 'NOT_PENDING');
  assert.equal(run.answerStatus, 'suggested');
  assert.ok(!fs.existsSync(path.join(base, 'escape.js')));
});

await test('a general question is answered without touching the project', async () => {
  const model = scriptedModel({ understand: JSON.stringify({ kind: 'question', title: 'Big-O', statement: 'What is the time complexity of binary search?', needsProject: false, evidence: 'user' }), answer: 'O(log n).' });
  const r = rig(makeCalcProject('calc-d'), model);
  const runId = await r.manager.startTask({ request: 'What is the time complexity of binary search?', useScreen: false });
  await until(() => stageOf(r, runId) === 'done', 'done');
  const run = r.manager.getRun(runId);
  assert.equal(run.actions.length, 0);
  assert.equal(run.answer, 'O(log n).');
  assert.equal(run.answerStatus, 'suggested');
  assert.ok(!model.prompts.some((p) => p.stage === 'plan'));
});

await test('invalid model JSON twice fails the run with a clear contract error; nothing is proposed', async () => {
  const model = scriptedModel({ understand: 'Sure! Here is my analysis without JSON.' });
  const r = rig(makeCalcProject('calc-e'), model);
  const runId = await r.manager.startTask({ request: 'fix' });
  await until(() => stageOf(r, runId) === 'failed', 'failed');
  assert.equal(r.manager.getRun(runId).error.code, 'CONTRACT_INVALID');
  assert.equal(model.prompts.length, 2, 'one retry, then stop');
});

await test('cancel while the model is planning: run cancelled, the late reply is dropped, nothing proposed', async () => {
  let release;
  const model = scriptedModel({ understand: DEBUG_TASK, plan: (p, opts) => new Promise((resolve) => { release = () => resolve(planWith([FIX], [])); }) });
  const r = rig(makeCalcProject('calc-f'), model);
  const runId = await r.manager.startTask({ request: 'fix' });
  await until(() => stageOf(r, runId) === 'planning' && release, 'planning');
  r.manager.cancel(runId);
  release();
  await sleep(100);
  const run = r.manager.getRun(runId);
  assert.equal(run.stage, 'cancelled');
  assert.equal(run.actions.length, 0);
});

await test('restart: pending approvals survive, the file changed meanwhile is refused instead of overwritten', async () => {
  const root = makeCalcProject('calc-g');
  const persistPath = path.join(base, 'runs-restart.json');
  const model = scriptedModel({ understand: DEBUG_TASK, plan: planWith([FIX], []), answer: 'done' });
  const first = rig(root, model, { persistPath });
  const runId = await first.manager.startTask({ request: 'fix' });
  await until(() => stageOf(first, runId) === 'awaiting_approval', 'approval');
  first.manager.persist();
  fs.writeFileSync(path.join(root, 'src/math.js'), fs.readFileSync(path.join(root, 'src/math.js'), 'utf8').replace('mean', 'average'));
  const second = rig(root, model, { persistPath });
  // The second rig registered the same folder into a fresh store; point the restored run at it.
  assert.equal(second.manager.restore(), 1);
  const restored = second.manager.getRun(runId);
  assert.equal(restored.stage, 'awaiting_approval');
  const result = await second.manager.approve(runId, restored.actions[0].id);
  assert.equal(result.status, 'failed');
  assert.equal(second.manager.getRun(runId).actions[0].result.error.code, 'FILE_CHANGED');
  assert.match(fs.readFileSync(path.join(root, 'src/math.js'), 'utf8'), /let total = 1;/, 'the edited file was not overwritten');
});

await test('project suggestion from an editor window title picks the registered project; an unknown folder is never picked', () => {
  const projects = [{ id: 'prj_a', name: 'calc-lib', root: path.join(base, 'calc-a') }, { id: 'prj_b', name: 'other', root: path.join(base, 'other') }];
  const hit = matchProject(`math.js — ${path.join(base, 'calc-a')}/src — Visual Studio Code`, projects);
  assert.equal(hit.projectId, 'prj_a');
  assert.equal(hit.confidence, 'high');
  assert.equal(matchProject('notes — /Users/someone/unregistered — Visual Studio Code', projects).projectId, null);
});

console.log(`\nWorkbench end-to-end tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
fs.rmSync(base, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
