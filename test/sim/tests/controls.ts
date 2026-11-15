// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The controls test (src/probes/controls/): pages whose answer is known by construction.
// - controls-keyboard (2.1.1): a control and how it is wired. It fails when a mouse click does
//   something a person would notice and no key does (WCAG failure F54); a native button with a click
//   handler, a custom control with Enter or Space wired, tabs with arrow keys, and a listener that does
//   nothing a person would notice all pass. So does a pointer-only control whose function the keyboard
//   reaches another way: a key it names for itself, or another control that does the same.
// - controls-status (4.1.3): what a press shows. It fails when the press shows a status message (the
//   result of the action) in no live region while focus stays; the same message in a status region, an
//   alert, or with focus moved to it passes, and so does content a control shows and hides.
// - controls-opened (2.4.3, 2.1.2): what a press opens. A panel with controls that focus is not moved
//   into and the next Tab presses do not reach fails 2.4.3 (F85); a dialog that keeps focus with no way
//   out fails 2.1.2.
import { controlsProbe } from '../../../src/probes/controls/index.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'animation-in-flight', 'scroll-snap', 'reduced-motion-honored'];
const CSS = '.ctl { display: inline-block; padding: 8px 14px; border: 2px solid #1d4d3f; border-radius: 4px; background: #e7f2ee; cursor: pointer; } .ctl:focus { outline: 3px solid #0b57d0; outline-offset: 2px; } .note { min-height: 1.5em; } [hidden] { display: none !important; }';

// ---------------------------------------------------------------------------------------------
// 2.1.1

type Kind = 'role-button' | 'plain-span' | 'native' | 'tabs' | 'no-focus';
type Wiring =
  | 'click+keys' | 'click' | 'pointerup' | 'mousedown' | 'delegated' | 'delegated+keys' | 'click+space-up' | 'inert'
  // Tabs: arrow keys that choose, arrow keys that move focus and Enter that chooses, a click with no keys, pointer-up only.
  | 'arrows' | 'arrows-manual' | 'click-roving' | 'tabs-pointerup';
type Effect = 'panel' | 'status' | 'state' | 'later';

/** Whether the control can be used with the keyboard, by construction (true = the page passes 2.1.1). */
function operable(kind: Kind, wiring: Wiring): boolean {
  if (wiring === 'inert') return true; // nothing a click does that a key does not
  if (kind === 'tabs') return wiring === 'arrows' || wiring === 'arrows-manual';
  if (kind === 'no-focus') return false; // answers the pointer, takes no focus, nothing beside it does the same
  if (wiring === 'pointerup' || wiring === 'mousedown') return false; // a key press never sends these
  if (kind === 'native') return true; // Enter and Space click a native button
  return wiring === 'click+keys' || wiring === 'delegated+keys' || wiring === 'click+space-up';
}

const KEYBOARD_COMBOS: readonly [Kind, Wiring][] = [
  ['role-button', 'click+keys'], ['role-button', 'click'], ['role-button', 'pointerup'], ['role-button', 'mousedown'], ['role-button', 'delegated'], ['role-button', 'delegated+keys'], ['role-button', 'click+space-up'], ['role-button', 'inert'],
  ['plain-span', 'click+keys'], ['plain-span', 'click'], ['plain-span', 'delegated'], ['plain-span', 'delegated+keys'],
  ['native', 'click'], ['native', 'pointerup'], ['native', 'mousedown'], ['native', 'delegated'], ['native', 'inert'],
  ['tabs', 'arrows'], ['tabs', 'arrows-manual'], ['tabs', 'click-roving'], ['tabs', 'tabs-pointerup'],
  ['no-focus', 'click'], ['no-focus', 'pointerup'], ['no-focus', 'inert'],
];

