// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 1.4.4 Resize Text (probe `resize-text` and axe `meta-viewport`, read from the criteria table).
//
// Source of truth. SC 1.4.4: "Except for captions and images of text, text can be resized without
// assistive technology up to 200 percent without loss of content or functionality." Understanding 1.4.4:
// "The scaling of content is primarily a user agent responsibility … The author's responsibility is to
// create Web content that does not prevent the user agent from scaling the content effectively";
// sufficient technique G142 "Using a technology that has commonly-available user agents that support
// zoom". Failure F94: "Failure of Success Criterion 1.4.4 due to incorrect use of viewport units to
// resize text". ACT b4f0c3 "Meta viewport allows for zoom": a viewport meta with `user-scalable=no` or
// `maximum-scale` under 2 fails ("Any failed outcomes: success criterion is not satisfied").
// Horizontal scrolling is not a 1.4.4 failure (1.4.10 Reflow is the criterion about it).
//
// So the lab judges at 200% browser zoom (what G142 relies on): the 1280×900 window shows the page laid
// out at 640×450 CSS px. A page whose text breaks only when the root font size alone is doubled (text in
// rem in a box sized in px) zooms cleanly in every browser and passes; the engine's first pass (root
// font ×2, docs/scoring.md "Text at 200%") disagrees with the lab there, by design of the lab.
//
// The answer by construction:
// - 'vw-text': text sized in vw, vh or vmin: at 640×450 its CSS size halves, so on screen it does not
//   grow at all (F94): fails;
// - 'vh-box': k lines of 20 px text in a box `Y vh` tall with overflow hidden: fits at 900 px (k·20 ≤ 9Y
//   − 4), loses at least 40 px at 450 px (k·20 ≥ 4.5Y + 40): fails; the same box with `min-height` passes;
// - 'cut-row': a row of six links W px wide (900–1240) on a page whose html and body clip sideways
//   (overflow-x hidden): at 640 px the last links are past the edge and cannot be reached: fails; the
//   same row on a page that scrolls sideways passes (horizontal scrolling is allowed by 1.4.4);
// - 'meta': user-scalable=no, maximum-scale=1 or 1.5 fails (ACT b4f0c3); maximum-scale=2, 5 and
//   user-scalable=yes pass;
// - 'rem-px-box': text in rem in a box of fixed px height with overflow hidden (breaks only with the root
//   font doubled, zooms cleanly), 'px-box' (px text in a px box) and 'rem-fluid' (rem text, height auto)
//   pass.
import { resizeTextProbe } from '../../../src/probes/resizeText.js';
import { applyHazard, filler, hash, parts, pick, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'animation-in-flight', 'scroll-snap', 'reduced-motion-honored'];
const WORDS = 'agenda budget council notice parks permit street water zoning library housing transit'.split(' ');
const words = (r: () => number, n: number) => Array.from({ length: n }, () => pick(r, WORDS)).join(' ');

/** At 200% zoom of a 1280×900 window the page is laid out at 640×450 CSS px. */
export const ZOOMED = { width: 640, height: 450 } as const;
export const DESKTOP = { width: 1280, height: 900 } as const;

export const VH_BOXES = [{ Y: 20, k: 7 }, { Y: 30, k: 10 }, { Y: 40, k: 13 }] as const;

export type ResizeKind = 'vw-text' | 'vh-box' | 'vh-min-height' | 'cut-row' | 'scroll-row' | 'meta' | 'rem-px-box' | 'px-box' | 'rem-fluid';

