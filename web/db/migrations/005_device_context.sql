-- Which context version each desktop last fetched, so the website can show whether
-- the desktop agent has the latest resume and job description.
ALTER TABLE device_tokens
  ADD COLUMN context_version text,
  ADD COLUMN context_fetched_at timestamptz;
