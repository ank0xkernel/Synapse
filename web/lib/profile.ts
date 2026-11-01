import 'server-only';
import { z } from 'zod';
// Deterministic desktop modules, copied into lib/intelligence. No LLM involved.
import { buildCandidateProfile, extractTechnologies } from './intelligence/candidate-profile.js';

export type Source = 'extracted' | 'user';

const src = z.enum(['extracted', 'user']).default('user');
const text = (max: number) => z.string().trim().max(max);

// Limits are generous on purpose: extracted resume content must never be cut to fit.
const textItem = z.object({ text: text(20000).min(1), source: src });
const eduItem = z.object({ text: text(20000).min(1), grade: text(60).default(''), source: src });
const entry = z.object({
  name: text(300).default(''),
  dates: text(100).default(''),
  bullets: z.array(text(20000).min(1)).max(1000).default([]),
  technologies: z.array(text(60).min(1)).max(200).default([]),
  source: src
});

const headedItem = z.object({ heading: text(120).default(''), text: text(20000).min(1), source: src });

// summary, contact and additional default to [] so profiles stored before they existed stay valid.
export const profileSchema = z.object({
  summary: z.array(textItem).max(200).default([]),
  contact: z.array(textItem).max(50).default([]),
  additional: z.array(headedItem).max(1000).default([]),
  education: z.array(eduItem).max(300),
  experience: z.array(entry).max(300),
  projects: z.array(entry).max(300),
  skills: z.array(textItem).max(1000),
  achievements: z.array(textItem).max(500),
  certifications: z.array(textItem).max(500),
  custom_context: z.object({ text: text(8000).default(''), source: src })
});
export type Profile = z.infer<typeof profileSchema>;

export const emptyProfile = (): Profile => ({
  summary: [],
  contact: [],
  additional: [],
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
  heading?: string;
}

/** Profile derived only from what the resume text says. Empty sections stay empty. */
export function extractProfile(resumeText: string): Profile {
  const raw = buildCandidateProfile(resumeText) as unknown as {
    summary: RawItem[];
    contact: RawItem[];
    additional: RawItem[];
    education: RawItem[];
    experience: RawEntry[];
    projects: RawEntry[];
    skills: RawItem[];
    achievements: RawItem[];
    certifications: RawItem[];
  };
  const items = (list: RawItem[]) => list.map((i) => ({ text: i.text, source: 'extracted' as const }));
  const entries = (list: RawEntry[]) =>
    list.map((e) => ({
      name: e.name ?? '',
      dates: e.dates ?? '',
      bullets: e.bullets.map((b) => b),
      technologies: e.technologies,
      source: 'extracted' as const
    }));
  return {
    summary: items(raw.summary),
    contact: items(raw.contact),
    additional: raw.additional.map((i) => ({ heading: i.heading ?? '', text: i.text, source: 'extracted' as const })),
    education: raw.education.map((e) => ({ text: e.text, grade: e.grade ?? '', source: 'extracted' as const })),
    experience: entries(raw.experience),
    projects: entries(raw.projects),
    skills: items(raw.skills),
    achievements: items(raw.achievements),
    certifications: items(raw.certifications),
    custom_context: { text: '', source: 'user' }
  };
}

/**
 * Rebuilds a profile from freshly extracted data while keeping everything the user wrote.
 * Old items marked source 'user' stay (first, in their order); old 'extracted' items are replaced
 * by the new extraction; a new item identical to a kept user item is not added twice.
 */
export function mergeReprocessed(old: Profile, fresh: Profile): Profile {
  const merge = <T extends { source: Source }>(before: T[], after: T[]): T[] => {
    const mine = before.filter((i) => i.source === 'user');
    const seen = new Set(mine.map((i) => strip(i)));
    return [...mine, ...after.filter((i) => !seen.has(strip(i)))];
  };
  return {
    summary: merge(old.summary, fresh.summary),
    contact: merge(old.contact, fresh.contact),
    additional: merge(old.additional, fresh.additional),
    education: merge(old.education, fresh.education),
    experience: merge(old.experience, fresh.experience),
    projects: merge(old.projects, fresh.projects),
    skills: merge(old.skills, fresh.skills),
    achievements: merge(old.achievements, fresh.achievements),
    certifications: merge(old.certifications, fresh.certifications),
    custom_context: old.custom_context
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
    summary: mark(incoming.summary, previous.summary),
    contact: mark(incoming.contact, previous.contact),
    additional: mark(incoming.additional, previous.additional),
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
    ...p.summary.map((s) => s.text),
    ...p.education.map((e) => e.text),
    ...[...p.experience, ...p.projects].flatMap((e) => [e.name, ...e.bullets]),
    ...p.skills.map((s) => s.text),
    ...p.achievements.map((s) => s.text),
    ...p.certifications.map((s) => s.text),
    ...p.additional.map((s) => s.text),
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
