import type { DeviceToken } from '@/lib/data';
import { fmtDateTime } from '@/lib/format';
import ConfirmButton from './ConfirmButton';

/** Devices that can read this account's context. Revoking takes effect on their next request. */
export default function LinkedDesktops({ tokens }: { tokens: DeviceToken[] }) {
  const now = Date.now();
  if (tokens.length === 0) return <p className="muted">No desktops linked yet.</p>;
  return (
    <ul className="list">
      {tokens.map((t) => {
        const expired = !t.revoked_at && t.expires_at.getTime() < now;
        return (
          <li key={t.id}>
            <div className="grow stack" style={{ gap: 2 }}>
              <span className="title">{t.name}</span>
              <span className="meta">
                {t.linked_via === 'pkce' ? 'Browser sign-in' : 'Manual token'} ({t.prefix}...) - last used {t.last_used_at ? fmtDateTime(t.last_used_at) : 'never'}
              </span>
              <span>
                {t.revoked_at ? <span className="status" data-tone="danger">Revoked</span>
                  : expired ? <span className="status" data-tone="warning">Expired</span>
                  : <span className="status" data-tone="positive" style={{ whiteSpace: 'normal' }}>Active until {fmtDateTime(t.expires_at)}</span>}
              </span>
            </div>
            {!t.revoked_at && <ConfirmButton small label="Revoke" title={`Revoke "${t.name}"?`} body="This desktop loses access immediately and must sign in again." url={`/api/device-tokens/${t.id}`} />}
          </li>
        );
      })}
    </ul>
  );
}