export function keyboardCase(kind: Kind, wiring: Wiring, effect: Effect, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `controls-keyboard/${kind}/${wiring}/${effect}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const init: string[] = [];
  // What the control does when it works.
  const act = effect === 'panel' ? "document.getElementById('out').hidden = false;"
    : effect === 'status' ? "document.getElementById('out').textContent = 'Your choice is saved for this visit.';"
      : effect === 'state' ? "var c = document.getElementById('ctl'); c.setAttribute('aria-pressed', c.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');"
        : "setTimeout(function () { document.getElementById('out').hidden = false; }, 40);";
  const out = effect === 'status' ? '<p id="out" class="note" role="status"></p>' : effect === 'state' ? '' : '<p id="out" hidden>The desk is open on Saturday from 9 to 1.</p>';
  let body: string;
  if (kind === 'tabs') {
    body = `<div id="tabs"><div role="tablist" aria-label="Views">
<button id="t0" role="tab" aria-selected="true" aria-controls="p0" tabindex="0">This week</button>
<button id="t1" role="tab" aria-selected="false" aria-controls="p1" tabindex="-1">Next week</button>
<button id="t2" role="tab" aria-selected="false" aria-controls="p2" tabindex="-1">Later</button></div>
<section id="p0" role="tabpanel" aria-labelledby="t0"><p>Two meetings this week.</p></section>
<section id="p1" role="tabpanel" aria-labelledby="t1" hidden><p>One hearing next week.</p></section>
<section id="p2" role="tabpanel" aria-labelledby="t2" hidden><p>The budget vote is in June.</p></section></div>`;
    init.push(`(function () { var tabs = [].slice.call(document.querySelectorAll('[role=tab]'));
  function pick(tab) { tabs.forEach(function (t) { var on = t === tab; t.tabIndex = on ? 0 : -1; t.setAttribute('aria-selected', String(on)); document.getElementById(t.getAttribute('aria-controls')).hidden = !on; }); }
  tabs.forEach(function (t) {
    ${wiring === 'tabs-pointerup' ? "t.addEventListener('pointerup', function () { pick(t); });" : "t.addEventListener('click', function () { pick(t); });"}
    ${wiring === 'arrows' || wiring === 'arrows-manual' ? `t.addEventListener('keydown', function (e) { var i = tabs.indexOf(t); if (e.key === 'ArrowRight') i = (i + 1) % tabs.length; else if (e.key === 'ArrowLeft') i = (i + tabs.length - 1) % tabs.length; else return; e.preventDefault(); ${wiring === 'arrows' ? 'pick(tabs[i]);' : ''} tabs[i].focus(); });` : ''}
  }); })();`);
  } else {
    const attrs = kind === 'role-button' ? ' role="button" tabindex="0"' : kind === 'plain-span' ? ' tabindex="0"' : '';
    const state = effect === 'state' ? ' aria-pressed="false"' : '';
    const el = kind === 'native' ? `<button type="button" id="ctl" class="ctl"${state}>Weekend opening</button>` : `<${kind === 'plain-span' ? 'span' : 'div'} id="ctl" class="ctl"${attrs}${state}>Weekend opening</${kind === 'plain-span' ? 'span' : 'div'}>`;
    body = `<div class="widget">${el}</div>${out}`;
    const fn = `function act() { ${act} }`;
    const keys = "function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } }";
    const wire: Record<string, string> = {
      'click+keys': `c.addEventListener('click', act); c.addEventListener('keydown', ${keys});`,
      click: "c.addEventListener('click', act);",
      pointerup: "c.addEventListener('pointerup', act);",
      mousedown: "c.addEventListener('mousedown', act);",
      delegated: "document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('#ctl')) act(); });",
      'delegated+keys': `document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('#ctl')) act(); }); document.addEventListener('keydown', function (e) { if (e.target === c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); act(); } });`,
      'click+space-up': "c.addEventListener('click', act); c.addEventListener('keydown', function (e) { if (e.key === ' ') e.preventDefault(); }); c.addEventListener('keyup', function (e) { if (e.key === ' ' || e.key === 'Enter') act(); });",
      // A listener that changes nothing a person would notice (a counter kept in a variable).
      inert: "var n = 0; c.addEventListener('click', function () { n++; }); c.addEventListener('mousedown', function () { n++; });",
    };
    init.push(`(function () { var c = document.getElementById('ctl'); ${fn} ${wire[wiring] ?? ''} })();`);
  }
  const pg = parts('Site hut', `<p>Find the desk's hours.</p>${body}${filler(r, 2)}`, [CSS], init);
  applyHazard(pg, hazard, r);
  const ok = operable(kind, wiring);
  return {
    id, test: 'controls-keyboard', hazard, params: { kind, wiring, effect, rep },
    site: render(pg),
    expect: { '2.1.1': ok ? { verdict: 'pass' } : { verdict: 'fail', count: 1 } },
    why: ok ? `a ${kind} control wired with ${wiring}: a key does what a click does (or neither does anything)` : `a ${kind} control wired with ${wiring}: a click does something and no key does`,
  };
}

/**
 * Another keyboard way to what a pointer-only control does (Understanding 2.1.1: any key, and any other
 * control that does the same, will do). The control shows and hides a panel on pointer-up only.
 */
