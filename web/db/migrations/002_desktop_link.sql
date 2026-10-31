ALTER TABLE device_tokens
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN linked_via text NOT NULL DEFAULT 'manual' CHECK (linked_via IN ('manual', 'pkce'));
UPDATE device_tokens SET expires_at = created_at + interval '90 days';

CREATE TABLE auth_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_challenge text NOT NULL,
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_codes_expiry_idx ON auth_codes(expires_at);
