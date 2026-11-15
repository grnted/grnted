// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A bounded GIF decoder for the flash test's animated-image check (2.3.1, `flashMotion.ts`): it plays
// the frames onto a canvas the way a browser does (disposal, transparency, interlacing) and hands each
// composed frame, with how long it shows, to the caller. Linear time in what it decodes, and every
// cost is capped (bytes, canvas size, frames, pixels decoded), so a huge GIF cannot stall the test.
// Engine core: no Node-only imports.

export const GIF_LIMITS = {
  /** Largest file read. */
  maxBytes: 4_000_000,
  /** Largest canvas (width × height). */
  maxCanvas: 600_000,
  /** Most frames decoded. */
  maxFrames: 200,
  /** Most canvas pixels handed out over all frames (each composed frame costs width × height). */
  maxWork: 12_000_000,
} as const;

export type GifLimits = { [K in keyof typeof GIF_LIMITS]: number };

export interface GifFrame {
  width: number;
  height: number;
  /** The composed canvas, RGBA, width × height (alpha 0 or 255). Reused: copy what you keep. */
  rgba: Uint8Array;
  /** How long the frame shows, in ms (browsers show delays of 10 ms or less as 100 ms). */
  delayMs: number;
}

export interface GifResult {
  width: number;
  height: number;
  /** Frames handed out. */
  frames: number;
  /** How often the animation repeats: 0 forever, n more times, null when it plays once (no loop block). */
  loops: number | null;
  /** A limit stopped the decoding before the end of the file. */
  truncated: boolean;
}

/** True when the bytes start like a GIF. */
export function isGif(bytes: Uint8Array): boolean {
  return bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61;
}

