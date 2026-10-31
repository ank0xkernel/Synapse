import 'server-only';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { validateEnv } from './env';

// One pool per server instance. Cached on globalThis so dev hot reload does not leak pools.
const g = globalThis as unknown as { __synapsePool?: Pool };

function pool(): Pool {
  if (!g.__synapsePool) {
    validateEnv();
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    // TLS comes from the URL (Neon URLs carry sslmode=require); nothing is forced here, so local Postgres works.
    g.__synapsePool = new Pool({
      connectionString: url,
      // Serverless: keep few connections per instance; Neon's pooled endpoint fans in.
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 20_000,
      application_name: 'synapse-web',
      allowExitOnIdle: true
    });
    // An idle client dropped by the server must not crash the process.
    g.__synapsePool.on('error', (err) => console.error(JSON.stringify({ level: 'error', msg: 'pg idle client error', err: err.message })));
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

/** Runs fn in one transaction on one connection. Commits on return, rolls back on throw. */
export async function withTx<T>(fn: (q: <R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) => Promise<R[]>) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(async (text, params = []) => (await client.query(text, params)).rows as never);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function ping(): Promise<boolean> {
  try {
    await pool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
