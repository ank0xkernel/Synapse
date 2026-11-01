import Link from 'next/link';
import BrandMark from '@/components/BrandMark';
import Icon from '@/components/Icon';
import ThemeSwitch from '@/components/ThemeSwitch';
import ObservationBand from '@/components/landing/ObservationBand';
import ModeSelector from '@/components/landing/ModeSelector';
import { currentUser } from '@/lib/auth';
import s from './landing.module.css';

const DESKTOP = [
  ['System audio capture', 'On macOS the desktop app captures the interviewer’s audio natively from the system, alongside your microphone.'],
  ['Live transcription', 'Speech is transcribed as it happens with AssemblyAI, so questions are on screen while they are still being asked.'],
  ['Streamed answers', 'Gemini answers stream in as they are written, grounded in your resume and the job description you saved.'],
  ['Five response modes', 'Quick, Professional, Technical, STAR and Detailed. Pick a default per job or per interview.'],
  ['Resume and job context', 'Answers use what is in your resume and the posting. Details that are missing stay missing.'],
  ['Phone companion', 'Optionally follow the session from your phone over your local network, behind a one-time code.']
];
const WEB = [
  ['Resume library', 'Upload several resumes as PDF, Word or scans, preview them, fix extracted text and choose the active one.'],
  ['Candidate profile', 'Education, experience, projects, skills, achievements and certifications, each marked as extracted or edited by you.'],
  ['Job descriptions', 'Save postings with company and role, link a resume and set your preferred answer style.'],
  ['Interview preparation', 'A resume-to-job comparison with skill gaps, plus optional AI practice questions that are labelled as suggestions.'],
  ['Sessions', 'Prepare, reopen and edit interview sessions. Choose which one the desktop app loads.'],
  ['Desktop connection', 'Sign in from the desktop app through your browser. It fetches your context once before a session starts.']
];
const COLUMNS = [
  { title: 'On your Mac, during the call', items: DESKTOP },
  { title: 'On the web, before it', items: WEB }
];
const LEDGER = [
  ['PostgreSQL', 'Acme Corp, backend engineer', 'work', 'Used at work'],
  ['Event sourcing', 'Ledger replay', 'project', 'Used in a project'],
  ['Kafka', 'Skills section', 'listed', 'Only listed']
];
const PRIVACY = [
  ['One account, one owner', 'Every resume, file and note belongs to your account only.'],
  ['Private files', 'Files are served privately to you, and passwords are hashed.'],
  ['Delete everything', 'You can delete your account and everything in it from Settings.'],
  ['AI kept labelled', 'Preparation questions from AI are always labelled, and never mixed in with facts from your resume.']
];

