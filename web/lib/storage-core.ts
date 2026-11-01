// Pure storage rules with no server-only imports, so node can unit-test this file directly.

export const MAX_PDF_BYTES = 8 * 1024 * 1024;

export class StorageError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`);

export const newKey = (userId: string, rand: string) => `resumes/${userId}/${rand}.pdf`;

/** A key is the caller's only if it is exactly resumes/<their id>/<uuid>.pdf. */
export function isOwnKey(userId: string, key: unknown): key is string {
  return typeof key === 'string' && UUID_RE.test(userId) && new RegExp(`^resumes/${userId}/${UUID}\\.pdf$`).test(key);
}

/** Constraints for the one-shot upload token. Throws when the requested pathname is not the caller's. */
export function uploadConstraints(userId: string, pathname: string) {
  if (!isOwnKey(userId, pathname)) throw new StorageError(403, 'Upload path is not allowed');
  return {
    allowedContentTypes: ['application/pdf'],
    maximumSizeInBytes: MAX_PDF_BYTES,
    addRandomSuffix: false,
    allowOverwrite: false,
    validUntil: Date.now() + 10 * 60 * 1000
  };
}

export function assertPdfBytes(buf: Buffer) {
  if (buf.length === 0) throw new StorageError(400, 'The file is empty');
  if (buf.length > MAX_PDF_BYTES) throw new StorageError(413, 'File is larger than 8 MB');
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new StorageError(415, 'That file is not a valid PDF');
}

export interface FinalizeDeps<R> {
  read(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
  /** Extracts text; must throw an error carrying a `status` on failure. */
  extract(buf: Buffer): Promise<{ text: string; method: 'pdf' | 'ocr' }>;
  /** Saves in one transaction. The same key twice must resolve to the same row. */
  save(p: { key: string; bytes: number; sha256: string; text: string; method: 'pdf' | 'ocr' }): Promise<R>;
}

/**
 * Verifies ownership, bytes and text of an already-uploaded private object, then saves it.
 * A validation or extraction failure deletes the object, so a rejected upload leaves no orphan.
 * A database failure keeps it, so the client can retry finalize.
 */
export async function finalizeUpload<R>(userId: string, key: unknown, deps: FinalizeDeps<R>, sha256: (b: Buffer) => string): Promise<R> {
  if (!isOwnKey(userId, key)) throw new StorageError(403, 'Upload path is not allowed');
  const buf = await deps.read(key);
  if (!buf) throw new StorageError(404, 'Upload not found. Upload the file again.');
  let ex: { text: string; method: 'pdf' | 'ocr' };
  try {
    assertPdfBytes(buf);
    ex = await deps.extract(buf);
  } catch (err) {
    await deps.remove(key).catch(() => {});
    throw err;
  }
  return deps.save({ key, bytes: buf.length, sha256: sha256(buf), text: ex.text, method: ex.method });
}
