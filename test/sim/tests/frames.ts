// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Controls inside the page's own embedded frames (keyboard-op lane, 2026-11-11): pages whose answer is known by
// construction. A same-site frame (a parcel map, an event calendar, a booking tool) is part of the page; a
// keyboard user must be able to use what is in it.
// - controls-frames (2.1.1, 2.1.2), the controls test: a widget inside the frame and how it is wired. It fails
//   2.1.1 when a click does something and no key does (F54); a widget with Enter, Space or arrow keys wired
//   passes, and so does one whose function a control outside the frame offers with the keyboard (a careful
//   auditor passes it; the test, which does not compare presses across documents, may only say not testable).
//   2.1.2 fails when a dialog a button in the frame opens keeps focus with no way out; Escape, a Close button or
//   Tab leaving the dialog pass.
// - keyboard-frames (2.1.1), the keyboard walk's click-handler rule: an element in the frame that answers the
//   mouse and cannot get focus fails; a button, a card whose own link does the same, a pointer cursor with no
//   handler, and an element whose function a control outside the frame offers pass.
// Each frame is either a file of the site (`src`) or written by the page itself (`srcdoc`).
import { controlsProbe } from '../../../src/probes/controls/index.js';
import { keyboardProbe } from '../../../src/probes/keyboard/index.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

type Mode = 'src' | 'srcdoc';
const MODES: readonly Mode[] = ['src', 'srcdoc'];

