// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 17 (structure lane): text shown as a section heading with no heading markup (WCAG 1.3.1, F2), decided
// where the page, or the site, itself proves it. Four proofs, each with the look-alikes that must stay undecided
// or clean. Every page here is written for this test (no red-team, ACT or real-site page is copied).
// - twin by rendering: set exactly like a real heading as the browser DRAWS it (weight 500 of a family with no
//   medium face is its regular face), proved by the ink a sample line leaves, in web fonts that have arrived;
// - peer: the markup names it a heading, it is the first line of a box beside boxes that begin with a real heading,
//   and it is set at least as large and as heavy as that heading in the same typeface;
// - repeated: the markup names it a heading, and two or more lines of one make each head a part of one block;
// - site twin: another scanned page marks up the same line, set the same way, as a real heading.
import { readFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fontsSettled, HEADINGS_LIMITS, headingFindings, headingsAcrossPages, headingsData, headingsProbe, readHeadings, shownVerdict, siteTwinFindings, type HeadingsData, type HeadingsRead } from '../../src/probes/headings.js';
import { installNamesSomething, NAMES_SOMETHING_KEY } from '../../src/probes/namesSomething.js';
import { runProbes, withAcrossPages } from '../../src/probes/runner.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike, ProbeFinding, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

const LIMITS = { elements: HEADINGS_LIMITS.elements, headings: HEADINGS_LIMITS.headings, frames: HEADINGS_LIMITS.frames, styled: HEADINGS_LIMITS.styled, namesKey: NAMES_SOMETHING_KEY };
const CSS = `
  body { margin: 0; font: 16px/1.5 Arial, sans-serif; color: #222; }
  h1 { font-size: 2rem; } h2 { font-size: 1.5rem; font-weight: 700; }
  .cols { display: grid; grid-template-columns: 1fr 280px; gap: 24px; padding: 0 24px; }
  .rail section { border: 1px solid #999; margin: 0 0 16px; }
  .rail h2 { font-size: 1.05rem; margin: 0; padding: 8px; }
  .widgetHeading { font-size: 1.22rem; font-weight: 700; margin: 0; padding: 8px; background: #145; color: #fff; }
  .widgetHeading.serif { font-family: Georgia, 'DejaVu Serif', serif; }
  .rail-top { font-size: 1.22rem; font-weight: 700; margin: 0; padding: 8px; }
  .visual-heading { font-size: 1.6rem; font-weight: 700; margin: 28px 0 14px; }
  .visual-heading.other { font-size: 1.9rem; }
  .visual-heading[data-q]::before { content: open-quote; } .visual-heading[data-q]::after { content: close-quote; }
  .big { font-size: 1.6rem; font-weight: 700; margin: 28px 0 14px; }
  .serif h2 { font: 500 1.7rem Georgia, 'DejaVu Serif', serif; }
  .serif .plain-title { font: 400 1.7rem Georgia, 'DejaVu Serif', serif; margin: 0 0 12px; }
  .serif .bold-title { font: 700 1.7rem Georgia, 'DejaVu Serif', serif; margin: 0 0 12px; }
  .serif .sans-title { font: 400 1.7rem Arial, sans-serif; margin: 0 0 12px; }
  .semi h2 { font: 600 1.4rem Arial, sans-serif; }
  .semi .bold-title { font: 700 1.4rem Arial, sans-serif; margin: 0 0 12px; }
`;
/**
 * Web fonts every machine draws alike (the engine's own, OFL): TwoFaces has a regular and a bold face and
 * nothing between or above them; ThreeFaces has a regular, a medium and a bold face of one width (monospaced).
 */
const face = (file: string) => `url(data:font/woff2;base64,${readFileSync(new URL(`../../assets/fonts/${file}`, import.meta.url)).toString('base64')}) format("woff2")`;
const FACES = `
  @font-face { font-family: TwoFaces; src: ${face('ibm-plex-mono-400-latin.woff2')}; font-weight: 400; }
  @font-face { font-family: TwoFaces; src: ${face('ibm-plex-mono-600-latin.woff2')}; font-weight: 700; }
  @font-face { font-family: ThreeFaces; src: ${face('ibm-plex-mono-400-latin.woff2')}; font-weight: 400; }
  @font-face { font-family: ThreeFaces; src: ${face('ibm-plex-mono-500-latin.woff2')}; font-weight: 500; }
  @font-face { font-family: ThreeFaces; src: ${face('ibm-plex-mono-600-latin.woff2')}; font-weight: 700; }
  @font-face { font-family: LocalFaces; src: local("No Such Font On This Device"), ${face('ibm-plex-mono-400-latin.woff2')}; font-weight: 400; }
  @font-face { font-family: LocalFaces; src: local("No Such Bold Font On This Device"), ${face('ibm-plex-mono-600-latin.woff2')}; font-weight: 700; }
`;
const BODY = 'Crews will work on the east side of the street first, then move to the west side once the new pipe has been tested and the road surface is repaired.';
const LINKS = '<ul><li><a href="/alerts">Service alerts</a></li><li><a href="/rates">Rates and charges</a></li><li><a href="/board">Board meetings</a></li></ul>';

