// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A page whose browser closed under its audit and that could not be checked again gives the scan no
// score, at every size: a score without the page could be higher than the site's (scoring v7 keeps
// the strict rule; the hosted long scan re-checks such a page in fresh sessions before the core tests).
import { describe, expect, it } from 'vitest';
import * as report from '../../src/report/build.js';
import { buildReport } from '../../src/report/build.js';
import { BROWSER_CLOSED_PAGE, BROWSER_LOST_PAGE } from '../../src/reconnect.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, PageAudit, ProbeRun } from '../../src/types.js';

const E = 'https://e.org';
const ok = (url: string): PageAudit => ({ url, status: 'ok', rules: { label: 'pass', 'image-alt': 'pass' }, violations: [], incomplete: [], links: [] });
const lost = (url: string, reason = BROWSER_LOST_PAGE): PageAudit => ({ url, status: 'failed', reason, rules: {}, violations: [], incomplete: [], links: [] });
const urls = (n: number) => Array.from({ length: n }, (_, i) => (i ? `${E}/p${i}` : `${E}/`));
const build = (pages: PageAudit[], opts: { probeRuns?: ProbeRun[] } = {}) =>
  buildReport({ site: `${E}/`, pages, documents: [], skipped: [], startedAt: '', finishedAt: '', userAgent: 'UA', ...opts });

const resumed = (n: number, lostAt: number[], reason = BROWSER_LOST_PAGE) => {
  const list = urls(n);
  const browser = { newContext: async () => { throw new Error('nothing is loaded'); } } as unknown as BrowserLike;
  return scanSite(`${E}/`, {
    browser, maxPages: n, probes: false, documents: false, fetchFn: async () => new Response('', { status: 404 }),
    resume: { pages: list, documents: [], skipped: [], audit: (i) => (i < n ? (lostAt.includes(i) ? lost(list[i]!, reason) : ok(list[i]!)) : undefined) },
  });
};

describe('lost pages', () => {
  it('the 25-page rule: one lost page and the scan has no score, the reason first', () => {
    const r = build(urls(25).map((u, i) => (i === 12 ? lost(u) : ok(u))));
    expect(r.status).toBe('incomplete');
    expect(r.reasons[0]).toMatch(/^The browser the scan ran in closed, and 1 page could not be redone/);
  });

  it('simplify: a 3,500-page scan with one page lost has no score either (no share exception, no worst case)', async () => {
    const r = await resumed(3500, [1700]);
    expect(r.status).toBe('incomplete');
    expect(r.score).toBeNull();
    expect(r.pages[1700]).toMatchObject({ status: 'failed', reason: BROWSER_LOST_PAGE });
    // The exception's names are gone from the engine.
    expect('LOST_PAGES_MAX_SHARE' in report).toBe(false);
    expect('LOST_EVERY_TRY' in report).toBe(false);
  });

  it('simplify: a page whose browser closed and that was not checked again is lost too: no score, said plainly', async () => {
    expect(BROWSER_CLOSED_PAGE).toBe('the browser closed while this page was checked');
    expect(BROWSER_LOST_PAGE).toBe(`${BROWSER_CLOSED_PAGE} and it could not be checked again`);
    const r = await resumed(300, [40], BROWSER_CLOSED_PAGE);
    expect(r.status).toBe('incomplete');
    expect(r.pages[40]!.reason).toBe(BROWSER_CLOSED_PAGE);
    expect(build(urls(25).map((u, i) => (i === 3 ? lost(u, BROWSER_CLOSED_PAGE) : ok(u)))).status).toBe('incomplete');
  });

  it('a scan whose scored core-test run lost its browser has no score, with no lost page', () => {
    const run: ProbeRun = { probe: 'headings', kind: 'render', page: `${E}/p3`, criteria: ['1.3.1'], status: 'ok', findings: [{ criterion: '1.3.1', status: 'not_testable', detail: 'the browser closed while this test ran and it could not be run again, so the scan has no result for it', loadFailure: 'browser-lost' }], ms: 1 } as ProbeRun;
    expect(build(urls(300).map(ok), { probeRuns: [run] }).status).toBe('incomplete');
  });
});
