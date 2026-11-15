// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The browser closing in the middle of a scan (a hosted Browser Rendering session that ended, a
// browser process that died). With a host that opens a new one (`reconnectingBrowser`) the scan
// redoes what was lost and gives the same report as a scan where nothing happened; when no new one
// can be had, it gives no score, never a score without the lost work. Fixture: test/fixtures/site/.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconnectingBrowser, type BrowserHandle } from '../../src/reconnect.js';
import { scanSite, type ScanOptions } from '../../src/scan.js';
import type { BrowserLike, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let server: Awaited<ReturnType<typeof startFixtureServer>>;
let clean: SiteReport;
/** A larger site with server latency, scanned as the hosted checker does: every page gated (allowUrl), 4 at once. */
let hosted: Awaited<ReturnType<typeof startFixtureServer>>;
const HOSTED: Partial<ScanOptions> = { allowUrl: async () => true, concurrency: 4, maxPages: 8 };
let hostedClean: SiteReport;
const opened: Browser[] = [];

const launch = async (): Promise<BrowserHandle> => {
  const b = await chromium.launch();
  opened.push(b);
  return { browser: b, close: () => b.close() };
};

/** What the score is made of: the score, each failing rule's and core test criterion's pages. */
const scored = (r: SiteReport) => ({
  status: r.status, score: r.score,
  rules: r.rules.map((x) => [x.id, x.pagesAffected.map((u) => new URL(u).pathname)]),
  tests: (r.testIssues ?? []).map((t) => [t.criterion, t.pagesAffected.map((u) => new URL(u).pathname), t.pointsLost]),
});

/**
 * A scan whose first browser closes 150 ms after the `nth` new context opened in it (work is then
 * running in that browser). `reopen`: whether a new browser can be opened.
 */
async function scanWithLoss(nth: number, reopen: boolean, site: { origin: string; opts?: Partial<ScanOptions> } = { origin: '' }): Promise<{ report: SiteReport; reopened: number }> {
  const first = await launch();
  const b = first.browser as Browser;
  let contexts = 0;
  const original = b.newContext.bind(b);
  b.newContext = (async (o?: Parameters<Browser['newContext']>[0]) => {
    const ctx = await original(o);
    if (++contexts === nth) setTimeout(() => void b.close().catch(() => {}), 150);
    return ctx;
  }) as Browser['newContext'];
  const r = reconnectingBrowser(first, launch, { maxReopens: reopen ? 2 : 0 });
  try {
    const report = await scanSite(`${site.origin || server.origin}/`, { browser: r.browser as unknown as BrowserLike, maxPages: 10, ...site.opts });
    return { report, reopened: r.reopened() };
  } finally {
    await r.close();
  }
}

beforeAll(async () => {
  server = await startFixtureServer();
  hosted = await startFixtureServer('timing', {}, { delayMs: (path) => (path.endsWith('.html') || path.endsWith('/') ? 300 : 0) });
  const b = await launch();
  clean = await scanSite(`${server.origin}/`, { browser: b.browser as unknown as BrowserLike, maxPages: 10 });
  hostedClean = await scanSite(`${hosted.origin}/`, { browser: b.browser as unknown as BrowserLike, ...HOSTED });
}, 240_000);

afterAll(async () => {
  await Promise.all(opened.map((b) => b.close().catch(() => {})));
  await server?.close();
  await hosted?.close();
});

describe('the browser closing during a scan', () => {
  it('a scan that gets a new browser redoes the lost work: the same report as when nothing happened', async () => {
    expect(clean.status).toBe('scored');
    // Closed while the audit runs (the 3rd context) and while the core tests run (the 12th).
    for (const nth of [3, 12]) {
      const { report, reopened } = await scanWithLoss(nth, true);
      expect(reopened, `nth=${nth}`).toBe(1);
      expect(scored(report), `nth=${nth}`).toEqual(scored(clean));
    }
  }, 240_000);

  it('a scan that cannot get a new browser gives no score, and says why', async () => {
    for (const nth of [3, 12]) {
      const { report } = await scanWithLoss(nth, false);
      expect(report.status, `nth=${nth}`).toBe('incomplete');
      expect(report.score).toBeNull();
      expect(report.reasons[0]).toMatch(/^The browser the scan ran in closed, and .* could not be redone in a new one, so no score is given/);
    }
  }, 240_000);

  it('on a gated scan (as hosted), pages whose audit the browser closed under are audited again, not taken as refused', async () => {
    // The 9th context: discovery's, then 4 pages at both widths, all in flight (300 ms per page).
    expect(hostedClean.status).toBe('scored');
    const { report, reopened } = await scanWithLoss(9, true, { origin: hosted.origin, opts: HOSTED });
    expect(reopened).toBe(1);
    expect(report.pages.filter((p) => p.status !== 'ok').map((p) => p.reason)).toEqual([]);
    expect(scored(report)).toEqual(scored(hostedClean));
    // With no new browser: no score, never one without the pages that were open.
    const lost = await scanWithLoss(9, false, { origin: hosted.origin, opts: HOSTED });
    expect(lost.report.status).toBe('incomplete');
    expect(lost.report.reasons[0]).toMatch(/^The browser the scan ran in closed/);
  }, 300_000);
});
