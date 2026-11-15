// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// An early-out before pdf.js reads a file (the command line, and the hosted PDF reader Worker): pdf.js inflates
// a stream synchronously with no bound on its decoded size. Every FlateDecode and LZWDecode stream that is not
// an image is inflated here first, asynchronously, counting the output and keeping none of it; a file past
// `limit` bytes in all, or past its time, is refused before pdf.js sees it. It is NOT the safety boundary: it
// finds streams by keyword (with their direct /Length when they have one), and it skips other filters,
// chains, image streams and data with junk inside its /Length (which workerd refuses whole), so a crafted
// file can pass it (Grok r1, feat/pdf-cap-by-tier). The hosted checker's boundary is the reader Worker
// (apps/pdf-reader): its own isolate, memory and CPU limit, so a file that gets past this check ends only
// that invocation. Engine core: no Node-only imports (DecompressionStream runs in Node, Workers, browsers).

/** The most a PDF's non-image streams may decode to, in all (the isolate has 128 MB). */
export const PDF_DECODED_LIMIT = 64 * 1024 * 1024;

/** Streams looked at per file; a file with more is judged on the first ones (each one costs a little). */
const MAX_STREAMS = 20_000;
/** How far back from `stream` the stream's dictionary is looked for. */
const DICT_WINDOW = 4096;

export type DecodedVerdict = 'ok' | 'over' | 'time';

/**
 * The file's image streams, found on the way (pdf.ts): where each one's /Width and /Height numbers and its
 * /Filter key are, so the reader can hand pdf.js a copy in which every image is one pixel with no filter.
 * pdf.js then decodes no image at all, whatever the file says its images are, and the page's drawing
 * operators keep their places and sizes. `unknown`: that cannot be relied on (a size that is not a plain
 * number in the image's own dictionary, an inline image too large to ignore, a stream this scan cannot
 * look inside, or more streams than it reads), so the page's images are not measured.
 */
export interface PdfImageScan {
  count: number;
  unknown: boolean;
  spans: { at: number; length: number; kind: 'number' | 'key' }[];
}

/**
 * A copy of the file in which every image stream found by the scan is one pixel with no filter (same length,
 * every other byte the same): its /Width and /Height read "1", and its /Filter key reads "/Filtex", a key no
 * reader knows. pdf.js then builds each image from its first bytes and decodes nothing.
 */
export function withoutImagePixels(bytes: Uint8Array, scan: PdfImageScan): Uint8Array {
  const copy = bytes.slice();
  for (const sp of scan.spans) {
    if (sp.kind === 'number') { copy[sp.at] = 0x31; copy.fill(0x20, sp.at + 1, sp.at + sp.length); }
    else copy[sp.at + sp.length - 1] = 0x78;
  }
  return copy;
}

/**
 * Inline images (in a page's content, not streams of their own) are the only images pdf.js still decodes: each
 * may have this many pixels at most (a larger one is dropped unread), and a file with more of them than
 * `PDF_INLINE_IMAGES` is not measured at all. Worst case 64 x 65,536 pixels: 16 MB decoded.
 */
export const PDF_INLINE_IMAGE_PIXELS = 65_536;
export const PDF_INLINE_IMAGES = 64;

/**
 * Inflates each FlateDecode and LZWDecode stream that is not an image, counting the bytes, until the total
 * passes `limit` ('over') or `deadline` (epoch ms) passes ('time'). A stream whose first filter is another
 * one is not judged, and an encrypted stream fails to inflate at once. A stream that is not valid
 * compressed data counts what it gave before the error. An early-out only (see the top of this file).
 */
