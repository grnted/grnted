// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 1.4.12 Text Spacing (probe `text-spacing` and axe `avoid-inline-spacing`, read from the criteria table).
//
// Source of truth. SC 1.4.12: "In content implemented using markup languages that support the following
// text style properties, no loss of content or functionality occurs by setting all of the following and by
// changing no other style property: Line height (line spacing) to at least 1.5 times the font size; Spacing
// following paragraphs to at least 2 times the font size; Letter spacing (tracking) to at least 0.12 times
// the font size; Word spacing to at least 0.16 times the font size." Failure F104: "clipped or overlapped
// content when text spacing is adjusted". ACT rules 24afc2, 9e45ec and 78fd32 ("Important letter / word
// spacing / line height in style attributes is wide enough"): an element with visible text whose
// `letter-spacing` (`word-spacing`, `line-height`) is declared `!important` in its style attribute fails
// unless the value is at least 0.12 (0.16, 1.5 for text that wraps) times its font size; "Any failed
// outcomes: success criterion is not satisfied".
//
// The answer by construction (font 16 px, so the WCAG spacing gives 24 px lines and 32 px between
// paragraphs; lines are set with <br> and do not wrap, so the line count never changes):
// - 'clip': P paragraphs of L lines in a box of fixed height with overflow hidden. Before: P·L·lh +
//   (P−1)·mb px of text (the page's own line height lh and paragraph margin mb), which fits. After:
//   24·P·L + 32·(P−1) px. The box is that height minus `lost` px: lost ≥ 14 (more than half of the last
//   24 px line is gone) fails, lost ≤ −4 (the spaced text fits with room) passes;
// - 'overlap': the same box with overflow visible and a paragraph right under it: the spaced text runs
//   `lost` px into it (fails at ≥ 14, passes at ≤ −4);
// - 'scroll' (overflow auto: the text can be scrolled to) and 'min-height' (the box grows) pass at every
//   `lost`: nothing is lost;
// - 'width': a one-line button or label of M monospace characters (S spaces) in a box of overflow hidden,
//   `M ch + 4 px` wide (the spacing adds 0.12 em per character and 0.16 em per space: at least 11 px
//   cut, fails) or `M ch + (0.12 M + 0.16 S) em + 6 px` (fits, passes);
// - 'inline': a paragraph with `letter-spacing` 0.05 em, `word-spacing` 0.05 em or `line-height` 1.2
//   (wrapping text) `!important` in its style attribute fails (ACT); 0.2 em, 0.3 em, 1.6, the same
//   values without !important, and !important line height on one line that does not wrap pass
//   (78fd32 applies only to text with a soft wrap break).
import { textSpacingProbe } from '../../../src/probes/textSpacing.js';
import { applyHazard, filler, hash, parts, pick, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'animation-in-flight', 'scroll-snap', 'reduced-motion-honored'];
const MONO = "font-family: 'Courier New', Courier, monospace; font-size: 16px;";
const WORDS = 'agenda budget council notice parks permit street water zoning library housing transit'.split(' ');
const line = (r: () => number, n: number) => Array.from({ length: n }, () => pick(r, WORDS)).join(' ');

/** Geometry of a box of paragraphs: P paragraphs of L lines, line height lh px, paragraph margin mb px. */
export interface Geometry { P: number; L: number; lh: number; mb: number }
export const GEOMETRIES: readonly Geometry[] = [
  { P: 1, L: 3, lh: 19, mb: 0 }, { P: 2, L: 2, lh: 20, mb: 4 }, { P: 3, L: 1, lh: 21, mb: 0 }, { P: 3, L: 2, lh: 19, mb: 8 }, { P: 2, L: 3, lh: 22, mb: 0 },
];
/** Text height (px) before and with the WCAG spacing (16 px font: 24 px lines, 32 px after paragraphs). */
export const heights = (g: Geometry) => ({ before: g.P * g.L * g.lh + (g.P - 1) * g.mb, after: 24 * g.P * g.L + 32 * (g.P - 1) });
export const LOSSES = [48, 24, 14, -4, -24] as const;

export type BoxKind = 'clip' | 'overlap' | 'scroll' | 'min-height';

