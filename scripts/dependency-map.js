#!/usr/bin/env node
'use strict';

/**
 * Builds the module graph of the desktop app from its real entry points and
 * reports which files under src/ are reachable, which are not, and any
 * import cycles. Static analysis of require('./x') and import ... from './x'
 * (plus <script src> in HTML and loadURL/loadFile targets named in code).
 *
 *   node scripts/dependency-map.js            summary
 *   node scripts/dependency-map.js --json     full graph
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const ENTRY_POINTS = [
  'src/main.js',
  'src/windows/assistant/preload.js',
  'src/windows/assistant/renderer.html',
  'src/main-process/features/mobile-server/companion.html'
].map((entry) => path.join(ROOT, entry));

const EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.json', '/index.js'];

function resolve(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null; // package or builtin
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const extension of EXTENSIONS) {
    const candidate = base + extension;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function dependenciesOf(file) {
  const source = fs.readFileSync(file, 'utf8');
  const specifiers = new Set();
  if (file.endsWith('.html')) {
    for (const match of source.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
      if (!/^(https?:|data:)/.test(match[1])) specifiers.add(`./${match[1]}`);
    }
  } else {
    for (const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.add(match[1]);
    for (const match of source.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g)) specifiers.add(match[1]);
    for (const match of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.add(match[1]);
    // path.join(__dirname, ..., 'file.html') style asset references
    for (const match of source.matchAll(/path\.join\(\s*__dirname\s*,([^)]+)\)/g)) {
      const parts = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((part) => part[1]);
      if (parts.length) specifiers.add(`./${parts.join('/')}`);
    }
  }
  return [...specifiers].map((specifier) => resolve(file, specifier)).filter(Boolean);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|cjs|html|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function buildGraph() {
  const graph = new Map();
  const queue = [...ENTRY_POINTS];
  while (queue.length) {
    const file = queue.shift();
    if (graph.has(file) || !fs.existsSync(file)) continue;
    const deps = dependenciesOf(file);
    graph.set(file, deps);
    queue.push(...deps);
  }
  return graph;
}

function findCycles(graph) {
  const cycles = [];
  const state = new Map();
  const stack = [];
  function visit(node) {
    state.set(node, 'active');
    stack.push(node);
    for (const next of graph.get(node) || []) {
      if (state.get(next) === 'active') {
        cycles.push(stack.slice(stack.indexOf(next)).concat(next));
      } else if (!state.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 'done');
  }
  for (const node of graph.keys()) if (!state.has(node)) visit(node);
  return cycles;
}

function main() {
  const graph = buildGraph();
  const rel = (file) => path.relative(ROOT, file);
  const all = walk(SRC);
  const unreachable = all.filter((file) => !graph.has(file)).map(rel).sort();
  const cycles = findCycles(graph).map((cycle) => cycle.map(rel));

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
      entryPoints: ENTRY_POINTS.map(rel),
      reachable: [...graph.keys()].map(rel).sort(),
      unreachable,
      cycles,
      edges: Object.fromEntries([...graph].map(([file, deps]) => [rel(file), deps.map(rel)]))
    }, null, 2));
    return;
  }

  console.log(`Reachable from entry points: ${graph.size} files`);
  console.log(`Not reachable (candidates for review, not automatic deletion): ${unreachable.length}`);
  for (const file of unreachable) console.log(`  ${file}`);
  console.log(`Import cycles: ${cycles.length}`);
  for (const cycle of cycles) console.log(`  ${cycle.join(' -> ')}`);
}

module.exports = { buildGraph, findCycles, ENTRY_POINTS };

if (require.main === module) main();