async function readOn(body: string, title = 'T'): Promise<HeadingsRead> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><title>${title}</title><style>${CSS}${body.includes('Faces') ? FACES : ''}</style></head><body>${body}</body></html>`);
    await page.evaluate(fontsSettled, 5000);
    await page.evaluate(installNamesSomething, NAMES_SOMETHING_KEY);
    return await page.evaluate(readHeadings, LIMITS);
  } finally {
    await page.close();
  }
}
const of = (read: HeadingsRead, status: ProbeFinding['status']) => headingFindings(read).filter((f) => f.criterion === '1.3.1' && f.status === status && !f.advice);
const failed = async (body: string) => of(await readOn(body), 'failed').map((f) => f.target);
const undecided = async (body: string) => of(await readOn(body), 'not_testable').map((f) => f.target);

/** A two-column page whose side rail holds a links widget and a contact card. */
const rail = (widget: string, card = `<section class="card"><h2>We are here to help</h2><p>Call the office on weekdays between 8 and 5.</p></section>`) =>
  `<div class="cols"><main><h1>Water main work</h1><p>${BODY}</p></main><aside class="rail">${widget}${card}</aside></div>`;

describe('1.3.1 F2, peer proof: a named box title set at least as large as the real heading of the box beside it', () => {
  it('fails the first line of a box that the markup calls a heading, set larger than the real heading the next box begins with', async () => {
    const read = await readOn(rail(`<section class="widget"><p id="t" class="widgetHeading">In This Section</p>${LINKS}</section>`));
    const f = of(read, 'failed');
    expect(f.map((x) => x.target)).toEqual(['#t']);
    // The finding names the element's own proof: the real heading beside it, its size and what the markup calls it.
    expect(f[0]!.detail).toMatch(/^“In This Section” is shown as a section heading \(the first line of its box, in 19\.5 px, set at least as large as “We are here to help”, the real heading the box beside it begins with; the page's own markup calls it a “heading”\) but is not marked up as a heading/);
    expect(of(read, 'not_testable')).toEqual([]);
    expect(read.shown?.map(shownVerdict)).toEqual(['peer']);
  });

  it('look-alikes that stay undecided: smaller than the real heading beside it, another typeface, no naming class, no heading in the box beside it', async () => {
    for (const [why, body] of [
      ['smaller than the neighbour\'s heading', rail(`<section class="widget"><p id="t" class="widgetHeading">In This Section</p>${LINKS}</section>`, '<section class="card"><h2 style="font-size:1.5rem">We are here to help</h2><p>Call the office on weekdays between 8 and 5.</p></section>')],
      ['set in another typeface than the neighbour\'s heading', rail(`<section class="widget"><p id="t" class="widgetHeading serif">In This Section</p>${LINKS}</section>`)],
      ['the box beside it begins with plain text', rail(`<section class="widget"><p id="t" class="widgetHeading">In This Section</p>${LINKS}</section>`, '<section class="card"><p>Call the office on weekdays between 8 and 5.</p></section>')],
    ] as const) {
      expect(await failed(body), why).toEqual([]);
      expect(await undecided(body), why).toEqual(['#t']);
    }
    // Not named: its place and its size alone are a candidate (undecided), never a failure.
    const unnamed = rail(`<section class="widget"><p id="t" class="rail-top">In This Section</p>${LINKS}</section>`);
    expect(await failed(unnamed)).toEqual([]);
    expect(await undecided(unnamed)).toEqual(['#t']);
  });

  it('look-alike: a class that says "header" (a bar, a banner, the top of a card) is no naming word for a proof: undecided', async () => {
    for (const body of [
      rail(`<section class="widget"><p id="t" class="widget-header" style="font-size:1.22rem;font-weight:700;margin:0">In This Section</p>${LINKS}</section>`),
      `<main><h1>Service alerts</h1><p>${BODY}</p><section><div id="t" class="msg-hdr" style="font-size:1.6rem;font-weight:700">School-day stop changes</div><p>${BODY}</p><div class="msg-hdr" style="font-size:1.6rem;font-weight:700">Emergency reroutes</div><p>${BODY}</p></section></main>`,
    ]) {
      expect(await failed(body), body).toEqual([]);
      expect((await undecided(body))[0], body).toBe('#t');
    }
  });

  it('look-alikes that are no finding at all: a real heading, a label tied to its box, a line that runs into a sentence', async () => {
    for (const body of [
      rail(`<section class="widget"><h2 id="t" class="widgetHeading">In This Section</h2>${LINKS}</section>`),
      rail(`<section class="widget" aria-labelledby="t"><p id="t" class="widgetHeading">In This Section</p>${LINKS}</section>`),
      rail(`<section class="widget"><div id="t" class="widgetHeading" role="heading" aria-level="2">In This Section</div>${LINKS}</section>`),
    ]) {
      expect(await failed(body), body).toEqual([]);
      expect(await undecided(body), body).toEqual([]);
    }
    // A heading-sized word that runs into body text on its line is a lead-in: undecided at most, never failed.
    expect(await failed(rail(`<section class="widget"><p id="t"><span class="widgetHeading" style="display:inline;padding:0;background:none;color:inherit">Notice</span> offices close at noon</p>${LINKS}</section>`))).toEqual([]);
  });
});

describe('1.3.1 F2, repeated proof: named lines of one make that divide a block into titled parts', () => {
  const two = (a: string, b: string) => `<main><h1>Service alerts</h1><p>${BODY}</p><section id="s">${a}<p>${BODY}</p>${b}<p>${BODY}</p></section></main>`;

  it('fails each of two named lines of one make that head the parts of one block', async () => {
    const read = await readOn(two('<div id="a" class="visual-heading">School-day stop changes</div>', '<div id="b" class="visual-heading">Emergency reroutes</div>'));
    const f = of(read, 'failed');
    expect(f.map((x) => x.target)).toEqual(['#a', '#b']);
    expect(f[0]!.detail).toMatch(/^“School-day stop changes” is shown as a section heading \(one of 2 lines of one make, each on its own line at the head of the text it introduces, in 25\.6 px; the page's own markup calls them a “heading”\) but is not marked up as a heading/);
    expect(of(read, 'not_testable')).toEqual([]);
  });

  it('look-alikes: one named line alone, two of different makes, two in different blocks stay undecided; two unnamed lines are no finding', async () => {
    const one = `<main><h1>Service alerts</h1><p>${BODY}</p><section><div id="a" class="visual-heading">School-day stop changes</div><p>${BODY}</p></section></main>`;
    expect(await failed(one)).toEqual([]);
    expect(await undecided(one)).toEqual(['#a']);
    const makes = two('<div id="a" class="visual-heading">School-day stop changes</div>', '<div id="b" class="visual-heading other">Emergency reroutes</div>');
    expect(await failed(makes)).toEqual([]);
    expect(await undecided(makes)).toEqual(['#a', '#b']);
    const blocks = `<main><h1>Service alerts</h1><p>${BODY}</p><section><div id="a" class="visual-heading">School-day stop changes</div><p>${BODY}</p></section><div><div id="b" class="visual-heading">Emergency reroutes</div><p>${BODY}</p></div></main>`;
    expect(await failed(blocks)).toEqual([]);
    expect(await undecided(blocks)).toEqual(['#a', '#b']);
    // Nothing on the page says these are headings (no naming class, no twin, no boxes): no finding from this page.
    const unnamed = two('<div id="a" class="big">School-day stop changes</div>', '<div id="b" class="big">Emergency reroutes</div>');
    expect(await failed(unnamed)).toEqual([]);
    expect(await undecided(unnamed)).toEqual([]);
  });

  // After the review of batch 17: a name and a place prove a heading only where nothing says the line may be
  // something else. Each of these is named and repeated (or named beside a real heading) and stays undecided.
  it('look-alikes: classes that set type ("font-heading-xl", "text-title", "has-heading-font-family", "title-large", "heading-2") name nothing', async () => {
    for (const cls of ['font-heading-xl', 'text-title', 'has-heading-font-family', 'title-large', 'heading-2', 'u-heading']) {
      const body = two(`<p id="a" class="${cls}" style="font-size:1.6rem;font-weight:700;margin:28px 0 14px">School-day stop changes</p>`, `<p id="b" class="${cls}" style="font-size:1.6rem;font-weight:700;margin:28px 0 14px">Emergency reroutes</p>`);
      expect(await failed(body), cls).toEqual([]);
      expect(await undecided(body), cls).toEqual(['#a', '#b']);
    }
    // In a box beside a real heading, the same.
    const peer = rail(`<section class="widget"><p id="t" class="font-heading-lg" style="font-size:1.22rem;font-weight:700;margin:0;padding:8px">In This Section</p>${LINKS}</section>`);
    expect(await failed(peer)).toEqual([]);
    expect(await undecided(peer)).toEqual(['#t']);
  });

  it('look-alikes: a figure that reads on into its sentence, a quotation, dates and times, a job title under a name, a bar that takes clicks, a line over text that is not shown', async () => {
    const on = 'took a bus or a train with us last year, the most since the new lines opened, and nine in ten said they would ride again.';
    const pair = (a: string, b: string, pa = BODY, pb = BODY, attrs = '') => `<main><h1>Service alerts</h1><p>${BODY}</p><section><div id="a" class="visual-heading" ${attrs}>${a}</div><p>${pa}</p><div id="b" class="visual-heading" ${attrs}>${b}</div><p>${pb}</p></section></main>`;
    for (const [why, body] of [
      ['reads on into the text after it', pair('Riders of every age', 'Trains that ran on time', on, 'were counted at the six busiest stations in the first week of each month of the year.')],
      ['begins with a figure', pair('1.2 million riders', '94% on time')],
      ['a quotation', pair('“The bus is my lifeline”', '“I sold my second car”')],
      ['a quotation by its markup (a q element)', pair('<q>The bus is my lifeline</q>', '<q>I sold my second car</q>')],
      ['a quotation by marks the style sheet adds', pair('The bus is my lifeline', 'I sold my second car', BODY, BODY, 'data-q')],
      ['a span of dates', pair('November 18–20', 'November 23–25')],
      ['a month', pair('November 2026', 'December 2026')],
      ['a weekday', pair('Monday', 'Tuesday')],
      ['a time', pair('9:00 AM', '1:30 PM')],
      ['takes clicks (a pointer cursor)', pair('Who needs a permit', 'What it costs', BODY, BODY, 'style="cursor:pointer"')],
      ['takes clicks (it says what it opens)', pair('Who needs a permit', 'What it costs', BODY, BODY, 'aria-expanded="false"')],
    ] as const) {
      expect(await failed(body), why).toEqual([]);
      expect(await undecided(body), why).toEqual(['#a', '#b']);
    }
    // A job title under a name, each set like a title: the second line is no heading of its own.
    const staff = `<main><h1>Our staff</h1><p>${BODY}</p><section><div class="big">Maria Lopez</div><div id="a" class="visual-heading">Director of Finance</div><p>${BODY}</p><div class="big">Sam Okafor</div><div id="b" class="visual-heading">Director of Operations</div><p>${BODY}</p></section></main>`;
    expect(await failed(staff)).toEqual([]);
    expect(await undecided(staff)).toEqual(['#a', '#b']);
    // The text after it is not shown (a closed panel): the line may be the bar that opens it.
    const closed = `<main><h1>Permits</h1><p>${BODY}</p><section><div id="a" class="visual-heading">Who needs a permit</div><div style="max-height:0;overflow:hidden"><p>${BODY}</p></div><div id="b" class="visual-heading">What it costs</div><div style="max-height:0;overflow:hidden"><p>${BODY}</p></div></section></main>`;
    expect(await failed(closed)).toEqual([]);
    expect(await undecided(closed)).toEqual(['#a', '#b']);
    // The reason is said with the doubt.
    expect(of(await readOn(pair('1.2 million riders', '94% on time')), 'not_testable')[0]!.detail).toContain('or a lead-in, a callout or a label (it begins with a figure): this could not be told');
  });

  it('look-alikes beside a real heading: lighter than it, smaller than the largest of several, or beside an h2 whose role says it is no heading', async () => {
    const title = (style: string) => `<section class="widget"><p id="t" class="widgetHeading" style="${style}">In This Section</p>${LINKS}</section>`;
    for (const [why, body] of [
      ['lighter than the heading beside it (300 against 500)', rail(title('font-weight:300;font-size:1.6rem;background:none;color:inherit'), '<section class="card"><h2 style="font-weight:500">We are here to help</h2><p>Call the office on weekdays between 8 and 5.</p></section>')],
      ['larger than one neighbour\'s small heading and smaller than another\'s', rail(title(''), '<section class="card"><h6 style="font-size:.8rem;margin:0">Hours</h6><p>Call the office on weekdays between 8 and 5.</p></section><section class="card"><h2 style="font-size:1.5rem">We are here to help</h2><p>Write to the office at any time of the year.</p></section>')],
      ['the heading beside it has a role that says it is none', rail(title(''), '<section class="card"><h2 role="presentation">We are here to help</h2><p>Call the office on weekdays between 8 and 5.</p></section>')],
    ] as const) {
      expect(await failed(body), why).toEqual([]);
      expect(await undecided(body), why).toEqual(['#t']);
    }
  });

  it('look-alike, through the test itself: titles the page\'s script listens for clicks on (the bars of an accordion) are undecided', async () => {
    const site = await startFixtureServer('headings-proofs');
    try {
      const runs = await runProbes(browser as unknown as BrowserLike, ['accordion.html', 'parts.html'].map((p, index) => ({ url: `${site.origin}/${p}`, index })), [headingsProbe], { userAgent: 'grnted-test' });
      const shown = (p: string, status: ProbeFinding['status']) => runs.find((r) => new URL(r.page).pathname === `/${p}`)!.findings.filter((f) => f.criterion === '1.3.1' && f.status === status && !f.advice).map((f) => f.target);
      expect(runs.map((r) => r.status)).toEqual(['ok', 'ok']);
      expect(shown('accordion.html', 'failed')).toEqual([]);
      expect(shown('accordion.html', 'not_testable')).toEqual(['#a', '#b']);
      // The same page without the script: titled parts, as before.
      expect(shown('parts.html', 'failed')).toEqual(['#a', '#b']);
    } finally {
      await site.close();
    }
  }, 120_000);

  it('look-alikes that are never headings: sentences, figures and dates of one make', async () => {
    expect(await failed(`<main><h1>Service alerts</h1><p>${BODY}</p><section>
      <div class="visual-heading">Buses stop at the temporary shelter on Alder Avenue.</div><p>${BODY}</p>
      <div class="visual-heading">Allow ten more minutes for the walk.</div><p>${BODY}</p>
      <div class="visual-heading">1,240</div><p>${BODY}</p><div class="visual-heading">3,410</div><p>${BODY}</p>
      <div class="visual-heading">November 12, 2026</div><p>${BODY}</p><div class="visual-heading">November 19, 2026</div><p>${BODY}</p></section></main>`)).toEqual([]);
  });
});

describe('1.3.1 F2, twin by rendering: set exactly like a real heading as the browser draws it', () => {
  /** A page whose level-2 heading and one plain line are set in `family` at the two weights. */
  const drawn = (h2: string, line: string, extra = '') => `<main><h1>Library services</h1><p>${BODY}</p>${extra}<div id="t" class="plain-title" style="font:${line};margin:0 0 12px">Borrow beyond books</div><p>${BODY}</p><h2 style="font:${h2}">Get started</h2><p>${BODY}</p></main>`;

  it('fails a line whose weight differs in the style sheet and not on screen: 500 against 400, and 800 against 700, of a family with a regular and a bold face only', async () => {
    const read = await readOn(drawn('400 1.7rem TwoFaces, monospace', '500 1.7rem TwoFaces, monospace'));
    const f = of(read, 'failed');
    expect(f.map((x) => x.target)).toEqual(['#t']);
    expect(f[0]!.detail).toMatch(/set exactly like the page's real headings: the same type as its level-2 heading “Get started”, 27\.2 px\) but is not marked up as a heading/);
    expect(await failed(drawn('700 1.4rem TwoFaces, monospace', '800 1.4rem TwoFaces, monospace'))).toEqual(['#t']);
  });

  it('look-alike: two faces of one width leave different ink (500 against 400 of a monospaced family that has a medium face): no twin', async () => {
    const body = drawn('400 1.7rem ThreeFaces, monospace', '500 1.7rem ThreeFaces, monospace');
    expect(await failed(body)).toEqual([]);
    // "title" in the class makes it a candidate (undecided), never a failure.
    expect(await undecided(body)).toEqual(['#t']);
  });

  it('look-alike: two different first families that are drawn with one face here (the first is not installed) are not one type', async () => {
    const body = drawn('700 1.7rem NoSuchFace, TwoFaces, monospace', '700 1.7rem TwoFaces, monospace');
    expect(await failed(body)).toEqual([]);
    expect(await undecided(body)).toEqual(['#t']);
  });

  // After the second review round: which faces a font of the reader's own device has differs from device to device
  // (a semibold beside the bold on one, none on another), and the scan's machine is one device. The picture is
  // compared only for a family the page itself serves.
  it('look-alike: a font of the device is compared by the style sheet\'s own words only: 600 against 700, or 500 against 400, is no twin whatever faces this machine has', async () => {
    for (const [h2, line] of [['700 1.4rem Arial, sans-serif', '600 1.4rem Arial, sans-serif'], ['500 1.7rem Georgia, serif', '400 1.7rem Georgia, serif'], ['700 1.4rem system-ui, sans-serif', '800 1.4rem system-ui, sans-serif']] as const) {
      const body = drawn(h2, line);
      expect(await failed(body), line).toEqual([]);
      expect(await undecided(body), line).toEqual(['#t']);
    }
    // The same weight is the same type, as before.
    expect(await failed(drawn('700 1.4rem Arial, sans-serif', '700 1.4rem Arial, sans-serif'))).toEqual(['#t']);
  });

  it('look-alike: a web font with a source on the reader\'s own device (local()) is not the same faces for every reader: no twin by the picture', async () => {
    const body = drawn('400 1.7rem LocalFaces, monospace', '500 1.7rem LocalFaces, monospace');
    expect(await failed(body)).toEqual([]);
    expect(await undecided(body)).toEqual(['#t']);
  });

  it('look-alike: where a web font of the page did not arrive, only the style sheet\'s own words are compared (500 is not 400)', async () => {
    // (The same page as the first test, with one more face that fails to load: what the canvas draws may be a stand-in.)
    const gone = '<style>@font-face { font-family: Gone; src: url("http://127.0.0.1:9/gone.woff2") format("woff2"); }</style><p style="font-family:Gone, sans-serif">Opening hours are on the door.</p>';
    const body = drawn('400 1.7rem TwoFaces, monospace', '500 1.7rem TwoFaces, monospace', gone);
    expect(await failed(body)).toEqual([]);
    expect(await undecided(body)).toEqual(['#t']);
    // The same weight is still the same type, as before.
    expect(await failed(drawn('400 1.7rem TwoFaces, monospace', '400 1.7rem TwoFaces, monospace', gone))).toEqual(['#t']);
  });

  it('look-alikes: small capitals, or a condensed width, against plain headings of the same face and size are not twins', async () => {
    for (const style of ['font-variant-caps:small-caps', 'font-stretch:condensed']) {
      const body = `<main class="semi"><h1>Library services</h1><p>${BODY}</p><div id="t" style="font:700 1.4rem Arial, sans-serif;${style};margin:0 0 12px">Borrow beyond books</div><p>${BODY}</p><h2>Get started</h2><p>${BODY}</p></main>`;
      expect(await failed(body), style).toEqual([]);
    }
  });

  // Sol review of batch 17, S6 (lead's ruling): the font settings a canvas does not draw are part of the type; text with
  // letters of another script is never a twin by the picture; and the line's OWN letters must come out the same in
  // its style and in the heading's, not only the sample's.
  it('Sol S6 look-alikes: the same face with other font settings (alternate letters, a variation axis, spacing) is no twin', async () => {
    for (const setting of ["font-feature-settings:'ss01'", "font-variation-settings:'wght' 650", 'font-variant-numeric:oldstyle-nums', 'letter-spacing:0.08em', 'font-kerning:none']) {
      const body = drawn('400 1.7rem TwoFaces, monospace', `500 1.7rem TwoFaces, monospace;${setting}`);
      expect(await failed(body), setting).toEqual([]);
      expect(await undecided(body), setting).toEqual(['#t']);
    }
    // The same settings on both: the same type, as before.
    const both = `<main><h1>Library services</h1><p>${BODY}</p><div id="t" class="plain-title" style="font:500 1.7rem TwoFaces, monospace;font-feature-settings:'ss01';margin:0 0 12px">Borrow beyond books</div><p>${BODY}</p><h2 style="font:400 1.7rem TwoFaces, monospace;font-feature-settings:'ss01'">Get started</h2><p>${BODY}</p></main>`;
    expect(await failed(both)).toEqual(['#t']);
  });

  it('Sol S6 look-alikes: a line with letters of another script, alone or mixed with Latin, is no twin by the picture', async () => {
    for (const text of ['Borrow beyond books Ελληνικά', 'Библиотека для всех', 'Borrow 图书 beyond books']) {
      const body = `<main><h1>Library services</h1><p>${BODY}</p><div id="t" class="plain-title" style="font:500 1.7rem TwoFaces, monospace;margin:0 0 12px">${text}</div><p>${BODY}</p><h2 style="font:400 1.7rem TwoFaces, monospace">Get started</h2><p>${BODY}</p></main>`;
      expect(await failed(body), text).toEqual([]);
      expect(await undecided(body), text).toEqual(['#t']);
    }
    // Latin letters with accents are Latin: a twin, as before.
    const accents = `<main><h1>Library services</h1><p>${BODY}</p><div id="t" class="plain-title" style="font:500 1.7rem TwoFaces, monospace;margin:0 0 12px">Borrow a book at the café</div><p>${BODY}</p><h2 style="font:400 1.7rem TwoFaces, monospace">Get started</h2><p>${BODY}</p></main>`;
    expect(await failed(accents)).toEqual(['#t']);
  });

  it('Sol S6 look-alike: the sample leaves the same ink but a letter of the line comes from another face (a face served for some letters only): no twin', async () => {
    // SplitFaces: weight 400 is the regular face for every letter; weight 500 is the same regular face for the letters
    // up to "è" only (unicode-range), so its "é" is drawn by the next family. The sample ("Rag 38&") is the same in both.
    const split = `<style>@font-face { font-family: SplitFaces; src: ${face('ibm-plex-mono-400-latin.woff2')}; font-weight: 400; }
      @font-face { font-family: SplitFaces; src: ${face('ibm-plex-mono-400-latin.woff2')}; font-weight: 500; unicode-range: U+0000-00E8; }</style>`;
    const page = (text: string) => `${split}<main><h1>Library services</h1><p>${BODY}</p><div id="t" class="plain-title" style="font:500 1.7rem SplitFaces, monospace;margin:0 0 12px">${text}</div><p>${BODY}</p><h2 style="font:400 1.7rem SplitFaces, monospace">Get started</h2><p>${BODY}</p></main>`;
    expect(await failed(page('Café and reading room'))).toEqual([]);
    expect(await undecided(page('Café and reading room'))).toEqual(['#t']);
    // The same page with a line whose letters both faces draw alike: a twin by the picture.
    expect(await failed(page('Cafe and reading room'))).toEqual(['#t']);
  });

  it('Sol S6, the site twin: the line\'s own letters drawn differently on the two pages (a face served for some letters only) is no proof', () => {
    const data = (o: Partial<HeadingsData>): HeadingsData => ({ title: 'T', h1: [], ...o });
    const twin = { text: 'Café hours', level: 2, sig: 'A', drawn: 'D', glyphs: 'g1' };
    const maybe = [{ text: 'Café hours', target: '#t', sig: 'B', drawn: 'D', glyphs: 'g1' }];
    expect(siteTwinFindings([run('https://s.example/a', data({ sigs: [twin] })), run('https://s.example/b', data({ maybe }))]).size).toBe(1);
    // Other ink for the line's letters, or no ink at all (another script, a letter from a stand-in): no proof by the picture.
    expect(siteTwinFindings([run('https://s.example/a', data({ sigs: [{ ...twin, glyphs: 'g2' }] })), run('https://s.example/b', data({ maybe }))]).size).toBe(0);
    expect(siteTwinFindings([run('https://s.example/a', data({ sigs: [{ ...twin, glyphs: undefined }] })), run('https://s.example/b', data({ maybe }))]).size).toBe(0);
    expect(siteTwinFindings([run('https://s.example/a', data({ sigs: [twin] })), run('https://s.example/b', data({ maybe: [{ ...maybe[0]!, glyphs: undefined }] }))]).size).toBe(0);
  });

  it('look-alikes: bold against a regular heading, and another typeface at the same size, are not twins', async () => {
    for (const cls of ['bold-title', 'sans-title']) {
      const body = `<main class="serif"><h1>Library services</h1><p>${BODY}</p><div id="t" class="${cls}">Borrow beyond books</div><p>${BODY}</p><h2>Get started</h2><p>${BODY}</p></main>`;
      expect(await failed(body), cls).toEqual([]);
      // "title" in the class makes it a candidate (undecided), never a failure.
      expect(await undecided(body), cls).toEqual(['#t']);
    }
  });
});

const run = (page: string, data: HeadingsData | undefined, findings: ProbeFinding[] = [], status: ProbeRun['status'] = 'ok'): { run: ProbeRun; index: number } =>
  ({ index: 0, run: { probe: 'headings', kind: 'render', page, criteria: ['1.3.1', '2.4.6'], status, findings, ms: 1, ...(data ? { data } : {}) } });

describe('1.3.1 F2, site twin: another scanned page marks up the same line, set the same way, as a heading', () => {
  const WIDGET = (tag: string, attrs = '') => rail(`<section class="widget"><${tag} id="t" ${attrs} style="font-size:1.22rem;font-weight:700;margin:0;padding:8px">Quick links</${tag}>${LINKS}</section>`, '<section class="card"><p>Call the office on weekdays between 8 and 5.</p></section>');

  it('fails the page that shows the line as a plain paragraph when another page has it as a real heading (read in real pages)', async () => {
    const marked = await readOn(WIDGET('h2'), 'Rates');
    const plain = await readOn(WIDGET('p'), 'Alerts');
    // Nothing on the plain page alone says the line is a heading: no finding from it.
    expect(of(plain, 'failed')).toEqual([]);
    expect(of(plain, 'not_testable')).toEqual([]);
    expect(plain.plain?.map((b) => b.text)).toEqual(['Quick links']);
    const runs = [run('https://site.example/rates', headingsData(marked)), run('https://site.example/alerts', headingsData(plain), headingFindings(plain))];
    const found = siteTwinFindings(runs);
    expect([...found.keys()]).toEqual(['https://site.example/alerts']);
    const f = found.get('https://site.example/alerts')!;
    expect(f.map((x) => [x.criterion, x.status, x.target])).toEqual([['1.3.1', 'failed', '#t']]);
    expect(f[0]!.detail).toBe('“Quick links” is shown as a section heading (on its own line, at the head of the text it introduces) but is not marked up as a heading: on another scanned page of this site the same line, set the same way, is a level-2 heading (/rates), so screen readers can list it and jump to it there and not here');
  });

  it('look-alikes: the same words set another way, other words set the same way, the page\'s own heading, a run that did not end ok', async () => {
    const data = (o: Partial<HeadingsData>): HeadingsData => ({ title: 'T', h1: [], ...o });
    const maybe = [{ text: 'Quick links', target: '#t', sig: '19.5|b1.2|none|normal' }];
    const twin = { text: 'Quick Links', level: 2, sig: '19.5|b1.2|none|normal' };
    // The proof (case and spacing aside).
    expect(siteTwinFindings([run('https://s.example/a', data({ sigs: [twin] })), run('https://s.example/b', data({ maybe }))]).size).toBe(1);
    // Set another way; other words; only this page's own heading; the other page's run failed; one page only.
    expect(siteTwinFindings([run('https://s.example/a', data({ sigs: [{ ...twin, sig: '24|b1.2|none|normal' }] })), run('https://s.example/b', data({ maybe }))]).size).toBe(0);
    expect(siteTwinFindings([run('https://s.example/a', data({ sigs: [{ ...twin, text: 'Quick facts' }] })), run('https://s.example/b', data({ maybe }))]).size).toBe(0);
    expect(siteTwinFindings([run('https://s.example/a', data({})), run('https://s.example/b', data({ maybe, sigs: [twin] }))]).size).toBe(0);
    expect(siteTwinFindings([run('https://s.example/a', data({ sigs: [twin] }), [], 'error'), run('https://s.example/b', data({ maybe }))]).size).toBe(0);
    expect(siteTwinFindings([run('https://s.example/b', data({ maybe }))]).size).toBe(0);
  });

  it('settles the page\'s own undecided finding: the site\'s failure takes its place (and the template-heading rule still runs)', () => {
    const undecidedHere: ProbeFinding = { criterion: '1.3.1', status: 'not_testable', target: '#t', detail: '“Quick links” may be a section heading that is not marked up as one' };
    const other: ProbeFinding = { criterion: '1.3.1', status: 'not_testable', target: '#u', detail: '“Hours” may be a section heading that is not marked up as one' };
    const probe: PageProbe = { id: 'headings', criteria: ['1.3.1', '2.4.6'], kind: 'render', tier: 'core', timeoutMs: 1000, run: async () => [], acrossPages: headingsAcrossPages, acrossSettles: ['1.3.1'] };
    const a = run('https://s.example/a', { title: 'A', h1: [], sigs: [{ text: 'Quick links', level: 3, sig: 'S' }] });
    const b = run('https://s.example/b', { title: 'B', h1: [], maybe: [{ text: 'Quick links', target: '#t', sig: 'S' }] }, [undecidedHere, other]);
    const out = withAcrossPages([probe], [a, b]);
    expect(out[0]!.findings).toEqual([]);
    expect(out[1]!.findings.map((f) => [f.status, f.target])).toEqual([['not_testable', '#u'], ['failed', '#t']]);
    expect(out[1]!.findings[1]!.detail).toMatch(/is a level-3 heading \(\/a\)/);
  });

  it('look-alike (lead\'s condition): styled text that is NOT a heading on the site\'s other pages stays undecided or clean', () => {
    const probe: PageProbe = { id: 'headings', criteria: ['1.3.1', '2.4.6'], kind: 'render', tier: 'core', timeoutMs: 1000, run: async () => [], acrossPages: headingsAcrossPages, acrossSettles: ['1.3.1'] };
    const undecidedHere: ProbeFinding = { criterion: '1.3.1', status: 'not_testable', target: '#t', detail: '“Quick links” may be a section heading that is not marked up as one' };
    // The other pages show the same line the same way and none marks it up as a heading: the page stays undecided.
    const others = ['a', 'c', 'd'].map((x) => run(`https://s.example/${x}`, { title: x, h1: [], sigs: [{ text: 'Contact the office', level: 2, sig: 'S' }], maybe: [{ text: 'Quick links', target: '#t', sig: 'S' }] }, [undecidedHere]));
    const b = run('https://s.example/b', { title: 'B', h1: [], maybe: [{ text: 'Quick links', target: '#t', sig: 'S' }] }, [undecidedHere]);
    for (const r of withAcrossPages([probe], [...others, b])) expect(r.findings, r.page).toEqual([undecidedHere]);
    // A line this page gives no proof for (kept for the site rule only) with no heading like it elsewhere: clean.
    const clean = withAcrossPages([probe], [run('https://s.example/a', { title: 'A', h1: [], sigs: [{ text: 'Quick links', level: 2, sig: 'OTHER-TYPE' }] }), run('https://s.example/b', { title: 'B', h1: [], maybe: [{ text: 'Quick links', target: '#t', sig: 'S' }] })]);
    expect(clean.map((r) => r.findings)).toEqual([[], []]);
  });

  it('the replacement is scoped (lead\'s condition): only the criteria a test names; any other test or criterion keeps the page\'s undecided finding', () => {
    const doubt: ProbeFinding = { criterion: '2.4.2', status: 'not_testable', target: 'title', detail: 'the title may not describe the page' };
    const across = () => new Map([['https://s.example/b', [{ criterion: '2.4.2', status: 'failed' as const, target: 'title', detail: 'a cross-page failure' }]]]);
    const mk = (settles?: string[]): PageProbe => ({ id: 'titles', criteria: ['2.4.2'], kind: 'render', tier: 'core', timeoutMs: 1000, run: async () => [], acrossPages: across, ...(settles ? { acrossSettles: settles } : {}) });
    const b = { index: 1, run: { probe: 'titles', kind: 'render' as const, page: 'https://s.example/b', criteria: ['2.4.2'], status: 'ok' as const, findings: [doubt], ms: 1 } };
    // No `acrossSettles`, or one that names another criterion: the cross-page finding is added and nothing goes.
    expect(withAcrossPages([mk()], [b])[0]!.findings.map((f) => f.status)).toEqual(['not_testable', 'failed']);
    expect(withAcrossPages([mk(['1.3.1'])], [b])[0]!.findings.map((f) => f.status)).toEqual(['not_testable', 'failed']);
    // Named: it settles it.
    expect(withAcrossPages([mk(['2.4.2'])], [b])[0]!.findings.map((f) => f.status)).toEqual(['failed']);
  });
});

