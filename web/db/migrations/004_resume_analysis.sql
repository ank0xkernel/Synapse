-- How a resume's text and profile were produced, so the UI can show it and a rules-built
-- profile can be re-analysed once AI is configured. Constant defaults: metadata-only in Postgres 11+.
ALTER TABLE resumes
  ADD COLUMN extraction_method text NOT NULL DEFAULT 'text' CHECK (extraction_method IN ('text', 'pdf', 'ocr', 'docx')),
  ADD COLUMN analysis_method text NOT NULL DEFAULT 'rules' CHECK (analysis_method IN ('rules', 'ai')),
  ADD COLUMN analysis_note text;

UPDATE resumes SET extraction_method = 'pdf' WHERE mime = 'application/pdf';
