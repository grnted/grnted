// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Reads a store-only zip (zip.ts) back: every entry's name and text, with its CRC checked against zlib's.
import * as zlib from 'node:zlib';

export function unzipText(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, string>();
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('no end of central directory');
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  for (let k = 0; k < count; k++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('bad central directory entry');
    if (view.getUint16(at + 10, true) !== 0) throw new Error('not stored');
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error('bad local header');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if ((zlib.crc32(data) >>> 0) !== crc) throw new Error(`CRC mismatch: ${name}`);
    out.set(name, new TextDecoder('utf-8', { fatal: true }).decode(data));
    at += 46 + nameLen + extra + comment;
  }
  return out;
}
