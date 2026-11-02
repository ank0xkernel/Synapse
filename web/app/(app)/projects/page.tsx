import type { Metadata } from 'next';
import { requirePageUser } from '@/lib/auth';
import ProjectIntelligenceClient from '@/components/projects/ProjectIntelligenceClient';

export const metadata: Metadata = {
  title: 'Project Intelligence — Second Brain'
};

export default async function ProjectsPage() {
  await requirePageUser();

  return (
    <div className="main">
      <div className="page-head">
        <h1 style={{ fontSize: 'var(--display-xs)', fontWeight: 'var(--weight-regular)' }}>
          Project Intelligence
        </h1>
        <p className="muted">
          Your personal engineering knowledge system. Discovers, indexes, and grounds technical answers in your real local repositories.
        </p>
      </div>
      <ProjectIntelligenceClient />
    </div>
  );
}

