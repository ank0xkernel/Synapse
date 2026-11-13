/// <reference path="./renderer-globals.d.ts" />

import { createMessageStore } from './renderer/features/ai-context/message-store.js';
import { buildFilteredAiContextBundle as buildAiContextBundle } from './renderer/features/ai-context/context-bundle.js';
import { updateMessageAiToggleUi as syncMessageAiToggleUi } from './renderer/features/ai-context/toggle-ui.js';
import { createChatUiManager } from './renderer/features/chat/chat-ui-manager.js';
import { createWindowAdjustmentManager } from './renderer/features/layout/window-adjustments.js';
import { setupEventListeners as setupEventListenersModule } from './renderer/features/listeners/event-listeners.js';
import { setupIpcListeners as setupIpcListenersModule } from './renderer/features/listeners/ipc-listeners.js';
import { createShortcutManager } from './renderer/features/settings/shortcut-manager.js';
import { createSettingsPanelManager } from './renderer/features/settings/settings-panel-manager.js';
import { createTranscriptionManager } from './renderer/features/transcription/transcription-manager.js';
import { deriveSessionState, applySessionState } from './renderer/features/session/session-state.js';
import { initPanels } from './renderer/features/panels/panels.js';
import { initConversationHistory, persistMessage, toChatType } from './renderer/features/conversations/conversation-history.js';

const sessionStateEl = document.getElementById('session-state');
const sessionStateLabelEl = document.getElementById('session-state-label');
const sessionAnswerState = { pending: false, streaming: false, error: null };
let sessionWasListening = false;
let transcriptionManagerReady = false;

import {
    createTranscriptionSourceState,
    normalizeSource as normalizeAssemblySource,
    sourceLabel as resolveSourceLabel
} from './renderer/features/assembly-ai/source-state.js';
import { createAudioPipeline } from './renderer/features/assembly-ai/audio-pipeline.js';
import { createTranscriptBufferManager } from './renderer/features/assembly-ai/transcript-buffer.js';
// Renderer with AssemblyAI Streaming Transcription - Real-time & Accurate!
// Uses AssemblyAI WebSocket API for live speech-to-text

let screenshotsCount = 0;
let isAnalyzing = false;
let stealthHideTimeout = null;
const THEME_STORAGE_KEY = 'assistant-theme';
const THEME_LIGHT = 'light';
const THEME_DARK = 'dark';
let activeTheme = THEME_LIGHT;
const AI_CONTEXT_CHAR_BUDGET = 12000;
// The problem continuous screen monitoring says is on screen now (null when
// not monitoring or not yet identified). New answers are stamped with it.
let activeScreenProblemId = null;
let lastIdentifiedProblemId = null;
const messageStore = createMessageStore({ getActiveProblemId: () => activeScreenProblemId });
let chatMessagesArray = messageStore.getMessages();

// When the screen moves to a different problem, answers about the previous
// one stop being sent as context. They stay visible and can be toggled back.
function onScreenProblemSnapshot(snapshot) {
    const problem = snapshot && snapshot.monitoring !== 'stopped' ? snapshot.problem : null;
    const nextId = problem && problem.status === 'identified' ? problem.id : null;
    if (!nextId) {
        // Stopped, or still reading / unable to tell: answers started now are
        // not stamped with the previous problem (they get the real one at the
        // end via setProblemId). The last identified id is kept for comparison.
        if (!snapshot || snapshot.monitoring === 'stopped') lastIdentifiedProblemId = null;
        activeScreenProblemId = null;
        return;
    }
    activeScreenProblemId = nextId;
    if (nextId === lastIdentifiedProblemId) return;
    const hadProblem = lastIdentifiedProblemId !== null;
    lastIdentifiedProblemId = nextId;
    const excluded = messageStore.excludeOtherProblems(nextId);
    if (!excluded.length && !excluded.restored.length && !hadProblem) return;
    chatMessagesArray = messageStore.getMessages();
    for (const message of [...excluded, ...excluded.restored]) updateMessageAiToggleUi(message);
    const title = problem.title ? `“${problem.title}”` : 'a different problem';
    const parts = [`Screen moved to ${title}.`];
    if (excluded.length) parts.push(`${excluded.length} answer(s) about the previous problem were excluded from AI context.`);
    if (excluded.restored.length) parts.push(`${excluded.restored.length} earlier answer(s) about this problem are back in context.`);
    addChatMessage('system', parts.join(' '));
    updateUI();
}
window.electronAPI?.onScreenIntelState?.(onScreenProblemSnapshot);

// New Problem: earlier messages stay visible but leave the AI context, the
// screenshot list empties (main drops the images) and no problem is assumed
// until the new screen has been read.
window.addEventListener('synapse:new-problem', () => {
    const excluded = messageStore.startNewProblem();
    activeScreenProblemId = null;
    lastIdentifiedProblemId = null;
    chatMessagesArray = messageStore.getMessages();
    for (const message of excluded) updateMessageAiToggleUi(message);
    screenshotsCount = 0;
    addChatMessage('system', excluded.length
        ? `New problem. ${excluded.length} earlier message(s) are no longer sent to the AI; the screen is read again from scratch.`
        : 'New problem. The screen is read again from scratch.');
    updateUI();
});
const transcriptionSourceState = createTranscriptionSourceState();

// Source selection state (default: host/system on, mic off)
const selectedSources = transcriptionSourceState.selectedSources;

const audioPipeline = createAudioPipeline({
    sendAudioChunk: (source, audioBuffer) => {
        window.electronAPI.sendAudioChunk(source, audioBuffer);
    },
    addMonitorLog: (...args) => addMonitorLog(...args)
});

const transcriptBufferManager = createTranscriptBufferManager({
    // Was 3500ms — nearly 3s longer than auto-answer.js's own longest settle
    // wait (1100ms), so the chat message for a turn routinely landed *after*
    // the click that was supposed to be answering it (see the
    // __synapseFlushHostTranscript bridge below, which forces this buffer to
    // flush synchronously before that click). 900ms still merges a genuine
    // AssemblyAI turn split across a breath-pause, without leaving a
    // statement that never triggers auto-answer sitting invisible for
    // seconds — the actual "chat does not update" complaint.
    mergeWindowMs: 900,
    onBuffer: ({ source, text, segments }) => {
        addMonitorLog('info', 'final-buffer', 'Buffered transcript segment', source, {
            segments,
            chars: text.length
        });
    },
    onFlush: ({ source, text, reason, segments }) => {
        if (source === 'system') {
            addChatMessage('voice-system', text);
        } else {
            addChatMessage('voice-mic', text);
        }

        addMonitorLog('info', 'final-flush', 'Merged transcript committed', source, {
            reason,
            segments,
            chars: text.length
        });
        showFeedback('Captured', 'success');
    }
});


// DOM elements
const statusText = document.getElementById('status-text');
const screenshotCount = document.getElementById('screenshot-count');
const resultsPanel = document.getElementById('results-panel');
const resultText = document.getElementById('result-text');
const loadingOverlay = document.getElementById('loading-overlay');
const emergencyOverlay = document.getElementById('emergency-overlay');
const chatContainer = document.getElementById('chat-container');
const chatMessagesElement = document.getElementById('chat-messages');
const chatComposer = document.getElementById('chat-composer');
const chatManualInput = document.getElementById('chat-manual-input');
const chatManualSend = document.getElementById('chat-manual-send');
const chatAutoScrollToggle = document.getElementById('chat-autoscroll-toggle');

const AUTOSCROLL_STORAGE_KEY = 'open-cluely.autoScrollEnabled';
let autoScrollEnabledState = (() => {
    try {
        const raw = localStorage.getItem(AUTOSCROLL_STORAGE_KEY);
        if (raw === null) return true;
        return raw === '1';
    } catch (_) {
        return true;
    }
})();
function isAutoScrollEnabled() { return autoScrollEnabledState; }
function setAutoScrollEnabled(value) {
    autoScrollEnabledState = !!value;
    try { localStorage.setItem(AUTOSCROLL_STORAGE_KEY, autoScrollEnabledState ? '1' : '0'); } catch (_) {}
    paintAutoScrollToggle();
}
function paintAutoScrollToggle() {
    if (!chatAutoScrollToggle) return;
    const enabled = autoScrollEnabledState;
    chatAutoScrollToggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    chatAutoScrollToggle.classList.toggle('off', !enabled);
    chatAutoScrollToggle.title = enabled ? 'Auto-scroll on (click to disable)' : 'Auto-scroll off (click to enable)';
}

const mobileServerPill = document.getElementById('mobile-server-pill');
const mobileServerPillLabel = document.getElementById('mobile-server-pill-label');
let mobileServerStatus = { listening: false, port: 7823, urls: [], clientCount: 0, error: null };

function paintMobileServerPill() {
    if (!mobileServerPill || !mobileServerPillLabel) return;

    mobileServerPill.classList.remove('off', 'idle', 'connected');

    if (!mobileServerStatus.listening) {
        mobileServerPill.classList.add('off');
        mobileServerPillLabel.textContent = mobileServerStatus.error ? 'Mobile · error' : 'Mobile · off';
        mobileServerPill.title = mobileServerStatus.error
            ? `Mobile companion not running: ${mobileServerStatus.error}`
            : 'Mobile companion not running';
        return;
    }

    const firstReal = mobileServerStatus.urls.find((u) => !u.virtual) || mobileServerStatus.urls[0];
    const firstUrl = firstReal?.url;
    const count = mobileServerStatus.clientCount || 0;
    mobileServerPill.classList.add(count > 0 ? 'connected' : 'idle');

    // Short, fixed-width label. This used to print the whole pairing URL, which
    // includes the bearer token as a query parameter: it stretched the header
    // until the transcription, mic and capture controls were pushed out of the
    // window, and it put the token on screen for anyone looking at the desktop.
    // The address (without the token) stays available in the tooltip.
    if (firstUrl) {
        mobileServerPillLabel.textContent = count > 0 ? `Phone · ${count}` : 'Phone';
        mobileServerPill.title = `Phone companion ready at ${firstUrl.replace(/\?.*$/, '')}`
            + ' — open the pairing link from the menu-bar icon, or enter the passcode.';
    } else {
        mobileServerPillLabel.textContent = count > 0 ? `Phone · ${count}` : 'Phone';
        mobileServerPill.title = `Phone companion on port ${mobileServerStatus.port} — no LAN address found.`;
    }

    const lines = [
        count > 0
            ? `Mobile companion: ${count} client(s) connected`
            : 'Mobile companion listening (no clients yet — click for help)',
        ...mobileServerStatus.urls.map(({ url, name, virtual }) => virtual
            ? `${url}  (${name}) — virtual adapter, phone probably cannot reach this`
            : `${url}  (${name})`
        )
    ];
    if (mobileServerStatus.urls.length === 0) {
        lines.push('No non-loopback IPv4 interface detected.');
    }
    if (mobileServerStatus.urls.some((u) => u.virtual) && mobileServerStatus.urls.some((u) => !u.virtual)) {
        lines.push('Use the first non-virtual URL on the phone.');
    }
    lines.push('');
    lines.push('Click to copy URL. If the phone times out, run this once in elevated PowerShell:');
    lines.push('  New-NetFirewallRule -DisplayName "Open-Cluely Mobile" -Direction Inbound -LocalPort 7823 -Protocol TCP -Action Allow -Profile Any');
    mobileServerPill.title = lines.join('\n');

    const showCodeBtn = document.getElementById('show-mobile-code-btn');
    if (showCodeBtn) {
        // '' hands display back to .icon-btn (inline-grid centres the icon); the title bar's
        // narrow-width rules can then still hide it.
        showCodeBtn.style.display = mobileServerStatus.listening ? '' : 'none';
    }
}

