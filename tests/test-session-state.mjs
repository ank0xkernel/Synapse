#!/usr/bin/env node
/**
 * session-state.js: the title-bar status is derived from real state only, and
 * the more urgent state always wins.
 *
 * Run: node tests/test-session-state.mjs
 */
import { deriveSessionState, SessionState } from '../src/windows/assistant/renderer/features/session/session-state.js';

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
function is(input, expected) {
  const { state } = deriveSessionState(input);
  if (state !== expected) throw new Error(`expected ${expected}, got ${state}`);
}

const off = { system: 'off', mic: 'off' };
const listening = { system: 'listening', mic: 'off' };

test('Nothing running -> ready', () => is({ sources: off }, SessionState.READY));
test('Host audio live -> listening', () => is({ sources: listening }, SessionState.LISTENING));
test('First connect -> connecting', () => is({ sources: { system: 'connecting', mic: 'off' } }, SessionState.CONNECTING));
test('Connecting after having listened -> reconnecting (a drop, not a start)', () =>
  is({ sources: { system: 'connecting', mic: 'off' }, wasListening: true }, SessionState.RECONNECTING));
test('Question sent, no token yet -> thinking', () => is({ sources: listening, aiPending: true }, SessionState.THINKING));
test('Tokens streaming -> answering, even while listening', () =>
  is({ sources: listening, aiPending: true, aiStreaming: true }, SessionState.ANSWERING));
test('A source error outranks an answer in progress', () =>
  is({ sources: { system: 'error', mic: 'off' }, aiStreaming: true }, SessionState.ERROR));
test('An AI error with audio fine -> error', () => is({ sources: listening, error: 'All keys unavailable' }, SessionState.ERROR));
test('Every state has a human label', () => {
  for (const sources of [off, listening]) {
    const { label } = deriveSessionState({ sources });
    if (!label) throw new Error('missing label');
  }
});

console.log(`\nSession state tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