type Way =
  // Pass: a button elsewhere that shows and hides the same panel; a key the control declares; a key its describing text names.
  | 'elsewhere' | 'declared-key' | 'named-in-text'
  // Fail: a declared key that does nothing; a control with the same name that does something else.
  | 'dead-key' | 'same-name-other';
const WAY_OK: ReadonlySet<Way> = new Set(['elsewhere', 'declared-key', 'named-in-text']);

export function otherWayCase(way: Way, focus: 'role-button' | 'no-focus', rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `controls-keyboard/other-way/${way}/${focus}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const attrs = [
    focus === 'role-button' ? ' role="button" tabindex="0"' : '',
    way === 'elsewhere' ? ' aria-controls="out"' : '',
    way === 'declared-key' || way === 'dead-key' ? ' aria-keyshortcuts="F2"' : '',
    way === 'named-in-text' ? ' aria-describedby="hint"' : '',
  ].join('');
  const other = way === 'elsewhere' ? '<p><button type="button" id="alt" aria-controls="out">Show or hide the hours</button></p>'
    : way === 'same-name-other' ? '<p><button type="button" id="alt">Weekend opening</button></p><p id="said" class="note"></p>' : '';
  const hint = way === 'named-in-text' ? '<p id="hint">Press Alt+H to show or hide the hours.</p>' : '';
  const body = `${other}<div class="widget"><div id="ctl" class="ctl"${attrs}>Weekend opening</div></div>${hint}<p id="out" hidden>The desk is open on Saturday from 9 to 1.</p>`;
  const wire = way === 'elsewhere' ? "document.getElementById('alt').addEventListener('click', flip);"
    : way === 'declared-key' ? "document.addEventListener('keydown', function (e) { if (e.key === 'F2') { e.preventDefault(); flip(); } });"
      : way === 'named-in-text' ? "document.addEventListener('keydown', function (e) { if (e.altKey && (e.key === 'h' || e.code === 'KeyH')) { e.preventDefault(); flip(); } });"
        : way === 'same-name-other' ? "document.getElementById('alt').addEventListener('click', function () { var s = document.getElementById('said'); s.textContent = s.textContent ? '' : 'The hut is by the east gate.'; });" : '';
  const init = [`(function () { var o = document.getElementById('out'); function flip() { o.hidden = !o.hidden; } document.getElementById('ctl').addEventListener('pointerup', flip); ${wire} })();`];
  const pg = parts('Site hut', `<p>Find the desk's hours.</p>${body}${filler(r, 2)}`, [CSS], init);
  applyHazard(pg, hazard, r);
  const ok = WAY_OK.has(way);
  return {
    id, test: 'controls-keyboard', hazard, params: { way, focus, rep },
    site: render(pg),
    expect: { '2.1.1': ok ? { verdict: 'pass' } : { verdict: 'fail', count: 1 } },
    why: ok ? `a pointer-only control (${focus}) whose function the keyboard reaches another way (${way})` : `a pointer-only control (${focus}) with what only looks like another keyboard way (${way}): a click does something and no key does`,
  };
}

