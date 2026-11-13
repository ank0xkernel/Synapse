'use strict';

// Per-language parsers for code-index: TypeScript compiler API (JS/TS), the
// python ast module (one process per batch), and line-regex fallbacks.

const path = require('path');
const { spawn } = require('child_process');

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'else', 'sizeof', 'do', 'using', 'foreach', 'when', 'elif', 'with', 'throw']);

const PY_SCRIPT = `
import ast, json, sys
out = {}
for p in json.load(sys.stdin):
    try:
        tree = ast.parse(open(p, encoding='utf-8', errors='replace').read())
    except Exception as e:
        out[p] = {'error': str(e)}
        continue
    syms, imps = [], []
    def sym(n, kind, parent=None):
        return {'name': n.name, 'kind': kind, 'lineno': n.lineno, 'end_lineno': getattr(n, 'end_lineno', n.lineno), 'parent': parent}
    for n in tree.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            syms.append(sym(n, 'function'))
        elif isinstance(n, ast.ClassDef):
            syms.append(sym(n, 'class'))
            for m in n.body:
                if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    syms.append(sym(m, 'method', n.name))
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            imps += [{'module': a.name, 'level': 0, 'names': []} for a in n.names]
        elif isinstance(n, ast.ImportFrom):
            imps.append({'module': n.module or '', 'level': n.level, 'names': [a.name for a in n.names]})
    out[p] = {'symbols': syms, 'imports': imps}
json.dump(out, sys.stdout)
`;

// Decl rule: [regex, kind, name group, optional kind group]; matched per line.
const C_FN = [/^[A-Za-z_][\w:<>*&\s,]*?[\s*&]((?:\w+::)?\w+)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{?\s*$/, 'function', 1];
const JAVA_M = [/^\s+(?:(?:public|private|protected|static|final|abstract|synchronized|override|async)\s+)+[\w<>\[\],.? ]+\s+(\w+)\s*\([^;]*\)\s*(?:throws [\w., ]+)?\s*\{?\s*$/, 'method', 1];
const TYPES = (kw) => [new RegExp(`^\\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|data|open|export|pub)\\s+)*(${kw})\\s+(\\w+)`), 'class', 2, 1];
const JS_DECLS = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/, 'function', 1],
  [/^\s*(?:export\s+)?(?:abstract\s+)?(class)\s+(\w+)/, 'class', 2, 1],
  [/^\s*(?:export\s+)?(interface)\s+(\w+)/, 'interface', 2, 1],
  [/^\s*(?:export\s+)?type\s+(\w+)\s*=/, 'type', 1],
  [/^\s*(?:export\s+)?(?:const\s+)?enum\s+(\w+)/, 'enum', 1],
  [/^\s*(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/, 'function', 1]
];
const REGEX_LANGS = {
  javascript: { decls: JS_DECLS, imports: [/\bfrom\s+['"]([^'"]+)['"]/g, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g] },
  python: { decls: [[/^(\s*)(?:async\s+)?def\s+(\w+)/, 'function', 2], [/^(class)\s+(\w+)/, 'class', 2, 1]], imports: [] },
  java: { decls: [TYPES('class|interface|enum|record'), JAVA_M], imports: [] },
  kotlin: { decls: [[/^\s*(?:(?:private|public|internal|override|suspend|inline)\s+)*fun\s+(?:<[^>]+>\s*)?(?:[\w.]+\.)?(\w+)/, 'function', 1], TYPES('class|interface|object')], imports: [] },
  go: { decls: [[/^func\s+(?:\([^)]*\)\s*)?(\w+)/, 'function', 1], [/^type\s+(\w+)\s+(?:struct|interface)/, 'type', 1]], imports: [] },
  rust: { decls: [[/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, 'function', 1], TYPES('struct|enum|trait')], imports: [] },
  c: { decls: [C_FN, TYPES('struct|enum')], imports: [] },
  cpp: { decls: [C_FN, TYPES('class|struct|enum|namespace')], imports: [] },
  csharp: { decls: [TYPES('class|interface|struct|enum|record'), JAVA_M], imports: [] },
  ruby: { decls: [[/^\s*def\s+(?:self\.)?(\w+[?!]?)/, 'function', 1], TYPES('class|module')], imports: [] },
  php: { decls: [[/^\s*(?:(?:public|private|protected|static)\s+)*function\s+(\w+)/, 'function', 1], TYPES('class|interface|trait')], imports: [] },
  swift: { decls: [[/^\s*(?:(?:public|private|internal|open|static|final|override)\s+)*func\s+(\w+)/, 'function', 1], TYPES('class|struct|enum|protocol|extension')], imports: [] }
};
REGEX_LANGS.typescript = REGEX_LANGS.javascript;

