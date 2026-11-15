// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 17 (structure lane): the stale title (2.4.2, F25) in real Chromium, over test/fixtures/titles-stale/
// (written for this test). A title that is, word for word, the main heading of another page of the site, on a page
// that uses none of its words (its headings, its text, its description, its address; the site's menus, and a header
// and footer most of its pages share, left out), may name that other page and not this one. Since the Sol review of
// batch 17 (S3, and the lead's ruling) the two facts together are a doubt for a person, never a failure: a page can
// be about its title in other words ("Water conservation" over "Save every drop", shorter showers and the tap turned
// off). Either fact alone decides nothing; and the two together say what else may explain the title (review of batch
// 17): a page under the page it names, a title that names a kind of page, a page in another language.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageTitlesProbe, readTitle, TITLE_LIMITS, TITLE_STOP_WORDS, topicWords, type TitleData } from '../../src/probes/pageTitles.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let runs: ProbeRun[];
// (A part that half of a site's titles share is taken for the site's name: thirteen of these pages carry it.)
const PAGES = ['/', '/swap.html', '/keys.html', '/inspections.html', '/bonfires.html', '/committee.html', '/water.html', '/hire/index.html', '/faq.html', '/compost.html', '/leaves.html', '/wardens.html', '/join.html',
  '/rebates.html', '/store.html', '/rota.html', '/described.html', '/footer.html', '/short.html', '/hire/mower.html', '/bees.html', '/es/abono.html', '/hojas.html',
  '/conservation.html', '/tips.html'];

