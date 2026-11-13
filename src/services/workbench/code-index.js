'use strict';

// Symbol and import index for one project root. JS/TS via the TypeScript
// compiler API (syntax only, no checker), Python via the real `ast` module in
// one python3 process, other languages via line regexes. Every file records
// which parser produced its data. Paths are repo-relative with forward slashes.

const fs = require('fs');
const path = require('path');
const { SKIP_DIRS } = require('./project-scanner');

const { regexParse, loadTs, tsParse, runPython, imp } = require('./code-index-parsers');

const JS_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const LANG_BY_EXT = {
  '.py': 'python', '.java': 'java', '.kt': 'kotlin', '.go': 'go', '.rs': 'rust', '.c': 'c', '.h': 'c', '.cpp': 'cpp',
  '.hpp': 'cpp', '.cc': 'cpp', '.cs': 'csharp', '.rb': 'ruby', '.php': 'php', '.swift': 'swift'
};
const langOf = (ext) => (JS_EXT.has(ext) ? (ext.startsWith('.t') ? 'typescript' : 'javascript') : LANG_BY_EXT[ext] || null);
const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'];
const PY_BINS = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'how', 'what', 'where', 'why', 'are', 'was', 'does', 'not', 'can', 'you', 'all', 'any', 'get', 'set', 'use', 'file', 'code', 'function']);

function splitName(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).map((t) => t.toLowerCase());
}
const tokenise = (q) => [...new Set(splitName(String(q || '')).filter((t) => t.length >= 3 && !STOP.has(t)))];

