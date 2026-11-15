// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Keyboard: 2.4.3 Focus Order (probe `keyboard`) and 2.1.4 Character Key Shortcuts (probe
// `key-shortcuts`), read from the criteria table.
//
// Source of truth. SC 2.4.3: "If a web page can be navigated sequentially and the navigation sequences
// affect meaning or operation, focusable components receive focus in an order that preserves meaning and
// operability." F44: "Failure of Success Criterion 2.4.3 due to using tabindex to create a tab order that
// does not preserve meaning and operability"; C27 "Making the DOM order match the visual order".
// SC 2.1.4: "If a keyboard shortcut is implemented in content using only letter (including upper- and
// lower-case letters), punctuation, number, or symbol characters, then at least one of the following is
// true: Turn off: A mechanism is available to turn the shortcut off; Remap: …; Active only on focus: The
// keyboard shortcut for a user interface component is only active when that component has focus."
//
// 2.4.3, by construction (a form of four fields stacked d px apart, d = 16, 120, 400 or 1000; the
// viewport is 900 px tall):
// - fails: positive tabindex in the order 3, 1, 4, 2 (focus jumps 2·d back up the page, F44); a row of
//   "Step 1 … Step 4" links shown left to right whose DOM (and focus) order is 4, 3, 2, 1
//   (flex-direction: row-reverse); a Send button shown under the fields but first in the DOM (CSS
//   `order`), so focus reaches it before any field;
// - passes: DOM order = visual order; extra tabindex="0" and tabindex="-1" elements in place; positive
//   tabindex 1, 2, 3, 4 in the visual order; a two-column layout read column by column (DOM = reading
//   order). Positive tabindex cases use hazards with no focusable element of their own.
// 2.1.4, by construction (a listener on the document reacting to e.key alone):
// - fails: one character key (s / ? k j, which the engine presses, and a b q r 1 . w z, which it does
//   not) that focuses the search field, opens a help panel, scrolls the page 600 px or loads /help;
// - passes: the same with Ctrl or Alt required; a type-ahead active only while its list box has focus;
//   the shortcuts with a visible "Keyboard shortcuts" switch that turns them off (Turn off); shortcuts
//   off until a switch turns them on; Escape, arrow and function keys (not character keys); a listener
//   that only counts key presses (no shortcut).
import { keyboardProbe, keyShortcutsProbe } from '../../../src/probes/keyboard/index.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'animation-in-flight', 'scroll-snap', 'reduced-motion-honored'];
/** Hazards that add no focusable element of their own (positive tabindex cases). */
const QUIET_HAZARDS: readonly Hazard[] = ['none', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'animation-in-flight', 'scroll-snap', 'reduced-motion-honored'];
const FOCUS_CSS = 'a:focus-visible, button:focus-visible, input:focus-visible, [tabindex]:focus-visible { outline: 3px solid #b00020; outline-offset: 2px; } input, button { font: 16px Arial; }';

// ---------------------------------------------------------------------------------------------
// 2.4.3 Focus order.

export const ORDER_KINDS = ['tabindex-shuffle', 'tabindex-row', 'tabindex-late-button', 'reversed-steps', 'submit-first', 'natural', 'extra-tabindex', 'tabindex-in-order', 'two-columns'] as const;
type OrderKind = (typeof ORDER_KINDS)[number];
export const ORDER_GAPS = [16, 120, 400, 1000] as const;

