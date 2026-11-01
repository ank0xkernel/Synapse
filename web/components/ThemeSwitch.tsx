'use client';
import { useEffect, useState } from 'react';

type Choice = 'system' | 'light' | 'dark';
const KEY = 'synapse-theme';

const ICONS: Record<Choice, React.ReactNode> = {
  system: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.5" /><path d="M6 13.5h4" strokeLinecap="round" /></svg>,
  light: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="2.75" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" /></svg>,
  dark: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6Z" /></svg>
};
const LABELS: Record<Choice, string> = { system: 'Match system theme', light: 'Light theme', dark: 'Dark theme' };

/** System, light or dark. The choice is applied before paint by the script in app/layout.tsx. */
export default function ThemeSwitch() {
  const [choice, setChoice] = useState<Choice>('system');
  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    if (t === 'light' || t === 'dark') setChoice(t);
  }, []);

  function pick(next: Choice) {
    setChoice(next);
    const root = document.documentElement;
    if (next === 'system') delete root.dataset.theme;
    else root.dataset.theme = next;
    try {
      if (next === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      // Private mode: the choice lasts for this page only.
    }
  }

  return (
    <div className="theme-switch" role="group" aria-label="Theme">
      {(['system', 'light', 'dark'] as const).map((c) => (
        <button key={c} type="button" aria-pressed={choice === c} aria-label={LABELS[c]} title={LABELS[c]} onClick={() => pick(c)}>
          {ICONS[c]}
        </button>
      ))}
    </div>
  );
}
