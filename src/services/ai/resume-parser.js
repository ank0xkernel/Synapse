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
    const lines = rawText.split('\n');
    const sections = [];
    let currentSection = 'Experience';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Phase 9: minimally extended (not a competing parser -- same function,
      // same regex-header-detection strategy) to also recognize
      // certifications/achievements headings, which candidate-profile.js
      // needs and the original list didn't cover. Every previously-
      // recognized header is untouched; resumes without these headings are
      // completely unaffected.
      if (/^(skills|experience|work|education|projects|summary|certifications?|achievements?|awards)/i.test(line)) {
        currentSection = line.replace(/[^a-zA-Z]/g, '');
        continue;
      }

      if (line.length > 15) {
        sections.push({
          id: `res_bullet_${sections.length + 1}`,
          section: currentSection,
          text: line
        });
      }
    }

    console.log(`[ResumeParser] Parsed ${sections.length} structured resume bullets.`);
    return sections;
  }
}

module.exports = ResumeParser;
