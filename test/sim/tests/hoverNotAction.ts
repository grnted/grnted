// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.1.1 (the controls test) and 2.5.7 (the gesture test), batch 17 (motion-pointer): what the pointer resting on or
// moving over content shows by itself is no effect of a click or a drag. A chart's tooltip that waits a moment before
// it shows appeared after the controls test's 100 ms hover baseline ("it answers a mouse click", 2.1.1 failed) and
// during the gesture test's drag ("dragging pans it", 2.5.7 failed). Now the controls test rests the pointer on the
// element again without clicking before a click-only failure stands, and the gesture test counts a drag only beyond
// what the same moves without pressing show.
// By construction (one element on the page, a tooltip on #t where named):
// - pass: a chart, a card, an icon and a map region whose click or press listeners do nothing, each with a delayed
//   tooltip (shown 200-400 ms after the pointer comes, hidden 400-600 ms after it leaves);
// - fail 2.5.7: a map that pans only by dragging, with and without a delayed tooltip that follows the pointer;
// - fail 2.1.1: a card that takes no focus and opens its hours on a click only, with and without a delayed tooltip.
import { controlsProbe } from '../../../src/probes/controls/index.js';
import { pointerGesturesProbe } from '../../../src/probes/pointerGestures.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Expectation, Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'scroll-snap', 'reduced-motion-ignored'];
/** The tooltip's delays: short (shown 200-280 ms after the pointer comes) or long (300-450 ms). */
const DELAYS = ['short', 'long'] as const;
type Delay = (typeof DELAYS)[number];
const PASS = ['chart-tooltip', 'card-tooltip', 'icon-tooltip', 'map-region-tooltip'] as const;
const FAIL_DRAG = ['pan-map-tooltip', 'pan-map'] as const;
const FAIL_CLICK = ['click-card-tooltip', 'click-card'] as const;
type Kind = (typeof PASS)[number] | (typeof FAIL_DRAG)[number] | (typeof FAIL_CLICK)[number];

/** A delayed tooltip on `#t`: shows `show` ms after the pointer comes (mousemove or mouseenter) and hides `hide` ms after it leaves. */
const TIP = (show: number, hide: number, on: 'mousemove' | 'mouseenter') => `(function () { var el = document.getElementById('t'), tip = null, st = 0, ht = 0;
  function show() { clearTimeout(ht); if (tip) return; tip = document.createElement('div'); tip.className = 'tip'; tip.textContent = el.getAttribute('data-tip'); el.appendChild(tip); }
  el.addEventListener('${on}', function () { clearTimeout(ht); if (!tip) { clearTimeout(st); st = setTimeout(show, ${show}); } });
  el.addEventListener('mouseleave', function () { clearTimeout(st); clearTimeout(ht); ht = setTimeout(function () { if (tip) { tip.remove(); tip = null; } }, ${hide}); });
})();`;
/** A map that pans only by dragging: its layer moves with the mouse while the button is down. */
const PAN = `(function () { var m = document.getElementById('t'), l = document.getElementById('layer'), x = 0, d = null;
  m.addEventListener('mousedown', function (e) { d = { x: e.clientX, s: x }; e.preventDefault(); });
  document.addEventListener('mousemove', function (e) { if (!d) return; x = Math.max(-960, Math.min(0, d.s + e.clientX - d.x)); l.style.left = x + 'px'; });
  document.addEventListener('mouseup', function () { d = null; });
})();`;
const MAP = (tip: string) => `<div id="t"${tip ? ` data-tip="${tip}"` : ''} style="position:relative;width:480px;max-width:100%;height:200px;overflow:hidden;border:1px solid #595959"><div id="layer" style="position:absolute;left:0;top:0;width:1440px;height:200px;background:repeating-linear-gradient(90deg,#dbe8f7 0 60px,#0b4fb3 60px 120px)"></div></div>`;
const CARD = (tip: boolean) => `<div id="t"${tip ? ' data-tip="Click to see the hours"' : ''} style="position:relative;display:inline-block;cursor:pointer;padding:8px 12px;border:1px solid #595959">Main library</div><div id="hours" hidden><p>8 am to 6 pm, Monday to Saturday.</p></div>`;
const OPEN = "document.getElementById('t').addEventListener('click', function () { var h = document.getElementById('hours'); h.hidden = !h.hidden; });";

