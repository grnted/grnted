// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.3.4 Orientation in real Chromium: a message to turn the device that stands in for part of a page.
// F100 (showing a message asking to reorient the device): the content behind it is only there in the other
// orientation, however small the message is on screen. The test used to count such a message only when it covered
// half the screen or the whole page's text was gone.
// WCAG lets content require an orientation that is essential ("a bank check, a piano application, slides for a
// projector or television, or virtual reality content"), so the swap fails only with evidence that the content
// does not need it: it is general page content (running text, a form, most of the page), or the same content is
// shown in the blocked orientation on a larger screen. Without that evidence the page is not testable (review r1,
// finding 6), never failed.
// Look-alikes that must keep passing: a hint that leaves the content where it is, also on a page whose menu
// collapses in portrait.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orientationProbe } from '../../src/probes/orientation.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const page = (css: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Swimming pool</title>
<style>body { font: 16px/1.5 sans-serif; margin: 0; padding: 16px; } .card { border: 1px solid #555; padding: 16px; margin: 16px 0; } .wall { display: none; background: #fff3cd; padding: 16px; } nav.wide a { margin-right: 12px; } ${css}</style></head>
<body><header><strong>Elm Park Pool</strong><nav class="wide" aria-label="Sections"><a href="/a">Lessons and courses</a><a href="/b">Opening hours</a><a href="/c">Prices and passes</a><a href="/d">Getting here</a></nav></header>
<main><h1>Swimming pool</h1><p>The pool is open every day. Lane swimming is in the main pool, and the small pool is kept warm for lessons.</p>${body}
<p>Lockers take a one-pound coin. Children under eight swim with an adult.</p></main></body></html>`;
const TIMES = '<p>Early lanes run from six to eight on weekdays. Family sessions are on Saturday and Sunday afternoons, and the quiet session is on Tuesday evening at seven.</p>';

async function run(html: string): Promise<ProbeRun> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0 }], [orientationProbe], { userAgent: 'grnted-test', full: true });
    return r!;
  } finally {
    await sim.close();
  }
}

describe('orientation (1.3.4): a rotate message in place of part of the page', () => {
  it('fails a section whose running text is swapped for a message to turn the phone in portrait (F100)', async () => {
    const r = await run(page('@media (orientation: portrait) { .turn .content { display: none; } .turn .wall { display: block; } }',
      `<section class="card turn" id="times"><h2>Session times</h2><div class="wall">Turn your phone sideways to see the session times.</div><div class="content">${TIMES}</div></section>`));
    expect(r.findings, JSON.stringify(r.findings)).toEqual([expect.objectContaining({
      status: 'failed', target: expect.stringContaining('#times'),
      detail: expect.stringMatching(/On a phone in portrait .* it shows “Turn your phone sideways to see the session times\.” in place of content shown in landscape \(\d+ characters\), so the content only works in landscape/),
    })]);
  }, 60_000);

  it('fails the same swap the other way round (a section that asks for portrait)', async () => {
    const r = await run(page('@media (orientation: landscape) { .turn .content { display: none; } .turn .wall { display: block; } }',
      `<section class="card turn" id="times"><h2>Session times</h2><div class="wall">Please use portrait to read the session times.</div><div class="content">${TIMES}</div></section>`));
    expect(r.findings, JSON.stringify(r.findings)).toEqual([expect.objectContaining({ status: 'failed', detail: expect.stringMatching(/On a phone in landscape .* in place of content shown in portrait/) })]);
  }, 60_000);

  it('look-alike: a hint to rotate that leaves the content where it is passes', async () => {
    const r = await run(page('@media (orientation: portrait) { .turn .wall { display: block; } }',
      `<section class="card turn" id="times"><h2>Session times</h2><div class="wall">Turn your phone sideways for a wider view of the session times.</div><div class="content">${TIMES}</div></section>`));
    expect(r.findings, JSON.stringify(r.findings)).toEqual([]);
  }, 60_000);

  it('look-alike: the same hint on a page whose menu collapses in portrait (its links are hidden there, behind a menu button) passes', async () => {
    const r = await run(page('@media (orientation: portrait) { .turn .wall { display: block; } nav.wide { display: none; } }',
      `<section class="card turn" id="times"><h2>Session times</h2><div class="wall">Turn your phone sideways for a wider view of the session times.</div><div class="content">${TIMES}</div></section>`));
    expect(r.findings, JSON.stringify(r.findings)).toEqual([]);
  }, 60_000);

  // Review r1, finding 6: the orientation may be essential.
  const CHECK = `<div class="check" id="check"><span style="left:16px;top:12px">Elm Park Leisure Trust</span><span style="right:16px;top:12px">No. 004471</span>
<span style="left:16px;top:64px">Pay to the order of the bearer named on the membership card</span><span style="right:16px;top:64px">$ 120.00</span>
<span style="left:16px;top:112px">One hundred twenty dollars and no cents</span><span style="left:16px;bottom:12px">Memo: annual pass</span></div>`;
  const CHECK_CSS = '.check { position: relative; width: 560px; height: 220px; border: 2px solid #334; background: #f4f7fb; } .check span { position: absolute; font: 14px/1.2 monospace; }';

  it('does not fail a check laid out for landscape behind a message to turn the phone: the orientation may be essential, so it is not testable', async () => {
    const r = await run(page(`${CHECK_CSS} @media (orientation: portrait) { .turn .check { display: none; } .turn .wall { display: block; } }`,
      `<section class="card turn" id="deposit"><h2>Check to bring</h2><div class="wall">Turn your phone sideways to see the sample check.</div>${CHECK}</section>`));
    expect(r.findings, JSON.stringify(r.findings)).toEqual([expect.objectContaining({
      criterion: '1.3.4', status: 'not_testable',
      detail: expect.stringMatching(/^On a phone in portrait \(390×844 px\), the page shows “Turn your phone sideways to see the sample check\.” in place of content shown in landscape \(\d+ characters\); whether that content needs landscape could not be told/),
    })]);
  }, 60_000);

  // Review r2, finding 5: how much of the page's text a part holds never makes it general content.
  const BIG_CHECK = `<div class="check tall" id="check"><span style="left:16px;top:12px">Elm Park Leisure Trust, 14 Mill Lane, Elm Park</span><span style="right:16px;top:12px">No. 004471</span>
<span style="left:16px;top:52px">Pay to the order of the bearer named on the membership card, in full</span><span style="right:16px;top:84px">$ 120.00</span>
<span style="left:16px;top:116px">One hundred twenty dollars and no cents, for the annual family pass</span>
<span style="left:16px;top:148px">Memo: annual pass, valid from the first of January to the last of December</span>
<span style="left:16px;top:180px">Signed for the trust by the duty manager at the front desk</span><span style="left:16px;bottom:12px">Routing 000111222 · Account 000333444 · Check 004471</span></div>`;

  it('does not fail a landscape-only check that holds more than half of a short page’s text: not testable', async () => {
    const r = await run(page(`${CHECK_CSS} .check.tall { width: 640px; height: 260px; } @media (orientation: portrait) { .turn .check { display: none; } .turn .wall { display: block; } }`,
      `<section class="card turn" id="deposit"><h2>Check to bring</h2><div class="wall">Turn your phone sideways to see the sample check.</div>${BIG_CHECK}</section>`));
    expect(r.findings, JSON.stringify(r.findings)).toEqual([expect.objectContaining({
      criterion: '1.3.4', status: 'not_testable', detail: expect.stringMatching(/in place of content shown in landscape \(\d+ characters\); whether that content needs landscape could not be told/),
    })]);
  }, 60_000);

  it('does not fail a page that is one check behind a message over the whole screen: nothing general is hidden, so it is not testable', async () => {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sample check</title>
<style>body { font: 16px/1.5 sans-serif; margin: 0; padding: 16px; } ${CHECK_CSS} .check.tall { width: 640px; height: 260px; } #wall { display: none; }
@media (orientation: portrait) { main { display: none; } #wall { display: flex; position: fixed; inset: 0; align-items: center; justify-content: center; padding: 24px; background: #fff; } }</style></head>
<body><div id="wall">Turn your phone sideways to see the sample check.</div><main><h1>Sample check</h1>${BIG_CHECK}</main></body></html>`;
    const r = await run(html);
    expect(r.findings, JSON.stringify(r.findings)).toEqual([expect.objectContaining({
      criterion: '1.3.4', status: 'not_testable', target: '#wall', detail: expect.stringMatching(/over 100% of the screen; whether that content needs landscape could not be told/),
    })]);
  }, 60_000);

  it('look-alike: a page of running text hidden behind the same message over the whole screen still fails', async () => {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pool rules</title>
<style>body { font: 16px/1.5 sans-serif; margin: 0; padding: 16px; } #wall { display: none; }
@media (orientation: portrait) { main { display: none; } #wall { display: flex; position: fixed; inset: 0; align-items: center; justify-content: center; padding: 24px; background: #fff; } }</style></head>
<body><div id="wall">Turn your phone sideways to read the pool rules.</div><main><h1>Pool rules</h1>${TIMES}<p>Lockers take a one-pound coin. Children under eight swim with an adult, and armbands are lent at the desk.</p></main></body></html>`;
    const r = await run(html);
    expect(r.findings, JSON.stringify(r.findings)).toEqual([expect.objectContaining({ criterion: '1.3.4', status: 'failed', detail: expect.stringContaining('so the content only works in landscape') })]);
  }, 60_000);

  it('fails the same check when it is shown in portrait on a larger screen: it does not need landscape', async () => {
    const r = await run(page(`${CHECK_CSS} @media (orientation: portrait) and (max-width: 600px) { .turn .check { display: none; } .turn .wall { display: block; } }`,
      `<section class="card turn" id="deposit"><h2>Check to bring</h2><div class="wall">Turn your phone sideways to see the sample check.</div>${CHECK}</section>`));
    expect(r.findings, JSON.stringify(r.findings)).toEqual([expect.objectContaining({ status: 'failed', detail: expect.stringContaining('the same content is shown in portrait on a larger screen') })]);
  }, 60_000);

  it('fails a form swapped for the message (general page content)', async () => {
    const form = '<form class="content" action="/book"><p><label for="who">Name</label> <input id="who" name="who"></p><p><label for="when">Day</label> <input id="when" name="when"></p><p><button type="submit">Book a lane</button></p></form>';
    const r = await run(page('@media (orientation: portrait) { .turn .content { display: none; } .turn .wall { display: block; } }',
      `<section class="card turn" id="book"><h2>Book a lane for the family session this weekend, or for a quiet session in the week</h2><div class="wall">Turn your phone sideways to book.</div>${form}</section>`));
    expect(r.findings.filter((f) => f.status === 'failed'), JSON.stringify(r.findings)).toEqual([expect.objectContaining({ target: expect.stringContaining('#book') })]);
  }, 60_000);
});
