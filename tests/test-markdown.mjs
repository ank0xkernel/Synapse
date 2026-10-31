#!/usr/bin/env node
/**
 * markdown.js: streamed answers render as formatted, safe HTML.
 *
 * Run: node tests/test-markdown.mjs
 */
import { renderMarkdown, escapeHtml } from '../src/windows/assistant/renderer/features/chat/markdown.js';

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

test('Model output containing HTML is escaped, never rendered as markup', () => {
  const html = renderMarkdown('Hello <img src=x onerror="alert(1)"> and <script>x()</script>');
  assert(!html.includes('<img') && !html.includes('<script'), html);
  assert(html.includes('&lt;img'), html);
});

test('HTML inside a code block is escaped too', () => {
  const html = renderMarkdown('```html\n<div onclick="x()">hi</div>\n```');
  assert(html.includes('&lt;div onclick=&quot;x()&quot;&gt;'), html);
  assert(html.includes('class="code-lang">html<'), 'language label');
});

test('Bullets, numbered lists and paragraphs', () => {
  const html = renderMarkdown('Intro line\n\n- one\n- **two**\n\n1. first\n2. second');
  assert(html.includes('<p>Intro line</p>'));
  assert(html.includes('<ul><li>one</li><li><strong>two</strong></li></ul>'), html);
  assert(html.includes('<ol><li>first</li><li>second</li></ol>'), html);
});

test('Inline code is not re-formatted (asterisks inside stay literal)', () => {
  const html = renderMarkdown('Use `a*b*c` here');
  assert(html.includes('<code>a*b*c</code>'), html);
});

test('An unclosed fence mid-stream renders as a code block, not raw backticks', () => {
  const html = renderMarkdown('Here:\n```python\ndef f():\n    return 1');
  assert(html.includes('<pre><code>def f():\n    return 1</code></pre>'), html);
  assert(!html.includes('```'));
});

test('Headings map to h3-h6, never page-level h1/h2', () => {
  const html = renderMarkdown('# Big\n## Smaller');
  assert(html.includes('<h3>Big</h3>') && html.includes('<h4>Smaller</h4>'), html);
});

test('Snake_case identifiers are not italicised', () => {
  const html = renderMarkdown('call get_user_id now');
  assert(!html.includes('<em>'), html);
});

test('escapeHtml covers quotes and ampersands', () => {
  assert(escapeHtml(`a&b "c" 'd'`) === 'a&amp;b &quot;c&quot; &#39;d&#39;');
});

console.log(`\nMarkdown tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
