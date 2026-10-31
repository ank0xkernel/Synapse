#!/usr/bin/env node
'use strict';

/**
 * Pre-flight check for host-audio capture.
 *
 * Answers one question: if you start a call right now, will Synapse hear the
 * other person, or will it hear you? Run before any real call.
 *
 *   node scripts/diagnose-audio-capture.js
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_ROOT = path.join(__dirname, '..');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let failures = 0;
let warnings = 0;

function pass(label, detail) {
  console.log(`${GREEN}  ✓${RESET} ${label}${detail ? `  ${DIM}${detail}${RESET}` : ''}`);
}

function fail(label, detail) {
  failures += 1;
  console.log(`${RED}  ✗${RESET} ${label}${detail ? `\n     ${DIM}${detail}${RESET}` : ''}`);
}

function warn(label, detail) {
  warnings += 1;
  console.log(`${YELLOW}  !${RESET} ${label}${detail ? `\n     ${DIM}${detail}${RESET}` : ''}`);
}

function section(title) {
  console.log(`\n${BOLD}${title}${RESET}`);
}

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : String(stdout || ''));
    });
  });
}

const { buildNativeAudio, NATIVE_AUDIO_BINARY } = require('./build-native-audio');

async function checkPlatform() {
  section('Platform');
  if (process.platform !== 'darwin') {
    warn(`Not macOS (${process.platform})`, 'Native system audio capture is macOS only.');
    return false;
  }
  pass('macOS detected');
  return true;
}

async function checkNativeCapture() {
  section('Native system audio capture');

  try {
    const result = buildNativeAudio({ log: () => {} });
    pass(result.built ? 'Capture helper built' : 'Capture helper up to date', NATIVE_AUDIO_BINARY);
  } catch (error) {
    fail('Could not build the capture helper', error.message);
    return;
  }

  const probeRaw = await run(NATIVE_AUDIO_BINARY, ['probe']);
  let probe = null;
  try {
    probe = JSON.parse(probeRaw);
  } catch (_error) {
    fail('Capture helper probe failed', 'The helper did not return its capability report.');
    return;
  }

  console.log(`${DIM}     macOS ${probe.osVersion}, current output: ${probe.defaultOutput}${RESET}`);
  if (probe.processTap) {
    pass('Core Audio process tap available (macOS 14.2+)', 'Uses the "System Audio Recording" permission.');
  } else if (probe.screenCaptureKit) {
    pass('ScreenCaptureKit audio available (macOS 13+)', 'Uses the "Screen Recording" permission.');
  } else {
    fail('Native capture unsupported on this macOS version', 'Use the legacy BlackHole setup in docs/BLACKHOLE-SETUP.md.');
    return;
  }

  // Live check: capture 3 s while a system sound plays through whatever
  // output is selected. Output routing is never changed.
  const samples = await new Promise((resolve) => {
    const { spawn } = require('child_process');
    const child = spawn(NATIVE_AUDIO_BINARY, ['capture'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let peak = 0;
    let count = 0;
    let carry = Buffer.alloc(0);
    let lastError = null;
    child.stdout.on('data', (chunk) => {
      const buffer = Buffer.concat([carry, chunk]);
      const usable = buffer.length - (buffer.length % 4);
      for (let offset = 0; offset < usable; offset += 4) {
        const value = Math.abs(buffer.readFloatLE(offset));
        if (value > peak) peak = value;
      }
      count += usable / 4;
      carry = buffer.subarray(usable);
    });
    let started = false;
    child.stderr.on('data', (line) => {
      for (const entry of String(line).split('\n')) {
        try {
          const event = JSON.parse(entry);
          if (event.type === 'error') lastError = event;
          if (event.type === 'ready' && !started) {
            // Play only once the tap is live, then give it time to land.
            started = true;
            execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], () => {});
            setTimeout(() => child.kill('SIGTERM'), 2500);
          }
        } catch (_error) { /* partial line */ }
      }
    });
    setTimeout(() => child.kill('SIGTERM'), 15000);
    child.on('exit', () => resolve({ peak, count, lastError }));
  });

  if (samples.lastError) {
    fail(`Capture failed: ${samples.lastError.code}`, samples.lastError.message);
  } else if (samples.count === 0) {
    fail('No audio frames arrived from the helper');
  } else if (samples.peak < 0.0008) {
    warn(
      'Frames arrived but the test sound was not heard',
      'Allow the app in System Settings → Privacy & Security → Screen & System Audio Recording, and make sure output volume is not muted.'
    );
  } else {
    pass(`Heard the test sound through "${probe.defaultOutput}"`, `peak ${(20 * Math.log10(samples.peak)).toFixed(1)} dBFS, ${samples.count} samples`);
  }
}

