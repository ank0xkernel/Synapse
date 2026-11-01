'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Icon, { type IconName } from './Icon';
import LogoutButton from './LogoutButton';
import ThemeSwitch from './ThemeSwitch';
import s from './shell/shell.module.css';

type Item = readonly [href: string, label: string, icon: IconName];
const GROUPS: readonly { id: string; label?: string; items: readonly Item[] }[] = [
  { id: 'home', items: [['/dashboard', 'Dashboard', 'dashboard']] },
  { id: 'material', label: 'Your material', items: [['/resumes', 'Resumes', 'resume'], ['/profile', 'Profile', 'profile'], ['/jobs', 'Job descriptions', 'job']] },
  { id: 'interviews', label: 'Interviews', items: [['/sessions', 'Sessions', 'session'], ['/prep', 'Prep', 'prep']] },
  { id: 'app', label: 'Desktop app', items: [['/desktop', 'Desktop', 'desktop'], ['/settings', 'Settings', 'settings']] }
];

const initials = (name: string, email: string) =>
  (name.trim() ? name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('') : email[0] ?? '?').toUpperCase();

/** Nav + account footer. Below 900px it collapses behind a Menu button and closes on navigation or Escape. */
export default function Sidebar({ email, name }: { email: string; name: string }) {
  const path = usePathname();
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === path;
  return (
    <>
      <button
        type="button"
        className={`btn btn-sm ${s.toggle}`}
        aria-expanded={open}
        aria-controls="app-menu"
        onClick={() => setOpenAt(open ? null : path)}
      >
        {open ? <Icon name="close" size={16} /> : <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3.5 6h13M3.5 10h13M3.5 14h13" /></svg>}
        {open ? 'Close' : 'Menu'}
      </button>
      <div
        className={s.body}
        id="app-menu"
        data-open={open}
        onKeyDown={(e) => { if (e.key === 'Escape' && open) setOpenAt(null); }}
      >
        <nav className={s.nav} aria-label="Main">
          {GROUPS.map((g) => (
            <div key={g.id} className={s.group}>
              {g.label && <p className={s.groupLabel} id={`nav-${g.id}`}>{g.label}</p>}
              <ul aria-labelledby={g.label ? `nav-${g.id}` : undefined}>
                {g.items.map(([href, label, icon]) => (
                  <li key={href}>
                    <Link href={href} className={s.link} aria-current={path === href || path.startsWith(`${href}/`) ? 'page' : undefined}>
                      <Icon name={icon} size={18} className={s.icon} />
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className={s.foot}>
          <div className={s.account}>
            <span className={s.avatar} aria-hidden="true">{initials(name, email)}</span>
            <span className={s.who}>
              {name.trim() && <span className={s.name}>{name}</span>}
              <span className={s.email}>{email}</span>
            </span>
          </div>
          <div className={s.footRow}>
            <ThemeSwitch />
            <LogoutButton />
          </div>
        </div>
      </div>
    </>
  );
}