// Sol review of batch 17, S1 (lead's ruling: a recorded doubt is NEVER set aside). A line the read doubts (it reads on
// into the text after it, it is a quotation…) stays undecided whatever proves it: a twin on its own page, as the style
// sheet sets it or as the browser draws it, and the site's other pages, which never get it as a candidate.
describe('1.3.1 F2, Sol review S1: a doubt is never set aside by a twin or by the site', () => {
  const ON = 'took a bus or a train with us last year, the most since the new lines opened, and nine in ten said they would ride again.';
  /** A page with a real level-2 heading set `h2`, and the line "Riders of every age" set `line` over `after`. */
  const split = (line: string, after: string, attrs = '') => `<main><h1>Our year in numbers</h1><p>${BODY}</p><div id="t" ${attrs} style="font:${line};margin:0 0 12px">Riders of every age</div><p>${after}</p><h2 style="font:700 1.5rem Arial, sans-serif">Get started</h2><p>${BODY}</p></main>`;

  it('a twin by the style sheet that reads on into its sentence ("Riders of every age" / "took a bus…") is undecided, with the reason', async () => {
    const body = split('700 1.5rem Arial, sans-serif', ON);
    expect(await failed(body)).toEqual([]);
    const read = await readOn(body);
    expect(of(read, 'not_testable').map((f) => f.target)).toEqual(['#t']);
    expect(of(read, 'not_testable')[0]!.detail).toContain('(it reads on into the text after it)');
    expect(of(read, 'not_testable')[0]!.detail).toContain('it is set exactly like the page\'s real headings');
    // The same line over a sentence of its own is a twin, as before.
    expect(await failed(split('700 1.5rem Arial, sans-serif', BODY))).toEqual(['#t']);
  });

  it('a twin as the browser draws it that is a quotation is undecided', async () => {
    const body = `<main><h1>Library services</h1><p>${BODY}</p><div id="t" style="font:500 1.7rem TwoFaces, monospace;margin:0 0 12px">“The bus is my lifeline”</div><p>${BODY}</p><h2 style="font:400 1.7rem TwoFaces, monospace">Get started</h2><p>${BODY}</p></main>`;
    expect(await failed(body)).toEqual([]);
    expect(await undecided(body)).toEqual(['#t']);
  });

  it('the site twin: another page marks up "Riders of every age" as a heading; on this page it reads on into its sentence: no failure, and not offered to the site rule', async () => {
    const marked = await readOn(`<main><h1>Ridership</h1><p>${BODY}</p><h2 style="font:700 1.5rem Arial, sans-serif">Riders of every age</h2><p>${BODY}</p></main>`, 'Ridership');
    for (const [why, body] of [
      ['no naming class (a plain candidate)', split('700 1.5rem Arial, sans-serif', ON)],
      ['a naming class', split('700 1.5rem Arial, sans-serif', ON, 'class="block-title"')],
      ['set unlike the page\'s own headings', split('700 1.9rem Arial, sans-serif', ON).replace('font:700 1.5rem Arial, sans-serif">Get started', 'font:700 1.2rem Arial, sans-serif">Get started')],
    ] as const) {
      const here = await readOn(body, 'Numbers');
      expect(headingsData(here).maybe ?? [], why).toEqual([]);
      expect(here.plain ?? [], why).toEqual([]);
      const runs = [run('https://site.example/ridership', headingsData(marked)), run('https://site.example/numbers', headingsData(here), headingFindings(here))];
      expect(siteTwinFindings(runs).size, why).toBe(0);
    }
    // The look-alike's own proof still holds where nothing doubts the line: over a sentence of its own it fails by the site.
    const own = await readOn(split('700 1.9rem Arial, sans-serif', BODY).replace('font:700 1.5rem Arial, sans-serif">Get started', 'font:700 1.2rem Arial, sans-serif">Get started'), 'Numbers');
    const markedBig = await readOn(`<main><h1>Ridership</h1><p>${BODY}</p><h2 style="font:700 1.9rem Arial, sans-serif">Riders of every age</h2><p>${BODY}</p></main>`, 'Ridership');
    expect([...siteTwinFindings([run('https://site.example/ridership', headingsData(markedBig)), run('https://site.example/numbers', headingsData(own), headingFindings(own))]).keys()]).toEqual(['https://site.example/numbers']);
  });

  it('shownVerdict reads the doubt before any proof', () => {
    expect(shownVerdict({ text: 'x', target: '#t', why: 'twin', doubt: 'it reads on into the text after it' })).toBeNull();
    expect(shownVerdict({ text: 'x', target: '#t', why: 'twin' })).toBe('twin');
  });
});
