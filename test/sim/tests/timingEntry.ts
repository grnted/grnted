// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The timing-entry test (src/probes/timingEntry.ts, 2.2.1): pages with a text field and a timer whose
// answer is known by construction. A page fails when a time limit takes what the visitor typed (clears
// it, locks the field or removes it) and nothing turns the limit off, adjusts it to ten times its
// default, or offers to extend it at least 20 seconds before. The limit starts with the page, with
// typing, or with a "Start" button; it is kept by one timeout, by a 1 s tick that counts down, by a
// 200 ms tick that reads the clock, or by a 500 ms timeout that re-arms itself and reads the clock.
import { timingEntryProbe } from '../../../src/probes/timingEntry.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'animation-in-flight', 'scroll-snap', 'reduced-motion-honored'];

type Start = 'load' | 'typing' | 'press';
type Clockwork = 'timeout' | 'ticks' | 'clock' | 'chain';
type Offer =
  // Fail: nothing; "extend" shown 10 s before; a warning with only "Close"; a range up to nine times the default.
  | 'nothing' | 'extend-10' | 'warn-only' | 'adjust-9x'
  // Pass: "extend" shown 25 s before; a switch that turns the limit off; a range of ten times; a timer that takes nothing.
  | 'extend-25' | 'off-switch' | 'adjust-10x' | 'no-limit' | 'saved';
type Effect = 'clear' | 'lock' | 'remove';
type Field = 'textarea' | 'input' | 'number';

const FAILS = new Set<Offer>(['nothing', 'extend-10', 'warn-only', 'adjust-9x']);
const EXTEND_NAMES = ['Extend', 'I need more time', 'Stay signed in', 'Keep working'] as const;
const OFF_NAMES = ['No time limit', 'Turn off the time limit', 'Disable the timer'] as const;
const CSS = 'label { display: block; margin-top: 12px; } textarea, input[type="text"], input[type="number"], select { font: inherit; min-width: 240px; } #warn { border: 2px solid #8a4b00; padding: 8px 12px; margin: 12px 0; } button { font: inherit; padding: 6px 12px; }';

