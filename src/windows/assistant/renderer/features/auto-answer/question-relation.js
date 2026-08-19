/**
 * Question relation classification.
 *
 * The trap this deliberately avoids: an ever-growing list of regexes, one
 * per phrasing an interviewer might use. "What about MongoDB?", "What about
 * Redis?", "What about Kafka?" are not three rules — they're one
 * grammatical FRAME ("what about X") that structurally presupposes an
 * antecedent, independent of what X actually is. Every pattern group below
 * matches a frame, not a topic; the topic itself comes from
 * conversation-tracker.js's tracked-entity state, checked separately by the
 * caller. This is still pattern matching under the hood — full semantic
 * understanding without an LLM call isn't achievable — but grouping by frame
 * is what keeps the pattern count bounded instead of growing per example
 * forever. See PART 8 in the spec for why an LLM fallback is deliberately
 * NOT added here: this stays fast and deterministic on the critical path,
 * which a real-time interview tool cannot trade away for marginal recall.
 *
 * Resolution ≠ answering. This module's only job is deciding what the
 * interviewer is actually asking about; it never tries to answer anything.
 */

export const QuestionRelation = Object.freeze({
  NEW_TOPIC: 'NEW_TOPIC',
  FOLLOW_UP: 'FOLLOW_UP',
  REFINEMENT: 'REFINEMENT',
  CLARIFICATION: 'CLARIFICATION',
  CORRECTION: 'CORRECTION',
  EXPANSION: 'EXPANSION',
  CONTINUATION: 'CONTINUATION',
  COMPARISON: 'COMPARISON',
  TOPIC_SWITCH: 'TOPIC_SWITCH',
  UNKNOWN: 'UNKNOWN'
});

export const Confidence = Object.freeze({
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW'
});

