// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Text shown as a section heading that is not marked up as one (WCAG 1.3.1, failure F2: "using changes in
// text presentation to convey information without using the appropriate markup or text"), in real Chromium.
// A failure only where the page itself proves the text is a heading: it is set on its own line, larger than
// the body copy (and bold, or much larger), it introduces the content after it, and either the page's own
// class or id calls it a heading or title, or it is set exactly like the page's real headings, or the
// boxes beside its box begin with a real heading. Bold text alone stays a recommendation. Every page here
// is written for this test.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HEADINGS_LIMITS, headingFindings, readHeadings, type HeadingsRead } from '../../src/probes/headings.js';
import { installNamesSomething, NAMES_SOMETHING_KEY } from '../../src/probes/namesSomething.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

const LIMITS = { elements: HEADINGS_LIMITS.elements, headings: HEADINGS_LIMITS.headings, frames: HEADINGS_LIMITS.frames, styled: HEADINGS_LIMITS.styled, namesKey: NAMES_SOMETHING_KEY };
const CSS = `
  body { font: 16px/1.5 Arial, sans-serif; color: #222; }
  h1 { font-size: 2rem; } h2 { font-size: 1.5rem; font-weight: 700; color: #123; }
  .box-title { font-size: 1.25rem; font-weight: 700; margin: 0; }
  .big-title { font: 1.75rem Georgia, serif; margin: 1.5rem 0 .5rem; }
  .like-h2 { font-size: 1.5rem; font-weight: 700; color: #123; }
  .strongline { font-weight: 700; }
  .subtitle { font-size: 1.25rem; font-weight: 700; }
  .lead-in { font-size: 1.3rem; font-weight: 700; }
`;
const BODY = 'Crews will work on the east side of the street first, then move to the west side once the new pipe has been tested and the road surface is repaired.';

