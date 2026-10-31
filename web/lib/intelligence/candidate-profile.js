'use strict';

/**
 * CandidateProfile
 *
 * Turns the candidate's raw `background` text into structured, provenance-
 * aware data -- deterministic and dependency-free, no LLM anywhere in this
 * file. Reuses resume-parser.js's existing section detection (extractSections)
 * rather than re-implementing it; this module's own job starts one layer
 * below that: grouping a section's bullets into named entries (projects,
 * jobs) and deriving a technology → status map from where each technology
 * actually appears.
 *
 * Every meaningful claim keeps its provenance ({ text, section, sourceLine }
 * -- see toEvidence below) all the way through, and nothing here ever
 * fabricates a value formatting doesn't clearly support: an ambiguous entry
 * stays unstructured evidence rather than a guessed employer/date.
 */

// Path fixed for web/lib/intelligence's flat layout — originally
// '../ai/resume-parser' in the desktop app's src/services/context/ tree.
const ResumeParser = require('./resume-parser');

// Mirrored from conversation-tracker.js's KNOWN_TECHNOLOGIES (Phase 3), not
// imported: Phase 9 is explicitly barred from modifying conversation-
// tracker.js, question-relation.js, or semantic-reference.js (see the Phase 9
// spec's PART 14) unless a genuine compatibility defect is found, and none
// was. Kept identical on purpose -- if this list ever needs to grow, extend
// both copies with the same reasoning, don't let them drift into two
// different vocabularies for what is conceptually one list.
const KNOWN_TECHNOLOGIES = new Set([
  'PostgreSQL', 'MongoDB', 'Redis', 'GraphQL', 'REST', 'gRPC', 'Kubernetes', 'Docker',
  'AWS', 'GCP', 'Azure', 'React', 'Vue', 'Angular', 'Node', 'Python', 'TypeScript',
  'JavaScript', 'FastAPI', 'Django', 'Flask', 'JWT', 'OAuth', 'MySQL', 'SQLite',
  'Kafka', 'RabbitMQ', 'Nginx', 'Terraform', 'Next', 'Express', 'Spring', 'LangGraph'
]);

const SECTION_ALIASES = {
  skills: 'skills',
  experience: 'experience',
  work: 'experience',
  education: 'education',
  projects: 'projects',
  summary: 'summary',
  certifications: 'certifications',
  certificates: 'certifications',
  certification: 'certifications',
  achievements: 'achievements',
  achievement: 'achievements',
  awards: 'achievements',
  award: 'achievements'
};

function normalizeSectionName(rawSection) {
  const key = String(rawSection || '').toLowerCase();
  return SECTION_ALIASES[key] || null; // null = an unrecognized header; kept as raw evidence, not discarded
}

/**
 * A bullet that looks like it OPENS a new project/job entry: a short
 * name/title phrase followed reasonably closely by a date or date range.
 * Conservative on purpose -- a bullet that doesn't match stays a plain
 * bullet under whatever entry is currently open (or unstructured, if none
 * is), never a guessed new entry.
 */
const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const ENTRY_START_PATTERN = new RegExp(
  `^([A-Z][\\w&.,'()\\/ -]{1,80}?)\\s*[-–—:]?\\s*((?:${MONTHS})\\.?\\s*\\d{4}|\\d{4}\\s*[-–—]\\s*(?:\\d{4}|present)|\\d{4})`,
  'i'
);

function isEntryStart(line) {
  return ENTRY_START_PATTERN.test(line);
}

function extractDates(line) {
  const match = line.match(ENTRY_START_PATTERN);
  return match ? match[2].trim() : null;
}

function extractName(line) {
  const match = line.match(ENTRY_START_PATTERN);
  if (!match) return null;
  return match[1].trim().replace(/[-–—:]+$/, '').trim() || null;
}

function extractTechnologies(text) {
  const words = String(text || '').split(/\s+/).map((w) => w.replace(/[^a-zA-Z0-9.]/g, ''));
  return [...new Set(words.filter((w) => KNOWN_TECHNOLOGIES.has(w)))];
}

function toEvidence(item) {
  return { text: item.text, section: normalizeSectionName(item.section) || item.section, sourceLine: item.id };
}

/**
 * Groups a flat list of `{id, section, text}` bullets (already known to
 * belong to one section) into named entries where the formatting supports
 * it, falling back to a single unstructured entry (name: null) covering the
 * whole section when no bullet looks like an entry header at all -- this is
 * the "do not invent structure formatting doesn't support" fallback PART 5
 * requires.
 */
