import 'server-only';
import crypto from 'node:crypto';
import { z } from 'zod';
import { one, query, withTx } from './db';
import { RESPONSE_MODE_IDS } from './constants';
import { notFound } from './http';

/**
 * Conversations shared by the website and the desktop app (docs/desktop-web-contract.md, section 5).
 * Every function takes userId from the server session or device token, never from the request body.
 * Ids are client-generated uuids, so retries are idempotent. Messages are append-only; only a
 * conversation's title and summary can change, and the later edit (edited_at) wins.
 */

export interface Conversation {
  id: string;
  title: string;
  summary: string;
  source: 'web' | 'desktop';
  created_at: Date;
  edited_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface ConversationListItem extends Conversation {
  message_count: number;
  last_message: string | null;
}

export type MessageRole = 'user' | 'assistant' | 'transcript' | 'screen';

export interface Message {
  id: string;
  conversation_id: string;
  seq: string;
  role: MessageRole;
  content: string;
  meta: Record<string, unknown>;
  created_at: Date;
}

const CONV_COLS = 'id, title, summary, source, created_at, edited_at, updated_at, deleted_at';
const MSG_COLS = 'id, conversation_id, seq, role, content, meta, created_at';

// ---- Validation shared by the cookie and device-token routes ----

const ts = z.coerce.date();
export const conversationInput = z.object({
  id: z.string().uuid(),
  title: z.string().max(200).default(''),
  summary: z.string().max(4000).default(''),
  created_at: ts.optional(),
  edited_at: ts.optional(),
  deleted: z.boolean().optional()
});
export const messageInput = z.object({
  id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  role: z.enum(['user', 'assistant', 'transcript', 'screen']),
  content: z.string().min(1).max(100_000),
  meta: z.record(z.string(), z.unknown()).default({}).refine((m) => JSON.stringify(m).length <= 4000, 'meta is too large'),
  created_at: ts.optional()
});
export const settingsInput = z.object({
  model: z.string().regex(/^[a-z0-9][a-z0-9.\-]{1,79}$/).optional(),
  responseMode: z.enum(RESPONSE_MODE_IDS).optional()
}).strict();
export type Settings = z.infer<typeof settingsInput>;

/** A client clock in the future must not win every later conflict. */
const clamp = (d: Date | undefined) => {
  const now = Date.now();
  return !d || Number.isNaN(d.getTime()) || d.getTime() > now ? new Date(now) : d;
};

// ---- Reads ----

export async function listConversations(userId: string): Promise<ConversationListItem[]> {
  return query<ConversationListItem>(
    `SELECT ${CONV_COLS.split(', ').map((c) => `c.${c}`).join(', ')},
            (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT left(m.content, 160) FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.seq DESC LIMIT 1) AS last_message
     FROM conversations c
     WHERE c.user_id = $1 AND c.deleted_at IS NULL
     ORDER BY c.updated_at DESC
     LIMIT 200`,
    [userId]
  );
}

export async function getConversation(userId: string, id: string): Promise<{ conversation: Conversation; messages: Message[] } | null> {
  const [conversation, messages] = await Promise.all([
    one<Conversation>(`SELECT ${CONV_COLS} FROM conversations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [id, userId]),
    query<Message>(`SELECT ${MSG_COLS} FROM messages WHERE conversation_id = $1 AND user_id = $2 ORDER BY created_at, seq`, [id, userId])
  ]);
  return conversation ? { conversation, messages } : null;
}

// ---- Writes ----

type Q = <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<R[]>;

/**
 * Creates the conversation, or applies a newer title/summary to an existing one, or deletes it.
 * Returns false when the id belongs to another user or the conversation was already deleted:
 * a delete always wins over edits made elsewhere while offline.
 */
async function upsertConversation(q: Q, userId: string, input: z.infer<typeof conversationInput>, source: 'web' | 'desktop'): Promise<boolean> {
  if (input.deleted) {
    // Tombstone first, then drop the content. The tombstone row is what tells the other device.
    const rows = await q<{ id: string }>(
      `INSERT INTO conversations (id, user_id, title, source, deleted_at) VALUES ($1, $2, '', $3, now())
       ON CONFLICT (id) DO UPDATE SET deleted_at = COALESCE(conversations.deleted_at, now()), updated_at = now(), title = '', summary = ''
       WHERE conversations.user_id = EXCLUDED.user_id
       RETURNING id`,
      [input.id, userId, source]
    );
    if (rows[0]) await q('DELETE FROM messages WHERE conversation_id = $1 AND user_id = $2', [input.id, userId]);
    return Boolean(rows[0]);
  }
  const editedAt = clamp(input.edited_at);
  const rows = await q<{ id: string; user_id: string; deleted_at: Date | null }>(
    `INSERT INTO conversations (id, user_id, title, summary, source, created_at, edited_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, summary = EXCLUDED.summary, edited_at = EXCLUDED.edited_at, updated_at = now()
     WHERE conversations.user_id = EXCLUDED.user_id AND conversations.deleted_at IS NULL AND conversations.edited_at < EXCLUDED.edited_at
     RETURNING id`,
    [input.id, userId, input.title.trim(), input.summary.trim(), source, clamp(input.created_at), editedAt]
  );
  if (rows[0]) return true;
  // No row changed: either an older edit (fine) or not ours / deleted (refuse).
  const existing = await q<{ ok: boolean }>(`SELECT (user_id = $2 AND deleted_at IS NULL) AS ok FROM conversations WHERE id = $1`, [input.id, userId]);
  return Boolean(existing[0]?.ok);
}

/** Appends messages; an id that already exists is skipped. Messages for a deleted or foreign conversation are dropped. */
async function insertMessages(q: Q, userId: string, messages: z.infer<typeof messageInput>[]): Promise<string[]> {
  const inserted: string[] = [];
  const touched = new Set<string>();
  // Insert in client order so seq follows the order the messages were written in.
  const ordered = [...messages].sort((a, b) => clamp(a.created_at).getTime() - clamp(b.created_at).getTime());
  for (const m of ordered) {
    const rows = await q<{ id: string }>(
      `INSERT INTO messages (id, conversation_id, user_id, role, content, meta, created_at)
       SELECT $1, c.id, c.user_id, $3, $4, $5, $6 FROM conversations c
       WHERE c.id = $2 AND c.user_id = $7 AND c.deleted_at IS NULL
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [m.id, m.conversation_id, m.role, m.content, JSON.stringify(m.meta), clamp(m.created_at), userId]
    );
    if (rows[0]) {
      inserted.push(rows[0].id);
      touched.add(m.conversation_id);
    }
  }
  if (touched.size) await q('UPDATE conversations SET updated_at = now() WHERE id = ANY($1::uuid[]) AND user_id = $2', [[...touched], userId]);
  return inserted;
}

export async function saveConversation(userId: string, input: z.infer<typeof conversationInput>, source: 'web' | 'desktop' = 'web') {
  const ok = await withTx((q) => upsertConversation(q, userId, input, source));
  if (!ok) throw notFound();
}

export async function appendMessages(userId: string, messages: z.infer<typeof messageInput>[]) {
  return withTx((q) => insertMessages(q, userId, messages));
}

/** Rename or re-summarize from the website. The server's clock is the edit time. */
export async function renameConversation(userId: string, id: string, patch: { title?: string; summary?: string }) {
  const row = await one<Conversation>(
    `UPDATE conversations SET title = COALESCE($3, title), summary = COALESCE($4, summary), edited_at = now(), updated_at = now()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING ${CONV_COLS}`,
    [id, userId, patch.title?.trim() ?? null, patch.summary?.trim() ?? null]
  );
  if (!row) throw notFound();
  return row;
}

export async function deleteConversation(userId: string, id: string) {
  await saveConversation(userId, { id, title: '', summary: '', deleted: true });
}

// ---- Settings ----

export async function getSettings(userId: string): Promise<{ settings: Settings; updated_at: Date }> {
  const row = await one<{ settings: Settings; settings_updated_at: Date }>('SELECT settings, settings_updated_at FROM users WHERE id = $1', [userId]);
  return { settings: settingsInput.catch({}).parse(row?.settings ?? {}), updated_at: row?.settings_updated_at ?? new Date(0) };
}

/** Later edit wins; returns the stored settings either way. */
export async function saveSettings(userId: string, settings: Settings, editedAt?: Date) {
  await query(
    `UPDATE users SET settings = $2, settings_updated_at = $3 WHERE id = $1 AND settings_updated_at < $3`,
    [userId, JSON.stringify(settings), clamp(editedAt)]
  );
  return getSettings(userId);
}

// ---- Desktop sync ----

/** Rows changed within this window before the cursor are sent again, so a transaction that committed late is not missed. Clients merge by id. */
const OVERLAP_MS = 60_000;
const PAGE = 500;

export const pushInput = z.object({
  conversations: z.array(conversationInput).max(PAGE).default([]),
  messages: z.array(messageInput).max(PAGE).default([]),
  settings: z.object({ data: settingsInput, updated_at: ts }).optional()
});

/** Applies a batch from the desktop in one transaction. Idempotent: the desktop may resend a batch after a timeout. */
export async function applyPush(userId: string, input: z.infer<typeof pushInput>) {
  const result = await withTx(async (q) => {
    const refused: string[] = [];
    for (const c of input.conversations) if (!(await upsertConversation(q, userId, c, 'desktop'))) refused.push(c.id);
    const inserted = await insertMessages(q, userId, input.messages);
    return { refused, inserted: inserted.length };
  });
  if (input.settings) await saveSettings(userId, input.settings.data, input.settings.updated_at);
  return result;
}

const cursorShape = z.object({
  t: z.string().datetime().optional(), // server time the previous complete pull started at
  n: z.string().datetime().optional(), // server time this multi-page pull started at
  u: z.string().regex(/^\d{1,20}$/).optional(), // keyset: last message's updated_at in microseconds
  id: z.string().uuid().optional() //        keyset: last message's id
});
const encode = (c: z.infer<typeof cursorShape>) => Buffer.from(JSON.stringify(c)).toString('base64url');
export function decodeCursor(raw: string | null): z.infer<typeof cursorShape> | null {
  if (!raw) return {};
  try {
    return cursorShape.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

/**
 * Everything that changed after `cursor`, an opaque value an earlier pull returned (absent on first
 * sync). The cursor holds the server's clock, never the desktop's. A full page sets `more`, and the
 * returned cursor continues after the last message by (updated_at, id), so rows written in one
 * transaction with the same timestamp are neither skipped nor repeated forever.
 */
export async function pull(userId: string, cursor: z.infer<typeof cursorShape>) {
  const since = cursor.t ? new Date(new Date(cursor.t).getTime() - OVERLAP_MS) : null;
  const startedAt = cursor.n ?? (await one<{ now: Date }>('SELECT clock_timestamp() AS now'))!.now.toISOString();
  const firstPage = !cursor.u;
  const params: unknown[] = [userId];
  let where = 'user_id = $1';
  if (since) where += ` AND updated_at > $${params.push(since)}`;
  if (cursor.u && cursor.id) where += ` AND (${MICROS}, id) > ($${params.push(cursor.u)}::bigint, $${params.push(cursor.id)}::uuid)`;

  const [conversations, messages, settings] = await Promise.all([
    // ponytail: conversations come whole on the first page (cap 2000); paginate them too if one account ever has more.
    firstPage
      ? query<Conversation>(
          `SELECT ${CONV_COLS} FROM conversations WHERE user_id = $1 ${since ? 'AND updated_at > $2' : 'AND deleted_at IS NULL'} ORDER BY updated_at LIMIT 2000`,
          since ? [userId, since] : [userId]
        )
      : Promise.resolve([] as Conversation[]),
    query<Message & { micros: string }>(`SELECT ${MSG_COLS}, ${MICROS}::text AS micros FROM messages WHERE ${where} ORDER BY ${MICROS}, id LIMIT ${PAGE + 1}`, params),
    getSettings(userId)
  ]);
  const more = messages.length > PAGE;
  const page = messages.slice(0, PAGE);
  const last = page.at(-1);
  const next = more && last ? { t: cursor.t, n: startedAt, u: last.micros, id: last.id } : { t: startedAt };
  return {
    cursor: encode(next),
    more,
    conversations,
    messages: page.map(({ micros: _m, ...m }) => m),
    settings
  };
}
const MICROS = '(floor(extract(epoch FROM updated_at) * 1000000))::bigint';

/** The id of the assistant reply to a user message: deterministic, so a retried send cannot create two replies. */
export function replyIdFor(userMessageId: string): string {
  const h = crypto.createHash('sha256').update(`reply:${userMessageId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