function copyMobileUrlPickReal() {
    return mobileServerStatus.urls.find((u) => !u.virtual)?.url || mobileServerStatus.urls[0]?.url;
}

async function copyMobileUrlToClipboard() {
    const url = copyMobileUrlPickReal();
    if (!url) {
        showFeedback('Mobile server has no LAN URL yet', 'error');
        return;
    }
    try {
        await navigator.clipboard.writeText(url);
        showFeedback(`Copied ${url}`, 'success');
    } catch (err) {
        showFeedback('Could not copy URL', 'error');
    }
}

let passcodeInterval = null;

function openMobileCodeDialog() {
    const dialog = document.getElementById('mobile-code-dialog');
    const display = document.getElementById('mobile-code-display');
    const timer = document.getElementById('mobile-code-timer');
    if (!dialog || !display || !timer) return;

    dialog.classList.remove('hidden');

    function updateCode() {
        if (window.electronAPI?.getMobilePasscode) {
            window.electronAPI.getMobilePasscode().then((code) => {
                display.textContent = code;
            }).catch(() => {});
        }
        
        const secondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30);
        timer.textContent = `Rotates in ${secondsLeft}s`;
    }

    updateCode();
    passcodeInterval = setInterval(updateCode, 1000);
}

function closeMobileCodeDialog() {
    const dialog = document.getElementById('mobile-code-dialog');
    if (dialog) {
        dialog.classList.add('hidden');
    }
    if (passcodeInterval) {
        clearInterval(passcodeInterval);
        passcodeInterval = null;
    }
}
const transcriptionToggle = document.getElementById('transcription-toggle');
const sourceSystemToggle = document.getElementById('source-system-toggle');
const sourceMicToggle = document.getElementById('source-mic-toggle');
const monitorMasterState = document.getElementById('monitor-master-state');
const monitorStatusSystem = document.getElementById('monitor-status-system');
const monitorStatusMic = document.getElementById('monitor-status-mic');
const monitorLiveSystem = document.getElementById('monitor-live-system');
const monitorLiveMic = document.getElementById('monitor-live-mic');
const monitorLogList = document.getElementById('monitor-log-list');
const windowResizeHandles = document.querySelectorAll('[data-resize-handle]');

const analyzeScreenBtn = document.getElementById('analyze-screen-btn');
const screenshotBtn = document.getElementById('screenshot-btn');
const analyzeBtn = document.getElementById('analyze-btn');
const screenAiBtn = document.getElementById('screen-ai-btn');
const clearBtn = document.getElementById('clear-btn');
const hideBtn = document.getElementById('hide-btn');
const compactModeBtn = document.getElementById('compact-mode-btn');
const closeResultsBtn = document.getElementById('close-results');
const closeAppBtn = document.getElementById('close-app-btn');
const closeConfirmationDialog = document.getElementById('close-confirmation-dialog');
const cancelCloseBtn = document.getElementById('cancel-close-btn');
const confirmCloseBtn = document.getElementById('confirm-close-btn');

const transcriptionControl = document.getElementById('transcription-control');

// New Cluely-style buttons
const suggestBtn = document.getElementById('suggest-btn');
const notesBtn = document.getElementById('notes-btn');
const insightsBtn = document.getElementById('insights-btn');
const themeToggleBtn = document.getElementById('theme-toggle-btn');

// Settings elements
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const closeSettingsBtn = document.getElementById('close-settings');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const settingAiProvider = document.getElementById('setting-ai-provider');
const geminiSettingsGroup = document.getElementById('gemini-settings-group');
const ollamaSettingsGroup = document.getElementById('ollama-settings-group');
const settingGeminiKey = document.getElementById('setting-gemini-key');
const toggleGeminiKeyVisibilityBtn = document.getElementById('toggle-gemini-key-visibility');
const settingGeminiModel = document.getElementById('setting-gemini-model');
const settingOllamaBaseUrl = document.getElementById('setting-ollama-base-url');
const settingOllamaModel = document.getElementById('setting-ollama-model');
const settingOllamaModelSelect = document.getElementById('setting-ollama-model-select');
const fetchOllamaModelsBtn = document.getElementById('fetch-ollama-models');
const settingProgrammingLanguage = document.getElementById('setting-programming-language');
const settingAssemblyKey = document.getElementById('setting-assembly-key');
const toggleAssemblyKeyVisibilityBtn = document.getElementById('toggle-assembly-key-visibility');
const settingAssemblyModel = document.getElementById('setting-assembly-model');
const settingWindowOpacity = document.getElementById('setting-window-opacity');
const settingWindowOpacityValue = document.getElementById('setting-window-opacity-value');
const settingsShortcutsList = document.getElementById('settings-shortcuts-list');

// Timer
let startTime = Date.now();
let timerInterval;
const MIN_WINDOW_WIDTH = 600;
const MIN_WINDOW_HEIGHT = 380;
const MAX_CHAT_INPUT_HEIGHT = 88;

let isCloseConfirmationOpen = false;
let hasGeminiApiKeysConfigured = false;
let hasAssemblyAiApiKeyConfigured = false;
// Whether resume/JD context (entered through the web companion) was found
// on disk the last time it was checked — see loadInterviewContextStatus().
// Starts true (i.e. "don't warn yet") so a slow/failed status fetch never
// flashes a false "no resume loaded" warning before the real check lands.
let hasResumeContext = true;
let hasJdContext = true;
const aiActionInFlightState = {
    askAi: false,
    screenAi: false,
    screenIntelligence: false,
    suggest: false,
    notes: false,
    insights: false
};
const shortcutManager = createShortcutManager({ settingsShortcutsList });
const windowAdjustmentManager = createWindowAdjustmentManager({
    windowResizeHandles,
    chatContainer,
    minWindowWidth: MIN_WINDOW_WIDTH,
    minWindowHeight: MIN_WINDOW_HEIGHT,
    onViewportResize: () => {
        autoResizeManualInput();
    }
});
const chatUiManager = createChatUiManager({
    chatContainer,
    chatMessagesElement,
    chatComposer,
    chatManualInput,
    chatManualSend,
    messageStore,
    maxChatInputHeight: MAX_CHAT_INPUT_HEIGHT,
    escapeHtml: (value) => escapeHtml(value),
    updateUi: () => updateUI(),
    onMessagesChanged: (messages) => {
        chatMessagesArray = messages;
    },
    showFeedback: (message, type) => showFeedback(message, type),
    addMonitorLog: (...args) => addMonitorLog(...args),
    isAutoScrollEnabled,
    // Stop belongs to the request that is writing this answer: a screen
    // answer is an Analyze/Reanalyze, anything else an Ask.
    onStopAnswer: (messageId) => {
        const message = messageStore.findById(messageId);
        if (String(message?.content || '').startsWith('**[Screen Analysis]**')) window.electronAPI?.cancelAnalyzeScreen?.();
        else window.electronAPI?.cancelAskAi?.();
    },
    onReanalyzeAnswer: (messageId) => { reanalyzeAnswerAction(messageId); },
    onRegenerateAnswer: () => {
        if (analyzeBtn && !analyzeBtn.disabled) {
            analyzeBtn.click();
        } else {
            showFeedback('Nothing to regenerate yet', 'info');
        }
    }
});
const settingsPanelManager = createSettingsPanelManager({
    settingsPanel,
    settingAiProvider,
    geminiSettingsGroup,
    ollamaSettingsGroup,
    settingGeminiKey,
    toggleGeminiKeyVisibilityBtn,
    settingGeminiModel,
    settingProgrammingLanguage,
    settingOllamaBaseUrl,
    settingOllamaModel,
    settingOllamaModelSelect,
    fetchOllamaModelsBtn,
    settingAssemblyKey,
    toggleAssemblyKeyVisibilityBtn,
    settingAssemblyModel,
    settingWindowOpacity,
    settingWindowOpacityValue,
    applySettingsShortcutConfig: (settings) => applySettingsShortcutConfig(settings),
    showFeedback: (message, type) => showFeedback(message, type),
    onSettingsSaved: (settings) => {
        applyApiKeyAvailabilityFromSettings(settings);
        updateUI();
    }
});
const transcriptionManager = createTranscriptionManager({
    transcriptionSourceState,
    normalizeSourceRule: normalizeAssemblySource,
    sourceLabelRule: resolveSourceLabel,
    audioPipeline,
    transcriptBufferManager,
    chatMessagesElement,
    transcriptionToggle,
    sourceSystemToggle,
    sourceMicToggle,
    monitorMasterState,
    monitorStatusSystem,
    monitorStatusMic,
    monitorLiveSystem,
    monitorLiveMic,
    monitorLogList,
    addChatMessage: (type, content, options) => addChatMessage(type, content, options),
    showFeedback: (message, type) => showFeedback(message, type),
    isAutoScrollEnabled,
    isChatNearBottom: () => chatUiManager.isChatNearBottom(),
    onStateChange: () => updateSessionStatus()
});
transcriptionManagerReady = true;

