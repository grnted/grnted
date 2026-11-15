// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 1.4.3 Contrast (Minimum): axe's color-contrast rule with the text-contrast probe (axe's undecided
// text), read from the report's criteria table as a customer sees it. The answer by construction:
// - one subject paragraph per page whose colour is solved on 8-bit sRGB for a ratio just below, at or
//   just above the threshold (4.4 / 4.5 / 4.6 for normal text, 2.9 / 3.0 / 3.1 for large), the exact
//   ratio computed on the chosen colours (WCAG luminance) and the truth taken from that, never from the
//   nominal number; everything else on the page is far above every threshold;
// - large text is 24 px and up, or bold (700) at 14 pt (18.67 px) and up: the sizes straddle both
//   lines (23 px / 24 px normal, 18.5 px / 18.67 px bold);
// - the background is a solid colour, a gradient (the text's worst point decides: both ends are on the
//   same side of the threshold), a CSS background image or an image laid behind the text;
// - fonts: the system sans-serif, Archivo and IBM Plex Mono (real web fonts from the engine's assets);
// - in flight: the text fades in, changes colour or slides in for 2.5 s from load (the settled state is
//   what people read, so it decides);
// - inactive controls (disabled, aria-disabled, a disabled fieldset) are exempt at any contrast.
import { readFileSync } from 'node:fs';
import { textContrastProbe } from '../../../src/probes/textContrast.js';
import { DARK_HUES, LIGHT_BGS, hexOf, mix, ratio, solve, type Rgb } from '../color.js';
import { applyHazard, filler, hash, parts, pick, render, rng, solidPng, webFont } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'font-swap', 'late-mount', 'sticky-header', 'cookie-banner', 'smooth-scroll', 'lazy-images', 'animation-in-flight', 'scroll-snap', 'reduced-motion-honored', 'none'];

export const SIZES = [
  { id: '16px', px: 16, weight: 400 },
  { id: '18.5px-bold', px: 18.5, weight: 700 },
  { id: '18.67px-bold', px: 18.67, weight: 700 },
  { id: '23px', px: 23, weight: 400 },
  { id: '24px', px: 24, weight: 400 },
] as const;
/** WCAG large-scale text: at least 18 pt, or 14 pt bold (1 pt = 4/3 px). */
export const isLarge = (px: number, weight: number) => px >= 24 || (px >= 18.666 && weight >= 700);

export const NOMINALS = [2.9, 3.0, 3.1, 4.4, 4.5, 4.6] as const;
const BGS = ['solid', 'gradient', 'bg-image', 'img-behind'] as const;
const FONTS = ['system', 'archivo', 'mono'] as const;
type Bg = (typeof BGS)[number];
type Font = (typeof FONTS)[number];

let mono: Uint8Array | null = null;
const monoFont = () => (mono ??= new Uint8Array(readFileSync(new URL('../../../assets/fonts/ibm-plex-mono-400-latin.woff2', import.meta.url))));

const FONT_CSS: Record<Font, string> = {
  system: 'font-family: Arial, Helvetica, sans-serif;',
  archivo: "font-family: 'Archivo', Arial, sans-serif;",
  mono: "font-family: 'Plex Mono', monospace;",
};

/** An exact-threshold nominal (3.0, 4.5) is solved above it, so it passes; the others land on it. */
const sideOf = (n: number): 'above' | 'nearest' => (n === 3 || n === 4.5 ? 'above' : 'nearest');

function solveText(bg: Rgb, hue: Rgb, nominal: number): { fg: Rgb; ratio: number } {
  const side = sideOf(nominal);
  if (side === 'above') {
    const s = solve(bg, hue, bg, nominal, 'above');
    return { fg: s.color, ratio: s.ratio };
  }
  const a = solve(bg, hue, bg, nominal, 'above', 0);
  const b = solve(bg, hue, bg, nominal, 'below', 0);
  const s = Math.abs(a.ratio - nominal) <= Math.abs(b.ratio - nominal) ? a : b;
  return { fg: s.color, ratio: s.ratio };
}