export function entryCase(start: Start, clockwork: Clockwork, offer: Offer, effect: Effect, field: Field, limitS: number, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `timing-entry/${start}/${clockwork}/${offer}/${effect}/${field}/${limitS}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const warnMs = offer === 'extend-10' ? 10_000 : offer === 'extend-25' ? 25_000 : offer === 'warn-only' ? 15_000 : 0;
  const control = field === 'textarea' ? '<textarea id="f" rows="3"></textarea>' : field === 'number' ? '<input type="number" id="f">' : '<input type="text" id="f">';
  const label = field === 'number' ? 'How many people are coming?' : 'What do you need help with?';
  const extendName = EXTEND_NAMES[rep % EXTEND_NAMES.length]!;
  const offName = OFF_NAMES[rep % OFF_NAMES.length]!;
  const seconds = (s: number) => (s >= 120 && s % 60 === 0 ? `${s / 60} minutes` : `${s} seconds`);
  const range = offer === 'adjust-9x' ? [limitS, limitS * 3, limitS * 9] : [limitS, limitS * 10];
  const options = offer === 'off-switch' ? `<label><input type="checkbox" id="off"> ${offName}</label>`
    : offer === 'adjust-9x' || offer === 'adjust-10x' ? `<label for="len">Time limit</label><select id="len">${range.map((s, i) => `<option value="${s}"${i === 0 ? ' selected' : ''}>${seconds(s)}</option>`).join('')}</select>` : '';
  const take = offer === 'no-limit' ? "document.getElementById('note').textContent = 'Are you still there? What you typed is kept on this device.';"
    : offer === 'saved' ? "document.getElementById('note').textContent = 'Your draft was saved.';"
      : effect === 'clear' ? "f.value = '';" : effect === 'lock' ? 'f.disabled = true;' : "document.getElementById('box').remove();";
  const onWarn = warnMs
    ? `warn.innerHTML = '<p>Your time is almost up.</p><button type="button" id="wb">${offer === 'warn-only' ? 'Close' : extendName}</button>'; warn.hidden = false;
      document.getElementById('wb').addEventListener('click', function () { warn.hidden = true; ${offer === 'warn-only' ? '' : 'arm();'} });`
    : '';
  // The limit's clockwork: arm() starts (or restarts) the limit, onWarn runs W ms before its end, take() at its end.
  const works: Record<Clockwork, string> = {
    timeout: `var a = 0, b = 0; function arm() { clearTimeout(a); clearTimeout(b); if (W) a = setTimeout(onWarn, LIMIT - W); b = setTimeout(take, LIMIT); } arm();`,
    ticks: `var left = 0, warned = false; function arm() { left = Math.round(LIMIT / 1000); warned = false; } arm();
      var id = setInterval(function () { left -= 1; if (W && !warned && left <= W / 1000) { warned = true; onWarn(); } if (left <= 0) { clearInterval(id); take(); } }, 1000);`,
    clock: `var end = 0, warned = false; function arm() { end = Date.now() + LIMIT; warned = false; } arm();
      var id = setInterval(function () { var left = end - Date.now(); if (W && !warned && left <= W) { warned = true; onWarn(); } if (left <= 0) { clearInterval(id); take(); } }, 200);`,
    chain: `var end = 0, warned = false; function arm() { end = performance.now() + LIMIT; warned = false; } arm();
      (function tick() { var left = end - performance.now(); if (W && !warned && left <= W) { warned = true; onWarn(); } if (left <= 0) { take(); return; } setTimeout(tick, 500); })();`,
  };
  const begin = `function begin() {
      ${offer === 'off-switch' ? "if (document.getElementById('off').checked) return;" : ''}
      var LIMIT = ${offer === 'adjust-9x' || offer === 'adjust-10x' ? "Number(document.getElementById('len').value) * 1000" : limitS * 1000}, W = ${warnMs};
      function take() { ${take} }
      function onWarn() { ${onWarn} }
      ${works[clockwork]}
    }`;
  const trigger = start === 'load' ? 'begin();'
    : start === 'typing' ? "f.addEventListener('input', begin, { once: true });"
      : "f.disabled = true; document.getElementById('go').addEventListener('click', function () { f.disabled = false; begin(); }, { once: true });";
  const init = [`(function () { var f = document.getElementById('f'), warn = document.getElementById('warn'); ${begin} ${trigger} })();`];
  const body = `<p>Tell the front desk what you need and we will have it ready.</p>${options}
${start === 'press' ? '<p><button type="button" id="go">Start a request</button></p>' : ''}
<div id="box"><label for="f">${label}</label>${control}</div>
<div id="warn" role="alert" hidden></div><p id="note" role="status"></p>${filler(r, 2)}`;
  const pg = parts('Front desk request', body, [CSS], init);
  applyHazard(pg, hazard, r);
  const fails = FAILS.has(offer);
  return {
    id, test: 'timing-entry', hazard, params: { start, clockwork, offer, effect, field, limitS, rep },
    site: render(pg),
    expect: { '2.2.1': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: fails
      ? `${limitS} s after ${start === 'load' ? 'the page loads' : start === 'typing' ? 'typing starts' : 'the button is pressed'} a ${clockwork} limit takes what was typed (${effect}); the page offers ${offer === 'nothing' ? 'nothing' : offer === 'extend-10' ? 'to extend only 10 s before' : offer === 'warn-only' ? 'a warning with no way to extend' : 'a range of nine times the default'}`
      : offer === 'no-limit' || offer === 'saved' ? `the timer (${clockwork}) takes nothing the visitor typed (${offer})`
        : `the limit can be ${offer === 'off-switch' ? 'turned off' : offer === 'adjust-10x' ? 'set to ten times its default' : 'extended from a button shown 25 s before'}`,
  };
}

/**
 * Act-watch review r1, F7: two timers that are no limit on the visitor, never failed. 'dialog': a dialog opens
 * `limitS` s after the load and makes the page behind it inert (closing it gives the field back). 'used': the
 * visitor types, presses "Send", the page thanks them and takes the box away `limitS` s later.
 */
export function usedCase(kind: 'dialog' | 'used' | 'next-step', limitS: number, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `timing-entry/review-${kind}/${limitS}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const field = rep % 2 ? '<textarea id="f" rows="3"></textarea>' : '<input type="text" id="f">';
  const init = kind === 'dialog'
    ? [`(function () { var m = document.getElementById('page'), d = document.getElementById('dlg');
  setTimeout(function () { m.inert = true; d.hidden = false; }, ${limitS * 1000});
  document.getElementById('dc').addEventListener('click', function () { m.inert = false; d.hidden = true; }); })();`]
    : kind === 'next-step'
      ? [`document.getElementById('send').addEventListener('click', function () { document.getElementById('two').hidden = false;
  setTimeout(function () { document.getElementById('f').value = ''; }, ${limitS * 1000}); });`]
    : [`document.getElementById('send').addEventListener('click', function () { document.getElementById('note').textContent = ${JSON.stringify(['Thanks, we got your note.', 'Thank you for your feedback.', 'Sent. We will read it today.'][rep % 3])};
  setTimeout(function () { document.getElementById('box').remove(); }, ${limitS * 1000}); });`];
  const body = `<div id="page"><p>Tell the front desk what you need and we will have it ready.</p>
<div id="box"><label for="f">${kind === 'used' ? 'Was this page helpful? Tell us more' : 'What do you need help with?'}</label>${field}${kind === 'used' ? '<p><button type="button" id="send">Send</button></p>' : kind === 'next-step' ? '<p><button type="button" id="send">Continue to the details</button></p><div id="two" hidden><h2>Details</h2><label for="g">How many people are coming?</label><input type="number" id="g"></div>' : ''}</div>
<p id="note"></p>${filler(r, 2)}</div>${kind === 'dialog' ? '<div id="dlg" role="dialog" aria-modal="true" aria-label="News" hidden style="position:fixed;inset:25% 15%;background:#fff;border:2px solid #333;padding:1rem"><p>Get the monthly news.</p><button type="button" id="dc">Close</button></div>' : ''}`;
  const pg = parts('Front desk request', body, [CSS], init);
  applyHazard(pg, hazard, r);
  return {
    id, test: 'timing-entry', hazard, params: { kind, limitS, rep },
    site: render(pg),
    expect: { '2.2.1': kind === 'next-step' ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: kind === 'next-step' ? `a press that only moves on to the next step starts a timer that clears the first step's entry ${limitS} s later, with no way to extend` : kind === 'dialog' ? `a dialog opens ${limitS} s after the load and makes the page inert; closing it gives the field back` : `the press uses what was typed (thanks), and the box goes ${limitS} s later`,
  };
}

export function entryCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  const starts: Start[] = ['load', 'typing', 'press'];
  const works: Clockwork[] = ['timeout', 'ticks', 'clock', 'chain'];
  const effects: Effect[] = ['clear', 'lock', 'remove'];
  const fields: Field[] = ['textarea', 'input', 'number'];
  // Offers that need a control set before the limit starts go with the "Start" button only.
  const plan: [Offer, number, readonly Start[], readonly number[]][] = [
    ['nothing', 3, starts, [12, 30, 45, 600]], ['extend-10', 2, starts, [40, 60, 90, 300]], ['warn-only', 1, starts, [40, 60, 90]], ['adjust-9x', 3, ['press'], [20, 40, 60]],
    ['extend-25', 2, starts, [40, 60, 90, 300]], ['no-limit', 2, starts, [12, 30, 45, 600]], ['saved', 1, starts, [12, 30, 45]], ['off-switch', 3, ['press'], [20, 40, 600]], ['adjust-10x', 3, ['press'], [20, 40, 60]],
  ];
  let i = 0;
  for (const [offer, reps, forStarts, limits] of plan) {
    for (const start of forStarts) for (const clockwork of works) for (let rep = 0; rep < reps; rep++) {
      out.push(entryCase(start, clockwork, offer, effects[i % effects.length]!, fields[(i >> 1) % fields.length]!, limits[i % limits.length]!, rep, HAZARDS[i % HAZARDS.length]!, seed));
      i++;
    }
  }
  // Review r1 F7: 12 of each; dialog and used never fail, next-step (a press that only moves on) still fails.
  for (const kind of ['dialog', 'used', 'next-step'] as const) for (let rep = 0; rep < 12; rep++) out.push(usedCase(kind, [6, 8, 12, 30][rep % 4]!, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  return [...new Map(out.map((c) => [c.id, c])).values()];
}

export const timingEntryTest: SimTest = {
  id: 'timing-entry', criteria: ['2.2.1'], probes: () => [timingEntryProbe], full: true, read: 'probe', readProbes: ['timing-entry'], capMs: 120_000, cases: entryCases,
  knownIssue: "A countdown kept by a tick under 1 s that was already running when the test started (set as the page loaded) and that shows a button to extend less than 20 s before the end is not failed: the test cannot run such a tick by hand (the hook lists timers of 1 s or more), so it moves the clock in steps and knows the limit and the button only between two steps. Two of the 168 pages (load x clock x extend-10). Listing short intervals in the hook (probes/listeners.ts) would close it.",
};
