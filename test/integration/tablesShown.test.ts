// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Tabular data shown as a table but with no header relationships a screen reader can use (WCAG 1.3.1), in real
// Chromium: a data table whose header row is bold data cells (F91), a data table made presentational (F92), and
// rows and columns of text laid out with CSS only. A failure only where the page shows a header row: its first
// row is bold and the rows under it are not. Every page here is written for this test.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TABLES_SHOWN_LIMITS, readShownTables, shownTableFindings } from '../../src/probes/tablesShown.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

const CSS = `
  body { font: 16px/1.5 Arial, sans-serif; color: #222; }
  table { border-collapse: collapse; } td, th { border: 1px solid #999; padding: 6px 10px; }
  .head td, td.head, .head > span, .head > div { font-weight: 700; }
  .rows > div { display: grid; grid-template-columns: 2fr 1fr 1fr; }
  .rows span, .flat > * { padding: 6px 10px; border: 1px solid #ccc; }
  .flat { display: grid; grid-template-columns: repeat(3, 1fr); }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
`;

async function failed(body: string): Promise<[string, string | undefined][]> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><title>T</title><style>${CSS}</style></head><body><main><h1>Pool hours</h1>${body}</main></body></html>`);
    return shownTableFindings(await page.evaluate(readShownTables, { ...TABLES_SHOWN_LIMITS })).filter((f) => f.status === 'failed').map((f) => [f.criterion, f.target]);
  } finally {
    await page.close();
  }
}

async function undecided(body: string): Promise<[string, string | undefined][]> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><title>T</title><style>${CSS}</style></head><body><main><h1>Pool hours</h1>${body}</main></body></html>`);
    return shownTableFindings(await page.evaluate(readShownTables, { ...TABLES_SHOWN_LIMITS })).filter((f) => f.status === 'not_testable').map((f) => [f.criterion, f.target]);
  } finally {
    await page.close();
  }
}

const ROWS = '<tr><td>Main pool</td><td>6 a.m.</td><td>9 p.m.</td></tr><tr><td>Teaching pool</td><td>9 a.m.</td><td>6 p.m.</td></tr><tr><td>Splash pad</td><td>10 a.m.</td><td>5 p.m.</td></tr>';

