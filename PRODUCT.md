# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Software engineers job-hunting on a Mac, interviewing for engineering roles: coding, system design and behavioural rounds. They use the website before an interview to keep their material in order, and the Synapse desktop app during the live call.

## Product Purpose

Synapse is a macOS desktop interview assistant with a companion website. The desktop app listens to the call, transcribes the interviewer as they speak, and streams a short, speakable answer grounded in the candidate's own resume and the job description. The website is where the candidate keeps that material: resumes, a candidate profile they can correct, job descriptions, preparation, sessions, and the link to the desktop app. Success: the answer the candidate sees mid-interview is accurate to their real background and usable aloud.

## Positioning

Answers are grounded in the candidate's own reviewed resume, never invented: each technology is labelled as used at work, in a project, or only listed, and the job description is kept separate from what the candidate has done. Described plainly as a live interview assistant.

## Operating Context

- Website (Next.js 16, Postgres, Vercel): accounts, resume library (PDF, Word, scans via OCR), candidate profile editor, job descriptions, AI prep, sessions, desktop linking.
- Desktop app (Electron, macOS): native system audio, AssemblyAI live transcription, Gemini streamed answers, five response modes (Quick, Professional, Technical, STAR, Detailed), optional phone companion on the local network.
- The desktop fetches the website context before a session and works offline from its cache; live answers never wait on the website.

## Capabilities and Constraints

- Website and desktop share terminology: resume, candidate profile, job description, session, response mode, desktop link.
- AI-generated preparation content is always labelled as a suggestion and never mixed with resume facts.
- Animation is CSS only (no animation library), per the owner.
- The website supports dark and light themes.

## Brand Commitments

- Name: Synapse. Brand artwork supplied by the owner in `assets/brand/`: the app tile (`synapse-icon-source.png`, a glowing violet-to-cyan "S" of connected nodes on a dark rounded tile) and the wordmark (`synapse-logo.png`, on a dark ground). The tile is the favicon, the website and desktop brand mark, and the app icon; the wordmark is the social preview image.

## Evidence on Hand

- Real product UI: desktop and web screenshots in `docs/screenshots/`.
- No testimonials, user counts, customer logos or metrics exist. Never fabricate them; the real product is the proof.

## Product Principles

1. Truth over polish: never show a state, claim or number the system did not produce.
2. The candidate's real background is the source of every answer.
3. Live use comes first: nothing on the website may slow the desktop during an interview.
4. Private by default: every resume and note belongs to one account only.
