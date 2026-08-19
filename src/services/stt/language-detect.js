'use strict';

/**
 * Language detection over a transcript, used for two things: choosing which STT
 * engine to trust, and telling the answering model which language to reply in.
 *
 * Deliberately lexical rather than statistical — it runs on every final
 * transcript in the hot path, and the three-way call it has to make
 * (English / Hindi / Hinglish) is well served by script plus a marker list.
 */

const DEVANAGARI = /[ऀ-ॿ]/;

/**
 * Romanised Hindi function words. Content words are borrowed freely in Indian
 * English ("scale", "production"), so only grammatical glue is a reliable
 * signal — these are the words that rarely appear in plain English.
 */
// Excludes tokens that are also ordinary English words — "the", "to", "main",
// "par", "na", "ya". Hindi "थे" romanises to "the", and letting that count made
// every English sentence look like Hinglish.
const HINGLISH_MARKERS = /\b(aap|aapko|aapka|hai|hain|tha|thi|kya|kyun|kyu|kaise|kaisa|kitna|kitne|kitni|matlab|lekin|magar|abhi|phir|bhi|nahi|nahin|haan|acha|accha|theek|thik|karke|karna|karta|karte|kiya|hua|hoga|raha|rahe|rahi|mera|meri|tera|apna|apne|humne|hamara|unka|iska|uska|woh|yeh|ye|bata|batao|bataiye|samajh|zyada|thoda|bilkul|sirf|liye|wala|wale|mein|ko|ka|ki|ke|aur|toh)\b/gi;

// AssemblyAI's English model shreds Hindi into short nonsense tokens. A high
// ratio of very short "words" is the fingerprint of that failure — but English
// is itself full of short words ("a", "me", "you"), so the ratio alone is not
// enough. It only convicts when a Hindi marker survived the mangling too.
// A ratio threshold on its own is unusable: "Walk me through the architecture
// you chose and why" is 56% short words and perfectly good English. Only a
// surviving Hindi marker makes a high ratio meaningful.
const SHORT_RATIO_WITH_MARKER = 0.25;

function countMatches(text, pattern) {
  const matches = String(text || '').match(pattern);
  return matches ? matches.length : 0;
}

function tokenize(text) {
  return String(text || '')
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
}

/**
 * @returns {{ language: 'hi'|'en'|'hinglish', confidence: number, devanagari: boolean, markers: number }}
 */
function detectLanguage(text) {
  const trimmed = String(text || '').trim();

  if (!trimmed) {
    return { language: 'en', confidence: 0, devanagari: false, markers: 0 };
  }

  const tokens = tokenize(trimmed);
  const devanagariChars = countMatches(trimmed, new RegExp(DEVANAGARI, 'g'));
  const hasDevanagari = devanagariChars > 0;
  const markers = countMatches(trimmed, HINGLISH_MARKERS);
  const markerRatio = tokens.length ? markers / tokens.length : 0;

  // Devanagari present: Hindi, unless a real share of Latin words rides along,
  // which is what code-switched Hinglish actually looks like.
  if (hasDevanagari) {
    const latinTokens = tokens.filter((token) => /^[A-Za-z]+$/.test(token)).length;
    const latinRatio = tokens.length ? latinTokens / tokens.length : 0;
    return {
      language: latinRatio >= 0.2 ? 'hinglish' : 'hi',
      confidence: 0.95,
      devanagari: true,
      markers
    };
  }

  // Romanised Hindi mixed with English words.
  if (markers >= 2 && markerRatio >= 0.12) {
    return { language: 'hinglish', confidence: Math.min(0.9, 0.5 + markerRatio), devanagari: false, markers };
  }

  return { language: 'en', confidence: markers ? 0.6 : 0.85, devanagari: false, markers };
}

/**
 * Heuristic for "the English STT engine probably mangled a non-English
 * utterance" — the trigger for re-transcribing with the multilingual engine.
 */
function looksLikeMistranscription(text) {
  const tokens = tokenize(text);
  if (tokens.length < 4) return false;

  const shortTokens = tokens.filter((token) => token.length <= 3).length;
  const shortRatio = shortTokens / tokens.length;
  const { markers, devanagari } = detectLanguage(text);

  // Devanagari came from a multilingual engine and is already correct.
  if (devanagari) return false;

  if (markers >= 2) return true;
  return markers >= 1 && shortRatio >= SHORT_RATIO_WITH_MARKER;
}

/** Instruction injected into the answering prompt so the reply matches the ask. */
function buildLanguageInstruction(language) {
  switch (language) {
    case 'hi':
      return 'The speaker asked in Hindi. Reply in natural conversational Hindi (Devanagari). '
        + 'Keep established technical terms in English rather than forcing literal translations.';
    case 'hinglish':
      return 'The speaker asked in Hinglish (Hindi-English code-switching). Reply in the same Hinglish register: '
        + 'Hindi sentence structure with English technical vocabulary, exactly as an Indian professional would speak. '
        + 'Do not answer in pure Hindi or pure English.';
    default:
      return 'The speaker asked in English. Reply in English.';
  }
}

module.exports = {
  buildLanguageInstruction,
  detectLanguage,
  looksLikeMistranscription
};
