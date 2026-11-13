'use strict';

// Live Mode C verification, run inside Electron.
//
//   npm run test:modec:live           offscreen: renders its own two-panel
//                                     "Campus FAQ Bot" page off screen and
//                                     feeds those frames to the real engine,
//                                     Vision OCR and session. Never shows a
//                                     window and never reads the display.
//   npm run test:modec:live -- --screen
//                                     same page in a visible window, read back
//                                     through the real screen-capture stream.
//                                     Takes over the primary display; the page
//                                     must stay frontmost for the whole run.
//
// It only ever scrolls the window it created.

const { app, BrowserWindow, desktopCapturer, ipcMain, powerMonitor, screen, systemPreferences } = require('electron');
const { buildNativeOcr } = require('../scripts/build-native-ocr');
const { createScreenIntelController } = require('../src/main-process/features/screen-intel/controller');
const { createOffscreenRig } = require('./support/offscreen-rig');

const USE_SCREEN = process.argv.includes('--screen');
const OFFSCREEN = { width: 1440, height: 900 };

const CELLS = 36;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pageHtml() {
  const tests = Array.from({ length: 24 }, (_, i) => `<li>test_case_${i + 1}_retrieve_ok</li>`).join('');
  const cells = Array.from({ length: CELLS }, (_, i) => {
    const n = i + 1;
    // Cells differ in length like a real notebook. Byte-identical cells repeat
    // every cell height, and a scroll of exactly that much is invisible to any
    // pixel comparison (estimateShift refuses periodic content by design).
    const extra = Array.from({ length: (n * 7) % 4 }, (_, j) => `limit_${n}_${j} = top_k * ${j + 2}  # ${'tune '.repeat((n + j) % 5)}\n`).join('');
    return `<div class="cell"><span class="in">In [${n}]:</span><pre># checkpoint cell ${n} alpha
${extra}def step_${n}(passages, top_k=3):
    scores = []
    for passage in passages:
        scores.append(score_${n}(passage))
    return scores[:top_k]</pre></div>
<div class="out"><pre>result ${n}: ${n * 37} rows ok</pre></div>`;
  }).join('');
  return `<!doctype html><meta charset="utf-8"><title>Mode C live fixture</title><style>
    html,body{margin:0;height:100%;font:15px -apple-system,Helvetica,sans-serif}
    body{display:flex;flex-direction:column}
    header{background:#101014;color:#fff;padding:14px 20px;font-weight:600}
    main{flex:1;display:flex;min-height:0}
    #left{width:360px;background:#0c0c10;color:#eee;overflow-y:auto;padding:20px;line-height:1.9}
    #right{flex:1;background:#fff;color:#111;overflow-y:auto;padding:24px 40px}
    pre{font:14px Menlo,monospace;margin:0;line-height:1.55}
    .cell{display:flex;gap:12px;background:#f5f5f5;border:1px solid #ddd;padding:10px;margin-top:18px}
    .in{font:14px Menlo,monospace;color:#888}.out{padding:8px 0 0 70px}
    li{margin:6px 0}
  </style><header>Campus FAQ Bot &nbsp;|&nbsp; Mode C live fixture</header><main>
  <div id="left"><h2>Campus FAQ Bot</h2><p>Your campus has a knowledge base of frequently asked questions. Complete the functions to build a basic retrieval pipeline and return a grounded answer.</p>
  <p>Use the text-embedding-3-small model for embeddings.</p><h3>Test Cases</h3><ol>${tests}</ol><p>End of question panel marker omega.</p></div>
  <div id="right"><h1>Campus FAQ Bot</h1><p>Notebook with ${CELLS} cells. Scroll to reveal every checkpoint.</p>${cells}<p>End of notebook marker zeta.</p></div></main>`;
}

