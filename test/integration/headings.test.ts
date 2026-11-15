// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The heading structure probe (1.3.1, 2.4.6) in real Chromium: the page reader on small pages, and
// whole scans of the fixture sites (test/fixtures/headings/: a news template whose pages all use the
// site name as their main heading, synthetic; test/fixtures/site/).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HEADINGS_LIMITS, headingFindings, headingsProbe, readHeadings, type HeadingsRead } from '../../src/probes/headings.js';
import { installNamesSomething, NAMES_SOMETHING_KEY } from '../../src/probes/namesSomething.js';
import { runProbes } from '../../src/probes/runner.js';
import { loneHeaderFindings, readLoneHeaders, TABLE_HEADER_LIMITS } from '../../src/probes/tableHeaders.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, ProbeRun, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
const B = () => browser as unknown as BrowserLike;

beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

const LIMITS = { elements: HEADINGS_LIMITS.elements, headings: HEADINGS_LIMITS.headings, frames: HEADINGS_LIMITS.frames, namesKey: NAMES_SOMETHING_KEY };

async function readOn(body: string, setup?: string): Promise<HeadingsRead> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><title>T</title></head><body>${body}</body></html>`);
    if (setup) await page.evaluate(setup);
    await page.evaluate(installNamesSomething, NAMES_SOMETHING_KEY);
    return await page.evaluate(readHeadings, LIMITS);
  } finally {
    await page.close();
  }
}
const outline = (r: HeadingsRead) => r.headings.map((h) => `${h.level}:${h.text}`);
const findings = async (body: string, setup?: string) => headingFindings(await readOn(body, setup)).map((f) => [f.criterion, f.status]);

describe('readHeadings', () => {
  it('finds nothing wrong with one good main heading, an outline in order, or levels going back up', async () => {
    expect(await findings('<h1>Page</h1><p>x</p>')).toEqual([]);
    expect(await findings('<h1>Page</h1><h2>A</h2><h3>B</h3>')).toEqual([]);
    expect(await findings('<h1>Page</h1><h2>A</h2><h3>B</h3><h4>C</h4><h2>D</h2><h3>E</h3>')).toEqual([]);
  });

  it('reads role="heading" and aria-level, and leaves out headings with another role', async () => {
    const r = await readOn('<div role="heading" aria-level="1">Page</div><div role="heading">Default two</div><h3 aria-level="2">Native, level 2</h3><h2 role="presentation">Not a heading</h2><h4 role="tab">Tab</h4>');
    expect(outline(r)).toEqual(['1:Page', '2:Default two', '2:Native, level 2']);
    // Strict tests round 4: the h2 made presentational still shows as a heading (the browser's bold, larger h2): F92 is
    // listed as a recommendation, never a failure (lead's ruling, Sol round 2).
    expect(headingFindings(r).map((f) => [f.criterion, f.status, f.advice])).toEqual([['1.3.1', 'no_failures_found', true]]);
    expect(headingFindings(r)[0]!.detail).toMatch(/^“Not a heading” looks like a heading/);
  });

  it('ignores hidden headings, but counts screen-reader-only ones', async () => {
    const r = await readOn(`
      <h1 style="display:none">Hidden main</h1>
      <h1 hidden>Hidden attribute</h1>
      <div aria-hidden="true"><h1>Aria hidden</h1></div>
      <div inert><h1>Inert</h1></div>
      <h1 style="visibility:hidden">Invisible</h1>
      <details><summary>More</summary><h1>In a closed details</h1></details>
      <h1 style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Screen reader only</h1>
      <h2>Services</h2><h4 style="display:none">Hidden deep</h4><h3>Sub</h3>`);
    expect(outline(r)).toEqual(['1:Screen reader only', '2:Services', '3:Sub']);
    expect(headingFindings(r)).toEqual([]);
    // Only hidden main headings: the page has none (a recommendation, not a failure).
    expect(await findings('<h1 style="display:none">Hidden</h1><h2>Visible</h2>')).toEqual([['2.4.6', 'no_failures_found']]);
  });

  // Batch 19, the lead's ruling: a heading with no text is Needs review under 1.3.1 (flagged), never a failure.
  it('recommends a main heading (never a failure), and flags 1.3.1 for review for headings with no text', async () => {
    expect(await findings('<p><b>About us</b></p><h2>History</h2>')).toEqual([['2.4.6', 'no_failures_found']]);
    expect(await findings('<p>No headings at all</p>')).toEqual([['2.4.6', 'no_failures_found']]);
    const r = await readOn('<h1>Page</h1><h2></h2><h2><img src="data:," alt=""></h2><h2><span style="display:none">gone</span></h2><h2><img src="data:," alt="Logo"></h2><h2 aria-label="Named"></h2><h2><svg><title>Icon</title></svg></h2>');
    expect(outline(r)).toEqual(['1:Page', '2:', '2:', '2:', '2:Logo', '2:Named', '2:Icon']);
    expect(headingFindings(r).map((f) => [f.criterion, f.status, f.target])).toEqual([
      ['1.3.1', 'flagged', 'html > body > h2:nth-of-type(1)'], ['1.3.1', 'flagged', 'html > body > h2:nth-of-type(2)'], ['1.3.1', 'flagged', 'html > body > h2:nth-of-type(3)'],
    ]);
  });

  // W3C ACT ffd0e9 "Heading has non-empty accessible name": its failed examples, each with a named h2 after it. Batch 19
  // (the lead's ruling: ffd0e9 now maps to ARIA 1.2 only): each is flagged for review under 1.3.1, never failed.
  it('flags 1.3.1 for review for every ACT ffd0e9 failed example', async () => {
    const failed = [
      '<h1></h1>', '<h1><br></h1>', '<div role="heading" aria-level="1" style="border-style: solid"></div>',
      '<h1><img src="data:," alt=""></h1>', '<h1><img src="data:," alt="ACT rules" role="presentation"></h1>',
      '<h1 aria-label=""><span aria-hidden="true">ACT rules</span></h1>',
      '<h1 aria-label="" role="none"><span aria-hidden="true">ACT rules</span></h1>',
      '<span id="h-name" hidden></span><h1 aria-labelledby="h-name"><span aria-hidden="true">ACT rules</span></h1>',
    ];
    for (const body of failed) {
      const got = await findings(`${body}<h2>Next</h2>`);
      expect(got.filter(([, s]) => s === 'failed'), body).toEqual([]);
      expect(got.filter(([, s]) => s === 'flagged'), body).toEqual([['1.3.1', 'flagged']]);
    }
    // Its passed examples: a named heading, an image's alt, a heading made presentational.
    for (const body of ['<h1>ACT rules</h1>', '<h1><img src="data:," alt="ACT rules"></h1>', '<h1 role="none"></h1>', '<h1 aria-label="ACT rules"></h1>']) {
      expect((await findings(body)).filter(([, s]) => s === 'failed'), body).toEqual([]);
    }
  });

  it('fails 1.3.1 for a paragraph marked up as a heading', async () => {
    const long = 'Opening hours may change on public holidays and during staff training days. When the library closes early for bad weather, the change is posted on this page and at the front desk by nine in the morning on that day.';
    const r = await readOn(`<h1>Page</h1><h2>Hours</h2><p>Nine to five.</p><h5>${long}</h5>`);
    expect(r.headings[2]!.chars).toBe(long.length);
    expect(headingFindings(r).map((f) => [f.criterion, f.status])).toEqual([['1.3.1', 'failed'], ['1.3.1', 'no_failures_found']]);
  });

  it('recommends levels in order where they skip downwards (never a failure), with the heading as the target', async () => {
    const f = headingFindings(await readOn('<h1>Page</h1><h2 id="news">News</h2><h4>Event</h4>'));
    expect(f.map((x) => [x.criterion, x.status, x.advice, x.target])).toEqual([['1.3.1', 'no_failures_found', true, 'html > body > h4']]);
    expect(f[0]!.detail).toContain('“Event”');
  });

  it('reads headings in open shadow roots in reading order, and a main heading in a same-origin frame', async () => {
    const shadow = `
      const host = document.getElementById('host');
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<h2>In shadow</h2><slot></slot><h3>After slot</h3>';`;
    const r = await readOn('<h1>Page</h1><div id="host"><h3>Slotted</h3></div><h2>After host</h2>', shadow);
    expect(outline(r)).toEqual(['1:Page', '2:In shadow', '3:Slotted', '3:After slot', '2:After host']);
    expect(r.headings[1]!.target).toBe('#host >>> h2');
    const framed = await readOn('<h2>Outside</h2><iframe srcdoc="<h1>Framed page</h1>" title="Content"></iframe>');
    await expect.poll(() => framed.frameH1).toBe(true);
    expect(headingFindings(framed)).toEqual([]);
  });

  it('makes no main-heading recommendation for a page that is mostly another site\'s frame', async () => {
    const r = await readOn('<iframe src="https://elsewhere.invalid/" title="App" style="width:1280px;height:900px;border:0"></iframe>');
    expect(r.bigUnreadableFrame).toBe(true);
    expect(headingFindings(r)).toEqual([]);
  });

  it('reads a huge page within its time box', async () => {
    const t0 = Date.now();
    const r = await readOn('<h1>Big</h1><div id="big"></div>', `
      const big = document.getElementById('big');
      let html = '';
      for (let i = 0; i < 20000; i++) html += '<div><span>Item ' + i + '</span>' + (i % 50 === 0 ? '<h2>Section ' + i + '</h2>' : '') + '</div>';
      big.innerHTML = html;`);
    expect(r.headings).toHaveLength(401);
    expect(r.truncated).toBe(false);
    expect(Date.now() - t0).toBeLessThan(5000);
    // A heading that wraps a whole section is named from its first part, quickly.
    const t1 = Date.now();
    const wrapped = await readOn('<h1 id="all"><span>Start</span></h1>', `
      const all = document.getElementById('all');
      let html = '';
      for (let i = 0; i < 20000; i++) html += '<div><span>Part ' + i + '</span></div>';
      all.insertAdjacentHTML('beforeend', html);`);
    expect(wrapped.headings[0]!.text).toMatch(/^Start Part 0 /);
    expect(Date.now() - t1).toBeLessThan(5000);
  });
});

