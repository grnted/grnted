// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A minimal GIF writer for tests (the flash check's GIF decoder, the animated-GIF fixture): 8-bit
// codes with a clear code every 120 pixels, so the code size never grows. Palette of up to 128 colours.
export interface GifEncodeFrame {
  /** Palette indexes, width × height of the frame (or of `rect`). */
  pixels: Uint8Array;
  delayCs: number;
  rect?: { x: number; y: number; w: number; h: number };
  transparent?: number;
  disposal?: number;
  interlaced?: boolean;
}

export function encodeGif(width: number, height: number, palette: readonly [number, number, number][], frames: readonly GifEncodeFrame[], loops: number | null = 0): Uint8Array {
  const out: number[] = [];
  const u16 = (n: number) => { out.push(n & 255, (n >> 8) & 255); };
  out.push(...[...'GIF89a'].map((c) => c.charCodeAt(0)));
  u16(width); u16(height);
  out.push(0xf6, 0, 0); // global table of 128 colours
  for (let i = 0; i < 128; i++) out.push(...(palette[i] ?? [0, 0, 0]));
  if (loops !== null) {
    out.push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1);
    u16(loops);
    out.push(0);
  }
  for (const f of frames) {
    const r = f.rect ?? { x: 0, y: 0, w: width, h: height };
    out.push(0x21, 0xf9, 4, ((f.disposal ?? 0) << 2) | (f.transparent !== undefined ? 1 : 0));
    u16(f.delayCs);
    out.push(f.transparent ?? 0, 0);
    out.push(0x2c);
    u16(r.x); u16(r.y); u16(r.w); u16(r.h);
    out.push(f.interlaced ? 0x40 : 0);
    // Rows in file order (interlaced: the four passes).
    let order = Array.from({ length: r.h }, (_, i) => i);
    if (f.interlaced) order = [0, 4, 2, 1].flatMap((s, k) => order.filter((y) => y >= s && (y - s) % [8, 8, 4, 2][k]! === 0));
    const codes: number[] = [128];
    let n = 0;
    for (const y of order) {
      for (let x = 0; x < r.w; x++) {
        if (n === 120) { codes.push(128); n = 0; }
        codes.push(f.pixels[y * r.w + x]!);
        n++;
      }
    }
    codes.push(129);
    out.push(7); // minimum code size: 8-bit codes
    for (let i = 0; i < codes.length; i += 255) {
      const chunk = codes.slice(i, i + 255);
      out.push(chunk.length, ...chunk);
    }
    out.push(0);
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}
