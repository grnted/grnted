// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The probes' instant scrolling (motionShared.ts) in real Chromium, on a page with
// `scroll-behavior: smooth` on html and body: a scroll the test makes lands at once, the page's own
// smooth scrolling comes back afterwards, and settleScroll waits for the window to stand still.
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCROLL_SETTLE_MS, instantScrollStart, instantScrollStop, settleScroll } from '../../src/probes/motionShared.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let page: Page;
beforeAll(async () => {
  server = await startFixtureServer('motion');
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${server.origin}/smooth-scroll-text.html`);
}, 30_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

describe('instant scrolling on a smooth-scrolling page', () => {
  it('the page scrolls smoothly by itself (the hazard): a plain scrollTo has not arrived right away', async () => {
    const y = await page.evaluate(() => { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); window.scrollTo(0, 3000); return scrollY; });
    expect(y).toBeLessThan(3000);
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
  });

  it('while on, plain scrolls are instant; afterwards the page scrolls smoothly again, its styles as they were', async () => {
    const before = await page.evaluate(() => [document.documentElement.getAttribute('style'), document.body.getAttribute('style')]);
    await page.evaluate(instantScrollStart, undefined);
    await page.evaluate(instantScrollStart, undefined);
    const y = await page.evaluate(() => { window.scrollTo(0, 3000); return scrollY; });
    expect(y).toBe(3000);
    const into = await page.evaluate(() => { document.querySelector('footer')!.scrollIntoView({ block: 'center' }); return scrollY; });
    expect(into).toBeGreaterThan(3000);
    // Nested: one stop leaves it on.
    await page.evaluate(instantScrollStop, undefined);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
    await page.evaluate(instantScrollStop, undefined);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('smooth');
    expect(await page.evaluate(() => document.querySelectorAll('style[data-grnted-instant-scroll]').length)).toBe(0);
    expect(await page.evaluate(() => [document.documentElement.getAttribute('style'), document.body.getAttribute('style')])).toEqual(before);
  });

  it('settleScroll lands at the place and reports it settled, even with smooth scrolling left on', async () => {
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
    const at = await page.evaluate(settleScroll, { y: 2500, maxMs: SCROLL_SETTLE_MS });
    expect(at).toEqual({ x: 0, y: 2500, settled: true });
    // Beyond the end of the page: the largest scroll.
    const end = await page.evaluate(settleScroll, { y: 10_000_000, maxMs: SCROLL_SETTLE_MS });
    expect(end.settled).toBe(true);
    expect(end.y).toBe(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight));
  });

  it('turns mandatory scroll snapping off while on (the place asked for is reached), and back on after', async () => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await p.goto(`${server.origin}/flash-snap-top.html`);
      // The hazard: with snapping on, the window can never sit at 0 (the first snap point is lower).
      await p.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
      await p.waitForTimeout(200);
      expect(await p.evaluate(() => scrollY)).toBeGreaterThan(0);
      await p.evaluate(instantScrollStart, undefined);
      expect(await p.evaluate(settleScroll, { y: 0, maxMs: SCROLL_SETTLE_MS })).toEqual({ x: 0, y: 0, settled: true });
      expect(await p.evaluate(settleScroll, { y: 1234, maxMs: SCROLL_SETTLE_MS })).toEqual({ x: 0, y: 1234, settled: true });
      await p.evaluate(instantScrollStop, undefined);
      expect(await p.evaluate(() => getComputedStyle(document.documentElement).scrollSnapType)).toBe('y mandatory');
    } finally {
      await p.close();
    }
  });

  it('settleScroll gives up (not settled) on a page that keeps scrolling itself', async () => {
    await page.evaluate(() => {
      const w = window as unknown as { __jitter?: number };
      w.__jitter = window.setInterval(() => window.scrollBy({ top: 7, behavior: 'instant' }), 16);
    });
    const at = await page.evaluate(settleScroll, { y: 1000, maxMs: 400 });
    expect(at.settled).toBe(false);
    await page.evaluate(() => clearInterval((window as unknown as { __jitter: number }).__jitter));
  });
});
