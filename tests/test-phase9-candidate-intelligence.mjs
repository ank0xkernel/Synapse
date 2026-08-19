#!/usr/bin/env node
/**
 * Phase 9 — Candidate Intelligence & Interview Knowledge Layer test suite.
 *
 * Exercises the REAL production modules (candidate-profile.js, jd-profile.js,
 * interview-context.js, prompts.js, conversation-tracker.js), not
 * reimplementations. Two fixture strategies, matching what each test
 * actually needs: a real temp-directory interview-context store (for
 * save()/load()/structuredProfile-computation tests), and a monkey-patched
 * interviewContext.load() (for prompts.js consumption tests, same pattern
 * the Phase 6/7/8 suites already use).
 *
 * Run: node tests/test-phase9-candidate-intelligence.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const candidateProfileModule = require(path.join(__dirname, '../src/services/context/candidate-profile.js'));
const jdProfileModule = require(path.join(__dirname, '../src/services/context/jd-profile.js'));
const interviewContext = require(path.join(__dirname, '../src/services/context/interview-context.js'));
const prompts = require(path.join(__dirname, '../src/services/ai/prompts.js'));

const { buildCandidateProfile, deriveCandidateTechnologyStatus } = candidateProfileModule;
const { buildJdProfile, matchCandidateToJd, deriveFullTechnologyStatus } = jdProfileModule;

const { createConversationTracker, formatActiveContextBlock } = await import(
  '../src/windows/assistant/renderer/features/auto-answer/conversation-tracker.js'
);

// ─── tiny test harness ─────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];
let currentCategory = '';

function section(title) {
  currentCategory = title;
  console.log(`\n${title}`);
}
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ category: currentCategory, name, message: err.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}
function assertEqual(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg || 'assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertTrue(cond, msg) { if (!cond) throw new Error(msg || 'expected true'); }
function assertFalse(cond, msg) { if (cond) throw new Error(msg || 'expected false'); }
function normalizeWhitespace(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }
function assertContains(haystack, needle, msg) {
  if (!normalizeWhitespace(haystack).includes(normalizeWhitespace(needle))) {
    throw new Error(`${msg || 'expected substring'}: "${needle}" not found`);
  }
}

// ─── fixtures ───────────────────────────────────────────────────────────────

const SAMPLE_RESUME = [
  'SUMMARY',
  'Full-stack developer with a focus on backend systems.',
  'EDUCATION',
  'Newton School of Technology, Pune June 2024',
  'Grade: 7.82/10.0',
  'EXPERIENCE',
  'Full Stack Developer Intern June 2026 - August 2026',
  'JPMorgan Chase & Co.',
  'Integrated Kafka into a Spring Boot microservice for transaction processing.',
  'Implemented persistence logic with PostgreSQL and Spring Data JPA.',
  'PROJECTS',
  'CampusConnect June 2026',
  'Built a full-stack university management platform with role-based dashboards and JWT authentication.',
  'Used PostgreSQL with a normalized 26-table schema.',
  'Novaris March 2026',
  'Built an AI-powered GitHub repository intelligence platform using FastAPI and PostgreSQL.',
  'SKILLS',
  'Python, TypeScript, React, Redis, Docker',
  'ACHIEVEMENTS',
  'Ranked in the top 5% of 2000+ participants in a national coding competition.',
  'CERTIFICATIONS',
  'AWS Certified Cloud Practitioner'
].join('\n');

const SAMPLE_JD = [
  'Responsibilities',
  'Design and build backend services for a growing platform.',
  'Required Skills',
  'Strong PostgreSQL and Kafka experience required.',
  'Preferred',
  'Experience with React is a plus.'
].join('\n');

function withMockContext(mockContext, fn) {
  const original = interviewContext.load;
  interviewContext.load = () => mockContext;
  try { return fn(); } finally { interviewContext.load = original; }
}

function buildMockContextWithProfile() {
  const candidate = buildCandidateProfile(SAMPLE_RESUME);
  const jd = buildJdProfile(SAMPLE_JD);
  return {
    role: 'Backend Engineer', company: 'TestCo', interviewType: 'auto', seniority: 'mid',
    background: SAMPLE_RESUME, jobDescription: SAMPLE_JD,
    focusAreas: '', avoidTopics: '', answerStyle: 'balanced', extraNotes: '',
    round: '', duration: '', interviewerContext: '', difficulty: '', updatedAt: null,
    structuredProfile: { candidate, jd, match: matchCandidateToJd(candidate, jd), technologyStatus: deriveFullTechnologyStatus(candidate, jd) }
  };
}

// ─── A-H: resume structuring ────────────────────────────────────────────────
section('A-H. Resume structuring (candidate-profile.js)');

const profile = buildCandidateProfile(SAMPLE_RESUME);

test('A. Resume section extraction: every recognized section is present', () => {
  assertTrue(profile.education.length > 0);
  assertTrue(profile.experience.length > 0);
  assertTrue(profile.projects.length > 0);
  assertTrue(profile.skills.length > 0);
  assertTrue(profile.achievements.length > 0);
  assertTrue(profile.certifications.length > 0);
});

test('B. Education extraction: preserves raw lines, extracts grade only where unambiguous', () => {
  const gradeLine = profile.education.find((e) => e.grade);
  assertTrue(!!gradeLine, 'expected one education line with an extracted grade');
  assertEqual(gradeLine.grade, '7.82/10.0');
  const institutionLine = profile.education.find((e) => e.text.includes('Newton School'));
  assertEqual(institutionLine.grade, null, 'must not fabricate a grade for a line with none');
});

test('C. Experience extraction: groups into a named entry with technologies', () => {
  assertEqual(profile.experience.length, 1);
  const entry = profile.experience[0];
  assertContains(entry.name, 'Full Stack Developer Intern');
  assertTrue(entry.technologies.includes('Kafka'));
  assertTrue(entry.technologies.includes('PostgreSQL'));
});

test('D. Project extraction: two distinct named project entries', () => {
  assertEqual(profile.projects.length, 2);
  const names = profile.projects.map((p) => p.name);
  assertTrue(names.includes('CampusConnect'));
  assertTrue(names.includes('Novaris'));
  const campusConnect = profile.projects.find((p) => p.name === 'CampusConnect');
  assertTrue(campusConnect.technologies.includes('PostgreSQL'));
});

test('E. Technology extraction: reuses the mirrored KNOWN_TECHNOLOGIES vocabulary, no fabricated tech', () => {
  assertTrue(profile.technologies.includes('PostgreSQL'));
  assertTrue(profile.technologies.includes('Kafka'));
  assertTrue(profile.technologies.includes('React'));
  assertFalse(profile.technologies.includes('COBOL'), 'must not invent a technology never mentioned');
});

test('F. Achievement extraction: only from a real Achievements heading', () => {
  assertEqual(profile.achievements.length, 1);
  assertContains(profile.achievements[0].text, 'top 5%');
});

test('G. Certification extraction: only from a real Certifications heading', () => {
  assertEqual(profile.certifications.length, 1);
  assertContains(profile.certifications[0].text, 'AWS Certified');
});

test('H. Provenance preservation: every evidence item keeps section + sourceLine', () => {
  const item = profile.evidence[0];
  assertTrue('text' in item && 'section' in item && 'sourceLine' in item);
  for (const entry of profile.projects) {
    for (const ev of entry.evidence) {
      assertTrue('sourceLine' in ev, 'project bullet evidence must retain provenance');
    }
  }
});

test('empty/malformed input never throws, returns the empty shape', () => {
  const empty = buildCandidateProfile('');
  assertEqual(empty.projects, []);
  assertEqual(empty.experience, []);
  const garbage = buildCandidateProfile('   \n\n   ');
  assertEqual(garbage.technologies, []);
  const undef = buildCandidateProfile(undefined);
  assertEqual(undef.education, []);
});

// ─── I-L: experience grounding ──────────────────────────────────────────────
section('I-L. Experience grounding (deterministic status derivation)');

const candidateStatus = deriveCandidateTechnologyStatus(profile);

test('I. VERIFIED_EXPERIENCE: a technology backed by a Work/Experience entry', () => {
  assertEqual(candidateStatus.Kafka, 'VERIFIED_EXPERIENCE');
});

test('J. PROJECT_EXPERIENCE: a technology backed only by a Projects entry', () => {
  assertEqual(candidateStatus.FastAPI, 'PROJECT_EXPERIENCE');
});

test('K. WORKED_WITH: a technology backed only by a Skills line', () => {
  assertEqual(candidateStatus.Redis, 'WORKED_WITH');
});

test('K2. Precedence: a technology in BOTH experience and skills stays at its strongest tier', () => {
  // PostgreSQL appears in Experience, Projects, AND nowhere in Skills here --
  // still must resolve to the single strongest tier, not the weakest.
  assertEqual(candidateStatus.PostgreSQL, 'VERIFIED_EXPERIENCE');
});

test('L. UNKNOWN: a technology with no candidate-side evidence at all gets no status (never fabricated)', () => {
  assertFalse('COBOL' in candidateStatus, 'a technology never mentioned must not appear in the status map at all');
});

// ─── M-N: JD structuring and matching ───────────────────────────────────────
section('M-N. JD profile + candidate/JD matching (jd-profile.js)');

const jdProfile = buildJdProfile(SAMPLE_JD);

test('M. JD required/preferred/responsibility extraction under their real headings', () => {
  assertEqual(jdProfile.responsibilities.length, 1);
  assertEqual(jdProfile.requiredSkills.length, 1);
  assertEqual(jdProfile.preferredSkills.length, 1);
  assertContains(jdProfile.requiredSkills[0].text, 'Kafka');
  assertContains(jdProfile.preferredSkills[0].text, 'React');
});

test('N. Candidate/JD technology intersection: matched / candidate-only / JD-only', () => {
  const match = matchCandidateToJd(profile, jdProfile);
  assertTrue(match.matched.includes('PostgreSQL'));
  assertTrue(match.matched.includes('React'));
  assertTrue(match.candidateOnly.includes('Redis'));
  assertTrue(match.jdOnly.includes('Kafka') === false, 'Kafka is candidate-verified AND JD-required -- it must be MATCHED, not JD-only');
});

test('N2. JD-only technology (never in resume) is correctly isolated', () => {
  const jdWithGap = buildJdProfile('Required Skills\nStrong MongoDB experience required.');
  const match = matchCandidateToJd(profile, jdWithGap);
  assertTrue(match.jdOnly.includes('MongoDB'));
  assertFalse(match.matched.includes('MongoDB'));
});

test('empty/malformed JD input never throws', () => {
  const empty = buildJdProfile('');
  assertEqual(empty.requiredSkills, []);
  const undef = buildJdProfile(undefined);
  assertEqual(undef.technologies, []);
});

// ─── O-Q: retrieval upgrade ──────────────────────────────────────────────────
section('O-Q. Retrieval (BM25-lite, section weighting, active-topic weighting)');

test('O. BM25 ranking: a document with more/rarer matching terms ranks first, deterministically', () => {
  const { scoreItemsAgainstQuery } = prompts.__testing;
  const items = [
    'Built CampusConnect using PostgreSQL with a normalized relational schema.',
    'Implemented caching with Redis for dashboard queries.',
    'Built the frontend in React with TypeScript.'
  ];
  const results = scoreItemsAgainstQuery(items, 'postgresql relational schema');
  assertEqual(results[0].item, items[0]);
  // Deterministic: running it again produces the identical ranking.
  const again = scoreItemsAgainstQuery(items, 'postgresql relational schema');
  assertEqual(results.map((r) => r.item), again.map((r) => r.item));
});

test('P. Section weighting: preferredSection boosts a matching item above a higher-raw-score non-matching one', () => {
  const { scoreItemsAgainstQuery } = prompts.__testing;
  const items = [
    { text: 'a', searchableText: 'PostgreSQL fundamentals certificate', section: 'certifications' },
    { text: 'b', searchableText: 'Built a project using PostgreSQL', section: 'projects' }
  ];
  const weighted = scoreItemsAgainstQuery(items, 'postgresql', { preferredSection: 'projects' });
  assertEqual(weighted[0].item.section, 'projects');
});

test('P2. inferPreferredSection: project/internship/education/skill queries map to the right section', () => {
  const { inferPreferredSection } = prompts.__testing;
  assertEqual(inferPreferredSection('What projects have you built with React?'), 'projects');
  assertEqual(inferPreferredSection('Tell me about your previous internship.'), 'experience');
  assertEqual(inferPreferredSection('What did you study?'), 'education');
  assertEqual(inferPreferredSection('What are your skills?'), 'skills');
});

test('Q. Active-topic weighting: anchor terms from ACTIVE CONTEXT still enrich the retrieval query (Phase 6 mechanism preserved)', () => {
  withMockContext(buildMockContextWithProfile(), () => {
    const activeContext = 'Current question: What about MongoDB?\nRelation: COMPARISON\nConfidence: HIGH\nActive topic: PostgreSQL\nRelevant entities: PostgreSQL, MongoDB';
    const block = prompts.__testing.buildRetrievedContextBlock('What about MongoDB?', 'FOLLOW_UP', activeContext);
    assertContains(block, 'PostgreSQL', 'anchor-enriched query should still surface PostgreSQL-related evidence');
  });
});

// ─── R-T: evidence selection ─────────────────────────────────────────────────
section('R-T. Structured evidence retrieval and JD/candidate separation');

test('R. Candidate evidence retrieval: a project-specific question surfaces the right project, status-labeled', () => {
  withMockContext(buildMockContextWithProfile(), () => {
    const block = prompts.__testing.buildRetrievedContextBlock('authentication CampusConnect', 'FOLLOW_UP', '');
    assertContains(block, '[RESUME — PROJECT_EXPERIENCE]');
    assertContains(block, 'CampusConnect');
  });
});

test('S. JD evidence retrieval: required/preferred labels render distinctly', () => {
  withMockContext(buildMockContextWithProfile(), () => {
    const block = prompts.__testing.buildRetrievedContextBlock('kafka postgresql', 'JD_RELATED', '');
    assertContains(block, '[JD — REQUIRED]');
  });
});

test('T. JD is never rendered under the same label as candidate experience', () => {
  withMockContext(buildMockContextWithProfile(), () => {
    const block = prompts.__testing.buildRetrievedContextBlock('kafka', 'FOLLOW_UP', '');
    assertContains(block, '[RESUME — VERIFIED_EXPERIENCE]');
    assertContains(block, '[JD — REQUIRED]');

    // Isolate each individually-labeled item's own span: from its "[LABEL...]"
    // header to the next "[" (the next item's header) or end of string.
    const headerPositions = [...block.matchAll(/\[(RESUME|JD)[^\]]*\]/g)].map((m) => m.index);
    const spans = headerPositions.map((start, i) => block.slice(start, headerPositions[i + 1] ?? block.length));
    const resumeSpans = spans.filter((s) => s.startsWith('[RESUME'));
    const jdSpans = spans.filter((s) => s.startsWith('[JD'));
    assertTrue(resumeSpans.length > 0 && jdSpans.length > 0, 'expected both a RESUME and a JD block to be present');

    for (const span of resumeSpans) {
      assertFalse(/Strong PostgreSQL and Kafka experience required/.test(span), 'a JD line must never appear inside a RESUME-labeled block');
    }
    for (const span of jdSpans) {
      assertFalse(/Integrated Kafka into a Spring Boot microservice/.test(span), 'a RESUME line must never appear inside a JD-labeled block');
    }
  });
});

// ─── U-V: backward compatibility ─────────────────────────────────────────────
section('U-V. Backward compatibility (PART 10 — the critical requirement)');

test('U. Missing structuredProfile: retrieval falls back to legacy flat [RESUME]/[JD] rendering', () => {
  const legacyContext = {
    role: 'X', company: 'Y', background: 'Built CampusConnect using PostgreSQL.',
    jobDescription: 'PostgreSQL required.', structuredProfile: null
  };
  withMockContext(legacyContext, () => {
    const block = prompts.__testing.buildRetrievedContextBlock('postgresql', 'RESUME_RELATED', '');
    assertContains(block, '[RESUME]');
    assertFalse(block.includes('VERIFIED_EXPERIENCE'), 'legacy path must not emit Phase 9 status labels');
    assertFalse(block.includes('PROJECT_EXPERIENCE'));
  });
});

test('V. Existing flat resume (real interview-context.js load/save cycle) stays byte-compatible in shape', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-phase9-test-'));
  try {
    const storePath = interviewContext.configure({ isPackaged: true, getPath: () => tmpDir });
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify({
      role: 'Old Role', company: 'OldCo', background: 'Just some old plain background text.', jobDescription: 'Old JD text.'
    }, null, 2));

    const loaded = interviewContext.load();
    assertEqual(loaded.role, 'Old Role');
    assertEqual(loaded.background, 'Just some old plain background text.');
    assertEqual(loaded.structuredProfile, null, 'a file never saved through Phase 9 code must not have a structuredProfile');
    assertEqual(loaded.round, '', 'new fields default to empty on an old file');

    const block = interviewContext.toPromptBlock(loaded, { excludeDocText: true });
    assertFalse(block.includes('Interview round:'), 'an unset new field must not render at all');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('V2. save() computes structuredProfile unconditionally, even for a brief with no resume/JD yet', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-phase9-test-'));
  try {
    interviewContext.configure({ isPackaged: true, getPath: () => tmpDir });
    const saved = interviewContext.save({ role: 'Backend Engineer' });
    assertTrue(!!saved.structuredProfile, 'structuredProfile must be populated (even if empty-shaped) after any save()');
    assertEqual(saved.structuredProfile.candidate.projects, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── W-Y: prompt rendering ────────────────────────────────────────────────────
section('W-Y. Prompt rendering (status labels, anti-hallucination, no dumping)');

test('W. Prompt evidence-status rendering: labels appear exactly as designed', () => {
  withMockContext(buildMockContextWithProfile(), () => {
    const block = prompts.__testing.buildRetrievedContextBlock('campusconnect project postgresql', 'FOLLOW_UP', '');
    assertContains(block, '[RESUME — PROJECT_EXPERIENCE]');
    assertContains(block, 'Project: CampusConnect');
    assertContains(block, 'Technology:');
  });
});

test('X. Prompt anti-hallucination: WORKED_WITH vs VERIFIED_EXPERIENCE distinction is explicit', () => {
  withMockContext(buildMockContextWithProfile(), () => {
    const directives = prompts.__testing.buildEvidenceDirectives(true);
    assertContains(directives, 'Never describe WORKED_WITH-level exposure as if it were VERIFIED_EXPERIENCE');
    assertContains(directives, 'must never become');
  });
});

test('X2. Anti-leakage: new Phase 9 status labels are explicitly forbidden from spoken output', () => {
  withMockContext(buildMockContextWithProfile(), () => {
    const t = createConversationTracker();
    const r = t.resolveQuestion('What is a hash map?');
    const activeContext = formatActiveContextBlock(r);
    const promptText = prompts.buildAskAiSessionPrompt({
      contextString: 'Host: What is a hash map?', transcriptContext: 'Host: What is a hash map?',
      activeContext, relation: r.relation, confidence: r.confidence
    });
    assertContains(promptText, 'VERIFIED_EXPERIENCE');
    assertContains(promptText, 'internal provenance tags, not words a candidate would ever say');
  });
});

test('Y. No resume dumping: an unrelated section (Education) does not appear for a targeted project question', () => {
  withMockContext(buildMockContextWithProfile(), () => {
    const block = prompts.__testing.buildRetrievedContextBlock('authentication CampusConnect', 'FOLLOW_UP', '');
    assertFalse(block.includes('Education:'), 'Education must not appear when the question is about a specific project');
    assertFalse(block.includes('Novaris'), 'an unrelated project must not appear either');
  });
});

// ─── Z: full pipeline integration ────────────────────────────────────────────
section('Z. Full pipeline integration');

test('Z. End-to-end: real save() -> real conversation-tracker -> real prompt build, correct evidence selected', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-phase9-e2e-'));
  try {
    interviewContext.configure({ isPackaged: true, getPath: () => tmpDir });
    interviewContext.save({ role: 'Backend Engineer', company: 'TestCo', background: SAMPLE_RESUME, jobDescription: SAMPLE_JD });

    const t = createConversationTracker();
    t.resolveQuestion('Tell me about CampusConnect.');
    t.recordAnswer('CampusConnect is a university management platform I built with role-based dashboards.');
    const r = t.resolveQuestion('Can you explain the authentication part?');
    const activeContext = formatActiveContextBlock(r);
    const contextString = `Host: Tell me about CampusConnect.\nAI: CampusConnect is a university management platform I built with role-based dashboards.\nHost: ${r.resolved}`;

    const promptText = prompts.buildAskAiSessionPrompt({
      contextString, transcriptContext: contextString, activeContext, relation: r.relation, confidence: r.confidence
    });

    assertContains(promptText, '[RESUME — PROJECT_EXPERIENCE]');
    assertContains(promptText, 'CampusConnect');
    assertFalse(promptText.includes('Novaris'), 'the unrelated second project must not be dumped in');
    assertContains(promptText, '=== EVIDENCE PRIORITY ===');
    assertContains(promptText, 'do not restart the parent explanation from scratch');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── summary ────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Phase 9 tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  [${f.category}] ${f.name}\n    ${f.message}`);
  }
  process.exitCode = 1;
} else {
  console.log('All Phase 9 tests passed.');
}
