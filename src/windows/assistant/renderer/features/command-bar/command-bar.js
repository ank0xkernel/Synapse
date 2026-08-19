/*
 * Command bar.
 *
 * The toolbar used to carry eleven buttons. Five of them — Ask AI, Screen AI,
 * Suggest, Notes, Insights — are the same operation with a different prompt,
 * which is what made the bar feel like a wall of near-identical controls.
 * Those are now slash-commands, and plain text is the primary "ask" path.
 *
 * This layer deliberately does not reimplement any feature. It resolves the
 * existing control for a command and dispatches a real click, so every
 * feature manager, disabled-state guard and keyboard shortcut keeps working
 * exactly as before. That also means a command cannot silently drift out of
 * sync with the button it stands for.
 */

const COMMANDS = [
    {
        id: 'ask',
        name: 'Ask',
        aliases: ['ask', 'answer', 'a'],
        icon: '↩',
        description: 'Answer using transcript, screenshots and chat context',
        target: 'analyze-btn',
        key: '⌥⇧A',
        takesText: true
    },
    {
        id: 'screen',
        name: 'Screen',
        aliases: ['screen', 'screenai', 'vision'],
        icon: '🖥',
        description: 'Analyse the captured screenshots only',
        target: 'screen-ai-btn',
        key: '⌥⇧E'
    },
    {
        id: 'suggest',
        name: 'Suggest',
        aliases: ['suggest', 'next', 'g'],
        icon: '✨',
        description: 'Suggest what to say next',
        target: 'suggest-btn',
        key: '⌥⇧G'
    },
    {
        id: 'notes',
        name: 'Notes',
        aliases: ['notes', 'summary'],
        icon: '📝',
        description: 'Generate notes from the conversation',
        target: 'notes-btn',
        key: '⌥⇧N'
    },
    {
        id: 'insights',
        name: 'Insights',
        aliases: ['insights', 'key'],
        icon: '📊',
        description: 'Pull the key points out of the conversation',
        target: 'insights-btn',
        key: '⌥⇧I'
    },
    {
        id: 'shot',
        name: 'Capture',
        aliases: ['shot', 'capture', 'screenshot'],
        icon: '📷',
        description: 'Capture the screen',
        target: 'screenshot-btn',
        key: '⌥⇧S'
    },
    {
        id: 'listen',
        name: 'Transcription',
        aliases: ['listen', 'transcribe', 'mic'],
        icon: '🎙',
        description: 'Start or stop transcribing',
        target: 'transcription-toggle',
        key: '⌥⇧T'
    },
    {
        id: 'clear',
        name: 'Clear',
        aliases: ['clear', 'reset'],
        icon: '⌫',
        description: 'Clear the chat, screenshots and history',
        target: 'clear-btn',
        key: '⌥⇧C'
    },
    {
        id: 'theme',
        name: 'Theme',
        aliases: ['theme', 'dark', 'light'],
        icon: '◐',
        description: 'Switch between light and dark',
        target: 'theme-toggle-btn'
    },
    {
        id: 'settings',
        name: 'Settings',
        aliases: ['settings', 'prefs', 'config'],
        icon: '⚙',
        description: 'Open settings',
        target: 'settings-btn'
    },
    {
        id: 'hide',
        name: 'Hide',
        aliases: ['hide'],
        icon: '👁',
        description: 'Hide this window',
        target: 'hide-btn',
        key: '⌥⇧X'
    }
];