const INNER_CSS = 'body { margin: 0; font: 16px/1.5 sans-serif; color: #1b1b1b; background: #fff; } main { padding: 8px 12px; } .ctl { display: inline-block; padding: 6px 12px; border: 2px solid #1d4d3f; border-radius: 4px; background: #e7f2ee; cursor: pointer; margin: 2px; } .ctl:focus { outline: 3px solid #0b57d0; outline-offset: 2px; } .day { display: inline-block; width: 36px; padding: 6px; border: 1px solid #555; cursor: pointer; text-align: center; } .modal { position: fixed; inset: 8px; background: #fff; border: 2px solid #333; padding: 8px; } [hidden] { display: none !important; }';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** The frame's own page. */
export function innerHtml(title: string, body: string, script: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${INNER_CSS}</style></head><body><main>${body}</main><script>${script}</script></body></html>`;
}

/** The page under test: some text, the frame, links after it; `outside` is markup beside the frame (and its script). */
export function withFrame(id: string, title: string, frameTitle: string, inner: string, mode: Mode, hazard: Hazard, outside = '', outsideInit = ''): SimCase['site'] {
  const r = rng(hash(id));
  const frame = mode === 'src'
    ? `<iframe id="tool" title="${frameTitle}" src="/frame/tool.html" style="width:600px;height:240px;border:1px solid #888"></iframe>`
    : `<iframe id="tool" title="${frameTitle}" srcdoc="${esc(inner)}" style="width:600px;height:240px;border:1px solid #888"></iframe>`;
  const pg = parts(title, `<p>${filler(r, 1, 18).replace(/<\/?p>/g, '').trim()}</p>\n${frame}\n${outside}<p><a href="/a">More about this service</a> · <a href="/b">Contact the office</a></p>${filler(r, 2)}`, [], outsideInit ? [outsideInit] : []);
  if (mode === 'src') pg.files['/frame/tool.html'] = inner;
  applyHazard(pg, hazard, r);
  return render(pg);
}

// ---------------------------------------------------------------------------------------------
// controls-frames

type Widget = 'layer' | 'span' | 'day' | 'tabs';
type Wiring = 'pointerup' | 'click' | 'keys' | 'outside';
const WIDGETS: readonly Widget[] = ['layer', 'span', 'day', 'tabs'];
const WIRINGS: readonly Wiring[] = ['pointerup', 'click', 'keys', 'outside'];
const C_HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'late-mount'];

const LABEL: Record<Widget, string> = { layer: 'Show flood zones', span: 'Show bus stops', day: 'November 18', tabs: 'Next week' };
const SHOWS: Record<Widget, string> = { layer: 'Lots 12 to 18 are in the flood zone.', span: 'Stops 4 and 9 have shelters.', day: 'Story time at 10 a.m. and a book club at 6 p.m.', tabs: 'One hearing next week.' };

export function widgetCase(widget: Widget, wiring: Wiring, mode: Mode, hazard: Hazard, seed: number): SimCase {
  const id = `controls-frames/${widget}/${wiring}/${mode}/${hazard}`;
  void seed;
  const keys = "function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } }";
  let body: string;
  let script: string;
  if (widget === 'tabs') {
    body = `<div role="tablist" aria-label="Weeks"><button id="t0" role="tab" aria-selected="true" aria-controls="p0" tabindex="0" class="ctl">This week</button><button id="t1" role="tab" aria-selected="false" aria-controls="p1" tabindex="-1" class="ctl">${LABEL.tabs}</button></div>
<section id="p0" role="tabpanel" aria-labelledby="t0"><p>Two meetings this week.</p></section><section id="p1" role="tabpanel" aria-labelledby="t1" hidden><p>${SHOWS.tabs}</p></section>`;
    const pick = "function pick(t) { tabs.forEach(function (x) { var on = x === t; x.tabIndex = on ? 0 : -1; x.setAttribute('aria-selected', String(on)); document.getElementById(x.getAttribute('aria-controls')).hidden = !on; }); }";
    const arrows = "t.addEventListener('keydown', function (e) { var i = tabs.indexOf(t); if (e.key === 'ArrowRight') i = (i + 1) % tabs.length; else if (e.key === 'ArrowLeft') i = (i + tabs.length - 1) % tabs.length; else return; e.preventDefault(); pick(tabs[i]); tabs[i].focus(); });";
    script = `var tabs = [].slice.call(document.querySelectorAll('[role=tab]')); ${pick}
tabs.forEach(function (t) { t.addEventListener('${wiring === 'pointerup' ? 'pointerup' : 'click'}', function () { pick(t); }); ${wiring === 'keys' ? arrows : ''} });
window.addEventListener('message', function (e) { if (e.data === 'go') pick(tabs[1]); });`;
  } else {
    const el = widget === 'span' ? `<span id="ctl" class="ctl" tabindex="0">${LABEL.span}</span>`
      : widget === 'day' ? `<div class="month" role="group" aria-label="November"><div class="day" role="button" tabindex="0">17</div><div id="ctl" class="day" role="button" tabindex="0" aria-label="${LABEL.day}">18</div></div>`
        : `<div id="ctl" class="ctl" role="button" tabindex="0" aria-expanded="false">${LABEL.layer}</div>`;
    body = `${el}<p id="out" hidden>${SHOWS[widget]}</p>`;
    script = `var c = document.getElementById('ctl'); function act() { var o = document.getElementById('out'); o.hidden = !o.hidden; }
c.addEventListener('${wiring === 'pointerup' ? 'pointerup' : 'click'}', act); ${wiring === 'keys' ? `c.addEventListener('keydown', ${keys});` : ''}
window.addEventListener('message', function (e) { if (e.data === 'go') act(); });`;
  }
  const inner = innerHtml('Service tool', body, script);
  // The page's own button with the same name, which tells the frame to do the same (a native button: the keyboard works).
  const outside = wiring === 'outside' ? `<p><button type="button" id="outside">${LABEL[widget]}</button></p>\n` : '';
  const outsideInit = wiring === 'outside' ? "document.getElementById('outside').addEventListener('click', function () { document.getElementById('tool').contentWindow.postMessage('go', '*'); });" : '';
  const ok = wiring === 'keys' || wiring === 'outside';
  return {
    id, test: 'controls-frames', hazard, params: { widget, wiring, mode },
    site: withFrame(id, 'Service map', 'Service tool', inner, mode, hazard, outside, outsideInit),
    expect: { '2.1.1': ok ? { verdict: 'pass' } : { verdict: 'fail', count: 1 }, '2.1.2': { verdict: 'any' } },
    why: ok ? `a ${widget} in a ${mode} frame, ${wiring === 'keys' ? 'with its keys wired' : 'whose function a button outside the frame offers'}` : `a ${widget} in a ${mode} frame that only ${wiring} works`,
  };
}

type Opener = 'native' | 'custom';
type Dialog = 'trap' | 'escape' | 'close' | 'tab-out';
const OPENERS: readonly Opener[] = ['native', 'custom'];
const DIALOGS: readonly Dialog[] = ['trap', 'escape', 'close', 'tab-out'];
const D_HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'late-mount', 'cookie-banner'];

export function dialogCase(opener: Opener, dialog: Dialog, mode: Mode, hazard: Hazard, seed: number): SimCase {
  const id = `controls-frames/dialog/${opener}/${dialog}/${mode}/${hazard}`;
  void seed;
  const open = opener === 'native' ? '<button id="lookup" type="button" class="ctl">Look up a parcel</button>' : '<div id="lookup" class="ctl" role="button" tabindex="0">Look up a parcel</div>';
  const close = dialog === 'close' ? ' <button type="button" id="x">Close</button>' : '';
  const body = `${open}<div id="dlg" class="modal" role="dialog" aria-modal="true" aria-label="Parcel lookup" hidden><label for="pn">Parcel number</label> <input id="pn"> <button type="button" id="find">Find parcel</button>${close}</div>`;
  const keys = opener === 'custom' ? "o.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); } });" : '';
  // Inside the dialog: Tab goes round its controls (but for 'tab-out'), Escape is kept (but for 'escape').
  const cycle = dialog === 'tab-out' ? '' : "if (e.key !== 'Tab') return; e.preventDefault(); var f = [].slice.call(d.querySelectorAll('input, button')); var i = f.indexOf(document.activeElement); f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();";
  const escape = dialog === 'escape' ? "if (e.key === 'Escape') { e.preventDefault(); hide(); return; }" : "if (e.key === 'Escape') { e.preventDefault(); return; }";
  const script = `var d = document.getElementById('dlg'), o = document.getElementById('lookup');
function show() { d.hidden = false; document.getElementById('pn').focus(); } function hide() { d.hidden = true; o.focus(); }
o.addEventListener('click', show); ${keys}
${dialog === 'close' ? "document.getElementById('x').addEventListener('click', hide);" : ''}
d.addEventListener('keydown', function (e) { ${escape} ${cycle} });`;
  const inner = innerHtml('Parcel lookup', body, script);
  return {
    id, test: 'controls-frames', hazard, params: { opener, dialog, mode },
    site: withFrame(id, 'Parcel lookup', 'Parcel lookup tool', inner, mode, hazard),
    expect: { '2.1.1': { verdict: 'pass' }, '2.1.2': dialog === 'trap' ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: dialog === 'trap' ? `a dialog in a ${mode} frame that keeps focus and Escape, with no way out` : `a dialog in a ${mode} frame that ${dialog === 'escape' ? 'Escape closes' : dialog === 'close' ? 'its Close button closes' : 'Tab leaves'}`,
  };
}

function frameControlCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  for (const widget of WIDGETS) for (const wiring of WIRINGS) for (const mode of MODES) for (const hazard of C_HAZARDS) out.push(widgetCase(widget, wiring, mode, hazard, seed));
  for (const opener of OPENERS) for (const dialog of DIALOGS) for (const mode of MODES) for (const hazard of D_HAZARDS) out.push(dialogCase(opener, dialog, mode, hazard, seed));
  return out;
}

export const controlsFramesTest: SimTest = {
  id: 'controls-frames', criteria: ['2.1.1', '2.1.2'], probes: () => [controlsProbe], full: true, read: 'probe', readProbes: ['controls'], capMs: 120_000, cases: frameControlCases,
};

// ---------------------------------------------------------------------------------------------
// keyboard-frames

type Thing = 'click-div' | 'delegated' | 'click-span' | 'pointerup-div' | 'mousedown-div' | 'onclick-attr' | 'button' | 'card-link' | 'cursor-only' | 'pointed' | 'named' | 'role-button';
const THINGS: readonly Thing[] = ['click-div', 'delegated', 'click-span', 'pointerup-div', 'mousedown-div', 'onclick-attr', 'button', 'card-link', 'cursor-only', 'pointed', 'named', 'role-button'];
const FAILING_THINGS: ReadonlySet<Thing> = new Set(['click-div', 'delegated', 'click-span', 'pointerup-div', 'mousedown-div', 'onclick-attr']);
const K_HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'late-mount', 'cookie-banner', 'font-swap'];

export function clickableCase(thing: Thing, mode: Mode, hazard: Hazard, seed: number): SimCase {
  const id = `keyboard-frames/${thing}/${mode}/${hazard}`;
  void seed;
  const days = (tag: string, extra = (_n: number) => '') => `<div class="month">${[17, 18, 19].map((n) => `<${tag} class="day" data-day="${n}" aria-label="November ${n}"${tag === 'button' ? ' type="button"' : ''}${extra(n)}>${n}</${tag}>`).join('')}</div>`;
  const each = (type: string) => `\n[].forEach.call(document.querySelectorAll('.day'), function (d) { d.addEventListener('${type}', function () { act(d.getAttribute('data-day')); }); });`;
  let body: string;
  let script = "function act(n) { var o = document.getElementById('out'); o.hidden = false; o.textContent = 'Events on November ' + n + ': story time at 10 a.m.'; }\nwindow.addEventListener('message', function (e) { if (/^\\d+$/.test(String(e.data))) act(e.data); });";
  switch (thing) {
    case 'click-div':
    case 'pointed':
    case 'named':
      body = days('div');
      script += "\n[].forEach.call(document.querySelectorAll('.day'), function (d) { d.addEventListener('click', function () { act(d.getAttribute('data-day')); }); });";
      break;
    case 'delegated':
      body = days('div');
      script += "\ndocument.querySelector('.month').addEventListener('click', function (e) { var d = e.target.closest('.day'); if (d) act(d.getAttribute('data-day')); });";
      break;
    case 'click-span':
      body = days('span');
      script += each('click');
      break;
    case 'pointerup-div':
      body = days('div');
      script += each('pointerup');
      break;
    case 'mousedown-div':
      body = days('div');
      script += each('mousedown');
      break;
    case 'onclick-attr':
      // An inline handler written on each day.
      body = days('div', (n) => ` onclick="act('${n}')"`);
      break;
    case 'role-button':
      // Focusable days with Enter and Space wired: the keyboard reaches and presses them.
      body = days('div', () => ' role="button" tabindex="0"');
      script += each('click') + "\n[].forEach.call(document.querySelectorAll('.day'), function (d) { d.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(d.getAttribute('data-day')); } }); });";
      break;
    case 'button':
      body = days('button');
      script += "\n[].forEach.call(document.querySelectorAll('.day'), function (d) { d.addEventListener('click', function () { act(d.getAttribute('data-day')); }); });";
      break;
    case 'card-link':
      // Each day is a card whose own link goes to the same place as a click on the card.
      body = `<div class="month">${[17, 18, 19].map((n) => `<div class="day" data-href="/events/${n}"><span>${n}</span> <a href="/events/${n}" target="_top">events</a></div>`).join('')}</div>`;
      script += "\n[].forEach.call(document.querySelectorAll('.day'), function (d) { d.addEventListener('click', function (e) { if (e.target.closest('a')) return; top.location.href = d.getAttribute('data-href'); }); });";
      break;
    default:
      // A pointer cursor with no handler anywhere.
      body = days('div');
  }
  body += '<p id="out" hidden></p>';
  const inner = innerHtml('Event calendar', body, script);
  const outside = thing === 'pointed' ? '<p><label for="pick">Or choose a day</label> <select id="pick" aria-controls="tool"><option>17</option><option>18</option><option>19</option></select></p>\n'
    : thing === 'named' ? `<p>${[17, 18, 19].map((n) => `<button type="button" class="outside" data-day="${n}">November ${n}</button>`).join(' ')}</p>\n` : '';
  const outsideInit = thing === 'pointed' ? "document.getElementById('pick').addEventListener('change', function (e) { document.getElementById('tool').contentWindow.postMessage(e.target.value, '*'); });"
    : thing === 'named' ? "[].forEach.call(document.querySelectorAll('.outside'), function (b) { b.addEventListener('click', function () { document.getElementById('tool').contentWindow.postMessage(b.getAttribute('data-day'), '*'); }); });" : '';
  const fails = FAILING_THINGS.has(thing);
  return {
    id, test: 'keyboard-frames', hazard, params: { thing, mode },
    site: withFrame(id, 'Library events', 'Event calendar', inner, mode, hazard, outside, outsideInit),
    expect: { '2.1.1': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: fails ? `days in a ${mode} frame that answer a click and cannot get focus` : `days in a ${mode} frame: ${thing}`,
  };
}

function frameClickableCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  for (const thing of THINGS) for (const mode of MODES) for (const hazard of K_HAZARDS) out.push(clickableCase(thing, mode, hazard, seed));
  return out;
}

export const keyboardFramesTest: SimTest = {
  id: 'keyboard-frames', criteria: ['2.1.1'], probes: () => [keyboardProbe], full: false, read: 'probe', readProbes: ['keyboard'], capMs: 90_000, cases: frameClickableCases,
};
