-- Additive only: new columns, new indexes. No DROP, no data rewrite.
-- Existing rows get parse_status 'needs_reprocess' (constant default, metadata-only in Postgres 11+),
-- then the default flips to 'ok' for rows created from now on.
ALTER TABLE resumes
  ADD COLUMN storage_driver text NOT NULL DEFAULT 'db' CHECK (storage_driver IN ('db', 'blob')),
  ADD COLUMN storage_key text,
  ADD COLUMN file_sha256 text,
  ADD COLUMN parse_status text NOT NULL DEFAULT 'needs_reprocess' CHECK (parse_status IN ('ok', 'failed', 'needs_reprocess')),
  ADD COLUMN parse_error text,
  ADD COLUMN parser_version integer,
  ADD COLUMN extracted_at timestamptz;
ALTER TABLE resumes ALTER COLUMN parse_status SET DEFAULT 'ok';

-- One row per stored object: makes finalize idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS resumes_storage_key_idx ON resumes(storage_key) WHERE storage_key IS NOT NULL;
-- Resume list ordering.
CREATE INDEX IF NOT EXISTS resumes_user_created_idx ON resumes(user_id, created_at DESC);
-- Foreign keys that were unindexed: deleting a resume or JD scans these for ON DELETE SET NULL.
CREATE INDEX IF NOT EXISTS job_descriptions_resume_idx ON job_descriptions(resume_id);
CREATE INDEX IF NOT EXISTS interview_sessions_resume_idx ON interview_sessions(resume_id);
CREATE INDEX IF NOT EXISTS interview_sessions_jd_idx ON interview_sessions(jd_id);
CREATE INDEX IF NOT EXISTS candidate_profiles_user_idx ON candidate_profiles(user_id);
