import 'server-only';
import { ApiError } from './http';

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Bumped whenever the parser output changes, so older rows can be found and reprocessed. */
export const PARSER_VERSION = 2;
export const MAX_TEXT_CHARS = 200_000;

export interface Extracted {
  mime: 'application/pdf' | 'text/plain';
  text: string;
  keepBytes: boolean;
}

/** Never truncates: text over the limit is rejected so nothing is silently lost. */
function limit(text: string): string {
  if (text.length > MAX_TEXT_CHARS) throw new ApiError(413, `This resume has more than ${MAX_TEXT_CHARS.toLocaleString('en-US')} characters of text, which is more than Synapse keeps. Remove unneeded pages and try again.`);
  return text;
}

const tidy = (t: string) => t.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

/** PDF bytes to text. Throws ApiError 415/422/413 with a message that says what is wrong. */
export async function extractPdfText(buf: Buffer): Promise<string> {
  if (buf.length === 0) throw new ApiError(400, 'The file is empty');
  if (buf.length > MAX_FILE_BYTES) throw new ApiError(413, 'File is larger than 8 MB');
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new ApiError(415, 'That file is not a valid PDF');
  let text = '';
  try {
    // The package root runs a debug routine when imported without a parent; the lib entry does not.
    const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
    text = tidy(String((await pdfParse(buf)).text || ''));
  } catch (error) {
    // The parser's own reason, for diagnosing real files; never the file contents.
    console.warn(JSON.stringify({ level: 'warn', event: 'pdf_parse_failed', reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) }));
    throw new ApiError(422, 'This PDF could not be read. It may be encrypted, password protected or damaged.');
  }
  if (!text) throw new ApiError(422, 'No text could be extracted. This PDF looks like a scan or an image, and OCR (reading text from images) is not supported. Export a text-based PDF, or paste the text instead.');
  return limit(text);
}

/** Validates by content, not by the filename or declared type the client sent. */
export async function extractResume(buf: Buffer, fileName: string): Promise<Extracted> {
  if (buf.length === 0) throw new ApiError(400, 'The file is empty');
  if (buf.length > MAX_FILE_BYTES) throw new ApiError(413, 'File is larger than 8 MB');
  const lower = fileName.toLowerCase();

  if (lower.endsWith('.pdf')) {
    return { mime: 'application/pdf', text: await extractPdfText(buf), keepBytes: true };
  }

  if (lower.endsWith('.txt') || lower.endsWith('.md')) {
    if (buf.includes(0)) throw new ApiError(415, 'That file is not plain text');
    const text = tidy(buf.toString('utf8'));
    if (!text) throw new ApiError(422, 'The file has no text');
    return { mime: 'text/plain', text: limit(text), keepBytes: false };
  }
  throw new ApiError(415, 'Only PDF, TXT and MD files are accepted');
}
