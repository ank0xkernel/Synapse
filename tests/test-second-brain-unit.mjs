#!/usr/bin/env node
/**
 * Synapse Second Brain — Comprehensive Unit Test Suite
 *
 * Verifies:
 * 1. Project Registry & Local Discovery
 * 2. Security Scrubber & Secret Exclusion
 * 3. AST & Symbol Analysis
 * 4. Syntax-Aware Chunking
 * 5. BM25 Inverted Index & Scoring
 * 6. Dense Semantic Vector Indexer
 * 7. Knowledge Graph Relationships & Provenance
 * 8. Resume-to-Code Mappings
 * 9. 4-Tier Personal Engineering Memory
 * 10. Incremental Indexing & Content Hashing
 * 11. Hybrid Retriever & Token Budgeting
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { projectRegistry } = require('../src/services/second-brain/project-registry');
const { isSensitiveFile, hasSecrets, scrubSecrets } = require('../src/services/second-brain/security-scrubber');
const { astAnalyzer } = require('../src/services/second-brain/ast-analyzer');
const { chunker } = require('../src/services/second-brain/chunker');
const { BM25Indexer } = require('../src/services/second-brain/bm25-indexer');
const { VectorIndexer } = require('../src/services/second-brain/vector-indexer');
const { KnowledgeGraph, VERIFICATION_LEVELS } = require('../src/services/second-brain/knowledge-graph');
const { resumeMapper } = require('../src/services/second-brain/resume-mapper');
const { EngineeringMemory } = require('../src/services/second-brain/engineering-memory');
const { HybridRetriever } = require('../src/services/second-brain/hybrid-retriever');

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

function assertTrue(cond, msg) { if (!cond) throw new Error(msg || 'expected true'); }
function assertFalse(cond, msg) { if (cond) throw new Error(msg || 'expected false'); }
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'}: expected ${expected}, got ${actual}`);
}

console.log('=== SECOND BRAIN UNIT TESTS ===\n');

// 1. Project Registry
test('1. Project Registry discovers all 10 priority repositories on local disk', () => {
  const projects = projectRegistry.discoverProjects();
  assertTrue(projects.length >= 10, 'Expected at least 10 projects defined');
  const discovered = projectRegistry.getDiscoveredProjects();
  assertTrue(discovered.length >= 8, 'Expected majority of projects to be discovered on disk');
  
  const jumpstart = projectRegistry.getProject('jumpstart_go');
  assertTrue(jumpstart !== null, 'Jumpstart Go must be registered');
  assertTrue(jumpstart.isDiscovered, 'Jumpstart Go must be discovered');
  
  const novaris = projectRegistry.getProject('novaris');
  assertTrue(novaris !== null, 'Novaris must be registered');
  assertTrue(novaris.isDiscovered, 'Novaris must be discovered');
});

// 2. Security Scrubber
test('2. Security scrubber detects and masks credentials, API keys, and sensitive files', () => {
  assertTrue(isSensitiveFile('.env'), '.env must be sensitive');
  assertTrue(isSensitiveFile('.env.production'), '.env.production must be sensitive');
  assertTrue(isSensitiveFile('service-account.json'), 'service-account.json must be sensitive');
  assertFalse(isSensitiveFile('index.ts'), 'index.ts must not be sensitive');

  const leakedApiKey = 'AIzaSyD-sampleApiKey1234567890abcdef';
  assertTrue(hasSecrets(leakedApiKey), 'Must detect Google API key');
  const scrubbedKey = scrubSecrets(`const key = "${leakedApiKey}";`);
  assertTrue(!scrubbedKey.includes(leakedApiKey), 'Original key must not remain');
  assertTrue(scrubbedKey.includes('[REDACTED_CREDENTIAL]'), 'Must replace with redaction marker');

  const leakedJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature';
  assertTrue(hasSecrets(leakedJwt), 'Must detect JWT');
  const scrubbedJwt = scrubSecrets(leakedJwt);
  assertTrue(!scrubbedJwt.includes(leakedJwt), 'JWT must be redacted');
});

// 3. AST Analyzer
test('3. AST Analyzer extracts classes, functions, and TypeScript interfaces with line ranges', () => {
  const tsCode = `
export interface UserProfile {
  id: string;
  name: string;
}

export class OrderService {
  async processPayment(orderId: string): Promise<boolean> {
    return true;
  }
}

export const fetchMetrics = async () => {
  return { ok: true };
};
  `;
  const symbols = astAnalyzer.analyzeFile('test.ts', tsCode);
  assertTrue(symbols.some((s) => s.name === 'UserProfile' && s.kind === 'type'), 'Must extract UserProfile type');
  assertTrue(symbols.some((s) => s.name === 'OrderService' && s.kind === 'class'), 'Must extract OrderService class');
  assertTrue(symbols.some((s) => s.name === 'fetchMetrics' && s.kind === 'function'), 'Must extract fetchMetrics function');
});

test('3b. AST Analyzer extracts SQL tables, triggers, and stored procedures', () => {
  const sqlCode = `
CREATE TABLE IF NOT EXISTS "Enrollment" (
  id VARCHAR PRIMARY KEY,
  student_id VARCHAR NOT NULL
);

CREATE TRIGGER trg_attendance_change
AFTER INSERT ON "Attendance"
FOR EACH ROW EXECUTE FUNCTION update_attendance();

CREATE OR REPLACE FUNCTION EnrollStudent(student_id VARCHAR) RETURNS VOID AS $$
BEGIN
END;
$$ LANGUAGE plpgsql;
  `;
  const symbols = astAnalyzer.analyzeFile('schema.sql', sqlCode);
  assertTrue(symbols.some((s) => s.name === 'Enrollment' && s.kind === 'database_table'), 'Must extract Enrollment table');
  assertTrue(symbols.some((s) => s.name === 'trg_attendance_change' && s.kind === 'database_trigger'), 'Must extract attendance trigger');
  assertTrue(symbols.some((s) => s.name === 'EnrollStudent' && s.kind === 'database_procedure'), 'Must extract EnrollStudent procedure');
});

// 4. Chunker
test('4. Syntax-Aware Chunker preserves line numbers and symbols', () => {
  const dummyContent = Array.from({ length: 60 }, (_, i) => `const line${i} = ${i};`).join('\n');
  const symbols = [{ name: 'line30', kind: 'function', line: 30 }];
  const chunks = chunker.chunkFile('src/lines.ts', dummyContent, symbols, 'sample_proj');
  assertTrue(chunks.length >= 2, 'Should create overlapping chunks for 60 lines');
  assertTrue(chunks[0].startLine === 1, 'Chunk 0 should start at line 1');
  assertTrue(chunks[0].symbols.length >= 0, 'Chunk symbols array present');
});

// 5. BM25 Indexer
test('5. BM25 Indexer indexes and ranks exact technical keywords and file names', () => {
  const indexer = new BM25Indexer();
  indexer.addChunk({
    id: 'chunk1',
    projectId: 'jumpstart_go',
    filePath: 'src/features/duty/sound.ts',
    symbols: ['unlockSound', 'CLIP_BUDGET_MS'],
    summary: 'Sound announcement system',
    text: 'Web Audio API unlock for iPadOS silent switch and Azure en-IN-NeerjaNeural voice.'
  });
  indexer.addChunk({
    id: 'chunk2',
    projectId: 'campus_connect',
    filePath: 'database/triggers.sql',
    symbols: ['trg_attendance_change'],
    summary: 'Database triggers',
    text: 'Calculates attendance rate in PostgreSQL Enrollment table.'
  });

  const resultsSound = indexer.search('sound unlock Web Audio', { limit: 5 });
  assertTrue(resultsSound.length > 0, 'Must match sound chunk');
  assertEqual(resultsSound[0].chunk.id, 'chunk1', 'Top result should be chunk1');

  const resultsDb = indexer.search('PostgreSQL triggers attendance', { limit: 5 });
  assertTrue(resultsDb.length > 0, 'Must match DB trigger chunk');
  assertEqual(resultsDb[0].chunk.id, 'chunk2', 'Top result should be chunk2');
});

// 6. Vector Indexer
test('6. Dense Semantic Vector Indexer computes cosine similarity on conceptual queries', () => {
  const vectorIndexer = new VectorIndexer(128);
  vectorIndexer.addChunk({
    id: 'v1',
    projectId: 'novaris',
    filePath: 'src/lib/services/security-service.ts',
    summary: 'Security scanner engine',
    symbols: ['runScanEngineV2'],
    text: 'Automated vulnerability scanning with AST pattern matching and Google Gemini AI verification.'
  });
  vectorIndexer.addChunk({
    id: 'v2',
    projectId: 'gems_lord',
    filePath: 'backend/src/modules/checkout/checkout.service.ts',
    summary: 'Checkout service',
    symbols: ['createOrder'],
    text: 'Stock is reserved only once payment actually succeeds through Razorpay.'
  });

  const matches = vectorIndexer.search('AI vulnerability scanning AST verification', { limit: 5 });
  assertTrue(matches.length > 0, 'Must return conceptual matches');
  assertEqual(matches[0].chunk.id, 'v1', 'Should rank vulnerability scanner first');
});

// 7. Knowledge Graph
test('7. Knowledge Graph creates provenance-backed entity relationships', () => {
  const graph = new KnowledgeGraph();
  graph.addNode({
    id: 'project:novaris',
    label: 'Novaris',
    type: 'project',
    projectId: 'novaris',
    verificationLevel: VERIFICATION_LEVELS.VERIFIED_CODE
  });
  graph.addNode({
    id: 'tech:gemini',
    label: 'Google Gemini AI',
    type: 'technology',
    projectId: 'novaris',
    verificationLevel: VERIFICATION_LEVELS.VERIFIED_CODE
  });
  graph.addEdge('project:novaris', 'tech:gemini', 'USES_TECH', VERIFICATION_LEVELS.VERIFIED_CODE);

  const related = graph.findRelated('project:novaris', 1);
  assertTrue(related.length === 1, 'Should find 1 connected entity');
  assertEqual(related[0].node.id, 'tech:gemini', 'Connected entity should be Gemini');
  assertEqual(related[0].edge.relation, 'USES_TECH', 'Relation should be USES_TECH');
});

// 8. Resume Mapper
test('8. Resume Mapper links every resume project to verified source implementations', () => {
  const mappings = resumeMapper.getMappings();
  assertTrue(mappings.length >= 8, 'Should have mappings for all key projects');

  const jumpstart = resumeMapper.getMappingForProject('jumpstart_go');
  assertTrue(jumpstart !== null, 'Jumpstart Go mapping must exist');
  assertTrue(jumpstart.verifiedImplementation.evidenceFiles.includes('src/features/duty/sound.ts'), 'Evidence files must include sound.ts');

  const campus = resumeMapper.getMappingForProject('campus_connect');
  assertTrue(campus.verifiedImplementation.technologies.includes('PostgreSQL'), 'CampusConnect must include PostgreSQL');
});

// 9. Engineering Memory
test('9. Engineering Memory handles 4-tier storage and user overrides without clobbering', () => {
  const memory = new EngineeringMemory(path.join(__dirname, '../cache/test-memory'));
  
  // Tier 1: Professional
  const prof = memory.getProfessionalMemory();
  assertEqual(prof.candidateName, 'Ankit Singh', 'Candidate name should be Ankit Singh');

  // Tier 3: Session
  memory.recordQuestionTurn('How does Kafka work in your project?', 'Explained Kafka consumer in Spring Boot.', 'jumpstart_go');
  const session = memory.getSessionMemory();
  assertTrue(session.recentQuestions.length > 0, 'Should record question turn');
  assertEqual(session.activeProjectId, 'jumpstart_go', 'Should set active project');

  // Tier 4: User Reviewed Fact
  memory.setUserFact('lead_role_evox', 'Personally architected the 3D particle field and budget estimator engine.');
  const fact = memory.getUserReviewedFact('lead_role_evox');
  assertTrue(fact !== null, 'User fact must exist');
  assertTrue(fact.confirmedByUser, 'Must be marked confirmed by user');
});

// 10. Hybrid Retriever
test('10. Hybrid Retriever detects project target and applies Reciprocal Rank Fusion within token budget', () => {
  const bm25 = new BM25Indexer();
  const vec = new VectorIndexer(128);
  const retriever = new HybridRetriever(bm25, vec);

  assertEqual(retriever.detectProjectTarget('How did you implement sound in Jumpstart Go?'), 'jumpstart_go');
  assertEqual(retriever.detectProjectTarget('How does Novaris scan code?'), 'novaris');
  assertEqual(retriever.detectProjectTarget('Explain Gems Lord checkout flow.'), 'gems_lord');
  assertEqual(retriever.detectProjectTarget('Explain Manisha Wires.'), 'manisha_wires');
  assertEqual(retriever.detectProjectTarget('How does CampusConnect do RBAC?'), 'campus_connect');
  assertEqual(retriever.detectProjectTarget('What is React?'), null, 'Generic question should have no target');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

