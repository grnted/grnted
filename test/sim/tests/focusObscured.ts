// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.4.11 Focus Not Obscured (Minimum): the keyboard probe (desktop, 1280 px) and the overlays probe
// (320 px and 390 px, Tab and Shift+Tab), read from the criteria table. The answer by construction:
// - the subject control is placed, in viewport units, so that at the top of the page a fixed bar (a
//   sticky header, a cookie banner, a chat bubble) covers 0%, 50%, 99% (a 1 px strip shows) or 100%
//   of it; the page is short and the subject is the first Tab stop, so focusing it never scrolls;
// - the AA criterion fails only when the focused control is ENTIRELY hidden: 100% under an opaque bar
//   fails, anything less passes, and a translucent bar never hides it;
// - the bar is on at every width, only at phone widths (≤ 400 px) or only on desktops (≥ 1000 px):
//   the page fails where the bar is (WCAG holds at every width).
import { keyboardProbe } from '../../../src/probes/keyboard/index.js';
import { overlaysProbe } from '../../../src/probes/overlays.js';
import { applyHazard, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

export const BARS = ['header', 'banner', 'bubble', 'translucent'] as const;
export const COVERS = ['0', '50', '99', '100', '100-small'] as const;
export const WIDTHS = ['all', 'narrow', 'wide'] as const;
export const SUBJECTS = ['link', 'button', 'input', 'select'] as const;
type Bar = (typeof BARS)[number];
type Cover = (typeof COVERS)[number];
type Width = (typeof WIDTHS)[number];
type Subject = (typeof SUBJECTS)[number];

const HAZARDS: readonly Hazard[] = ['none', 'smooth-scroll', 'late-mount', 'font-swap', 'animation-in-flight', 'reduced-motion-honored', 'none', 'lazy-images'];
/** Bar sizes (CSS px): the header and banner are 120 px tall, the bubble 80 px square. */
const BAR_H = 120;
const BUBBLE = 80;

/** Top (CSS, viewport-based) and height of the subject for a cover of the bar. */
function placement(bar: Bar, cover: Cover): { top: string; left: string; w: number; h: number } {
  const small = cover === '100-small';
  if (bar === 'bubble') {
    // Bubble at right 16 px, bottom 16 px, 80×80 (square corners). Subject 56×56 at the right.
    const h = small ? 24 : 56;
    const w = small ? 40 : 56;
    const insideTop = `calc(100vh - 16px - ${BUBBLE}px + ${(BUBBLE - h) / 2}px)`;
    const left = `calc(100vw - 16px - ${BUBBLE}px + ${(BUBBLE - w) / 2}px)`;
    switch (cover) {
      case '0': return { top: `calc(100vh - 16px - ${BUBBLE}px - ${h + 8}px)`, left, w, h };
      case '50': return { top: `calc(100vh - 16px - ${BUBBLE}px - ${h / 2}px)`, left, w, h };
      case '99': return { top: `calc(100vh - 16px - ${BUBBLE}px - 1px)`, left, w, h: BUBBLE };
      default: return { top: insideTop, left, w, h };
    }
  }
  const h = small ? 24 : 100;
  const w = 140;
  const left = '24px';
  if (bar === 'banner') {
    switch (cover) {
      case '0': return { top: `calc(100vh - ${BAR_H + h + 8}px)`, left, w, h };
      case '50': return { top: `calc(100vh - ${BAR_H + h / 2}px)`, left, w, h };
      case '99': return { top: `calc(100vh - ${BAR_H + 1}px)`, left, w, h };
      default: return { top: `calc(100vh - ${BAR_H}px + ${(BAR_H - h) / 2}px)`, left, w, h };
    }
  }
  switch (cover) {
    case '0': return { top: `${BAR_H + 8}px`, left, w, h };
    case '50': return { top: `${BAR_H - h / 2}px`, left, w, h };
    case '99': return { top: `${BAR_H - h + 1}px`, left, w, h };
    default: return { top: `${(BAR_H - h) / 2}px`, left, w, h };
  }
}

export function focusCase(bar: Bar, cover: Cover, width: Width, subject: Subject, hazard: Hazard, seed: number): SimCase {
  const id = `focus-obscured/${bar}/${cover}/${width}/${subject}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const p = placement(bar, cover);
  const media = width === 'narrow' ? '(max-width: 400px)' : width === 'wide' ? '(min-width: 1000px)' : 'all';
  const barCss = bar === 'header'
    ? `position: fixed; top: 0; left: 0; right: 0; height: ${BAR_H}px; background: #fff; border-bottom: 2px solid #1b1b1b;`
    : bar === 'translucent'
      ? `position: fixed; top: 0; left: 0; right: 0; height: ${BAR_H}px; background: rgba(255, 255, 255, 0.45); border-bottom: 2px solid #1b1b1b;`
      : bar === 'banner'
        ? `position: fixed; bottom: 0; left: 0; right: 0; height: ${BAR_H}px; background: #1b1b1b; color: #fff;`
        : `position: fixed; right: 16px; bottom: 16px; width: ${BUBBLE}px; height: ${BUBBLE}px; background: #00376d; color: #fff;`;
  const barHtml = bar === 'bubble'
    ? '<div class="sim-bar" role="complementary" aria-label="Chat"><span>Chat</span></div>'
    : bar === 'banner'
      ? '<div class="sim-bar" role="region" aria-label="Notice"><p>Office hours change on Monday.</p></div>'
      : '<div class="sim-bar" role="banner"><p>City of Example</p></div>';
  const ctl = subject === 'link'
    ? `<a class="subject" id="subject" href="#news">Read the news</a>`
    : subject === 'button'
      ? `<button class="subject" id="subject" type="button">Open the map</button>`
      : subject === 'select'
        ? `<label class="sr" for="subject">District</label><select class="subject" id="subject"><option>North</option><option>South</option></select>`
        : `<label class="sr" for="subject">Search</label><input class="subject" id="subject" type="search" autocomplete="off">`;
  const css = [
    `.sim-bar { display: none; z-index: 30; box-sizing: border-box; padding: 12px 24px; font: 16px/1.4 Arial, sans-serif; } .sim-bar p { margin: 0; color: inherit; }`,
    `@media ${media} { .sim-bar { display: block; ${barCss} } }`,
    `.subject { position: absolute; top: ${p.top}; left: ${p.left}; width: ${p.w}px; height: ${p.h}px; box-sizing: border-box; margin: 0; padding: 4px; font: 14px/1.2 Arial, sans-serif; color: #00376d; background: #fff; border: 2px solid #00376d; z-index: 1; overflow: hidden; }`,
    '.subject:focus { outline: 3px solid #b00020; outline-offset: -3px; }',
    '.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }',
    // The page's own content sits clear of every bar and of the subject (short: it never scrolls).
    `main { position: absolute; top: ${BAR_H + 8}px; left: 200px; right: 120px; padding: 0; } main h1 { font-size: 18px; margin: 0 0 8px; } main p { margin: 0 0 8px; font-size: 14px; }`,
    '@media (max-width: 400px) { main { left: 180px; right: 8px; } main h1 { font-size: 14px; } main p { display: none; } }',
  ];
  // The subject is the first Tab stop (before the page's own links).
  const pg = parts('News', `<p><a href="#news">News</a></p>`, css);
  pg.before.push(ctl, barHtml);
  applyHazard(pg, hazard, r);
  const opaque = bar !== 'translucent';
  const fails = opaque && (cover === '100' || cover === '100-small');
  return {
    id, test: 'focus-obscured', hazard,
    params: { bar, cover, width, subject },
    site: render(pg),
    expect: { '2.4.11': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: fails ? `the first Tab stop is entirely under an opaque ${bar} (${width === 'all' ? 'every width' : width === 'narrow' ? 'phone widths' : 'desktop widths'})` : `the ${bar} covers ${cover}% of the focused control${opaque ? '' : ' and is translucent'}: not entirely hidden`,
  };
}

export function focusObscuredCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const bar of BARS) for (const cover of COVERS) for (const width of WIDTHS) for (const subject of SUBJECTS) {
    out.push(focusCase(bar, cover, width, subject, HAZARDS[i++ % HAZARDS.length]!, seed));
  }
  return out;
}

export const focusObscuredTest: SimTest = {
  id: 'focus-obscured',
  criteria: ['2.4.11'],
  probes: () => [keyboardProbe, overlaysProbe],
  full: false,
  read: 'criterion',
  capMs: 150_000,
  cases: focusObscuredCases,
};
