// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 1.4.11 Non-text Contrast (probe `non-text-contrast`): the boundary of a styled form field or custom
// checkbox, and the icon of an icon-only control. The answer by construction:
// - one subject control per page, its identifying colour (border, fill or icon) solved on 8-bit sRGB
//   for a ratio against the colour next to it just below, at or above 3:1 (2.0 / 2.5 / 2.9 / 3.0 /
//   3.1 / 4.5), the truth taken from the exact ratio of the chosen colours;
// - a field is identified by its border or by its fill: when the border is faint but the fill stands
//   out at 3:1 or more, the field passes (the boundary is the fill);
// - the page background is white, a light tint, or dark with light controls;
// - disabled controls and controls left with the browser's own look are exempt.
import { nonTextContrastProbe } from '../../../src/probes/nonTextContrast.js';
import { DARK_HUES, LIGHT_BGS, hexOf, ratio, solve, type Rgb } from '../color.js';
import { applyHazard, filler, hash, parts, pick, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'animation-in-flight', 'scroll-snap', 'none'];
export const NT_KINDS = ['field-border-1', 'field-border-2', 'field-fill', 'select-border', 'checkbox', 'icon-svg'] as const;
export const NT_RATIOS = [2.0, 2.5, 2.7, 2.9, 3.0, 3.1, 4.5] as const;
const PAGES = ['white', 'tint', 'dark'] as const;
type Kind = (typeof NT_KINDS)[number];
type PageBg = (typeof PAGES)[number];

const LIGHT_HUES: readonly Rgb[] = [[255, 255, 255], [255, 240, 200], [210, 235, 255], [220, 255, 220]];

function solveFor(bg: PageBg, against: Rgb, nominal: number, r: () => number): { c: Rgb; ratio: number } {
  // Exactly 3.0 is solved above the line (it passes); the others land as near their number as 8 bits allow.
  const from = bg === 'dark' ? pick(r, LIGHT_HUES) : pick(r, DARK_HUES);
  if (nominal === 3) { const s = solve(against, from, against, 3, 'above'); return { c: s.color, ratio: s.ratio }; }
  const a = solve(against, from, against, nominal, 'above', 0);
  const b = solve(against, from, against, nominal, 'below', 0);
  const s = Math.abs(a.ratio - nominal) <= Math.abs(b.ratio - nominal) ? a : b;
  return { c: s.color, ratio: s.ratio };
}

const ICON = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10z"/></svg>';

