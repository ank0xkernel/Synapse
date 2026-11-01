#!/usr/bin/env node
/**
 * The website and the desktop app parse resumes with the same code. The web
 * copies under web/lib/intelligence are canonical; the desktop copies must
 * match them (candidate-profile.js differs only in its require path). Also
 * covers the section rules that used to drop content from the profile.
 *
 * Run: node tests/test-parser-parity.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const ResumeParser = require(path.join(root, 'src/services/ai/resume-parser.js'));
const { buildCandidateProfile, extractTechnologies } = require(path.join(root, 'src/services/context/candidate-profile.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const sectionsOf = (text) => new ResumeParser().extractSections(text);

console.log('\nparser parity');

test('desktop resume-parser.js is byte-identical to the web copy', () => {
  assert(read('src/services/ai/resume-parser.js') === read('web/lib/intelligence/resume-parser.js'), 'copy web/lib/intelligence/resume-parser.js to src/services/ai/');
});

test('desktop candidate-profile.js differs from the web copy only in its require path', () => {
  const body = (s) => s.split('\n').filter((l) => !/resume-parser'\);$/.test(l) && !/^\/\/ (Path fixed|'\.\.\/ai|Desktop copy|require path)/.test(l)).join('\n');
  assert(body(read('src/services/context/candidate-profile.js')) === body(read('web/lib/intelligence/candidate-profile.js')), 'copy web/lib/intelligence/candidate-profile.js to src/services/context/ (keep the ../ai/ require)');
});

console.log('\nsection rules');

const RESUME = `Asha Rao
asha.rao@example.com | +91 98765 43210 | github.com/asha
CAREER OBJECTIVE
Backend engineer who likes making slow systems fast.
EXPERIENCE
Paytm — Software Engineer Jan 2022 - Present
Cut p99 checkout latency from 900ms to 240ms.
Tech Stack: Go, Kafka, PostgreSQL
Rewrote the ledger reconciliation job to run in 4 minutes instead of 2 hours.
Education: B.Tech Computer Science, NIT Trichy, 2021
PROJECTS
Ledgerly 2021
Double-entry ledger in Rust with a CRDT sync engine.
PUBLICATIONS
Fast reconciliation at scale, PyCon India 2023.
SKILLS
Go, Rust, Node.js, React, C#`;

test('Summary and objective content is kept, not dropped', () => {
  const p = buildCandidateProfile(RESUME);
  assert(p.summary.length === 1 && /slow systems fast/.test(p.summary[0].text), JSON.stringify(p.summary));
});

test('name and contact block is kept as contact, including short lines', () => {
  const p = buildCandidateProfile(RESUME);
  assert(p.contact.some((c) => c.text === 'Asha Rao'), JSON.stringify(p.contact));
});

test('"Tech Stack:" inside a job stays with that job and does not swallow the next bullet', () => {
  const s = sectionsOf(RESUME);
  const sectionOf = (needle) => s.find((i) => i.text.includes(needle))?.section;
  assert(sectionOf('Tech Stack: Go') === 'Experience', sectionOf('Tech Stack: Go'));
  assert(sectionOf('ledger reconciliation job') === 'Experience', sectionOf('ledger reconciliation job'));
});

test('"Education: ..." inside Experience still starts Education', () => {
  const s = sectionsOf(RESUME);
  assert(s.find((i) => i.text.includes('NIT Trichy'))?.section === 'Education');
});

test('a non-core section is kept under its own heading instead of leaking into the one above', () => {
  const p = buildCandidateProfile(RESUME);
  assert(p.additional.length === 1 && p.additional[0].heading === 'PUBLICATIONS', JSON.stringify(p.additional));
  assert(!p.projects.some((e) => e.bullets.some((b) => /PyCon/.test(b))), 'publication leaked into projects');
});

test('technologies: Go, Rust, Node.js, React, C#, Kafka are recognised', () => {
  const t = buildCandidateProfile(RESUME).technologies;
  for (const name of ['Go', 'Rust', 'Node', 'React', 'C#', 'Kafka', 'PostgreSQL']) assert(t.includes(name), `${name} missing from ${t}`);
});

test('technologies: everyday words are not read as technologies', () => {
  const t = extractTechnologies('We react to incidents, go to the next node, and keep guard rails at the helm.');
  assert(t.length === 0, JSON.stringify(t));
});

console.log(`\nParser parity tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
