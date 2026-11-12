# Desktop to web contract (v1, final)

How the Synapse desktop app signs in to the Synapse website and pulls the context it caches before a live session. Implemented in `web/app/api/desktop/v1/**` and `web/app/(link)/desktop/link`. Tests: `web/tests/desktop-link.test.mjs`, `web/tests/api.test.mjs`.

Base URL: the site origin (for example `https://synapse.example.com`). All paths below are relative to it. JSON everywhere except the PDF download. Versioning is by path (`/v1`); a breaking change ships as `/v2` and `/v1` stays until the desktop releases that use it are retired. `schema_version` in the context body mirrors this.

The desktop fetches once before a session starts and works from its cache. There is no polling, push or websocket; no live answer depends on this API.

## 1. Sign-in (OAuth 2.0 authorization code with PKCE, RFC 7636, loopback redirect, RFC 8252)

The desktop never sees the user's password. The credential it ends up with is a device token.

### 1.1 Desktop prepares

1. Pick a free TCP port `P` in 1024..65535 and listen on `127.0.0.1:P` (IPv4 literal, not `localhost`).
2. `code_verifier`: 43..128 chars from `[A-Za-z0-9-._~]` (32 random bytes, base64url, gives 43).
3. `code_challenge = base64url(sha256(code_verifier))`, no padding (always 43 chars).
4. `state`: random, 16..128 printable ASCII characters.

### 1.2 Open the browser

```
GET /desktop/link
  ?client=synapse-desktop
  &redirect_uri=http://127.0.0.1:<P>/callback      (URL-encoded)
  &code_challenge=<43 chars>
  &code_challenge_method=S256
  &state=<state>
```

The page requires a web session; if the user is signed out it redirects to `/login?next=<this URL>` and returns after login or signup. It shows "Link Synapse Desktop to <email>?" with Approve and Cancel.

Validation (any failure renders an error page and never redirects anywhere):

| Field | Rule |
|---|---|
| `client` | exactly `synapse-desktop` |
| `redirect_uri` | exactly `http://127.0.0.1:<port>/callback`, port 1024..65535, no query, no userinfo, no other host or scheme |
| `code_challenge_method` | exactly `S256` |
| `code_challenge` | 43 chars of `[A-Za-z0-9_-]` |
| `state` | 16..128 chars, printable ASCII (0x21..0x7e) |

### 1.3 Browser redirect to the desktop

The page itself performs a same-origin `POST /api/desktop/v1/link` (cookie session plus `Origin` check) and then navigates the browser to the returned URL.

Approve: `302`-equivalent navigation to
`http://127.0.0.1:<P>/callback?code=<code>&state=<state>`
`code` is 32 random bytes, base64url (43 chars). Server stores only its sha256, the user id, the challenge and the redirect_uri. It expires 120 seconds after issue and works once.

Cancel: `http://127.0.0.1:<P>/callback?error=access_denied&state=<state>`

The desktop must compare `state` with the value it generated and ignore the request if it differs.

### 1.4 Exchange the code

```
POST /api/desktop/v1/token
Content-Type: application/json
(no cookies, no Authorization)

{
  "grant_type": "authorization_code",
  "code": "<code>",
  "code_verifier": "<verifier>",
  "redirect_uri": "http://127.0.0.1:<P>/callback",
  "device_name": "Ankit's MacBook"          // optional, 1..60 chars, default "Synapse Desktop"
}
```

`200`:

```json
{
  "access_token": "syn_<43 base64url chars>",
  "token_type": "Bearer",
  "account": { "id": "<uuid>", "email": "user@example.com" },
  "expires_at": "2027-01-29T14:15:00.000Z"
}
```

`Cache-Control: no-store`. The token is shown once; only its sha256 is stored server side. Store it in the OS keychain.

