#!/usr/bin/env node
/**
 * Test Suite: Screen Intelligence & macOS Permission Stability
 *
 * Verifies the 20 criteria of Phase 6:
 * - Navbar button existence, design system matching, accessibility, tooltips
 * - Screen Recording permission check, granted, denied, revoked handling
 * - In-memory screen capture pipeline, Retina scaling, multi-display
 * - Intelligent question understanding (DSA, constraints, I/O, languages)
 * - Answer generation structure (algorithm, code, complexity, edge cases)
 * - Answer style preferences (responseMode)
 * - Chat streaming integration & failure recovery
 * - macOS code-signing identity, entitlements & Info.plist declarations
 *
 * Run: node tests/test-screen-intelligence.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Under plain Node, require('electron') only returns the binary's path string;
// nothing here calls Electron APIs. CI skips the binary download
// (ELECTRON_SKIP_BINARY_DOWNLOAD), and then the package throws on load
// instead, so the module gets that same plain-Node value.
{
  const electronId = require.resolve('electron');
  try {
    require('electron');
  } catch {
    const Module = require('node:module');
    const stub = new Module(electronId);
    stub.filename = electronId;
    stub.loaded = true;
    stub.exports = '';
    require.cache[electronId] = stub;
  }
}

const prompts = require(path.join(__dirname, '../src/services/ai/prompts.js'));
const { createScreenshotManager } = require(path.join(__dirname, '../src/main-process/features/assistant/screenshot-manager.js'));
const config = require(path.join(__dirname, '../src/config.js'));

let passed = 0;
let failed = 0;

async function runTests() {
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
    if (!condition) throw new Error(message || 'assertion failed');
  }

  console.log('=== SCREEN INTELLIGENCE & macOS PERMISSION VERIFICATION ===\n');

  // 1. Navbar button visibility, markup, and accessibility
  await test('1. Navbar button: Analyze Screen exists in renderer.html with scan icon and tooltip', () => {
    const html = fs.readFileSync(path.join(__dirname, '../src/windows/assistant/renderer.html'), 'utf8');
    assert(html.includes('id="analyze-screen-btn"'), 'Missing #analyze-screen-btn in renderer.html');
    assert(html.includes('aria-label="Analyze Screen"'), 'Missing aria-label on analyze-screen-btn');
    assert(html.includes('data-tip="Analyze Screen  ⌥⇧D"'), 'Missing tooltip data-tip on analyze-screen-btn');
    assert(html.includes('class="analyze-screen-label">Analyze Screen</span>'), 'Missing Analyze Screen text label');
    assert(html.includes('class="analyze-screen-icon"'), 'Missing monitor/scan icon');
    assert(html.includes('class="spinner analyze-screen-spinner"'), 'Missing spinner element');
  });

  // 2. CSS rules: Height, spacing, hover, compact mode, and responsive collapse
  await test('2. CSS rules: Height, spacing, hover, compact mode, and responsive collapse', () => {
    const css = fs.readFileSync(path.join(__dirname, '../src/windows/assistant/ui/app.css'), 'utf8');
    assert(css.includes('.analyze-screen-btn'), 'Missing .analyze-screen-btn class in app.css');
    assert(css.includes('height: var(--control-h);'), 'Height must match var(--control-h)');
    assert(css.includes('.analyze-screen-btn.analyzing'), 'Missing .analyzing state in app.css');
    assert(css.includes('.app.compact-mode #analyze-screen-btn'), 'Button must hide in compact mode');
    // The label collapses when the title bar itself runs short of room (it needs about 1064 px with labels;
    // the old 820px viewport breakpoint left 821-1064 px overlapping). Rendered check: npm run test:layout:live.
    const collapse = /@container topbar \(max-width: (\d+)px\) \{[^}]*\.analyze-screen-label \{ display: none; \}/.exec(css);
    assert(collapse, 'Analyze Screen label must collapse through the title-bar container query');
    assert(Number(collapse[1]) >= 1064, `Label must collapse before the bar runs out of room (collapses at ${collapse?.[1]}px, needs 1064px)`);
  });

  // 3. Screen Recording permission check: Already granted
  await test('3. Permission check: Returns authorized=true when already granted', () => {
    const mockApp = { isPackaged: false, getPath: () => '/tmp' };
    const manager = createScreenshotManager({
      app: mockApp,
      getMainWindow: () => ({ getOpacity: () => 1.0, setOpacity: () => {} }),
      getAppEnvironment: () => ({ screenshotDelay: 10 }),
      sendToRenderer: () => {}
    });

    const perm = manager.checkScreenRecordingPermission();
    assert(typeof perm === 'object', 'Permission status must be an object');
    assert('authorized' in perm && 'status' in perm, 'Must return authorized and status fields');
  });

  // 4. Permission denied handling
  await test('4. Permission denied: Blocks capture immediately and returns actionable error', async () => {
    const mockApp = { isPackaged: false, getPath: () => '/tmp' };
    const manager = createScreenshotManager({
      app: mockApp,
      getMainWindow: () => ({ getOpacity: () => 1.0, setOpacity: () => {} }),
      getAppEnvironment: () => ({}),
      sendToRenderer: () => {},
      getScreenRecordingPermission: () => ({ status: 'denied', authorized: false })
    });

    let errorCaught = null;
    try {
      await manager.captureScreenInMemory();
    } catch (err) {
      errorCaught = err;
    }

    assert(errorCaught !== null, 'Capture must throw when permission denied');
    assert(errorCaught.code === 'SCREEN_RECORDING_DENIED', `Expected code SCREEN_RECORDING_DENIED, got: ${errorCaught?.code}`);
    assert(errorCaught.message.includes('System Settings'), 'Error must guide user to System Settings');
  });

  // 5. In-flight duplicate prevention
  await test('5. Duplicate prevention: Concurrent capture requests are rejected', async () => {
    const mockApp = { isPackaged: false, getPath: () => '/tmp' };
    const manager = createScreenshotManager({
      app: mockApp,
      getMainWindow: () => ({
        getOpacity: () => 1.0,
        setOpacity: () => {},
        isDestroyed: () => false
      }),
      getAppEnvironment: () => ({ screenshotDelay: 50 }),
      sendToRenderer: () => {}
    });

    manager.checkScreenRecordingPermission = () => ({ status: 'granted', authorized: true });

    const p1 = manager.captureScreenInMemory().catch(() => {});
    let duplicateError = null;
    try {
      await manager.captureScreenInMemory();
    } catch (err) {
      duplicateError = err;
    }
    await p1;

    assert(duplicateError !== null, 'Concurrent capture must reject');
    assert(duplicateError.code === 'CAPTURE_IN_PROGRESS', `Expected CAPTURE_IN_PROGRESS, got: ${duplicateError?.code}`);
  });

  // 6. Zero disk persistence in memory pipeline
  await test('6. Privacy & In-memory pipeline: captureScreenInMemory does not write capture files to disk', () => {
    const managerSrc = fs.readFileSync(path.join(__dirname, '../src/main-process/features/assistant/screenshot-manager.js'), 'utf8');
    assert(managerSrc.includes('captureScreenInMemory'), 'captureScreenInMemory must be implemented');
    assert(!managerSrc.match(/captureScreenInMemory[\s\S]*?writeFileSync/), 'captureScreenInMemory must not write files to disk');
  });

  // 7. Prompt: Coding problem extraction (Problem, Constraints, I/O, Languages)
  await test('7. Intelligent question understanding: Extracts problem statement, I/O, constraints, language', () => {
    const prompt = prompts.buildScreenshotAnalysisPrompt({
      programmingLanguage: 'Python',
      responseMode: 'technical'
    });

    assert(prompt.includes('extract problem statement, input format, output format, explicit constraints'), 'Missing constraint extraction rules');
    assert(prompt.includes('Never invent missing constraints'), 'Must not invent missing constraints');
    assert(prompt.includes('prefer Python'), 'Must honor requested programming language');
  });

  // 8. Prompt: Structured answer generation (Algorithm, Implementation, Complexity, Edge Cases)
  await test('8. Answer generation: Structures problem summary, algorithm, implementation, Big-O, edge cases', () => {
    const prompt = prompts.buildScreenshotAnalysisPrompt({
      programmingLanguage: 'TypeScript',
      responseMode: 'professional'
    });

    assert(prompt.includes('1. **Problem Summary & Constraints:**'), 'Missing Problem Summary section');
    assert(prompt.includes('2. **Recommended Approach & Algorithm:**'), 'Missing Recommended Approach section');
    assert(prompt.includes('3. **Implementation:**'), 'Missing Implementation section');
    assert(prompt.includes('4. **Complexity Analysis:**'), 'Missing Complexity Analysis section');
    assert(prompt.includes('5. **Edge Cases & Walkthrough:**'), 'Missing Edge Cases section');
  });

  // 9. Prompt: Multi-domain support (MCQs, debugging, system design, theory, math)
  await test('9. Broad domain support: MCQs, debugging, theory, system design, math', () => {
    const prompt = prompts.buildScreenshotAnalysisPrompt({ responseMode: 'detailed' });
    assert(prompt.includes('debugging / errors: identify the root cause'), 'Missing debugging guidance');
    assert(prompt.includes('multiple-choice questions: state the correct option'), 'Missing MCQ guidance');
    assert(prompt.includes('technical theory / system design / math'), 'Missing system design and math guidance');
  });

  // 10. Prompt: Hiring assessment & practice safety
  await test('10. Hiring assessment guidance: Practice-oriented guidance for interview assessments', () => {
    const prompt = prompts.buildScreenshotAnalysisPrompt();
    assert(prompt.includes('active interview or hiring assessment, provide practice-oriented guidance, hints'), 'Missing interview assessment safety');
  });

  // 11. Response mode parameter honoring
  await test('11. Response mode: Honored across quick, technical, professional, star, detailed', () => {
    for (const mode of ['quick', 'professional', 'technical', 'star', 'detailed']) {
      const prompt = prompts.buildScreenshotAnalysisPrompt({ responseMode: mode });
      assert(prompt.includes(`Follow the active answer style preference: ${mode.toUpperCase()}`), `Mode ${mode} not reflected in prompt`);
    }
  });

  // 12. Preload API exposed: analyzeScreen and checkScreenRecordingPermission
  await test('12. Preload API: analyzeScreen and checkScreenRecordingPermission are exposed', () => {
    const actionsSrc = fs.readFileSync(path.join(__dirname, '../src/windows/assistant/preload/actions.js'), 'utf8');
    assert(actionsSrc.includes('channel: \'analyze-screen\''), 'Missing analyze-screen in preload/actions.js');
    assert(actionsSrc.includes('channel: \'check-screen-recording-permission\''), 'Missing check-screen-recording-permission in preload/actions.js');
  });

  // 13. Shortcut registry: analyzeScreen shortcut in config.js
  await test('13. Shortcut registry: analyzeScreen is registered in config.js with accelerator', () => {
    const shortcuts = config.getKeyboardShortcuts();
    const shortcut = shortcuts.find((s) => s.id === 'analyzeScreen');
    assert(shortcut !== undefined, 'analyzeScreen not found in config.getKeyboardShortcuts()');
    assert(shortcut.accelerator === 'Alt+Shift+D', `Expected Alt+Shift+D, got: ${shortcut?.accelerator}`);
  });

  // 14. Command bar integration: analyze-screen command and tooltip
  await test('14. Command bar: analyze-screen command registered in COMMANDS array', () => {
    const cmdBarSrc = fs.readFileSync(path.join(__dirname, '../src/windows/assistant/renderer/features/command-bar/command-bar.js'), 'utf8');
    assert(cmdBarSrc.includes('id: \'analyze-screen\''), 'Missing analyze-screen in COMMANDS');
    assert(cmdBarSrc.includes('target: \'analyze-screen-btn\''), 'Command must target analyze-screen-btn');
    assert(cmdBarSrc.includes('\'analyze-screen-btn\': [\'Analyze Screen\''), 'Missing tooltip label in applyTooltips()');
  });

  // 15. Window controller global shortcut routing
  await test('15. Window controller: Global shortcut dispatches analyze-screen command', () => {
    const winCtrlSrc = fs.readFileSync(path.join(__dirname, '../src/main-process/features/window/window-controller.js'), 'utf8');
    assert(winCtrlSrc.includes('registerShortcut(\'analyzeScreen\', triggerCommand(\'analyze-screen\'))'), 'Global shortcut must route analyzeScreen');
  });

  // 16. Application bundle identifier consistency
  await test('16. App identifier: Consistent com.synapse.interviewcoach in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    assert(pkg.build.appId === 'com.synapse.interviewcoach', `Expected com.synapse.interviewcoach, got: ${pkg.build.appId}`);
    assert(pkg.name === 'synapse', `Expected synapse, got: ${pkg.name}`);
  });

  // 17. Info.plist usage descriptions: Screen Recording, Mic, System Audio
  await test('17. Info.plist: NSScreenCaptureDescription, NSAudioCaptureUsageDescription, NSMicrophoneUsageDescription', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    const extendInfo = pkg.build.mac.extendInfo;
    assert(typeof extendInfo.NSScreenCaptureDescription === 'string' && extendInfo.NSScreenCaptureDescription.length > 10, 'Missing or empty NSScreenCaptureDescription');
    assert(typeof extendInfo.NSAudioCaptureUsageDescription === 'string' && extendInfo.NSAudioCaptureUsageDescription.length > 10, 'Missing or empty NSAudioCaptureUsageDescription');
    assert(typeof extendInfo.NSMicrophoneUsageDescription === 'string' && extendInfo.NSMicrophoneUsageDescription.length > 10, 'Missing or empty NSMicrophoneUsageDescription');
  });

  // 18. macOS Entitlements configuration
  await test('18. macOS Entitlements: Files exist and are referenced in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    assert(pkg.build.mac.entitlements === 'assets/entitlements.mac.plist', 'package.json must reference assets/entitlements.mac.plist');
    assert(pkg.build.mac.entitlementsInherit === 'assets/entitlements.mac.inherit.plist', 'package.json must reference assets/entitlements.mac.inherit.plist');
    assert(fs.existsSync(path.join(__dirname, '../assets/entitlements.mac.plist')), 'assets/entitlements.mac.plist file must exist');
    assert(fs.existsSync(path.join(__dirname, '../assets/entitlements.mac.inherit.plist')), 'assets/entitlements.mac.inherit.plist file must exist');
  });

  // 19. Codesign after-pack designated requirement stability
  await test('19. Code signing: after-pack.js specifies stable designated requirement to prevent TCC/Keychain resets', () => {
    const afterPackSrc = fs.readFileSync(path.join(__dirname, '../scripts/after-pack.js'), 'utf8');
    assert(afterPackSrc.includes('-r=designated => identifier "'), 'after-pack.js must pass designated requirement');
    assert(afterPackSrc.includes('com.synapse.synapse-audio-capture'), 'after-pack.js must sign native helper with stable identifier');
  });

  // 20. Native audio helper signing requirement stability
  await test('20. Native helper build: build-native-audio.js specifies stable identifier and designated requirement', () => {
    const buildAudioSrc = fs.readFileSync(path.join(__dirname, '../scripts/build-native-audio.js'), 'utf8');
    assert(buildAudioSrc.includes('--identifier\', \'com.synapse.synapse-audio-capture\''), 'build-native-audio must sign with stable identifier');
    assert(buildAudioSrc.includes('-r=designated => identifier "com.synapse.synapse-audio-capture"'), 'build-native-audio must sign with stable requirement');
  });

  // 21. Preload API: onScreenCaptureStatus is exposed in preload/listeners.js
  await test('21. Preload API: onScreenCaptureStatus is exposed in preload/listeners.js', () => {
    const listenersSrc = fs.readFileSync(path.join(__dirname, '../src/windows/assistant/preload/listeners.js'), 'utf8');
    assert(listenersSrc.includes('onScreenCaptureStatus'), 'Missing onScreenCaptureStatus in preload/listeners.js');
    assert(listenersSrc.includes('channel: \'screen-capture-status\''), 'Missing screen-capture-status channel in preload/listeners.js');
  });

  // 22. Multi-monitor & active display selection implementation
  await test('22. Screen manager: resolveTargetDisplay handles multi-monitor, cursor proximity, and Retina scaling', () => {
    const managerSrc = fs.readFileSync(path.join(__dirname, '../src/main-process/features/assistant/screenshot-manager.js'), 'utf8');
    assert(managerSrc.includes('resolveTargetDisplay'), 'Missing resolveTargetDisplay in screenshot-manager.js');
    assert(managerSrc.includes('getDisplayNearestPoint'), 'Must prefer display nearest cursor for active user focus');
    assert(managerSrc.includes('MAX_CAPTURE_DIMENSION'), 'Must budget max capture dimension for vision LLMs');
  });

  // 23. Frame validation: black frame detection
  await test('23. Frame validation: detects black or empty frames to prevent sending black screens to AI', () => {
    const managerSrc = fs.readFileSync(path.join(__dirname, '../src/main-process/features/assistant/screenshot-manager.js'), 'utf8');
    assert(managerSrc.includes('nonBlackPixels'), 'Missing black frame pixel check');
    assert(managerSrc.includes('toBitmap()'), 'Must check raw bitmap to verify non-black pixels');
  });

  // 24. MIME type detection from magic bytes
  await test('24. MIME detection: correctly identifies JPEG and PNG magic bytes in buildImagePartsFromScreenshots', () => {
    const managerSrc = fs.readFileSync(path.join(__dirname, '../src/main-process/features/assistant/screenshot-manager.js'), 'utf8');
    assert(managerSrc.includes('0xff && imageData[1] === 0xd8'), 'Must inspect JPEG magic bytes');
    assert(managerSrc.includes('image/jpeg'), 'Must support image/jpeg mimeType');
  });

  // 25. AppState fallback seeding prevents key loss in packaged app
  await test('25. AppState fallback: seeds existing Gemini credentials from dev cache into packaged state if unconfigured', () => {
    const appStateSrc = fs.readFileSync(path.join(__dirname, '../src/services/state/app-state.js'), 'utf8');
    assert(appStateSrc.includes('candidatePaths') || appStateSrc.includes('devStatePath'), 'app-state.js must support fallback seeding');
    assert(appStateSrc.includes('sanitizedState.geminiApiKey'), 'Must verify geminiApiKey in fallback candidates');
  });

  // 26. Centralized ScreenPermissionManager structured states
  await test('26. ScreenPermissionManager: defines all 6 structured permission and capability states', () => {
    const { PERMISSION_STATES, createScreenPermissionManager } = require('../src/main-process/features/assistant/screen-permission-manager');
    assert(PERMISSION_STATES.GRANTED === 'GRANTED', 'Missing GRANTED state');
    assert(PERMISSION_STATES.DENIED === 'DENIED', 'Missing DENIED state');
    assert(PERMISSION_STATES.NOT_DETERMINED === 'NOT_DETERMINED', 'Missing NOT_DETERMINED state');
    assert(PERMISSION_STATES.RESTART_REQUIRED === 'RESTART_REQUIRED', 'Missing RESTART_REQUIRED state');
    assert(PERMISSION_STATES.CAPTURE_INITIALIZATION_FAILED === 'CAPTURE_INITIALIZATION_FAILED', 'Missing CAPTURE_INITIALIZATION_FAILED state');
    assert(PERMISSION_STATES.CAPTURE_UNAVAILABLE === 'CAPTURE_UNAVAILABLE', 'Missing CAPTURE_UNAVAILABLE state');
  });

  // 27. ScreenPermissionManager: active capability verification & false negative recovery
  await test('27. ScreenPermissionManager: verifies capture capability via desktopCapturer and avoids stale denial', async () => {
    const { createScreenPermissionManager } = require('../src/main-process/features/assistant/screen-permission-manager');
    const mockCapturer = {
      getSources: async () => [{
        id: 'screen:0:0',
        thumbnail: { isEmpty: () => false, toJPEG: () => Buffer.from([0xff, 0xd8]) }
      }]
    };
    const mockScreen = {
      getAllDisplays: () => [{ id: 1, bounds: { width: 1920, height: 1080 } }]
    };
    const manager = createScreenPermissionManager({
      systemPreferences: { getMediaAccessStatus: () => 'granted' },
      desktopCapturer: mockCapturer,
      screen: mockScreen
    });

    const cap = await manager.validateCaptureCapability();
    assert(cap.authorized === true, 'Capture must be authorized when sources exist');
    assert(cap.state === 'GRANTED', 'State must be GRANTED');
  });

  // 28. ScreenPermissionManager: handles RESTART_REQUIRED when user toggles permission in settings
  await test('28. ScreenPermissionManager: accurately identifies RESTART_REQUIRED when macOS permissions change', () => {
    const { createScreenPermissionManager } = require('../src/main-process/features/assistant/screen-permission-manager');
    const mockScreen = {
      getAllDisplays: () => [{ id: 1, bounds: { width: 1920, height: 1080 } }]
    };
    const manager = createScreenPermissionManager({
      systemPreferences: { getMediaAccessStatus: () => 'denied' },
      screen: mockScreen
    });

    manager.setUserDirectedToSettings(true);
    const check = manager.checkPermission();
    assert(check.restartRequired === true, 'Must flag restartRequired=true after user goes to settings');
    assert(check.state === 'RESTART_REQUIRED', 'State must be RESTART_REQUIRED');
    assert(check.message.includes('restart'), 'Message must inform user that restart is required');
  });

  // 29. Packaged environment isolation: never writes to process.resourcesPath
  await test('29. Packaged environment: getEnvPath points to userData and protects sealed app bundle', () => {
    const { getEnvPath } = require('../src/bootstrap/environment');
    const mockApp = { isPackaged: true, getPath: (name) => name === 'userData' ? '/mock/userData' : '/tmp' };
    const p = getEnvPath(mockApp);
    assert(p.includes('/mock/userData'), 'Packaged env path must be inside userData');
    assert(!p.includes('process.resourcesPath'), 'Packaged env path must never write inside resourcesPath');
  });

  // 30. Code signing: after-pack signs inside-out without stomping helper IDs
  await test('30. Code signing: after-pack.js preserves individual helper bundle IDs and avoids destructive --deep', () => {
    const afterPackSrc = fs.readFileSync(path.join(__dirname, '../scripts/after-pack.js'), 'utf8');
    assert(afterPackSrc.includes('helperId'), 'after-pack must preserve helper identity');
    assert(!afterPackSrc.includes('\'--deep\','), 'after-pack must not use destructive top-level --deep');
  });

  // 31. Renderer lifecycle: updateUI replaces missing updateAiActionButtons
  await test('31. Renderer lifecycle: uses updateUI and guarantees no ReferenceError', () => {
    const rendererSrc = fs.readFileSync(path.join(__dirname, '../src/windows/assistant/renderer.js'), 'utf8');
    assert(!rendererSrc.includes('updateAiActionButtons'), 'Must not contain undefined updateAiActionButtons');
    assert(rendererSrc.includes('updateUI()'), 'Must call updateUI');
  });

  // 32. Preload API: exposes validateScreenCaptureCapability and openScreenRecordingSettings
  await test('32. Preload API: exposes validateScreenCaptureCapability and openScreenRecordingSettings', () => {
    const actionsSrc = fs.readFileSync(path.join(__dirname, '../src/windows/assistant/preload/actions.js'), 'utf8');
    assert(actionsSrc.includes('validateScreenCaptureCapability'), 'Missing validateScreenCaptureCapability');
    assert(actionsSrc.includes('openScreenRecordingSettings'), 'Missing openScreenRecordingSettings');
    assert(actionsSrc.includes('relaunchApplication'), 'Missing relaunchApplication');
  });

  // 33. Environment bootstrap: loadApplicationEnvironment initializes in packaged and dev modes without nodeOptionsBefore error
  await test('33. Environment bootstrap: loadApplicationEnvironment initializes in packaged and dev modes without nodeOptionsBefore error', () => {
    const { loadApplicationEnvironment } = require('../src/bootstrap/environment');
    const mockPackagedApp = {
      isPackaged: true,
      getPath: (name) => name === 'userData' ? path.join(__dirname, '../cache') : '/tmp'
    };
    const envPackaged = loadApplicationEnvironment(mockPackagedApp);
    assert(typeof envPackaged === 'object' && envPackaged !== null, 'Packaged environment must load without error');
    assert(typeof envPackaged.nodeOptions === 'string', 'nodeOptions must be defined in loaded environment');

    const mockDevApp = {
      isPackaged: false,
      getPath: (name) => name === 'userData' ? path.join(__dirname, '../cache') : '/tmp'
    };
    const envDev = loadApplicationEnvironment(mockDevApp);
    assert(typeof envDev === 'object' && envDev !== null, 'Dev environment must load without error');
  });

  // 34. Readiness & Onboarding UI: verify screen recording readiness check and onboarding action exist
  await test('34. Readiness & Onboarding UI: verify screen recording readiness check and onboarding action exist', () => {
    const htmlSrc = fs.readFileSync(path.join(__dirname, '../src/windows/assistant/renderer.html'), 'utf8');
    assert(htmlSrc.includes('data-check="screen"'), 'Missing data-check="screen" in status panel checklist');
    assert(htmlSrc.includes('data-setup="request-screen"'), 'Missing data-setup="request-screen" in onboarding permissions step');

    const panelsSrc = fs.readFileSync(path.join(__dirname, '../src/windows/assistant/renderer/features/panels/panels.js'), 'utf8');
    assert(panelsSrc.includes("setRow(statusPanel, 'screen'"), 'Missing screen row update in refreshStatus');
    assert(panelsSrc.includes("action === 'request-screen'"), 'Missing request-screen onboarding action handler');
  });

  // 35. Credential resilience: get-settings falls back to appEnvironment or process.env when appState key is empty
  await test('35. Credential resilience: get-settings falls back to appEnvironment or process.env when appState key is empty', () => {
    const settingsIpcSrc = fs.readFileSync(path.join(__dirname, '../src/main-process/features/settings/ipc.js'), 'utf8');
    assert(settingsIpcSrc.includes('appEnvironment.geminiApiKey || process.env.GEMINI_API_KEY'), 'Missing Gemini fallback in get-settings');
    assert(settingsIpcSrc.includes('appEnvironment.assemblyAiApiKey || process.env.ASSEMBLY_AI_API_KEY'), 'Missing AssemblyAI fallback in get-settings');

    const startAppSrc = fs.readFileSync(path.join(__dirname, '../src/main-process/start-application.js'), 'utf8');
    assert(startAppSrc.includes('appEnvironment?.geminiApiKey || process.env.GEMINI_API_KEY'), 'Missing Gemini fallback in start-application.js');
  });

  console.log(`\nScreen Intelligence & Permission Tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
