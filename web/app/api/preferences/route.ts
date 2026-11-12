import { api, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { getSettings, saveSettings, settingsInput } from '@/lib/conversations';

export const dynamic = 'force-dynamic';

export const GET = api(async () => getSettings((await requireUser()).id));

export const PUT = api(async (req) => {
  const user = await requireUser();
  return saveSettings(user.id, await readJson(req, settingsInput, 4 * 1024));
});
