'use strict';
// Run with Electron: offline UI fixtures, never the user's companion server.
// No production authentication or transport implementation is replaced.
const electron = require('electron');
if (typeof electron === 'string') {
  const { spawn } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 0));
  return;
}
const { app, BrowserWindow } = electron;
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const out = path.resolve(process.argv[2] || '/tmp/synapse-companion');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const html = fs.readFileSync(path.join(__dirname, '../src/main-process/features/mobile-server/companion.html'));
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/login') res.end(JSON.stringify({ ok: true, sessionToken: 'ui-fixture-only' }));
  else if (req.url === '/api/context') res.end(JSON.stringify({ ok: true, context: { role: 'Backend engineer · UI fixture', company: 'Example team', background: 'Simulated candidate context for visual verification.', jobDescription: 'Build reliable APIs.', interviewType: 'technical' } }));
  else res.end(JSON.stringify({ ok: true, clientCount: 1, entries: [{ level: 'info', message: 'Simulated companion connection', at: '2026-11-01T10:00:00Z' }], systemAudioCapture: { ok: true, detail: 'Simulated system audio' } }));
});
const wss = new WebSocketServer({ server });
let peer;
wss.on('connection', ws => { peer = ws; ws.send(JSON.stringify({ type: 'snapshot', seq: 1, data: { listening: { system: true, mic: false }, lastQuestion: 'How would you make this API resilient?', mode: 'Professional', answer: { streamId: 'fixture', status: 'streaming', text: 'I would start with timeouts and bounded retries, then add circuit breakers around dependencies.\n\nThis is simulated streaming data for UI verification.' } } })); });
app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, webPreferences: { partition: 'companion-ui-fixture', nodeIntegration: false, contextIsolation: true, sandbox: true } });
  const errors = [];
  win.webContents.on('console-message', (_, level, message) => { if (level === 3) errors.push(message); });
  await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
  const run = code => win.webContents.executeJavaScript(code);
  async function capture(name) {
    await sleep(400);
    const overflow = await run('document.documentElement.scrollWidth > innerWidth');
    if (overflow) throw new Error(`Horizontal overflow: ${name}`);
    fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  }
  for (const theme of ['dark', 'light']) {
    await run(`document.documentElement.dataset.theme = '${theme}'`);
    await capture(`auth-${theme}`);
  }
  await run("document.documentElement.dataset.theme = 'dark'; document.getElementById('gateCode').value = '123456'; document.getElementById('gateBtn').click()");
  await sleep(700);
  if (await run("!document.getElementById('gate').hidden")) throw new Error('Fixture login failed');
  for (const theme of ['dark', 'light']) {
    await run(`document.documentElement.dataset.theme = '${theme}'`);
    for (const tab of ['live', 'context', 'status', 'logs']) {
      await run(`document.querySelector('[data-tab="${tab}"]').click()`);
      await capture(`${tab}-${theme}`);
    }
  }
  await run("document.querySelector('[data-tab=live]').click()");
  peer.close();
  await sleep(100);
  await capture('disconnected');
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ simulated: true, viewport: [390, 844], errors }, null, 2));
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`Companion fixtures passed: ${out}`);
  app.exit(0);
}).catch(e => { console.error(e); app.exit(1); });
