import type { DeviceToken } from '@/lib/data';

/** Whether a linked desktop can still read the account. Revoked and expired tokens cannot. */
export type Access = 'active' | 'expired' | 'revoked';
export const accessOf = (t: DeviceToken, now: number): Access =>
  t.revoked_at ? 'revoked' : t.expires_at.getTime() < now ? 'expired' : 'active';

/**
 * What a desktop has cached compared with the context the website would send now.
 * `unknown`: there is nothing to send, so no comparison is possible.
 */
export type Sync = 'latest' | 'older' | 'never' | 'unknown';
export const syncOf = (t: DeviceToken, currentVersion: string | null): Sync =>
  !currentVersion ? 'unknown' : !t.context_version ? 'never' : t.context_version === currentVersion ? 'latest' : 'older';

/** The best state across the account's active desktops, for one summary line. */
export function bestSync(tokens: DeviceToken[], currentVersion: string | null, now: number): Sync | 'none' {
  const active = tokens.filter((t) => accessOf(t, now) === 'active');
  if (active.length === 0) return 'none';
  const states = active.map((t) => syncOf(t, currentVersion));
  for (const s of ['latest', 'older', 'never'] as const) if (states.includes(s)) return s;
  return 'unknown';
}