export async function decodedSizeWithin(bytes: Uint8Array, limit: number = PDF_DECODED_LIMIT, deadline: number = Infinity, images?: PdfImageScan): Promise<DecodedVerdict> {
  // windows-1252 maps every byte to one UTF-16 unit, so string offsets are byte offsets.
  const s = new TextDecoder('windows-1252').decode(bytes);
  let total = 0;
  let streams = 0;
  // One look through all page content for inline images (their count is the file's).
  const inline = images ? scanInline(images) : undefined;
  for (let at = s.indexOf('stream'); at >= 0 && streams < MAX_STREAMS; at = s.indexOf('stream', at + 6)) {
    if (at >= 3 && s.startsWith('end', at - 3)) continue; // `endstream`
    let start = at + 6;
    if (s[start] === '\r') start++;
    if (s[start] !== '\n' && s[start - 1] !== '\r') continue; // not the keyword (a word in text)
    if (s[start] === '\n') start++;
    const keyword = at;
    const head = s.slice(Math.max(0, at - DICT_WINDOW), at);
    const dict = head.slice(Math.max(head.lastIndexOf(' obj'), head.lastIndexOf('\nobj'), head.lastIndexOf('\robj'), 0));
    // A dictionary that does not begin where its object begins (it is longer than the window, or "obj" is a
    // word inside it) may be an image this scan does not see as one.
    if (images && !/^[ \n\r]obj\s*<</.test(dict)) images.unknown = true;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    streams++;
    // The next search starts past this stream's data, which is never searched for keywords.
    at = end;
    if (/\/Subtype\s*\/Image\b/.test(dict)) {
      if (images) noteImage(images, dict, keyword - dict.length);
      continue;
    }
    const filter = firstFilter(dict);
    if (images && inline) {
      // Page content is looked through for inline images: as it is, inflated (below), or with its ASCII
      // wrappers taken off first (ASCII85 and hex, with or without Flate after them: a common producer's
      // default). Content this scan cannot look inside may hold an inline image of any size.
      const chain = filterChain(dict);
      const ascii = chain.findIndex((f) => f !== 'a85' && f !== 'ahx');
      const wrappers = ascii < 0 ? chain : chain.slice(0, ascii);
      const rest = ascii < 0 ? [] : chain.slice(ascii);
      if (!chain.length) { inline.next(); inline.feed(bytes.subarray(start, end)); }
      else if (wrappers.length && (!rest.length || (rest.length === 1 && rest[0] === 'flate'))) {
        let data: Uint8Array | null = bytes.subarray(start, end);
        for (const f of wrappers) data = data && (f === 'a85' ? ascii85Decoded(data, limit) : asciiHexDecoded(data));
        if (!data) images.unknown = true;
        else {
          inline.next();
          if (!rest.length) inline.feed(data);
          else {
            const left = limit - total;
            const got = await inflatedSize(data, left, deadline, (chunk) => inline.feed(chunk));
            if (got === 'time') return 'time';
            if (got > left) images.unknown = true; // not looked through to its end
          }
        }
      } else if (!(chain.length === 1 && chain[0] === 'flate')) images.unknown = true;
    }
    if (filter !== 'flate' && filter !== 'lzw') continue;
    // The data: its direct /Length when that fits before `endstream`, else up to the end of line before it.
    // (Workers' DecompressionStream refuses a stream with bytes after its end, dropping what it inflated.)
    const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    let stop = end;
    if (len && start + Number(len[1]) <= end) stop = start + Number(len[1]);
    else {
      if (bytes[stop - 1] === 0x0a) stop--;
      if (bytes[stop - 1] === 0x0d) stop--;
    }
    const data = bytes.subarray(start, stop);
    const left = limit - total;
    inline?.next();
    const got = filter === 'flate' ? await inflatedSize(data, left, deadline, inline ? (chunk) => inline.feed(chunk) : undefined) : lzwDecodedSize(data, left);
    if (got === 'time') return 'time';
    total += got;
    if (total > limit) return 'over';
    if (Date.now() > deadline) return 'time';
  }
  if (images && streams >= MAX_STREAMS) images.unknown = true;
  return 'ok';
}

