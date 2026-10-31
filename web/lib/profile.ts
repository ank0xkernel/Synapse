import 'server-only';
import { z } from 'zod';
// Deterministic desktop modules, copied into lib/intelligence. No LLM involved.
import { buildCandidateProfile, extractTechnologies } from './intelligence/candidate-profile.js';

export type Source = 'extracted' | 'user';

const src = z.enum(['extracted', 'user']).default('user');
const text = (max: number) => z.string().trim().max(max);

const textItem = z.object({ text: text(2000).min(1), source: src });
const eduItem = z.object({ text: text(2000).min(1), grade: text(60).default(''), source: src });
const entry = z.object({
  name: text(300).default(''),
  dates: text(100).default(''),
  bullets: z.array(text(2000).min(1)).max(40).default([]),
  technologies: z.array(text(60).min(1)).max(60).default([]),
  source: src
});

export const profileSchema = z.object({
  education: z.array(eduItem).max(30),
  experience: z.array(entry).max(40),
  projects: z.array(entry).max(40),
  skills: z.array(textItem).max(100),
  achievements: z.array(textItem).max(60),
  certifications: z.array(textItem).max(60),
  custom_context: z.object({ text: text(8000).default(''), source: src })
});
export type Profile = z.infer<typeof profileSchema>;

export const emptyProfile = (): Profile => ({
  education: [],
  experience: [],
  projects: [],
  skills: [],
  achievements: [],
  certifications: [],
  custom_context: { text: '', source: 'user' }
});

interface RawEntry {
  name: string | null;
  dates: string | null;
  bullets: string[];
  technologies: string[];
}
interface RawItem {
  text: string;
  grade?: string | null;
}

/** Profile derived only from what the resume text says. Empty sections stay empty. */
export function extractProfile(resumeText: string): Profile {
  const raw = buildCandidateProfile(resumeText) as unknown as {
    education: RawItem[];
    experience: RawEntry[];
    projects: RawEntry[];
    skills: RawItem[];
    achievements: RawItem[];
    certifications: RawItem[];
  };
  const items = (list: RawItem[]) => list.map((i) => ({ text: i.text.slice(0, 2000), source: 'extracted' as const }));
  const entries = (list: RawEntry[]) =>
    list.map((e) => ({
      name: e.name ?? '',
      dates: e.dates ?? '',
      bullets: e.bullets.map((b) => b.slice(0, 2000)),
      technologies: e.technologies,
      source: 'extracted' as const
    }));
  return {
    education: raw.education.map((e) => ({ text: e.text.slice(0, 2000), grade: e.grade ?? '', source: 'extracted' as const })),
    experience: entries(raw.experience),
    projects: entries(raw.projects),
    skills: items(raw.skills),
    achievements: items(raw.achievements),
    certifications: items(raw.certifications),
    custom_context: { text: '', source: 'user' }
  };
}

const strip = (o: object) => JSON.stringify({ ...o, source: undefined });

/**
 * Provenance is decided on the server: an item identical to one already stored keeps its source;
 * anything new or changed is marked "user".
 */
export function applyProvenance(incoming: Profile, previous: Profile): Profile {
  const mark = <T extends { source: Source }>(list: T[], before: T[]): T[] => {
    const known = new Map(before.map((b) => [strip(b), b.source]));
    return list.map((i) => ({ ...i, source: known.get(strip(i)) ?? 'user' }));
  };
  const cc = incoming.custom_context;
  return {
    education: mark(incoming.education, previous.education),
    experience: mark(incoming.experience, previous.experience),
    projects: mark(incoming.projects, previous.projects),
    skills: mark(incoming.skills, previous.skills),
    achievements: mark(incoming.achievements, previous.achievements),
    certifications: mark(incoming.certifications, previous.certifications),
    custom_context: { text: cc.text, source: 'user' }
  };
}

/** All profile text flattened, for technology matching and prompts. */
export function profileText(p: Profile): string {
  return [
    ...p.education.map((e) => e.text),
    ...[...p.experience, ...p.projects].flatMap((e) => [e.name, ...e.bullets]),
    ...p.skills.map((s) => s.text),
    ...p.achievements.map((s) => s.text),
    ...p.certifications.map((s) => s.text),
    p.custom_context.text
  ].join('\n');
}

export function profileTechnologies(p: Profile): string[] {
  const set = new Set<string>(extractTechnologies(profileText(p)) as string[]);
  for (const e of [...p.experience, ...p.projects]) e.technologies.forEach((t) => set.add(t));
  return [...set];
}

export function parseStoredProfile(data: unknown): Profile {
  const r = profileSchema.safeParse(data);
  return r.success ? r.data : emptyProfile();
}