function build(kind: Kind, delay: Delay, r: () => number): { body: string; init: string[]; why: string } {
  const show = delay === 'short' ? 200 + Math.round(r() * 80) : 300 + Math.round(r() * 150);
  const hide = 400 + Math.round(r() * 200);
  switch (kind) {
    case 'chart-tooltip':
      return { body: '<div id="t" data-tip="General: 41 million" style="position:relative;width:480px;max-width:100%;height:160px"><svg xmlns="http://www.w3.org/2000/svg" width="480" height="160" role="img" aria-label="Spending by fund"><rect width="480" height="160" fill="#dbe8f7"/><rect x="40" y="20" width="100" height="140" fill="#0b4fb3"/></svg></div>', init: [TIP(show, hide, 'mousemove'), "document.getElementById('t').addEventListener('mousedown', function () {}); document.getElementById('t').addEventListener('click', function () {});"], why: 'a chart with a delayed tooltip and press and click listeners that do nothing' };
    case 'card-tooltip':
      return { body: '<div id="t" data-tip="Opens 9 am, closes 6 pm" style="position:relative;display:inline-block;padding:8px 12px;border:1px solid #595959">Main library</div>', init: [TIP(show, hide, 'mouseenter'), "document.getElementById('t').addEventListener('click', function () {});"], why: 'a card with a delayed hover card and a click listener that does nothing' };
    case 'icon-tooltip':
      return { body: '<span id="t" data-tip="Accessible entrance" style="position:relative;display:inline-block;width:32px;height:32px;background:#0b4fb3"></span>', init: [TIP(show, hide, 'mouseenter'), "document.getElementById('t').addEventListener('click', function (e) { e.stopPropagation(); });"], why: 'an icon with a delayed label and a click listener that only stops the click' };
    case 'map-region-tooltip':
      return { body: MAP('Riverside park'), init: [TIP(show, hide, 'mousemove'), "document.getElementById('t').addEventListener('mousedown', function (e) { e.preventDefault(); });"], why: 'a map picture with a delayed tooltip whose press listener only stops text selection (it does not pan)' };
    case 'pan-map-tooltip':
      return { body: MAP('River trail'), init: [PAN, TIP(show, hide, 'mousemove')], why: 'a map that pans only by dragging, with a delayed tooltip' };
    case 'pan-map':
      return { body: MAP(''), init: [PAN], why: 'a map that pans only by dragging' };
    case 'click-card-tooltip':
      return { body: CARD(true), init: [OPEN, TIP(show, hide, 'mouseenter')], why: 'a card that takes no focus and opens its hours on a click only, with a delayed tooltip' };
    case 'click-card':
      return { body: CARD(false), init: [OPEN], why: 'a card that takes no focus and opens its hours on a click only' };
  }
}

export function hoverNotActionCase(kind: Kind, delay: Delay, hazard: Hazard, seed: number): SimCase {
  const id = `hover-not-action/${kind}/${delay}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const b = build(kind, delay, r);
  // A drawing's tooltip shows over the drawing (as charting libraries draw theirs); a card's and an icon's below it.
  const inside = kind === 'chart-tooltip' || kind === 'map-region-tooltip' || kind === 'pan-map-tooltip';
  const pg = parts('Library services', `${filler(r, 1)}${b.body}<p style="margin-top:5rem">${filler(r, 1).replace(/<\/?p>/g, '')}</p><p><a href="/about">About the library</a></p>`, [`.tip { position: absolute; left: ${inside ? '8px' : '0'}; top: ${inside ? '8px' : '100%'}; padding: 4px 8px; background: #ffffff; border: 1px solid #333333; color: #1a1a1a; white-space: nowrap; pointer-events: none; }`], b.init);
  applyHazard(pg, hazard, r);
  const pass: Expectation = { verdict: 'pass' };
  const any: Expectation = { verdict: 'any' };
  const drag = (FAIL_DRAG as readonly string[]).includes(kind);
  const click = (FAIL_CLICK as readonly string[]).includes(kind);
  return {
    id, test: 'hover-not-action', hazard, params: { kind, delay },
    site: render(pg),
    expect: { '2.1.1': click ? { verdict: 'fail', count: 1 } : drag ? any : pass, '2.5.7': drag ? { verdict: 'fail', count: 1 } : click ? any : pass },
    why: b.why,
  };
}

export const hoverNotActionTest: SimTest = {
  id: 'hover-not-action', criteria: ['2.1.1', '2.5.7'], probes: () => [controlsProbe, pointerGesturesProbe], full: true, read: 'probe', readProbes: ['controls', 'pointer-gestures'], capMs: 150_000,
  cases: (seed) => [...PASS, ...FAIL_DRAG, ...FAIL_CLICK].flatMap((kind) => DELAYS.flatMap((d) => HAZARDS.map((h) => hoverNotActionCase(kind, d, h, seed)))),
};
