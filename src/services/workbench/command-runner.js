'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolveInside } = require('./path-guard');
const { scrubSecrets } = require('../second-brain/security-scrubber');

const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH/i;
const MIN_SECRET_LENGTH = 6;
const KILL_GRACE_MS = 3000;

/** Masks secret env values (read at call time) and well-known credential patterns. */
function redactSecrets(text, extraEnv) {
  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
  let out = text;
  const values = Object.entries({ ...process.env, ...(extraEnv || {}) })
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string' && value.length >= MIN_SECRET_LENGTH)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  for (const value of new Set(values)) out = out.split(value).join('[REDACTED]');
  return scrubSecrets(out);
}

// ---------- classification ----------

/** Splits a command line into segments of tokens; redirects become { redirect, target }. */
function tokenize(command) {
  const segments = [];
  let tokens = [];
  let buf = '';
  let quoted = false;
  let substitution = false;
  const flush = () => {
    if (buf !== '' || quoted) tokens.push({ text: buf, quoted });
    buf = ''; quoted = false;
  };
  const endSegment = () => { flush(); if (tokens.length) segments.push(tokens); tokens = []; };
  const s = String(command);
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "'") {
      quoted = true;
      const end = s.indexOf("'", i + 1);
      const stop = end === -1 ? s.length : end;
      buf += s.slice(i + 1, stop);
      i = stop;
    } else if (c === '"') {
      quoted = true;
      i += 1;
      for (; i < s.length && s[i] !== '"'; i += 1) {
        if (s[i] === '\\' && i + 1 < s.length) i += 1;
        else if (s[i] === '$' && s[i + 1] === '(') substitution = true;
        else if (s[i] === '`') substitution = true;
        buf += s[i];
      }
    } else if (c === '\\' && i + 1 < s.length) {
      buf += s[i + 1]; i += 1;
    } else if (c === '`' || (c === '$' && s[i + 1] === '(')) {
      substitution = true; buf += c;
    } else if (/\s/.test(c) && c !== '\n') {
      flush();
    } else if (c === ';' || c === '\n' || c === '|') {
      endSegment();
      if (c === '|' && s[i + 1] === '|') i += 1;
    } else if (c === '&') {
      if (/^(\d*|&)>+$/.test(buf) || s[i + 1] === '>') buf += c;
      else { endSegment(); if (s[i + 1] === '&') i += 1; }
    } else if (c === '>') {
      if (buf !== '' && !/^(\d+|&)$/.test(buf) && !/^(\d*|&)>+$/.test(buf)) flush();
      buf += c;
    } else {
      buf += c;
    }
  }
  endSegment();
  // Resolve redirect tokens (unquoted `[fd]>[>]target`).
  const resolved = segments.map((seg) => {
    const out = [];
    for (let i = 0; i < seg.length; i += 1) {
      const t = seg[i];
      const m = !t.quoted && /^(\d*|&)(>>?)(.*)$/.exec(t.text);
      if (m) {
        let target = m[3];
        if (!target && seg[i + 1]) { target = seg[i + 1].text; i += 1; }
        out.push({ redirect: m[2], target });
      } else out.push(t);
    }
    return out;
  });
  return { segments: resolved, substitution };
}

const PATH_LIKE = /^(\/|~|\.\.?(\/|$))|(^|\/)\.\.(\/|$)/;
const WRAPPERS = new Set(['time', 'nohup', 'command', 'exec', 'nice', 'env', 'builtin']);
const RUNNERS = new Set(['npx', 'bunx']);
const PKG = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const READ_CMDS = new Set(['ls', 'cat', 'pwd', 'grep', 'egrep', 'fgrep', 'rg', 'head', 'tail', 'wc', 'echo', 'printf', 'which', 'whoami', 'date', 'stat', 'file', 'du', 'df', 'tree', 'sort', 'uniq', 'diff', 'basename', 'dirname', 'realpath', 'true', 'false', 'cd']);
const PKG_INSTALL = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'un', 'ci', 'update', 'upgrade', 'link', 'unlink']);

