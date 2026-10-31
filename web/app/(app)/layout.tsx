import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import Sidebar from '@/components/Sidebar';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/dashboard" className="brand"><span className="brand-mark" aria-hidden="true" />Synapse</Link>
        <Sidebar email={user.email} />
      </aside>
      <main className="main" id="main">{children}</main>
    </div>
  );
}
