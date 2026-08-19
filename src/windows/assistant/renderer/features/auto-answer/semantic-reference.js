/**
 * Phase 7 — semantic reference resolution.
 *
 * The gap this closes: question-relation.js only recognizes a bounded set of
 * explicit grammatical FRAMES ("what about X", "elaborate", the bare-pronoun
 * list, ...). A real interviewer follow-up like "How does that scale
 * though?" matches none of them -- it isn't shaped like any of those frames,
 * it's an ordinary WH-question that happens to contain a pronoun with no
 * antecedent of its own. question-relation.js correctly calls this UNKNOWN
 * (it genuinely doesn't recognize the shape), but UNKNOWN today means "treat
 * as a new, self-contained question" -- which silently drops "that" instead
 * of resolving it.
 *
 * This module does NOT reclassify relation (question-relation.js remains the
 * sole authority for that) and does NOT replace conversation-tracker.js's
 * own already-correct resolution for frame-matched turns (COMPARISON,
 * REFINEMENT, CORRECTION, ...) -- conversation-tracker.js only calls this for
 * the two cases it currently produces no resolution for at all. It is a
 * second, narrower pass: given an utterance question-relation.js couldn't
 * place, does it contain a REFERENCE (a pronoun, a possessive, a bare
 * "and X?" ellipsis, an anaphoric "that approach") with a real antecedent
 * available in conversation-tracker.js's already-tracked state?
 *
 * Pure and stateless, like question-relation.js -- every input is plain data
 * the caller already has (or already computes via extractEntities), so this
 * never needs to reach back into conversation-tracker.js's internals. That
 * keeps the dependency direction one-way (conversation-tracker.js calls this,
 * never the reverse) and keeps this fully unit-testable on its own.
 *
 * FALSE NEGATIVE > HALLUCINATED CONTEXT: every path that isn't confident
 * returns `resolved: false` and leaves the raw utterance untouched. Nothing
 * here ever invents an antecedent that isn't actually present in the given
 * context.
 */

export const ReferenceType = Object.freeze({
  PRONOUN_REFERENCE: 'PRONOUN_REFERENCE',
  ELLIPTICAL_REFERENCE: 'ELLIPTICAL_REFERENCE',
  ANAPHORIC_CONCEPT_REFERENCE: 'ANAPHORIC_CONCEPT_REFERENCE',
  CONTEXTUAL_FOLLOWUP: 'CONTEXTUAL_FOLLOWUP',
  NONE: 'NONE'
});

// Small, bounded, deliberately generic vocab -- these are grammatical
// classes (pronoun, possessive, a handful of abstract "decision" nouns), not
// per-topic patterns. Same principle question-relation.js's own header
// comment describes: group by FRAME, don't enumerate examples.
const PRONOUN_MARKERS = /\b(that|it|this|they|those|its)\b/i;
const POSSESSIVE_MARKER = /\bits\b/i;

// A "that/this/the <abstract noun>" phrase -- "that approach", "the
// implementation" -- refers to whatever was just being discussed, not to a
// standalone concept. Deliberately requires the determiner to sit DIRECTLY
// before the noun: "the database design" does NOT match (there's a specific
// modifier -- "database" -- between "the" and "design"), which is exactly
// the signal that phrase already names its own subject and needs no
// substitution. Bounded, generic list -- not a per-topic pattern set.
const CONCEPT_NOUNS = ['approach', 'decision', 'design', 'architecture', 'implementation', 'strategy', 'solution', 'choice'];
const ANAPHORIC_CONCEPT_PATTERN = new RegExp(`\\b(that|this|the)\\s+(${CONCEPT_NOUNS.join('|')})\\b`, 'i');

// "How does X work/scale/..." / "Why is X better/worse" / "Would X be..." --
// the WH-question shapes the mega-prompt calls CONTEXTUAL_FOLLOWUP. Purely a
// more specific LABEL over the same pronoun-substitution handling as plain
// PRONOUN_REFERENCE; doesn't change what gets resolved or how.
const CONTEXTUAL_FOLLOWUP_OPENER = /^(how (does|did|would|do|should)|why (is|was|would|did)|would)\b/i;

// A short "and X?" / "what about X?" / "how about X?" / "at X?" fragment
// with no verb of its own -- structurally presupposes a subject the same way
// question-relation.js's own COMPARISON_PATTERNS do, just used here to build
// the CANONICAL text rather than to classify relation.
const ELLIPSIS_FRAME = /^(and\s+|what about\s+|how about\s+|at\s+)/i;

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'is', 'are', 'was', 'were']);

