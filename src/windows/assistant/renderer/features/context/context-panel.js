/**
 * Resume & context workspace. Shows exactly what is saved locally (via the
 * context:* IPC in src/main-process/features/context/context-ipc.js) and
 * what the AI will receive. Every value is written with textContent: resume
 * and JD text are user data and never become markup.
 */

import { initWebAccount } from './web-account.js';

const api = () => window.electronAPI || {};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Readiness from saved data only. Ready means the AI has a resume to ground answers in. */
export function deriveReadiness(context) {
  if (!context) return { ready: false, title: 'Context unavailable', items: [] };
  const hasResume = Boolean(context.background?.trim());
  const profile = context.profile || {};
  const entries = (profile.experience?.length || 0) + (profile.projects?.length || 0);
  // Saved text is clamped to the limit and then trimmed, so a cut resume
  // lands a few characters under it, not exactly on it.
  const nearLimit = hasResume && context.background.length >= (context.limits?.background || Infinity) - 50;
  const items = [
    hasResume
      ? { tone: nearLimit ? 'warn' : 'ok', text: nearLimit
        ? `Resume loaded, but cut at ${context.limits.background.toLocaleString()} characters; later sections may be missing`
        : `Resume loaded (${context.background.length.toLocaleString()} characters)` }
      : { tone: 'error', text: 'No resume yet. Import a PDF or paste your resume text.' },
    hasResume
      ? (entries > 0
        ? { tone: 'ok', text: `${entries} experience or project ${entries === 1 ? 'entry' : 'entries'} recognized` }
        : { tone: 'warn', text: context.resumeSource === 'file' || context.resumeSource === 'web'
          ? 'No experience or projects recognized. Check that the resume uses clear section headings (for example "Experience", "Projects").'
          : 'No experience or projects recognized. This resume was saved by an older version that dropped its section headings; import the PDF again to fix it.' })
      : null,
    hasResume && context.profileSource === 'web'
      ? { tone: 'ok', text: 'Agent uses the profile you reviewed on Synapse web, including your corrections' }
      : null,
    context.role || context.company
      ? { tone: 'ok', text: `Target: ${[context.role, context.company].filter(Boolean).join(' at ')}` }
      : { tone: 'idle', text: 'Optional: add the role and company so answers fit them' },
    context.jobDescription?.trim()
      ? { tone: 'ok', text: 'Job description loaded' }
      : { tone: 'idle', text: 'Optional: paste the job description to match your skills against it' }
  ].filter(Boolean);
  return {
    ready: hasResume,
    title: hasResume ? 'Ready for the interview' : 'Not ready: add your resume',
    items
  };
}

