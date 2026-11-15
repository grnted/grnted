// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.5.2 Pointer Cancellation (probe `pointer-cancellation`, deep) and 2.5.4 Motion Actuation (probe
// `motion-actuation`), read from the probes' findings.
//
// Source of truth. SC 2.5.2: "For functionality that can be operated using a single pointer, at least one
// of the following is true: No Down-Event: The down-event of the pointer is not used to execute any part
// of the function; Abort or Undo: Completion of the function is on the up-event, and a mechanism is
// available to abort the function before completion or to undo the function after completion; Up
// Reversal: The up-event reverses any outcome of the preceding down-event; Essential: …". F101: "Failure
// of Success Criterion 2.5.2 due to activating a control on the down-event".
// SC 2.5.4: "Functionality that can be operated by device motion or user motion can also be operated by
// user interface components and responding to the motion can be disabled to prevent accidental
// actuation, except when: Supported Interface …; Essential …". F106: "Failure due to inability to
// deactivate motion actuation".
//
// 2.5.2, by construction (one control on the page: a div role="button", a span with a click-style
// handler, or a <button type="button">, neutrally named):
// - fails: on pointerdown or mousedown it shows a details panel, hides a notice, changes "Photo 1 of 5" to
//   "Photo 2 of 5", toggles aria-pressed, or loads /next; nothing on release undoes it (F101);
// - passes: the same effects on click (the up-event); a press-and-hold that shows the panel on down and
//   hides it again on up, leave and cancel (Up Reversal); a down handler that only adds a pressed look
//   removed on up; a pointerup handler; a down handler that only records where it was pressed.
// 2.5.4, by construction (a synthetic shake or tilt):
// - fails: shaking undoes the last edit of a note, or tilting moves to the next slide, with no button that
//   does the same; or with such a button but nothing that turns the motion response off (F106);
// - passes: the button and a "Shake to undo" / "Tilt to change slides" switch that turns it off; a tilt
//   that only moves a background (parallax, inline style); a listener that does nothing; no listener
//   (not applicable).
import { motionActuationProbe } from '../../../src/probes/actuation.js';
import { pointerCancellationProbe } from '../../../src/probes/pointerCancellation.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'animation-in-flight', 'scroll-snap', 'reduced-motion-honored'];
const CSS = '.ctl { display: inline-block; padding: 10px 16px; font: 16px Arial; background: #fff; color: #1b1b1b; border: 2px solid #1b1b1b; cursor: pointer; } .ctl:focus-visible { outline: 3px solid #00376d; outline-offset: 2px; } .ctl.pressed { background: #e8e8e8; } #panel { border: 1px solid #555; padding: 8px; }';

// ---------------------------------------------------------------------------------------------
// 2.5.2 Pointer cancellation.

export const CANCEL_ELEMENTS = ['div-button', 'span', 'button'] as const;
export const CANCEL_EFFECTS = ['show-panel', 'hide-notice', 'next-photo', 'toggle-pressed', 'navigate'] as const;
export const CANCEL_PASS = ['click', 'up-reversal', 'pressed-look', 'pointerup', 'track-only'] as const;
type El = (typeof CANCEL_ELEMENTS)[number];
type Eff = (typeof CANCEL_EFFECTS)[number];

const effectJs = (e: Eff) => ({
  'show-panel': "document.getElementById('panel').hidden = false;",
  'hide-notice': "document.getElementById('notice').hidden = true;",
  'next-photo': "document.getElementById('cap').textContent = 'Photo 2 of 5';",
  'toggle-pressed': "var b = document.getElementById('ctl'); b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');",
  navigate: "location.assign('/next');",
}[e]);

