// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 1.4.13 Content on Hover or Focus, "dismissible" (probe `hover-content`), batch 17 (motion-pointer; a training-site
// false alarm): a tooltip whose Escape handler is on its trigger or the trigger's wrapper hides on Escape while
// keyboard focus is in the trigger, and not while only the pointer rests on it (the key then goes to the page). The
// test failed it; whether that Escape is a way to dismiss it is a judgement the test does not make (not testable).
// By construction (a tooltip shown by :hover and :focus-within of its wrapper, covering the next paragraph, hoverable
// and persistent):
// - pass: Escape handled on the wrapper, on the trigger itself, or on the whole page (each hides it until the pointer
//   or focus leaves);
// - fail: no Escape at all; Escape on the wrapper but a gap the pointer cannot cross (not hoverable); Escape on the
//   wrapper but it hides by itself after a second (not persistent).
import { hoverContentProbe } from '../../../src/probes/hoverContent.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'scroll-snap', 'reduced-motion-ignored'];
const PASS = ['wrapper-escape', 'trigger-escape', 'page-escape'] as const;
const FAIL = ['no-escape', 'wrapper-escape-gap', 'wrapper-escape-vanishes'] as const;
type Kind = (typeof PASS)[number] | (typeof FAIL)[number];
const TRIGGERS = ['button', 'link'] as const;

const ON = (target: string) => `(function () { var w = document.getElementById('wrap');
  ${target}.addEventListener('keydown', function (e) { if (e.key === 'Escape') { w.classList.add('dismissed'); e.preventDefault(); } });
  w.addEventListener('mouseleave', function () { if (!w.contains(document.activeElement)) w.classList.remove('dismissed'); });
  w.addEventListener('focusin', function () { w.classList.remove('dismissed'); });
  w.addEventListener('focusout', function (e) { if (!w.contains(e.relatedTarget)) w.classList.remove('dismissed'); }); })();`;

export function hoverEscapeCase(kind: Kind, trigger: (typeof TRIGGERS)[number], hazard: Hazard, seed: number): SimCase {
  const id = `hover-escape/${kind}/${trigger}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const trig = trigger === 'button' ? '<button type="button" id="trig" aria-describedby="tip">Where is the emergency exit?</button>' : '<a href="#exits" id="trig" aria-describedby="tip">Where is the emergency exit?</a>';
  const css = ['.wrap { position: relative; display: inline-block; margin: 24px 0 0; } .tip { display: none; position: absolute; left: 0; top: 100%; width: 280px; padding: 12px; background: #173e38; color: #fff; font: 14px/1.4 Arial; z-index: 5; } .wrap:hover .tip, .wrap:focus-within .tip { display: block; } .wrap.dismissed .tip { display: none; }'];
  if (kind === 'wrapper-escape-gap') css.push('.tip { top: calc(100% + 24px); pointer-events: none; }');
  if (kind === 'wrapper-escape-vanishes') css.push('.wrap:hover .tip, .wrap:focus-within .tip { animation: sim-tip-out 0.01s linear 1.2s forwards; } @keyframes sim-tip-out { to { visibility: hidden; } }');
  const init = kind === 'no-escape' ? [] : kind === 'page-escape' ? [ON('document')] : kind === 'trigger-escape' ? [ON("document.getElementById('trig')")] : [ON('w')];
  const body = `<p>Ride safely.</p><span class="wrap" id="wrap">${trig}<span class="tip" id="tip" role="tooltip">Exit instructions are posted above each emergency window. Ask the operator if you need help.</span></span><p>Follow the operator's instructions during an evacuation. Keep the aisle clear and hold a rail.</p>${filler(r, 2)}`;
  const pg = parts('Travel safely', body, css, init);
  applyHazard(pg, hazard, r);
  const fails = (FAIL as readonly string[]).includes(kind);
  return {
    id, test: 'hover-escape', hazard, params: { kind, trigger },
    site: render(pg),
    expect: { '1.4.13': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: fails ? `a tooltip ${kind === 'no-escape' ? 'that nothing hides' : kind === 'wrapper-escape-gap' ? 'with Escape on its wrapper, across a gap the pointer cannot cross' : 'with Escape on its wrapper, that hides by itself after a second'}` : `a hoverable, persistent tooltip with Escape handled on ${kind === 'page-escape' ? 'the page' : kind === 'trigger-escape' ? 'its trigger' : 'its wrapper'}`,
  };
}

export const hoverEscapeTest: SimTest = {
  id: 'hover-escape', criteria: ['1.4.13'], probes: () => [hoverContentProbe], full: true, read: 'probe', readProbes: ['hover-content'], capMs: 120_000,
  cases: (seed) => [...PASS, ...FAIL].flatMap((k) => TRIGGERS.flatMap((t) => HAZARDS.map((h) => hoverEscapeCase(k, t, h, seed)))),
};