export default async function Landing() {
  const user = await currentUser();
  const primary = user
    ? <Link className="btn btn-primary btn-lg" href="/dashboard">Open dashboard</Link>
    : <Link className="btn btn-primary btn-lg" href="/signup">Create a free account</Link>;
  return (
    <>
      <header className="pub-nav">
        <Link href="/" className="brand" aria-label="Synapse home"><BrandMark /><span className={s.brandWord}>Synapse</span></Link>
        <nav className="row" aria-label="Account">
          <ThemeSwitch />
          {user ? (
            <Link className="btn btn-primary" href="/dashboard">Open dashboard</Link>
          ) : (
            <>
              <Link className={`btn btn-ghost ${s.navSignIn}`} href="/login">Sign in</Link>
              <Link className="btn btn-primary" href="/signup">Create account</Link>
            </>
          )}
        </nav>
      </header>

      <main className={s.page} id="main">
        <section className={s.hero} aria-labelledby="hero-h">
          <div className={s.heroCopy}>
            <h1 id="hero-h" className={s.display}>Live interview answers, drawn from what you have actually done.</h1>
            <p className={s.lede}>Synapse is a macOS interview assistant. It listens to the call, captions the interviewer and streams a short answer you can say aloud, grounded in your own reviewed resume.</p>
            <div className={s.ctas}>
              {primary}
              {!user && <Link className="btn btn-ghost btn-lg" href="/login">Sign in</Link>}
            </div>
          </div>
          <ObservationBand />
        </section>

        <section className={s.path} aria-labelledby="path-h">
          <div className={s.sectionHead}>
            <h2 id="path-h" className={s.h2}>Prepare here once. The call runs on your Mac.</h2>
            <p className={s.body}>The website keeps your material. The desktop app takes a copy before the session and answers from it, so live answers never wait on this site and keep working offline from the cache.</p>
          </div>
          <ol className={s.stations}>
            <li className={s.station}>
              <h3 className={s.h3}>Add your material</h3>
              <p className={s.small}>On the web, upload a resume, paste the job description and create a session.</p>
              <div className={s.frag} aria-hidden="true">
                <span className={`tag ${s.fragTag}`}>Example</span>
                <div className={s.fragRow}><Icon name="file" size={16} /><span className={s.fragName}>Backend resume.pdf</span><span className="status" data-tone="positive">Active</span></div>
                <div className={s.fragRow}><Icon name="job" size={16} /><span className={s.fragName}>Globex &middot; Backend Engineer</span><span className={s.fragMeta}>Technical</span></div>
                <div className={s.fragRow}><Icon name="session" size={16} /><span className={s.fragName}>Globex, round 1</span><span className="status" data-tone="accent">Desktop loads this</span></div>
              </div>
            </li>
            <li className={s.station}>
              <h3 className={s.h3}>Link the desktop app</h3>
              <p className={s.small}>Approve it once in your browser. It fetches your context before the session starts.</p>
              <div className={`${s.frag} ${s.fragLink}`} aria-hidden="true">
                <span className={`tag ${s.fragTag}`}>Example</span>
                <div className={s.nodes}>
                  <span className={s.node}><Icon name="desktop" size={18} />Synapse Desktop</span>
                  <hr className={`fringe-line ${s.nodeLine}`} />
                  <span className={s.node}><Icon name="profile" size={18} />Your account</span>
                </div>
                <span className="status" data-tone="positive">Linked &middot; context cached on this Mac</span>
              </div>
            </li>
            <li className={s.station}>
              <h3 className={s.h3}>Run the interview on your Mac</h3>
              <p className={s.small}>During the call, the app listens, transcribes and streams answers on its own, without waiting on this site.</p>
              <div className={`${s.frag} ${s.fragCall}`} aria-hidden="true">
                <span className={`tag ${s.fragTag}`}>Example</span>
                <div className={s.callBar}><span className="status" data-tone="busy">Listening</span><span className={s.mono}>00:05</span><span className={s.callMode}>Professional</span></div>
                <p className={s.callQ}>How would you design a rate limiter for a public API with bursty traffic?</p>
                <p className={s.callA}>I&rsquo;d use a token bucket per API key, stored in Redis so every gateway node shares the same counts.</p>
              </div>
            </li>
          </ol>
        </section>

        <section className={s.prov} aria-labelledby="prov-h">
          <div className={s.provCopy}>
            <h2 id="prov-h" className={s.h2}>Every skill keeps a record of where it came from.</h2>
            <p className={s.body}>Synapse reads your resume into a candidate profile that you review and correct. Each technology is labelled by where it appears: used at work, used in a project, or only listed. Each entry is also marked as extracted from your resume or edited by you.</p>
            <p className={s.body}>The job description is kept apart. What a posting asks for is compared against your background, and never added to it.</p>
          </div>
          <figure className={s.ledger}>
            <figcaption className={s.ledgerCap}><span className="tag">Example</span>Candidate profile, skills</figcaption>
            <dl className={s.rows}>
              {LEDGER.map(([tech, where, kind, label]) => (
                <div className={s.ledgerRow} key={tech}>
                  <dt className={s.tech}>{tech}</dt>
                  <dd className={s.whereCell}>{where}</dd>
                  <dd className={s.label} data-kind={kind}>{label}</dd>
                </div>
              ))}
            </dl>
            <div className={s.jd}>
              <p className={s.jdHead}><Icon name="job" size={16} />Job description &middot; Globex <span className={s.jdNote}>kept separate</span></p>
              <ul className={s.jdList}>
                <li>Design and operate services on AWS and Kubernetes</li>
                <li>Experience with event-driven systems</li>
              </ul>
            </div>
          </figure>
        </section>

        <section className={s.modes} aria-labelledby="modes-h">
          <div className={s.sectionHead}>
            <h2 id="modes-h" className={s.h2}>One question, five ways to say it.</h2>
            <p className={s.body}>Each response mode changes the length and shape of the answer, never the facts behind it. Set a default per job or per interview.</p>
          </div>
          <ModeSelector />
        </section>

        <section className={s.index} aria-labelledby="index-h">
          <h2 id="index-h" className={s.h2}>What it does, plainly.</h2>
          <div className={s.columns}>
            {COLUMNS.map(({ title, items }) => (
              <div key={title}>
                <h3 className={s.colHead}>{title}</h3>
                <dl className={s.defs}>
                  {items.map(([t, d]) => (
                    <div key={t} className={s.def}><dt>{t}</dt><dd>{d}</dd></div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </section>

        <section className={s.privacy} aria-labelledby="priv-h">
          <div className={s.privHead}>
            <Icon name="lock" size={22} />
            <h2 id="priv-h" className={s.h2}>Your data stays yours.</h2>
          </div>
          <ul className={s.facts}>
            {PRIVACY.map(([t, d]) => (
              <li key={t}><b>{t}</b><span>{d}</span></li>
            ))}
          </ul>
        </section>

        <section className={s.close} aria-labelledby="close-h">
          <hr className="fringe-line" />
          <h2 id="close-h" className={s.closeH}>Walk into the interview with your context ready.</h2>
          <div className={s.ctas}>
            {primary}
            {!user && <Link className="btn btn-lg" href="/login">Sign in</Link>}
          </div>
        </section>
      </main>

      <footer className={s.foot}>
        <div className={s.footInner}>
          <span className="brand"><BrandMark />Synapse</span>
          <p className={s.footNote}>A macOS interview assistant, and the website where you prepare its material.</p>
          <nav className={s.footNav} aria-label="Footer">
            {user ? <Link href="/dashboard">Dashboard</Link> : <><Link href="/login">Sign in</Link><Link href="/signup">Create account</Link></>}
          </nav>
        </div>
      </footer>
    </>
  );
}
