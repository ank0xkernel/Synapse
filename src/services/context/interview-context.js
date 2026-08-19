'use strict';

const fs = require('fs');
const path = require('path');
const { buildCandidateProfile } = require('./candidate-profile');
const { buildJdProfile, matchCandidateToJd, deriveFullTechnologyStatus } = require('./jd-profile');

/**
 * InterviewContext
 *
 * The preparation brief: which role you are interviewing for, what the job
 * description says, your own background, and how you want answers phrased.
 *
 * Everything the model says should be grounded in this. It is read on every
 * prompt build, so it is cached in memory and only re-read from disk when the
 * file changes underneath us.
 */

const STORE_DIR_NAME = 'cache';
const STORE_FILE_NAME = 'interview-context.json';

const FIELDS = Object.freeze({
  role: { label: 'Role', max: 200 },
  company: { label: 'Company', max: 200 },
  interviewType: { label: 'Interview type', max: 60 },
  seniority: { label: 'Seniority', max: 60 },
  jobDescription: { label: 'Job description', max: 8000 },
  background: { label: 'Your background', max: 8000 },
  focusAreas: { label: 'Topics to emphasise', max: 2000 },
  avoidTopics: { label: 'Topics to avoid', max: 2000 },
  answerStyle: { label: 'Answer style', max: 60 },
  extraNotes: { label: 'Extra notes', max: 4000 },
  // Phase 9 PART 9/5: extends the existing interview profile schema in
  // place -- same FIELDS-driven clamp/sanitize convention as every field
  // above, not a second file or a second persistence model.
  round: { label: 'Interview round', max: 60 },
  duration: { label: 'Duration', max: 60 },
  interviewerContext: { label: 'Interviewer context', max: 500 },
  difficulty: { label: 'Difficulty', max: 60 }
});

const ANSWER_STYLES = ['concise', 'balanced', 'detailed'];
const INTERVIEW_TYPES = ['auto', 'coding', 'system-design', 'behavioural', 'general'];

let cached = null;
let cachedMtimeMs = 0;
let storePath = null;

function defaults() {
  return {
    role: '',
    company: '',
    interviewType: 'auto',
    seniority: '',
    jobDescription: '',
    background: '',
    focusAreas: '',
    avoidTopics: '',
    answerStyle: 'balanced',
    extraNotes: '',
    round: '',
    duration: '',
    interviewerContext: '',
    difficulty: '',
    updatedAt: null,
    // Phase 9 PART 10/11: absent (undefined, via spread over these
    // defaults) on any file saved before this change -- every consumer
    // must treat a null/missing structuredProfile as "fall back to today's
    // plain-text behavior," never as an error or a reason to re-derive it
    // eagerly outside save().
    structuredProfile: null
  };
}

/** Must be called once at startup so packaged builds write to userData. */
function configure(app) {
  const baseDir = app && app.isPackaged
    ? app.getPath('userData')
    : path.join(__dirname, '..', '..', '..');

  storePath = path.join(baseDir, STORE_DIR_NAME, STORE_FILE_NAME);
  return storePath;
}

function getStorePath() {
  if (!storePath) configure(null);
  return storePath;
}

