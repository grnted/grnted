// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The picture test through a whole scan (public API only: scanSite and the report), on a small site written for it:
// a notice that is an SVG picture of its words (1.4.5), a drop-off map whose alt text is "Map" (1.1.1), and a page
// with a photo only. Red before batch 17 (1.4.5 had no test without the AI review; "Map" passed every rule).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probesFor } from '../../src/probes/registry.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let report: SiteReport;
let without: SiteReport;
const row = (r: SiteReport, c: string) => r.criteria!.find((x) => x.criterion === c)!;

beforeAll(async () => {
  server = await startFixtureServer('picture-text');
  browser = await chromium.launch();
  report = await scanSite(`${server.origin}/`, { browser: browser as unknown as BrowserLike, maxPages: 3, concurrency: 2, documents: false });
  without = await scanSite(`${server.origin}/`, { browser: browser as unknown as BrowserLike, maxPages: 3, concurrency: 2, documents: false, probes: probesFor().filter((p) => p.id !== 'picture-text') });
}, 240_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('a scan with SVG pictures of words (no AI review)', () => {
  // Batch 17 (the lead's ruling after the cut round's review): the picture test's failures are listed for a person to
  // check (flagged, Needs review), with their evidence, never failed.
  it('1.4.5 is flagged for review for the notice picture, with the element, the words and the picture test as its method', () => {
    const r = row(report, '1.4.5');
    expect(r.status).toBe('flagged');
    expect(r.methods.map((m) => [m.id, m.status])).toEqual([['picture-text', 'flagged'], ['ai', 'not_testable']]);
    expect(r.evidence).toEqual([{
      page: `${server.origin}/`, target: '#notice',
      detail: 'For a person to check: The picture is text and nothing else: an SVG file that draws 4 lines of words on a plain ground (“Family packet pickup · Friday, November 13 · 1–3 p.m. · Alder Draw office, room 4 · Use the west garden gate.”). As a picture, the words cannot be restyled, re-spaced or reflowed by the reader',
    }]);
  });

  it('1.1.1 is flagged for review for the map whose alt text only says "Map", on its page only', () => {
    const r = row(report, '1.1.1');
    expect(r.status).toBe('flagged');
    expect(r.methods.find((m) => m.id === 'picture-text')).toMatchObject({ status: 'flagged' });
    expect(r.evidence.filter((e) => e.target === '#map')).toEqual([{
      page: `${server.origin}/map.html`, target: '#map',
      detail: 'For a person to check: The picture\'s text alternative (“Map”) only says what kind of picture it is, and the picture draws words that neither it nor the page\'s text gives: “SOUTH LOT · KISS AND GO · Drive past the flagpole and stop only at the yellow kerb.”',
    }]);
  });

  it('the picture test ran on every page, and its findings are flagged for review, never failed or scored', () => {
    const runs = (report.probes?.runs ?? []).filter((x) => x.probe === 'picture-text');
    expect(runs.map((x) => new URL(x.page).pathname).sort()).toEqual(['/', '/map.html', '/photos.html']);
    expect(runs.flatMap((x) => x.findings.filter((f) => f.status === 'failed'))).toEqual([]);
    const flagged = runs.flatMap((x) => x.findings.filter((f) => f.status === 'flagged').map((f) => `${new URL(x.page).pathname} ${f.criterion} ${f.target}`)).sort();
    expect(flagged).toEqual(['/ 1.4.5 #notice', '/map.html 1.1.1 #map']);
    // The page with a photo only: nothing for this test to read.
    expect(runs.find((x) => x.page.endsWith('/photos.html'))!.findings.map((f) => [f.criterion, f.status, f.detail]))
      .toEqual([['1.1.1', 'not_applicable', 'no picture on this page is an SVG file'], ['1.4.5', 'not_applicable', 'no picture on this page is an SVG file']]);
    // Listed, not scored: neither criterion is among the scored test problems, and the score is the one the site has
    // without the picture test (the same scan with it left out).
    expect((report.testIssues ?? []).filter((t) => t.criterion === '1.4.5' || t.criterion === '1.1.1')).toEqual([]);
    expect(report.score).toBe(without.score);
  });
});

describe('a scan with bitmap pictures only (no AI review)', () => {
  it('1.4.5 still reads "needs the AI review": the picture test read no picture, and says so', async () => {
    const r = await scanSite(`${server.origin}/photos.html`, { browser: browser as unknown as BrowserLike, maxPages: 1, documents: false });
    const c = row(r, '1.4.5');
    expect(c.status).toBe('not_testable');
    expect(c.methods).toEqual([
      { id: 'picture-text', kind: 'render', status: 'not_applicable', pages: 1, note: 'no picture on this page is an SVG file' },
      { id: 'ai', kind: 'ai', status: 'not_testable', pages: 0, note: 'needs the AI review, which was not run in this scan' },
    ]);
  }, 120_000);
});
