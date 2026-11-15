// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Reading Office Open XML files (.docx, .xlsx, .pptx: a zip of XML parts) with hard limits and no
// external binaries. Engine core: no Node-only imports (inflate is the web-standard
// DecompressionStream, as in probes/pixels.ts).
//
// Hostile input stays bounded and linear:
// - the zip's central directory is read once, with every offset and length checked against the file;
//   ZIP64, encrypted entries and methods other than stored/deflate are refused per entry;
// - an entry is inflated a small piece at a time and reading stops at `maxEntryBytes` (the header's
//   size is never trusted), and all entries together stop at `maxTotalBytes` (decompression bombs);
// - the XML scanner moves forward only (indexOf), so a tag that never closes ends the scan instead of
//   being searched for again from every '<'. Attributes are read by a hand-written loop, not a regex.

/** Why a file could not be read. `legacy`: an Office binary file (.doc/.xls/.ppt); `encrypted`: it needs a password to open. */
export class OoxmlError extends Error {
  constructor(message: string, readonly kind: 'unreadable' | 'legacy' | 'encrypted' | 'time' = 'unreadable') {
    super(message);
  }
}

export interface ZipLimits {
  /** Entries in the central directory. */
  maxEntries: number;
  /** Bytes inflated from one entry; past it the entry is cut (`ZipText.cut`). */
  maxEntryBytes: number;
  /** Bytes inflated from all entries together; past it entries are cut or not read. */
  maxTotalBytes: number;
  /** Epoch ms after which reading stops with an `OoxmlError` of kind 'time'. */
  deadline: number;
}

interface CentralEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  localOffset: number;
}

/** One entry's text: `cut` when a limit stopped it (the text is its start). */
export interface ZipText {
  text: string;
  cut: boolean;
}

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ENCRYPTED_STREAM = 'EncryptedPackage';

export const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6);
export const isOle = (b: Uint8Array) => b.length >= OLE_MAGIC.length && OLE_MAGIC.every((v, i) => b[i] === v);

/**
 * An OLE compound file is either an Office binary file (.doc/.xls/.ppt) or an encrypted OOXML file,
 * whose directory names an `EncryptedPackage` stream (directory names are UTF-16LE). One forward search.
 */
export function oleIsEncrypted(b: Uint8Array): boolean {
  const pattern: number[] = [];
  for (const ch of ENCRYPTED_STREAM) pattern.push(ch.charCodeAt(0), 0);
  const first = pattern[0]!;
  for (let i = b.indexOf(first); i >= 0 && i <= b.length - pattern.length; i = b.indexOf(first, i + 1)) {
    let k = 1;
    while (k < pattern.length && b[i + k] === pattern[k]) k++;
    if (k === pattern.length) return true;
  }
  return false;
}

/** The zip's entries by name. Throws `OoxmlError` for a file that is not a readable zip. */
export function zipEntries(bytes: Uint8Array, limits: Pick<ZipLimits, 'maxEntries'>): Map<string, CentralEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad = () => new OoxmlError('Could not read the file (it is damaged or not a Word, Excel or PowerPoint file)');
  // The end record sits in the last 22 + 65,535 bytes (its comment is at most 65,535 bytes).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad();
  const count = view.getUint16(eocd + 10, true);
  const dirSize = view.getUint32(eocd + 12, true);
  const dirOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || dirOffset === 0xffffffff) throw new OoxmlError('Could not read the file (ZIP64 is not supported)');
  if (count > limits.maxEntries) throw new OoxmlError(`Could not read the file (more than ${limits.maxEntries} parts)`);
  if (dirOffset + dirSize > eocd) throw bad();
  const dec = new TextDecoder('utf-8');
  const out = new Map<string, CentralEntry>();
  let at = dirOffset;
  for (let k = 0; k < count; k++) {
    if (at + 46 > eocd || view.getUint32(at, true) !== 0x02014b50) throw bad();
    const nameLen = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    if (at + 46 + nameLen > eocd) throw bad();
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    const entry: CentralEntry = {
      name, flags: view.getUint16(at + 8, true), method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true), localOffset: view.getUint32(at + 42, true),
    };
    if (!out.has(name)) out.set(name, entry);
    at += 46 + nameLen + extra + comment;
  }
  return out;
}

