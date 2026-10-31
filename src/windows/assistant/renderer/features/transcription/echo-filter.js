/**
 * Cross-source echo filter.
 *
 * With speakers (not headphones), the microphone also hears the interviewer
 * coming out of the Mac. The host channel already carries that speech
 * digitally, so the mic copy would be stored as if the user had said it,
 * which mislabels "You" lines in the answer prompt. Chromium's echo
 * cancellation does not help: it only cancels audio this app itself plays.
 *
 * A mic final is treated as an echo when most of its words appeared in host
 * speech (finals or the live partial) within the last few seconds. Short
 * utterances need a near-total match, so a user saying "yes" right after the
 * interviewer said "yes or no?" is not swallowed by a two-word overlap.
 */

const DEFAULT_WINDOW_MS = 6000;
const MAX_HOST_ENTRIES = 12;

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Fraction of the mic utterance's words found in the host text (multiset aware). */
export function overlapRatio(micText, hostText) {
  const micWords = tokenize(micText);
  if (micWords.length === 0) return 0;
  const hostCounts = new Map();
  for (const word of tokenize(hostText)) hostCounts.set(word, (hostCounts.get(word) || 0) + 1);

  let matched = 0;
  for (const word of micWords) {
    const remaining = hostCounts.get(word) || 0;
    if (remaining > 0) {
      matched += 1;
      hostCounts.set(word, remaining - 1);
    }
  }
  return matched / micWords.length;
}

function requiredRatio(wordCount) {
  if (wordCount <= 2) return 1;
  if (wordCount <= 5) return 0.8;
  return 0.6;
}

export function createEchoFilter({ windowMs = DEFAULT_WINDOW_MS, now = () => Date.now() } = {}) {
  const hostFinals = [];
  let hostPartial = { text: '', at: 0 };

  function prune(at) {
    while (hostFinals.length && at - hostFinals[0].at > windowMs) hostFinals.shift();
    while (hostFinals.length > MAX_HOST_ENTRIES) hostFinals.shift();
  }

  return {
    noteHostFinal(text) {
      if (!String(text || '').trim()) return;
      const at = now();
      hostFinals.push({ text, at });
      prune(at);
    },

    noteHostPartial(text) {
      hostPartial = { text: String(text || ''), at: now() };
    },

    /** @returns {{echo: boolean, ratio: number}} */
    check(micText) {
      const at = now();
      prune(at);
      const words = tokenize(micText).length;
      if (words === 0) return { echo: false, ratio: 0 };

      const recentHost = hostFinals.map((entry) => entry.text);
      if (hostPartial.text && at - hostPartial.at <= windowMs) recentHost.push(hostPartial.text);
      if (recentHost.length === 0) return { echo: false, ratio: 0 };

      const ratio = overlapRatio(micText, recentHost.join(' '));
      return { echo: ratio >= requiredRatio(words), ratio };
    },

    reset() {
      hostFinals.length = 0;
      hostPartial = { text: '', at: 0 };
    }
  };
}
