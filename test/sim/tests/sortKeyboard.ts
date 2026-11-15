// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A list that only dragging reorders (keyboard-op lane, 2026-11-11; the pointer-gestures test's 2.1.1 rule): pages
// whose answer is known by construction. A ranked list of shelters, routes or lessons that a script reorders when an
// item is dragged onto another. It fails 2.1.1 when the keyboard has no way to reorder it (WCAG failure F54, G202):
// none of its items takes focus and nothing else on the page does it. It passes when its items take focus and move
// with the arrow keys, when each item has Move up and Move down buttons, when a control near the list or elsewhere
// on the page reorders it, and when a key the page names does. (The test may only say "not testable" for a way it
// cannot try; a careful auditor passes those pages, and the lab counts a doubt there as no error.)
// Fix round 1 (F1): lists whose items a click picks up and a second click puts down (`pick: 'click'`, a single-pointer
// way that takes no keyboard), with the page's links further away; and the review's look-alikes, a keyboard way
// outside the list's block: a link to another way, a "First choice" field in a sibling section, a button that puts
// them in order, a wrapper around the list that takes focus and the arrow keys. A list only dragging reorders, on a
// page with other controls, is a failure by construction that the test now leaves not testable (the 2.5.7 rule's
// own doubt: another control on the page may do it).
import { pointerGesturesProbe } from '../../../src/probes/pointerGestures.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

type Place = 'section' | 'main' | 'article' | 'fieldset';
type Item = 'li' | 'div' | 'card';
type Way = 'none' | 'arrows' | 'item-buttons' | 'near-buttons' | 'near-select' | 'told-key' | 'toolbar' | 'list-keys' | 'link-far' | 'select-sibling' | 'button-outside' | 'wrapper';
/** How a pointer reorders the list: dragging only, or dragging and a click on an item, then on another. */
type Pick = 'drag' | 'click';
const FAR_WAYS: readonly Way[] = ['link-far', 'select-sibling', 'button-outside', 'wrapper'];
const PLACES: readonly Place[] = ['section', 'main', 'article', 'fieldset'];
const ITEMS: readonly Item[] = ['li', 'div', 'card'];
const WAYS: readonly Way[] = ['arrows', 'item-buttons', 'near-buttons', 'near-select', 'told-key', 'toolbar', 'list-keys'];
const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap'];
const NAMES = ['Cedar Bend', 'Wren Meadow', 'Larch Grove'];
const CSS = '#rank > * { display: block; padding: 8px; margin: 4px 0; border: 1px solid #555; background: #f4f4f4; cursor: grab; width: 260px; } #rank > *:focus { outline: 3px solid #0b57d0; } .card h3 { margin: 0; font-size: 16px; } .card p { margin: 0; }';

