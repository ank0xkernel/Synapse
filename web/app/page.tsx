import Link from 'next/link';
import { currentUser } from '@/lib/auth';

const FEATURES = [
  ['Native audio capture', 'The desktop app listens to your system audio and microphone directly. No virtual audio driver to install.'],
  ['Answers grounded in you', 'Answers are built from your resume and the job description you saved, not generic advice. Missing details stay missing.'],
  ['Five response modes', 'Quick, Professional, Technical, STAR and Detailed. Pick a default per job or per interview.']
];
const WEB = [
  ['Resume library', 'Upload several PDF resumes, preview them, fix extracted text and choose the active one.'],
  ['Candidate profile', 'Education, experience, projects, skills, achievements and certifications, each marked as extracted or edited by you.'],
  ['Job descriptions', 'Save postings with company and role, link a resume and set your preferred answer style.'],
  ['Interview preparation', 'A resume-to-job comparison with skill gaps, plus optional AI practice questions that are labelled as suggestions.'],
  ['Sessions', 'Prepare, reopen and edit interview sessions. Choose which one the desktop app loads.'],
  ['Desktop connection', 'Sign in from the desktop app through your browser. It fetches your context once before a session starts.']
];

export default async function Landing() {
  const user = await currentUser();
  return (
    <>
      <header className="pub-nav">
        <span className="brand"><span className="brand-mark" aria-hidden="true" />Synapse</span>
        <nav className="row" aria-label="Account">
          {user ? (
            <Link className="btn btn-primary" href="/dashboard">Open dashboard</Link>
          ) : (
            <>
              <Link className="btn btn-ghost" href="/login">Sign in</Link>
              <Link className="btn btn-primary" href="/signup">Create account</Link>
            </>
          )}
        </nav>
      </header>
      <main className="pub">
        <section className="hero">
          <h1>Prepare once. Walk into the interview with your context ready.</h1>
          <p>Synapse is a desktop interview assistant. This website is where you keep the material it works from: your resumes, the jobs you are applying for, and your preparation notes.</p>
          <div className="row">
            <Link className="btn btn-primary" href={user ? '/dashboard' : '/signup'}>{user ? 'Open dashboard' : 'Create a free account'}</Link>
            {!user && <Link className="btn" href="/login">Sign in</Link>}
          </div>
        </section>
        <section aria-labelledby="desk" className="stack">
          <h2 id="desk">What the desktop app does</h2>
          <div className="grid-3">
            {FEATURES.map(([t, d]) => (
              <div className="card stack" key={t}><h3>{t}</h3><p className="muted">{d}</p></div>
            ))}
          </div>
        </section>
        <section aria-labelledby="web" className="stack">
          <h2 id="web">What you manage here</h2>
          <div className="grid-3">
            {WEB.map(([t, d]) => (
              <div className="card stack" key={t}><h3>{t}</h3><p className="muted">{d}</p></div>
            ))}
          </div>
        </section>
        <section aria-labelledby="priv" className="card stack">
          <h2 id="priv">Your data stays yours</h2>
          <p className="muted">Every resume, file and note belongs to your account only. Files are served privately to you, passwords are hashed, and you can delete your account and everything in it from Settings. Preparation questions from AI are always labelled, and never mixed in with facts from your resume.</p>
        </section>
      </main>
    </>
  );
}
