#!/usr/bin/env node
/**
 * Resume import and section extraction: file validation (type, size, PDF
 * signature, scanned PDFs), a real PDF made with macOS cupsfilter, and the
 * section rules that decide what the AI treats as experience.
 *
 * Run: node tests/test-resume-import.mjs
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { extractResumeText } = require(path.join(__dirname, '../src/services/context/resume-import.js'));
const ResumeParser = require(path.join(__dirname, '../src/services/ai/resume-parser.js'));
const { buildCandidateProfile } = require(path.join(__dirname, '../src/services/context/candidate-profile.js'));

let passed = 0;
let failed = 0;
const quiet = (fn) => async () => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};
async function test(name, fn) {
  try {
    await quiet(fn)();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-resume-test-'));
const write = (name, content) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
};
async function expectCode(file, code) {
  try {
    await extractResumeText(file);
  } catch (error) {
    assert(error.code === code, `expected ${code}, got ${error.code}: ${error.message}`);
    return;
  }
  throw new Error(`expected ${code}, but import succeeded`);
}

const RESUME = [
  'Ankit Example',
  'Phone: +91 00000 00000 | Email: someone@example.com',
  'LinkedIn · GitHub · Portfolio',
  'PROFESSIONAL SUMMARY',
  'Full-stack developer building SaaS products with React and Node.js.',
  'WORK EXPERIENCE',
  'Software Engineer Intern, Acme Corp  Jun 2024 - Aug 2024',
  'Built a billing dashboard in React and TypeScript used by 40 internal users.',
  'KEY PROJECTS',
  'CampusConnect  2023 - 2024',
  'Role-based dashboards with PostgreSQL and Express, deployed on Render.',
  'Technical Skills: React, TypeScript, Node.js, PostgreSQL, Docker',
  'EDUCATION',
  'B.Tech Computer Science, Example University  2021 - 2025'
].join('\n');

console.log('\nvalidation');

await test('Rejects unsupported file types', () => expectCode(write('resume.docx', 'x'), 'UNSUPPORTED_TYPE'));
await test('Rejects an empty file', () => expectCode(write('empty.txt', ''), 'NO_TEXT'));
await test('Rejects a non-PDF renamed to .pdf', () => expectCode(write('fake.pdf', 'hello, not a pdf at all'), 'NOT_A_PDF'));
await test('Rejects files over 8 MB', () => expectCode(write('huge.txt', Buffer.alloc(8 * 1024 * 1024 + 1, 97)), 'TOO_LARGE'));
await test('A PDF with no text layer (scanned) is reported as NO_TEXT, not saved empty', async () => {
  const file = write('scan.pdf', '%PDF-1.4 placeholder');
  try {
    await extractResumeText(file, { parser: { parseResume: async () => [] } });
  } catch (error) {
    assert(error.code === 'NO_TEXT' && /scanned/i.test(error.message), error.message);
    return;
  }
  throw new Error('expected NO_TEXT');
});
await test('Plain text resumes import as-is', async () => {
  const result = await extractResumeText(write('resume.txt', RESUME));
  assert(result.text.includes('CampusConnect') && result.fileName === 'resume.txt');
});

if (process.platform === 'darwin' && fs.existsSync('/usr/sbin/cupsfilter')) {
  await test('A real text PDF (made with macOS cupsfilter) imports through pdf-parse', async () => {
    const source = write('source.txt', RESUME);
    const pdf = path.join(dir, 'real.pdf');
    fs.writeFileSync(pdf, execFileSync('/usr/sbin/cupsfilter', ['-m', 'application/pdf', source], { stdio: ['ignore', 'pipe', 'ignore'] }));
    const result = await extractResumeText(pdf);
    assert(/CampusConnect/.test(result.text), 'project name extracted from the PDF');
    assert(/WORK EXPERIENCE|Software Engineer Intern/.test(result.text), 'experience extracted');
  });
}

console.log('\nsection extraction');

const parser = new ResumeParser();
await test('Name and contact lines before the first heading are not experience', () => {
  const sections = parser.extractSections(RESUME);
  const experience = sections.filter((item) => item.section === 'Experience').map((item) => item.text).join('\n');
  assert(!/Phone|Email|LinkedIn/.test(experience), experience);
});
await test('Qualified headings are recognized ("PROFESSIONAL SUMMARY", "WORK EXPERIENCE", "KEY PROJECTS")', () => {
  const sections = parser.extractSections(RESUME);
  const sectionOf = (fragment) => sections.find((item) => item.text.includes(fragment))?.section;
  assert(sectionOf('Full-stack developer building') === 'Summary');
  assert(sectionOf('billing dashboard') === 'Experience');
  assert(sectionOf('Role-based dashboards') === 'Projects');
});
await test('"Technical Skills: React, ..." keeps its content under Skills instead of dropping it', () => {
  const skills = parser.extractSections(RESUME).filter((item) => item.section === 'Skills');
  assert(skills.some((item) => item.text.includes('PostgreSQL')), JSON.stringify(skills));
});
await test('A sentence starting with "Skills" or "Work" is content, not a heading', () => {
  const sections = parser.extractSections('EXPERIENCE\nWork with product teams to ship features weekly at scale.');
  assert(sections.length === 1 && sections[0].section === 'Experience');
});
await test('Headings with extra words are recognized ("INTERNSHIP EXPERIENCE", "ACADEMIC PROJECTS & RESEARCH", "Projects (Selected)")', () => {
  const text = [
    'Jane Doe',
    'INTERNSHIP EXPERIENCE',
    'Backend intern at Example Labs building REST APIs in Node.js',
    'ACADEMIC PROJECTS & RESEARCH',
    'Built a recommendation engine prototype with Python and FastAPI',
    'Projects (Selected)',
    'Realtime chat app using WebSockets and Redis pub/sub'
  ].join('\n');
  const sections = parser.extractSections(text);
  const sectionOf = (fragment) => sections.find((item) => item.text.includes(fragment))?.section;
  assert(sectionOf('Backend intern') === 'Experience', JSON.stringify(sections));
  assert(sectionOf('recommendation engine') === 'Projects');
  assert(sectionOf('Realtime chat app') === 'Projects');
});

await test('A resume with no headings at all still treats its lines as experience (unchanged behavior)', () => {
  const sections = parser.extractSections('Built a payments service in Go handling 2k requests per second.');
  assert(sections[0].section === 'Experience');
});
await test('The candidate profile no longer lists contact lines as experience', () => {
  const profile = buildCandidateProfile(RESUME);
  const experienceText = JSON.stringify(profile.experience);
  assert(!/Phone|Email|LinkedIn/.test(experienceText), experienceText);
  assert(profile.projects.length >= 1, 'project recognized');
});

await test('A 30k-character resume is saved whole and its last section still reaches the live prompt', () => {
  const interviewContext = require(path.join(__dirname, '../src/services/context/interview-context.js'));
  const prompts = require(path.join(__dirname, '../src/services/ai/prompts.js'));
  interviewContext.configure({ isPackaged: true, getPath: () => dir });
  const filler = Array.from({ length: 420 }, (_, i) => `- Shipped internal tooling improvement number ${i} for the platform team`).join('\n');
  const tail = 'Projects\nOrbitDB Sync Engine\n- Built a CRDT sync engine in Rust replicating 40k documents across regions';
  const background = `Jane Doe\nExperience\nSenior Engineer, Acme Corp (2019 - 2024)\n${filler}\n\n${tail}`;
  assert(background.length > 25000, `fixture is ${background.length} chars`);
  const saved = interviewContext.save({ background });
  assert(saved.background.length === background.trim().length, `kept ${saved.background.length} of ${background.length}`);
  assert(saved.background.endsWith('40k documents across regions'), 'last section kept');
  const transcript = 'Interviewer: Tell me about the OrbitDB sync engine you built in Rust.';
  const prompt = prompts.buildAskAiSessionPrompt({ contextString: transcript, transcriptContext: transcript });
  assert(/CRDT sync engine in Rust/.test(prompt), 'late-section evidence retrieved into the prompt');
  assert(prompt.length < background.length, `prompt (${prompt.length}) is budgeted, not the whole resume`);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nResume import tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
