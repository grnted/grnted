// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Page titles that cannot describe their page (2.4.2, F25) in real Chromium, over test/fixtures/titles/.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageTitlesProbe } from '../../src/probes/pageTitles.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let runs: ProbeRun[];
const PAGES = ['/', '/plots.html', '/tools.html', '/draft.html', '/compost.html', '/wardens.html', '/swap.html', '/news.html', '/news2.html', '/contact.html', '/directory.html', '/agendas.html', '/archive.html'];

beforeAll(async () => {
  server = await startFixtureServer('titles');
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

describe('2.4.2: titles that cannot describe their page', () => {
  it('every page ran', () => {
    expect(runs.map((r) => [new URL(r.page).pathname, r.status])).toEqual(PAGES.map((p) => [p, 'ok']));
  });
  it('fails only the definite cases: a placeholder, a file name that describes nothing, and (since batch 17\'s fix round) "Home" on an inner page whose heading names something else', () => {
    expect(failed('/draft.html')).toEqual(['The page\'s title is “Untitled Document”, which says nothing about the page (its main heading is “Water butts and hoses”).']);
    expect(failed('/archive.html')).toEqual(['The page\'s title is “index.html”, a file name that says nothing about the page (its main heading is “Archive of old notices”).']);
    // The lead's ruling (c): a generic title on a page that is not the home page fails where the site's pages demonstrate
    // it (the page's own level-1 heading names something else); the one-page doubt gives way to it.
    expect(failed('/tools.html')).toEqual(['The page\'s title, “Home”, does not describe the page: it is the word “Home”, while this is not the home page (/tools.html) and its main heading, “Tool shed”, names what it is about.']);
    expect(PAGES.filter((p) => failed(p).length)).toEqual(['/tools.html', '/draft.html', '/archive.html']);
  });
  // Review r1, findings 9 and 10, and the ruling: the rest are doubts for a person (or the AI review), never failures.
  it('raises a doubt, not a failure: the site name alone on one inner page (it may be a landing page about the site itself)', () => {
    expect(doubts('/plots.html')).toEqual(['The page\'s title, “Marsh Lane Allotments”, is also the title of another scanned page about something else (/: “Marsh Lane Allotments”), and it shares no word with this page\'s main heading, “Plot rents”; whether it describes this page is for a person to judge.']);
    expect(doubts('/tools.html')).toEqual([]);
    expect(PAGES.filter((p) => doubts(p).length)).toEqual(['/plots.html']);
  });
  it('look-alikes with no finding at all: a title that is another page\'s main heading ("Contact" beside a directory headed "Contact"; "Seed swap day"), a descriptive file name, titles in other words, a list and its second page', () => {
    for (const p of ['/', '/contact.html', '/directory.html', '/compost.html', '/agendas.html', '/wardens.html', '/swap.html', '/news.html', '/news2.html']) {
      expect(failed(p), p).toEqual([]);
      expect(doubts(p), p).toEqual([]);
    }
  });
});
