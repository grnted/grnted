// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.1 Use of color, a colour key, in real Chromium. "Color is not used as the only visual means of
// conveying information, indicating an action, prompting a response, or distinguishing a visual element."
// A page that explains what its colours mean ("Green means free. Red means taken.", "Boxes labelled in red are
// required", or a row of swatches with a word each) and then marks its items with the colour alone fails:
// failure F81 for required fields, and the missing technique G14 / G182 (the information also in text, or
// another visual cue). The test fires only where the page itself says colour carries the meaning, and only when
// no item carries a word of that meaning, a symbol, or a shape or type style of its own.
// Look-alikes: the same keys with the word on each item, with a shape or an asterisk or bold type, prose that
// only mentions colours, names that happen to be colours, and coloured items with no key at all.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { linkColorProbe } from '../../src/probes/linkColor.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const CSS = `body { font: 16px/1.5 sans-serif; margin: 32px; background: #fff; color: #1d2a2e; } ul { padding-left: 20px; }
.dot { display: inline-block; width: 14px; height: 14px; border-radius: 50%; margin: 0 6px; vertical-align: middle; }
.g { background: #1f7a45; } .r { background: #b3262e; } .tg { color: #1b6b3a; } .tr { color: #a3202a; } .shade { background: #f0b9b9; }
table { border-collapse: collapse; } td, th { padding: 6px 12px; border: 1px solid #99a; text-align: left; } label { display: block; margin-top: 12px; } input { font: inherit; padding: 6px; }
.grid { display: grid; grid-template-columns: repeat(3, 160px); } .grid span { padding: 8px; border: 1px solid #99a; }`;
const doc = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Harbour pool</title><style>${CSS}</style></head><body><main><h1>Harbour pool</h1><p>Plan a visit to the pool and the gym.</p>${body}</main></body></html>`;

async function pages(bodies: Record<string, string>): Promise<Record<string, ProbeRun>> {
  const files = Object.fromEntries(Object.entries(bodies).map(([name, body]) => [`/${name}`, doc(body)]));
  const sim = await startSimServer({ files });
  try {
    const runs = await runProbes(browser as unknown as BrowserLike, Object.keys(bodies).map((name, index) => ({ url: `${sim.origin}/${name}`, index })), [linkColorProbe], { userAgent: 'grnted-test', full: true });
    return Object.fromEntries(runs.map((r) => [new URL(r.page).pathname.slice(1), r]));
  } finally {
    await sim.close();
  }
}
const failed = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed');
const text = (r: ProbeRun) => JSON.stringify(r.findings);

const DOTS = (a: string, b: string) => `<h2>Lockers</h2><p>A green dot means the locker is free. A red dot means it is taken.</p><ul id="lockers"><li><span class="dot g"></span>${a}</li><li><span class="dot r"></span>${b}</li><li><span class="dot g"></span>Locker 16</li></ul>`;
const LANES = (a: string, b: string) => `<h2>Lanes</h2><p>Green lanes are open. Red lanes are closed.</p><ul id="lanes"><li class="tg">${a}</li><li class="tr">${b}</li><li class="tg">Lane 3</li></ul>`;
const ROWS = (a: string, b: string) => `<h2>Invoices</h2><p>Green means paid; red means overdue.</p><table id="invoices"><tr><th scope="col">Invoice</th><th scope="col">Amount</th>${a || b ? '<th scope="col">Status</th>' : ''}</tr>
<tr style="color:#1b6b3a"><th scope="row">Swim club, May</th><td>$240</td>${a}</tr><tr style="color:#a3202a"><th scope="row">Swim club, June</th><td>$240</td>${b}</tr></table>`;
const SHADED = (mark: string) => `<h2>Cleaning days</h2><p>Dates shaded red need a second visit.</p><div class="grid" id="days"><span>Main pool</span><span class="shade">June 3${mark}</span><span>June 10</span><span>Teaching pool</span><span>June 4</span><span>June 11</span></div>`;
const FORM = (label: string, css = '') => `<h2>Book a lane</h2><form id="book"><p>Boxes labelled in red are required.</p><label class="tr" style="${css}" for="who">${label}</label><input id="who" name="who" required><label for="note">Note for the lifeguard</label><input id="note" name="note"><p><button type="submit">Book</button></p></form>`;
const SWATCHES = (a: string, b: string) => `<h2>Lifts</h2><p id="key"><span class="dot g"></span> Running <span class="dot r"></span> Stopped</p><ul id="lifts"><li>Pool hoist ${a}<span class="dot g"></span></li><li>Gym lift ${b}<span class="dot r"></span></li></ul>`;

describe('use of color (1.4.1): a colour key whose items carry only the colour', () => {
  let runs: Record<string, ProbeRun>;
  beforeAll(async () => {
    runs = await pages({
      dots: DOTS('Locker 14', 'Locker 15'),
      lanes: LANES('Lane 1', 'Lane 2'),
      rows: ROWS('', ''),
      shaded: SHADED(''),
      form: FORM('Your name'),
      swatches: SWATCHES('', ''),
      // Review r2, finding 6: two coloured names in one plain block, each with its status written after it.
      courts: '<h2>Courts</h2><p>Green means free. Red means taken.</p><div id="courts"><span class="tg">Court one</span> Free <span class="tr">Court two</span> Taken</div>',
      rooms: '<h2>Changing rooms</h2><p>Green rooms are free. Red rooms need cleaning.</p><ul id="rooms"><li class="tg">Room A</li><li class="tr">Room B</li></ul>',
      overdue: '<h2>Club invoices</h2><p>Overdue invoices are shown in red.</p><ul id="club"><li>Swim club, May</li><li class="tr">Swim club, June</li><li>Dive club, June</li></ul>',
      cells: '<h2>Classes</h2><table id="classes"><caption>Classes this week. Green means places left; orange means waiting list.</caption><tr><th scope="col">Class</th><th scope="col">Places</th></tr><tr><th scope="row">Aqua fit</th><td style="color:#1f7a45">●</td></tr><tr><th scope="row">Lane swim</th><td style="color:#a55a14">●</td></tr></table>',
      'cells-shapes': '<h2>Classes</h2><table><caption>Classes this week. Green means places left; orange means waiting list.</caption><tr><th scope="col">Class</th><th scope="col">Places</th></tr><tr><th scope="row">Aqua fit</th><td style="color:#1f7a45">●</td></tr><tr><th scope="row">Lane swim</th><td style="color:#a55a14">■</td></tr></table>',
      'overdue-far': '<h2>Finding the exits</h2><p>The exits are marked in red.</p><p>The plan is by the front desk.</p><p>Ask a lifeguard for help.</p><ul><li>Open every day</li><li class="tr">Closed on 25 December</li></ul>',
      // A key of swatches with its counts in words, over a bar whose coloured parts repeat the counts (a chart with its legend).
      bar: '<h2>Lanes today</h2><p><span class="dot g"></span> Open 5 <span class="dot r"></span> Closed 2</p><div style="display:flex;width:420px"><span style="flex:5;background:#1f7a45;color:#fff;padding:4px">5</span><span style="flex:2;background:#b3262e;color:#fff;padding:4px">2</span></div>',
      // Review r1, finding 2: the item is the whole list item, row, term or label group; any status text or cue in it exempts it.
      pools: '<h2>Pools</h2><p>Green means open. Red means closed.</p><ul id="pools"><li><span style="color:#1b6b3a">North pool</span> Open</li><li><span style="color:#a3202a">South pool</span> Closed</li></ul>',
      'pools-names': '<h2>Pools</h2><p>Green means open. Red means closed.</p><ul id="pools"><li><span style="color:#1b6b3a">North pool</span></li><li><span style="color:#a3202a">South pool</span></li></ul>',
      'pools-own-words': '<h2>Pools</h2><p>Green means open. Red means closed.</p><ul><li><span style="color:#1b6b3a">North pool</span> — swimmers welcome</li><li><span style="color:#a3202a">South pool</span> — being drained</li></ul>',
      'chart-inline': '<h2>Water tests</h2><p>Green means passed. Red means failed.</p><div><span style="background:#1f7a45;color:#fff;padding:2px 8px">12</span> <span>Passed</span></div><div><span style="background:#b3262e;color:#fff;padding:2px 8px">3</span> <span>Failed</span></div>',
      'chart-flex': '<h2>Water tests</h2><p>Green means passed. Red means failed.</p><div style="display:flex;gap:8px"><span style="background:#1f7a45;color:#fff;padding:2px 8px">12</span><span>Passed</span></div><div style="display:flex;gap:8px"><span style="background:#b3262e;color:#fff;padding:2px 8px">3</span><span>Failed</span></div>',
      'tail-words': '<h2>Lanes</h2><p>Green lanes are open. Red lanes are closed.</p><ul><li class="tg">Lane 1 — ready for swimmers</li><li class="tr">Lane 2 — roped off</li></ul>',
      'status-column': '<h2>Invoices</h2><p>Green means paid; red means overdue.</p><table><tr><th scope="col">Invoice</th><th scope="col">Status</th></tr><tr><th scope="row" style="color:#1b6b3a">Swim club, May</th><td>Settled</td></tr><tr><th scope="row" style="color:#a3202a">Swim club, June</th><td>Late</td></tr></table>',
      terms: '<h2>Pools</h2><p>Green means open. Red means closed.</p><dl><dt class="tg">North pool</dt><dd>Open until nine</dd><dt class="tr">South pool</dt><dd>Closed for cleaning</dd></dl>',
      'label-hint': FORM('Your name').replace('<input id="who" name="who" required>', '<input id="who" name="who" required> <span class="hint">(required)</span>'),
      'icons-differ': '<h2>Pools</h2><p>Green means open. Red means closed.</p><ul><li class="tg"><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="5"/></svg> North pool</li><li class="tr"><svg width="12" height="12" aria-hidden="true"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor"/></svg> South pool</li></ul>',
      'icons-same': '<h2>Pools</h2><p>Green means open. Red means closed.</p><ul id="same"><li class="tg"><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="5"/></svg> North pool</li><li class="tr"><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="5"/></svg> South pool</li></ul>',
      'dots-words': DOTS('Locker 14: free', 'Locker 15: taken'),
      'dots-shapes': DOTS('Locker 14', 'Locker 15').replace(/class="dot r"/g, 'class="dot r" style="border-radius:0"'),
      'dots-title': DOTS('Locker 14', 'Locker 15').replace(/class="dot g"/g, 'class="dot g" title="Free"').replace(/class="dot r"/g, 'class="dot r" title="Taken"'),
      'lanes-words': LANES('Lane 1 (open)', 'Lane 2 (closed)'),
      'rows-status': ROWS('<td>Paid</td>', '<td>Overdue</td>'),
      'shaded-mark': SHADED(' ⚑ second visit'),
      'form-star': FORM('Your name *'),
      'form-bold': FORM('Your name', 'font-weight:700'),
      'form-word': FORM('Your name (required)'),
      'swatches-words': SWATCHES('— running ', '— stopped '),
      prose: '<h2>Finding us</h2><p>The red door is on the left. The green gate is by the car park.</p><ul><li class="tr">Sale ends Friday</li><li>Towels for hire</li></ul>',
      names: '<h2>Buses</h2><p>The Red line runs every ten minutes. The Green line runs every fifteen.</p><ul><li class="tr">Red line: harbour to pool</li><li class="tg">Green line: station to pool</li></ul>',
      'no-key': '<h2>Lanes</h2><ul><li class="tg">Lane 1</li><li class="tr">Lane 2</li></ul><ul><li><span class="dot g"></span>Locker 14</li><li><span class="dot r"></span>Locker 15</li></ul>',
      'one-colour': '<h2>Lanes</h2><p>Green lanes are open. Red lanes are closed.</p><ul><li class="tg">Lane 1</li><li class="tg">Lane 2</li></ul>',
    });
  }, 240_000);

  it('fails same-shaped dots under a key that names the colours', () => {
    const r = runs['dots']!;
    expect(failed(r), text(r)).toEqual([expect.objectContaining({
      criterion: '1.4.1', target: expect.stringContaining('#lockers'),
      detail: expect.stringMatching(/^Only color tells these items apart: the page says “A green dot means the locker is free\. A red dot means it is taken\.”, and 3 items there carry the color with no word, symbol or shape of their own that says which: “Locker 14”, “Locker 15”, “Locker 16”$/),
    })]);
  });

  it('fails list items and table rows told apart by the colour of their text only', () => {
    expect(failed(runs['lanes']!), text(runs['lanes']!)).toEqual([expect.objectContaining({ target: expect.stringContaining('#lanes'), detail: expect.stringContaining('“Green lanes are open. Red lanes are closed.”') })]);
    expect(failed(runs['rows']!), text(runs['rows']!)).toEqual([expect.objectContaining({ target: expect.stringContaining('#invoices'), detail: expect.stringContaining('“Swim club, May $240”') })]);
  });

  it('fails one shaded cell among plain ones, and a required field marked by a red label only (F81)', () => {
    expect(failed(runs['shaded']!), text(runs['shaded']!)).toEqual([expect.objectContaining({
      target: expect.stringContaining('#days'), detail: expect.stringMatching(/the page says “Dates shaded red need a second visit\.”, and 1 item there is told apart from the others like it only by its color: “June 3”$/),
    })]);
    expect(failed(runs['form']!), text(runs['form']!)).toEqual([expect.objectContaining({ target: expect.stringContaining('#book'), detail: expect.stringContaining('“Boxes labelled in red are required.”') })]);
  });

  it('fails dots under a key made of swatches with a word each', () => {
    const r = runs['swatches']!;
    expect(failed(r), text(r)).toEqual([expect.objectContaining({ target: expect.stringContaining('#lifts'), detail: expect.stringMatching(/the page’s key gives a color to each of “Running” and “Stopped”, and 2 items there carry the color with no word/) })]);
  });

  it('fails under keys worded other ways: a second clause with its own verb, the meaning before the colour, and a bullet character in a cell', () => {
    expect(failed(runs['rooms']!), text(runs['rooms']!)).toEqual([expect.objectContaining({ target: expect.stringContaining('#rooms'), detail: expect.stringContaining('“Green rooms are free. Red rooms need cleaning.”') })]);
    expect(failed(runs['overdue']!), text(runs['overdue']!)).toEqual([expect.objectContaining({ target: expect.stringContaining('#club'), detail: expect.stringMatching(/“Overdue invoices are shown in red\.”, and 1 item there is told apart from the others like it only by its color: “Swim club, June”$/) })]);
    expect(failed(runs['cells']!), text(runs['cells']!)).toEqual([expect.objectContaining({ target: expect.stringContaining('#classes'), detail: expect.stringContaining('2 items there carry the color') })]);
  });

  it('look-alike: bullet characters of two shapes, a one-colour sentence that is not beside the coloured item, and a chart under its key of swatches are not failed', () => {
    for (const name of ['cells-shapes', 'overdue-far', 'bar']) expect(failed(runs[name]!), `${name}: ${text(runs[name]!)}`).toEqual([]);
  });

  it('does not fail when the status stands in words beside a coloured name: in the list item, the row, the term’s description or the label’s hint', () => {
    for (const name of ['pools', 'chart-inline', 'chart-flex', 'status-column', 'terms', 'label-hint']) expect(failed(runs[name]!), `${name}: ${text(runs[name]!)}`).toEqual([]);
  });

  it('does not rebuild items from coloured names that share one block with their status words: not failed, and not testable', () => {
    const r = runs['courts']!;
    expect(failed(r), text(r)).toEqual([]);
    expect(r.findings.filter((f) => f.status === 'not_testable'), text(r)).toEqual([expect.objectContaining({
      criterion: '1.4.1', target: expect.stringContaining('#courts'), detail: expect.stringMatching(/^Whether only color tells these items apart could not be told: the page says “Green means free\. Red means taken\.”, and the 2 colored items there share one block of text/),
    })]);
  });

  it('does not fail when the items say the status in their own words, or show a different icon for each color', () => {
    for (const name of ['pools-own-words', 'tail-words', 'icons-differ']) expect(failed(runs[name]!), `${name}: ${text(runs[name]!)}`).toEqual([]);
  });

  it('look-alike: names in color only, with no status text (and the same icon on every item), still fail', () => {
    expect(failed(runs['pools-names']!), text(runs['pools-names']!)).toEqual([expect.objectContaining({ target: expect.stringContaining('#pools'), detail: expect.stringContaining('“North pool”, “South pool”') })]);
    expect(failed(runs['icons-same']!), text(runs['icons-same']!)).toEqual([expect.objectContaining({ target: expect.stringContaining('#same') })]);
  });

  it('look-alike: the same keys pass when each item also says it in words', () => {
    for (const name of ['dots-words', 'lanes-words', 'rows-status', 'form-word', 'swatches-words']) expect(failed(runs[name]!), `${name}: ${text(runs[name]!)}`).toEqual([]);
  });

  it('look-alike: a shape, a symbol, an asterisk, bold type or a hover title of its own is another cue', () => {
    for (const name of ['dots-shapes', 'dots-title', 'shaded-mark', 'form-star', 'form-bold']) expect(failed(runs[name]!), `${name}: ${text(runs[name]!)}`).toEqual([]);
  });

  it('look-alike: prose that mentions colours, names that are colours, coloured items with no key, and a key with one colour in use are not failed', () => {
    for (const name of ['prose', 'names', 'no-key', 'one-colour']) expect(failed(runs[name]!), `${name}: ${text(runs[name]!)}`).toEqual([]);
  });
});
