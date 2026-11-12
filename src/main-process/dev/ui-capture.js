'use strict';

/**
 * Development-only screenshot capture of the real assistant window.
 *
 *   SYNAPSE_UI_CAPTURE=/abs/out/dir npm start
 *
 * Each scene drives the actual renderer (real DOM, real IPC event handlers:
 * the streamed answer goes through the same ai-stream-* channels Gemini uses)
 * and saves a PNG via webContents.capturePage(). The app quits when done.
 * Never runs unless the environment variable is set.
 */

const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ANSWER_CHUNKS = [
  'I\'d use a **token bucket** per API key, stored in Redis so every gateway node shares the same counts.\n\n',
  '- Each request takes one token; tokens refill at the plan\'s rate, so short bursts are allowed up to the bucket size.\n',
  '- The check-and-decrement runs as one Lua script, which keeps it atomic across nodes.\n',
  '- Over the limit returns **429** with a `Retry-After` header.\n\n',
  '```python\n# refill based on elapsed time, then take one token\ntokens = min(capacity, tokens + elapsed * rate)\nallowed = tokens >= 1\n```\n'
];

async function disableAutoAnswer(win) {
  await win.webContents.executeJavaScript(js(() => {
    const toggle = document.getElementById('auto-answer-toggle');
    if (toggle && toggle.getAttribute('aria-pressed') === 'true') toggle.click();
  }));
}

function js(fn, ...args) {
  return `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(',')})`;
}

