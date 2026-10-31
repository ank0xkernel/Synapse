CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  name text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  active_session_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);

CREATE TABLE login_attempts (
  id bigserial PRIMARY KEY,
  email text NOT NULL,
  ip text NOT NULL,
  succeeded boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_lookup_idx ON login_attempts(email, ip, created_at);

CREATE TABLE resumes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  file_name text NOT NULL,
  mime text NOT NULL,
  size_bytes integer NOT NULL,
  file_bytes bytea,
  extracted_text text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resumes_user_idx ON resumes(user_id);
CREATE UNIQUE INDEX resumes_one_active_idx ON resumes(user_id) WHERE is_active;

CREATE TABLE candidate_profiles (
  resume_id uuid PRIMARY KEY REFERENCES resumes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_descriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT '',
  text text NOT NULL,
  parsed jsonb NOT NULL,
  resume_id uuid REFERENCES resumes(id) ON DELETE SET NULL,
  response_mode text NOT NULL DEFAULT 'professional',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_descriptions_user_idx ON job_descriptions(user_id);

CREATE TABLE interview_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resume_id uuid REFERENCES resumes(id) ON DELETE SET NULL,
  jd_id uuid REFERENCES job_descriptions(id) ON DELETE SET NULL,
  title text NOT NULL,
  company text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT '',
  interview_type text NOT NULL DEFAULT 'general',
  response_mode text NOT NULL DEFAULT 'professional',
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'completed')),
  scheduled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interview_sessions_user_idx ON interview_sessions(user_id);

ALTER TABLE users
  ADD CONSTRAINT users_active_session_fk FOREIGN KEY (active_session_id)
  REFERENCES interview_sessions(id) ON DELETE SET NULL;

CREATE TABLE prep_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  kind text NOT NULL,
  source text NOT NULL CHECK (source IN ('deterministic', 'ai')),
  model text,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prep_results_lookup_idx ON prep_results(session_id, source, kind, created_at DESC);

CREATE TABLE device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX device_tokens_user_idx ON device_tokens(user_id);