function initCommandBar() {
    const input = document.getElementById('chat-manual-input');
    const sendBtn = document.getElementById('chat-manual-send');
    const list = document.getElementById('command-suggestions');
    const composer = document.getElementById('chat-composer');

    if (!input || !sendBtn || !list) {
        return;
    }

    let activeIndex = 0;
    let visible = [];
    let paletteMode = false;

    const target = (command) => document.getElementById(command.target);
    const isAvailable = (command) => {
        const el = target(command);
        return !!el && !el.disabled;
    };

    /** Runs a command by clicking the control that owns the behaviour. */
    function run(command) {
        const el = target(command);

        if (!el) {
            console.warn(`[CommandBar] No control found for "${command.id}" (#${command.target}).`);
            return;
        }

        if (el.disabled) {
            return;
        }

        close();
        el.click();
    }

    function matches(query) {
        const q = query.trim().toLowerCase();
        if (!q) return COMMANDS;
        return COMMANDS.filter((c) =>
            c.aliases.some((a) => a.startsWith(q)) || c.name.toLowerCase().includes(q));
    }

    function render(commands, heading) {
        visible = commands;
        activeIndex = Math.min(activeIndex, Math.max(commands.length - 1, 0));

        list.textContent = '';

        if (commands.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'command-empty';
            empty.textContent = 'No matching command';
            list.appendChild(empty);
            list.hidden = false;
            return;
        }

        const label = document.createElement('div');
        label.className = 'command-group-label';
        label.textContent = heading;
        list.appendChild(label);

        commands.forEach((command, index) => {
            const available = isAvailable(command);

            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'command-option';
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(index === activeIndex));
            option.disabled = !available;

            const icon = document.createElement('span');
            icon.className = 'command-option-icon';
            icon.textContent = command.icon;

            const body = document.createElement('span');
            body.className = 'command-option-body';

            const name = document.createElement('span');
            name.className = 'command-option-name';
            name.textContent = command.name;

            const desc = document.createElement('span');
            desc.className = 'command-option-desc';
            // Say why it is unavailable rather than just greying it out.
            desc.textContent = available ? command.description : `${command.description} — unavailable right now`;

            body.append(name, desc);
            option.append(icon, body);

            if (command.key) {
                const key = document.createElement('kbd');
                key.className = 'command-option-key';
                key.textContent = command.key;
                option.appendChild(key);
            }

            option.addEventListener('mouseenter', () => {
                activeIndex = index;
                syncSelection();
            });
            // mousedown, not click: the input's blur would tear the list down first.
            option.addEventListener('mousedown', (event) => {
                event.preventDefault();
                run(command);
            });

            list.appendChild(option);
        });

        list.hidden = false;
    }

    function syncSelection() {
        const options = list.querySelectorAll('.command-option');
        options.forEach((option, index) => {
            option.setAttribute('aria-selected', String(index === activeIndex));
        });
        options[activeIndex]?.scrollIntoView({ block: 'nearest' });
    }

    function close() {
        list.hidden = true;
        paletteMode = false;
        activeIndex = 0;
        visible = [];
    }

    function openPalette() {
        paletteMode = true;
        activeIndex = 0;
        render(COMMANDS, 'Commands');
        input.focus();
    }

    function refreshFromInput() {
        const value = input.value;

        if (paletteMode) {
            render(matches(value.replace(/^\//, '')), 'Commands');
            return;
        }

        if (value.startsWith('/')) {
            activeIndex = 0;
            render(matches(value.slice(1)), 'Commands');
            return;
        }

        close();
    }

    /** Enter with plain text: stage it as context, then ask. */
    function submitPlainText() {
        const text = input.value.trim();
        const ask = COMMANDS.find((c) => c.id === 'ask');

        if (!text) {
            run(ask);
            return;
        }

        // `chat-manual-send` is the original "add this as You" control; keeping
        // it in the flow means the message still lands in the transcript the
        // model reads, instead of being passed round the side.
        sendBtn.click();

        // Let the manager append the message before the AI pass reads context.
        setTimeout(() => run(ask), 60);
    }

    input.addEventListener('input', refreshFromInput);

    input.addEventListener('keydown', (event) => {
        const listOpen = !list.hidden && visible.length > 0;

        if (event.key === 'Escape') {
            if (listOpen) {
                event.preventDefault();
                event.stopPropagation();
                close();
            }
            return;
        }

        if (listOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            activeIndex = (activeIndex + delta + visible.length) % visible.length;
            syncSelection();
            return;
        }

        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            // stopPropagation: the legacy composer listener also submits on
            // Enter, and would otherwise stage the raw "/notes" text as context.
            event.stopPropagation();

            if (listOpen) {
                const chosen = visible[activeIndex];
                if (chosen) {
                    input.value = '';
                    run(chosen);
                }
                return;
            }

            submitPlainText();
        }
    }, true);

    input.addEventListener('blur', () => {
        // Delay so a click on an option is not cancelled by the list closing.
        setTimeout(close, 120);
    });

    // ⌘K / Ctrl+K opens the palette from anywhere in the window.
    document.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            if (list.hidden) openPalette();
            else close();
        }
    });

    // Reflect in-flight work on the bar, driven by the real button's own
    // disabled state so it cannot disagree with what is actually happening.
    const askBtn = document.getElementById('analyze-btn');
    if (askBtn && composer && 'MutationObserver' in window) {
        const observer = new MutationObserver(() => {
            composer.classList.toggle('is-busy', askBtn.disabled);
            sendBtn.disabled = askBtn.disabled;
        });
        observer.observe(askBtn, { attributes: true, attributeFilter: ['disabled'] });
    }

    // Hide the screenshot counter at zero instead of showing a bare "0".
    const count = document.getElementById('screenshot-count');
    if (count && 'MutationObserver' in window) {
        const sync = () => count.setAttribute('data-count', count.textContent.trim());
        sync();
        new MutationObserver(sync).observe(count, { childList: true, characterData: true, subtree: true });
    }

    // Global shortcuts for the five actions that are no longer buttons arrive
    // here as { command: '<id>' } and resolve through the same registry.
    if (window.electronAPI?.onTriggerCommand) {
        window.electronAPI.onTriggerCommand((payload) => {
            const command = COMMANDS.find((c) => c.id === payload?.command);
            if (command) {
                run(command);
            } else {
                console.warn('[CommandBar] Unknown shortcut command:', payload?.command);
            }
        });
    }

    // Every control gets a tooltip naming what it does and its shortcut. The
    // icon-only buttons were previously unlabelled guesses.
    applyTooltips();
    initAppearanceControls();

    console.log('[CommandBar] Ready — / for commands, ⌘K for the palette.');
}

