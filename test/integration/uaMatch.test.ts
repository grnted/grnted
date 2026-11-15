// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// P1 (2026-11-06): every page of a WordPress.com site (Automattic's bot shield) answered 403, in production
// and from a home address. The scan's User-Agent hard-coded Chrome/141 while the browser (Chromium 149
// here, whatever Browser Rendering runs there) sends its own version in its client hints (Sec-CH-UA,
// navigator.userAgentData): a disguised bot to the shield. The scan now sends the browser's own user agent
// with Granted's token appended, on every page and every plain fetch, and the report says so.
// The fixture (test/helpers/uaShieldSite.ts) refuses a User-Agent that disagrees with the client hints.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { quietBrowser } from '../../src/analytics.js';
import { BROWSER_ARGS } from '../../src/browserArgs.js';
import { reconnectingBrowser } from '../../src/reconnect.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike } from '../../src/types.js';
import { DEFAULT_USER_AGENT, ENGINE_VERSION } from '../../src/version.js';
import { claimedChrome, startUaShieldSite, type UaShieldSite } from '../helpers/uaShieldSite.js';

const TOKEN = `grnted/${ENGINE_VERSION} (grnted.co)`;
let browser: Browser;
let site: UaShieldSite;

beforeAll(async () => {
  browser = await chromium.launch({ args: [...BROWSER_ARGS] });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

/** What one context sends to the shield with this User-Agent (undefined: the browser's own). */
async function load(userAgent: string | undefined): Promise<number> {
  const s = await startUaShieldSite();
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }, ...(userAgent ? { userAgent } : {}) });
  try {
    const res = await (await ctx.newPage()).goto(`${s.origin}/`);
    return res?.status() ?? 0;
  } finally {
    await ctx.close();
    await s.close();
  }
}

describe('the scan presents the browser\'s own identity, with the grnted token', () => {
  it('the fixture refuses what the shield refused and serves what it served (the lead\'s maplesvenson.com results)', async () => {
    const own = (await (await browser.newBrowserCDPSession()).send('Browser.getVersion')).userAgent;
    const results = {
      'hard-coded Chrome/141 + token': await load(DEFAULT_USER_AGENT),
      'browser\'s own + token': await load(`${own} ${TOKEN}`),
      'own, HeadlessChrome renamed Chrome, + token': await load(`${own.replace('HeadlessChrome', 'Chrome')} ${TOKEN}`),
      'browser\'s own, no override': await load(undefined),
    };
    console.log(`ua shield fixture (Chromium ${browser.version()}): ${JSON.stringify(results)}`);
    expect(results['hard-coded Chrome/141 + token']).toBe(403);
    expect(results['browser\'s own + token']).toBe(200);
    // Same version, but the client hints still carry the HeadlessChrome brand: a disagreement too.
    expect(results['own, HeadlessChrome renamed Chrome, + token']).toBe(403);
    expect(results['browser\'s own, no override']).toBe(200);
  });

  for (const [name, wrap] of [
    // As the CLI and the gold harness scan: the analytics-quiet browser.
    ['local browser', (b: Browser) => quietBrowser(b as unknown as BrowserLike)],
    // As the CLI scans: a browser that is replaced when lost (src/reconnect.ts).
    ['reconnecting browser', (b: Browser) => quietBrowser(reconnectingBrowser({ browser: b, close: async () => {} }, async () => ({ browser: b, close: async () => {} })).browser as unknown as BrowserLike)],
  ] as const) {
    it(`a real scan (${name}) is served every page, with one User-Agent on every load and fetch, named in the report`, async () => {
      site = await startUaShieldSite();
      try {
        const report = await scanSite(`${site.origin}/`, { browser: wrap(browser), maxPages: 5, concurrency: 2 });
        const hits = site.hits();
        const refused = hits.filter((h) => h.status === 403);
        expect(refused, 'refused by the shield').toEqual([]);
        expect(report.pages.map((p) => [p.url.replace(site.origin, ''), p.status])).toEqual([['/', 'ok'], ['/about.html', 'ok']]);
        // One identity: browser loads (with client hints) and plain fetches (robots.txt, sitemap) alike.
        const agents = [...new Set(hits.map((h) => h.ua))];
        expect(agents).toHaveLength(1);
        const ua = agents[0]!;
        expect(hits.some((h) => !h.hints && h.path === '/robots.txt'), 'robots.txt was fetched').toBe(true);
        expect(hits.some((h) => h.hints), 'pages were loaded by the browser').toBe(true);
        expect(ua.endsWith(TOKEN)).toBe(true);
        expect(claimedChrome(ua)?.major).toBe(Number(browser.version().split('.')[0]));
        expect(report.meta.userAgent).toBe(ua);
      } finally {
        await site.close();
      }
    }, 120_000);
  }
});
