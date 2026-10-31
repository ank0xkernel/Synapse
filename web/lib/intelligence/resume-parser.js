'use strict';

const fs = require('fs');

/**
 * ResumeParser
 * Extracts structured text (skills, work experience, projects, education) from candidate PDF resumes or plain text.
 */
class ResumeParser {
  /**
   * Parse PDF or text resume file into structured bullet points
   * @param {string} filePath 
   * @returns {Promise<Array<{id: string, section: string, text: string}>>}
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
   * @returns {Array<{id: string, section: string, text: string}>}
   */
  extractSections(rawText) {
    const lines = rawText.split('\n').map((line) => line.trim()).filter(Boolean);
    const sections = [];

    // Lines before the first section heading are the name and contact block,
    // not experience. Only when the resume has no headings at all does
    // everything stay under Experience, so heading-less resumes still work.
    const hasHeadings = lines.some((line) => matchHeading(line));
    let currentSection = hasHeadings ? 'Header' : 'Experience';

    const push = (text) => {
      if (text.length > 15) {
        sections.push({ id: `res_bullet_${sections.length + 1}`, section: currentSection, text });
      }
    };

    for (const line of lines) {
      const heading = matchHeading(line);
      if (heading) {
        currentSection = heading.section;
        // "Skills: Python, React, SQL" is a heading and content on one line;
        // keep the content instead of dropping the whole line.
        if (heading.rest) push(heading.rest);
        continue;
      }
      push(line);
    }

    console.log(`[ResumeParser] Parsed ${sections.length} structured resume bullets.`);
    return sections;
  }
}

// Section headings as resumes actually write them: "EXPERIENCE",
// "Work Experience", "PROFESSIONAL SUMMARY", "Technical Skills:", "Key
// Projects". A heading is short and made only of an optional qualifier plus
// a section word, so ordinary sentences that happen to start with "Skills"
// or "Work" are not mistaken for headings.
const SECTION_WORDS = [
  [/^(summary|profile|objective|about me)$/, 'Summary'],
  [/^(experience|work experience|employment|employment history|work history|internships?|experience and internships?)$/, 'Experience'],
  [/^(education|academics?|qualifications?)$/, 'Education'],
  [/^(projects?|personal projects|academic projects)$/, 'Projects'],
  [/^(skills|technical skills|core skills|key skills|technologies|tech stack|tools)$/, 'Skills'],
  [/^(certifications?|licenses? and certifications?|courses)$/, 'Certifications'],
  [/^(achievements?|awards?|honou?rs|accomplishments)$/, 'Achievements']
];
const QUALIFIERS = /^(professional|technical|relevant|key|selected|notable|academic|personal|core|work)\s+/;

function matchHeading(line) {
  const [head, ...restParts] = line.split(':');
  const rest = restParts.join(':').trim();
  if (head.length > 40) return null;
  let words = head.toLowerCase().replace(/[^a-z& ]/g, ' ').replace(/&/g, 'and').replace(/\s+/g, ' ').trim();
  if (!words) return null;
  for (const [pattern, section] of SECTION_WORDS) {
    if (pattern.test(words)) return { section, rest };
  }
  words = words.replace(QUALIFIERS, '');
  for (const [pattern, section] of SECTION_WORDS) {
    if (pattern.test(words)) return { section, rest };
  }
  return null;
}

module.exports = ResumeParser;
