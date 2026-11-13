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
      { code: 'VIEW_ANALYSED_FIRST', text: 'Current screen fully analysed.', hint: 'Scroll to analyse more.' }));
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

  /**
   * Conversation history, part 1: a transcript, a typed message through the
   * real composer and a streamed answer, then a rename and an answer-style
   * change through the real History sheet and picker. Run `history-restore`
   * in a second launch to check what survived the restart.
   */
  async 'history-write'({ win, send }) {
    const run = (fn, ...a) => win.webContents.executeJavaScript(js(fn, ...a));
    const assert = (ok, message) => { if (!ok) throw new Error(message); };
    await disableAutoAnswer(win);
    send('vosk-final', { source: 'system', text: 'History check: how does a B-tree stay balanced?' });
    await sleep(2500);
    await run(() => {
      const input = document.getElementById('chat-manual-input');
      input.value = 'History check: typed note from the composer';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('chat-manual-send').click();
    });
    await run(() => window.__synapseBeginDemoStream?.());
    send('ai-stream-chunk', { actionId: 'askAi', text: 'Splits and merges keep every leaf at the same depth.', index: 1 });
    await sleep(200);
    await run(() => window.__synapseEndDemoStream?.(true));
    await run(() => { const s = document.getElementById('response-mode-select'); s.value = 'technical'; s.dispatchEvent(new Event('change')); });
    await sleep(600);
    await run(() => document.getElementById('history-btn').click());
    await sleep(800);
    const first = await run(() => document.querySelector('#history-list .history-item[data-current="true"] .history-title')?.textContent);
    assert(first === 'History check: how does a B-tree stay balanced?', `History title was ${first}`);
    await run(() => [...document.querySelectorAll('#history-list .history-item[data-current="true"] button')].find((b) => b.textContent === 'Rename').click());
    await sleep(200);
    await run(() => { const f = document.querySelector('.history-rename'); f.querySelector('input').value = 'Renamed in History'; f.requestSubmit(); });
    await sleep(800);
    const renamed = await run(() => document.querySelector('#history-list .history-item[data-current="true"] .history-title')?.textContent);
    assert(renamed === 'Renamed in History', `rename shown as ${renamed}`);
    const meta = await run(() => document.querySelector('#history-list .history-item[data-current="true"] .history-meta')?.textContent);
    assert(/3 messages/.test(meta), `expected 3 saved messages, meta: ${meta}`);
    console.log(`[ui-capture] history-write: saved "${renamed}" (${meta}); status: ${await run(() => document.getElementById('history-sync-status').textContent)}`);
  },

  /** Conversation history, part 2 (a fresh launch): the open conversation and answer style came back. */
  async 'history-restore'({ win }) {
    const run = (fn) => win.webContents.executeJavaScript(js(fn));
    const assert = (ok, message) => { if (!ok) throw new Error(message); };
    const texts = await run(() => [...document.querySelectorAll('#chat-messages .chat-message .message-content')].map((e) => e.textContent.trim()));
    assert(texts.some((t) => t.includes('how does a B-tree stay balanced')), `transcript not restored: ${JSON.stringify(texts)}`);
    assert(texts.some((t) => t.includes('typed note from the composer')), 'typed message not restored');
    assert(texts.some((t) => t.includes('Splits and merges')), 'answer not restored');
    assert(await run(() => document.getElementById('response-mode-select').value) === 'technical', 'answer style not restored');
    await run(() => document.getElementById('history-btn').click());
    await sleep(800);
    const title = await run(() => document.querySelector('#history-list .history-item[data-current="true"] .history-title')?.textContent);
    assert(title === 'Renamed in History', `rename did not survive restart: ${title}`);
    console.log(`[ui-capture] history-restore: ${texts.length} message(s) restored, title "${title}", status: ${await run(() => document.getElementById('history-sync-status').textContent)}`);
  },

  /**
   * Layout regression sweep: every size from the 600 x 380 minimum to the
   * full work area, idle and busy title bar, an empty and a long feed, each
   * sheet, and compact mode. Fails on any overlap, blocked, clipped, outside,
   * undersized control or squeezed workspace (see layout-audit.js). Writes
   * layout-report.json and a screenshot per size.
   */
  async layout({ win, send, outDir }) {
    const { auditLayout, applyState } = require('./layout-audit');
    const { screen } = require('electron');
    const run = (fn, ...a) => win.webContents.executeJavaScript(js(fn, ...a));
    const assert = (ok, message) => { if (!ok) throw new Error(message); };
    const area = screen.getPrimaryDisplay().workAreaSize;
    const sizes = [[600, 380], [640, 480], [700, 520], [760, 560], [820, 600], [900, 560], [1024, 700], [1280, 800], [area.width, area.height]];
    await disableAutoAnswer(win);

    // A long feed: a long question, a long answer with a wide code block, typed notes.
    send('vosk-final', { source: 'system', text: 'Walk me through how you would design a globally distributed rate limiter, including how you handle clock skew between regions and what happens when the coordination store is partitioned from half of the gateways?' });
    await sleep(2500);
    await run(() => window.__synapseBeginDemoStream?.());
    const longCode = 'const key = `${tenantId}:${routeId}:${Math.floor(Date.now() / windowMs)}`; // a deliberately long single line that must scroll inside the code block instead of widening the feed';
    send('ai-stream-chunk', { actionId: 'askAi', text: `${ANSWER_CHUNKS.join('')}\n\`\`\`js\n${longCode}\n\`\`\`\n\n${'Each region keeps its own buckets and reconciles asynchronously. '.repeat(12)}`, index: 1 });
    await sleep(300);
    await run(() => window.__synapseEndDemoStream?.(true));
    await run(() => {
      const input = document.getElementById('chat-manual-input');
      input.value = 'A long note typed into the composer that wraps across several lines to check the composer grows without pushing the action buttons out of the window or on top of each other. '.repeat(2);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const report = [];
    const check = async (label) => {
      await sleep(250);
      const { checked, problems, regions } = await run(auditLayout);
      report.push({ label, checked, problems, regions });
      return problems.length;
    };
    const fileFor = (w, h) => path.join(outDir, `layout-${w}x${h}.png`);

    for (const [w, h] of sizes) {
      win.setSize(w, h);
      await sleep(400);
      for (const state of ['idle', 'busy']) {
        await run(applyState, state);
        await check(`${w}x${h} ${state} feed`);
      }
      fs.writeFileSync(fileFor(w, h), (await win.webContents.capturePage()).toPNG());
      for (const sheet of ['history-btn', 'context-btn', 'status-btn', 'settings-btn', 'workbench-btn']) {
        await run((id) => document.getElementById(id).click(), sheet);
        await sleep(350);
        await check(`${w}x${h} busy ${sheet.replace('-btn', '')} sheet`);
        await run(() => { document.querySelectorAll('.sheet').forEach((s) => s.classList.add('hidden')); document.getElementById('close-settings')?.click(); });
      }
      await run(() => document.getElementById('compact-mode-btn').click());
      await sleep(400);
      await check(`${w} compact busy`);
      await run(() => document.getElementById('compact-mode-btn').click());
      await sleep(400);
    }
    // ⌘+ / ⌘- zoom shrinks the CSS viewport. Busy title bar at 100 %, 110 % and 120 % (levels 0, 0.5, 1).
    const savedZoom = win.webContents.getZoomLevel();
    for (const level of [0, 0.5, 1]) {
      win.webContents.setZoomLevel(level);
      for (const [w, h] of [[600, 380], [900, 560]]) {
        win.setSize(w, h);
        await sleep(400);
        await run(applyState, 'busy');
        await check(`${w}x${h} busy zoom ${Math.round(1.2 ** level * 100)}%`);
        if (w === 600) fs.writeFileSync(path.join(outDir, `layout-600x380-zoom${Math.round(1.2 ** level * 100)}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
    win.webContents.setZoomLevel(savedZoom);

    await run(applyState, 'idle');
    await run(() => { const b = document.getElementById('clear-btn'); if (b && !b.disabled) b.click(); });
    await sleep(300);
    win.setSize(600, 380);
    await check('600x380 idle empty');

    // Keyboard: Tab from the first title-bar control must visit every visible one, each with a focus ring.
    win.setSize(900, 560);
    await sleep(400);
    await run(applyState, 'busy');
    const expected = await run(() => [...document.querySelectorAll('.topbar button, .topbar select')]
      // Disabled controls are skipped by Tab on purpose (Analyze Screen while it is analyzing).
      .filter((el) => !el.disabled && !el.closest('.hidden, [hidden], .command-targets') && el.getBoundingClientRect().width && getComputedStyle(el).display !== 'none')
      .map((el) => el.id));
    // Reach the first control by keyboard, so :focus-visible applies as it does for a real user.
    win.focus();
    await run((id) => document.getElementById(id).focus(), expected[0]);
    for (const modifiers of [['shift'], []]) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers });
      await sleep(80);
    }
    assert(await run(() => document.activeElement.id) === expected[0], 'keyboard start did not land on the first title-bar control');
    const visited = [];
    const unringed = [];
    for (let i = 0; i < expected.length; i += 1) {
      const info = await run(() => { const el = document.activeElement; const s = getComputedStyle(el); return { id: el.id, ring: parseFloat(s.outlineWidth) > 0 && s.outlineStyle !== 'none' }; });
      visited.push(info.id);
      if (!info.ring && expected.includes(info.id)) unringed.push(info.id);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
      await sleep(60);
    }
    const missed = expected.filter((id) => !visited.includes(id));
    report.push({ label: 'keyboard title bar', checked: expected.length, problems: [
      ...missed.map((id) => ({ kind: 'unreachable', el: `#${id}` })),
      ...unringed.map((id) => ({ kind: 'no-focus-ring', el: `#${id}` }))
    ] });
    await run(applyState, 'idle');

    const failures = report.filter((r) => r.problems.length);
    fs.writeFileSync(path.join(outDir, 'layout-report.json'), JSON.stringify({ sizes, failures, regions: report.map((r) => ({ label: r.label, ...r.regions })), passed: report.length - failures.length, total: report.length }, null, 2));
    console.log(`[ui-capture] layout: ${report.length - failures.length}/${report.length} checks clean, ${report.reduce((n, r) => n + r.checked, 0)} control placements measured`);
    if (failures.length) {
      for (const f of failures.slice(0, 12)) console.log(`[ui-capture] layout FAIL ${f.label}: ${f.problems.slice(0, 4).map((p) => `${p.kind} ${p.el}${p.with ? ` x ${p.with}` : ''}${p.by && !p.with ? ` by ${p.by}` : ''}`).join('; ')}`);
      throw new Error(`${failures.length} layout check(s) failed; see layout-report.json`);
    }
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
      // history-restore checks what the last launch left on screen, so it must not be cleared.
      const clear = document.getElementById('clear-btn');
      if (sceneName !== 'history-restore' && clear && !clear.disabled) clear.click();
    }, name));
    await sleep(500);
    console.log(`[ui-capture] scene ${name}: ready`);

    try {
      await scene({ win, send: baseSendToRenderer, outDir });
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