export function keyboardCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const [kind, wiring] of KEYBOARD_COMBOS) {
    const effects: Effect[] = kind === 'tabs' ? ['panel'] : ['panel', 'status', 'state', 'later'];
    // More repeats where there is one effect only, so both sides of the answer have enough cases.
    const reps = kind === 'tabs' ? 6 : wiring === 'inert' ? 1 : 2;
    for (const effect of effects) for (let rep = 0; rep < reps; rep++) out.push(keyboardCase(kind, wiring, effect, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  }
  // Other keyboard ways to what a pointer-only control does (2026-11-10): their own hazard rotation, so the cases above keep theirs.
  let j = 0;
  for (const way of ['elsewhere', 'declared-key', 'named-in-text', 'dead-key', 'same-name-other'] as const) {
    for (const focus of ['role-button', 'no-focus'] as const) for (let rep = 0; rep < 2; rep++) out.push(otherWayCase(way, focus, rep, HAZARDS[j++ % HAZARDS.length]!, seed));
  }
  return [...new Map(out.map((c) => [c.id, c])).values()];
}

export const controlsKeyboardTest: SimTest = {
  id: 'controls-keyboard', criteria: ['2.1.1'], probes: () => [controlsProbe], full: true, read: 'probe', readProbes: ['controls'], capMs: 120_000, cases: keyboardCases,
};

// ---------------------------------------------------------------------------------------------
// 4.1.3

type Shows =
  // Fail: a status message in no live region, focus unmoved.
  | 'plain' | 'toast' | 'replaced'
  // Fail: the status region is added together with its message (ARIA22: the region has to be there first).
  | 'region-with-text'
  // Pass: announced.
  | 'role-status' | 'aria-live' | 'alert-added' | 'focused'
  // Pass: a status region the press adds empty and fills a moment later; a new element inside a region that was live all along.
  | 'region-then-text' | 'in-live-parent'
  // Pass: not a status message.
  | 'disclosure' | 'toggle' | 'content' | 'dialog';
type Trigger = 'button' | 'custom';

const STATUS_WORDS = ['Route 7 was saved to your list.', '3 results found.', 'Your request has been sent.', 'Bed number copied.', 'No results match that name.', 'Something went wrong. Try again.'];
const CONTENT_WORDS = ['The office is open weekdays from 8 to 5.', 'Buses leave from platform B.', 'Bring a photo ID to the counter.'];
const FAILS: ReadonlySet<Shows> = new Set(['plain', 'toast', 'replaced', 'region-with-text']);

export function statusCase(shows: Shows, trigger: Trigger, text: number, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `controls-status/${shows}/${trigger}/${text}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const content = shows === 'content';
  const words = content ? CONTENT_WORDS[text % CONTENT_WORDS.length]! : STATUS_WORDS[text % STATUS_WORDS.length]!;
  const q = JSON.stringify(words);
  // A control's name says what it does: an action for a message, a question or "show" for content it shows and hides.
  const name = shows === 'disclosure' ? 'Show the details' : shows === 'toggle' ? 'Plot deposits' : shows === 'dialog' ? 'Open the notice' : shows === 'content' ? 'Next tip' : ['Save this route', 'Search stops', 'Send request', 'Copy stop number', 'Find a person', 'Apply'][text % 6]!;
  const el = trigger === 'button'
    ? `<button type="button" id="go"${shows === 'disclosure' ? ' aria-expanded="false" aria-controls="msg"' : ''}>${name}</button>`
    : `<div id="go" class="ctl" role="button" tabindex="0"${shows === 'disclosure' ? ' aria-expanded="false" aria-controls="msg"' : ''}>${name}</div>`;
  const css = [CSS, '.toast { position: fixed; right: 16px; bottom: 16px; padding: 8px 12px; background: #1b1b1b; color: #fff; } #dlg { position: fixed; inset: 20% 25%; padding: 20px; background: #fff; border: 2px solid #1b1b1b; }'];
  let extra = '';
  let act: string;
  switch (shows) {
    case 'plain': extra = '<div id="msg" class="note"></div>'; act = `document.getElementById('msg').textContent = ${q};`; break;
    case 'role-status': extra = '<div id="msg" class="note" role="status"></div>'; act = `document.getElementById('msg').textContent = ${q};`; break;
    case 'aria-live': extra = '<div id="msg" class="note" aria-live="polite"></div>'; act = `document.getElementById('msg').textContent = ${q};`; break;
    case 'focused': extra = '<div id="msg" class="note" tabindex="-1"></div>'; act = `var m = document.getElementById('msg'); m.textContent = ${q}; m.focus();`; break;
    case 'toast': act = `var old = document.querySelector('.toast'); if (old) old.remove(); var t = document.createElement('div'); t.className = 'toast'; t.textContent = ${q}; document.body.appendChild(t);`; break;
    case 'alert-added': act = `var old = document.querySelector('.toast'); if (old) old.remove(); var t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'alert'); t.textContent = ${q}; document.body.appendChild(t);`; break;
    case 'region-with-text': extra = '<div id="spot"></div>'; act = `var s = document.getElementById('spot'); s.textContent = ''; var t = document.createElement('p'); t.setAttribute('role', 'status'); t.textContent = ${q}; s.appendChild(t);`; break;
    case 'region-then-text': extra = '<div id="spot"></div>'; act = `var s = document.getElementById('spot'); s.textContent = ''; var t = document.createElement('p'); t.setAttribute('role', 'status'); s.appendChild(t); setTimeout(function () { t.textContent = ${q}; }, 100);`; break;
    case 'in-live-parent': extra = '<div id="spot" aria-live="polite"></div>'; act = `var s = document.getElementById('spot'); s.textContent = ''; var t = document.createElement('p'); t.textContent = ${q}; s.appendChild(t);`; break;
    case 'replaced': extra = '<p id="msg">Showing all 12 stops.</p>'; act = `document.getElementById('msg').textContent = ${q};`; break;
    case 'content': extra = '<p id="msg">Tip: check the timetable before you leave.</p>'; act = `document.getElementById('msg').textContent = ${q};`; break;
    case 'disclosure': extra = `<p id="msg" hidden>${words}</p>`; act = "var m = document.getElementById('msg'); m.hidden = !m.hidden; document.getElementById('go').setAttribute('aria-expanded', String(!m.hidden));"; break;
    case 'toggle': extra = `<p id="msg" hidden>${words}</p>`; act = "var m = document.getElementById('msg'); m.hidden = !m.hidden;"; break;
    default: extra = `<div id="dlg" role="dialog" aria-modal="true" aria-label="Notice" hidden><p>${words}</p><button type="button" id="x">Close</button></div>`;
      act = "document.getElementById('dlg').hidden = false; document.getElementById('x').focus();";
  }
  const init = [`(function () { var g = document.getElementById('go'); function act() { ${act} }
  g.addEventListener('click', act);
  ${trigger === 'custom' ? "g.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });" : ''}
  ${shows === 'dialog' ? "var d = document.getElementById('dlg'); function shut() { d.hidden = true; g.focus(); } document.getElementById('x').addEventListener('click', shut); d.addEventListener('keydown', function (e) { if (e.key === 'Escape') shut(); });" : ''} })();`];
  const pg = parts('Route 7', `<p>Route 7 runs every 20 minutes.</p><p>${el}</p>${extra}${filler(r, 2)}`, css, init);
  applyHazard(pg, hazard, r);
  const fails = FAILS.has(shows);
  return {
    id, test: 'controls-status', hazard, params: { shows, trigger, text, rep },
    site: render(pg),
    expect: { '4.1.3': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: fails ? `a press shows the status message "${words}" (${shows}) in no live region, and focus stays on the control`
      : shows === 'content' || shows === 'disclosure' || shows === 'toggle' || shows === 'dialog' ? `what the press shows (${shows}) is content, not a status message`
        : `the status message is announced (${shows})`,
  };
}

export function statusCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  // The three kinds added on 2026-11-10 come last, so the earlier cases keep their hazards.
  const all: Shows[] = ['plain', 'toast', 'replaced', 'role-status', 'aria-live', 'alert-added', 'focused', 'disclosure', 'toggle', 'content', 'dialog', 'region-with-text', 'region-then-text', 'in-live-parent'];
  for (const shows of all) {
    for (const trigger of ['button', 'custom'] as const) {
      // Failing kinds get every status wording; passing kinds a spread of them.
      const texts = FAILS.has(shows) ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3];
      for (const text of texts) for (let rep = 0; rep < (FAILS.has(shows) ? 2 : 1); rep++) out.push(statusCase(shows, trigger, text, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
    }
  }
  return [...new Map(out.map((c) => [c.id, c])).values()];
}

export const controlsStatusTest: SimTest = {
  id: 'controls-status', criteria: ['4.1.3'], probes: () => [controlsProbe], full: true, read: 'probe', readProbes: ['controls'], capMs: 120_000, cases: statusCases,
};

// ---------------------------------------------------------------------------------------------
// 2.4.3 (F85) and 2.1.2: what a press opens.

type Opens =
  // 2.4.3 fails: a panel with controls at the end of the page (shown as a layer), focus not moved, the next Tabs go elsewhere.
  | 'far-panel'
  // 2.1.2 fails: a dialog that takes focus, loops Tab, cancels Escape, and whose buttons do not close it.
  | 'trap'
  // Pass: the far panel with focus moved into it; a panel right after its button; a dialog that Escape or its button closes; a native modal.
  | 'far-focused' | 'next-panel' | 'dialog-esc' | 'dialog-button' | 'native';

export function openedCase(opens: Opens, links: number, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `controls-opened/${opens}/${links}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const css = [CSS, '.float { position: fixed; top: 140px; right: 24px; width: 260px; padding: 12px; background: #fff; border: 2px solid #1d4d3f; } .modal { position: fixed; inset: 15% 20%; padding: 20px; background: #fff; border: 2px solid #1b1b1b; z-index: 50; }'];
  const between = Array.from({ length: links }, (_, k) => `<a href="/list/${k}.html">List ${k + 1}</a>`).join(' ');
  const panel = '<section id="panel" class="float" aria-label="Filter the list" hidden><h2>Filter the list</h2><label for="yr">Year</label> <select id="yr"><option>2026</option><option>2025</option></select> <button type="button" id="apply">Apply</button></section>';
  let body = '';
  let after = '';
  let script = '';
  if (opens === 'far-panel' || opens === 'far-focused') {
    body = `<p><button type="button" id="open" aria-expanded="false" aria-controls="panel">Filter the list</button></p><p>${between}</p>`;
    after = panel;
    script = `document.getElementById('open').addEventListener('click', function () { document.getElementById('panel').hidden = false; this.setAttribute('aria-expanded', 'true'); ${opens === 'far-focused' ? "document.getElementById('yr').focus();" : ''} });`;
  } else if (opens === 'next-panel') {
    body = `<p><button type="button" id="open" aria-expanded="false" aria-controls="panel">Filter the list</button></p>${panel}<p>${between}</p>`;
    script = "document.getElementById('open').addEventListener('click', function () { var p = document.getElementById('panel'); p.hidden = !p.hidden; this.setAttribute('aria-expanded', String(!p.hidden)); });";
  } else if (opens === 'native') {
    body = `<p><button type="button" id="open">Ticket questions</button></p><p>${between}</p><dialog id="dlg" aria-label="Ticket questions"><p>Concession tickets need a pass.</p><button type="button" id="x">Close</button></dialog>`;
    script = "var d = document.getElementById('dlg'); document.getElementById('open').addEventListener('click', function () { d.showModal(); }); document.getElementById('x').addEventListener('click', function () { d.close(); });";
  } else {
    const second = opens === 'dialog-button' ? 'Got it' : 'Hut hours';
    body = `<p><button type="button" id="open">Ticket questions</button></p><p>${between}</p><div id="dlg" class="modal" role="dialog" aria-modal="true" aria-label="Ticket questions" hidden><p>Concession tickets need a pass.</p><button type="button" id="b1">Concession tickets</button> <button type="button" id="b2">${second}</button></div>`;
    script = `var d = document.getElementById('dlg'), o = document.getElementById('open'), b1 = document.getElementById('b1'), b2 = document.getElementById('b2');
  function shut() { d.hidden = true; o.focus(); }
  o.addEventListener('click', function () { d.hidden = false; b1.focus(); });
  ${opens === 'dialog-button' ? "b2.addEventListener('click', shut);" : ''}
  d.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { ${opens === 'dialog-esc' ? 'shut();' : 'e.preventDefault();'} return; }
    if (e.key !== 'Tab') return;
    e.preventDefault(); (document.activeElement === b1 ? b2 : b1).focus();
  });`;
  }
  const pg = parts('Archive', `${body}${filler(r, 1)}`, css, [`(function () { ${script} })();`]);
  if (after) pg.after.push(after);
  applyHazard(pg, hazard, r);
  return {
    id, test: 'controls-opened', hazard, params: { opens, links, rep },
    site: render(pg),
    expect: {
      '2.4.3': opens === 'far-panel' ? { verdict: 'fail', count: 1 } : { verdict: 'pass' },
      '2.1.2': opens === 'trap' ? { verdict: 'fail', count: 1 } : { verdict: 'pass' },
    },
    why: opens === 'far-panel' ? 'the press opens a panel with controls at the end of the page; focus is not moved and the next Tab presses go to other links (F85)'
      : opens === 'trap' ? 'the press opens a dialog that keeps focus: Tab loops, Escape is cancelled, and no button closes it'
        : `what the press opens can be reached and left (${opens})`,
  };
}

export function openedCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  const fails: Opens[] = ['far-panel', 'trap'];
  const passes: Opens[] = ['far-focused', 'next-panel', 'dialog-esc', 'dialog-button', 'native'];
  // The far panel needs at least four links between its button and it (so three Tab presses do not reach it).
  for (const opens of fails) for (const links of [4, 5, 6, 8]) for (let rep = 0; rep < 13; rep++) out.push(openedCase(opens, links, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  for (const opens of passes) for (const links of [4, 6]) for (let rep = 0; rep < 6; rep++) out.push(openedCase(opens, links, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  // A fifth layout for the failing kinds (added after the first run; last, so the earlier cases keep their ids).
  for (const opens of fails) for (let rep = 0; rep < 13; rep++) out.push(openedCase(opens, 10, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  return [...new Map(out.map((c) => [c.id, c])).values()];
}

export const controlsOpenedTest: SimTest = {
  id: 'controls-opened', criteria: ['2.4.3', '2.1.2'], probes: () => [controlsProbe], full: true, read: 'probe', readProbes: ['controls'], capMs: 120_000, cases: openedCases,
};
