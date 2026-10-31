const {
  getProgrammingLanguages,
  resolveProgrammingLanguage
} = require('../../config');
const interviewContext = require('../context/interview-context');
const { buildLanguageInstruction, detectLanguage } = require('../stt/language-detect');
const { buildResponseModeBlock } = require('./response-modes');
const { buildCommunicationStyleBlock } = require('./communication-style');

function buildContextBlock(label, content) {
  const normalizedContent = typeof content === 'string' ? content.trim() : '';
  return normalizedContent ? `${label}:\n${normalizedContent}\n\n` : '';
}

function getCodeFenceLanguage(programmingLanguage) {
  const resolvedLanguage = resolveProgrammingLanguage(programmingLanguage);

  switch (resolvedLanguage) {
    case 'C++':
      return 'cpp';
    case 'C#':
      return 'csharp';
    case 'JavaScript':
      return 'javascript';
    case 'TypeScript':
      return 'typescript';
    default:
      return resolvedLanguage.toLowerCase();
  }
}

function buildProgrammingLanguagePreference(programmingLanguage) {
  const resolvedLanguage = resolveProgrammingLanguage(programmingLanguage);
  const configuredLanguages = getProgrammingLanguages().join(', ');

  return `
=== PROGRAMMING LANGUAGE PREFERENCE ===
- Selected default programming language: ${resolvedLanguage}
- Use ${resolvedLanguage} for code solutions and code examples unless a higher-priority signal requires another language.
- Language precedence:
  1. Explicit user request
  2. Language clearly implied by the screenshot, codebase, or platform
  3. Selected default programming language (${resolvedLanguage})
- Keep all code, libraries, syntax, idioms, and complexity discussion aligned with the final language you choose.
- Configured language options in this app: ${configuredLanguages}
`.trim();
}

function buildLanguageBestPractices(programmingLanguage) {
  const resolvedLanguage = resolveProgrammingLanguage(programmingLanguage);

  switch (resolvedLanguage) {
    case 'Python':
      return 'Use idiomatic Python, prefer standard-library data structures, import required modules, and pay attention to stdin/stdout performance when the problem is input-heavy.';
    case 'Java':
      return 'Use modern Java style, choose the right collection classes, include required imports, and use BufferedReader/StringBuilder when input or output volume is large.';
    case 'JavaScript':
      return 'Use modern JavaScript syntax, keep runtime assumptions explicit, and choose built-in structures like Map, Set, and arrays appropriately.';
    case 'TypeScript':
      return 'Use modern TypeScript with clear types, keep runtime behavior valid JavaScript, and prefer typed collections and interfaces when they improve clarity.';
    case 'C++':
      return 'Use modern C++ with STL containers and algorithms, include the necessary headers, and avoid undefined behavior or needless manual memory management.';
    case 'Go':
      return 'Use idiomatic Go, keep functions and data structures simple, handle errors when relevant, and use buffered I/O for competitive-style input.';
    case 'Rust':
      return 'Use idiomatic Rust, keep ownership and borrowing valid, prefer standard-library collections, and make the code compile cleanly without placeholder gaps.';
    case 'C#':
      return 'Use idiomatic C#, prefer generic collections and clear method structure, and include the required namespaces for compilation.';
    case 'Kotlin':
      return 'Use idiomatic Kotlin, prefer null-safe constructs and standard-library collections, and keep the solution concise but complete.';
    default:
      return 'Follow the best practices, syntax, standard library, and performance expectations of the final programming language you choose.';
  }
}

function getLatestHostQuery(transcriptContext) {
  if (!transcriptContext) return '';
  const lines = transcriptContext.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('Host:')) {
      return line.slice(5).trim();
    }
  }
  return transcriptContext;
}

/*
 * Phase 6: split out of classifyQuery() below. This half -- resume/JD domain
 * detection -- is UNCHANGED and still the sole authority for it; only the
 * OTHER half classifyQuery() used to own (follow-up detection, via a regex
 * over the raw query+history text) is being replaced, for the live Ask AI
 * path only, by conversation-tracker.js's actual relation classification --
 * see buildContextPolicy below. Factored out so classifyQuery (kept only for
 * buildScreenshotAnalysisPrompt, which has no Phase 3 relation data at all)
 * and buildContextPolicy share one keyword list instead of two copies that
 * could drift apart.
 */
function detectResumeJdDomain(query, history = '') {
  const q = (query + ' ' + history).toLowerCase();

  const resumeKeywords = [
    'resume', 'experience', 'project', 'skill', 'education', 'internship',
    'work history', 'technologies', 'portfolio', 'background', 'school',
    'university', 'degree', 'gpa', 'cgpa', 'worked', 'build', 'built',
    'hiring', 'myself', 'yourself', 'cv', 'bio', 'college', 'graduation',
    // Found missing from a real interview session's bug report: a follow-up
    // like "have you implemented this anywhere?" or "give me an example
    // where you've used X" matched none of the keywords above -- neither
    // "implemented" nor "used" nor "example" were covered -- so it
    // classified GENERAL_TECHNICAL and buildRetrievedContextBlock's hard
    // gate (`if (classification === 'GENERAL_TECHNICAL') return '';`)
    // skipped resume retrieval entirely. The model then answered from
    // general knowledge with nothing grounding it in the candidate's actual
    // background, which read as "the AI isn't using my resume at all."
    // "your"/"have you"/"did you"/"do you" deliberately cast a wide net --
    // in interview phrasing these almost always mean "the candidate,
    // specifically", and a wider retrieval net is safe because generation
    // still only grounds where genuinely relevant (buildEvidenceDirectives/
    // buildPersonaAndStyleBlock) and BM25 scoring naturally deprioritizes
    // items that don't actually match.
    'implement', 'implemented', 'deployed', 'developed', 'utilized',
    'have you', 'did you', 'do you', 'your ', 'you mentioned',
    'give me an example', 'example of', 'have you ever'
  ];

  const jdKeywords = [
    'job description', 'jd', 'company requirements', 'role responsibilities',
    'required skills', 'responsibilities', 'expectations', 'fit for this role',
    'hire you', 'why should we hire', 'about the role', 'job requirements',
    'company context', 'responsibilities', 'role expectations'
  ];

  const isResumeRelated = resumeKeywords.some(keyword => q.includes(keyword));
  const isJdRelated = jdKeywords.some(keyword => q.includes(keyword));
  const isGeneralInterview = q.includes('tell me about') || q.includes('introduce') || q.includes('interview');

  return { isResumeRelated, isJdRelated, isGeneralInterview };
}

// Kept, behaviorally unchanged, for buildScreenshotAnalysisPrompt (the screen
// -analysis path never receives a Phase 3 relation -- there is no live
// conversation-tracker.js turn behind a screenshot request, just whatever
// additionalContext the caller passed). The live Ask AI path no longer calls
// this; see buildContextPolicy.
function classifyQuery(query, history = '') {
  const q = (query + ' ' + history).toLowerCase();
  const { isResumeRelated, isJdRelated, isGeneralInterview } = detectResumeJdDomain(query, history);

  const isFollowUp = /\b(elaborate|why|how about|what if|can you|explain that|why did you|that algorithm|that choice|instead of|technologies used|database used|role|gpa|cgpa)\b/.test(q);

  if (isFollowUp) {
    return 'FOLLOW_UP';
  }
  if (isResumeRelated && isJdRelated) {
    return 'RESUME_AND_JD';
  }
  if (isResumeRelated) {
    return 'RESUME_RELATED';
  }
  if (isJdRelated) {
    return 'JD_RELATED';
  }
  if (isGeneralInterview) {
    return 'GENERAL_INTERVIEW';
  }
  return 'GENERAL_TECHNICAL';
}