/**
 * Transparency, brightness, and glass intensity.
 *
 * These drive CSS custom properties on :root rather than Electron's window
 * opacity: window opacity dims the text along with everything else, so at the
 * levels people actually want the answer becomes unreadable. Acting on the
 * surface keeps the text crisp.
 *
 * Glass (--shell-blur) maps the same 0-100 slider scale the other two use
 * onto an 8-40px backdrop-filter blur radius — "soft" to "strong" — rather
 * than surfacing a raw pixel value, which would mean nothing to someone who
 * isn't a CSS author. toCss lets a pair override the default value/scale
 * numeric mapping without changing how transparency/brightness already work.
 */
function initAppearanceControls() {
    const pairs = [
        { input: 'setting-transparency', output: 'setting-transparency-value', prop: '--shell-veil', store: 'synapse_veil', scale: 100 },
        { input: 'setting-brightness', output: 'setting-brightness-value', prop: '--shell-brightness', store: 'synapse_brightness', scale: 100 },
        {
            input: 'setting-glass-intensity',
            output: 'setting-glass-intensity-value',
            prop: '--shell-blur',
            store: 'synapse_blur',
            scale: 100,
            toCss: (value) => `${Math.round(8 + (value / 100) * 32)}px`
        }
    ];

    for (const { input, output, prop, store, scale, toCss } of pairs) {
        const slider = document.getElementById(input);
        const readout = document.getElementById(output);
        if (!slider) continue;

        const apply = (value, persist) => {
            document.documentElement.style.setProperty(prop, toCss ? toCss(value) : String(value / scale));
            if (readout) readout.textContent = `${value}%`;
            if (persist) {
                try { localStorage.setItem(store, String(value)); } catch (_) { /* non-fatal */ }
            }
        };

        let saved = null;
        try { saved = localStorage.getItem(store); } catch (_) { /* ignore */ }

        const initial = Number(saved) || Number(slider.value);
        slider.value = String(initial);
        apply(initial, false);

        slider.addEventListener('input', () => apply(Number(slider.value), true));
    }
}

/**
 * Gives every toolbar control a title, and keeps it in sync with the user's
 * configured accelerator so an edited shortcut is reflected on hover.
 */
function applyTooltips() {
    const labels = {
        'transcription-toggle': ['Transcription', 'Start or stop listening'],
        'source-system-toggle': ['Host audio', 'Transcribe the other person on the call'],
        'source-mic-toggle': ['Your microphone', 'Transcribe your own voice'],
        'screenshot-btn': ['Capture', 'Capture the screen for the AI to read'],
        'mobile-server-pill': ['Phone companion', 'Pair a phone to see answers on it'],
        'theme-toggle-btn': ['Theme', 'Switch between light and dark'],
        'settings-btn': ['Settings', 'Keys, models, shortcuts'],
        'hide-btn': ['Hide', 'Hide this window'],
        'close-app-btn': ['Quit', 'Close Synapse'],
        'chat-manual-send': ['Ask', 'Send this and get an answer'],
        'chat-autoscroll-toggle': ['Auto-scroll', 'Follow new messages as they arrive']
    };

    const shortcuts = window.__synapseShortcuts || {};

    for (const [id, [name, description]] of Object.entries(labels)) {
        const el = document.getElementById(id);
        if (!el) continue;

        const key = shortcuts[id];
        el.title = key ? `${name} — ${description}  (${key})` : `${name} — ${description}`;
        if (!el.getAttribute('aria-label')) {
            el.setAttribute('aria-label', name);
        }
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCommandBar);
} else {
    initCommandBar();
}