beforeAll(async () => {
  server = await startFixtureServer('titles-stale');
  browser = await chromium.launch();
  runs = await runProbes(browser as unknown as BrowserLike, PAGES.map((p, index) => ({ url: `${server.origin}${p}`, index })), [pageTitlesProbe], { userAgent: 'grnted-test' });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const on = (path: string) => runs.find((r) => new URL(r.page).pathname === path)!;
const failed = (path: string) => on(path).findings.filter((f) => f.status === 'failed').map((f) => f.detail);
const doubts = (path: string) => on(path).findings.filter((f) => f.status === 'not_testable').map((f) => f.detail);

describe('2.4.2: a title that names another page of the site and nothing on this one', () => {
  it('every page ran, and kept which of its title\'s words the page uses outside its menus, its language and how much it read', () => {
    expect(runs.map((r) => [new URL(r.page).pathname, r.status])).toEqual(PAGES.map((p) => [p, 'ok']));
    const data = (p: string) => on(p).data as TitleData;
    // The menu names the swap day on every page: a menu is not what the page is about.
    expect(data('/rebates.html').hits).toEqual([]);
    expect(data('/rebates.html').read).toBeGreaterThan(40);
    expect(data('/rebates.html').partial).toBeUndefined();
    expect(data('/rebates.html').lang).toBe('en');
    // A side column, the text and the description are the page's own words.
    expect([...(data('/store.html').hits ?? [])].sort()).toEqual(['holder', 'key']);
    expect(data('/rota.html').hits).toEqual(['inspection']);
    expect(data('/described.html').hits).toEqual(['bonfir']);
    // (In a footer of its own: most of the site's pages have another footer text, so it is this page's.)
    expect(data('/footer.html').hits).toEqual([]);
    expect([...(data('/footer.html').frameHits ?? [])].sort()).toEqual(['supply', 'water']);
    expect(data('/footer.html').frame).not.toBe(data('/rebates.html').frame);
    expect(data('/store.html').frame).toBe(data('/rebates.html').frame);
    expect(data('/swap.html').hits).toEqual(expect.arrayContaining(['day', 'seed', 'swap']));
    // English and Spanish pages, told by their words.
    expect(data('/rebates.html').en! / data('/rebates.html').words!).toBeGreaterThan(0.1);
    expect(data('/hojas.html').en! / data('/hojas.html').words!).toBeLessThan(0.06);
    expect(data('/es/abono.html').lang).toBe('es');
  });

  it('Sol review S3: the page titled with another page\'s main heading that uses none of the title\'s words is a doubt for a person, never a failure, and names that page', () => {
    expect(failed('/rebates.html')).toEqual([]);
    expect(doubts('/rebates.html')).toEqual(['The page\'s title, “Seed swap day”, may describe another page: “Seed swap day” is, word for word, the main heading of /swap.html, and none of its words is on this page (not in its main heading, “Water butt rebates”, its other headings, its text, its description or its address; the site\'s menus, and a header and footer most of its pages share, are left out); whether it describes this page in other words is for a person to judge.']);
    expect(PAGES.filter((p) => failed(p).length)).toEqual([]);
  });

  it('Sol review S3 look-alike: "Water conservation" over "Save every drop" (shorter showers, the tap turned off), beside a page headed and titled "Water conservation", is a doubt, not a failure', () => {
    expect(failed('/tips.html')).toEqual([]);
    expect(doubts('/tips.html')).toEqual(['The page\'s title, “Water conservation | Marsh Lane Allotments”, may describe another page: “Water conservation” is, word for word, the main heading of /conservation.html, and none of its words is on this page (not in its main heading, “Save every drop”, its other headings, its text, its description or its address; the site\'s menus, and a header and footer most of its pages share, are left out); whether it describes this page in other words is for a person to judge.']);
    expect(failed('/conservation.html')).toEqual([]);
    expect(doubts('/conservation.html')).toEqual([]);
  });

  it('look-alikes with no finding: the page uses a word of the title in a side column, in its text, in its description or in its footer, or has next to no text', () => {
    for (const p of ['/store.html', '/rota.html', '/described.html', '/footer.html', '/short.html']) {
      expect(failed(p), p).toEqual([]);
      expect(doubts(p), p).toEqual([]);
    }
  });

  it('look-alikes with both facts stay a doubt, with the reason: under the page it names, a kind of page, another language', () => {
    const reason = (p: string) => { expect(failed(p), p).toEqual([]); expect(doubts(p).length, p).toBe(1); return doubts(p)[0]!; };
    expect(reason('/hire/mower.html')).toBe('The page\'s title, “Tool shed bookings”, is, word for word, the main heading of another scanned page (/hire/index.html), and none of its words is on this page outside the site\'s menus and shared header and footer (its main heading is “Borrowing the mower”); but this page lies under that page, so the title may name the section it is in, so whether it describes this page is for a person to judge.');
    expect(reason('/bees.html')).toContain('but its words name a kind of page, not one page, so whether it describes this page is for a person to judge.');
    expect(reason('/es/abono.html')).toContain('but the two pages are marked as being in different languages,');
    expect(reason('/hojas.html')).toContain('but the two pages read as being in different languages,');
  });

  it('no finding on the pages the titles belong to, on a page whose own heading shares a word with its title, or on the start page', () => {
    for (const p of ['/', '/swap.html', '/keys.html', '/inspections.html', '/bonfires.html', '/committee.html', '/water.html', '/hire/index.html', '/faq.html', '/compost.html', '/leaves.html', '/wardens.html', '/join.html']) {
      expect(failed(p), p).toEqual([]);
      expect(doubts(p), p).toEqual([]);
    }
  });

  it('the in-page reader reads words as topicWords does (endings, accents and stop words)', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${server.origin}/rebates.html`);
      const probe = ['Board Meeting Calendar', 'Employment Opportunities', 'Café menus and prices', 'The official home page of our site', 'Classes, passes and glasses', 'Planning and zoning hearings'];
      const read = await page.evaluate(readTitle, { stop: TITLE_STOP_WORDS, nodes: TITLE_LIMITS.nodes, chars: TITLE_LIMITS.chars, probe });
      expect([...new Set(read.probed)].sort()).toEqual([...new Set(probe.flatMap((t) => [...topicWords(t)]))].sort());
    } finally {
      await page.close();
    }
  });
});
