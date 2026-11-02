'use strict';

const fs = require('fs');
const path = require('path');
const { SECOND_BRAIN_CONFIG } = require('./config');

/**
 * 4-Tier Personal Engineering Memory
 *
 * Tier 1: Professional Memory (Education, Experience, Skills, Certifications)
 * Tier 2: Project Memory (Verified Architectures, Features, Decisions)
 * Tier 3: Session Memory (Questions discussed, active project, follow-up state)
 * Tier 4: User-Reviewed Memory (User confirmed/corrected facts, never overwritten on reindex)
 */

class EngineeringMemory {
  constructor(baseDir = null) {
    this.baseDir = baseDir || path.join(__dirname, '..', '..', '..', 'cache', SECOND_BRAIN_CONFIG.storeDirName);
    this.memoryPath = path.join(this.baseDir, 'engineering-memory.json');

    this.professionalMemory = {
      candidateName: 'Ankit Singh',
      education: [
        {
          institution: 'Newton School of Technology, Pune',
          degree: 'Bachelor of Engineering (Computer Science, AI & ML)',
          period: '2024 - 2028',
          grade: '7.82 / 10.0'
        },
        {
          institution: 'Vivekanand International Public School',
          level: 'Class XII (Intermediate)',
          period: '2022 - 2023',
          grade: '90.0%'
        },
        {
          institution: 'Vivekanand International Public School',
          level: 'Class X (Matriculation)',
          period: '2020 - 2021',
          grade: '95.0%'
        }
      ],
      verifiedExperience: [
        {
          role: 'Full Stack Developer',
          company: 'Evox Ventures, Pune',
          period: 'December 2025 - May 2026',
          verifiedResponsibilities: 'Lead Developer for official digital experience with Next.js, React, Tailwind CSS, Framer Motion, and Three.js.'
        },
        {
          role: 'Full Stack Developer (Job Simulation)',
          company: 'JPMorgan Chase & Co.',
          period: 'June 2026 - August 2026',
          verifiedResponsibilities: 'Kafka integration into Spring Boot microservices, Spring Data JPA transaction processing with H2, RestTemplate external API consumption.'
        }
      ],
      verifiedSkills: [
        'Python', 'TypeScript', 'JavaScript', 'React', 'Next.js', 'Node.js', 'Express',
        'FastAPI', 'PostgreSQL', 'Prisma ORM', 'Kafka', 'Spring Boot', 'Tailwind CSS',
        'Framer Motion', 'Three.js / WebGL', 'Docker', 'Git', 'Google Gemini AI', 'Supabase'
      ]
    };

    this.projectMemory = new Map();   // projectId -> project technical summaries & decisions
    this.sessionMemory = {
      activeProjectId: null,
      discussedTopics: [],
      recentQuestions: [],
      followUpState: null
    };
    this.userReviewedMemory = new Map(); // key -> user-confirmed override fact

    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.memoryPath)) {
        const raw = fs.readFileSync(this.memoryPath, 'utf8');
        const data = JSON.parse(raw);
        if (data.professionalMemory) this.professionalMemory = data.professionalMemory;
        if (data.projectMemory) this.projectMemory = new Map(Object.entries(data.projectMemory));
        if (data.sessionMemory) this.sessionMemory = data.sessionMemory;
        if (data.userReviewedMemory) this.userReviewedMemory = new Map(Object.entries(data.userReviewedMemory));
      }
    } catch {
      // Non-fatal if memory file doesn't exist yet
    }
  }

  save() {
    try {
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
      }
      const data = {
        updatedAt: new Date().toISOString(),
        professionalMemory: this.professionalMemory,
        projectMemory: Object.fromEntries(this.projectMemory),
        sessionMemory: this.sessionMemory,
        userReviewedMemory: Object.fromEntries(this.userReviewedMemory)
      };
      fs.writeFileSync(this.memoryPath, JSON.stringify(data, null, 2), 'utf8');
    } catch {
      // Non-fatal
    }
  }

  // Tier 1: Professional Memory
  getProfessionalMemory() {
    return this.professionalMemory;
  }

  // Tier 2: Project Memory
  setProjectMemory(projectId, memoryObj) {
    this.projectMemory.set(projectId, {
      ...memoryObj,
      updatedAt: new Date().toISOString()
    });
    this.save();
  }

  getProjectMemory(projectId) {
    return this.projectMemory.get(projectId) || null;
  }

  // Tier 3: Session Memory
  recordQuestionTurn(question, answerSummary, activeProjectId = null) {
    if (!question) return;
    this.sessionMemory.recentQuestions.push({
      question,
      answerSummary: answerSummary ? answerSummary.slice(0, 200) : '',
      timestamp: new Date().toISOString()
    });
    if (this.sessionMemory.recentQuestions.length > 20) {
      this.sessionMemory.recentQuestions.shift();
    }
    if (activeProjectId) {
      this.sessionMemory.activeProjectId = activeProjectId;
    }
    this.save();
  }

  getSessionMemory() {
    return this.sessionMemory;
  }

  clearSessionMemory() {
    this.sessionMemory = {
      activeProjectId: null,
      discussedTopics: [],
      recentQuestions: [],
      followUpState: null
    };
    this.save();
  }

  // Tier 4: User-Reviewed Memory (Immutable to reindexing)
  setUserFact(key, fact) {
    return this.setUserReviewedFact(key, fact);
  }

  getUserFact(key) {
    return this.getUserReviewedFact(key);
  }

  setUserReviewedFact(key, fact) {
    this.userReviewedMemory.set(key, {
      key,
      fact,
      confirmedByUser: true,
      updatedAt: new Date().toISOString()
    });
    this.save();
  }

  getUserReviewedFact(key) {
    return this.userReviewedMemory.get(key) || null;
  }

  getAllUserReviewedFacts() {
    return Array.from(this.userReviewedMemory.values());
  }

  deleteUserReviewedFact(key) {
    const deleted = this.userReviewedMemory.delete(key);
    if (deleted) this.save();
    return deleted;
  }
}

module.exports = {
  EngineeringMemory,
  engineeringMemory: new EngineeringMemory()
};
