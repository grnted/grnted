// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.2.2 Pause, Stop, Hide (probe `motion`), batch 17 item 1: a control is credited for stopping motion only when the
// stop is not explained by the motion's own end. Before, an end that came during a control's check passed a Pause
// button that does nothing (the release 0.2.0 lab allowlist: motion/ticker/8s/broken, motion/canvas/8s/broken).
// By construction (motion that starts by itself and lasts more than 5 s, one Pause or Hide button beside it):
// - kinds: a canvas drawn by an animation-frame loop, a canvas drawn by a fast timer, headlines rotated by a timer;
// - fail: a Pause button that does nothing, the motion's own end landing in the test's check (a quarter second after
//   the pointer reaches the button: what an 8 s run's end does by its own clock in the lab's motion test) or three
//   seconds later (the check sees it still moving);
// - pass: Pause that cancels the loop or clears the timer, Pause that sets a flag the loop reads (it keeps running
//   and draws nothing), Stop that clears it and leaves a still picture, Hide that hides the box.
// An end in the check leaves a Pause that does nothing undecided (not testable): never credited (the fix), and never
// failed either (the end proves nothing about the button). Those cases are counted as missed failures here.
import { motionProbe } from '../../../src/probes/motion.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'scroll-snap', 'reduced-motion-ignored'];
const KINDS = ['canvas-frames', 'canvas-timer', 'rotation'] as const;
const CONTROLS = ['broken', 'broken-late', 'pause-cancel', 'pause-flag', 'stop', 'hide'] as const;
type Kind = (typeof KINDS)[number];
type Control = (typeof CONTROLS)[number];

function script(kind: Kind, control: Control): string {
  const endIn = control === 'broken' ? 250 : control === 'broken-late' ? 3000 : null;
  const ends = endIn === null ? '' : `document.getElementById('ctl').addEventListener('mouseover', function () { if (endAt === Infinity) endAt = performance.now() + ${endIn}; });`;
  const head = 'var endAt = Infinity, paused = false;';
  if (kind === 'rotation') {
    const act = control === 'pause-cancel' ? 'clearInterval(t);' : control === 'pause-flag' ? 'paused = true;' : control === 'stop' ? "clearInterval(t); i = 0; h.textContent = s[0];" : control === 'hide' ? "document.getElementById('box').hidden = true;" : '';
    return `(function () { ${head} var s = ['Story 1: The library opens a new reading room.', 'Story 2: Road work on Main Street ends Friday.', 'Story 3: The pool reopens on Monday.'], i = 0, h = document.getElementById('headline');
  var t = setInterval(function () { if (performance.now() > endAt) { clearInterval(t); return; } if (paused) return; i = (i + 1) % s.length; h.textContent = s[i]; }, 1200);
  ${ends} document.getElementById('ctl').addEventListener('click', function () { ${act} }); })();`;
  }
  const draw = "var e = performance.now() - t0; g.fillStyle = '#eef3f8'; g.fillRect(0, 0, 600, 120); g.fillStyle = '#00376d'; g.fillRect((e / 8) % 520, 30, 80, 60);";
  const still = "g.fillStyle = '#eef3f8'; g.fillRect(0, 0, 600, 120);";
  if (kind === 'canvas-frames') {
    const act = control === 'pause-cancel' ? 'cancelAnimationFrame(raf);' : control === 'pause-flag' ? 'paused = true;' : control === 'stop' ? `cancelAnimationFrame(raf); ${still}` : control === 'hide' ? "document.getElementById('box').hidden = true;" : '';
    return `(function () { ${head} var c = document.getElementById('wave'), g = c.getContext('2d'), t0 = performance.now(), raf = 0;
  function step(t) { if (t > endAt) return; if (!paused) { ${draw} } raf = requestAnimationFrame(step); } raf = requestAnimationFrame(step);
  ${ends} document.getElementById('ctl').addEventListener('click', function () { ${act} }); })();`;
  }
  const act = control === 'pause-cancel' ? 'clearInterval(t);' : control === 'pause-flag' ? 'paused = true;' : control === 'stop' ? `clearInterval(t); ${still}` : control === 'hide' ? "document.getElementById('box').hidden = true;" : '';
  return `(function () { ${head} var c = document.getElementById('wave'), g = c.getContext('2d'), t0 = performance.now();
  var t = setInterval(function () { if (performance.now() > endAt) { clearInterval(t); return; } if (!paused) { ${draw} } }, 40);
  ${ends} document.getElementById('ctl').addEventListener('click', function () { ${act} }); })();`;
}

export function motionEndedCase(kind: Kind, control: Control, hazard: Hazard, seed: number): SimCase {
  const id = `motion-ended/${kind}/${control}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const el = kind === 'rotation' ? '<p id="headline">Story 1: The library opens a new reading room.</p>' : '<canvas id="wave" width="600" height="120" role="img" aria-label="A moving wave"></canvas>';
  const label = control === 'hide' ? 'Hide the news' : control === 'stop' ? 'Stop' : 'Pause';
  const body = `<p>News from the city.</p><div id="box" class="news-box">${el}</div><button type="button" id="ctl">${label}</button>${filler(r, 3)}`;
  const pg = parts('City news', body, ['.news-box { width: 600px; max-width: 100%; min-height: 120px; background: #eef3f8; margin: 16px 0; } #headline { margin: 0; padding: 40px 16px; font: 20px Arial; }'], [script(kind, control)]);
  applyHazard(pg, hazard, r);
  const fails = control === 'broken' || control === 'broken-late';
  return {
    id, test: 'motion-ended', hazard, params: { kind, control },
    site: render(pg),
    expect: { '2.2.2': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: fails ? `moves more than 5 s; its Pause button does nothing (its own end comes ${control === 'broken' ? 'during the test\'s check' : 'three seconds after the pointer reaches the button'})` : `moves more than 5 s; ${label} ${control === 'pause-flag' ? 'sets a flag its loop reads' : control === 'hide' ? 'hides it' : 'stops its loop'}`,
  };
}

export const motionEndedTest: SimTest = {
  id: 'motion-ended', criteria: ['2.2.2'], probes: () => [motionProbe], full: false, read: 'probe', readProbes: ['motion'], capMs: 120_000,
  cases: (seed) => KINDS.flatMap((k) => CONTROLS.flatMap((c) => HAZARDS.map((h) => motionEndedCase(k, c, h, seed)))),
};
