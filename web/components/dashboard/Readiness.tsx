import Link from 'next/link';
import Icon from '@/components/Icon';
import type { Check, Phase } from './checks';
import s from './dashboard.module.css';

const SPOKEN: Record<Phase, string> = { vivid: 'Done', forming: 'In progress', absent: 'Not started', dispersed: 'Needs attention' };

/** The chain the desktop agent depends on, in order, each link in one of the cloud's states. */
export default function Readiness({ checks }: { checks: Check[] }) {
  return (
    <ol className={s.chain}>
      {checks.map((c) => (
        <li key={c.id} className={s.link} data-phase={c.phase}>
          <span className={s.marker} aria-hidden="true">{c.phase === 'vivid' && <Icon name="check" size={12} />}</span>
          <div className={s.linkBody}>
            <p className={s.linkLabel}>{c.label}<span className="sr-only">: {SPOKEN[c.phase]}</span></p>
            <p className={s.linkState}>{c.state}</p>
            {c.detail && <p className={s.linkDetail}>{c.detail}</p>}
            {c.action && (
              <Link className={s.linkAction} href={c.action.href}>
                {c.action.label}<Icon name="arrow" size={14} />
              </Link>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
