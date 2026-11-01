/** How a resume was read and analysed, worded once for the library, the workspace and the reading panel. */
export type ParseStatus = 'ok' | 'failed' | 'needs_reprocess';

export const PARSE: Record<ParseStatus, { text: string; tone: 'positive' | 'danger' | 'warning' }> = {
  ok: { text: 'Parsed', tone: 'positive' },
  failed: { text: 'Parsing failed', tone: 'danger' },
  needs_reprocess: { text: 'Parsed with an older parser', tone: 'warning' }
};

export const READ_BY: Record<string, string> = {
  pdf: 'Text read from the PDF',
  ocr: 'Text read from scanned pages',
  docx: 'Text read from the Word file',
  text: 'Text as pasted or uploaded'
};

export const READ_SHORT: Record<string, string> = { pdf: 'PDF text', ocr: 'Scanned pages (OCR)', docx: 'Word document', text: 'Plain text' };

export const ANALYSED_BY = { ai: 'AI, resume facts only', rules: 'Section rules' } as const;

/** File type shown on the paper preview, taken from the stored file name. */
export const docKind = (fileName: string) => fileName.match(/\.(pdf|docx|txt|md)$/i)?.[1].toUpperCase() ?? 'TEXT';
