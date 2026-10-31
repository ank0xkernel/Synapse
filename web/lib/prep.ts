import 'server-only';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';
import { matchCandidateToJd } from './intelligence/jd-profile.js';
import { profileTechnologies, profileText, type Profile } from './profile';
import type { ParsedJd } from './jd';

export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
export const aiConfigured = () => !!process.env.GEMINI_API_KEY;
export const aiModel = () => process.env.GEMINI_MODEL || DEFAULT_MODEL;

export interface Comparison {
  matched: string[];
  gaps: string[];
  resumeOnly: string[];
  topics: string[];
  jdRequirements: string[];
  hasResume: boolean;
  hasJd: boolean;
}

/** Resume vs JD overlap, computed with the vocabulary in intelligence/candidate-profile.js. No AI. */
export function compare(profile: Profile | null, jd: ParsedJd | null): Comparison {
  const techs = profile ? profileTechnologies(profile) : [];
  const m = matchCandidateToJd({ technologies: techs }, { technologies: jd?.technologies ?? [] }) as {
    matched: string[];
    candidateOnly: string[];
    jdOnly: string[];
  };
  return {
    matched: m.matched,
    gaps: m.jdOnly,
    resumeOnly: m.candidateOnly,
    topics: jd?.technologies ?? [],
    jdRequirements: jd?.requiredSkills ?? [],
    hasResume: !!profile,
    hasJd: !!jd
  };
}

const short = z.string().trim().max(600);
export const aiPrepSchema = z.object({
  practiceQuestions: z.array(z.object({ question: short, topic: short, why: short })).max(15),
  behavioral: z.array(z.object({ question: short, why: short })).max(10),
  projectPrep: z.array(z.object({ project: short, explainPoints: z.array(short).max(8), likelyFollowUps: z.array(short).max(6) })).max(8),
  starPractice: z.array(z.object({ prompt: short, basedOn: short, outline: z.object({ situation: short, task: short, action: short, result: short }) })).max(8),
  improvements: z.array(z.object({ area: short, suggestion: short })).max(10)
});
export type AiPrep = z.infer<typeof aiPrepSchema>;

export class AiUnavailable extends Error {}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export async function generateAiPrep(input: {
  profile: Profile;
  jdText: string;
  company: string;
  role: string;
  interviewType: string;
  notes: string;
  comparison: Comparison;
}): Promise<{ content: AiPrep; model: string }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new AiUnavailable('AI preparation needs GEMINI_API_KEY on the server');
  const model = aiModel();
  const projectNames = input.profile.projects.map((p) => p.name).filter(Boolean);

  const prompt = `You prepare a job candidate for an interview. Return JSON only.

HARD RULES
- Use ONLY facts from CANDIDATE RESUME. Never invent employers, titles, dates, metrics, projects, skills or outcomes.
- If the resume lacks a detail (for example a metric or result), write "[add your own detail]" in that slot. Do not guess.
- "projectPrep" and "starPractice.basedOn" must name an item that exists in the resume. If the resume has no projects, return an empty projectPrep array.
- Skill gaps are things in the job description that the resume does not show. Suggest how to prepare for them; never claim the candidate has them.
- Questions are suggestions, not predictions.

Shape: {"practiceQuestions":[{"question","topic","why"}],"behavioral":[{"question","why"}],"projectPrep":[{"project","explainPoints":[],"likelyFollowUps":[]}],"starPractice":[{"prompt","basedOn","outline":{"situation","task","action","result"}}],"improvements":[{"area","suggestion"}]}
Give up to 8 practice questions, 5 behavioral, one projectPrep per resume project (max 4), 3 starPractice, 5 improvements.

TARGET: role "${input.role || 'unspecified'}" at "${input.company || 'unspecified'}", interview type "${input.interviewType}".
CANDIDATE NOTES: ${clip(input.notes, 2000) || '(none)'}
RESUME PROJECT NAMES: ${projectNames.join('; ') || '(none)'}
TECHNOLOGIES MATCHED: ${input.comparison.matched.join(', ') || '(none)'}
TECHNOLOGIES IN JD BUT NOT IN RESUME: ${input.comparison.gaps.join(', ') || '(none)'}

=== CANDIDATE RESUME ===
${clip(profileText(input.profile), 12000)}

=== JOB DESCRIPTION ===
${clip(input.jdText, 8000)}`;

  const genAI = new GoogleGenerativeAI(key);
  const m = genAI.getGenerativeModel({
    model,
    generationConfig: { temperature: 0.4, maxOutputTokens: 6000, responseMimeType: 'application/json' }
  });
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 50_000));
  let raw: string;
  try {
    raw = (await Promise.race([m.generateContent(prompt), timeout])).response.text();
  } catch (e) {
    console.error('[gemini] request failed:', e instanceof Error ? e.message.replace(key, '***') : 'unknown');
    throw new AiUnavailable('The AI provider did not return a result. Try again in a moment.');
  }
  let parsed: AiPrep;
  try {
    parsed = aiPrepSchema.parse(JSON.parse(raw));
  } catch {
    throw new AiUnavailable('The AI response was not in the expected format. Try again.');
  }
  // Guard: drop project prep for projects that are not on the resume.
  const known = projectNames.map((n) => n.toLowerCase());
  const onResume = (n: string) => known.some((k) => k && (k.includes(n.toLowerCase()) || n.toLowerCase().includes(k)));
  parsed.projectPrep = parsed.projectPrep.filter((p) => onResume(p.project));
  return { content: parsed, model };
}
