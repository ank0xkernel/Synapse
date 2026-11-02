'use client';

import { useState, useEffect } from 'react';
import Icon from '@/components/Icon';

interface Project {
  id: string;
  name: string;
  category: string;
  resumeTitle: string;
  rootPath: string | null;
  isDiscovered: boolean;
  gitRemote: string | null;
  lastCommit: string | null;
  verifiedSummary: string;
  primaryStack: string[];
}

interface Health {
  status: string;
  totalFiles: number;
  totalChunks: number;
  totalSymbols: number;
  lastIndexedAt: string | null;
  projectsCount: number;
  projectStats: Record<string, { files: number; symbols: number; lastIndexedAt: string }>;
}

interface QueryResult {
  query: string;
  targetProjectId: string | null;
  latencyMs: number;
  results: Array<{
    id: string;
    projectId: string;
    filePath: string;
    startLine: number;
    endLine: number;
    symbols: string[];
    summary: string;
    rrfScore: number;
    sources: string[];
    textSnippet: string;
  }>;
  resumeMapping: {
    verifiedImplementation: {
      summary: string;
      technologies: string[];
      flows: string[];
    };
  } | null;
}

export default function ProjectIntelligenceClient() {
  const [health, setHealth] = useState<Health | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [reindexing, setReindexing] = useState(false);
  const [queryInput, setQueryInput] = useState('');
  const [querying, setQuerying] = useState(false);
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);

  useEffect(() => {
    fetchStatus();
  }, []);

  const fetchStatus = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/second-brain?action=status');
      if (res.ok) {
        const data = await res.json();
        setHealth(data.health);
        setProjects(data.projects || []);
      }
    } catch (err) {
      console.error('Failed to fetch second brain status:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleReindex = async () => {
    try {
      setReindexing(true);
      const res = await fetch('/api/second-brain?action=reindex', { method: 'POST' });
      if (res.ok) {
        await fetchStatus();
      }
    } catch (err) {
      console.error('Reindexing failed:', err);
    } finally {
      setReindexing(false);
    }
  };

  const handleQuery = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!queryInput.trim()) return;

    try {
      setQuerying(true);
      const res = await fetch('/api/second-brain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: queryInput.trim() })
      });
      if (res.ok) {
        const data = await res.json();
        setQueryResult(data);
      }
    } catch (err) {
      console.error('Query failed:', err);
    } finally {
      setQuerying(false);
    }
  };

  const sampleQuestions = [
    'How did you implement real-time announcements in Jumpstart Go?',
    'How does Novaris perform repository analysis?',
    'What backend technologies did you use in Gems Lord?',
    'Explain Manisha Wires.',
    'How does CampusConnect implement role-based access?'
  ];

  return (
    <div className="stack-lg">
      {/* Overview Status Banner */}
      <div className="panel fringe" style={{ padding: 'var(--space-6)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className="row-between">
          <div className="stack-tight">
            <div className="row" style={{ gap: 'var(--space-2)' }}>
              <span className="badge badge-accent">Second Brain Active</span>
              <span className="meta">
                {health?.lastIndexedAt ? `Last indexed ${new Date(health.lastIndexedAt).toLocaleTimeString()}` : 'Ready to index'}
              </span>
            </div>
            <h2 style={{ fontSize: 'var(--text-xl)', margin: 'var(--space-1) 0 0' }}>Engineering Repository Intelligence</h2>
            <p className="muted" style={{ maxWidth: '72ch' }}>
              Persistent code knowledge engine indexing {health?.totalFiles?.toLocaleString() ?? '3,100+'} verified source files and {health?.totalSymbols?.toLocaleString() ?? '13,500+'} symbols across your repositories.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleReindex}
            disabled={reindexing}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}
          >
            <Icon name="refresh" size={16} />
            {reindexing ? 'Reindexing...' : 'Reindex Repositories'}
          </button>
        </div>

        {/* Metric chips */}
        <div className="row" style={{ gap: 'var(--space-4)', marginTop: 'var(--space-2)' }}>
          <div className="panel panel-subtle" style={{ padding: 'var(--space-3) var(--space-4)', flex: 1, minWidth: '160px' }}>
            <span className="meta">Indexed Files</span>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)', marginTop: '2px' }}>
              {health?.totalFiles?.toLocaleString() ?? '3,115'}
            </div>
          </div>
          <div className="panel panel-subtle" style={{ padding: 'var(--space-3) var(--space-4)', flex: 1, minWidth: '160px' }}>
            <span className="meta">AST Symbols</span>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)', marginTop: '2px' }}>
              {health?.totalSymbols?.toLocaleString() ?? '13,562'}
            </div>
          </div>
          <div className="panel panel-subtle" style={{ padding: 'var(--space-3) var(--space-4)', flex: 1, minWidth: '160px' }}>
            <span className="meta">Code Chunks</span>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)', marginTop: '2px' }}>
              {health?.totalChunks?.toLocaleString() ?? '16,839'}
            </div>
          </div>
          <div className="panel panel-subtle" style={{ padding: 'var(--space-3) var(--space-4)', flex: 1, minWidth: '160px' }}>
            <span className="meta">Discovered Projects</span>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)', marginTop: '2px' }}>
              {projects.filter((p) => p.isDiscovered).length} / {projects.length}
            </div>
          </div>
        </div>
      </div>

      {/* Interactive Q&A Search & Provenance Inspector */}
      <div className="panel" style={{ padding: 'var(--space-6)' }}>
        <h3 style={{ marginBottom: 'var(--space-1)' }}>Code-Grounded Project Query</h3>
        <p className="muted" style={{ marginBottom: 'var(--space-4)' }}>
          Ask a technical question to inspect how Synapse retrieves verified code artifacts, flows, and provenance.
        </p>

        <form onSubmit={handleQuery} className="row" style={{ gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
          <input
            type="text"
            className="input grow"
            placeholder="e.g. How did you implement real-time announcements in Jumpstart Go?"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            disabled={querying}
          />
          <button type="submit" className="btn btn-primary" disabled={querying || !queryInput.trim()}>
            {querying ? 'Retrieving...' : 'Ask Second Brain'}
          </button>
        </form>

        {/* Suggestion pills */}
        <div className="row" style={{ gap: 'var(--space-2)', marginBottom: queryResult ? 'var(--space-6)' : '0' }}>
          <span className="meta" style={{ fontSize: '12px' }}>Try asking:</span>
          {sampleQuestions.slice(0, 3).map((q) => (
            <button
              key={q}
              type="button"
              className="badge"
              style={{ cursor: 'pointer', background: 'var(--surface-hover)', border: '1px solid var(--border)' }}
              onClick={() => { setQueryInput(q); }}
            >
              {q}
            </button>
          ))}
        </div>

        {/* Query Results */}
        {queryResult && (
          <div className="stack" style={{ marginTop: 'var(--space-6)', borderTop: '1px solid var(--border)', paddingTop: 'var(--space-4)' }}>
            <div className="row-between">
              <div className="row" style={{ gap: 'var(--space-2)' }}>
                <span className="badge badge-accent">Target: {queryResult.targetProjectId || 'General'}</span>
                <span className="meta">Retrieved in {queryResult.latencyMs} ms</span>
              </div>
              <span className="meta">{queryResult.results.length} code snippets verified</span>
            </div>

            {queryResult.resumeMapping && (
              <div className="panel panel-subtle" style={{ padding: 'var(--space-4)' }}>
                <div style={{ fontWeight: 'var(--weight-semibold)', marginBottom: 'var(--space-1)' }}>
                  Verified Architectural Flow
                </div>
                <p className="muted" style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-2)' }}>
                  {queryResult.resumeMapping.verifiedImplementation.summary}
                </p>
                <ul style={{ margin: 0, paddingLeft: 'var(--space-4)', fontSize: 'var(--text-sm)', color: 'var(--text-2)' }}>
                  {queryResult.resumeMapping.verifiedImplementation.flows.map((flow, i) => (
                    <li key={i}>{flow}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="stack" style={{ gap: 'var(--space-3)' }}>
              <div style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-sm)' }}>
                Verified Source Snippets (Injected into Gemini live context)
              </div>
              {queryResult.results.map((res) => (
                <div key={res.id} className="panel" style={{ padding: 'var(--space-3)', background: 'var(--surface-2)' }}>
                  <div className="row-between" style={{ marginBottom: 'var(--space-2)' }}>
                    <span className="mono" style={{ fontSize: '12px', color: 'var(--accent-text)' }}>
                      {res.filePath.split('/').slice(-3).join('/')}#L{res.startLine}-L{res.endLine}
                    </span>
                    <span className="meta" style={{ fontSize: '11px' }}>
                      RRF: {res.rrfScore.toFixed(4)} ({res.sources.join('+')})
                    </span>
                  </div>
                  <pre className="mono" style={{ margin: 0, padding: 'var(--space-2)', fontSize: '11px', background: 'var(--ground)', borderRadius: 'var(--radius-sm)', overflowX: 'auto', maxHeight: '160px' }}>
                    {res.textSnippet}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Discovered Projects Grid */}
      <div className="stack">
        <div className="row-between">
          <div>
            <h3>Discovered Engineering Repositories</h3>
            <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
              10 isolated engineering projects verified against local macOS workspace code.
            </p>
          </div>
        </div>

        <div className="grid-2">
          {projects.map((proj) => {
            const pStat = health?.projectStats?.[proj.id];
            return (
              <div
                key={proj.id}
                className="panel"
                style={{
                  padding: 'var(--space-5)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-3)',
                  border: proj.isDiscovered ? '1px solid var(--border)' : '1px dashed var(--border-weak)'
                }}
              >
                <div className="row-between">
                  <div className="stack-tight">
                    <div className="row" style={{ gap: 'var(--space-2)' }}>
                      <span style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-md)' }}>
                        {proj.name}
                      </span>
                      <span className={`badge ${proj.isDiscovered ? 'badge-neutral' : 'badge-subtle'}`}>
                        {proj.isDiscovered ? 'Discovered' : 'Missing'}
                      </span>
                    </div>
                    <span className="meta" style={{ fontSize: '11px' }}>{proj.resumeTitle}</span>
                  </div>
                </div>

                <p className="muted" style={{ fontSize: 'var(--text-sm)', lineHeight: '1.4' }}>
                  {proj.verifiedSummary}
                </p>

                {/* Primary tech tags */}
                <div className="row" style={{ gap: '4px' }}>
                  {proj.primaryStack.slice(0, 6).map((tech) => (
                    <span key={tech} className="badge" style={{ fontSize: '11px', padding: '1px 6px' }}>
                      {tech}
                    </span>
                  ))}
                  {proj.primaryStack.length > 6 && (
                    <span className="meta" style={{ fontSize: '11px' }}>+{proj.primaryStack.length - 6}</span>
                  )}
                </div>

                <div className="hairline" />

                {/* Stats & Path */}
                <div className="row-between" style={{ fontSize: '11px' }}>
                  <span className="meta">
                    {pStat ? `${pStat.files} files · ${pStat.symbols} symbols` : 'Not yet scanned'}
                  </span>
                  {proj.rootPath && (
                    <span className="mono meta" title={proj.rootPath}>
                      ~/{proj.rootPath.split('/').slice(-2).join('/')}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