export function nonTextCase(kind: Kind, nominal: number, pageBg: PageBg, hazard: Hazard, seed: number): SimCase {
  const id = `non-text-contrast/${kind}/${nominal}/${pageBg}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const bg: Rgb = pageBg === 'white' ? [255, 255, 255] : pageBg === 'tint' ? pick(r, LIGHT_BGS.slice(1)) : [27, 27, 27];
  const text = pageBg === 'dark' ? '#ffffff' : '#1b1b1b';
  const { c, ratio: actual } = solveFor(pageBg, bg, nominal, r);
  const C = hexOf(c);
  const B = hexOf(bg);
  const css = [`body { background: ${B}; color: ${text}; } main a { color: ${text}; } label { display: block; margin: 16px 0 4px; }`];
  let control: string;
  switch (kind) {
    case 'field-border-1':
    case 'field-border-2':
      control = `<label for="q">Your street</label><input id="q" type="text" class="ctl" autocomplete="street-address">`;
      css.push(`.ctl { font: 16px Arial, sans-serif; color: ${text}; background: ${B}; border: ${kind === 'field-border-1' ? 1 : 2}px solid ${C}; border-radius: 0; padding: 8px; width: 280px; }`);
      break;
    case 'field-fill':
      control = `<label for="q">Your street</label><input id="q" type="text" class="ctl" autocomplete="street-address">`;
      // The fill is the boundary; the text inside stays readable on it (dark on light, light on dark).
      css.push(`.ctl { font: 16px Arial, sans-serif; color: ${ratio(c, [0, 0, 0]) >= 7 ? '#000' : '#fff'}; background: ${C}; border: 0; border-radius: 0; padding: 8px; width: 280px; }`);
      break;
    case 'select-border':
      control = `<label for="q">Your district</label><select id="q" class="ctl"><option>North</option><option>South</option></select>`;
      css.push(`.ctl { font: 16px Arial, sans-serif; color: ${text}; background: ${B}; border: 2px solid ${C}; border-radius: 0; padding: 8px; width: 280px; }`);
      break;
    case 'checkbox':
      control = `<p><input id="q" type="checkbox" class="ctl"> <label for="q" style="display:inline">Send me the newsletter</label></p>`;
      css.push(`.ctl { appearance: none; -webkit-appearance: none; width: 20px; height: 20px; margin: 0 8px 0 0; vertical-align: middle; background: ${B}; border: 2px solid ${C}; border-radius: 2px; } .ctl:checked { background: ${C}; }`);
      break;
    case 'icon-svg':
      control = `<p>Search the site: <button type="button" class="ctl" aria-label="Search">${ICON}</button></p>`;
      css.push(`.ctl { width: 44px; height: 44px; padding: 10px; background: ${B}; color: ${C}; border: 0; } .ctl svg { display: block; fill: currentColor; }`);
      break;
  }
  const pg = parts('Sign up for news', `<p>Get the city newsletter.</p>${control}${filler(r, 3)}`, css);
  if (pageBg === 'dark') pg.css.push(`main p { color: #fff; }`);
  applyHazard(pg, hazard, r);
  const fails = actual < 3;
  return {
    id, test: 'non-text-contrast', hazard,
    params: { kind, nominal, actual: Math.round(actual * 1000) / 1000, page: pageBg, colour: C, background: B },
    site: render(pg),
    expect: { '1.4.11': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: `${kind}: ${actual.toFixed(3)}:1 against ${B} (needs 3:1)`,
  };
}

/** Exempt (disabled, browser look) and a faint border saved by a fill that stands out. */
export function nonTextSpecial(kind: 'disabled-field' | 'disabled-checkbox' | 'default-field' | 'faint-border-strong-fill' | 'faint-border-faint-fill', hazard: Hazard, seed: number): SimCase {
  const id = `non-text-contrast/special/${kind}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const bg: Rgb = [255, 255, 255];
  const faint = solve(bg, [118, 118, 118], bg, 1.6, 'above', 0).color;
  let control = '';
  const css: string[] = [];
  let fails = false;
  let why = '';
  switch (kind) {
    case 'disabled-field':
      control = '<label for="q">Account number</label><input id="q" type="text" class="ctl" disabled value="">';
      css.push(`.ctl { font: 16px Arial; border: 1px solid ${hexOf(faint)}; background: #fff; padding: 8px; }`);
      why = 'a disabled field (exempt) with a 1.6:1 border';
      break;
    case 'disabled-checkbox':
      control = '<p><input id="q" type="checkbox" class="ctl" disabled> <label for="q" style="display:inline">Not available</label></p>';
      css.push(`.ctl { appearance: none; width: 20px; height: 20px; border: 2px solid ${hexOf(faint)}; background: #fff; }`);
      why = 'a disabled custom checkbox (exempt) with a 1.6:1 border';
      break;
    case 'default-field':
      control = '<label for="q">Your name</label><input id="q" type="text" autocomplete="name">';
      why = 'a field with the browser\'s own look (exempt)';
      break;
    case 'faint-border-strong-fill': {
      const fill = solve(bg, [0, 40, 110], bg, 3.4, 'above', 0).color;
      control = '<label for="q">Your street</label><input id="q" type="text" class="ctl" autocomplete="street-address">';
      css.push(`.ctl { font: 16px Arial; color: #fff; border: 1px solid ${hexOf(faint)}; background: ${hexOf(fill)}; padding: 8px; }`);
      why = `a faint border (1.6:1) on a fill that stands out (${ratio(fill, bg).toFixed(2)}:1): the fill is the boundary`;
      break;
    }
    case 'faint-border-faint-fill': {
      const fill = solve(bg, [118, 118, 118], bg, 1.3, 'above', 0).color;
      control = '<label for="q">Your street</label><input id="q" type="text" class="ctl" autocomplete="street-address">';
      css.push(`.ctl { font: 16px Arial; color: #000; border: 1px solid ${hexOf(faint)}; background: ${hexOf(fill)}; padding: 8px; }`);
      fails = true;
      why = 'a faint border (1.6:1) on a faint fill (1.3:1): nothing marks the field at 3:1';
      break;
    }
  }
  const pg = parts('Your account', `<p>Update your details.</p>${control}${filler(r, 3)}`, css);
  applyHazard(pg, hazard, r);
  return {
    id, test: 'non-text-contrast', hazard, params: { special: kind }, site: render(pg),
    expect: { '1.4.11': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } }, why,
  };
}

export function nonTextContrastCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const kind of NT_KINDS) {
    for (const nominal of NT_RATIOS) {
      for (const page of PAGES) out.push(nonTextCase(kind, nominal, page, HAZARDS[i++ % HAZARDS.length]!, seed));
    }
  }
  // A page-load pop-up over the page (the 2026-11-07 audit's cause 6): the page behind it decides.
  for (const kind of NT_KINDS) for (const nominal of [2.5, 2.9, 3.1, 4.5] as const) out.push(nonTextCase(kind, nominal, 'white', 'load-popup', seed));
  for (const k of ['disabled-field', 'disabled-checkbox', 'default-field', 'faint-border-strong-fill', 'faint-border-faint-fill'] as const) {
    for (const h of ['none', 'sticky-header'] as const) out.push(nonTextSpecial(k, h, seed));
  }
  return out;
}

export const nonTextContrastTest: SimTest = {
  id: 'non-text-contrast',
  criteria: ['1.4.11'],
  probes: () => [nonTextContrastProbe],
  full: false,
  read: 'probe',
  readProbes: ['non-text-contrast'],
  capMs: 90_000,
  cases: nonTextContrastCases,
};