function createCodeIndex(root, { maxFiles = 8000, maxBytesPerFile = 512 * 1024, python = null, log = console.warn } = {}) {
  const abs = path.resolve(root);
  const files = new Map(); // rel -> { language, parser, size, symbols, imports, exports }
  const pyBin = python || PY_BINS.find((p) => fs.existsSync(p)) || null;
  const cache = new Map(); // rel -> text; insertion order is eviction order
  let cacheChars = 0;
  let graph = null;
  const CACHE_CAP = 64 * 1024 * 1024;

  const cancelled = (signal) => { if (signal && signal.aborted) throw Object.assign(new Error('Index cancelled'), { code: 'CANCELLED' }); };
  const drop = (rel) => { if (cache.has(rel)) { cacheChars -= cache.get(rel).length; cache.delete(rel); } };
  const read = (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    let text = '';
    try { text = fs.readFileSync(path.join(abs, rel), 'utf8'); } catch { return ''; }
    cache.set(rel, text);
    cacheChars += text.length;
    for (const k of cache.keys()) {
      if (cacheChars <= CACHE_CAP || k === rel) break;
      drop(k);
    }
    return text;
  };

  function walk(signal) {
    const found = [];
    const queue = [''];
    let truncated = false;
    while (queue.length && !truncated) {
      cancelled(signal);
      const rel = queue.shift();
      let dirents;
      try { dirents = fs.readdirSync(path.join(abs, rel), { withFileTypes: true }); } catch { continue; }
      for (const d of dirents) {
        const child = rel ? `${rel}/${d.name}` : d.name;
        if (d.isSymbolicLink()) continue;
        if (d.isDirectory()) {
          if (!SKIP_DIRS.has(d.name) && !d.name.startsWith('.')) queue.push(child);
        } else if (d.isFile() && langOf(path.extname(d.name).toLowerCase())) {
          if (found.length >= maxFiles) { truncated = true; break; }
          found.push(child);
        }
      }
    }
    return { found, truncated };
  }

  function parseOne(rel, size) {
    const ext = path.extname(rel).toLowerCase();
    const lang = langOf(ext);
    const text = read(rel);
    let data = null;
    let parser = 'regex';
    const ts = JS_EXT.has(ext) ? loadTs() : null;
    if (ts) {
      try { data = tsParse(ts, rel, text); parser = 'typescript'; } catch (e) { log(`[code-index] ${rel}: ${e.message}`); }
    }
    if (!data) data = regexParse(text, lang);
    files.set(rel, { language: lang, parser, size, ...data });
    drop(rel);
  }

  async function parsePython(rels, signal) {
    if (!rels.length) return;
    let result = null;
    if (pyBin) {
      try { result = await runPython(pyBin, rels.map((r) => path.join(abs, r)), signal); } catch (e) {
        if (e.code === 'CANCELLED') throw e;
        log(`[code-index] python ast unavailable, using regex: ${e.message}`);
      }
    }
    for (const rel of rels) {
      const r = result && result[path.join(abs, rel)];
      const size = files.get(rel).size;
      if (r && !r.error) {
        const symbols = r.symbols.map((s) => ({ name: s.name, kind: s.kind, startLine: s.lineno, endLine: s.end_lineno, exported: !s.name.startsWith('_'), parent: s.parent }));
        const imports = r.imports.map((i) => imp(i.module, { level: i.level, names: i.names }));
        files.set(rel, { language: 'python', parser: 'ast', size, symbols, imports, exports: symbols.filter((s) => !s.parent && s.exported).map((s) => s.name) });
      } else {
        files.set(rel, { language: 'python', parser: 'regex', size, ...regexParse(read(rel), 'python') });
      }
      drop(rel);
    }
  }

  async function ingest(rels, signal) {
    const py = [];
    for (const rel of rels) {
      cancelled(signal);
      let st = null;
      try { st = fs.statSync(path.join(abs, rel)); } catch { /* removed */ }
      drop(rel);
      const ext = path.extname(rel).toLowerCase();
      if (!st || !st.isFile() || st.size > maxBytesPerFile || !langOf(ext)) files.delete(rel);
      else if (ext === '.py') { files.set(rel, { size: st.size }); py.push(rel); } else parseOne(rel, st.size);
    }
    await parsePython(py, signal);
    graph = null;
  }

  function resolve(rel, i, lang) {
    const dir = path.posix.dirname(rel);
    const has = (p) => (files.has(p) ? p : null);
    if (lang === 'python') {
      const mod = (base, parts) => {
        const p = [base, ...parts].filter(Boolean).join('/');
        return has(`${p}.py`) || has(`${p}/__init__.py`);
      };
      const parts = i.spec ? i.spec.split('.') : [];
      const bases = i.level > 0 ? [path.posix.normalize(`${dir}/${'../'.repeat(i.level - 1)}`).replace(/^\.$|\/$/g, '')] : ['', 'src', dir];
      const out = [];
      for (const base of bases) {
        for (let n = parts.length; n >= 1; n--) {
          const hit = mod(base, parts.slice(0, n));
          if (hit) { out.push(hit); break; }
        }
        for (const nm of i.names) { const hit = mod(base, [...parts, nm]); if (hit) out.push(hit); }
        if (!parts.length && i.level > 0 && !out.length) { const hit = has(base ? `${base}/__init__.py` : '__init__.py'); if (hit) out.push(hit); }
        if (out.length) break;
      }
      return [...new Set(out)].filter((p) => p !== rel);
    }
    if (lang === 'c' || lang === 'cpp') {
      const hit = [path.posix.normalize(`${dir}/${i.spec}`), i.spec, `include/${i.spec}`, `src/${i.spec}`].find((p) => files.has(p));
      return hit ? [hit] : [];
    }
    if (!i.spec.startsWith('.')) return [];
    const base = path.posix.normalize(`${dir}/${i.spec}`);
    const stripped = base.replace(/\.(m|c)?js$/, '');
    const cands = [base, ...RESOLVE_EXTS.map((e) => base + e), ...RESOLVE_EXTS.map((e) => `${base}/index${e}`), ...(stripped !== base ? RESOLVE_EXTS.map((e) => stripped + e) : [])];
    const hit = cands.find((p) => files.has(p));
    return hit && hit !== rel ? [hit] : [];
  }

  function buildGraph() {
    if (graph) return graph;
    const forward = new Map();
    const reverse = new Map();
    for (const [rel, f] of files) {
      forward.set(rel, f.imports.map((i) => {
        const targets = resolve(rel, i, f.language);
        for (const t of targets) {
          if (!reverse.has(t)) reverse.set(t, new Set());
          reverse.get(t).add(rel);
        }
        return { specifier: '.'.repeat(i.level) + i.spec, type: i.type, resolved: targets, external: targets.length === 0 };
      }));
    }
    graph = { forward, reverse };
    return graph;
  }

  return {
    async build({ signal } = {}) {
      const t0 = Date.now();
      const { found, truncated } = walk(signal);
      files.clear();
      cache.clear();
      cacheChars = 0;
      await ingest(found, signal);
      const byParser = {};
      let symbols = 0;
      let imports = 0;
      for (const f of files.values()) {
        byParser[f.parser] = (byParser[f.parser] || 0) + 1;
        symbols += f.symbols.length;
        imports += f.imports.length;
      }
      return { files: files.size, symbols, imports, byParser, truncated, ms: Date.now() - t0 };
    },
    // Async because Python files are re-parsed by the python process.
    async update(relPaths, { signal } = {}) {
      await ingest([...new Set((relPaths || []).map((p) => String(p).split(path.sep).join('/')))], signal);
    },
    // ponytail: reads file contents per query (cached up to 64 MB); add an inverted index if repos outgrow maxFiles.
    search(query, { limit = 20 } = {}) {
      const tokens = tokenise(query);
      if (!tokens.length) return [];
      const results = [];
      for (const [rel, f] of files) {
        const symHits = [];
        const matched = new Set();
        for (const s of f.symbols) {
          const nm = s.name.toLowerCase();
          const hit = tokens.filter((t) => nm.includes(t));
          if (hit.length) { symHits.push({ s, n: hit.length }); hit.forEach((t) => matched.add(t)); }
        }
        let score = matched.size * 5;
        const pathTokens = splitName(rel);
        for (const t of tokens) if (pathTokens.some((p) => p.includes(t))) score += 3;
        const text = read(rel);
        const lower = text.toLowerCase();
        for (const t of tokens) {
          let count = 0;
          for (let at = lower.indexOf(t); at !== -1 && count < 3; at = lower.indexOf(t, at + t.length)) count++;
          score += count;
        }
        if (!score) continue;
        symHits.sort((a, b) => b.n - a.n || a.s.startLine - b.s.startLine);
        const lines = text.split('\n');
        let center = symHits.length ? symHits[0].s.startLine : 1;
        if (!symHits.length) {
          let best = 0;
          lines.forEach((l, idx) => {
            const ll = l.toLowerCase();
            const n = tokens.filter((t) => ll.includes(t)).length;
            if (n > best) { best = n; center = idx + 1; }
          });
        }
        const start = Math.max(1, center - 2);
        results.push({
          path: rel,
          score,
          symbols: symHits.slice(0, 5).map(({ s }) => ({ name: s.name, kind: s.kind, startLine: s.startLine })),
          snippet: { startLine: start, text: lines.slice(start - 1, start + 11).join('\n') }
        });
      }
      return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
    },
    symbolsIn: (rel) => (files.has(rel) ? files.get(rel).symbols.map((s) => ({ ...s })) : []),
    findSymbol(name) {
      const out = [];
      for (const [rel, f] of files) for (const s of f.symbols) if (s.name === name || (s.parent && `${s.parent}.${s.name}` === name)) out.push({ ...s, path: rel });
      return out;
    },
    importsOf: (rel) => (files.has(rel) ? buildGraph().forward.get(rel).map((e) => ({ ...e, resolved: [...e.resolved] })) : []),
    importersOf: (rel) => [...(buildGraph().reverse.get(rel) || [])].sort(),
    exportsOf: (rel) => (files.has(rel) ? [...files.get(rel).exports] : []),
    files: () => [...files].map(([rel, f]) => ({ path: rel, language: f.language, parser: f.parser, size: f.size })).sort((a, b) => a.path.localeCompare(b.path))
  };
}

module.exports = { createCodeIndex, tokenise };