initPanels({
    getSourceStatuses: () => transcriptionManager.sourceStatuses,
    getTranscriptionFailure: () => transcriptionManager.getLastPermanentFailure(),
    openSettings: () => document.getElementById('settings-btn')?.click(),
    showFeedback: (message, type) => showFeedback(message, type)
});

// Development screenshot harness only (src/main-process/dev/ui-capture.js):
// renders an answer through the real stream handler, with chunks the harness
// sends over the same ai-stream-chunk channel Gemini uses.
window.__synapseBeginDemoStream = () => {
    const stream = createStreamHandler('askAi');
    stream.start('');
    window.__synapseEndDemoStream = (finished = true) => {
        if (finished) stream.cleanup();
    };
};

/*
 * Phase 13: "Copy Diagnostics" — the one new user-facing action this phase
 * adds. Wired directly here (not the separate event-listeners.js module)
 * since transcriptionManager and showFeedback are already in scope at this
 * exact point and the whole handler is self-contained. Technical metrics
 * only, see diagnostic-snapshot.js for exactly what buildDiagnosticSnapshot
 * assembles -- no transcript content, no keys, no auth headers ever reach
 * this string.
 */
const copyDiagnosticsBtn = document.getElementById('copy-diagnostics-btn');
if (copyDiagnosticsBtn) {
    copyDiagnosticsBtn.addEventListener('click', async () => {
        try {
            const report = await transcriptionManager.buildDiagnosticSnapshot();
            const text = JSON.stringify(report, null, 2);
            await navigator.clipboard.writeText(text);
            showFeedback('Diagnostics copied to clipboard', 'success');
        } catch (error) {
            console.error('Failed to build/copy diagnostic snapshot:', error);
            showFeedback('Could not copy diagnostics', 'error');
        }
    });
}

// Initialize
async function init() {
    console.log('Initializing renderer with live transcription...');

    if (typeof window.electronAPI !== 'undefined') {
        console.log('electronAPI is available');
    } else {
        console.error('electronAPI not available');
        showFeedback('electronAPI not available', 'error');
    }

    const settings = await loadShortcutConfig();
    // Fire-and-forget: must not block the rest of startup on an extra IPC
    // round trip, and updateSetupHint() (called at the end of this function
    // via applyApiKeyAvailabilityFromSettings) already runs once before this
    // resolves — loadInterviewContextStatus calls it again itself once the
    // real status is known, which is what actually shows the warning.
    loadInterviewContextStatus();
    setupEventListeners();
    setupIpcListeners();
    setupWindowAdjustments();
    if (chatAutoScrollToggle) {
        chatAutoScrollToggle.addEventListener('click', () => setAutoScrollEnabled(!autoScrollEnabledState));
        paintAutoScrollToggle();
    }
    if (window.electronAPI?.onClearFromMobile) {
        window.electronAPI.onClearFromMobile(() => {
            clearChatView();
            showFeedback('Cleared from mobile', 'info');
        });
    }
    if (mobileServerPill) {
        mobileServerPill.addEventListener('click', copyMobileUrlToClipboard);
        const showCodeBtn = document.getElementById('show-mobile-code-btn');
        if (showCodeBtn) {
            showCodeBtn.addEventListener('click', openMobileCodeDialog);
        }
        const closeCodeBtn = document.getElementById('close-mobile-code-btn');
        if (closeCodeBtn) {
            closeCodeBtn.addEventListener('click', closeMobileCodeDialog);
        }
        paintMobileServerPill();
        if (window.electronAPI?.onMobileServerStatus) {
            window.electronAPI.onMobileServerStatus((data) => {
                mobileServerStatus = { ...mobileServerStatus, ...(data || {}) };
                paintMobileServerPill();
            });
        }
        if (window.electronAPI?.getMobileServerStatus) {
            window.electronAPI.getMobileServerStatus().then((data) => {
                if (data && typeof data === 'object') {
                    mobileServerStatus = { ...mobileServerStatus, ...data };
                    paintMobileServerPill();
                }
            }).catch(() => {});
        }
    }
    applyTheme(resolveInitialThemePreference(settings), { persist: false });
    updateUI();
    transcriptionManager.updateTranscriptionUI();
    transcriptionManager.renderMonitorState();
    startTimer();

    document.body.style.visibility = 'visible';
    document.body.style.display = 'block';
    const app = document.getElementById('app');
    if (app) {
        app.style.visibility = 'visible';
        app.style.display = 'flex';
    }

    console.log('Renderer initialized - Ready for live transcription!');
    showFeedback('Ready - click transcription to start', 'success');
    addMonitorLog('info', 'init', 'Renderer initialized');
    addMonitorLog('info', 'source-defaults', 'Default sources: Host on, Mic off');
}

function updateWindowOpacityValueLabel(value) {
    settingsPanelManager.updateWindowOpacityValueLabel(value);
}

function parseThemePreference(theme) {
    return theme === THEME_DARK || theme === THEME_LIGHT ? theme : null;
}

function normalizeTheme(theme) {
    return theme === THEME_DARK ? THEME_DARK : THEME_LIGHT;
}

function loadStoredThemePreference() {
    try {
        const savedTheme = window.localStorage?.getItem(THEME_STORAGE_KEY) || '';
        return parseThemePreference(savedTheme) || THEME_LIGHT;
    } catch (error) {
        console.warn('Failed to read saved theme preference:', error);
        return THEME_LIGHT;
    }
}

function resolveInitialThemePreference(settings) {
    const settingsTheme = parseThemePreference(String(settings?.themePreference || '').trim().toLowerCase());
    if (settingsTheme) {
        saveThemePreference(settingsTheme);
        return settingsTheme;
    }

    return loadStoredThemePreference();
}

function saveThemePreference(theme) {
    try {
        window.localStorage?.setItem(THEME_STORAGE_KEY, normalizeTheme(theme));
    } catch (error) {
        console.warn('Failed to save theme preference:', error);
    }
}

function persistThemePreference(theme) {
    const normalizedTheme = normalizeTheme(theme);
    saveThemePreference(normalizedTheme);

    const setThemePreference = window.electronAPI?.setThemePreference;
    if (typeof setThemePreference === 'function') {
        setThemePreference(normalizedTheme).catch((error) => {
            console.warn('Failed to persist theme preference to app state:', error);
        });
    }
}

function updateThemeToggleUi() {
    if (!themeToggleBtn) {
        return;
    }

    const isDarkMode = activeTheme === THEME_DARK;
    const nextThemeLabel = isDarkMode ? 'light' : 'dark';
    const ariaLabel = `Switch to ${nextThemeLabel} mode`;

    themeToggleBtn.classList.toggle('is-dark', isDarkMode);
    themeToggleBtn.setAttribute('aria-pressed', isDarkMode ? 'true' : 'false');
    themeToggleBtn.setAttribute('aria-label', ariaLabel);
    themeToggleBtn.removeAttribute('title');
}

function applyTheme(theme, options = {}) {
    const { persist = true, announce = false } = options;
    activeTheme = normalizeTheme(theme);

    document.body.classList.toggle('theme-dark', activeTheme === THEME_DARK);
    document.documentElement.setAttribute('data-theme', activeTheme);
    updateThemeToggleUi();

    if (persist) {
        persistThemePreference(activeTheme);
    }

    if (announce) {
        showFeedback(activeTheme === THEME_DARK ? 'Dark mode enabled' : 'Light mode enabled', 'info');
    }
}

function toggleThemeMode() {
    const nextTheme = activeTheme === THEME_DARK ? THEME_LIGHT : THEME_DARK;
    applyTheme(nextTheme, { persist: true, announce: true });
}

function applySettingsShortcutConfig(settings) {
    shortcutManager.applySettingsShortcutConfig(settings);
}

function isShortcutPressed(event, shortcutId) {
    return shortcutManager.isShortcutPressed(event, shortcutId);
}

function isAiActionInFlight(actionId) {
    return Boolean(aiActionInFlightState[actionId]);
}

function setAiActionInFlight(actionId, inFlight) {
    if (!Object.prototype.hasOwnProperty.call(aiActionInFlightState, actionId)) {
        return;
    }

    const nextValue = Boolean(inFlight);
    if (aiActionInFlightState[actionId] === nextValue) {
        return;
    }

    aiActionInFlightState[actionId] = nextValue;
    updateUI();
}

async function runAiActionWithLock(actionId, action) {
    if (isAiActionInFlight(actionId)) {
        return false;
    }

    setAiActionInFlight(actionId, true);
    try {
        await action();
        return true;
    } finally {
        setAiActionInFlight(actionId, false);
    }
}

let activeScreenAiStream = null;
let rerunScreenAnalysisAfterCancel = false;

