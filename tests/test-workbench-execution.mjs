#!/usr/bin/env node
/**
 * Workbench execution layer: path guard, unified diff, file ops, command
 * runner (classification + execution), action log. Real temp dirs, real
 * processes.
 *
 * Run: node --no-warnings tests/test-workbench-execution.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveInside, toRelative } = require('../src/services/workbench/path-guard.js');
const { unifiedDiff } = require('../src/services/workbench/unified-diff.js');
const { createFileOps } = require('../src/services/workbench/file-ops.js');
const { classifyCommand, runCommand, redactSecrets } = require('../src/services/workbench/command-runner.js');
const { createActionLog } = require('../src/services/workbench/action-log.js');
const { RISKS } = require('../src/services/workbench/contracts.js');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${String(error.stack || error.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

const tmpDirs = [];
function tmp(prefix = 'wb-test-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}
const write = (dir, rel, data) => {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  return abs;
};
const code = (fn) => { try { fn(); } catch (error) { return error.code; } return null; };
const listTmp = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---------- path guard ----------
const root = tmp();
const outside = tmp('wb-outside-');
write(root, 'src/a.txt', 'a\n');
write(outside, 'secret.txt', 'nope\n');

console.log('path guard');
await test('relative path inside resolves', () => {
  assert.equal(resolveInside(root, 'src/a.txt'), path.join(root, 'src/a.txt'));
  assert.equal(resolveInside(root, '.'), root);
  assert.equal(toRelative(root, path.join(root, 'src', 'a.txt')), 'src/a.txt');
});
await test('../ escape is OUTSIDE_PROJECT', () => {
  assert.equal(code(() => resolveInside(root, '../etc/passwd')), 'OUTSIDE_PROJECT');
  assert.equal(code(() => resolveInside(root, 'src/../../x')), 'OUTSIDE_PROJECT');
  assert.equal(code(() => resolveInside(root, outside)), 'OUTSIDE_PROJECT');
  assert.equal(code(() => resolveInside(root, '../nonexistent-zzz', { mustExist: true })), 'OUTSIDE_PROJECT');
  assert.match(String(new Error(((() => { try { resolveInside(root, '../x'); } catch (e) { return e.message; } })()))), /\.\.\/x/);
});
await test('symlink escape (file, dir, and new file under symlinked dir)', () => {
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link-file'));
  fs.symlinkSync(outside, path.join(root, 'link-dir'));
  assert.equal(code(() => resolveInside(root, 'link-file')), 'OUTSIDE_PROJECT');
  assert.equal(code(() => resolveInside(root, 'link-dir/secret.txt')), 'OUTSIDE_PROJECT');
  assert.equal(code(() => resolveInside(root, 'link-dir/new/file.txt')), 'OUTSIDE_PROJECT');
});
await test('NUL byte rejected; missing is NOT_FOUND only with mustExist', () => {
  assert.equal(code(() => resolveInside(root, 'a\0b')), 'INVALID_PATH');
  assert.equal(code(() => resolveInside(root, 'nope.txt', { mustExist: true })), 'NOT_FOUND');
  assert.equal(resolveInside(root, 'new/dir/nope.txt'), path.join(root, 'new/dir/nope.txt'));
});

// ---------- unified diff ----------
console.log('unified diff');
function gitDiff(oldText, newText) {
  const dir = tmp('wb-gitdiff-');
  const args = ['diff', '--no-index', '--no-prefix', '--'];
  if (oldText !== null) write(dir, 'a/x.txt', oldText);
  if (newText !== null) write(dir, 'b/x.txt', newText);
  args.push(oldText === null ? '/dev/null' : 'a/x.txt', newText === null ? '/dev/null' : 'b/x.txt');
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  assert.ok(r.status === 0 || r.status === 1, r.stderr);
  return r.stdout.split('\n').filter((l) => !/^(diff |index |new file mode|deleted file mode|old mode|new mode)/.test(l)).join('\n');
}
// git appends a function-context heading after the closing @@; drop it.
function body(diff) { const i = diff.indexOf('@@'); return i < 0 ? '' : diff.slice(i).replace(/^(@@ [^@]+@@).*$/gm, '$1'); }
const numbered = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';
const diffCases = {
  'modify middle of a long file': [numbered(40), numbered(40, (i) => (i === 20 ? 'CHANGED' : `line ${i}`))],
  'two far-apart hunks': [numbered(60), numbered(60, (i) => (i === 5 || i === 55 ? `X${i}` : `line ${i}`))],
  'nearby changes merge into one hunk': [numbered(30), numbered(30, (i) => (i === 10 || i === 14 ? `X${i}` : `line ${i}`))],
  'insert and delete lines': ['a\nb\nc\nd\ne\nf\ng\n', 'a\nb\nNEW\nc\nd\nf\ng\n'],
  'change first line': ['one\ntwo\nthree\n', 'ONE\ntwo\nthree\n'],
  'change last line': ['one\ntwo\nthree\n', 'one\ntwo\nTHREE\n'],
  'append lines': ['a\nb\n', 'a\nb\nc\nd\n'],
  'creation': [null, 'hello\nworld\n'],
  'deletion': ['hello\nworld\n', null],
  'no trailing newline on new': ['a\nb\n', 'a\nb\nc'],
  'no trailing newline on old': ['a\nb', 'a\nb\nc\n'],
  'no trailing newline on both, last changed': ['a\nb', 'a\nB'],
  'only eol-at-eof differs': ['a\nb', 'a\nb\n'],
  'creation without trailing newline': [null, 'solo'],
  'blank lines and repeats': ['a\n\nb\n\nb\n', 'a\n\nb\n\nb\n\nc\n']
};
for (const [name, [oldText, newText]] of Object.entries(diffCases)) {
  await test(`diff matches git: ${name}`, () => {
    const mine = unifiedDiff(oldText || '', newText || '', { path: 'x.txt' });
    const ref = gitDiff(oldText, newText);
    assert.equal(body(mine), body(ref));
    if (oldText === null) assert.ok(mine.startsWith('--- /dev/null\n+++ b/x.txt\n'));
    else if (newText === null) assert.ok(mine.startsWith('--- a/x.txt\n+++ /dev/null\n'));
    else assert.ok(mine.startsWith('--- a/x.txt\n+++ b/x.txt\n'));
  });
}
await test('identical text yields empty diff', () => assert.equal(unifiedDiff('a\n', 'a\n', { path: 'x' }), ''));

// ---------- file ops ----------
console.log('file ops');
const proj = tmp('wb-proj-');
const backups = tmp('wb-bak-');
const logEntries = [];
const ops = createFileOps({ root: proj, backupDir: backups, log: { record: (e) => logEntries.push(e) } });
const bytesOf = (rel) => fs.readFileSync(path.join(proj, rel));

await test('read returns content, sha256, eol, bom, bytes', () => {
  write(proj, 'r.txt', Buffer.from('﻿hi\r\nthere\r\n'));
  const r = ops.read('r.txt');
  assert.equal(r.path, 'r.txt');
  assert.equal(r.content, 'hi\r\nthere\r\n');
  assert.equal(r.eol, '\r\n');
  assert.equal(r.bom, true);
  assert.equal(r.encoding, 'utf8');
  assert.equal(r.bytes, Buffer.byteLength('﻿hi\r\nthere\r\n'));
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
});
await test('read rejects binary, too large, outside', () => {
  write(proj, 'bin.dat', Buffer.from([1, 2, 0, 3]));
  assert.equal(code(() => ops.read('bin.dat')), 'BINARY_FILE');
  write(proj, 'big.txt', 'x'.repeat(5000));
  assert.equal(code(() => ops.read('big.txt', { maxBytes: 1000 })), 'FILE_TOO_LARGE');
  assert.equal(code(() => ops.read('../x')), 'OUTSIDE_PROJECT');
  assert.equal(code(() => ops.read('missing.txt')), 'NOT_FOUND');
});
await test('prepare replace: anchor once, diff, no write', () => {
  write(proj, 'm.txt', 'alpha\nbeta\ngamma\n');
  const p = ops.prepare({ id: 'e1', path: 'm.txt', kind: 'replace', search: 'beta', replace: 'BETA' });
  assert.equal(p.valid, true);
  assert.equal(p.after, 'alpha\nBETA\ngamma\n');
  assert.equal(p.risk, 'write');
  assert.equal(p.before.exists, true);
  assert.match(p.diff, /^--- a\/m\.txt\n\+\+\+ b\/m\.txt\n@@/);
  assert.equal(bytesOf('m.txt').toString(), 'alpha\nbeta\ngamma\n');
});
await test('prepare replace: zero and multiple anchors are invalid, not thrown', () => {
  write(proj, 'm2.txt', 'x\nx\ny\n');
  const none = ops.prepare({ id: 'e', path: 'm2.txt', kind: 'replace', search: 'zzz', replace: 'q' });
  assert.equal(none.valid, false);
  assert.equal(none.invalidCode, 'ANCHOR_NOT_FOUND');
  const many = ops.prepare({ id: 'e', path: 'm2.txt', kind: 'replace', search: 'x', replace: 'q' });
  assert.equal(many.valid, false);
  assert.equal(many.invalidCode, 'ANCHOR_AMBIGUOUS');
  assert.ok(many.invalidReason);
  assert.equal(ops.prepare({ id: 'e', path: 'nope.txt', kind: 'replace', search: 'a', replace: 'b' }).valid, false);
});
await test('prepare throws only for outside / invalid path', () => {
  assert.equal(code(() => ops.prepare({ id: 'e', path: '../x', kind: 'create', content: '' })), 'OUTSIDE_PROJECT');
  assert.equal(code(() => ops.prepare({ id: 'e', path: 'a\0b', kind: 'create', content: '' })), 'INVALID_PATH');
});
await test('CRLF file: LF anchor matches, CRLF endings kept', () => {
  write(proj, 'crlf.txt', 'one\r\ntwo\r\nthree\r\n');
  const p = ops.prepare({ id: 'c', path: 'crlf.txt', kind: 'replace', search: 'one\ntwo', replace: 'ONE\nTWO\nextra' });
  assert.equal(p.valid, true);
  assert.equal(p.after, 'ONE\r\nTWO\r\nextra\r\nthree\r\n');
  const r = ops.apply(p);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(bytesOf('crlf.txt').toString(), 'ONE\r\nTWO\r\nextra\r\nthree\r\n');
});
await test('BOM kept on replace', () => {
  write(proj, 'bom.txt', Buffer.from('﻿hello\nworld\n'));
  const p = ops.prepare({ id: 'b', path: 'bom.txt', kind: 'replace', search: 'world', replace: 'there' });
  assert.equal(p.valid, true);
  assert.ok(ops.apply(p).ok);
  const bytes = bytesOf('bom.txt');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.toString('utf8'), '﻿hello\nthere\n');
});
await test('prepare on binary file is invalid BINARY_FILE', () => {
  const p = ops.prepare({ id: 'x', path: 'bin.dat', kind: 'replace', search: 'a', replace: 'b' });
  assert.equal(p.valid, false);
  assert.equal(p.invalidCode, 'BINARY_FILE');
});
await test('apply replace: backup made, file mode kept, no tmp files', () => {
  write(proj, 'sub/mode.sh', '#!/bin/sh\necho 1\n');
  fs.chmodSync(path.join(proj, 'sub/mode.sh'), 0o755);
  const p = ops.prepare({ id: 'm1', path: 'sub/mode.sh', kind: 'replace', search: 'echo 1', replace: 'echo 2' });
  const r = ops.apply(p);
  assert.equal(r.ok, true);
  assert.equal(r.bytesWritten, Buffer.byteLength('#!/bin/sh\necho 2\n'));
  assert.equal(bytesOf('sub/mode.sh').toString(), '#!/bin/sh\necho 2\n');
  assert.equal(fs.statSync(path.join(proj, 'sub/mode.sh')).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(r.backupPath, 'utf8'), '#!/bin/sh\necho 1\n');
  assert.ok(path.basename(r.backupPath).endsWith('-m1-mode.sh'));
  assert.deepEqual(listTmp(path.join(proj, 'sub')), []);
});
await test('FILE_CHANGED on concurrent modification; file untouched; no backup', () => {
  write(proj, 'race.txt', 'one\ntwo\n');
  const p = ops.prepare({ id: 'r1', path: 'race.txt', kind: 'replace', search: 'one', replace: '1' });
  const before = fs.readdirSync(backups).length;
  fs.writeFileSync(path.join(proj, 'race.txt'), 'one\ntwo\nthree-by-someone-else\n');
  const r = ops.apply(p);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'FILE_CHANGED');
  assert.equal(bytesOf('race.txt').toString(), 'one\ntwo\nthree-by-someone-else\n');
  assert.equal(fs.readdirSync(backups).length, before);
  assert.deepEqual(listTmp(proj), []);
});
await test('FILE_CHANGED when a file prepared as create appears, or a replace target vanishes', () => {
  const c = ops.prepare({ id: 'c1', path: 'late.txt', kind: 'create', content: 'mine\n' });
  write(proj, 'late.txt', 'theirs\n');
  assert.equal(ops.apply(c).error.code, 'FILE_CHANGED');
  assert.equal(bytesOf('late.txt').toString(), 'theirs\n');
  write(proj, 'gone.txt', 'x\n');
  const p = ops.prepare({ id: 'g', path: 'gone.txt', kind: 'replace', search: 'x', replace: 'y' });
  fs.unlinkSync(path.join(proj, 'gone.txt'));
  assert.equal(ops.apply(p).error.code, 'FILE_CHANGED');
  assert.equal(fs.existsSync(path.join(proj, 'gone.txt')), false);
});
await test('apply refuses invalid prepared edit', () => {
  const p = ops.prepare({ id: 'i', path: 'm2.txt', kind: 'replace', search: 'x', replace: 'q' });
  const r = ops.apply(p);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_EDIT');
  assert.equal(bytesOf('m2.txt').toString(), 'x\nx\ny\n');
});
await test('create: parents made, ALREADY_EXISTS guard, undo removes it', () => {
  const p = ops.prepare({ id: 'n1', path: 'deep/er/new.txt', kind: 'create', content: 'fresh\n' });
  assert.equal(p.valid, true);
  assert.equal(p.before.exists, false);
  assert.match(p.diff, /^--- \/dev\/null\n\+\+\+ b\/deep\/er\/new\.txt\n/);
  const r = ops.apply(p);
  assert.equal(r.ok, true);
  assert.equal(r.backupPath, undefined);
  assert.equal(bytesOf('deep/er/new.txt').toString(), 'fresh\n');
  const u = ops.undo(r);
  assert.equal(u.ok, true, JSON.stringify(u));
  assert.equal(fs.existsSync(path.join(proj, 'deep/er/new.txt')), false);
  const dup = ops.prepare({ id: 'n2', path: 'm.txt', kind: 'create', content: 'x' });
  assert.equal(dup.valid, false);
  assert.equal(dup.invalidCode, 'ALREADY_EXISTS');
});
await test('delete: backed up, risk delete, undo is byte-identical', () => {
  const original = Buffer.from([0x68, 0x69, 0x0d, 0x0a, 0xc3, 0xa9, 0x0a]);
  write(proj, 'del.txt', original);
  const p = ops.prepare({ id: 'd1', path: 'del.txt', kind: 'delete' });
  assert.equal(p.valid, true);
  assert.equal(p.risk, 'delete');
  assert.equal(p.after, null);
  assert.match(p.diff, /^--- a\/del\.txt\n\+\+\+ \/dev\/null\n/);
  const r = ops.apply(p);
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(proj, 'del.txt')), false);
  assert.deepEqual(fs.readFileSync(r.backupPath), original);
  assert.equal(ops.undo(r).ok, true);
  assert.deepEqual(bytesOf('del.txt'), original);
  assert.equal(ops.prepare({ id: 'd2', path: 'never.txt', kind: 'delete' }).valid, false);
});
await test('undo of replace restores original bytes exactly (CRLF + BOM)', () => {
  const original = Buffer.from('﻿a\r\nb\r\n');
  write(proj, 'u.txt', original);
  const r = ops.apply(ops.prepare({ id: 'u1', path: 'u.txt', kind: 'replace', search: 'b', replace: 'B' }));
  assert.equal(r.ok, true);
  assert.notDeepEqual(bytesOf('u.txt'), original);
  assert.equal(ops.undo(r).ok, true);
  assert.deepEqual(bytesOf('u.txt'), original);
  assert.equal(ops.undo({ ok: false }).ok, false);
});
await test('create under a symlinked dir is blocked; nothing leaks outside', () => {
  fs.symlinkSync(outside, path.join(proj, 'esc'));
  assert.equal(code(() => ops.prepare({ id: 's', path: 'esc/new.txt', kind: 'create', content: 'x' })), 'OUTSIDE_PROJECT');
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
});
await test('no tmp files left anywhere in the project', () => {
  const stray = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.tmp') && stray.push(e.name)));
  walk(proj);
  assert.deepEqual(stray, []);
});
await test('log receives file.apply entries', () => {
  assert.ok(logEntries.some((e) => e.type === 'file.apply' && e.ok === true));
  assert.ok(logEntries.some((e) => e.type === 'file.apply' && e.code === 'FILE_CHANGED'));
});

// ---------- classification ----------
console.log('classification');
const croot = tmp('wb-class-');
write(croot, 'existing.txt', 'x\n');
const classify = (c, cwd = croot) => classifyCommand(c, { root: croot, cwd });
const table = [
  ['rm -rf build', 'delete', true],
  ['npm install', 'install', true],
  ['npm i lodash', 'install', true],
  ['pnpm add zod', 'install', true],
  ['bun remove x', 'install', true],
  ['pip install requests', 'install', true],
  ['npx prisma migrate dev', 'migration', true],
  ['npx prisma db push', 'migration', true],
  ['python manage.py migrate', 'migration', true],
  ['curl https://example.com', 'external', true],
  ['git push origin main', 'external', true],
  ['git status', 'read', false],
  ['git diff --stat', 'read', false],
  ['git clean -fd', 'delete', true],
  ['git reset --hard HEAD~1', 'delete', true],
  ['cd /tmp && ls', 'outside_project', true],
  ['cd .. && ls', 'outside_project', true],
  ['cat /etc/hosts', 'outside_project', true],
  ['sudo ls', 'outside_project', true],
  ['npm test', 'test', false],
  ['npm run test:unit', 'test', false],
  ['pytest -q', 'test', false],
  ['python -m pytest', 'test', false],
  ['go test ./...', 'test', false],
  ['cargo test', 'test', false],
  ['npx vitest run', 'test', false],
  ['make', 'build', false],
  ['npm run build', 'build', false],
  ['tsc --noEmit', 'build', false],
  ['ls', 'read', false],
  ['ls -la src | grep js | wc -l', 'read', false],
  ['echo hi > existing.txt', 'delete', true],
  ['echo hi > fresh.txt', 'write', false],
  ['echo hi >> existing.txt', 'write', false],
  ['echo hi > /tmp/zzz', 'outside_project', true],
  ['find . -name "*.js" -delete', 'delete', true],
  ['find . -name "*.js"', 'read', false],
  ['frobnicate --now', 'unknown', true],
  ['echo "a && rm -rf x"', 'read', false],
  ['npm test && rm -rf dist', 'delete', true],
  ['echo $(whoami)', 'unknown', true]
];
for (const [cmd, risk, explicit] of table) {
  await test(`classify: ${cmd}`, () => {
    const c = classify(cmd);
    assert.ok(c.risks.includes(risk), `risks=${c.risks} reasons=${c.reasons}`);
    assert.equal(c.requiresExplicit, explicit, `risks=${c.risks}`);
    assert.ok(c.risks.every((r) => RISKS.includes(r)));
    assert.ok(Array.isArray(c.reasons));
  });
}
await test('classify: cwd outside root flagged; cd inside is fine', () => {
  assert.ok(classify('ls', outside).risks.includes('outside_project'));
  fs.mkdirSync(path.join(croot, 'sub'), { recursive: true });
  const c = classify('cd sub && ls');
  assert.deepEqual(c.risks.filter((r) => r !== 'read'), []);
});
await test('classify: only-read pipeline is not explicit; mixed risk keeps all', () => {
  const c = classify('npm install && npm test');
  assert.ok(c.risks.includes('install') && c.risks.includes('test'));
});

// ---------- run command ----------
console.log('run command');
const rroot = tmp('wb-run-');
const run = (command, extra = {}) => runCommand({ command, cwd: '.', root: rroot, ...extra });

await test('exit 0: executed with stdout and timing fields', async () => {
  const r = await run('echo hello');
  assert.equal(r.status, 'executed');
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.trim(), 'hello');
  assert.equal(r.timedOut, false);
  assert.equal(r.cancelled, false);
  assert.equal(r.truncated, false);
  assert.equal(r.command, 'echo hello');
  assert.equal(r.cwd, rroot);
  assert.ok(r.durationMs >= 0 && Date.parse(r.startedAt) <= Date.parse(r.finishedAt));
});
await test('runs in the requested cwd', async () => {
  fs.mkdirSync(path.join(rroot, 'inner'));
  const r = await run('pwd', { cwd: 'inner' });
  assert.equal(fs.realpathSync(r.stdout.trim()), path.join(rroot, 'inner'));
});
await test('exit 3: failed, stderr captured', async () => {
  const r = await run('echo oops >&2; exit 3');
  assert.equal(r.status, 'failed');
  assert.equal(r.exitCode, 3);
  assert.equal(r.stderr.trim(), 'oops');
});
await test('missing command: failed, real "not found" stderr', async () => {
  const r = await run('definitely-not-a-real-cmd-xyz');
  assert.equal(r.status, 'failed');
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /not found|no such file/i);
});
await test('timeout kills the whole process group', async () => {
  let pid = null;
  const r = await run("sh -c 'sleep 30 & echo $!; wait'", {
    timeoutMs: 1200,
    onOutput: ({ text }) => { const m = /(\d+)/.exec(text); if (m && !pid) pid = Number(m[1]); }
  });
  assert.equal(r.timedOut, true);
  assert.equal(r.status, 'failed');
  assert.ok(r.durationMs < 8000, `took ${r.durationMs}ms`);
  assert.ok(pid, 'grandchild pid was not reported');
  await sleep(300);
  assert.equal(alive(pid), false, 'grandchild survived the timeout');
});
await test('cancel via AbortController', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 400);
  const r = await run('sleep 30', { signal: ac.signal, timeoutMs: 20000 });
  assert.equal(r.cancelled, true);
  assert.equal(r.status, 'cancelled');
  assert.equal(r.timedOut, false);
  assert.ok(r.durationMs < 8000);
  const pre = new AbortController();
  pre.abort();
  const r2 = await run('echo never', { signal: pre.signal });
  assert.equal(r2.status, 'cancelled');
  assert.equal(r2.stdout, '');
});
await test('output truncation keeps head and tail', async () => {
  const r = await run("printf START; head -c 20000 /dev/zero | tr '\\0' x; printf END", { maxOutputBytes: 1000 });
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.startsWith('START'));
  assert.ok(r.stdout.endsWith('END'));
  assert.match(r.stdout, /truncated/);
  assert.ok(r.stdout.length < 1300);
  const small = await run('echo tiny', { maxOutputBytes: 1000 });
  assert.equal(small.truncated, false);
});
await test('secrets in env are redacted from result and onOutput', async () => {
  process.env.TEST_API_KEY = 'supersecretvalue123';
  try {
    const chunks = [];
    const r = await run('echo key=$TEST_API_KEY; echo "oops $TEST_API_KEY" >&2', { onOutput: (c) => chunks.push(c.text) });
    assert.ok(!r.stdout.includes('supersecretvalue123'));
    assert.ok(!r.stderr.includes('supersecretvalue123'));
    assert.match(r.stdout, /key=\[REDACTED\]/);
    assert.ok(chunks.length > 0 && chunks.every((c) => !c.includes('supersecretvalue123')));
    const viaEnv = await run('echo $MY_SECRET_TOKEN', { env: { MY_SECRET_TOKEN: 'another-secret-xyz' } });
    assert.ok(viaEnv.stdout.trim() === '[REDACTED]', viaEnv.stdout);
    assert.equal(redactSecrets('x supersecretvalue123 y'), 'x [REDACTED] y');
    assert.ok(!redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123').includes('abcdefghijklmnopqrstuvwxyz'));
    assert.equal(redactSecrets('short'), 'short');
  } finally { delete process.env.TEST_API_KEY; }
});
await test('env override is passed to the command', async () => {
  const r = await run('echo $WB_PLAIN', { env: { WB_PLAIN: 'visible' } });
  assert.equal(r.stdout.trim(), 'visible');
});
await test('cwd outside project is rejected with OUTSIDE_PROJECT', async () => {
  await assert.rejects(run('echo hi', { cwd: outside }), { code: 'OUTSIDE_PROJECT' });
  await assert.rejects(run('echo hi', { cwd: '..' }), { code: 'OUTSIDE_PROJECT' });
  await assert.rejects(run('echo hi', { cwd: 'does-not-exist' }), { code: 'NOT_FOUND' });
});

// ---------- action log ----------
console.log('action log');
const ldir = tmp('wb-log-');
await test('append, list newest first, ts and seq', () => {
  const log = createActionLog({ filePath: path.join(ldir, 'a.jsonl') });
  log.record({ type: 'x', n: 1, runId: 'r1' });
  log.record({ type: 'x', n: 2, runId: 'r2' });
  log.record({ type: 'x', n: 3, runId: 'r1' });
  const all = log.list();
  assert.deepEqual(all.map((e) => e.n), [3, 2, 1]);
  assert.deepEqual(all.map((e) => e.seq), [3, 2, 1]);
  assert.ok(!Number.isNaN(Date.parse(all[0].ts)));
  assert.deepEqual(log.list({ runId: 'r1' }).map((e) => e.n), [3, 1]);
  assert.equal(log.list({ limit: 2 }).length, 2);
  const again = createActionLog({ filePath: path.join(ldir, 'a.jsonl') });
  assert.equal(again.record({ type: 'y' }).seq, 4);
});
await test('corrupt lines are skipped', () => {
  const file = path.join(ldir, 'c.jsonl');
  const log = createActionLog({ filePath: file });
  log.record({ n: 1 });
  fs.appendFileSync(file, '{not json\n\n[1,2\n');
  log.record({ n: 2 });
  assert.deepEqual(log.list().map((e) => e.n), [2, 1]);
});
await test('rotates to .1 beyond maxBytes and list spans both files', () => {
  const file = path.join(ldir, 'rot.jsonl');
  const log = createActionLog({ filePath: file, maxBytes: 600 });
  for (let i = 1; i <= 20; i += 1) log.record({ n: i, pad: 'p'.repeat(40) });
  assert.ok(fs.existsSync(`${file}.1`));
  assert.ok(fs.statSync(file).size < 1200);
  const rows = log.list({ limit: 1000 });
  assert.equal(rows[0].n, 20);
  assert.ok(rows.length > 5);
  assert.deepEqual(rows.map((r) => r.n), [...rows.map((r) => r.n)].sort((a, b) => b - a));
});
await test('strings truncated at 8KB and secrets redacted', () => {
  const file = path.join(ldir, 's.jsonl');
  const log = createActionLog({ filePath: file });
  process.env.TEST_LOG_PASSWORD = 'hunter2-hunter2';
  try {
    log.record({ big: 'z'.repeat(20000), nested: { cmd: 'login hunter2-hunter2' }, list: ['sk_live_' + 'a'.repeat(30)] });
  } finally { delete process.env.TEST_LOG_PASSWORD; }
  const [e] = log.list();
  assert.ok(e.big.length < 8300 && e.big.includes('truncated'));
  assert.ok(!JSON.stringify(e).includes('hunter2-hunter2'));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('sk_live_aaaa'));
});
await test('entry cannot forge ts/seq', () => {
  const log = createActionLog({ filePath: path.join(ldir, 'f.jsonl') });
  const e = log.record({ ts: 'forged', seq: 999 });
  assert.notEqual(e.ts, 'forged');
  assert.equal(e.seq, 1);
});

for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nWorkbench execution tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed ? 1 : 0);
