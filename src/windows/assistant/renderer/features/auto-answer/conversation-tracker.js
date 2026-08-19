/**
 * Follow-up resolution.
 *
 * "Why?" carries no answerable content by itself — sent to Gemini as-is it
 * would generate a generic, contextless answer. A person hearing it resolves
 * it instantly against what was just being discussed. This keeps just enough
 * running state to do the same: the last substantive host question, the last
 * answer given, and a short list of technical nouns mentioned recently
 * (project names, technologies, feature areas) — not a full transcript, per
 * the spec's own instruction not to resend everything.
 *
 * Utterance -> relation classification (NEW_TOPIC, FOLLOW_UP, REFINEMENT,
 * COMPARISON, CORRECTION, ...) lives in question-relation.js, as a pure,
 * stateless function — this module owns the actual conversation STATE
 * (what was asked, what's the current topic, how far back we remember) and
 * decides what to DO with a classification once question-relation.js has
 * produced one. Splitting it that way keeps the classification rules
 * independently testable without needing a tracker instance at all.
 */
import {
  QuestionRelation,
  Confidence,
  classifyUtterance,
  isBareFollowUp
} from './question-relation.js';
import { resolveSemanticReference } from './semantic-reference.js';

/*
 * Recognisable technical/proper nouns worth remembering as "what we were just
 * talking about." Deliberately narrow — this is a recency cache for pronoun
 * resolution, not a knowledge base; the resume/JD context engine (not built
 * this pass) is where real fact grounding belongs.
 *
 * An earlier version matched "any capitalised word," which reliably matched
 * ordinary sentence-starters too ("Because we needed..." -> "Because" logged
 * as a tracked entity). Matching only a known-technology list plus
 * structurally-distinctive tokens (CamelCase, PascalCase, a .js/.py suffix)
 * avoids that without a stopword blocklist that would always be one word
 * behind whatever a real conversation says next.
 */
const KNOWN_TECHNOLOGIES = new Set([
  'PostgreSQL', 'MongoDB', 'Redis', 'GraphQL', 'REST', 'gRPC', 'Kubernetes', 'Docker',
  'AWS', 'GCP', 'Azure', 'React', 'Vue', 'Angular', 'Node', 'Python', 'TypeScript',
  'JavaScript', 'FastAPI', 'Django', 'Flask', 'JWT', 'OAuth', 'MySQL', 'SQLite',
  'Kafka', 'RabbitMQ', 'Nginx', 'Terraform', 'Next', 'Express', 'Spring', 'LangGraph'
]);

/*
 * Common software/interview domain nouns — distinct from KNOWN_TECHNOLOGIES
 * (brand/product names) because these are lowercase, ordinary words that
 * would otherwise never be recognised as "a thing worth remembering." Added
 * specifically because REFINEMENT/COMPARISON follow-ups reference these
 * constantly ("the authentication part", "what about the backend") and
 * without recognising them, "authentication" or "backend" could never
 * become the tracked topic a later "What about refresh tokens?" needs to
 * resolve against. Bounded to the vocabulary actually exercised by the
 * spec's own examples plus immediate neighbours, not an open-ended list —
 * PART 6's instruction is relevance, not maximum recall.
 */
const COMMON_DOMAIN_NOUNS = new Set([
  'authentication', 'authorization', 'database', 'backend', 'frontend', 'api',
  'deployment', 'testing', 'caching', 'architecture', 'schema', 'infrastructure',
  'pipeline', 'security', 'scaling', 'performance', 'tradeoffs', 'tradeoff',
  'migration', 'indexing', 'replication', 'sharding', 'monitoring', 'logging'
]);