function createStreamHandler(actionId) {
    let accumulatedText = '';
    let messageRecord = null;
    let interrupted = false;
    let persisted = false;
    let removeChunkListener = null;
    let loadingHidden = false;

    // Latency instrumentation — only meaningful for the auto-answer-driven
    // 'askAi' path, which is the only one auto-answer.js tags with a
    // questionId before clicking. Other actionIds (screenAi/suggest/notes/
    // insights) have no QuestionEvent to correlate against, so they log
    // nothing here rather than attribute their timing to a stale id.
    let questionId = null;
    let requestStartAt = 0;
    let firstTokenLogged = false;

    function start(headingPrefix) {
        accumulatedText = headingPrefix || '';
        messageRecord = addChatMessage('ai-response', accumulatedText || '');
        if (messageRecord) chatUiManager.setMessageStreaming(messageRecord.id, true);
        if (actionId === 'askAi') {
            sessionAnswerState.pending = true;
            sessionAnswerState.streaming = false;
            sessionAnswerState.error = null;
            updateSessionStatus();
        }

        if (actionId === 'askAi') {
            // Read-and-clear: this is set once, synchronously, immediately
            // before the askBtn.click() that led to this call — there is no
            // window for a second click to land between them.
            questionId = window.__synapseActiveQuestionId || null;
            window.__synapseActiveQuestionId = null;
            requestStartAt = Date.now();
            firstTokenLogged = false;
            console.log(`[AI] request-start id=${questionId || 'manual'} t=${requestStartAt}`);
        }

        removeChunkListener = window.electronAPI.onAiStreamChunk((data) => {
            if (data.actionId !== actionId) return;

            if (actionId === 'askAi' && !firstTokenLogged) {
                firstTokenLogged = true;
                console.log(`[AI] first-token id=${questionId || 'manual'} +${Date.now() - requestStartAt}ms`);
                sessionAnswerState.streaming = true;
                updateSessionStatus();
            }

            accumulatedText += data.text;
            if (messageRecord) {
                chatUiManager.updateChatMessageContent(messageRecord.id, accumulatedText);
            }
            if (!loadingHidden) {
                loadingHidden = true;
                hideLoadingOverlay();
            }
        });

        return messageRecord;
    }

    function finalize(finalText) {
        if (finalText && messageRecord) {
            chatUiManager.updateChatMessageContent(messageRecord.id, finalText);
        }
        if (actionId === 'askAi' && requestStartAt) {
            console.log(`[AI] end id=${questionId || 'manual'} +${Date.now() - requestStartAt}ms total`);
        }
    }

    // The interviewer updated/extended the question while this was still
    // streaming (see cancel-ask-ai / auto-answer.js's supersede check) —
    // whatever text had rendered so far is genuinely stale, not broken, so
    // it's marked rather than left looking like a silently truncated answer.
    function markInterrupted(customNote) {
        if (actionId === 'askAi' && requestStartAt) {
            console.log(`[AI] interrupted id=${questionId || 'manual'} +${Date.now() - requestStartAt}ms — ${customNote ? 'screen problem changed' : 'question updated'}`);
        }
        if (!messageRecord) return;
        interrupted = true;
        const note = customNote
            ? `${accumulatedText.trim() ? `${accumulatedText}\n\n` : ''}${customNote}`
            : accumulatedText.trim()
                ? `${accumulatedText}\n\n_(interrupted — answering the updated question instead)_`
                : '_(skipped — the question was updated before an answer arrived)_';
        chatUiManager.updateChatMessageContent(messageRecord.id, note);
    }

    function cleanup() {
        if (removeChunkListener) {
            removeChunkListener();
            removeChunkListener = null;
        }
        if (messageRecord) {
            chatUiManager.setMessageStreaming(messageRecord.id, false, { regenerable: actionId === 'askAi' });
            // Saved once, when the stream ends: finished, interrupted or failed with partial text.
            if (!persisted) {
                persisted = true;
                persistMessage(messageRecord, interrupted ? { interrupted: true } : {});
            }
        }
        if (actionId === 'askAi') {
            sessionAnswerState.pending = false;
            sessionAnswerState.streaming = false;
            updateSessionStatus();
        }
    }

    /** A failed request: show it in the title-bar status until the next attempt. */
    function fail(message) {
        if (actionId === 'askAi') {
            sessionAnswerState.error = message || 'The answer request failed';
            updateSessionStatus();
        }
    }

    /** The main process reports which screen problem the answer was for. */
    function setProblemId(problemId) {
        if (!messageRecord || typeof problemId !== 'string' || !problemId) return;
        if (messageStore.assignProblem(messageRecord.id, problemId, lastIdentifiedProblemId)) {
            chatMessagesArray = messageStore.getMessages();
            updateMessageAiToggleUi(messageRecord);
        }
    }

    return { start, finalize, markInterrupted, cleanup, fail, setProblemId };
}

