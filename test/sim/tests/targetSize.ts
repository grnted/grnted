// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.5.8 Target Size (Minimum) (axe `target-size`, read from the criteria table).
//
// Source of truth. SC 2.5.8: "The size of the target for pointer inputs is at least 24 by 24 CSS pixels,
// except when: Spacing: Undersized targets (those less than 24 by 24 CSS pixels) are positioned so that if
// a 24 CSS pixel diameter circle is centered on the bounding box of each, the circles do not intersect
// another target or the circle for another undersized target; Equivalent: The function can be achieved
// through a different control on the same page that meets this criterion; Inline: The target is in a
// sentence or its size is otherwise constrained by the line-height of non-target text; User agent
// control: The size of the target is determined by the user agent and is not modified by the author;
// Essential: …".
//
// The answer by construction:
// - a row (or a column) of four s×s targets with g px between them (buttons, icon links, author-styled
//   check boxes with `appearance: none`): with s ≥ 24 they pass; undersized (s < 24), the centres are
//   s + g apart, so neighbouring circles intersect exactly when s + g < 24 (fails) and the circle of one
//   reaches the next target when s/2 + g < 12, the same condition. s + g = 24 exactly (the circles touch)
//   is never generated;
// - look-alikes that pass: links in a sentence (Inline); a 16 px icon toolbar (Bold, Italic, Underline
//   with no gap) whose three functions are also full-size text buttons on the page (Equivalent); the
//   browser's own check boxes and radio buttons, not restyled, in a list (User agent control; the
//   Understanding document names date pickers and scrollbars, not check boxes, so the lead may rule).
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'animation-in-flight', 'scroll-snap', 'reduced-motion-honored'];
export const TARGET_SIZES = [12, 16, 18, 20, 22, 23, 24, 28] as const;
export const TARGET_GAPS = [0, 1, 2, 3, 4, 8, 12] as const;
const ELEMENTS = ['button', 'icon-link', 'checkbox'] as const;
type El = (typeof ELEMENTS)[number];

const ICON = '<svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="100%" height="100%"><circle cx="8" cy="8" r="6" fill="#1b1b1b"/></svg>';

/** The answer for a row of identical targets s px with g px between them. */
export const rowFails = (s: number, g: number) => s < 24 && s + g < 24;

