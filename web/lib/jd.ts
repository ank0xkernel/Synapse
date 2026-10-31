import 'server-only';
import { buildJdProfile } from './intelligence/jd-profile.js';

export interface ParsedJd {
  responsibilities: string[];
  requiredSkills: string[];
  preferredSkills: string[];
  technologies: string[];
}

/** Deterministic section/technology parse of a pasted job description. */
export function parseJd(text: string): ParsedJd {
  const p = buildJdProfile(text) as unknown as {
    responsibilities: { text: string }[];
    requiredSkills: { text: string }[];
    preferredSkills: { text: string }[];
    technologies: string[];
  };
  const t = (l: { text: string }[]) => l.map((x) => x.text);
  return {
    responsibilities: t(p.responsibilities),
    requiredSkills: t(p.requiredSkills),
    preferredSkills: t(p.preferredSkills),
    technologies: p.technologies
  };
}
