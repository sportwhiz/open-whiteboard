import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

export const MAX_ARCHIVE = 128 * 1024 * 1024;
export const MAX_PLAIN = 256 * 1024 * 1024;
const magic = Buffer.from('OWB-RECOVERY-1\n');
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function recoveryKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('A 32-byte recovery key is required.');
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== value) throw new Error('Invalid recovery key.');
  return key;
}
export function encryptArchive(snapshot, key) {
  const plain = Buffer.from(JSON.stringify(snapshot));
  if (plain.length > MAX_PLAIN) throw new Error('Installation exceeds the recovery tool size limit.');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', recoveryKey(key), nonce);
  cipher.setAAD(magic);
  const encrypted = Buffer.concat([cipher.update(gzipSync(plain)), cipher.final()]);
  const result = Buffer.concat([magic, nonce, cipher.getAuthTag(), encrypted]);
  if (result.length > MAX_ARCHIVE) throw new Error('Archive exceeds the recovery tool size limit.');
  return result;
}
export function decryptArchive(bytes, key) {
  if (bytes.length > MAX_ARCHIVE || bytes.length < magic.length + 29 || !bytes.subarray(0, magic.length).equals(magic)) throw new Error('Invalid recovery archive.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', recoveryKey(key), bytes.subarray(magic.length, magic.length + 12));
    decipher.setAAD(magic);
    decipher.setAuthTag(bytes.subarray(magic.length + 12, magic.length + 28));
    const compressed = Buffer.concat([decipher.update(bytes.subarray(magic.length + 28)), decipher.final()]);
    return JSON.parse(gunzipSync(compressed, { maxOutputLength: MAX_PLAIN }).toString());
  } catch { throw new Error('The archive or recovery key is invalid.'); }
}
export function encodeCell(value) {
  if (Buffer.isBuffer(value)) return { binary: value.toString('base64') };
  if (value instanceof Date) return { date: value.toISOString() };
  if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new Error('Unsupported database value.');
}
export function decodeCell(value) {
  if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (value && typeof value === 'object' && Object.keys(value).length === 1) {
    if (typeof value.binary === 'string') {
      const bytes = Buffer.from(value.binary, 'base64');
      if (bytes.toString('base64') === value.binary) return bytes;
    }
    if (typeof value.date === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.date)) {
      const date = new Date(value.date);
      if (Number.isFinite(date.getTime()) && date.toISOString() === value.date) return date;
    }
  }
  throw new Error('Invalid archived database value.');
}
