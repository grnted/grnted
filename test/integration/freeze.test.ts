// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Holding a page still for the pixel tests (`freezePage`) in real Chromium: one hold per window,
// a call that answers late never holds the page again after the thaw, the thaw always reports whether
// it is confirmed, and a page whose thaw is not confirmed is never reused by a later probe.
// Fixture site: test/fixtures/contrast/ (synthetic).
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freezeFrame, freezePage, thawFrame } from '../../src/probes/freeze.js';
import { LISTENER_HOOK_SCRIPT } from '../../src/probes/listeners.js';
import { runProbes } from '../../src/probes/runner.js';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike, Finding, PageLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer('contrast');
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const like = (page: Page) => page as unknown as PageLike;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Evaluate = (fn: unknown, arg: unknown) => Promise<unknown>;

/** Replaces a frame's `evaluate` (the frame object Playwright hands out for this frame every time). */
function intercept(frame: Frame, wrap: (orig: Evaluate, fn: unknown, arg: unknown) => Promise<unknown>): void {
  const orig = frame.evaluate.bind(frame) as unknown as Evaluate;
  (frame as unknown as { evaluate: Evaluate }).evaluate = (fn, arg) => wrap(orig, fn, arg);
}

/** A page with a stand-in for the listener hook's `__grntedFreeze` that records its calls. */
async function hookedPage(path: string): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const calls: boolean[] = [];
    Object.assign(window, { __holdCalls: calls, __grntedFreeze: (on: boolean) => { calls.push(on); return 0; } });
  });
  const page = await context.newPage();
  await page.goto(`${server.origin}${path}`);
  return { page, context };
}

/** What is left of a hold in the page's main document. */
const leftover = (page: Page) => page.evaluate(() => ({
  state: '__grntedFrozen' in window,
  sheets: document.adoptedStyleSheets.length,
  calls: (window as unknown as { __holdCalls: boolean[] }).__holdCalls,
}));

describe('holding the page still (freezePage)', () => {
  it('a freeze call that answers after the thaw never holds the page again, and the thaw is not confirmed while it is out', async () => {
    const { page, context } = await hookedPage('/text-carousel.html');
    try {
      // The first freeze call reaches the page 2.6 s late (past its 2 s limit): the settle and the
      // thaw run before it does.
      let late: Promise<unknown> | undefined;
      intercept(page.mainFrame(), (orig, fn, arg) => {
        if (fn === freezeFrame && !late) {
          late = sleep(2600).then(() => orig(fn, arg));
          return late;
        }
        return orig(fn, arg);
      });
      const frozen = await freezePage(like(page));
      await frozen.settle();
      const confirmed = await frozen.thaw();
      await late;
      expect(await leftover(page)).toEqual({ state: false, sheets: 0, calls: [true, false] });
      expect(confirmed).toBe(false);
    } finally {
      await context.close();
    }
  }, 30_000);

  it('the thaw leaves an autoplay video the page itself paused paused, and restarts one that was playing', async () => {
    const { page, context } = await hookedPage('/text-video.html');
    try {
      const video = page.locator('video');
      await page.waitForFunction(() => !(document.querySelector('video') as HTMLVideoElement).paused);
      // The page stops its own background video (as a reduced-motion check would).
      await video.evaluate((v: HTMLVideoElement) => v.pause());
      let frozen = await freezePage(like(page));
      await frozen.settle();
      expect(await frozen.thaw()).toBe(true);
      await sleep(300);
      expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
      // A video that was playing when the test froze it plays again afterwards.
      await video.evaluate((v: HTMLVideoElement) => v.play());
      frozen = await freezePage(like(page));
      await frozen.settle();
      expect(await frozen.thaw()).toBe(true);
      await sleep(300);
      expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
    } finally {
      await context.close();
    }
  }, 30_000);

  it('repeated freeze calls share one hold, and one thaw undoes all of it (confirmed)', async () => {
    const { page, context } = await hookedPage('/text-carousel.html');
    try {
      const frozen = await freezePage(like(page));
      await frozen.settle();
      await frozen.settle();
      expect(await leftover(page)).toEqual({ state: true, sheets: 1, calls: [true] });
      expect(await frozen.thaw()).toBe(true);
      // Asking again gets the same answer and sends nothing more.
      expect(await frozen.thaw()).toBe(true);
      await frozen.settle();
      expect(await leftover(page)).toEqual({ state: false, sheets: 0, calls: [true, false] });
    } finally {
      await context.close();
    }
  }, 30_000);

  it('a thaw the page never answers is not confirmed', async () => {
    const { page, context } = await hookedPage('/text-carousel.html');
    try {
      intercept(page.mainFrame(), (orig, fn, arg) => (fn === thawFrame ? new Promise(() => {}) : orig(fn, arg)));
      const frozen = await freezePage(like(page));
      expect(await frozen.thaw()).toBe(false);
    } finally {
      await context.close();
    }
  }, 30_000);

  it('never throws: a page that cannot wait for its paused video keeps the hold until the thaw, which undoes it', async () => {
    const { page, context } = await hookedPage('/text-video.html');
    try {
      await page.waitForFunction(() => !(document.querySelector('video') as HTMLVideoElement).paused);
      (page as unknown as { waitForTimeout: () => Promise<void> }).waitForTimeout = () => Promise.reject(new Error('Target page, context or browser has been closed'));
      const frozen = await freezePage(like(page));
      expect(frozen.held.media).toBe(1);
      expect(await frozen.thaw()).toBe(true);
      expect(await leftover(page)).toEqual({ state: false, sheets: 0, calls: [true, false] });
    } finally {
      await context.close();
    }
  }, 30_000);
});

