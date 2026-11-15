// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.5.2 Pointer cancellation, batch 17 (motion-pointer): what the pointer resting on an element shows by itself is
// no outcome of pressing it. The pointer cancellation test presses an element after hovering it for 120 ms; a tooltip
// that waits a moment before it shows (and hides a while after the pointer leaves) appeared during the press and was
// read as "pressing down shows the tooltip". The test now repeats the same moves without pressing when a press changed
// content: when that alone changes the page too, the press is not measured (not testable), never failed.
// By construction:
// - pass: elements with a press listener that does nothing (a chart, a card, a figure, an icon) and a tooltip, hover
//   card or label that shows after a delay on mouseenter or mousemove and hides after a delay;
// - fail: a press that acts at once (shows a message, opens a panel, marks a row) with nothing on hover; and one that
//   acts at once on an element that also shows a delayed tooltip (missed by design: the hover control cannot tell
//   the two changes apart, so it is not measured).
import { pointerCancellationProbe } from '../../../src/probes/pointerCancellation.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'scroll-snap', 'reduced-motion-ignored'];
/** Each kind twice per hazard (a second page with other filler text), so each side has enough pages for a 95% claim. */
const REPS = [0, 1] as const;
const PASS = ['chart-tooltip-delay', 'card-hovercard-delay', 'icon-label-delay', 'figure-caption-delay', 'chart-tooltip-long-delay', 'enter-tooltip-delay'] as const;
const FAIL = ['press-message', 'press-panel', 'press-row-selected', 'press-and-tooltip'] as const;
type Kind = (typeof PASS)[number] | (typeof FAIL)[number];

/** A delayed tooltip on `#t`: shows `show` ms after the pointer comes (mousemove or mouseenter) and hides `hide` ms after it leaves. */
const TIP = (show: number, hide: number, on: 'mousemove' | 'mouseenter') => `(function () { var el = document.getElementById('t'), tip = null, st = 0, ht = 0;
  function show() { clearTimeout(ht); if (tip) return; tip = document.createElement('div'); tip.className = 'tip'; tip.textContent = el.getAttribute('data-tip'); el.appendChild(tip); }
  el.addEventListener('${on}', function () { clearTimeout(ht); if (!tip) { clearTimeout(st); st = setTimeout(show, ${show}); } });
  el.addEventListener('mouseleave', function () { clearTimeout(st); clearTimeout(ht); ht = setTimeout(function () { if (tip) { tip.remove(); tip = null; } }, ${hide}); });
})();`;

