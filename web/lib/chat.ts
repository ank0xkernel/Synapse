import 'server-only';
import { ApiError } from './http';
import { one } from './db';
import { AiResumeUnavailable, generate } from './ai-resume';
import { aiConfigured } from './prep';
import { appendMessages, getConversation, getSettings, replyIdFor, saveConversation, type Message } from './conversations';

const HISTORY = 30;
// Every reply spends the shared GEMINI_API_KEY. Counted in the database, so the limit holds across serverless instances.
const REPLIES_PER_MINUTE = 10;

const MODE_HINT: Record<string, string> = {
  quick: 'Answer in two or three sentences.',
  professional: 'Answer concisely and directly.',
  technical: 'Give a structured technical explanation with code where it helps.',
  star: 'Structure behavioral answers as Situation, Task, Action, Result.',
  detailed: 'Give a thorough, well-organized explanation.'
};

const speaker = (m: Message) =>
  m.role === 'assistant' ? 'Synapse' : m.role === 'transcript' ? (m.meta.speaker === 'host' ? 'Interviewer (transcript)' : 'User (transcript)') : m.role === 'screen' ? 'Screen text' : 'User';

/**
 * Saves the user's message, asks Gemini, saves the reply. Safe to retry with the same ids:
 * the user message is skipped if already stored, and the reply id is derived from it, so a
 * second attempt returns the stored reply instead of creating another one.
 */
export async function sendMessage(userId: string, input: { conversationId: string; messageId: string; content: string }) {
  const content = input.content.trim();
  // The first message creates the conversation and names it.
  const existing = await getConversation(userId, input.conversationId);
  if (!existing) {
    await saveConversation(userId, { id: input.conversationId, title: content.split('\n')[0]!.slice(0, 80), summary: '' }, 'web');
  }
  await appendMessages(userId, [{ id: input.messageId, conversation_id: input.conversationId, role: 'user', content, meta: {} }]);

  const replyId = replyIdFor(input.messageId);
  const thread = (await getConversation(userId, input.conversationId))!;
  const stored = thread.messages.find((m) => m.id === replyId);
  if (stored) return { conversation: thread.conversation, reply: stored };

  if (!aiConfigured()) throw new ApiError(503, 'AI replies need GEMINI_API_KEY on the server. Your message was saved.');
  const upTo = thread.messages.findIndex((m) => m.id === input.messageId);
  // The id was already used in another conversation, so the insert above was skipped.
  if (upTo < 0) throw new ApiError(409, 'That message id is already in use. Send the message again.');
  const recent = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages WHERE user_id = $1 AND role = 'assistant' AND created_at > now() - interval '1 minute'`,
    [userId]
  );
  if ((recent?.n ?? 0) >= REPLIES_PER_MINUTE) {
    throw new ApiError(429, 'Too many AI replies in the last minute. Your message was saved; press Retry shortly.', { 'Retry-After': '30' });
  }
  const { settings } = await getSettings(userId);
  const history = thread.messages.slice(0, upTo + 1).slice(-HISTORY);
  const prompt = [
    'You are Synapse, a private AI assistant for one person. Be accurate; say so when you are unsure.',
    MODE_HINT[settings.responseMode ?? 'professional'],
    thread.conversation.summary ? `Conversation summary: ${thread.conversation.summary}` : '',
    'Conversation so far:',
    ...history.map((m) => `${speaker(m)}: ${m.content}`),
    'Synapse:'
  ].filter(Boolean).join('\n\n');

  let text: string;
  try {
    text = (await generate(prompt, { json: false, timeoutMs: 45_000, maxTokens: 4096, temperature: 0.4, model: settings.model })).trim();
  } catch (e) {
    const reason = e instanceof AiResumeUnavailable ? e.message : 'The AI provider did not return a result';
    throw new ApiError(502, `${reason}. Your message was saved; press Retry.`);
  }
  if (!text) throw new ApiError(502, 'The AI returned an empty reply. Your message was saved; press Retry.');
  await appendMessages(userId, [{ id: replyId, conversation_id: input.conversationId, role: 'assistant', content: text, meta: { replyTo: input.messageId } }]);
  const after = (await getConversation(userId, input.conversationId))!;
  return { conversation: after.conversation, reply: after.messages.find((m) => m.id === replyId)! };
}
