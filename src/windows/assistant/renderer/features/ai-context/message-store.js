import {
  canToggleAiForMessageType,
  defaultIncludeInAiForMessageType,
  isSystemMessageType
} from './message-types.js';

// Answers and screenshots describe one problem on screen. They carry its id
// so that answers about an earlier problem can leave the AI context once the
// screen moves on (see excludeOtherProblems).
const PROBLEM_SCOPED_TYPES = new Set(['ai-response', 'screenshot']);

export function createMessageStore({ getActiveProblemId = () => null } = {}) {
  let messages = [];
  let sequence = 0;

  // UUIDs: the same id is used in the saved conversation history and on the website.
  function nextId() {
    sequence += 1;
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function createRecord(type, content, options = {}) {
    return {
      id: options.id || nextId(),
      type,
      content,
      timestamp: options.timestamp || new Date(),
      canToggleAi: typeof options.canToggleAi === 'boolean'
        ? options.canToggleAi
        : canToggleAiForMessageType(type),
      includeInAi: typeof options.includeInAi === 'boolean'
        ? options.includeInAi
        : defaultIncludeInAiForMessageType(type),
      screenshotId: typeof options.screenshotId === 'string' ? options.screenshotId : null,
      problemId: typeof options.problemId === 'string'
        ? options.problemId
        : (PROBLEM_SCOPED_TYPES.has(type) ? getActiveProblemId() || null : null)
    };
  }

  /**
   * The screen now shows `problemId`. Problem-scoped messages stamped with a
   * different problem are switched to "Excluded"; the user can toggle any of
   * them back. Messages of `problemId` that were excluded this way (not by the
   * user) come back when the screen returns to that problem. Returns the
   * messages that were excluded; `restored` lists the ones brought back.
   */
  function excludeOtherProblems(problemId) {
    if (!problemId) return Object.assign([], { restored: [] });
    const changed = messages.filter((m) => m.problemId && m.problemId !== problemId && m.canToggleAi && m.includeInAi);
    for (const m of changed) { m.includeInAi = false; m.autoExcluded = true; }
    const restored = messages.filter((m) => m.problemId === problemId && m.autoExcluded && !m.includeInAi);
    for (const m of restored) { m.includeInAi = true; m.autoExcluded = false; }
    return Object.assign(changed, { restored });
  }

  function add(type, content, options = {}) {
    const record = createRecord(type, content, options);
    messages.push(record);
    return record;
  }

  function clear() {
    messages = [];
    sequence = 0;
  }

  function findById(messageId) {
    return messages.find((message) => message.id === messageId);
  }

  function getMessages() {
    return messages.slice();
  }

  function toggleInclusion(messageId) {
    const message = findById(messageId);
    if (!message || !message.canToggleAi) {
      return null;
    }

    message.includeInAi = !message.includeInAi;
    message.autoExcluded = false;
    return message;
  }

  function isIncludedForAi(message) {
    if (!message || isSystemMessageType(message.type)) {
      return false;
    }

    if (message.canToggleAi) {
      return !!message.includeInAi;
    }

    return message.includeInAi !== false;
  }

  /**
   * Records which problem a finished answer was about. An answer that a switch
   * excluded automatically while it streamed comes back if it turns out to be
   * about the problem on screen now. Returns true when inclusion changed.
   */
  function assignProblem(messageId, problemId, currentProblemId) {
    const message = findById(messageId);
    if (!message || !problemId) return false;
    message.problemId = problemId;
    if (message.autoExcluded && problemId === currentProblemId && !message.includeInAi) {
      message.includeInAi = true;
      message.autoExcluded = false;
      return true;
    }
    return false;
  }

  /**
   * New Problem: nothing said or shown before it goes to the AI again, with
   * or without a problem stamp, until the user toggles a message back. These
   * exclusions are not auto-excluded ones, so no later problem identification
   * or late answer brings them back. Returns the messages excluded.
   */
  function startNewProblem() {
    const changed = messages.filter((m) => !isSystemMessageType(m.type) && isIncludedForAi(m));
    for (const m of changed) {
      m.includeInAi = false;
      m.autoExcluded = false;
      m.newProblemExcluded = true;
      m.canToggleAi = true;
    }
    return changed;
  }

  return {
    add,
    assignProblem,
    clear,
    excludeOtherProblems,
    startNewProblem,
    findById,
    getMessages,
    isIncludedForAi,
    toggleInclusion
  };
}