export function initContextPanel({ showFeedback = () => {}, openSheet, closeSheet } = {}) {
  const panel = document.getElementById('context-panel');
  if (!panel) return null;
  const $ = (id) => document.getElementById(id);
  const fields = {
    role: $('ctx-role'),
    company: $('ctx-company'),
    interviewType: $('ctx-type'),
    background: $('ctx-background'),
    jobDescription: $('ctx-jd')
  };
  let saved = null;

  function dirtyPatch() {
    if (!saved) return {};
    const patch = {};
    for (const [key, input] of Object.entries(fields)) {
      if (input && input.value !== (saved[key] || '')) patch[key] = input.value;
    }
    return patch;
  }

  function updateSaveState() {
    const dirty = Object.keys(dirtyPatch()).length > 0;
    $('ctx-save').disabled = !dirty;
    $('ctx-save-state').textContent = dirty ? 'Unsaved changes' : (saved?.updatedAt ? `Saved ${new Date(saved.updatedAt).toLocaleString()}` : '');
    const limit = saved?.limits?.background || 200000;
    $('ctx-background-count').textContent = `${fields.background.value.length.toLocaleString()} / ${limit.toLocaleString()} characters`;
    $('ctx-jd-count').textContent = `${fields.jobDescription.value.length.toLocaleString()} / ${(saved?.limits?.jobDescription || 50000).toLocaleString()} characters`;
  }

  function renderReadiness(context) {
    const readiness = deriveReadiness(context);
    const box = $('ctx-readiness');
    box.dataset.ready = String(readiness.ready);
    $('ctx-readiness-title').textContent = readiness.title;
    const list = $('ctx-readiness-list');
    list.replaceChildren(...readiness.items.map((item) => {
      const li = el('li', 'readiness-item');
      li.dataset.tone = item.tone;
      li.append(el('span', 'check-dot'), el('span', '', item.text));
      return li;
    }));
  }

  function renderMeta(context) {
    const meta = $('ctx-resume-meta');
    meta.replaceChildren();
    if (!context.background?.trim()) {
      meta.append(el('span', 'doc-empty', 'No resume loaded'));
      $('ctx-remove').hidden = true;
      return;
    }
    $('ctx-remove').hidden = false;
    const sourceLabel = { file: 'Imported from a file', edited: 'Edited here', companion: 'Added from the phone companion', web: 'Synced from Synapse web' }[context.resumeSource] || 'Saved before sources were recorded';
    meta.append(
      el('span', 'doc-name', context.resumeFileName || `${context.background.length.toLocaleString()} characters of resume text`),
      el('span', 'doc-detail', [sourceLabel, context.resumeImportedAt ? new Date(context.resumeImportedAt).toLocaleDateString() : null].filter(Boolean).join(' · '))
    );
  }

  function renderEntries(title, entries) {
    const group = el('div', 'profile-group');
    group.append(el('h4', 'profile-group-title', `${title} · ${entries.length}`));
    if (!entries.length) {
      group.append(el('p', 'profile-empty', 'Not found in your resume'));
      return group;
    }
    for (const entry of entries) {
      const card = el('div', 'profile-entry');
      const head = el('div', 'profile-entry-head');
      head.append(el('span', 'profile-entry-name', entry.name || 'Untitled entry'));
      if (entry.dates) head.append(el('span', 'profile-entry-dates', entry.dates));
      card.append(head);
      const bullets = entry.bullets.filter((bullet) => bullet !== entry.name).slice(0, 3);
      if (bullets.length) {
        const ul = el('ul', 'profile-bullets');
        bullets.forEach((bullet) => ul.append(el('li', '', bullet)));
        card.append(ul);
      }
      if (entry.technologies.length) card.append(chips(entry.technologies));
      group.append(card);
    }
    return group;
  }

  function chips(items, tone) {
    const wrap = el('div', 'chips');
    items.forEach((item) => {
      const chip = el('span', 'chip', item);
      if (tone) chip.dataset.tone = tone;
      wrap.append(chip);
    });
    return wrap;
  }

  function renderList(title, items) {
    const group = el('div', 'profile-group');
    group.append(el('h4', 'profile-group-title', `${title} · ${items.length}`));
    if (!items.length) group.append(el('p', 'profile-empty', 'Not found in your resume'));
    else group.append(chips(items));
    return group;
  }

  function renderProfile(context) {
    const root = $('ctx-profile');
    const profile = context.profile;
    if (!context.background?.trim() || !profile) {
      root.replaceChildren(el('p', 'profile-empty', 'Import or paste a resume to see what Synapse extracts.'));
      return;
    }
    root.replaceChildren(
      renderEntries('Experience', profile.experience),
      renderEntries('Projects', profile.projects),
      renderEntries('Education', profile.education),
      renderList('Skills and technologies', profile.technologies.length ? profile.technologies : profile.skills),
      renderList('Certifications', profile.certifications),
      renderList('Achievements', profile.achievements)
    );
  }

  function renderMatch(context) {
    const root = $('ctx-match');
    root.replaceChildren();
    if (!context.jobDescription?.trim() || !context.match) return;
    const groups = [
      ['In both your resume and the job description', context.match.matched, 'ok'],
      ['Asked for in the job description, not found in your resume', context.match.jdOnly, 'warn']
    ];
    for (const [title, items, tone] of groups) {
      const group = el('div', 'profile-group');
      group.append(el('h4', 'profile-group-title', `${title} · ${items.length}`));
      group.append(items.length ? chips(items, tone) : el('p', 'profile-empty', 'None'));
      root.append(group);
    }
  }

  function renderAiFacts(context) {
    const facts = [];
    if (context.role || context.company) facts.push(`Target role: ${[context.role, context.company].filter(Boolean).join(' at ')}`);
    if (context.background?.trim()) {
      facts.push('For each question, only the resume lines relevant to it (matching projects, experience and skills), not the whole resume');
      facts.push('Technologies are labeled as used at work, in projects, or only mentioned, so answers never claim more than the resume shows');
    } else {
      facts.push('No resume: answers explain concepts and frame hypotheticals, and never claim personal experience');
    }
    if (context.jobDescription?.trim()) facts.push('The job description\'s required and preferred skills, to keep answers relevant to the role');
    facts.push('The recent conversation, so follow-ups stay on topic');
    $('ctx-ai-facts').replaceChildren(...facts.map((fact) => el('li', '', fact)));
  }

  function render(context) {
    saved = context;
    if (!context) {
      $('ctx-readiness-title').textContent = 'Could not load your saved context';
      return;
    }
    fields.role.value = context.role || '';
    fields.company.value = context.company || '';
    fields.interviewType.value = context.interviewType || 'auto';
    fields.background.value = context.background || '';
    fields.jobDescription.value = context.jobDescription || '';
    renderReadiness(context);
    renderMeta(context);
    renderProfile(context);
    renderMatch(context);
    renderAiFacts(context);
    updateSaveState();
  }

  function showAlert(text, tone = 'error') {
    const alert = $('ctx-resume-alert');
    alert.textContent = text;
    alert.dataset.tone = tone;
    alert.hidden = !text;
  }

  async function refresh() {
    panel.setAttribute('aria-busy', 'true');
    render(await api().getContext?.());
    panel.removeAttribute('aria-busy');
  }

  Object.values(fields).forEach((input) => input?.addEventListener('input', updateSaveState));

  $('ctx-save').addEventListener('click', async () => {
    const patch = dirtyPatch();
    if (!Object.keys(patch).length) return;
    const button = $('ctx-save');
    button.disabled = true;
    $('ctx-save-state').textContent = 'Saving…';
    const result = await api().updateContext?.(patch);
    if (result?.success) {
      render(result.context);
      showFeedback('Context saved', 'success');
    } else {
      $('ctx-save-state').textContent = `Not saved: ${result?.error || 'unknown error'}`;
      button.disabled = false;
    }
  });

  $('ctx-import').addEventListener('click', async () => {
    const button = $('ctx-import');
    button.disabled = true;
    button.textContent = 'Reading…';
    showAlert('');
    const result = await api().importResume?.();
    button.disabled = false;
    button.textContent = 'Import PDF…';
    if (result?.cancelled) return;
    if (!result?.success) {
      showAlert(result?.error || 'The resume could not be imported.');
      return;
    }
    render(result.context);
    if (result.truncated) {
      showAlert(`Imported. The resume has ${result.chars.toLocaleString()} characters; only the first ${result.limit.toLocaleString()} are kept, so check the later sections.`, 'warn');
    } else {
      showFeedback('Resume imported', 'success');
    }
  });

  $('ctx-remove').addEventListener('click', async () => {
    const result = await api().removeResume?.();
    if (result?.success) {
      render(result.context);
      showFeedback('Resume removed', 'info');
    }
  });

  const webAccount = initWebAccount({
    showFeedback,
    onApplied: (state) => {
      refresh();
      // The website session's answer style, applied as a starting point the
      // user can still change in the title bar.
      const mode = state?.applied?.responseMode;
      const select = document.getElementById('response-mode-select');
      if (mode && select && [...select.options].some((option) => option.value === mode)) {
        select.value = mode;
        select.dispatchEvent(new Event('change'));
      }
    }
  });

  document.getElementById('context-btn')?.addEventListener('click', () => {
    if (panel.classList.contains('hidden')) {
      openSheet(panel);
      refresh();
      webAccount?.refresh();
    } else {
      closeSheet(panel);
    }
  });
  $('close-context').addEventListener('click', () => closeSheet(panel));

  return { refresh, open: () => { openSheet(panel); refresh(); webAccount?.refresh(); } };
}
