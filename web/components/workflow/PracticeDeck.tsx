'use client';
import { useState, type KeyboardEvent } from 'react';
import type { AiPrep } from '@/lib/prep';
import s from './PracticeDeck.module.css';

type Tab = 'technical' | 'behavioral' | 'star' | 'projects' | 'improve';
const STAR = ['situation', 'task', 'action', 'result'] as const;

/** AI practice set, one prompt at a time. Everything here is an AI suggestion; resume facts never render in this component. */
export default function PracticeDeck({ content }: { content: AiPrep }) {
  const tabs: { id: Tab; label: string; n: number }[] = [
    { id: 'technical', label: 'Technical', n: content.practiceQuestions.length },
    { id: 'behavioral', label: 'Behavioral', n: content.behavioral.length },
    { id: 'star', label: 'STAR practice', n: content.starPractice.length },
    { id: 'projects', label: 'Projects', n: content.projectPrep.length },
    { id: 'improve', label: 'To improve', n: content.improvements.length }
  ];
  const [tab, setTab] = useState<Tab>(tabs.find((t) => t.n > 0)?.id ?? 'technical');
  const [pos, setPos] = useState(0);
  const [shown, setShown] = useState(0); // how much of the current card is revealed

  const select = (t: Tab) => { setTab(t); setPos(0); setShown(0); };
  const go = (i: number) => { setPos(i); setShown(0); };
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = tabs[(i + d + tabs.length) % tabs.length];
    select(next.id);
    document.getElementById(`deck-tab-${next.id}`)?.focus();
  };

  return (
    <div className={s.deck}>
      <div className={s.tabs} role="tablist" aria-label="Practice sets">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            id={`deck-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls="deck-panel"
            tabIndex={tab === t.id ? 0 : -1}
            className={s.tab}
            onClick={() => select(t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {t.label}<span className={s.tabN}>{t.n}</span>
          </button>
        ))}
      </div>

      <div id="deck-panel" role="tabpanel" aria-labelledby={`deck-tab-${tab}`} className={s.panel}>
        {tab === 'technical' && (
          <Questions
            items={content.practiceQuestions.map((q) => ({ question: q.question, kicker: q.topic, why: q.why }))}
            pos={pos} go={go} shown={shown} setShown={setShown}
          />
        )}
        {tab === 'behavioral' && (
          <Questions items={content.behavioral.map((q) => ({ question: q.question, why: q.why }))} pos={pos} go={go} shown={shown} setShown={setShown} />
        )}
        {tab === 'star' && (
          content.starPractice.length === 0 ? <p className={s.none}>Nothing generated for this set.</p> : (() => {
            const p = content.starPractice[Math.min(pos, content.starPractice.length - 1)];
            return (
              <Stage n={content.starPractice.length} pos={pos} go={go}>
                <p className={s.q}>{p.prompt}</p>
                <p className={s.sub}>Suggested story to draw on: {p.basedOn}</p>
                <p className={s.hint}>Say your own answer out loud first, then reveal the suggested outline one step at a time.</p>
                <ol className={s.star}>
                  {STAR.map((k, i) => (
                    <li key={k} className={s.starStep} data-shown={i < shown}>
                      <span className={s.starKey}>{k[0].toUpperCase()}</span>
                      <div>
                        <span className={s.starName}>{k}</span>
                        {i < shown ? <p>{p.outline[k]}</p> : <p className={s.hidden}>Hidden</p>}
                      </div>
                    </li>
                  ))}
                </ol>
                <div className="row">
                  {shown < STAR.length ? (
                    <>
                      <button type="button" className="btn" onClick={() => setShown(shown + 1)}>Reveal {STAR[shown]}</button>
                      <button type="button" className="btn btn-ghost" onClick={() => setShown(STAR.length)}>Show whole outline</button>
                    </>
                  ) : (
                    <button type="button" className="btn btn-ghost" onClick={() => setShown(0)}>Hide outline</button>
                  )}
                </div>
              </Stage>
            );
          })()
        )}
        {tab === 'projects' && (
          content.projectPrep.length === 0 ? <p className={s.none}>No projects on your resume to prepare, so none were generated.</p> : (
            <div className={s.projects}>
              {content.projectPrep.map((p, pi) => (
                <details key={`${pi}:${p.project}`} className={s.project}>
                  <summary><span className={s.projectName}>{p.project}</span><span className="tag" data-kind="resume">Project from your resume</span></summary>
                  <div className={s.projectBody}>
                    <div>
                      <h4>Points to explain</h4>
                      <ul>{p.explainPoints.map((x, j) => <li key={`${j}:${x}`}>{x}</li>)}</ul>
                    </div>
                    <div>
                      <h4>Likely follow-ups</h4>
                      <ul>{p.likelyFollowUps.map((x, j) => <li key={`${j}:${x}`}>{x}</li>)}</ul>
                    </div>
                  </div>
                </details>
              ))}
            </div>
          )
        )}
        {tab === 'improve' && (
          content.improvements.length === 0 ? <p className={s.none}>Nothing generated for this set.</p> : (
            <dl className={s.improve}>
              {content.improvements.map((x, j) => (
                <div key={`${j}:${x.area}`}><dt>{x.area}</dt><dd>{x.suggestion}</dd></div>
              ))}
            </dl>
          )
        )}
      </div>
    </div>
  );
}

function Questions(props: {
  items: { question: string; kicker?: string; why: string }[];
  pos: number; go: (i: number) => void; shown: number; setShown: (n: number) => void;
}) {
  if (!props.items.length) return <p className={s.none}>Nothing generated for this set.</p>;
  const q = props.items[Math.min(props.pos, props.items.length - 1)];
  return (
    <Stage n={props.items.length} pos={props.pos} go={props.go}>
      {q.kicker && <span className={s.topic}>{q.kicker}</span>}
      <p className={s.q}>{q.question}</p>
      {props.shown > 0 ? (
        <div className={s.why}>
          <span className={s.whyLabel}>Why it may come up</span>
          <p>{q.why}</p>
        </div>
      ) : (
        <div className="row">
          <button type="button" className="btn btn-ghost" onClick={() => props.setShown(1)}>Why it may come up</button>
        </div>
      )}
    </Stage>
  );
}

/** Shared frame: position, previous and next, and a jump list. */
function Stage({ n, pos, go, children }: { n: number; pos: number; go: (i: number) => void; children: React.ReactNode }) {
  const i = Math.min(pos, n - 1);
  return (
    <div className={s.stage}>
      <div aria-live="polite"><div key={i} className={s.card}>{children}</div></div>
      {n > 1 && <nav className={s.nav} aria-label="Move through this set">
        <button type="button" className="btn" onClick={() => go(i - 1)} disabled={i === 0}>Previous</button>
        <span className={s.pos}><span className={s.mono}>{i + 1}</span> of <span className={s.mono}>{n}</span></span>
        <button type="button" className="btn" onClick={() => go(i + 1)} disabled={i === n - 1}>Next</button>
        <ol className={s.jump}>
          {Array.from({ length: n }, (_, k) => (
            <li key={k}>
              <button type="button" className={s.dot} aria-label={`Item ${k + 1}`} aria-current={k === i ? 'step' : undefined} onClick={() => go(k)} />
            </li>
          ))}
        </ol>
      </nav>}
    </div>
  );
}