Errors (OAuth style, `Cache-Control: no-store`):

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_request` | body is not JSON of the shape above, or `code`/`code_verifier` have impossible length or characters, or `grant_type` is not `authorization_code` |
| 400 | `invalid_grant` | code unknown, expired, already used, `redirect_uri` differs from the one used at authorization, or `sha256(code_verifier)` does not match the stored challenge. A code is consumed by its first exchange attempt, successful or not. |
| 429 | `slow_down` | 20 failed exchanges from one IP in 15 minutes |

```json
{ "error": "invalid_grant", "error_description": "..." }
```

Linking the same `device_name` again revokes that name's previous browser-linked token.

### 1.5 Token lifetime

90 days, sliding: every authenticated request moves `expires_at` to now + 90 days. After 90 idle days, or after revocation, the token returns `401` and the desktop must run section 1 again. Users see linked desktops, last-used time and expiry under Settings and Desktop on the website, and can revoke each one.

## 2. Authenticated endpoints

All require `Authorization: Bearer syn_...`. Cookies are ignored and `Origin` is not checked. Missing, malformed, unknown, revoked or expired token:

`401` with `WWW-Authenticate: Bearer` and
```json
{ "ok": false, "error": "Invalid, expired or revoked device token" }
```

Other error bodies share the shape `{ "ok": false, "error": "<message>" }`.

### 2.1 `GET /api/desktop/v1/me`

```json
{
  "ok": true,
  "account": { "id": "<uuid>", "email": "user@example.com" },
  "token": { "name": "Ankit's MacBook", "created_at": "ISO-8601", "expires_at": "ISO-8601" }
}
```

### 2.2 `POST /api/desktop/v1/logout`

No body. Revokes the calling token. `204`, empty body. Later calls with it return `401`.

### 2.3 `GET /api/desktop/v1/context`

Query: optional `session=<uuid>`.

Which context: `?session=` when given (must belong to the account, else `404`); otherwise the session the user marked "Load in desktop app"; otherwise the active resume alone (`session` and `job_description` are `null`). If there is nothing at all: `404 {"ok":false,"error":"No active context..."}`.

Headers sent: `ETag: "<version>"`, `Cache-Control: private, no-cache`. Send `If-None-Match: "<version>"` to get `304` with empty body when nothing changed.

`200`:

```json
{
  "ok": true,
  "etag": "\"3f2a...\"",
  "version": "3f2a...",
  "schema_version": 1,
  "updated_at": "ISO-8601 (latest change among the included rows)",
  "session": {
    "id": "<uuid>", "title": "Globex round 1", "status": "draft|ready|completed",
    "interview_type": "general|technical|behavioral|system-design|hr",
    "notes": "user's own interview context",
    "scheduled_at": "ISO-8601 or null"
  },
  "settings": { "response_mode": "quick|professional|technical|star|detailed", "company": "", "role": "" },
  "resume": {
    "id": "<uuid>", "name": "Backend resume", "updated_at": "ISO-8601",
    "size": 18746, "has_pdf": true,
    "text": "extracted resume text (user-corrected if they edited it)"
  },
  "profile": {
    "education":      [{ "text": "", "grade": "", "source": "extracted|user" }],
    "experience":     [{ "name": "", "dates": "", "bullets": [""], "technologies": [""], "source": "extracted|user" }],
    "projects":       [{ "name": "", "dates": "", "bullets": [""], "technologies": [""], "source": "extracted|user" }],
    "skills":         [{ "text": "", "source": "extracted|user" }],
    "achievements":   [{ "text": "", "source": "extracted|user" }],
    "certifications": [{ "text": "", "source": "extracted|user" }],
    "custom_context": { "text": "", "source": "user" }
  },
  "job_description": {
    "id": "<uuid>", "company": "", "role": "", "text": "",
    "parsed": { "responsibilities": [""], "requiredSkills": [""], "preferredSkills": [""], "technologies": [""] }
  }
}
```

Notes:
- `version` is the first 32 hex chars of sha256 over the JSON body without `ok`, `etag` and `version`. It changes when, and only when, an included value changes. `etag` is `version` in quotes.
- `session`, `resume`, `profile`, `job_description` are each `null` when absent. Empty profile sections are empty arrays: the server never invents resume facts.
- `profile` is the reviewed profile: where the user edited a value, the edited value is what is sent, with `source: "user"`. Unedited items keep `source: "extracted"`. Prep suggestions generated by AI are never part of this bundle.
- `resume.has_pdf` is `false` for pasted or text-file resumes.
- Contract v1 is unchanged: the context bundle has no new fields. `resume.text` and `profile` always reflect the latest reprocess or replace, and the bundle `version` changes when they do.

### 2.4 `GET /api/desktop/v1/resumes/:id/pdf`

Returns the stored PDF for on-demand preview. When the website keeps files in private object storage (any PDF can be up to 8 MB, above the 4.5 MB hosting response limit) the answer is `302` with a `Location` to a signed URL that expires after two minutes; follow it without credentials (standard `fetch` redirects drop `Authorization` on a cross-origin hop, which is what you want). Otherwise the bytes are streamed directly. The final response is `Content-Type: application/pdf`; the direct form also sends `Content-Disposition: inline`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`. `404` when the id is malformed, not the caller's, or the resume has no PDF (the same answer in all three cases).

