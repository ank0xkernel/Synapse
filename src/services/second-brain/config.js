'use strict';

const path = require('path');
const os = require('os');

/**
 * Synapse Second Brain — Configuration
 *
 * Configures project roots, persistence directories, indexing filters,
 * secret scanning patterns, and token/latency budgets.
 */

const HOME = os.homedir();

// Canonical project definitions with discovered local directories on macOS
const KNOWN_PROJECTS = {
  jumpstart_go: {
    id: 'jumpstart_go',
    name: 'Jumpstart Go',
    category: 'priority_resume',
    resumeTitle: 'Jumpstart Go — Preschool pickup/drop-off management PWA',
    candidatePaths: [
      path.join(HOME, 'Downloads', 'jumpstart-app-claude-jumpstart-background-voice-jkomjf'),
      path.join(HOME, 'Downloads', 'jumpstart-app-main'),
      path.join(HOME, 'jumpstart')
    ],
    verifiedSummary: 'Preschool pickup & drop-off management PWA for Jumpstart Preschool, Karve Road. Features real-time arrivals queue, WhatsApp OTP authentication, Azure TTS Indian English voice announcements for center leaders, gate code verification, and Cloudflare Workers/Supabase edge architecture.',
    primaryStack: ['React 18', 'TypeScript', 'Vite', 'Tailwind CSS', 'Capacitor', 'Supabase', 'PostgreSQL', 'Cloudflare Workers', 'Azure Speech TTS', 'Twilio WhatsApp']
  },
  novaris: {
    id: 'novaris',
    name: 'Novaris',
    category: 'priority_resume',
    resumeTitle: 'Novaris — Agentic AI-powered GitHub intelligence platform',
    candidatePaths: [
      path.join(HOME, 'Novaris'),
      path.join(HOME, 'Downloads', 'Novaris-final'),
      path.join(HOME, 'Downloads', 'Novaris-main')
    ],
    verifiedSummary: 'Agentic AI-powered GitHub repository intelligence platform. Analyzes codebases and developer profiles across 5 engineering dimensions (Code Complexity, Architecture Maturity, Production Readiness, Engineering Leadership, Technical Depth) using AST analysis, GitHub REST/GraphQL APIs, Gemini 1.5, and Prisma/PostgreSQL.',
    primaryStack: ['Next.js 15', 'React 19', 'TypeScript', 'Tailwind CSS', 'Prisma ORM', 'PostgreSQL', 'Octokit', 'Google Gemini AI', 'LangGraph', 'NextAuth.js', 'Vitest']
  },
  evox_ventures: {
    id: 'evox_ventures',
    name: 'Evox Ventures',
    category: 'priority_resume',
    resumeTitle: 'Evox Ventures — Interactive portfolio and event management platform',
    candidatePaths: [
      path.join(HOME, 'evox-ventures'),
      path.join(HOME, 'Documents', 'GitHub', 'evox-ventures'),
      path.join(HOME, 'Downloads', 'evox-ventures-main')
    ],
    verifiedSummary: 'Official digital portfolio and event management platform for Evox Ventures. Features interactive 3D particle field, parallax showcase for sports/luxury/tech events, dynamic multi-step quotation & budget estimator engine, and AI concierge lead capture.',
    primaryStack: ['Next.js', 'React', 'TypeScript', 'Tailwind CSS', 'Framer Motion', 'Three.js / WebGL', 'Vercel']
  },
  shuttle_tracker: {
    id: 'shuttle_tracker',
    name: 'Shuttle Tracker',
    category: 'priority_resume',
    resumeTitle: 'Shuttle Tracker — Real-time campus transportation tracking system',
    candidatePaths: [
      path.join(HOME, 'Shuttle_Tracker')
    ],
    verifiedSummary: 'Real-time campus shuttle transportation tracking system. Features driver geolocation GPS tracking via navigator.geolocation, student polling client, live map rendering with route visualization, and lightweight in-memory coordinate buffering with Redis scalability roadmap.',
    primaryStack: ['React', 'JavaScript', 'Node.js', 'Express', 'Google Maps / Mapbox API', 'In-Memory Cache']
  },
  gems_lord: {
    id: 'gems_lord',
    name: 'Gems Lord',
    category: 'additional_project',
    resumeTitle: 'Gems Lord — Gemstone, jewellery, and e-commerce platform',
    candidatePaths: [
      path.join(HOME, 'gemslord-final', 'gemslord-1'),
      path.join(HOME, 'Gemslord_FInal_S', 'gemslord'),
      path.join(HOME, 'gemslord-final', 'gemslord')
    ],
    verifiedSummary: 'Omnichannel luxury gemstone and custom jewellery e-commerce platform. Features carat/ratti pricing engine, live inventory reservations only upon verified payment, Razorpay checkout with webhook verification, Shiprocket logistics, and automated GST billing with PDFKit.',
    primaryStack: ['Next.js 15', 'React', 'Node.js', 'Express', 'TypeScript', 'Prisma ORM', 'PostgreSQL', 'Razorpay', 'Shiprocket', 'PDFKit', 'Vitest']
  },
  chhota_vyapar: {
    id: 'chhota_vyapar',
    name: 'Chhota Vyapar',
    category: 'additional_project',
    resumeTitle: 'Chhota Vyapar — Route-to-market & distribution consultancy platform',
    candidatePaths: [
      path.join(HOME, 'Downloads', 'chotavyapar-final'),
      path.join(HOME, 'Downloads', 'chotavyapar-main')
    ],
    verifiedSummary: 'Route-to-market and distribution consultancy platform for physical-product brands expanding into Indian retail channels (General Trade, Modern Trade, D2C, HORECA, e-commerce) and foreign brand entry (Minky UK, MAWA Germany).',
    primaryStack: ['Next.js 16', 'React 19', 'TypeScript', 'Tailwind CSS v4', 'GSAP', 'Motion', 'Lenis', 'Leaflet', 'Playwright']
  },
  manisha_wires: {
    id: 'manisha_wires',
    name: 'Manisha Wires',
    category: 'additional_project',
    resumeTitle: 'Manisha Wires — Steel wire stockist & institutional distribution platform',
    candidatePaths: [
      path.join(HOME, 'Downloads', 'Manisha_Wires-main'),
      path.join(HOME, 'Downloads', 'Manisha_Wires1')
    ],
    verifiedSummary: 'Portfolio and institutional platform for Manisha Wires Pvt. Ltd. (MWPL), a stockist and distributor of industrial and spring steel wire (Usha Martin, Aarti, KEI, Pengg Usha, DSR) across Mumbai/Bhiwandi/Vasai. Features 3D Cobe WebGL globe, Leaflet supply maps, and RFQ Google Sheets integration.',
    primaryStack: ['Next.js 16', 'React 19', 'TypeScript', 'Tailwind CSS v4', 'Motion', 'Cobe WebGL', 'Leaflet', 'Google Sheets API']
  },
  synapse: {
    id: 'synapse',
    name: 'Synapse',
    category: 'core_assistant',
    resumeTitle: 'Synapse — AI Interview Assistant & Second Brain',
    candidatePaths: [
      path.join(HOME, 'Downloads', 'Open-Cluely-main')
    ],
    verifiedSummary: 'Local-first AI practice coach and live call assistant for interview preparation. Combines macOS CoreAudio system loopback audio capture, AssemblyAI real-time speech-to-text, Google Gemini streaming answers, and PKCE-authenticated web synchronisation with Next.js/PostgreSQL.',
    primaryStack: ['Electron', 'Node.js', 'Next.js 16', 'PostgreSQL', 'AssemblyAI', 'Google Gemini AI', 'CoreAudio', 'WebSockets', 'PKCE']
  },
  jumpstart_inventory: {
    id: 'jumpstart_inventory',
    name: 'Jumpstart Inventory Intelligence OS',
    category: 'relevant_repository',
    resumeTitle: 'Jumpstart Inventory Intelligence OS — Preschool inventory OS',
    candidatePaths: [
      path.join(HOME, 'JS-Inventory-Management'),
      path.join(HOME, 'Downloads', 'JS-Inventory-Management')
    ],
    verifiedSummary: 'Enterprise preschool inventory management operating system. Implements comprehensive inventory traceability (Q01-Q58), classroom asset tracking, supply replenishment workflows, Recharts analytical dashboards, and Zod domain validation.',
    primaryStack: ['Next.js 15 (Turbopack)', 'React 19', 'TypeScript', 'Tailwind CSS v4', 'Recharts', 'Zod', 'Vitest']
  },
  campus_connect: {
    id: 'campus_connect',
    name: 'CampusConnect',
    category: 'priority_resume',
    resumeTitle: 'CampusConnect — University Management & Student Ecosystem Platform',
    candidatePaths: [
      path.join(HOME, 'CampusConnect')
    ],
    verifiedSummary: 'Enterprise full-stack university management platform. Features 23-table normalized PostgreSQL schema in 3NF, automated audit and attendance triggers, stored procedures for student enrollment and CGPA-gated internship applications, analytical views, and role-based access control (Admin, Student, Faculty, Recruiter).',
    primaryStack: ['React', 'TypeScript', 'Node.js', 'Express', 'PostgreSQL', 'Prisma ORM', 'Docker Compose', 'JWT RBAC', 'Three.js']
  },
  astrology_engine: {
    id: 'astrology_engine',
    name: 'Astrology/Kundli Engine',
    category: 'specialized_subengine',
    resumeTitle: 'Kundli Calculation Engine — Vedic & Astronomical Precision Library',
    candidatePaths: [
      path.join(HOME, 'gemslord-final', 'gemslord-1', 'backend', 'src', 'astrology'),
      path.join(HOME, 'gemslord-final', 'gemslord-1', 'docs', 'astrology')
    ],
    verifiedSummary: 'High-precision Vedic and astronomical calculation engine built as a pure library. Adapts Astronomy Engine to calculate Julian dates, sidereal snapshots with Lahiri ayanamsa, lunar nodes, D1/D9 vargas, Bhav Chalit (Sripati & Placidus), KP sublords, Ashtakavarga matrices, and Vimshottari dasha, validated against Swiss Ephemeris golden fixtures.',
    primaryStack: ['TypeScript', 'Node.js', 'Astronomy Engine', 'Swiss Ephemeris Validation', 'PDFKit']
  }
};

