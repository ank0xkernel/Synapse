import type { DeviceToken } from '@/lib/data';
import { fmtDateTime } from '@/lib/format';
import ConfirmButton from './ConfirmButton';
import Icon from './Icon';
import { accessOf, syncOf } from './dashboard/sync';
import s from './dashboard/devices.module.css';

/** What this desktop has cached compared with the context the website would send now. */
function SyncState({ token, currentVersion }: { token: DeviceToken; currentVersion: string | null }) {
  const sync = syncOf(token, currentVersion);
  if (sync === 'unknown') return null;
  if (sync === 'never') return <span className="status">Has not fetched your context yet</span>;
  if (sync === 'latest') return <span className="status" data-tone="positive">Has your latest context, fetched {fmtDateTime(token.context_fetched_at!)}</span>;
  return <span className="status" data-tone="warning">Older context. It updates when the app next checks (Refresh, or when listening starts).</span>;
}

/** Devices that can read this account's context. Revoking takes effect on their next request. */
export default function LinkedDesktops({ tokens, currentVersion = null }: { tokens: DeviceToken[]; currentVersion?: string | null }) {
  const now = Date.now();
  if (tokens.length === 0) return <p className={s.none}>No desktops linked yet.</p>;
  return (
    <ul className={s.devices}>
      {tokens.map((t) => {
        const access = accessOf(t, now);
        return (
          <li key={t.id} className={s.device} data-access={access}>
            <span className={s.deviceIcon}><Icon name="desktop" size={20} /></span>
            <div className={s.deviceBody}>
              <p className={s.deviceName}>{t.name}</p>
              <p className={s.deviceMeta}>
                {t.linked_via === 'pkce' ? 'Browser sign-in' : 'Manual token'} · <span className="mono">{t.prefix}…</span> · last used {t.last_used_at ? fmtDateTime(t.last_used_at) : 'never'}
              </p>
              <div className={s.deviceStates}>
                {access === 'revoked' ? <span className="status" data-tone="danger">Revoked</span>
                  : access === 'expired' ? <span className="status" data-tone="warning">Expired</span>
                  : <span className="status" data-tone="positive">Active until {fmtDateTime(t.expires_at)}</span>}
                {access === 'active' && <SyncState token={t} currentVersion={currentVersion} />}
              </div>
            </div>
            {!t.revoked_at && (
              <div className={s.deviceAction}>
                <ConfirmButton small label="Revoke" title={`Revoke "${t.name}"?`} body="This desktop loses access immediately and must sign in again." url={`/api/device-tokens/${t.id}`} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
