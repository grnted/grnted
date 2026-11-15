// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A focus loop in what a same-site frame shows by itself (keyboard-op lane, 2026-11-11; fix round 1: the controls
// test's frame focus loop, `frameLoop`, gets a lab of its own): pages whose answer is known by construction. The
// keyboard walk stops where focus goes into a frame; the controls test Tabs through the frame's own content from its
// first stop and judges a cycle with the keyboard test's trap rules (Shift+Tab, Escape, Close-named buttons, an
// advised key, the loop's other plain buttons).
// - Fails 2.1.2 (F10): the frame's script sends Tab and Shift+Tab round its own controls and keeps Escape, with no way
//   out: a plain wrap, a wrap whose "Close" button does nothing, a wrap inside a modal panel.
// - Passes: Tab leaves the frame after its last control (no loop); a loop that Escape leaves; one whose Close button
//   leaves; one that Shift+Tab leaves (only Tab wraps); one whose text advises a key that leaves (Alt+Q).
// Each frame is a file of the site (`src`) or written by the page itself (`srcdoc`); its controls are buttons, a form
// (a field and a button) or links within the frame.
import { controlsProbe } from '../../../src/probes/controls/index.js';
import type { Hazard, SimCase, SimTest } from '../types.js';
import { innerHtml, withFrame } from './frames.js';

type Mode = 'src' | 'srcdoc';
const MODES: readonly Mode[] = ['src', 'srcdoc'];
type Widget = 'buttons' | 'form' | 'links';
const WIDGETS: readonly Widget[] = ['buttons', 'form', 'links'];
type Loop = 'wrap' | 'dead-close' | 'modal' | 'none' | 'escape' | 'close' | 'shift-out' | 'advised';
const TRAPS: readonly Loop[] = ['wrap', 'dead-close', 'modal'];
const WAYS_OUT: readonly Loop[] = ['none', 'escape', 'close', 'shift-out', 'advised'];
const F_HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'font-swap'];
const P_HAZARDS: readonly Hazard[] = ['none', 'cookie-banner'];

/** The frame's controls: three of a kind (their presses change nothing outside a note in the frame). */
function controls(widget: Widget): string {
  if (widget === 'buttons') return '<button type="button" class="ctl" id="c1">Show parks</button> <button type="button" class="ctl" id="c2">Show schools</button> <button type="button" class="ctl" id="c3">Show libraries</button>';
  if (widget === 'form') return '<label for="addr">Street address</label> <input id="addr" autocomplete="street-address"> <button type="button" class="ctl" id="c2">Look up</button> <button type="button" class="ctl" id="c3">Clear</button>';
  return '<a href="#parks" id="c1">Parks</a> · <a href="#schools" id="c2">Schools</a> · <a href="#libraries" id="c3">Libraries</a>';
}

export function loopCase(loop: Loop, widget: Widget, mode: Mode, hazard: Hazard, seed: number): SimCase {
  const id = `controls-frame-loop/${loop}/${widget}/${mode}/${hazard}`;
  void seed;
  const close = loop === 'close' || loop === 'dead-close' ? ' <button type="button" class="ctl" id="x">Close</button>' : '';
  const advice = loop === 'advised' ? '<p>Press Alt+Q to leave this map.</p>' : '';
  const inner = `${advice}${controls(widget)}${close}<p id="note" class="note"></p>`;
  const body = loop === 'modal' ? `<div role="dialog" aria-modal="true" aria-label="Service map">${inner}</div>` : inner;
  // Out of the frame: focus to the page's next link (the frame is the page's own, so its script may do it).
  const leave = "var a = window.parent.document.querySelector('main p a'); if (a) a.focus();";
  const wraps = loop !== 'none';
  const script = `var f = [].slice.call(document.querySelectorAll('button, input, a[href]'));
[].forEach.call(document.querySelectorAll('.ctl'), function (b) { if (b.id !== 'x') b.addEventListener('click', function () { document.getElementById('note').textContent = b.textContent + ' shown.'; }); });
${loop === 'close' ? `document.getElementById('x').addEventListener('click', function () { ${leave} });` : ''}
document.addEventListener('keydown', function (e) {
  ${loop === 'escape' ? `if (e.key === 'Escape') { e.preventDefault(); ${leave} return; }` : "if (e.key === 'Escape') { e.preventDefault(); return; }"}
  ${loop === 'advised' ? `if (e.altKey && (e.key === 'q' || e.key === 'Q' || e.code === 'KeyQ')) { e.preventDefault(); ${leave} return; }` : ''}
  if (e.key !== 'Tab' || ${wraps ? 'false' : 'true'}) return;
  ${loop === 'shift-out' ? 'if (e.shiftKey) return;' : ''}
  e.preventDefault();
  var i = f.indexOf(document.activeElement);
  f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
});`;
  const page = innerHtml('Service map', body, script);
  const fails = TRAPS.includes(loop);
  return {
    id, test: 'controls-frame-loop', hazard, params: { loop, widget, mode },
    site: withFrame(id, 'Service map', 'Service map', page, mode, hazard),
    expect: { '2.1.1': { verdict: 'any' }, '2.1.2': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: fails ? `${widget} in a ${mode} frame whose script keeps Tab, Shift+Tab and Escape in it (${loop})` : `${widget} in a ${mode} frame: ${loop === 'none' ? 'Tab leaves after the last control' : `a loop with a way out (${loop})`}`,
  };
}

function loopCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  for (const loop of TRAPS) for (const widget of WIDGETS) for (const mode of MODES) for (const hazard of F_HAZARDS) out.push(loopCase(loop, widget, mode, hazard, seed));
  for (const loop of WAYS_OUT) for (const widget of WIDGETS) for (const mode of MODES) for (const hazard of P_HAZARDS) out.push(loopCase(loop, widget, mode, hazard, seed));
  return out;
}

export const controlsFrameLoopTest: SimTest = {
  id: 'controls-frame-loop', criteria: ['2.1.2'], probes: () => [controlsProbe], full: true, read: 'probe', readProbes: ['controls'], capMs: 120_000, cases: loopCases,
};