const SCENES = {
  async home() {},

  async interactions({ win }) {
    const run = (fn) => win.webContents.executeJavaScript(js(fn));
    const assert = (ok, message) => { if (!ok) throw new Error(message); };
    await run(() => document.getElementById('context-summary').click());
    await sleep(250);
    assert(await run(() => !document.getElementById('context-panel').classList.contains('hidden')), 'Context summary did not open editor');
    await run(() => document.getElementById('close-context').click());
    await run(() => document.getElementById('session-details').click());
    assert(await run(() => !document.getElementById('status-panel').classList.contains('hidden')), 'Session details did not open');
    await run(() => document.getElementById('close-status').click());
    await run(() => document.getElementById('settings-btn').click());
    await sleep(250);
    assert(await run(() => document.getElementById('settings-panel').contains(document.activeElement)), 'Settings did not receive focus');
    await run(() => { const body = document.querySelector('#settings-panel .sheet-body'); body.scrollTop = body.scrollHeight; });
    assert(await run(() => document.querySelector('#settings-panel .sheet-body').scrollTop > 0), 'Settings cannot scroll');
    await run(() => document.getElementById('close-settings').click());
    win.focus();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'k', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'k', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    await sleep(100);
    assert(await run(() => document.activeElement.id === 'chat-manual-input'), 'Command shortcut did not focus composer');
    const bounds = win.getBounds();
    await run(async () => { const b = await window.electronAPI.getWindowBounds(); await window.electronAPI.setWindowBounds({ ...b, x: b.x + 10, width: b.width - 20 }); });
    assert(win.getBounds().width === bounds.width - 20, 'Resize IPC did not change bounds');
    win.setBounds(bounds);
    assert(win.isAlwaysOnTop(), 'Always-on-top was lost');
    await run(() => document.getElementById('compact-mode-btn').click());
    await sleep(200);
    assert(await run(() => document.getElementById('app').classList.contains('compact-mode')), 'Compact mode failed');
    await run(() => document.getElementById('compact-mode-btn').click());
    await sleep(200);
    assert(await run(() => !document.getElementById('app').classList.contains('compact-mode')), 'Compact restore failed');
    console.log('[ui-capture] interaction assertions passed: context, session, focus, scroll, command shortcut, bounds IPC, always-on-top, compact restore');
  },

  // Mode C in the real renderer: session snapshots arrive on the same
  // screen-intel:state channel the controller uses. Checks the bar renders,
  // and that switching problems excludes the earlier answer from AI context.
  async 'screen-intel'({ win, send }) {
    const run = (fn) => win.webContents.executeJavaScript(js(fn));
    const assert = (ok, message) => { if (!ok) throw new Error(message); };
    const t = Date.now();
    const snap = (problem, message) => ({
      sessionId: 'ss-demo', state: 'VIEW_FULLY_ANALYSED', monitoring: 'active', view: 'analysed', message,
      startedAt: t - 60000, lastCaptureAt: t - 2000, lastAnalysisAt: t - 1500, analysingSince: null, lastAnalysisDurationMs: 140,
      counts: { analysed: 9, analysing: 0, captured: 0, new: 0, pending: 1, failed: 0, inaccessible: 1, stale: 0, superseded: 2, cancelled: 0, gaps: 0 },
      containers: [
        { id: 'c2', label: 'Panel 2 (left, x=0..400)', gaps: 0, segments: [{ id: 0, cells: [{ start: 0, end: 800, status: 'analysed', regionId: 'r1' }, { start: 800, end: 1100, status: 'pending', regionId: 'r2' }] }] },
        { id: 'c1', label: 'Panel 3 (right, x=432..1440)', gaps: 0, segments: [{ id: 0, cells: [{ start: 0, end: 2400, status: 'analysed', regionId: 'r3' }, { start: 2400, end: 2600, status: 'inaccessible', regionId: null }] }] }
      ],
      regions: [], metrics: {}, error: null, problem
    });
    await disableAutoAnswer(win);
    send('screen-intel:state', snap({ id: 'p1', title: 'Campus FAQ Bot', status: 'identified', changedAt: t - 60000 },
      { code: 'VIEW_ANALYSED_FIRST', text: 'Current screen fully analysed.', hint: 'Scroll to analyse more content.' }));
    await sleep(200);
    assert(await run(() => !document.getElementById('screen-intel').hidden), 'Screen intelligence bar stayed hidden');
    assert(await run(() => document.getElementById('screen-intel-primary').textContent === 'Current screen fully analysed.'), 'Bar message not rendered');
    await win.webContents.executeJavaScript(js(() => window.__synapseBeginDemoStream?.()));
    send('ai-stream-chunk', { actionId: 'askAi', text: 'Answer about the Campus FAQ Bot: rank passages by cosine similarity.', index: 1 });
    await win.webContents.executeJavaScript(js(() => window.__synapseEndDemoStream?.(true)));
    await sleep(200);
    send('screen-intel:state', snap({ id: 'p2', title: 'Matrix Spiral Order', status: 'identified', changedAt: t },
      { code: 'NEW_ANALYSED', text: 'New content analysed.', hint: 'Scroll to continue.' }));
    await sleep(300);
    await run(() => document.getElementById('screen-intel-toggle').click());
    await sleep(200);
    assert(await run(() => document.getElementById('screen-intel-problem').textContent.includes('Matrix Spiral Order')), 'Active problem not shown');
    assert(await run(() => document.querySelectorAll('.screen-intel-map').length === 2), 'Coverage maps not rendered per panel');
    assert(await run(() => [...document.querySelectorAll('.system-message')].some((el) => /Screen moved to “Matrix Spiral Order”/.test(el.textContent))), 'No problem-change notice');
    assert(await run(() => {
      const answer = [...document.querySelectorAll('.ai-response-message')].find((el) => /Campus FAQ Bot/.test(el.textContent));
      return Boolean(answer && answer.classList.contains('ai-excluded'));
    }), 'Earlier answer still included in AI context after the switch');
    console.log('[ui-capture] screen-intel assertions passed: bar renders, problem shown, per-panel maps, switch notice, earlier answer excluded');
  },

  // Real end-to-end Analyze: real capture, Vision OCR and provider call. A
  // known image (the Newton fixture) is shown full screen first so only that
  // reaches the provider. Opt-in: needs Screen Recording and a provider key.
  async 'real-analyze'({ win }) {
    const { BrowserWindow, screen } = require('electron');
    const run = (fn) => win.webContents.executeJavaScript(js(fn));
    const assert = (ok, message) => { if (!ok) throw new Error(message); };
    const display = screen.getPrimaryDisplay();
    const fixture = path.join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'newton-campus-faq', 'frame-2-scrolled.png');
    const cover = new BrowserWindow({ ...display.bounds, frame: false, show: true, backgroundColor: '#000', webPreferences: { sandbox: true } });
    cover.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    cover.setAlwaysOnTop(true, 'floating');
    // Loaded as a file: a data: page may not reference file:// images.
    await cover.loadFile(fixture);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
    await sleep(2500);
    await disableAutoAnswer(win);
    const t0 = Date.now();
    await run(() => document.getElementById('analyze-screen-btn').click());
    let answer = '';
    for (let i = 0; i < 90 && !answer; i += 1) {
      await sleep(500);
      answer = await run(() => {
        const cards = [...document.querySelectorAll('.ai-response-message')];
        const last = cards[cards.length - 1];
        return last && !last.classList.contains('streaming') && /\S{20,}/.test(last.textContent) && !document.getElementById('analyze-screen-btn').disabled ? last.textContent : '';
      });
    }
    const elapsed = Date.now() - t0;
    const bar = await run(() => ({ hidden: document.getElementById('screen-intel').hidden, primary: document.getElementById('screen-intel-primary').textContent }));
    console.log(`[ui-capture] real-analyze: answer after ${elapsed} ms, ${answer.length} chars, mentions retrieve_passages=${/retrieve_passages/.test(answer)}; bar=${JSON.stringify(bar)}`);
    assert(answer, 'no answer arrived within 45 s');
    assert(!bar.hidden, 'monitoring bar did not appear after Analyze');
    await run(() => document.getElementById('screen-intel-stop').click());
    await sleep(800);
    const stopped = await run(() => document.getElementById('screen-intel-pause').hidden);
    assert(stopped, 'Stop did not stop monitoring');
    console.log('[ui-capture] real-analyze assertions passed: real capture -> OCR -> provider answer, bar live, Stop works');
    cover.destroy();
  },

  // Packaged-app smoke for Mode C: real capture stream and the bundled Vision
  // helper, started through the real preload API. No provider call.
  async 'modec-smoke'({ win }) {
    const run = (fn) => win.webContents.executeJavaScript(js(fn));
    const assert = (ok, message) => { if (!ok) throw new Error(message); };
    const started = await run(() => window.electronAPI.screenIntelStart({}));
    assert(started && started.success, `start failed: ${JSON.stringify(started)}`);
    let state = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(500);
      state = await run(() => window.electronAPI.screenIntelGetState());
      if (state && state.view === 'analysed') break;
    }
    const metrics = await run(() => window.electronAPI.screenIntelGetMetrics());
    console.log(`[ui-capture] modec-smoke: state=${state && state.state} view=${state && state.view} analysed=${state && state.counts.analysed} problem=${JSON.stringify(state && state.problem)} ocrEngine=${metrics && metrics.ocrEngine} ocr=${JSON.stringify(metrics && metrics.ocr)}`);
    assert(state && state.view === 'analysed' && state.counts.analysed > 0, 'screen was not analysed');
    assert(metrics && metrics.ocrEngine === 'vision', `OCR engine is ${metrics && metrics.ocrEngine}, expected the bundled Vision helper`);
    assert(metrics.engine && metrics.engine.streamOpen === true, 'stream not open while monitoring');
    // Pause must release the screen stream (macOS recording indicator off).
    await run(() => window.electronAPI.screenIntelPause());
    await sleep(400);
    const paused = await run(() => window.electronAPI.screenIntelGetMetrics());
    assert(paused.engine && paused.engine.streamOpen === false, 'screen stream still open while paused');
    await run(() => window.electronAPI.screenIntelResume());
    await sleep(1500);
    const resumed = await run(() => window.electronAPI.screenIntelGetMetrics());
    const resumedState = await run(() => window.electronAPI.screenIntelGetState());
    assert(resumed.engine && resumed.engine.streamOpen === true && resumedState.monitoring === 'active', 'resume did not reopen the stream');
    console.log(`[ui-capture] modec-smoke: pause released the stream, resume reopened it (state=${resumedState.state})`);
    await run(() => window.electronAPI.screenIntelStop());
    await sleep(500);
    const after = await run(() => window.electronAPI.screenIntelGetState());
    assert(after.monitoring === 'stopped', 'monitoring did not stop');
    console.log('[ui-capture] modec-smoke assertions passed: real capture, bundled Vision OCR, analysed, stopped');
  },

  async 'light-home'({ win }) {
    await win.webContents.executeJavaScript(js(() => { document.documentElement.dataset.theme = 'light'; }));
  },
  async 'light-answer'(args) {
    await SCENES.answer(args);
    await args.win.webContents.executeJavaScript(js(() => { document.documentElement.dataset.theme = 'light'; }));
  },
  async 'light-settings'(args) {
    await SCENES.settings(args);
    await args.win.webContents.executeJavaScript(js(() => { document.documentElement.dataset.theme = 'light'; }));
  },
  async appearance({ win }) {
    await SCENES.settings({ win });
    await win.webContents.executeJavaScript(js(() => document.getElementById('theme-toggle-btn')?.scrollIntoView({ block: 'center' })));
  },

  async answer({ win, send }) {
    await disableAutoAnswer(win);
    send('vosk-final', { source: 'system', text: 'How would you design a rate limiter for a public API with bursty traffic?' });
    await sleep(2500); // the transcript buffer commits the question after a short pause
    await win.webContents.executeJavaScript(js(() => window.__synapseBeginDemoStream?.()));
    for (let index = 0; index < ANSWER_CHUNKS.length; index += 1) {
      send('ai-stream-chunk', { actionId: 'askAi', text: ANSWER_CHUNKS[index], index: index + 1 });
      await sleep(60);
    }
    await win.webContents.executeJavaScript(js(() => window.__synapseEndDemoStream?.(true)));
    await sleep(400);
    await win.webContents.executeJavaScript(js(() => { document.getElementById('chat-messages').scrollTop = 0; }));
  },

  async streaming({ win, send }) {
    await disableAutoAnswer(win);
    send('vosk-final', { source: 'system', text: 'Tell me about a time you disagreed with a teammate.' });
    await sleep(2500);
    await win.webContents.executeJavaScript(js(() => window.__synapseBeginDemoStream?.()));
    send('ai-stream-chunk', { actionId: 'askAi', text: '**Situation**: on the payments team, a teammate wanted to ', index: 1 });
    await sleep(300);
  },

  async settings({ win }) {
    await win.webContents.executeJavaScript(js(() => document.getElementById('settings-btn')?.click()));
  },

  async onboarding({ win }) {
    await win.webContents.executeJavaScript(js(() => window.__synapseOpenOnboarding?.()));
  },

  async context({ win }) {
    await win.webContents.executeJavaScript(js(() => window.__synapseOpenContext?.()));
  },

  async 'context-profile'({ win }) {
    await win.webContents.executeJavaScript(js(() => window.__synapseOpenContext?.()));
    await sleep(800);
    await win.webContents.executeJavaScript(js(() => {
      document.getElementById('ctx-profile-title')?.scrollIntoView({ block: 'start' });
    }));
  },

  async 'context-match'({ win }) {
    await win.webContents.executeJavaScript(js(() => window.__synapseOpenContext?.()));
    await sleep(800);
    await win.webContents.executeJavaScript(js(() => {
      document.getElementById('ctx-jd-title')?.scrollIntoView({ block: 'start' });
    }));
  },

  async status({ win }) {
    await win.webContents.executeJavaScript(js(() => window.__synapseOpenStatus?.()));
  },

  async compact({ win }) {
    await win.webContents.executeJavaScript(js(() => document.getElementById('compact-mode-btn')?.click()));
  },

  /**
   * Real end-to-end check: presses Listen in the real UI, so native capture
   * and the AssemblyAI connection run with the app's own saved settings, then
   * speaks a question through the current output device.
   */
  async listen({ win }) {
    await win.webContents.executeJavaScript(js(() => document.getElementById('transcription-toggle')?.click()));
    await sleep(4000);
    await new Promise((resolve) => require('child_process').execFile('say', ['How would you design a rate limiter for a public API?'], resolve));
    await sleep(5000);
  },

  /**
   * Load scenario for profiling: ~25 s of live transcription (partials at
   * 10 Hz, a final every 3 s, as AssemblyAI delivers them) while a long
   * answer streams at ~25 chunks/s.
   */
  async stress({ win, send }) {
    await disableAutoAnswer(win);
    const words = 'so the way I would approach this is to start with the data model and then think about how the queries scale under load'.split(' ');
    const hasDemoStream = await win.webContents.executeJavaScript(js(() => typeof window.__synapseBeginDemoStream === 'function'));
    if (hasDemoStream) await win.webContents.executeJavaScript(js(() => window.__synapseBeginDemoStream()));
    for (let tick = 0; tick < 250; tick += 1) {
      const text = words.slice(0, (tick % 30) + 1).join(' ');
      send('vosk-partial', { source: 'system', text });
      if (tick % 30 === 29) send('vosk-final', { source: 'system', text: `${text}?` });
      if (hasDemoStream) {
        send('ai-stream-chunk', { actionId: 'askAi', text: `word${tick} and `, index: tick * 2 });
        send('ai-stream-chunk', { actionId: 'askAi', text: tick % 20 === 19 ? 'done.\n\n- a point\n' : 'more ', index: tick * 2 + 1 });
      }
      await sleep(100);
    }
  },

  /** Real Listen attempt, then the Session panel as the user would open it. */
  async 'listen-status'({ win }) {
    await SCENES.listen({ win });
    await win.webContents.executeJavaScript(js(() => window.__synapseOpenStatus?.()));
    await sleep(1500);
  },

  async error({ send }) {
    send('vosk-error', { source: 'system', error: 'AssemblyAI rejected the API key: it has been disabled or deleted.', unexpected: false });
  }
};