export function sortCase(place: Place, item: Item, way: Way, hazard: Hazard, seed: number, pick: Pick = 'drag'): SimCase {
  const id = `sort-keyboard/${pick === 'click' ? 'click/' : ''}${place}/${item}/${way}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const focus = way === 'arrows' ? ' tabindex="0"' : '';
  const buttons = (n: string) => (way === 'item-buttons' ? ` <button type="button" class="up" aria-label="Move ${n} up">▲</button> <button type="button" class="down" aria-label="Move ${n} down">▼</button>` : '');
  const one = (n: string) => item === 'li' ? `<li draggable="true"${focus}>${n}${buttons(n)}</li>`
    : item === 'div' ? `<div draggable="true"${focus}>${n}${buttons(n)}</div>`
      : `<div class="card" draggable="true"${focus}><h3>${n}</h3><p>Covered tables, water${buttons(n)}</p></div>`;
  const tag = item === 'li' ? 'ol' : 'div';
  const rows = `<${tag} id="rank"${way === 'list-keys' ? ' tabindex="0" aria-label="Your ranking (arrow keys move the first choice)"' : ''}>${NAMES.map(one).join('')}</${tag}>`;
  const list = way === 'wrapper' ? `<div id="wrap" tabindex="0" role="listbox" aria-label="Your ranking (Down moves the first choice down)">${rows}</div>` : rows;
  const say = way === 'told-key' ? 'Drag the shelters into your preferred order. Keyboard users: press R to rank them by name.'
    : pick === 'click' ? 'Drag the shelters into your preferred order, or click a shelter and then the one it should follow.' : 'Drag the shelters into your preferred order.';
  const near = way === 'near-buttons' ? '<p><button type="button" id="alpha">Put them in alphabetical order</button></p>'
    : way === 'near-select' ? '<p><label for="first">First choice</label> <select id="first">' + NAMES.map((n) => `<option>${n}</option>`).join('') + '</select></p>' : '';
  const inner = `<h2>Rank your shelter choices</h2><p>${say}</p>${list}${near}`;
  const block = place === 'section' ? `<section>${inner}</section>` : place === 'article' ? `<article>${inner}</article>` : place === 'fieldset' ? `<form action="/nowhere" onsubmit="return false"><fieldset><legend>Shelter ranking</legend>${inner}</fieldset></form>` : inner;
  const toolbar = way === 'toolbar' ? '<p><button type="button" id="sort-az">Sort shelters A to Z</button></p>' : '';
  // The page's text after the block (the click cases: the page's links further from the list), and a keyboard way
  // outside the block (the review's look-alikes).
  const gap = pick === 'click' ? `<h2>Rules for shelter use</h2>\n${filler(r, 3, 30)}` : '';
  const far = way === 'link-far' ? '<p><a href="/parks/rank">Rank them with a form instead</a></p>'
    : way === 'select-sibling' ? '<section><h2>Or pick one</h2><p><label for="first">First choice</label> <select id="first">' + NAMES.map((n) => `<option>${n}</option>`).join('') + '</select></p></section>'
      : way === 'button-outside' ? '<p><button type="button" id="alpha">Put them in alphabetical order</button></p>' : '';
  const init = [
    `(function () { var list = document.getElementById('rank'), dragged = null;
list.addEventListener('dragstart', function (e) { dragged = e.target.closest('#rank > *'); });
list.addEventListener('dragover', function (e) { e.preventDefault(); });
list.addEventListener('drop', function (e) { e.preventDefault(); var t = e.target.closest('#rank > *'); if (dragged && t && t !== dragged) t.after(dragged); dragged = null; });
function byName() { [].slice.call(list.children).sort(function (a, b) { return a.textContent < b.textContent ? -1 : 1; }).forEach(function (x) { list.append(x); }); }
${way === 'arrows' ? "[].forEach.call(list.children, function (x) { x.addEventListener('keydown', function (e) { if (e.key === 'ArrowUp' && x.previousElementSibling) { e.preventDefault(); x.previousElementSibling.before(x); x.focus(); } if (e.key === 'ArrowDown' && x.nextElementSibling) { e.preventDefault(); x.nextElementSibling.after(x); x.focus(); } }); });" : ''}
${way === 'item-buttons' ? "list.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; var x = b.closest('#rank > *'); if (b.classList.contains('up') && x.previousElementSibling) x.previousElementSibling.before(x); if (b.classList.contains('down') && x.nextElementSibling) x.nextElementSibling.after(x); });" : ''}
${way === 'near-buttons' ? "document.getElementById('alpha').addEventListener('click', byName);" : ''}
${way === 'near-select' ? "document.getElementById('first').addEventListener('change', function (e) { var x = [].find.call(list.children, function (c) { return c.textContent.indexOf(e.target.value) === 0; }); if (x) list.prepend(x); });" : ''}
${way === 'told-key' ? "document.addEventListener('keydown', function (e) { if (e.key === 'r' || e.key === 'R') byName(); });" : ''}
${way === 'toolbar' ? "document.getElementById('sort-az').addEventListener('click', byName);" : ''}
${way === 'list-keys' ? "list.addEventListener('keydown', function (e) { if (e.key === 'ArrowDown') { e.preventDefault(); var f = list.firstElementChild; if (f.nextElementSibling) f.nextElementSibling.after(f); } });" : ''}
${way === 'wrapper' ? "document.getElementById('wrap').addEventListener('keydown', function (e) { if (e.key === 'ArrowDown') { e.preventDefault(); var f = list.firstElementChild; if (f.nextElementSibling) f.nextElementSibling.after(f); } });" : ''}
${way === 'select-sibling' ? "document.getElementById('first').addEventListener('change', function (e) { var x = [].find.call(list.children, function (c) { return c.textContent.indexOf(e.target.value) === 0; }); if (x) list.prepend(x); });" : ''}
${way === 'button-outside' ? "document.getElementById('alpha').addEventListener('click', byName);" : ''}
${pick === 'click' ? "var picked = null; [].forEach.call(list.children, function (x) { x.addEventListener('click', function (e) { if (e.target.closest('button')) return; if (!picked) { picked = x; x.style.background = '#dde8ff'; return; } if (x !== picked) x.after(picked); picked.style.background = ''; picked = null; }); });" : ''}
})();`,
  ];
  const pg = parts('Reserve a shelter', `${toolbar}<p>${filler(r, 1, 16).replace(/<\/?p>/g, '').trim()}</p>\n${block}\n${gap}${far}<p><a href="/parks">All parks</a> · <a href="/contact">Contact the parks office</a></p>${filler(r, 1)}`, [CSS], init);
  applyHazard(pg, hazard, r);
  const fails = way === 'none';
  const how = pick === 'click' ? 'dragging and clicking its items reorder' : 'only dragging reorders';
  return {
    id, test: 'sort-keyboard', hazard, params: { place, item, way, pick },
    site: render(pg),
    expect: { '2.1.1': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: fails ? `a ${item} list in ${place} that ${how}, with no keyboard way` : `a ${item} list in ${place} that ${how}, with a keyboard way: ${way}`,
  };
}

function sortCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  for (const place of PLACES) for (const item of ITEMS) for (const hazard of HAZARDS) out.push(sortCase(place, item, 'none', hazard, seed));
  for (const place of PLACES) for (const way of WAYS) for (const hazard of HAZARDS) out.push(sortCase(place, 'li', way, hazard, seed));
  // Fix round 1 (F1): a click on an item, then on another, also reorders it (no keyboard way: failed), and the
  // review's look-alikes with a keyboard way outside the list's block (not testable, never failed).
  for (const place of PLACES) for (const item of ITEMS) for (const hazard of HAZARDS) out.push(sortCase(place, item, 'none', hazard, seed, 'click'));
  for (const place of PLACES) for (const way of FAR_WAYS) for (const hazard of HAZARDS) out.push(sortCase(place, 'li', way, hazard, seed, 'click'));
  return out;
}

export const sortKeyboardTest: SimTest = {
  id: 'sort-keyboard', criteria: ['2.1.1'], probes: () => [pointerGesturesProbe], full: true, read: 'probe', readProbes: ['pointer-gestures'], capMs: 90_000, cases: sortCases,
};