function build(kind: Kind): { body: string; init: string[]; why: string } {
  const out = '<p id="out" role="status"></p>';
  switch (kind) {
    case 'chart-tooltip-delay':
    case 'chart-tooltip-long-delay':
      return { body: `<div id="t" data-tip="General: 41 million" style="position:relative;width:480px;height:160px"><svg xmlns="http://www.w3.org/2000/svg" width="480" height="160" role="img" aria-label="Spending by fund"><rect width="480" height="160" fill="#dbe8f7"/></svg></div>`, init: [TIP(kind === 'chart-tooltip-delay' ? 250 : 380, 500, 'mousemove'), "document.getElementById('t').addEventListener('mousedown', function () {});"], why: 'a chart with a delayed hover tooltip and a press listener that does nothing' };
    case 'card-hovercard-delay':
      return { body: '<div id="t" data-tip="Opens 9 am, closes 6 pm" style="position:relative;display:inline-block;padding:8px 12px;border:1px solid #595959">Main library</div>', init: [TIP(300, 600, 'mouseenter'), "document.getElementById('t').addEventListener('pointerdown', function () {});"], why: 'a card with a delayed hover card and a pointerdown listener that does nothing' };
    case 'icon-label-delay':
      return { body: '<span id="t" data-tip="Accessible entrance" style="position:relative;display:inline-block;width:32px;height:32px;background:#0b4fb3"></span>', init: [TIP(200, 400, 'mouseenter'), "document.getElementById('t').addEventListener('mousedown', function () {});"], why: 'an icon with a delayed label tooltip and a press listener that does nothing' };
    case 'figure-caption-delay':
      return { body: '<figure id="t" data-tip="Photo: the new reading room" style="position:relative;margin:0;width:240px;height:120px;background:#9ecae1"></figure>', init: [TIP(250, 500, 'mousemove'), "document.getElementById('t').addEventListener('mousedown', function (e) { e.preventDefault(); });"], why: 'a figure with a delayed caption tooltip and a press listener that only stops text selection' };
    case 'enter-tooltip-delay':
      return { body: '<div id="t" data-tip="Next bus in 4 minutes" style="position:relative;display:inline-block;padding:8px 12px;border:1px solid #595959">Stop 4410</div>', init: [TIP(220, 450, 'mouseenter'), "document.getElementById('t').addEventListener('pointerdown', function () {});"], why: 'a stop marker with a delayed tooltip and a pointerdown listener that does nothing' };
    case 'press-message':
      return { body: `<span id="save" role="button" style="display:inline-block;padding:6px 12px;border:1px solid #333333">Save route 12</span>${out}`, init: ["document.getElementById('save').addEventListener('mousedown', function () { document.getElementById('out').textContent = 'Route 12 is saved to your list.'; });"], why: 'a button that saves the moment it goes down (nothing on hover)' };
    case 'press-panel':
      return { body: '<div id="open" role="button" style="display:inline-block;padding:6px 12px;border:1px solid #333333">Show hours</div><div id="panel" hidden>8 am to 4 pm on weekdays.</div>', init: ["document.getElementById('open').addEventListener('pointerdown', function () { document.getElementById('panel').hidden = false; });"], why: 'a button that opens a panel the moment it goes down (nothing on hover)' };
    case 'press-row-selected':
      return { body: '<ul style="list-style:none;padding:0"><li id="row" role="option" aria-selected="false" style="padding:6px;border:1px solid #595959">Route 12</li></ul>', init: ["document.getElementById('row').addEventListener('mousedown', function () { this.setAttribute('aria-selected', 'true'); this.textContent = 'Route 12 (selected)'; });"], why: 'a row marked selected the moment it is pressed (nothing on hover)' };
    case 'press-and-tooltip':
      return { body: `<span id="t" role="button" data-tip="Saves to your list" style="position:relative;display:inline-block;padding:6px 12px;border:1px solid #333333">Save route 12</span>${out}`, init: [TIP(250, 500, 'mouseenter'), "document.getElementById('t').addEventListener('mousedown', function () { document.getElementById('out').textContent = 'Route 12 is saved to your list.'; });"], why: 'a button that saves on press and also shows a delayed tooltip (missed by design: the change cannot be told from what hovering shows)' };
  }
}

export function hoverCase(kind: Kind, hazard: Hazard, seed: number, rep = 0): SimCase {
  const id = `pointer-cancel-hover/${kind}/${hazard}${rep ? `/${rep}` : ''}`;
  const r = rng(hash(id) ^ seed);
  const b = build(kind);
  const pg = parts('Library services', `${filler(r, 1)}${b.body}${filler(r, 1)}<p><a href="/about">About the library</a></p>`, ['.tip { position: absolute; left: 0; top: 100%; padding: 4px 8px; background: #ffffff; border: 1px solid #333333; color: #1a1a1a; white-space: nowrap; }'], b.init);
  applyHazard(pg, hazard, r);
  return {
    id, test: 'pointer-cancel-hover', hazard, params: { kind },
    site: render(pg),
    expect: { '2.5.2': (FAIL as readonly string[]).includes(kind) ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: b.why,
  };
}

export const pointerCancelHoverTest: SimTest = {
  id: 'pointer-cancel-hover', criteria: ['2.5.2'], probes: () => [pointerCancellationProbe], full: true, read: 'probe', readProbes: ['pointer-cancellation'], capMs: 120_000,
  cases: (seed) => [...PASS, ...FAIL].flatMap((kind) => HAZARDS.flatMap((h) => REPS.map((rep) => hoverCase(kind, h, seed, rep)))),
};
