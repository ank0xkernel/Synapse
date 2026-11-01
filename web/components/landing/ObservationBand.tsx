'use client';
import { useEffect, useRef, useState } from 'react';
import s from './observation.module.css';

/*
 * The hero demo: an interviewer's question meets the candidate's material, and colour forms at the edge between them.
 * The server renders the resolved ("vivid") state, so the band reads complete before any script runs and under
 * prefers-reduced-motion. The loop only advances while the band is on screen and the tab is visible.
 */
const QUESTION = 'How would you keep an event pipeline correct when a consumer goes down?';
const WORDS = QUESTION.split(' ');
const STEPS = [
  ['vivid', 7000],
  ['clear', 800],
  ['ask', 3400],
  ['form', 1600]
] as const;

const LINES = [
  { text: 'At Acme Corp I owned the payment events service, so I would start with idempotent consumers and a dead-letter queue.', source: 'Acme Corp', kind: 'work' },
  { text: 'In my ledger replay project I rebuilt state from an append-only log, which is how I would recover what was missed.', source: 'Ledger replay', kind: 'project' },
  { text: 'Kafka is only listed on my resume, so I would talk through the design rather than claim production use.', source: 'Kafka', kind: 'listed' }
] as const;
const KIND_LABEL = { work: 'work', project: 'project', listed: 'listed skill' } as const;

export default function ObservationBand() {
  const ref = useRef<HTMLElement>(null);
  const [step, setStep] = useState(0);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    let onScreen = false;
    const update = () => {
      const go = onScreen && !document.hidden && !reduce.matches;
      if (reduce.matches) setStep(0);
      setRunning(go);
    };
    const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; update(); }, { threshold: 0.2 });
    io.observe(el);
    document.addEventListener('visibilitychange', update);
    reduce.addEventListener('change', update);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', update);
      reduce.removeEventListener('change', update);
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const t = setTimeout(() => setStep((i) => (i + 1) % STEPS.length), STEPS[step][1]);
    return () => clearTimeout(t);
  }, [running, step]);

  return (
    <figure ref={ref} className={s.band} data-phase={STEPS[step][0]} data-running={running} aria-labelledby="band-cap">
      <figcaption id="band-cap" className={s.cap}>
        <span className="tag">Example</span>
        <span className={s.capText}>A question from the call, answered from one candidate&rsquo;s reviewed resume.</span>
      </figcaption>

      <div className={s.question}>
        <p className={s.who}>
          <span className={s.liveDot} aria-hidden="true" />Interviewer
          <span className={s.whoMeta}>live caption</span>
        </p>
        <p className={s.caption}>
          {WORDS.map((w, i) => (
            <span key={i} className={s.word} style={{ '--i': i } as React.CSSProperties}>{w} </span>
          ))}
          <span className={s.caret} aria-hidden="true" />
        </p>
      </div>

      <div className={s.edge} aria-hidden="true">
        <span className={s.edgeVeil} />
        <span className={s.edgeCore}><span className={s.edgeRun} /></span>
        <span className={s.edgeState}>
          <span data-for="ask">Listening</span>
          <span data-for="form">Matching your resume</span>
          <span data-for="vivid">Three sources found</span>
        </span>
      </div>

      <div className={s.answer}>
        <p className={s.who}>
          Answer<span className={s.whoMeta}>Technical mode</span>
        </p>
        <ul className={s.lines}>
          {LINES.map((l, i) => (
            <li key={l.kind} className={s.line} style={{ '--i': i } as React.CSSProperties}>
              <span>{l.text}</span>
              <span className={s.source} data-kind={l.kind}>{l.source} &middot; {KIND_LABEL[l.kind]}</span>
            </li>
          ))}
        </ul>
        <p className={s.jd}>
          <span className={s.jdTag}>Job description</span>
          &ldquo;Experience with event-driven systems&rdquo; is kept separate and never counted as something the candidate has done.
        </p>
      </div>
    </figure>
  );
}
