'use strict';

// One parser for the website and the desktop app. The desktop copy at
// src/services/ai/resume-parser.js must stay byte-identical to this file;
// tests/test-parser-parity.mjs fails when they differ.

const fs = require('fs');

/**
 * ResumeParser
 * Splits resume text into {id, section, text} lines under the section heading each one sits in.
 * Sections: Header (name and contact, above the first heading), Summary, Experience, Education,
 * Projects, Skills, Certifications, Achievements, and Additional (a recognised but non-core section
 * such as Publications or Languages; `heading` keeps its title). Nothing is dropped: a line is only
 * ever moved to the section it belongs to.
 */
class ResumeParser {
  /**
   * Parse PDF or text resume file into structured bullet points
   * @param {string} filePath
   * @returns {Promise<Array<{id: string, section: string, text: string, heading?: string}>>}
   */
  async parseResume(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Resume file not found at path: ${filePath}`);
    }

    const rawText = filePath.toLowerCase().endsWith('.pdf')
      ? await this.extractPdfText(filePath)
      : fs.readFileSync(filePath, 'utf8');

    return this.extractSections(rawText);
  }

  /**
   * Extracts text from a PDF.
   *
   * This used to fall back to reading the PDF as UTF-8 when pdf-parse threw,
   * which does not degrade gracefully — it yields binary noise that then gets
   * embedded and retrieved as though it were the user's resume. Failing loudly
   * is the only safe behaviour here.
   *
   * @param {string} filePath
   * @returns {Promise<string>}
   */
  async extractPdfText(filePath) {
    let pdfParse;

    try {
      pdfParse = require('pdf-parse');
    } catch (_) {
      throw new Error(
        'PDF support requires the pdf-parse package (npm install pdf-parse). '
        + 'Paste the resume text or upload a .txt file instead.'
      );
    }

    const data = await pdfParse(fs.readFileSync(filePath));
    const text = String(data.text || '').trim();

    if (!text) {
      throw new Error(
        'No text could be extracted from that PDF — it is most likely a scan. '
        + 'Paste the resume text or upload a .txt file instead.'
      );
    }

    return text;
  }

  /**
   * Extract bullet sections from raw resume text
   * @param {string} rawText
   * @returns {Array<{id: string, section: string, text: string, heading?: string}>}
   */
  extractSections(rawText) {
    const lines = String(rawText || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const sections = [];

    // Lines before the first section heading are the name and contact block.
    // Only when the resume has no headings at all does everything stay under
    // Experience, so heading-less resumes still work.
    const hasHeadings = lines.some((line) => matchHeading(line));
    let currentSection = hasHeadings ? 'Header' : 'Experience';
    let currentHeading = '';

    const push = (text) => {
      if (text.length < 2) return; // stray bullet glyphs and single letters
      const item = { id: `res_bullet_${sections.length + 1}`, section: currentSection, text };
      if (currentSection === 'Additional') item.heading = currentHeading;
      sections.push(item);
    };

    for (const line of lines) {
      const heading = matchHeading(line);
      if (heading && heading.rest && ENTRY_SECTIONS.has(currentSection) && ENTRY_LABEL.test(heading.title)) {
        // "Tech Stack: React, Node" or "Tools: Jenkins" inside a job or project
        // describes that entry; it does not start a new section.
        push(line);
        continue;
      }
      if (heading && heading.rest && heading.section === 'Additional' && currentSection !== 'Header') {
        // "Languages: Python, Go" under Skills is content; a non-core section
        // only starts on a heading line of its own.
        push(line);
        continue;
      }
      if (heading) {
        currentSection = heading.section;
        currentHeading = heading.title;
        // "Skills: Python, React, SQL" is a heading and content on one line;
        // keep the content instead of dropping the whole line.
        if (heading.rest) push(heading.rest);
        continue;
      }
      push(line);
    }

    return sections;
  }
}

// Sections whose lines belong to a named entry (a job, a project, a degree).
const ENTRY_SECTIONS = new Set(['Experience', 'Projects', 'Education']);
// Labels that describe the entry they sit in ("Tech Stack:", "Tools:", "Coursework:").
// Section titles such as "Skills:", "Technical Skills:" or "Education:" still start a section.
const ENTRY_LABEL = /^\s*(tech(nology)?\s*stack|stack|tools(\s+used)?|technologies(\s+used)?|built\s+with|environment|(relevant\s+)?coursework|courses)\s*$/i;

// Section headings as resumes actually write them: "EXPERIENCE",
// "Work Experience", "PROFESSIONAL SUMMARY", "Technical Skills:", "Key
// Projects". A heading is short and made only of an optional qualifier plus
// a section word, so ordinary sentences that happen to start with "Skills"
// or "Work" are not mistaken for headings.
const SECTION_WORDS = [
  [/^(summary|profile|objective|about me|about|career objective|career summary|profile summary|executive summary|overview|introduction)$/, 'Summary'],
  [/^(experience|work experience|employment|employment history|work history|internships?|experience and internships?|journey|career|career history|positions? of responsibility)$/, 'Experience'],
  [/^(education|academics?|qualifications?|educational background|education and training)$/, 'Education'],
  [/^(projects?|personal projects|academic projects|selected work|portfolio|open source|side projects?)$/, 'Projects'],
  [/^(skills|technical skills|core skills|key skills|technologies|tech stack|tools|toolkit|toolbox|competencies|core competencies|skills and tools|tools and technologies|skill set|skillset)$/, 'Skills'],
  [/^(certifications?|licenses? and certifications?|certificates?|courses|training)$/, 'Certifications'],
  [/^(achievements?|awards?|honou?rs|accomplishments|awards and honou?rs|honou?rs and awards)$/, 'Achievements'],
  // Non-core sections: kept, under their own heading, so their lines never
  // leak into the section above them.
  [/^(publications?|research|patents?|presentations|talks|conferences|languages?|interests|hobbies|hobbies and interests|volunteer(ing)?|volunteer experience|community|leadership|activities|extracurricular activities|extra curricular activities|extracurriculars?|memberships?|affiliations|professional affiliations|coursework|relevant coursework|references|declaration|personal details|personal information|contact|contact information|links)$/, 'Additional']
];
const QUALIFIERS = /^(professional|technical|relevant|key|selected|notable|academic|personal|core|work|career|executive)\s+/;

function matchHeading(line) {
  const [head, ...restParts] = line.split(':');
  const rest = restParts.join(':').trim();
  if (head.length > 40) return null;
  const title = head.trim().replace(/[\s:]+$/, '');
  let words = head.toLowerCase().replace(/[^a-z& ]/g, ' ').replace(/&/g, 'and').replace(/\s+/g, ' ').trim();
  if (!words) return null;
  for (const [pattern, section] of SECTION_WORDS) {
    if (pattern.test(words)) return { section, rest, title };
  }
  words = words.replace(QUALIFIERS, '');
  for (const [pattern, section] of SECTION_WORDS) {
    if (pattern.test(words)) return { section, rest, title };
  }

  // Looser form for headings with extra words ("INTERNSHIP EXPERIENCE",
  // "ACADEMIC PROJECTS & RESEARCH", "Projects (Selected)"): only for lines
  // that look like headings, meaning ALL CAPS or at most 5 Title Case words
  // with no sentence punctuation, and no content after a colon.
  const raw = head.trim();
  const letters = raw.replace(/[^A-Za-z]/g, '');
  const isAllCaps = letters.length >= 4 && letters === letters.toUpperCase();
  const titleWords = raw.split(/\s+/).filter((word) => /[A-Za-z]/.test(word));
  const isTitleCase = titleWords.length <= 5 && titleWords.every((word) => /^[A-Z(&]/.test(word) || /^(and|of|the|in)$/.test(word));
  if (rest || /[.!?,]/.test(raw) || !(isAllCaps || isTitleCase)) return null;
  for (const [pattern, section] of KEYWORD_SECTIONS) {
    if (pattern.test(words)) return { section, rest: '', title };
  }
  return null;
}

// Checked in this order: the more specific section wins.
const KEYWORD_SECTIONS = [
  [/certificat|licen[cs]e/, 'Certifications'],
  [/achievement|award|honou?r|accomplishment/, 'Achievements'],
  [/education|academic background|qualification/, 'Education'],
  [/project/, 'Projects'],
  [/skill|technolog|tech stack|tools/, 'Skills'],
  [/summary|profile|objective|about/, 'Summary'],
  [/experience|internship|employment|work history|positions? of responsibility/, 'Experience'],
  [/publication|patent|language|interest|hobb|volunteer|leadership|extracurricular|activities|coursework|membership|affiliation/, 'Additional']
];

module.exports = ResumeParser;
