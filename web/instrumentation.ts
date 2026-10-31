// Runs once when the server starts (not during `next build`), so a bad production environment fails fast.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validateEnv } = await import('./lib/env');
    validateEnv();
  }
}
