/*
 * Auto-answer.
 *
 * Transcription already ran continuously, but nothing ever acted on it: a
 * final transcript was buffered into the chat and there it stopped, so every
 * answer needed a keypress. In a live call that is the one moment you cannot
 * spare a hand — which is what made the assistant feel like it was not
 * listening at all.
 *
 * This watches the HOST channel (the other person on the call, captured from
 * system audio) and asks for an answer on its own once they finish a question.
 *
 * Deliberately scoped to the host channel: triggering on your own microphone
 * would fire while you are mid-answer and talk over you.
 */

import { createQuestionDetector } from './question-detector.js';
import { createConversationTracker, isBareFollowUp, formatActiveContextBlock } from './conversation-tracker.js';

const STORAGE_KEY = 'synapse_auto_answer';

/*
 * Endpointing — deciding the speaker has actually finished.
 *
 * This was a flat 1400ms wait after every final transcript, which is the worst
 * of both worlds: a plainly finished question ("...how would you scale it?")
 * still sat for 1.4s before generation even started, while someone genuinely
 * trailing off mid-thought got cut off at exactly the same 1.4s.
 *
 * A person doesn't wait a fixed beat. They answer almost immediately after an
 * unmistakable question, and they hold when the speaker is clearly still
 * assembling a sentence. The wait is now chosen from how the utterance ends,
 * which is the same cue a listener uses.
 *
 * Net effect on the case that matters: a question ending in "?" now begins
 * generating ~1.1s sooner than before.
 */
// Retuned for latency. AssemblyAI's own endpointing already waits for silence
// before it emits end_of_turn, so this timer is a *second* wait stacked on top
// of that one — the original values were paying for the same silence twice.
const SETTLE_FINISHED_MS = 120;   // ends in "?" — they are done, go now
const SETTLE_NORMAL_MS   = 450;   // complete-looking clause, no question mark
const SETTLE_TRAILING_MS = 1100;  // ends mid-thought — they are still talking

/*
 * Words that almost never end a spoken sentence. If the transcript stops here,
 * STT caught a breath or a pause, not the end of the question — so hold longer
 * and let the next fragment arrive and be appended.
 */
const TRAILING_TOKEN = /(?:^|\s)(and|or|but|so|because|since|that|which|who|if|when|while|like|as|than|then|um|uh|erm|hmm|well|okay|the|a|an|to|of|for|with|about|into|onto|on|in|at|by|from|is|are|was|were|be|been|do|does|did|have|has|had|can|could|would|should|will|you know|i mean|sort of|kind of|let me|maybe|you|i|we|they|he|she|it|my|your|our|their|his|her|its)$/i;

/**
 * Chooses how long to wait before treating `text` as a finished utterance.
 * Shorter when the ending is conclusive, longer when it is obviously mid-clause.
 */
function computeSettleMs(text) {
    const trimmed = String(text || '').trim();

    // A question mark is the strongest end-of-turn signal STT gives us.
    if (/[?]$/.test(trimmed)) {
        return SETTLE_FINISHED_MS;
    }

    /*
     * Dangling conjunction/article/pronoun/filler: mid-sentence, not finished.
     *
     * Trailing commas, dashes and ellipses are stripped first — STT emits
     * "Let's talk about caching. So," and the comma would otherwise hide the
     * "so" that is the actual signal.
     */
    if (TRAILING_TOKEN.test(trimmed.replace(/[\s,;:\-–—.]+$/, ''))) {
        return SETTLE_TRAILING_MS;
    }

    return SETTLE_NORMAL_MS;
}

// Below this, a "question" is almost always a backchannel ("mm-hm", "right").
const MIN_QUESTION_CHARS = 12;

