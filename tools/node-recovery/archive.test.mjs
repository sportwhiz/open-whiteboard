import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptArchive, decryptArchive, encodeCell, decodeCell } from './archive.mjs';
test('encrypted archives round-trip without exposing stored credentials', () => {
  const key = randomBytes(32).toString('base64url');
  const source = { privateKey: 'sensitive-installation-key', binary: encodeCell(Buffer.from([0, 255, 42])), date: encodeCell(new Date('2026-10-17T01:02:03.456Z')) };
  const bytes = encryptArchive(source, key);
  assert.equal(bytes.includes(Buffer.from(source.privateKey)), false);
  const decoded = decryptArchive(bytes, key);
  assert.deepEqual(decoded, source);
  assert.deepEqual(decodeCell(decoded.binary), Buffer.from([0, 255, 42]));
  assert.equal(decodeCell(decoded.date).toISOString(), '2026-10-17T01:02:03.456Z');
  assert.notDeepEqual(encryptArchive(source, key), bytes, 'Every backup uses a new nonce');
  for (const offset of [0, 16, bytes.length - 1]) {
    const altered = Buffer.from(bytes); altered[offset] ^= 1;
    assert.throws(() => decryptArchive(altered, key));
  }
  assert.throws(() => decryptArchive(bytes, randomBytes(32).toString('base64url')));
  assert.throws(() => decryptArchive(bytes.subarray(0, -1), key));
  assert.throws(() => encryptArchive(source, 'short'));
});
test('database decoder rejects malformed typed values', () => {
  for (const value of [{ binary: '%%%bad' }, { date: '2026-02-30T00:00:00.000Z' }, { binary: 'YQ==', extra: true }, ['a'], false, Infinity]) assert.throws(() => decodeCell(value));
  for (const value of [null, '18446744073709551615', 123.5]) assert.equal(decodeCell(encodeCell(value)), value);
});