/** Pieces fed to the inflater: small, so one piece can never inflate past the caps by much (deflate tops out near 1:1032). */
const FEED = 1024;

/**
 * Inflates one entry to text, at most `max` bytes (the rest is never inflated). Stored and deflate
 * entries only; anything else, an encrypted entry or a bad local header throws.
 */
async function inflateEntry(bytes: Uint8Array, e: CentralEntry, max: number, deadline: number): Promise<{ data: Uint8Array; cut: boolean }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad = () => new OoxmlError(`Could not read the part ${e.name.slice(0, 80)}`);
  if (e.flags & 1) throw bad(); // an encrypted entry
  if (e.localOffset + 30 > bytes.length || view.getUint32(e.localOffset, true) !== 0x04034b50) throw bad();
  const start = e.localOffset + 30 + view.getUint16(e.localOffset + 26, true) + view.getUint16(e.localOffset + 28, true);
  const end = start + e.compressedSize;
  if (end > bytes.length) throw bad();
  const raw = bytes.subarray(start, end);
  if (e.method === 0) return raw.length > max ? { data: raw.slice(0, max), cut: true } : { data: raw.slice(), cut: false };
  if (e.method !== 8) throw bad();

  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  let stop = false;
  const feeding = (async () => {
    for (let i = 0; i < raw.length && !stop; i += FEED) await writer.write(raw.slice(i, i + FEED));
    if (!stop) await writer.close();
  })().catch(() => {});
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cut = false;
  try {
    for (;;) {
      if (Date.now() > deadline) throw new OoxmlError('Reading it took too long', 'time');
      const { done, value } = await reader.read();
      if (done) break;
      const room = max - total;
      if (value.length >= room) {
        if (value.length > room || !(await atEnd(reader))) cut = true;
        chunks.push(value.subarray(0, room));
        total += room;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } catch (err) {
    if (err instanceof OoxmlError) throw err;
    throw bad();
  } finally {
    stop = true;
    reader.cancel().catch(() => {});
    writer.abort().catch(() => {});
    await feeding;
  }
  const data = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    data.set(c, p);
    p += c.length;
  }
  return { data, cut };
}

