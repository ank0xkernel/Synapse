'use strict';

/**
 * JobDescriptionProfile
 *
 * Structures raw `jobDescription` text -- pure, deterministic, no LLM, no
 * filesystem access. role/company already live in interview-context.js's
 * own fields and are NOT duplicated here (PART 7 of the Phase 9 spec is
 * explicit about this); this module only structures the JD body text
 * itself.
 *
 * JD headings ("Responsibilities", "Requirements", "Preferred") are a
 * different vocabulary from resume headings (resume-parser.js's job), so
 * this is a small header-detection pass of its own scope -- not a
 * competing resume parser, a JD-specific one that didn't exist at all
 * before. Conservative by design: a heading that isn't recognized doesn't
 * get invented a category, it stays in a generic evidence bucket.
 */

const { KNOWN_TECHNOLOGIES, extractTechnologies, deriveCandidateTechnologyStatus } = require('./candidate-profile');

const HEADING_PATTERNS = [
  { bucket: 'responsibilities', pattern: /^(responsibilities|what you.ll do|about the role|role overview|the role)/i },
  { bucket: 'requiredSkills', pattern: /^(requirements|required skills|must[- ]have|minimum qualifications|qualifications|basic qualifications)/i },
  { bucket: 'preferredSkills', pattern: /^(preferred|nice[- ]to[- ]have|bonus|preferred qualifications|good to have)/i }
];

function matchHeading(line) {
  const found = HEADING_PATTERNS.find(({ pattern }) => pattern.test(line.trim()));
  return found ? found.bucket : null;
}

/**
 * Splits raw JD text into lines, same bullet-stripping convention
 * mobile-server/server.js's own splitIntoPoints already uses (dash/bullet
 * prefix stripped, blank lines dropped, short fragments discarded) --
 * mirrored rather than imported because splitIntoPoints lives in the main
 * process's mobile-server module, not a service this module can reach
 * without pulling in HTTP-server-only code.
 */
function splitLines(text) {
  return String(text || '')
    .split(/\r?\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•●]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length >= 4);
}

/**
 * @param {string} jdText
 * @returns {object} JobDescriptionProfile
 */
function buildJdProfile(jdText) {
  const empty = { responsibilities: [], requiredSkills: [], preferredSkills: [], technologies: [], evidence: [] };

  const text = String(jdText || '').trim();
  if (!text) return empty;

  const lines = splitLines(text);
  if (lines.length === 0) return empty;

  const responsibilities = [];
  const requiredSkills = [];
  const preferredSkills = [];
  const evidence = [];

  let currentBucket = null;
  lines.forEach((line, index) => {
    const heading = matchHeading(line);
    if (heading) {
      currentBucket = heading;
      return; // the heading line itself isn't evidence text
    }

    const item = { text: line, section: currentBucket || 'jd', sourceLine: `jd-${index}` };
    evidence.push(item);

    if (currentBucket === 'responsibilities') responsibilities.push(item);
    else if (currentBucket === 'requiredSkills') requiredSkills.push(item);
    else if (currentBucket === 'preferredSkills') preferredSkills.push(item);
    // No recognized heading yet -- kept in `evidence` only, per PART 7:
    // "retain useful raw JD evidence rather than aggressively guessing
    // categories."
  });

  return {
    responsibilities,
    requiredSkills,
    preferredSkills,
    technologies: extractTechnologies(text),
    evidence
  };
}

/**
 * PART 8: deterministic set overlap between what the candidate has and what
 * the JD asks for. No semantic equivalence claimed -- "distributed systems"
 * and "Kafka" are never treated as the same thing here; only literal
 * KNOWN_TECHNOLOGIES-vocabulary matches count, which is honest about what
 * this can and can't detect.
 *
 * @param {object} candidateProfile
 * @param {object} jdProfile
 * @returns {{ matched: string[], candidateOnly: string[], jdOnly: string[] }}
 */
function matchCandidateToJd(candidateProfile, jdProfile) {
  const candidateSet = new Set(candidateProfile?.technologies || []);
  const jdSet = new Set(jdProfile?.technologies || []);

  const matched = [...candidateSet].filter((t) => jdSet.has(t));
  const candidateOnly = [...candidateSet].filter((t) => !jdSet.has(t));
  const jdOnly = [...jdSet].filter((t) => !candidateSet.has(t));

  return { matched, candidateOnly, jdOnly };
}

/**
 * PART 6/16: the one JD-aware status upgrade -- a technology the JD asks
 * for but that candidate-profile.js found no candidate-side evidence for at
 * all becomes THEORETICAL ("the employer wants this; nothing shows the
 * candidate has it") rather than staying a bare UNKNOWN. Never the reverse:
 * a technology already VERIFIED_EXPERIENCE/PROJECT_EXPERIENCE/WORKED_WITH
 * from the candidate's own evidence is never downgraded or overwritten by
 * JD presence, and JD presence never upgrades anything to
 * VERIFIED_EXPERIENCE -- that upgrade path plainly doesn't exist in this
 * function.
 *
 * @param {object} candidateProfile
 * @param {object} jdProfile
 * @returns {Record<string, string>}
 */
function deriveFullTechnologyStatus(candidateProfile, jdProfile) {
  const status = deriveCandidateTechnologyStatus(candidateProfile);

  for (const tech of jdProfile?.technologies || []) {
    if (!status[tech]) status[tech] = 'THEORETICAL';
  }

  return status;
}

module.exports = {
  buildJdProfile,
  matchCandidateToJd,
  deriveFullTechnologyStatus,
  __testing: { matchHeading, splitLines }
};