function normalize(text) {
  return String(text || '').trim().replace(/[.?!]+$/, '').trim();
}

function isHardEntity(entity) {
  return /^[A-Z]/.test(entity);
}

function contentWordCount(text) {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !STOPWORDS.has(word)).length;
}

/**
 * Does this utterance already carry its own explicit subject? A hard
 * (capitalized) entity of its own -- "Redis", "MongoDB" -- always means yes,
 * regardless of any pronoun/ellipsis shape also present (this is what makes
 * "How does Redis scale?" stay about Redis instead of being dragged onto
 * whatever the active topic was). This check runs BEFORE any reference
 * detection below, specifically so new-topic protection is not a special
 * case bolted on afterward -- it's the first thing checked.
 */
function hasOwnHardEntity(ownEntities) {
  return (ownEntities || []).some(isHardEntity);
}

/**
 * Classifies what kind of reference (if any) `utterance` makes, without
 * deciding what it resolves to -- that's selectAntecedent's job. Returns
 * `{ type, strippedContent }`; `strippedContent` is only meaningful for
 * ELLIPTICAL_REFERENCE (the fragment with its frame prefix removed).
 */
function detectReference(utterance, ownEntities) {
  if (hasOwnHardEntity(ownEntities)) {
    return { type: ReferenceType.NONE, strippedContent: null };
  }

  const normalized = normalize(utterance);

  if (ANAPHORIC_CONCEPT_PATTERN.test(normalized)) {
    return { type: ReferenceType.ANAPHORIC_CONCEPT_REFERENCE, strippedContent: null };
  }

  if (PRONOUN_MARKERS.test(normalized)) {
    const type = CONTEXTUAL_FOLLOWUP_OPENER.test(normalized)
      ? ReferenceType.CONTEXTUAL_FOLLOWUP
      : ReferenceType.PRONOUN_REFERENCE;
    return { type, strippedContent: null };
  }

  if (ELLIPSIS_FRAME.test(normalized)) {
    const strippedContent = normalized.replace(ELLIPSIS_FRAME, '').trim();
    // Only a single bare aspect word ("security", "scale") is genuinely
    // elliptical -- "what about transaction performance?" already supplies
    // its own specific compound noun phrase and must NOT be rewritten onto
    // the active topic (see the module header and PART on "transaction
    // performance" in the spec this implements).
    if (strippedContent && contentWordCount(strippedContent) <= 1) {
      return { type: ReferenceType.ELLIPTICAL_REFERENCE, strippedContent };
    }
  }

  return { type: ReferenceType.NONE, strippedContent: null };
}

/**
 * The 5-tier antecedent priority the spec requires, implemented directly
 * over conversation-tracker.js's own already-computed state -- no new
 * tracking, no re-derivation of anything conversation-tracker.js doesn't
 * already have. Tiers 1-2 (the curated active topic, or a tracked hard
 * entity) are treated as HIGH confidence; tiers 3-5 (falling back to
 * extracting from the raw previous-question/previous-answer text, or a
 * generic tracked domain noun) are treated as MEDIUM -- genuinely weaker
 * signals, per the confidence policy's own definition of MEDIUM ("multiple
 * plausible antecedents, one favored"). No candidate at all -> null (tier 6).
 */
function selectAntecedent({ activeTopic, activeEntities = [], previousQuestionEntities = [], previousAnswerEntities = [] }) {
  if (activeTopic) {
    return { candidate: activeTopic, confidence: 'HIGH', source: 'active topic' };
  }

  const trackedHardEntity = [...activeEntities].reverse().find(isHardEntity);
  if (trackedHardEntity) {
    return { candidate: trackedHardEntity, confidence: 'HIGH', source: 'a tracked entity' };
  }

  const fromQuestion = previousQuestionEntities.find(isHardEntity) || previousQuestionEntities[0];
  if (fromQuestion) {
    return { candidate: fromQuestion, confidence: 'MEDIUM', source: 'the previous question' };
  }

  const fromAnswer = previousAnswerEntities.find(isHardEntity) || previousAnswerEntities[0];
  if (fromAnswer) {
    return { candidate: fromAnswer, confidence: 'MEDIUM', source: 'the previous answer' };
  }

  const domainNoun = [...activeEntities].reverse().find((e) => !isHardEntity(e));
  if (domainNoun) {
    return { candidate: domainNoun, confidence: 'MEDIUM', source: 'recent conversation' };
  }

  return null;
}

