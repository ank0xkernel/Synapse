import { z } from 'zod';
import { api, readJson } from '@/lib/http';
import { login } from '@/lib/auth';

const body = z.object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(1).max(200) });

export const POST = api(async (req) => {
  const b = await readJson(req, body, 8 * 1024);
  const user = await login(b.email, b.password);
  return { user: { id: user.id, email: user.email, name: user.name } };
});