function groupIntoEntries(bullets) {
  if (bullets.length === 0) return [];

  const anyEntryStarts = bullets.some((b) => isEntryStart(b.text));
  if (!anyEntryStarts) {
    return [{
      name: null,
      dates: null,
      bullets: bullets.map((b) => b.text),
      technologies: extractTechnologies(bullets.map((b) => b.text).join(' ')),
      evidence: bullets.map(toEvidence)
    }];
  }

  const entries = [];
  let current = null;

  for (const bullet of bullets) {
    if (isEntryStart(bullet.text)) {
      if (current) entries.push(current);
      current = {
        name: extractName(bullet.text),
        dates: extractDates(bullet.text),
        bullets: [bullet.text],
        technologies: [],
        evidence: [toEvidence(bullet)]
      };
    } else if (current) {
      current.bullets.push(bullet.text);
      current.evidence.push(toEvidence(bullet));
    } else {
      // A bullet before any recognized entry start -- keep it, don't drop
      // it, as its own unstructured entry rather than silently discarding it.
      entries.push({
        name: null,
        dates: null,
        bullets: [bullet.text],
        technologies: extractTechnologies(bullet.text),
        evidence: [toEvidence(bullet)]
      });
    }
  }
  if (current) entries.push(current);

  for (const entry of entries) {
    entry.technologies = extractTechnologies(entry.bullets.join(' '));
  }

  return entries;
}

// Grade is the one education sub-field extracted beyond raw text: it has an
// unambiguous, explicitly-labeled shape ("Grade: 7.82/10.0", "Grade: 90%")
// that doesn't require guessing, unlike institution/degree/field which run
// together in free text with no reliable delimiter across resume formats.
function extractGrade(text) {
  const match = String(text || '').match(/grade:?\s*([\d.]+\s*\/\s*[\d.]+|\d+(?:\.\d+)?%)/i);
  return match ? match[1].replace(/\s+/g, '') : null;
}

/**
 * Builds a CandidateProfile from raw resume text. Returns the "empty" shape
 * (every array empty) for empty/missing input -- never throws, safe to call
 * with malformed or incomplete data.
 *
 * @param {string} backgroundText
 * @returns {object} CandidateProfile
 */
function buildCandidateProfile(backgroundText) {
  const empty = {
    identity: {},
    education: [],
    experience: [],
    projects: [],
    skills: [],
    achievements: [],
    certifications: [],
    technologies: [],
    evidence: []
  };

  const text = String(backgroundText || '').trim();
  if (!text) return empty;

  const parser = new ResumeParser();
  const rawItems = parser.extractSections(text); // [{id, section, text}], pure -- no filesystem access
  if (!Array.isArray(rawItems) || rawItems.length === 0) return empty;

  const bySection = {};
  for (const item of rawItems) {
    const bucket = normalizeSectionName(item.section) || 'other';
    (bySection[bucket] = bySection[bucket] || []).push(item);
  }

  const experience = groupIntoEntries(bySection.experience || []);
  const projects = groupIntoEntries(bySection.projects || []);

  const skills = (bySection.skills || []).map(toEvidence);
  const achievements = (bySection.achievements || []).map(toEvidence);
  const certifications = (bySection.certifications || []).map(toEvidence);
  const education = (bySection.education || []).map((item) => ({
    ...toEvidence(item),
    grade: extractGrade(item.text)
  }));

  const allTechnologies = new Set([
    ...extractTechnologies(text),
  ]);

  const evidence = rawItems.map(toEvidence);

  return {
    identity: {},
    education,
    experience,
    projects,
    skills,
    achievements,
    certifications,
    technologies: [...allTechnologies],
    evidence
  };
}

/**
 * PART 6: derives a technology -> status map from the candidate's OWN
 * evidence only (no JD involved -- see jd-profile.js's
 * deriveFullTechnologyStatus for the JD-aware THEORETICAL upgrade).
 * Precedence mirrors the profile's own evidence strength: a technology
 * verified by a Work/Experience entry outranks the same technology also
 * appearing in a Skills line.
 *
 * @param {object} candidateProfile
 * @returns {Record<string, string>}
 */
function deriveCandidateTechnologyStatus(candidateProfile) {
  const status = {};
  const set = (tech, value, rank) => {
    const existing = status[tech];
    if (!existing || existing.rank < rank) status[tech] = { value, rank };
  };

  for (const entry of candidateProfile.experience || []) {
    for (const tech of entry.technologies || []) set(tech, 'VERIFIED_EXPERIENCE', 3);
  }
  for (const entry of candidateProfile.projects || []) {
    for (const tech of entry.technologies || []) set(tech, 'PROJECT_EXPERIENCE', 2);
  }
  for (const item of candidateProfile.skills || []) {
    for (const tech of extractTechnologies(item.text)) set(tech, 'WORKED_WITH', 1);
  }

  const flat = {};
  for (const [tech, { value }] of Object.entries(status)) flat[tech] = value;
  return flat;
}

module.exports = {
  KNOWN_TECHNOLOGIES,
  buildCandidateProfile,
  deriveCandidateTechnologyStatus,
  extractTechnologies,
  // Test-only internals, same convention as question-relation.js's and
  // conversation-tracker.js's own __testing exports.
  __testing: {
    normalizeSectionName,
    isEntryStart,
    extractName,
    extractDates,
    extractGrade,
    groupIntoEntries
  }
};
