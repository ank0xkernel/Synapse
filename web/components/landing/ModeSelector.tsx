'use client';
import { useRef, useState } from 'react';
import s from './modes.module.css';

/* Descriptions mirror src/services/ai/response-modes.js; the answers are illustrative and labelled Example. */
const MODES = [
  {
    id: 'quick', label: 'Quick', note: '1 to 3 spoken sentences, about 10 to 20 seconds.',
    body: [{ p: 'At Acme Corp our payment events were being processed twice after retries, so I made the consumers idempotent with a processed-event key and added a dead-letter queue for the ones that kept failing.' }]
  },
  {
    id: 'professional', label: 'Professional', note: 'Concise, tied to the role only where it is relevant.',
    body: [
      { p: 'At Acme Corp I owned the payment events service, and retries were occasionally charging work twice. I made every consumer idempotent and moved repeat failures to a dead-letter queue the on-call engineer could replay.' },
      { p: 'It is the same kind of reliability work this role describes, so I would expect to bring that habit of designing for retries from the start.' }
    ]
  },
  {
    id: 'technical', label: 'Technical', note: 'A direct opening, then how it works: mechanism, trade-offs, limits.',
    body: [
      { p: 'I made the payment event consumers idempotent and isolated poison messages, so a retry could never apply the same event twice.' },
      { h: 'How it works', list: [
        'Each event carries an id; the consumer records it in the same transaction as the write and skips ids it has seen.',
        'After a fixed number of failures the event moves to a dead-letter queue instead of blocking the partition.',
        'Trade-off: the processed-id table grows, so it needs a retention window longer than the longest retry.'
      ] }
    ]
  },
  {
    id: 'star', label: 'STAR', note: 'Situation, Task, Action, Result, with Action the longest.',
    body: [
      { k: 'Situation', p: 'At Acme Corp, retried payment events were sometimes processed twice.' },
      { k: 'Task', p: 'I owned the events service, so stopping the duplicates was mine to fix.' },
      { k: 'Action', p: 'I added an idempotency key checked inside the write transaction, moved repeat failures to a dead-letter queue, and wrote the runbook for replaying them.' },
      { k: 'Result', p: 'Retries became safe to run, and on-call had one clear place to look when an event failed.' }
    ]
  },
  {
    id: 'detailed', label: 'Detailed', note: 'About a minute: answer, reasoning, a real example, trade-offs, what next.',
    body: [
      { p: 'The short version is that I made retries safe instead of trying to make failures rare. At Acme Corp the payment events service retried on timeouts, and a slow downstream call meant the same event could land twice.' },
      { p: 'I put an idempotency check inside the write transaction, so the record of a processed event and its effect commit together. Events that kept failing moved to a dead-letter queue rather than holding up everything behind them.' },
      { p: 'The cost is a table of processed ids that needs a retention policy. Next time I would add that from day one, along with an alert on dead-letter depth.' }
    ]
  }
] as const;

type Part = { p?: string; k?: string; h?: string; list?: readonly string[] };

export default function ModeSelector() {
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const mode = MODES[active];

  function onKey(e: React.KeyboardEvent) {
    const last = MODES.length - 1;
    const next = ({ ArrowDown: active + 1, ArrowRight: active + 1, ArrowUp: active - 1, ArrowLeft: active - 1, Home: 0, End: last } as Record<string, number>)[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const i = (next + MODES.length) % MODES.length;
    setActive(i);
    tabs.current[i]?.focus();
  }

  return (
    <div className={s.wrap}>
      <div className={s.tabs} role="tablist" aria-label="Response mode" aria-orientation="vertical" onKeyDown={onKey}>
        {MODES.map((m, i) => (
          <button
            key={m.id}
            ref={(el) => { tabs.current[i] = el; }}
            id={`mode-tab-${m.id}`}
            type="button"
            role="tab"
            className={s.tab}
            aria-selected={i === active}
            aria-controls="mode-panel"
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
          >
            <span className={s.tabLabel}>{m.label}</span>
            <span className={s.tabNote}>{m.note}</span>
          </button>
        ))}
      </div>
      <div id="mode-panel" role="tabpanel" aria-labelledby={`mode-tab-${mode.id}`} className={`${s.panel} fringe`} tabIndex={0}>
        <div className={s.panelHead}>
          <span className="tag">Example</span>
          <span className={s.mode}>{mode.label}</span>
        </div>
        <p className={s.panelNote}>{mode.note}</p>
        <p className={s.q}><span className={s.qWho}>Interviewer</span>Tell me about a time you made a system more reliable.</p>
        <div className={s.body} key={mode.id}>
          {(mode.body as readonly Part[]).map((b, i) => (
            <div key={i} className={s.part}>
              {b.h && <p className={s.h}>{b.h}</p>}
              {b.p && <p>{b.k && <b className={s.k}>{b.k}</b>}{b.p}</p>}
              {b.list && <ul>{b.list.map((li) => <li key={li}>{li}</li>)}</ul>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