// CamelCase/PascalCase compounds (ExpenseTracker) or a filename-style suffix
// (auth.js) — both are structurally distinctive from ordinary capitalised
// words in a way "starts with a capital letter" alone is not.
const STRUCTURAL_ENTITY_PATTERN = /\b([A-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*|[a-zA-Z0-9]+\.(?:js|ts|py))\b/g;

const MAX_TRACKED_ENTITIES = 6;
const MAX_TURN_HISTORY = 8;

function extractEntities(text) {
  const words = String(text || '').split(/\s+/).map((w) => w.replace(/[^a-zA-Z0-9.]/g, ''));
  const known = words.filter((word) => KNOWN_TECHNOLOGIES.has(word));
  const domainNouns = words.filter((word) => COMMON_DOMAIN_NOUNS.has(word.toLowerCase())).map((word) => word.toLowerCase());
  const structural = String(text || '').match(STRUCTURAL_ENTITY_PATTERN) || [];
  return [...new Set([...known, ...domainNouns, ...structural])];
}

export function createConversationTracker() {
  const turns = []; // bounded recent history, most-recent last
  let lastHostQuestion = null;   // { text, entities, ts }
  let lastAnswerGiven = null;    // text of the most recent answer, for "why?" chains
  const trackedEntities = [];    // recency-ordered, most-recent last

  function noteEntities(text) {
    for (const entity of extractEntities(text)) {
      const existingIndex = trackedEntities.indexOf(entity);
      if (existingIndex !== -1) trackedEntities.splice(existingIndex, 1);
      trackedEntities.push(entity);
    }
    while (trackedEntities.length > MAX_TRACKED_ENTITIES) trackedEntities.shift();
  }

  function noteEntity(entity) {
    if (!entity) return;
    const existingIndex = trackedEntities.indexOf(entity);
    if (existingIndex !== -1) trackedEntities.splice(existingIndex, 1);
    trackedEntities.push(entity);
    while (trackedEntities.length > MAX_TRACKED_ENTITIES) trackedEntities.shift();
  }

  function pushTurn(turn) {
    turns.push(turn);
    while (turns.length > MAX_TURN_HISTORY) turns.shift();
  }

  /** User (candidate) speech: never answered, but it's the richest source of facts. */
  function recordUserTurn(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    noteEntities(trimmed);
    pushTurn({ speaker: 'user', text: trimmed, ts: Date.now() });
  }

  /**
   * Host speech that was judged NOT worth answering (small talk, "okay",
   * mid-sentence fragments). Still updates entity memory — the host naming a
   * technology while thinking out loud is still useful context later.
   */
  function recordHostContext(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    noteEntities(trimmed);
    pushTurn({ speaker: 'host', text: trimmed, ts: Date.now() });
  }

  /** Call once an answer has actually been generated for a host question. */
  function recordAnswer(text) {
    lastAnswerGiven = String(text || '').trim() || null;
  }

  /**
   * Resolves `text` into something Gemini can actually answer, using
   * question-relation.js's classification plus this tracker's own state
   * (last host question, last answer, recently mentioned entities).
   *
   * Confidence governs whether resolution happens at all: HIGH/MEDIUM with
   * real prior context to anchor to -> resolve. LOW, or no context yet, or
   * an outright NEW_TOPIC/TOPIC_SWITCH -> the utterance passes through
   * unresolved, exactly as PART 11 specifies ("prefer the original question
   * rather than hallucinating context").
   *
   * @returns {{ resolved: string, raw: string, wasResolved: boolean, topic: string|null, relation: string, confidence: string }}
   */
  function resolveQuestion(text) {
    const trimmed = String(text || '').trim();

    // Snapshotted BEFORE noteEntities(trimmed) below. This matters: for a
    // comparison like "What about MongoDB?", noteEntities would push
    // "MongoDB" itself onto trackedEntities, and reading the topic AFTER
    // that would make the resolution say "regarding MongoDB" — the new
    // thing being asked about, not the prior thing it's being compared
    // against. Capturing the topic first is what keeps "comparing with
    // PostgreSQL" correct.
    const priorTopic = trackedEntities.at(-1) || null;
    const priorAnchor = lastHostQuestion?.text || null;
    // Snapshotted here too, before anything below can touch it (TOPIC_SWITCH
    // clears lastAnswerGiven) — Phase 6 needs "the answer to the question
    // before this one," not whatever lastAnswerGiven ends up holding after
    // this call returns.
    const previousAnswer = lastAnswerGiven;
    const hasContext = Boolean(lastHostQuestion || lastAnswerGiven);

    noteEntities(trimmed);
    const ownEntities = extractEntities(trimmed);

    const { relation, confidence, refinementSubtopic, isSubstantial } = classifyUtterance(trimmed, { hasContext });

    if (relation === QuestionRelation.TOPIC_SWITCH) {
      // Explicit signal to drop what was being discussed — the answer for
      // whatever comes next must not be contaminated by the old subject.
      lastAnswerGiven = null;
    }

    if (relation === QuestionRelation.NEW_TOPIC || relation === QuestionRelation.TOPIC_SWITCH) {
      // Phase 7: deliberately NOT run through the semantic reference
      // resolver. hasStandaloneSubject() (question-relation.js) already
      // excludes any subject starting with that/it/this/those/these before
      // a relation can ever land here, so there is no bare pronoun to
      // resolve -- this is exactly the "clear NEW_TOPIC question" case the
      // spec requires stays untouched.
      lastHostQuestion = { text: trimmed, entities: ownEntities, ts: Date.now() };
      pushTurn({ speaker: 'host', text: trimmed, ts: Date.now(), isQuestion: true, relation, confidence });
      return {
        resolved: trimmed, raw: trimmed, wasResolved: false, topic: trackedEntities.at(-1) || null, relation, confidence,
        previousQuestion: priorAnchor, previousAnswer, activeEntities: trackedEntities.slice(),
        canonicalQuestion: null, referenceType: null, resolutionReason: null
      };
    }

    if (relation === QuestionRelation.UNKNOWN && isSubstantial) {
      // Matches no context-dependent frame AND is long enough to be a real
      // question in its own right (e.g. "Why did you choose PostgreSQL?" —
      // not a follow-up shape, just an opener this classifier's standalone
      // list doesn't happen to include). Treated exactly like NEW_TOPIC for
      // anchoring: it becomes what later follow-ups resolve against. This
      // is what keeps a multi-turn sequence from getting stuck on the
      // first-ever topic forever just because later questions use openers
      // ("why", "how", "when") outside the small standalone-subject list.
      //
      // Phase 7: this is also exactly the gap the mega-prompt is about --
      // "How does that scale though?" lands here too (no recognized frame,
      // 5 words), and question-relation.js has no way to tell it apart from
      // a genuine standalone opener. The semantic reference resolver is the
      // second-pass check for that: does this SPECIFIC utterance actually
      // contain a reference (pronoun/ellipsis/anaphor) with a real
      // antecedent in already-tracked state? If so, canonicalQuestion
      // carries the resolution; if not (e.g. "How does Redis scale?" --
      // Redis is the utterance's own explicit subject), it's a no-op and
      // this branch's anchoring behavior is completely unchanged.
      lastHostQuestion = { text: trimmed, entities: ownEntities, ts: Date.now() };
      pushTurn({ speaker: 'host', text: trimmed, ts: Date.now(), isQuestion: true, relation, confidence });
      const reference = resolveSemanticReference({
        utterance: trimmed,
        ownEntities,
        activeTopic: priorTopic,
        activeEntities: trackedEntities.slice(),
        previousQuestionEntities: extractEntities(priorAnchor || ''),
        previousAnswerEntities: extractEntities(previousAnswer || '')
      });
      return {
        resolved: trimmed, raw: trimmed, wasResolved: false, topic: trackedEntities.at(-1) || null, relation, confidence,
        previousQuestion: priorAnchor, previousAnswer, activeEntities: trackedEntities.slice(),
        canonicalQuestion: reference.resolved ? reference.canonicalQuestion : null,
        referenceType: reference.resolved ? reference.referenceType : null,
        resolutionReason: reference.resolved ? reference.reason : null
      };
    }

    if (relation === QuestionRelation.UNKNOWN || confidence === Confidence.LOW || !hasContext) {
      // A short, genuinely ambiguous fragment, or a recognized-but-
      // unconfident frame with nothing to resolve against yet. Passed
      // through as-is, and does NOT overwrite an existing anchor — unlike
      // the isSubstantial case above, there's no real signal this is a new
      // question at all (see PART 11: prefer raw over a guessed
      // resolution).
      if (!lastHostQuestion) {
        lastHostQuestion = { text: trimmed, entities: ownEntities, ts: Date.now() };
      }
      pushTurn({ speaker: 'host', text: trimmed, ts: Date.now(), isQuestion: true, relation: QuestionRelation.UNKNOWN, confidence: Confidence.LOW });
      // Phase 7: run the same second-pass check here too -- this branch
      // covers both non-substantial fragments and any frame-matched-but-
      // low-confidence case (both ultimately because hasContext was false at
      // classification time). When there is real tracked state (hasContext
      // true but the fragment itself was just too short to trust as an
      // anchor) this can still resolve; when there truly is no context, the
      // resolver's own tiers all come up empty and this is a no-op.
      const reference = resolveSemanticReference({
        utterance: trimmed,
        ownEntities,
        activeTopic: priorTopic,
        activeEntities: trackedEntities.slice(),
        previousQuestionEntities: extractEntities(priorAnchor || ''),
        previousAnswerEntities: extractEntities(previousAnswer || '')
      });
      return {
        resolved: trimmed, raw: trimmed, wasResolved: false, topic: priorTopic, relation: QuestionRelation.UNKNOWN, confidence: Confidence.LOW,
        previousQuestion: priorAnchor, previousAnswer, activeEntities: trackedEntities.slice(),
        canonicalQuestion: reference.resolved ? reference.canonicalQuestion : null,
        referenceType: reference.resolved ? reference.referenceType : null,
        resolutionReason: reference.resolved ? reference.reason : null
      };
    }

    // From here on: FOLLOW_UP / REFINEMENT / CLARIFICATION / CORRECTION /
    // EXPANSION / CONTINUATION / COMPARISON, all with real prior context
    // and enough confidence to actually resolve against it.
    let resolved;
    let effectiveTopic = priorTopic;

    if (relation === QuestionRelation.CORRECTION) {
      // Redirect, not a follow-up: the interviewer is overriding what they
      // just asked, not building on it. The corrected utterance becomes the
      // new anchor so a later follow-up pins to the correction, not the
      // misunderstood original (PART 13's "context transition").
      resolved = priorAnchor
        ? `${trimmed} — correcting the previous question ("${priorAnchor}"); answer this instead`
        : trimmed;
      lastHostQuestion = { text: trimmed, entities: ownEntities, ts: Date.now() };
    } else if (relation === QuestionRelation.REFINEMENT && refinementSubtopic) {
      // Narrows within the active project/topic rather than replacing it —
      // both stay visible in the resolution so the answer model knows the
      // subtopic is scoped to the parent, not standalone.
      noteEntity(refinementSubtopic);
      effectiveTopic = refinementSubtopic;
      resolved = priorTopic
        ? `${trimmed} (about the "${refinementSubtopic}" part of ${priorTopic})`
        : `${trimmed} (about the "${refinementSubtopic}" part of what we were discussing)`;
    } else if (relation === QuestionRelation.COMPARISON && priorTopic) {
      resolved = priorAnchor
        ? `${trimmed} — comparing with ${priorTopic}, following up on: "${priorAnchor}"`
        : `${trimmed} — comparing with ${priorTopic}`;
    } else if (priorTopic) {
      resolved = priorAnchor
        ? `${trimmed} (following up on: "${priorAnchor}", specifically regarding ${priorTopic})`
        : `${trimmed} (regarding ${priorTopic})`;
    } else if (priorAnchor) {
      resolved = `${trimmed} (following up on: "${priorAnchor}")`;
    } else {
      resolved = trimmed;
    }

    pushTurn({ speaker: 'host', text: trimmed, resolvedText: resolved, ts: Date.now(), isQuestion: true, relation, confidence });
    // Phase 7: the semantic reference resolver is NOT invoked here. This
    // branch already produced a real resolution above (question-relation.js
    // recognized the frame with real context to resolve against) -- re-
    // running reference detection on top of it would either agree (no new
    // information) or risk contradicting an already-correct answer. Mirror
    // `resolved` as canonicalQuestion instead of duplicating that reasoning:
    // it's the same fact, so ACTIVE CONTEXT does not render it a second time
    // (see formatActiveContextBlock below) -- exactly the duplication Phase
    // 6 removed elsewhere would reappear if it did.
    return {
      resolved, raw: trimmed, wasResolved: resolved !== trimmed, topic: effectiveTopic, relation, confidence,
      previousQuestion: priorAnchor, previousAnswer, activeEntities: trackedEntities.slice(),
      canonicalQuestion: resolved, referenceType: null, resolutionReason: null
    };
  }

  function getRecentTurns() {
    return turns.slice();
  }

  function reset() {
    turns.length = 0;
    trackedEntities.length = 0;
    lastHostQuestion = null;
    lastAnswerGiven = null;
  }

  return {
    recordUserTurn,
    recordHostContext,
    recordAnswer,
    resolveQuestion,
    getRecentTurns,
    reset
  };
}

// Real export, not test-only: auto-answer.js's own looksLikeQuestion() has a
// 12-char noise floor (filtering backchannel like "mm-hm") that also filters
// out exactly the short, legitimate follow-ups this module exists to
// resolve — "Why?" is 4 characters. That gate needs to special-case these
// patterns rather than reject them outright. Sourced from question-relation.js
// now (Phase 3) — re-exported here so auto-answer.js's existing import site
// does not need to change.
export { isBareFollowUp };

/**
 * Phase 6: renders a resolveQuestion() result into the compact, explicit
 * scaffolding block the prompt calls ACTIVE CONTEXT — "what does Synapse
 * already understand about this turn," made explicit instead of left for
 * Gemini to re-derive from raw transcript. Pure function of the result
 * object; no tracker state read directly, so it's usable (and testable)
 * anywhere a resolveQuestion() result is available, not just inside
 * auto-answer.js.
 *
 * Only NEW_TOPIC/UNKNOWN-with-nothing-resolved turns produce a thin block
 * (current question only) — there's nothing else confidently known yet, and
 * per Phase 3's own rule, this must never fabricate an anchor.
 */
export function formatActiveContextBlock(result) {
  if (!result) return '';

  const lines = [`Current question: ${result.raw}`];
  lines.push(`Relation: ${result.relation}`);
  lines.push(`Confidence: ${result.confidence}`);
  if (result.topic) lines.push(`Active topic: ${result.topic}`);
  if (result.previousQuestion) lines.push(`Previous question: ${result.previousQuestion}`);
  if (result.previousAnswer) lines.push(`Previous answer: ${result.previousAnswer}`);
  if (result.activeEntities && result.activeEntities.length > 0) {
    lines.push(`Relevant entities: ${result.activeEntities.join(', ')}`);
  }
  // Phase 7: only rendered when the semantic reference resolver itself found
  // something (resolutionReason is only ever set by that path -- see
  // resolveQuestion above). Deliberately NOT rendered when
  // question-relation.js's own frame-matched branch already resolved the
  // turn: that resolution already appears in full down in RELEVANT RECENT
  // CONVERSATION (as the annotated Host: line), and repeating the same fact
  // here a second time is exactly the duplication Phase 6 removed.
  if (result.resolutionReason) {
    lines.push(`Resolved question: ${result.canonicalQuestion}`);
    lines.push(`Resolution: ${result.resolutionReason}`);
  }

  return lines.join('\n');
}

export const __testing = { isBareFollowUp, extractEntities };
