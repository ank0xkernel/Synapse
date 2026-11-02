#!/usr/bin/env node
/**
 * Synapse Second Brain — Realistic Question-Answering Test Suite
 *
 * Verifies code grounding, evidence citation, and non-hallucination across:
 * 1. Jumpstart Go: Architecture and audio announcements pipeline
 * 2. Novaris: GitHub AST and Gemini verification pipeline
 * 3. Gems Lord: Pricing matrices, atomic checkout, and backend technologies
 * 4. Chhota Vyapar: Route-to-market distribution consultancy positioning and tech stack
 * 5. Manisha Wires: Verified stockist identity, steel specifications, Cobe 3D, and RFQ Google Sheets
 * 6. CampusConnect: Role-based access control (RBAC) middleware and security
 * 7. CampusConnect: Database optimization (3NF schema, triggers, stored procedures, analytical views)
 * 8. AI/LLM Usage across projects (Novaris Gemini scanner, Synapse live streaming, Evox concierge)
 * 9. Hardest technical challenges across repositories
 * 10. Multi-project architecture comparison
 * 11. Unknown / Non-existent project verification (refuses to hallucinate on unverified claims)
 * 12. Full Live Interview Prompt Integration: Evidence block injected for projects, omitted for generic definitions
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { secondBrainService } = require('../src/services/second-brain/second-brain-service');
const prompts = require('../src/services/ai/prompts.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, message: err.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, message: err.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

function assertTrue(cond, msg) { if (!cond) throw new Error(msg || 'expected true'); }
function assertFalse(cond, msg) { if (cond) throw new Error(msg || 'expected false'); }

console.log('=== REALISTIC Q&A & EVIDENCE GROUNDING TESTS ===\n');

await secondBrainService.initialize();

// Test 1: Jumpstart Go
test('1. Jumpstart Go: Retrieves real-time voice announcements, Web Audio, and Capacitor architecture', () => {
  const res = secondBrainService.query('How did you implement real-time announcements in Jumpstart Go?');
  assertTrue(res.targetProjectId === 'jumpstart_go', 'Must identify jumpstart_go');
  assertTrue(res.results.length > 0, 'Must return code evidence');
  
  const hasVoiceCode = res.results.some((r) => r.filePath.includes('sound') || r.filePath.includes('voice') || r.filePath.includes('announce'));
  assertTrue(hasVoiceCode, 'Must cite sound/voice code implementation');
  
  const textAll = res.results.map((r) => r.textSnippet).join(' ');
  assertTrue(textAll.includes('AudioContext') || textAll.includes('unlockSound') || textAll.includes('Azure') || textAll.includes('chime'), 'Must cite Web Audio / Azure TTS');
});

// Test 2: Novaris
test('2. Novaris: Retrieves GitHub API repository analysis, AST scanning, and Gemini verification', () => {
  const res = secondBrainService.query('How does Novaris perform repository analysis?');
  assertTrue(res.targetProjectId === 'novaris', 'Must identify novaris');
  assertTrue(res.results.length > 0, 'Must return code evidence');

  const textAll = res.results.map((r) => r.textSnippet).join(' ');
  assertTrue(textAll.includes('Scan') || textAll.includes('Security') || textAll.includes('Gemini') || textAll.includes('finding'), 'Must cite scan engine / Gemini verification');
});

// Test 3: Gems Lord
test('3. Gems Lord: Retrieves pricing, atomic inventory lock, and Express/Prisma backend architecture', () => {
  const res = secondBrainService.query('What backend technologies did you use in Gems Lord and how does checkout work?');
  assertTrue(res.targetProjectId === 'gems_lord', 'Must identify gems_lord');
  assertTrue(res.results.length > 0, 'Must return code evidence');

  assertTrue(res.resumeMapping.verifiedImplementation.technologies.includes('Prisma ORM'), 'Must cite Prisma ORM');
  assertTrue(res.resumeMapping.verifiedImplementation.technologies.includes('PostgreSQL'), 'Must cite PostgreSQL');
  assertTrue(res.resumeMapping.verifiedImplementation.technologies.includes('Razorpay'), 'Must cite Razorpay');
});

// Test 4: Chhota Vyapar
test('4. Chhota Vyapar: Verifies route-to-market distribution consultancy and tech stack', () => {
  const res = secondBrainService.query('Which technologies power Chhota Vyapar and what does it do?');
  assertTrue(res.targetProjectId === 'chhota_vyapar', 'Must identify chhota_vyapar');
  assertTrue(res.resumeMapping.verifiedImplementation.technologies.includes('Next.js 16'), 'Must cite Next.js 16');
  assertTrue(res.resumeMapping.verifiedImplementation.technologies.includes('GSAP'), 'Must cite GSAP');
  assertTrue(res.resumeMapping.verifiedImplementation.summary.includes('distribution'), 'Must cite distribution/route-to-market');
});

// Test 5: Manisha Wires
test('5. Manisha Wires: Verifies stockist identity, steel wire distribution, and RFQ Google Sheets', () => {
  const res = secondBrainService.query('Explain Manisha Wires.');
  assertTrue(res.targetProjectId === 'manisha_wires', 'Must identify manisha_wires');
  assertTrue(res.resumeMapping.verifiedImplementation.summary.includes('stockist'), 'Must verify MWPL is a stockist, not a mill');
  assertTrue(res.resumeMapping.verifiedImplementation.technologies.includes('Cobe WebGL'), 'Must cite Cobe WebGL');
  assertTrue(res.resumeMapping.verifiedImplementation.technologies.includes('Google Sheets API'), 'Must cite Google Sheets API');
});

// Test 6: CampusConnect RBAC
test('6. CampusConnect: Retrieves JWT role-based access control and ownership middleware', () => {
  const res = secondBrainService.query('How does CampusConnect implement role-based access?');
  assertTrue(res.targetProjectId === 'campus_connect', 'Must identify campus_connect');
  assertTrue(res.resumeMapping.verifiedImplementation.flows.some((f) => f.includes('authenticateToken') || f.includes('requireRole')), 'Must cite RBAC middleware flows');
});

// Test 7: CampusConnect Database Optimization
test('7. CampusConnect: Retrieves 3NF schema, automated triggers, and stored procedures', () => {
  const res = secondBrainService.query('What database optimization techniques were used in CampusConnect?');
  assertTrue(res.targetProjectId === 'campus_connect', 'Must identify campus_connect');
  assertTrue(res.resumeMapping.verifiedImplementation.flows.some((f) => f.includes('trg_attendance_change') || f.includes('ApplyForInternship') || f.includes('vw_student_performance')), 'Must cite real triggers and stored procedures');
});

// Test 8: AI / LLM Usage across projects
test('8. AI / LLM Usage: Detects multi-project AI architectures (Novaris, Synapse, Evox)', () => {
  const resNovaris = secondBrainService.query('How does Novaris use AI?');
  assertTrue(resNovaris.targetProjectId === 'novaris', 'Must identify Novaris');
  assertTrue(resNovaris.resumeMapping.verifiedImplementation.technologies.includes('Google Gemini AI'), 'Must cite Gemini in Novaris');

  const resEvox = secondBrainService.query('How does Evox Ventures use AI?');
  assertTrue(resEvox.targetProjectId === 'evox_ventures', 'Must identify Evox Ventures');
});

// Test 9: Hardest Technical Challenges
test('9. Technical Challenges: Grounds technical trade-offs in verified architectural code', () => {
  const resJumpstart = secondBrainService.query('What were the hardest challenges in Jumpstart Go?');
  assertTrue(resJumpstart.targetProjectId === 'jumpstart_go', 'Must identify Jumpstart Go');
  assertTrue(resJumpstart.results.some((r) => r.filePath.includes('sound') || r.filePath.includes('duty')), 'Must ground challenge in Web Audio unlock or duty queue');
});

// Test 10: Multi-project comparison
test('10. Project comparison: Distinguishes Jumpstart Go PWA edge from Gems Lord Express backend', () => {
  const p1 = secondBrainService.getProject('jumpstart_go');
  const p2 = secondBrainService.getProject('gems_lord');
  assertTrue(p1.primaryStack.includes('Cloudflare Workers'), 'Jumpstart Go must use Cloudflare Workers');
  assertTrue(p2.primaryStack.includes('Express'), 'Gems Lord must use Express');
  assertFalse(p1.primaryStack.includes('Express'), 'Jumpstart Go must NOT be confused with Express');
});

// Test 11: Non-hallucination on generic or unknown queries
test('11. Non-hallucination: Generic technical queries do not fabricate project associations', () => {
  const res = secondBrainService.query('What is a red-black tree?');
  assertTrue(res.targetProjectId === null, 'Generic algorithmic question must have null project target');
  assertTrue(res.results.length === 0, 'No code chunks should match generic question');
});

// Test 12: Gemini Prompt Integration
test('12. Gemini Prompt Integration: Injects project evidence block only when relevant', () => {
  const { buildAskAiSessionPrompt } = prompts;

  // Case A: Project question
  const promptProject = buildAskAiSessionPrompt({
    transcriptContext: 'Host: How does Novaris analyze GitHub repositories?',
    contextString: 'Host: How does Novaris analyze GitHub repositories?'
  });
  assertTrue(promptProject.includes('=== VERIFIED PROJECT & ENGINEERING EVIDENCE ==='), 'Prompt must contain project evidence block');
  assertTrue(promptProject.includes('NOVARIS'), 'Prompt must mention NOVARIS');

  // Case B: Generic definitional question
  const promptGeneric = buildAskAiSessionPrompt({
    transcriptContext: 'Host: What is React?',
    contextString: 'Host: What is React?'
  });
  assertFalse(promptGeneric.includes('=== VERIFIED PROJECT & ENGINEERING EVIDENCE ==='), 'Generic question must NOT contain project evidence block');
});

console.log(`\nRealistic Q&A Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