describe('the listener hook holding timers (__grntedFreeze)', () => {
  it('every timeout due while the page is held runs once it is released, also past the hold list cap', async () => {
    const context = await browser.newContext();
    try {
      await context.addInitScript({ content: LISTENER_HOOK_SCRIPT });
      const page = await context.newPage();
      await page.goto(`${server.origin}/text-carousel.html`);
      await page.evaluate(() => {
        const w = window as unknown as { __grntedFreeze: (on: boolean) => number; ran: number };
        w.ran = 0;
        w.__grntedFreeze(true);
        for (let i = 0; i < 305; i++) setTimeout(() => { w.ran++; }, 1000);
      });
      await sleep(1400);
      await page.evaluate(() => (window as unknown as { __grntedFreeze: (on: boolean) => number }).__grntedFreeze(false));
      await page.waitForFunction(() => (window as unknown as { ran: number }).ran >= 305, undefined, { timeout: 3000 }).catch(() => {});
      expect(await page.evaluate(() => (window as unknown as { ran: number }).ran)).toBe(305);
    } finally {
      await context.close();
    }
  }, 30_000);
});

describe('a page whose hold could not be confirmed undone', () => {
  it('is not reused: the next probe gets a fresh page', async () => {
    const own = await chromium.launch();
    try {
      // Every page this browser opens: the thaw marks the page, then never answers.
      const newContext = own.newContext.bind(own);
      (own as unknown as { newContext: typeof newContext }).newContext = async (o) => {
        const c = await newContext(o);
        const newPage = c.newPage.bind(c);
        (c as unknown as { newPage: typeof newPage }).newPage = async () => {
          const p = await newPage();
          intercept(p.mainFrame(), (orig, fn, arg) => {
            if (fn !== thawFrame) return orig(fn, arg);
            return orig(() => { (window as unknown as { __grntedStale: boolean }).__grntedStale = true; }, undefined).then(() => new Promise(() => {}));
          });
          return p;
        };
        return c;
      };
      let stale: boolean | undefined;
      const after: PageProbe = {
        id: 'after', criteria: ['0.0.1'], kind: 'render', tier: 'core', timeoutMs: 5000,
        async run(ctx) {
          stale = await ctx.page.evaluate(() => (window as unknown as { __grntedStale?: boolean }).__grntedStale === true, undefined);
          return [];
        },
      };
      const incomplete: Finding[] = [{
        id: 'color-contrast', help: 'Elements must meet minimum color contrast ratio thresholds', helpUrl: 'https://x/color-contrast',
        nodes: [{ target: '#t-slide-1', html: '<p>', viewports: ['desktop'], failureSummary: "Element's background color could not be determined due to a background image" }],
      }];
      const runs = await runProbes(own as unknown as BrowserLike, [{ url: `${server.origin}/text-carousel.html`, index: 0, incomplete }], [textContrastProbe, after], { userAgent: 'grnted-test' });
      expect(runs.map((r) => [r.probe, r.status])).toEqual([['text-contrast', 'ok'], ['after', 'ok']]);
      expect(stale).toBe(false);
    } finally {
      await own.close();
    }
  }, 60_000);
});
