'use strict';

const STATES = Object.freeze({
  IDLE: 'IDLE',
  INITIAL_CAPTURE: 'INITIAL_CAPTURE',
  INITIAL_ANALYSIS: 'INITIAL_ANALYSIS',
  MONITORING: 'MONITORING',
  SCROLL_DETECTED: 'SCROLL_DETECTED',
  CAPTURING_NEW_CONTENT: 'CAPTURING_NEW_CONTENT',
  PROCESSING_NEW_CONTENT: 'PROCESSING_NEW_CONTENT',
  VIEW_FULLY_ANALYSED: 'VIEW_FULLY_ANALYSED',
  ANALYSIS_PENDING: 'ANALYSIS_PENDING',
  ANALYSIS_FAILED: 'ANALYSIS_FAILED',
  PAUSED: 'PAUSED',
  STOPPED: 'STOPPED',
});

const ACTIVE = [
  STATES.INITIAL_CAPTURE,
  STATES.INITIAL_ANALYSIS,
  STATES.MONITORING,
  STATES.SCROLL_DETECTED,
  STATES.CAPTURING_NEW_CONTENT,
  STATES.PROCESSING_NEW_CONTENT,
  STATES.VIEW_FULLY_ANALYSED,
  STATES.ANALYSIS_PENDING,
  STATES.ANALYSIS_FAILED,
  STATES.PAUSED,
];

// A session starts only through INITIAL_CAPTURE. Every active state can reach
// every other active state because the state is derived from live facts, and
// any fact change can land anywhere. STOPPED is terminal until a new start.
const TRANSITIONS = Object.freeze(
  Object.fromEntries(
    [
      [STATES.IDLE, [STATES.INITIAL_CAPTURE, STATES.STOPPED]],
      [STATES.STOPPED, [STATES.INITIAL_CAPTURE, STATES.IDLE]],
      ...ACTIVE.map((state) => [state, [...ACTIVE.filter((s) => s !== state), STATES.STOPPED]]),
    ].map(([from, to]) => [from, Object.freeze(to)]),
  ),
);

function createStateMachine({ onChange, initial = STATES.IDLE, now = Date.now } = {}) {
  let state = initial;
  const rejected = [];

  function can(next) {
    return Boolean(TRANSITIONS[state] && TRANSITIONS[state].includes(next));
  }

  function transition(next, reason = '') {
    if (next === state) return true;
    if (!can(next)) {
      rejected.push({ from: state, to: next, reason, at: now() });
      if (rejected.length > 50) rejected.shift();
      return false;
    }
    const from = state;
    state = next;
    if (typeof onChange === 'function') onChange({ from, to: next, reason });
    return true;
  }

  return {
    get state() { return state; },
    can,
    transition,
    rejected: () => rejected.slice(),
  };
}

/** The only place the state is decided. Pure function of live facts. */
function deriveState(f) {
  if (!f.started) return STATES.IDLE;
  if (f.stopped) return STATES.STOPPED;
  if (f.paused) return STATES.PAUSED;
  if (f.engineError || f.quotaWait) return STATES.ANALYSIS_FAILED;
  if (!f.frameCaptured) return STATES.INITIAL_CAPTURE;
  if (f.busy) return f.initialSettled ? STATES.PROCESSING_NEW_CONTENT : STATES.INITIAL_ANALYSIS;
  if (f.capturing) return STATES.CAPTURING_NEW_CONTENT;
  if (f.motion) return STATES.SCROLL_DETECTED;
  if (f.failed > 0) return STATES.ANALYSIS_FAILED;
  if (f.pending > 0) return STATES.ANALYSIS_PENDING;
  if (f.viewAnalysed) return STATES.VIEW_FULLY_ANALYSED;
  return f.initialSettled ? STATES.MONITORING : STATES.INITIAL_ANALYSIS;
}

module.exports = { STATES, TRANSITIONS, createStateMachine, deriveState };