export function cancelCase(kind: 'down' | (typeof CANCEL_PASS)[number], el: El, effect: Eff, event: 'pointerdown' | 'mousedown', rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `pointer-cancel/${kind}/${el}/${effect}/${event}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const name = { 'show-panel': 'Show details', 'hide-notice': 'Hide notice', 'next-photo': 'Next photo', 'toggle-pressed': 'Large text', navigate: 'Continue reading' }[effect];
  const pressed = effect === 'toggle-pressed' ? ' aria-pressed="false"' : '';
  const ctl = el === 'button' ? `<button type="button" id="ctl" class="ctl"${pressed}>${name}</button>`
    : el === 'div-button' ? `<div role="button" tabindex="0" id="ctl" class="ctl"${pressed}>${name}</div>`
      : `<span id="ctl" class="ctl">${name}</span>`;
  const html = `<p id="notice">The pool is closed on Monday.</p><p id="cap">Photo 1 of 5</p><p>${ctl}</p><div id="panel" hidden><p>Open 6 am to 9 pm, Tuesday to Sunday.</p></div>`;
  let script = '';
  switch (kind) {
    case 'down': script = `document.getElementById('ctl').addEventListener('${event}', function () { ${effectJs(effect)} });`; break;
    case 'click': script = `document.getElementById('ctl').addEventListener('click', function () { ${effectJs(effect)} });`; break;
    case 'pointerup': script = `document.getElementById('ctl').addEventListener('pointerup', function () { ${effectJs(effect)} });`; break;
    case 'up-reversal':
      script = `var c = document.getElementById('ctl'), p = document.getElementById('panel');
c.addEventListener('${event}', function () { p.hidden = false; });
['pointerup', 'pointerleave', 'pointercancel', 'mouseup', 'mouseleave'].forEach(function (t) { c.addEventListener(t, function () { p.hidden = true; }); });`;
      break;
    case 'pressed-look':
      script = `var c = document.getElementById('ctl'); c.addEventListener('${event}', function () { c.classList.add('pressed'); });
['pointerup', 'pointerleave', 'pointercancel', 'mouseup', 'mouseleave'].forEach(function (t) { c.addEventListener(t, function () { c.classList.remove('pressed'); }); });
c.addEventListener('click', function () { ${effectJs(effect)} });`;
      break;
    case 'track-only': script = `window.__at = []; document.getElementById('ctl').addEventListener('${event}', function (e) { window.__at.push([e.clientX, e.clientY]); }); document.getElementById('ctl').addEventListener('click', function () { ${effectJs(effect)} });`; break;
  }
  const pg = parts('Pool', `<p>City pool.</p>${html}${filler(r, 2)}`, [CSS], [script]);
  pg.routes['/next'] = { status: 200, type: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en"><title>Next</title><main><h1>Next</h1></main></html>' };
  applyHazard(pg, hazard, r);
  const fails = kind === 'down';
  const WHY = {
    down: `${event} on a ${el} runs "${effect}" with nothing on release to undo it (F101)`, click: 'the function runs on click (up-event)', pointerup: 'the function runs on pointerup',
    'up-reversal': 'press and hold shows the panel; release, leave and cancel hide it (Up Reversal)', 'pressed-look': 'down only adds a pressed look, removed on release; the function runs on click',
    'track-only': 'down only records where it was pressed; the function runs on click',
  } as const;
  return { id, test: 'pointer-cancel', hazard, params: { kind, el, effect, event }, site: render(pg), expect: { '2.5.2': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } }, why: WHY[kind] };
}

export function cancelCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const el of CANCEL_ELEMENTS) for (const effect of CANCEL_EFFECTS) for (const event of ['pointerdown', 'mousedown'] as const) for (let rep = 0; rep < 2; rep++) {
    out.push(cancelCase('down', el, effect, event, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  }
  for (const kind of CANCEL_PASS) for (const el of CANCEL_ELEMENTS) for (const event of ['pointerdown', 'mousedown'] as const) for (let rep = 0; rep < (kind === 'click' || kind === 'pointerup' ? 3 : 2); rep++) {
    const effect = kind === 'up-reversal' ? 'show-panel' : CANCEL_EFFECTS[(i + rep) % CANCEL_EFFECTS.length]!;
    if ((kind === 'click' || kind === 'pointerup') && event === 'mousedown') continue;
    out.push(cancelCase(kind, el, effect, event, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  }
  return out;
}

export const pointerCancelTest: SimTest = {
  id: 'pointer-cancel', criteria: ['2.5.2'], probes: () => [pointerCancellationProbe], full: true, read: 'probe', readProbes: ['pointer-cancellation'], capMs: 120_000, cases: cancelCases,
};

// ---------------------------------------------------------------------------------------------
// 2.5.4 Motion actuation.

export const ACTUATION_FAIL = ['shake-no-control', 'shake-no-off', 'tilt-no-control', 'tilt-no-off'] as const;
export const ACTUATION_PASS = ['shake-control-off', 'tilt-control-off', 'parallax', 'noop-listener', 'no-listener'] as const;
type ActKind = (typeof ACTUATION_FAIL)[number] | (typeof ACTUATION_PASS)[number];

export function actuationCase(kind: ActKind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `motion-actuation/${kind}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const shake = kind.startsWith('shake');
  const tilt = kind.startsWith('tilt');
  const control = kind.endsWith('no-off') || kind.endsWith('control-off');
  const off = kind.endsWith('control-off');
  let html = '';
  let script = '';
  if (shake) {
    html = `<section aria-label="Note"><p id="note">Meeting moved to Thursday at 6 pm.</p>${control ? '<p><button type="button" id="undo" class="ctl">Undo</button></p>' : ''}${off ? '<p><input type="checkbox" id="on" checked> <label for="on">Shake to undo</label></p>' : ''}</section>`;
    script = `var undo = function () { document.getElementById('note').textContent = 'Meeting on Wednesday at 6 pm.'; };
var last = 0; addEventListener('devicemotion', function (e) { var a = e.accelerationIncludingGravity || e.acceleration || {}; var m = Math.abs(a.x || 0) + Math.abs(a.y || 0) + Math.abs(a.z || 0);
  ${off ? "if (!document.getElementById('on').checked) return;" : ''} if (m > 15 && Date.now() - last > 300) { last = Date.now(); undo(); } });
${control ? "document.getElementById('undo').addEventListener('click', undo);" : ''}`;
  } else if (tilt) {
    html = `<section aria-label="Slides"><p id="slide">Slide 1 of 4: the new library.</p>${control ? '<p><button type="button" id="next" class="ctl">Next slide</button></p>' : ''}${off ? '<p><input type="checkbox" id="on" checked> <label for="on">Tilt to change slides</label></p>' : ''}</section>`;
    script = `var n = 1; var next = function () { n = n % 4 + 1; document.getElementById('slide').textContent = 'Slide ' + n + ' of 4: ' + ['the new library', 'the river path', 'the skate park', 'the market'][n - 1] + '.'; };
var armed = true; addEventListener('deviceorientation', function (e) { ${off ? "if (!document.getElementById('on').checked) return;" : ''} var g = e.gamma || 0; if (Math.abs(g) > 30 && armed) { armed = false; next(); } if (Math.abs(g) < 10) armed = true; });
${control ? "document.getElementById('next').addEventListener('click', next);" : ''}`;
  } else if (kind === 'parallax') {
    html = '<div id="bg" class="bg" aria-hidden="true"></div>';
    script = "addEventListener('deviceorientation', function (e) { document.getElementById('bg').style.transform = 'translate(' + ((e.gamma || 0) / 6) + 'px, ' + ((e.beta || 0) / 6) + 'px)'; });";
  } else if (kind === 'noop-listener') {
    script = "window.__m = 0; addEventListener('devicemotion', function () { window.__m++; });";
  }
  const pg = parts('City news', `<p>The latest from the city.</p>${html}${filler(r, 2)}`, [CSS, '.bg { height: 120px; background: linear-gradient(90deg, #cfe3c8, #e8f0ff); }', 'input:focus-visible { outline: 3px solid #00376d; }'], script ? [script] : []);
  applyHazard(pg, hazard, r);
  const fails = (ACTUATION_FAIL as readonly string[]).includes(kind);
  const WHY: Record<ActKind, string> = {
    'shake-no-control': 'shaking undoes an edit; no button does it', 'shake-no-off': 'an Undo button does it too, but nothing turns shake-to-undo off (F106)',
    'tilt-no-control': 'tilting changes the slide; no button does it', 'tilt-no-off': 'a Next button does it too, but nothing turns tilting off (F106)',
    'shake-control-off': 'an Undo button and a "Shake to undo" switch', 'tilt-control-off': 'a Next button and a "Tilt to change slides" switch',
    parallax: 'tilting only moves a background (no function)', 'noop-listener': 'a motion listener that does nothing', 'no-listener': 'no motion listener (not applicable)',
  };
  return {
    id, test: 'motion-actuation', hazard, params: { kind }, site: render(pg),
    expect: { '2.5.4': fails ? { verdict: 'fail', count: 1 } : kind === 'no-listener' ? { verdict: 'na' } : { verdict: 'pass' } }, why: WHY[kind],
  };
}

export function actuationCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const kind of ACTUATION_FAIL) for (let rep = 0; rep < 13; rep++) out.push(actuationCase(kind, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  for (const kind of ACTUATION_PASS) for (let rep = 0; rep < 11; rep++) out.push(actuationCase(kind, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  return out;
}

export const motionActuationTest: SimTest = {
  id: 'motion-actuation', criteria: ['2.5.4'], probes: () => [motionActuationProbe], full: false, read: 'probe', readProbes: ['motion-actuation'], capMs: 90_000, cases: actuationCases,
};