function hasConfiguredGeminiApiKeys(value) {
    const keys = String(value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    return keys.length > 0;
}

function hasConfiguredAssemblyAiApiKey(value) {
    return String(value ?? '').trim().length > 0;
}

function applyApiKeyAvailabilityFromSettings(settings) {
    if (!settings || typeof settings !== 'object') {
        hasGeminiApiKeysConfigured = false;
        hasAssemblyAiApiKeyConfigured = false;
        return;
    }

    if (settings.apiKeyStorage?.locked) {
        showFeedback('Your API keys are saved, but the macOS Keychain did not release them. Restart Synapse and choose "Always Allow" when macOS asks.', 'error');
    }

    // Ollama doesn't require API keys, so treat it as always configured
    if (settings.aiProvider === 'ollama') {
        hasGeminiApiKeysConfigured = true;
    } else if (typeof settings.hasGeminiApiKeys === 'boolean') {
        hasGeminiApiKeysConfigured = settings.hasGeminiApiKeys;
    } else {
        hasGeminiApiKeysConfigured = hasConfiguredGeminiApiKeys(settings.geminiApiKey);
    }

    if (typeof settings.hasAssemblyAiApiKey === 'boolean') {
        hasAssemblyAiApiKeyConfigured = settings.hasAssemblyAiApiKey;
    } else {
        hasAssemblyAiApiKeyConfigured = hasConfiguredAssemblyAiApiKey(settings.assemblyAiApiKey);
    }

    updateSetupHint();
}

/**
 * Surfaces missing configuration on the empty state. Without this the app looks
 * identical whether it is fully configured or has no API keys at all — every
 * action just silently does nothing.
 */
function updateSetupHint() {
    const hint = document.getElementById('chat-empty-hint');
    if (!hint) return;

    const missing = [];
    if (!hasGeminiApiKeysConfigured) missing.push('an AI provider key (Gemini)');
    if (!hasAssemblyAiApiKeyConfigured) missing.push('a transcription key (AssemblyAI)');

    if (missing.length > 0) {
        hint.textContent = `Setup needed: add ${missing.join(' and ')} in Settings (gear icon) before answers or transcription can work.`;
        hint.hidden = false;
        return;
    }

    // Real interview-session bug report: the app gave no warning at all when
    // the interviewer's first question arrived and there was no resume/JD
    // on file to ground the answer in — the first sign was an ungrounded
    // answer, mid-interview. This is checked once at startup (see
    // loadInterviewContextStatus) specifically so it's visible BEFORE the
    // session starts, not discovered reactively.
    const missingContext = [];
    if (!hasResumeContext) missingContext.push('a resume');
    if (!hasJdContext) missingContext.push('a job description');

    if (missingContext.length > 0) {
        hint.textContent = `No ${missingContext.join(' or ')} on file yet — add it on the mobile companion page `
            + '(Context tab) before the interview starts so answers can be grounded in it.';
        hint.hidden = false;
        return;
    }

    hint.hidden = true;
}

async function loadInterviewContextStatus() {
    if (!window.electronAPI?.getInterviewContextStatus) return;

    try {
        const status = await window.electronAPI.getInterviewContextStatus();
        hasResumeContext = Boolean(status?.hasResume);
        hasJdContext = Boolean(status?.hasJd);
    } catch (error) {
        console.error('Failed to load interview context status:', error);
        // Leave the optimistic defaults in place — a failed check should
        // never itself become a false "nothing is loaded" warning.
    }

    updateSetupHint();
}

async function loadShortcutConfig() {
    if (!window.electronAPI?.getSettings) {
        applyApiKeyAvailabilityFromSettings(null);
        return null;
    }

    try {
        const settings = await window.electronAPI.getSettings();

        // Record key availability BEFORE rendering shortcuts. Rendering can
        // throw on an incomplete settings payload, and the catch below resets
        // availability to "no keys" — which disables every button even though
        // the keys are present and valid. Key state must not depend on
        // unrelated UI rendering succeeding.
        applyApiKeyAvailabilityFromSettings(settings);

        try {
            applySettingsShortcutConfig(settings);
        } catch (shortcutError) {
            console.error('Failed to render shortcut config:', shortcutError);
        }

        return settings;
    } catch (error) {
        console.error('Failed to load settings:', error);
        applyApiKeyAvailabilityFromSettings(null);
        return null;
    }
}

function setupWindowAdjustments() {
    windowAdjustmentManager.setupWindowAdjustments();
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isMessageIncludedForAi(message) {
    return messageStore.isIncludedForAi(message);
}

function buildFilteredAiContextBundle({ charBudget = AI_CONTEXT_CHAR_BUDGET, emitTruncationLog = true } = {}) {
    return buildAiContextBundle({
        messages: chatMessagesArray,
        isMessageIncludedForAi,
        charBudget,
        emitTruncationLog,
        onTruncationLog: (dropped, budget) => {
            addMonitorLog(
                'info',
                'context-cap',
                `Trimmed ${dropped} older context message(s) to stay within ${budget} chars`
            );
        }
    });
}

function updateMessageAiToggleUi(message) {
    syncMessageAiToggleUi(chatMessagesElement, message);
}

function toggleChatMessageInclusion(messageId) {
    const message = messageStore.toggleInclusion(messageId);
    if (!message) return;

    chatMessagesArray = messageStore.getMessages();
    updateMessageAiToggleUi(message);
    updateUI();

    const stateText = message.includeInAi ? 'included in' : 'excluded from';
    addMonitorLog('info', 'ai-context-toggle', `Message ${stateText} AI context`, null, {
        id: message.id,
        type: message.type
    });
}

function addMonitorLog(level, event, message, source = null, meta = null, timestamp = Date.now()) {
    transcriptionManager.addMonitorLog(level, event, message, source, meta, timestamp);
}

function flushAllFinalTranscripts(reason = 'flush-all') {
    transcriptionManager.flushAllFinalTranscripts(reason);
}

function setSourceSelected(source, enabled) {
    return transcriptionManager.setSourceSelected(source, enabled);
}

async function toggleMasterTranscription() {
    if (!hasAssemblyAiApiKeyConfigured) {
        showFeedback('AssemblyAI API key missing. Add it in Settings.', 'error');
        return;
    }

    return transcriptionManager.toggleMasterTranscription();
}

// Screenshot functions
async function takeStealthScreenshot() {
    try {
        showFeedback('Taking screenshot...', 'info');
        const result = await window.electronAPI.takeStealthScreenshot();
        if (result?.error) throw new Error(result.error);
    } catch (error) {
        console.error('Screenshot error:', error);
        // IPC prefixes "Error invoking remote method '…': Error: "; show the cause only.
        const reason = String(error?.message || '').replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
        showFeedback(reason ? `Screenshot failed: ${reason}` : 'Screenshot failed', 'error');
    }
}

// Answer style. A per-device preference, so it lives in localStorage; reads
// and writes are guarded because storage can be unavailable.
const RESPONSE_MODE_STORAGE_KEY = 'synapse.responseMode';
const RESPONSE_MODE_IDS = ['quick', 'professional', 'technical', 'star', 'detailed'];
const responseModeSelect = document.getElementById('response-mode-select');

function getResponseMode() {
    const value = responseModeSelect?.value;
    return RESPONSE_MODE_IDS.includes(value) ? value : 'professional';
}

if (responseModeSelect) {
    try {
        const saved = localStorage.getItem(RESPONSE_MODE_STORAGE_KEY);
        if (RESPONSE_MODE_IDS.includes(saved)) responseModeSelect.value = saved;
    } catch (_) { /* storage unavailable: keep the default */ }

    responseModeSelect.addEventListener('change', () => {
        try {
            localStorage.setItem(RESPONSE_MODE_STORAGE_KEY, getResponseMode());
        } catch (_) { /* not persisted this session */ }
        // Shared with the website through the account settings.
        window.electronAPI?.conversationsSetResponseMode?.(getResponseMode());
    });
}

function buildAskAiContextPayload() {
    const bundle = buildFilteredAiContextBundle({ charBudget: AI_CONTEXT_CHAR_BUDGET, emitTruncationLog: true });

    // Read-and-clear, same discipline as __synapseActiveQuestionId (set at
    // the same site in auto-answer.js's processNextQuestion): a manual Ask
    // button / ⌥⇧A press never goes through that path, so this must not
    // leak a stale timestamp from a previous auto-answer-triggered question
    // onto an unrelated manual click.
    const questionT0 = typeof window.__synapseQuestionT0 === 'number' ? window.__synapseQuestionT0 : null;
    window.__synapseQuestionT0 = null;

    return {
        mode: 'best-next-answer',
        responseMode: getResponseMode(),
        contextString: bundle.contextString,
        transcriptContext: bundle.transcriptContext,
        sessionSummary: bundle.sessionSummary,
        // Phase 6: Phase 3's already-computed relation/confidence, plus the
        // explicit ACTIVE CONTEXT block built from it — threaded through so
        // prompts.js (main process) can use them directly instead of
        // independently re-guessing whether this is a follow-up (see
        // prompts.js's buildContextPolicy).
        activeContext: bundle.activeContext,
        relation: bundle.relation,
        confidence: bundle.confidence,
        enabledScreenshotIds: bundle.enabledScreenshotIds,
        screenshotCount: bundle.enabledScreenshotIds.length,
        questionT0
    };
}

async function askAiWithSessionContext() {
    // These three guards return before createStreamHandler ever runs, so
    // without this a rejected question would leave a [QUESTION] dispatch log
    // line with no [AI] line after it and no visible reason why — exactly the
    // "impossible to tell where it went" failure mode this instrumentation
    // exists to rule out. window.__synapseActiveQuestionId is cleared either
    // way so a rejection here can never be misattributed to a later call.
    const rejectedQuestionId = window.__synapseActiveQuestionId || null;
    function logRejection(reason) {
        if (rejectedQuestionId) {
            console.log(`[QUESTION] rejected id=${rejectedQuestionId} t=${Date.now()} reason=${reason}`);
            window.__synapseActiveQuestionId = null;
        }
    }

    if (!hasGeminiApiKeysConfigured) {
        logRejection('gemini-api-key-missing');
        showFeedback('Gemini API key missing. Add it in Settings.', 'error');
        return;
    }

    if (!window.electronAPI?.askAiWithSessionContext) {
        logRejection('feature-unavailable');
        showFeedback('Feature not available', 'error');
        return;
    }

    const payload = buildAskAiContextPayload();
    if (!payload.contextString && payload.enabledScreenshotIds.length === 0) {
        logRejection('no-context-available');
        showFeedback('No transcript or screenshots available yet', 'error');
        return;
    }

    await runAiActionWithLock('askAi', async () => {
        const stream = createStreamHandler('askAi');
        try {
            setAnalyzing(true);
            // The answer card shows its own "Thinking" state; no full-window
            // overlay, so earlier answers stay readable while the next arrives.
            stream.start('');

            const result = await window.electronAPI.askAiWithSessionContext(payload);
            stream.setProblemId(result?.problemId);

            if (result?.success && result?.text) {
                stream.finalize(result.text);
            } else if (result?.cancelled) {
                // Not a failure — auto-answer.js interrupted this on purpose
                // because the host updated the question, or the screen moved
                // to a different problem. No error toast.
                stream.markInterrupted(result.reason === 'problem-changed'
                    ? '_(stopped — the screen moved to a different problem. Ask again for the new one.)_'
                    : undefined);
            } else {
                throw new Error(result?.error || 'Ask AI failed');
            }
        } catch (error) {
            console.error('Ask AI error:', error);
            showFeedback('Answer failed', 'error');
            addChatMessage('system', `Answer failed: ${error.message}`);
            stream.fail(error.message);
        } finally {
            stream.cleanup();
            setAnalyzing(false);
            hideLoadingOverlay();
        }
    });
}

// ─── Title-bar session state ────────────────────────────────────────────────
// Derived from real state only: source statuses and the Ask AI lifecycle.
// (State variables are declared at the top of the module: updateUI() can run
// during start-up, before this point.)
function updateSessionStatus() {
    if (!transcriptionManagerReady) return;
    const sources = transcriptionManager?.sourceStatuses || {};
    if (sources.system === 'listening' || sources.mic === 'listening') sessionWasListening = true;
    if (sources.system === 'off' && sources.mic === 'off') sessionWasListening = false;
    const errorDetail = sessionAnswerState.error
        || (sources.system === 'error' ? 'Host audio stopped' : null)
        || (sources.mic === 'error' ? 'Microphone stopped' : null);
    applySessionState(sessionStateEl, sessionStateLabelEl, deriveSessionState({
        sources,
        aiPending: sessionAnswerState.pending,
        aiStreaming: sessionAnswerState.streaming,
        error: sessionAnswerState.error,
        wasListening: sessionWasListening
    }), errorDetail || '');
}

// ─── Answer text size (⌘= / ⌘- / ⌘0), per device ─────────────────────────
const ANSWER_SIZE_KEY = 'synapse.answerSize';
const ANSWER_SIZE_MIN = 12;
const ANSWER_SIZE_MAX = 22;

function setAnswerSize(size, { announce = false } = {}) {
    const next = Math.min(ANSWER_SIZE_MAX, Math.max(ANSWER_SIZE_MIN, Math.round(size)));
    document.documentElement.style.setProperty('--answer-size', `${next}px`);
    const readout = document.getElementById('setting-answer-size-value');
    if (readout) readout.textContent = `${next}px`;
    try { localStorage.setItem(ANSWER_SIZE_KEY, String(next)); } catch (_) { /* not persisted */ }
    if (announce) showFeedback(`Answer text ${next}px`, 'info');
    return next;
}

function getAnswerSize() {
    return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--answer-size'), 10) || 14;
}

(function initAnswerSize() {
    let saved = null;
    try { saved = Number(localStorage.getItem(ANSWER_SIZE_KEY)); } catch (_) { /* default */ }
    if (saved) setAnswerSize(saved);
    document.getElementById('answer-size-down')?.addEventListener('click', () => setAnswerSize(getAnswerSize() - 1));
    document.getElementById('answer-size-up')?.addEventListener('click', () => setAnswerSize(getAnswerSize() + 1));
    document.addEventListener('keydown', (event) => {
        if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
        if (event.key === '=' || event.key === '+') {
            event.preventDefault();
            setAnswerSize(getAnswerSize() + 1, { announce: true });
        } else if (event.key === '-') {
            event.preventDefault();
            setAnswerSize(getAnswerSize() - 1, { announce: true });
        } else if (event.key === '0') {
            event.preventDefault();
            setAnswerSize(14, { announce: true });
        }
    });
})();

async function analyzeScreenAction() {
    if (!hasGeminiApiKeysConfigured) {
        showFeedback('Gemini API key missing. Add it in Settings.', 'error');
        return;
    }

    if (isAiActionInFlight('screenIntelligence')) {
        // A new press means the running answer is for an older screen: stop
        // it and analyse again once it has unwound (see finally below).
        rerunScreenAnalysisAfterCancel = true;
        window.electronAPI?.cancelAnalyzeScreen?.();
        return;
    }
    if (isAnalyzing) {
        return;
    }

    const bundle = buildFilteredAiContextBundle({ charBudget: AI_CONTEXT_CHAR_BUDGET, emitTruncationLog: false });
    const responseMode = responseModeSelect ? responseModeSelect.value : 'professional';

    await runAiActionWithLock('screenIntelligence', async () => {
        const stream = createStreamHandler('screenIntelligence');
        activeScreenAiStream = stream;
        if (analyzeScreenBtn) {
            analyzeScreenBtn.classList.add('analyzing');
            analyzeScreenBtn.disabled = true;
            analyzeScreenBtn.setAttribute('aria-busy', 'true');
        }

        try {
            setAnalyzing(true);
            showLoadingOverlay('Capturing screen...');
            stream.start('**[Screen Analysis]**\n\n');

            const result = await window.electronAPI.analyzeScreen({
                contextString: bundle.contextString,
                responseMode
            });

            stream.setProblemId(result?.problemId);
            if (result?.success && result?.text) {
                const header = '**[Screen Analysis]**\n\n';
                stream.finalize(result.text.startsWith(header) ? result.text : `${header}${result.text}`);
            } else if (result?.cancelled) {
                stream.markInterrupted(result.reason === 'problem-changed'
                    ? '_(stopped — the screen moved to a different problem. Press Analyze for the new one.)_'
                    : '_(stopped)_');
            } else if (result?.error) {
                if (result?.restartRequired) {
                    showFeedback('Screen recording enabled. Restart Synapse to apply changes.', 'warn');
                } else {
                    showFeedback(result.error, 'error');
                }
                if (activeScreenAiStream) {
                    const extra = result?.restartRequired
                        ? '\n\n*(macOS requires Synapse to restart before screen capture permissions take effect.)*'
                        : '';
                    activeScreenAiStream.finalize(`**[Screen Analysis]**\n\n⚠️ ${result.error}${extra}`);
                    activeScreenAiStream.cleanup();
                    activeScreenAiStream = null;
                }
            }
        } catch (error) {
            console.error('Screen intelligence error:', error);
            showFeedback(error.message || 'Screen analysis failed', 'error');
            if (activeScreenAiStream) {
                activeScreenAiStream.finalize(`**[Screen Analysis]**\n\n⚠️ ${error.message || 'Screen analysis failed'}`);
                activeScreenAiStream.cleanup();
                activeScreenAiStream = null;
            }
        } finally {
            setAnalyzing(false);
            hideLoadingOverlay();
            if (activeScreenAiStream) {
                activeScreenAiStream.cleanup();
                activeScreenAiStream = null;
            }
            if (analyzeScreenBtn) {
                analyzeScreenBtn.classList.remove('analyzing');
                analyzeScreenBtn.disabled = isAnalyzing || isAiActionInFlight('screenIntelligence') || !hasGeminiApiKeysConfigured;
                analyzeScreenBtn.removeAttribute('aria-busy');
            }
            updateUI();
        }
    });

    if (rerunScreenAnalysisAfterCancel) {
        rerunScreenAnalysisAfterCancel = false;
        await analyzeScreenAction();
    }
}

// Reanalyze an earlier screen answer: main re-reads the visible screen from
// current pixels, answers independently (the earlier answer is not in the
// context) and compares. The earlier answer is marked superseded and leaves
// the AI context. A second press confirms when the screen shows a different
// problem.
let reanalyzeConfirmedFor = null;
async function reanalyzeAnswerAction(messageId) {
    const original = messageStore.findById(messageId);
    if (!original || !String(original.content).startsWith('**[Screen Analysis]**')) return;
    if (isAiActionInFlight('screenIntelligence') || isAnalyzing) {
        showFeedback('A screen analysis is already running. Stop it first.', 'warn');
        return;
    }
    const force = reanalyzeConfirmedFor === messageId;
    reanalyzeConfirmedFor = null;
    const header = '**[Screen Analysis]**\n\n';
    const previousAnswer = String(original.content).replace(/^\*\*\[Screen Analysis\]\*\*\s*\n+/, '');
    const bundle = buildAiContextBundle({
        messages: chatMessagesArray.filter((m) => m.id !== messageId),
        isMessageIncludedForAi,
        charBudget: AI_CONTEXT_CHAR_BUDGET,
        emitTruncationLog: false
    });
    const responseMode = responseModeSelect ? responseModeSelect.value : 'professional';

    await runAiActionWithLock('screenIntelligence', async () => {
        const stream = createStreamHandler('screenIntelligence');
        // The shared analysis-result listener must neither add its own message
        // nor finalize (and save) this card before the comparison is added:
        // it sees a placeholder; this function finalizes and saves once.
        const placeholder = { finalize() {}, cleanup() {}, setProblemId() {}, markInterrupted() {} };
        activeScreenAiStream = placeholder;
        try {
            setAnalyzing(true);
            showLoadingOverlay('Reading the screen again...');
            stream.start(header);
            const result = await window.electronAPI.reanalyzeScreen({
                contextString: bundle.contextString,
                responseMode,
                problemId: original.problemId || null,
                previousAnswer,
                force
            });
            stream.setProblemId(result?.problemId);
            if (result?.code === 'PROBLEM_CHANGED') {
                reanalyzeConfirmedFor = messageId;
                const title = result.problem?.title ? `“${result.problem.title}”` : 'a different problem';
                stream.finalize(`${header}The screen now shows ${title}, not the problem this answer was about. Press **New problem** to start it, or press **Reanalyze** on the earlier answer again to analyse what is on screen anyway.`);
            } else if (result?.success && result?.text) {
                const body = result.text.startsWith(header) ? result.text.slice(header.length) : result.text;
                const notes = [];
                if (result.refreshed && !result.refreshed.settled) notes.push('_Part of the screen was still being re-read; the current screen image was used for it._');
                if (result.comparison) notes.push(`**Compared with the earlier answer:** ${result.comparison}`);
                else if (result.comparisonError) notes.push(`_The comparison with the earlier answer failed: ${result.comparisonError}_`);
                stream.finalize(`${header}${body}${notes.length ? `\n\n---\n${notes.join('\n\n')}` : ''}`);
                original.includeInAi = false;
                original.superseded = true;
                chatMessagesArray = messageStore.getMessages();
                updateMessageAiToggleUi(original);
                document.querySelector(`[data-message-id="${CSS.escape(String(messageId))}"]`)?.classList.add('is-superseded');
            } else if (result?.cancelled) {
                stream.markInterrupted('_(reanalysis stopped)_');
            } else {
                const error = result?.error || 'Reanalysis failed';
                showFeedback(error, 'error');
                stream.finalize(`${header}⚠️ ${error}`);
            }
        } catch (error) {
            showFeedback(error.message || 'Reanalysis failed', 'error');
            stream.finalize(`${header}⚠️ ${error.message || 'Reanalysis failed'}`);
        } finally {
            setAnalyzing(false);
            hideLoadingOverlay();
            stream.cleanup();
            if (activeScreenAiStream === placeholder) activeScreenAiStream = null;
            updateUI();
        }
    });
}

async function analyzeScreenshotsOnly() {
    if (!hasGeminiApiKeysConfigured) {
        showFeedback('Gemini API key missing. Add it in Settings.', 'error');
        return;
    }

    const bundle = buildFilteredAiContextBundle({ charBudget: AI_CONTEXT_CHAR_BUDGET, emitTruncationLog: true });
    if (bundle.enabledScreenshotIds.length === 0) {
        showFeedback('No enabled screenshots to analyze', 'error');
        return;
    }

    await runAiActionWithLock('screenAi', async () => {
        const stream = createStreamHandler('screenAi');
        activeScreenAiStream = stream;
        try {
            setAnalyzing(true);
            showLoadingOverlay('Analyzing screenshots...');
            stream.start('');

            await window.electronAPI.analyzeStealthWithContext({
                contextString: bundle.contextString,
                enabledScreenshotIds: bundle.enabledScreenshotIds
            });
        } catch (error) {
            console.error('Analysis error:', error);
            showFeedback('Analysis failed', 'error');
            setAnalyzing(false);
            hideLoadingOverlay();
            // Clean up on error since onAnalysisResult may not fire
            stream.cleanup();
            activeScreenAiStream = null;
        }
        // Don't cleanup in finally - onAnalysisResult handles it for success path
        // This avoids a race where the invoke resolves before the event is delivered
    });
}

async function clearStealthData() {
    try {
        await window.electronAPI.clearStealth();
        if (window.electronAPI.clearConversationHistory) {
            await window.electronAPI.clearConversationHistory();
        }
        clearChatView();
        showFeedback('Cleared', 'success');
    } catch (error) {
        console.error('Clear error:', error);
        showFeedback('Clear failed', 'error');
    }
}

async function emergencyHide() {
    try {
        await window.electronAPI.emergencyHide();
        showEmergencyOverlay();
    } catch (error) {
        console.error('Emergency hide error:', error);
    }
}

let isCompactModeActive = false;

/**
 * Shrinks the window to a thin status strip (window-controller.js's
 * setCompactMode) and hides the chat/monitor panels (#app.compact-mode in
 * ui/app.css) so whatever is underneath — the call, a shared editor — is no
 * longer covered. Distinct from emergencyHide/toggleStealth: this stays
 * fully visible, just small.
 */
async function toggleCompactMode() {
    const next = !isCompactModeActive;

    try {
        const result = await window.electronAPI.setCompactMode(next);
        if (result?.error) throw new Error(result.error);
        isCompactModeActive = Boolean(result?.compact);
    } catch (error) {
        console.error('Failed to toggle compact mode:', error);
        showFeedback('Could not toggle compact mode', 'error');
        return;
    }

    document.getElementById('app')?.classList.toggle('compact-mode', isCompactModeActive);

    if (compactModeBtn) {
        compactModeBtn.setAttribute('aria-label', isCompactModeActive ? 'Expand from compact mode' : 'Shrink to compact mode');
        compactModeBtn.setAttribute('data-tip', isCompactModeActive ? 'Expand' : 'Compact mode');
        compactModeBtn.classList.toggle('active', isCompactModeActive);
    }

    addMonitorLog('info', 'compact-mode', isCompactModeActive ? 'Entered compact mode' : 'Exited compact mode');
}

function openCloseConfirmation() {
    if (!closeConfirmationDialog) {
        closeApplication();
        return;
    }

    isCloseConfirmationOpen = true;
    closeConfirmationDialog.classList.remove('hidden');
    confirmCloseBtn?.focus();
}

function closeCloseConfirmation() {
    if (!closeConfirmationDialog) {
        return;
    }

    isCloseConfirmationOpen = false;
    closeConfirmationDialog.classList.add('hidden');
    closeAppBtn?.focus();
}

async function closeApplication() {
    try {
        console.log('Closing application...');
        flushAllFinalTranscripts('app-close');
        await window.electronAPI.closeApp();
    } catch (error) {
        console.error('Close application error:', error);
    }
}

// NEW CLUELY-STYLE FEATURES

async function getResponseSuggestions() {
    if (!hasGeminiApiKeysConfigured) {
        showFeedback('Gemini API key missing. Add it in Settings.', 'error');
        return;
    }

    if (!window.electronAPI || !window.electronAPI.suggestResponse) {
        showFeedback('Feature not available', 'error');
        return;
    }

    await runAiActionWithLock('suggest', async () => {
        const stream = createStreamHandler('suggest');
        try {
            showFeedback('Generating suggestions...', 'info');
            const bundle = buildFilteredAiContextBundle({ charBudget: AI_CONTEXT_CHAR_BUDGET, emitTruncationLog: true });
            const transcriptOnlyContext = String(bundle.transcriptContext || '').trim();
            if (!transcriptOnlyContext) {
                showFeedback('No enabled transcript context available for suggestions', 'error');
                return;
            }

            stream.start('\u{1F4A1} **What should I say?**\n\n');

            const result = await window.electronAPI.suggestResponse({
                context: bundle.sessionSummary || 'Current meeting conversation',
                contextString: transcriptOnlyContext
            });

            if (result.success && result.suggestions) {
                stream.finalize(`\u{1F4A1} **What should I say?**\n\n${result.suggestions}`);
                showFeedback('Suggestions generated', 'success');
            } else {
                throw new Error(result.error || 'Failed to generate suggestions');
            }
        } catch (error) {
            console.error('Error getting suggestions:', error);
            showFeedback('Failed to generate suggestions', 'error');
            addChatMessage('system', `Error: ${error.message}`);
        } finally {
            stream.cleanup();
        }
    });
}

async function generateMeetingNotes() {
    if (!hasGeminiApiKeysConfigured) {
        showFeedback('Gemini API key missing. Add it in Settings.', 'error');
        return;
    }

    if (!window.electronAPI || !window.electronAPI.generateMeetingNotes) {
        showFeedback('Feature not available', 'error');
        return;
    }

    await runAiActionWithLock('notes', async () => {
        const stream = createStreamHandler('notes');
        try {
            showFeedback('Generating meeting notes...', 'info');
            setAnalyzing(true);
            const bundle = buildFilteredAiContextBundle({ charBudget: AI_CONTEXT_CHAR_BUDGET, emitTruncationLog: true });
            if (!bundle.contextString) {
                showFeedback('No enabled context available for notes', 'error');
                return;
            }

            stream.start('\u{1F4DD} **Meeting Notes**\n\n');

            const result = await window.electronAPI.generateMeetingNotes({
                contextString: bundle.contextString
            });

            if (result.success && result.notes) {
                stream.finalize(`\u{1F4DD} **Meeting Notes**\n\n${result.notes}`);
                showFeedback('Meeting notes generated', 'success');
            } else {
                throw new Error(result.error || 'Failed to generate notes');
            }
        } catch (error) {
            console.error('Error generating notes:', error);
            showFeedback('Failed to generate notes', 'error');
            addChatMessage('system', `Error: ${error.message}`);
        } finally {
            stream.cleanup();
            setAnalyzing(false);
        }
    });
}

async function getConversationInsights() {
    if (!hasGeminiApiKeysConfigured) {
        showFeedback('Gemini API key missing. Add it in Settings.', 'error');
        return;
    }

    if (!window.electronAPI || !window.electronAPI.getConversationInsights) {
        showFeedback('Feature not available', 'error');
        return;
    }

    await runAiActionWithLock('insights', async () => {
        const stream = createStreamHandler('insights');
        try {
            showFeedback('Analyzing conversation...', 'info');
            setAnalyzing(true);
            const bundle = buildFilteredAiContextBundle({ charBudget: AI_CONTEXT_CHAR_BUDGET, emitTruncationLog: true });
            if (!bundle.contextString) {
                showFeedback('No enabled context available for insights', 'error');
                return;
            }

            stream.start('\u{1F4CA} **Conversation Insights**\n\n');

            const result = await window.electronAPI.getConversationInsights({
                contextString: bundle.contextString
            });

            if (result.success && result.insights) {
                stream.finalize(`\u{1F4CA} **Conversation Insights**\n\n${result.insights}`);
                showFeedback('Insights generated', 'success');
            } else {
                throw new Error(result.error || 'Failed to get insights');
            }
        } catch (error) {
            console.error('Error getting insights:', error);
            showFeedback('Failed to get insights', 'error');
            addChatMessage('system', `Error: ${error.message}`);
        } finally {
            stream.cleanup();
            setAnalyzing(false);
        }
    });
}

// SETTINGS FUNCTIONS

async function openSettings() {
    await settingsPanelManager.openSettings();
}

function closeSettings() {
    settingsPanelManager.closeSettings();
}

async function saveSettings() {
    const result = await settingsPanelManager.saveSettings();
    if (result?.success && result?.settings) {
        applyApiKeyAvailabilityFromSettings(result.settings);
        updateUI();
    }
}

// UI Helper functions
function setAnalyzing(analyzing) {
    isAnalyzing = analyzing;
    updateUI();
}

function updateUI() {
    if (screenshotCount) {
        screenshotCount.textContent = screenshotsCount;
        screenshotCount.hidden = !screenshotsCount;
    }
    updateSessionStatus();

    const aiBundle = buildFilteredAiContextBundle({
        charBudget: AI_CONTEXT_CHAR_BUDGET,
        emitTruncationLog: false
    });
    const hasTranscriptContext = aiBundle.transcriptContext.length > 0;
    const hasEnabledScreenshots = aiBundle.enabledScreenshotIds.length > 0;
    const hasAiContext = hasTranscriptContext || hasEnabledScreenshots || aiBundle.contextString.length > 0;
    const canRunAiActions = hasGeminiApiKeysConfigured;
    const canRunTranscription = hasAssemblyAiApiKeyConfigured;
    const askAiInFlight = isAiActionInFlight('askAi');
    const screenAiInFlight = isAiActionInFlight('screenAi');
    const screenIntelInFlight = isAiActionInFlight('screenIntelligence');
    const suggestInFlight = isAiActionInFlight('suggest');
    const notesInFlight = isAiActionInFlight('notes');
    const insightsInFlight = isAiActionInFlight('insights');

    if (analyzeScreenBtn) {
        analyzeScreenBtn.disabled = isAnalyzing || screenIntelInFlight || !canRunAiActions;
    }

    if (analyzeBtn) {
        analyzeBtn.disabled = isAnalyzing || askAiInFlight || !canRunAiActions || !hasAiContext;
    }

    if (screenAiBtn) {
        screenAiBtn.disabled = isAnalyzing || screenAiInFlight || !canRunAiActions || !hasEnabledScreenshots;
    }

    if (suggestBtn) {
        suggestBtn.disabled = isAnalyzing || suggestInFlight || !canRunAiActions || !hasTranscriptContext;
    }

    if (notesBtn) {
        notesBtn.disabled = isAnalyzing || notesInFlight || !canRunAiActions || !hasAiContext;
    }

    if (insightsBtn) {
        insightsBtn.disabled = isAnalyzing || insightsInFlight || !canRunAiActions || !hasAiContext;
    }

    if (transcriptionToggle) {
        transcriptionToggle.disabled = !canRunTranscription;
    }

    if (sourceSystemToggle) {
        sourceSystemToggle.disabled = !canRunTranscription;
    }

    if (sourceMicToggle) {
        sourceMicToggle.disabled = !canRunTranscription;
    }

    // Reflect selection state on the source pills so "off" is visible at a
    // glance and announced to assistive tech, rather than being carried only by
    // a subtle background tint.
    if (sourceSystemToggle) {
        sourceSystemToggle.setAttribute('aria-pressed', String(!!selectedSources.system));
        sourceSystemToggle.classList.toggle('deselected', !selectedSources.system);
    }

    if (sourceMicToggle) {
        sourceMicToggle.setAttribute('aria-pressed', String(!!selectedSources.mic));
        sourceMicToggle.classList.toggle('deselected', !selectedSources.mic);
    }

    const hasSelectedSource = !!(selectedSources.system || selectedSources.mic);

    // Turning both sources off is a dead end: the toggle looks live but every
    // click fails with a message that disappears after three seconds. Surface
    // it on the control itself instead.
    if (transcriptionControl) {
        transcriptionControl.classList.toggle(
            'needs-source',
            canRunTranscription && !hasSelectedSource
        );
    }

    applyDisabledReasons({
        canRunAiActions,
        canRunTranscription,
        hasTranscriptContext,
        hasEnabledScreenshots,
        hasAiContext,
        hasSelectedSource
    });
}

/**
 * A disabled button with no explanation is indistinguishable from a broken one.
 * Each control keeps its normal tooltip when usable, and states the specific
 * blocker when not.
 */
function applyDisabledReasons(state) {
    const missingAiKey = 'Add a Gemini API key in Settings to enable this';
    const missingSttKey = 'Add an AssemblyAI API key in Settings to enable transcription';

    const reasonFor = (button, reasons) => {
        if (!button) return;

        if (!button.dataset.defaultTitle) {
            button.dataset.defaultTitle = button.getAttribute('title') || '';
        }

        // Keyed off the blocking reasons rather than `disabled`: the
        // transcription toggle stays enabled with no source selected, yet every
        // click fails, so it still needs to explain itself.
        const reason = reasons.find(Boolean);
        button.setAttribute('title', reason || button.dataset.defaultTitle);
    };

    reasonFor(analyzeScreenBtn, [
        !state.canRunAiActions && missingAiKey
    ]);

    reasonFor(analyzeBtn, [
        !state.canRunAiActions && missingAiKey,
        !state.hasAiContext && 'Nothing to work from yet — start transcription, add a screenshot, or type some context'
    ]);

    reasonFor(screenAiBtn, [
        !state.canRunAiActions && missingAiKey,
        !state.hasEnabledScreenshots && 'Capture a screenshot first (⌥⇧S)'
    ]);

    reasonFor(suggestBtn, [
        !state.canRunAiActions && missingAiKey,
        !state.hasTranscriptContext && 'Needs a transcript — start transcription first (⌥⇧T)'
    ]);

    reasonFor(notesBtn, [
        !state.canRunAiActions && missingAiKey,
        !state.hasAiContext && 'Nothing to summarise yet'
    ]);

    reasonFor(insightsBtn, [
        !state.canRunAiActions && missingAiKey,
        !state.hasAiContext && 'Nothing to analyse yet'
    ]);

    reasonFor(transcriptionToggle, [
        !state.canRunTranscription && missingSttKey,
        !state.hasSelectedSource && 'Pick a source first — click Host (speaker) or Mic to the right'
    ]);
    reasonFor(sourceSystemToggle, [!state.canRunTranscription && missingSttKey]);
    reasonFor(sourceMicToggle, [!state.canRunTranscription && missingSttKey]);
}

function showFeedback(message, type = 'info') {
    console.log(`Feedback (${type}):`, message);

    if (statusText) {
        statusText.textContent = message;
        statusText.className = `status-text ${type} show`;
        statusText.style.display = 'block';

        setTimeout(() => {
            statusText.classList.remove('show');
            setTimeout(() => {
                statusText.style.display = 'none';
            }, 300);
        }, 3000);
    }
}

function showLoadingOverlay(message = 'Analyzing screen...') {
    if (loadingOverlay) {
        // Update the loading text if custom message provided
        const loadingTextElement = loadingOverlay.querySelector('.loading-text');
        if (loadingTextElement) {
            loadingTextElement.innerHTML = message;
        }
        loadingOverlay.classList.remove('hidden');
    }
}

function hideLoadingOverlay() {
    if (loadingOverlay) {
        loadingOverlay.classList.add('hidden');
        // Reset to default text
        const loadingTextElement = loadingOverlay.querySelector('.loading-text');
        if (loadingTextElement) {
            loadingTextElement.innerHTML = 'Analyzing screen...';
        }
    }
}

function showEmergencyOverlay() {
    if (emergencyOverlay) {
        emergencyOverlay.classList.remove('hidden');
        setTimeout(() => {
            emergencyOverlay.classList.add('hidden');
        }, 2000);
    }
}

function hideResults() {
    if (resultsPanel) {
        resultsPanel.classList.add('hidden');
    }
}

async function writeTextToClipboard(text) {
    const value = String(text ?? '');

    // Main-process clipboard first: it does not need this window to have
    // focus and confirms the write by reading it back.
    if (window.electronAPI?.writeClipboardText) {
        const result = await window.electronAPI.writeClipboardText(value);
        if (result?.success) return;
        if (result?.code !== 'IPC_FAILED') throw new Error(result?.error || 'Clipboard write failed');
    }

    if (navigator?.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(value);
            return;
        } catch (error) {
            console.warn('Clipboard API denied, using fallback copy path:', error);
        }
    }

    const copyListener = (event) => {
        event.preventDefault();
        if (event.clipboardData) {
            event.clipboardData.setData('text/plain', value);
        }
    };

    document.addEventListener('copy', copyListener, true);
    try {
        const copiedViaEvent = document.execCommand('copy');
        if (copiedViaEvent) {
            return;
        }
    } finally {
        document.removeEventListener('copy', copyListener, true);
    }

    const temporaryInput = document.createElement('textarea');
    temporaryInput.value = value;
    temporaryInput.setAttribute('readonly', '');
    temporaryInput.style.position = 'fixed';
    temporaryInput.style.left = '-9999px';
    temporaryInput.style.top = '0';
    document.body.appendChild(temporaryInput);
    temporaryInput.select();

    const copiedViaSelection = document.execCommand('copy');
    document.body.removeChild(temporaryInput);

    if (!copiedViaSelection) {
        throw new Error('Clipboard write failed');
    }
}

async function copyChatMessageById(messageId) {
    const message = messageStore.findById(messageId);
    // A streaming answer is incomplete: copying it would hand out half an answer.
    const messageEl = document.querySelector(`[data-message-id="${CSS.escape(String(messageId))}"]`);
    if (messageEl?.dataset.streaming === 'true') {
        showFeedback('The answer is still being written. Copy it when it finishes.', 'warn');
        return;
    }
    // The whole Markdown source (code fences, lists, maths intact), without
    // the internal heading the screen answers start with.
    const content = String(message?.content || '').replace(/^\*\*\[Screen Analysis\]\*\*\s*\n+/, '');

    if (!content.trim()) {
        showFeedback('Nothing to copy', 'error');
        return;
    }

    try {
        await writeTextToClipboard(content);
        showFeedback(`Copied ${content.length.toLocaleString()} characters`, 'success');
    } catch (error) {
        console.error('Message copy error:', error);
        showFeedback('Copy failed', 'error');
    }
}

// Chat message management
function addChatMessage(type, content, options = {}) {
    return chatUiManager.addChatMessage(type, content, options);
}

/**
 * Empties the chat. The saved conversation stays in History; unless
 * `keepConversation` (opening another one), the next message starts a new one.
 */
function clearChatView({ keepConversation = false } = {}) {
    screenshotsCount = 0;
    messageStore.clear();
    chatMessagesArray = messageStore.getMessages();
    chatMessagesElement.innerHTML = '';
    if (!keepConversation) window.electronAPI?.conversationsNew?.();
    updateUI();
}

/** Shows saved messages (restored after a restart, reopened, or synced from the website) without saving them again. */
function renderSavedMessages(messages) {
    for (const m of messages || []) {
        if (messageStore.findById(m.id)) continue;
        addChatMessage(toChatType(m), m.content, { id: m.id, persist: false, timestamp: new Date(m.createdAt) });
    }
}

function autoResizeManualInput() {
    chatUiManager.autoResizeManualInput();
}

function updateManualComposerState() {
    chatUiManager.updateManualComposerState();
}

function submitManualContextMessage() {
    chatUiManager.submitManualContextMessage();
}

// Timer
function startTimer() {
    const timerElement = document.querySelector('.timer');
    if (!timerElement) return;

    timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
        const seconds = (elapsed % 60).toString().padStart(2, '0');
        timerElement.textContent = `${minutes}:${seconds}`;
    }, 1000);
}

