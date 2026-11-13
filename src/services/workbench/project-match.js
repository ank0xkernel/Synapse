'use strict';

// Pick the registered project a screen most likely shows. Pure: no I/O.
// Evidence strength: strong = a path into the project root; medium = name in
// an editor-title pattern or the package name; weak = bare folder name.
// Only registered projects are ever returned, and ambiguity yields null.

const os = require('os');

const SCORE = { strong: 10, medium: 4, weak: 1 };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD_L = '(?<![A-Za-z0-9_])';
const WORD_R = '(?![A-Za-z0-9_])';
const DASH = '[-\\u2013\\u2014]';

function titleRegexes(name) {
  const n = esc(name);
  return [
    new RegExp(`${DASH}\\s+${n}\\s+${DASH}`, 'i'),
    new RegExp(`\\[${n}\\]`, 'i'),
    new RegExp(`(^|\\n)\\s*${n}\\s+${DASH}\\s`, 'i'),
    new RegExp(`${WORD_L}${n}\\s+[\\u2013\\u2014]\\s`, 'i')
  ];
}

// Positions where `prefix` starts a path (ends at a path boundary).
function pathHits(text, prefix) {
  const hits = [];
  let i = text.indexOf(prefix);
  while (i !== -1) {
    const next = text[i + prefix.length];
    const prev = text[i - 1];
    if (!(next && /[A-Za-z0-9_.-]/.test(next)) && !(prev && /[A-Za-z0-9_.~-]/.test(prev))) hits.push(i);
    i = text.indexOf(prefix, i + 1);
  }
  return hits;
}

function matchProject(screenText, projects) {
  const text = typeof screenText === 'string' ? screenText : '';
  const list = Array.isArray(projects) ? projects.filter((p) => p && typeof p.id === 'string' && typeof p.root === 'string') : [];
  const home = os.homedir();
  const found = new Map(); // id -> [{ strength, label }]
  const add = (p, strength, label) => {
    if (!found.has(p.id)) found.set(p.id, []);
    const arr = found.get(p.id);
    if (!arr.some((e) => e.label === label)) arr.push({ strength, label });
  };

  // Path evidence: an occurrence belongs to the longest root that matches it.
  const forms = [];
  for (const p of list) {
    const root = p.root.replace(/[\\/]+$/, '');
    if (!root) continue;
    forms.push({ p, prefix: root, label: `path ${root}` });
    if (home && (root === home || root.startsWith(home + '/'))) forms.push({ p, prefix: '~' + root.slice(home.length), label: `path ${'~' + root.slice(home.length)}` });
  }
  const bestAt = new Map(); // start position -> form
  for (const f of forms) {
    for (const i of pathHits(text, f.prefix)) {
      const cur = bestAt.get(i);
      if (!cur || f.prefix.length > cur.prefix.length) bestAt.set(i, f);
    }
  }
  for (const f of bestAt.values()) add(f.p, 'strong', f.label);

  for (const p of list) {
    const base = p.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    if (base && base.length >= 2) {
      if (titleRegexes(base).some((re) => re.test(text))) add(p, 'medium', `editor title shows "${base}"`);
      else if (new RegExp(`${WORD_L}${esc(base)}${WORD_R}`, 'i').test(text)) add(p, 'weak', `folder name "${base}" on screen`);
    }
    if (typeof p.packageName === 'string' && p.packageName.length >= 2 && p.packageName !== base) {
      if (new RegExp(`${WORD_L}${esc(p.packageName)}${WORD_R}`, 'i').test(text)) add(p, 'medium', `package name "${p.packageName}" on screen`);
    }
  }

  const scored = [...found.entries()]
    .map(([projectId, ev]) => ({
      projectId,
      score: ev.reduce((s, e) => s + SCORE[e.strength], 0),
      evidence: ev.map((e) => e.label),
      strongest: ev.some((e) => e.strength === 'strong') ? 'strong' : ev.some((e) => e.strength === 'medium') ? 'medium' : 'weak'
    }))
    .sort((a, b) => b.score - a.score || a.projectId.localeCompare(b.projectId));
  const candidates = scored.map(({ projectId, score, evidence }) => ({ projectId, score, evidence }));
  if (!scored.length) return { projectId: null, confidence: 'none', candidates };

  const [top, second] = scored;
  const clear = !second || second.score < top.score * 0.5;
  if (top.strongest !== 'weak' && clear) return { projectId: top.projectId, confidence: 'high', candidates };
  return { projectId: null, confidence: 'low', candidates };
}

module.exports = { matchProject };
