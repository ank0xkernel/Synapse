import 'server-only';
import { Pool, type QueryResultRow } from 'pg';

// One pool per server instance. Cached on globalThis so dev hot reload does not leak pools.
const g = globalThis as unknown as { __synapsePool?: Pool };

function pool(): Pool {
  if (!g.__synapsePool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    g.__synapsePool = new Pool({
      connectionString: url,
      // Serverless: keep few connections per instance; Neon's pooler fans in.
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000
    });
  }
  return g.__synapsePool;
}

/** Parameterized queries only. Callers must pass user_id from the server session. */
export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pool().query<T>(text, params)).rows;
}

export async function one<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
  return (await query<T>(text, params))[0] ?? null;
}
