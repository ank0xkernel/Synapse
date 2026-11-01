import Link from 'next/link';
import BrandMark from '@/components/BrandMark';
import { requirePageUser } from '@/lib/auth';
import Sidebar from '@/components/Sidebar';
import s from '@/components/shell/shell.module.css';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  return (
    <div className={s.shell}>
      <aside className={s.sidebar}>
        <Link href="/dashboard" className={`brand ${s.brand}`}><BrandMark />Synapse</Link>
        <Sidebar email={user.email} name={user.name} />
      </aside>
      <main className="main" id="main">{children}</main>
    </div>
  );
}
