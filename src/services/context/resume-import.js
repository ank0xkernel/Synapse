'use strict';

/**
 * Reads a resume file chosen on this Mac and returns its plain text.
 *
 * Validates before parsing (type, size, real PDF signature) and fails with a
 * coded, user-facing error instead of ever storing binary noise. Scanned
 * PDFs (images without a text layer) are reported as NO_TEXT: Synapse does
 * not OCR, and saying so is better than saving an empty resume.
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = new Set(['.pdf', '.txt', '.md']);

class ResumeImportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function flattenSections(sections) {
  if (Array.isArray(sections)) {
    return sections.map((section) => (typeof section === 'string' ? section : section?.text || '')).filter(Boolean).join('\n');
  }
  if (sections && typeof sections === 'object') {
    return Object.values(sections).flat().map((entry) => (typeof entry === 'string' ? entry : entry?.text || '')).filter(Boolean).join('\n');
  }
  return '';
}

/**
 * @param {string} filePath
 * @param {{ parser?: { parseResume(file: string): Promise<unknown> } }} [deps]
 * @returns {Promise<{ text: string, fileName: string, bytes: number }>}
 */
async function extractResumeText(filePath, deps = {}) {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  if (!ALLOWED.has(extension)) {
    throw new ResumeImportError('UNSUPPORTED_TYPE', 'Choose a PDF, .txt or .md resume.');
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    throw new ResumeImportError('NOT_FOUND', 'That file could not be opened.');
  }
  if (stat.size === 0) throw new ResumeImportError('NO_TEXT', 'That file is empty.');
  if (stat.size > MAX_BYTES) throw new ResumeImportError('TOO_LARGE', 'Resumes must be 8 MB or smaller.');

  if (extension === '.pdf') {
    const head = Buffer.alloc(5);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, head, 0, 5, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (head.toString('latin1') !== '%PDF-') {
      throw new ResumeImportError('NOT_A_PDF', 'That file is not a valid PDF.');
    }
  }

  const parser = deps.parser || new (require('../ai/resume-parser'))();
  let text;
  try {
    // Store the raw extracted text, headings included. The section parser
    // drops heading lines, and saving its output lost the structure that
    // later decides what counts as experience vs projects vs education.
    text = extension === '.pdf'
      ? (typeof parser.extractPdfText === 'function'
        ? await parser.extractPdfText(filePath)
        : flattenSections(await parser.parseResume(filePath)))
      : fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ResumeImportError('PARSE_FAILED', `The PDF could not be read (${error.message}). Try exporting it again, or paste the text instead.`);
  }

  text = String(text || '').replace(/\u0000/g, '').trim();
  if (!text) {
    throw new ResumeImportError(
      'NO_TEXT',
      extension === '.pdf'
        ? 'No text could be found in this PDF. It is probably a scanned image; Synapse does not read images. Export a text-based PDF, or paste the resume text instead.'
        : 'That file has no text.'
    );
  }

  return { text, fileName: path.basename(filePath), bytes: stat.size };
}

module.exports = { extractResumeText, ResumeImportError, MAX_BYTES };
