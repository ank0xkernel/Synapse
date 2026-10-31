'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

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

export default function Sidebar() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {ITEMS.map(([href, label]) => (
        <Link key={href} href={href} aria-current={path === href || path.startsWith(`${href}/`) ? 'page' : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
