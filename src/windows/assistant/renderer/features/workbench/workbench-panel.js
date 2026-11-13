// Workbench sheet: projects, one task at a time, and per-action approval.
// All run text is untrusted (model output, file contents, command output), so
// DOM is built with createElement/textContent. The only innerHTML is the
// answer, produced by renderMarkdown, which HTML-escapes everything first.

import { renderMarkdown } from '../chat/markdown.js';
import {
  actionControls, answerLabel, canStart, classifyDiff, describeCommandResult, describeRunError, describeSuggestion,
  firstChangedLine, groupEvidence, hasFailedCommand, isRunActive, stageLabel, startHint, statusLabel, statusTone
} from './workbench-view.js';

const api = window.electronAPI;
const $ = (id) => document.getElementById(id);
const panel = $('workbench-panel');

if (panel && api?.workbenchListProjects) {
  const el = {
    open: $('workbench-btn'), close: $('close-workbench'), list: $('wb-project-list'), add: $('wb-add'), suggest: $('wb-suggest'),
    suggestion: $('wb-suggestion'), note: $('wb-projects-note'), request: $('wb-request'), useScreen: $('wb-use-screen'),
    start: $('wb-start'), cancel: $('wb-cancel'), hint: $('wb-start-hint'), stage: $('wb-stage'), run: $('wb-run'),
    history: $('wb-history'), historyList: $('wb-history-list')
  };

  let projects = [];
  let activeProjectId = null;
  let run = null;
  let starting = false;
  let confirmingRemove = null;
  let lastFocus = null;
  const openDetails = new Set();

  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function button(label, onClick, { ghost = true, primary = false, aria } = {}) {
    const b = node('button', `btn btn-sm ${primary ? 'btn-primary' : ghost ? 'btn-ghost' : ''}`.trim(), label);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', onClick);
    return b;
  }
  function pill(text, tone) {
    const p = node('span', 'wb-pill', text);
    p.dataset.tone = tone;
    return p;
  }
  function details(key, summary, body, className) {
    const d = node('details', className);
    d.dataset.key = key;
    d.open = openDetails.has(key);
    d.addEventListener('toggle', () => { if (d.open) openDetails.add(key); else openDetails.delete(key); });
    d.append(node('summary', null, summary), body);
    return d;
  }
  const say = (text, tone) => { el.note.textContent = text || ''; el.note.dataset.tone = tone || ''; };
  const failure = (response, fallback) => `${response?.error || fallback}${response?.code ? ` (${response.code})` : ''}`;

  // ─── Projects ───────────────────────────────────────────────────────────
  async function refreshProjects() {
    const response = await api.workbenchListProjects();
    if (!response?.success) { say(failure(response, 'Projects could not be loaded.'), 'danger'); return; }
    projects = response.projects || [];
    activeProjectId = response.activeProjectId || null;
    paintProjects();
    paintTask();
  }

  function paintProjects() {
    if (!projects.length) {
      el.list.replaceChildren(node('li', 'wb-empty', 'No projects yet. Add the folder of a project you work on.'));
      return;
    }
    el.list.replaceChildren(...projects.map((project) => {
      const li = node('li', 'wb-project');
      const active = project.id === activeProjectId;
      li.dataset.active = String(active);
      const text = node('div', 'wb-project-text');
      const name = node('span', 'wb-project-name', project.name);
      if (active) { name.append(pill('Active', 'positive')); li.setAttribute('aria-current', 'true'); }
      text.append(name, node('span', 'wb-path', project.root));
      li.append(text);
      if (confirmingRemove === project.id) {
        li.append(
          button(`Remove ${project.name}?`, () => removeProject(project), { aria: `Confirm removing ${project.name}` }),
          button('Keep', () => { confirmingRemove = null; paintProjects(); })
        );
      } else {
        if (!active) li.append(button('Use', () => confirmProject(project.id), { aria: `Use ${project.name}` }));
        li.append(button('Remove', () => { confirmingRemove = project.id; paintProjects(); }, { aria: `Remove ${project.name}` }));
      }
      return li;
    }));
  }

  async function confirmProject(id) {
    const response = await api.workbenchConfirmProject(id);
    if (!response?.success) { say(failure(response, 'The project could not be selected.'), 'danger'); return; }
    el.suggestion.hidden = true;
    say('');
    await refreshProjects();
  }

  async function removeProject(project) {
    confirmingRemove = null;
    const response = await api.workbenchRemoveProject(project.id);
    if (!response?.success) say(failure(response, `${project.name} could not be removed.`), 'danger');
    else say(`Removed ${project.name} from Synapse. Its files were not touched.`);
    await refreshProjects();
  }

  async function addProject() {
    el.add.disabled = true;
    try {
      const response = await api.workbenchAddProject();
      if (response?.cancelled) say('Add project cancelled.');
      else if (!response?.success) say(failure(response, 'The project could not be added.'), 'danger');
      else say(`Added ${response.project?.name || 'project'}.`);
      await refreshProjects();
    } finally { el.add.disabled = false; }
  }

  async function suggestProject() {
    el.suggest.disabled = true;
    el.suggest.setAttribute('aria-busy', 'true');
    say('Matching what is on screen to your projects...');
    try {
      const model = describeSuggestion(await api.workbenchSuggestProject(), projects);
      say('');
      el.suggestion.hidden = false;
      el.suggestion.dataset.kind = model.kind;
      const rows = [node('p', 'wb-suggestion-text', model.text)];
      for (const option of model.options) {
        const row = node('div', 'wb-candidate');
        const text = node('div', 'wb-project-text');
        text.append(node('span', 'wb-project-name', option.name));
        if (option.evidence.length) text.append(node('span', 'wb-evidence-line', option.evidence.join(' · ')));
        row.append(text, button('Confirm', () => confirmProject(option.projectId), { primary: true, aria: `Confirm ${option.name}` }));
        rows.push(row);
      }
      el.suggestion.replaceChildren(...rows);
    } finally { el.suggest.disabled = false; el.suggest.removeAttribute('aria-busy'); }
  }

  // ─── Task ───────────────────────────────────────────────────────────────
  function paintTask() {
    const busy = starting || isRunActive(run);
    const state = { activeProjectId, request: el.request.value, busy };
    el.start.disabled = !canStart(state);
    el.hint.textContent = busy ? '' : startHint(state);
    el.cancel.hidden = !isRunActive(run);
    el.stage.hidden = !run;
    if (run) {
      el.stage.dataset.stage = run.stage;
      el.stage.textContent = isRunActive(run) || run.stage === 'failed' || run.stage === 'cancelled'
        ? `${stageLabel(run.stage)}${run.stageDetail ? `: ${run.stageDetail}` : ''}`
        : stageLabel(run.stage);
    }
  }

  async function startTask() {
    if (!canStart({ activeProjectId, request: el.request.value, busy: starting || isRunActive(run) })) return;
    starting = true;
    paintTask();
    try {
      const response = await api.workbenchStartTask({ request: el.request.value.trim(), useScreen: el.useScreen.checked });
      if (!response?.success) say(failure(response, 'The task could not be started.'), 'danger');
      else say('');
    } finally { starting = false; paintTask(); }
  }

  async function control(call, label) {
    const response = await call();
    if (!response?.success) say(failure(response, `${label} failed.`), 'danger');
  }

  // ─── Run view ───────────────────────────────────────────────────────────
  function renderRun() {
    paintTask();
    if (!run) { el.run.hidden = true; return; }
    el.run.hidden = false;
    const parts = [node('h3', 'wb-subhead', 'Run')];
    parts.push(node('p', 'wb-run-project', `${run.projectName || 'Project'} · ${run.projectRoot || ''}`));
    if (run.error) parts.push(node('p', 'wb-error', describeRunError(run)));
    if (run.task) parts.push(taskView(run.task));
    const evidence = groupEvidence(run.evidence);
    if (evidence.length) parts.push(evidenceView(evidence));
    if (run.plan) parts.push(planView(run.plan));
    if (run.actions?.length) {
      const wrap = node('div', 'wb-actions');
      wrap.setAttribute('role', 'list');
      run.actions.forEach((action, index) => wrap.append(actionView(action, index)));
      parts.push(wrap);
    }
    if (hasFailedCommand(run)) {
      const fix = button('Fix failures', () => control(() => api.workbenchFixFailures({ runId: run.id }), 'Fix failures'), { primary: true });
      parts.push(fix);
    }
    if (run.answer || run.answerStatus === 'failed') parts.push(answerView());
    el.run.replaceChildren(...parts);
  }

  function taskView(task) {
    const box = node('div', 'wb-card');
    const head = node('div', 'wb-card-head');
    head.append(node('strong', 'wb-card-title', task.title || 'Task'), pill(task.kind || 'task', 'neutral'));
    box.append(head);
    if (task.statement) {
      const body = node('p', 'wb-statement', task.statement);
      box.append(details(`${run.id}:statement`, 'Task statement', body));
    }
    for (const [label, items] of [['Requirements', task.requirements], ['Constraints', task.constraints]]) {
      if (!items?.length) continue;
      box.append(node('h4', 'wb-minor', label), listOf(items));
    }
    if (task.missing?.length) {
      const missing = node('div', 'wb-missing');
      missing.append(node('strong', null, 'Missing information'), listOf(task.missing));
      box.append(missing);
    }
    return box;
  }

  function listOf(items) {
    const ul = node('ul', 'wb-bullets');
    ul.append(...items.map((item) => node('li', null, String(item))));
    return ul;
  }

  function evidenceView(groups) {
    const box = node('div', 'wb-card');
    box.append(node('h4', 'wb-minor', 'Evidence'));
    for (const group of groups) {
      const section = node('div', 'wb-evidence-group');
      section.dataset.kind = group.kind;
      section.append(node('strong', 'wb-evidence-label', group.label));
      const ul = node('ul', 'wb-bullets');
      ul.append(...group.items.map((item) => {
        const li = node('li', null, item.label || '');
        if (item.detail) li.append(node('span', 'wb-evidence-line', ` ${item.detail}`));
        return li;
      }));
      section.append(ul);
      box.append(section);
    }
    return box;
  }

  function planView(plan) {
    const box = node('div', 'wb-card');
    box.append(node('h4', 'wb-minor', 'Plan'), node('p', null, plan.summary || ''));
    if (plan.approach) box.append(node('p', 'wb-evidence-line', plan.approach));
    if (plan.validation?.length) box.append(node('h4', 'wb-minor', 'How it will be checked'), listOf(plan.validation));
    if (plan.uncertainties?.length) {
      const unsure = node('div', 'wb-missing');
      unsure.append(node('strong', null, 'Uncertain'), listOf(plan.uncertainties));
      box.append(unsure);
    }
    return box;
  }

  function actionView(action, index) {
    const card = node('div', 'wb-card wb-action');
    card.setAttribute('role', 'listitem');
    card.dataset.status = action.status;
    const head = node('div', 'wb-card-head');
    const controls = actionControls(action);
    if (action.type === 'edit') {
      head.append(node('strong', 'wb-card-title wb-mono', action.path || '(no path)'), pill(action.editKind || 'edit', 'neutral'));
    } else {
      head.append(node('strong', 'wb-card-title', `Command ${index + 1}`));
    }
    head.append(pill(statusLabel(action.status), statusTone(action.status)));
    card.append(head);

    if (action.type === 'edit') {
      if (action.reason) card.append(node('p', null, action.reason));
      if (action.valid === false) card.append(node('p', 'wb-error', `Cannot be applied: ${action.invalidReason || 'the edit is not valid.'}`));
      if (action.diff) card.append(diffView(action.diff));
      if (controls.openInEditor) {
        const line = firstChangedLine(action.diff);
        card.append(button('Open in editor', () => control(() => api.workbenchOpenInEditor({ runId: run && run.id, path: action.path, line }), 'Open in editor'),
          { aria: `Open ${action.path} in editor` }));
      }
    } else {
      card.append(node('pre', 'wb-command', action.command || ''));
      card.append(node('p', 'wb-evidence-line', `Runs in ${action.cwd || '(unknown folder)'}`));
      if (action.purpose) card.append(node('p', null, action.purpose));
      if (action.risks?.length) {
        const risks = node('div', 'wb-risks');
        risks.append(...action.risks.map((risk) => pill(String(risk), action.requiresExplicit ? 'warning' : 'neutral')));
        card.append(risks);
      }
    }
    if (action.result) card.append(resultView(action));
    if (controls.approve || controls.reject) {
      const row = node('div', 'wb-row');
      if (controls.approve) row.append(button('Approve', () => control(() => api.workbenchApprove({ runId: run.id, actionId: action.id }), 'Approve'), { primary: true }));
      row.append(button('Reject', () => control(() => api.workbenchReject({ runId: run.id, actionId: action.id }), 'Reject')));
      card.append(row);
    }
    return card;
  }

  function diffView(diff) {
    const pre = node('pre', 'wb-diff');
    pre.setAttribute('aria-label', 'Proposed change');
    pre.append(...classifyDiff(diff).map((line) => {
      const row = node('span', `wb-diff-line wb-diff-${line.kind}`, line.text || ' ');
      return row;
    }));
    return pre;
  }

  function resultView(action) {
    const result = action.result;
    const box = node('div', 'wb-result');
    if (action.type === 'command' || 'exitCode' in result || result.error) {
      const line = describeCommandResult(result);
      if (line) box.append(node('p', result.error || result.exitCode ? 'wb-error' : 'wb-evidence-line', line));
      for (const stream of ['stdout', 'stderr']) {
        if (!result[stream]) continue;
        const body = node('pre', 'wb-output', result[stream]);
        box.append(details(`${run.id}:${action.id}:${stream}`, stream + (result.truncated ? ' (truncated)' : ''), body));
      }
    } else if ('bytesWritten' in result) {
      box.append(node('p', 'wb-evidence-line', `${result.bytesWritten} bytes written${result.backupPath ? `. Backup: ${result.backupPath}` : ''}`));
    }
    return box;
  }

  function answerView() {
    const box = node('div', 'wb-card wb-answer');
    const head = node('div', 'wb-card-head');
    head.append(node('strong', 'wb-card-title', 'Answer'), pill(answerLabel(run.answerStatus), run.answerStatus === 'verified' ? 'positive' : run.answerStatus === 'failed' ? 'danger' : 'neutral'));
    const body = node('div', 'wb-answer-body');
    body.innerHTML = renderMarkdown(run.answer); // renderMarkdown escapes all input before adding its own tags
    box.append(head, body);
    return box;
  }

  // ─── History ────────────────────────────────────────────────────────────
  async function refreshHistory() {
    const response = await api.workbenchHistory({ limit: 50 });
    if (!response?.success) { el.historyList.replaceChildren(node('li', 'wb-error', failure(response, 'History could not be loaded.'))); return; }
    const entries = response.entries || [];
    el.historyList.replaceChildren(...(entries.length ? entries.map((entry) => {
      const li = node('li', 'wb-history-item');
      li.append(node('span', 'wb-evidence-line', new Date(entry.ts).toLocaleString()), node('span', null, ` ${entry.type}`), pill(entry.status || '', 'neutral'));
      if (entry.summary) li.append(node('div', null, entry.summary));
      return li;
    }) : [node('li', 'wb-empty', 'Nothing recorded yet.')]));
  }

  // ─── Sheet open/close and wiring ────────────────────────────────────────
  function openSheet() {
    lastFocus = document.activeElement;
    document.querySelectorAll('.sheet:not(.hidden)').forEach((s) => { if (s !== panel) s.classList.add('hidden'); });
    panel.classList.remove('hidden');
    panel.querySelector('[data-autofocus]')?.focus();
    refreshProjects();
    if (el.history.open) refreshHistory();
    // Runs restored after a restart (with approvals still pending) send no
    // event until something changes: show the latest one on open.
    if (!run) {
      api.workbenchListRuns?.().then((response) => {
        if (!run && response?.success && response.runs?.length) { run = response.runs[0]; renderRun(); }
      });
    }
  }
  function closeSheet() {
    if (panel.classList.contains('hidden')) return;
    panel.classList.add('hidden');
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  el.open?.addEventListener('click', () => (panel.classList.contains('hidden') ? openSheet() : closeSheet()));
  el.close.addEventListener('click', closeSheet);
  el.add.addEventListener('click', addProject);
  el.suggest.addEventListener('click', suggestProject);
  el.request.addEventListener('input', paintTask);
  el.start.addEventListener('click', startTask);
  el.cancel.addEventListener('click', () => run && control(() => api.workbenchCancel({ runId: run.id }), 'Cancel'));
  el.history.addEventListener('toggle', () => { if (el.history.open) refreshHistory(); });

  api.onWorkbenchEvent?.((event) => {
    if (event?.type !== 'run' || !event.run) return;
    const finished = run && isRunActive(run) && !isRunActive(event.run);
    run = event.run;
    renderRun();
    if (finished && el.history.open) refreshHistory();
  });
}
