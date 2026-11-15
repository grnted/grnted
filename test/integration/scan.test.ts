// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { criterionScore, reportCriterionChecks } from '../../src/criterionScore.js';
import { roundScore } from '../../src/score.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let report: SiteReport;
// The AI review is the closed AI package's (its own suite scans this fixture site with it: scanAi.test.ts).

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await chromium.launch();
  report = await scanSite(`${server.origin}/`, {
    browser: browser as unknown as BrowserLike, maxPages: 10,
  });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('scanSite against the fixture site', () => {
  it('scans the linked pages, skipping robots-blocked and off-site ones', () => {
    const urls = report.pages.map((p) => new URL(p.url).pathname);
    expect(urls).toEqual(['/', '/bad.html', '/form.html']);
    expect(report.skipped.map((s) => new URL(s.url).pathname)).toEqual(['/private.html']);
  });
  it('inventories documents', () => {
    expect(report.documents.map((d) => new URL(d).pathname)).toEqual(['/board.pdf']);
  });
  it('scores the clean page 100', () => {
    expect(report.pages[0]!.score).toBe(100);
  });
  it('finds the planted problems on the right pages', () => {
    const byId = Object.fromEntries(report.rules.map((r) => [r.id, r.pagesAffected.map((u) => new URL(u).pathname)]));
    expect(byId['image-alt']).toEqual(['/bad.html']);
    expect(byId['color-contrast']).toEqual(['/bad.html']);
    expect(byId['link-name']).toEqual(['/bad.html']);
    expect(byId['label']).toEqual(['/form.html']);
  });
  it('produces a scored, denied report with critical failures', () => {
    expect(report.status).toBe('scored');
    expect(report.headline).toBe('Access Denied');
    expect(report.rules.find((r) => r.id === 'image-alt')?.impact).toBe('critical');
    // No cap: the score is 100 − 18 × ln(1 + total ÷ 10) over the failing checks, by criterion (scoring
    // v8), recomputed here from the report's own lists: its axe rules, test criteria and (v8) the
    // cross-page rules the small fixture fails.
    const checks = reportCriterionChecks(report)!;
    expect(new Set(checks.map((c) => c.key))).toEqual(new Set([...report.rules.map((r) => `rule:${r.id}`), ...(report.testIssues ?? []).map((t) => `criterion:${t.criterion}`), ...checks.filter((c) => c.key.startsWith('consistency:')).map((c) => c.key)]));
    expect(report.score).toBe(roundScore(criterionScore(checks)));
    expect(report.score).toBe(76);
    // The keyboard test's failure on the planted page is scored, with its own points. Batch 19 (the lead's ruling): a
    // focus stop hidden when focused is filed under 2.4.7 (it was 2.4.3).
    expect(report.testIssues?.map((t) => [t.criterion, t.pagesAffected.map((u) => new URL(u).pathname), t.pointsLost])).toEqual([['2.4.7', ['/bad.html'], 1]]);
  });
  it('is reproducible: a one-page-at-a-time rescan matches the concurrent scan', async () => {
    const again = await scanSite(`${server.origin}/`, { browser: browser as unknown as BrowserLike, maxPages: 10, concurrency: 1 });
    expect(again.pages.map((p) => [p.url, p.score, p.violations])).toEqual(report.pages.map((p) => [p.url, p.score, p.violations]));
    expect(again.score).toBe(report.score);
    expect(again.rules.map((r) => [r.id, r.elements, r.pointsLost])).toEqual(report.rules.map((r) => [r.id, r.elements, r.pointsLost]));
  }, 120_000);
});