export interface TextParams {
  nominal: number;
  size: (typeof SIZES)[number];
  bg: Bg;
  font: Font;
  hazard: Hazard;
  /** 'fade' | 'color' | 'slide': the text animates in for 2.5 s from load. */
  flight?: 'fade' | 'color' | 'slide';
}

export function textCase(p: TextParams, seed: number): SimCase {
  const id = `text-contrast/${p.nominal}/${p.size.id}/${p.bg}/${p.font}/${p.hazard}${p.flight ? `/flight-${p.flight}` : ''}`;
  const r = rng(hash(id) ^ seed);
  const base = pick(r, LIGHT_BGS.slice(1));
  const hue = pick(r, DARK_HUES);
  const { fg, ratio: actual } = solveText(base, hue, p.nominal);
  const large = isLarge(p.size.px, p.size.weight);
  const threshold = large ? 3 : 4.5;
  let worst = actual;
  const css: string[] = [];
  const files: Record<string, Uint8Array> = {};
  const routes: Record<string, { body: Uint8Array; type: string }> = {};
  let bgCss = `background: ${hexOf(base)};`;
  let behind = '';
  if (p.bg === 'gradient') {
    // The other end: lighter (toward white) for a passing ratio, darker for a failing one, so both ends
    // are on the same side of the threshold.
    const fails = actual < threshold;
    const other = fails ? solve(fg, base, mix(base, fg, 0.6), actual - 0.15, 'above', 0).color : mix(base, [255, 255, 255], 0.7);
    const ro = ratio(fg, other);
    worst = Math.min(actual, ro);
    if ((worst < threshold) !== (actual < threshold) || (Math.max(actual, ro) < threshold) !== (actual < threshold)) throw new Error(`text-contrast: gradient crosses the threshold in ${id}`);
    bgCss = `background: linear-gradient(90deg, ${hexOf(base)}, ${hexOf(other)});`;
  } else if (p.bg === 'bg-image') {
    files['/bg.png'] = solidPng(32, 32, [base[0], base[1], base[2]]);
    bgCss = 'background: url(/bg.png) repeat;';
  } else if (p.bg === 'img-behind') {
    files['/bg.png'] = solidPng(32, 32, [base[0], base[1], base[2]]);
    behind = '<img class="behind" src="/bg.png" alt="">';
    bgCss = 'position: relative;';
    css.push('.subject-wrap .behind { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0; } .subject-wrap .subject { position: relative; z-index: 1; }');
  }
  if (p.font === 'archivo') {
    files['/fonts/archivo.woff2'] = webFont();
    css.push("@font-face { font-family: 'Archivo'; src: url('/fonts/archivo.woff2') format('woff2'); font-weight: 100 900; }");
  } else if (p.font === 'mono') {
    files['/fonts/mono.woff2'] = monoFont();
    css.push("@font-face { font-family: 'Plex Mono'; src: url('/fonts/mono.woff2') format('woff2'); font-weight: 400; }");
  }
  const flight = p.flight === 'fade' ? 'animation: sim-fade 2.5s ease-out both;' : p.flight === 'color' ? 'animation: sim-color 2.5s ease-out both;' : p.flight === 'slide' ? 'animation: sim-slide-in 2.5s ease-out both;' : '';
  if (p.flight) {
    css.push(`@keyframes sim-fade { from { opacity: 0; } to { opacity: 1; } } @keyframes sim-color { from { color: ${hexOf(mix(fg, base, 0.8))}; } to { color: ${hexOf(fg)}; } } @keyframes sim-slide-in { from { transform: translateY(40px); opacity: 0.2; } to { transform: none; opacity: 1; } }`);
  }
  const words = filler(r, 1, 12).replace(/^<p>|<\/p>\n$/g, '');
  css.push(`.subject-wrap { ${bgCss} padding: 24px; margin: 24px 0; max-width: 720px; }
.subject { margin: 0; color: ${hexOf(fg)}; font-size: ${p.size.px}px; font-weight: ${p.size.weight}; line-height: 1.5; ${FONT_CSS[p.font]} ${flight} }`);
  const body = `<p>Notices from the city, updated weekly.</p>
<div class="subject-wrap">${behind}<p class="subject" id="subject">${words}</p></div>
${filler(r, 4)}`;
  const pg = parts('Public notices', body, css);
  Object.assign(pg.files, files);
  Object.assign(pg.routes, routes);
  const hz = applyHazard(pg, p.hazard, r);
  const fails = worst < threshold;
  return {
    id, test: 'text-contrast', hazard: p.hazard,
    params: { nominal: p.nominal, actual: Math.round(worst * 1000) / 1000, size: p.size.id, large, bg: p.bg, font: p.font, fg: hexOf(fg), ...(p.flight ? { flight: p.flight } : {}), ...(hz.mountMs ? { mountMs: hz.mountMs } : {}) },
    site: render(pg),
    expect: { '1.4.3': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: `${large ? 'large' : 'normal'} text (${p.size.id}) at ${worst.toFixed(3)}:1, needs ${threshold}:1`,
  };
}

/** Inactive controls with low-contrast text (exempt) and the same controls active (fail). */
export function controlCase(kind: 'disabled' | 'aria-disabled' | 'fieldset', active: boolean, nominal: number, hazard: Hazard, seed: number): SimCase {
  const id = `text-contrast/control/${kind}/${active ? 'active' : 'inactive'}/${nominal}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const { fg, ratio: actual } = solveText([240, 240, 240], pick(r, DARK_HUES), nominal);
  const off = active ? '' : kind === 'disabled' ? ' disabled' : kind === 'aria-disabled' ? ' aria-disabled="true"' : '';
  const button = `<button type="button" class="btn"${off}>Send the form</button>`;
  const ctl = kind === 'fieldset' ? `<fieldset${active ? '' : ' disabled'}><legend>Send</legend>${button}</fieldset>` : button;
  const css = [`.btn { font: 16px/1.4 Arial, sans-serif; padding: 8px 16px; color: ${hexOf(fg)}; background: #f0f0f0; border: 2px solid #1b1b1b; border-radius: 4px; } .btn:disabled, .btn[aria-disabled="true"] { color: ${hexOf(fg)}; }`];
  const pg = parts('Contact the city', `<p>Write to us with any question.</p>${ctl}${filler(r, 3)}`, css);
  applyHazard(pg, hazard, r);
  const fails = active && actual < 4.5;
  return {
    id, test: 'text-contrast', hazard,
    params: { control: kind, active, nominal, actual: Math.round(actual * 1000) / 1000, fg: hexOf(fg) },
    site: render(pg),
    expect: { '1.4.3': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: active ? `an active button's text at ${actual.toFixed(3)}:1 (needs 4.5:1)` : `an inactive control's text (exempt) at ${actual.toFixed(3)}:1`,
  };
}

export function textContrastCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const bg of BGS) {
    for (const size of SIZES) {
      for (const nominal of NOMINALS) {
        out.push(textCase({ nominal, size, bg, font: FONTS[i % FONTS.length]!, hazard: HAZARDS[i % HAZARDS.length]! }, seed));
        i++;
      }
    }
  }
  for (const flight of ['fade', 'color', 'slide'] as const) {
    for (const nominal of [3.0, 4.4, 4.6, 7] as const) {
      for (const bg of ['solid', 'gradient'] as const) {
        out.push(textCase({ nominal, size: SIZES[0], bg, font: 'system', hazard: 'none', flight }, seed));
      }
    }
  }
  // A page-load pop-up over the page (the 2026-11-07 audit's cause 6): the page behind it decides.
  for (const size of [SIZES[0], SIZES[4]]) {
    for (const nominal of NOMINALS) out.push(textCase({ nominal, size, bg: 'solid', font: 'system', hazard: 'load-popup' }, seed));
  }
  let j = 0;
  for (const kind of ['disabled', 'aria-disabled', 'fieldset'] as const) {
    for (const active of [false, true]) {
      for (const nominal of [2.5, 3.5]) out.push(controlCase(kind, active, nominal, HAZARDS[j++ % HAZARDS.length]!, seed));
    }
  }
  return out;
}

export const textContrastTest: SimTest = {
  id: 'text-contrast',
  criteria: ['1.4.3'],
  probes: () => [textContrastProbe],
  full: false,
  read: 'criterion',
  capMs: 90_000,
  cases: textContrastCases,
};