describe('1.3.1: a data table with no header cells (F91)', () => {
  it('fails a two-column table whose header row is bold td cells (axe\'s td-has-header does not apply under three columns)', async () => {
    expect(await failed(`<table id="t"><caption>Opening times</caption><tr class="head"><td>Pool</td><td>Opens</td></tr><tr><td>Main pool</td><td>6 a.m.</td></tr><tr><td>Teaching pool</td><td>9 a.m.</td></tr></table>`)).toEqual([['1.3.1', '#t']]);
    // The bold can come from <b> or <strong> inside the cells.
    expect(await failed(`<table id="t"><tr><td><b>Pool</b></td><td><strong>Opens</strong></td></tr><tr><td>Main pool</td><td>6 a.m.</td></tr><tr><td>Teaching pool</td><td>9 a.m.</td></tr></table>`)).toEqual([['1.3.1', '#t']]);
    // Three columns and three rows or more: axe's td-has-header fails the table, so it is not reported twice.
    expect(await failed(`<table><caption>Opening hours</caption><tr class="head"><td>Pool</td><td>Opens</td><td>Closes</td></tr>${ROWS}</table>`)).toEqual([]);
  });

  it('fails a data table made presentational (F92): a caption or header cells under role="presentation"', async () => {
    expect(await failed(`<table id="t" role="presentation"><caption>Opening hours</caption><tr class="head"><td>Pool</td><td>Opens</td><td>Closes</td></tr>${ROWS}</table>`)).toEqual([['1.3.1', '#t']]);
    expect(await failed(`<table id="t" role="none"><thead><tr><th>Pool</th><th>Opens</th><th>Closes</th></tr></thead><tbody>${ROWS}</tbody></table>`)).toEqual([['1.3.1', '#t']]);
  });

  it('a small presentational table reads the same in order: one row of values, or one column, is never failed', async () => {
    expect(await failed(`
      <table role="presentation"><tr><td id="a">Stage</td><td id="b">Target</td></tr><tr><td headers="a">Half done</td><td headers="b">June</td></tr></table>
      <table role="none"><tr><th>Opens</th></tr><tr><td>9 a.m.</td></tr></table>
      <table role="presentation"><tr><th>Opens</th></tr><tr><td>9 a.m.</td></tr><tr><td>10 a.m.</td></tr></table>`)).toEqual([]);
    // Two columns and two rows of values under header cells: the relationships are lost.
    expect(await failed(`<table id="t" role="presentation"><tr><th>Pool</th><th>Opens</th></tr><tr><td>Main pool</td><td>6 a.m.</td></tr><tr><td>Teaching pool</td><td>9 a.m.</td></tr></table>`)).toEqual([['1.3.1', '#t']]);
  });

  it('look-alikes: real header cells, a layout table, a label column, an all-bold table, a one-row table', async () => {
    expect(await failed(`
      <table><tr><th>Pool</th><th>Opens</th><th>Closes</th></tr>${ROWS}</table>
      <table><tr><th scope="row">Main pool</th><td>6 a.m.</td></tr><tr><th scope="row">Teaching pool</th><td>9 a.m.</td></tr><tr><th scope="row">Splash pad</th><td>10 a.m.</td></tr></table>
      <table role="presentation"><tr><td><h2>Visit</h2><p>The pool is on Mill Road, next to the library and the bus stop.</p></td><td><h2>Swim</h2><p>Lessons run all year for every age and level.</p></td></tr></table>
      <table role="presentation"><tr><td>Pool</td><td>Opens</td><td>Closes</td></tr>${ROWS}</table>
      <table><tr><td class="head">Phone</td><td>555 0100</td></tr><tr><td class="head">Email</td><td>pool@example.org</td></tr><tr><td class="head">Address</td><td>12 Mill Road</td></tr></table>
      <table class="head"><tr><td>Pool</td><td>Opens</td></tr><tr class="head"><td>Main pool</td><td>6 a.m.</td></tr><tr class="head"><td>Teaching pool</td><td>9 a.m.</td></tr></table>
      <table><tr class="head"><td>Pool</td><td>Opens</td><td>Closes</td></tr></table>
      <table><tr><td>Main pool</td><td>6 a.m.</td><td>9 p.m.</td></tr>${ROWS}</table>`)).toEqual([]);
  });

  it('look-alikes: a bold first row over cells that hold blocks, pictures or form fields is a layout', async () => {
    expect(await failed(`
      <table><tr class="head"><td>Visit</td><td>Swim</td></tr><tr><td><p>The pool is on Mill Road.</p><p>Park behind the library.</p></td><td><ul><li>Lessons</li><li>Lanes</li></ul></td></tr><tr><td><p>Buses stop at the door.</p></td><td><p>Bring a towel.</p></td></tr></table>
      <table><tr class="head"><td>Your name</td><td>Your email</td></tr><tr><td><input aria-label="Name"></td><td><input aria-label="Email"></td></tr><tr><td><input aria-label="Name 2"></td><td><input aria-label="Email 2"></td></tr></table>`)).toEqual([]);
  });
});

