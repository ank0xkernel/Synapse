'use strict';

// Shared shapes between the workbench stages (screen -> task -> project ->
// plan -> approval -> execution -> answer) and the assistant window.
// Version 1. Every value crossing a stage boundary goes through a validator
// here; model output is never trusted as-is.
//
// Evidence kinds keep observed facts apart from inference:
//   screen      read from the screen by Phase 1 (OCR text or an image)
//   filesystem  checked on disk (path exists, file content read)
//   repository  derived from project analysis (symbols, imports, manifests)
//   execution   produced by a command Synapse ran
//   inference   the model's reasoning, not verified
//   unknown     needed but not available

const CONTRACT_VERSION = 1;

const EVIDENCE_KINDS = ['screen', 'filesystem', 'repository', 'execution', 'inference', 'unknown'];
const TASK_KINDS = ['question', 'coding_problem', 'math', 'project_change', 'debugging', 'explanation'];
// Lifecycle of every proposed edit or command. Only 'verified' means a check
// that Synapse ran passed.
const ACTION_STATUSES = ['suggested', 'pending_approval', 'approved', 'rejected', 'running', 'executed', 'verified', 'failed', 'cancelled'];
const RISKS = ['read', 'write', 'test', 'build', 'install', 'delete', 'migration', 'external', 'outside_project', 'unknown'];

const MAX_TEXT = 200000;

class ContractError extends Error {
  constructor(message, details = []) {
    super(message);
    this.code = 'CONTRACT_INVALID';
    this.details = details;
  }
}

const isStr = (v, max = MAX_TEXT) => typeof v === 'string' && v.length <= max;
const isNonEmpty = (v, max) => isStr(v, max) && v.trim().length > 0;
const strArray = (v, maxItems = 200, maxLen = 4000) => Array.isArray(v) && v.length <= maxItems && v.every((s) => isStr(s, maxLen));

function collect(checks) {
  const errors = checks.filter(([ok]) => !ok).map(([, msg]) => msg);
  return errors;
}

/**
 * Task understanding produced by the model from the screen context and the
 * user's request. Required fields always present (empty arrays allowed).
 * @typedef {{ version: 1, kind: string, title: string, statement: string,
 *   requirements: string[], constraints: string[], examples: string[],
 *   inputFormat: string, outputFormat: string, language: string|null,
 *   needsProject: boolean, missing: string[], subtasks: string[],
 *   evidence: string }} TaskUnderstanding
 */
function normaliseTask(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const arr = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string').map((s) => s.slice(0, 4000)).slice(0, 100) : []);
  const task = {
    version: CONTRACT_VERSION,
    kind: TASK_KINDS.includes(r.kind) ? r.kind : 'question',
    title: String(r.title || '').slice(0, 200),
    statement: String(r.statement || '').slice(0, 20000),
    requirements: arr(r.requirements),
    constraints: arr(r.constraints),
    examples: arr(r.examples),
    inputFormat: String(r.inputFormat || '').slice(0, 4000),
    outputFormat: String(r.outputFormat || '').slice(0, 4000),
    language: typeof r.language === 'string' && r.language.trim() ? r.language.trim().slice(0, 40) : null,
    needsProject: Boolean(r.needsProject),
    missing: arr(r.missing),
    subtasks: arr(r.subtasks),
    // Where the statement came from: 'screen' when read from the screen
    // context, 'user' when only the typed request carried it.
    evidence: ['screen', 'user', 'both'].includes(r.evidence) ? r.evidence : 'user'
  };
  if (!task.statement) throw new ContractError('Task has no statement.', ['statement']);
  return task;
}

/**
 * One file change in a plan. 'replace' swaps an exact anchor that must occur
 * once in the current file; 'create' writes a file that must not exist;
 * 'delete' removes a file (always needs explicit approval).
 * @typedef {{ id: string, path: string, kind: 'replace'|'create'|'delete',
 *   search?: string, replace?: string, content?: string, reason: string,
 *   symbols: string[] }} PlannedEdit
 * @typedef {{ id: string, command: string, cwd: string, purpose: string,
 *   kind: 'validation'|'setup'|'other' }} PlannedCommand
 * @typedef {{ version: 1, summary: string, approach: string,
 *   files: { path: string, reason: string, symbols: string[] }[],
 *   edits: PlannedEdit[], commands: PlannedCommand[], validation: string[],
 *   uncertainties: string[] }} Plan
 */
function normalisePlan(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const files = (Array.isArray(r.files) ? r.files : []).slice(0, 50).map((f) => ({
    path: String((f && f.path) || ''),
    reason: String((f && f.reason) || '').slice(0, 2000),
    symbols: strArray(f && f.symbols, 50, 200) ? f.symbols : []
  })).filter((f) => f.path);
  const edits = (Array.isArray(r.edits) ? r.edits : []).slice(0, 40).map((e, i) => {
    const kind = ['replace', 'create', 'delete'].includes(e && e.kind) ? e.kind : null;
    const edit = {
      id: `e${i + 1}`,
      path: String((e && e.path) || ''),
      kind,
      reason: String((e && e.reason) || '').slice(0, 2000),
      symbols: strArray(e && e.symbols, 50, 200) ? e.symbols : []
    };
    if (kind === 'replace') { edit.search = String(e.search ?? ''); edit.replace = String(e.replace ?? ''); }
    if (kind === 'create') edit.content = String(e.content ?? '');
    const problems = collect([
      [kind, `edit ${i + 1}: kind must be replace, create or delete`],
      [isNonEmpty(edit.path, 1000), `edit ${i + 1}: path missing`],
      [kind !== 'replace' || edit.search.length > 0, `edit ${i + 1}: replace needs a non-empty search anchor`],
      [(edit.search || '').length + (edit.replace || '').length + (edit.content || '').length <= MAX_TEXT, `edit ${i + 1}: too large`]
    ]);
    if (problems.length) errors.push(...problems);
    return edit;
  });
  const commands = (Array.isArray(r.commands) ? r.commands : []).slice(0, 20).map((c, i) => ({
    id: `c${i + 1}`,
    command: String((c && c.command) || '').slice(0, 4000),
    cwd: String((c && c.cwd) || '.'),
    purpose: String((c && c.purpose) || '').slice(0, 1000),
    kind: ['validation', 'setup', 'other'].includes(c && c.kind) ? c.kind : 'other'
  })).filter((c) => c.command.trim());
  if (errors.length) throw new ContractError('Plan failed validation.', errors);
  return {
    version: CONTRACT_VERSION,
    summary: String(r.summary || '').slice(0, 4000),
    approach: String(r.approach || '').slice(0, 20000),
    files,
    edits,
    commands,
    validation: strArray(r.validation, 50) ? r.validation : [],
    uncertainties: strArray(r.uncertainties, 50) ? r.uncertainties : []
  };
}

/**
 * Pulls the first JSON object out of model text (models often wrap it in a
 * fenced block). Throws ContractError when there is none.
 */
function parseModelJson(text) {
  const s = String(text || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ContractError('Model reply contained no JSON object.');
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (error) {
    throw new ContractError(`Model reply was not valid JSON: ${error.message}`);
  }
}

module.exports = {
  CONTRACT_VERSION,
  EVIDENCE_KINDS,
  TASK_KINDS,
  ACTION_STATUSES,
  RISKS,
  ContractError,
  normaliseTask,
  normalisePlan,
  parseModelJson
};