const imp = (spec, extra = {}) => ({ spec, level: 0, names: [], type: 'import', ...extra });

// End line by brace matching (brace languages) or indentation (python).
function endLineOf(lines, i, lang) {
  if (lang === 'python') {
    const indent = lines[i].match(/^\s*/)[0].length;
    let end = i;
    for (let j = i + 1; j < lines.length && j < i + 2000; j++) {
      if (!lines[j].trim()) continue;
      if (lines[j].match(/^\s*/)[0].length <= indent) break;
      end = j;
    }
    return end + 1;
  }
  let depth = 0;
  let seen = false;
  for (let j = i; j < lines.length && j < i + 2000; j++) {
    for (const ch of lines[j]) {
      if (ch === '{') { depth++; seen = true; } else if (ch === '}') depth--;
    }
    if (seen && depth <= 0) return j + 1;
    if (!seen && j > i && /;\s*$/.test(lines[j])) break;
  }
  return i + 1;
}

function regexParse(text, lang) {
  const spec = REGEX_LANGS[lang];
  const lines = text.split('\n');
  const symbols = [];
  const imports = [];
  lines.forEach((line, i) => {
    const comment = lang === 'python' || lang === 'ruby' ? /^\s*#/ : /^\s*(\/\/|\*|\/\*)/;
    if (comment.test(line)) return;
    for (const [re, kind, g, kg] of spec.decls) {
      const m = re.exec(line);
      if (!m || KEYWORDS.has(m[g])) continue;
      let k = kg ? m[kg] : kind;
      if (lang === 'python' && k === 'function' && m[1]) k = 'method';
      if (lang === 'go' && k === 'function' && /^func\s+\(/.test(line)) k = 'method';
      const exported = lang === 'python' ? !m[g].startsWith('_') : lang === 'go' ? /^[A-Z]/.test(m[g]) : /\b(export|pub|public)\b/.test(line);
      symbols.push({ name: m[g], kind: k, startLine: i + 1, endLine: endLineOf(lines, i, lang), exported, parent: null });
      break;
    }
    for (const re of spec.imports) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) imports.push(imp(m[1]));
    }
    if (lang === 'python') {
      let m = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)$/.exec(line);
      if (m) imports.push(imp(m[2], { level: m[1].length, names: m[3].replace(/[()]/g, '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean) }));
      else if ((m = /^\s*import\s+([\w., ]+)/.exec(line))) m[1].split(',').forEach((s) => imports.push(imp(s.trim().split(/\s+as\s+/)[0])));
    } else if (lang === 'c' || lang === 'cpp') {
      const m = /^\s*#\s*include\s+"([^"]+)"/.exec(line);
      if (m) imports.push(imp(m[1], { type: 'include' }));
    }
  });
  return { symbols, imports, exports: symbols.filter((s) => s.exported).map((s) => s.name) };
}

let tsMod;
function loadTs() {
  if (tsMod === undefined) {
    try { tsMod = require('typescript'); } catch { tsMod = null; }
  }
  return tsMod;
}

function tsParse(ts, rel, text) {
  const ext = path.extname(rel);
  const kind = { '.tsx': ts.ScriptKind.TSX, '.jsx': ts.ScriptKind.JSX, '.ts': ts.ScriptKind.TS }[ext] || ts.ScriptKind.JS;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  const symbols = [];
  const imports = [];
  const exports = new Set();
  const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const isExp = (n) => (ts.canHaveModifiers(n) ? ts.getModifiers(n) || [] : []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const add = (n, name, k, exported) => {
    symbols.push({ name, kind: k, startLine: line(n.getStart(sf)), endLine: line(n.getEnd()), exported, parent: null });
    if (exported) exports.add(name);
  };
  const str = (n) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);
  const isFn = (n) => n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) add(st, st.name.text, 'function', isExp(st));
    else if (ts.isClassDeclaration(st) && st.name) {
      add(st, st.name.text, 'class', isExp(st));
      for (const m of st.members) {
        if (m.name && !ts.isComputedPropertyName(m.name) && (ts.isMethodDeclaration(m) || (ts.isPropertyDeclaration(m) && isFn(m.initializer)))) {
          symbols.push({ name: m.name.getText(sf), kind: 'method', startLine: line(m.getStart(sf)), endLine: line(m.getEnd()), exported: false, parent: st.name.text });
        }
      }
    } else if (ts.isInterfaceDeclaration(st)) add(st, st.name.text, 'interface', isExp(st));
    else if (ts.isTypeAliasDeclaration(st)) add(st, st.name.text, 'type', isExp(st));
    else if (ts.isEnumDeclaration(st)) add(st, st.name.text, 'enum', isExp(st));
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && (isFn(d.initializer) || isExp(st))) add(d, d.name.text, isFn(d.initializer) ? 'function' : 'const', isExp(st));
      }
    } else if (ts.isExportDeclaration(st)) {
      const from = str(st.moduleSpecifier);
      if (from) imports.push(imp(from, { type: 'export-from' }));
      if (st.exportClause && ts.isNamedExports(st.exportClause)) st.exportClause.elements.forEach((e) => exports.add(e.name.text));
      else if (from) exports.add('*');
    } else if (ts.isExportAssignment(st)) exports.add('default');
    else if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const l = st.expression.left.getText(sf);
      const r = st.expression.right;
      if (l === 'module.exports' && ts.isObjectLiteralExpression(r)) r.properties.forEach((p) => p.name && exports.add(p.name.getText(sf)));
      else if (l === 'module.exports') exports.add('default');
      else if (/^(module\.)?exports\.\w+$/.test(l)) exports.add(l.split('.').pop());
    }
  }
  const visit = (n) => {
    if (ts.isImportDeclaration(n)) {
      const s = str(n.moduleSpecifier);
      if (s) imports.push(imp(s));
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const s = str(n.moduleReference.expression);
      if (s) imports.push(imp(s, { type: 'require' }));
    } else if (ts.isCallExpression(n) && n.arguments.length >= 1 && str(n.arguments[0])) {
      if (ts.isIdentifier(n.expression) && n.expression.text === 'require') imports.push(imp(str(n.arguments[0]), { type: 'require' }));
      else if (n.expression.kind === ts.SyntaxKind.ImportKeyword) imports.push(imp(str(n.arguments[0]), { type: 'dynamic' }));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const s of symbols) if (!s.parent && exports.has(s.name)) s.exported = true;
  return { symbols, imports, exports: [...exports] };
}

function runPython(bin, absPaths, signal, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-I', '-c', PY_SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'] });
    const out = [];
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(v);
    };
    const onAbort = () => { child.kill('SIGKILL'); finish(reject, Object.assign(new Error('Index cancelled'), { code: 'CANCELLED' })); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, new Error('python timed out')); }, timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort);
    child.stdout.on('data', (d) => out.push(d));
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      if (code !== 0) return finish(reject, new Error(`python exited ${code}`));
      try { finish(resolve, JSON.parse(Buffer.concat(out).toString('utf8'))); } catch (e) { finish(reject, e); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(absPaths));
  });
}

module.exports = { regexParse, loadTs, tsParse, runPython, imp };
