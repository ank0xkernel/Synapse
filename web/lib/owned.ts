import 'server-only';
import { one } from './db';
import { ApiError } from './http';

/** A referenced row must belong to the caller. Otherwise 400, without saying whether it exists for someone else. */
export async function assertOwnedOrNull(table: 'resumes' | 'job_descriptions', uid: string, id: string | null) {
  if (id === null) return;
  if (!(await one(`SELECT 1 FROM ${table} WHERE user_id = $1 AND id = $2`, [uid, id]))) {
    throw new ApiError(400, `Unknown ${table === 'resumes' ? 'resume' : 'job description'}`);
  }
}
