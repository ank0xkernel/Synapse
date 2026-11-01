import Link from 'next/link';
import Icon from '@/components/Icon';
import s from './dashboard.module.css';

/** A new account: one path, three steps, the first one in focus. Step 3 shows as done if a Mac is already linked. */
export default function FirstRun({ linked }: { linked: boolean }) {
  return (
    <div className={s.page}>
      <header className={s.head}>
        <div className={s.headText}>
          <h1>Get Synapse ready for your next interview</h1>
          <p>The desktop app answers from your own resume and the job you are interviewing for. Three steps put both on your Mac.</p>
        </div>
      </header>
      <ol className={s.path}>
        <li className={`${s.step} ${s.stepFirst} fringe`}>
          <span className={s.stepNum} aria-hidden="true">1</span>
          <h2>Upload your resume</h2>
          <p>PDF, Word or a scan. Synapse reads it and builds a candidate profile that you can check and correct, so answers stay true to what you have done.</p>
          <Link className="btn btn-primary btn-lg" href="/resumes"><Icon name="upload" size={18} />Upload a resume</Link>
        </li>
        <li className={s.step}>
          <span className={s.stepNum} aria-hidden="true">2</span>
          <h2>Add the job and a session</h2>
          <p>Paste the job description, then create a session for the interview: which resume, which job, and how answers should sound.</p>
          <Link className={s.linkAction} href="/jobs/new">Add a job description<Icon name="arrow" size={14} /></Link>
        </li>
        <li className={s.step} data-done={linked}>
          <span className={s.stepNum} aria-hidden="true">{linked ? <Icon name="check" size={14} /> : 3}</span>
          <h2>Link your Mac{linked && <span className="sr-only"> (done)</span>}</h2>
          <p>In the desktop app, choose Link with browser and approve it here. It fetches your context before each interview and works from that copy.</p>
          {linked
            ? <p className="status" data-tone="positive">A Mac is linked</p>
            : <Link className={s.linkAction} href="/desktop">See how linking works<Icon name="arrow" size={14} /></Link>}
        </li>
      </ol>
    </div>
  );
}
