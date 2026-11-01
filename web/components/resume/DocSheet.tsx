import s from './sheet.module.css';

/** A paper preview of a resume, printed with the first lines of its own extracted text. Decorative: the same facts are in the row beside it. */
export default function DocSheet({ kind, text, active, failed, large }: { kind: string; text: string; active?: boolean; failed?: boolean; large?: boolean }) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, large ? 22 : 10);
  return (
    <div className={s.sheet} data-active={active} data-failed={failed} data-large={large} aria-hidden="true">
      <span className={s.kind}>{kind}</span>
      {lines.length > 0 ? (
        <div className={s.print}>
          {lines.map((l, i) => <p key={i} data-first={i === 0}>{l}</p>)}
        </div>
      ) : (
        <div className={s.blank}><i /><i /><i /><i /></div>
      )}
    </div>
  );
}