/** One image stream's dictionary (`dict`, which starts at byte `base` of the file): its size numbers and its filter key. */
function noteImage(images: PdfImageScan, dict: string, base: number): void {
  images.count++;
  let sizes = 0;
  for (const m of dict.matchAll(/\/(Width|Height)(\s+)(\d+)(?!\s+\d+\s+R)(?=[\s/>\]])/g)) {
    images.spans.push({ at: base + m.index + 1 + m[1]!.length + m[2]!.length, length: m[3]!.length, kind: 'number' });
    sizes++;
  }
  // Exactly one width and one height, written as numbers; and no /F key, which pdf.js reads as the filter too.
  if (sizes !== 2 || /\/F[\s/\[]/.test(dict)) images.unknown = true;
  for (const m of dict.matchAll(/\/Filter(?=[\s/\[])/g)) images.spans.push({ at: base + m.index, length: 7, kind: 'key' });
}

/**
 * Looks through decoded page content, piece by piece, for inline images (`BI … ID`): one larger than
 * `PDF_INLINE_IMAGE_PIXELS` (pdf.js is told to drop those undecoded, so a page that has one draws something
 * the reader will not see), or more than `PDF_INLINE_IMAGES` of them in the file (pdf.js decodes each).
 */
function scanInline(images: PdfImageScan): { next(): void; feed(chunk: Uint8Array): void } {
  const decoder = new TextDecoder('windows-1252');
  let carry = '';
  let seen = 0;
  const feed = (chunk: Uint8Array): void => {
    if (images.unknown) return;
    const fresh = decoder.decode(chunk);
    // Every inline image begins with the operator BI: counted on the new text alone, so none is counted twice.
    for (const _ of `${carry.slice(-3)}${fresh}`.matchAll(/(?:^|[\s>\]])BI(?=\s)/g)) if (++seen > PDF_INLINE_IMAGES) { images.unknown = true; return; }
    const text = carry + fresh;
    for (const m of text.matchAll(/(?:^|[\s>\]])BI\s([\s\S]{0,400}?)\sID(?=\s)/g)) {
      const w = /\/W(?:idth)?\s+(\d+)/.exec(m[1]!);
      const h = /\/H(?:eight)?\s+(\d+)/.exec(m[1]!);
      if (w && h && Number(w[1]) * Number(h[1]) > PDF_INLINE_IMAGE_PIXELS) images.unknown = true;
    }
    carry = text.slice(-512);
  };
  // `next`: another stream begins (nothing is carried over from the one before).
  return { next: () => { carry = ''; }, feed };
}

/** The stream's filters in the order they are undone (the first is applied to the stored bytes); [] for none. */
function filterChain(dict: string): ('flate' | 'lzw' | 'a85' | 'ahx' | 'other')[] {
  const m = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict);
  // A filter given some other way (a reference to another object) is one this scan cannot read.
  if (!m) return /\/Filter[\s/\[]/.test(dict) ? ['other'] : [];
  return (m[1]!.match(/\/[A-Za-z0-9]+/g) ?? []).map((n) => {
    const name = n.slice(1);
    if (name === 'FlateDecode' || name === 'Fl') return 'flate';
    if (name === 'LZWDecode' || name === 'LZW') return 'lzw';
    if (name === 'ASCII85Decode' || name === 'A85') return 'a85';
    if (name === 'ASCIIHexDecode' || name === 'AHx') return 'ahx';
    return 'other';
  });
}

/**
 * ASCII85 as PDF writes it, decoded: five characters "!" to "u" are four bytes, "z" is four zero bytes, spaces,
 * tabs and line ends are skipped, "~>" ends it (an "<~" at the start is skipped). null when it is not valid
 * ASCII85 (any other byte, a NUL or a form feed included) or would be longer than `max` bytes.
 */
export function ascii85Decoded(data: Uint8Array, max: number): Uint8Array | null {
  let zs = 0;
  for (let i = 0; i < data.length; i++) if (data[i] === 0x7a) zs++;
  const size = Math.ceil(((data.length - zs) * 4) / 5) + zs * 4 + 4;
  if (size > max) return null;
  const out = new Uint8Array(size);
  let n = 0;
  let group = 0;
  let count = 0;
  let i = 0;
  if (data[0] === 0x3c && data[1] === 0x7e) i = 2;
  for (; i < data.length; i++) {
    const c = data[i]!;
    if (c === 0x7e) break; // "~>"
    // Only the white space every reader skips: a NUL or a form feed is read differently by different readers,
    // so data that has one is not relied on.
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) continue;
    if (c === 0x7a) {
      if (count) return null;
      n += 4; // four zero bytes (the array is zeroed)
      continue;
    }
    if (c < 0x21 || c > 0x75) return null;
    group = group * 85 + (c - 0x21);
    if (++count === 5) {
      if (group > 0xffffffff) return null;
      out[n++] = group >>> 24; out[n++] = (group >>> 16) & 255; out[n++] = (group >>> 8) & 255; out[n++] = group & 255;
      group = 0;
      count = 0;
    }
  }
  if (count === 1) return null;
  if (count > 1) {
    // A last group of 2 to 4 characters is 1 to 3 bytes: padded with "u", the padding's bytes dropped.
    for (let k = count; k < 5; k++) group = group * 85 + 84;
    if (group > 0xffffffff) return null;
    const last = [group >>> 24, (group >>> 16) & 255, (group >>> 8) & 255];
    for (let k = 0; k < count - 1; k++) out[n++] = last[k]!;
  }
  return out.subarray(0, n);
}