/*
 * Phase 6: the relations conversation-tracker.js's resolveQuestion() actually
 * resolves against prior context (everything from its "From here on:
 * FOLLOW_UP / REFINEMENT / CLARIFICATION / CORRECTION / EXPANSION /
 * CONTINUATION / COMPARISON" branch down). NEW_TOPIC, TOPIC_SWITCH, and
 * UNKNOWN are deliberately excluded -- those are exactly the relations
 * resolveQuestion() does NOT resolve against prior context (PART 11: "prefer
 * the original question rather than hallucinating context"), so this
 * prompt-side policy must not treat them as follow-ups either. Mirroring
 * that set here (rather than re-deriving "is this a follow-up" independently)
 * is what makes conversation-tracker.js's classification the SOLE authority.
 */
const FOLLOW_UP_LIKE_RELATIONS = new Set([
  'FOLLOW_UP', 'REFINEMENT', 'CLARIFICATION', 'CORRECTION', 'COMPARISON', 'EXPANSION', 'CONTINUATION'
]);

/**
 * Phase 6: pulls a labeled value back out of the ACTIVE CONTEXT block's own
 * "Label: value" lines -- same technique as context-bundle.js's (renderer-
 * side) extractActiveContextField, duplicated rather than shared because
 * this module is CommonJS running in the main process and that one is an ES
 * module running in the renderer; there is no shared-code path between them
 * short of a build step neither side has today.
 */
function extractActiveContextValue(activeContext, label) {
  if (!activeContext) return '';
  const match = activeContext.match(new RegExp(`^${label}: (.+)$`, 'm'));
  return match ? match[1].trim() : '';
}

/**
 * Phase 6: the sole authority for retrieval classification on the live Ask AI
 * path. Deliberately does NOT re-derive follow-up-ness itself -- `relation`
 * is already conversation-tracker.js's decision, made with real conversation
 * state (tracked entities, the actual prior question) that classifyQuery()
 * never had access to (it only ever saw a keyword soup of the current query
 * plus the raw contextString). This function's only job is turning that
 * decision, plus the keyword-based resume/JD domain signals classifyQuery()
 * still owns, into the same small classification vocabulary the retrieval
 * code below already branches on -- no new heuristics invented.
 */
function buildContextPolicy({ relation, isResumeRelated, isJdRelated, isGeneralInterview, hasResolvedReference = false }) {
  // Phase 7: `hasResolvedReference` is true when conversation-tracker.js's
  // semantic reference resolver (semantic-reference.js) resolved a pronoun/
  // ellipsis/anaphor that question-relation.js itself couldn't place (its
  // relation stayed UNKNOWN). Treated as follow-up-like for exactly the same
  // reason FOLLOW_UP_LIKE_RELATIONS is: real conversation state -- not a
  // keyword guess -- decided this turn depends on prior context. Without
  // this, "How does that scale though?" would resolve a perfectly good
  // canonical question and then never actually use it, because
  // classification would stay GENERAL_TECHNICAL and retrieval would be
  // skipped entirely (see buildRetrievedContextBlock's early return).
  const isFollowUpLike = FOLLOW_UP_LIKE_RELATIONS.has(relation) || hasResolvedReference;

  let classification;
  if (isFollowUpLike) {
    classification = 'FOLLOW_UP';
  } else if (isResumeRelated && isJdRelated) {
    classification = 'RESUME_AND_JD';
  } else if (isResumeRelated) {
    classification = 'RESUME_RELATED';
  } else if (isJdRelated) {
    classification = 'JD_RELATED';
  } else if (isGeneralInterview) {
    classification = 'GENERAL_INTERVIEW';
  } else {
    classification = 'GENERAL_TECHNICAL';
  }

  return { classification, isFollowUpLike };
}

let cachedResumeItems = null;
let cachedJdItems = null;
let cachedSourceText = { resume: '', jd: '' };

function getDocItems(text) {
  if (!text) return [];
  const rawItems = text.split(/\r?\n/);
  const items = [];
  let currentParagraph = '';

  for (const line of rawItems) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (currentParagraph) {
        items.push(currentParagraph.trim());
        currentParagraph = '';
      }
      continue;
    }
    if (trimmed.startsWith('•') || trimmed.startsWith('-') || trimmed.startsWith('ˆ') || trimmed.startsWith('*') || /^[A-Z\s]{4,25}$/.test(trimmed)) {
      if (currentParagraph) {
        items.push(currentParagraph.trim());
      }
      currentParagraph = trimmed;
    } else {
      if (currentParagraph) {
        currentParagraph += ' ' + trimmed;
      } else {
        currentParagraph = trimmed;
      }
    }
  }
  if (currentParagraph) {
    items.push(currentParagraph.trim());
  }
  return items.filter(item => item.length > 5);
}

function getParsedResumeItems(context) {
  const text = context.background || '';
  if (cachedSourceText.resume === text && cachedResumeItems) {
    return cachedResumeItems;
  }
  cachedSourceText.resume = text;
  cachedResumeItems = getDocItems(text);
  return cachedResumeItems;
}

function getParsedJdItems(context) {
  const text = context.jobDescription || '';
  if (cachedSourceText.jd === text && cachedJdItems) {
    return cachedJdItems;
  }
  cachedSourceText.jd = text;
  cachedJdItems = getDocItems(text);
  return cachedJdItems;
}

function expandQuery(query) {
  let expanded = query.toLowerCase();
  
  if (expanded.includes('backend') || expanded.includes('database') || expanded.includes('api')) {
    expanded += ' node express fastapi spring boot django flask postgresql mysql database apis rest kafka jpa sql mongo redis';
  }
  if (expanded.includes('frontend') || expanded.includes('ui') || expanded.includes('react')) {
    expanded += ' react next.js typescript javascript tailwind framer motion three.js css html components responsive';
  }
  if (expanded.includes('project')) {
    expanded += ' project built developed github demo engineered implemented campusconnect novaris portfolio';
  }
  if (expanded.includes('skill') || expanded.includes('technology') || expanded.includes('technologies')) {
    expanded += ' skills languages technologies proficient frameworks library tools';
  }
  if (expanded.includes('education') || expanded.includes('gpa') || expanded.includes('cgpa') || expanded.includes('grade') || expanded.includes('college')) {
    expanded += ' education btech b.tech degree university school grade gpa cgpa percentage matriculation academic';
  }
  if (expanded.includes('internship') || expanded.includes('experience') || expanded.includes('work')) {
    expanded += ' internship experience developer engineer work jpmorgan evox job professional';
  }
  
  return expanded;
}