/** Whether the inflater has nothing more (read once more: a chunk ending exactly at the cap). */
async function atEnd(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<boolean> {
  try {
    const next = await reader.read();
    return next.done || next.value.length === 0;
  } catch {
    return false;
  }
}

/** Reads the parts of one zip as text, sharing the total budget. */
export class ZipReader {
  private readonly entries: Map<string, CentralEntry>;
  private used = 0;
  /** A part was cut or left unread by a limit. */
  cut = false;

  constructor(private readonly bytes: Uint8Array, private readonly limits: ZipLimits) {
    this.entries = zipEntries(bytes, limits);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** The part as text, or undefined when it is missing or the total budget is spent. Throws for a damaged part. */
  async text(name: string): Promise<ZipText | undefined> {
    const e = this.entries.get(name);
    if (!e) return undefined;
    if (Date.now() > this.limits.deadline) throw new OoxmlError('Reading it took too long', 'time');
    const room = Math.min(this.limits.maxEntryBytes, this.limits.maxTotalBytes - this.used);
    if (room <= 0) {
      this.cut = true;
      return undefined;
    }
    const { data, cut } = await inflateEntry(this.bytes, e, room, this.limits.deadline);
    this.used += data.length;
    if (cut) this.cut = true;
    return { text: new TextDecoder('utf-8').decode(data), cut };
  }
}

// XML --------------------------------------------------------------------------------------------

export interface XmlHandler {
  /** A start tag (or an empty-element tag, `selfClosing`). `name` is the local name (no prefix). */
  open(name: string, tag: string, selfClosing: boolean): void;
  close(name: string): void;
  /** Character data between tags, entities not decoded. */
  text?(raw: string): void;
}

const localName = (qname: string) => {
  const i = qname.indexOf(':');
  return i >= 0 ? qname.slice(i + 1) : qname;
};

/** The tag's name: up to the first whitespace, '/' or '>'. */
function tagName(tag: string, from: number): string {
  let i = from;
  while (i < tag.length) {
    const c = tag.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 47 || c === 62) break;
    i++;
  }
  return tag.slice(from, i);
}

/** Checks the time box every this many tags. */
const DEADLINE_EVERY = 4096;

/**
 * Walks the XML once, calling `h` for each tag and text run. Comments, processing instructions and
 * DOCTYPEs are skipped; CDATA is text. A tag that never closes ends the walk. Linear in the input.
 */
export function scanXml(xml: string, h: XmlHandler, deadline = Infinity): void {
  let i = 0;
  let n = 0;
  const len = xml.length;
  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      if (h.text && i < len) h.text(xml.slice(i));
      return;
    }
    if (h.text && lt > i) h.text(xml.slice(i, lt));
    if (++n % DEADLINE_EVERY === 0 && Date.now() > deadline) throw new OoxmlError('Reading it took too long', 'time');
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end < 0) return;
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end < 0) return;
      if (h.text) h.text(xml.slice(lt + 9, end).replace(/&/g, '&amp;').replace(/</g, '&lt;'));
      i = end + 3;
      continue;
    }
    const gt = xml.indexOf('>', lt + 1);
    if (gt < 0) return;
    const c = xml.charCodeAt(lt + 1);
    if (c === 63 /* ? */ || c === 33 /* ! */) {
      i = gt + 1;
      continue;
    }
    if (c === 47 /* / */) {
      h.close(localName(tagName(xml, lt + 2)));
    } else {
      const tag = xml.slice(lt, gt + 1);
      const name = localName(tagName(tag, 1));
      const selfClosing = xml.charCodeAt(gt - 1) === 47;
      h.open(name, tag, selfClosing);
      if (selfClosing) h.close(name);
    }
    i = gt + 1;
  }
}

/**
 * An attribute's value from a start tag, by local name (`val` matches `w:val` and `val`); entities
 * decoded. Undefined when absent. One forward pass over the tag.
 */
export function attr(tag: string, name: string): string | undefined {
  let i = 1;
  const len = tag.length;
  // Skip the element name.
  while (i < len && !isSpace(tag.charCodeAt(i)) && tag[i] !== '>' && tag[i] !== '/') i++;
  while (i < len) {
    while (i < len && (isSpace(tag.charCodeAt(i)) || tag[i] === '/')) i++;
    const start = i;
    while (i < len && tag[i] !== '=' && !isSpace(tag.charCodeAt(i)) && tag[i] !== '>' && tag[i] !== '/') i++;
    const qname = tag.slice(start, i);
    while (i < len && isSpace(tag.charCodeAt(i))) i++;
    if (tag[i] !== '=') {
      if (i === start) i++; // a stray character: move on
      continue;
    }
    i++;
    while (i < len && isSpace(tag.charCodeAt(i))) i++;
    const q = tag[i];
    if (q !== '"' && q !== "'") continue;
    const end = tag.indexOf(q, i + 1);
    if (end < 0) return undefined;
    if (localName(qname) === name) return decodeEntities(tag.slice(i + 1, end));
    i = end + 1;
  }
  return undefined;
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML entities to text (the five named ones and numeric references); anything else is left as written. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/gi, (m, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[ref] ?? m;
  });
}

/** A boolean OOXML property: present means on, unless its val is false, 0 or off. */
export function onOff(tag: string): boolean {
  const v = attr(tag, 'val');
  return v === undefined || !/^(?:false|0|off|none)$/i.test(v);
}