// Event listeners
function setupEventListeners() {
    setupEventListenersModule({
        windowApi: window.electronAPI,
        analyzeScreenBtn,
        screenshotBtn,
        analyzeBtn,
        screenAiBtn,
        clearBtn,
        hideBtn,
        compactModeBtn,
        chatManualSend,
        chatManualInput,
        closeResultsBtn,
        transcriptionToggle,
        sourceSystemToggle,
        sourceMicToggle,
        closeAppBtn,
        cancelCloseBtn,
        confirmCloseBtn,
        closeConfirmationDialog,
        chatMessagesElement,
        suggestBtn,
        notesBtn,
        insightsBtn,
        themeToggleBtn,
        settingsBtn,
        closeSettingsBtn,
        saveSettingsBtn,
        settingWindowOpacity,
        selectedSources,
        isCloseConfirmationOpen: () => isCloseConfirmationOpen,
        isShortcutPressed,
        updateWindowOpacityValueLabel,
        takeStealthScreenshot,
        analyzeScreenAction,
        askAiWithSessionContext,
        analyzeScreenshotsOnly,
        clearStealthData,
        emergencyHide,
        toggleCompactMode,
        copyChatMessageById,
        submitManualContextMessage,
        autoResizeManualInput,
        updateManualComposerState,
        hideResults,
        toggleMasterTranscription,
        addMonitorLog,
        setSourceSelected,
        openCloseConfirmation,
        closeCloseConfirmation,
        closeApplication,
        toggleChatMessageInclusion,
        getResponseSuggestions,
        generateMeetingNotes,
        getConversationInsights,
        toggleThemeMode,
        openSettings,
        closeSettings,
        saveSettings
    });
}

