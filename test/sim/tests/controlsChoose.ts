// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Act and watch, controls (act-watch lane, 2026-11-11; probe `controls`, deep, step 2b): a filter whose "Update"
// button changes nothing while its list or radio group keeps the first choice. The answer by construction:
// - after another month is chosen, the press shows the new count ("Four events in May.") in a plain
//   paragraph: 4.1.3 fails (nobody is told);
// - look-alikes pass: the count in a role=status, role=alert or aria-live region, or given focus; a button that
//   does nothing whatever is chosen (no status at all); a list or radio group that loads another page when changed
//   (the choice is never made: a person cannot choose without leaving, and the button alone shows nothing new).
import { controlsProbe } from '../../../src/probes/controls/index.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'animation-in-flight', 'scroll-snap', 'reduced-motion-honored'];
const CSS = ['button, select { font: 16px Arial; padding: 4px 10px; } fieldset { border: 1px solid #555; } .filter { margin: 16px 0; }'];
type Widget = 'select' | 'radios';
type Result = 'quiet' | 'status' | 'alert' | 'polite' | 'focus' | 'unrelated' | 'navigates';
const COUNTS = [
  ['Six events in April.', 'Four events in May.'], ['6 events in April.', '4 events in May.'],
  ['Showing 5 results for April.', 'Showing 4 results for May.'], ['Six events in April.', 'No events in May.'],
] as const;
const BUTTONS = ['Update list', 'Apply', 'Refresh list', 'Filter'] as const;

export function chooseCase(widget: Widget, result: Result, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `controls-choose/${widget}/${result}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const [before, after] = COUNTS[rep % COUNTS.length]!;
  const attr = result === 'status' ? ' role="status"' : result === 'alert' ? ' role="alert"' : result === 'polite' ? ' aria-live="polite"' : result === 'focus' ? ' tabindex="-1"' : '';
  const choice = widget === 'select'
    ? '<label for="month">Month</label> <select id="month"><option>April</option><option>May</option></select>'
    : '<fieldset><legend>Month</legend><label><input type="radio" name="month" value="April" checked> April</label> <label><input type="radio" name="month" value="May"> May</label></fieldset>';
  const value = widget === 'select' ? "document.getElementById('month').value" : "document.querySelector('input[name=month]:checked').value";
  const button = result === 'unrelated' ? 'Print calendar' : BUTTONS[rep % BUTTONS.length]!;
  const init: string[] = [];
  if (result === 'navigates') {
    init.push(widget === 'select'
      ? "document.getElementById('month').addEventListener('change', function (e) { location.href = '/calendar-' + e.target.value.toLowerCase(); });"
      : "document.querySelectorAll('input[name=month]').forEach(function (x) { x.addEventListener('change', function () { location.href = '/calendar-' + x.value.toLowerCase(); }); });");
  }
  if (result !== 'unrelated') {
    init.push(`document.getElementById('go').addEventListener('click', function () { var p = document.getElementById('result'); p.textContent = ${value} === 'May' ? ${JSON.stringify(after)} : ${JSON.stringify(before)};${result === 'focus' ? ' p.focus();' : ''} });`);
  }
  const body = `<p>Events for families and neighbours this season.</p><div class="filter">${choice} <button type="button" id="go">${button}</button><p id="result"${attr}>${before}</p></div>${filler(r, 2)}`;
  const pg = parts('Events', body, [...CSS], init);
  applyHazard(pg, hazard, r);
  const fails = result === 'quiet';
  return {
    id, test: 'controls-choose', hazard, params: { widget, result, rep },
    site: render(pg),
    expect: { '4.1.3': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: fails ? `after May is chosen, "${button}" shows "${after}" in a plain paragraph, and focus stays on the button`
      : { status: 'the count is in a role=status region', alert: 'the count is in a role=alert region', polite: 'the count is in an aria-live region', focus: 'the count is given focus', unrelated: 'the button does nothing whatever is chosen: no status at all', navigates: 'the month loads another page when changed: the choice is never made, and the button alone shows nothing new' }[result as Exclude<Result, 'quiet'>],
  };
}

export function chooseCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  // 54 failing pages (two widgets, 27 each) and 60 passing (two widgets, six kinds, five each).
  for (const widget of ['select', 'radios'] as const) {
    for (let rep = 0; rep < 27; rep++) out.push(chooseCase(widget, 'quiet', rep, HAZARDS[i++ % HAZARDS.length]!, seed));
    for (const result of ['status', 'alert', 'polite', 'focus', 'unrelated', 'navigates'] as const) for (let rep = 0; rep < 5; rep++) out.push(chooseCase(widget, result, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  }
  return out;
}

export const controlsChooseTest: SimTest = {
  id: 'controls-choose', criteria: ['4.1.3'], probes: () => [controlsProbe], full: true, read: 'probe', readProbes: ['controls'], capMs: 120_000, cases: chooseCases,
};
