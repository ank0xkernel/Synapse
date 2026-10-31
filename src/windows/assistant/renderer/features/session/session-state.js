/**
 * The one status shown in the title bar. Derived only from real state:
 * transcription source statuses, the Ask AI request lifecycle and errors.
 *
 * Priority: error > answering > thinking > reconnecting > listening >
 * connecting > ready. "Thinking" is the gap between sending a question and
 * the first streamed token; "answering" lasts until the stream ends.
 */

export const SessionState = Object.freeze({
  READY: 'ready',
  CONNECTING: 'connecting',
  LISTENING: 'listening',
  RECONNECTING: 'reconnecting',
  THINKING: 'thinking',
  ANSWERING: 'answering',
  ERROR: 'error'
});

const LABELS = {
  ready: 'Ready',
  connecting: 'Connecting',
  listening: 'Listening',
  reconnecting: 'Reconnecting',
  thinking: 'Thinking',
  answering: 'Answering',
  error: 'Needs attention'
};

/**
 * @param {object} input
 * @param {{system: string, mic: string}} input.sources  'off' | 'connecting' | 'listening' | 'error'
 * @param {boolean} input.aiPending      Ask AI request in flight
 * @param {boolean} input.aiStreaming    first token received, stream not ended
 * @param {string|null} input.error      latest unresolved error message
 * @param {boolean} input.wasListening   a source was listening earlier this session
 */
export function deriveSessionState({ sources = {}, aiPending = false, aiStreaming = false, error = null, wasListening = false } = {}) {
  const statuses = [sources.system, sources.mic];
  let state = SessionState.READY;

  if (error || statuses.includes('error')) state = SessionState.ERROR;
  else if (aiStreaming) state = SessionState.ANSWERING;
  else if (aiPending) state = SessionState.THINKING;
  else if (statuses.includes('connecting')) state = wasListening ? SessionState.RECONNECTING : SessionState.CONNECTING;
  else if (statuses.includes('listening')) state = SessionState.LISTENING;

  return { state, label: LABELS[state] };
}

/** Writes the state to the title-bar chip. */
export function applySessionState(element, labelElement, { state, label }, detail = '') {
  if (!element) return;
  if (element.dataset.state !== state) element.dataset.state = state;
  if (labelElement && labelElement.textContent !== label) labelElement.textContent = label;
  element.title = detail ? `${label}: ${detail}` : label;
}
