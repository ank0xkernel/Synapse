'use strict';

const path = require('path');
const { SECOND_BRAIN_CONFIG } = require('./config');
const { scrubSecrets } = require('./security-scrubber');

/**
 * Syntax-Aware Chunker
 *
 * Chunks source code and documentation along logical syntactic boundaries
 * (functions, classes, route blocks, markdown sections, schema models)
 * rather than arbitrary character offsets.
 */

class Chunker {
  chunkFile(filePath, content, symbols = [], projectId = '') {
    if (!content || typeof content !== 'string') return [];
    const lines = content.split('\n');
    const totalLines = lines.length;

    if (totalLines <= SECOND_BRAIN_CONFIG.chunkSize + 5) {
      // Small file: single unified chunk
      const text = scrubSecrets(content);
      return [{
        id: `${projectId}:${filePath}:L1-L${totalLines}`,
        projectId,
        filePath,
        startLine: 1,
        endLine: totalLines,
        text,
        symbols: symbols.map((s) => s.name),
        summary: this.generateChunkSummary(filePath, 1, totalLines, symbols)
      }];
    }

    // Larger file: chunk with overlap, snapping to symbols when possible
    const chunks = [];
    const step = SECOND_BRAIN_CONFIG.chunkSize - SECOND_BRAIN_CONFIG.chunkOverlap;

    for (let start = 0; start < totalLines; start += step) {
      let end = Math.min(start + SECOND_BRAIN_CONFIG.chunkSize, totalLines);

      // Snap chunk boundary to a nearby symbol if available
      const nearbySymbol = symbols.find((s) => Math.abs(s.line - end) <= 5);
      if (nearbySymbol && nearbySymbol.line > start + 10) {
        end = nearbySymbol.line;
      }

      const chunkLines = lines.slice(start, end);
      const chunkText = scrubSecrets(chunkLines.join('\n'));
      const startLine = start + 1;
      const endLine = end;

      const chunkSymbols = symbols.filter((s) => s.line >= startLine && s.line <= endLine);

      chunks.push({
        id: `${projectId}:${filePath}:L${startLine}-L${endLine}`,
        projectId,
        filePath,
        startLine,
        endLine,
        text: chunkText,
        symbols: chunkSymbols.map((s) => s.name),
        summary: this.generateChunkSummary(filePath, startLine, endLine, chunkSymbols)
      });

      if (end >= totalLines) break;
    }

    return chunks;
  }

  generateChunkSummary(filePath, startLine, endLine, symbols) {
    const filename = path.basename(filePath);
    const symList = symbols.slice(0, 4).map((s) => `${s.kind}:${s.name}`).join(', ');
    return `[${filename}#L${startLine}-L${endLine}] ${symList || 'Source block'}`;
  }
}

module.exports = {
  Chunker,
  chunker: new Chunker()
};