export function orderCase(kind: OrderKind, d: number, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `focus-order/${kind}/${d}px/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const labels = ['Your name', 'E-mail address', 'Street address', 'Daytime phone'];
  const auto = ['name', 'email', 'street-address', 'tel'];
  const field = (i: number, tab?: number) => `<p class="f"><label for="f${i}">${labels[i]}</label><br><input id="f${i}" type="text" autocomplete="${auto[i]}"${tab !== undefined ? ` tabindex="${tab}"` : ''}></p>`;
  const css = [FOCUS_CSS, `.f { margin: 0 0 ${d}px; }`];
  let html = '';
  switch (kind) {
    case 'tabindex-shuffle':
      html = `<form action="/c" method="post">${[3, 1, 4, 2].map((t, i) => field(i, t)).join('')}</form>`;
      break;
    case 'tabindex-row':
      // A row of links shown left to right with tabindex 2, 1, 4, 3: focus goes back left along the same line (F44).
      html = `<nav aria-label="Topics"><ul class="row">${['Parks', 'Permits', 'Streets', 'Water'].map((t, i) => `<li><a href="#t${i}" tabindex="${[2, 1, 4, 3][i]}">${t}</a></li>`).join('')}</ul></nav>${filler(r, 1)}`;
      css.push('.row { display: flex; gap: 24px; list-style: none; padding: 0; } .row a { color: #00376d; }');
      break;
    case 'tabindex-late-button':
      // Only the Send button, last in the form, has tabindex="1": focus starts there and then goes back up to the fields (F44).
      html = `<form action="/c" method="post">${[0, 1, 2, 3].map((i) => field(i)).join('')}<p><button type="submit" tabindex="1">Send</button></p></form>`;
      break;
    case 'tabindex-in-order':
      html = `<form action="/c" method="post">${[1, 2, 3, 4].map((t, i) => field(i, t)).join('')}</form>`;
      break;
    case 'natural':
      html = `<form action="/c" method="post">${[0, 1, 2, 3].map((i) => field(i)).join('')}<p><button type="submit">Send</button></p></form>`;
      break;
    case 'extra-tabindex':
      html = `<form action="/c" method="post">${field(0)}<div tabindex="0" role="note" class="note">All fields are optional.</div>${field(1)}<p id="tgt" tabindex="-1">Errors appear here.</p>${field(2)}${field(3)}<p><button type="submit">Send</button></p></form>`;
      css.push('.note { padding: 4px; }');
      break;
    case 'submit-first':
      html = `<form action="/c" method="post" class="flexf"><p class="sub"><button type="submit">Send</button></p>${[0, 1, 2, 3].map((i) => field(i)).join('')}</form>`;
      css.push('.flexf { display: flex; flex-direction: column; } .sub { order: 99; }');
      break;
    case 'reversed-steps':
      html = `<nav aria-label="Application steps"><ol class="steps">${[4, 3, 2, 1].map((n) => `<li><a href="#s${n}">Step ${n}: ${['Contact', 'Address', 'Documents', 'Review'][n - 1]}</a></li>`).join('')}</ol></nav>${filler(r, 1)}`;
      css.push('.steps { display: flex; flex-direction: row-reverse; justify-content: flex-end; gap: 24px; list-style: none; padding: 0; } .steps a { color: #00376d; }');
      break;
    case 'two-columns':
      html = `<div class="cols"><div><h2>Residents</h2><ul>${['Pay a bill', 'Report a problem', 'Find a park'].map((t, i) => `<li><a href="#r${i}">${t}</a></li>`).join('')}</ul></div><div><h2>Businesses</h2><ul>${['Licences', 'Permits', 'Contracts'].map((t, i) => `<li><a href="#b${i}">${t}</a></li>`).join('')}</ul></div></div>`;
      css.push('.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; } .cols a { color: #00376d; }');
      break;
  }
  const pg = parts('Apply for a permit', `<p>Fill in the form.</p>${html}${filler(r, 2)}`, css);
  applyHazard(pg, hazard, r);
  const fails = kind === 'tabindex-shuffle' || kind === 'tabindex-row' || kind === 'tabindex-late-button' || kind === 'reversed-steps' || kind === 'submit-first';
  const WHY: Record<OrderKind, string> = {
    'tabindex-shuffle': `tabindex 3, 1, 4, 2 on fields ${d} px apart: focus jumps ${2 * d} px back up the form (F44)`,
    'tabindex-row': 'a row of links shown left to right with tabindex 2, 1, 4, 3: focus goes back left on the same line (F44)',
    'tabindex-late-button': 'tabindex="1" only on the Send button under the fields: focus starts there, then goes back up (F44)',
    'reversed-steps': 'steps shown 1 to 4 left to right, focused 4 to 1 (row-reverse; C27)',
    'submit-first': 'the Send button is shown under the fields but receives focus first (CSS order)',
    natural: 'DOM order is the visual order', 'extra-tabindex': 'tabindex 0 and -1 in place',
    'tabindex-in-order': 'positive tabindex 1 to 4 in the visual order', 'two-columns': 'two columns read column by column (DOM = reading order)',
  };
  // Lead's ruling (2026-11-07): on a mandatory scroll-snapping page with fields 400 px or more apart, the
  // browser can snap a correctly ordered, focused field off screen. That is a 2.4.11 (focus not obscured)
  // matter, not focus order, so such a passing page is not counted for 2.4.3.
  const snapAway = !fails && hazard === 'scroll-snap' && d >= 400;
  // Lead's rulings (Sol rounds 1 and 2, 2026-11-07): CSS showing focus in another order than the layout (row-reverse,
  // CSS order) may or may not change meaning: only judgement can tell. AI-review cases, left out of deterministic
  // recall ('any'), not relabelled as passes. Positive tabindex shuffles (F44) stay deterministic.
  const aiReview = kind === 'reversed-steps' || kind === 'submit-first';
  return {
    id, test: 'focus-order', hazard, params: { kind, gap: d }, site: render(pg),
    expect: { '2.4.3': snapAway || aiReview ? { verdict: 'any' } : fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: aiReview ? `AI-review case (judgement, not deterministic): ${WHY[kind]}` : snapAway ? `${WHY[kind]}; on a scroll-snapping page the focused field may snap off screen (2.4.11, not counted for 2.4.3)` : WHY[kind],
  };
}

export function orderCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  const plan: [OrderKind, readonly number[], number][] = [
    // F44 by three mechanisms (a shuffle down a form, a shuffle along a row, one late control first), 52 failing cases in
    // all; the CSS-reorder kinds are AI-review cases (Sol rounds 2 and 3: no same-pattern padding).
    ['tabindex-shuffle', ORDER_GAPS, 6], ['tabindex-row', [16], 14], ['tabindex-late-button', [16], 14], ['reversed-steps', [16], 14], ['submit-first', [16, 120], 7],
    ['natural', [16, 120, 400], 6], ['extra-tabindex', [16, 120], 6], ['tabindex-in-order', ORDER_GAPS, 3], ['two-columns', [16], 12],
  ];
  for (const [kind, gaps, reps] of plan) for (const d of gaps) for (let rep = 0; rep < reps; rep++) {
    const hz = kind.startsWith('tabindex') ? QUIET_HAZARDS[i++ % QUIET_HAZARDS.length]! : HAZARDS[i++ % HAZARDS.length]!;
    out.push(orderCase(kind, d, rep, hz, seed));
  }
  return out;
}

export const focusOrderTest: SimTest = {
  id: 'focus-order', criteria: ['2.4.3'], probes: () => [keyboardProbe], full: false, read: 'criterion', capMs: 120_000, cases: orderCases,
};

// ---------------------------------------------------------------------------------------------
// 2.1.4 Character key shortcuts.

export const SHORTCUT_KEYS_IN = ['s', '/', '?', 'k', 'j'] as const;
export const SHORTCUT_KEYS_OUT = ['a', 'b', 'q', 'r', '1', '.', 'w', 'z'] as const;
export const SHORTCUT_EFFECTS = ['focus-search', 'help-panel', 'scroll', 'navigate'] as const;
type Effect = (typeof SHORTCUT_EFFECTS)[number];
export const SHORTCUT_PASS = ['modifier', 'focus-only', 'turn-off-switch', 'off-by-default', 'non-character', 'counter'] as const;
type PassKind = (typeof SHORTCUT_PASS)[number];

const action = (effect: Effect) => ({
  'focus-search': "document.getElementById('q').focus();",
  'help-panel': "var h = document.getElementById('help'); h.hidden = !h.hidden;",
  scroll: "window.scrollBy({ top: 600, behavior: 'instant' });",
  navigate: "location.assign('/help');",
}[effect]);

export function shortcutCase(kind: 'shortcut' | PassKind, key: string, effect: Effect, hazard: Hazard, seed: number): SimCase {
  const keyId = key === '/' ? 'slash' : key === '?' ? 'question' : key === '.' ? 'dot' : key;
  const id = `key-shortcuts/${kind}/${keyId}/${effect}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const k = JSON.stringify(key);
  let script = '';
  let extra = '';
  switch (kind) {
    case 'shortcut':
      script = `document.addEventListener('keydown', function (e) { if (e.key === ${k} && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); ${action(effect)} } });`;
      break;
    case 'modifier':
      script = `document.addEventListener('keydown', function (e) { if (e.key.toLowerCase() === ${k} && (e.ctrlKey || e.altKey)) { e.preventDefault(); ${action(effect)} } });`;
      break;
    case 'focus-only':
      extra = '<p id="lbl">Departments</p><ul id="lb" role="listbox" tabindex="0" aria-labelledby="lbl" class="lb"><li role="option" id="o1" aria-selected="true">Parks</li><li role="option" id="o2">Streets</li><li role="option" id="o3">Water</li></ul>';
      script = `document.getElementById('lb').addEventListener('keydown', function (e) { if (e.key.length === 1) { var o = [].slice.call(this.children).filter(function (x) { return x.textContent[0].toLowerCase() === e.key.toLowerCase(); })[0]; if (o) { [].forEach.call(this.children, function (x) { x.setAttribute('aria-selected', 'false'); }); o.setAttribute('aria-selected', 'true'); } } });`;
      break;
    case 'turn-off-switch':
    case 'off-by-default':
      extra = `<p><input type="checkbox" id="ks"${kind === 'turn-off-switch' ? ' checked' : ''}> <label for="ks">Keyboard shortcuts</label></p>`;
      script = `document.addEventListener('keydown', function (e) { if (!document.getElementById('ks').checked) return; if (e.key === ${k} && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); ${action(effect)} } });`;
      break;
    case 'non-character':
      script = `document.addEventListener('keydown', function (e) { if (e.key === ${k}) { ${action(effect)} } });`;
      break;
    case 'counter':
      script = "window.__keys = 0; document.addEventListener('keydown', function () { window.__keys++; });";
      break;
  }
  const html = `<form role="search" action="/search" method="get"><p><label for="q">Search the site</label> <input id="q" type="search" name="q" autocomplete="off"> <button type="submit">Search</button></p></form>
${extra}<div id="help" hidden role="region" aria-label="Help"><p>Press the keys shown to move around the site.</p></div>`;
  const css = [FOCUS_CSS, '.lb { list-style: none; padding: 4px; border: 1px solid #555; width: 200px; } .lb [aria-selected="true"] { background: #00376d; color: #fff; } .lb:focus-visible { outline: 3px solid #b00020; }'];
  const pg = parts('City news', `<p>The latest from the city.</p>${html}${filler(r, 14)}`, css, [script]);
  pg.routes['/help'] = { status: 200, type: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en"><title>Help</title><main><h1>Help</h1></main></html>' };
  applyHazard(pg, hazard, r);
  const fails = kind === 'shortcut';
  const WHY: Record<'shortcut' | PassKind, string> = {
    shortcut: `the key ${key} alone ${effect === 'focus-search' ? 'focuses the search field' : effect === 'help-panel' ? 'opens a help panel' : effect === 'scroll' ? 'scrolls the page' : 'loads /help'}, with no way to turn it off`,
    modifier: `Ctrl or Alt + ${key}: not a character key shortcut`, 'focus-only': 'type-ahead active only while its list box has focus',
    'turn-off-switch': 'a visible "Keyboard shortcuts" switch turns them off (Turn off)', 'off-by-default': 'shortcuts are off until a switch turns them on',
    'non-character': `${key} is not a character key`, counter: 'a key listener that does nothing visible',
  };
  return { id, test: 'key-shortcuts', hazard, params: { kind, key, effect, pressedByEngine: (SHORTCUT_KEYS_IN as readonly string[]).includes(key) }, site: render(pg), expect: { '2.1.4': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } }, why: WHY[kind] };
}

