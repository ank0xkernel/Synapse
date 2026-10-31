import { renderMarkdown } from './markdown.js';

const ICONS = {
    host: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>',
    you: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>',
    answer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>',
    screen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
    regenerate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>'
};

const MESSAGE_META = {
    voice: { icon: 'you', label: 'You' },
    'voice-mic': { icon: 'you', label: 'You' },
    'voice-system': { icon: 'host', label: 'Interviewer' },
    screenshot: { icon: 'screen', label: 'Screen' },
    'ai-response': { icon: 'answer', label: 'Answer' },
    system: { icon: 'info', label: '' }
};

export function createChatUiManager({
    chatContainer,
    chatMessagesElement,
    chatComposer,
    chatManualInput,
    chatManualSend,
    messageStore,
    maxChatInputHeight,
    escapeHtml,
    updateUi,
    onMessagesChanged,
    showFeedback,
    addMonitorLog,
    isAutoScrollEnabled = () => true,
    onStopAnswer = () => {},
    onRegenerateAnswer = () => {}
}) {
    // Answers stream token by token. Rendering on every chunk re-parses and
    // re-lays out the whole answer each time; coalescing to one render per
    // animation frame keeps streaming smooth on long answers.
    const pendingRenders = new Map();
    let renderFrame = 0;

    function formatResponse(text) {
        return renderMarkdown(text);
    }

    function flushRenders() {
        renderFrame = 0;
        if (!chatMessagesElement) return;
        const shouldAutoScroll = isChatNearBottom(48);
        for (const [messageId, content] of pendingRenders) {
            const contentEl = chatMessagesElement.querySelector(`[data-message-id="${messageId}"] .message-content`);
            if (contentEl) contentEl.innerHTML = formatResponse(content);
        }
        pendingRenders.clear();
        if (shouldAutoScroll && isAutoScrollEnabled()) {
            chatMessagesElement.scrollTop = chatMessagesElement.scrollHeight;
        }
    }

    function scheduleRender(messageId, content) {
        pendingRenders.set(messageId, content);
        if (!renderFrame) renderFrame = requestAnimationFrame(flushRenders);
    }

    async function copyText(text, label = 'Copied') {
        try {
            await navigator.clipboard.writeText(text);
            showFeedback?.(label, 'success');
        } catch (_) {
            showFeedback?.('Could not copy', 'error');
        }
    }

    chatMessagesElement?.addEventListener('click', (event) => {
        const codeCopy = event.target?.closest?.('[data-code-copy]');
        if (codeCopy) {
            const code = codeCopy.closest('.code-block')?.querySelector('code')?.textContent || '';
            copyText(code, 'Code copied');
            return;
        }
        const action = event.target?.closest?.('[data-answer-action]');
        if (!action) return;
        const messageId = action.closest('[data-message-id]')?.dataset.messageId;
        if (action.dataset.answerAction === 'stop') onStopAnswer(messageId);
        if (action.dataset.answerAction === 'regenerate') onRegenerateAnswer(messageId);
    });

    /** Marks an answer as streaming (shows Stop) or settled (shows Regenerate where supported). */
    function setMessageStreaming(messageId, streaming, { regenerable = false } = {}) {
        const messageEl = chatMessagesElement?.querySelector(`[data-message-id="${messageId}"]`);
        if (!messageEl) return;
        if (streaming) {
            messageEl.dataset.streaming = 'true';
        } else {
            delete messageEl.dataset.streaming;
            if (pendingRenders.has(messageId)) flushRenders();
        }
        messageEl.classList.toggle('is-regenerable', !streaming && regenerable);
    }

    function isChatNearBottom(threshold = 28) {
        if (!chatMessagesElement) {
            return true;
        }

        const distanceFromBottom =
            chatMessagesElement.scrollHeight - chatMessagesElement.clientHeight - chatMessagesElement.scrollTop;
        return distanceFromBottom <= threshold;
    }

    function addChatMessage(type, content, options = {}) {
        if (!chatMessagesElement) {
            return null;
        }

        const shouldAutoScroll = isChatNearBottom();

        const timestampDate = new Date();
        const record = messageStore.add(type, content, {
            id: options.id,
            timestamp: timestampDate,
            canToggleAi: options.canToggleAi,
            includeInAi: options.includeInAi,
            screenshotId: options.screenshotId
        });

        const messageDiv = document.createElement('div');
        messageDiv.className = `chat-message ${type}-message`;
        messageDiv.dataset.messageId = record.id;
        if (record.canToggleAi) {
            messageDiv.classList.add('ai-toggleable');
            messageDiv.classList.add(record.includeInAi ? 'ai-included' : 'ai-excluded');
        }

        const timestamp = timestampDate.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit'
        });

        const meta = MESSAGE_META[type] || MESSAGE_META.system;
        const isAnswer = type === 'ai-response';
        const contentClass = isAnswer
            ? 'message-content ai-response'
            : type === 'system' ? 'message-content system-message' : 'message-content';
        const safeContent = isAnswer ? formatResponse(content) : escapeHtml(content);

        const labelHtml = meta.label ? `<span class="message-label">${meta.label}</span>` : '';
        const toggleHtml = record.canToggleAi
            ? `<button class="ai-include-toggle ${record.includeInAi ? 'included' : 'excluded'}" data-message-id="${record.id}" type="button" aria-label="${record.includeInAi ? 'Exclude from AI context' : 'Include in AI context'}" aria-pressed="${record.includeInAi ? 'true' : 'false'}">${record.includeInAi ? 'In context' : 'Excluded'}</button>`
            : '';
        const answerActionsHtml = isAnswer
            ? `<button class="message-action answer-stop" data-answer-action="stop" type="button" aria-label="Stop generating">${ICONS.stop}<span>Stop</span></button>`
              + `<button class="message-action answer-regenerate" data-answer-action="regenerate" type="button" aria-label="Regenerate answer">${ICONS.regenerate}<span>Regenerate</span></button>`
            : '';
        const copyHtml = `<button class="message-copy-btn message-action" data-message-id="${record.id}" type="button" aria-label="Copy message">${ICONS.copy}</button>`;
        const messageActionsHtml = `<span class="message-actions">${toggleHtml}${answerActionsHtml}${copyHtml}</span>`;
        const exclusionHtml = record.canToggleAi
            ? '<div class="ai-excluded-note">Excluded from AI context</div>'
            : '';

        const messageContent = `
        <div class="message-header">
            <span class="message-icon">${ICONS[meta.icon]}</span>
            ${labelHtml}
            <span class="message-time">${timestamp}</span>
            ${messageActionsHtml}
        </div>
        <div class="${contentClass}">${exclusionHtml}${safeContent}</div>
    `;

        messageDiv.innerHTML = messageContent;
        chatMessagesElement.appendChild(messageDiv);

        if (shouldAutoScroll && isAutoScrollEnabled()) {
            chatMessagesElement.scrollTop = chatMessagesElement.scrollHeight;
        }

        onMessagesChanged?.(messageStore.getMessages());
        updateUi?.();

        return record;
    }

    function updateChatComposerHeight() {
        if (!chatContainer || !chatComposer) {
            return;
        }

        // Remove the variable first so the min-height constraint is cleared,
        // allowing getBoundingClientRect to return the natural content height
        // instead of being held at the previous (potentially stale) large value.
        chatContainer.style.removeProperty('--chat-composer-height');
        const composerHeight = Math.max(0, Math.round(chatComposer.getBoundingClientRect().height));
        if (composerHeight > 0) {
            chatContainer.style.setProperty('--chat-composer-height', `${composerHeight}px`);
        }
    }

    function autoResizeManualInput() {
        if (!chatManualInput) {
            return;
        }

        chatManualInput.style.height = 'auto';
        const nextHeight = Math.min(chatManualInput.scrollHeight, maxChatInputHeight);
        chatManualInput.style.height = `${Math.max(24, nextHeight)}px`;
        chatManualInput.style.overflowY = chatManualInput.scrollHeight > maxChatInputHeight ? 'auto' : 'hidden';
        updateChatComposerHeight();
    }

    function updateManualComposerState() {
        if (!chatManualInput || !chatManualSend) {
            return;
        }

        chatManualSend.disabled = String(chatManualInput.value || '').trim().length === 0;
    }

    function updateChatMessageContent(messageId, newContent) {
        const record = messageStore.findById(messageId);
        if (record) {
            record.content = newContent;
        }

        if (!chatMessagesElement) return;
        scheduleRender(messageId, newContent);
    }

    function submitManualContextMessage() {
        if (!chatManualInput) {
            return;
        }

        const text = String(chatManualInput.value || '').trim();
        if (!text) {
            showFeedback?.('Type a message first', 'error');
            return;
        }

        addChatMessage('voice-mic', text);
        addMonitorLog?.('info', 'manual-context-added', 'Manual context message added', 'mic', {
            chars: text.length
        });
        showFeedback?.('Manual context added', 'success');

        chatManualInput.value = '';
        autoResizeManualInput();
        updateManualComposerState();
        chatManualInput.focus();
    }

    return {
        addChatMessage,
        updateChatMessageContent,
        setMessageStreaming,
        autoResizeManualInput,
        submitManualContextMessage,
        updateManualComposerState,
        isChatNearBottom
    };
}