const SUPPORTED_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.py', '.sql', '.prisma',
  '.json', '.md', '.html', '.css', '.mjs', '.yaml', '.yml'
]);

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.cache',
  'cache',
  'coverage',
  '.turbo',
  '.playwright-cli',
  'venv',
  '.venv',
  'env',
  '__pycache__',
  '.DS_Store'
]);

// Secret scanning patterns to block credentials, tokens, and private keys
const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z-_]{30,40}/g,                              // Google API Key
  /(?:sk|pk)_(?:test|live)_[0-9a-zA-Z]{24,}/g,              // Stripe / generic secret
  /gh[pous]_[0-9a-zA-Z]{36}/g,                              // GitHub Token
  /bearer\s+[a-zA-Z0-9_\-\.=:_\+\/]{20,}/gi,                // Bearer token
  /eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // PEM Private key
  /postgres(?:ql)?:\/\/[^:]+:[^@]+@[^:]+:\d+\/\w+/gi,       // Database connection string with password
  /(?:api[_-]?key|secret|password|auth_token)\s*[:=]\s*['"][a-zA-Z0-9_\-]{8,}['"]/gi // Generic credential assignments
];

const SECOND_BRAIN_CONFIG = {
  enabled: true,
  storeDirName: 'second-brain',
  maxIndexedFilesPerProject: 600,
  maxFileSizeBytes: 512 * 1024, // 512 KB per file
  chunkSize: 45,                // ~45 lines per chunk
  chunkOverlap: 10,             // 10 lines overlap
  retrievalMaxSnippets: 4,      // Top 4 snippets in live prompt
  retrievalTokenBudget: 1200,   // Max ~1,200 tokens injected into prompt
  bm25Weight: 0.6,
  vectorWeight: 0.4,
  minConfidenceScore: 0.15,
  knownProjects: KNOWN_PROJECTS,
  supportedExtensions: SUPPORTED_EXTENSIONS,
  ignoredDirectories: IGNORED_DIRECTORIES,
  secretPatterns: SECRET_PATTERNS
};

/**
 * Where the index and memory are stored. A packaged build's source sits inside
 * the read-only app.asar, so it writes to userData/state instead; development
 * keeps the project cache/ folder.
 */
function resolveStoreDir() {
  const path = require('path');
  let app = null;
  try { ({ app } = require('electron')); } catch (_) { /* plain Node (tests) */ }
  if (app && app.isPackaged) return path.join(app.getPath('userData'), 'state', SECOND_BRAIN_CONFIG.storeDirName);
  return path.join(__dirname, '..', '..', '..', 'cache', SECOND_BRAIN_CONFIG.storeDirName);
}

module.exports = {
  resolveStoreDir,
  SECOND_BRAIN_CONFIG,
  KNOWN_PROJECTS,
  SUPPORTED_EXTENSIONS,
  IGNORED_DIRECTORIES,
  SECRET_PATTERNS
};
