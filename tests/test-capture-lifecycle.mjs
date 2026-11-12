// Capture lifecycle: the assistant window is always restored (the "Capture
// Screen makes Synapse disappear" bug), the requested display is the one
// captured, and vision crops come from the same frame.
// Electron is stubbed. Run: node tests/test-capture-lifecycle.mjs

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fakeImage(width, height, { black = false, origin = 'frame' } = {}) {
  const crops = [];
  return {
    origin,
    crops,
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toBitmap: () => Buffer.alloc(256, black ? 0 : 200),
    toPNG: () => Buffer.from('png'),
    toJPEG: () => Buffer.from(`jpeg:${origin}`),
    crop(rect) { crops.push(rect); return fakeImage(rect.width, rect.height, { origin: `${origin}-crop` }); }
  };
}

const state = { sources: [], getSourcesCalls: 0, throwOnGetSources: null };
const displays = [
  { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2 },
  { id: 2, bounds: { x: 1512, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }
];
const electronStub = {
  desktopCapturer: {
    async getSources(opts) {
      state.getSourcesCalls += 1;
      state.lastOpts = opts;
      if (state.throwOnGetSources) throw state.throwOnGetSources;
      return state.sources;
    }
  },
  screen: {
    getAllDisplays: () => displays,
    getCursorScreenPoint: () => ({ x: 10, y: 10 }),
    getDisplayNearestPoint: () => displays[0],
    getPrimaryDisplay: () => displays[0]
  },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
  shell: {},
  nativeImage: { createFromBuffer: () => fakeImage(10, 10) }
};
const electronId = require.resolve('electron');
const stub = new Module(electronId);
stub.filename = electronId;
stub.loaded = true;
stub.exports = electronStub;
require.cache[electronId] = stub;

const { createScreenshotManager, buildVisionImageParts } = require('../src/main-process/features/assistant/screenshot-manager.js');

function fakeWindow() {
  const win = { opacity: 1, visible: true, focused: true, history: [] };
  return Object.assign(win, {
    isDestroyed: () => false,
    getOpacity: () => win.opacity,
    setOpacity: (v) => { win.opacity = v; win.history.push(v); },
    isVisible: () => win.visible,
    isFocused: () => win.focused,
    showInactive: () => { win.visible = true; },
    focus: () => { win.focused = true; },
    getBounds: () => ({ x: 0, y: 0, width: 400, height: 300 })
  });
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-capture-'));
function manager(win, permission = { status: 'granted', authorized: true }) {
  return createScreenshotManager({
    app: { isPackaged: true, getPath: () => userData },
    getMainWindow: () => win,
    getAppEnvironment: () => ({ screenshotDelay: 1, maxScreenshots: 5 }),
    sendToRenderer: () => {},
    getScreenRecordingPermission: () => permission
  });
}
const quiet = async (fn) => { const { log, warn } = console; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = log; console.warn = warn; } };

await test('Capture Screen restores the window after a successful capture (was left at opacity 0.01)', async () => {
  const win = fakeWindow();
  win.opacity = 0.85;
  state.sources = [{ id: 'screen:1:0', display_id: '1', thumbnail: fakeImage(3024, 1964) }];
  const file = await quiet(() => manager(win).takeStealthScreenshot());
  assert(fs.existsSync(file), 'Screenshot file must be written');
  assert(win.history[0] === 0.01, 'Window must be dimmed during capture');
  assert(win.opacity === 0.85, `Opacity must be restored to 0.85, got ${win.opacity}`);
});

await test('Window is restored when the capture throws', async () => {
  const win = fakeWindow();
  state.throwOnGetSources = new Error('boom');
  state.sources = [];
  let error = null;
  try { await quiet(() => manager(win).takeStealthScreenshot()); } catch (e) { error = e; }
  state.throwOnGetSources = null;
  assert(error, 'Capture must fail');
  assert(win.opacity === 1, `Opacity must be restored after failure, got ${win.opacity}`);
});

await test('Denied permission: no dimming, no capture, actionable error', async () => {
  const win = fakeWindow();
  state.getSourcesCalls = 0;
  let error = null;
  try { await quiet(() => manager(win, { status: 'denied', authorized: false }).takeStealthScreenshot()); } catch (e) { error = e; }
  assert(error?.code === 'SCREEN_RECORDING_DENIED', `Expected SCREEN_RECORDING_DENIED, got ${error?.code}`);
  assert(win.history.length === 0, 'Window must not be touched');
  assert(state.getSourcesCalls === 0, 'Must not call getSources while denied');
});

await test('A second capture while one runs is refused; the first still restores the window', async () => {
  const win = fakeWindow();
  state.sources = [{ id: 'screen:1:0', display_id: '1', thumbnail: fakeImage(3024, 1964) }];
  const m = manager(win);
  const first = quiet(() => m.captureScreenInMemory());
  let second = null;
  try { await m.captureScreenInMemory(); } catch (e) { second = e; }
  await first;
  assert(second?.code === 'CAPTURE_IN_PROGRESS', `Expected CAPTURE_IN_PROGRESS, got ${second?.code}`);
  assert(win.opacity === 1, 'Window restored');
  await quiet(() => m.captureScreenInMemory());
});

await test('Requested display is captured at full Retina resolution; another display is never substituted', async () => {
  const win = fakeWindow();
  state.sources = [
    { id: 'screen:2:0', display_id: '2', thumbnail: fakeImage(1920, 1080, { origin: 'display-2' }) },
    { id: 'screen:1:0', display_id: '1', thumbnail: fakeImage(3024, 1964, { origin: 'display-1' }) }
  ];
  const frame = await quiet(() => manager(win).captureScreenInMemory({ displayId: 1 }));
  assert(frame.image.origin === 'display-1', `Captured ${frame.image.origin}`);
  assert(state.lastOpts.thumbnailSize.width === 3024 && state.lastOpts.thumbnailSize.height === 1964, `Requested ${JSON.stringify(state.lastOpts.thumbnailSize)}`);
  assert(frame.meta.displayId === '1' && frame.meta.width === 3024 && frame.meta.captureId, 'Frame metadata must be set');

  state.sources = [{ id: 'screen:2:0', display_id: '2', thumbnail: fakeImage(1920, 1080) }, { id: 'screen:3:0', display_id: '3', thumbnail: fakeImage(10, 10) }];
  let error = null;
  try { await quiet(() => manager(win).captureScreenInMemory({ displayId: 1 })); } catch (e) { error = e; }
  assert(error?.code === 'CAPTURE_DISPLAY_NOT_FOUND', `Expected CAPTURE_DISPLAY_NOT_FOUND, got ${error?.code}`);
});

await test('Black frames are rejected', async () => {
  state.sources = [{ id: 'screen:1:0', display_id: '1', thumbnail: fakeImage(3024, 1964, { black: true }) }];
  let error = null;
  try { await quiet(() => manager(fakeWindow()).captureScreenInMemory()); } catch (e) { error = e; }
  assert(error?.code === 'CAPTURE_BLACK_FRAME', `Expected CAPTURE_BLACK_FRAME, got ${error?.code}`);
});

await test('Vision payload: full frame + left and right halves cropped from that same frame, labelled', () => {
  const image = fakeImage(3024, 1964);
  const parts = buildVisionImageParts(image);
  const images = parts.filter((p) => p.inlineData);
  assert(images.length === 3, `Expected 3 images, got ${images.length}`);
  assert(image.crops.length === 2, 'Both crops must come from the same frame');
  const [left, right] = image.crops;
  assert(left.x === 0 && left.width === 1512 && left.height === 1964, `Left crop ${JSON.stringify(left)}`);
  assert(right.x + right.width === 3024 && right.height === 1964, `Right crop must reach the right edge ${JSON.stringify(right)}`);
  assert(parts[0].text.includes('full screen') && parts.some((p) => p.text?.includes('left half')) && parts.some((p) => p.text?.includes('right half')), 'Labels missing');
  assert(images.every((p) => p.inlineData.mimeType === 'image/jpeg' && p.inlineData.data.length > 0), 'Images must be non-empty JPEG');
  const small = buildVisionImageParts(fakeImage(1280, 800)).filter((p) => p.inlineData);
  assert(small.length === 1, 'Small screens send only the full frame');
});

fs.rmSync(userData, { recursive: true, force: true });
console.log(`\nCapture lifecycle tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
if (failed) process.exit(1);
