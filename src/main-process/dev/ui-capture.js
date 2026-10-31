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
    }
    await sleep(700);

    const image = await win.webContents.capturePage();
    const file = path.join(outDir, `${name}.png`);
    fs.writeFileSync(file, image.toPNG());
    console.log(`[ui-capture] wrote ${file}`);
  }

  app.exit(0);
}

module.exports = { runUiCapture, SCENES };
