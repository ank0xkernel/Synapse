#!/usr/bin/env node
'use strict';

/**
 * End-to-end host-audio transcription test, without Electron in the way.
 *
 * Records the BlackHole loopback device exactly as the app does — 16 kHz mono
 * PCM16, 100 ms frames — streams it to AssemblyAI, and prints what comes back.
 *
 * If this prints the words coming out of your speakers, the capture and STT
 * layers are healthy and any remaining problem is in the app UI. If it prints
 * nothing, the audio is not reaching BlackHole.
 *
 *   node scripts/test-host-transcription.js [seconds] [speech-model]
 *
 * The speech model defaults to whatever Settings has stored, so this exercises
 * the same configuration the app will use.
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const DURATION_SECONDS = Number.parseInt(process.argv[2] || '15', 10);
const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = SAMPLE_RATE / 10; // 100 ms
const FRAME_BYTES = FRAME_SAMPLES * 2;  // 16-bit mono

const PROJECT_ROOT = path.join(__dirname, '..');

function loadState() {
  const statePath = path.join(PROJECT_ROOT, 'cache', 'app-state.json');
  if (!fs.existsSync(statePath)) {
    console.error('No cache/app-state.json — launch Synapse once and save settings.');
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!state.assemblyAiApiKey) {
    console.error('No AssemblyAI key configured in Settings.');
    process.exit(1);
  }
  return state;
}

function findBlackHoleIndex() {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
      (_error, _stdout, stderr) => {
        const audioSection = String(stderr).split('AVFoundation audio devices:')[1] || '';
        const match = audioSection.match(/\[(\d+)\]\s*BlackHole/i);
        resolve(match ? match[1] : null);
      });
  });
}

async function main() {
  const state = loadState();
  const apiKey = state.assemblyAiApiKey;
  const speechModel = process.argv[3] || state.assemblyAiSpeechModel || 'universal-streaming-english';
  const deviceIndex = await findBlackHoleIndex();

  if (deviceIndex === null) {
    console.error('BlackHole not found in avfoundation devices. Run: brew install blackhole-2ch');
    process.exit(1);
  }

  console.log(`Recording BlackHole (avfoundation :${deviceIndex}) for ${DURATION_SECONDS}s`);
  console.log('Play audio through your "Synapse Output" device now.\n');

  console.log(`Speech model: ${speechModel}\n`);

  const params = new URLSearchParams({
    sample_rate: String(SAMPLE_RATE),
    format_turns: 'true',
    speech_model: speechModel
  });

  const ws = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?${params}`, {
    headers: { Authorization: apiKey }
  });

  let ffmpeg = null;
  let pending = Buffer.alloc(0);
  let framesSent = 0;
  let silentFrames = 0;
  let finals = 0;

  // Same silence yardstick the app's monitor uses, so a "connected but silent"
  // run is distinguishable from a genuinely broken one.
  function frameIsSilent(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i += 2) {
      const sample = frame.readInt16LE(i) / 32768;
      sum += sample * sample;
    }
    return Math.sqrt(sum / (frame.length / 2)) < 0.0005;
  }

  ws.on('open', () => {
    console.log('AssemblyAI connected.\n');

    ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'avfoundation', '-i', `:${deviceIndex}`,
      '-t', String(DURATION_SECONDS),
      '-ac', '1', '-ar', String(SAMPLE_RATE),
      '-f', 's16le', '-'
    ]);

    ffmpeg.stdout.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);

      while (pending.length >= FRAME_BYTES) {
        const frame = pending.subarray(0, FRAME_BYTES);
        pending = pending.subarray(FRAME_BYTES);

        if (frameIsSilent(frame)) silentFrames += 1;
        framesSent += 1;

        if (ws.readyState === WebSocket.OPEN) ws.send(frame);
      }
    });

    ffmpeg.on('exit', () => {
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'Terminate' }));
      }, 1500);
    });
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === 'Turn' && msg.transcript) {
      if (msg.end_of_turn) {
        finals += 1;
        console.log(`  FINAL:   ${msg.transcript}`);
      } else {
        process.stdout.write(`  partial: ${msg.transcript}\r`);
      }
    }

    if (msg.type === 'Termination') ws.close();
  });

  ws.on('error', (error) => {
    console.error('AssemblyAI error:', error.message);
    process.exit(1);
  });

  ws.on('close', () => {
    const silentPct = framesSent ? Math.round((silentFrames / framesSent) * 100) : 100;

    console.log('\n\n─── Result ────────────────────────────────');
    console.log(`  Frames streamed : ${framesSent}`);
    console.log(`  Silent frames   : ${silentPct}%`);
    console.log(`  Final transcripts: ${finals}`);

    if (finals > 0) {
      console.log('\n  PASS — host audio is being captured and transcribed.');
    } else if (silentPct > 95) {
      console.log('\n  FAIL — BlackHole received only silence.');
      console.log('  Your call audio is not routed to it. Run:');
      console.log('    scripts/audio-routing/synapse-audio-routing create --set-default');
    } else {
      console.log('\n  FAIL — audio arrived but produced no transcript.');
      console.log('  Check that the audio contains intelligible speech.');
    }

    try { ffmpeg?.kill(); } catch (_) { /* already gone */ }
    process.exit(finals > 0 ? 0 : 1);
  });
}

main();
