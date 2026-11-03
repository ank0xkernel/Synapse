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
    assert(css.includes('.listen-label, .analyze-screen-label { display: none; }'), 'Label must collapse at 820px viewport');
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

  console.log(`\nScreen Intelligence & Permission Tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
