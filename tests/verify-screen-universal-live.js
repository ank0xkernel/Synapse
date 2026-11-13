'use strict';

// Universal screen understanding on real pixels, run inside Electron:
//
//   npm run test:screen:universal
//
// Renders self-authored pages that share nothing with each other (terminal,
// documentation site, wide spreadsheet, maths multiple-choice, two coding
// problems) in an offscreen window, and feeds the rendered frames to the real
// capture engine, Apple Vision OCR and screen session (tests/support/
// offscreen-rig.js). Then runs the Analyze Screen IPC handler on a rendered
// frame and OCRs the exact JPEGs it hands to the model.
//
// Offscreen rendering is the frame source; the display stream, macOS
// permissions and the AI model are not exercised here. Needs macOS.

const { app, BrowserWindow, ipcMain } = require('electron');
const { buildNativeOcr } = require('../scripts/build-native-ocr');
const { createOffscreenRig } = require('./support/offscreen-rig');
const { registerAssistantIpc } = require('../src/main-process/features/assistant/ipc');

const SIZE = { width: 1440, height: 900 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}

const BASE_CSS = 'html,body{margin:0;height:100%;font:16px -apple-system,Helvetica,sans-serif}pre,code{font:15px Menlo,monospace}';
const page = (title, css, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>${BASE_CSS}${css}</style>${body}`;

// Lines differ in content and length: identical repeating rows defeat any
// pixel shift estimate (by design), and no real screen looks like that.
const PAGES = {
  terminal: () => page('terminal', '#t{background:#111;color:#ddd;height:100%;overflow-y:auto;padding:16px 24px;box-sizing:border-box}pre{line-height:1.5}',
    `<div id="t"><pre>$ make test TARGET=ledger-service
${Array.from({ length: 90 }, (_, i) => `[build ${String(i + 1).padStart(3, '0')}] compiling module_${i + 1}.py ${'.'.repeat((i * 7) % 23)} ok (${(i * 13) % 97} ms)`).join('\n')}
Traceback (most recent call last):
  File "ledger/report.py", line 42, in average_balance
    return total / count
ZeroDivisionError: division by zero
$ echo terminal-end-marker-kappa</pre></div>`),

  docs: () => page('docs', 'body{display:flex}nav{width:260px;background:#f4f4f6;padding:20px;line-height:2}#a{flex:1;overflow-y:auto;padding:24px 48px;line-height:1.7}h2{margin-top:48px}',
    `<nav><b>Orbit CLI docs</b><br>Overview<br>Install<br>Auth<br>Rate limits<br>Changelog</nav><div id="a"><h1>Orbit CLI reference</h1><p>Orbit syncs local folders with remote buckets. docs-intro-marker-alpha.</p>${
      ['Installing the CLI', 'Authenticating with tokens', 'Uploading folders', 'Retry behaviour', 'Rate limits and quotas', 'Exit codes'].map((h, i) => `<h2>${h}</h2>${Array.from({ length: 6 }, (_, j) => `<p>Section ${i + 1} paragraph ${j + 1}: ${'the command honours flags and environment variables '.repeat(1 + ((i + j) % 3))}</p>`).join('')}`).join('')
    }<p>docs-end-marker-omega</p></div>`),

  sheet: () => page('sheet', '#w{margin:40px;width:900px;overflow-x:auto;border:1px solid #ccc}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:8px 14px;white-space:nowrap}',
    `<h2 style="margin:24px 40px 0">Quarterly inventory sheet</h2><div id="w"><table><tr>${Array.from({ length: 22 }, (_, c) => `<th>col_${String(c + 1).padStart(2, '0')}</th>`).join('')}</tr>${
      Array.from({ length: 8 }, (_, r) => `<tr>${Array.from({ length: 22 }, (_, c) => `<td>r${r + 1}c${c + 1}v${(r * 31 + c * 17) % 1000}</td>`).join('')}</tr>`).join('')
    }</table></div>`),

  mcq: () => page('mcq', 'body{padding:60px 120px;line-height:2}li{font-size:18px}',
    '<h2>Question 4 of 20</h2><p>Solve for x: 3x + 7 = 22. Choose one answer.</p><ol type="A"><li>x = 3</li><li>x = 5</li><li>x = 7</li><li>x = 15</li></ol><p>Time remaining 12:40</p>'),

  problemA: () => page('A', 'body{padding:40px 80px;line-height:1.8;overflow-y:auto}',
    `<h1>Problem 1: Pair With Target Sum</h1><p>Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target. Each input has exactly one solution and the same element may not be used twice.</p>${
      Array.from({ length: 8 }, (_, i) => `<h3>Example ${i + 1}</h3><pre>Input: nums = [${[i + 2, i + 7, 11 + i, 15 - i].join(', ')}], target = ${2 * i + 9}\nOutput: [0, 1]</pre>`).join('')
    }<h3>Constraints</h3><p>2 &lt;= nums.length &lt;= 10^4 and -10^9 &lt;= nums[i] &lt;= 10^9. constraint-marker-sigma</p>`),

  problemB: () => page('B', 'body{padding:40px 80px;line-height:1.8}',
    '<h1>Problem 2: Merge Overlapping Intervals</h1><p>Given a collection of closed intervals, merge every pair that overlaps and return the merged list sorted by start time. Intervals that only touch at an endpoint are considered overlapping.</p><pre>Input: [[1,3],[2,6],[8,10],[15,18]]\nOutput: [[1,6],[8,10],[15,18]]</pre><p>Constraints: 1 &lt;= intervals.length &lt;= 10^4.</p>')
};

async function main() {
  if (process.platform !== 'darwin') { console.log('skipped: needs macOS (Apple Vision OCR)'); return app.exit(0); }
  buildNativeOcr({ log: () => {} });
  const win = new BrowserWindow({ ...SIZE, show: false, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code);
  const load = async (name) => { await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGES[name]())}`); await sleep(300); };
  const scroll = (selector, prop, step, ms = 100) => js(`new Promise((done) => { const el = ${selector}; const max = '${prop}' === 'scrollTop' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth; const id = setInterval(() => { el.${prop} = Math.min(max, el.${prop} + ${step}); if (el.${prop} >= max - 1) { clearInterval(id); done(); } }, ${ms}); })`);

  let rig = null;
  const snap = () => rig.getSnapshot();
  const text = () => rig.session.buildContext({ charBudget: 400000 }).text;
  async function settle(label, timeoutMs = 60000) {
    const t0 = Date.now();
    await sleep(600); // let the engine see the last frame before judging "settled"
    while (Date.now() - t0 < timeoutMs) {
      if (snap().state === 'VIEW_FULLY_ANALYSED') return Date.now() - t0;
      await sleep(100);
    }
    console.log(`  (timeout: ${label}; state=${snap().state} message=${snap().message && snap().message.code})`);
    if (process.env.UNIVERSAL_DEBUG) dump(label);
    return null;
  }
  function dump(label) {
    const s = snap();
    console.log(`  [debug ${label}] problem=${JSON.stringify(s.problem)} view=${s.view}`);
    for (const c of s.containers) console.log(`    container ${c.id} axis=${c.axis} rect=${JSON.stringify(c.screenRect)} viewport=${JSON.stringify(c.viewport)} segments=${JSON.stringify(c.segments)}`);
    for (const r of s.regions.slice(0, 12)) console.log(`    region ${r.id} ${r.containerId} ${r.status} ${r.kind} err=${r.error && r.error.code} "${r.preview.slice(0, 60).replace(/\n/g, ' | ')}"`);
    console.log(text().slice(0, 3000));
  }
  async function session(name) {
    if (rig) { await rig.session.stop(); rig.dispose(); }
    await load(name);
    rig = createOffscreenRig(win, SIZE);
    const started = await rig.start();
    if (!started.success) throw new Error(`monitoring did not start: ${started.error}`);
    return settle(`${name} initial`);
  }

  console.log('\n— Terminal: long build log ending in a stack trace —');
  check('terminal: initial view analysed', (await session('terminal')) !== null);
  const termProblem = snap().problem && snap().problem.id;
  check('terminal: stack trace not claimed before scrolling', !/ZeroDivisionError/.test(text()));
  await scroll("document.getElementById('t')", 'scrollTop', 120);
  check('terminal: analysed again after scrolling', (await settle('terminal scroll')) !== null);
  let t = text();
  check('terminal: first command kept after scrolling away from it', /make test TARGET=ledger-service/.test(t));
  check('terminal: error line read', /ZeroDivisionError: division by zero/.test(t));
  check('terminal: end of log reached', /terminal-end-marker-kappa/.test(t));
  check('terminal: scrolling did not change the problem', (snap().problem && snap().problem.id) === termProblem, `${termProblem} -> ${snap().problem && snap().problem.id}`);

  console.log('\n— Documentation site: fixed sidebar, long article —');
  check('docs: initial view analysed', (await session('docs')) !== null);
  const docsProblem = snap().problem && snap().problem.id;
  await scroll("document.getElementById('a')", 'scrollTop', 90);
  check('docs: analysed again after scrolling', (await settle('docs scroll')) !== null);
  t = text();
  check('docs: intro kept', /docs-intro-marker-alpha/.test(t));
  check('docs: every section heading read', ['Installing the CLI', 'Authenticating with tokens', 'Uploading folders', 'Retry behaviour', 'Rate limits and quotas', 'Exit codes'].every((h) => t.includes(h)));
  check('docs: end of article reached', /docs-end-marker-omega/.test(t));
  check('docs: sidebar text kept', /Orbit CLI docs/.test(t));
  check('docs: scrolling did not change the problem', (snap().problem && snap().problem.id) === docsProblem);
  const regions = snap().metrics.regionsTotal;
  await js("new Promise((d) => { const el = document.getElementById('a'); const id = setInterval(() => { el.scrollTop = Math.max(0, el.scrollTop - 90); if (el.scrollTop === 0) { clearInterval(id); d(); } }, 100); })");
  await settle('docs reverse');
  check('docs: scrolling back over read content adds no regions', snap().metrics.regionsTotal === regions, `${regions} -> ${snap().metrics.regionsTotal}`);

  console.log('\n— Wide spreadsheet: horizontal scrolling —');
  check('sheet: initial view analysed', (await session('sheet')) !== null);
  check('sheet: far-right column not claimed before scrolling', !/col_22/.test(text()));
  await scroll("document.getElementById('w')", 'scrollLeft', 80);
  const sheetSettled = await settle('sheet scroll');
  t = text();
  check('sheet: analysed again after horizontal scroll', sheetSettled !== null);
  check('sheet: first column kept', /col_01/.test(t));
  check('sheet: far-right column read after horizontal scroll', /col_22/.test(t) && /r1c22v/.test(t));
  check('sheet: horizontal container tracked on the x axis', snap().containers.some((c) => c.id !== 'root' && c.axis === 'x'), snap().containers.map((c) => ({ id: c.id, axis: c.axis })));

  console.log('\n— Maths multiple choice —');
  check('mcq: analysed', (await session('mcq')) !== null);
  t = text();
  if (process.env.UNIVERSAL_DEBUG) dump('mcq');
  check('mcq: equation read', /3x \+ 7 = 22/.test(t));
  // Vision's spacing and letter case drift between runs ("C.X =7"): every
  // option must be there character for character, ignoring both.
  const squash = (s) => s.toLowerCase().replace(/\s+/g, '');
  check('mcq: all four options read', ['a.x=3', 'b.x=5', 'c.x=7', 'd.x=15'].every((o) => squash(t).includes(o)), t.match(/A\.[\s\S]{0,60}/)?.[0]);
  check('mcq: options are question text, not a code block', !/\[code\]/.test(t));
  check('mcq: coverage reported complete for a static screen', /Everything captured on the current screen was analysed/.test(t));

  console.log('\n— Two coding problems: scrolling vs switching —');
  check('problem A: analysed', (await session('problemA')) !== null);
  const a = snap().problem;
  check('problem A: identified', a && a.status === 'identified' && a.id, a);
  await scroll('document.scrollingElement', 'scrollTop', 70);
  check('problem A: analysed after scrolling to constraints', (await settle('A scroll')) !== null);
  t = text();
  check('problem A: statement kept while constraints read', /return indices of the two numbers/.test(t) && /constraint-marker-sigma/.test(t));
  check('problem A: scrolling kept the same problem', snap().problem.id === a.id && snap().problems.length === 1, { problem: snap().problem.id, problems: snap().problems.length });
  // Rapid jump: back to the top in one step, then to the bottom in one step.
  await js('document.scrollingElement.scrollTop = 0'); await sleep(250);
  await js('document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight');
  await settle('A rapid');
  check('problem A: rapid scrolling kept the same problem', snap().problem.id === a.id && snap().problems.length === 1);
  if (process.env.RIG_TRACE) console.log('    [trace] loading problem B');
  await load('problemB');
  await settle('B switch');
  const b = snap().problem;
  check('switch: a different problem on screen is a new problem', b && b.id && b.id !== a.id, `${a.id} -> ${b && b.id}`);
  t = text();
  check('switch: problem A text is not offered as problem B context', !/Pair With Target Sum/.test(t) && /Merge Overlapping Intervals/.test(t));
  if (process.env.RIG_TRACE) console.log('    [trace] loading problem A again');
  await load('problemA');
  if (process.env.RIG_TRACE) console.log(`    [trace] page scrollTop after load: ${await js('document.scrollingElement.scrollTop')}`);
  await settle('back to A');
  if (process.env.UNIVERSAL_DEBUG) dump('back to A');
  check('switch back: problem A is recognised, not duplicated', snap().problem.id === a.id && snap().problems.length === 2, { problem: snap().problem.id, problems: snap().problems.map((p) => p.id) });
  await rig.session.stop();
  rig.dispose();
  rig = null;

  console.log('\n— Analyze Screen payload: the JPEGs sent to the model, read back by OCR —');
  await payloadCheck();

  win.destroy();
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nUniversal screen suite: ${checks.length - failed.length} passed, ${failed.length} failed (${checks.length} total)`);
  app.exit(failed.length ? 1 : 0);
}

// Runs the real analyze-screen handler with a rendered 2400x1400 frame as the
// capture, records the parts it hands the AI service, decodes every JPEG and
// OCRs it. Proves what the model receives, not what the code intends to send.
async function payloadCheck() {
  const big = { width: 2400, height: 1400 };
  const win = new BrowserWindow({ ...big, show: false, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page('split', 'body{display:flex}#l,#r{flex:1;padding:40px;font-size:22px}#l{background:#fafafa}',
    '<div id="l"><h2>Left panel</h2><p>left-payload-marker-delta</p></div><div id="r"><h2>Right panel</h2><p>right-payload-marker-epsilon</p></div>'))}`);
  await sleep(400);
  const frame = await win.webContents.capturePage();
  win.destroy();
  const handlers = {};
  const sent = [];
  let parts = null;
  registerAssistantIpc({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, on: () => {}, removeHandler: () => {} },
    screenshotManager: {
      validateScreenCaptureCapability: async () => ({ authorized: true }),
      captureScreenInMemory: async () => ({ image: frame, meta: { captureId: 'payload', displayId: '1', ...frame.getSize(), source: 'offscreen', capturedAt: Date.now() } }),
      hasScreenshots: () => false,
      getScreenshotsCount: () => 0
    },
    windowController: {},
    geminiRuntime: {
      getActiveAiProvider: () => 'gemini', hasApiKeys: () => true, getApiKeys: () => ['k'], isAllKeysUnavailableError: () => false, cancelActive: () => false,
      executeWithKeyFailover: (op) => op({ model: {}, analyzeScreenshots: async (p) => { parts = p; return 'stub answer'; } })
    },
    assemblyAiService: { flushAllSttHistoryBuffers: () => {} },
    sendToRenderer: (ch, payload) => sent.push([ch, payload]),
    quitApplication: () => {},
    mobileServer: null,
    getScreenIntel: () => null
  });
  const result = await handlers['analyze-screen']({}, {});
  check('payload: handler succeeded', result && result.success, result);
  const images = (parts || []).filter((p) => p.inlineData);
  check('payload: full frame plus two halves for a 2400px-wide frame', images.length === 3, images.length);
  const { nativeImage } = require('electron');
  const { createOcrService, resolveOcrHelperPath } = require('../src/services/screen-intel/ocr-service');
  const ocr = createOcrService({ helperPath: resolveOcrHelperPath({ isPackaged: false }), log: () => {} });
  const readBack = [];
  for (const p of images) {
    const buf = Buffer.from(p.inlineData.data, 'base64');
    const decoded = nativeImage.createFromBuffer(buf);
    const r = await ocr.recognize({ jpeg: buf, mime: p.inlineData.mimeType }, {});
    readBack.push({ mime: p.inlineData.mimeType, jpegMagic: buf[0] === 0xff && buf[1] === 0xd8, size: decoded.getSize(), text: r.lines.map((l) => l.text).join(' ') });
  }
  ocr.dispose();
  check('payload: every part is a decodable JPEG with matching MIME', readBack.length && readBack.every((x) => x.mime === 'image/jpeg' && x.jpegMagic && x.size.width > 0), readBack.map((x) => x.size));
  check('payload: the full frame shows both panels', readBack[0] && /left-payload-marker-delta/.test(readBack[0].text) && /right-payload-marker-epsilon/.test(readBack[0].text), readBack[0] && readBack[0].text);
  check('payload: the left tile shows the left panel only', readBack[1] && /left-payload-marker-delta/.test(readBack[1].text) && !/right-payload-marker-epsilon/.test(readBack[1].text));
  check('payload: the right tile shows the right panel only', readBack[2] && /right-payload-marker-epsilon/.test(readBack[2].text) && !/left-payload-marker-delta/.test(readBack[2].text));
  check('payload: one final analysis-result and stream end, no error', sent.filter(([ch]) => ch === 'analysis-result').length === 1 && sent.some(([ch]) => ch === 'ai-stream-end') && !sent.some(([, p]) => p && p.error));
}

app.whenReady().then(main).catch((error) => {
  console.error(error);
  app.exit(1);
});
