import 'server-only';
import { ApiError } from './http';

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;

export interface Extracted {
  mime: 'application/pdf' | 'text/plain';
  text: string;
  keepBytes: boolean;
}

const tidy = (t: string) => t.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

/** Validates by content, not by the filename or declared type the client sent. */
export async function extractResume(buf: Buffer, fileName: string): Promise<Extracted> {
  if (buf.length === 0) throw new ApiError(400, 'The file is empty');
  if (buf.length > MAX_FILE_BYTES) throw new ApiError(413, 'File is larger than 8 MB');
  const lower = fileName.toLowerCase();

  if (lower.endsWith('.pdf')) {
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new ApiError(415, 'That file is not a valid PDF');
    let text = '';
    try {
      // The package root runs a debug routine when imported without a parent; the lib entry does not.
      const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
      text = tidy(String((await pdfParse(buf)).text || ''));
    } catch {
      throw new ApiError(422, 'This PDF could not be read. It may be encrypted or damaged.');
    }
    if (!text) throw new ApiError(422, 'No text could be extracted. The PDF is probably a scan. Paste the text instead.');
    return { mime: 'application/pdf', text: text.slice(0, MAX_TEXT_CHARS), keepBytes: true };
  }

  if (lower.endsWith('.txt') || lower.endsWith('.md')) {
    if (buf.includes(0)) throw new ApiError(415, 'That file is not plain text');
    const text = tidy(buf.toString('utf8'));
    if (!text) throw new ApiError(422, 'The file has no text');
    return { mime: 'text/plain', text: text.slice(0, MAX_TEXT_CHARS), keepBytes: false };
  }
  throw new ApiError(415, 'Only PDF, TXT and MD files are accepted');
}
