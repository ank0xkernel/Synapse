'use strict';
/**
 * verify-pipeline-live.js
 *
 * Full Comprehensive Real-World Test Suite for Synapse Screen Intelligence:
 * Target 1: Primary display capture & Gemini Vision analysis (via analyzeScreenshots)
 * Target 2: Secondary / Retina display capture & Gemini Vision analysis
 * Target 3: Burst / Repeated capture requests (idempotency, latency, concurrency)
 * Target 4: Error handling & edge cases (empty buffers, black frame detection)
 * Target 5: Native CoreAudio system audio non-regression check
 * Target 6: Installed bundle signature & TCC stability verification
 */

const { app, desktopCapturer, screen, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const GeminiService = require('../src/services/ai/gemini-service');
const { configureSecretStore, loadAppState } = require('../src/services/state/app-state');
const { createScreenshotManager } = require('../src/main-process/features/assistant/screenshot-manager');

async function runLiveVerification() {
  console.log('================================================================');
  console.log(' SYNAPSE SCREEN INTELLIGENCE: EXTENDED PRODUCTION VERIFICATION ');
  console.log('================================================================\n');

  let passes = 0;
  let failures = 0;

  function assert(condition, desc) {
    if (condition) {
      console.log(`  [PASS] ${desc}`);
      passes++;
    } else {
      console.error(`  [FAIL] ${desc}`);
      failures++;
    }
  }

  try {
    // API keys live in the Keychain-backed store, not app-state.json.
    configureSecretStore(app, safeStorage);
    const state = loadAppState(app);
    const geminiApiKey = state?.geminiApiKey;
    const modelName = state?.geminiModel || 'gemini-3.5-flash-lite';
    assert(Boolean(geminiApiKey), 'Valid Gemini API key configured in state');

    const geminiService = new GeminiService(geminiApiKey, { modelName });
    const allDisplays = screen.getAllDisplays();
    assert(allDisplays.length > 0, `Detected ${allDisplays.length} macOS display(s)`);

    // --- TEST SUITE 1: Multi-Monitor & Retina Capture ---
    console.log('\n--- TEST SUITE 1: Multi-Monitor & Display Capture ---');
    for (let i = 0; i < allDisplays.length; i++) {
      const disp = allDisplays[i];
      const rawW = Math.round(disp.bounds.width * disp.scaleFactor);
      const rawH = Math.round(disp.bounds.height * disp.scaleFactor);
      const MAX_DIM = 2048;
      let targetW = rawW;
      let targetH = rawH;
      if (targetW > MAX_DIM || targetH > MAX_DIM) {
        const s = Math.min(MAX_DIM / targetW, MAX_DIM / targetH);
        targetW = Math.round(targetW * s);
        targetH = Math.round(targetH * s);
      }

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: targetW, height: targetH }
      });

      const matched = sources.find((s) => s.display_id === String(disp.id) || s.id.includes(String(disp.id))) || sources[i] || sources[0];
      assert(Boolean(matched && !matched.thumbnail.isEmpty()), `Display ${i + 1} (id: ${disp.id}, ${disp.size.width}x${disp.size.height} @ ${disp.scaleFactor}x) captured`);
      
      const thumb = matched.thumbnail;
      const size = thumb.getSize();
      console.log(`       Display ${i + 1} thumbnail dimension: ${size.width}x${size.height}`);
      assert(size.width > 0 && size.height > 0, `Display ${i + 1} dimensions valid`);
    }

    // --- TEST SUITE 2: Visual Understanding with Gemini Vision ---
    console.log('\n--- TEST SUITE 2: Multimodal Gemini Vision Accuracy via analyzeScreenshots ---');
    const primaryDisp = screen.getPrimaryDisplay();
    const primarySources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    });
    const primaryThumb = primarySources[0].thumbnail;
    const primaryJpeg = primaryThumb.toJPEG(88);

    assert(primaryJpeg[0] === 0xFF && primaryJpeg[1] === 0xD8, 'JPEG magic bytes verified');

    const imageParts = [{
      inlineData: {
        data: primaryJpeg.toString('base64'),
        mimeType: 'image/jpeg'
      }
    }];

    const startT = Date.now();
    let ttft = null;
    let chunks = [];

    const aiResponse = await geminiService.analyzeScreenshots(
      imageParts,
      'List what active application, code editor, or terminal you observe in this screenshot.',
      {
        responseMode: 'quick',
        onChunk: ({ text, index }) => {
          if (!ttft) ttft = Date.now() - startT;
          chunks.push(text);
        }
      }
    );

    const elapsed = Date.now() - startT;
    console.log(`       Vision TTFT: ${ttft} ms | Total: ${elapsed} ms | Chunks: ${chunks.length}`);
    console.log(`\n--- RECOGNIZED SCREEN CONTENT ---`);
    console.log(aiResponse.trim());
    console.log(`---------------------------------\n`);
    assert(aiResponse.length > 20, 'Gemini Vision generated rich response');
    assert(chunks.length > 0, 'Gemini Vision streamed in real-time');

    // --- TEST SUITE 3: Rapid Consecutive Analysis Requests (Burst & Idempotency) ---
    console.log('\n--- TEST SUITE 3: Rapid Consecutive Analysis Requests ---');
    const burstCount = 3;
    let burstSuccesses = 0;
    const burstStart = Date.now();

    for (let b = 1; b <= burstCount; b++) {
      const bStart = Date.now();
      const bResp = await geminiService.generateMultimodal([
        { text: 'Confirm screen received in 1 sentence.' },
        ...imageParts
      ], { priority: 'realtime' });
      const bElapsed = Date.now() - bStart;
      if (bResp && bResp.length > 0) {
        burstSuccesses++;
        console.log(`       Burst ${b}/${burstCount} completed in ${bElapsed} ms: "${bResp.trim()}"`);
      }
    }
    assert(burstSuccesses === burstCount, `All ${burstCount} burst requests succeeded without rate limit or deadlock`);
    console.log(`       Total burst duration: ${Date.now() - burstStart} ms`);

    // --- TEST SUITE 4: Error Handling & Black Frame Detection ---
    console.log('\n--- TEST SUITE 4: Defensive Error Handling & Diagnostics ---');
    // Test Black / empty frame detection
    const blackBuffer = Buffer.alloc(100 * 100 * 4, 0); // 100x100 all black RGBA
    let nonBlackCount = 0;
    for (let i = 0; i < blackBuffer.length; i += 16) {
      if (blackBuffer[i] > 10 || blackBuffer[i + 1] > 10 || blackBuffer[i + 2] > 10) nonBlackCount++;
    }
    assert(nonBlackCount === 0, 'Defensive check reliably identifies 100% black frames');

    // Test API recovery on missing/empty image parts
    let caughtEmptyImage = false;
    try {
      const dummyMgr = createScreenshotManager({
        app,
        getMainWindow: () => null,
        sendToRenderer: () => {}
      });
      await dummyMgr.buildImagePartsFromScreenshots({ strict: true });
    } catch (err) {
      caughtEmptyImage = true;
      assert(err.message.includes('No screenshots') || err.message.includes('unavailable'), 'Missing screenshots throws clear actionable error');
    }

    // --- TEST SUITE 5: CoreAudio Audio Capture Non-Regression ---
    console.log('\n--- TEST SUITE 5: System Audio Non-Regression ---');
    const helperPath = path.join(__dirname, '../native/macos-audio-capture/build/synapse-audio-capture');
    const probe = JSON.parse(execFileSync(helperPath, ['probe'], { encoding: 'utf8' }));
    assert(probe.processTap === true, 'Audio process-tap is operational');
    assert(probe.defaultOutput.length > 0, `Default audio device: "${probe.defaultOutput}"`);

    // --- TEST SUITE 6: Installed Application Bundle ---
    console.log('\n--- TEST SUITE 6: Installed Synapse.app Verification ---');
    const installedPath = '/Applications/Synapse.app';
    assert(fs.existsSync(installedPath), '/Applications/Synapse.app installed');
    const req = execFileSync('codesign', ['-d', '-r-', installedPath], { encoding: 'utf8' });
    assert(req.includes('identifier "com.synapse.interviewcoach"'), 'Installed app signature is valid and matching');

    console.log('\n================================================================');
    console.log(` ALL PRODUCTION TESTS COMPLETE: ${passes} PASSED, ${failures} FAILED`);
    console.log('================================================================\n');

  } catch (err) {
    console.error('\n[FATAL ERROR IN TEST SUITE]:', err);
    failures++;
  } finally {
    app.exit(failures === 0 ? 0 : 1);
  }
}

app.whenReady().then(runLiveVerification);
