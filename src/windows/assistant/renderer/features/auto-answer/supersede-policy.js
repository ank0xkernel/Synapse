/**
 * Supersede-while-busy policy.
 *
 * auto-answer.js's queue answers every question in the order it arrived,
 * deliberately — nothing the interviewer asked should ever be silently
 * dropped. But that rule breaks down in one real case: the interviewer
 * extends or clarifies the question WHILE Synapse is still generating the
 * first answer ("What is React?" -> mid-answer -> "give me an example,
 * where have you implemented React Native in your project?"). Strict FIFO
 * finishes the stale answer first and only then starts the real one, by
 * which point the interviewer has already moved on.
 *
 * A genuinely new, unrelated question must still queue normally. Only a
 * question that reads as continuing/refining/correcting the one currently
 * in flight should jump the queue and cancel the stale generation.
 *
 * Pure and DOM-free on purpose — auto-answer.js itself can't be imported
 * under plain Node (it touches `document` at module scope), so the policy
 * decision lives here where it's directly testable.
 */
import { QuestionRelation } from './question-relation.js';

export const SUPERSEDE_RELATIONS = new Set([
    QuestionRelation.FOLLOW_UP,
    QuestionRelation.REFINEMENT,
    QuestionRelation.CLARIFICATION,
    QuestionRelation.EXPANSION,
    QuestionRelation.CONTINUATION,
    QuestionRelation.COMPARISON,
    QuestionRelation.CORRECTION
]);

// classifyUtterance (question-relation.js) has no pattern for phrasings like
// "give me an example ... where you've implemented X" — a common interview
// follow-up shape EXPANSION_PATTERNS doesn't cover — so it falls out as
// UNKNOWN. Rather than chase every such phrasing with more regexes, an
// UNKNOWN-relation question arriving this soon after the current one was
// dispatched is treated as very likely still elaborating it: there simply
// hasn't been time for the interviewer to have formulated and asked a whole
// separate question. Past this window, UNKNOWN falls back to the FIFO queue.
export const SUPERSEDE_UNKNOWN_WINDOW_MS = 6000;

/**
 * @param {string} relation - one of QuestionRelation, classified against the
 *   question currently in flight (i.e. conversationTracker.resolveQuestion()
 *   called on the new utterance while the old one is still the tracker's
 *   lastHostQuestion).
 * @param {number|null|undefined} dispatchedAt - Date.now() when the
 *   in-flight question was dispatched, or null/undefined if nothing is
 *   actually in flight.
 * @param {number} now - injectable for testing; defaults to Date.now().
 */
export function shouldSupersede(relation, dispatchedAt, now = Date.now()) {
    if (!dispatchedAt) return false; // nothing actually in flight to interrupt
    if (SUPERSEDE_RELATIONS.has(relation)) return true;
    if (relation === QuestionRelation.UNKNOWN) {
        return (now - dispatchedAt) < SUPERSEDE_UNKNOWN_WINDOW_MS;
    }
    // NEW_TOPIC / TOPIC_SWITCH: a deliberate, independent question — the
    // in-flight answer is still worth having, so it stays FIFO.
    return false;
}
