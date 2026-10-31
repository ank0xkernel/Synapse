import { z } from 'zod';
import { api, readJson } from '@/lib/http';
import { signup } from '@/lib/auth';

const body = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().max(100).default(''),
  password: z.string().min(10, 'must be at least 10 characters').max(200)
});

export const POST = api(async (req) => {
  const b = await readJson(req, body, 8 * 1024);
  const user = await signup(b.email, b.name, b.password);
  return { user: { id: user.id, email: user.email, name: user.name } };
});