## 3. Recommended desktop behavior

1. Sign in once (section 1); keep `access_token` in the keychain.
2. Before starting a live session: `GET /context` with the cached `ETag` in `If-None-Match`. On `304` keep the cache; on `200` replace it; on `401` re-link; on network failure use the cache and tell the user it may be stale.
3. During the session make no calls to this API.

## 4. Security properties

- PKCE S256 only; the code is useless without the verifier; single use; 120 s lifetime.
- `redirect_uri` is fixed to a loopback listener, so no redirect can leave the machine.
- Authorization codes and device tokens are stored as sha256 only.
- Every query is scoped to the token's user id; another account's session or resume id answers `404`.
- Revocation takes effect on the next request.

## 5. Conversation sync

Conversations and their messages live in Neon on the website and in a local file on each desktop (`<userData>/conversations/history.json`). The desktop pushes its changes and pulls everything else through one endpoint, authenticated exactly as section 2 (device token; cookies ignored). The website's own pages use cookie-authenticated routes over the same tables (`/api/conversations…`, `/api/preferences`).

### 5.1 Data model

- **Conversation:** `id` (uuid, chosen by the client that creates it), `title` (≤ 200), `summary` (≤ 4000), `source` (`web` | `desktop`), `created_at`, `edited_at` (when the title or summary last changed, as reported by the editing client and clamped to server time), `updated_at` (server time of any change, read by the cursor), `deleted_at`.
- **Message:** `id` (uuid, client-chosen), `conversation_id`, `role` (`user` | `assistant` | `transcript` | `screen`), `content` (1 to 100 000 chars), `meta` (JSON object ≤ 4000 bytes, opaque to the server), `created_at` (client time, clamped to server time). Messages are append-only.
- **Settings:** `{ "model"?: "<gemini model id>", "responseMode"?: "quick" | "professional" | "technical" | "star" | "detailed" }` plus `updated_at`.

The desktop stores transcripts (`meta.speaker` is `host` or `me`), typed context, screen text and answers, with `meta.type` set to the chat type and `meta.interrupted: true` on an answer cut short. It never sends images, system notices, or Mode C's per-message "in context" toggles.

### 5.2 `POST /api/desktop/v1/sync` (push)

Body (≤ 4 MB; the desktop sends at most 500 conversations and 500 messages, about 3 MB, per batch):

```json
{
  "conversations": [
    { "id": "<uuid>", "title": "…", "summary": "", "created_at": "ISO-8601", "edited_at": "ISO-8601" },
    { "id": "<uuid>", "deleted": true }
  ],
  "messages": [
    { "id": "<uuid>", "conversation_id": "<uuid>", "role": "transcript", "content": "…", "meta": { "speaker": "host" }, "created_at": "ISO-8601" }
  ],
  "settings": { "data": { "responseMode": "star" }, "updated_at": "ISO-8601" }
}
```