async function readOn(body: string): Promise<HeadingsRead> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><title>T</title><style>${CSS}</style></head><body><main><h1>Water main work</h1><p>${BODY}</p>${body}</main></body></html>`);
    await page.evaluate(installNamesSomething, NAMES_SOMETHING_KEY);
    return await page.evaluate(readHeadings, LIMITS);
  } finally {
    await page.close();
  }
}
const failed = async (body: string) => headingFindings(await readOn(body)).filter((f) => f.status === 'failed').map((f) => [f.criterion, f.target]);

const undecided = async (body: string) => headingFindings(await readOn(body)).filter((f) => f.status === 'not_testable').map((f) => [f.criterion, f.target]);

describe('1.3.1 F2: text shown as a section heading with no heading markup', () => {
  it('fails text set exactly like the page\'s real headings that heads a section of content, whatever its class', async () => {
    const f = headingFindings(await readOn(`<h2>Schedule</h2><p>${BODY}</p><p id="t" class="like-h2">Parking during the work</p><p>${BODY}</p>`)).filter((x) => x.status === 'failed');
    expect(f.map((x) => [x.criterion, x.target])).toEqual([['1.3.1', '#t']]);
    expect(f[0]!.detail).toMatch(/^“Parking during the work” is shown as a section heading .* but is not marked up as a heading/);
    // Over a list of links too.
    expect(await failed(`<h2>Schedule</h2><p>${BODY}</p><div id="t" class="like-h2">In this section</div><ul><li><a href="/a">Service alerts</a></li><li><a href="/b">Rates and charges</a></li></ul>`)).toEqual([['1.3.1', '#t']]);
  });

  it('a word set like a heading that runs into its sentence is a lead-in, not a heading: only a line set like a heading from end to end is a twin', async () => {
    // "Notice" is set like the page's h2 and the rest of its line is body text: the line is a paragraph.
    const leadIn = `<h2>Schedule</h2><p>${BODY}</p><p id="t"><span class="like-h2">Notice</span> offices close at noon on Friday</p><p>${BODY}</p>`;
    expect(await failed(leadIn)).toEqual([]);
    // The same with the styled word last, and with a smaller note after a heading-sized start.
    expect(await failed(`<h2>Schedule</h2><p>${BODY}</p><p id="t">Offices close at noon on <span class="like-h2">Friday</span></p><p>${BODY}</p>`)).toEqual([]);
    expect(await failed(`<h2>Schedule</h2><p>${BODY}</p><div id="t" class="like-h2">Parking <small style="font-size:.8rem;font-weight:400">updated on Friday at noon</small></div><p>${BODY}</p>`)).toEqual([]);
    // Look-alike that still fails: the whole line is set like the h2, also when it is split over two spans.
    expect(await failed(`<h2>Schedule</h2><p>${BODY}</p><p id="t"><span class="like-h2">Parking</span> <span class="like-h2">during the work</span></p><p>${BODY}</p>`)).toEqual([['1.3.1', '#t']]);
  });

  it('a class that calls it a heading or a title, or its place in a box beside boxes that begin with a real heading, is no proof: undecided, never failed', async () => {
    // Named, larger than the text it introduces, not set like a real heading.
    for (const body of [
      `<h2>Schedule</h2><p>${BODY}</p><div id="t" class="big-title visual-heading">Parking during the work</div><p>${BODY}</p>`,
      `<div id="t" class="big-title sectionTitle">Parking during the work</div><p>${BODY}</p>`,
      `<p id="t"><span class="big-title section-heading">Parking during the work</span></p><p>${BODY}</p>`,
      // A widget title beside a box that starts with a real heading.
      `<aside><section><p id="t" class="box-title">In this section</p><ul><li><a href="/a">Service alerts</a></li><li><a href="/b">Rates and charges</a></li><li><a href="/c">Board meetings</a></li></ul></section><section><h2>Contact us</h2><p>${BODY}</p></section></aside>`,
    ]) {
      expect(await failed(body), body).toEqual([]);
      expect(await undecided(body), body).toEqual([['1.3.1', '#t']]);
    }
  });

  it('text that names something else is never an unmarked heading: a group\'s, a region\'s or a widget\'s label', async () => {
    for (const body of [
      // The label of a group, tied with aria-labelledby (set like a real heading, and named "title").
      `<h2>Schedule</h2><p>${BODY}</p><div role="group" aria-labelledby="t"><p id="t" class="title like-h2">Contact preferences</p><p>Choose the channels through which the department may contact you.</p></div>`,
      // The same with no real heading styled like it.
      `<div role="group" aria-labelledby="t"><p id="t" class="title" style="font-size:24px;font-weight:700">Contact preferences</p><p>Choose the channels through which the department may contact you.</p></div>`,
      // A description of something (aria-describedby), the label of a region by aria-label, and the first line of a group with no name.
      `<h2>Schedule</h2><p>${BODY}</p><p id="t" class="like-h2">Parking during the work</p><p>${BODY}</p><button type="button" aria-describedby="t">Read the notice</button>`,
      `<h2>Schedule</h2><p>${BODY}</p><section aria-label="Parking during the work"><div class="like-h2">Parking during the work</div><p>${BODY}</p></section>`,
      `<h2>Schedule</h2><p>${BODY}</p><div role="region"><div class="like-h2">Parking during the work</div><p>${BODY}</p></div>`,
      `<h2>Schedule</h2><p>${BODY}</p><fieldset><div class="like-h2">How should we reach you</div><p>${BODY}</p></fieldset>`,
      `<h2>Schedule</h2><p>${BODY}</p><figure><div class="like-h2">Detour map for March</div><p>${BODY}</p></figure>`,
    ]) {
      expect((await headingFindings(await readOn(body))).filter((f) => f.status !== 'no_failures_found'), body).toEqual([]);
    }
  });
});

describe('1.3.1 F2: what stays a recommendation or clean', () => {
  it('a real heading, and a styled line with role="heading", are headings', async () => {
    expect(await failed(`<h2 class="box-title">Parking during the work</h2><p>${BODY}</p><div class="big-title section-title" role="heading" aria-level="2">Detours</div><p>${BODY}</p>`)).toEqual([]);
  });

  it('bold text of the body\'s own size is not proof of a heading (a recommendation at most)', async () => {
    const f = headingFindings(await readOn(`<p class="strongline section-title">Parking during the work</p><p>${BODY}</p><p class="strongline section-title">Detours</p><p>${BODY}</p>`));
    expect(f.filter((x) => x.status === 'failed')).toEqual([]);
  });

  it('a larger bold line with nothing that says it is a heading (no naming class, not set like a heading, no parallel boxes)', async () => {
    expect(await failed(`<p class="lead-in">Please read before you travel</p><p>${BODY}</p>`)).toEqual([]);
  });

  it('a subtitle under a real heading, and a line above one, are not section headings', async () => {
    expect(await failed(`<h2>Schedule</h2><p class="subtitle page-subtitle">Updated every Friday afternoon</p><p>${BODY}</p>`)).toEqual([]);
    expect(await failed(`<p class="box-title overline-title">This week</p><h2>Schedule</h2><p>${BODY}</p>`)).toEqual([]);
  });

  it('a sentence, a label, a figure, a link and a button are not headings', async () => {
    expect(await failed(`
      <p class="box-title notice-title">The office will be closed on Friday for the holiday.</p><p>${BODY}</p>
      <p class="box-title field-title">Hours:</p><p>${BODY}</p>
      <div class="big-title stat-title">1,240</div><p>${BODY}</p>
      <p class="box-title link-title"><a href="/more">Parking during the work</a></p><p>${BODY}</p>
      <div class="box-title"><button class="box-title">Show the parking map</button></div><p>${BODY}</p>`)).toEqual([]);
  });

  it('a title with nothing after it, above a table, in a table cell, in a list item, in the header, footer or navigation', async () => {
    expect(await failed(`
      <div class="box-title table-title">Parking zones</div>
      <table><tr><td><div class="box-title cell-title">Zone A</div><p>${BODY}</p></td></tr></table>
      <ul><li><div class="box-title item-title">First step</div><p>${BODY}</p></li></ul>
      <header><div class="box-title site-title">City of Example</div><p>${BODY}</p></header>
      <footer><div class="box-title footer-title">Contact</div><p>${BODY}</p></footer>
      <nav><div class="box-title nav-title">Sections</div><ul><li><a href="/a">One</a></li><li><a href="/b">Two</a></li></ul></nav>
      <div class="box-title card-title">Parking during the work</div>`)).toEqual([]);
  });

  it('a hidden title, and one for screen readers only, are not shown as headings', async () => {
    expect(await failed(`<div class="box-title section-title" style="display:none">Parking during the work</div><p>${BODY}</p>
      <div class="box-title section-title" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Detours</div><p>${BODY}</p>`)).toEqual([]);
  });

  it('a job title, a price and a date line named "title" are not section headings', async () => {
    expect(await failed(`
      <div class="box-title job-title">Director of Public Works</div><p>${BODY}</p>
      <div class="box-title price-title">$45 per month</div><p>${BODY}</p>
      <div class="box-title date-title">November 12, 2026</div><p>${BODY}</p>`)).toEqual([]);
  });
});