describe('1.3.1: rows and columns laid out with CSS only', () => {
  it('fails rows of spans with a bold header row, and a flat CSS grid with a bold first row', async () => {
    expect(await failed(`<div id="g" class="rows"><div class="head"><span>Pool</span><span>Opens</span><span>Closes</span></div><div><span>Main pool</span><span>6 a.m.</span><span>9 p.m.</span></div><div><span>Teaching pool</span><span>9 a.m.</span><span>6 p.m.</span></div></div>`)).toEqual([['1.3.1', '#g']]);
    expect(await failed(`<div id="g" class="flat"><b>Pool</b><b>Opens</b><b>Closes</b><span>Main pool</span><span>6 a.m.</span><span>9 p.m.</span><span>Teaching pool</span><span>9 a.m.</span><span>6 p.m.</span></div>`)).toEqual([['1.3.1', '#g']]);
  });

  it('look-alikes: ARIA table roles, cards, a link grid, a label column, a grid with no header row, a list', async () => {
    expect(await failed(`
      <div class="rows" role="table"><div class="head" role="row"><span role="columnheader">Pool</span><span role="columnheader">Opens</span><span role="columnheader">Closes</span></div><div role="row"><span role="cell">Main pool</span><span role="cell">6 a.m.</span><span role="cell">9 p.m.</span></div><div role="row"><span role="cell">Teaching pool</span><span role="cell">9 a.m.</span><span role="cell">6 p.m.</span></div></div>
      <div class="cards"><div><h2>Visit</h2><p>The pool is on Mill Road, next to the library.</p></div><div><h2>Swim</h2><p>Lessons run all year for every age.</p></div><div><h2>Join</h2><p>Members swim free on weekdays.</p></div></div>
      <div class="flat"><a href="/a"><b>Lessons</b></a><a href="/b"><b>Lanes</b></a><a href="/c"><b>Parties</b></a><a href="/d">Hours</a><a href="/e">Prices</a><a href="/f">Rules</a><a href="/g">Jobs</a><a href="/h">News</a><a href="/i">Contact</a></div>
      <div class="rows"><div><span class="head">Phone</span><span>555 0100</span><span>Weekdays</span></div><div><span class="head">Email</span><span>pool@example.org</span><span>Any time</span></div><div><span class="head">Desk</span><span>12 Mill Road</span><span>Weekends</span></div></div>
      <div class="flat"><span>Main pool</span><span>6 a.m.</span><span>9 p.m.</span><span>Teaching pool</span><span>9 a.m.</span><span>6 p.m.</span><span>Splash pad</span><span>10 a.m.</span><span>5 p.m.</span></div>
      <ul class="flat"><li><b>Pool</b></li><li><b>Opens</b></li><li><b>Closes</b></li><li>Main pool</li><li>6 a.m.</li><li>9 p.m.</li><li>Teaching pool</li><li>9 a.m.</li><li>6 p.m.</li></ul>`)).toEqual([]);
  });
});

describe('review round 1: a bold first row alone never proves a data table', () => {
  const NOTICES = ['Urgent: Mill Road is closed at the bridge until Friday', 'Urgent: the main pool opens two hours late on Monday', 'Urgent: boil tap water in Hillside until told otherwise',
    'Notice: the library book sale starts on the first Saturday of May', 'Notice: leaf collection ends for the season next week', 'Notice: the council meets in the old hall this month',
    'Notice: street sweeping moves to Thursdays in the east district', 'Notice: the farmers market returns to the square in April', 'Notice: parking permits for next year go on sale soon'];

  it('a grid of nine notices whose first three are bold is not a data table, and neither is a narrow table of notes', async () => {
    const grid = `<div id="g" class="flat">${NOTICES.map((n, i) => (i < 3 ? `<b>${n}</b>` : `<span>${n}</span>`)).join('')}</div>`;
    const table = `<table id="t"><tr class="head"><td>${NOTICES[0]}</td><td>${NOTICES[1]}</td></tr><tr><td>${NOTICES[3]}</td><td>${NOTICES[4]}</td></tr><tr><td>${NOTICES[5]}</td><td>${NOTICES[6]}</td></tr></table>`;
    for (const [name, body] of [['grid', grid], ['table', table]] as const) {
      expect(await failed(body), name).toEqual([]);
      expect(await undecided(body), name).toEqual([]);
    }
  });

  it('short bold labels over columns whose values are of no one kind are undecided, never failed', async () => {
    // Names, roles and rooms: it may be a table of staff, or a row of bold names over notes.
    expect(await undecided(`<div id="g" class="flat"><b>Name</b><b>Role</b><b>Office</b><span>Ana Ruiz</span><span>Clerk</span><span>Front desk</span><span>Ben Cho</span><span>Planner</span><span>East wing</span></div>`)).toEqual([['1.3.1', '#g']]);
    expect(await failed(`<div id="g" class="flat"><b>Name</b><b>Role</b><b>Office</b><span>Ana Ruiz</span><span>Clerk</span><span>Front desk</span><span>Ben Cho</span><span>Planner</span><span>East wing</span></div>`)).toEqual([]);
  });

  it('look-alikes that still fail: labels over columns alike in kind (money, dates and times) across two rows or more', async () => {
    expect(await failed(`<table id="t"><tr class="head"><td>Service</td><td>Fee</td></tr><tr><td>Dog licence</td><td>$25</td></tr><tr><td>Parking permit</td><td>$40</td></tr><tr><td>Copy of a record</td><td>$12.50</td></tr></table>`)).toEqual([['1.3.1', '#t']]);
    expect(await failed(`<div id="g" class="flat"><b>Meeting</b><b>Date</b><b>Starts</b><span>Council</span><span>March 4</span><span>6 p.m.</span><span>Planning board</span><span>March 11</span><span>7 p.m.</span><span>Parks committee</span><span>March 18</span><span>5:30 p.m.</span></div>`)).toEqual([['1.3.1', '#g']]);
  });

  it('a presentational table that uses th cells for columns of blocks is a layout; one row of values under labels proves nothing', async () => {
    expect(await failed(`<table role="presentation"><tr><th><h2>Visit</h2><p>The pool is on Mill Road, next to the library.</p></th><th><h2>Swim</h2><p>Lessons run all year for every age.</p></th></tr><tr><td><p>Buses stop at the door.</p></td><td><p>Bring a towel.</p></td></tr><tr><td><p>Park behind the hall.</p></td><td><p>Lockers take coins.</p></td></tr></table>`)).toEqual([]);
    expect(await failed(`<div class="flat"><b>Pool</b><b>Opens</b><b>Closes</b><span>Main pool</span><span>6 a.m.</span><span>9 p.m.</span></div>`)).toEqual([]);
  });
});

