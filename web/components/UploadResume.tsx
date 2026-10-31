'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const MAX = 8 * 1024 * 1024;
const OK_EXT = /\.(pdf|txt|md)$/i;

export default function UploadResume() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);

  function send(form: FormData) {
    setError('');
    setPct(0);
    setStage('Uploading');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/resumes');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setPct(Math.round((e.loaded / e.total) * 100));
    };
    xhr.upload.onload = () => setStage('Extracting text');
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
        router.push(`/resumes/${data.id}`);
        router.refresh();
      } else {
        setPct(null);
        setError(data.error || `Upload failed (${xhr.status})`);
      }
    };
    xhr.send(form);
  }

  function pick(file: File | undefined) {
    if (!file) return;
    if (!OK_EXT.test(file.name)) return setError('Only PDF, TXT and MD files are accepted.');
    if (file.size > MAX) return setError('That file is larger than 8 MB.');
    if (file.size === 0) return setError('That file is empty.');
    const f = new FormData();
    f.set('file', file);
    send(f);
  }

  const busy = pct !== null;

  return (
    <div className="stack">
      <div
        className="drop"
        data-over={over}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (!busy) pick(e.dataTransfer.files[0]); }}
      >
        <strong>Drop a resume here</strong>
        <span className="muted">PDF, TXT or Markdown, up to 8 MB</span>
        <input ref={input} id="resume-file" type="file" accept=".pdf,.txt,.md,application/pdf,text/plain" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => input.current?.click()}>Choose file</button>
          <button type="button" className="btn" disabled={busy} onClick={() => setPasteOpen((v) => !v)} aria-expanded={pasteOpen}>Paste text instead</button>
        </div>
        {busy && (
          <div style={{ width: '100%', maxWidth: 360 }} role="status">
            <div className="progress" role="progressbar" aria-valuenow={pct ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress">
              <span style={{ width: `${pct}%` }} />
            </div>
            <p className="meta">{stage}{stage === 'Uploading' ? ` ${pct}%` : '...'}</p>
          </div>
        )}
      </div>
      {pasteOpen && (
        <form
          className="stack card"
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
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
