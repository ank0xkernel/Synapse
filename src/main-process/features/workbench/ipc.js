'use strict';

// Workbench IPC: projects, screen-based project suggestion, task runs with
// per-action approval, editor opening and the audit history. Every handler
// answers only the assistant window.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { createProjectStore } = require('../../../services/workbench/project-store');
const { scanProject } = require('../../../services/workbench/project-scanner');
const { createCodeIndex } = require('../../../services/workbench/code-index');
const { matchProject } = require('../../../services/workbench/project-match');
const { createFileOps } = require('../../../services/workbench/file-ops');
const { runCommand, classifyCommand } = require('../../../services/workbench/command-runner');
const { resolveInside } = require('../../../services/workbench/path-guard');
const { createActionLog } = require('../../../services/workbench/action-log');
const { createRunManager } = require('../../../services/workbench/run-manager');

const INDEX_MAX_AGE_MS = 10 * 60 * 1000;
const EDITOR_CLIS = [
  '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
  '/usr/local/bin/code',
  '/opt/homebrew/bin/code'
];

function registerWorkbenchIpc({
  app, ipcMain, dialog, desktopCapturer, getMainWindow, sendToWindow, geminiRuntime, getScreenIntel, screenshotManager, log = console.log
}) {
  const dir = path.join(app.getPath('userData'), 'workbench');
  const projectStore = createProjectStore({ filePath: path.join(dir, 'projects.json'), log });
  const actionLog = createActionLog({ filePath: path.join(dir, 'actions.jsonl') });
  const tools = new Map(); // projectId -> Promise<{ scan, index, fileOps, stats, builtAt }>

  /** Scan and index a project once, again after INDEX_MAX_AGE_MS. Concurrent callers share one build. */
  function getProjectTools(project, { signal } = {}) {
    const cached = tools.get(project.id);
    if (cached && Date.now() - cached.startedAt < INDEX_MAX_AGE_MS) return cached.promise;
    const entry = { startedAt: Date.now() };
    entry.promise = (async () => {
      if (!fs.existsSync(project.root)) throw Object.assign(new Error(`The project folder ${project.root} no longer exists.`), { code: 'PROJECT_MISSING' });
      const scan = await scanProject(project.root, { signal });
      const index = createCodeIndex(project.root, { log: (m) => log(`[Workbench] ${m}`) });
      const built = await index.build({ signal });
      const fileOps = createFileOps({ root: project.root, backupDir: path.join(dir, 'backups', project.id), log });
      return { scan, index, fileOps, stats: { files: built.files ?? index.files().length, symbols: built.symbols ?? 0 }, builtAt: Date.now() };
    })();
    entry.promise.catch(() => { if (tools.get(project.id) === entry) tools.delete(project.id); });
    tools.set(project.id, entry);
    return entry.promise;
  }

  async function callModel(prompt, { tag, signal, maxOutputTokens = 8192 } = {}) {
    if (signal && signal.aborted) throw Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' });
    const text = await geminiRuntime.executeWithKeyFailover((service) => {
      if (!service || typeof service.generateText !== 'function') throw new Error('No AI provider is configured.');
      return service.generateText(prompt, { tag, priority: 'realtime', generation: { maxOutputTokens, thinkingLevel: 'medium' } });
    });
    // Providers that cannot abort (Ollama) still finish; a cancelled run drops the reply.
    if (signal && signal.aborted) throw Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' });
    return text;
  }

  function getScreenText() {
    const screenIntel = getScreenIntel();
    if (!screenIntel || !screenIntel.isActive()) return { text: '', available: false };
    const context = screenIntel.getPromptContext({ withImages: false });
    return { text: context ? context.text : '', available: true };
  }

  const runs = createRunManager({
    callModel,
    cancelModel: (tag) => geminiRuntime.cancelActive?.(tag),
    getScreenText,
    projectStore,
    getProjectTools,
    runCommand,
    classifyCommand,
    resolveInside,
    actionLog,
    persistPath: path.join(dir, 'runs.json'),
    emit: (run) => sendToWindow('workbench:event', { type: 'run', run }),
    log: (m) => log(m)
  });
  const restored = runs.restore();
  if (restored) log(`[Workbench] restored ${restored} run(s)`);

  /** Window titles of on-screen apps (editors name the open folder there). Needs Screen Recording, already used by Phase 1. */
  async function windowTitles() {
    const permission = await screenshotManager.validateScreenCaptureCapability();
    if (!permission.authorized) return { titles: [], available: false };
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
    return { titles: sources.map((s) => s.name).filter(Boolean), available: true };
  }

  function findEditorCli() {
    return EDITOR_CLIS.find((p) => fs.existsSync(p)) || null;
  }

  const run = (file, args) => new Promise((resolve) => execFile(file, args, { timeout: 10000 }, (error) => resolve(error)));

  const handlers = {
    'workbench:list-projects': () => ({ success: true, projects: projectStore.list(), activeProjectId: projectStore.getActive()?.id || null }),
    'workbench:add-project': async () => {
      const win = getMainWindow();
      const result = await dialog.showOpenDialog(win, { title: 'Add a project folder', properties: ['openDirectory'] });
      if (result.canceled || !result.filePaths.length) return { success: false, cancelled: true };
      const project = projectStore.add(result.filePaths[0]);
      return { success: true, project };
    },
    'workbench:remove-project': (_e, projectId) => {
      projectStore.remove(String(projectId));
      tools.delete(String(projectId));
      return { success: true };
    },
    'workbench:suggest-project': async () => {
      const [titles, screen] = await Promise.all([windowTitles().catch(() => ({ titles: [], available: false })), Promise.resolve(getScreenText())]);
      const text = [...titles.titles, screen.text].join('\n');
      const suggestion = matchProject(text, projectStore.list());
      return { success: true, suggestion, screenAvailable: titles.available || screen.available };
    },
    'workbench:confirm-project': (_e, projectId) => {
      const project = projectStore.get(String(projectId));
      if (!project) return { success: false, code: 'NOT_FOUND', error: 'That project is not registered.' };
      projectStore.setActive(project.id);
      projectStore.touch(project.id);
      getProjectTools(project).catch((error) => log(`[Workbench] indexing ${project.name} failed: ${error.message}`));
      return { success: true, activeProjectId: project.id };
    },
    'workbench:start-task': async (_e, payload = {}) => {
      const request = typeof payload.request === 'string' ? payload.request.trim() : '';
      if (!request && payload.useScreen === false) return { success: false, code: 'EMPTY', error: 'Describe the task or use the screen.' };
      return { success: true, runId: await runs.startTask({ request, useScreen: payload.useScreen !== false }) };
    },
    'workbench:approve': (_e, p = {}) => runs.approve(String(p.runId), String(p.actionId)),
    'workbench:reject': (_e, p = {}) => runs.reject(String(p.runId), String(p.actionId)),
    'workbench:cancel': (_e, p = {}) => runs.cancel(String(p.runId)),
    'workbench:fix-failures': (_e, p = {}) => runs.fixFailures(String(p.runId)),
    'workbench:get-run': (_e, runId) => {
      const found = runs.getRun(String(runId));
      return found ? { success: true, run: found } : { success: false, code: 'NOT_FOUND', error: 'Unknown run.' };
    },
    'workbench:list-runs': () => ({ success: true, runs: runs.listRuns() }),
    'workbench:history': (_e, p = {}) => ({ success: true, entries: actionLog.list({ limit: Math.min(500, Number(p.limit) || 100) }) }),
    'workbench:open-in-editor': async (_e, p = {}) => {
      // A run's paths are relative to that run's project, which may not be the active one any more.
      const ofRun = p.runId ? runs.getRun(String(p.runId)) : null;
      const project = ofRun ? projectStore.get(ofRun.projectId) : projectStore.getActive();
      if (!project) return { success: false, code: 'NO_PROJECT', error: 'That project is not registered any more.' };
      let abs;
      try { abs = resolveInside(project.root, String(p.path || ''), { mustExist: true }); } catch (error) {
        return { success: false, code: error.code || 'INVALID_PATH', error: error.message };
      }
      const line = Math.max(1, Number.parseInt(p.line, 10) || 1);
      const cli = findEditorCli();
      if (cli && !(await run(cli, ['-g', `${abs}:${line}`]))) return { success: true, opener: 'code' };
      const error = await run('/usr/bin/open', [abs]);
      return error ? { success: false, code: 'OPEN_FAILED', error: error.message } : { success: true, opener: 'open' };
    }
  };

  const fromAssistant = (event) => {
    const win = getMainWindow();
    return Boolean(win && !win.isDestroyed() && event && event.sender === win.webContents);
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!fromAssistant(event)) return { success: false, code: 'FORBIDDEN', error: 'Not allowed from this window.' };
      try {
        return await handler(event, ...args);
      } catch (error) {
        log(`[Workbench] ${channel} failed: ${error.message}`);
        return { success: false, code: error.code || 'FAILED', error: error.message };
      }
    });
  }

  return {
    dispose() {
      for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
      runs.persist();
    }
  };
}

module.exports = { registerWorkbenchIpc };
