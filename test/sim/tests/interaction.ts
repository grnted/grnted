// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Interaction tests: 2.1.2 No Keyboard Trap (probe `keyboard`), 1.4.13 Content on Hover or Focus
// (probe `hover-content`, deep) and 2.5.1 Pointer Gestures / 2.5.7 Dragging Movements (probe
// `pointer-gestures`, deep). The answer by construction:
// - a trap: focus cannot leave a control or a region by Tab, Shift+Tab or Escape (a control that takes
//   focus back on blur, at once or a moment later; a Tab key handler that swallows the key; a region
//   that wraps focus with no way out); a dialog that wraps focus but closes on Escape or with its close
//   button is not a trap; the trap sits after 0 to 55 other Tab stops;
// - hover content must be dismissible (Escape hides it), hoverable (the pointer can move onto it) and
//   persistent (it stays while hovered or focused): each of the eight combinations, shown on hover and
//   focus by a script or by CSS; a native title tooltip is the browser's and passes;
// - a swipe-only carousel or a pinch-only map fails 2.5.1; drag-only sorting, a drag-only slider and a
//   drag-only map pan fail 2.5.7; each with a single-pointer alternative (next/previous, zoom buttons,
//   move up/down, increase/decrease, pan arrows) passes. The criterion a case is not about is not counted.
import { hoverContentProbe } from '../../../src/probes/hoverContent.js';
import { keyboardProbe } from '../../../src/probes/keyboard/index.js';
import { pointerGesturesProbe } from '../../../src/probes/pointerGestures.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'animation-in-flight', 'scroll-snap', 'none'];

const links = (n: number, r: () => number) => (n ? `<ul class="links">${Array.from({ length: n }, (_, i) => `<li><a href="#p${i}">${filler(r, 1, 2).replace(/<\/?p>|\.\n?/g, '')} ${i + 1}</a></li>`).join('')}</ul>` : '');
const LINK_CSS = '.links { columns: 4; font-size: 14px; margin: 8px 0; padding-left: 20px; } a:focus-visible, button:focus-visible, input:focus-visible { outline: 3px solid #b00020; outline-offset: 2px; }';

// ---------------------------------------------------------------------------------------------
// 2.1.2 keyboard traps.

export const TRAPS = ['refocus', 'refocus-later', 'swallow-tab', 'wrap-no-exit', 'dialog-escape', 'dialog-close', 'none', 'toolbar'] as const;
type Trap = (typeof TRAPS)[number];

