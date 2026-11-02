import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksLikeQuestion, scoreQuestionCompleteness, createQuestionDetector } from '../src/windows/assistant/renderer/features/auto-answer/question-detector.js';
import { shouldSupersede } from '../src/windows/assistant/renderer/features/auto-answer/supersede-policy.js';
import { createGeminiSpeechService } from '../src/services/stt/gemini-speech-service.js';
import { createAssemblyAiService } from '../src/services/assembly-ai/service.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Cursor consistency across Synapse application interface', () => {
  const css = fs.readFileSync(path.join(root, 'src', 'windows', 'assistant', 'ui', 'app.css'), 'utf8');

  // Universal default arrow cursor
  assert.match(css, /\*,\s*\*::before,\s*\*::after\s*\{[^}]*cursor:\s*default\s*!important/);
  assert.match(css, /html,\s*body\s*\{[^}]*cursor:\s*default\s*!important/);

  // Buttons, inputs, textareas, selects, links
  assert.match(css, /button,\s*input,\s*select,\s*textarea,\s*a,\s*summary[^}]*cursor:\s*default\s*!important/);

  // Resize handles keep their specific resize cursors
  assert.match(css, /\.resize-handle-n,\s*\.resize-handle-s\s*\{[^}]*cursor:\s*ns-resize\s*!important/);
  assert.match(css, /\.resize-handle-e,\s*\.resize-handle-w\s*\{[^}]*cursor:\s*ew-resize\s*!important/);
  assert.match(css, /\.resize-handle-ne[^{]*\{[^}]*cursor:\s*nesw-resize\s*!important/);
  assert.match(css, /\.resize-handle-se[^{]*\{[^}]*cursor:\s*nwse-resize\s*!important/);

  // No leftover cursor: pointer in assistant CSS
  assert.doesNotMatch(css, /cursor:\s*pointer/);

  // Companion HTML also enforces default cursor
  const companionHtml = fs.readFileSync(path.join(root, 'src', 'main-process', 'features', 'mobile-server', 'companion.html'), 'utf8');
  assert.doesNotMatch(companionHtml, /cursor:\s*pointer/);
});

test('Real-time question detection accurately scores completeness', () => {
  assert.equal(looksLikeQuestion('How would you scale a PostgreSQL database with high read traffic?'), true);
  assert.equal(looksLikeQuestion('Tell me about a time you resolved a difficult production incident.'), true);
  assert.equal(looksLikeQuestion('Can you explain your experience with Next.js and React?'), true);
  assert.equal(looksLikeQuestion('mm-hm'), false);
  assert.equal(looksLikeQuestion('Yeah okay so'), false);

  // Ends in question mark -> high completeness score
  const finishedScore = scoreQuestionCompleteness('How would you design an API rate limiter?');
  assert.ok(finishedScore >= 0.95, `Expected score >= 0.95 for ?, got ${finishedScore}`);

  // Ends on trailing conjunction/token -> low completeness score
  const danglingScore = scoreQuestionCompleteness('How would you design an API rate limiter and');
  assert.ok(danglingScore <= 0.3, `Expected score <= 0.3 for dangling conjunction, got ${danglingScore}`);

  // Complete-looking clause without ?
  const completeClause = scoreQuestionCompleteness('Walk me through your architectural approach to caching');
  assert.ok(completeClause >= 0.6, `Expected score >= 0.6 for complete statement, got ${completeClause}`);
});

test('Question detector tracks climbing confidence', () => {
  const detector = createQuestionDetector();
  const r1 = detector.update('How');
  assert.equal(r1.score, 0); // under 12 chars

  const r2 = detector.update('How would you scale this system and');
  assert.ok(r2.score > 0);
  assert.equal(r2.rising, true);

  const r3 = detector.update('How would you scale this system?');
  assert.ok(r3.score >= 0.95);
  assert.equal(r3.rising, true);
  assert.ok(r3.score > r2.score);
});

test('Intelligent auto-scroll and Jump to Latest DOM element exists and is styled', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'windows', 'assistant', 'renderer.html'), 'utf8');
  assert.match(html, /id="chat-jump-latest"/);
  assert.match(html, /class="chat-jump-latest\s+hidden"/);

  const css = fs.readFileSync(path.join(root, 'src', 'windows', 'assistant', 'ui', 'app.css'), 'utf8');
  assert.match(css, /\.chat-jump-latest\s*\{/);
  assert.match(css, /\.chat-jump-latest\.hidden\s*\{/);
});

test('Gemini Speech service supports fallback mode and eager transcription', () => {
  let mode = 'auto';
  const service = createGeminiSpeechService({
    getApiKey: () => 'test-key',
    getMode: () => mode,
    emitSttDebug: () => {},
    onTranscript: () => {}
  });

  assert.equal(typeof service.setFallbackMode, 'function');
  assert.equal(typeof service.isFallbackMode, 'function');
  assert.equal(typeof service.hasApiKey, 'function');
  assert.equal(service.hasApiKey(), true);
  assert.equal(service.isFallbackMode(), false);

  service.setFallbackMode(true);
  assert.equal(service.isFallbackMode(), true);

  service.dispose();
});

test('AssemblyAI service activates Gemini Speech fallback on missing or disabled credentials', () => {
  const messages = [];
  const fakeGeminiSpeech = {
    fallback: false,
    setFallbackMode(val) { this.fallback = val; },
    isFallbackMode() { return this.fallback; },
    hasApiKey() { return true; },
    handleAudioChunk() {}
  };

  const service = createAssemblyAiService({
    WebSocket: class FakeWS {},
    desktopCapturer: {},
    getAssemblyApiKey: () => '', // No key configured
    getSpeechModel: () => 'universal-streaming-english',
    getGeminiService: () => ({}),
    sendToRenderer: (event, payload) => {
      messages.push({ event, payload });
    },
    getSttMode: () => 'auto',
    geminiSpeech: fakeGeminiSpeech
  });

  const res = service.startAssemblyAiStream('system');
  assert.equal(res.success, true);
  assert.equal(fakeGeminiSpeech.fallback, true);

  const statusMsg = messages.find(m => m.event === 'vosk-status');
  assert.ok(statusMsg, 'Expected vosk-status event');
  assert.equal(statusMsg.payload.status, 'listening');
  assert.match(statusMsg.payload.message, /Gemini STT/);
});
