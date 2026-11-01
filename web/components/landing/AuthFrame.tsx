import Link from 'next/link';
import BrandMark from '@/components/BrandMark';
import Icon, { type IconName } from '@/components/Icon';
import ThemeSwitch from '@/components/ThemeSwitch';
import s from './auth.module.css';

const HOLDS: [IconName, string, string][] = [
  ['resume', 'Resumes', 'PDF, Word or scanned, with the text you corrected and the one marked active.'],
  ['profile', 'Candidate profile', 'Every technology labelled as used at work, in a project, or only listed.'],
  ['job', 'Job descriptions', 'Kept apart from your background, with the answer style you chose.'],
  ['session', 'Sessions and preparation', 'Notes, the skill-gap comparison and AI suggestions, labelled as such.'],
  ['desktop', 'Desktop link', 'The Macs you approved, which you can unlink from Settings.']
];
const NEXT: [string, string][] = [
  ['Add a resume', 'Synapse reads it into a candidate profile you review and correct.'],
  ['Save the job and a session', 'Paste the posting, pick a response mode, mark the session the desktop loads.'],
  ['Link Synapse Desktop', 'Approve it once in this browser. It takes your context before the call.']
];

/** Shared composition for sign in and sign up: a calm form field, a fringe seam, and what the account holds. */
export default function AuthFrame({ mode, title, intro, linking, children }: {
  mode: 'login' | 'signup';
  title: string;
  intro: string;
  linking: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={s.frame} data-mode={mode}>
      <main className={s.formSide} id="main">
        <div className={s.top}>
          <Link href="/" className="brand"><BrandMark />Synapse</Link>
          <ThemeSwitch />
        </div>
        <div className={s.formBody}>
          <h1 className={s.title}>{title}</h1>
          <p className={s.intro}>{intro}</p>
          {linking && (
            <p className={`notice ${s.linking}`}><Icon name="link" size={16} />Synapse Desktop asked to link to your account. After this, you will be asked to approve it.</p>
          )}
          {children}
        </div>
        <p className={s.privacy}><Icon name="lock" size={14} />Private to your account. Delete it and everything in it from Settings.</p>
      </main>

      <aside className={s.side} aria-labelledby="side-h">
        <hr className={`fringe-line ${s.seam}`} aria-hidden="true" />
        {mode === 'login' ? (
          <div className={s.panel}>
            <h2 id="side-h" className={s.sideH}>Where you left it</h2>
            <ul className={s.holds}>
              {HOLDS.map(([icon, t, d]) => (
                <li key={t}>
                  <span className={s.holdIcon}><Icon name={icon} size={18} /></span>
                  <span><b>{t}</b><span>{d}</span></span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className={s.panel}>
            <h2 id="side-h" className={s.sideH}>After you sign up</h2>
            <ol className={s.next}>
              {NEXT.map(([t, d]) => (
                <li key={t}><b>{t}</b><span>{d}</span></li>
              ))}
            </ol>
            <p className={s.sideNote}>During the call the desktop app answers from its own copy, so nothing on this site slows it down.</p>
          </div>
        )}
      </aside>
    </div>
  );
}