export function rowCase(el: El, s: number, g: number, axis: 'row' | 'column', hazard: Hazard, seed: number): SimCase {
  const id = `target-size/${el}/${s}px/gap${g}/${axis}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const names = ['Share by e-mail', 'Print this page', 'Save to favourites', 'Report a problem'];
  const items = names.map((n, i) => el === 'button'
    ? `<button type="button" class="tg" aria-label="${n}">${ICON}</button>`
    : el === 'icon-link'
      ? `<a class="tg" href="#t${i}" aria-label="${n}">${ICON}</a>`
      : `<input type="checkbox" class="tg" id="c${i}" aria-label="${n}">`).join('');
  const css = [`.set { display: flex; flex-direction: ${axis}; gap: ${g}px; align-items: flex-start; margin: 32px 0; }
.tg { box-sizing: border-box; width: ${s}px; height: ${s}px; min-width: 0; min-height: 0; padding: 0; margin: 0; border: 0; display: block; flex: none; background: #fff; color: #1b1b1b; line-height: 0; }
input.tg { appearance: none; -webkit-appearance: none; border: 2px solid #1b1b1b; border-radius: 3px; } input.tg:checked { background: #1b1b1b; }
.tg:focus-visible { outline: 3px solid #00376d; outline-offset: 1px; }`];
  const pg = parts('Article tools', `<p>Tools for this article.</p><div class="set" role="group" aria-label="Article tools">${items}</div>${filler(r, 2)}`, css);
  applyHazard(pg, hazard, r);
  const fails = rowFails(s, g);
  return {
    id, test: 'target-size', hazard, params: { el, size: s, gap: g, axis },
    site: render(pg),
    expect: { '2.5.8': fails ? { verdict: 'fail', count: 4 } : { verdict: 'pass' } },
    why: s >= 24 ? `${s}×${s} px targets (at least 24)` : fails
      ? `${s} px targets ${g} px apart: centres ${s + g} px apart, the 24 px circles intersect`
      : `${s} px targets ${g} px apart: centres ${s + g} px apart, the 24 px circles do not intersect (Spacing)`,
  };
}

export const LOOKALIKES = ['inline-links', 'equivalent-toolbar', 'ua-checkboxes', 'ua-radios'] as const;

export function lookalikeCase(kind: (typeof LOOKALIKES)[number], rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `target-size/${kind}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const css: string[] = ['a:focus-visible, button:focus-visible, input:focus-visible { outline: 3px solid #00376d; outline-offset: 1px; }'];
  let html = '';
  let why = '';
  switch (kind) {
    case 'inline-links': {
      const size = [14, 16][rep % 2]!;
      html = `<p class="s">Read the <a href="#a">agenda</a>, the <a href="#b">minutes</a> and the <a href="#c">budget</a> or <a href="#d">contact</a> the <a href="#e">clerk</a> about the <a href="#f">meeting</a>.</p>`;
      css.push(`.s { font: ${size}px/1.4 Arial; } .s a { color: #00376d; }`);
      why = `links in a sentence (${size} px text): Inline exception`;
      break;
    }
    case 'equivalent-toolbar':
      html = `<div class="tb" role="toolbar" aria-label="Format">${['Bold', 'Italic', 'Underline'].map((n) => `<button type="button" aria-label="${n}" class="ic">${ICON}</button>`).join('')}</div>
<p><label for="ed">Comment</label><br><textarea id="ed" rows="3" cols="40"></textarea></p>
<p class="big">${['Bold', 'Italic', 'Underline'].map((n) => `<button type="button" class="full">${n}</button>`).join(' ')}</p>`;
      css.push('.tb { display: flex; gap: 0; } .ic { width: 16px; height: 16px; padding: 0; border: 0; background: #fff; line-height: 0; } .full { font: 16px Arial; min-height: 44px; padding: 8px 16px; } textarea { font: 16px Arial; }');
      why = 'a 16 px icon toolbar whose functions are also full-size buttons on the page: Equivalent exception';
      break;
    case 'ua-checkboxes':
      // Lead's ruling (2026-11-07): the browser's own unstyled check boxes and radio buttons pass under the
      // User agent control exception.
      html = `<fieldset><legend>Topics</legend>${['Parks', 'Streets', 'Water', 'Library'].map((t, i) => `<div><input type="checkbox" id="k${i}"> <label for="k${i}">${t}</label></div>`).join('')}</fieldset>`;
      why = "the browser's own check boxes, not restyled: User agent control exception";
      break;
    case 'ua-radios':
      html = `<fieldset><legend>How often?</legend>${['Daily', 'Weekly', 'Monthly', 'Never'].map((t, i) => `<div><input type="radio" name="f" id="q${i}"> <label for="q${i}">${t}</label></div>`).join('')}</fieldset>`;
      why = "the browser's own radio buttons, not restyled: User agent control exception";
      break;
  }
  const pg = parts('Article tools', `<p>Tools for this article.</p>${html}${filler(r, 2)}`, css);
  applyHazard(pg, hazard, r);
  return { id, test: 'target-size', hazard, params: { kind }, site: render(pg), expect: { '2.5.8': { verdict: 'pass' } }, why };
}

export function targetSizeCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const el of ELEMENTS) for (const s of TARGET_SIZES) for (const g of TARGET_GAPS) {
    if (s < 24 && s + g === 24) continue; // circles exactly touching: never generated
    if (s >= 24 && g > 2) continue;
    const axis = (i % 3 === 2 ? 'column' : 'row') as 'row' | 'column';
    out.push(rowCase(el, s, g, axis, HAZARDS[i++ % HAZARDS.length]!, seed));
  }
  for (const k of LOOKALIKES) for (let rep = 0; rep < 4; rep++) out.push(lookalikeCase(k, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  return out;
}

export const targetSizeTest: SimTest = {
  id: 'target-size', criteria: ['2.5.8'], probes: () => [], full: false, read: 'criterion', capMs: 60_000, cases: targetSizeCases,
};
