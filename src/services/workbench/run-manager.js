'use strict';

// One workbench run: understand -> (project) index -> retrieve -> plan ->
// per-action approval -> execute -> answer. Owns run state, the approval
// gate, cancellation, the audit trail and persistence across restarts.
// Nothing is written or run except through approve().

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const engine = require('./task-engine');

const KEEP_RUNS = 20;

function createRunManager({
  callModel, cancelModel = () => {}, getScreenText, projectStore, getProjectTools,
  runCommand, classifyCommand, resolveInside, actionLog, emit = () => {}, persistPath = null,
  now = Date.now, log = console.warn
}) {
  const runs = new Map();
  const controllers = new Map();
  let saveTimer = null;

  const id = () => `run_${now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const record = (run, entry) => {
    try { actionLog.record({ runId: run.id, projectId: run.projectId, ...entry }); } catch (error) { log(`[Workbench] audit log write failed: ${error.message}`); }
  };

  /** What the window sees: everything except prepared file contents. */
  function snapshot(run) {
    const { screenText, ...rest } = run;
    return { ...rest, actions: run.actions.map(({ _prepared: p, _cmd, ...a }) => a) };
  }

  function changed(run) {
    emit(snapshot(run));
    if (!persistPath || saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 300);
  }

  function persist() {
    if (!persistPath) return;
    // Screen text stays in memory, like every other screen capture.
    const list = Array.from(runs.values()).sort((a, b) => b.createdAt - a.createdAt).slice(0, KEEP_RUNS)
      .map(({ screenText, ...run }) => run);
    const tmp = `${persistPath}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, runs: list }), { mode: 0o600 });
      fs.renameSync(tmp, persistPath);
    } catch (error) {
      log(`[Workbench] could not save runs: ${error.message}`);
      try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean */ }
    }
  }

  /**
   * Restores saved runs. Work that was in flight when the app stopped is
   * reported as interrupted; approvals still pending stay pending (apply
   * re-checks each file, so a file changed meanwhile is refused).
   */
  function restore() {
    if (!persistPath || !fs.existsSync(persistPath)) return 0;
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
    } catch (error) {
      const aside = `${persistPath}.corrupt-${now()}`;
      try { fs.renameSync(persistPath, aside); } catch (_) { /* keep going */ }
      log(`[Workbench] saved runs unreadable (${error.message}); moved to ${aside}`);
      return 0;
    }
    for (const run of (saved && Array.isArray(saved.runs) ? saved.runs : [])) {
      for (const a of run.actions || []) {
        if (a.status === 'running' || a.status === 'approved') {
          a.status = 'failed';
          a.result = { error: { code: 'INTERRUPTED', message: 'Synapse stopped while this was running. Check the file or rerun the command.' } };
        }
      }
      if (!['done', 'failed', 'cancelled'].includes(run.stage)) {
        if (run.actions.some((a) => a.status === 'pending_approval')) {
          run.stage = 'awaiting_approval';
          run.stageDetail = 'Restored after restart. Pending actions are re-checked before they run.';
        } else {
          run.stage = 'failed';
          run.error = { code: 'INTERRUPTED', message: 'Synapse stopped during this run.' };
        }
      }
      runs.set(run.id, run);
    }
    return runs.size;
  }

  function setStage(run, stage, detail = '') {
    run.stage = stage;
    run.stageDetail = detail;
    changed(run);
  }

  function fail(run, error) {
    if (run.stage === 'cancelled') return;
    run.stage = 'failed';
    run.error = { code: error.code || 'FAILED', message: error.message || String(error) };
    for (const a of run.actions) if (a.status === 'pending_approval') a.status = 'cancelled';
    record(run, { type: 'run', status: 'failed', summary: run.error.message });
    changed(run);
  }

  const throwIfCancelled = (run) => {
    if (run.stage === 'cancelled') throw Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' });
  };

  async function startTask({ request = '', useScreen = true, parentRunId = null, failures = null } = {}) {
    const project = projectStore.getActive();
    const run = {
      id: id(), parentRunId, projectId: project ? project.id : null, projectName: project ? project.name : null,
      projectRoot: project ? project.root : null, request: String(request).slice(0, 8000), createdAt: now(),
      stage: 'understanding', stageDetail: '', error: null, task: null, plan: null, evidence: [], actions: [], answer: '', answerStatus: 'none'
    };
    runs.set(run.id, run);
    const controller = new AbortController();
    controllers.set(run.id, controller);
    record(run, { type: 'run', status: 'started', summary: run.request.slice(0, 200) });
    changed(run);
    execute(run, { useScreen, failures, signal: controller.signal, project }).catch((error) => fail(run, error));
    return run.id;
  }

  async function execute(run, { useScreen, failures, signal, project }) {
    const tag = `workbench:${run.id}`;
    const ask = (prompt, opts) => callModel(prompt, { ...opts, tag, signal });
    const screen = useScreen ? await getScreenText() : { text: '', available: false };
    run.screenText = screen.text ? screen.text.slice(0, 24000) : '';
    run.evidence.push(screen.text
      ? { kind: 'screen', label: 'Screen text', detail: `${screen.text.length} characters read by screen monitoring` }
      : { kind: 'unknown', label: 'Screen', detail: useScreen ? 'No screen text available (monitoring is not running or has read nothing).' : 'Not used for this task.' });
    run.task = await engine.understandTask({ callModel: ask, request: run.request, screenText: run.screenText, projectName: run.projectName, signal });
    throwIfCancelled(run);
    if (!run.task.needsProject) return finish(run, ask);
    if (!project) throw Object.assign(new Error('This task needs its project folder. Press "Suggest from screen" to find the project open on screen, or "Add project" to pick it, then start again.'), { code: 'NO_PROJECT' });

    setStage(run, 'indexing', `Analysing ${project.name}`);
    const tools = await getProjectTools(project, { signal });
    throwIfCancelled(run);
    run.evidence.push({ kind: 'repository', label: 'Project analysis', detail: `${tools.stats.files} files indexed, ${tools.stats.symbols} symbols; languages: ${(tools.scan.languages || []).map((l) => l.name).join(', ') || 'unknown'}` });

    setStage(run, 'retrieving', 'Finding the relevant files');
    const gathered = await engine.gatherEvidence({ index: tools.index, fileOps: tools.fileOps, task: run.task, request: run.request, screenText: run.screenText });
    run.evidence.push(...gathered.evidence);
    throwIfCancelled(run);

    setStage(run, 'planning', `Planning with ${gathered.files.length} file(s)`);
    const plan = await engine.planChange({ callModel: ask, task: run.task, request: run.request, scan: tools.scan, gathered, failures, signal });
    throwIfCancelled(run);
    run.plan = { summary: plan.summary, approach: plan.approach, validation: plan.validation, uncertainties: plan.uncertainties };
    run.evidence.push({ kind: 'inference', label: 'Plan', detail: 'Designed by the model from the files above; not verified until approved actions run.' });

    for (const edit of plan.edits) {
      let prepared;
      try {
        prepared = tools.fileOps.prepare(edit);
      } catch (error) {
        prepared = { valid: false, invalidReason: error.message, invalidCode: error.code, diff: '', path: edit.path, kind: edit.kind };
      }
      run.actions.push({
        id: edit.id, type: 'edit', path: prepared.path || edit.path, editKind: edit.kind, reason: edit.reason, diff: prepared.diff || '',
        valid: Boolean(prepared.valid), invalidReason: prepared.valid ? null : prepared.invalidReason, risks: [prepared.risk || 'write'],
        requiresExplicit: edit.kind === 'delete', status: prepared.valid ? 'pending_approval' : 'suggested', result: null, _prepared: prepared.valid ? prepared : null
      });
    }
    for (const cmd of plan.commands) {
      let cwdOk = true;
      try { resolveInside(project.root, cmd.cwd, { mustExist: true }); } catch (_) { cwdOk = false; }
      const risk = classifyCommand(cmd.command, { root: project.root, cwd: path.resolve(project.root, cmd.cwd) });
      run.actions.push({
        id: cmd.id, type: 'command', command: cmd.command, cwd: cmd.cwd, purpose: cmd.purpose, kind: cmd.kind,
        risks: cwdOk ? risk.risks : Array.from(new Set([...risk.risks, 'outside_project'])), riskReasons: risk.reasons,
        requiresExplicit: !cwdOk || risk.requiresExplicit, valid: cwdOk, invalidReason: cwdOk ? null : 'Working directory is outside the project or does not exist.',
        status: cwdOk ? 'pending_approval' : 'suggested', result: null
      });
    }
    record(run, { type: 'plan', status: 'proposed', summary: `${plan.edits.length} edit(s), ${plan.commands.length} command(s)` });
    if (run.actions.some((a) => a.status === 'pending_approval')) return setStage(run, 'awaiting_approval', 'Review each change and command');
    return finish(run, ask);
  }

  async function finish(run, ask) {
    if (run.stage === 'cancelled') return;
    setStage(run, 'answering', 'Writing the answer');
    const actions = run.actions.map(({ _prepared, ...a }) => a);
    const answer = await engine.writeAnswer({ callModel: ask, task: run.task, request: run.request, screenText: run.screenText, plan: run.plan, actions, projectName: run.projectName });
    if (run.stage === 'cancelled') return;
    run.answer = answer;
    const statuses = run.actions.map((a) => a.status);
    run.answerStatus = statuses.includes('failed') ? 'failed'
      : statuses.includes('verified') ? 'verified'
        : statuses.includes('executed') ? 'executed' : 'suggested';
    record(run, { type: 'run', status: 'done', summary: `answer ${run.answerStatus}` });
    setStage(run, 'done', '');
  }

  function maybeFinish(run) {
    if (run.stage !== 'awaiting_approval' && run.stage !== 'executing') return;
    if (run.actions.some((a) => a.status === 'pending_approval' || a.status === 'running')) {
      setStage(run, 'awaiting_approval', 'Review each change and command');
      return;
    }
    const controller = controllers.get(run.id) || new AbortController();
    controllers.set(run.id, controller);
    const ask = (prompt, opts) => callModel(prompt, { ...opts, tag: `workbench:${run.id}`, signal: controller.signal });
    finish(run, ask).catch((error) => fail(run, error));
  }

  const err = (code, message) => ({ success: false, code, error: message });

  async function approve(runId, actionId) {
    const run = runs.get(runId);
    if (!run) return err('NOT_FOUND', 'Unknown run.');
    const action = run.actions.find((a) => a.id === actionId);
    if (!action || action.status !== 'pending_approval') return err('NOT_PENDING', 'This action is not waiting for approval.');
    if (run.actions.some((a) => a.status === 'running')) return err('BUSY', 'Another action of this run is still running.');
    if (action.type === 'command' && action.kind === 'validation' && run.actions.some((a) => a.type === 'edit' && a.status === 'pending_approval')) {
      return err('EDITS_PENDING', 'Approve or reject the file changes first; this check is meant to run after them.');
    }
    const project = projectStore.get(run.projectId);
    if (!project) return err('NO_PROJECT', 'The project of this run is no longer registered.');
    action.status = 'running';
    setStage(run, 'executing', action.type === 'edit' ? `Writing ${action.path}` : `Running ${action.command}`);
    record(run, { type: action.type, actionId, status: 'approved', summary: action.type === 'edit' ? `${action.editKind} ${action.path}` : `${action.command} (cwd ${action.cwd})` });
    try {
      if (action.type === 'edit') await applyEdit(run, action, project);
      else await runApprovedCommand(run, action, project);
    } catch (error) {
      action.status = 'failed';
      action.result = { error: { code: error.code || 'FAILED', message: error.message } };
    }
    record(run, { type: action.type, actionId, status: action.status, summary: summarise(action) });
    maybeFinish(run);
    return { success: true, status: action.status };
  }

  async function applyEdit(run, action, project) {
    const tools = await getProjectTools(project, {});
    const result = tools.fileOps.apply(action._prepared);
    if (result.ok) {
      action.status = 'executed';
      action.result = { bytesWritten: result.bytesWritten || 0, backupPath: result.backupPath || null };
      action._prepared = null;
      try { await tools.index.update([action.path]); } catch (error) { log(`[Workbench] index update failed: ${error.message}`); }
    } else {
      action.status = 'failed';
      action.result = { error: result.error || { code: 'WRITE_FAILED', message: 'The file could not be written.' } };
    }
  }

  async function runApprovedCommand(run, action, project) {
    const controller = new AbortController();
    action._cmd = controller;
    const res = await runCommand({ command: action.command, cwd: path.resolve(project.root, action.cwd), root: project.root, signal: controller.signal });
    action._cmd = null;
    action.result = { exitCode: res.exitCode, durationMs: res.durationMs, stdout: res.stdout, stderr: res.stderr, timedOut: res.timedOut, cancelled: res.cancelled, truncated: res.truncated };
    action.status = res.status === 'executed' ? (action.kind === 'validation' ? 'verified' : 'executed') : res.status;
  }

  function summarise(a) {
    if (a.type === 'edit') return `${a.editKind} ${a.path}: ${a.status}${a.result && a.result.error ? ` (${a.result.error.code})` : ''}`;
    return `${a.command}: ${a.status}${a.result && Number.isInteger(a.result.exitCode) ? ` exit ${a.result.exitCode}` : ''}${a.result && a.result.timedOut ? ' timed out' : ''}`;
  }

  function reject(runId, actionId) {
    const run = runs.get(runId);
    const action = run && run.actions.find((a) => a.id === actionId);
    if (!action || action.status !== 'pending_approval') return err('NOT_PENDING', 'This action is not waiting for approval.');
    action.status = 'rejected';
    action._prepared = null;
    record(run, { type: action.type, actionId, status: 'rejected', summary: summarise(action) });
    maybeFinish(run);
    return { success: true };
  }

  function cancel(runId) {
    const run = runs.get(runId);
    if (!run) return err('NOT_FOUND', 'Unknown run.');
    if (['done', 'failed', 'cancelled'].includes(run.stage)) return { success: true, alreadyFinished: true };
    run.stage = 'cancelled';
    run.stageDetail = '';
    const controller = controllers.get(runId);
    if (controller) controller.abort();
    cancelModel(`workbench:${runId}`);
    for (const a of run.actions) {
      if (a.status === 'running' && a._cmd) a._cmd.abort();
      if (a.status === 'pending_approval') { a.status = 'cancelled'; a._prepared = null; }
    }
    record(run, { type: 'run', status: 'cancelled', summary: 'Cancelled by the user' });
    changed(run);
    return { success: true };
  }

  async function fixFailures(runId) {
    const run = runs.get(runId);
    if (!run) return err('NOT_FOUND', 'Unknown run.');
    const failed = run.actions.filter((a) => a.status === 'failed');
    if (!failed.length) return err('NOTHING_FAILED', 'No action of this run failed.');
    const failures = failed.map((a) => (a.type === 'command'
      ? `$ ${a.command} (cwd ${a.cwd}) -> exit ${a.result && a.result.exitCode}\n${String(`${(a.result && a.result.stdout) || ''}\n${(a.result && a.result.stderr) || ''}`).trim().split('\n').slice(-60).join('\n')}`
      : `edit ${a.path} failed: ${a.result && a.result.error ? `${a.result.error.code} ${a.result.error.message}` : a.invalidReason}`)).join('\n\n');
    const newId = await startTask({ request: `${run.request}\n\nFix the failures from the previous attempt.`, useScreen: false, parentRunId: run.id, failures });
    return { success: true, runId: newId };
  }

  return {
    startTask, approve, reject, cancel, fixFailures, restore, persist,
    /** Cancels every unfinished run (New Problem: they were about the previous screen). */
    cancelActive: () => {
      for (const run of runs.values()) if (!['done', 'failed', 'cancelled'].includes(run.stage)) cancel(run.id);
    },
    getRun: (runId) => (runs.has(runId) ? snapshot(runs.get(runId)) : null),
    listRuns: () => Array.from(runs.values()).sort((a, b) => b.createdAt - a.createdAt).map(snapshot)
  };
}

module.exports = { createRunManager };
