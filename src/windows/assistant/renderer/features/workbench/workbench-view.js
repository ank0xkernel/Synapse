// Workbench view-model: pure functions, no DOM. Every string here is shown to
// the user, so each action status keeps its own distinct label.

export const STATUS_LABELS = Object.freeze({
  suggested: 'Suggested',
  pending_approval: 'Planned: needs your approval',
  approved: 'Approved',
  rejected: 'Rejected',
  running: 'Attempted: running',
  executed: 'Ran',
  verified: 'Verified',
  failed: 'Failed',
  cancelled: 'Cancelled'
});

export const STATUS_TONES = Object.freeze({
  suggested: 'neutral', pending_approval: 'warning', approved: 'info', rejected: 'neutral',
  running: 'busy', executed: 'info', verified: 'positive', failed: 'danger', cancelled: 'neutral'
});

export const ANSWER_LABELS = Object.freeze({
  none: 'No answer yet', suggested: 'Suggested', executed: 'Executed', verified: 'Verified', failed: 'Failed'
});

export const STAGE_LABELS = Object.freeze({
  understanding: 'Understanding the request', indexing: 'Indexing the project', retrieving: 'Reading relevant code',
  planning: 'Planning', awaiting_approval: 'Waiting for your approval', executing: 'Running approved actions',
  answering: 'Writing the answer', done: 'Done', failed: 'Failed', cancelled: 'Cancelled'
});

const TERMINAL_STAGES = new Set(['done', 'failed', 'cancelled']);

export const EVIDENCE_GROUPS = Object.freeze([
  ['screen', 'Seen on screen'],
  ['filesystem', 'Checked on disk'],
  ['repository', 'From project analysis'],
  ['execution', 'From running commands'],
  ['inference', 'Model reasoning (unverified)'],
  ['unknown', 'Unknown']
]);

export const statusLabel = (status) => STATUS_LABELS[status] || 'Unknown status';
export const statusTone = (status) => STATUS_TONES[status] || 'neutral';
export const answerLabel = (status) => ANSWER_LABELS[status] || ANSWER_LABELS.none;
export const stageLabel = (stage) => STAGE_LABELS[stage] || String(stage || '');
export const isRunActive = (run) => Boolean(run) && !TERMINAL_STAGES.has(run.stage);

/** Evidence grouped in display order; unrecognised kinds fall into "Unknown"; empty groups are omitted. */
export function groupEvidence(evidence) {
  const known = new Set(EVIDENCE_GROUPS.map(([kind]) => kind));
  const items = Array.isArray(evidence) ? evidence : [];
  return EVIDENCE_GROUPS
    .map(([kind, label]) => ({
      kind,
      label,
      items: items.filter((item) => (known.has(item?.kind) ? item.kind : 'unknown') === kind)
    }))
    .filter((group) => group.items.length);
}

/** Line of the first changed line: the +start of the first @@ hunk, or null when there is no hunk. */
export function firstChangedLine(diff) {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/m.exec(String(diff ?? ''));
  return match ? Math.max(1, Number(match[1])) : null;
}

/** CSS class suffix for a unified-diff line. */
export function diffLineClass(line) {
  const text = String(line ?? '');
  if (text.startsWith('\\')) return 'note';
  if (text.startsWith('@@')) return 'hunk';
  if (text.startsWith('+++') || text.startsWith('---')) return 'meta';
  if (text.startsWith('+')) return 'add';
  if (text.startsWith('-')) return 'del';
  return 'ctx';
}

export function classifyDiff(diff) {
  const text = String(diff ?? '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
  return text ? text.split('\n').map((line) => ({ text: line, kind: diffLineClass(line) })) : [];
}

/** Which buttons an action card offers. Edits that failed validation can never be approved. */
export function actionControls(action) {
  const pending = action?.status === 'pending_approval';
  const invalid = action?.type === 'edit' && action.valid === false;
  return { approve: pending && !invalid, reject: pending, openInEditor: action?.type === 'edit' && Boolean(action.path) };
}

export function hasFailedCommand(run) {
  return Boolean(run?.actions?.some((a) => a.type === 'command' && a.status === 'failed'));
}

/** Start needs an active project and a non-empty request, and no run in flight. */
export function canStart({ activeProjectId, request, busy }) {
  return Boolean(activeProjectId) && String(request ?? '').trim().length > 0 && !busy;
}

export function startHint({ activeProjectId, request }) {
  if (!activeProjectId) return 'Add and confirm a project first.';
  if (!String(request ?? '').trim()) return 'Describe what you want done.';
  return '';
}

/** What the command result says, one short line. */
export function describeCommandResult(result) {
  if (!result) return '';
  if (result.error) return result.error.message || result.error.code || 'Failed';
  const parts = [];
  if (result.timedOut) parts.push('Timed out');
  if (result.cancelled) parts.push('Cancelled');
  if (Number.isFinite(result.exitCode)) parts.push(`Exit code ${result.exitCode}`);
  if (Number.isFinite(result.durationMs)) parts.push(formatMs(result.durationMs));
  return parts.join(' · ');
}

export function formatMs(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Turn a workbenchSuggestProject response into what the panel shows. Never
 * confirms anything: every outcome is a prompt for the user.
 */
export function describeSuggestion(response, projects = []) {
  if (!response || response.success === false) return { kind: 'error', text: response?.error || 'The suggestion failed.', options: [] };
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const suggestion = response.suggestion || { projectId: null, confidence: 'none', candidates: [] };
  // A candidate is a registered project (projectId) or a folder found on
  // screen that confirming will register (root).
  const option = (c) => ({
    projectId: c.projectId || null,
    root: c.root || null,
    registered: Boolean(c.projectId),
    name: names.get(c.projectId) || c.name || c.projectId || c.root,
    score: c.score,
    evidence: [...(c.evidence || []), ...(!c.projectId && c.root ? [`Not added yet: ${c.root}`] : [])]
  });
  const candidates = suggestion.candidates || [];
  if (suggestion.confidence === 'high' && (suggestion.projectId || suggestion.root)) {
    const top = candidates.find((c) => (suggestion.projectId ? c.projectId === suggestion.projectId : c.root === suggestion.root))
      || { projectId: suggestion.projectId, root: suggestion.root };
    const picked = option(top);
    return { kind: 'high', text: `Looks like ${picked.name}`, options: [picked] };
  }
  if (suggestion.confidence === 'low' && candidates.length) {
    return { kind: 'low', text: 'Not sure. Pick the project you mean:', options: candidates.map(option) };
  }
  return {
    kind: 'none',
    text: response.screenAvailable
      ? 'No project folder could be found from what is on screen. Use Add project to pick it.'
      : 'No screen content was available, so no project could be found. Use Add project to pick it.',
    options: []
  };
}

export function describeRunError(run) {
  return run?.error ? `${run.error.message || 'The run failed.'}${run.error.code ? ` (${run.error.code})` : ''}` : '';
}
