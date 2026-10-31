'use client';
import { call } from '@/lib/client';

export default function LogoutButton() {
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={async () => {
        await call('POST', '/api/auth/logout', {});
        window.location.assign('/');
      }}
    >
      Sign out
    </button>
  );
}