function classifyCommand(command, { root, cwd } = {}) {
  const risks = new Set();
  const reasons = [];
  const add = (risk, reason) => { risks.add(risk); if (reason) reasons.push(`${risk}: ${reason}`); };
  const text = String(command || '');
  if (!text.trim()) add('unknown', 'empty command');
  if (text.includes('\0')) add('unknown', 'NUL byte in command');

  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch (_) { /* use as given */ }
  const insideRoot = (abs) => {
    try { resolveInside(root, abs); return true; } catch (error) { return error.code !== 'OUTSIDE_PROJECT'; }
  };
  let cur = cwd ? path.resolve(realRoot, cwd) : realRoot;
  if (root && !insideRoot(cur)) add('outside_project', `working directory ${cwd} is outside the project`);

  const checkPath = (tok) => {
    let candidate = tok;
    const eq = candidate.indexOf('=');
    if (candidate.startsWith('-') && eq !== -1) candidate = candidate.slice(eq + 1);
    if (!PATH_LIKE.test(candidate) || candidate === '/dev/null') return true;
    const abs = candidate.startsWith('~') ? path.join(process.env.HOME || '/', candidate.slice(1)) : path.resolve(cur, candidate);
    return root ? insideRoot(abs) : true;
  };

  const { segments, substitution } = tokenize(text);
  if (substitution) add('unknown', 'command substitution cannot be inspected');

  for (const seg of segments) {
    // Redirects first.
    for (const t of seg.filter((x) => x.redirect)) {
      if (!t.target || t.target.startsWith('&') || t.target === '/dev/null') continue;
      const abs = path.resolve(cur, t.target);
      if (!checkPath(t.target) || (root && !insideRoot(abs))) add('outside_project', `redirect to ${t.target} is outside the project`);
      else if (t.redirect === '>' && fs.existsSync(abs)) add('delete', `> overwrites existing ${t.target}`);
      else add('write', `redirect writes ${t.target}`);
    }
    let words = seg.filter((x) => !x.redirect).map((x) => x.text);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    while (words.length) {
      const w = path.basename(words[0]);
      if (w === 'sudo' || w === 'doas') { add('outside_project', `${w} runs with elevated privileges`); words.shift(); }
      else if (WRAPPERS.has(w) || RUNNERS.has(w)) words.shift();
      else if (w === 'bundle' && words[1] === 'exec') words = words.slice(2);
      else if ((w === 'pnpm' && ['dlx', 'exec'].includes(words[1])) || (w === 'yarn' && words[1] === 'dlx') || (w === 'bun' && words[1] === 'x')) words = words.slice(2);
      else break;
      while (words.length && /^-/.test(words[0]) && words[0] !== '-') words.shift();
      while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    }
    if (!words.length) continue;

    // Path arguments leaving the project.
    for (const arg of words.slice(1)) {
      if (!checkPath(arg)) add('outside_project', `path argument ${arg} is outside the project`);
    }
    const cmd = path.basename(words[0]);
    const args = words.slice(1);
    const sub = args.find((a) => !a.startsWith('-'));
    const has = (...names) => args.some((a) => names.includes(a));
    const before = risks.size + reasons.length;

    if (cmd === 'cd') {
      const target = args[0];
      if (!target || target === '-' || target.startsWith('~')) add('outside_project', 'cd leaves the project');
      else if (!checkPath(target)) add('outside_project', `cd ${target} leaves the project`);
      else cur = path.resolve(cur, target);
      continue;
    }

    if (['rm', 'rmdir', 'unlink', 'truncate', 'shred'].includes(cmd)) add('delete', `${cmd} removes data`);
    else if (cmd === 'find') {
      if (has('-delete') || has('rm')) add('delete', 'find with -delete or rm');
      else add('read', 'find');
    } else if (['mkdir', 'touch'].includes(cmd)) add('write', `${cmd} creates files`);
    else if (cmd === 'git') {
      let rest = args;
      while (rest.length && rest[0].startsWith('-')) rest = rest.slice(rest[0] === '-C' || rest[0] === '-c' ? 2 : 1);
      const g = rest[0];
      const gargs = rest.slice(1);
      if (['push', 'pull', 'fetch', 'clone', 'ls-remote'].includes(g)) add('external', `git ${g} uses the network`);
      else if (g === 'clean') add('delete', 'git clean removes untracked files');
      else if (g === 'reset' && gargs.includes('--hard')) add('delete', 'git reset --hard discards changes');
      else if (g === 'checkout' && (gargs.includes('--') || gargs.includes('.'))) add('delete', 'git checkout -- discards changes');
      else if (g === 'restore') add('delete', 'git restore discards changes');
      else if (g === 'stash' && ['drop', 'clear'].includes(gargs[0])) add('delete', 'git stash drop');
      else if (g === 'branch' && gargs.some((a) => /^-(D|d|-delete)$/.test(a))) add('delete', 'git branch delete');
      else if (['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'grep'].includes(g) || (g === 'branch' && !gargs.length)) add('read', `git ${g}`);
      else if (['add', 'commit', 'checkout', 'switch', 'merge', 'rebase', 'stash', 'mv', 'cherry-pick', 'tag'].includes(g)) add('write', `git ${g}`);
    } else if (PKG.has(cmd)) {
      const run = sub === 'run' || sub === 'run-script' ? args[args.indexOf(sub) + 1] : sub;
      if (cmd === 'yarn' && !sub) add('install', 'yarn install');
      else if (PKG_INSTALL.has(sub)) add('install', `${cmd} ${sub}`);
      else if (sub === 'publish') add('external', `${cmd} publish`);
      else if (sub === 'test' || sub === 't' || sub === 'tst' || (run && /^test/.test(run) && (sub === 'run' || sub === 'run-script'))) add('test', `${cmd} test`);
      else if (run && /^build/.test(run)) add('build', `${cmd} build`);
      else if (sub === 'prisma' || sub === 'knex' || sub === 'sequelize') { /* handled below via migration scan */ }
    } else if (['pip', 'pip3', 'brew', 'gem', 'poetry', 'apt', 'apt-get', 'port'].includes(cmd) && ['install', 'add', 'uninstall', 'remove', 'upgrade', 'reinstall'].includes(sub)) add('install', `${cmd} ${sub}`);
    else if (cmd === 'cargo') {
      if (['add', 'install', 'remove', 'update'].includes(sub)) add('install', `cargo ${sub}`);
      else if (sub === 'test') add('test', 'cargo test');
      else if (['build', 'check', 'clippy'].includes(sub)) add('build', `cargo ${sub}`);
      else if (sub === 'publish') add('external', 'cargo publish');
    } else if (cmd === 'go') {
      if (['get', 'install', 'mod'].includes(sub)) add('install', `go ${sub}`);
      else if (sub === 'test') add('test', 'go test');
      else if (['build', 'vet'].includes(sub)) add('build', `go ${sub}`);
    } else if (/^python[\d.]*$/.test(cmd) && has('-m') && args[args.indexOf('-m') + 1] === 'pytest') add('test', 'python -m pytest');
    else if (/^python[\d.]*$/.test(cmd) && has('-m') && args[args.indexOf('-m') + 1] === 'pip' && ['install', 'uninstall'].includes(args[args.indexOf('-m') + 2])) add('install', 'python -m pip install');
    else if (['pytest', 'py.test', 'jest', 'vitest', 'ctest', 'mocha'].includes(cmd)) add('test', cmd);
    else if (['mvn', 'mvnw', 'gradle', 'gradlew'].includes(cmd)) {
      if (['test', 'verify'].includes(sub)) add('test', `${cmd} ${sub}`);
      else if (['package', 'compile', 'build', 'assemble'].includes(sub)) add('build', `${cmd} ${sub}`);
      else if (sub === 'deploy') add('external', `${cmd} deploy`);
    } else if (cmd === 'tsc') add('build', 'tsc');
    else if (cmd === 'cmake' && has('--build')) add('build', 'cmake --build');
    else if (cmd === 'make') {
      if (['test', 'check'].includes(sub)) add('test', `make ${sub}`);
      else if (sub === 'clean') add('delete', 'make clean');
      else if (sub === 'install') add('install', 'make install');
      else add('build', 'make');
    } else if (['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ftp', 'telnet', 'vercel', 'netlify', 'fly', 'flyctl', 'heroku', 'gh', 'aws', 'gcloud', 'az', 'kubectl', 'terraform'].includes(cmd)) add('external', `${cmd} contacts external systems`);
    else if (cmd === 'docker' && ['push', 'pull', 'login'].includes(sub)) add('external', `docker ${sub}`);
    else if (cmd === 'open' && args.some((a) => /^https?:/i.test(a))) add('external', 'open opens a URL');
    else if (READ_CMDS.has(cmd)) add('read', cmd);

    // Migration tools, regardless of how they are launched.
    const joined = words.join(' ');
    if (/\bprisma\b.*\b(migrate|db\s+(push|execute|seed))\b/.test(joined)
      || /\balembic\b/.test(joined)
      || /\b(rails|rake)\b.*\bdb:/.test(joined)
      || /manage\.py\s+migrate\b/.test(joined)
      || /\bknex\b.*\bmigrate\b/.test(joined)
      || /\bsequelize(-cli)?\b.*\bdb:migrate/.test(joined)) add('migration', 'database schema migration');

    if (risks.size + reasons.length === before) add('unknown', `${cmd} is not a recognised command`);
  }
  if (!risks.size) add('unknown', 'nothing recognisable to classify');
  const list = [...risks];
  const requiresExplicit = list.some((r) => ['delete', 'install', 'migration', 'external', 'outside_project', 'unknown'].includes(r));
  return { risks: list, reasons, requiresExplicit };
}

// ---------- execution ----------

/** Keeps the first and last half of a stream within a byte budget. */
function createCapture(max) {
  const half = Math.max(1, Math.floor(max / 2));
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let total = 0;
  return {
    push(chunk) {
      total += chunk.length;
      if (head.length < half) head = Buffer.concat([head, chunk.subarray(0, half - head.length)]);
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > half) tail = tail.subarray(tail.length - half);
    },
    result() {
      if (total <= max) return { text: Buffer.concat([head, tail.subarray(tail.length - (total - head.length))]).toString('utf8'), truncated: false };
      const dropped = total - head.length - tail.length;
      return { text: `${head.toString('utf8')}\n...[${dropped} bytes truncated]...\n${tail.toString('utf8')}`, truncated: true };
    }
  };
}

function runCommand({ command, cwd, root, timeoutMs = 120000, maxOutputBytes = 200 * 1024, signal, env, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    let realCwd;
    try {
      realCwd = resolveInside(root, cwd || '.', { mustExist: true });
    } catch (error) { reject(error); return; }
    const startedAt = new Date();
    const t0 = process.hrtime.bigint();
    const base = { command: redactSecrets(String(command), env), cwd: realCwd };
    const finish = (extra) => {
      const finishedAt = new Date();
      resolve({
        ...base, exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, cancelled: false, truncated: false,
        startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
        durationMs: Number((process.hrtime.bigint() - t0) / 1000000n), ...extra
      });
    };
    if (signal && signal.aborted) { finish({ cancelled: true, status: 'cancelled' }); return; }

    const childEnv = { ...process.env, ...(env || {}) };
    if (!(env && 'ELECTRON_RUN_AS_NODE' in env)) delete childEnv.ELECTRON_RUN_AS_NODE;
    const out = createCapture(maxOutputBytes);
    const err = createCapture(maxOutputBytes);
    const lineBuf = { stdout: '', stderr: '' };
    const emit = (stream, chunk, final) => {
      if (typeof onOutput !== 'function') return;
      lineBuf[stream] += chunk;
      let piece = lineBuf[stream];
      if (!final) {
        const nl = piece.lastIndexOf('\n');
        if (nl === -1) return;
        lineBuf[stream] = piece.slice(nl + 1);
        piece = piece.slice(0, nl + 1);
      } else lineBuf[stream] = '';
      if (piece) { try { onOutput({ stream, text: redactSecrets(piece, env) }); } catch (_) { /* observer errors are ignored */ } }
    };

    let child;
    try {
      child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', String(command)], { cwd: realCwd, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ stderr: redactSecrets(error.message, env), status: 'failed' }); return;
    }

    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let spawnError = null;
    let killTimer = null;
    let timer = null;
    let graceTimer = null;
    const killGroup = (sig) => {
      try { process.kill(-child.pid, sig); } catch (_) { try { child.kill(sig); } catch (__) { /* already gone */ } }
    };
    const terminate = () => {
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    };
    const onAbort = () => { cancelled = true; terminate(); };

    const done = (exitCode, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(graceTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      emit('stdout', '', true); emit('stderr', '', true);
      const o = out.result();
      const e = err.result();
      const stderr = spawnError ? `${e.text}${e.text ? '\n' : ''}${spawnError.message}` : e.text;
      const ok = exitCode === 0 && !timedOut && !cancelled && !spawnError;
      finish({
        exitCode, signal: sig || null, stdout: redactSecrets(o.text, env), stderr: redactSecrets(stderr, env),
        timedOut, cancelled, truncated: o.truncated || e.truncated,
        status: cancelled ? 'cancelled' : ok ? 'executed' : 'failed'
      });
    };

    child.stdout.on('data', (chunk) => { out.push(chunk); emit('stdout', chunk.toString('utf8')); });
    child.stderr.on('data', (chunk) => { err.push(chunk); emit('stderr', chunk.toString('utf8')); });
    child.on('error', (error) => { spawnError = error; done(null, null); });
    child.on('close', (code, sig) => done(code, sig));
    // A daemonised grandchild can hold the pipes open; do not wait on it forever.
    child.on('exit', (code, sig) => { graceTimer = setTimeout(() => done(code, sig), 1500); });

    if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = { classifyCommand, runCommand, redactSecrets };
