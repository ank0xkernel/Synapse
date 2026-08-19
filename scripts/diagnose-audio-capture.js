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

async function getAudioProfile() {
  const raw = await run('system_profiler', ['-json', 'SPAudioDataType']);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    const items = parsed.SPAudioDataType || [];
    return items.flatMap((entry) => entry._items || []);
  } catch (_error) {
    return [];
  }
}

function isLoopbackName(name) {
  return /blackhole|soundflower|loopback|vb-?cable/i.test(String(name || ''));
}

async function checkPlatform() {
  section('Platform');
  if (process.platform !== 'darwin') {
    warn(`Not macOS (${process.platform})`, 'This diagnostic targets the macOS loopback setup.');
    return false;
  }
  pass('macOS detected');
  return true;
}

async function checkDevices() {
  section('Audio devices');
  const devices = await getAudioProfile();

  if (devices.length === 0) {
    fail('Could not read audio devices', 'system_profiler returned nothing.');
    return null;
  }

  const loopback = devices.find((device) => isLoopbackName(device._name));
  const defaultOutput = devices.find((device) => device.coreaudio_default_audio_output_device === 'spaudio_yes');
  const defaultInput = devices.find((device) => device.coreaudio_default_audio_input_device === 'spaudio_yes');

  if (loopback) {
    pass(`Loopback device installed: ${loopback._name}`);
  } else {
    fail('No loopback device found', 'Run: brew install blackhole-2ch   (then log out and back in)');
  }

  if (defaultOutput) {
    const name = defaultOutput._name;
    if (isLoopbackName(name)) {
      warn(`Output is raw ${name}`, 'You will not hear the call. Use a Multi-Output Device instead.');
    } else if (/multi-?output|aggregate|synapse/i.test(name)) {
      pass(`Output routed through "${name}"`);
    } else {
      fail(
        `Output is "${name}" — call audio is NOT reaching the loopback device`,
        'Set output to a Multi-Output Device containing BlackHole 2ch. See docs/BLACKHOLE-SETUP.md'
      );
    }
  } else {
    warn('Could not determine the default output device');
  }

  if (defaultInput) {
    console.log(`${DIM}     Default input (used only for the nudge engine): ${defaultInput._name}${RESET}`);
  }

  return { loopback, defaultOutput };
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

function checkSetupGuide() {
  section('Setup guide');
  const guide = path.join(PROJECT_ROOT, 'docs', 'BLACKHOLE-SETUP.md');
  if (fs.existsSync(guide)) {
    pass('docs/BLACKHOLE-SETUP.md present', 'The in-app "Open setup guide" button opens this.');
  } else {
    fail('docs/BLACKHOLE-SETUP.md missing', 'The in-app setup button will fail.');
  }
}

function printManualSteps() {
  section('Manual verification (do this before a real call)');
  console.log(`
  1. Start Synapse and open the phone companion.
  2. Turn the ${BOLD}Host${RESET} source on. Leave the Mic source ${BOLD}off${RESET}.
  3. Confirm the companion's ${BOLD}System Audio${RESET} dot is green.
  4. Play any talking video on the Mac (a YouTube interview works well).
  5. ${BOLD}Expected:${RESET} the video's speech appears as the Host transcript.
  6. Now speak out loud without touching the Mic toggle.
     ${BOLD}Expected:${RESET} nothing new appears. If your own voice shows up under
     Host, capture is still on the built-in mic — recheck your output routing.
  7. Switch your output to plain speakers mid-playback.
     ${BOLD}Expected:${RESET} the dot turns amber ("Reconnecting"), then red if the
     device stays gone.
`);
}

async function main() {
  console.log(`${BOLD}Synapse — host audio capture diagnostic${RESET}`);

  const isMac = await checkPlatform();
  if (isMac) {
    await checkDevices();
  }
  await checkTranscription();
  checkSetupGuide();
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