async function main() {
  const report = { platform: `${process.platform} ${process.arch}`, electron: process.versions.electron, steps: [], checks: [] };
  const check = (name, ok, detail) => {
    report.checks.push({ name, ok: Boolean(ok), detail });
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  };

  report.source = USE_SCREEN ? 'screen stream' : 'offscreen page';
  console.log(`Frame source: ${report.source}`);
  const access = USE_SCREEN ? systemPreferences.getMediaAccessStatus('screen') : 'granted';
  if (USE_SCREEN) console.log(`Screen Recording permission for this Electron binary: ${access}`);
  if (access !== 'granted') {
    console.log('BLOCKED: grant Screen Recording to the Electron development binary (System Settings → Privacy & Security → Screen & System Audio Recording), then rerun.');
    app.exit(2);
    return;
  }

  buildNativeOcr({ log: console.log });
  const display = screen.getPrimaryDisplay();
  const page = USE_SCREEN
    ? new BrowserWindow({ x: display.workArea.x, y: display.workArea.y, width: display.workArea.width, height: display.workArea.height, show: true, alwaysOnTop: true, webPreferences: { backgroundThrottling: false } })
    : new BrowserWindow({ ...OFFSCREEN, show: false, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } });
  if (USE_SCREEN) {
    // A full-screen app owns its own Space; without this the page opens on
    // the desktop Space and the stream records whatever is full screen.
    page.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    page.setAlwaysOnTop(true, 'screen-saver');
    page.moveTop();
    page.focus();
  }
  await page.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pageHtml())}`);
  // Moving onto a full-screen Space animates for about a second; start reading
  // the display only once the page is what it shows.
  if (USE_SCREEN) await sleep(2500);
  const js = (code) => page.webContents.executeJavaScript(code);

  // Baseline: the existing one-shot capture path (desktopCapturer thumbnail at 2048px).
  const baseline = [];
  for (let i = 0; USE_SCREEN && i < 5; i += 1) {
    const t0 = Date.now();
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 2048, height: 1330 } });
    sources[0].thumbnail.toJPEG(88);
    baseline.push(Date.now() - t0);
  }
  report.baselineOneShotCaptureMs = baseline;

  const controller = !USE_SCREEN ? createOffscreenRig(page, OFFSCREEN) : createScreenIntelController({
    app, BrowserWindow, desktopCapturer, screen, powerMonitor, ipcMain,
    getMainWindow: () => null,
    sendToWindow: () => {},
    screenshotManager: { validateScreenCaptureCapability: async () => ({ authorized: true }) },
    geminiRuntime: { executeWithKeyFailover: async () => { throw new Error('AI fallback must not be needed in this test'); }, getActiveAiProvider: () => 'gemini' },
    log: (line) => console.log(line)
  });

  const snapshot = () => controller.getSnapshot();
  async function waitFor(predicate, timeoutMs, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (predicate(snapshot())) return Date.now() - t0;
      await sleep(100);
    }
    console.log(`  (timeout waiting for ${label}; state=${snapshot().state}, message=${snapshot().message && snapshot().message.code})`);
    return null;
  }
  const settled = (s) => s.state === 'VIEW_FULLY_ANALYSED';
  const cpu = () => app.getAppMetrics().reduce((sum, m) => sum + m.cpu.percentCPUUsage, 0);
  const memoryMb = () => Math.round(app.getAppMetrics().reduce((sum, m) => sum + m.memory.workingSetSize, 0) / 1024);
  const contextText = () => controller.session.buildContext({ charBudget: 400000 }).text;
  const cellsRead = (text) => Array.from({ length: CELLS }, (_, i) => i + 1).filter((n) => new RegExp(`checkpoint cell ${n} alpha`).test(text));

  const t0 = Date.now();
  const started = await controller.start({ displayId: display.id });
  check('monitoring starts', started.success, started.error || `${Date.now() - t0} ms`);
  if (!started.success) return finish(report, controller, page);

  const initialMs = await waitFor(settled, 30000, 'initial analysis');
  check('initial view reaches VIEW_FULLY_ANALYSED', initialMs !== null, `${initialMs} ms`);
  check('initial message is the scroll prompt', snapshot().message && snapshot().message.code === 'VIEW_ANALYSED_FIRST', snapshot().message);
  let text = contextText();
  check('initial context has the question panel and first notebook cell', /Test Cases/.test(text) && /checkpoint cell 1 alpha/.test(text));
  check('late notebook cells are not claimed before scrolling', !/checkpoint cell 30 alpha/.test(text));
  report.afterInitial = { regions: snapshot().counts, memoryMb: memoryMb() };

  app.getAppMetrics();
  await sleep(4000);
  report.idleCpuPercent = Number(cpu().toFixed(1));
  const idleRegions = snapshot().metrics.regionsTotal;
  await sleep(2000);
  check('no new regions while the screen is static', snapshot().metrics.regionsTotal === idleRegions, `${snapshot().metrics.regionsTotal} regions`);

  // Natural scrolling of the notebook: 90px every 100ms to the bottom.
  const leftBefore = text.includes('test_case_1_retrieve_ok');
  app.getAppMetrics();
  const scrollStart = Date.now();
  await js(`new Promise((done) => { const el = document.getElementById('right'); const id = setInterval(() => { el.scrollTop += 90; if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) { clearInterval(id); done(); } }, 100); })`);
  report.scrollDurationMs = Date.now() - scrollStart;
  if (process.env.MODEC_DUMP_DIR && controller.getLatestFrame) {
    const frame = await controller.getLatestFrame();
    if (frame && frame.jpeg) require('fs').writeFileSync(`${process.env.MODEC_DUMP_DIR}/after-scroll-frame.jpg`, Buffer.from(frame.jpeg));
  }
  report.scrollCpuPercent = Number(cpu().toFixed(1));
  const afterScrollMs = await waitFor(settled, 90000, 'analysis after notebook scroll');
  check('view is fully analysed again after scrolling', afterScrollMs !== null, `${afterScrollMs} ms after scroll end`);
  text = contextText();
  const read = cellsRead(text);
  report.cellsRead = read.length;
  check(`notebook checkpoints read after one pass (${read.length}/${CELLS})`, read.length >= CELLS - 1, `missing: ${Array.from({ length: CELLS }, (_, i) => i + 1).filter((n) => !read.includes(n)).join(',') || 'none'}`);
  check('end of notebook reached', /End of notebook marker zeta/.test(text));
  check('python indentation survives', /def step_20\(passages, top_k=3\):\n {4}scores = \[\]\n {4}for passage in passages:\n {8}scores\.append/.test(text), (text.match(/def step_20[\s\S]{0,160}/) || [''])[0]);
  // Geometry only: the leading spaces of each step_20 line, whatever Vision's
  // spacing inside the line. The strict check above also needs exact characters.
  const block = (text.match(/^( *)def step_20\b.*\n( *)scores =.*\n( *)for passage in passages.*\n( *)scores\s*\.\s*append.*\n( *)return\b/m) || []).slice(1).map((s) => s.length);
  check('python indentation columns are exact (0/4/4/8/4)', block.join('/') === '0/4/4/8/4', block.join('/') || 'block not found');
  check('question panel content kept while notebook scrolled', leftBefore && text.includes('test_case_1_retrieve_ok'));
  const containers = snapshot().containers.filter((c) => c.id !== 'root');
  check('notebook tracked as its own scroll container', containers.length === 1, containers.map((c) => ({ id: c.id, rect: c.screenRect })));

  // Independent second container: scroll the question panel.
  await js(`new Promise((done) => { const el = document.getElementById('left'); const id = setInterval(() => { el.scrollTop += 60; if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) { clearInterval(id); done(); } }, 100); })`);
  await waitFor(settled, 60000, 'analysis after question panel scroll');
  text = contextText();
  check('question panel end reached', /End of question panel marker omega/.test(text) && /test_case_24_retrieve_ok/.test(text));
  check('two independent containers', snapshot().containers.filter((c) => c.id !== 'root').length === 2, snapshot().containers.map((c) => c.id));
  check('notebook content unaffected by question panel scroll', cellsRead(text).length === read.length);

  // Scrolling back over covered content must not create work.
  const before = snapshot().metrics.regionsTotal;
  await js(`new Promise((done) => { const el = document.getElementById('right'); const id = setInterval(() => { el.scrollTop -= 90; if (el.scrollTop <= 900) { clearInterval(id); done(); } }, 100); })`);
  await sleep(1500);
  check('scrolling back over read content adds no regions', snapshot().metrics.regionsTotal === before, `${before} -> ${snapshot().metrics.regionsTotal}`);

  // Pause, change the screen, resume.
  await controller.session.pause();
  check('pause reports PAUSED', snapshot().state === 'PAUSED');
  await controller.session.resume();
  await waitFor((s) => s.monitoring === 'active', 5000, 'resume');
  check('resume returns to active monitoring', snapshot().monitoring === 'active', snapshot().state);

  // Opt-in soak: MODEC_SOAK_CYCLES=n scrolls the notebook fully down and up n
  // times and samples memory, ledger size and held image bytes per cycle.
  const cycles = Number(process.env.MODEC_SOAK_CYCLES || 0);
  if (cycles > 0) {
    const samples = [];
    for (let i = 0; i < cycles; i += 1) {
      await js(`new Promise((done) => { const el = document.getElementById('right'); const id = setInterval(() => { el.scrollTop += 120; if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) { clearInterval(id); done(); } }, 60); })`);
      await js(`new Promise((done) => { const el = document.getElementById('right'); const id = setInterval(() => { el.scrollTop -= 120; if (el.scrollTop <= 0) { clearInterval(id); done(); } }, 60); })`);
      await waitFor(settled, 30000, `soak cycle ${i + 1}`);
      const m = snapshot().metrics;
      samples.push({ cycle: i + 1, memoryMb: memoryMb(), regions: m.regionsTotal, imageMb: Math.round(m.imageBytes / 1048576 * 10) / 10, queue: m.queueDepth });
      console.log(`  soak ${JSON.stringify(samples[samples.length - 1])}`);
    }
    report.soak = samples;
    const first = samples[0];
    const last = samples[samples.length - 1];
    check('soak: held image bytes stay inside the 64 MB budget', samples.every((s) => s.imageMb <= 64), `${last.imageMb} MB`);
    check('soak: no new regions once the notebook is covered', last.regions === first.regions, `${first.regions} -> ${last.regions}`);
    check('soak: memory growth under 60 MB across cycles', last.memoryMb - first.memoryMb < 60, `${first.memoryMb} -> ${last.memoryMb} MB`);
  }

  if (process.env.MODEC_DUMP_DIR && !USE_SCREEN) {
    require('fs').writeFileSync(`${process.env.MODEC_DUMP_DIR}/context.txt`, contextText());
    const ledger = controller.session.buildContext({ charBudget: 400000 });
    require('fs').writeFileSync(`${process.env.MODEC_DUMP_DIR}/regions.json`, JSON.stringify(snapshot().regions.map((r) => ({
      id: r.id, c: r.containerId, s: r.status, k: r.kind, e: r.error && r.error.code, t: r.preview.slice(0, 50)
    })), null, 1) + '\n' + JSON.stringify(ledger.coverage));
    const boxes = snapshot().regions.map((r) => controller.session.getRegion(r.id)).filter((r) => r && /step_20\(/.test(r.text))
      .map((r) => ({ id: r.id, rect: r.contentRect, lines: r.lines.map((l) => ({ t: l.text, b: l.box })) }));
    require('fs').writeFileSync(`${process.env.MODEC_DUMP_DIR}/step20-boxes.json`, JSON.stringify(boxes, null, 1));
  }
  if (controller.engineMetrics) report.engine = controller.engineMetrics();
  report.final = { counts: snapshot().counts, metrics: snapshot().metrics, memoryMb: memoryMb() };
  return finish(report, controller, page);
}

async function finish(report, controller, page) {
  await controller.session.stop();
  const stopped = controller.getSnapshot();
  report.checks.push({ name: 'stop reports STOPPED', ok: stopped.state === 'STOPPED' });
  console.log(`  ${stopped.state === 'STOPPED' ? '✓' : '✗'} stop reports STOPPED`);
  controller.dispose();
  page.destroy();
  const failed = report.checks.filter((c) => !c.ok);
  console.log('\nREPORT ' + JSON.stringify({ ...report, checks: undefined }, null, 2));
  console.log(`\nLive Mode C: ${report.checks.length - failed.length} passed, ${failed.length} failed`);
  app.exit(failed.length ? 1 : 0);
}

app.whenReady().then(main).catch((error) => {
  console.error(error);
  app.exit(1);
});
