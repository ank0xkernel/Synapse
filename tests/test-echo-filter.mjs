#!/usr/bin/env node
/**
 * echo-filter.js: the mic hearing the interviewer through the speakers must
 * not be stored as the user's own speech, and real user replies must survive.
 *
 * Run: node tests/test-echo-filter.mjs
 */
import { createEchoFilter, overlapRatio } from '../src/windows/assistant/renderer/features/transcription/echo-filter.js';

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

let clock = 0;
const filter = () => createEchoFilter({ now: () => clock });

test('Mic copy of a host question (STT wording drifts slightly) is an echo', () => {
  clock = 1000;
  const f = filter();
  f.noteHostFinal('Can you walk me through how you would design a rate limiter for an API?');
  clock = 2500;
  const result = f.check('can you walk me through how you design a rate limiter for the API');
  assert(result.echo, `ratio ${result.ratio}`);
});

test('A real answer that reuses some of the question words is not an echo', () => {
  clock = 1000;
  const f = filter();
  f.noteHostFinal('How would you design a rate limiter for an API?');
  clock = 3000;
  const result = f.check('I would use a token bucket per user stored in Redis with a sliding expiry');
  assert(!result.echo, `ratio ${result.ratio}`);
});

test('A short reply ("yes") after a host question containing "yes" is kept: short utterances need a full match', () => {
  clock = 1000;
  const f = filter();
  f.noteHostFinal('Is that a yes or a no?');
  clock = 2000;
  assert(!f.check('yes I think so').echo);
});

test('Echo of the live host partial (final not arrived yet) is still caught', () => {
  clock = 1000;
  const f = filter();
  f.noteHostPartial('tell me about a time you disagreed with your manager');
  clock = 1800;
  assert(f.check('tell me about a time you disagreed with your manager').echo);
});

test('Host speech older than the window no longer suppresses the mic', () => {
  clock = 1000;
  const f = filter();
  f.noteHostFinal('what is your biggest weakness');
  clock = 1000 + 7000;
  assert(!f.check('what is your biggest weakness').echo, 'the user repeating the question later is their own speech');
});

test('No host speech at all -> never an echo', () => {
  clock = 0;
  assert(!filter().check('hello there').echo);
});

test('overlapRatio counts repeated words only as often as the host said them', () => {
  assert(Math.abs(overlapRatio('no no no no', 'no') - 0.25) < 1e-9);
});

console.log(`\nEcho filter tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
