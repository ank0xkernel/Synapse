#!/usr/bin/env node
'use strict';

/**
 * Measures real CPU and memory of every Synapse process (Electron main,
 * renderer, GPU, utility helpers, native audio helper) while the real app
 * runs a scenario.
 *
 *   node scripts/profile-resources.js idle      [seconds]
 *   node scripts/profile-resources.js streaming [seconds]   long streamed answer
 *   node scripts/profile-resources.js helper    [seconds]   native capture helper alone
 *
 * Samples `ps` once per second after a warm-up. macOS `ps` %CPU is a
 * short decaying average, so numbers are indicative, not exact; compare runs
 * on the same Mac. Prints averages and peaks per process type.
 */

const { spawn, execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const scenario = process.argv[2] || 'idle';
const seconds = Number(process.argv[3]) || 20;
const WARMUP_MS = 8000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processTable() {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,%cpu=,rss=,comm='], { encoding: 'utf8' });
  return out.trim().split('\n').map((line) => {
    const [pid, ppid, cpu, rss, ...comm] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), cpu: Number(cpu), rssMb: Number(rss) / 1024, comm: comm.join(' ') };
  });
}

function descendants(rootPid, table) {
  const ids = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of table) {
      if (!ids.has(row.pid) && ids.has(row.ppid)) {
        ids.add(row.pid);
        grew = true;
      }
    }
  }
  return table.filter((row) => ids.has(row.pid));
}

function label(comm) {
  if (/synapse-audio-capture/.test(comm)) return 'native-helper';
  if (/Renderer/.test(comm)) return 'renderer';
  if (/GPU/.test(comm)) return 'gpu';
  if (/Helper/.test(comm)) return 'utility';
  if (/afplay|say/.test(comm)) return null;
  return 'main';
}

async function sample(rootPid, durationSec) {
  const series = {};
  for (let second = 0; second < durationSec; second += 1) {
    const rows = descendants(rootPid, processTable());
    const totals = {};
    for (const row of rows) {
      const key = label(row.comm);
      if (!key) continue;
      totals[key] = totals[key] || { cpu: 0, rssMb: 0 };
      totals[key].cpu += row.cpu;
      totals[key].rssMb += row.rssMb;
    }
    for (const [key, value] of Object.entries(totals)) {
      (series[key] = series[key] || []).push(value);
    }
    await sleep(1000);
  }
  return series;
}

function summarize(series) {
  const rows = [];
  let totalCpu = 0;
  let totalRss = 0;
  for (const [key, values] of Object.entries(series)) {
    const avgCpu = values.reduce((sum, v) => sum + v.cpu, 0) / values.length;
    const maxCpu = Math.max(...values.map((v) => v.cpu));
    const rss = values.map((v) => v.rssMb);
    totalCpu += avgCpu;
    totalRss += rss[rss.length - 1];
    rows.push({ process: key, avgCpu: +avgCpu.toFixed(1), peakCpu: +maxCpu.toFixed(1), rssStartMb: Math.round(rss[0]), rssEndMb: Math.round(rss[rss.length - 1]) });
  }
  rows.sort((a, b) => b.avgCpu - a.avgCpu);
  return { rows, totalAvgCpu: +totalCpu.toFixed(1), totalRssMb: Math.round(totalRss) };
}

async function profileApp(extraEnv) {
  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), ['.'], { cwd: ROOT, env, stdio: 'ignore' });
  await sleep(WARMUP_MS);
  const series = await sample(child.pid, seconds);
  child.kill('SIGTERM');
  await sleep(1500);
  try { child.kill('SIGKILL'); } catch (_) { /* already exited */ }
  return summarize(series);
}

async function profileHelper() {
  const { NATIVE_AUDIO_BINARY, buildNativeAudio } = require('./build-native-audio');
  buildNativeAudio({ log: () => {} });
  const child = spawn(NATIVE_AUDIO_BINARY, ['capture'], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdout.resume();
  const speaker = spawn('say', ['-r', '170', 'This is a continuous speech sample used to measure the capture helper. '.repeat(12)]);
  await sleep(2000);
  const series = await sample(child.pid, seconds);
  speaker.kill();
  child.kill('SIGTERM');
  return summarize(series);
}

async function main() {
  let result;
  if (scenario === 'helper') result = await profileHelper();
  else if (scenario === 'streaming') result = await profileApp({ SYNAPSE_UI_CAPTURE: path.join(ROOT, '.profile-tmp'), SYNAPSE_UI_SCENES: 'stress' });
  else result = await profileApp({});

  console.log(`Scenario: ${scenario}, ${seconds}s sampled after ${WARMUP_MS / 1000}s warm-up`);
  console.table(result.rows);
  console.log(`Total average CPU: ${result.totalAvgCpu}%  (100% = one core)   Total RSS at end: ${result.totalRssMb} MB`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