function readAppState() {
  const statePath = path.join(PROJECT_ROOT, 'cache', 'app-state.json');
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function checkAssemblyKey(state) {
  return new Promise((resolve) => {
    const apiKey = state?.assemblyAiApiKey;
    if (!apiKey) {
      fail('AssemblyAI API key not configured', 'Add it in Synapse → Settings.');
      resolve(false);
      return;
    }

    const request = https.request({
      hostname: 'api.assemblyai.com',
      path: '/v2/transcript?limit=1',
      method: 'GET',
      headers: { Authorization: apiKey },
      timeout: 10000
    }, (response) => {
      response.resume();
      if (response.statusCode === 200) {
        pass('AssemblyAI key accepted');
        resolve(true);
      } else {
        fail(`AssemblyAI rejected the key (HTTP ${response.statusCode})`);
        resolve(false);
      }
    });

    request.on('timeout', () => {
      request.destroy();
      warn('AssemblyAI check timed out', 'Network issue, or the API is unreachable.');
      resolve(false);
    });
    request.on('error', (error) => {
      warn('AssemblyAI check failed', error.message);
      resolve(false);
    });
    request.end();
  });
}

async function checkTranscription() {
  section('Transcription backend');
  const state = readAppState();
  if (!state) {
    warn('No cache/app-state.json yet', 'Launch Synapse once and save your settings.');
    return;
  }
  await checkAssemblyKey(state);
  console.log(`${DIM}     Speech model: ${state.assemblyAiSpeechModel || 'default'}${RESET}`);
}

function printManualSteps() {
  section('Manual verification (do this before a real call)');
  console.log(`
  1. In System Settings → Sound → Output, select ${BOLD}MacBook Speakers${RESET} (or your headphones).
  2. Start Synapse. Turn the ${BOLD}Host${RESET} source on. Leave the Mic source ${BOLD}off${RESET}.
  3. Play any talking video on the Mac (a YouTube interview works well).
     ${BOLD}Expected:${RESET} you still hear it normally, and its speech appears as the Host transcript.
  4. Speak out loud without touching the Mic toggle.
     ${BOLD}Expected:${RESET} nothing new appears under Host.
  5. Plug in or unplug headphones mid-playback.
     ${BOLD}Expected:${RESET} audio keeps playing on the new device and the transcript continues
     after a short gap (the capture follows the new output).
`);
}

async function main() {
  console.log(`${BOLD}Synapse — host audio capture diagnostic${RESET}`);

  const isMac = await checkPlatform();
  if (isMac) {
    await checkNativeCapture();
  }
  await checkTranscription();
  printManualSteps();

  section('Result');
  if (failures > 0) {
    console.log(`${RED}  ${failures} blocking issue(s)${RESET}${warnings ? `, ${warnings} warning(s)` : ''}.`);
    console.log(`${DIM}  Synapse will not hear the other person until these are fixed.${RESET}\n`);
    process.exit(1);
  }

  if (warnings > 0) {
    console.log(`${YELLOW}  Ready, with ${warnings} warning(s).${RESET}\n`);
  } else {
    console.log(`${GREEN}  All checks passed — host audio should transcribe correctly.${RESET}\n`);
  }
}

main().catch((error) => {
  console.error('Diagnostic crashed:', error);
  process.exit(1);
});
