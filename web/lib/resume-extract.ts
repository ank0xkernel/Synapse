import 'server-only';
import { AiResumeUnavailable, aiConfigured, ocrPdf } from './ai-resume';
import { DocxError, docxText } from './docx';
import { ApiError } from './http';

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Bumped whenever the parser output changes, so older rows can be found and reprocessed. */
export const PARSER_VERSION = 3;
export const MAX_TEXT_CHARS = 200_000;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type ExtractionMethod = 'text' | 'pdf' | 'ocr' | 'docx';

export interface Extraction {
  text: string;
  method: ExtractionMethod;
}

export interface Extracted extends Extraction {
  mime: 'application/pdf' | 'text/plain' | typeof DOCX_MIME;
  keepBytes: boolean;
}

/** Under this many letters the PDF has no usable text layer: a scan, or text drawn as images. */
const MIN_LETTERS = 40;

/** Never truncates: text over the limit is rejected so nothing is silently lost. */
function limit(text: string): string {
  if (text.length > MAX_TEXT_CHARS) throw new ApiError(413, `This resume has more than ${MAX_TEXT_CHARS.toLocaleString('en-US')} characters of text, which is more than Synapse keeps. Remove unneeded pages and try again.`);
  return text;
}

const tidy = (t: string) => t.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

/**
 * PDF bytes to text. A PDF without a text layer is read by OCR when AI is configured.
 * Throws ApiError 415/422/413 with a message that says what is wrong.
 */
export async function extractPdfText(buf: Buffer): Promise<{ text: string; method: 'pdf' | 'ocr' }> {
  if (buf.length === 0) throw new ApiError(400, 'The file is empty');
  if (buf.length > MAX_FILE_BYTES) throw new ApiError(413, 'File is larger than 8 MB');
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new ApiError(415, 'That file is not a valid PDF');
  let text = '';
  try {
    // The package root runs a debug routine when imported without a parent; the lib entry does not.
    const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
    // pdf-parse's bundled pdf.js keeps state between calls: on Linux a valid
    // PDF parsed right after a damaged one fails with "bad XRef entry", while
    // the same bytes parse fine on their own. Each attempt gets its own copy
    // of the bytes, and one retry separates that leftover state from a file
    // that is really unreadable.
    const parse = async () => tidy(String((await pdfParse(Buffer.from(buf))).text || ''));
    text = await parse().catch(parse);
  } catch (error) {
    // The parser's own reason, for diagnosing real files; never the file contents.
    console.warn(JSON.stringify({ level: 'warn', event: 'pdf_parse_failed', reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) }));
    throw new ApiError(422, 'This PDF could not be read. It may be encrypted, password protected or damaged.');
  }
  if (letters(text) >= MIN_LETTERS) return { text: limit(text), method: 'pdf' };

  if (!aiConfigured()) {
    throw new ApiError(422, 'No text could be extracted. This PDF looks like a scan or an image, and reading scanned pages needs AI, which is not set up on this server. Export a text-based PDF, upload a Word file, or paste the text instead.');
  }
  let scanned = '';
  try {
    scanned = tidy(await ocrPdf(buf));
  } catch (e) {
    if (!(e instanceof AiResumeUnavailable)) throw e;
    throw new ApiError(503, 'This PDF is a scan, and the text reader is not responding right now. Try again in a minute, or paste the text instead.');
  }
  if (letters(scanned) < MIN_LETTERS) throw new ApiError(422, 'No readable text was found in this PDF, even after scanning the pages. Check that it is the right file, or paste the text instead.');
  return { text: limit(scanned), method: 'ocr' };
}

const letters = (t: string) => (t.match(/\p{L}/gu) ?? []).length;

/** Validates by content, not by the filename or declared type the client sent. */
export async function extractResume(buf: Buffer, fileName: string): Promise<Extracted> {
  if (buf.length === 0) throw new ApiError(400, 'The file is empty');
  if (buf.length > MAX_FILE_BYTES) throw new ApiError(413, 'File is larger than 8 MB');
  const lower = fileName.toLowerCase();

  if (lower.endsWith('.pdf')) {
    return { mime: 'application/pdf', ...(await extractPdfText(buf)), keepBytes: true };
  }

  if (lower.endsWith('.docx')) {
    let text: string;
    try {
      text = tidy(docxText(buf));
    } catch (e) {
      if (!(e instanceof DocxError)) throw e;
      throw new ApiError(415, 'That file is not a readable Word document (.docx). Older .doc files are not supported: save it as .docx or PDF.');
    }
    if (!text) throw new ApiError(422, 'The Word document has no text');
    return { mime: DOCX_MIME, text: limit(text), method: 'docx', keepBytes: false };
  }

  if (lower.endsWith('.txt') || lower.endsWith('.md')) {
    if (buf.includes(0)) throw new ApiError(415, 'That file is not plain text');
    const text = tidy(buf.toString('utf8'));
    if (!text) throw new ApiError(422, 'The file has no text');
    return { mime: 'text/plain', text: limit(text), method: 'text', keepBytes: false };
  }
  if (lower.endsWith('.doc')) throw new ApiError(415, 'Older Word .doc files are not supported. Save it as .docx or PDF and upload that.');
  throw new ApiError(415, 'Only PDF, Word (.docx), TXT and MD files are accepted');
}