describe('scanSite with the headings probe', () => {
  let server: Awaited<ReturnType<typeof startFixtureServer>>;
  let report: SiteReport;
  const path = (u: string) => new URL(u).pathname;
  const runsOf = (r: SiteReport, id: string): ProbeRun[] => r.probes!.runs.filter((x) => x.probe === id);

  beforeAll(async () => {
    server = await startFixtureServer('headings');
    report = await scanSite(`${server.origin}/`, { browser: B() });
  }, 240_000);
  afterAll(async () => {
    await server?.close();
  });

  it('runs headings and text contrast on every page that loaded, beyond the template sample', () => {
    const pages = report.pages.filter((p) => p.status === 'ok').map((p) => path(p.url));
    expect(pages).toHaveLength(7);
    for (const id of ['headings', 'text-contrast']) expect(runsOf(report, id).map((r) => path(r.page)).sort(), id).toEqual([...pages].sort());
    // The other core probes are scored on the template sample, which leaves out repeats of the news template.
    // (Since 2026-11-10 reflow also runs on the other pages as coverage, `ProbeRun.coverage`: listed, not scored.)
    const sampled = runsOf(report, 'reflow').filter((r) => !r.coverage).map((r) => path(r.page));
    expect(sampled.length).toBeLessThan(pages.length);
    expect(sampled.filter((p) => p.startsWith('/news/')).length).toBeLessThanOrEqual(1);
    expect(runsOf(report, 'reflow').map((r) => path(r.page)).sort()).toEqual([...pages].sort());
    expect(runsOf(report, 'headings').every((r) => r.status === 'ok')).toBe(true);
  });

  it('finds each planted problem, and the site name as the main heading of every news page', () => {
    const by = (p: string) => runsOf(report, 'headings').find((r) => path(r.page) === p)!.findings.map((f) => [f.criterion, f.status]);
    expect(by('/')).toEqual([]);
    expect(by('/contact.html')).toEqual([]);
    // No level-1 heading and a skipped level are recommendations; a paragraph as a heading fails; an empty heading is
    // Needs review (batch 19, the lead's ruling).
    expect(by('/about.html')).toEqual([['1.3.1', 'failed'], ['2.4.6', 'no_failures_found']]);
    expect(by('/news/spring-reading-challenge.html')).toEqual([['1.3.1', 'no_failures_found'], ['2.4.6', 'failed']]);
    expect(by('/news/new-opening-hours.html')).toEqual([['1.3.1', 'flagged'], ['2.4.6', 'failed']]);
    expect(by('/news/summer-story-time.html')).toEqual([['2.4.6', 'failed']]);
    expect(by('/news/library-card-week.html')).toEqual([['2.4.6', 'failed']]);
    const template = runsOf(report, 'headings').flatMap((r) => r.findings).filter((f) => /same on nearly every page/.test(f.detail));
    expect(template).toHaveLength(4);
    expect(template[0]!.detail).toContain('“Riverside Library”');
    // No run data reaches the report.
    expect(runsOf(report, 'headings').every((r) => !('data' in r))).toBe(true);
  });
});

