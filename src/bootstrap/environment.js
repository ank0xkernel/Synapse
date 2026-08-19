const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const OPTIONAL_ENV_DEFAULTS = Object.freeze({
  HIDE_NOTES_FROM_SCREEN_SHARE: 'true',
  START_HIDDEN: 'false',
  MAX_SCREENSHOTS: '50',
  SCREENSHOT_DELAY: '300',
  NODE_ENV: 'production',
  NODE_OPTIONS: '--max-old-space-size=4096'
});

function normalizeGeminiApiKeys(value) {
  const sourceValues = Array.isArray(value)
    ? value
    : String(value ?? '').split(',');
  const seen = new Set();
  const keys = [];

  for (const rawValue of sourceValues) {
    const key = String(rawValue || '').trim();
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    keys.push(key);
  }

  return keys;
}

function getEnvPath(app) {
  return app.isPackaged
    ? path.join(process.resourcesPath, '.env')
    : path.join(__dirname, '..', '..', '.env');
}

function parseBoolean(value, defaultValue) {
  if (value == null || value === '') {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function parsePositiveInteger(value, defaultValue) {
  const parsedValue = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : defaultValue;
}

function normalizeApplicationEnvironment(source = {}) {
  const geminiApiKeys = normalizeGeminiApiKeys(
    source.geminiApiKey ?? source.geminiApiKeys
  );

  return {
    geminiApiKey: geminiApiKeys.join(','),
    geminiApiKeys,
    assemblyAiApiKey: String(source.assemblyAiApiKey || '').trim(),
    // HIDE_FROM_SCREEN_CAPTURE is the pre-1.0 name, still honoured so existing
    // .env files keep working.
    hideFromScreenCapture: parseBoolean(
      source.HIDE_NOTES_FROM_SCREEN_SHARE
        ?? source.hideNotesFromScreenShare
        ?? source.HIDE_FROM_SCREEN_CAPTURE
        ?? source.hideFromScreenCapture,
      parseBoolean(OPTIONAL_ENV_DEFAULTS.HIDE_NOTES_FROM_SCREEN_SHARE, true)
    ),
    startHidden: parseBoolean(
      source.START_HIDDEN ?? source.startHidden,
      parseBoolean(OPTIONAL_ENV_DEFAULTS.START_HIDDEN, false)
    ),
    maxScreenshots: parsePositiveInteger(
      source.MAX_SCREENSHOTS ?? source.maxScreenshots,
      parsePositiveInteger(OPTIONAL_ENV_DEFAULTS.MAX_SCREENSHOTS, 50)
    ),
    screenshotDelay: parsePositiveInteger(
      source.SCREENSHOT_DELAY ?? source.screenshotDelay,
      parsePositiveInteger(OPTIONAL_ENV_DEFAULTS.SCREENSHOT_DELAY, 300)
    ),
    nodeEnv: String(source.NODE_ENV || source.nodeEnv || OPTIONAL_ENV_DEFAULTS.NODE_ENV).trim() || OPTIONAL_ENV_DEFAULTS.NODE_ENV,
    nodeOptions: String(source.NODE_OPTIONS || source.nodeOptions || OPTIONAL_ENV_DEFAULTS.NODE_OPTIONS).trim() || OPTIONAL_ENV_DEFAULTS.NODE_OPTIONS
  };
}

function syncProcessEnvironment(environment) {
  process.env.GEMINI_API_KEY = environment.geminiApiKey;
  process.env.ASSEMBLY_AI_API_KEY = environment.assemblyAiApiKey;
  process.env.HIDE_NOTES_FROM_SCREEN_SHARE = String(environment.hideFromScreenCapture);
  process.env.START_HIDDEN = String(environment.startHidden);
  process.env.MAX_SCREENSHOTS = String(environment.maxScreenshots);
  process.env.SCREENSHOT_DELAY = String(environment.screenshotDelay);
  process.env.NODE_ENV = environment.nodeEnv;
  // NODE_OPTIONS is deliberately NOT written back to process.env. Electron reads
  // it only at process launch and rejects it afterwards ("Most NODE_OPTIONs are
  // not supported in packaged apps"), so assigning it here achieved nothing
  // except an ERROR line on every boot. The heap limit is applied through the
  // js-flags command-line switch in start-application.js instead.
}

function validateRequiredEnvironment(environment, envPath) {
  void environment;
  void envPath;
}

function loadApplicationEnvironment(app) {
  const envPath = getEnvPath(app);

  // dotenv writes every key it finds straight into process.env, including
  // NODE_OPTIONS. Electron re-reads that variable and rejects it once the
  // process is already running, printing an ERROR on every launch. The value is
  // still parsed and reported below; it is just applied via the js-flags switch
  // in start-application.js instead of through the environment.
  const nodeOptionsBefore = process.env.NODE_OPTIONS;
  const parsed = dotenv.config({ path: envPath });

  if (nodeOptionsBefore === undefined) {
    delete process.env.NODE_OPTIONS;
  } else {
    process.env.NODE_OPTIONS = nodeOptionsBefore;
  }

  const environment = normalizeApplicationEnvironment({
    ...process.env,
    // Keep the file's NODE_OPTIONS visible to the normalizer/startup log even
    // though it never reaches process.env.
    NODE_OPTIONS: parsed?.parsed?.NODE_OPTIONS || nodeOptionsBefore
  });
  syncProcessEnvironment(environment);
  validateRequiredEnvironment(environment, envPath);

  return {
    envPath,
    ...environment
  };
}

function buildEnvironmentFileContent(environment) {
  return [
    '# API keys are managed in the in-app Settings UI and stored in app state.',
    '# Do not place API keys in this file.',
    '',
    '# Screen-share privacy for the coaching notes window.',
    '# true  = your private notes/prompts stay out of a shared screen',
    '# false = the notes window appears in screen shares like any other window',
    `HIDE_NOTES_FROM_SCREEN_SHARE=${environment.hideFromScreenCapture}`,
    '',
    '# Optional startup mode',
    '# true = start the window hidden (background mode)',
    '# false = show the window on startup',
    `START_HIDDEN=${environment.startHidden}`,
    '',
    '# Optional screenshot settings',
    `MAX_SCREENSHOTS=${environment.maxScreenshots}`,
    `SCREENSHOT_DELAY=${environment.screenshotDelay}`,
    '',
    '# Optional runtime settings',
    `NODE_ENV=${environment.nodeEnv}`,
    `NODE_OPTIONS=${environment.nodeOptions}`,
    ''
  ].join('\n');
}

function saveApplicationEnvironment(app, values = {}) {
  const envPath = getEnvPath(app);
  const environment = normalizeApplicationEnvironment(values);
  syncProcessEnvironment(environment);
  fs.writeFileSync(envPath, buildEnvironmentFileContent(environment), 'utf8');

  try {
    // This file's origin (electron-builder's extraResources copy) does not
    // set a mode, so it can end up world-readable despite carrying API keys.
    // Re-assert owner-only permissions on every save, not just at build time.
    fs.chmodSync(envPath, 0o600);
  } catch (_error) {
    // Best-effort — some filesystems (e.g. exFAT) don't support unix modes.
  }

  return {
    envPath,
    ...environment
  };
}

module.exports = {
  OPTIONAL_ENV_DEFAULTS,
  buildEnvironmentFileContent,
  getEnvPath,
  loadApplicationEnvironment,
  normalizeGeminiApiKeys,
  normalizeApplicationEnvironment,
  saveApplicationEnvironment
};