// IPC listeners
function setupIpcListeners() {
    setupIpcListenersModule({
        windowApi: window.electronAPI,
        setScreenshotsCount: (nextCount) => {
            screenshotsCount = nextCount;
        },
        updateUi: updateUI,
        addChatMessage,
        setAnalyzing,
        showLoadingOverlay,
        hideLoadingOverlay,
        showFeedback,
        showEmergencyOverlay,
        transcriptionManager,
        toggleMasterTranscription,
        askAiWithSessionContext,
        isAskAiShortcutEnabled: () => Boolean(analyzeBtn && !analyzeBtn.disabled),
        addMonitorLog,
        getActiveScreenAiStream: () => activeScreenAiStream,
        clearActiveScreenAiStream: () => {
            if (activeScreenAiStream) {
                activeScreenAiStream.cleanup();
                activeScreenAiStream = null;
            }
        }
    });
}

/*
 * Narrow bridge for auto-answer.js (a separate ES module, so it cannot reach
 * this file's closures directly).
 *
 * askAiWithSessionContext() builds its Gemini prompt from chatMessagesArray —
 * NOT from whatever string triggered the click — so auto-answer's follow-up
 * resolution ("Why?" -> "Why did you choose PostgreSQL for that project?")
 * had no way to actually reach the model; it could only affect logging.
 * This lets it drop a system-authored annotation into the same message store
 * everything else feeds from, so the resolved framing is genuinely part of
 * transcriptContext by the time the click fires. includeInAi: true is
 * explicit rather than relying on a type-based default, since silently
 * defaulting to excluded would make this a no-op that looks like a fix.
 */