/** ASCII hex as PDF writes it, decoded: pairs of hex digits, spaces, tabs and line ends skipped, ">" ends it. null when it has any other byte. */
export function asciiHexDecoded(data: Uint8Array): Uint8Array | null {
  const out = new Uint8Array((data.length >> 1) + 1);
  let n = 0;
  let high = -1;
  for (let i = 0; i < data.length; i++) {
    const c = data[i]!;
    if (c === 0x3e) break; // ">"
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) continue;
    const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;
    if (v < 0) return null;
    if (high < 0) high = v;
    else { out[n++] = (high << 4) | v; high = -1; }
  }
  if (high >= 0) out[n++] = high << 4; // an odd last digit is followed by 0
  return out.subarray(0, n);
}

/** The stream's first filter: the one applied to the stored bytes. */
function firstFilter(dict: string): 'flate' | 'lzw' | 'other' | 'none' {
  const m = /\/Filter\s*(\[\s*)?\/([A-Za-z0-9]+)/.exec(dict);
  if (!m) return 'none';
  const name = m[2]!;
  if (name === 'FlateDecode' || name === 'Fl') return 'flate';
  if (name === 'LZWDecode' || name === 'LZW') return 'lzw';
  return 'other';
}

/** Input fed to the inflater at a time: output is counted as it comes, before any junk at the end is seen. */
const INFLATE_CHUNK = 16 * 1024;

/**
 * Bytes a zlib stream inflates to, reading at most `max + 1` of them (none kept). The input goes in small
 * pieces: the Workers runtime refuses a whole stream with junk after its end before giving any output
 * (Node gives the output, then the error), and a stream must count what it gives either way.
 */
async function inflatedSize(data: Uint8Array, max: number, deadline: number, onChunk?: (chunk: Uint8Array) => void): Promise<number | 'time'> {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  let n = 0;
  let done = false;
  const feed = (async () => {
    try {
      for (let i = 0; i < data.length && !done; i += INFLATE_CHUNK) await writer.write(data.slice(i, i + INFLATE_CHUNK));
      if (!done) await writer.close();
    } catch {
      // damaged, or the reading side stopped: what came out counts
    }
  })();
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) return n;
      n += r.value.byteLength;
      onChunk?.(r.value);
      if (n > max) return n;
      if (Date.now() > deadline) return 'time';
    }
  } catch {
    return n; // damaged or followed by junk: what it gave counts
  } finally {
    done = true;
    reader.cancel().catch(() => {});
    writer.abort().catch(() => {});
    await feed.catch(() => {});
  }
}

/**
 * Bytes an LZW stream (PDF's variant: 9 to 12-bit codes, most significant bit first, clear 256, end 257,
 * the code width growing one code early) decodes to, counted from the code table's lengths alone (no output
 * is built), stopping past `max`.
 */
export function lzwDecodedSize(data: Uint8Array, max: number): number {
  const len = new Uint32Array(4096);
  for (let i = 0; i < 256; i++) len[i] = 1;
  let next = 258;
  let width = 9;
  let prev = -1;
  let n = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < data.length; i++) {
    buf = ((buf << 8) | data[i]!) & 0xffffff;
    bits += 8;
    while (bits >= width) {
      const code = (buf >>> (bits - width)) & ((1 << width) - 1);
      bits -= width;
      if (code === 256) {
        next = 258;
        width = 9;
        prev = -1;
        continue;
      }
      if (code === 257) return n;
      let size: number;
      if (code < next && (code < 256 || code >= 258)) size = len[code]!;
      else if (code === next && prev >= 0) size = len[prev]! + 1;
      else return n; // not valid LZW data: pdf.js stops there too
      n += size;
      if (n > max) return n;
      if (prev >= 0 && next < 4096) len[next++] = len[prev]! + 1;
      prev = code;
      if (next + 1 >= 1 << width && width < 12) width++;
    }
  }
  return n;
}
