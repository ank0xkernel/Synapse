import 'server-only';
import zlib from 'node:zlib';

/** Thrown for anything that is not a readable .docx. The caller maps it to a 415/422. */
export class DocxError extends Error {}

// A resume's document.xml is tens of KB. The cap stops a zip bomb from inflating to gigabytes.
const MAX_XML_BYTES = 20 * 1024 * 1024;

/**
 * Text of a Word (.docx) file: paragraphs as lines, table cells separated by tabs.
 * A .docx is a ZIP archive; only word/document.xml is read, through the central directory.
 */
export function docxText(buf: Buffer): string {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new DocxError('not a zip');
  const xml = readEntry(buf, 'word/document.xml').toString('utf8');
  return xmlToText(xml);
}

function readEntry(buf: Buffer, name: string): Buffer {
  // End of central directory: last 22 bytes plus an optional comment of up to 65535 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new DocxError('no zip directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new DocxError('bad zip directory');
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entryName = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (entryName !== name) continue;

    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new DocxError('bad zip entry');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressed);
    if (data.length !== compressed) throw new DocxError('truncated zip entry');
    if (method === 0) return data;
    if (method === 8) {
      try {
        return zlib.inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES });
      } catch {
        throw new DocxError('could not inflate document.xml');
      }
    }
    throw new DocxError(`unsupported compression ${method}`);
  }
  throw new DocxError('no word/document.xml');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function xmlToText(xml: string): string {
  return xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:(br|cr)\b[^>]*\/>/g, '\n')
    // A table row becomes one line: cells joined by tabs. Each cell's last paragraph does not break the line.
    .replace(/<\/w:p>\s*<\/w:tc>/g, '</w:tc>')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, '\n');
}