export function shortcutCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  const h = () => HAZARDS[i++ % HAZARDS.length]!;
  for (const key of [...SHORTCUT_KEYS_IN, ...SHORTCUT_KEYS_OUT]) for (const e of SHORTCUT_EFFECTS) out.push(shortcutCase('shortcut', key, e, h(), seed));
  const keys = ['s', 'k', '/', 'j', 'a', 'q', 'r', 'w', 'z'];
  for (const kind of ['modifier', 'turn-off-switch', 'off-by-default'] as const) for (const key of keys) out.push(shortcutCase(kind, key, SHORTCUT_EFFECTS[i % 4]!, h(), seed));
  for (const key of ['s', 'p', 'd', 'w', 'k', 'b', 'a', 'z', 'm']) out.push(shortcutCase('focus-only', key, 'help-panel', h(), seed));
  for (const key of ['Escape', 'ArrowDown', 'F2', 'Escape', 'ArrowDown', 'F2', 'PageUp', 'F4', 'ArrowLeft']) out.push(shortcutCase('non-character', key, (['help-panel', 'focus-search', 'help-panel'] as const)[i % 3]!, h(), seed));
  for (let rep = 0; rep < 9; rep++) out.push(shortcutCase('counter', `n${rep}`, 'help-panel', h(), seed));
  return dedupe(out);
}

const dedupe = (cs: SimCase[]) => [...new Map(cs.map((c) => [c.id, c])).values()];

export const keyShortcutsTest: SimTest = {
  id: 'key-shortcuts', criteria: ['2.1.4'], probes: () => [keyShortcutsProbe], full: false, read: 'criterion', capMs: 120_000, cases: shortcutCases,
};
