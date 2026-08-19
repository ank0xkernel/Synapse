// AI provider configuration.
// Supported providers: 'gemini' and 'ollama'.
const AI_PROVIDERS = ['gemini', 'ollama'];
const DEFAULT_AI_PROVIDER = 'gemini';

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'llama3.2';

// Gemini model configuration.
// The first model in this list is treated as the default model everywhere.
//
// The 2.5 generation was removed here on 2026-08-09: Google now answers
// generateContent for those models with
//   404 "This model ... is no longer available to new users"
// for keys that had not already used them. `gemini-2.5-flash-lite` was the
// default and the persisted choice, so every analysis request failed — which
// surfaced in the UI as a misleading "check your internet connection".
//
// Every entry below was verified against the live API before being listed.
const GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview'
];

// Models that Google has retired. A stored preference pointing at one of these
// is silently migrated to the current default rather than left to 404 forever.
const RETIRED_GEMINI_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview'
];

// AssemblyAI speech model configuration.
// The first model in this list is treated as the default model everywhere.
const ASSEMBLY_AI_SPEECH_MODELS = [
  'universal-streaming-english',
  'universal-streaming-multilingual'
];

// Programming language configuration.
// The first language in this list is treated as the default language everywhere.
const PROGRAMMING_LANGUAGES = [
  'Python',
  'Java',
  'JavaScript',
  'TypeScript',
  'C++',
  'Go',
  'Rust',
  'C#',
  'Kotlin'
];

// Keyboard shortcuts configuration.
// Edit accelerators here to customize app shortcuts in one place.
const KEYBOARD_SHORTCUTS = [
  {
    id: 'toggleTranscription',
    buttonLabel: 'Transcription',
    description: 'Toggle transcription master control',
    accelerator: 'Alt+Shift+T'
  },
  {
    id: 'takeScreenshot',
    buttonLabel: 'Screenshot',
    description: 'Capture screenshot',
    accelerator: 'Alt+Shift+S'
  },
  {
    id: 'askAi',
    buttonLabel: 'Ask AI',
    description: 'Uses only enabled transcript, enabled screenshots, and enabled chat context',
    accelerator: 'Alt+Shift+A'
  },
  {
    id: 'screenAi',
    buttonLabel: 'Screen AI',
    description: 'Analyzes only enabled screenshots selected in chat',
    accelerator: 'Alt+Shift+E'
  },
  {
    id: 'suggest',
    buttonLabel: 'Suggest',
    description: 'Uses only enabled transcript context to suggest what to say next',
    accelerator: 'Alt+Shift+G'
  },
  {
    id: 'notes',
    buttonLabel: 'Notes',
    description: 'Generates notes from only enabled context',
    accelerator: 'Alt+Shift+N'
  },
  {
    id: 'insights',
    buttonLabel: 'Insights',
    description: 'Finds key insights from only enabled context',
    accelerator: 'Alt+Shift+I'
  },
  {
    id: 'clearChat',
    buttonLabel: 'Clear Chat',
    description: 'Clears chat, screenshots, and AI history',
    accelerator: 'Alt+Shift+C'
  },
  {
    id: 'emergencyHide',
    buttonLabel: 'Hide',
    description: 'Emergency hide',
    accelerator: 'Alt+Shift+X'
  },
  {
    id: 'toggleStealth',
    buttonLabel: 'Hide/Show',
    description: 'Hide or show the overlay window',
    accelerator: 'Alt+Shift+H'
  },
  {
    id: 'toggleClickThrough',
    buttonLabel: 'Click-through',
    description: 'Let mouse clicks pass through the overlay to whatever is behind it',
    // Bound globally, not just while the window has focus: this is the only
    // reliable way out of click-through mode, since the overlay's own toggle
    // button becomes unclickable the instant click-through turns on.
    accelerator: 'Alt+Shift+M'
  },
  {
    id: 'moveWindowLeft',
    buttonLabel: 'Move Window Left',
    description: 'Move window to left side',
    accelerator: 'Alt+Shift+Left'
  },
  {
    id: 'moveWindowRight',
    buttonLabel: 'Move Window Right',
    description: 'Move window to right side',
    accelerator: 'Alt+Shift+Right'
  },
  {
    id: 'moveWindowUp',
    buttonLabel: 'Move Window Up',
    description: 'Move window to top',
    accelerator: 'Alt+Shift+Up'
  },
  {
    id: 'moveWindowDown',
    buttonLabel: 'Move Window Down',
    description: 'Move window to bottom',
    accelerator: 'Alt+Shift+Down'
  },
  // Fine positioning. These sit alongside the Alt+Shift+Arrow snap shortcuts
  // above: those jump the overlay to a screen edge, these slide it a step at a
  // time so it can be tucked exactly where it needs to sit.
  //
  // CommandOrControl (not Command) so the binding survives the Windows and
  // Linux build targets — Electron ignores a macOS-only `Command` accelerator
  // elsewhere and registration would simply fail. On macOS this resolves to
  // Cmd+Arrow.
  //
  // Heads-up: as a global shortcut this shadows the OS text-navigation meaning
  // of Cmd+Arrow (start/end of line, top/bottom of document) in every app for
  // as long as Synapse is running. Rebind these rows in Settings → Shortcuts if
  // that gets in the way.
  {
    id: 'nudgeWindowLeft',
    buttonLabel: 'Nudge Left',
    description: 'Slide window left in small steps',
    accelerator: 'CommandOrControl+Left'
  },
  {
    id: 'nudgeWindowRight',
    buttonLabel: 'Nudge Right',
    description: 'Slide window right in small steps',
    accelerator: 'CommandOrControl+Right'
  },
  {
    id: 'nudgeWindowUp',
    buttonLabel: 'Nudge Up',
    description: 'Slide window up in small steps',
    accelerator: 'CommandOrControl+Up'
  },
  {
    id: 'nudgeWindowDown',
    buttonLabel: 'Nudge Down',
    description: 'Slide window down in small steps',
    accelerator: 'CommandOrControl+Down'
  },
  {
    id: 'windowSizePreset1',
    buttonLabel: 'Size Preset 1',
    description: 'Resize window to minimum size',
    accelerator: 'Alt+Shift+1'
  },
  {
    id: 'windowSizePreset2',
    buttonLabel: 'Size Preset 2',
    description: 'Resize window to +25% from minimum size',
    accelerator: 'Alt+Shift+2'
  },
  {
    id: 'windowSizePreset3',
    buttonLabel: 'Size Preset 3',
    description: 'Resize window to +50% from minimum size',
    accelerator: 'Alt+Shift+3'
  },
  {
    id: 'windowSizePreset4',
    buttonLabel: 'Size Preset 4',
    description: 'Resize window to +75% from minimum size',
    accelerator: 'Alt+Shift+4'
  }
];

