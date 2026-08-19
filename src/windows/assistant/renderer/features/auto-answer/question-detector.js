/**
 * Real-time question detection over partial transcripts.
 *
 * The old design only ever looked at a *final* transcript, so all of the
 * "was that a question" work happened after AssemblyAI had already decided
 * the turn was over. This runs the same judgment continuously as partials
 * arrive, so a question that ends unambiguously ("...how would you scale
 * it?") can be recognised the moment the words exist — it does not have to
 * wait for a final event to even be evaluated.
 *
 * This does not replace endpointing. AssemblyAI still decides when a turn
 * closes; this decides, given the words seen so far, how confident we already
 * are that they form a question and whether that confidence is still rising.
 */

// Below this, a "question" is almost always a backchannel ("mm-hm", "right").
const MIN_QUESTION_CHARS = 12;

const QUESTION_OPENERS = /^(what|why|how|when|where|which|who|whom|whose|can|could|would|should|do|does|did|is|are|was|were|have|has|had|will|tell me|walk me|explain|describe|give me|talk me|suppose|imagine|let's say|lets say)\b/i;

const QUESTION_PHRASES = /\b(tell me about|walk me through|how would you|what would you|can you explain|describe a time|give me an example|your thoughts on|how do you)\b/i;

// Words that almost never end a spoken sentence — if the partial stops here,
// STT caught a breath, not the end of the thought.
const TRAILING_TOKEN = /(?:^|\s)(and|or|but|so|because|since|that|which|who|if|when|while|like|as|than|then|um|uh|erm|hmm|well|okay|the|a|an|to|of|for|with|about|into|onto|on|in|at|by|from|is|are|was|were|be|been|do|does|did|have|has|had|can|could|would|should|will|you know|i mean|sort of|kind of|let me|maybe|you|i|we|they|he|she|it|my|your|our|their|his|her|its)$/i;

/** True when the line reads like something the listener is expected to answer. */
export function looksLikeQuestion(text) {
  const trimmed = String(text || '').trim();
  if (trimmed.length < MIN_QUESTION_CHARS) return false;
  if (trimmed.endsWith('?')) return true;
  return QUESTION_OPENERS.test(trimmed) || QUESTION_PHRASES.test(trimmed);
}

function endsOnTrailingToken(text) {
  return TRAILING_TOKEN.test(text.replace(/[\s,;:\-–—.]+$/, ''));
}

/**
 * Confidence that `text`, as heard so far, is a complete question — not just
 * question-shaped, but plausibly *finished*. Deliberately conservative: a
 * false trigger mid-sentence is worse than a 100-200ms wait (spec's own
 * framing), so ambiguous middles score low rather than optimistically high.
 *
 * @returns {number} 0..1
 */
export function scoreQuestionCompleteness(text) {
  const trimmed = String(text || '').trim();
  if (trimmed.length < MIN_QUESTION_CHARS) return 0;

  const isQuestionShaped = looksLikeQuestion(trimmed);
  if (!isQuestionShaped) return 0;

  // Explicit punctuation is the strongest signal there is — AssemblyAI only
  // emits '?' when its own model believes the utterance completed as a question.
  if (trimmed.endsWith('?')) return 0.97;

  // Question-shaped but visibly still assembling a clause.
  if (endsOnTrailingToken(trimmed)) return 0.25;

  // Question-shaped, grammatically closed, just missing the mark STT sometimes
  // drops on a falling-intonation question.
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount >= 5) return 0.65;

  return 0.4;
}

/**
 * Tracks one source's running partial and exposes whether confidence is still
 * climbing — used to decide whether to hold for one more partial rather than
 * fire on the current one.
 */
export function createQuestionDetector() {
  let lastText = '';
  let lastScore = 0;
  let peakScore = 0;

  function update(partialText) {
    const text = String(partialText || '').trim();
    const score = scoreQuestionCompleteness(text);
    const rising = score > lastScore;

    lastText = text;
    lastScore = score;
    if (score > peakScore) peakScore = score;

    return { text, score, rising, peakScore };
  }

  function reset() {
    lastText = '';
    lastScore = 0;
    peakScore = 0;
  }

  return { update, reset };
}
