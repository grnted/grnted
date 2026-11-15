// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Self-updating live data is never a form's answer (batch 17, 2026-11-12; probe `forms`, deep, 4.1.3). A form beside,
// around or holding something the page keeps writing by itself on a timer: an arrival time, a queue length, a
// "last updated" line, a countdown, a rotating service alert whose lines read like errors. The text changes every
// 1.8 to 4.5 s, so on one attempt in three or four it changes in the half second the test watches after a submit.
// The answer by construction:
// - pass: the form's own script answers a submit with nothing, or with a message in a role=status region; the
//   live value is the only other thing that changes. Read as the form's message, the live value failed 4.1.3
//   ("the form showed 1 error message (for example “7 min”) that screen readers do not announce");
// - fail: the same pages where the form does answer an empty submit with an error text that nothing announces
//   (in the form, or in a summary above it): it must still be found, with the live value ticking beside it.
import { formsProbe } from '../../../src/probes/forms.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll'];
const CSS = ['label { display: block; margin-top: 10px; } input, select, textarea, button { font: 16px Arial; padding: 4px; border: 2px solid #1b1b1b; } fieldset { border: 1px solid #555; margin: 12px 0; } .layout { display: flex; gap: 32px; flex-wrap: wrap; } .panel { border: 1px solid #555; padding: 8px 16px; max-width: 320px; } .err { color: #a00000; }'];

const LIVE = ['eta', 'queue', 'updated', 'countdown', 'alert'] as const;
type Live = (typeof LIVE)[number];
const PLACES = ['beside', 'in-form', 'described'] as const;
type Place = (typeof PLACES)[number];
const ANSWERS = ['silent', 'status', 'quiet-error', 'quiet-summary'] as const;
type Answer = (typeof ANSWERS)[number];
const PERIODS = [1800, 2500, 3300, 4500] as const;

/** The live element's markup and the lines it cycles through. */
function live(kind: Live): { html: string; lines: string[] } {
  switch (kind) {
    case 'eta': return { html: 'Route 12 to the library: <b id="live">6 min</b>', lines: ['6 min', '7 min', '5 min', '8 min'] };
    case 'queue': return { html: 'Callers waiting: <span id="live">4 people ahead of you</span>', lines: ['4 people ahead of you', '3 people ahead of you', '5 people ahead of you'] };
    case 'updated': return { html: '<span id="live">Updated a moment ago</span>', lines: ['Updated a moment ago', 'Updated one minute ago', 'Updated two minutes ago'] };
    case 'countdown': return { html: 'Parking: <span id="live">the east lot fills in about twelve minutes</span>', lines: ['the east lot fills in about twelve minutes', 'the east lot fills in about eleven minutes', 'the east lot fills in about ten minutes'] };
    default: return { html: '<span id="live">Elevator at Main Station is out of service; please use the ramp</span>', lines: ['Elevator at Main Station is out of service; please use the ramp', 'Route 24 cannot serve Elm Street today', 'Stop closed: boarding is not allowed at Pine Avenue'] };
  }
}

export function liveCase(kind: Live, place: Place, answer: Answer, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `forms-live/${kind}/${place}/${answer}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const l = live(kind);
  const ms = PERIODS[(rep + kind.length + place.length) % PERIODS.length]!;
  const panel = `<aside class="panel" aria-label="Right now"><h2>Right now</h2><p>${l.html}</p></aside>`;
  const inForm = `<p${place === 'described' ? ' id="live-note"' : ''}>${l.html}</p>`;
  // Half the forms have nothing to get wrong (preferences); half ask for a stop name.
  const stop = rep % 2 === 0 ? '' : `<label for="stop">Stop name</label><input id="stop" name="stop"${place === 'described' ? ' aria-describedby="live-note"' : ''}>`;
  const walk = `<label for="walk">Maximum walking distance</label><select id="walk" name="walk"${place === 'described' && rep % 2 === 0 ? ' aria-describedby="live-note"' : ''}><option>One quarter mile</option><option>One half mile</option></select>`;
  const form = `${answer === 'quiet-summary' ? '<p id="summary" class="err"></p>' : ''}<form id="f" novalidate>
<fieldset><legend>Trip options</legend><label><input type="checkbox" name="stairs" checked> Avoid stairs</label>${walk}${stop}</fieldset>
${place !== 'beside' ? inForm : ''}<p id="answer"${answer === 'status' ? ' role="status"' : answer === 'quiet-error' ? ' class="err"' : ''}></p>
<p><button type="submit">${['Update trip options', 'Save', 'Apply', 'Show trips'][rep % 4]}</button></p></form>`;
  const submit = answer === 'silent' ? ''
    : answer === 'status' ? "document.getElementById('answer').textContent = 'Your trip options are saved.';"
      : answer === 'quiet-error' ? "document.getElementById('answer').textContent = 'Choose a walking distance you can manage, then update again.';"
        : "document.getElementById('summary').textContent = 'There is a problem: choose a walking distance you can manage.';";
  const init = [
    `document.getElementById('f').addEventListener('submit', function (e) { e.preventDefault(); ${submit} });`,
    // The page's own timer, running from load: it writes the live value whatever anyone does.
    `(function () { var lines = ${JSON.stringify(l.lines)}, n = 0; setInterval(function () { n = (n + 1) % lines.length; document.getElementById('live').textContent = lines[n]; }, ${ms}); })();`,
  ];
  const body = `<p>Choose how you travel. Trips are planned again when you update.</p><div class="layout"><article>${form}</article>${place === 'beside' ? panel : ''}</div>${filler(r, 1)}`;
  const pg = parts('Trip options', body, [...CSS], init);
  applyHazard(pg, hazard, r);
  const fails = answer === 'quiet-error' || answer === 'quiet-summary';
  return {
    id, test: 'forms-live', hazard, params: { kind, place, answer, rep, ms },
    site: render(pg),
    expect: { '4.1.3': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: fails ? `the form answers an empty submit with an error text ${answer === 'quiet-summary' ? 'above the form' : 'in the form'} that nothing announces, while a live ${kind} ${place === 'beside' ? 'beside it' : 'in it'} changes by itself every ${ms / 1000} s`
      : `the form ${answer === 'silent' ? 'shows nothing' : 'answers in a role=status region'}; a live ${kind} ${place === 'beside' ? 'beside it' : place === 'in-form' ? 'in it' : 'that describes a field'} changes by itself every ${ms / 1000} s and is no message of the form`,
  };
}

export function liveCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  // 90 passing pages (five live kinds, three places, the form silent or announcing, three each) and 60 failing ones
  // (five kinds, three places, an unannounced error in the form or above it, two each).
  for (const kind of LIVE) {
    for (const place of PLACES) {
      for (const answer of ['silent', 'status'] as const) for (let rep = 0; rep < 3; rep++) out.push(liveCase(kind, place, answer, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
      for (const answer of ['quiet-error', 'quiet-summary'] as const) for (let rep = 0; rep < 2; rep++) out.push(liveCase(kind, place, answer, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
    }
  }
  return out;
}

export const formsLiveTest: SimTest = {
  id: 'forms-live', criteria: ['4.1.3'], probes: () => [formsProbe], full: true, read: 'probe', readProbes: ['forms'], capMs: 120_000, cases: liveCases,
};