All three keys are optional. Conversations and messages apply in one transaction, conversations first, so a new conversation and its first messages can share a batch.

`200`:

```json
{ "ok": true, "refused": ["<uuid>"], "inserted": 2 }
```

- A message whose `id` already exists is skipped. Resending a whole batch after a timeout is safe and inserts nothing twice.
- `refused` lists conversation ids that belong to another account or were already deleted. The desktop deletes those locally.
- A message for a deleted or foreign conversation is dropped silently and not counted in `inserted`.
- `400` (validation) and `413` (too large) mean the batch will never be accepted. The desktop logs the error and drops that batch, so it cannot block later changes. `401` follows section 2.

### 5.3 `GET /api/desktop/v1/sync?cursor=<opaque>` (pull)

Omit `cursor` on the first sync. Always send back the `cursor` from the previous answer unchanged. It is base64url JSON holding server times only, never the desktop's clock.

`200`:

```json
{
  "ok": true,
  "cursor": "<opaque>",
  "more": false,
  "conversations": [ { "id": "…", "title": "…", "summary": "…", "source": "web", "created_at": "…", "edited_at": "…", "updated_at": "…", "deleted_at": null } ],
  "messages": [ { "id": "…", "conversation_id": "…", "seq": "41", "role": "assistant", "content": "…", "meta": {}, "created_at": "…" } ],
  "settings": { "settings": { "responseMode": "star" }, "updated_at": "…" }
}
```

- First sync: every live conversation and all messages. Later syncs: rows whose `updated_at` is after the previous pull's start time minus 60 seconds. The overlap re-sends a few rows so a transaction that committed late is never missed; clients merge by `id`.
- Messages come in pages of 500, ordered by (`updated_at`, `id`). While `more` is `true`, pull again at once with the new cursor. Conversations arrive whole on the first page of a pull.
- `400 "Invalid cursor…"`: drop the cursor and pull from the start.
- Deleted conversations come as rows with `deleted_at` set (tombstones). Their messages are already gone from the server.

### 5.4 Conflicts and deletes

- **Title and summary:** the edit with the later `edited_at` wins. A client clock ahead of the server is clamped to server time, so it cannot win every future conflict. A title edited locally but not yet pushed is not overwritten by a pull.
- **Messages:** never conflict. They are append-only with client ids. Display order is `created_at`, then `seq`.
- **Delete wins:** deleting writes a tombstone and removes the messages from Neon. Later pushes for that conversation (offline edits, late messages) are refused or dropped. The other device removes it on its next pull; if that conversation is open, the chat is cleared with a notice.
- **Settings:** the later `updated_at` wins.

### 5.5 Desktop behavior

1. Every saved message, rename, delete and answer-style change goes to the local file first (atomic write, mode 0600), then into an outbox in the same file. History, the open conversation and the outbox survive restarts and work with no network.
2. Sync runs at launch, 2 seconds after a burst of local changes, every 2 minutes while linked, when the window gains focus, and on "Sync now" in History. One sync runs at a time. Order: push the whole outbox, then pull until `more` is `false`.
3. Network failure: status `offline`, outbox kept, retry after 5 s, doubling to at most 5 minutes. `401`: status `auth-expired`, outbox kept for after re-linking. A pushed item leaves the outbox only after a `2xx`, and a conversation renamed again during the push stays queued.
4. Not linked: status `unlinked`; history is saved on this Mac only and pushed after linking.
5. The device token stays in the main process (section 1, Keychain via `safeStorage`). The history file is plain JSON on purpose: if the Keychain key changes after a rebuild, the history must still be readable.

### 5.6 Website chat

`POST /api/conversations/:id/messages` with `{ "id": "<uuid>", "content": "…" }` creates the conversation on its first message, saves the user message, asks Gemini with the last 30 messages, and saves the reply under an id derived from the user message id. Retrying with the same `id` returns the stored reply and does not call Gemini again. Without `GEMINI_API_KEY` the answer is `503`; on a provider failure it is `502`. In both cases the user message is already saved.
