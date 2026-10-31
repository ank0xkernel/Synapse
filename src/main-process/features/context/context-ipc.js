'use strict';

/**
 * The desktop Context workspace: the resume, job description and role the
 * AI uses, stored locally in interview-context.json. Private data stays in
 * the main process and this window; nothing here is broadcast to the phone
 * companion.
 */

const interviewContext = require('../../../services/context/interview-context');
const { extractResumeText } = require('../../../services/context/resume-import');

const EDITABLE = new Set(['role', 'company', 'interviewType', 'seniority', 'jobDescription', 'background', 'extraNotes', 'focusAreas']);

const asText = (item) => (typeof item === 'string' ? item : item?.text || '');

function summarizeEntries(entries = []) {
  return entries.map((entry) => ({
    name: entry.name || null,
    dates: entry.dates || null,
    bullets: (entry.bullets || []).slice(0, 12),
    technologies: entry.technologies || []
  }));
}

/** What the renderer needs to show the workspace, derived only from saved data. */
function snapshot() {
  const context = interviewContext.load();
  const candidate = context.structuredProfile?.candidate || null;
  const jd = context.structuredProfile?.jd || null;
  const match = context.structuredProfile?.match || null;
  return {
    role: context.role,
    company: context.company,
    interviewType: context.interviewType,
    seniority: context.seniority,
    jobDescription: context.jobDescription,
    background: context.background,
    extraNotes: context.extraNotes,
    focusAreas: context.focusAreas,
    resumeFileName: context.resumeFileName || '',
    resumeImportedAt: context.resumeImportedAt || '',
    resumeSource: context.resumeSource || (context.background ? 'unknown' : ''),
    updatedAt: context.updatedAt,
    limits: { background: interviewContext.FIELDS.background.max, jobDescription: interviewContext.FIELDS.jobDescription.max },
    profile: candidate ? {
      education: summarizeEntries(candidate.education),
      experience: summarizeEntries(candidate.experience),
      projects: summarizeEntries(candidate.projects),
      skills: (candidate.skills || []).map((item) => item.text),
      achievements: (candidate.achievements || []).map((item) => item.text),
      certifications: (candidate.certifications || []).map((item) => item.text),
      technologies: candidate.technologies || []
    } : null,
    jd: jd ? {
      technologies: jd.technologies || [],
      required: (jd.requiredSkills || []).map(asText),
      preferred: (jd.preferredSkills || []).map(asText),
      responsibilities: (jd.responsibilities || []).map(asText)
    } : null,
    match: match ? { matched: match.matched || [], candidateOnly: match.candidateOnly || [], jdOnly: match.jdOnly || [] } : null
  };
}

const WEB_INTERVIEW_TYPES = { technical: 'coding', behavioral: 'behavioural', 'system-design': 'system-design', general: 'general', hr: 'general' };

/**
 * Lines the user corrected on the website, re-stated under section headings
 * so the same local extraction picks them up (it reads the resume text).
 */
function userCorrectionsText(profile) {
  if (!profile) return '';
  const blocks = [];
  const edited = (items) => (items || []).filter((item) => item.source === 'user');
  const entries = (heading, items) => {
    const list = edited(items);
    if (!list.length) return;
    blocks.push(heading, ...list.flatMap((item) => [
      [item.name, item.dates].filter(Boolean).join('  '),
      ...(item.bullets || []),
      item.technologies?.length ? `Technologies: ${item.technologies.join(', ')}` : ''
    ].filter(Boolean)));
  };
  entries('EXPERIENCE', profile.experience);
  entries('PROJECTS', profile.projects);
  const simple = (heading, items) => {
    const list = edited(items).map((item) => item.text).filter(Boolean);
    if (list.length) blocks.push(heading, ...list);
  };
  simple('EDUCATION', profile.education);
  simple('SKILLS', profile.skills);
  simple('CERTIFICATIONS', profile.certifications);
  simple('ACHIEVEMENTS', profile.achievements);
  return blocks.length ? `\n\nCORRECTIONS FROM SYNAPSE WEB\n${blocks.join('\n')}` : '';
}

/** Writes a confirmed website context bundle (contract v1) into the local context the AI reads. */
function applyWebBundle(bundle) {
  const current = interviewContext.load();
  const notes = [bundle.profile?.custom_context?.text, bundle.session?.notes].filter(Boolean).join('\n\n');
  interviewContext.save({
    ...current,
    background: `${bundle.resume?.text || ''}${userCorrectionsText(bundle.profile)}`.trim(),
    jobDescription: bundle.job_description?.text || '',
    role: bundle.settings?.role || bundle.job_description?.role || '',
    company: bundle.settings?.company || bundle.job_description?.company || '',
    interviewType: WEB_INTERVIEW_TYPES[bundle.session?.interview_type] || 'auto',
    extraNotes: notes,
    resumeFileName: bundle.resume?.name || '',
    resumeImportedAt: bundle.resume?.updated_at || new Date().toISOString(),
    resumeSource: bundle.resume ? 'web' : ''
  });
}

/** After unlinking: remove context that came from the website account. Local imports stay. */
function clearWebContext() {
  const current = interviewContext.load();
  if (current.resumeSource !== 'web') return;
  interviewContext.save({ ...current, background: '', jobDescription: '', role: '', company: '', extraNotes: '', resumeFileName: '', resumeImportedAt: '', resumeSource: '' });
}

function registerContextIpc({ ipcMain, dialog, getMainWindow }) {
  ipcMain.handle('context:get', () => snapshot());

  ipcMain.handle('context:update', (_event, patch = {}) => {
    if (!patch || typeof patch !== 'object') return { success: false, error: 'Nothing to save.' };
    const current = interviewContext.load();
    const next = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (EDITABLE.has(key) && typeof value === 'string') next[key] = value;
    }
    if (typeof patch.background === 'string' && patch.background !== current.background) {
      next.resumeSource = patch.background.trim() ? 'edited' : '';
      if (!patch.background.trim()) {
        next.resumeFileName = '';
        next.resumeImportedAt = '';
      }
    }
    interviewContext.save(next);
    return { success: true, context: snapshot() };
  });

  ipcMain.handle('context:import-resume', async () => {
    const owner = getMainWindow();
    const choice = await dialog.showOpenDialog(owner && !owner.isDestroyed() ? owner : undefined, {
      title: 'Choose your resume',
      properties: ['openFile'],
      filters: [{ name: 'Resume', extensions: ['pdf', 'txt', 'md'] }]
    });
    if (choice.canceled || !choice.filePaths?.[0]) return { success: false, cancelled: true };

    try {
      const { text, fileName } = await extractResumeText(choice.filePaths[0]);
      const limit = interviewContext.FIELDS.background.max;
      interviewContext.save({
        ...interviewContext.load(),
        background: text,
        resumeFileName: fileName,
        resumeImportedAt: new Date().toISOString(),
        resumeSource: 'file'
      });
      return { success: true, truncated: text.length > limit, chars: text.length, limit, context: snapshot() };
    } catch (error) {
      return { success: false, code: error.code || 'IMPORT_FAILED', error: error.message };
    }
  });

  ipcMain.handle('context:remove-resume', () => {
    interviewContext.save({ ...interviewContext.load(), background: '', resumeFileName: '', resumeImportedAt: '', resumeSource: '' });
    return { success: true, context: snapshot() };
  });
}

module.exports = { registerContextIpc, snapshot, applyWebBundle, clearWebContext, userCorrectionsText };
