'use strict';

// The reasoning stages of a workbench run: understand the task, gather
// evidence from the project, plan edits and commands, write the answer.
// Deterministic work (search, reading files, validating the plan against the
// disk) is code; the model is only asked to interpret and design, and every
// reply is validated (contracts.js).

const { normaliseTask, normalisePlan, parseModelJson, ContractError } = require('./contracts');
const { understandPrompt, planPrompt, answerPrompt } = require('./prompts');

const FILE_CONTEXT_CHARS = 60000;
const MAX_FILES_IN_FULL = 8;
const WINDOW_LINES = 160;

/**
 * Calls the model and validates its JSON with `normalise`. One retry with the
 * validation error appended; a second failure propagates (code CONTRACT_INVALID
 * or the provider's own error).
 */
async function askJson(callModel, prompt, normalise, options) {
  let reply = await callModel(prompt, options);
  try {
    return normalise(parseModelJson(reply));
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    const detail = [error.message, ...(error.details || [])].join('; ');
    reply = await callModel(`${prompt}\n\nYour previous reply was rejected: ${detail}\nReply again with ONE valid JSON object only.`, options);
    return normalise(parseModelJson(reply));
  }
}

async function understandTask({ callModel, request, screenText, projectName, signal }) {
  return askJson(callModel, understandPrompt({ request, screenText, projectName }), normaliseTask, { signal, maxOutputTokens: 4096 });
}

const numbered = (lines, start) => lines.map((l, i) => `${String(start + i).padStart(5)}| ${l}`).join('\n');

/**
 * Files relevant to the task: index search over the task text, plus any
 * indexed path named in the request or on screen. Returns file contents for
 * the prompt (whole small files, a window around the best hit in big ones)
 * and the evidence entries describing what was read.
 */
async function gatherEvidence({ index, fileOps, task, request, screenText }) {
  const known = new Set(index.files().map((f) => f.path));
  const query = [task.title, task.statement, ...task.requirements, request].join(' ');
  const hits = index.search(query, { limit: 16 });
  const named = Array.from(new Set(`${request}\n${screenText || ''}`.match(/[\w@./-]+\.[A-Za-z0-9]{1,6}\b/g) || []))
    .flatMap((p) => Array.from(known).filter((f) => f === p || f.endsWith(`/${p}`)))
    .slice(0, 6);
  const order = Array.from(new Set([...named, ...hits.map((h) => h.path)]));
  const hitByPath = new Map(hits.map((h) => [h.path, h]));
  const files = [];
  const evidence = [];
  let budget = FILE_CONTEXT_CHARS;
  for (const rel of order) {
    if (files.length >= MAX_FILES_IN_FULL || budget <= 2000) break;
    let read;
    try {
      read = fileOps.read(rel);
    } catch (error) {
      evidence.push({ kind: 'unknown', label: rel, detail: `Could not read: ${error.code || error.message}` });
      continue;
    }
    const lines = read.content.split(/\r?\n/);
    let start = 1;
    let slice = lines;
    if (read.content.length > budget || lines.length > 2 * WINDOW_LINES) {
      const centre = (hitByPath.get(rel) && hitByPath.get(rel).snippet && hitByPath.get(rel).snippet.startLine) || 1;
      start = Math.max(1, centre - WINDOW_LINES / 2);
      slice = lines.slice(start - 1, start - 1 + WINDOW_LINES);
    }
    const text = numbered(slice, start);
    budget -= text.length;
    files.push({ path: rel, lines: lines.length, numbered: text, partial: slice.length < lines.length });
    evidence.push({ kind: 'filesystem', label: rel, detail: slice.length < lines.length ? `Read lines ${start}-${start + slice.length - 1} of ${lines.length}` : `Read all ${lines.length} lines` });
  }
  const shown = new Set(files.map((f) => f.path));
  const outlines = hits.filter((h) => !shown.has(h.path)).slice(0, 12)
    .map((h) => `${h.path}: ${(h.symbols || []).slice(0, 8).map((s) => `${s.name} (${s.kind}, line ${s.startLine})`).join(', ') || 'no symbols'}`)
    .join('\n');
  if (!files.length) evidence.push({ kind: 'unknown', label: 'Relevant files', detail: 'Search found no file related to the task.' });
  return { files, outlines, evidence };
}

function summariseProject(scan) {
  if (!scan) return 'Unknown.';
  const scripts = Object.entries(scan.scripts || {})
    .map(([dir, s]) => `${dir || '.'}: ${Object.entries(s).slice(0, 12).map(([k, v]) => `${k}=${v}`).join('; ')}`).join('\n');
  return [
    `Languages: ${(scan.languages || []).map((l) => `${l.name} (${l.files})`).join(', ') || 'unknown'}`,
    `Manifests: ${(scan.manifests || []).join(', ') || 'none'}`,
    `Package managers: ${(scan.packageManagers || []).join(', ') || 'unknown'}`,
    `Frameworks: ${(scan.frameworks || []).join(', ') || 'none detected'}`,
    `Workspaces: ${(scan.workspaces || []).join(', ') || 'none'}`,
    `Test systems: ${(scan.testSystems || []).join(', ') || 'none detected'}; build: ${(scan.buildSystems || []).join(', ') || 'none detected'}`,
    `Scripts:\n${scripts || 'none'}`
  ].join('\n');
}

async function planChange({ callModel, task, request, scan, gathered, failures, signal }) {
  return askJson(callModel, planPrompt({
    task, request, projectSummary: summariseProject(scan), files: gathered.files, outlines: gathered.outlines, failures
  }), normalisePlan, { signal, maxOutputTokens: 16384 });
}

async function writeAnswer({ callModel, task, request, screenText, plan, actions, projectName, signal }) {
  const text = await callModel(answerPrompt({ task, request, screenText, plan, actions, projectName }), { signal, maxOutputTokens: 8192 });
  if (!String(text || '').trim()) throw Object.assign(new Error('The model returned an empty answer.'), { code: 'EMPTY_ANSWER' });
  return String(text);
}

module.exports = { understandTask, gatherEvidence, planChange, writeAnswer, summariseProject, askJson };
