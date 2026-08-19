'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Decides which local services this machine can actually run.
 *
 * The local stack (a warm 7B LLM plus a medium Whisper model) needs roughly
 * 16 GB to sit in memory without swapping. Starting it on a smaller machine
 * doesn't degrade gracefully — it thrashes swap and takes the whole desktop
 * down with it. So we measure first and refuse loudly rather than hang.
 */

const GB = 1024 ** 3;

// Below this, a 7B model cannot stay resident alongside Electron + the OS.
const MIN_RAM_FOR_LOCAL_LLM_GB = 12;

// Below this, even a small local model is a bad idea.
const MIN_RAM_FOR_SMALL_LLM_GB = 8;

function getTotalMemoryGb() {
  return os.totalmem() / GB;
}

function getFreeMemoryGb() {
  return os.freemem() / GB;
}

/**
 * Ranked from smallest to largest. On a constrained machine we pick the
 * largest model that still fits rather than whatever happens to be installed.
 */
const MODEL_SIZE_HINTS = [
  { pattern: /:0\.5b|:1b|:1\.5b/i, approxGb: 1.2 },
  { pattern: /:2b|:3b/i, approxGb: 2.4 },
  { pattern: /:7b|:8b/i, approxGb: 5.0 },
  { pattern: /:13b|:14b/i, approxGb: 9.0 },
  { pattern: /:32b|:34b|:70b/i, approxGb: 20.0 }
];

function estimateModelGb(modelName) {
  const name = String(modelName || '');
  for (const hint of MODEL_SIZE_HINTS) {
    if (hint.pattern.test(name)) return hint.approxGb;
  }
  return 5.0; // unknown tag: assume 7B-class rather than under-estimate
}

/**
 * Picks the largest installed model that fits in the memory budget.
 * @param {string[]} availableModels
 * @returns {{ model: string|null, reason: string }}
 */
function selectModelForMemory(availableModels = []) {
  const totalGb = getTotalMemoryGb();

  if (totalGb < MIN_RAM_FOR_SMALL_LLM_GB) {
    return {
      model: null,
      reason: `${totalGb.toFixed(1)} GB RAM is below the ${MIN_RAM_FOR_SMALL_LLM_GB} GB minimum for local inference.`
    };
  }

  // Leave headroom for Electron, the OS, and the browser running your call.
  const budgetGb = Math.max(1.5, totalGb * 0.45);

  const fitting = availableModels
    .map((model) => ({ model, sizeGb: estimateModelGb(model) }))
    .filter((entry) => entry.sizeGb <= budgetGb)
    .sort((a, b) => b.sizeGb - a.sizeGb);

  if (fitting.length === 0) {
    return {
      model: null,
      reason: `No installed model fits the ~${budgetGb.toFixed(1)} GB budget on this ${totalGb.toFixed(1)} GB machine.`
    };
  }

  return {
    model: fitting[0].model,
    reason: `Selected ${fitting[0].model} (~${fitting[0].sizeGb} GB) within a ~${budgetGb.toFixed(1)} GB budget.`
  };
}

function canRunLocalLlm() {
  return getTotalMemoryGb() >= MIN_RAM_FOR_LOCAL_LLM_GB;
}

/**
 * Whisper is only startable when the binary AND the model file both exist.
 * Spawning it without a model produces an instant-exit restart storm.
 */
function checkWhisperAssets(binaryPath, modelPath) {
  const hasBinary = fs.existsSync(binaryPath);
  const hasModel = fs.existsSync(modelPath);

  const missing = [];
  if (!hasBinary) missing.push(`binary not found at ${binaryPath}`);
  if (!hasModel) missing.push(`model not found at ${modelPath}`);

  return {
    available: hasBinary && hasModel,
    missing,
    hint: hasBinary && !hasModel
      ? `Download it with: bash ${path.join(path.dirname(binaryPath), 'models', 'download-ggml-model.sh')} ${path.basename(modelPath).replace(/^ggml-|\.bin$/g, '')}`
      : null
  };
}

function describeMachine() {
  return `${os.cpus()[0]?.model || 'unknown CPU'}, ${getTotalMemoryGb().toFixed(1)} GB RAM`;
}

module.exports = {
  MIN_RAM_FOR_LOCAL_LLM_GB,
  MIN_RAM_FOR_SMALL_LLM_GB,
  canRunLocalLlm,
  checkWhisperAssets,
  describeMachine,
  estimateModelGb,
  getFreeMemoryGb,
  getTotalMemoryGb,
  selectModelForMemory
};
