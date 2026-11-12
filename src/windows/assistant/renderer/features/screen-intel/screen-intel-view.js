// Pure view-model for the screen intelligence bar: turns a session snapshot
// and the current time into the words and coverage tracks the bar shows. No
// DOM access, so it runs under Node for tests. Every value comes from the
// snapshot; nothing here estimates progress.

export const STATUS_LABELS = {
  analysed: 'Analysed',
  analysing: 'Analysing',
  captured: 'Captured, awaiting analysis',
  new: 'Newly detected',
  pending: 'Needs recapture',
  failed: 'Failed',
  inaccessible: 'Inaccessible',
  stale: 'Changed, needs update',
  uncovered: 'Not yet explored',
  gap: 'Not yet explored (scrolled past too quickly)'
};

const MONITORING_LABELS = { active: 'Active', paused: 'Paused', stopped: 'Stopped' };
const VIEW_LABELS = { analysing: 'Analysing', analysed: 'Fully analysed', needs_update: 'Needs update', unknown: 'Not analysed yet' };
const ANALYSED_CODES = new Set(['VIEW_ANALYSED_FIRST', 'NEW_ANALYSED']);
const TONES = {
  FAILED: 'danger', PERMISSION: 'danger', UNCAPTURED: 'warning', PENDING: 'warning', QUOTA: 'warning', OFFLINE: 'warning',
  NEEDS_UPDATE: 'busy', NEW_CONTENT: 'busy', INITIAL: 'busy', VIEW_ANALYSED_FIRST: 'positive', NEW_ANALYSED: 'positive'
};

