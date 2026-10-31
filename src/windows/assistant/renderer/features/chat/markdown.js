/**
 * Minimal, safe Markdown for streamed answers.
 *
 * Everything is HTML-escaped first; only the tags produced here are ever
 * emitted, so model output can never inject markup. Handles what answers
 * actually contain: paragraphs, headings, bullet and numbered lists,
 * blockquotes, fenced code (including a fence still open mid-stream), inline
 * code, bold and italic. No links or images: an answer read aloud in an
 * interview has no use for them, and they are the riskiest elements.
 */

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Inline formatting on already-escaped text. Code spans are protected first. */
function renderInline(escaped) {
  const codeSpans = [];
  let text = escaped.replace(/`([^`\n]+)`/g, (_match, code) => {
    codeSpans.push(code);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  text = text
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');

  return text.replace(/\u0000(\d+)\u0000/g, (_match, index) => `<code>${codeSpans[Number(index)]}</code>`);
}

function renderCodeBlock(language, code) {
  const label = language ? escapeHtml(language) : 'code';
  return '<div class="code-block">'
    + `<div class="code-head"><span class="code-lang">${label}</span>`
    + '<button type="button" class="code-copy" data-code-copy aria-label="Copy code">Copy</button></div>'
    + `<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre></div>`;
}

function renderBlocks(text) {
  const lines = text.split('\n');
  const html = [];
  let paragraph = [];
  let list = null; // { type: 'ul' | 'ol', items: [] }
  let quote = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${paragraph.map((line) => renderInline(escapeHtml(line))).join('<br>')}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      html.push(`<${list.type}>${list.items.map((item) => `<li>${renderInline(escapeHtml(item))}</li>`).join('')}</${list.type}>`);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      html.push(`<blockquote>${quote.map((line) => renderInline(escapeHtml(line))).join('<br>')}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) {
      flushAll();
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length + 2, 6);
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }

    const bullet = /^\s*[-*•]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      flushQuote();
      const type = bullet ? 'ul' : 'ol';
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push((bullet || numbered)[1]);
      continue;
    }

    const quoted = /^>\s?(.*)$/.exec(line);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line);
  }

  flushAll();
  return html.join('');
}

export function renderMarkdown(source) {
  const text = String(source ?? '').replace(/\r\n?/g, '\n');
  const parts = [];
  const fence = /```([\w#+.-]*)[^\n]*\n([\s\S]*?)(```|$)/g;
  let cursor = 0;
  let match;

  while ((match = fence.exec(text)) !== null) {
    if (match.index > cursor) parts.push(renderBlocks(text.slice(cursor, match.index)));
    // An unclosed fence (answer still streaming) renders as code so far.
    parts.push(renderCodeBlock(match[1], match[2]));
    cursor = fence.lastIndex;
    if (match[3] === '') break;
  }
  if (cursor < text.length) parts.push(renderBlocks(text.slice(cursor)));

  return parts.join('');
}