function clampString(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

/**
 * Phase 9 PART 11: computed unconditionally on every save, not diffed
 * against whether background/jobDescription actually changed. Building the
 * candidate/JD profile is a deterministic regex pass over a few KB of text
 * (measured in the Phase 9 report) and save() is a rare, user-initiated
 * call (resume upload, JD paste, a settings tweak) -- recomputing always is
 * simpler and can never drift out of sync with the raw text it's derived
 * from, which a "did it change" cache easily could if a future call site
 * mutates background without going through this exact path.
 *
 * Never throws: buildCandidateProfile/buildJdProfile both return their
 * empty shape for blank/malformed input, so a save with no resume/JD yet
 * still produces a valid (empty-arrays) structuredProfile, not null and not
 * an exception. structuredProfile stays null only for a file written before
 * Phase 9 existed at all (see defaults()) -- once anything is saved through
 * this code, it is always populated, even if empty.
 */
function buildStructuredProfile(clean) {
  const candidate = buildCandidateProfile(clean.background);
  const jd = buildJdProfile(clean.jobDescription);
  return {
    candidate,
    jd,
    match: matchCandidateToJd(candidate, jd),
    technologyStatus: deriveFullTechnologyStatus(candidate, jd)
  };
}

function sanitize(input = {}) {
  const clean = defaults();

  for (const [key, spec] of Object.entries(FIELDS)) {
    clean[key] = clampString(input[key], spec.max);
  }

  if (!ANSWER_STYLES.includes(clean.answerStyle)) clean.answerStyle = 'balanced';
  if (!INTERVIEW_TYPES.includes(clean.interviewType)) clean.interviewType = 'auto';

  clean.structuredProfile = buildStructuredProfile(clean);
  clean.updatedAt = new Date().toISOString();
  return clean;
}

function load() {
  const file = getStorePath();

  try {
    const stat = fs.statSync(file);
    if (cached && stat.mtimeMs === cachedMtimeMs) {
      return cached;
    }

    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    cached = { ...defaults(), ...parsed };
    cachedMtimeMs = stat.mtimeMs;
    return cached;
  } catch (_) {
    // No file yet, or unreadable — an empty brief is a valid state.
    cached = cached || defaults();
    return cached;
  }
}

function save(input) {
  const file = getStorePath();
  const clean = sanitize(input);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(clean, null, 2), 'utf8');

  cached = clean;
  try {
    cachedMtimeMs = fs.statSync(file).mtimeMs;
  } catch (_) {
    cachedMtimeMs = 0;
  }

  return clean;
}

function isEmpty(context = load()) {
  return !Object.keys(FIELDS).some((key) => {
    const value = String(context[key] || '').trim();
    // The two enums always hold a default, so they don't count as "filled".
    if (key === 'answerStyle' || key === 'interviewType') return false;
    return value.length > 0;
  });
}

/**
 * Renders the brief as a prompt block. Returns '' when nothing is set, so an
 * unconfigured app produces exactly the prompt it did before this feature.
 */
function toPromptBlock(context = load(), options = {}) {
  if (isEmpty(context)) return '';

  const lines = [];
  const add = (label, value) => {
    const text = String(value || '').trim();
    if (text) lines.push(`${label}: ${text}`);
  };

  add('Target role', context.role);
  add('Company', context.company);
  add('Seniority', context.seniority);

  if (context.interviewType && context.interviewType !== 'auto') {
    add('Interview type', context.interviewType);
  }

  // Phase 9: same add() pattern as every field above -- renders only when set.
  add('Interview round', context.round);
  add('Duration', context.duration);
  add('Interviewer context', context.interviewerContext);
  add('Difficulty', context.difficulty);

  add('Emphasise these topics', context.focusAreas);
  add('Avoid these topics', context.avoidTopics);
  add('Additional notes', context.extraNotes);

  const styleGuidance = {
    concise: 'Answer in under 80 words. Lead with the single strongest point.',
    balanced: 'Answer in roughly 100-160 words, structured and easy to say aloud.',
    detailed: 'Give a thorough answer with concrete specifics and trade-offs.'
  }[context.answerStyle] || '';

  const sections = [
    `=== INTERVIEW BRIEF ===
The user is preparing for a real interview. Ground every answer in the brief below:
use their actual background instead of generic filler, and phrase answers so they can
be spoken naturally out loud.
${lines.join('\n')}
${styleGuidance}`
  ];

  if (!options.excludeDocText) {
    if (context.jobDescription) {
      sections.push(`=== JOB DESCRIPTION ===\n${context.jobDescription}`);
    }

    if (context.background) {
      sections.push(`=== THE USER'S BACKGROUND (use these real details, never invent new ones) ===\n${context.background}`);
    }
  }

  return `\n${sections.join('\n\n')}\n`;
}

module.exports = {
  ANSWER_STYLES,
  FIELDS,
  INTERVIEW_TYPES,
  configure,
  defaults,
  getStorePath,
  isEmpty,
  load,
  save,
  toPromptBlock,
  // Test-only, same convention used across the Phase 3/6/7/8 __testing
  // exports elsewhere in this codebase.
  __testing: { buildStructuredProfile }
};
