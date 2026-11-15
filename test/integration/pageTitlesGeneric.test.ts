// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 17's fix round (structure lane), the lead's ruling (c): a generic title ("Home", "Welcome"…) or the site's name
// alone fails 2.4.2 (F25) only where the site's own pages demonstrate it, in real Chromium over
// test/fixtures/titles-generic/ (written for this test):
// (A) a page that is not the home page, titled with a generic word and the site's name, whose own level-1 heading, in
//     text, names something else; (B) the site's name alone on two or more pages that are not the home page, headed
//     otherwise. A heading that is a picture, a heading that is not level 1, a home page in another language and a
//     heading that names the site keep the one-page "Home" doubt, or nothing.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageTitlesProbe, type TitleData } from '../../src/probes/pageTitles.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let runs: ProbeRun[];
const PAGES = ['/', '/events.html', '/hours.html', '/rooms.html', '/visit.html', '/es/index.html', '/kids.html', '/teens.html', '/catalogue.html', '/cards.html', '/side.html'];

beforeAll(async () => {
  server = await startFixtureServer('titles-generic');
  browser = await chromium.launch();
  runs = await runProbes(browser as unknown as BrowserLike, PAGES.map((p, index) => ({ url: `${server.origin}${p}`, index })), [pageTitlesProbe], { userAgent: 'grnted-test' });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const on = (path: string) => runs.find((r) => new URL(r.page).pathname === path)!;
const status = (path: string) => on(path).findings.filter((f) => f.criterion === '2.4.2' && (f.status === 'failed' || f.status === 'not_testable')).map((f) => f.status);

describe('2.4.2: a generic title or the site\'s name alone, demonstrated by the site\'s pages (ruling c)', () => {
  it('reads whether the main heading is a level-1 heading with text of its own', () => {
    expect(runs.map((r) => [new URL(r.page).pathname, r.status])).toEqual(PAGES.map((p) => [p, 'ok']));
    const data = (p: string) => on(p).data as TitleData;
    expect([data('/events.html').h1, data('/events.html').h1top, data('/events.html').h1text]).toEqual(['Story time and events', true, true]);
    // A heading that is a picture: its text is the image's alternative.
    expect([data('/rooms.html').h1, data('/rooms.html').h1top, data('/rooms.html').h1text]).toEqual(['Meeting rooms', true, false]);
    // No level-1 heading: the first heading of another level.
    expect([data('/side.html').h1, data('/side.html').h1top]).toEqual(['Quick links', false]);
  });

  it('(A) fails "Home" and the site\'s name, and "Welcome" alone, on pages that are not the home page and whose heading names something else; the page\'s own "Home" doubt goes', () => {
    expect(status('/events.html')).toEqual(['failed']);
    expect(on('/events.html').findings.find((f) => f.status === 'failed')!.detail).toBe('The page\'s title, “Home | Cedar Hollow Library”, does not describe the page: it is the word “Home” and the site\'s name, while this is not the home page (/events.html) and its main heading, “Story time and events”, names what it is about.');
    expect(status('/hours.html')).toEqual(['failed']);
  });

  it('(B) fails the site\'s name alone on two pages that are not the home page, headed otherwise', () => {
    expect(status('/kids.html')).toEqual(['failed']);
    expect(status('/teens.html')).toEqual(['failed']);
  });

  it('look-alikes: a heading that is a picture, a heading that is not level 1, a home page in another language keep the one-page doubt; a heading that names the site, the home page and pages titled in their own words have nothing', () => {
    expect(status('/rooms.html')).toEqual(['not_testable']);
    expect(status('/side.html')).toEqual(['not_testable']);
    expect(status('/es/index.html')).toEqual(['not_testable']);
    for (const p of ['/', '/visit.html', '/catalogue.html', '/cards.html']) expect(status(p), p).toEqual([]);
  });
});
