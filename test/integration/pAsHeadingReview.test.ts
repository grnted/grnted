// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 1.3.1 (F2) and axe's experimental p-as-heading (scoring v11.2.1, Granted 0.2.1; the lead's ruling of 2026-11-12): the
// rule still runs, but a paragraph it fails is listed for review (axe's "needs review", the report's "undecided by the
// rules"), never a failure and never in the score (`AXE_REVIEW_ONLY` in src/axeRun.ts). A notice set in bold, date
// lines and figures failed it on live sites and are not headings. A section title the page itself proves is one still
// fails 1.3.1, through the headings test. Fixtures: test/fixtures/p-as-heading/ (written for this test).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headingsProbe } from '../../src/probes/headings.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer('p-as-heading');
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const scan = (file: string): Promise<SiteReport> =>
  scanSite(`${server.origin}/${file}`, { browser: browser as unknown as BrowserLike, maxPages: 1, probes: [headingsProbe], documents: false });
const status = (r: SiteReport, criterion: string) => r.criteria?.find((c) => c.criterion === criterion)?.status;
/** The elements a rule's needs-review result lists (their HTML). */
const reviewed = (r: SiteReport, id: string) => r.needsReview.filter((x) => x.id === id).flatMap((x) => x.examples.map((e) => e.html));

describe('axe p-as-heading proves nothing alone: what it fails is listed for review, unscored', () => {
  // Each look-alike is placed where axe itself fails it, or the test proves nothing: bold and at least 1.15 times the
  // size of the paragraph after it (axe's weight+size margin; 18px bold over 16px text passes the rule), and not
  // right under a heading (such a line is the heading's subtitle and is cleared before any review: subtitleNotHeading).
  const LOOK_ALIKES = [
    ['bold-notice.html', 'a notice set in bold and larger ("The office will be closed on Friday…")', 'class="notice"'],
    ['date-lines.html', 'date lines set in bold over news items', 'class="date"'],
    ['figures.html', 'figures set in bold and large over what they count', 'class="figure"'],
  ] as const;
  for (const [file, what, marked] of LOOK_ALIKES) {
    it(`${what}: listed for review, no 1.3.1 failure, 100`, async () => {
      const r = await scan(file);
      // The rule ran and found the paragraph (the look-alike is not empty), and it is listed, not failed.
      const listed = reviewed(r, 'p-as-heading');
      expect(listed.length, JSON.stringify(r.needsReview.map((x) => x.id))).toBeGreaterThan(0);
      expect(listed.some((html) => html.includes(marked)), JSON.stringify(listed)).toBe(true);
      expect(r.needsReview.find((x) => x.id === 'p-as-heading')!.pointsLost).toBe(0);
      expect(r.rules.map((x) => x.id)).not.toContain('p-as-heading');
      expect(status(r, '1.3.1')).not.toBe('failed');
      expect(r.score).toBe(100);
    }, 90_000);
  }

  it('a paragraph set exactly like the page\'s real h2s still fails 1.3.1, through the headings test (scored)', async () => {
    const r = await scan('styled-heading.html');
    expect(r.rules.map((x) => x.id)).not.toContain('p-as-heading');
    const c = r.criteria?.find((x) => x.criterion === '1.3.1');
    expect(c?.status).toBe('failed');
    const failedBy = (c?.methods ?? []).filter((m) => m.status === 'failed').map((m) => m.id);
    expect(failedBy).toContain('headings');
    expect(failedBy).not.toContain('axe');
    expect(c?.evidence.some((e) => /Water service/.test(e.detail))).toBe(true);
    expect(r.score!).toBeLessThan(100);
  }, 90_000);
});
