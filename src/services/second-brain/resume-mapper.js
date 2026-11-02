'use strict';

/**
 * Resume-to-Code Mapping Intelligence
 *
 * Connects candidate resume claims and experience bullets directly to
 * concrete verified code artifacts, file paths, and architectural implementations.
 */

const RESUME_PROJECT_MAPPINGS = [
  {
    projectId: 'jumpstart_go',
    resumeSection: 'PROJECTS',
    claim: 'Preschool pickup/drop-off management PWA with real-time arrivals queue and spoken announcements',
    verifiedImplementation: {
      summary: 'Capacitor PWA with React 18, Supabase Realtime, and Web Audio/Azure TTS voice pipeline for preschool gate and parent handovers.',
      evidenceFiles: [
        'src/features/duty/sound.ts',
        'src/features/duty/voiceClips.ts',
        'src/features/duty/CoordinatorDuty.tsx',
        'src/features/trips/tracking.ts',
        'supabase/functions/_shared/announce.ts'
      ],
      technologies: ['React 18', 'TypeScript', 'Tailwind CSS', 'Capacitor', 'Supabase', 'Cloudflare Workers', 'Azure Speech TTS', 'Twilio WhatsApp OTP'],
      flows: [
        'Parent taps "I\'m on my way" / "I\'ve arrived" via PWA.',
        'Trip status updates in Supabase PostgreSQL and streams to the coordinator tablet via Realtime.',
        'Sound system triggers an audio chime and speaks child handover announcements in Indian English ("en-IN-NeerjaNeural") via Azure Speech or local speech synthesis fallback.'
      ]
    }
  },
  {
    projectId: 'novaris',
    resumeSection: 'PROJECTS',
    claim: 'AI-powered GitHub repository intelligence platform that analyzes codebases and developer profiles using Agentic AI, LangGraph, and LLMs',
    verifiedImplementation: {
      summary: 'Next.js 15 App Router platform with Prisma/PostgreSQL, Octokit GitHub API integration, rule-based security scanner, and Gemini 1.5 verification.',
      evidenceFiles: [
        'src/lib/services/security-service.ts',
        'src/lib/github.ts',
        'src/lib/gemini-security.ts',
        'src/lib/services/report-service.ts',
        'prisma/schema.prisma'
      ],
      technologies: ['Next.js 15', 'TypeScript', 'Tailwind CSS', 'Prisma ORM', 'PostgreSQL', 'Google Gemini AI', 'Octokit', 'Vitest'],
      flows: [
        'User initiates repository scan via GitHub URL or authenticated user repo list.',
        'Service fetches file trees and dependency lockfiles (package.json, lockfiles) using Octokit.',
        'runScanEngineV2 performs rule-based pattern matching across source files and dependencies.',
        'analyzeCodeWithGemini performs deep contextual verification and false-positive filtering.',
        'Results compute 5-dimensional scores (Complexity, Architecture, Production, Leadership, Depth) stored in PostgreSQL.'
      ]
    }
  },
  {
    projectId: 'evox_ventures',
    resumeSection: 'WORK EXPERIENCE',
    claim: 'Lead Full Stack Developer at Evox Ventures — Engineered and deployed official digital experience with interactive 3D particle field and quotation engine',
    verifiedImplementation: {
      summary: 'Full-stack event management and portfolio showcase with interactive WebGL particle fields, budget estimator, and lead concierge.',
      evidenceFiles: [
        'src/components/ui/ParticleField.jsx',
        'src/components/calculator/BudgetEstimator.jsx',
        'src/app/quotation/page.jsx',
        'src/sections/EventsShowcase.jsx',
        'src/app/api/concierge/route.js'
      ],
      technologies: ['Next.js', 'React', 'Tailwind CSS', 'Framer Motion', 'Three.js / WebGL', 'Vercel'],
      flows: [
        'Landing page renders hardware-accelerated 3D particle field and parallax timeline for sports, luxury, and tech portfolios.',
        'Multi-step "Get Quote" inquiry engine and BudgetEstimator calculator capture client requirements and event scope.',
        'API routes capture leads and pass to concierge handler.'
      ]
    }
  },
  {
    projectId: 'shuttle_tracker',
    resumeSection: 'PROJECTS',
    claim: 'Real-time campus shuttle tracking system with live GPS tracking, ETA prediction, and route visualization',
    verifiedImplementation: {
      summary: 'Express backend and React frontend with lightweight in-memory driver location buffering and GPS polling.',
      evidenceFiles: [
        'backend/src/index.js',
        'HLD.md',
        'frontend/latest/src/App.js'
      ],
      technologies: ['React', 'JavaScript', 'Node.js', 'Express', 'Google Maps / Mapbox API'],
      flows: [
        'Driver mobile app accesses GPS coordinates via navigator.geolocation.getCurrentPosition().',
        'Driver sends POST /api/driver/location updating status (At Hostel, On Route, At Campus).',
        'Backend stores location in lightweight in-memory coordinates for sub-second updates without DB thrashing.',
        'Student client polls GET /api/driver/location to render real-time marker on map.'
      ]
    }
  },
  {
    projectId: 'gems_lord',
    resumeSection: 'ADDITIONAL PROJECTS',
    claim: 'Omnichannel luxury gemstone and custom jewellery e-commerce platform with automated GST billing and live inventory lock',
    verifiedImplementation: {
      summary: 'Modular Express + Next.js architecture with Prisma ORM, PostgreSQL, Razorpay payments, Shiprocket logistics, and pure Vedic astrology sub-engine.',
      evidenceFiles: [
        'backend/src/modules/checkout/checkout.service.ts',
        'backend/src/modules/billing/billing.service.ts',
        'backend/src/modules/order-payments/order-payments.service.ts',
        'backend/src/astrology/core/astronomy-adapter.ts',
        'backend/src/astrology/vedic/kundli-core.ts'
      ],
      technologies: ['Next.js 15', 'Node.js', 'Express', 'TypeScript', 'Prisma ORM', 'PostgreSQL', 'Razorpay', 'Shiprocket', 'PDFKit'],
      flows: [
        'Pricing: Dynamic carat/ratti pricing matrices for precious stones, metals, and custom jewellery.',
        'Checkout: Items checked for availability; inventory is reserved ONLY when payment succeeds in checkout.repository.markPaid (preventing abandoned checkout locks).',
        'Payment: Razorpay order creation, client checkout sheet, signature verification, retryable order states on decline.',
        'Tax & Logistics: State-aware GST calculation (CGST/SGST vs IGST), automated PDF invoice rendering, and Shiprocket pickup scheduling.'
      ]
    }
  },
  {
    projectId: 'chhota_vyapar',
    resumeSection: 'ADDITIONAL PROJECTS',
    claim: 'Route-to-market and distribution consultancy platform for physical brands entering Indian retail and international brands',
    verifiedImplementation: {
      summary: 'Route-to-market and distribution consultancy platform for physical product brands expanding into Indian retail channels (General Trade, Modern Trade, D2C, HORECA) and international market entry. Single-page Next.js 16 marketing site with React 19, Tailwind CSS v4, GSAP, Motion, and Lenis smooth scrolling.',
      evidenceFiles: [
        'app/page.tsx',
        'lib/content.ts',
        'HANDOFF.md',
        'package.json'
      ],
      technologies: ['Next.js 16', 'React 19', 'Tailwind CSS v4', 'GSAP', 'Motion', 'Lenis', 'Leaflet', 'Playwright'],
      flows: [
        'Positioned as a distribution and route-to-market consultancy getting physical products into General Trade, Modern Trade, D2C, and HORECA.',
        'Showcases real international brand market-entry case studies (Minky UK, MAWA Germany) with zero fabricated review metrics.'
      ]
    }
  },
  {
    projectId: 'manisha_wires',
    resumeSection: 'ADDITIONAL PROJECTS',
    claim: 'Manisha Wires Pvt. Ltd. (MWPL) — Steel wire stockist & institutional distribution platform',
    verifiedImplementation: {
      summary: 'Institutional corporate website for Manisha Wires Pvt. Ltd. (MWPL), a verified stockist and distributor of industrial and spring steel wire (Usha Martin, Aarti, KEI, Pengg Usha, DSR) across Mumbai/Bhiwandi/Vasai. Features 3D Cobe WebGL globe, Leaflet supply network map, and Google Sheets RFQ pipeline.',
      evidenceFiles: [
        'app/page.tsx',
        'docs/PROJECT-BRIEF.md',
        'docs/COPY-DECK.md',
        'app/api/enquiry/route.ts'
      ],
      technologies: ['Next.js 16', 'React 19', 'Tailwind CSS v4', 'Motion', 'Cobe WebGL', 'Leaflet', 'Google Sheets API'],
      flows: [
        'Verified purpose: MWPL is a major stockist & distributor (NOT a manufacturing mill, NOT electrical cables) of industrial steel & spring wire across Mumbai/Bhiwandi/Vasai.',
        'Institutional presentation with Concept E dark navy theme (#090D13), glass pill nav, and interactive technical wire specifications.',
        'RFQ quotation request pipeline posting to Google Sheets backend.'
      ]
    }
  },
  {
    projectId: 'campus_connect',
    resumeSection: 'PROJECTS',
    claim: 'University management SaaS with 26-table normalized PostgreSQL schema, triggers, stored procedures, and RBAC',
    verifiedImplementation: {
      summary: 'Full-stack platform with Express, React, PostgreSQL 3NF schema, 4 triggers, 5 stored procedures, and 4 materialized views.',
      evidenceFiles: [
        'database/schema.sql',
        'database/triggers.sql',
        'database/views.sql',
        'backend/src/middleware/auth.ts',
        'DATABASE.md'
      ],
      technologies: ['React', 'TypeScript', 'Node.js', 'Express', 'PostgreSQL', 'Prisma ORM', 'JWT RBAC', 'Docker Compose'],
      flows: [
        'RBAC: JWT token verified by authenticateToken; requireRole checks ADMIN, FACULTY, STUDENT, RECRUITER; requireSelfOrAdmin enforces record isolation.',
        'Database Optimization: trg_attendance_change automatically recalculates enrollment attendance rates; trg_application_status_history logs immutable placement changes; ApplyForInternship stored procedure checks student CGPA eligibility.',
        'Analytics: Analytical views (vw_student_performance) precompute aggregations to eliminate slow frontend table joins.'
      ]
    }
  },
  {
    projectId: 'jumpstart_inventory',
    resumeSection: 'RELEVANT REPOSITORIES',
    claim: 'Jumpstart Inventory Intelligence OS — Preschool classroom asset & inventory operating system',
    verifiedImplementation: {
      summary: 'Next.js 15 (Turbopack) application with React 19, Tailwind CSS v4, Recharts, and Zod schemas implementing Q01-Q58 traceability requirements.',
      evidenceFiles: [
        'package.json',
        'docs/requirements-traceability-matrix.md',
        'src/domain/',
        'src/features/'
      ],
      technologies: ['Next.js 15 (Turbopack)', 'React 19', 'TypeScript', 'Tailwind CSS v4', 'Recharts', 'Zod', 'Vitest'],
      flows: [
        'Distinct from Jumpstart Go: Dedicated to internal school equipment, consumable supplies, classroom asset lifecycle, and replenishment requisitions.',
        'Domain-driven architecture (src/domain, src/features) with strict Zod validation.'
      ]
    }
  },
  {
    projectId: 'astrology_engine',
    resumeSection: 'SPECIALIZED ENGINES',
    claim: 'High-precision Kundli and Vedic calculation engine',
    verifiedImplementation: {
      summary: 'Pure mathematical library in Gemslord backend converting astronomical planetary coordinates into Vedic charts, vargas, and dashas.',
      evidenceFiles: [
        'docs/astrology/ARCHITECTURE.md',
        'backend/src/astrology/core/astronomy-adapter.ts',
        'backend/src/astrology/core/ayanamsa.ts',
        'backend/src/astrology/vedic/kundli-core.ts',
        'backend/src/astrology/dasha/vimshottari.ts'
      ],
      technologies: ['TypeScript', 'Node.js', 'Astronomy Engine', 'Swiss Ephemeris', 'PDFKit'],
      flows: [
        'Pure functional pipeline: Zero network, zero database calls in calculation core.',
        'Adapter converts civil birth time/lat/lon into Julian Date and calculates sidereal positions using Lahiri ayanamsa.',
        'Computes D1, D9 Navamsha, Bhav Chalit (Sripati/Placidus), KP sublords, Ashtakavarga matrices, and Vimshottari dasha hierarchy.'
      ]
    }
  }
];

class ResumeMapper {
  getMappings() {
    return RESUME_PROJECT_MAPPINGS;
  }

  getMappingForProject(projectId) {
    return RESUME_PROJECT_MAPPINGS.find((m) => m.projectId === projectId) || null;
  }

  findMatchingClaims(query) {
    const q = String(query || '').toLowerCase();
    const matches = [];

    for (const mapping of RESUME_PROJECT_MAPPINGS) {
      const projMatch = mapping.projectId.replace(/_/g, ' ');
      if (q.includes(mapping.projectId) || q.includes(projMatch)) {
        matches.push(mapping);
        continue;
      }
      for (const tech of mapping.verifiedImplementation.technologies) {
        if (q.includes(tech.toLowerCase())) {
          matches.push(mapping);
          break;
        }
      }
    }

    return matches;
  }
}

module.exports = {
  RESUME_PROJECT_MAPPINGS,
  ResumeMapper,
  resumeMapper: new ResumeMapper()
};
