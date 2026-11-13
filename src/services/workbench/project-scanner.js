'use strict';

// Structural scan of a project folder: languages, manifests, package
// managers, workspaces, frameworks, scripts, entry points, test and build
// systems. Plain fs walk, no dependencies. Never follows symlinked dirs.

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'target', '__pycache__', '.venv', 'venv', 'vendor', 'coverage', 'Pods']);

const LANG_BY_EXT = {
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.py': 'Python', '.go': 'Go', '.rs': 'Rust',
  '.java': 'Java', '.kt': 'Kotlin', '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++', '.hpp': 'C++',
  '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.sql': 'SQL', '.sh': 'Shell'
};

const MANIFEST_NAMES = new Set([
  'package.json', 'pnpm-workspace.yaml', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'go.mod',
  'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'CMakeLists.txt', 'Makefile', 'Gemfile',
  'composer.json', 'Package.swift'
]);
const isManifest = (name) => MANIFEST_NAMES.has(name) || name.endsWith('.csproj');

const LOCKFILES = {
  'bun.lockb': 'bun', 'bun.lock': 'bun', 'package-lock.json': 'npm', 'yarn.lock': 'yarn', 'pnpm-lock.yaml': 'pnpm',
  'poetry.lock': 'poetry', 'uv.lock': 'uv', 'Pipfile.lock': 'pipenv', 'Cargo.lock': 'cargo', 'go.sum': 'go'
};

const JS_FRAMEWORKS = {
  next: 'next', react: 'react', vue: 'vue', svelte: 'svelte', express: 'express', fastify: 'fastify',
  '@nestjs/core': 'nestjs', electron: 'electron', vite: 'vite', jest: 'jest', vitest: 'vitest', mocha: 'mocha',
  '@playwright/test': 'playwright'
};
const JS_TESTS = new Set(['jest', 'vitest', 'mocha', 'playwright']);
const PY_FRAMEWORKS = ['django', 'flask', 'fastapi', 'pytest'];
const PY_ENTRY = new Set(['__main__.py', 'manage.py', 'app.py', 'main.py']);

const posix = (p) => p.split(path.sep).join('/');
const readText = (file, max = 256 * 1024) => {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(max);
      return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, max, 0));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
};