/** Throws on a file it cannot read: not a GIF, cut short, too large. */
export function decodeGif(bytes: Uint8Array, onFrame: (f: GifFrame) => void, limits: GifLimits = GIF_LIMITS): GifResult {
  if (!isGif(bytes)) throw new Error('not a GIF image');
  if (bytes.length > limits.maxBytes) throw new Error('GIF too large');
  let at = 6;
  const need = (n: number) => { if (at + n > bytes.length) throw new Error('GIF cut short'); };
  need(7);
  const width = bytes[at]! | (bytes[at + 1]! << 8);
  const height = bytes[at + 2]! | (bytes[at + 3]! << 8);
  const flags = bytes[at + 4]!;
  const bgIndex = bytes[at + 5]!;
  void bgIndex;
  at += 7;
  if (!width || !height) throw new Error('GIF with no size');
  if (width * height > limits.maxCanvas) throw new Error('GIF canvas too large');
  let globalTable: Uint8Array | null = null;
  if (flags & 0x80) {
    const n = 3 * (1 << ((flags & 7) + 1));
    need(n);
    globalTable = bytes.subarray(at, at + n);
    at += n;
  }
  const canvas = new Uint8Array(width * height * 4);
  let saved: Uint8Array | null = null;
  // The graphic control extension for the next image.
  let delayCs = 0;
  let transparent = -1;
  let disposal = 0;
  let loops: number | null = null;
  let frames = 0;
  let work = 0;
  let truncated = false;
  // The previous frame's disposal, applied before the next one is drawn.
  let pending: { disposal: number; x: number; y: number; w: number; h: number } | null = null;
  // LZW tables, allocated once.
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const stack = new Uint8Array(4097);

  /** Concatenated data sub-blocks from `at`; moves `at` past the terminator. */
  const subBlocks = (): Uint8Array => {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      need(1);
      const len = bytes[at]!;
      at++;
      if (!len) break;
      need(len);
      parts.push(bytes.subarray(at, at + len));
      total += len;
      at += len;
    }
    if (parts.length === 1) return parts[0]!;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };

  while (at < bytes.length) {
    const kind = bytes[at]!;
    at++;
    if (kind === 0x3b) break; // trailer
    if (kind === 0x21) {
      need(1);
      const label = bytes[at]!;
      at++;
      if (label === 0xf9) {
        const data = subBlocks();
        if (data.length >= 4) {
          disposal = (data[0]! >> 2) & 7;
          delayCs = data[1]! | (data[2]! << 8);
          transparent = data[0]! & 1 ? data[3]! : -1;
        }
      } else if (label === 0xff) {
        const data = subBlocks();
        const id = String.fromCharCode(...data.subarray(0, 11));
        if ((id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0') && data.length >= 14 && data[11] === 1) loops = data[12]! | (data[13]! << 8);
      } else {
        subBlocks();
      }
      continue;
    }
    if (kind !== 0x2c) throw new Error('damaged GIF');
    need(9);
    const fx = bytes[at]! | (bytes[at + 1]! << 8);
    const fy = bytes[at + 2]! | (bytes[at + 3]! << 8);
    const fw = bytes[at + 4]! | (bytes[at + 5]! << 8);
    const fh = bytes[at + 6]! | (bytes[at + 7]! << 8);
    const iflags = bytes[at + 8]!;
    at += 9;
    let table = globalTable;
    if (iflags & 0x80) {
      const n = 3 * (1 << ((iflags & 7) + 1));
      need(n);
      table = bytes.subarray(at, at + n);
      at += n;
    }
    need(1);
    const minCode = bytes[at]!;
    at++;
    const data = subBlocks();
    if (frames >= limits.maxFrames || work + width * height > limits.maxWork) { truncated = true; break; }
    if (minCode < 2 || minCode > 11) throw new Error('damaged GIF');
    // A frame's pixels cost decoding even off the canvas: one larger than the canvas limit is refused.
    if (fw * fh > limits.maxCanvas) throw new Error('GIF frame too large');

    // The previous frame's disposal.
    if (pending) {
      if (pending.disposal === 2) clearRect(canvas, width, height, pending.x, pending.y, pending.w, pending.h);
      else if (pending.disposal === 3 && saved) canvas.set(saved);
    }
    if (disposal === 3) {
      saved ??= new Uint8Array(canvas.length);
      saved.set(canvas);
    }

    // LZW decode straight onto the canvas, row by row (interlaced rows in GIF's four passes).
    const interlaced = (iflags & 0x40) !== 0;
    const total = fw * fh;
    let written = 0;
    let row = 0;
    let pass = 0;
    let col = 0;
    const passStart = [0, 4, 2, 1];
    const passStep = [8, 8, 4, 2];
    const put = (index: number) => {
      if (written >= total) return;
      const x = fx + col;
      const y = fy + row;
      if (index !== transparent && table && x < width && y < height && index * 3 + 2 < table.length) {
        const p = (y * width + x) * 4;
        canvas[p] = table[index * 3]!;
        canvas[p + 1] = table[index * 3 + 1]!;
        canvas[p + 2] = table[index * 3 + 2]!;
        canvas[p + 3] = 255;
      }
      written++;
      if (++col >= fw) {
        col = 0;
        if (!interlaced) row++;
        else {
          row += passStep[pass]!;
          while (row >= fh && pass < 3) { pass++; row = passStart[pass]!; }
        }
      }
    };
    const clear = 1 << minCode;
    const end = clear + 1;
    let size = minCode + 1;
    let mask = (1 << size) - 1;
    let next = end + 1;
    let prev = -1;
    let bits = 0;
    let acc = 0;
    for (let i = 0; i < clear; i++) { prefix[i] = 0; suffix[i] = i; first[i] = i; }
    for (let i = 0; i < data.length && written < total; i++) {
      acc |= data[i]! << bits;
      bits += 8;
      while (bits >= size && written < total) {
        const code = acc & mask;
        acc >>>= size;
        bits -= size;
        if (code === clear) {
          size = minCode + 1;
          mask = (1 << size) - 1;
          next = end + 1;
          prev = -1;
          continue;
        }
        if (code === end) { i = data.length; break; }
        if (prev === -1) {
          if (code >= clear) throw new Error('damaged GIF');
          put(code);
          prev = code;
          continue;
        }
        let cur = code;
        let sp = 0;
        if (code >= next) {
          if (code > next) throw new Error('damaged GIF');
          // KwKwK: the previous string plus its own first byte.
          stack[sp++] = first[prev]!;
          cur = prev;
        }
        while (cur >= clear) {
          stack[sp++] = suffix[cur]!;
          cur = prefix[cur]!;
        }
        stack[sp++] = cur;
        const head = cur;
        while (sp > 0) put(stack[--sp]!);
        if (next < 4096) {
          prefix[next] = prev;
          suffix[next] = head;
          first[next] = first[prev]!;
          next++;
          if (next > mask && size < 12) { size++; mask = (1 << size) - 1; }
        }
        prev = code;
      }
    }
    frames++;
    work += width * height;
    onFrame({ width, height, rgba: canvas, delayMs: delayCs <= 1 ? 100 : delayCs * 10 });
    pending = { disposal, x: fx, y: fy, w: fw, h: fh };
    delayCs = 0;
    transparent = -1;
    disposal = 0;
  }
  return { width, height, frames, loops, truncated };
}

function clearRect(canvas: Uint8Array, width: number, height: number, x: number, y: number, w: number, h: number): void {
  const x1 = Math.min(width, x + w);
  const y1 = Math.min(height, y + h);
  for (let yy = y; yy < y1; yy++) canvas.fill(0, (yy * width + x) * 4, (yy * width + x1) * 4);
}
