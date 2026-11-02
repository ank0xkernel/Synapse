/** How a resume was read and analysed, worded once for the library, the workspace and the reading panel. */
export type ParseStatus = 'ok' | 'failed' | 'needs_reprocess';

export const PARSE: Record<ParseStatus, { text: string; tone: 'positive' | 'danger' | 'warning' }> = {
  ok: { text: 'Parsed', tone: 'positive' },
  failed: { text: 'Parsing failed', tone: 'danger' },
  needs_reprocess: { text: 'Parsed with an older parser', tone: 'warning' }
};

export type ProcessingOutcome =
  | 'ai_completed'
  | 'basic_extracted'
  | 'analysis_failed'
  | 'reanalysis_required';

export function getProcessingOutcome(r: {
  parse_status: ParseStatus;
  analysis_method?: 'ai' | 'rules' | string;
  analysis_note?: string | null;
}): { outcome: ProcessingOutcome; text: string; tone: 'positive' | 'danger' | 'warning' } {
  if (r.parse_status === 'failed') {
    return { outcome: 'analysis_failed', text: 'Analysis failed', tone: 'danger' };
  }
  if (r.parse_status === 'needs_reprocess') {
    return { outcome: 'reanalysis_required', text: 'Reanalysis required', tone: 'warning' };
  }
  if (r.analysis_method === 'ai') {
    return { outcome: 'ai_completed', text: 'AI analysis completed', tone: 'positive' };
  }
  return { outcome: 'basic_extracted', text: 'Basic extraction completed (AI unavailable)', tone: 'warning' };
}

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