function matchesAny(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

// STT output is inconsistent about trailing punctuation — a falling-
// intonation question can come through with a period, no mark at all, or a
// '?'. Matching against a version with trailing .?! stripped means every
// pattern below only has to anchor on real content ($ instead of \??$),
// once, instead of every individual pattern remembering to tolerate three
// different possible endings.
function normalizeForMatch(text) {
  return String(text || '').trim().replace(/[.?!]+$/, '').trim();
}

// Explicit self-redirect. Narrow on purpose — a false positive here discards
// a real question's own content, which is worse than under-triggering.
const CORRECTION_PATTERNS = [
  /^no,?\s+i meant\b/i,
  /^no,?\s+i was asking (about|for)\b/i,
  /^sorry,?\s+i meant\b/i,
  /^actually,?\s+i meant\b/i,
  /^wait,?\s+i meant\b/i,
  /^i meant\b/i
];

// Explicit, deliberate move away from the current subject.
const TOPIC_SWITCH_PATTERNS = [
  /^(ok(ay)?,?\s+)?let'?s (talk about|move on to|switch to|discuss)\b/i,
  /^(ok(ay)?,?\s+)?(moving on|next question|different question|switching gears|changing topics?)\b/i,
  /^now,?\s+(tell me about|let'?s talk about)\b/i
];

// "Explain/describe/tell me about/go deeper into THE <thing> PART/ASPECT/..."
// — a definite-article reference to a piece of something, not a fresh
// standalone subject. This is the rule that makes Example C correct:
// "Can you explain the authentication part?" narrows within whatever
// project is already active rather than discarding it. The captured group
// is the subtopic noun phrase itself (e.g. "authentication"), returned so
// the caller can track it explicitly.
const REFINEMENT_PATTERNS = [
  /^(can you |could you |please )?(explain|describe|tell me (about|more about)|walk me through|go (deeper|further) into|dig into|elaborate on)\s+(the|that|this)\s+([a-z][a-z\s]{1,40}?)\s*(part|aspect|piece|side|layer|component|feature|angle|flow|process|logic|handling)\b/i
];

function extractRefinementSubtopic(normalized) {
  const match = normalized.match(REFINEMENT_PATTERNS[0]);
  // Phase 6 fix: this was reading match[5] -- group 5 in REFINEMENT_PATTERNS
  // is the (the|that|this) determiner itself ("the"), not the subtopic noun
  // phrase. The actual subtopic is captured one group later, at match[6]
  // (see the "tell me (about|more about)" and "go (deeper|further) into"
  // nested groups above, which push every group after them up by one). This
  // silently broke the module's own named Example C ("Can you explain the
  // authentication part?" resolved to `(about the "the" part of ...)`
  // instead of `(about the "authentication" part of ...)`) for every
  // REFINEMENT match, independent of Phase 6 -- found via Phase 6's own test
  // suite, fixed here since it directly blocks Phase 6's REFINEMENT example.
  return match ? match[6].trim() : null;
}

// "What about X?" / "How about X?" / "Why not X?" — inherently relative
// frames. Grammatically, "what about" always means "what about X, relative
// to whatever we were just discussing" — it does not stand alone the way
// "what is X" does. Checked AFTER the bare-pronoun patterns below (see
// classifyUtterance's ordering) so "what about that/it/this" — a more
// specific subset with no entity of its own — resolves via the bare-pronoun
// path rather than this broader one; both produce a real resolution either
// way, but the bare path is the one actually proven correct by the original
// "Why?" case this whole system started from.
const COMPARISON_PATTERNS = [
  /^(and |but |ok(ay)?,?\s+but )?what about\b/i,
  /^(and |but )?how about\b/i,
  /^(ok(ay)?,?\s+)?but why not\b/i,
  /^(and )?why not\b/i,
  // "And the authentication?" / "And the frontend?" — the same implicit
  // comparison/continuation shape as "what about X", just with "and"
  // carrying the whole weight. Bounded to a short noun phrase and excludes
  // "and what ..." so it can't swallow CONTINUATION_PATTERNS' "and what
  // were the tradeoffs" below — those are checked independently either way,
  // but keeping this narrow avoids the two fighting over the same input.
  /^and\s+(the\s+)?(?!what\b)[a-z][a-z\s]{0,30}$/i
];

const EXPANSION_PATTERNS = [
  /^(can you |could you )?(go deeper|dig deeper|elaborate( on that)?|expand( on that)?|tell me more( about that)?|say more)\b/i
];

const CONTINUATION_PATTERNS = [
  /^(and )?(then )?what happened( next)?$/i,
  /^(and )?what (else|were the (trade-?offs?|pros and cons)|other (issues|problems|challenges))\b/i,
  /^(and )?then$/i
];

const CLARIFICATION_PATTERNS = [
  /^what do you mean\b/i,
  /^(can|could) you clarify\b/i,
  /^what does that mean\b/i
];

// Bare pronoun/deictic follow-ups with no subject of their own at all —
// "Why?", "What about that?", "How so?". The narrowest, highest-confidence
// signal there is: these cannot possibly stand alone.
const BARE_FOLLOWUP_PATTERNS = [
  /^why$/i,
  /^why (is that|not)$/i,
  /^how (so|come)$/i,
  /^(and )?what about (that|it|this)$/i,
  /^(and )?what else$/i,
  /^(can you )?(go deeper|elaborate|expand( on that)?)$/i,
  /^(and )?(then )?what happened( next)?$/i,
  /^(really|seriously)$/i,
  /^(and )?why (that|this) (one|approach|choice)$/i,
  // "Why did you choose that (approach/one/database/...)?" — allows one
  // trailing noun after the pronoun, which the plain "(that|it|this)$"
  // anchor above does not.
  /^why did you (do|choose|pick|use|go with) (that|it|this)( [a-z]+)?$/i,
  /^how did you (handle|fix|solve|approach) (that|it|this)$/i,
  /^can you explain (that|it|this)$/i,
  /^explain (that|it|this)$/i,
  /^what exactly did you (do|implement) (there|for that)$/i
];

export function isBareFollowUp(text) {
  return BARE_FOLLOWUP_PATTERNS.some((pattern) => pattern.test(normalizeForMatch(text)));
}

/**
 * "What is X" / "Tell me about X" / "Describe X" with a subject that stands
 * on its own — no pronoun, no definite-article partitive phrase. This is
 * the rule PART 4 needs: "What is React?" after a PostgreSQL discussion
 * must stay NEW_TOPIC, not get dragged into a comparison it never asked
 * for. Checked only after every context-dependent frame above has already
 * failed to match, so a genuinely partitive or relative phrasing never
 * reaches here.
 */
function hasStandaloneSubject(normalized) {
  const match = normalized.match(/^(what is|what'?s|what are|tell me about|describe|explain)\s+(.+)$/i);
  if (!match) return false;
  const subject = match[2].trim();
  if (!subject) return false;
  if (/^(that|it|this|those|these)\b/i.test(subject)) return false;
  return true;
}

/**
 * Classifies `trimmed` against the active conversation state. Pure and
 * stateless — takes only what it needs to decide (whether there is any
 * prior context to resolve against), never the tracker's internal state
 * directly, so it's testable without constructing a whole tracker.
 *
 * @param {string} trimmed
 * @param {{ hasContext: boolean }} state
 * @returns {{ relation: string, confidence: string, refinementSubtopic: string|null }}
 */
// Below this word count, an unrecognized utterance is too thin to trust as
// a genuine new question — could be a stray fragment, backchannel that
// slipped past looksLikeQuestion, or noise. At or above it, an utterance
// that matches no context-DEPENDENT frame (comparison/correction/
// refinement/...) is far more likely a well-formed standalone question
// this module's own opener list just doesn't happen to recognize (e.g.
// "Why did you choose PostgreSQL?" doesn't start with "what is"/"tell me
// about", but it is obviously not a follow-up either). See
// classifyUtterance's UNKNOWN branch for how this distinction is used.
const SUBSTANTIAL_WORD_COUNT = 4;

export function classifyUtterance(rawText, { hasContext = false } = {}) {
  const normalized = normalizeForMatch(rawText);

  if (matchesAny(CORRECTION_PATTERNS, normalized)) {
    return { relation: QuestionRelation.CORRECTION, confidence: Confidence.HIGH, refinementSubtopic: null };
  }
  if (matchesAny(TOPIC_SWITCH_PATTERNS, normalized)) {
    return { relation: QuestionRelation.TOPIC_SWITCH, confidence: Confidence.HIGH, refinementSubtopic: null };
  }
  if (matchesAny(REFINEMENT_PATTERNS, normalized)) {
    return {
      relation: QuestionRelation.REFINEMENT,
      confidence: hasContext ? Confidence.HIGH : Confidence.LOW,
      refinementSubtopic: extractRefinementSubtopic(normalized)
    };
  }
  // Bare pronoun/deictic patterns checked BEFORE the broader comparison
  // patterns: "What about that?" must resolve via the narrower, already-
  // proven pronoun path, not get swept up by the generic "what about"
  // prefix match below (which is aimed at "what about MongoDB?" — a real
  // entity, not a pronoun standing in for one).
  if (isBareFollowUp(normalized)) {
    return { relation: QuestionRelation.FOLLOW_UP, confidence: hasContext ? Confidence.HIGH : Confidence.LOW, refinementSubtopic: null };
  }
  if (matchesAny(COMPARISON_PATTERNS, normalized)) {
    return { relation: QuestionRelation.COMPARISON, confidence: hasContext ? Confidence.HIGH : Confidence.LOW, refinementSubtopic: null };
  }
  if (matchesAny(EXPANSION_PATTERNS, normalized)) {
    return { relation: QuestionRelation.EXPANSION, confidence: hasContext ? Confidence.HIGH : Confidence.LOW, refinementSubtopic: null };
  }
  if (matchesAny(CONTINUATION_PATTERNS, normalized)) {
    return { relation: QuestionRelation.CONTINUATION, confidence: hasContext ? Confidence.HIGH : Confidence.LOW, refinementSubtopic: null };
  }
  if (matchesAny(CLARIFICATION_PATTERNS, normalized)) {
    return { relation: QuestionRelation.CLARIFICATION, confidence: hasContext ? Confidence.MEDIUM : Confidence.LOW, refinementSubtopic: null };
  }
  if (hasStandaloneSubject(normalized)) {
    return { relation: QuestionRelation.NEW_TOPIC, confidence: Confidence.HIGH, refinementSubtopic: null };
  }

  // No context-dependent frame matched, and it isn't one of the specific
  // standalone openers either. Genuinely ambiguous whether this needs
  // resolving — PART 11's instruction applies: prefer the raw question over
  // a guessed resolution, so the caller must never inject synthetic context
  // into an UNKNOWN utterance's own resolved text. Word count only affects
  // whether it's substantial enough to become the new anchor for whatever
  // comes AFTER it (see conversation-tracker.js) — a fragment like "How?"
  // should not silently overwrite a real prior question as the anchor.
  const isSubstantial = normalized.split(/\s+/).filter(Boolean).length >= SUBSTANTIAL_WORD_COUNT;
  return { relation: QuestionRelation.UNKNOWN, confidence: Confidence.LOW, refinementSubtopic: null, isSubstantial };
}

export const __testing = {
  hasStandaloneSubject,
  extractRefinementSubtopic,
  CORRECTION_PATTERNS,
  TOPIC_SWITCH_PATTERNS,
  REFINEMENT_PATTERNS,
  COMPARISON_PATTERNS
};
