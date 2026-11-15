// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 19, precision lane (lane A): the look-alikes WCAG allows for the criteria whose failures were false alarms on
// unseen sites, each beside the failures that must stay failed. Every expectation is written from the criterion's
// normative text and its Understanding document before the engine is run; nothing here was read from a blind site.
//
// 2.2.2 Pause, Stop, Hide (probe `motion`). SC: "there is a mechanism for the user to pause, stop, or hide it";
// Understanding 2.2.2: "The word 'pause' here is meant in the sense of a 'pause button' although other mechanisms than
// a button can be used"; for auto-updating content the mechanism may instead "control the frequency of the update".
// The method fails moving content when it finds no control that stops it. Its assumption: every mechanism is a button
// or a toggle its vocabulary names. The look-alikes are mechanisms it may not name or reach: a check box or a switch
// that turns the slideshow off, a button named in words outside the vocabulary ("Disable autoplay", "Turn off
// auto-scroll", "Reduce motion", "Calm mode"), a pause button that is shown on hover and on keyboard focus, a
// page-wide motion toggle in the header. Failures that stay failed: no control at all, only previous / next / slide
// buttons, a Pause button that does nothing, pausing on hover only.
import { formsProbe } from '../../../src/probes/forms.js';
import { motionProbe } from '../../../src/probes/motion.js';
import { pointerCancellationProbe } from '../../../src/probes/pointerCancellation.js';
import { screenReaderProbe } from '../../../src/probes/screenReader/index.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'scroll-snap', 'none'];

// ---------------------------------------------------------------------------------------------
// 2.2.2: mechanisms the vocabulary may not name.

export const PAUSE_MOVERS = ['carousel', 'ticker'] as const;
/** Mechanisms that work (the content stops or is hidden): expected pass. */
export const PAUSE_WORKING = [
  'checkbox', 'switch', 'disable-autoplay', 'turn-off-autoscroll', 'reduce-motion-header', 'calm-mode', 'hover-focus-revealed',
  'pressed-toggle', 'still-images', 'hold',
] as const;
/** No mechanism (or one that does nothing, or only on hover): expected fail. */
export const PAUSE_FAILING = ['none', 'nav-only', 'broken-disable', 'hover-only'] as const;
type PMover = (typeof PAUSE_MOVERS)[number];
type PControl = (typeof PAUSE_WORKING)[number] | (typeof PAUSE_FAILING)[number];

