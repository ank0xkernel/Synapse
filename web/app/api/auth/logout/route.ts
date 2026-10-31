import { api } from '@/lib/http';
import { logout } from '@/lib/auth';

export const POST = api(async () => {
  await logout();
  return {};
});
