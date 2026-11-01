'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import LogoutButton from './LogoutButton';
import ThemeSwitch from './ThemeSwitch';

const ITEMS = [
  ['/dashboard', 'Dashboard'],
  ['/resumes', 'Resumes'],
  ['/profile', 'Profile'],
  ['/jobs', 'Job descriptions'],
  ['/sessions', 'Sessions'],
  ['/prep', 'Prep'],
  ['/desktop', 'Desktop'],
  ['/settings', 'Settings']
] as const;

/** Nav + account footer. On narrow screens it collapses behind a Menu button that closes on navigation. */
export default function Sidebar({ email }: { email: string }) {
  const path = usePathname();
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === path;
  return (
    <>
      <button type="button" className="btn btn-sm nav-toggle" aria-expanded={open} aria-controls="app-menu" onClick={() => setOpenAt(open ? null : path)}>
        {open ? 'Close' : 'Menu'}
      </button>
      <div className="sidebar-body" id="app-menu" data-open={open}>
        <nav className="nav" aria-label="Main">
          {ITEMS.map(([href, label]) => (
            <Link key={href} href={href} aria-current={path === href || path.startsWith(`${href}/`) ? 'page' : undefined}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="meta email">{email}</span>
          <div className="row-between">
            <ThemeSwitch />
            <LogoutButton />
          </div>
        </div>
      </div>
    </>
  );
}
