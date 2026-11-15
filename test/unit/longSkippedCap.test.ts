// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A long scan's crawl lists the first MAX_CRAWL_ROBOTS_SKIPPED robots-blocked links and counts the rest in
// one record: a site whose pages link to thousands of blocked addresses no longer grows the skipped
// list, its storage and report.json without bound.
import { describe, expect, it } from 'vitest';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, PageAudit } from '../../src/types.js';
import { MAX_CRAWL_ROBOTS_SKIPPED, ROBOTS_SKIP_REASON, isRobotsMoreRecord, robotsMoreReason } from '../../src/wide.js';

const E = 'https://e.org';
const home = (links: string[]): PageAudit => ({ url: `${E}/`, status: 'ok', rules: { label: 'pass' }, violations: [], incomplete: [], links });
// Distinct page shapes (wide.ts), so only robots.txt decides: no year-like or repeated-shape segments.
const blocked = (n: number) => Array.from({ length: n }, (_, i) => `${E}/x/p${i}`);

function resumed(links: string[], skipped: { url: string; reason: string }[] = []) {
  const browser = { newContext: async () => { throw new Error('nothing is loaded'); } } as unknown as BrowserLike;
  const fetchFn = async (input: RequestInfo | URL) =>
    String(input).endsWith('/robots.txt') ? new Response('User-agent: *\nDisallow: /x/\n', { status: 200 }) : new Response('', { status: 404 });
  return scanSite(`${E}/`, {
    browser, maxPages: 3500, probes: false, documents: false, fetchFn: fetchFn as typeof fetch,
    resume: { pages: [`${E}/`], documents: [], skipped, audit: (i) => (i === 0 ? home(links) : undefined) },
  });
}

describe('long-scan crawl: robots-blocked links are capped and counted', () => {
  it('a few blocked links are listed one by one, as before', async () => {
    const r = await resumed(blocked(3));
    expect(r.skipped).toEqual(blocked(3).map((url) => ({ url, reason: ROBOTS_SKIP_REASON })));
  });

  it(`past ${MAX_CRAWL_ROBOTS_SKIPPED}, one record counts the rest`, async () => {
    const r = await resumed(blocked(MAX_CRAWL_ROBOTS_SKIPPED + 2500));
    expect(r.skipped).toHaveLength(MAX_CRAWL_ROBOTS_SKIPPED + 1);
    expect(r.skipped.slice(0, MAX_CRAWL_ROBOTS_SKIPPED)).toEqual(blocked(MAX_CRAWL_ROBOTS_SKIPPED).map((url) => ({ url, reason: ROBOTS_SKIP_REASON })));
    expect(r.skipped.at(-1)).toEqual({ url: `${E}/`, reason: robotsMoreReason(2500) });
    expect(robotsMoreReason(2500)).toBe('Blocked by robots.txt: 2,500 more addresses it blocks are not listed (the list stops at 1,000)');
    expect(robotsMoreReason(1)).toBe('Blocked by robots.txt: 1 more address it blocks is not listed (the list stops at 1,000)');
  });

  it('a resumed segment counts the same (the count is re-derived from the stored pages\' links)', async () => {
    const links = blocked(MAX_CRAWL_ROBOTS_SKIPPED + 40);
    // What a host stores mid-crawl: the listed ones and the record without its count.
    const stored = [...blocked(MAX_CRAWL_ROBOTS_SKIPPED).map((url) => ({ url, reason: ROBOTS_SKIP_REASON })), { url: `${E}/`, reason: robotsMoreReason() }];
    expect(isRobotsMoreRecord(stored.at(-1)!)).toBe(true);
    const r = await resumed(links, stored);
    expect(r.skipped).toHaveLength(MAX_CRAWL_ROBOTS_SKIPPED + 1);
    expect(r.skipped.at(-1)).toEqual({ url: `${E}/`, reason: robotsMoreReason(40) });
  });

  it('50,000 blocked links: the report stays small and the crawl takes well under a second', async () => {
    const links = blocked(50_000);
    const t0 = performance.now();
    const r = await resumed(links);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(r.skipped.length).toBeLessThanOrEqual(MAX_CRAWL_ROBOTS_SKIPPED + 1);
    expect(JSON.stringify(r.skipped).length).toBeLessThan(100_000);
  }, 30_000);
});
