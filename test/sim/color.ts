// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Colour arithmetic for the contrast generators: WCAG relative luminance and contrast ratio on 8-bit
// sRGB, and solving for the 8-bit colour that lands on a ratio. Pure.
export type Rgb = readonly [number, number, number];

const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
export const luminance = (c: Rgb) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
export function ratio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
export const hexOf = (c: Rgb) => `#${c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as unknown as Rgb;

/**
 * The colour on the line from `dark` to `light` (256 steps, 8-bit) whose ratio against `against` is
 * closest to `target` from the side `side` says: 'above' (≥ target + margin) or 'below' (< target −
 * margin). Exact ratios are computed on the chosen 8-bit colour, so the side is guaranteed.
 */
export function solve(against: Rgb, dark: Rgb, light: Rgb, target: number, side: 'above' | 'below', margin = 0.005): { color: Rgb; ratio: number } {
  let best: { color: Rgb; ratio: number } | null = null;
  for (let i = 0; i <= 1024; i++) {
    const c = mix(dark, light, i / 1024);
    const r = ratio(c, against);
    const ok = side === 'above' ? r >= target + margin : r < target - margin;
    if (!ok) continue;
    if (!best || Math.abs(r - target) < Math.abs(best.ratio - target)) best = { color: c, ratio: r };
  }
  if (!best) throw new Error(`color: no colour from ${hexOf(dark)} to ${hexOf(light)} is ${side} ${target} against ${hexOf(against)}`);
  return best;
}

/** Text colours the generators draw from (dark hues), and light page backgrounds. */
export const DARK_HUES: readonly Rgb[] = [[0, 0, 0], [0, 40, 110], [110, 0, 20], [0, 70, 30], [60, 30, 90], [80, 50, 0]];
export const LIGHT_BGS: readonly Rgb[] = [[255, 255, 255], [250, 246, 238], [238, 245, 252], [245, 252, 245], [255, 250, 240]];