const QUESTION_OPENERS = /^(what|why|how|when|where|which|who|whom|whose|can|could|would|should|do|does|did|is|are|was|were|have|has|had|will|tell me|walk me|explain|describe|give me|talk me|suppose|imagine|let's say|lets say)\b/i;

// Phrases that are a question in substance without a question mark.
const QUESTION_PHRASES = /\b(tell me about|walk me through|how would you|what would you|can you explain|describe a time|give me an example|your thoughts on|how do you)\b/i;

/** True when the line reads like something the user is expected to answer. */
function looksLikeQuestion(text) {
    const trimmed = String(text || '').trim();

    if (trimmed.length < MIN_QUESTION_CHARS) {
        return false;
    }

    if (trimmed.endsWith('?')) {
        return true;
    }

    return QUESTION_OPENERS.test(trimmed) || QUESTION_PHRASES.test(trimmed);
}

function initAutoAnswer() {
    const askBtn = document.getElementById('analyze-btn');
    const toggle = document.getElementById('auto-answer-toggle');

    if (!askBtn || !window.electronAPI?.onVoskFinal) {
        return;
    }

    let enabled = true;
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored !== null) enabled = stored === '1';
    } catch (_) { /* default on */ }

    let settleTimer = null;
    let pending = '';
    let busyWatcher = null;

    // Resolves bare follow-ups ("Why?") against what was actually just being
    // discussed, and gives user speech a place to go that isn't /dev/null —
    // it's never answered, but it's the richest source of "what are we
    // actually talking about" this app has.
    const conversationTracker = createConversationTracker();

    // { id, text } entries — the id exists purely for latency instrumentation
    // (correlating [QUESTION]/[AI] log lines end to end per question), not for
    // any dispatch logic. Never mutated once created.
    const questionQueue = [];
    let questionSeq = 0;
    function nextQuestionId() {
        questionSeq += 1;
        return `q_${Date.now()}_${questionSeq}`;
    }

    function publishQueue() {
        window.electronAPI?.reportQuestionQueue?.({
            pending: questionQueue.length,
            questions: questionQueue.map((entry) => entry.text)
        });
    }

    /*
     * `assistant:final-question` -> AiOrchestrator.processQuestion() calls
     * ollamaService.streamResponse() UNCONDITIONALLY — it has no provider
     * check at all. On this Gemini-configured install that hits Ollama's
     * default model (codeqwen:7b-chat-v1.5-q4_K_M), which is not the
     * installed model (qwen2.5-coder:7b) and returns HTTP 404 on every
     * single question. Verified directly against the running Ollama
     * instance.
     *
     * The button click drives askAiWithSessionContext(), the path that has
     * actually been proven working against Gemini all along — same
     * transcript context, same streaming, same phone delivery. Route
     * through it until AiOrchestrator is made provider-aware; do not
     * resurrect the Ollama-only path.
     *
     * askBtn.click() is fire-and-forget — it does not return a promise tied
     * to generation finishing. askBtn.disabled is the one signal that is
     * synchronously true for the whole request (set inside
     * runAiActionWithLock before its first await), so busy-tracking watches
     * that attribute rather than guessing with a timer.
     */
    function processNextQuestion() {
        if (askBtn.disabled || questionQueue.length === 0) return;

        const question = questionQueue.shift();
        publishQueue();

        /*
         * Root cause of "answers the previous question instead of this one":
         * askAiWithSessionContext() builds its Gemini prompt from
         * chatMessagesArray, which this host question only enters once
         * transcriptBufferManager (renderer.js) flushes it via addChatMessage.
         * That buffer merges fragmented AssemblyAI finals for up to
         * mergeWindowMs before flushing — seconds longer than the settle
         * timer above that decides *this* click should happen right now. The
         * click was firing while the question that triggered it was still
         * sitting unflushed, so Gemini answered whatever was already in chat
         * — i.e. the previous turn — and the real question only surfaced in
         * chat later, in time to be misattributed to the *next* click.
         * Forcing a synchronous flush immediately before the click closes
         * that race: by the time askAiWithSessionContext() reads chat, this
         * question is provably already in it.
         */
        window.__synapseFlushHostTranscript?.('system');

        // Must come after the flush above: this is what makes the resolved
        // framing ("Why?" -> "...specifically regarding PostgreSQL") the
        // most recent "Host:" line in chat rather than the raw fragment it
        // resolves, which the flush just committed. See the queue-push
        // comment in the settle-timer handler above for why this can't just
        // happen at resolution time instead.
        if (question.resolvedAnnotation) {
            window.__synapseAnnotateResolvedQuestion?.(question.resolvedAnnotation);
        }

        // Phase 6: same deferred-timing reasoning as the resolved annotation
        // above — fired after the flush so it's not superseded by anything,
        // though ordering matters less here since it's carried as its own
        // dedicated message type (see context-bundle.js), not scanned by
        // position the way "last Host: line" is.
        if (question.activeContext) {
            window.__synapseAnnotateActiveContext?.(question.activeContext);
        }

        // Tags the click for renderer.js's askAiWithSessionContext(), which
        // has no other way to know which QuestionEvent it is servicing — the
        // click itself carries no payload. Read once at that call's entry.
        window.__synapseActiveQuestionId = question.id;

        console.log(`[QUESTION] dispatch id=${question.id} t=${Date.now()} queue=${questionQueue.length} text="${question.text.slice(0, 80)}"`);
        console.log(`[AutoAnswer] Answering via Gemini (Ask AI): "${question.text.slice(0, 80)}"`);
        askBtn.click();

        if (askBtn.disabled) {
            waitForIdleThenDrain();
        } else {
            // Nothing actually started (e.g. no transcript yet) — try the rest
            // of the queue without waiting on a disabled-state change that
            // will never come.
            processNextQuestion();
        }
    }

    function waitForIdleThenDrain() {
        if (busyWatcher) return;

        busyWatcher = new MutationObserver(() => {
            if (askBtn.disabled) return;
            busyWatcher.disconnect();
            busyWatcher = null;
            processNextQuestion();
        });

        busyWatcher.observe(askBtn, { attributes: true, attributeFilter: ['disabled'] });
    }

    function syncToggle() {
        if (!toggle) return;
        toggle.setAttribute('aria-pressed', String(enabled));
        toggle.classList.toggle('active', enabled);
        toggle.title = enabled
            ? 'Auto-answer is ON — answers the interviewer automatically  (⌥⇧A to ask manually)'
            : 'Auto-answer is OFF — press Ask, or ⌥⇧A';
    }

    function setEnabled(next) {
        enabled = next;
        try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch (_) { /* ignore */ }
        if (!next) {
            clearTimeout(settleTimer);
            pending = '';
        }
        syncToggle();
        console.log(`[AutoAnswer] ${next ? 'enabled' : 'disabled'}`);
    }

    if (toggle) {
        toggle.addEventListener('click', () => setEnabled(!enabled));
    }
    syncToggle();

    /*
     * Remote toggle from the mobile companion.
     *
     * The state is owned here (localStorage + the module-scoped `enabled`), so
     * the phone cannot flip it with a plain HTTP write — the command travels
     * mobile → server → main → this listener, and the same setEnabled() path
     * runs as if the on-screen button had been pressed. That keeps the button,
     * the stored preference and the phone from drifting apart.
     */
    window.electronAPI?.onSetAutoAnswer?.((data) => {
        const next = !!data?.enabled;
        if (next === enabled) return;
        console.log(`[AutoAnswer] Remote toggle from mobile companion: ${next ? 'on' : 'off'}`);
        setEnabled(next);
    });

    /*
     * Real-time question detection over partials (spec §14-16).
     *
     * The settle timer above only ever evaluates a *final* transcript, so all
     * question judgment happens after AssemblyAI's own endpointer has already
     * closed the turn. This lets an unambiguous question fire the moment its
     * words exist, without waiting for that closure.
     *
     * Deliberately narrow: it only acts at the detector's ceiling score
     * (0.95+, i.e. STT already believes the utterance ended in '?'). Per
     * §19, a false trigger mid-sentence is worse than the ~100-200ms this
     * saves, so anything less ambiguous is left to the final-transcript path.
     */
    const questionDetector = createQuestionDetector();
    let earlyTimer = null;
    let earlyFiredText = '';
    let lastPartialText = '';

    if (window.electronAPI?.onVoskPartial) {
        window.electronAPI.onVoskPartial((data) => {
            if (!enabled) return;
            const source = data?.source === 'system' ? 'system' : 'mic';
            if (source !== 'system') return;

            const text = String(data?.text || '').trim();
            if (!text || text === earlyFiredText) return;

            lastPartialText = text;
            const { score } = questionDetector.update(text);
            if (score < 0.95) return;

            clearTimeout(earlyTimer);
            earlyTimer = setTimeout(() => {
                // A newer partial superseded this one while the timer was
                // pending — that partial's own check governs instead.
                if (text !== lastPartialText || !looksLikeQuestion(text)) return;

                earlyFiredText = text;
                pending = '';
                clearTimeout(settleTimer);

                // This fires off a *partial* — AssemblyAI has not closed the
                // turn yet, so transcriptBufferManager has no final to flush
                // (the __synapseFlushHostTranscript bridge in
                // processNextQuestion() below would be a no-op here). Commit
                // the detected text directly and clear that buffer so the
                // real final, arriving moments later for this same
                // utterance, does not flush a second, duplicate chat line.
                window.__synapseCommitEarlyHostTranscript?.(text);

                // Phase 3: this path previously never called resolveQuestion
                // at all, which meant a fast, unambiguous follow-up — the
                // exact shape most likely to score high enough to early-fire
                // in the first place, e.g. "What about MongoDB?" — bypassed
                // context resolution entirely and reached Gemini bare. Same
                // resolve-then-defer-the-annotation pattern as the
                // final-settle path below: the raw commit above already
                // happened, so carrying resolvedAnnotation on the queue item
                // and firing it from processNextQuestion() (after any flush,
                // before the click) keeps the same correct ordering.
                const questionResult = conversationTracker.resolveQuestion(text);
                const { resolved, wasResolved, relation, confidence } = questionResult;
                if (wasResolved) {
                    console.log(`[AutoAnswer] Resolved follow-up (early-fire) "${text}" -> "${resolved}" [${relation}/${confidence}]`);
                }

                const questionId = nextQuestionId();
                console.log(`[QUESTION] detected id=${questionId} t=${Date.now()} queue=${questionQueue.length} source=partial score=${score.toFixed(2)} text="${text.slice(0, 80)}"`);
                // Phase 6: the active-context block is built regardless of
                // wasResolved — even a plain NEW_TOPIC turn has a relation/
                // confidence worth telling the model about explicitly, not
                // just resolved follow-ups.
                questionQueue.push({
                    id: questionId,
                    text,
                    resolvedAnnotation: wasResolved ? resolved : null,
                    activeContext: formatActiveContextBlock(questionResult)
                });
                publishQueue();
                console.log(`[AutoAnswer] Early-fired from partial (score ${score.toFixed(2)}): "${text.slice(0, 80)}"`);

                if (askBtn.disabled) {
                    waitForIdleThenDrain();
                } else {
                    processNextQuestion();
                }
            }, SETTLE_FINISHED_MS);
        });
    }

    window.electronAPI.onVoskFinal((data) => {
        if (!enabled) return;

        // 'system' is the host/other-party channel; 'mic' is the user.
        const source = data?.source === 'system' ? 'system' : 'mic';
        const text = String(data?.text || '').trim();
        if (!text) return;

        /*
         * Speaker separation invariant: this app must never auto-answer the
         * user's own voice. That's already true here (mic hits this branch
         * and never reaches the queueing code below) — but user speech is
         * discarded entirely today, which throws away the richest source of
         * "what are we actually talking about" in the whole pipeline. Record
         * it as context only. It is never eligible to trigger an answer.
         */
        if (source !== 'system') {
            conversationTracker.recordUserTurn(text);
            return;
        }

        console.log(`[VOICE] host-final t=${Date.now()} text="${text.slice(0, 80)}"`);

        // Already answered from the partial stream — the final confirming the
        // same utterance must not queue a duplicate.
        if (text === earlyFiredText) {
            earlyFiredText = '';
            return;
        }
        questionDetector.reset();

        // Accumulate fragments so a question split across pauses is judged whole.
        pending = pending ? `${pending} ${text}` : text;

        // Re-derived on every fragment: a turn that looked unfinished a moment
        // ago ("so tell me about a time") becomes a fast fire as soon as the
        // fragment completing it arrives ("...you debugged something hard?").
        const settleMs = computeSettleMs(pending);

        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
            const question = pending.trim();
            pending = '';

            // A bare follow-up ("Why?", "How so?") is legitimate content this
            // app must answer, but it will always fail looksLikeQuestion()'s
            // own noise floor (MIN_QUESTION_CHARS=12) — that floor exists for
            // backchannel ("mm-hm", "right"), not for short questions with
            // real content, so it needs this explicit carve-out.
            if (!looksLikeQuestion(question) && !isBareFollowUp(question)) {
                // Not response-worthy, but the host still said something —
                // "let's talk about your backend architecture" sets a topic
                // without ever containing a question mark. Keep it as context
                // rather than dropping it silently.
                conversationTracker.recordHostContext(question);
                return;
            }

            // Resolve bare follow-ups ("Why?", "What about that?") against
            // what was actually just discussed before this ever reaches
            // Gemini — sent unresolved, a fragment like that only prompts a
            // generic, contextless answer.
            const questionResult = conversationTracker.resolveQuestion(question);
            const { resolved, wasResolved, topic, relation, confidence } = questionResult;
            console.log(`[QUESTION] relation=${relation} confidence=${confidence}${topic ? ` topic=${topic}` : ''} raw="${question.slice(0, 60)}"`);
            if (wasResolved) {
                console.log(`[AutoAnswer] Resolved follow-up "${question}" -> "${resolved}"${topic ? ` (topic: ${topic})` : ''}`);
            }

            /*
             * Strict FIFO Queue
             * Ensure no questions are discarded and they are processed in order.
             */
            const questionId = nextQuestionId();
            console.log(`[QUESTION] detected id=${questionId} t=${Date.now()} queue=${questionQueue.length} source=final settleMs=${settleMs} text="${resolved.slice(0, 80)}"`);
            // Carried on the queue item rather than annotated immediately:
            // the raw utterance isn't actually committed to chat until
            // processNextQuestion() flushes it at dispatch time (below), which
            // can be seconds from now if the queue is backed up. Annotating
            // here would land the resolved line BEFORE the raw one it
            // resolves — still technically present, but no longer the most
            // recent "Host:" line, so getLatestHostQuery() would pick the
            // raw fragment right back up. Deferring this to fire right after
            // the flush is what actually fixes the ordering.
            questionQueue.push({
                id: questionId,
                text: resolved,
                resolvedAnnotation: wasResolved ? resolved : null,
                activeContext: formatActiveContextBlock(questionResult)
            });
            publishQueue();

            if (askBtn.disabled) {
                console.log(`[AutoAnswer] Busy — queued question (${questionQueue.length} pending): "${resolved.slice(0, 60)}"`);
                waitForIdleThenDrain();
            } else {
                console.log(`[AutoAnswer] Host asked: "${resolved.slice(0, 80)}" — answering (waited ${settleMs}ms).`);
                processNextQuestion();
            }
        }, settleMs);
    });

    /*
     * Feed generated answers back into the tracker. Without this, only the
     * FIRST follow-up in a chain would ever resolve — "Why?" resolves against
     * lastHostQuestion fine on its own, but a second "And why not X?" needs
     * to know what was actually just answered, not just what was asked.
     * actionId is filtered to 'askAi' — the same channel every path in this
     * file ultimately drives, whether fired by a click or by the queue.
     */
    let pendingAnswerText = '';
    window.electronAPI?.onAiStreamStart?.((data) => {
        if (data?.actionId !== 'askAi') return;
        pendingAnswerText = '';
    });
    window.electronAPI?.onAiStreamChunk?.((data) => {
        if (data?.actionId !== 'askAi') return;
        pendingAnswerText += String(data?.text || '');
    });
    window.electronAPI?.onAiStreamEnd?.((data) => {
        if (data?.actionId !== 'askAi') return;
        if (pendingAnswerText.trim()) {
            conversationTracker.recordAnswer(pendingAnswerText.trim());
        }
        pendingAnswerText = '';
    });

    console.log('[AutoAnswer] Listening to the host channel.');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAutoAnswer);
} else {
    initAutoAnswer();
}

export { looksLikeQuestion };
