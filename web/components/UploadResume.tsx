'use client';
import { useRef, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { uploadDriver, uploadPdfDirect } from '@/lib/client';
import Icon from '@/components/Icon';
import s from '@/components/resume/upload.module.css';

const MAX = 8 * 1024 * 1024;
const OK_EXT = /\.(pdf|docx|txt|md)$/i;
// One server request reads the file and builds the profile, so after the bytes are sent there is one honest stage.
const PROCESSING = 'Reading and analysing';
const DONE = 'Read and analysed';

/** Intake for a new resume. The sheet's edge carries the state: absent at rest, forming while sent and read, vivid when done, dispersed on failure. */
export default function UploadResume({ first = false }: { first?: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [retry, setRetry] = useState<(() => void) | null>(null);

  function opened(id: string) {
    setStage(DONE);
    router.push(`/resumes/${id}`);
    router.refresh();
  }

  function send(form: FormData) {
    setRetry(() => () => send(form));
    setError('');
    setPct(0);
    setStage('Uploading');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/resumes');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setPct(Math.round((e.loaded / e.total) * 100));
    };
    xhr.upload.onload = () => setStage(PROCESSING);
    xhr.onerror = () => {
      setPct(null);
      setError('Network error. Check your connection and try again.');
    };
    xhr.onload = () => {
      let data: { ok?: boolean; id?: string; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data.ok && data.id) {
        opened(data.id);
      } else {
        setPct(null);
        setError(data.error || `Upload failed (${xhr.status})`);
      }
    };
    xhr.send(form);
  }

  async function sendDirect(file: File) {
    setRetry(() => () => sendDirect(file));
    setError('');
    setPct(0);
    setStage('Uploading');
    const r = await uploadPdfDirect(file, { onProgress: setPct, onStage: setStage });
    if (r.ok) {
      opened(r.id);
    } else {
      setPct(null);
      setError(r.error);
    }
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    setRetry(null);
    if (/\.doc$/i.test(file.name)) return setError('Older Word .doc files are not supported. Save it as .docx or PDF and upload that.');
    if (!OK_EXT.test(file.name)) return setError('Only PDF, Word (.docx), TXT and MD files are accepted.');
    if (file.size > MAX) return setError('That file is larger than 8 MB.');
    if (file.size === 0) return setError('That file is empty.');
    if (/\.pdf$/i.test(file.name) && (await uploadDriver()) === 'blob') return sendDirect(file);
    const f = new FormData();
    f.set('file', file);
    send(f);
  }

  const busy = pct !== null;
  const sending = busy && stage === 'Uploading';
  const state = error ? 'failed' : stage === DONE ? 'done' : sending ? 'uploading' : busy ? 'processing' : over ? 'over' : 'idle';
  const progress = { '--p': (pct ?? 0) / 100 } as CSSProperties;

  return (
    <div className={s.wrap}>
      <div
        className={s.intake}
        data-state={state}
        data-first={first}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (!busy) pick(e.dataTransfer.files[0]); }}
      >
        <div className={s.sheet} aria-hidden="true">
          <span className={s.fold} />
          <span className={s.lines}><i /><i /><i /><i /><i /><i /><i /></span>
          <span className={s.scan} />
          <span className={s.edge} style={progress} />
        </div>

        <div className={s.body}>
          <h2 className={s.title}>{first ? 'Start with your resume' : 'Add a resume'}</h2>
          <p className={s.lead}>
            Drop a file anywhere on this panel, or choose one. PDF, Word (.docx), TXT or Markdown, up to 8 MB. Scanned PDFs are read when AI is set up.
          </p>
          <input ref={input} id="resume-file" type="file" accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
          <div className={s.actions}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => input.current?.click()}>
              <Icon name="upload" size={16} />Choose file
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setPasteOpen((v) => !v)} aria-expanded={pasteOpen} aria-controls="paste-panel">
              Paste text instead
            </button>
          </div>

          {busy && (
            <div className={s.progressBlock} role="status">
              <ol className={s.stages}>
                <li data-on={sending} data-done={!sending}>
                  <span>Send the file</span>
                  <span className="num">{sending ? `${pct}%` : 'Sent'}</span>
                </li>
                <li data-on={!sending && stage !== DONE} data-done={stage === DONE}>
                  <span>{sending ? PROCESSING : stage}</span>
                  <span>{stage === DONE ? 'Opening' : sending ? '' : 'Working'}</span>
                </li>
              </ol>
              <div className={s.track} role="progressbar" aria-valuenow={pct ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress">
                <span style={progress} data-indeterminate={!sending} />
              </div>
            </div>
          )}

          {error && (
            <div className={s.failure} role="alert">
              <p>{error}</p>
              {retry && !busy && (
                <button type="button" className="btn btn-sm" onClick={retry}>
                  <Icon name="refresh" size={15} />Try again
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {pasteOpen && (
        <form
          id="paste-panel"
          className={s.paste}
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            if (!String(f.get('text') ?? '').trim()) return setError('Paste some resume text first.');
            send(f);
          }}
        >
          <div className="field">
            <label htmlFor="paste-name">Name</label>
            <input id="paste-name" name="name" className="input" maxLength={120} placeholder="Backend resume" />
          </div>
          <div className="field">
            <label htmlFor="paste-text">Resume text</label>
            <textarea id="paste-text" name="text" className="textarea" rows={10} maxLength={200000} />
          </div>
          <div><button className="btn btn-primary" disabled={busy}>Save resume</button></div>
        </form>
      )}
    </div>
  );
}