window.__synapseAnnotateResolvedQuestion = (resolvedText) => {
    if (!resolvedText) return;
    // 'resolved-question', not 'system' — contextLineForMessage() renders
    // 'system' messages as empty (they're excluded from context on purpose),
    // which was the original bug: this never reached transcriptContext no
    // matter how the ordering worked out. See message-types.js.
    addChatMessage('resolved-question', resolvedText, { includeInAi: true });
};

/**
 * Phase 6: the explicit ACTIVE CONTEXT block (current question, relation,
 * confidence, active topic, previous question/answer, relevant entities) —
 * conversation-tracker.js already computes all of this on every
 * resolveQuestion() call; this is just the delivery bridge, same mechanism
 * as __synapseAnnotateResolvedQuestion above and for the same reason
 * (crossing from auto-answer.js's queue timing into the chat message store
 * that actually feeds the AI request). 'active-context' is its own message
 * type — not 'resolved-question' — because it is not conversational text
 * (it must never render as something the host said) and only the single
 * most recent one matters, unlike transcript lines which accumulate.
 */
window.__synapseAnnotateActiveContext = (activeContextText) => {
    if (!activeContextText) return;
    addChatMessage('active-context', activeContextText, { includeInAi: true });
};

/*
 * Two more bridges for the same reason, fixing the "answers the previous
 * question" bug: transcriptBufferManager (above) merges fragmented AssemblyAI
 * finals for up to mergeWindowMs before it ever calls addChatMessage, but
 * auto-answer.js's own settle timer can decide to click Ask AI in as little
 * as 120ms — far sooner. askAiWithSessionContext() reads chatMessagesArray at
 * click time, so the question that just triggered the click was routinely
 * still sitting unflushed, and the click answered whatever the *previous*
 * turn had left in chat instead.
 */
window.__synapseFlushHostTranscript = (source = 'system') => {
    transcriptBufferManager.flushFinalTranscript(source, 'auto-answer-dispatch');
    if (typeof updateUI === 'function') updateUI();
};

// Early-fire (auto-answer.js) acts on a partial, before AssemblyAI has even
// closed the turn — there is no final yet for flushFinalTranscript to flush.
// Commit the detected text directly, then clear the buffer so the real final
// (which will arrive moments later for the same utterance) does not also
// flush it as a second, duplicate chat line.
window.__synapseCommitEarlyHostTranscript = (text, source = 'system') => {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    addChatMessage(source === 'mic' ? 'voice-mic' : 'voice-system', trimmed);
    transcriptBufferManager.resetFinalTranscriptBuffer(source);
    if (typeof updateUI === 'function') updateUI();
};

window.__synapseIsSystemAudioActive = () => {
    return Boolean(transcriptionManager && transcriptionManager.isSourceActive && transcriptionManager.isSourceActive('system'));
};

// Initialize on load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}






initConversationHistory({
    renderMessages: renderSavedMessages,
    clearChatView,
    setResponseMode: (mode) => {
        if (!responseModeSelect || !RESPONSE_MODE_IDS.includes(mode) || responseModeSelect.value === mode) return;
        responseModeSelect.value = mode;
        try { localStorage.setItem(RESPONSE_MODE_STORAGE_KEY, mode); } catch (_) { /* not persisted this session */ }
    },
    showFeedback: (message, type) => showFeedback(message, type)
});
