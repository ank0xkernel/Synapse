#!/usr/bin/env node
/**
 * Answer style contract: every live answer prompt carries the Natural Expert
 * communication style plus the selected mode, and none of the format rules
 * that made answers read like templated articles come back.
 *
 * Run: node tests/test-answer-style.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const prompts = require(path.join(__dirname, '../src/services/ai/prompts.js'));
const { RESPONSE_MODES } = require(path.join(__dirname, '../src/services/ai/response-modes.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
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

const transcript = 'Host: How do you handle API failures?';
const build = (responseMode) => prompts.buildAskAiSessionPrompt({ contextString: transcript, transcriptContext: transcript, responseMode });

test('Natural Expert style is in every mode\'s prompt, before the mode block', () => {
  for (const id of Object.keys(RESPONSE_MODES)) {
    const text = build(id);
    const style = text.indexOf('COMMUNICATION STYLE: NATURAL EXPERT');
    const mode = text.indexOf('RESPONSE MODE:');
    assert(style > 0 && mode > style, `${id}: style ${style}, mode ${mode}`);
  }
});

test('Register examples are marked as tone guidance, not wording to reuse', () => {
  assert(/never reuse their wording/.test(build('professional')));
});

test('Adaptive length guidance covers quick, technical, experience and follow-up questions', () => {
  const text = build('professional');
  for (const marker of ['simple factual question', 'technical "how/why" question', 'project or experience question', 'follow-up: answer only the new point']) {
    assert(text.includes(marker), `missing: ${marker}`);
  }
});

test('No forced "Talking points" lists or comment-every-line rule', () => {
  const text = build('professional');
  assert(!/\*\*Talking points:\*\*/.test(text), 'Talking points template is back');
  assert(!/every line of code (in the solution )?MUST have a comment/i.test(text), 'comment-every-line rule is back');
});

test('Filler phrases are named as habits to avoid, without a replacement stock opener', () => {
  const text = build('quick');
  assert(text.includes('"Certainly"') && text.includes('"I would leverage"'));
  assert(/do not swap\s+in another stock opener/.test(text));
});

test('The no-fabrication rule survives in every mode', () => {
  for (const id of Object.keys(RESPONSE_MODES)) {
    assert(/Never invent an employer, project, metric, or result/.test(build(id)), id);
  }
});

console.log(`\nAnswer style tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