function substitutePronoun(utterance, candidate) {
  if (POSSESSIVE_MARKER.test(utterance)) {
    return utterance.replace(POSSESSIVE_MARKER, `${candidate}'s`);
  }
  return utterance.replace(/\b(that|it|this|they|those)\b/i, candidate);
}

function substituteAnaphoricConcept(utterance, candidate) {
  return utterance.replace(ANAPHORIC_CONCEPT_PATTERN, (_match, _det, noun) => `${candidate}'s ${noun}`);
}

function buildCanonicalQuestion({ type, utterance, strippedContent, candidate, resolverConfidence }) {
  // MEDIUM: "preserve enough original wording to avoid hallucination" -- add
  // the antecedent alongside the original question rather than rewriting it
  // inline, so a weaker-tier guess never silently overwrites the host's own
  // words.
  if (resolverConfidence === 'MEDIUM') {
    return `${utterance} (regarding ${candidate})`;
  }

  switch (type) {
    case ReferenceType.ANAPHORIC_CONCEPT_REFERENCE:
      return substituteAnaphoricConcept(utterance, candidate);
    case ReferenceType.PRONOUN_REFERENCE:
    case ReferenceType.CONTEXTUAL_FOLLOWUP:
      return substitutePronoun(utterance, candidate);
    case ReferenceType.ELLIPTICAL_REFERENCE:
      return `What about ${strippedContent} for ${candidate}?`;
    default:
      return utterance;
  }
}

function buildReason({ type, candidate, source }) {
  switch (type) {
    case ReferenceType.ANAPHORIC_CONCEPT_REFERENCE:
      return `The reference to "the ${source === 'active topic' ? candidate : candidate}" concept resolves to ${candidate}.`;
    case ReferenceType.ELLIPTICAL_REFERENCE:
      return `This is a follow-up aspect being asked about ${candidate}, inferred from ${source}.`;
    case ReferenceType.PRONOUN_REFERENCE:
    case ReferenceType.CONTEXTUAL_FOLLOWUP:
      return `The pronoun refers to ${candidate} (${source}).`;
    default:
      return `Inferred ${candidate} from ${source}.`;
  }
}

/**
 * @param {{
 *   utterance: string,
 *   ownEntities: string[],
 *   activeTopic: string|null,
 *   activeEntities: string[],
 *   previousQuestionEntities: string[],
 *   previousAnswerEntities: string[]
 * }} input
 * @returns {{
 *   resolved: boolean,
 *   confidence: 'HIGH'|'MEDIUM'|'LOW',
 *   referenceType: string,
 *   resolvedTopic: string|null,
 *   canonicalQuestion: string|null,
 *   reason: string|null
 * }}
 */
export function resolveSemanticReference({
  utterance,
  ownEntities = [],
  activeTopic = null,
  activeEntities = [],
  previousQuestionEntities = [],
  previousAnswerEntities = []
} = {}) {
  const { type, strippedContent } = detectReference(utterance, ownEntities);

  if (type === ReferenceType.NONE) {
    return { resolved: false, confidence: 'LOW', referenceType: ReferenceType.NONE, resolvedTopic: null, canonicalQuestion: null, reason: null };
  }

  const antecedent = selectAntecedent({ activeTopic, activeEntities, previousQuestionEntities, previousAnswerEntities });
  if (!antecedent) {
    // A reference was detected but nothing in tracked state can fill it --
    // exactly the "no reliable antecedent" LOW case. Never invent one.
    return { resolved: false, confidence: 'LOW', referenceType: type, resolvedTopic: null, canonicalQuestion: null, reason: null };
  }

  const canonicalQuestion = buildCanonicalQuestion({
    type,
    utterance,
    strippedContent,
    candidate: antecedent.candidate,
    resolverConfidence: antecedent.confidence
  });

  return {
    resolved: true,
    confidence: antecedent.confidence,
    referenceType: type,
    resolvedTopic: antecedent.candidate,
    canonicalQuestion,
    reason: buildReason({ type, candidate: antecedent.candidate, source: antecedent.source })
  };
}

export const __testing = {
  detectReference,
  selectAntecedent,
  hasOwnHardEntity,
  contentWordCount
};