export function trapCase(kind: Trap, before: number, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `keyboard-trap/${kind}/${before}-before/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const init: string[] = [];
  let html = '';
  switch (kind) {
    case 'refocus':
    case 'refocus-later':
      html = '<p><label for="trap">Your code</label> <input id="trap" type="text" autocomplete="off"></p>';
      init.push(`document.getElementById('trap').addEventListener('blur', function (e) { var t = e.target; ${kind === 'refocus' ? 't.focus();' : 'setTimeout(function () { t.focus(); }, 60);'} });`);
      break;
    case 'swallow-tab':
      html = '<p><label for="trap">Your code</label> <input id="trap" type="text" autocomplete="off"></p>';
      init.push("document.getElementById('trap').addEventListener('keydown', function (e) { if (e.key === 'Tab' || e.key === 'Escape') e.preventDefault(); });");
      break;
    case 'wrap-no-exit':
    case 'dialog-escape':
    case 'dialog-close': {
      const dialog = kind !== 'wrap-no-exit';
      html = `<div id="trap" ${dialog ? 'role="dialog" aria-modal="true" aria-labelledby="dt"' : 'role="group" aria-label="Sign in"'} class="box"><p id="dt">Sign in</p><p><label for="u">Name</label> <input id="u" type="text" autocomplete="username"></p><p><button type="button" id="go">Continue</button>${kind === 'dialog-close' ? ' <button type="button" id="close">Close</button>' : ''}</p></div>`;
      init.push(`(function () { var box = document.getElementById('trap'); var f = function () { return box.querySelectorAll('input, button'); };
  box.addEventListener('keydown', function (e) {
    ${kind === 'dialog-escape' || kind === 'dialog-close' ? "if (e.key === 'Escape') { box.remove(); return; }" : "if (e.key === 'Escape') { e.preventDefault(); return; }"}
    if (e.key !== 'Tab') return; var all = f(), first = all[0], last = all[all.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } });
  ${kind === 'dialog-close' ? "document.getElementById('close').addEventListener('click', function () { box.remove(); });" : ''} })();`);
      break;
    }
    case 'toolbar':
      html = '<div role="toolbar" aria-label="Text" id="tb"><button type="button" tabindex="0">Bold</button><button type="button" tabindex="-1">Italic</button><button type="button" tabindex="-1">Underline</button></div>';
      init.push("(function () { var b = document.querySelectorAll('#tb button'), i = 0; document.getElementById('tb').addEventListener('keydown', function (e) { if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return; b[i].tabIndex = -1; i = (i + (e.key === 'ArrowRight' ? 1 : b.length - 1)) % b.length; b[i].tabIndex = 0; b[i].focus(); }); })();");
      break;
    case 'none':
      html = '<p><label for="q">Search</label> <input id="q" type="search" autocomplete="off"></p>';
      break;
  }
  const pg = parts('Your account', `${links(before, r)}${html}<p><a href="#after">After the form</a></p>${filler(r, 2)}`, [LINK_CSS, '.box { border: 2px solid #1b1b1b; padding: 8px 16px; max-width: 420px; }'], init);
  applyHazard(pg, hazard, r);
  const fails = kind === 'refocus' || kind === 'refocus-later' || kind === 'swallow-tab' || kind === 'wrap-no-exit';
  return {
    id, test: 'keyboard-trap', hazard, params: { kind, before },
    site: render(pg),
    expect: { '2.1.2': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: fails ? `${kind}: focus cannot leave (Tab, Shift+Tab and Escape all kept in) after ${before} other stops` : `${kind}: focus can always leave`,
  };
}

export function trapCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const k of TRAPS) for (const b of [0, 5, 20, 45, 55]) for (const rep of [0, 1, 2]) out.push(trapCase(k, b, rep, HAZARDS[(i++ + rep * 4) % HAZARDS.length]!, seed));
  return [...new Map(out.map((c) => [c.id, c])).values()];
}

export const keyboardTrapTest: SimTest = {
  id: 'keyboard-trap', criteria: ['2.1.2'], probes: () => [keyboardProbe], full: false, read: 'criterion', capMs: 120_000, cases: trapCases,
};

// ---------------------------------------------------------------------------------------------
// 1.4.13 hover or focus content.

export interface HoverParams { dismiss: boolean; hoverable: boolean; persistent: boolean; how: 'script' | 'css'; trigger: 'button' | 'link'; hazard: Hazard; rep: number }

export function hoverCase(p: HoverParams, seed: number): SimCase {
  const id = `hover/${p.how}/${p.trigger}/${p.dismiss ? 'D' : 'd'}${p.hoverable ? 'H' : 'h'}${p.persistent ? 'P' : 'p'}/${p.rep}/${p.hazard}`;
  const r = rng(hash(id) ^ seed);
  const css: string[] = ['.tip-wrap { position: relative; display: inline-block; margin: 40px 0 0 24px; } .tip { position: absolute; left: 0; top: 100%; width: 260px; padding: 8px; background: #1b1b1b; color: #fff; font: 14px/1.4 Arial; z-index: 5; } .tip[hidden] { display: none; } a:focus-visible, button:focus-visible { outline: 3px solid #b00020; outline-offset: 2px; }'];
  const init: string[] = [];
  const trig = p.trigger === 'button' ? '<button type="button" id="trig" aria-describedby="tip">Fees</button>' : '<a href="#fees" id="trig" aria-describedby="tip">Fees</a>';
  // The tip covers the paragraph under the trigger (so it must be dismissible: content that covers nothing
  // need not be, the 1.4.13 exception). Not hoverable: a 24 px gap between trigger and tip, and the tip
  // hides when the trigger is left.
  if (!p.hoverable) css.push('.tip { top: calc(100% + 24px); }');
  const tip = `<div class="tip" id="tip" role="tooltip" hidden>The fee is 25 dollars for residents and 40 for visitors.</div>`;
  if (p.how === 'script') {
    init.push(`(function () { var w = document.getElementById('wrap'), t = document.getElementById('trig'), tip = document.getElementById('tip'), timer = 0;
  function show() { tip.hidden = false; clearTimeout(timer); ${p.persistent ? '' : 'timer = setTimeout(function () { tip.hidden = true; }, 1200);'} }
  function hide() { tip.hidden = true; }
  ${p.hoverable ? "w.addEventListener('mouseenter', show); w.addEventListener('mouseleave', hide);" : "t.addEventListener('mouseenter', show); t.addEventListener('mouseleave', hide);"}
  t.addEventListener('focus', show); t.addEventListener('blur', hide);
  ${p.dismiss ? "document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });" : ''} })();`);
  } else {
    // CSS: shown by :hover/:focus-within of the wrapper (hoverable) or of the trigger's sibling rule.
    css.push(p.hoverable ? '.tip-wrap:hover .tip, .tip-wrap:focus-within .tip { display: block; }' : '#trig:hover + .tip, #trig:focus + .tip { display: block; }');
    if (!p.persistent) css.push('.tip-wrap .tip { animation: sim-tip-out 0.01s linear 1.2s forwards; } @keyframes sim-tip-out { to { visibility: hidden; } }');
    if (p.dismiss) init.push("document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { var t = document.getElementById('tip'); t.style.setProperty('display', 'none', 'important'); document.getElementById('wrap').addEventListener('mouseleave', function () { t.style.removeProperty('display'); }, { once: true }); document.getElementById('trig').addEventListener('blur', function () { t.style.removeProperty('display'); }, { once: true }); } });");
  }
  const pg = parts('Park permits', `<p>Book a picnic shelter.</p><div class="tip-wrap" id="wrap">${trig}${tip}</div>${filler(r, 2)}`, css, init);
  applyHazard(pg, p.hazard, r);
  const fails = !(p.dismiss && p.hoverable && p.persistent);
  const missing = [!p.dismiss && 'not dismissible', !p.hoverable && 'not hoverable', !p.persistent && 'not persistent'].filter(Boolean).join(', ');
  return {
    id, test: 'hover', hazard: p.hazard, params: { how: p.how, trigger: p.trigger, dismissible: p.dismiss, hoverable: p.hoverable, persistent: p.persistent },
    site: render(pg),
    expect: { '1.4.13': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: fails ? `a tooltip on hover and focus that is ${missing}` : 'a tooltip that is dismissible, hoverable and persistent',
  };
}

export function hoverCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const how of ['script', 'css'] as const) for (const trigger of ['button', 'link'] as const) for (const dismiss of [true, false]) for (const hoverable of [true, false]) for (const persistent of [true, false]) {
    // The passing combination is repeated so both sides have enough cases.
    const reps = dismiss && hoverable && persistent ? 14 : 2;
    for (let rep = 0; rep < reps; rep++) out.push(hoverCase({ how, trigger, dismiss, hoverable, persistent, rep, hazard: HAZARDS[i++ % HAZARDS.length]! }, seed));
  }
  // A native title tooltip (the browser's own): passes.
  for (let rep = 0; rep < 6; rep++) {
    const id = `hover/title/${rep}`;
    const r = rng(hash(id) ^ seed);
    const pg = parts('Park permits', `<p>Book a picnic shelter.</p><p><button type="button" title="The fee is 25 dollars">Fees</button></p>${filler(r, 2)}`);
    out.push({ id, test: 'hover', hazard: 'none', params: { how: 'title' }, site: render(pg), expect: { '1.4.13': { verdict: 'pass' } }, why: 'a native title tooltip (drawn by the browser)' });
  }
  return out;
}

export const hoverTest: SimTest = {
  id: 'hover', criteria: ['1.4.13'], probes: () => [hoverContentProbe], full: true, read: 'probe', readProbes: ['hover-content'], capMs: 120_000, cases: hoverCases,
};

// ---------------------------------------------------------------------------------------------
// 2.5.1 / 2.5.7 gestures and drags.

export const GESTURES = ['swipe-carousel', 'pinch-map', 'sort-list', 'drag-slider', 'pan-map'] as const;
type Gesture = (typeof GESTURES)[number];
const CRIT: Record<Gesture, '2.5.1' | '2.5.7'> = { 'swipe-carousel': '2.5.1', 'pinch-map': '2.5.1', 'sort-list': '2.5.7', 'drag-slider': '2.5.7', 'pan-map': '2.5.7' };

export function gestureCase(g: Gesture, alternative: boolean, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `pointer/${g}/${alternative ? 'with-alternative' : 'only'}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const css: string[] = ['.region { position: relative; width: 640px; height: 240px; overflow: hidden; background: #e8eef4; border: 1px solid #555; touch-action: none; user-select: none; } button { font: 16px Arial; margin: 4px; }'];
  const init: string[] = [];
  let html = '';
  switch (g) {
    case 'swipe-carousel':
      html = `<div class="region" id="reg" aria-roledescription="carousel" aria-label="Stories"><div id="track" style="display:flex;width:300%;height:100%;transition:transform .2s">${[1, 2, 3].map((i) => `<div style="flex:1;padding:40px;font:24px Arial;background:${['#cde', '#dec', '#edc'][i - 1]}">Story ${i}</div>`).join('')}</div></div>${alternative ? '<p><button type="button" id="prev">Previous story</button><button type="button" id="next">Next story</button></p>' : ''}`;
      init.push(`(function () { var reg = document.getElementById('reg'), tr = document.getElementById('track'), i = 0, x0 = null;
  function go(d) { i = Math.max(0, Math.min(2, i + d)); tr.style.transform = 'translateX(' + (-i * 100 / 3) + '%)'; }
  reg.addEventListener('pointerdown', function (e) { x0 = e.clientX; });
  reg.addEventListener('pointerup', function (e) { if (x0 === null) return; var dx = e.clientX - x0; x0 = null; if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1); });
  ${alternative ? "document.getElementById('prev').onclick = function () { go(-1); }; document.getElementById('next').onclick = function () { go(1); };" : ''} })();`);
      break;
    case 'pinch-map':
    case 'pan-map':
      html = `<div class="region" id="reg" role="img" aria-label="Map of the parks"><div id="map" style="position:absolute;left:0;top:0;width:640px;height:240px;transform-origin:0 0;background:repeating-linear-gradient(45deg,#9bc 0 20px,#bde 20px 40px)"></div></div>${alternative ? (g === 'pinch-map' ? '<p><button type="button" id="zin">Zoom in</button><button type="button" id="zout">Zoom out</button></p>' : '<p><button type="button" id="pl">Pan left</button><button type="button" id="pr">Pan right</button><button type="button" id="pu">Pan up</button><button type="button" id="pd">Pan down</button></p>') : ''}`;
      init.push(`(function () { var reg = document.getElementById('reg'), m = document.getElementById('map'), s = 1, tx = 0, ty = 0, pts = new Map(), d0 = 0, s0 = 1, last = null;
  function draw() { m.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')'; }
  reg.addEventListener('pointerdown', function (e) { pts.set(e.pointerId, e); if (pts.size === 2) { var a = [...pts.values()]; d0 = Math.hypot(a[0].clientX - a[1].clientX, a[0].clientY - a[1].clientY); s0 = s; } last = e; });
  reg.addEventListener('pointermove', function (e) { if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, e);
    ${g === 'pinch-map' ? "if (pts.size === 2) { var a = [...pts.values()]; var d = Math.hypot(a[0].clientX - a[1].clientX, a[0].clientY - a[1].clientY); if (d0) { s = Math.max(0.5, Math.min(4, s0 * d / d0)); draw(); } }" : "if (pts.size === 1 && last) { tx += e.clientX - last.clientX; ty += e.clientY - last.clientY; last = e; draw(); }"} });
  ['pointerup', 'pointercancel'].forEach(function (t) { reg.addEventListener(t, function (e) { pts.delete(e.pointerId); last = null; }); });
  ${alternative ? (g === 'pinch-map' ? "document.getElementById('zin').onclick = function () { s = Math.min(4, s * 1.25); draw(); }; document.getElementById('zout').onclick = function () { s = Math.max(0.5, s / 1.25); draw(); };" : "[['pl', 40, 0], ['pr', -40, 0], ['pu', 0, 40], ['pd', 0, -40]].forEach(function (b) { document.getElementById(b[0]).onclick = function () { tx += b[1]; ty += b[2]; draw(); }; });") : ''} })();`);
      break;
    case 'sort-list':
      html = `<ol id="list" aria-label="Your priorities">${['Parks', 'Streets', 'Library', 'Transit'].map((t, i) => `<li draggable="true" data-i="${i}" style="padding:8px;margin:4px 0;background:#e8eef4;border:1px solid #555;cursor:grab;width:300px">${t}${alternative ? ` <button type="button" class="up">Move ${t} up</button><button type="button" class="down">Move ${t} down</button>` : ''}</li>`).join('')}</ol>`;
      init.push(`(function () { var list = document.getElementById('list'), drag = null;
  list.addEventListener('dragstart', function (e) { drag = e.target.closest('li'); });
  list.addEventListener('dragover', function (e) { e.preventDefault(); });
  list.addEventListener('drop', function (e) { e.preventDefault(); var t = e.target.closest('li'); if (drag && t && t !== drag) list.insertBefore(drag, t); else if (drag && t === drag) list.appendChild(drag); });
  ${alternative ? "list.addEventListener('click', function (e) { var li = e.target.closest('li'); if (!li) return; if (e.target.classList.contains('up') && li.previousElementSibling) list.insertBefore(li, li.previousElementSibling); if (e.target.classList.contains('down') && li.nextElementSibling) list.insertBefore(li.nextElementSibling, li); });" : ''} })();`);
      break;
    case 'drag-slider':
      html = `<p id="lab">Distance</p><div id="track" style="position:relative;width:400px;height:8px;background:#555;margin:24px 0"><div id="thumb" role="slider" tabindex="0" aria-labelledby="lab" aria-valuemin="0" aria-valuemax="100" aria-valuenow="20" style="position:absolute;top:-12px;left:80px;width:32px;height:32px;border-radius:16px;background:#00376d;cursor:grab"></div></div>${alternative ? '<p><button type="button" id="dec">Decrease distance</button><button type="button" id="inc">Increase distance</button></p>' : ''}<p>Value: <output id="val">20</output></p>`;
      init.push(`(function () { var th = document.getElementById('thumb'), tr = document.getElementById('track'), out = document.getElementById('val'), v = 20, on = false;
  function set(n) { v = Math.max(0, Math.min(100, Math.round(n))); th.style.left = (v * 4) + 'px'; th.setAttribute('aria-valuenow', v); out.textContent = v; }
  th.addEventListener('pointerdown', function (e) { on = true; th.setPointerCapture && th.setPointerCapture(e.pointerId); e.preventDefault(); });
  th.addEventListener('pointermove', function (e) { if (!on) return; var b = tr.getBoundingClientRect(); set((e.clientX - b.left) / 4); });
  th.addEventListener('pointerup', function () { on = false; });
  th.addEventListener('keydown', function (e) { if (e.key === 'ArrowRight') set(v + 1); if (e.key === 'ArrowLeft') set(v - 1); });
  ${alternative ? "document.getElementById('dec').onclick = function () { set(v - 10); }; document.getElementById('inc').onclick = function () { set(v + 10); };" : ''} })();`);
      break;
  }
  const pg = parts('Explore the city', `<p>See what is near you.</p>${html}${filler(r, 2)}`, css, init);
  applyHazard(pg, hazard, r);
  const crit = CRIT[g];
  const other = crit === '2.5.1' ? '2.5.7' : '2.5.1';
  const fails = !alternative;
  return {
    id, test: 'pointer', hazard, params: { gesture: g, alternative },
    site: render(pg),
    expect: { [crit]: fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' }, [other]: { verdict: 'any' } },
    why: fails ? `${g}: only a ${crit === '2.5.1' ? 'path-based or multipoint gesture' : 'drag'} does it` : `${g} with a single-pointer alternative`,
  };
}

export function gestureCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const g of GESTURES) for (const alt of [false, true]) for (let rep = 0; rep < 12; rep++) out.push(gestureCase(g, alt, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  return out;
}

export const pointerTest: SimTest = {
  id: 'pointer', criteria: ['2.5.1', '2.5.7'], probes: () => [pointerGesturesProbe], full: true, read: 'probe', readProbes: ['pointer-gestures'], capMs: 120_000, cases: gestureCases,
};
