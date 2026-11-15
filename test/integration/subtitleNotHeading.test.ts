// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 1.3.1 (F2) through axe's p-as-heading: a bold or larger line right under a real heading is that heading's
// subtitle (a tagline, a date line), not a section heading with no markup. Bold paragraphs that head their own
// sections still fail. Fixtures: test/fixtures/strict-4/axe-subtitle.html (written for this test) and the
// existing bold-paragraph page.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer('strict-4');
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('a styled line right under a real heading is its subtitle, not a heading', () => {
  it('a tagline under the h1, a date line under an h2 and a subtitle in the block after a heading do not fail p-as-heading', async () => {
    const r = await scanSite(`${server.origin}/axe-subtitle.html`, { browser: browser as unknown as BrowserLike, maxPages: 1, probes: false, documents: false });
    expect(r.rules.map((x) => x.id)).not.toContain('p-as-heading');
    expect(r.score).toBe(100);
  }, 60_000);

  it('bold paragraphs that head their own sections are still flagged (listed for review since batch 17)', async () => {
    const r = await scanSite(`${server.origin}/axe-r3-bold-p.html`, { browser: browser as unknown as BrowserLike, maxPages: 1, probes: false, documents: false });
    expect(r.needsReview.map((x) => x.id)).toContain('p-as-heading');
  }, 60_000);
});
