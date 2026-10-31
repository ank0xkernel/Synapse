'use strict';

/**
 * Response modes for live answers. Each mode changes the instruction the model
 * receives (appended last in the answer prompt, so it overrides the general
 * length/format guidance) and the output token budget.
 *
 * Every mode keeps the grounding rule: answers draw only on the candidate's
 * real background, and a missing experience is stated, never invented.
 */

const GROUNDING = 'Use only experience that appears in the candidate background above. If the question needs '
  + 'experience the candidate does not have, say so plainly and answer with how they would approach it. '
  + 'Never invent an employer, project, metric, or result.';

const RESPONSE_MODES = Object.freeze({
  quick: Object.freeze({
    id: 'quick',
    label: 'Quick',
    description: 'Short, immediate answer',
    maxOutputTokens: 300,
    thinkingLevel: 'low',
    instruction: 'Answer in 1 to 3 short spoken sentences, about 10 to 20 seconds out loud. Lead with the direct '
      + 'answer. No headings and no bullet points. For a coding question give the key idea and its complexity in '
      + 'one or two lines instead of full code, unless the question literally asks for the code.'
  }),
  professional: Object.freeze({
    id: 'professional',
    label: 'Professional',
    description: 'Concise, contextual answer',
    maxOutputTokens: 800,
    thinkingLevel: 'low',
    instruction: 'Adaptive depth: follow the length guidance in the communication style above for this kind of '
      + 'question. Tie it to the role and the candidate\'s background only where that is relevant.'
  }),
  technical: Object.freeze({
    id: 'technical',
    label: 'Technical',
    description: 'Structured technical explanation',
    maxOutputTokens: 1200,
    thinkingLevel: 'low',
    instruction: 'Give a structured technical explanation. Open with 1 or 2 spoken sentences that answer directly. '
      + 'Then a **How it works** section of 3 to 6 bullets covering the mechanism, the key trade-offs, and failure '
      + 'modes or limits, with concrete technology names and complexity where relevant. Add a short code or '
      + 'pseudo-code block only when it makes the explanation clearer.'
  }),
  star: Object.freeze({
    id: 'star',
    label: 'STAR',
    description: 'Behavioral story structure',
    maxOutputTokens: 900,
    thinkingLevel: 'low',
    instruction: 'Answer as a first-person behavioral story with four short bold labels: **Situation**, **Task**, '
      + '**Action**, **Result**, each 1 to 3 sentences. The Action part is the longest and says what the candidate '
      + 'personally did. Quantify the Result only with numbers that appear in the background. If no real matching '
      + 'experience exists, say so in one sentence and give a clearly framed "here is how I would handle it" answer '
      + 'in the same four parts instead of a made-up story.'
  }),
  detailed: Object.freeze({
    id: 'detailed',
    label: 'Detailed',
    description: 'Expanded explanation',
    maxOutputTokens: 1600,
    thinkingLevel: 'low',
    instruction: 'Give a thorough answer, about 60 to 120 seconds out loud: the direct answer first, then the '
      + 'reasoning, a concrete example from the candidate\'s real background where one exists, the trade-offs, '
      + 'and what they would do differently next time. Short paragraphs; bullets only for lists of three or more.'
  })
});

const DEFAULT_RESPONSE_MODE = 'professional';

function getResponseMode(id) {
  return RESPONSE_MODES[id] || RESPONSE_MODES[DEFAULT_RESPONSE_MODE];
}

function resolveResponseModeId(id) {
  return RESPONSE_MODES[id] ? id : DEFAULT_RESPONSE_MODE;
}

/** The prompt block for a mode. Placed last so it overrides earlier length/format guidance. */
function buildResponseModeBlock(id) {
  const mode = getResponseMode(id);
  return `=== RESPONSE MODE: ${mode.label.toUpperCase()} (overrides the length and format guidance above) ===\n`
    + `${mode.instruction}\n${GROUNDING}`;
}

function listResponseModes() {
  return Object.values(RESPONSE_MODES).map(({ id, label, description }) => ({ id, label, description }));
}

module.exports = {
  RESPONSE_MODES,
  DEFAULT_RESPONSE_MODE,
  buildResponseModeBlock,
  getResponseMode,
  listResponseModes,
  resolveResponseModeId
};