// AI provider configuration functions
function getAiProviders() {
  return [...AI_PROVIDERS];
}

function getDefaultAiProvider() {
  return DEFAULT_AI_PROVIDER;
}

function isConfiguredAiProvider(providerName) {
  return AI_PROVIDERS.includes(providerName);
}

function resolveAiProvider(providerName) {
  return isConfiguredAiProvider(providerName) ? providerName : DEFAULT_AI_PROVIDER;
}

function getDefaultOllamaBaseUrl() {
  return DEFAULT_OLLAMA_BASE_URL;
}

function getDefaultOllamaModel() {
  return DEFAULT_OLLAMA_MODEL;
}

// Gemini model configuration functions
function getGeminiModels() {
  if (!Array.isArray(GEMINI_MODELS) || GEMINI_MODELS.length === 0) {
    throw new Error('Gemini models are not configured. Add at least one model to src/config.js.');
  }

  return [...GEMINI_MODELS];
}

function getDefaultGeminiModel() {
  return getGeminiModels()[0];
}

function isConfiguredGeminiModel(modelName) {
  return getGeminiModels().includes(modelName);
}

// User-chosen accelerators, layered over the defaults above. Populated from
// persisted app state at startup and whenever a shortcut is re-bound.
let shortcutOverrides = {};

function setShortcutOverrides(overrides = {}) {
  shortcutOverrides = overrides && typeof overrides === 'object' ? { ...overrides } : {};
  return shortcutOverrides;
}

function getShortcutOverrides() {
  return { ...shortcutOverrides };
}

function isRetiredGeminiModel(modelName) {
  return RETIRED_GEMINI_MODELS.includes(String(modelName || '').trim());
}

