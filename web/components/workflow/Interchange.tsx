import type { CSSProperties } from 'react';
import s from './Interchange.module.css';

/**
 * One segment per technology the job description names. Matched segments carry the fringe;
 * the rest stay neutral. Encodes the deterministic match exactly: no score, no weighting.
 */
export function MatchTicks({ matched, total }: { matched: number; total: number }) {
  if (total === 0) return null;
  return (
    <span className={s.ticks} role="img" aria-label={`${matched} of ${total} technologies matched`} style={{ '--total': total } as CSSProperties}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={s.tick} data-on={i < matched} style={{ '--i': i } as CSSProperties} />
      ))}
    </span>
  );
}

/**
 * The posting's technologies set against the candidate's: employer-only on the left,
 * the meeting point in the middle, candidate-only on the right. Lists come straight from compare().
 */
export default function Interchange(props: {
  matched: string[];
  gaps: string[];
  resumeOnly: string[];
  resumeName: string;
  headingId: string;
  heading?: string;
  /** h3 when the interchange sits inside another section. */
  level?: 2 | 3;
}) {
  const { matched, gaps, resumeOnly } = props;
  const total = matched.length + gaps.length;
  const H = props.level === 3 ? 'h3' : 'h2';
  const L = props.level === 3 ? 'h4' : 'h3';
  return (
    <section className={s.root} aria-labelledby={props.headingId}>
      <div className={s.head}>
        <H id={props.headingId} className={s.title}>{props.heading ?? 'Where your resume meets the posting'}</H>
        <p className={s.summary}>
          {total === 0 ? (
            'The posting names no technologies from the known list, so there is nothing to match by name.'
          ) : (
            <>
              <span className={s.count}>{matched.length} of {total}</span> technologies the posting names also appear in{' '}
              <span className={s.resume}>{props.resumeName}</span>.
            </>
          )}
        </p>
        <MatchTicks matched={matched.length} total={total} />
      </div>

      <div className={s.lanes}>
        <div className={s.lane} data-side="jd">
          <div className={s.laneHead}>
            <L className={s.laneTitle}>Only in the posting</L>
            <span className={s.n}>{gaps.length}</span>
          </div>
          <p className={s.note}>The employer names these; your resume does not. You may still know them: add them to your profile if so.</p>
          <Chips items={gaps} kind="gap" empty="Nothing missing from the known list." />
        </div>

        <div className={s.lane} data-side="both">
          <div className={s.laneHead}>
            <L className={s.laneTitle}>In both</L>
            <span className={s.n}>{matched.length}</span>
          </div>
          <p className={s.note}>Named in the posting and found in your resume.</p>
          <Chips items={matched} kind="match" empty="No overlap in the known technology list." />
        </div>

        <div className={s.lane} data-side="resume">
          <div className={s.laneHead}>
            <L className={s.laneTitle}>Only in your resume</L>
            <span className={s.n}>{resumeOnly.length}</span>
          </div>
          <p className={s.note}>Your own experience the posting does not ask about.</p>
          <Chips items={resumeOnly} kind="own" empty="Everything on your resume is named in the posting." />
        </div>
      </div>
      <p className={s.method}>Matched by name against a fixed technology list. No AI, nothing inferred.</p>
    </section>
  );
}

function Chips({ items, kind, empty }: { items: string[]; kind: 'gap' | 'match' | 'own'; empty: string }) {
  if (!items.length) return <p className={s.empty}>{empty}</p>;
  return (
    <ul className={s.chips}>
      {items.map((t) => (
        <li key={t} className={s.chip} data-kind={kind}>{t}</li>
      ))}
    </ul>
  );
}
