'use strict';

const { STATES } = require('./mode-c-state');

const MESSAGES = Object.freeze({
  INITIAL: { code: 'INITIAL', text: 'Analysing current screen', hint: '' },
  VIEW_ANALYSED_FIRST: { code: 'VIEW_ANALYSED_FIRST', text: 'Current screen fully analysed.', hint: 'Scroll to analyse more content.' },
  NEW_CONTENT: { code: 'NEW_CONTENT', text: 'New content detected. Analysing...', hint: '' },
  NEW_ANALYSED: { code: 'NEW_ANALYSED', text: 'New content analysed.', hint: 'Scroll to continue.' },
  UNCAPTURED: { code: 'UNCAPTURED', text: "Screen movement detected, but new content hasn't been captured yet.", hint: '', action: 'retry' },
  FAILED: { code: 'FAILED', text: 'Unable to analyse new content', hint: '', action: 'retry' },
  PENDING: { code: 'PENDING', text: 'Some content is waiting to be captured again. Scroll back to it or retry.', hint: '', action: 'retry' },
  QUOTA: { code: 'QUOTA', text: 'AI quota reached. Analysis will resume automatically.', hint: '' },
  OFFLINE: { code: 'OFFLINE', text: 'Network unavailable. Analysis will resume when it returns.', hint: '' },
  PAUSED: { code: 'PAUSED', text: 'Screen monitoring paused', hint: '' },
  STOPPED: { code: 'STOPPED', text: 'Screen monitoring stopped', hint: '' },
  NEEDS_UPDATE: { code: 'NEEDS_UPDATE', text: 'Screen changed. Updating...', hint: '' },
  PERMISSION: { code: 'PERMISSION', text: 'Screen Recording permission is not available.', hint: '', action: 'open-settings' },
});

/** Picks the message for a derived state. facts come from the same derivation. */
function messageFor(state, f) {
  switch (state) {
    case STATES.STOPPED:
      return f.permissionRevoked ? MESSAGES.PERMISSION : MESSAGES.STOPPED;
    case STATES.PAUSED: return MESSAGES.PAUSED;
    case STATES.IDLE: return MESSAGES.STOPPED;
    case STATES.INITIAL_CAPTURE:
    case STATES.INITIAL_ANALYSIS: return MESSAGES.INITIAL;
    case STATES.SCROLL_DETECTED:
    case STATES.CAPTURING_NEW_CONTENT:
    case STATES.PROCESSING_NEW_CONTENT: return MESSAGES.NEW_CONTENT;
    case STATES.VIEW_FULLY_ANALYSED: return f.newContentAnalysed ? MESSAGES.NEW_ANALYSED : MESSAGES.VIEW_ANALYSED_FIRST;
    case STATES.ANALYSIS_PENDING: return f.uncapturedPlaceholders > 0 ? MESSAGES.UNCAPTURED : MESSAGES.PENDING;
    case STATES.ANALYSIS_FAILED:
      if (f.permissionRevoked) return MESSAGES.PERMISSION;
      if (f.quotaWait) return MESSAGES.QUOTA;
      if (f.retryScheduledCode === 'QUOTA_EXHAUSTED') return MESSAGES.QUOTA;
      if (f.retryScheduledCode === 'NETWORK') return MESSAGES.OFFLINE;
      return MESSAGES.FAILED;
    default: return MESSAGES.NEEDS_UPDATE;
  }
}

module.exports = { MESSAGES, messageFor };
