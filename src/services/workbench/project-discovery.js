'use strict';

// Finds the project a screen is about, registered or not, without scanning
// the disk. Sources, all bounded:
//   - absolute or ~ paths in window titles and screen text, walked up to the
//     nearest folder holding a project marker (never above the home folder)
//   - folders open in VS Code / Cursor windows, read from each editor's own
//     window-state file, matched against the window titles
//   - registered projects (project-match.js)
// Only folders that exist are returned. Nothing is registered here: the user
// confirms a candidate first.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');
const { matchProject } = require('./project-match');

const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod', 'Cargo.toml', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'CMakeLists.txt', 'Makefile', 'Gemfile', 'composer.json', 'Package.swift', 'deno.json'];
const EDITOR_STATE_FILES = ['Code', 'Cursor', 'VSCodium', 'Code - Insiders', 'Windsurf']
  .map((app) => path.join('Library', 'Application Support', app, 'User', 'globalStorage', 'storage.json'));
const PATH_RE = /(?:~|\/Users\/[^\s/"'`<>|:]+|\/Volumes\/[^\s/"'`<>|:]+)(?:\/[^\s"'`<>|:,;)\]]+)+/g;

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }

/**
 * Nearest folder at or above `start` with a project marker. The walk never
 * leaves the home folder, or the external volume the path is on.
 */
function projectRootOf(start, home) {
  let dir = isDir(start) ? start : path.dirname(start);
  const homeDir = path.resolve(home);
  const stop = dir.startsWith(`${homeDir}/`) ? homeDir : (dir.match(/^\/Volumes\/[^/]+/) || [])[0];
  if (!stop) return null;
  for (let i = 0; i < 40 && dir.startsWith(`${stop}/`); i += 1) {
    if (MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Folders open in editor windows right now (each editor's own window-state file). */
function openEditorFolders(home) {
  const folders = [];
  for (const rel of EDITOR_STATE_FILES) {
    let state;
    try { state = JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8')); } catch (_) { continue; }
    const ws = state && state.windowsState;
    const windows = ws ? [ws.lastActiveWindow, ...(Array.isArray(ws.openedWindows) ? ws.openedWindows : [])] : [];
    for (const w of windows) {
      if (!w || typeof w.folder !== 'string' || !w.folder.startsWith('file://')) continue;
      try {
        const folder = fileURLToPath(w.folder);
        if (isDir(folder) && !folders.includes(folder)) folders.push(folder);
      } catch (_) { /* not a local folder */ }
    }
  }
  return folders;
}

const wordIn = (text, word) => new RegExp(`(^|[^\\w.-])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w.-])`, 'i').test(text);

/**
 * @param {{ titles: string[], screenText: string, projects: object[], home?: string }} input
 * @returns {{ confidence: 'high'|'low'|'none', candidates: { root, name, projectId|null, registered, score, evidence: string[] }[] }}
 */
function discoverProjects({ titles = [], screenText = '', projects = [], home = os.homedir() }) {
  const text = [...titles, screenText].join('\n');
  const byRoot = new Map();
  const add = (root, score, evidence) => {
    let real;
    try { real = fs.realpathSync(root); } catch (_) { return; }
    const entry = byRoot.get(real) || { root: real, name: path.basename(real), score: 0, evidence: [] };
    entry.score += score;
    if (!entry.evidence.includes(evidence)) entry.evidence.push(evidence);
    byRoot.set(real, entry);
  };

  for (const raw of new Set(text.match(PATH_RE) || [])) {
    const p = raw.startsWith('~') ? path.join(home, raw.slice(1)) : raw;
    const root = fs.existsSync(p) || fs.existsSync(path.dirname(p)) ? projectRootOf(fs.existsSync(p) ? p : path.dirname(p), home) : null;
    if (root) add(root, 10, `Path on screen: ${raw}`);
  }
  for (const folder of openEditorFolders(home)) {
    const name = path.basename(folder);
    if (titles.some((t) => wordIn(t, name))) add(folder, 8, `Open in your editor, and "${name}" is in a window title`);
    else add(folder, 1, 'Open in your editor');
  }
  const registered = matchProject(text, projects);
  for (const c of registered.candidates) {
    const project = projects.find((p) => p.id === c.projectId);
    if (project) add(project.root, Math.min(10, c.score), c.evidence.join('; ') || 'Registered project');
  }

  const known = new Map(projects.map((p) => [(() => { try { return fs.realpathSync(p.root); } catch (_) { return p.root; } })(), p]));
  const candidates = Array.from(byRoot.values()).map((c) => ({
    ...c, projectId: known.get(c.root)?.id || null, registered: known.has(c.root), name: known.get(c.root)?.name || c.name
  })).sort((a, b) => b.score - a.score).slice(0, 6);
  const [top, next] = candidates;
  const confidence = !top ? 'none' : top.score >= 8 && (!next || next.score < top.score / 2) ? 'high' : 'low';
  return { confidence, candidates };
}

module.exports = { discoverProjects, projectRootOf, openEditorFolders };
