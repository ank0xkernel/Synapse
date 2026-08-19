export function isTranscriptMessageType(type) {
  return type === 'voice' || type === 'voice-mic' || type === 'voice-system';
}

export function isScreenshotMessageType(type) {
  return type === 'screenshot';
}

export function isSystemMessageType(type) {
  return type === 'system';
}

/**
 * conversation-tracker.js's follow-up resolution ("Why?" -> "Why? (following
 * up on: ..., specifically regarding PostgreSQL)"), delivered into chat via
 * window.__synapseAnnotateResolvedQuestion. Deliberately its own type, not
 * 'system' (which contextLineForMessage/summaryLineForMessage both render as
 * empty — that's what silently dropped it before) and not 'voice-system'
 * (it's a synthesized interpretation, not raw host speech — collapsing that
 * distinction would make every transcript consumer unable to tell them
 * apart). Recognized explicitly wherever it needs to participate, not by
 * loosening isTranscriptMessageType()'s own definition.
 */
export function isResolvedQuestionMessageType(type) {
  return type === 'resolved-question';
}

export function isAiResponseMessageType(type) {
  return type === 'ai-response';
}

/**
 * Phase 6's explicit ACTIVE CONTEXT block (current question, relation,
 * confidence, active topic, previous question/answer, relevant entities),
 * delivered via window.__synapseAnnotateActiveContext. Deliberately NOT
 * handled in contextLineForMessage/summaryLineForMessage below — it must
 * never render as a "Host:"/"You:" transcript line (it isn't conversational
 * text, and only the single most recent one is ever relevant, unlike
 * transcript lines which accumulate). context-bundle.js reads its content
 * directly via this predicate instead.
 */
export function isActiveContextMessageType(type) {
  return type === 'active-context';
}

export function canToggleAiForMessageType(type) {
  return isTranscriptMessageType(type) || isScreenshotMessageType(type) || isAiResponseMessageType(type);
}

export function defaultIncludeInAiForMessageType(type) {
  if (isSystemMessageType(type)) {
    return false;
  }
  return true;
}

export function contextLineForMessage(message) {
  const content = String(message?.content || '').trim();
  if (!content) return '';

  // Same "Host:" prefix as raw host speech, deliberately: it IS what the
  // host is asking, just resolved against context a bare fragment couldn't
  // carry on its own. getLatestHostQuery() (prompts.js) scans for the last
  // "Host:" line with no special-casing needed, as long as this line is
  // committed after the raw one it resolves — see auto-answer.js's
  // processNextQuestion(), which now fires this after the flush rather than
  // at resolution time, specifically so the ordering holds.
  if (message.type === 'resolved-question') return `Host: ${content}`;
  if (message.type === 'voice-system') return `Host: ${content}`;
  if (message.type === 'voice' || message.type === 'voice-mic') return `You: ${content}`;
  if (message.type === 'screenshot') {
    return message.screenshotId
      ? `Screenshot(${message.screenshotId}): ${content}`
      : `Screenshot: ${content}`;
  }
  if (message.type === 'ai-response') return `AI: ${content}`;
  return '';
}

export function summaryLineForMessage(message) {
  const content = String(message?.content || '').trim().replace(/\s+/g, ' ');
  if (!content) return '';

  if (message.type === 'resolved-question') return `Host said: ${content}`;
  if (message.type === 'voice-system') return `Host said: ${content}`;
  if (message.type === 'voice' || message.type === 'voice-mic') return `You said: ${content}`;
  if (message.type === 'screenshot') return `Screenshot: ${content}`;
  if (message.type === 'ai-response') return `AI response: ${content}`;
  return '';
}