export function formatAge(ms) {
  if (ms < 5000) return 'just now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

export function formatClock(timestamp) {
  if (!timestamp) return 'Not yet';
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined) return 'Not yet';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** The time fragment that changes every tick; kept separate so the timer rewrites one text node. */
export function describeTime(snapshot, now) {
  if (!snapshot || snapshot.monitoring === 'stopped') return '';
  if (snapshot.analysingSince) return `${(Math.max(0, now - snapshot.analysingSince) / 1000).toFixed(1)}s`;
  if (snapshot.lastAnalysisAt && ANALYSED_CODES.has(snapshot.message?.code)) {
    const age = formatAge(now - snapshot.lastAnalysisAt);
    return age === 'just now' ? age : `Last analysed ${age}`;
  }
  if (snapshot.lastAnalysisAt) return `Last analysed ${formatAge(now - snapshot.lastAnalysisAt)}`;
  return '';
}

/** Tick period the time fragment needs: tenths while analysing, seconds otherwise, none when idle. */
export function tickInterval(snapshot) {
  if (!snapshot || !snapshot.sessionId || snapshot.monitoring === 'stopped') return 0;
  return snapshot.analysingSince ? 100 : 1000;
}

export function describeStatus(snapshot) {
  if (!snapshot || !snapshot.sessionId) return { visible: false };
  const message = snapshot.message || {};
  const counts = snapshot.counts || {};
  return {
    visible: true,
    tone: TONES[message.code] || (snapshot.monitoring === 'active' ? 'neutral' : 'muted'),
    primary: message.text || '',
    hint: message.hint || '',
    canRetry: message.action === 'retry' || counts.failed > 0 || counts.pending > 0,
    monitoring: MONITORING_LABELS[snapshot.monitoring] || snapshot.monitoring,
    view: VIEW_LABELS[snapshot.view] || snapshot.view,
    chips: [
      ['new', counts.new, 'new'],
      ['pending', counts.pending, 'pending'],
      ['failed', counts.failed, 'failed'],
      ['inaccessible', counts.inaccessible, 'inaccessible'],
      ['gap', counts.gaps, counts.gaps === 1 ? 'gap' : 'gaps']
    ].filter(([, count]) => count > 0).map(([status, count, word]) => ({ status, text: `${count} ${word}` })),
    error: snapshot.error ? snapshot.error.message : ''
  };
}

/** The active-problem line: only what the session actually decided. */
export function describeProblem(problem) {
  if (!problem) return 'Not monitoring';
  if (problem.status === 'detecting') return 'Reading the new screen…';
  if (problem.status === 'undetermined') return 'Not enough instructions on screen to tell';
  const title = problem.title ? `“${problem.title}”` : problem.origin === 'explicit' ? 'New problem' : problem.id;
  return problem.changedAt ? `${title} · since ${formatClock(problem.changedAt)}` : title;
}

/** Name of a problem in lists: its heading, or what kind of problem it is. */
export function problemLabel(problem) {
  if (problem?.title) return problem.title;
  return problem?.origin === 'explicit' ? 'New problem' : 'Untitled problem';
}

/**
 * The prompt for a heading that may start a different problem. Its text is
 * held out of the answer context until the user decides (or the screen does).
 */
export function describeCandidate(problem) {
  const candidate = problem?.candidate;
  if (!candidate) return null;
  const title = candidate.title ? `“${candidate.title}”` : 'this heading';
  return {
    id: candidate.id,
    text: candidate.status === 'possible'
      ? `${title} may be a different problem. It is not used in answers until you choose.`
      : `Checking whether ${title} starts a different problem. Its text is held back for now.`
  };
}

/** Rows of the Problems list: newest activity first, the active one marked, others switchable. */
export function describeProblems(problems) {
  return (problems || []).map((p) => ({
    id: p.id,
    label: problemLabel(p),
    meta: [p.active ? 'Active' : null, p.origin === 'explicit' ? 'Started by you' : 'Detected', `last active ${formatClock(p.lastActiveAt)}`].filter(Boolean).join(' · '),
    active: Boolean(p.active),
    canSwitch: !p.active
  }));
}

/** What the bar says after New Problem (or a switch). Null when nothing needs saying. */
export function describeProblemResult(result, action = 'new') {
  if (!result || result.code === 'BUSY') return null;
  if (result.error && !result.code) return { tone: 'danger', text: result.error };
  if (!result.success) return { tone: 'warning', text: result.code === 'ALREADY_NEW' ? 'A new problem was just started. Scroll or switch screens to fill it.' : (result.message || 'The problem could not be changed.') };
  if (action === 'same') return { tone: 'positive', text: `Kept in ${problemLabel(result.problem)}. That text is now part of it.` };
  if (result.unchanged) return { tone: 'neutral', text: 'That problem is already active.' };
  if (result.pending === 'next-start') return { tone: 'neutral', text: 'New problem ready. It begins when monitoring starts.' };
  if (result.pending === 'next-screen') return { tone: 'neutral', text: 'New problem started. Waiting for the next screen.' };
  if (action === 'switch') return { tone: 'positive', text: `Switched to ${problemLabel(result.problem)}. Its earlier context is back.` };
  return { tone: 'positive', text: `${problemLabel(result.problem)} started. Earlier problems are kept under Details.` };
}

/**
 * One track per container. Segments are laid end to end with a gap marker
 * between them, because offsets on either side of a gap are not comparable.
 * Cell sizes are proportional to real content lengths.
 */
export function buildCoverage(snapshot) {
  return (snapshot?.containers || []).map((container) => {
    const parts = [];
    container.segments.forEach((segment, index) => {
      if (index > 0) parts.push({ status: 'gap', size: 0, regionId: null });
      for (const cell of segment.cells) {
        parts.push({ status: cell.status, size: Math.max(0, cell.end - cell.start), regionId: cell.regionId });
      }
    });
    const total = parts.reduce((sum, part) => sum + part.size, 0);
    const analysed = parts.filter((part) => part.status === 'analysed').reduce((sum, part) => sum + part.size, 0);
    return {
      id: container.id,
      label: container.label,
      gaps: container.gaps,
      parts: parts.map((part) => ({ ...part, label: STATUS_LABELS[part.status] || part.status, share: total ? part.size / total : 0 })),
      summary: total
        ? `${Math.round((analysed / total) * 100)}% of what has been seen is analysed${container.gaps ? `, ${container.gaps} unexplored ${container.gaps === 1 ? 'gap' : 'gaps'}` : ''}`
        : 'Nothing captured yet'
    };
  });
}
