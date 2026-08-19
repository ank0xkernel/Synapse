import {
  contextLineForMessage,
  isActiveContextMessageType,
  isResolvedQuestionMessageType,
  isScreenshotMessageType,
  isSystemMessageType,
  isTranscriptMessageType,
  summaryLineForMessage
} from './message-types.js';

/**
 * Phase 6: pulls relation/confidence back out of the ACTIVE CONTEXT block's
 * own "Label: value" lines rather than threading them as separate fields all
 * the way from auto-answer.js's queue item through the chat message store
 * (which only carries a plain content string, not arbitrary metadata) — the
 * format is produced by conversation-tracker.js's formatActiveContextBlock,
 * so this is parsing our own well-defined output, not free text.
 */
function extractActiveContextField(activeContextText, label) {
  if (!activeContextText) return null;
  const match = activeContextText.match(new RegExp(`^${label}: (.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

export function buildFilteredAiContextBundle({
  messages,
  isMessageIncludedForAi,
  charBudget,
  emitTruncationLog = true,
  onTruncationLog
}) {
  const candidates = messages
    .filter(isMessageIncludedForAi)
    .map((message) => ({
      message,
      contextLine: contextLineForMessage(message),
      summaryLine: summaryLineForMessage(message)
    }))
    .filter((entry) => entry.contextLine.length > 0);

  const selectedReversed = [];
  let currentChars = 0;
  let dropped = 0;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const entry = candidates[index];
    const nextCost = entry.contextLine.length + 1;

    if (currentChars + nextCost > charBudget) {
      dropped += 1;
      continue;
    }

    selectedReversed.push(entry);
    currentChars += nextCost;
  }

  const selected = selectedReversed.reverse();

  if (emitTruncationLog && dropped > 0 && typeof onTruncationLog === 'function') {
    onTruncationLog(dropped, charBudget);
  }

  // resolved-question is deliberately not folded into isTranscriptMessageType
  // itself (see message-types.js) — added here explicitly, and only here,
  // so it reaches getLatestHostQuery() without redefining what "transcript"
  // means for every other consumer of that predicate.
  const transcriptContext = selected
    .filter((entry) => isTranscriptMessageType(entry.message.type) || isResolvedQuestionMessageType(entry.message.type))
    .map((entry) => entry.contextLine)
    .join('\n');

  const sessionSummary = selected
    .filter((entry) => !isSystemMessageType(entry.message.type))
    .map((entry) => entry.summaryLine)
    .filter((line) => line.length > 0)
    .slice(-16)
    .join('\n');

  const enabledScreenshotIds = Array.from(
    new Set(
      selected
        .filter((entry) => isScreenshotMessageType(entry.message.type))
        .map((entry) => entry.message.screenshotId)
        .filter((value) => typeof value === 'string' && value.trim().length > 0)
    )
  );

  // Read from the full incoming message list, not `candidates`/`selected` —
  // active-context messages have no contextLine by design (see
  // message-types.js), so the candidate pipeline above always filters them
  // out before this point. Only the LATEST one matters: it describes the
  // turn currently being answered, not conversation history to accumulate.
  const activeContextMessage = messages
    .filter(isMessageIncludedForAi)
    .filter((message) => isActiveContextMessageType(message.type))
    .at(-1);
  const activeContext = activeContextMessage ? String(activeContextMessage.content || '').trim() : '';
  const relation = extractActiveContextField(activeContext, 'Relation');
  const confidence = extractActiveContextField(activeContext, 'Confidence');

  return {
    contextString: selected.map((entry) => entry.contextLine).join('\n'),
    transcriptContext,
    sessionSummary,
    activeContext,
    relation,
    confidence,
    enabledScreenshotIds,
    droppedMessages: dropped,
    selectedMessages: selected.length,
    charBudget
  };
}