export function boxCase(kind: BoxKind, gi: number, lost: number, hazard: Hazard, seed: number): SimCase | null {
  const g = GEOMETRIES[gi]!;
  const { before, after } = heights(g);
  const H = after - lost;
  if (before > H - 1) return null; // the page's own text must fit before the spacing
  const id = `text-spacing/${kind}/p${g.P}l${g.L}h${g.lh}m${g.mb}/lost${lost}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const paras = Array.from({ length: g.P }, () => `<p>${Array.from({ length: g.L }, () => line(r, 3)).join('<br>')}</p>`).join('');
  const overflow = kind === 'clip' ? 'hidden' : kind === 'scroll' ? 'auto' : 'visible';
  const height = kind === 'min-height' ? `min-height: ${H}px` : `height: ${H}px`;
  const css = [`.box { width: 640px; ${height}; overflow: ${overflow}; ${MONO} line-height: ${g.lh}px; box-sizing: content-box; padding: 0; margin: 0; }
.box p { margin: 0 0 ${g.mb}px; white-space: nowrap; } .box p:last-child { margin-bottom: 0; } .next { margin: 0; ${MONO} line-height: 22px; }`];
  const box = `<div class="box"${kind === 'scroll' ? ' tabindex="0" role="region" aria-label="Notice"' : ''}>${paras}</div>`;
  // 'overlap': the paragraph under the box wraps over several lines (at least 4 of 24 px with the spacing,
  // more than the 48 px that runs out), so every line that runs out of the box lands on one of its lines,
  // not in the gap a paragraph margin would leave.
  const next = kind === 'overlap'
    ? `<p class="next" style="width: 640px; white-space: normal;">${line(r, 40)}.</p>`
    : `<p class="next">${line(r, 4)}.</p>`;
  const pg = parts('Notices', `<p>Notices from the city.</p>${box}${next}${filler(r, 2)}`, css);
  applyHazard(pg, hazard, r);
  const loses = (kind === 'clip' || kind === 'overlap') && lost >= 14;
  return {
    id, test: 'text-spacing', hazard, params: { kind, P: g.P, L: g.L, lh: g.lh, mb: g.mb, before, after, box: H, lost },
    site: render(pg),
    expect: { '1.4.12': loses ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: loses
      ? `spaced text is ${after} px in a ${H} px box with overflow ${overflow}: ${lost} px ${kind === 'clip' ? 'cut off' : 'run into the next paragraph'}`
      : kind === 'scroll' || kind === 'min-height'
        ? `${kind}: the spaced text (${after} px) ${kind === 'scroll' ? 'can be scrolled to' : 'grows the box'}`
        : `spaced text (${after} px) fits the ${H} px box`,
  };
}

export const WIDTH_LENGTHS = [8, 12, 18, 26] as const;
const WIDTH_ELEMENTS = ['button', 'label', 'tab'] as const;

export function widthCase(el: (typeof WIDTH_ELEMENTS)[number], M: number, fit: 'tight' | 'loose', hazard: Hazard, seed: number): SimCase {
  const id = `text-spacing/width/${el}/${M}ch/${fit}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  let text = '';
  while (text.length < M) text += (text ? ' ' : '') + pick(r, WORDS);
  text = text.slice(0, M).replace(/\s+$/, 'x');
  const S = (text.match(/ /g) ?? []).length;
  const width = fit === 'tight' ? `calc(${M}ch + 4px)` : `calc(${M}ch + ${(0.12 * M + 0.16 * S).toFixed(3)}em + 6px)`;
  const box = 'class="w"';
  const html = el === 'button'
    ? `<p><button type="button" ${box}>${text}</button></p>`
    : el === 'label'
      ? `<p><label for="f" ${box}>${text}</label><br><input id="f" type="text" autocomplete="off"></p>`
      : `<div role="tablist" aria-label="Sections"><a role="tab" aria-selected="true" href="#s" id="t1" ${box}>${text}</a></div><div id="s" role="tabpanel" aria-labelledby="t1"><p>${line(r, 6)}.</p></div>`;
  const css = [`.w { display: inline-block; width: ${width}; overflow: hidden; white-space: nowrap; ${MONO} line-height: 24px; padding: 0; border: 0; margin: 0; text-align: left; background: #fff; color: #1b1b1b; box-sizing: content-box; vertical-align: top; }
button.w, a.w { text-decoration: underline; } .w:focus-visible, input:focus-visible { outline: 3px solid #00376d; outline-offset: 2px; } input { font: 16px Arial; }`];
  const pg = parts('Services', `<p>City services.</p>${html}${filler(r, 2)}`, css);
  applyHazard(pg, hazard, r);
  const lostPx = 16 * (0.12 * M + 0.16 * S) - 4;
  const fails = fit === 'tight';
  return {
    id, test: 'text-spacing', hazard, params: { kind: 'width', el, chars: M, spaces: S, fit },
    site: render(pg),
    expect: { '1.4.12': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: fails ? `a ${M}-character ${el} in a box 4 px wider than the text: the spacing adds ${(lostPx + 4).toFixed(1)} px, ${lostPx.toFixed(1)} px cut off` : `the ${el}'s box leaves room for the spaced text`,
  };
}

export const INLINE_KINDS = ['letter-0.05-important', 'word-0.05-important', 'line-1.2-important', 'letter-0.2-important', 'word-0.3-important', 'line-1.6-important', 'letter-0.05', 'line-1.2', 'line-1.2-important-one-line'] as const;
type InlineKind = (typeof INLINE_KINDS)[number];

export function inlineCase(kind: InlineKind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `text-spacing/inline/${kind}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const [prop, value] = kind.split('-') as [string, string];
  const important = kind.includes('important');
  const decl = `${prop === 'letter' ? 'letter-spacing' : prop === 'word' ? 'word-spacing' : 'line-height'}: ${value}${prop === 'line' ? '' : 'em'}${important ? ' !important' : ''}`;
  const oneLine = kind.endsWith('one-line');
  const text = oneLine ? line(r, 3) : filler(r, 1, 60).replace(/<\/?p>|\n/g, '');
  const pg = parts('Notices', `<p>Notices from the city.</p><p class="t" style="${decl}">${text}</p>${filler(r, 2)}`,
    ['.t { max-width: 640px; font: 16px Arial; }']);
  applyHazard(pg, hazard, r);
  const v = Number(value);
  const below = prop === 'letter' ? v < 0.12 : prop === 'word' ? v < 0.16 : v < 1.5;
  const fails = important && below && !oneLine;
  return {
    id, test: 'text-spacing', hazard, params: { kind: 'inline', decl, wraps: !oneLine },
    site: render(pg),
    expect: { '1.4.12': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: fails ? `style="${decl}": an !important value under the WCAG minimum the user cannot override (ACT ${prop === 'letter' ? '24afc2' : prop === 'word' ? '9e45ec' : '78fd32'})`
      : !important ? `style="${decl}" is not !important: user spacing overrides it` : oneLine ? `important line height on text that does not wrap (78fd32 applies only to wrapping text)` : `style="${decl}" is at least the WCAG minimum`,
  };
}

/**
 * ACT-shaped inline declarations in px on 16 px text (the computed value against 0.12 / 0.16 / 1.5 times
 * the font size), and an !important letter spacing on a wrapper with no text of its own (ACT 24afc2
 * applies only to elements with visible text node children; the paragraph inside takes the user's
 * spacing, since its own value is not important): fails at 1.5 px letter spacing (0.094), 2 px word
 * spacing (0.125), 20 px line height on wrapping text (1.25); passes at 2 px (0.125), 3 px (0.1875),
 * 24 px (1.5) and on the wrapper.
 */
export const ACT_DECLS = [
  ['letter-spacing: 1.5px !important', true], ['word-spacing: 2px !important', true], ['line-height: 20px !important', true],
  ['letter-spacing: 2px !important', false], ['word-spacing: 3px !important', false], ['line-height: 24px !important', false], ['wrapper', false],
] as const;

export function actCase(i: number, rep: number, hazard: Hazard, seed: number): SimCase {
  const [decl, fails] = ACT_DECLS[i]!;
  const id = `text-spacing/act/${decl.replace(/[^\w.]+/g, '-')}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const text = filler(r, 1, 60).replace(/<\/?p>|\n/g, '');
  const html = decl === 'wrapper'
    ? `<div style="letter-spacing: 0.05em !important"><p class="t">${text}</p></div>`
    : `<p class="t" style="${decl}">${text}</p>`;
  const pg = parts('Notices', `<p>Notices from the city.</p>${html}${filler(r, 2)}`, ['.t { max-width: 640px; font: 16px Arial; }']);
  applyHazard(pg, hazard, r);
  return {
    id, test: 'text-spacing', hazard, params: { kind: 'act', decl },
    site: render(pg),
    expect: { '1.4.12': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: decl === 'wrapper' ? 'an !important letter spacing on a wrapper with no text of its own (ACT 24afc2 does not apply; its text takes the user spacing)'
      : fails ? `style="${decl}" on 16 px text is under the WCAG minimum and cannot be overridden (ACT)` : `style="${decl}" on 16 px text is at least the WCAG minimum`,
  };
}

export function textSpacingCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  const h = () => HAZARDS[i++ % HAZARDS.length]!;
  for (const kind of ['clip', 'overlap', 'scroll', 'min-height'] as const) {
    GEOMETRIES.forEach((_, gi) => {
      for (const lost of LOSSES) {
        if ((kind === 'scroll' || kind === 'min-height') && lost < 14) continue;
        const c = boxCase(kind, gi, lost, h(), seed);
        if (c) out.push(c);
      }
    });
  }
  for (const el of WIDTH_ELEMENTS) for (const M of WIDTH_LENGTHS) for (const fit of ['tight', 'loose'] as const) out.push(widthCase(el, M, fit, h(), seed));
  for (const kind of INLINE_KINDS) {
    const reps = kind.endsWith('-important') && !kind.startsWith('letter-0.2') && !kind.startsWith('word-0.3') && !kind.startsWith('line-1.6') ? 7 : 2;
    for (let rep = 0; rep < reps; rep++) out.push(inlineCase(kind, rep, h(), seed));
  }
  ACT_DECLS.forEach((d, k) => { for (let rep = 0; rep < (d[1] ? 5 : 3); rep++) out.push(actCase(k, rep, h(), seed)); });
  return out;
}

export const textSpacingTest: SimTest = {
  id: 'text-spacing', criteria: ['1.4.12'], probes: () => [textSpacingProbe], full: false, read: 'criterion', capMs: 90_000, cases: textSpacingCases,
};