async function runUiCapture({ app, getMainWindow, baseSendToRenderer, outDir, sceneNames, size }) {
  fs.mkdirSync(outDir, { recursive: true });
  const names = sceneNames && sceneNames.length ? sceneNames : Object.keys(SCENES);
  const [width, height] = size;

  for (const name of names) {
    const scene = SCENES[name];
    if (!scene) continue;
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      console.log(`[ui-capture] window gone before scene ${name}`);
      break;
    }

    win.setOpacity(1);
    win.setSize(width, height);
    win.showInactive();
    await sleep(1200);
    // Reset to a clean view between scenes: close every panel and clear the
    // feed through the app's own Clear action. Scenes other than setup start
    // from a finished setup, as a returning user would.
    await win.webContents.executeJavaScript(js((sceneName) => {
      window.__synapseEndDemoStream?.(true);
      if (document.getElementById('app').classList.contains('compact-mode')) document.getElementById('compact-mode-btn')?.click();
      document.documentElement.dataset.theme = 'dark';
      document.documentElement.style.setProperty('--shell-veil', '1');
      document.documentElement.removeAttribute('data-brightness-adjusted');
      if (sceneName !== 'onboarding') window.__synapseCloseOnboarding?.();
      document.querySelectorAll('.sheet').forEach((sheet) => sheet.classList.add('hidden'));
      document.getElementById('close-settings')?.click();
      const clear = document.getElementById('clear-btn');
      if (clear && !clear.disabled) clear.click();
    }, name));
    await sleep(500);
    console.log(`[ui-capture] scene ${name}: ready`);

    try {
      await scene({ win, send: baseSendToRenderer });
    } catch (error) {
      console.error(`[ui-capture] scene ${name} failed:`, error.message);
      throw error;
    }
    await sleep(700);

    await win.webContents.executeJavaScript(js(() => document.fonts.ready.then(() => true)));
    const layout = await win.webContents.executeJavaScript(js(() => ({
      theme: document.documentElement.dataset.theme,
      viewport: [innerWidth, innerHeight],
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      context: document.getElementById('context-summary-resume')?.textContent,
      font: getComputedStyle(document.body).fontFamily,
      controlsOutsideWindow: [...document.querySelectorAll('.topbar button, .topbar select')].filter(e => {
        const r = e.getBoundingClientRect(); return r.width && r.height && (r.left < 0 || r.right > innerWidth || r.bottom > innerHeight);
      }).map(e => e.id)
    })));
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(layout, null, 2));
    if (layout.horizontalOverflow || layout.controlsOutsideWindow.length) throw new Error(`Layout overflow in ${name}`);
    const image = await win.webContents.capturePage();
    const file = path.join(outDir, `${name}.png`);
    fs.writeFileSync(file, image.toPNG());
    console.log(`[ui-capture] wrote ${file}`);
  }

  app.exit(0);
}

module.exports = { runUiCapture, SCENES };
