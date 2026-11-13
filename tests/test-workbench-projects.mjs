#!/usr/bin/env node
/**
 * Workbench project layer: store, scanner, code index, screen-to-project match.
 * Fixture repos are built on disk at test time.
 *
 * Run: node --no-warnings tests/test-workbench-projects.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createProjectStore } = require('../src/services/workbench/project-store.js');
const { scanProject } = require('../src/services/workbench/project-scanner.js');
const { createCodeIndex } = require('../src/services/workbench/code-index.js');
const { matchProject } = require('../src/services/workbench/project-match.js');

let passed = 0;
let failed = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-projects-'));
const put = (root, rel, content) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const fixture = (name, files) => {
  const root = fs.realpathSync(fs.mkdirSync(path.join(tmp, name), { recursive: true }) || path.join(tmp, name));
  for (const [rel, content] of Object.entries(files)) put(root, rel, content);
  return root;
};

// ---- fixtures ----------------------------------------------------------
const tsRoot = fixture('mono', {
  'package.json': JSON.stringify({ name: 'mono', workspaces: ['packages/*'], devDependencies: { typescript: '^5' } }),
  'package-lock.json': '{}',
  'packages/api/package.json': JSON.stringify({ name: '@mono/api', main: 'src/server.ts', scripts: { test: 'jest', build: 'tsc' }, dependencies: { express: '^4' }, devDependencies: { jest: '^29' } }),
  'packages/api/src/server.ts': [
    "import express from 'express';", // 1
    "import { greet } from '../../shared/util';", // 2
    '', // 3
    'export interface Options {', // 4
    '  port: number;', // 5
    '}', // 6
    '', // 7
    'export class Server {', // 8
    '  start(opts: Options) {', // 9
    "    return greet('x') + express.name;", // 10
    '  }', // 11
    '}', // 12
    '', // 13
    'export const createServer = () => new Server();', // 14
    ''
  ].join('\n'),
  'packages/shared/package.json': JSON.stringify({ name: '@mono/shared' }),
  'packages/shared/util.ts': ['export function greet(name: string): string {', "  return 'hi ' + name;", '}', ''].join('\n'),
  'packages/shared/index.ts': "export * from './util.js';\n",
  'packages/web/package.json': JSON.stringify({ name: '@mono/web', dependencies: { react: '^19' } }),
  'packages/web/src/App.tsx': "import React from 'react';\n\nexport function App() {\n  return <div>hi</div>;\n}\n",
  'packages/web/src/cjs.js': "const u = require('../../shared/util');\nmodule.exports = { u };\n",
  'node_modules/dep/index.js': 'module.exports = 1;\n'
});

const pyRoot = fixture('pyproj', {
  'pyproject.toml': '[tool.poetry]\nname = "pyproj"\n[tool.poetry.dependencies]\nfastapi = "*"\n[tool.poetry.group.dev.dependencies]\npytest = "*"\n',
  'poetry.lock': '',
  'main.py': 'from pkg.core import top\n',
  'pkg/__init__.py': '',
  'pkg/models.py': 'class User:\n    pass\n',
  'pkg/helpers.py': 'def assist():\n    return 1\n',
  'pkg/core.py': [
    'from . import helpers', // 1
    'from .models import User', // 2
    'import pkg.helpers as h', // 3
    '', // 4
    'class Service:', // 5
    '    def run(self):', // 6
    '        return 1', // 7
    '', // 8
    '    async def stop(self):', // 9
    '        return 2', // 10
    '', // 11
    'def top():', // 12
    '    return h, User', // 13
    ''
  ].join('\n')
});

const goRoot = fixture('goproj', {
  'go.mod': 'module example.com/goproj\n\ngo 1.21\n',
  'go.sum': '',
  'main.go': 'package main\n\nfunc main() {\n}\n\ntype Server struct {\n\tname string\n}\n\nfunc (s *Server) Handle() {\n}\n',
  'main_test.go': 'package main\n'
});

const cppRoot = fixture('cppproj', {
  'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.10)\nproject(x)\nenable_testing()\n',
  'include/engine.hpp': 'class Engine {\npublic:\n  int run(int x);\n};\n',
  'src/engine.cpp': '#include "engine.hpp"\n\nint Engine::run(int x) {\n  return x;\n}\n'
});

const javaRoot = fixture('javaproj', {
  'pom.xml': '<project><dependencies><dependency><artifactId>junit</artifactId></dependency></dependencies></project>',
  'src/main/java/com/acme/App.java': 'package com.acme;\n\npublic class App {\n    public static void main(String[] args) {\n        System.out.println("x");\n    }\n}\n'
});

const PY = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'].some((p) => fs.existsSync(p));

// ---- scanner -----------------------------------------------------------
test('scanner: TS monorepo fields', () => {
  const s = scanProject(tsRoot);
  assert.equal(s.root, tsRoot);
  assert.ok(s.manifests.includes('packages/api/package.json'));
  assert.deepEqual(s.workspaces, ['packages/api', 'packages/shared', 'packages/web']);
  assert.ok(s.packageManagers.includes('npm'));
  assert.ok(s.frameworks.includes('express') && s.frameworks.includes('react') && s.frameworks.includes('jest'));
  assert.deepEqual(s.scripts['packages/api'], { test: 'jest', build: 'tsc' });
  assert.ok(s.entryPoints.includes('packages/api/src/server.ts'));
  assert.ok(s.testSystems.includes('jest'));
  assert.ok(s.buildSystems.includes('tsc'));
  const ts = s.languages.find((l) => l.name === 'TypeScript');
  assert.ok(ts && ts.files >= 4);
  assert.equal(s.truncated, false);
});

test('scanner: skips node_modules', () => {
  const s = scanProject(tsRoot);
  assert.ok(!s.languages.some((l) => l.name === 'JavaScript' && l.files > 1));
  assert.equal(s.fileCount, 10);
});

test('scanner: does not follow symlink pointing outside root', () => {
  const outside = fixture('outside', { 'secret.ts': 'export const s = 1;\n', 'a/b.ts': 'export const b = 1;\n' });
  const root = fixture('linked', { 'ok.ts': 'export const ok = 1;\n' });
  fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
  fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'secret-link.ts'));
  const s = scanProject(root);
  assert.equal(s.fileCount, 1);
});

test('scanner: python, go, cmake, maven', () => {
  const py = scanProject(pyRoot);
  assert.ok(py.packageManagers.includes('poetry'));
  assert.ok(py.frameworks.includes('fastapi') && py.frameworks.includes('pytest'));
  assert.ok(py.entryPoints.includes('main.py'));
  assert.ok(py.testSystems.includes('pytest'));
  const go = scanProject(goRoot);
  assert.deepEqual(go.entryPoints, ['main.go']);
  assert.ok(go.packageManagers.includes('go') && go.buildSystems.includes('go modules') && go.testSystems.includes('go test'));
  const cpp = scanProject(cppRoot);
  assert.ok(cpp.buildSystems.includes('cmake') && cpp.testSystems.includes('ctest'));
  assert.ok(cpp.languages.some((l) => l.name === 'C++'));
  const java = scanProject(javaRoot);
  assert.ok(java.buildSystems.includes('maven') && java.testSystems.includes('junit'));
});

test('scanner: cancel and truncate', () => {
  const ac = new AbortController();
  ac.abort();
  assert.throws(() => scanProject(tsRoot, { signal: ac.signal }), (e) => e.code === 'CANCELLED');
  const t = scanProject(tsRoot, { maxFiles: 3 });
  assert.equal(t.truncated, true);
  assert.equal(t.fileCount, 3);
});

// ---- code index --------------------------------------------------------
const quiet = () => {};
test('index: TS symbols, lines, imports both directions', async () => {
  const idx = createCodeIndex(tsRoot, { log: quiet });
  const stats = await idx.build();
  assert.equal(stats.byParser.typescript, idx.files().filter((f) => f.parser === 'typescript').length);
  const syms = idx.symbolsIn('packages/api/src/server.ts');
  const by = (n) => syms.find((s) => s.name === n);
  assert.deepEqual([by('Options').kind, by('Options').startLine, by('Options').endLine, by('Options').exported], ['interface', 4, 6, true]);
  assert.deepEqual([by('Server').kind, by('Server').startLine, by('Server').endLine], ['class', 8, 12]);
  assert.deepEqual([by('start').kind, by('start').startLine, by('start').endLine, by('start').parent], ['method', 9, 11, 'Server']);
  assert.deepEqual([by('createServer').kind, by('createServer').startLine], ['function', 14]);
  const greet = idx.findSymbol('greet');
  assert.equal(greet.length, 1);
  assert.deepEqual([greet[0].path, greet[0].startLine, greet[0].endLine], ['packages/shared/util.ts', 1, 3]);
  const imports = idx.importsOf('packages/api/src/server.ts');
  assert.deepEqual(imports.find((i) => i.specifier === '../../shared/util').resolved, ['packages/shared/util.ts']);
  assert.equal(imports.find((i) => i.specifier === 'express').external, true);
  assert.deepEqual(idx.importersOf('packages/shared/util.ts'), ['packages/api/src/server.ts', 'packages/shared/index.ts', 'packages/web/src/cjs.js']);
  assert.ok(idx.exportsOf('packages/shared/index.ts').includes('*'));
  assert.ok(idx.exportsOf('packages/web/src/cjs.js').includes('u'));
  assert.equal(idx.symbolsIn('packages/web/src/App.tsx')[0].name, 'App');
  assert.ok(!idx.files().some((f) => f.path.includes('node_modules')));
});

test('index: Python via ast, relative imports resolved', async () => {
  if (!PY) { console.log('    (skip: no python3 found, ast assertions not run)'); return; }
  const idx = createCodeIndex(pyRoot, { log: quiet });
  await idx.build();
  const f = idx.files().find((x) => x.path === 'pkg/core.py');
  assert.equal(f.parser, 'ast');
  const syms = idx.symbolsIn('pkg/core.py');
  const by = (n) => syms.find((s) => s.name === n);
  assert.deepEqual([by('Service').kind, by('Service').startLine, by('Service').endLine], ['class', 5, 10]);
  assert.deepEqual([by('run').kind, by('run').startLine, by('run').parent], ['method', 6, 'Service']);
  assert.equal(by('stop').startLine, 9);
  assert.deepEqual([by('top').startLine, by('top').endLine], [12, 13]);
  assert.deepEqual(idx.importsOf('pkg/core.py').flatMap((i) => i.resolved).sort(), ['pkg/helpers.py', 'pkg/helpers.py', 'pkg/models.py']);
  assert.deepEqual(idx.importersOf('pkg/models.py'), ['pkg/core.py']);
  assert.deepEqual(idx.importersOf('pkg/core.py'), ['main.py']);
});

test('index: Python falls back to regex when interpreter is missing', async () => {
  const idx = createCodeIndex(pyRoot, { python: '/nonexistent/python3', log: quiet });
  await idx.build();
  assert.equal(idx.files().find((x) => x.path === 'pkg/core.py').parser, 'regex');
  const svc = idx.symbolsIn('pkg/core.py').find((s) => s.name === 'Service');
  assert.deepEqual([svc.startLine, svc.endLine], [5, 10]);
  assert.deepEqual(idx.importersOf('pkg/models.py'), ['pkg/core.py']);
});

test('index: regex fallback for Go, C++, Java', async () => {
  const go = createCodeIndex(goRoot, { log: quiet });
  await go.build();
  const gs = go.symbolsIn('main.go');
  assert.ok(gs.some((s) => s.name === 'main' && s.kind === 'function' && s.startLine === 3 && s.endLine === 4));
  assert.ok(gs.some((s) => s.name === 'Server' && s.kind === 'type' && s.startLine === 6));
  assert.ok(gs.some((s) => s.name === 'Handle' && s.kind === 'method' && s.startLine === 10));
  assert.ok(go.files().every((f) => f.parser === 'regex'));

  const cpp = createCodeIndex(cppRoot, { log: quiet });
  await cpp.build();
  assert.ok(cpp.symbolsIn('include/engine.hpp').some((s) => s.name === 'Engine' && s.kind === 'class' && s.startLine === 1));
  assert.ok(cpp.symbolsIn('src/engine.cpp').some((s) => s.name === 'Engine::run' && s.startLine === 3 && s.endLine === 5));
  assert.deepEqual(cpp.importersOf('include/engine.hpp'), ['src/engine.cpp']);

  const java = createCodeIndex(javaRoot, { log: quiet });
  await java.build();
  const js = java.symbolsIn('src/main/java/com/acme/App.java');
  assert.ok(js.some((s) => s.name === 'App' && s.kind === 'class' && s.startLine === 3 && s.endLine === 7));
  assert.ok(js.some((s) => s.name === 'main' && s.kind === 'method' && s.startLine === 4 && s.endLine === 6));
});

test('index: search ranks the defining file first, update picks up edits', async () => {
  const idx = createCodeIndex(tsRoot, { log: quiet });
  await idx.build();
  const hits = idx.search('greet name');
  assert.equal(hits[0].path, 'packages/shared/util.ts');
  assert.equal(hits[0].symbols[0].name, 'greet');
  assert.ok(hits[0].snippet.text.includes('function greet'));
  assert.ok(hits[0].snippet.text.split('\n').length <= 12);
  assert.ok(hits.some((h) => h.path === 'packages/api/src/server.ts'));
  assert.deepEqual(idx.search('the and'), []);
  put(tsRoot, 'packages/shared/extra.ts', 'export function zebraStripes() {}\n');
  await idx.update(['packages/shared/extra.ts']);
  assert.equal(idx.search('zebra stripes')[0].path, 'packages/shared/extra.ts');
  fs.rmSync(path.join(tsRoot, 'packages/shared/extra.ts'));
  await idx.update(['packages/shared/extra.ts']);
  assert.deepEqual(idx.search('zebra'), []);
});

test('index: does not index symlinked files or dirs', async () => {
  const outside = fixture('outside2', { 'secret.ts': 'export const s = 1;\n' });
  const root = fixture('linked2', { 'ok.ts': 'export const ok = 1;\n' });
  fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
  const idx = createCodeIndex(root, { log: quiet });
  await idx.build();
  assert.deepEqual(idx.files().map((f) => f.path), ['ok.ts']);
});

test('index: cancelled build rejects with CANCELLED', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(createCodeIndex(tsRoot, { log: quiet }).build({ signal: ac.signal }), (e) => e.code === 'CANCELLED');
});

// ---- store -------------------------------------------------------------
test('store: add, list, duplicate, reload, active, remove', () => {
  const file = path.join(tmp, 'store', 'projects.json');
  const logs = [];
  const a = createProjectStore({ filePath: file, log: (m) => logs.push(m) });
  assert.deepEqual(a.list(), []);
  const p = a.add(tsRoot);
  assert.match(p.id, /^prj_[0-9a-f]{12}$/);
  assert.equal(p.name, 'mono');
  assert.equal(p.root, tsRoot);
  assert.equal(a.add(tsRoot).id, p.id);
  assert.equal(a.add(path.join(tsRoot, 'packages', '..')).id, p.id);
  const g = a.add(goRoot);
  assert.equal(g.name, 'goproj');
  assert.equal(a.list().length, 2);
  a.setActive(g.id);
  assert.equal(a.getActive().id, g.id);
  assert.equal(a.touch(p.id), true);
  assert.throws(() => a.add(path.join(tmp, 'nope')), /does not exist/);
  assert.throws(() => a.add(path.join(tsRoot, 'package.json')), /Not a folder/);
  assert.throws(() => a.setActive('prj_unknown'), /Unknown project/);

  const b = createProjectStore({ filePath: file, log: (m) => logs.push(m) });
  assert.equal(b.list().length, 2);
  assert.equal(b.getActive().id, g.id);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
  assert.equal(b.remove(g.id), true);
  assert.equal(b.getActive(), null);
  assert.equal(b.remove(g.id), false);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')), []);
  assert.equal(createProjectStore({ filePath: file }).list().length, 1);
  assert.deepEqual(logs, []);
});

test('store: corrupt file is moved aside, not overwritten', () => {
  const dir = path.join(tmp, 'corrupt');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'projects.json');
  fs.writeFileSync(file, '{not json');
  const logs = [];
  const s = createProjectStore({ filePath: file, log: (m) => logs.push(m) });
  assert.deepEqual(s.list(), []);
  const aside = fs.readdirSync(dir).filter((n) => n.startsWith('projects.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{not json');
  assert.equal(logs.length, 1);
  s.add(goRoot);
  assert.equal(createProjectStore({ filePath: file }).list().length, 1);
});

// ---- match -------------------------------------------------------------
test('match: path evidence is strong, ~/ form too', () => {
  const projects = [{ id: 'a', root: '/work/alpha' }, { id: 'b', root: '/work/beta' }];
  const r = matchProject('src/app.ts - /work/alpha/src/app.ts:12', projects);
  assert.equal(r.projectId, 'a');
  assert.equal(r.confidence, 'high');
  assert.equal(r.candidates.length, 1);
  const home = [{ id: 'h', root: path.join(os.homedir(), 'zz-proj') }, { id: 'o', root: '/work/other' }];
  assert.equal(matchProject('~/zz-proj/lib/x.js', home).projectId, 'h');
  assert.equal(matchProject('/work/alphabet/x.js', projects).confidence, 'none');
});

test('match: nested roots resolve to the deepest project', () => {
  const projects = [{ id: 'outer', root: '/w/mono' }, { id: 'inner', root: '/w/mono/packages/api' }];
  const r = matchProject('/w/mono/packages/api/src/x.ts', projects);
  assert.equal(r.projectId, 'inner');
  assert.equal(r.confidence, 'high');
});

test('match: editor title and package name are medium, bare name is weak', () => {
  const projects = [{ id: 'a', root: '/work/alpha', packageName: '@acme/alpha-core' }, { id: 'b', root: '/work/beta' }];
  assert.deepEqual([matchProject('server.ts - alpha - Visual Studio Code', projects).projectId, matchProject('server.ts - alpha - Visual Studio Code', projects).confidence], ['a', 'high']);
  assert.equal(matchProject('import x from "@acme/alpha-core"', projects).projectId, 'a');
  const weak = matchProject('we talked about beta yesterday', projects);
  assert.equal(weak.projectId, null);
  assert.equal(weak.confidence, 'low');
  assert.equal(weak.candidates[0].projectId, 'b');
});

test('match: same basename in two projects is ambiguous, unregistered is none', () => {
  const projects = [{ id: 'a', root: '/one/app' }, { id: 'b', root: '/two/app' }];
  const r = matchProject('app.ts - app - Visual Studio Code', projects);
  assert.equal(r.projectId, null);
  assert.equal(r.confidence, 'low');
  assert.deepEqual(r.candidates.map((c) => c.projectId).sort(), ['a', 'b']);
  const none = matchProject('/elsewhere/unregistered/file.ts', projects);
  assert.deepEqual([none.projectId, none.confidence, none.candidates], [null, 'none', []]);
  assert.equal(matchProject('', projects).confidence, 'none');
  assert.equal(matchProject('anything', []).confidence, 'none');
});

// ---- run ---------------------------------------------------------------
for (const [name, fn] of queue) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${String(error.stack || error.message).split('\n').slice(0, 8).join('\n      ')}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Workbench project tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed ? 1 : 0);