function resolveGeminiModel(modelName) {
  if (isConfiguredGeminiModel(modelName)) {
    return modelName;
  }

  const fallback = getDefaultGeminiModel();

  // Worth saying out loud: a silent swap here previously looked identical to
  // "the app ignored my setting".
  if (isRetiredGeminiModel(modelName)) {
    console.warn(
      `[Config] Gemini model "${modelName}" has been retired by Google and can no longer `
      + `serve requests. Switching to "${fallback}".`
    );
  } else if (modelName) {
    console.warn(`[Config] Unknown Gemini model "${modelName}". Falling back to "${fallback}".`);
  }

  return fallback;
}

// Programming language configuration functions
function getProgrammingLanguages() {
  if (!Array.isArray(PROGRAMMING_LANGUAGES) || PROGRAMMING_LANGUAGES.length === 0) {
    throw new Error('Programming languages are not configured. Add at least one language to src/config.js.');
  }

  return [...PROGRAMMING_LANGUAGES];
}

function getDefaultProgrammingLanguage() {
  return getProgrammingLanguages()[0];
}

function isConfiguredProgrammingLanguage(languageName) {
  return getProgrammingLanguages().includes(languageName);
}

function resolveProgrammingLanguage(languageName) {
  return isConfiguredProgrammingLanguage(languageName)
    ? languageName
    : getDefaultProgrammingLanguage();
}

// AssemblyAI speech model configuration functions
function getAssemblyAiSpeechModels() {
  if (!Array.isArray(ASSEMBLY_AI_SPEECH_MODELS) || ASSEMBLY_AI_SPEECH_MODELS.length === 0) {
    throw new Error('AssemblyAI speech models are not configured. Add at least one model to src/config.js.');
  }

  return [...ASSEMBLY_AI_SPEECH_MODELS];
}

function getDefaultAssemblyAiSpeechModel() {
  return getAssemblyAiSpeechModels()[0];
}

function isConfiguredAssemblyAiSpeechModel(modelName) {
  return getAssemblyAiSpeechModels().includes(modelName);
}

function resolveAssemblyAiSpeechModel(modelName, fallbackModel = getDefaultAssemblyAiSpeechModel()) {
  if (isConfiguredAssemblyAiSpeechModel(modelName)) {
    return modelName;
  }

  if (isConfiguredAssemblyAiSpeechModel(fallbackModel)) {
    return fallbackModel;
  }

  return getDefaultAssemblyAiSpeechModel();
}

function getKeyboardShortcuts() {
  if (!Array.isArray(KEYBOARD_SHORTCUTS) || KEYBOARD_SHORTCUTS.length === 0) {
    throw new Error('Keyboard shortcuts are not configured. Add at least one shortcut to src/config.js.');
  }

  return KEYBOARD_SHORTCUTS.map((shortcut) => ({ ...shortcut }));
}

function getKeyboardShortcutById(shortcutId) {
  const normalizedId = String(shortcutId || '').trim();
  if (!normalizedId) {
    throw new Error('Shortcut id is required.');
  }

  const shortcut = getKeyboardShortcuts().find((entry) => entry.id === normalizedId);
  if (!shortcut) {
    throw new Error(`Shortcut "${normalizedId}" is not configured in src/config.js.`);
  }

  return shortcut;
}

function getKeyboardShortcutAccelerator(shortcutId) {
  const shortcut = getKeyboardShortcutById(shortcutId);

  // A user override always wins over the built-in default.
  const override = String(shortcutOverrides[shortcut.id] || '').trim();
  const accelerator = override || String(shortcut.accelerator || '').trim();

  if (!accelerator) {
    throw new Error(`Shortcut "${shortcutId}" is missing an accelerator in src/config.js.`);
  }

  return accelerator;
}

module.exports = {
  getAiProviders,
  getDefaultAiProvider,
  getDefaultOllamaBaseUrl,
  getDefaultOllamaModel,
  isConfiguredAiProvider,
  resolveAiProvider,
  getAssemblyAiSpeechModels,
  getDefaultAssemblyAiSpeechModel,
  getGeminiModels,
  getDefaultGeminiModel,
  getKeyboardShortcutAccelerator,
  getKeyboardShortcutById,
  getKeyboardShortcuts,
  getShortcutOverrides,
  setShortcutOverrides,
  getDefaultProgrammingLanguage,
  getProgrammingLanguages,
  isConfiguredAssemblyAiSpeechModel,
  isConfiguredGeminiModel,
  isConfiguredProgrammingLanguage,
  isRetiredGeminiModel,
  resolveAssemblyAiSpeechModel,
  resolveGeminiModel,
  resolveProgrammingLanguage
};
