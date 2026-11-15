// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.3 for text a style rule shows only while the pointer is on something or it has keyboard focus (a hint
// under a button, a drop-down menu), in real Chromium. The SC covers it like any other text: its exceptions are
// inactive components, pure decoration, text nobody sees and logotypes (G18). axe reads the page at rest, where
// this text is not shown at all. The test finds it from the page's own style rules (a `:hover`, `:focus` or
// `:focus-within` on an element before the hidden one that sets `display`, `visibility` or `opacity`), puts the
// element in that state (keyboard focus in the page; the browser's forced `:hover`), and reads the solid colours
// of the text that then shows. A `minor` failure.
// Look-alikes: the same hint with enough contrast, a hint with no backdrop of its own floating over the page
// (its backdrop is not known from colours), a hint on a picture, hidden text that no state rule shows, and text
// that is shown at rest.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const page = (css: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ferry times</title>
<style>body { font: 16px/1.5 sans-serif; margin: 32px; background: #fff; color: #1b1b1b; } button { font: inherit; padding: 8px 16px; } .wrap { position: relative; display: inline-block; margin: 0 0 80px; }
.hint { display: none; position: absolute; top: 100%; left: 0; width: 260px; padding: 10px; border: 1px solid #9aa; } ${css}</style></head>
<body><main><h1>Ferry times</h1><p>Boats leave from the east quay every half hour.</p>${body}</main></body></html>`;

async function run(html: string): Promise<ProbeRun> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0, incomplete: [] }], [textContrastProbe], { userAgent: 'grnted-test', full: true });
    return r!;
  } finally {
    await sim.close();
  }
}
const failed = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed');
const HINT = '<div class="wrap"><button type="button" aria-describedby="tip">Boarding</button><span class="hint" id="tip">Gates close five minutes before sailing.</span></div>';
const SHOW = '.wrap:hover .hint, .wrap:focus-within .hint { display: block; }';

describe('text contrast (1.4.3): text shown only on hover or keyboard focus', () => {
  it('fails a faint hint that a rule shows while the pointer is on its button or the button has focus', async () => {
    const r = await run(page(`${SHOW} .hint { background: #fff; color: #aaaaaa; }`, HINT));
    expect(failed(r), JSON.stringify(r.findings)).toEqual([expect.objectContaining({
      criterion: '1.4.3', target: '#tip', minor: true,
      detail: expect.stringMatching(/^Text shown only when “Boarding” has keyboard focus or the pointer is on it has 2\.3:1 contrast \(text #aaaaaa on #ffffff\); 16 px text needs at least 4\.5:1: “Gates close five minutes before sailing\.”$/),
    })]);
  }, 60_000);

  it('fails faint links in a menu shown on hover, and a tip made visible by the focus of the button before it', async () => {
    const r = await run(page(`nav ul { list-style: none; padding: 0; margin: 0; } nav > ul > li { position: relative; display: inline-block; } nav ul ul { display: none; position: absolute; left: 0; top: 100%; background: #f4f6f6; width: 220px; }
nav li:hover > ul { display: block; } nav ul ul a { color: #a9b4b4; display: block; padding: 6px 10px; }
#tip2 { visibility: hidden; background: #20303a; color: #5d6f7a; padding: 6px; } #help:focus + #tip2 { visibility: visible; }`,
      `<nav aria-label="Routes"><ul><li><a href="/routes">Routes</a><ul id="sub"><li><a href="/routes/east">East quay to the island</a></li><li><a href="/routes/north">North pier loop</a></li></ul></li></ul></nav>
<p><button type="button" id="help">Ticket help</button><span id="tip2">Day tickets are valid until the last boat.</span></p>`));
    const got = failed(r);
    expect(got.map((f) => f.target), JSON.stringify(r.findings)).toEqual(['#sub > li:nth-of-type(1) > a', '#tip2']);
    expect(got[0]!.detail).toMatch(/^Text shown only when the pointer is on “Routes” has 1\.\d:1 contrast \(text #a9b4b4 on #f4f6f6\)/);
    expect(got[1]!.detail).toMatch(/^Text shown only when “Ticket help” has keyboard focus has 2\.\d:1 contrast \(text #5d6f7a on #20303a\)/);
    expect(got.every((f) => f.minor === true)).toBe(true);
  }, 60_000);

  it('look-alikes pass: a hint with enough contrast, hidden text no state rule shows, and text shown at rest', async () => {
    const r = await run(page(`${SHOW} #ok { background: #fff; color: #333; } #never { display: none; color: #cccccc; background: #fff; } .wrap:hover #rest { color: #1b1b1b; }`,
      `${HINT.replace('id="tip"', 'id="ok"').replace('aria-describedby="tip"', 'aria-describedby="ok"')}
<p id="never">Winter timetable starts in November.</p><div class="wrap"><span id="rest">Summer timetable</span></div>`));
    expect(r.findings.filter((f) => f.status !== 'no_failures_found'), JSON.stringify(r.findings)).toEqual([]);
  }, 60_000);

  // Review r1, finding 9: what the check finds and cannot measure is never clean.
  it('fails a faint hint over a gradient whose every colour is too close to it ("linear-gradient(white, white)", white to grey)', async () => {
    const flat = await run(page(`${SHOW} .hint { color: #aaaaaa; background: linear-gradient(#fff, #fff); }`, HINT));
    expect(failed(flat), JSON.stringify(flat.findings)).toEqual([expect.objectContaining({ target: '#tip', detail: expect.stringContaining('2.3:1 contrast (text #aaaaaa on #ffffff)') })]);
    const grey = await run(page(`${SHOW} .hint { color: #aaaaaa; background: linear-gradient(#fff, #555); }`, HINT));
    expect(failed(grey), JSON.stringify(grey.findings)).toEqual([expect.objectContaining({ target: '#tip', detail: expect.stringContaining('3.2:1 contrast (text #aaaaaa on a gradient, at best #555555)') })]);
  }, 90_000);

  // Review r2, finding 2: both ends of the gradient fail against white text (4.0:1), the middle passes (7.2:1).
  it('does not fail white text over a gradient from red to green whose middle it reads well on: not testable', async () => {
    const r = await run(page(`${SHOW} .hint { width: 1000px; text-align: center; color: #ffffff; border: 0; background: linear-gradient(90deg, #ff0000, #009400); }`,
      '<div class="wrap"><button type="button" aria-describedby="tip">Boarding</button><span class="hint" id="tip">OK</span></div>'));
    expect(failed(r), JSON.stringify(r.findings)).toEqual([]);
    expect(r.findings, JSON.stringify(r.findings)).toEqual([expect.objectContaining({ criterion: '1.4.3', status: 'not_testable', detail: expect.stringContaining('Text contrast was not fully measured: text shown only on hover or focus where it sits on a gradient') })]);
  }, 60_000);

  it('is not testable, never clean, for a hint it cannot measure: over a picture, over a gradient it passes on in part, or floating with no backdrop', async () => {
    const PIC = "url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2220%22 height=%2220%22%3E%3Crect width=%2220%22 height=%2220%22 fill=%22%23ddd%22/%3E%3C/svg%3E')";
    for (const [name, css, why] of [
      ['picture', `.hint { color: #aaaaaa; background: #fff ${PIC}; }`, 'it sits on a picture'],
      ['mixed gradient', '.hint { color: #aaaaaa; background: linear-gradient(#fff, #000); }', 'it sits on a gradient'],
      ['floating', '.hint { color: #aaaaaa; }', 'it floats over the page with no background of its own'],
    ] as const) {
      const r = await run(page(`${SHOW} ${css}`, HINT));
      expect(failed(r), `${name}: ${JSON.stringify(r.findings)}`).toEqual([]);
      expect(r.findings, `${name}: ${JSON.stringify(r.findings)}`).toEqual([expect.objectContaining({ criterion: '1.4.3', status: 'not_testable', detail: expect.stringContaining(`Text contrast was not fully measured: text shown only on hover or focus where ${why}`) })]);
    }
  }, 120_000);
});
