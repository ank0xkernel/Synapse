import 'server-only';

/** Names only, never values. Throws one error listing everything that is wrong. */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  const problems: string[] = [];
  if (!env.DATABASE_URL) problems.push('DATABASE_URL is required');
  if (env.VERCEL_ENV === 'production') {
    if (!env.BLOB_READ_WRITE_TOKEN) problems.push('BLOB_READ_WRITE_TOKEN is required when VERCEL_ENV=production (resume PDFs over 4.5 MB cannot go through Functions)');
    if (env.INSECURE_COOKIES) problems.push('INSECURE_COOKIES must not be set when VERCEL_ENV=production');
  }
  if (problems.length) throw new Error(`Invalid environment: ${problems.join('; ')}`);
}