describe('scanSite on the plain fixture site', () => {
  it('finds no heading problem on pages with one good main heading each', async () => {
    const server = await startFixtureServer();
    try {
      const report = await scanSite(`${server.origin}/`, { browser: B() });
      const ok = report.pages.filter((p) => p.status === 'ok').map((p) => p.url);
      const runs = report.probes!.runs.filter((r) => r.probe === 'headings');
      expect(runs.map((r) => r.page).sort()).toEqual([...ok].sort());
      expect(runs.flatMap((r) => r.findings)).toEqual([]);
    } finally {
      await server.close();
    }
  }, 240_000);
});

// 2026-11-09 benchmark review. WCAG 1.3.1: a table header cell that is the header of no data cell (a column with no
// cells under its header, or one every cell names away with headers=) says nothing about any cell. Look-alikes stay
// clean: a corner label over a column of row headers, headers= that name the header, an empty table's one "No
// results" cell across every column, and a hidden header.
describe('table header cells that head no data cell (1.3.1)', () => {
  it('R7: an ARIA rowheader relates to cells on either side, while an empty row still fails', async () => {
    const html = `<div role="table">
  <div role="row">
    <span role="cell">9–5</span>
    <span role="rowheader" id="h">Main branch</span>
  </div>
</div>`;
    expect(await lone(html)).toEqual([]);
    expect(await lone(html.replace('<span role="cell">9–5</span>', '').replace('</div>\n</div>', '</div><div role="row"><span role="cell">Closed</span></div></div>')))
      .toContainEqual(expect.stringContaining('#h: The table row header'));
    expect(await lone('<table><tr><th scope="row">Main branch</th><td>9–5</td></tr></table>')).toEqual([]);
  });
  async function lone(body: string): Promise<string[]> {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(`<!doctype html><html lang="en"><head><title>T</title></head><body><main><h1>T</h1>${body}</main></body></html>`);
      return loneHeaderFindings(await page.evaluate(readLoneHeaders, { ...TABLE_HEADER_LIMITS })).map((f) => `${f.target}: ${f.detail.split(' is the header')[0]}`);
    } finally {
      await page.close();
    }
  }

  it('fails a column header with no cells under it, one every cell names away, and an ARIA grid column with no cells', async () => {
    expect(await lone('<table><tr><th>Item</th><th id="d">Due</th></tr><tr><td>Book</td></tr><tr><td>DVD</td></tr></table>')).toEqual(['#d: The table column header “Due”']);
    expect(await lone('<table><tr><th id="a">Branch</th><th id="b">Open late</th></tr><tr><td>Main</td><td headers="a">North</td></tr></table>')).toEqual(['#b: The table column header “Open late”']);
    expect(await lone(`<div role="grid"><div role="row"><span role="columnheader">Seat</span><span role="columnheader" id="g">Name</span></div>
<div role="row"><span role="gridcell">4A</span></div><div role="row"><span role="gridcell">4B</span></div></div>`)).toEqual(['#g: The table column header “Name”']);
  });

  it('a row header (scope=row) with no cell to its right fails; one with cells passes', async () => {
    expect(await lone('<table><tr><th>Day</th><td>Mon</td><td>Tue</td></tr><tr><th scope="row" id="r">Room</th></tr></table>')).toEqual(['#r: The table row header “Room”']);
  });

  it('assigns group headers to cells elsewhere in their group, and still fails a group with no data cells', async () => {
    expect(await lone('<table><tbody><tr><th scope="rowgroup" id="season">Winter</th></tr><tr><td>January</td><td>12</td></tr></tbody></table>')).toEqual([]);
    expect(await lone('<table><colgroup span="2"></colgroup><tr><th scope="colgroup" id="totals">Totals</th><th>Count</th></tr><tr><th>North</th><td>12</td></tr></table>')).toEqual([]);
    expect(await lone('<table><tbody><tr><th scope="rowgroup" id="empty">Winter</th></tr></tbody><tbody><tr><td>January</td><td>12</td></tr></tbody></table>')).toEqual(['#empty: The table row group header “Winter”']);
    expect(await lone('<table><colgroup></colgroup><colgroup></colgroup><tr><th>Item</th><th scope="colgroup" id="empty">Count</th></tr><tr><td>Book</td></tr></table>')).toEqual(['#empty: The table column group header “Count”']);
  });

  it('reports unread table structures as not testable instead of finding no failures', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<div role="table" id="schedule"><div role="row"><span role="columnheader" aria-rowspan="2">Day</span><span role="cell">Monday</span></div><div role="row"><span role="cell">Tuesday</span></div></div>');
      expect(loneHeaderFindings(await page.evaluate(readLoneHeaders, { ...TABLE_HEADER_LIMITS }))).toEqual([
        expect.objectContaining({ criterion: '1.3.1', status: 'not_testable', target: '#schedule', detail: expect.stringContaining('ARIA row spans') }),
      ]);
      await page.setContent('<table id="large"><tr><th>Day</th><td>Monday</td><td>Tuesday</td></tr></table>');
      expect(loneHeaderFindings(await page.evaluate(readLoneHeaders, { ...TABLE_HEADER_LIMITS, cells: 2 }))).toEqual([
        expect.objectContaining({ criterion: '1.3.1', status: 'not_testable', target: '#large', detail: expect.stringContaining('all cells') }),
      ]);
      expect(loneHeaderFindings(await page.evaluate(readLoneHeaders, { ...TABLE_HEADER_LIMITS, tables: 0 }))).toEqual([
        expect.objectContaining({ criterion: '1.3.1', status: 'not_testable', detail: expect.stringContaining('all tables') }),
      ]);
    } finally {
      await page.close();
    }
  });

  it('passes ordinary tables, corner labels, headers= that name the header, an empty table, spans and hidden headers', async () => {
    expect(await lone('<table><tr><th>Item</th><th>Due</th></tr><tr><td>Book</td><td>3 weeks</td></tr></table>')).toEqual([]);
    expect(await lone('<table><tr><th>Branch</th><th>Weekdays</th></tr><tr><th>Main</th><td>9–5</td></tr><tr><th>North</th><td>10–6</td></tr></table>')).toEqual([]);
    expect(await lone('<table><tr><th id="a">Branch</th><th id="b">Hours</th></tr><tr><td headers="a">Main</td><td headers="b">9–5</td></tr></table>')).toEqual([]);
    expect(await lone('<table><thead><tr><th>Item</th><th>Due</th><th>Fee</th></tr></thead><tbody><tr><td colspan="3">No results</td></tr></tbody></table>')).toEqual([]);
    expect(await lone('<table><tr><th colspan="2">Hours</th></tr><tr><td>Mon</td><td>9–5</td></tr></table>')).toEqual([]);
    expect(await lone('<table><tr><th>Item</th><th>Due</th></tr><tr><td rowspan="2">Book</td><td>3 weeks</td></tr><tr><td>4 weeks</td></tr></table>')).toEqual([]);
    expect(await lone('<table><tr><th>Item</th><th style="display:none">Due</th></tr><tr><td>Book</td></tr></table>')).toEqual([]);
    expect(await lone('<table role="presentation"><tr><th>Item</th><th>Due</th></tr><tr><td>Book</td></tr></table>')).toEqual([]);
    expect(await lone('<table><tr><th>Item</th><th>Due</th></tr></table>')).toEqual([]);
  });

  it('the headings probe reports it on a page', async () => {
    const server = await startFixtureServer('headings');
    try {
      const [run] = await runProbes(B(), [{ url: `${server.origin}/tables.html`, index: 0 }], [headingsProbe], { userAgent: 'grnted-test' });
      expect(run!.findings.filter((f) => f.status === 'failed')).toEqual([expect.objectContaining({ criterion: '1.3.1', target: '#due-head' })]);
    } finally {
      await server.close();
    }
  }, 60_000);
});
