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
- Errors: `lib/http.ts` wraps every route: same-origin check on mutations, uniform `{ok:false,error}` JSON, no stack traces to clients. 5xx errors are logged as one JSON line (route, method, error text, short stack; never bodies, headers or tokens).
- Environment: `lib/env.ts` runs at server start (`instrumentation.ts`) and in production fails fast, naming the missing variable (never its value): `DATABASE_URL` always; `BLOB_READ_WRITE_TOKEN` and no `INSECURE_COOKIES` when `VERCEL_ENV=production`.
- Health: `GET /api/health` returns `{ ok, db, storage, version }`, `Cache-Control: no-store`, status 503 when the database does not answer.
- Headers: CSP, `nosniff`, referrer and permissions policies, `X-Frame-Options`, and `Strict-Transport-Security` in production (`next.config.mjs`).

## Resume storage

`lib/storage.ts` picks the driver from the environment: `blob` (private Vercel Blob) when `BLOB_READ_WRITE_TOKEN` is set, otherwise `db` (the `resumes.file_bytes` column; local dev and the test suite). Vercel Functions accept and return at most 4.5 MB per body, so with `blob` an 8 MB PDF never passes through a Function in either direction:

1. The browser calls `GET /api/resumes/upload` (driver, and a fresh pathname `resumes/<userId>/<uuid>.pdf`).
2. It uploads straight to Blob with `@vercel/blob/client` `upload()`. The token comes from `POST /api/resumes/upload`, which requires the cookie session and pins the pathname to the caller, PDF only, 8 MB, no overwrite, 10 minutes.
3. It calls `POST /api/resumes/finalize { pathname, fileName, name?, replaceId? }`. The server checks the pathname belongs to the session user, downloads the private object, checks `%PDF-` and size, extracts text and saves the row and profile in one transaction. A unique index on `storage_key` makes a repeated finalize return the same resume. An object that fails validation or extraction is deleted, so nothing orphaned stays and no failed row appears. `onUploadCompleted` is not used (it does not fire on localhost).
4. Preview and desktop download: `GET /api/resumes/:id/file` and `GET /api/desktop/v1/resumes/:id/pdf` check ownership, then answer `302` to a signed Blob URL valid for 2 minutes (`issueSignedToken` + `presignUrl`). Node `fetch` follows the redirect and drops the `Authorization` header on the cross-origin hop (checked locally with two servers). The CSP allows only `https://*.private.blob.vercel-storage.com` for `frame-src` and `img-src`, and `https://vercel.com/api/blob` for `connect-src`.

With the `db` driver, files up to the hosting body limit go through `POST /api/resumes` (multipart), and `PUT /api/resumes/:id/file` replaces a file. With `blob`, multipart PDFs are refused (TXT, MD and pasted text still use multipart).

Parse state lives on the row: `parse_status` (`ok`, `failed`, `needs_reprocess`), `parse_error`, `parser_version`, `extracted_at`, `file_sha256`. `POST /api/resumes/:id/reprocess` re-reads the stored original (the saved text for pasted resumes) and rebuilds the profile. Profile items with `source: 'user'` are kept; items with `source: 'extracted'` are replaced. A failed reprocess sets `failed` and `parse_error` and leaves the previous text and profile untouched. Replacing a file does the same merge. Deleting a resume deletes its Blob object after the row.

Nothing is truncated silently: text over 200,000 characters is rejected with a message, and profile limits are far above any real resume. Scanned PDFs are refused with a message that says OCR is not supported.

## Data model (`web/db/migrations`)

`users`, `auth_sessions`, `login_attempts`, `resumes` (file in a `bytea` or a private Blob key, extracted text, parse status, one active per user by partial unique index), `candidate_profiles` (JSON per resume), `job_descriptions`, `interview_sessions`, `prep_results` (`source` is `deterministic` or `ai`, plus model and time), `device_tokens` (sha256 only, expiry, how linked), `auth_codes` (one-time PKCE codes, sha256 only). Deleting a user cascades through everything, including files.

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
| Vercel (Production; Preview optional) | `BLOB_READ_WRITE_TOKEN` | create a Private Blob store in the project's Storage tab and connect it; required in production |
| Vercel | `GEMINI_API_KEY` | a Google AI Studio key; optional, AI prep stays disabled without it |
| Vercel | `GEMINI_MODEL` | optional; default `gemini-3.5-flash-lite` |

Set the Vercel Build Command to `npm run build:vercel`: on Production and Preview deploys with `DATABASE_URL` set it runs the additive migrations, then `next build`; anywhere else it only builds. Preview must use its own Neon branch URL, never the production one. Migrations are additive only; run anything destructive by hand. You can also run `DATABASE_URL=<neon url> npm run migrate` from a trusted machine. Set the Vercel project root directory to `web`. Do not set `INSECURE_COOKIES` on Vercel. Nothing else is required; no session secret is used because sessions are random server-side tokens.

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

`tests/resume-storage.test.mjs` adds the blob ownership/finalize rules (injected fake), real PDFs (multi-page, links, table layout, unusual headings, 25k-character resume, renamed text, truncated, scanned), reprocess and replace with user-edit preservation, health, HSTS/CSP and the migration. Fixtures in `tests/fixtures/` are synthetic and committed.

Covers sign-up, login, logout, rate limit, CSRF, uploads (valid, fake PDF, oversize, wrong type), extraction, activate, rename, delete, profile provenance, JDs, sessions, deterministic prep, AI disabled state, cross-user 404s on every resource, device tokens, PKCE sign-in (happy path, wrong verifier, reuse, expiry, redirect mismatch, non-loopback rejection), context ETag/304, revoked and expired tokens.

Screenshots: with a server running, `npm run shots` (uses the repo's Electron, `SHOT_DIR` sets the output folder).

## Known limitations

- The Blob path (token, direct upload, finalize, signed-URL redirect, framing of the signed URL in the preview iframe) is covered by unit tests with an injected fake and was not run against real Vercel Blob. Check one real upload on a Preview deployment before relying on it.
- Hyperlink targets hidden behind link text are not extracted; only visible URL text is. Multi-column and table layouts are read in the order the PDF stores them, so cells can interleave.
- Text is extracted with a heuristic section parser; names such as "Acme Corp - Backend Engineer (Jan 2022 - Present)" can be cut at the first parenthesis in the entry-name field. The original text is kept in the details field and everything is editable.
- Technology matching uses a fixed vocabulary (about 35 technologies). Skill gaps outside it are not detected; the required-skill lines from the job description are shown verbatim instead.
- Scanned or image-only PDFs are rejected with a clear message (no OCR). Paste the text instead.
- The CSP allows inline scripts because Next.js injects bootstrap scripts; a nonce-based policy needs dynamic rendering through a proxy.
- Password reset by email is not implemented (no mail provider is configured).
- Live answer generation stays in the desktop app; this site never answers interview questions.
- The desktop app does not call this API yet.