export function resizeCase(kind: ResizeKind, variant: string, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `resize-text/${kind}/${variant}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const css: string[] = [];
  let subject = '';
  let viewport: string | undefined;
  let fails = false;
  let why = '';
  switch (kind) {
    case 'vw-text': {
      const [unit, size] = variant.split('-') as [string, string];
      subject = `<p class="s">${words(r, 30)}.</p>`;
      css.push(`.s { font-size: ${size}${unit}; line-height: 1.4; max-width: 60em; }`);
      fails = true;
      why = `text sized ${size}${unit}: at 200% zoom its CSS size halves, so on screen it does not grow (F94)`;
      break;
    }
    case 'vh-box':
    case 'vh-min-height': {
      const b = VH_BOXES[Number(variant)]!;
      subject = `<div class="s">${Array.from({ length: b.k }, () => words(r, 4)).join('<br>')}</div>`;
      css.push(`.s { ${kind === 'vh-box' ? 'height' : 'min-height'}: ${b.Y}vh; overflow: hidden; font: 16px/20px Arial; white-space: nowrap; background: #f4f4f4; }`);
      fails = kind === 'vh-box';
      why = fails
        ? `${b.k} lines (${b.k * 20} px) in a box ${b.Y}vh tall with overflow hidden: ${b.Y * 9} px at 100%, ${b.Y * 4.5} px at 200% zoom (${b.k * 20 - b.Y * 4.5} px cut off)`
        : `${b.k} lines in a box with min-height ${b.Y}vh: it grows at 200% zoom`;
      break;
    }
    case 'cut-row':
    case 'scroll-row': {
      const W = Number(variant);
      subject = `<nav aria-label="Services"><ul class="s">${['Pay a bill', 'Report a problem', 'Find a park', 'Permits', 'Library', 'Contact us'].map((t, i) => `<li><a href="#l${i}">${t}</a></li>`).join('')}</ul></nav>`;
      css.push(`.s { display: flex; width: ${W}px; margin: 0; padding: 0; list-style: none; } .s li { flex: 1 1 0; min-width: 0; } .s a { display: block; padding: 8px; font: 16px Arial; color: #00376d; } .s a:focus-visible { outline: 3px solid #00376d; }`);
      if (kind === 'cut-row') css.push('html, body { overflow-x: hidden; }');
      fails = kind === 'cut-row';
      why = fails ? `a ${W} px row on a page that clips sideways: at 640 px (200% zoom) its last links cannot be reached` : `a ${W} px row on a page that scrolls sideways: every link can be reached at 200% zoom (horizontal scrolling is 1.4.10's concern)`;
      break;
    }
    case 'meta': {
      viewport = `width=device-width, initial-scale=1, ${variant}`;
      subject = `<p>${words(r, 30)}.</p>`;
      const m = /maximum-scale=([\d.]+)/.exec(variant);
      fails = variant === 'user-scalable=no' || (!!m && Number(m[1]) < 2);
      why = fails ? `meta viewport ${variant} stops zooming (ACT b4f0c3)` : `meta viewport ${variant} allows zooming to 200% (ACT b4f0c3 passes)`;
      break;
    }
    // Lead's ruling (2026-11-07): a page that breaks only under a doubled root font size but zooms cleanly
    // passes 1.4.4 (G142 accepts browser zoom).
    case 'rem-px-box':
    case 'px-box': {
      const k = Number(variant);
      const unit = kind === 'rem-px-box' ? '1rem' : '16px';
      subject = `<div class="s">${Array.from({ length: k }, () => words(r, 4)).join('<br>')}</div>`;
      css.push(`.s { height: ${k * 22 + 6}px; width: 480px; overflow: hidden; font-size: ${unit}; line-height: 1.375; font-family: Arial; white-space: nowrap; background: #f4f4f4; }`);
      why = kind === 'rem-px-box'
        ? `${k} lines in rem in a ${k * 22 + 6} px box: cut off only when the root font size alone is doubled; at 200% browser zoom box and text scale together (G142)`
        : `px text in a px box: scales with the box at 200% zoom`;
      break;
    }
    case 'rem-fluid':
      subject = `<div class="s">${filler(r, 2, 30)}</div>`;
      css.push(`.s { font-size: ${variant}rem; max-width: 40em; }`);
      why = `text in rem in a box that grows with it`;
      break;
  }
  const pg = parts('City services', `<p>What the city does for you.</p>${subject}${filler(r, 2)}`, css);
  if (viewport) pg.viewport = viewport;
  applyHazard(pg, hazard, r);
  return {
    id, test: 'resize-text', hazard, params: { kind, variant },
    site: render(pg),
    expect: { '1.4.4': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why,
  };
}

const PLAN: [ResizeKind, readonly string[], number][] = [
  ['vw-text', ['vw-1.25', 'vw-2', 'vh-2.5', 'vmin-3'], 4],
  ['vh-box', ['0', '1', '2'], 5],
  ['cut-row', ['900', '1100', '1240'], 4],
  ['meta', ['user-scalable=no', 'maximum-scale=1', 'maximum-scale=1.5'], 4],
  ['rem-px-box', ['3', '5', '8'], 6],
  ['px-box', ['3', '6'], 4],
  ['rem-fluid', ['1', '1.25'], 4],
  ['vh-min-height', ['0', '1', '2'], 3],
  ['scroll-row', ['900', '1100', '1240'], 3],
  ['meta', ['maximum-scale=2', 'maximum-scale=5', 'user-scalable=yes'], 3],
];

export function resizeCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const [kind, variants, reps] of PLAN) for (const v of variants) for (let rep = 0; rep < reps; rep++) out.push(resizeCase(kind, v, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  return out;
}

export const resizeTextTest: SimTest = {
  id: 'resize-text', criteria: ['1.4.4'], probes: () => [resizeTextProbe], full: false, read: 'criterion', capMs: 90_000, cases: resizeCases,
};