// Batch 17 (structure lane): a column of date spans is a column of one kind, as a column of single dates is. A
// schedule laid out as a CSS grid ("Date | Lane condition | Walking route" over two rows of "November 18–20 | …")
// was undecided because "November 18–20" read as plain words.
describe('1.3.1: a span of dates is a typed value (batch 17)', () => {
  const grid = (dates: readonly string[]) => `<div id="g" class="flat"><b>Date</b><b>Lane condition</b><b>Walking route</b><span>${dates[0]}</span><span>Alternating traffic</span><span>South sidewalk closed</span><span>${dates[1]}</span><span>One westbound lane</span><span>Both sidewalks closed</span></div>`;

  it('fails a CSS grid schedule whose first column is spans of dates under a bold header row', async () => {
    for (const dates of [['November 18–20', 'November 23–25'], ['Nov 3 to Nov 5', 'Nov 10 to Nov 12'], ['11/18-11/20', '11/23-11/25'], ['June 30 – July 2, 2026', 'July 7 – July 9, 2026'], ['March 4 through 6', 'March 11 through 13']] as const) {
      expect(await failed(grid(dates)), dates[0]).toEqual([['1.3.1', '#g']]);
      expect(await undecided(grid(dates)), dates[0]).toEqual([]);
    }
  });

  it('look-alikes stay undecided: the same grid with plain words where the dates were, and words that only begin like a date', async () => {
    for (const dates of [['First phase', 'Second phase'], ['November crews', 'March crews'], ['May to be confirmed', 'June to be confirmed']] as const) {
      expect(await failed(grid(dates)), dates[0]).toEqual([]);
      expect(await undecided(grid(dates)), dates[0]).toEqual([['1.3.1', '#g']]);
    }
  });

  it('look-alike stays clean: three notices in a grid whose bold first row is sentences about dates', async () => {
    expect(await failed(`<div class="flat"><b>Closed November 18–20 for repairs.</b><b>Open again on November 21.</b><b>Call the office with questions.</b><span>November 18–20</span><span>November 21</span><span>Weekdays</span><span>November 23–25</span><span>November 26</span><span>Weekends</span></div>`)).toEqual([]);
  });
});
