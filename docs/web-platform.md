# Synapse web platform

`web/` is a Next.js 16 (React 19, App Router, Turbopack) application with plain Postgres storage. It holds each user's resumes, candidate profile, job descriptions, interview sessions and preparation results, and serves the desktop app its context through a small token-authenticated API (see `docs/desktop-web-contract.md`). It is independent of the Electron app.

## Pages

| Page | Route | Notes |
|---|---|---|
| Landing | `/` | public, describes only shipped behavior |
| Sign up / sign in | `/signup`, `/login` | `?next=` supports same-site paths only |
| Dashboard | `/dashboard` | counts, setup checklist, active context, upcoming sessions, all from the DB |
| Resumes | `/resumes`, `/resumes/[id]` | drag-and-drop upload with progress, PDF preview, rename, edit extracted text, activate, delete |
| Profile | `/profile?resume=` | editable extracted fields, per-item provenance, re-extract |
| Job descriptions | `/jobs`, `/jobs/new`, `/jobs/[id]` | company, role, text, linked resume, answer style, deterministic parse |
| Sessions | `/sessions`, `/sessions/new`, `/sessions/[id]` | interview context editor, status, schedule, "load in desktop app" |
| Prep | `/prep`, `/prep/[id]` | deterministic comparison, optional AI preparation |
| Desktop | `/desktop`, `/desktop/link` | browser sign-in consent for the desktop app, linked devices, manual token |
| Settings | `/settings` | name, password, linked desktops, delete account |

## Architecture

- UI: server components read the database directly; mutations are JSON `fetch` calls to route handlers from small client components. Styling is `app/tokens.css` (copied verbatim from `src/windows/assistant/ui/tokens.css`) plus `app/ui.css`. No Tailwind.
- Data: `pg` pool in `lib/db.ts`, parameterized SQL only. Every user-data query includes `user_id = $1` taken from the server session (`lib/data.ts`, route handlers). Foreign ids that a user supplies (resume or JD on a session) are verified to belong to them (`lib/owned.ts`).
- Validation: `zod` on every route body (`lib/schemas.ts`, per route). Uploads are validated by content: PDFs must start with `%PDF-`, text files must not contain NUL bytes, size is capped at 8 MB.
- Extraction: `pdf-parse` (external package) plus the desktop modules in `lib/intelligence/` (`resume-parser.js`, `candidate-profile.js`, `jd-profile.js`) for sections, entries and technology matching. They are copies of `src/services/ai/resume-parser.js` and `src/services/context/*-profile.js`; re-copy after desktop changes.
- Errors: `lib/http.ts` wraps every route: same-origin check on mutations, uniform `{ok:false,error}` JSON, no stack traces.

## Data model (`web/db/migrations`)

`users`, `auth_sessions`, `login_attempts`, `resumes` (file bytes in a `bytea`, extracted text, one active per user by partial unique index), `candidate_profiles` (JSON per resume), `job_descriptions`, `interview_sessions`, `prep_results` (`source` is `deterministic` or `ai`, plus model and time), `device_tokens` (sha256 only, expiry, how linked), `auth_codes` (one-time PKCE codes, sha256 only). Deleting a user cascades through everything, including files.

## Auth design

- Passwords: Node `crypto.scrypt` (N=16384, r=8, p=1), per-user 16-byte salt, `timingSafeEqual`. Minimum 10 characters.
- Sessions: 32 random bytes in an httpOnly, SameSite=Lax cookie (`Secure` in production); the database stores only the sha256 in `auth_sessions`. Logout deletes the row. Changing the password signs out other sessions.
- Login rate limit: 5 failed attempts per email and IP in 15 minutes returns 429 with `Retry-After`, even for the correct password. Unknown emails take the same code path and time. Sign-ups are limited to 10 per IP per hour.
- CSRF: mutating routes require an `Origin` header matching the host (cookie-authenticated routes only; the Bearer desktop API ignores cookies).
- Headers (`next.config.mjs`): CSP without `unsafe-eval` in production, `frame-ancestors 'none'` (the PDF route uses `'self'`), `nosniff`, referrer policy, permissions policy.
- No enumeration: there are no list endpoints. Pages list only the caller's rows, and another user's id answers 404.

## AI preparation

Server only (`lib/prep.ts`). `GEMINI_API_KEY` is read from the environment, never sent to the browser, and never logged. The model is `GEMINI_MODEL` or `gemini-3.5-flash-lite`. Generation happens only when the user clicks the button; the result is stored in `prep_results` with `source = 'ai'` and shown with an "AI suggestion" label, apart from "From your resume" facts. The prompt forbids inventing experience, the response is schema-validated, and project prep for projects that are not on the resume is dropped. Without a key the page says "AI preparation needs GEMINI_API_KEY on the server" and the endpoint returns 503.

## What you must supply

| Where | Variable | Value |
|---|---|---|
| Neon | `DATABASE_URL` | create a Neon project and database; use the pooled connection string (`...-pooler...?sslmode=require`) |
| Vercel (Production and Preview) | `DATABASE_URL` | same string |
| Vercel | `GEMINI_API_KEY` | a Google AI Studio key; optional, AI prep stays disabled without it |
| Vercel | `GEMINI_MODEL` | optional; default `gemini-3.5-flash-lite` |

Run migrations against Neon once per release from a trusted machine: `DATABASE_URL=<neon url> npm run migrate` (in `web/`). Set the Vercel project root directory to `web`. Do not set `INSECURE_COOKIES` on Vercel. Nothing else is required; no session secret is used because sessions are random server-side tokens.

## Local development

```bash
cd web
npm install
createdb synapse_web_dev && createdb synapse_web_test
cp .env.example .env.local        # DATABASE_URL=postgres://localhost/synapse_web_dev
npm run migrate                   # idempotent
npm run dev
```

Production mode on http://localhost needs `INSECURE_COOKIES=1` for `curl`-style clients that refuse Secure cookies over http.

## Tests

```bash
cd web
npm run build
npm test      # starts `next start` against synapse_web_test (TEST_DATABASE_URL overrides), truncates it first
```

Covers sign-up, login, logout, rate limit, CSRF, uploads (valid, fake PDF, oversize, wrong type), extraction, activate, rename, delete, profile provenance, JDs, sessions, deterministic prep, AI disabled state, cross-user 404s on every resource, device tokens, PKCE sign-in (happy path, wrong verifier, reuse, expiry, redirect mismatch, non-loopback rejection), context ETag/304, revoked and expired tokens.

Screenshots: with a server running, `npm run shots` (uses the repo's Electron, `SHOT_DIR` sets the output folder).

## Known limitations

- Vercel serverless functions accept request bodies up to 4.5 MB, below the 8 MB cap enforced by the app. Large PDF uploads on Vercel will be refused by the platform before reaching the app. Raise it by moving uploads to a different host, or lower the cap, in the next phase.
- Text is extracted with a heuristic section parser; names such as "Acme Corp - Backend Engineer (Jan 2022 - Present)" can be cut at the first parenthesis in the entry-name field. The original text is kept in the details field and everything is editable.
- Technology matching uses a fixed vocabulary (about 35 technologies). Skill gaps outside it are not detected; the required-skill lines from the job description are shown verbatim instead.
- Scanned PDFs are rejected (no OCR).
- The CSP allows inline scripts because Next.js injects bootstrap scripts; a nonce-based policy needs dynamic rendering through a proxy.
- Password reset by email is not implemented (no mail provider is configured).
- Live answer generation stays in the desktop app; this site never answers interview questions.
- The desktop app does not call this API yet.