export function pauseCase(mover: PMover, control: PControl, hazard: Hazard, seed: number): SimCase {
  const id = `b19-pause/${mover}/${control}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const css: string[] = [
    '.mover-box { position: relative; width: 600px; max-width: 100%; min-height: 120px; overflow: hidden; background: #eef3f8; margin: 16px 0; padding-bottom: 44px; }',
    '.box-ctl { position: absolute; right: 8px; bottom: 8px; z-index: 2; }',
    '.nav { position: absolute; left: 8px; bottom: 8px; z-index: 2; display: flex; gap: 6px; }',
    'button, [role="switch"] { font: 15px Arial; padding: 6px 10px; border: 2px solid #00376d; background: #fff; color: #00376d; cursor: pointer; }',
  ];
  const init: string[] = [];
  let el = '';
  // Pausing: the page's own way of stopping its motion (a flag the slideshow reads, CSS animations paused).
  const pause = "document.querySelectorAll('#mover, #mover *').forEach(function (e) { e.getAnimations().forEach(function (a) { a.pause(); }); }); window.__simPaused = true;";
  const resume = "document.querySelectorAll('#mover, #mover *').forEach(function (e) { e.getAnimations().forEach(function (a) { a.play(); }); }); window.__simPaused = false;";
  if (mover === 'carousel') {
    el = `<div class="mover" id="mover">${[1, 2, 3].map((i) => `<p class="slide${i === 1 ? ' on' : ''}">Story ${i}: ${filler(r, 1, 6).replace(/<\/?p>/g, '')}</p>`).join('')}</div>`;
    css.push('.mover .slide { display: none; margin: 0; padding: 30px 16px; font: 20px Arial; } .mover .slide.on { display: block; }');
    init.push(`(function () { var i = 0, s = document.querySelectorAll('#mover .slide');
  window.__simGo = function (d) { s[i].classList.remove('on'); i = (i + d + s.length) % s.length; s[i].classList.add('on'); };
  window.__simTimer = setInterval(function () { if (window.__simPaused) return; window.__simGo(1); }, 1500); })();`);
  } else {
    el = '<p class="mover" id="mover">Road closures: Main St, 2nd Ave and the bridge are closed for repairs this week.</p>';
    css.push('.mover { position: absolute; top: 40px; left: 0; margin: 0; white-space: nowrap; font: 20px Arial; color: #1b1b1b; animation: b19-tick 10s linear infinite both; } @keyframes b19-tick { from { transform: translateX(600px); } to { transform: translateX(-100%); } }');
  }
  const nav = mover === 'carousel'
    ? '<div class="nav"><button type="button" onclick="window.__simGo(-1)">Previous</button><button type="button" onclick="window.__simGo(1)">Next</button></div>'
    : '';
  let inBox = '';
  let header = '';
  switch (control) {
    case 'checkbox':
      inBox = `<label class="box-ctl"><input type="checkbox" checked onchange="if (this.checked) { ${resume} } else { ${pause} }"> Auto-advance ${mover === 'carousel' ? 'slides' : 'the ticker'}</label>`;
      css.push('.box-ctl { font: 15px Arial; background: #fff; padding: 4px 8px; }');
      break;
    case 'switch':
      inBox = `<span class="box-ctl" role="switch" tabindex="0" aria-checked="true" onclick="var on = this.getAttribute('aria-checked') === 'true'; this.setAttribute('aria-checked', on ? 'false' : 'true'); if (on) { ${pause} } else { ${resume} }" onkeydown="if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); this.click(); }">${mover === 'carousel' ? 'Slideshow' : 'Scrolling text'}</span>`;
      css.push('.box-ctl[role="switch"] { font: 15px Arial; background: #fff; border: 2px solid #00376d; padding: 4px 8px; }');
      break;
    case 'disable-autoplay': inBox = `<button type="button" class="box-ctl" onclick="${pause}">Disable autoplay</button>`; break;
    case 'turn-off-autoscroll': inBox = `<button type="button" class="box-ctl" onclick="${pause}">Turn off auto-scroll</button>`; break;
    case 'calm-mode': inBox = `<button type="button" class="box-ctl" onclick="${pause}">Calm mode</button>`; break;
    case 'still-images': inBox = `<button type="button" class="box-ctl" onclick="${pause}">Still view</button>`; break;
    case 'hold': inBox = `<button type="button" class="box-ctl" onclick="${pause}">Hold</button>`; break;
    case 'pressed-toggle': inBox = `<button type="button" class="box-ctl" aria-pressed="true" onclick="var on = this.getAttribute('aria-pressed') === 'true'; this.setAttribute('aria-pressed', on ? 'false' : 'true'); if (on) { ${pause} } else { ${resume} }">Auto-rotate</button>`; break;
    case 'hover-focus-revealed':
      inBox = `<button type="button" class="box-ctl reveal" onclick="${pause}">Pause</button>`;
      css.push('.reveal { opacity: 0; } .mover-box:hover .reveal, .mover-box:focus-within .reveal, .reveal:focus { opacity: 1; }');
      break;
    case 'reduce-motion-header':
      header = `<div class="site-tools"><button type="button" aria-pressed="false" onclick="this.setAttribute('aria-pressed', 'true'); ${pause}">Reduce motion</button></div>`;
      break;
    case 'broken-disable': inBox = '<button type="button" class="box-ctl" onclick="void 0">Disable autoplay</button>'; break;
    case 'hover-only':
      css.push('.mover-box:hover .mover, .mover-box:hover .mover * { animation-play-state: paused; }');
      init.push("document.getElementById('box').addEventListener('mouseenter', function () { window.__simPaused = true; }); document.getElementById('box').addEventListener('mouseleave', function () { window.__simPaused = false; });");
      break;
    case 'nav-only':
    case 'none':
      break;
  }
  const navHere = control === 'nav-only' || (mover === 'carousel' && control !== 'none') ? nav : '';
  const body = `${header}<p>News from the city.</p><div class="mover-box" id="box">${el}${navHere}${inBox}</div>${filler(r, 3)}`;
  const pg = parts('City news', body, css, init);
  applyHazard(pg, hazard, r);
  const fails = (PAUSE_FAILING as readonly string[]).includes(control);
  return {
    id, test: 'b19-pause', hazard, params: { mover, control },
    site: render(pg),
    expect: { '2.2.2': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: fails ? `moves with no end and ${control === 'none' ? 'no control' : control === 'nav-only' ? 'only Previous / Next buttons' : control === 'hover-only' ? 'only a pause on hover' : 'a "Disable autoplay" button that does nothing'}`
      : `moves with no end; ${control} stops it (a mechanism WCAG allows: "other mechanisms than a button can be used")`,
  };
}

/**
 * Real-site class (P0 dev split): a form's hidden time stamp that a script rewrites every half second changes nothing on
 * screen, so nothing moves or updates (pass); the same script writing a time shown on the page is an auto-updating region
 * with no way to pause it (fail).
 */
export function stampCase(shown: boolean, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `b19-pause/stamp/${shown ? 'shown' : 'hidden'}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const field = shown ? '<p>Page checked at <span id="ts">0</span></p>' : '<input type="hidden" name="captcha_settings" id="ts" value="{}">';
  const body = `<p>Send a question to the service desk.</p><form id="contact"><label for="q">Your question</label> <textarea id="q" name="q"></textarea>${field}<p><button>Send</button></p></form>${filler(r, 2)}`;
  const js = shown
    ? "setInterval(function () { document.getElementById('ts').textContent = String(Date.now()); }, 500);"
    : "setInterval(function () { var e = document.getElementById('ts'); e.value = JSON.stringify({ ts: String(Date.now()) }); }, 500);";
  const pg = parts('Contact us', body, [], [js]);
  applyHazard(pg, hazard, r);
  return {
    id, test: 'b19-pause', hazard, params: { mover: 'stamp', control: shown ? 'shown' : 'hidden' }, site: render(pg),
    expect: { '2.2.2': shown ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: shown ? 'a time shown on the page updates every half second with no way to pause it' : 'only a hidden form field changes: nothing moves or updates on screen',
  };
}

export function pauseCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const m of PAUSE_MOVERS) for (const c of [...PAUSE_WORKING, ...PAUSE_FAILING]) out.push(pauseCase(m, c, HAZARDS[i++ % HAZARDS.length]!, seed));
  for (const shown of [false, true]) for (let rep = 0; rep < 3; rep++) out.push(stampCase(shown, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  return out;
}

export const b19PauseTest: SimTest = {
  id: 'b19-pause', criteria: ['2.2.2'], probes: () => [motionProbe], full: false, read: 'probe', readProbes: ['motion'], capMs: 120_000, cases: pauseCases,
};

// ---------------------------------------------------------------------------------------------
// 2.5.2 Pointer cancellation (probe `pointer-cancellation`, deep). SC 2.5.2, Note 1: "Functions that emulate a keyboard or
// numeric keypad key press are considered essential"; Understanding: "The most prevalent essential down-event activation
// occurs in keyboard emulation". The method fails a press whose effect lasts after moving away and releasing. The
// look-alikes are keypads and keyboards on the page that type on the down event; the failures that stay are ordinary
// controls that act on the down event, a row of page numbers among them.

export const KEYPAD_KINDS = ['pin-keypad', 'calculator', 'onscreen-keyboard', 'page-numbers', 'vote', 'next-photo'] as const;
type KeypadKind = (typeof KEYPAD_KINDS)[number];
const KEYPAD_PASS: readonly KeypadKind[] = ['pin-keypad', 'calculator', 'onscreen-keyboard'];

export function keypadCase(kind: KeypadKind, event: 'pointerdown' | 'mousedown', rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `b19-keypad/${kind}/${event}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const css = ['.keys { display: grid; grid-template-columns: repeat(3, 56px); gap: 6px; margin: 12px 0; } .keys.wide { grid-template-columns: repeat(10, 40px); }',
    '.keys button, .row button { font: 18px Arial; padding: 8px 0; border: 2px solid #1b1b1b; background: #fff; color: #1b1b1b; } .row { display: flex; gap: 6px; margin: 12px 0; } .row button { padding: 8px 12px; }',
    '#display { display: block; min-height: 28px; font: 22px monospace; border: 1px solid #555; padding: 4px 8px; width: 220px; }'];
  let html = '';
  let js = '';
  const keys = (labels: readonly string[], cls = 'keys') => `<div class="${cls}" role="group" aria-label="${kind === 'onscreen-keyboard' ? 'Keyboard' : 'Keypad'}">${labels.map((k) => `<button type="button" data-key="${k}">${k}</button>`).join('')}</div>`;
  switch (kind) {
    case 'pin-keypad':
      html = `<p>Enter the 4-digit code from your letter.</p><output id="display" aria-live="polite"></output>${keys(['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Clear', '0', 'Back'])}`;
      js = `document.querySelectorAll('.keys button').forEach(function (b) { b.addEventListener('${event}', function () { var d = document.getElementById('display'), k = b.dataset.key; if (k === 'Clear') d.textContent = ''; else if (k === 'Back') d.textContent = d.textContent.slice(0, -1); else d.textContent += k; }); });`;
      break;
    case 'calculator':
      html = `<p>Work out your bill: enter the units you used.</p><output id="display"></output>${keys(['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '.', '×'])}`;
      js = `document.querySelectorAll('.keys button').forEach(function (b) { b.addEventListener('${event}', function () { document.getElementById('display').textContent += b.dataset.key; }); });`;
      break;
    case 'onscreen-keyboard':
      html = `<p><label for="q">Search the catalog</label> <input id="q" type="text"></p>${keys('QWERTYUIOPASDFGHJKLZXCVBNM'.split(''), 'keys wide')}`;
      js = `document.querySelectorAll('.keys button').forEach(function (b) { b.addEventListener('${event}', function (e) { e.preventDefault(); var q = document.getElementById('q'); q.value += b.dataset.key.toLowerCase(); }); });`;
      break;
    case 'page-numbers':
      html = `<p id="display">Page 1 of 5</p><div class="row" role="group" aria-label="Pages">${['1', '2', '3', '4', '5'].map((k) => `<button type="button" data-key="${k}">${k}</button>`).join('')}</div>`;
      js = `document.querySelectorAll('.row button').forEach(function (b) { b.addEventListener('${event}', function () { document.getElementById('display').textContent = 'Page ' + b.dataset.key + ' of 5'; }); });`;
      break;
    case 'vote':
      html = '<p id="display">No vote yet.</p><div class="row"><button type="button" id="v">Vote for the river trail</button></div>';
      js = `document.getElementById('v').addEventListener('${event}', function () { document.getElementById('display').textContent = 'Your vote: the river trail.'; });`;
      break;
    case 'next-photo':
      html = '<p id="display">Photo 1 of 5</p><div class="row"><button type="button" id="v">Next photo</button></div>';
      js = `document.getElementById('v').addEventListener('${event}', function () { document.getElementById('display').textContent = 'Photo 2 of 5'; });`;
      break;
  }
  const pg = parts('Service center', `<p>Service center.</p>${html}${filler(r, 2)}`, css, [js]);
  applyHazard(pg, hazard, r);
  const pass = KEYPAD_PASS.includes(kind);
  return {
    id, test: 'b19-keypad', hazard, params: { kind, event }, site: render(pg),
    expect: { '2.5.2': pass ? { verdict: 'pass' } : { verdict: 'fail', count: 1 } },
    why: pass ? `${kind}: its keys type on the ${event} event, as a keyboard's do (keyboard emulation is essential, Note 1)` : `${kind}: an ordinary control acts on the ${event} event with nothing on release to undo it (F101)`,
  };
}

export function keypadCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const k of KEYPAD_KINDS) for (const ev of ['pointerdown', 'mousedown'] as const) for (let rep = 0; rep < 3; rep++) out.push(keypadCase(k, ev, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  return out;
}

export const b19KeypadTest: SimTest = {
  id: 'b19-keypad', criteria: ['2.5.2'], probes: () => [pointerCancellationProbe], full: true, read: 'probe', readProbes: ['pointer-cancellation'], capMs: 120_000, cases: keypadCases,
};

// ---------------------------------------------------------------------------------------------
// 1.3.2 Meaningful sequence (probe `screen-reader`, its reading order). SC: "When the sequence in which content is
// presented affects its meaning, a correct reading sequence can be programmatically determined." Understanding 1.3.2:
// "if a page contains two independent articles, the relative order of the articles may not affect their meaning";
// "Tables and ordered lists are meaningful sequences, but unordered lists are not"; "the relative order of the main
// section of a web page and a navigation section does not affect their meaning". The method fails two neighbouring
// blocks read in one order and shown in the other. Its assumption: every such pair is a sequence that carries meaning.
// The look-alikes are pairs WCAG says need not be: independent sections (cards, a side section), the items of an
// unordered list, and a heading with the short label shown over it. The failures that stay are steps.

export const ORDER_KINDS = ['cards-column', 'ul-reordered', 'side-section-first', 'eyebrow-over-heading', 'date-over-heading', 'steps-reversed', 'ol-reordered', 'instructions-swapped'] as const;
type OKind = (typeof ORDER_KINDS)[number];
const ORDER_PASS: readonly OKind[] = ['cards-column', 'ul-reordered', 'side-section-first', 'eyebrow-over-heading', 'date-over-heading'];

export function orderCase(kind: OKind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `b19-order/${kind}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const col = 'display:flex;flex-direction:column';
  const STEPS = ['First fill in the request form with your name and your address.', 'Then hand the request form to the front desk before the end of the month.', 'Last, keep the receipt the front desk gives you until the work is done.'];
  let main = '';
  switch (kind) {
    case 'cards-column': main = `<div style="${col}"><article style="order:2"><h3>Water quality</h3><p>Read the monthly results and the annual report.</p></article><article style="order:1"><h3>System maintenance</h3><p>Learn why crews flush hydrants and test valves.</p></article></div>`; break;
    case 'ul-reordered': main = `<ul style="${col}"><li style="order:3">Library cards</li><li style="order:1">Meeting rooms</li><li style="order:2">Computer help</li></ul>`; break;
    case 'side-section-first': main = `<div style="${col}"><section style="order:2"><h2>Our services</h2><p>Permits, inspections and records for every property in the city.</p></section><aside style="order:1"><h2>Office hours</h2><p>Monday to Friday, eight to five.</p></aside></div>`; break;
    case 'eyebrow-over-heading': main = `<div style="${col}"><h2 style="order:2">Water main replaced on Elm Street</h2><p style="order:1;font-size:13px;text-transform:uppercase">News</p></div><p>Crews finished the work two days early.</p>`; break;
    case 'date-over-heading': main = `<div style="${col}"><h2 style="order:2">Library opens a new reading room</h2><p style="order:1;font-size:13px">November 3, 2026</p></div><p>The room has twenty seats and quiet hours every morning.</p>`; break;
    case 'steps-reversed': main = `<div style="display:flex;flex-direction:column-reverse">${[...STEPS].reverse().map((s) => `<p>${s}</p>`).join('')}</div>`; break;
    case 'ol-reordered': main = `<ol style="${col}"><li style="order:3">${STEPS[2]}</li><li style="order:1">${STEPS[0]}</li><li style="order:2">${STEPS[1]}</li></ol>`; break;
    case 'instructions-swapped': main = `<div style="${col}"><p style="order:2">${STEPS[1]}</p><p style="order:1">${STEPS[0]}</p></div>`; break;
  }
  const pg = parts('How to apply', `<p>${filler(r, 1, 18).replace(/<\/?p>/g, '')}</p><h2>How to apply</h2>${main}${filler(r, 1)}`, [], []);
  applyHazard(pg, hazard, r);
  const pass = ORDER_PASS.includes(kind);
  return {
    id, test: 'b19-order', hazard, params: { kind }, site: render(pg),
    expect: { '1.3.2': pass ? { verdict: 'pass' } : { verdict: 'fail', count: 1 } },
    why: pass ? `${kind}: shown in another order than read, where WCAG says the order does not affect the meaning` : `${kind}: steps read in another order than shown`,
  };
}

export const b19OrderTest: SimTest = {
  id: 'b19-order', criteria: ['1.3.2'], probes: () => [screenReaderProbe], full: false, read: 'probe', readProbes: ['screen-reader'], capMs: 90_000,
  cases: (seed) => { const out: SimCase[] = []; let i = 0; const still: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'font-swap', 'none']; for (const k of ORDER_KINDS) for (let rep = 0; rep < 4; rep++) out.push(orderCase(k, rep, still[i++ % still.length]!, seed)); return out; },
};

// ---------------------------------------------------------------------------------------------
// 3.2.2 On input (probe `forms`, deep). SC: "...does not automatically cause a change of context unless the user has been
// advised of the behavior before using the component." The method fails a change of context on input unless its advice
// wording matches. Its assumption: advice is said in the words its patterns know. The look-alikes say it in others, in
// the control's own label or description, or in a sentence about choosing right by it. The failures that stay have a
// short label and nothing about what choosing does.

export const INPUT_PASS = [
  ['label', 'Pick a department to visit its page'], ['label', 'Choose a month to see that meeting\'s agenda'],
  ['label', 'Select a language and the site switches to it'], ['after', 'Your choice goes straight to that page.'],
  ['after', 'Choosing a school brings up its own page.'], ['hint', 'Each option is a link to another page of this site.'],
  ['before', 'Pick a topic from the list below and you go there right away.'],
] as const;
export const INPUT_FAIL = [['label', 'Department'], ['label', 'Quick links'], ['label', 'Meeting month'], ['label', 'Choose a park'], ['label', 'Reason for closing'], ['nearby', 'Board meetings are held on the second Tuesday of each month.']] as const;

export function inputCase(i: number, pass: boolean, rep: number, hazard: Hazard, seed: number): SimCase {
  const [where, words] = (pass ? INPUT_PASS : INPUT_FAIL)[i]!;
  const id = `b19-on-input/${pass ? 'advised' : 'silent'}/${i}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const label = where === 'label' ? words : where === 'nearby' ? 'Meeting month' : 'Department';
  const before = where === 'before' || where === 'nearby' ? `<p>${words}</p>` : '';
  const hint = where === 'hint' ? `<p id="dh">${words}</p>` : '';
  const after = where === 'after' ? ` <span>${words}</span>` : '';
  const body = `<form id="j">${before}<label for="d">${label}</label>${hint}<select id="d" name="d"${hint ? ' aria-describedby="dh"' : ''}><option value="">Choose one</option><option value="/parks">Parks</option><option value="/water">Water</option></select>${after}</form>${filler(r, 2)}`;
  const pg = parts('Departments', body, [], ["document.getElementById('d').addEventListener('change', function (e) { if (e.target.value) location.href = e.target.value; });"]);
  pg.routes['/parks'] = { status: 200, type: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en"><title>Parks</title><main><h1>Parks</h1></main></html>' };
  pg.routes['/water'] = { status: 200, type: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en"><title>Water</title><main><h1>Water</h1></main></html>' };
  applyHazard(pg, hazard, r);
  return {
    id, test: 'b19-on-input', hazard, params: { where, words: words.slice(0, 40) }, site: render(pg),
    expect: { '3.2.2': pass ? { verdict: 'pass' } : { verdict: 'fail', count: 1 } },
    why: pass ? `the ${where} says what choosing does: "${words}"` : `a list that navigates on choice; ${where === 'nearby' ? 'the text before it says nothing about the list' : `its label "${words}" says nothing about it`}`,
  };
}

export const b19OnInputTest: SimTest = {
  id: 'b19-on-input', criteria: ['3.2.2'], probes: () => [formsProbe], full: true, read: 'probe', readProbes: ['forms'], capMs: 120_000,
  cases: (seed) => { const out: SimCase[] = []; let n = 0; for (let i = 0; i < INPUT_PASS.length; i++) for (let rep = 0; rep < 2; rep++) out.push(inputCase(i, true, rep, HAZARDS[n++ % HAZARDS.length]!, seed)); for (let i = 0; i < INPUT_FAIL.length; i++) for (let rep = 0; rep < 2; rep++) out.push(inputCase(i, false, rep, HAZARDS[n++ % HAZARDS.length]!, seed)); return out; },
};