function scanProject(root, { maxFiles = 20000, signal } = {}) {
  const abs = path.resolve(root);
  const langCounts = new Map();
  const manifests = [];
  const pms = new Set();
  const frameworks = new Set();
  const testSystems = new Set();
  const buildSystems = new Set();
  const scripts = {};
  const entries = new Set();
  const goFiles = [];
  let fileCount = 0;
  let truncated = false;

  const queue = [''];
  walk: while (queue.length) {
    if (signal && signal.aborted) throw Object.assign(new Error('Scan cancelled'), { code: 'CANCELLED' });
    const rel = queue.shift();
    let dirents;
    try {
      dirents = fs.readdirSync(path.join(abs, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name) || (d.name.startsWith('.') && d.name !== '.github')) continue;
        queue.push(childRel);
        continue;
      }
      if (!d.isFile()) continue;
      if (fileCount >= maxFiles) {
        truncated = true;
        break walk;
      }
      fileCount += 1;
      const ext = path.extname(d.name).toLowerCase();
      if (LANG_BY_EXT[ext]) langCounts.set(LANG_BY_EXT[ext], (langCounts.get(LANG_BY_EXT[ext]) || 0) + 1);
      if (isManifest(d.name)) manifests.push(childRel);
      if (LOCKFILES[d.name]) pms.add(LOCKFILES[d.name]);
      if (PY_ENTRY.has(d.name)) entries.add(childRel);
      if (ext === '.go' && !d.name.endsWith('_test.go')) goFiles.push(childRel);
      if (d.name.endsWith('_test.go')) testSystems.add('go test');
    }
  }

  const dirOf = (m) => (m.includes('/') ? m.slice(0, m.lastIndexOf('/')) : '.');
  const join = (dir, p) => (dir === '.' ? p : `${dir}/${p}`);
  const pyText = [];

  for (const m of manifests) {
    const name = m.split('/').pop();
    const dir = dirOf(m);
    if (name === 'package.json') {
      let pkg;
      try {
        pkg = JSON.parse(readText(path.join(abs, m)));
      } catch {
        continue;
      }
      if (!pkg || typeof pkg !== 'object') continue;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      for (const [dep, label] of Object.entries(JS_FRAMEWORKS)) {
        if (dep in deps) {
          frameworks.add(label);
          if (JS_TESTS.has(label)) testSystems.add(label);
        }
      }
      if (typeof pkg.packageManager === 'string') pms.add(pkg.packageManager.split('@')[0]);
      if (pkg.scripts && typeof pkg.scripts === 'object') {
        scripts[dir] = Object.fromEntries(Object.entries(pkg.scripts).filter(([, v]) => typeof v === 'string'));
        if (scripts[dir].build) buildSystems.add('npm scripts');
        if (scripts[dir].test && !/no test specified/.test(scripts[dir].test) && testSystems.size === 0) testSystems.add('npm test');
      }
      if ('webpack' in deps) buildSystems.add('webpack');
      if ('vite' in deps) buildSystems.add('vite');
      if ('typescript' in deps) buildSystems.add('tsc');
      const found = [];
      if (typeof pkg.main === 'string') found.push(pkg.main);
      if (typeof pkg.bin === 'string') found.push(pkg.bin);
      else if (pkg.bin && typeof pkg.bin === 'object') found.push(...Object.values(pkg.bin));
      const walkExports = (v, depth = 0) => {
        if (typeof v === 'string') found.push(v);
        else if (v && typeof v === 'object' && depth < 4) Object.values(v).forEach((x) => walkExports(x, depth + 1));
      };
      walkExports(pkg.exports);
      for (const f of found) {
        if (typeof f !== 'string') continue;
        const target = join(dir, path.posix.normalize(f));
        if (!target.startsWith('..') && fs.existsSync(path.join(abs, target))) entries.add(target);
      }
    } else if (['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'].includes(name)) {
      pyText.push(readText(path.join(abs, m)).toLowerCase());
      if (name === 'pyproject.toml') {
        const t = pyText[pyText.length - 1];
        if (t.includes('[tool.poetry')) pms.add('poetry');
        if (t.includes('[tool.uv')) pms.add('uv');
        if (t.includes('[build-system]')) buildSystems.add('python build');
      }
      if (name === 'requirements.txt' || name === 'Pipfile') pms.add(name === 'Pipfile' ? 'pipenv' : 'pip');
    } else if (name === 'go.mod') {
      buildSystems.add('go modules');
      pms.add('go');
    } else if (name === 'Cargo.toml') {
      buildSystems.add('cargo');
      testSystems.add('cargo test');
      pms.add('cargo');
    } else if (name === 'pom.xml') {
      buildSystems.add('maven');
      pms.add('maven');
      if (readText(path.join(abs, m)).includes('junit')) testSystems.add('junit');
    } else if (name.startsWith('build.gradle')) {
      buildSystems.add('gradle');
      pms.add('gradle');
      if (readText(path.join(abs, m)).includes('junit')) testSystems.add('junit');
    } else if (name === 'CMakeLists.txt') {
      buildSystems.add('cmake');
      if (/enable_testing|add_test\s*\(|gtest|catch2/i.test(readText(path.join(abs, m)))) testSystems.add('ctest');
    } else if (name === 'Makefile') buildSystems.add('make');
    else if (name === 'Gemfile') pms.add('bundler');
    else if (name === 'composer.json') pms.add('composer');
    else if (name === 'Package.swift') buildSystems.add('swiftpm');
    else if (name.endsWith('.csproj')) buildSystems.add('dotnet');
  }

  const allPy = pyText.join('\n');
  for (const fw of PY_FRAMEWORKS) {
    if (new RegExp(`(^|[^a-z0-9_-])${fw}([^a-z0-9_-]|$)`).test(allPy)) {
      frameworks.add(fw);
      if (fw === 'pytest') testSystems.add('pytest');
    }
  }

  for (const f of goFiles.slice(0, 1000)) {
    if (/^\s*package\s+main\b/m.test(readText(path.join(abs, f), 4096))) entries.add(f);
  }

  const workspaces = [...new Set(manifests.map(dirOf).filter((d) => d !== '.'))].sort();
  return {
    root: abs,
    languages: [...langCounts].map(([name, files]) => ({ name, files })).sort((a, b) => b.files - a.files),
    manifests: manifests.map(posix).sort(),
    packageManagers: [...pms].sort(),
    workspaces,
    frameworks: [...frameworks].sort(),
    scripts,
    entryPoints: [...entries].sort(),
    testSystems: [...testSystems].sort(),
    buildSystems: [...buildSystems].sort(),
    fileCount,
    truncated
  };
}

module.exports = { scanProject, SKIP_DIRS };