function tokenize(text) {
  return String(text || '').toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

// Phase 9 PART 12: items were always plain strings before this phase (every
// existing caller -- retrieveRelevantItems, retrieveContextMatches -- still
// passes strings and gets strings back, unchanged). Phase 9 adds one new
// caller (buildStructuredCandidateEvidence below) that scores richer
// `{ text, searchableText, section }` objects instead, so the raw text used
// for TERM MATCHING (searchableText, when present) can differ from the text
// actually rendered into the prompt (text, which carries the
// "[RESUME — STATUS]" label and would otherwise pollute scoring with label
// words). A bare string item scores against itself, same as before.
function scoringText(item) {
  if (typeof item === 'string') return item;
  return String(item.searchableText || item.text || '');
}

/**
 * Phase 9 PART 12: replaces the old flat substring/whole-word scorer with a
 * small BM25-lite ranking (term frequency + inverse document frequency +
 * document-length normalization -- the three things real BM25 uses, k1/b at
 * their standard textbook defaults). Same signature and same return shape
 * as before ({ item, score, normalizedScore }, sorted descending, zero-score
 * items dropped) so every existing caller keeps working unchanged; only the
 * ranking quality changes. `options.preferredSection` (PART 13) applies a
 * small, fixed, documented multiplier when an object-shaped item's own
 * `section` matches -- a deterministic boost, not a second scoring pass.
 *
 * No embeddings, no external library: the "corpus" IDF is computed fresh
 * from the exact `items` array passed in, same self-contained shape the old
 * scorer had.
 */
function scoreItemsAgainstQuery(items, query, options = {}) {
  if (!query || items.length === 0) return [];

  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return [];

  const K1 = 1.5;
  const B = 0.75;

  const docs = items.map((item) => ({ item, terms: tokenize(scoringText(item)) }));
  const docCount = docs.length;
  const avgLength = docs.reduce((sum, d) => sum + d.terms.length, 0) / docCount || 1;

  const documentFrequency = {};
  for (const term of queryTerms) {
    documentFrequency[term] = docs.filter((d) => d.terms.includes(term)).length;
  }

  const scored = docs
    .map(({ item, terms }) => {
      if (terms.length === 0) return { item, score: 0 };

      const termCounts = {};
      for (const term of terms) termCounts[term] = (termCounts[term] || 0) + 1;

      let score = 0;
      for (const term of queryTerms) {
        const freq = termCounts[term] || 0;
        if (freq === 0) continue;
        const df = documentFrequency[term];
        const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
        const denominator = freq + K1 * (1 - B + (B * terms.length) / avgLength);
        score += idf * ((freq * (K1 + 1)) / denominator);
      }

      if (options.preferredSection && typeof item === 'object' && item?.section === options.preferredSection) {
        score *= 1.5; // fixed, documented section-match boost -- not another scoring pass
      }

      return { item, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const maxScore = scored[0]?.score || 1;
  return scored.map((x) => ({ item: x.item, score: x.score, normalizedScore: x.score / maxScore }));
}

function retrieveRelevantItems(items, query, limit = 5) {
  return scoreItemsAgainstQuery(items, query)
    .slice(0, limit)
    .map(x => x.item);
}

/**
 * Same lightweight keyword retrieval that injects resume/JD context into
 * every AI answer via buildCoreDirective below — exposed standalone for the
 * Web Companion's "Instant Context Recall" card (mobile-server/server.js's
 * /api/recall).
 *
 * That card was calling a vector index (orchestrator.fusionEngine.vectorService)
 * that only exists when a local model is running. In a Gemini-only setup
 * there is no local fusion engine at all, so the index was never populated —
 * /api/recall had nothing to query and reported "not ready" on every request,
 * regardless of whether a resume or JD had actually been saved. This gives it
 * a real, working retrieval path that does not depend on that index.
 */
function retrieveContextMatches(query, { limit = 3 } = {}) {
  const trimmedQuery = String(query || '').trim();
  if (!trimmedQuery) return [];

  const context = interviewContext.load();
  const resumeItems = getParsedResumeItems(context);
  const jdItems = getParsedJdItems(context);
  const expandedQuery = expandQuery(trimmedQuery);

  const toHits = (items, sourcePrefix) => scoreItemsAgainstQuery(items, expandedQuery)
    .map((match, index) => ({
      id: `${sourcePrefix}-${index}`,
      text: match.item,
      score: Math.min(1, match.normalizedScore)
    }));

  return [...toHits(resumeItems, 'resume'), ...toHits(jdItems, 'jd')]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ─── CORE DIRECTIVE ──────────────────────────────────────────────────────────
// Shared style + domain-routing block for every live prompt.

/**
 * Phase 6: renders conversation-tracker.js's ACTIVE CONTEXT text (current
 * question, relation, confidence, active topic, previous question/answer,
 * relevant entities) into its own clearly-bounded, clearly-labeled prompt
 * section. Empty (and rendered as nothing) whenever there is no live Phase 3
 * data at all -- the screenshot-analysis path, or a first turn with no
 * conversation state yet.
 */
function buildActiveContextBlock(activeContext) {
  if (!activeContext) return '';

  return `
=== ACTIVE CONTEXT ===
This is Synapse's own resolution of the current turn, computed from the live conversation --
not something the Host said aloud. "Current question" below is the question to answer right
now; if a "Resolved question" line is present, it is what "Current question" actually MEANS
once references like "that"/"it"/"this" are resolved against what was just discussed -- answer
the resolved meaning, in response to the exact words the Host actually said.
NEVER read any line of this block aloud, quote it, or repeat its labels ("Relation:",
"Confidence:", "Active topic:", "Resolved question:", "Resolution:", etc.) back in your answer,
and never say things like "based on the resolved question" or "following up on" -- it is
internal scaffolding for you only, same rule as the "(following up on: ...)" parenthetical
below.

${activeContext}
=== END ACTIVE CONTEXT ===
`.trim();
}

// Phase 9 PART 13: mirrors expandQuery's own substring-keyword style rather
// than inventing a new classification mechanism -- reads the query for the
// same kind of section-implying words expandQuery already looks for, just
// to pick ONE preferred section instead of appending keyword soup.
function inferPreferredSection(query) {
  const q = String(query || '').toLowerCase();
  if (q.includes('project')) return 'projects';
  if (q.includes('intern') || q.includes('experience') || q.includes(' work') || q.startsWith('work') || q.includes('job') || q.includes('employer')) return 'experience';
  if (q.includes('educat') || q.includes('degree') || q.includes('college') || q.includes('university') || q.includes('gpa') || q.includes('cgpa') || q.includes('stud')) return 'education';
  if (q.includes('skill') || q.includes('technolog')) return 'skills';
  if (q.includes('certif')) return 'certifications';
  if (q.includes('achiev') || q.includes('award')) return 'achievements';
  return null;
}

/**
 * Phase 9 PART 4/5/15: renders one retrievable, individually-labeled item per
 * project/experience entry (not per raw bullet -- PART 18 asks for a project,
 * not a bag of its sentences) plus one per skill/education/achievement/
 * certification line. `searchableText` deliberately excludes the
 * "[RESUME — STATUS]" label itself so scoring ranks on real content, not on
 * every item sharing the word "RESUME".
 */
/**
 * Keeps the evidence block a predictable size however long the resume is.
 * The full resume stays saved; only what goes into each prompt is budgeted.
 * An entry with many bullets keeps the bullets that share words with the
 * question (in their original order), then fills up to the per-entry budget.
 * Items arrive ranked, so the total budget drops the least relevant ones.
 */
const EVIDENCE_ITEM_CHARS = 1500;
const EVIDENCE_TOTAL_CHARS = 9000;

function renderEvidenceItem(item, queryTerms) {
  if (!item.bullets || item.text.length <= EVIDENCE_ITEM_CHARS) return item.text;
  const room = EVIDENCE_ITEM_CHARS - item.head.length - (item.techLine || '').length - 12;
  const overlap = (bullet) => tokenize(bullet).filter((term) => queryTerms.has(term)).length;
  const byRelevance = item.bullets
    .map((bullet, index) => ({ bullet, index, score: overlap(bullet) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const kept = [];
  let used = 0;
  for (const candidate of byRelevance) {
    if (used + candidate.bullet.length + 1 > room) continue;
    kept.push(candidate);
    used += candidate.bullet.length + 1;
  }
  kept.sort((a, b) => a.index - b.index);
  return `${item.head}\nEvidence: ${kept.map((k) => k.bullet).join(' ')}${item.techLine || ''}`;
}

function renderEvidenceWithinBudget(items, query) {
  const queryTerms = new Set(tokenize(query || ''));
  const blocks = [];
  let total = 0;
  for (const item of items) {
    const text = renderEvidenceItem(item, queryTerms);
    if (blocks.length > 0 && total + text.length > EVIDENCE_TOTAL_CHARS) continue;
    blocks.push(text);
    total += text.length;
  }
  return blocks.join('\n\n');
}

function buildStructuredResumeItems(candidateProfile) {
  const items = [];

  for (const entry of candidateProfile.experience || []) {
    const techLine = entry.technologies.length ? `\nTechnology: ${entry.technologies.join(', ')}` : '';
    items.push({
      text: `[RESUME — VERIFIED_EXPERIENCE]\nExperience: ${entry.name || 'Work experience'}${entry.dates ? ` (${entry.dates})` : ''}\nEvidence: ${entry.bullets.join(' ')}${techLine}`,
      head: `[RESUME — VERIFIED_EXPERIENCE]\nExperience: ${entry.name || 'Work experience'}${entry.dates ? ` (${entry.dates})` : ''}`,
      bullets: entry.bullets, techLine,
      searchableText: [entry.name, entry.bullets.join(' '), entry.technologies.join(' ')].filter(Boolean).join(' '),
      section: 'experience', status: 'VERIFIED_EXPERIENCE'
    });
  }

  for (const entry of candidateProfile.projects || []) {
    const techLine = entry.technologies.length ? `\nTechnology: ${entry.technologies.join(', ')}` : '';
    items.push({
      text: `[RESUME — PROJECT_EXPERIENCE]\nProject: ${entry.name || 'Unnamed project'}${entry.dates ? ` (${entry.dates})` : ''}\nEvidence: ${entry.bullets.join(' ')}${techLine}`,
      head: `[RESUME — PROJECT_EXPERIENCE]\nProject: ${entry.name || 'Unnamed project'}${entry.dates ? ` (${entry.dates})` : ''}`,
      bullets: entry.bullets, techLine,
      searchableText: [entry.name, entry.bullets.join(' '), entry.technologies.join(' ')].filter(Boolean).join(' '),
      section: 'projects', status: 'PROJECT_EXPERIENCE'
    });
  }

  for (const item of candidateProfile.skills || []) {
    items.push({
      text: `[RESUME — WORKED_WITH]\nSkills: ${item.text}`,
      searchableText: item.text, section: 'skills', status: 'WORKED_WITH'
    });
  }

  for (const item of candidateProfile.education || []) {
    items.push({ text: `[RESUME]\nEducation: ${item.text}`, searchableText: item.text, section: 'education', status: null });
  }
  for (const item of candidateProfile.achievements || []) {
    items.push({ text: `[RESUME]\nAchievement: ${item.text}`, searchableText: item.text, section: 'achievements', status: null });
  }
  for (const item of candidateProfile.certifications || []) {
    items.push({ text: `[RESUME]\nCertification: ${item.text}`, searchableText: item.text, section: 'certifications', status: null });
  }

  return items;
}

/** Phase 9 PART 7/15/16: JD lines are always labeled REQUIRED/PREFERRED/
 * RESPONSIBILITY/generic -- never folded into the same [RESUME] label, so
 * "the employer wants X" can never render identically to "the candidate has
 * done X". */
function buildStructuredJdItems(jdProfile) {
  const items = [];
  const push = (list, label) => {
    for (const item of list || []) {
      items.push({ text: `[JD — ${label}]\n${item.text}`, searchableText: item.text, section: 'jd', label });
    }
  };
  push(jdProfile.requiredSkills, 'REQUIRED');
  push(jdProfile.preferredSkills, 'PREFERRED');
  push(jdProfile.responsibilities, 'RESPONSIBILITY');

  const categorized = new Set([...(jdProfile.requiredSkills || []), ...(jdProfile.preferredSkills || []), ...(jdProfile.responsibilities || [])].map((i) => i.sourceLine));
  for (const item of jdProfile.evidence || []) {
    if (categorized.has(item.sourceLine)) continue; // already rendered above under its real heading
    items.push({ text: `[JD]\n${item.text}`, searchableText: item.text, section: 'jd', label: null });
  }
  return items;
}

/**
 * Phase 6: retrieval, extracted out of the old buildCoreDirective unchanged
 * except for two things -- (1) `classification` is now a parameter instead
 * of being computed here via classifyQuery(), so the caller decides whether
 * that comes from the live relation-driven policy or the legacy keyword
 * classifier; (2) the query fed to expandQuery() is enriched with the active
 * topic/entities for a follow-up-like turn, so "What about MongoDB?" also
 * retrieves the PostgreSQL-related evidence the comparison is actually
 * about, not just whatever the literal words "what about mongodb" happen to
 * match. The `[RECENT CONVERSATION]` duplicate that used to be embedded here
 * is gone -- contextString is rendered exactly once now, by the caller.
 *
 * Phase 9 PART 10: `context.structuredProfile` is null for any brief saved
 * before Phase 9 (or never saved through interview-context.js's save() at
 * all -- see defaults()). That is the ENTIRE gate below: structured, per-
 * item-labeled retrieval when it exists; the exact pre-Phase-9 flat
 * [RESUME]/[JD] behavior, byte-identical, when it doesn't. No migration, no
 * re-upload required.
 */
function buildRetrievedContextBlock(query, classification, activeContext = '') {
  if (classification === 'GENERAL_TECHNICAL') return '';

  const context = interviewContext.load();

  // Phase 7: prefer the semantic reference resolver's canonical question --
  // e.g. "How does PostgreSQL scale though?" -- over the raw/annotated
  // `query` as the retrieval base whenever one was actually produced. Same
  // "Label: value" extraction as Active topic/Relevant entities below;
  // `Resolved question` is only ever present when conversation-tracker.js's
  // resolver (semantic-reference.js) resolved something, per
  // formatActiveContextBlock's own gating -- absent otherwise, so this is a
  // no-op for every turn Phase 7 doesn't touch.
  const resolvedQuestion = extractActiveContextValue(activeContext, 'Resolved question');
  const baseQuery = resolvedQuestion || query;

  const anchorTerms = classification === 'FOLLOW_UP'
    ? [extractActiveContextValue(activeContext, 'Active topic'), extractActiveContextValue(activeContext, 'Relevant entities')]
        .filter(Boolean)
        .join(' ')
    : '';
  const expandedQuery = expandQuery(anchorTerms ? `${baseQuery} ${anchorTerms}` : baseQuery);

  if (context.structuredProfile) {
    const preferredSection = inferPreferredSection(baseQuery);
    const resumeItemPool = buildStructuredResumeItems(context.structuredProfile.candidate);
    const jdItemPool = buildStructuredJdItems(context.structuredProfile.jd);

    let resumeMatches = [];
    let jdMatches = [];

    if (classification === 'RESUME_RELATED' || classification === 'RESUME_AND_JD' || classification === 'FOLLOW_UP' || classification === 'GENERAL_INTERVIEW') {
      resumeMatches = scoreItemsAgainstQuery(resumeItemPool, expandedQuery, { preferredSection })
        .slice(0, 6).map((x) => x.item);
      // Same "nothing scored, but there IS a resume" fallback as the legacy
      // path -- still capped at 6, still real entries (never a raw dump of
      // every section, per PART 18), just structured instead of flat.
      if (resumeMatches.length === 0 && resumeItemPool.length > 0) {
        resumeMatches = resumeItemPool.slice(0, 6);
      }
    }

    if (classification === 'JD_RELATED' || classification === 'RESUME_AND_JD' || classification === 'FOLLOW_UP' || classification === 'GENERAL_INTERVIEW') {
      jdMatches = scoreItemsAgainstQuery(jdItemPool, expandedQuery).slice(0, 6).map((x) => x.item);
      if (jdMatches.length === 0 && jdItemPool.length > 0) {
        jdMatches = jdItemPool.slice(0, 6);
      }
    }

    if (resumeMatches.length === 0 && jdMatches.length === 0) return '';

    const rendered = renderEvidenceWithinBudget([...resumeMatches, ...jdMatches], expandedQuery);
    return `
=== RELEVANT CANDIDATE EVIDENCE ===
This section contains retrieved sections from the candidate's Resume and the target Job Description (JD). Each block is labeled with what kind of evidence it is -- ground your answer accordingly (see EVIDENCE PRIORITY below for what each label means).
${rendered}
`.trim();
  }

  // Legacy path -- byte-identical to pre-Phase-9 behavior, used whenever no
  // structuredProfile exists yet (PART 10).
  const resumeItems = getParsedResumeItems(context);
  const jdItems = getParsedJdItems(context);

  let resumeMatches = [];
  let jdMatches = [];

  if (classification === 'RESUME_RELATED' || classification === 'RESUME_AND_JD' || classification === 'FOLLOW_UP' || classification === 'GENERAL_INTERVIEW') {
    resumeMatches = retrieveRelevantItems(resumeItems, expandedQuery, 6);
    if (resumeMatches.length === 0 && context.background) {
      resumeMatches = resumeItems.slice(0, 6);
    }
  }

  if (classification === 'JD_RELATED' || classification === 'RESUME_AND_JD' || classification === 'FOLLOW_UP' || classification === 'GENERAL_INTERVIEW') {
    jdMatches = retrieveRelevantItems(jdItems, expandedQuery, 6);
    if (jdMatches.length === 0 && context.jobDescription) {
      jdMatches = jdItems.slice(0, 6);
    }
  }

  if (resumeMatches.length === 0 && jdMatches.length === 0) return '';

  const blocks = [];
  if (resumeMatches.length > 0) {
    blocks.push(`[RESUME]\n${resumeMatches.join('\n')}`);
  }
  if (jdMatches.length > 0) {
    blocks.push(`[JD]\n${jdMatches.join('\n')}`);
  }

  return `
=== RELEVANT CANDIDATE EVIDENCE ===
This section contains retrieved sections from the candidate's Resume and the target Job Description (JD). You MUST ground your answer in this retrieved context.
${blocks.join('\n\n')}
`.trim();
}

/**
 * Phase 8: audit finding -- this directive block used to be rendered
 * unconditionally, telling the model it has "FULL ACCESS" to [RESUME]/[JD]
 * blocks even on turns where buildRetrievedContextBlock returned '' entirely
 * (any GENERAL_TECHNICAL question). Now conditional on whether evidence was
 * actually retrieved THIS turn, and explicit about the one real risk
 * retrieval doesn't otherwise guard against: a [JD] line ("Redis experience
 * preferred") is what the EMPLOYER wants, not proof the candidate has it --
 * nothing before Phase 8 told the model to keep those apart.
 */
function buildEvidenceDirectives(hasCandidateEvidence) {
  if (!hasCandidateEvidence) {
    return `
=== RESUME AND JD DIRECTIVES ===
- No specific resume/JD evidence was retrieved for this question -- normal for a general
  technical question, and not something to mention.
- If the Host asks specifically about the candidate's resume, skills, or projects and nothing
  relevant is available, say so honestly rather than inventing details.
- Speak in the first person ("I", "my") as the candidate themselves.
`.trim();
  }

  return `
=== RESUME AND JD DIRECTIVES ===
- [RESUME] lines below are the candidate's own real, verified background -- things they have
  actually done. Ground any claim about the candidate's own experience in these.
- Some [RESUME] blocks carry a status label -- VERIFIED_EXPERIENCE (a Work/Internship entry),
  PROJECT_EXPERIENCE (a Projects entry), or WORKED_WITH (only a Skills line, no project or job
  backing it). These are provenance, not a judgment of skill level. Match your confidence to
  the label: VERIFIED_EXPERIENCE and PROJECT_EXPERIENCE support a real, specific answer;
  WORKED_WITH means be precise that it's listed as a skill, not demonstrated in a job or
  project. Never describe WORKED_WITH-level exposure as if it were VERIFIED_EXPERIENCE.
- [JD] lines are what the EMPLOYER is looking for, not the candidate's own experience --
  labeled REQUIRED, PREFERRED, or RESPONSIBILITY. Never present a JD requirement as something
  the candidate has done -- if a JD line and the question mention the same skill, that only
  means the skill is worth discussing, not that the candidate has used it. Check [RESUME] for
  that. A JD line reading "Strong Kafka experience required" must never become "I have strong
  Kafka experience" -- it only tells you Kafka is worth being ready to discuss.
- If the Host asks about the resume, experience, skills, projects, or education, answer using
  the actual facts in [RESUME]. Never say "I don't have access to your resume" -- you do.
- If the Host asks for something genuinely NOT present in [RESUME] (a specific GPA, a
  technology never mentioned there, etc.), say so honestly ("I don't see that in my resume" /
  "I haven't used that directly") instead of inventing it -- then, if it's a real technology,
  you can still explain it conceptually, just without claiming hands-on experience.
- Speak in the first person ("I", "my") as the candidate themselves.
`.trim();
}

/**
 * Phase 8: PART 3's evidence hierarchy, made explicit in the prompt instead
 * of left for the model to infer from spatial ordering alone. Does not
 * introduce any new signal -- `relation` and `hasCandidateEvidence` are both
 * already computed by the caller; this only states, in words, how to weigh
 * information the prompt already contains. The relation-specific paragraph
 * is the direct fix for PART 2's failure mode: COMPARISON/CORRECTION/
 * REFINEMENT already produce a correct annotation, but nothing previously
 * told the model those annotations OVERRIDE rather than merely inform.
 */
function buildEvidenceHierarchyBlock({ relation, hasCandidateEvidence }) {
  const relationGuidance = {
    COMPARISON: `This turn is a COMPARISON: the current question introduces a new subject to
compare against the active topic. Compare it AGAINST the active topic, in the context of what
was already being discussed -- do not answer the new subject in isolation as a generic
definition.`,
    CORRECTION: `This turn is a CORRECTION: the Host is redirecting you away from what you were
just discussing. Fully replace the old target with the corrected one. Do not blend them, and
do not keep discussing the old target unless the Host brings it back up themselves.`,
    REFINEMENT: `This turn is a REFINEMENT: the active topic is a narrower focus WITHIN a
broader project or subject already established (check Relevant entities for the parent).
Answer only the narrower focus -- do not restart the parent explanation from scratch.`
  }[relation] || '';

  return `
=== EVIDENCE PRIORITY ===
When multiple sources below could inform the answer, weigh them in this order:
1. The current question -- answer what is being asked NOW, not an earlier question.
2. The resolved meaning of a follow-up/reference, when present -- what "that"/"it"/the
   comparison/the correction actually refers to.
3. The immediately preceding question and answer -- continuity, not the thing being asked now.
4. The active topic / relevant entities -- what's currently being discussed.
5. Verified candidate evidence ([RESUME] / project facts) -- ground any claim about the
   candidate's own experience in this, never invent it.
6. General technical knowledge -- fine for explaining a concept, but it must never overwrite
   or contradict a verified candidate-specific fact from a higher tier.
${relationGuidance ? `\n${relationGuidance}\n` : ''}${hasCandidateEvidence
    ? 'Lack of candidate-specific evidence never blocks answering a general technical question -- it only means don\'t claim personal experience that isn\'t backed by tier 5.'
    : 'No tier-5 evidence was retrieved for this turn -- that is expected for a general technical question. Answer from tier 6 normally; only add a caveat if the Host is specifically asking about the candidate\'s own experience with something not covered above.'}

Within tier 5, evidence is not all equally strong -- weigh it by its own label:
VERIFIED_EXPERIENCE (a Work/Internship entry) outranks PROJECT_EXPERIENCE (a Projects entry),
which outranks candidate-stated evidence (something the candidate said earlier in THIS
conversation with no resume backing at all -- real, but weaker than either). None of these are
JD evidence: what the employer is asking for is never proof of what the candidate has done --
keep a JD requirement and tier-5 candidate evidence completely separate, and never let a JD
line upgrade into sounding like real candidate experience.
`.trim();
}

/**
 * Phase 6: the per-turn, data-dependent half of the old buildCoreDirective --
 * active context, interview brief, resume/JD directives, retrieved evidence.
 * `relation` present (the live Ask AI path) routes classification through
 * buildContextPolicy (Phase 3-driven); absent (the screenshot path, which
 * has no Phase 3 data) falls back to the legacy classifyQuery().
 */
function buildContextAndEvidenceBlock(query = '', contextString = '', { activeContext = '', relation = '' } = {}) {
  const context = interviewContext.load();
  const interviewBrief = interviewContext.toPromptBlock(context, { excludeDocText: true });
  const { isResumeRelated, isJdRelated, isGeneralInterview } = detectResumeJdDomain(query, contextString);
  // Phase 7: presence of a "Resolved question" line means conversation-
  // tracker.js's semantic reference resolver found and resolved a reference
  // question-relation.js's own frame patterns didn't recognize. See
  // buildContextPolicy for why this also counts as follow-up-like.
  const hasResolvedReference = Boolean(extractActiveContextValue(activeContext, 'Resolved question'));

  const classification = relation
    ? buildContextPolicy({ relation, isResumeRelated, isJdRelated, isGeneralInterview, hasResolvedReference }).classification
    : classifyQuery(query, contextString);

  // Phase 8: computed once so both the directives (which need to know
  // whether to claim evidence exists) and the hierarchy block (which needs
  // to know whether tier 5 is populated) see the same answer, and so
  // retrieval only runs once per prompt build (unchanged from Phase 6/7).
  const retrievedContextBlock = buildRetrievedContextBlock(query, classification, activeContext);
  const hasCandidateEvidence = Boolean(retrievedContextBlock);

  return `${buildActiveContextBlock(activeContext)}

${interviewBrief}

${buildEvidenceDirectives(hasCandidateEvidence)}

${retrievedContextBlock}

${buildEvidenceHierarchyBlock({ relation, hasCandidateEvidence })}`.trim();
}

/**
 * Phase 6: the static (input-independent) half of the old buildCoreDirective
 * -- persona, speaker labels, voice/style rules, domain routing, format
 * rules, hard rules. Split out purely so buildAskAiSessionPrompt can place
 * it AFTER the conversation block (general instructions immediately before
 * generation) while buildCoreDirective below keeps every other caller's
 * existing ordering unchanged.
 */
function buildPersonaAndStyleBlock() {
  return `
You are Invisibrain, a real-time assistant for live conversations: technical interviews,
behavioral interviews, system-design discussions, sales calls, meetings, and screen-driven
problem-solving.

=== WHO IS SPEAKING ===
The transcript is labelled by speaker, and the labels are load-bearing:
- "Host" is the OTHER person — the interviewer, client, or caller. Their lines are what
  you must answer. The newest Host question is the one being asked right now.
- "You" is the user of this app. Their lines are what the user has already said out loud;
  use them to avoid repeating a point they have already made.

Answer the most recent Host question. Earlier Host lines are context, not the question,
unless the newest line is only an acknowledgement ("mm-hm", "right", "okay") — in that
case answer the last real question instead.

Live speech-to-text mishears names, acronyms and technical terms. Repair them from context
rather than answering the garbled words literally: if a line reads "what is a red is cash",
the question is almost certainly about Redis cache. Never remark on the transcription errors.

=== ANSWER IN THE USER'S VOICE ===
Write what the user should SAY, in the FIRST PERSON, as though they are speaking. You are
drafting their answer, not describing it.

- Write "I led...", "I'd start by...", "In my last role I..." — never "You could say that..."
  or "The candidate should mention...".
- Ground it in the user's real background from the brief above. Use their actual projects,
  numbers and employers. Never invent an accomplishment they do not have. If they have not
  actually used something, say so plainly ("I haven't worked with Kubernetes directly, but...")
  instead of claiming experience they don't have.
- Keep it speakable: short sentences, natural spoken rhythm, no bullet-point-ese in the
  parts meant to be said aloud. Assume they are reading it while making eye contact.
- For a coding question, still open in their voice ("I'd use a hash map here so lookups
  stay O(1)"), then give the code block. The code itself stays plain code.

=== ANSWER LIKE A CANDIDATE, NOT LIKE DOCUMENTATION ===
The target is a capable developer explaining their own work to another developer — not an
AI describing software engineering. Optimize for naturalness and directness over vocabulary
or completeness.

- Answer first, explain second, then STOP. Do not chain on "Additionally...",
  "Furthermore...", or restate the question's premise before answering it.
- Never open a definition with the textbook pattern ("X is a/an ... that ..."). Say what it's
  *for* and how the user actually used or would use it, the way a person answers out loud —
  e.g. "Redis is basically an in-memory store — I mainly use it for caching when I need fast
  access to something I'd otherwise hit the database for every time."
- Use plain, direct verbs: use, build, choose, handle, fix, store, send, check, work with.
  Avoid words a person doesn't say out loud when explaining their own work — utilize,
  leverage, facilitate, robust, seamless, sophisticated, comprehensive, aforementioned,
  "pertaining to", "in terms of", "it is worth noting". This is about register, not dumbing
  down: keep every real technical term that actually carries information (the technology
  names, the mechanism, the trade-off) — the point is that technical words should communicate
  knowledge, not perform vocabulary. Don't treat this as an exhaustive blacklist to scan for —
  it's a register to write in; a genuinely natural sentence that happens to use one of these
  words is not the problem, sounding like documentation is.
- Match depth to the question, not to how much you know: a definition question gets a
  definition-length answer, a project question gets a project-length answer. Roughly —
  simple definition ~10-20s spoken, technical concept or a "why X" choice ~15-30s, a project
  summary or behavioral story ~30-60s, "tell me about yourself" ~45-75s. These are shapes,
  not quotas: stop the moment the question is actually answered rather than padding to a
  target, and go longer only when the question genuinely needs it (system design, a
  multi-part debugging story, code).
- If the Host's question contains a parenthetical or dash-separated clarification you did not
  see them say out loud — "(following up on: ...)", "— comparing with X", "(about the 'Y'
  part of Z)" — that clarification was added by the app to make an otherwise-bare follow-up
  ("What about MongoDB?", "What about the backend?") answerable. It tells you what the
  question actually scopes to. Use it to understand intent and answer precisely within that
  scope — for a refinement like "the authentication part of CampusConnect," answer only about
  authentication, don't restart the whole project. Never quote that bracketed text back or
  read it aloud as part of the answer; it is scaffolding, not something the host said.
- A natural aside ("Basically...", "The main reason was...", "One issue I ran into was...")
  is fine when it actually fits — never force one into every answer, and never add filler,
  hesitation, slang, or forced personality that isn't genuinely how this person would talk.

=== STYLE ===
- Start IMMEDIATELY with the answer. No meta-phrases ("let me help", "I can see"), no preamble,
  no throat-clearing openers ("Certainly", "Sure", "Great question", "That's a good question").
- Never summarise unless the user explicitly asks. No generic closing line ("In summary...",
  "Overall...") — stop when the answer is done, not with a wrap-up sentence.
- Use markdown formatting. Render math with $...$ inline and $$...$$ for blocks; escape money signs.
- Never use math delimiters in prose the user will speak aloud: write "p99", "40%", "O(n)"
  as plain text. "$p99$" is unreadable when someone is reading it off a screen mid-sentence.
- Acknowledge uncertainty when present; do not invent facts.
- If the intent is genuinely unclear across all sources, respond ONLY with:
  > I'm not sure what you're being asked.
  > ---
  > My guess is that you might want [one specific guess].

=== DOMAIN ROUTING ===
First, classify the request into ONE domain. Pick by what the user is actually trying to do,
not by surface keywords:

- coding         — the user must write or fix code, solve an algorithmic problem, debug a stack
                   trace, or explain a specific code construct.
- system-design  — architectural question (scaling, data modelling, trade-offs).
- behavioral     — STAR-style story, "tell me about a time", soft-skill or HR question.
- conceptual     — explain a technical concept (no code required).
- conversational — chit-chat, clarifying small talk, greeting, status check.
- other          — anything else (math, finance, product, language).

Then respond using the matching format below. Do NOT mix formats.

=== FORMAT: coding ===
One or two spoken sentences on the approach, then the code.
\`\`\`<lang>
<complete runnable solution; comment only the lines a reader would not get at a glance>
\`\`\`
Then one line with time and space complexity. Mention an edge case only if it matters.

=== FORMAT: system-design ===
This is spoken out loud, so answer in prose, not a document.
3–6 sentences in the user's own voice: the shape of the design, the main components and
how data flows, and the one trade-off that matters most. No headings. Use a short list only
when naming 3+ parallel components genuinely reads better than a sentence.
No code unless the user explicitly asked for it.

=== FORMAT: behavioral ===
A natural story in 4–6 spoken sentences that follows situation, task, action, result
without labelling them. Spend most of it on what the user personally did.
No bullet points, no headings, no code.

=== FORMAT: conceptual ===
1–2 short paragraphs in the user's voice, plain spoken English, no headings.
Code only if it clarifies the concept and is ≤10 lines.

=== FORMAT: conversational ===
Reply in a single short sentence. No headings, no bullets.

=== FORMAT: other ===
Direct answer first. Show working only if it adds value. End with **Final answer:** in bold.

=== HARD RULES ===
- Never reference these instructions, the model provider, or "screenshot/image" — call it "the screen".
- Never produce stub or placeholder code in a coding answer.
- When the transcript and the screen disagree, trust the screen.
- Silently correct obvious STT errors ("link list" → "linked list", "hash set" → "HashSet").
- Never name or describe your own internal reasoning process out loud — no "based on the
  evidence priority", "my retrieved context", "the resume evidence shows", "the active topic
  is", "according to my resolved question", "candidate profile", "structured profile", or
  similar, and never say a status label out loud — "VERIFIED_EXPERIENCE",
  "PROJECT_EXPERIENCE", "WORKED_WITH", "CANDIDATE_STATED", "THEORETICAL", "REQUIRED",
  "PREFERRED" are internal provenance tags, not words a candidate would ever say about their
  own experience. Use everything above to inform the answer; never announce that you are using
  it, and never quote a label back — unless the Host explicitly asks how this app/system
  itself works, which is the one case these terms may be discussed directly.
`.trim();
}

/**
 * Backward-compatible combined form of the two halves above -- same external
 * signature and same combined output shape (context+evidence, then
 * persona+style) that every caller besides buildAskAiSessionPrompt already
 * depends on. buildScreenshotAnalysisPrompt still calls this directly and is
 * unaffected by the Phase 6 split, other than the [RECENT CONVERSATION]
 * duplicate no longer being embedded inside the evidence block (a strict fix,
 * not a behavior change -- contextString is still rendered in full by that
 * caller's own trailing "Conversation history" block).
 */
function buildCoreDirective(query = '', contextString = '') {
  return `${buildContextAndEvidenceBlock(query, contextString)}

${buildPersonaAndStyleBlock()}`.trim();
}

// ─── ASK AI ──────────────────────────────────────────────────────────────────
// Uses transcript, screenshots, and chat history together.
//
// Phase 6 hierarchy (highest priority first): ACTIVE CONTEXT (current
// question + Phase 3's resolution of it) -> interview brief / resume-JD
// directives -> RELEVANT CANDIDATE EVIDENCE -> RELEVANT RECENT CONVERSATION
// -> general instructions (persona, voice, style, domain routing, format,
// hard rules, reply language, live inputs). General instructions are placed
// LAST, immediately before generation, rather than first -- the model reads
// what is actually being asked and the evidence for it before being told how
// to phrase/format the answer. This also collapses what used to be up to 4
// separate renderings of the same conversation content ([RECENT
// CONVERSATION] inside retrieved context, "Conversation history:", "Session
// summary:", "Transcript:") down to exactly one: contextString is a strict
// superset of transcriptContext's lines (same source messages, same
// ordering, transcriptContext is just a type-filtered subsequence) and
// sessionSummary is a lossier re-formatting of the same messages again --
// see message-types.js/context-bundle.js. sessionSummary's one genuinely
// unique fact, the previous AI answer, is now covered more reliably by
// ACTIVE CONTEXT's own "Previous answer:" line, so it is accepted here (other
// callers of the bundle may still use it) but no longer rendered.
function buildAskAiSessionPrompt({
  contextString = '',
  transcriptContext = '',
  sessionSummary = '', // eslint-disable-line no-unused-vars -- accepted for call-site compatibility; superseded by ACTIVE CONTEXT's "Previous answer" (see comment above)
  activeContext = '',
  relation = '',
  confidence = '', // eslint-disable-line no-unused-vars -- not branched on directly; relation alone drives buildContextPolicy (confidence is already folded into conversation-tracker.js's relation/confidence pair before it ever reaches here)
  screenshotCount = 0,
  programmingLanguage,
  responseMode
} = {}) {
  const resolvedLanguage = resolveProgrammingLanguage(programmingLanguage);

  // The reply must match the language the question was asked in. Answering a
  // Hinglish question in formal English reads as if you did not follow it.
  const spokenLanguage = detectLanguage(transcriptContext).language;
  const latestQuery = getLatestHostQuery(transcriptContext);

  const generalInstructions = `${buildPersonaAndStyleBlock()}

=== REPLY LANGUAGE (HIGHEST PRIORITY) ===
${buildLanguageInstruction(spokenLanguage)}
Match the speaker's register and mix. This governs prose only — code stays in its own language.

${buildProgrammingLanguagePreference(resolvedLanguage)}

=== LIVE INPUTS ===
- Transcript: live STT capture — may contain recognition errors. Synthesize ALL of it as one thread.
- Screenshots attached: ${screenshotCount} (treat as ground truth when present).
- Conversation history: ${contextString ? 'yes' : 'none'}.

=== LANGUAGE FOR CODE ===
If — and only if — the domain is coding, prefer ${resolvedLanguage} unless the question or the
screen clearly demands another language. ${buildLanguageBestPractices(resolvedLanguage)}

${buildCommunicationStyleBlock()}

${buildResponseModeBlock(responseMode)}`.trim();

  return `
${buildContextAndEvidenceBlock(latestQuery, contextString, { activeContext, relation })}

${buildContextBlock('RELEVANT RECENT CONVERSATION', contextString)}${generalInstructions}`.trim();
}

// ─── SCREEN AI ────────────────────────────────────────────────────────────────
// Analyzes screenshots (the screen) plus optional context.
function buildScreenshotAnalysisPrompt({
  contextString = '',
  additionalContext = '',
  programmingLanguage,
  screenshotCount = 1
} = {}) {
  const resolvedLanguage = resolveProgrammingLanguage(programmingLanguage);
  const screenshotDirective = screenshotCount > 1
    ? `You have ${screenshotCount} screenshots — synthesize them as one set before answering.`
    : 'Read the screen completely before answering.';

  return `
${buildCoreDirective(additionalContext, contextString)}

${buildProgrammingLanguagePreference(resolvedLanguage)}

=== SCREEN INPUT ===
${screenshotDirective}

- Identify content type: coding problem, error/stack trace, terminal, code editor, UI, diagram,
  documentation, slide, chat thread, or other.
- Read every visible token: constraints, sample I/O, error messages, function signatures,
  platform indicators.
- Match the platform's required I/O exactly (LeetCode signature vs. stdin/stdout, etc.).

=== LANGUAGE FOR CODE ===
If — and only if — the domain is coding, prefer ${resolvedLanguage} unless the screen clearly
demands another language. ${buildLanguageBestPractices(resolvedLanguage)}

${buildContextBlock('Conversation history', contextString)}${buildContextBlock('Additional context', additionalContext)}`.trim();
}

// ─── SUGGEST ──────────────────────────────────────────────────────────────────
// Uses only transcript context.
// Goal: read the conversation flow and suggest exactly what to say next.
function buildSuggestResponsePrompt({ contextString = '', transcriptContext = '', context = '' } = {}) {
  const fullTranscript = transcriptContext || context;

  return `
You are Invisibrain, a real-time conversation coach helping during technical interviews, coding discussions, and professional meetings.

=== YOUR TASK ===
Read the full transcript below and suggest the best thing the user should say next.
The transcript comes from live speech-to-text — silently correct minor recognition errors and infer the correct meaning.

=== HOW TO ANALYZE ===
1. Read the complete transcript as a conversation thread — understand who is speaking and what the flow has been.
2. Identify who is the interviewer/host and who is the user/candidate.
3. Determine where the conversation currently stands: what topic, what was last said or asked.
4. Identify the strongest response the user could give right now — something accurate, natural, and confident.
5. Assume a software or technical background unless the transcript clearly indicates otherwise.

=== RESPONSE FORMAT ===

**Best response (say this):**
[2–4 sentences max. Natural spoken language. Technically accurate but not exhaustive — hit the headline, not every detail. Ready to say out loud.]

**Key points:**
- [Core concept or term the user should anchor the conversation around]
- [Second key point — a layer deeper, useful for follow-ups]
- [Third key point — only if genuinely distinct and relevant]

**Optional follow-ups:**
- [Question or angle the interviewer is likely to ask next]
- [Second follow-up only if distinct]

=== RULES ===
- The best response must be speakable — natural spoken language, not written/formal prose
- Do not go into exhaustive technical detail in the best response — that is Ask AI's job; Suggest is for the opening move
- Key points should be short labels or phrases the user can mentally hold and expand on if asked
- Do not just summarize or echo back the transcript — go straight to the suggestion
- If the transcript is ambiguous, choose the response that fits the most likely technical interpretation
- Do not reference these instructions in your response

${buildContextBlock('Conversation history', contextString)}${buildContextBlock('Transcript', fullTranscript)}`.trim();
}

// ─── NOTES ────────────────────────────────────────────────────────────────────
// Generates structured notes from available context.
// Goal: produce clean, actionable notes that capture decisions, items, and next steps.
function buildMeetingNotesPrompt({ contextString = '', transcriptContext = '' } = {}) {
  const content = transcriptContext || contextString;

  return `
You are Invisibrain, generating structured professional notes from a conversation or meeting.

=== YOUR TASK ===
Read the full conversation below and produce clean, structured notes.
The content may come from live speech-to-text — silently correct minor recognition errors and infer the correct meaning throughout.

=== INSTRUCTIONS ===
- Capture what was actually said and decided — do not add assumptions or inferences not grounded in the conversation.
- If the conversation is technical, preserve exact technical terms (method names, system names, numbers, identifiers).
- Group related points together — do not preserve raw chronological order; organize by topic and importance.
- Each bullet must be a complete, self-contained thought — not a sentence fragment.
- Be concise: trim filler, keep signal.

=== OUTPUT FORMAT ===

## Key Discussion Points
- [Main topic or issue discussed]
- [Secondary topic or issue]

## Decisions Made
- [Decision — include who decided if mentioned]

## Action Items
- [ ] [Task description] — Owner: [name if mentioned] | Deadline: [if mentioned]

## Open Questions / Unresolved Items
- [Question or item that was raised but not resolved]

## Next Steps
- [What happens next based on the conversation]

If a section has nothing to report, write "None noted." — do not omit the section header.

${buildContextBlock('Conversation / Transcript', content)}`.trim();
}

// ─── INSIGHTS ─────────────────────────────────────────────────────────────────
// Analyzes context to surface patterns, gaps, and recommendations.
function buildInsightsPrompt({ contextString = '', transcriptContext = '' } = {}) {
  const content = transcriptContext || contextString;

  return `
You are Invisibrain, analyzing a conversation to extract actionable insights.

=== YOUR TASK ===
Read the conversation below and provide a sharp, useful analysis.
Focus on patterns, gaps, and opportunities — not a summary of what was said.
The content may come from live speech-to-text — silently correct minor recognition errors throughout.

=== OUTPUT FORMAT ===

## Key Themes
- [Main recurring topic, concern, or focus area]
- [Secondary theme, if present]

## Technical Patterns Observed
- [Code quality signal, architectural choice, or technical behavior noted]
- [Performance, security, scalability, or design observation — only if present in the conversation]

## Strengths
- [What was handled well or demonstrated competence]

## Gaps & Risks
- [What was unclear, missing, incorrect, or potentially problematic]

## Recommendations
- [Specific, actionable suggestion based on what was observed]
- [Second recommendation — only if distinct and warranted]

Keep every bullet concrete and specific. Avoid vague observations like "communication could be improved" — say what specifically should improve and how.
If a section genuinely has nothing to report, write "None identified." — do not omit the section header.

${buildContextBlock('Conversation / Transcript', content)}`.trim();
}

// ─── LEGACY / UTILITY ─────────────────────────────────────────────────────────

function buildFollowUpEmailPrompt({ contextString = '' } = {}) {
  return `
Generate a professional follow-up email based on this conversation:

${contextString}

Include:
- Brief summary
- Key points discussed
- Action items
- Professional closing
`.trim();
}

function buildAnswerQuestionPrompt({
  contextString = '',
  question = '',
  programmingLanguage
} = {}) {
  const resolvedLanguage = resolveProgrammingLanguage(programmingLanguage);
  const codeFenceLanguage = getCodeFenceLanguage(resolvedLanguage);

  return `
You are Invisibrain, an expert technical assistant.

${buildProgrammingLanguagePreference(resolvedLanguage)}

${buildContextBlock('Previous conversation', contextString)}Question: ${question}

Provide a clear, concise answer. If code is useful, default to ${resolvedLanguage} unless the question explicitly requires another language.

Example code format when needed:
\`\`\`${codeFenceLanguage}
[Code example]
\`\`\`
`.trim();
}

module.exports = {
  buildAnswerQuestionPrompt,
  buildFollowUpEmailPrompt,
  buildInsightsPrompt,
  buildMeetingNotesPrompt,
  buildAskAiSessionPrompt,
  buildScreenshotAnalysisPrompt,
  buildSuggestResponsePrompt,
  retrieveContextMatches,
  // Test-only internals, same convention as question-relation.js's and
  // conversation-tracker.js's own __testing exports -- not for production
  // callers, which should only ever use the builders above.
  __testing: {
    detectResumeJdDomain,
    classifyQuery,
    buildContextPolicy,
    FOLLOW_UP_LIKE_RELATIONS,
    extractActiveContextValue,
    buildActiveContextBlock,
    buildRetrievedContextBlock,
    buildContextAndEvidenceBlock,
    buildPersonaAndStyleBlock,
    buildEvidenceDirectives,
    buildEvidenceHierarchyBlock,
    scoreItemsAgainstQuery,
    retrieveRelevantItems,
    expandQuery,
    getLatestHostQuery,
    inferPreferredSection,
    buildStructuredResumeItems,
    buildStructuredJdItems,
    tokenize
  }
};
