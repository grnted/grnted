// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { createPace } from '../../src/pace.js';
import { createTimeBudget, type PaceTiming } from '../../src/timeBudget.js';
import type { BrowserLike, ContextLike, PageLike, RequestLike } from '../../src/types.js';

/** A browser whose every call takes `step` ms of a clock the test owns. */
function fakeBrowser(clock: { t: number }, step: number) {
  const listeners: ((r: RequestLike) => void)[] = [];
  const tick = async () => { clock.t += step; };
  const page = (): PageLike => ({
    goto: async () => { await tick(); return null; },
    waitForTimeout: async (ms: number) => { clock.t += ms; },
    evaluate: async () => undefined as never,
    addScriptTag: async () => undefined,
    screenshot: async () => new Uint8Array(),
    close: async () => {},
  });
  const context = (): ContextLike => ({
    newPage: async () => { await tick(); return page(); },
    close: tick,
    on: ((_e: string, fn: (r: RequestLike) => void) => { listeners.push(fn); }) as ContextLike['on'],
  });
  const browser: BrowserLike = { newContext: async () => { await tick(); return context(); } };
  const request = (url: string, type: string) => {
    for (const fn of listeners) fn({ url: () => url, method: () => 'GET', resourceType: () => type });
  };
  return { browser, request };
}

describe('the time budget (debug only)', () => {
  it('adds up a context\'s time: opening, loads, fixed waits, closing and the rest', async () => {
    const clock = { t: 1000 };
    const { browser, request } = fakeBrowser(clock, 10);
    const tb = createTimeBudget('https://site.example/', () => clock.t);
    const ctx = await tb.browser(browser).newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto('https://site.example/a');
    await page.goto('https://site.example/a#part');
    await page.goto('https://site.example/b');
    await page.waitForTimeout(500);
    request('https://site.example/a', 'document');
    request('https://site.example/app.css', 'stylesheet');
    request('https://cdn.example/lib.js', 'script');
    clock.t += 70; // the engine working in the page
    await ctx.close();
    tb.mark('discovered');
    tb.mark('pages');
    const b = tb.summary({ total: 2, ok: 2 });
    expect(b.contexts).toBe(1);
    expect(b.loads).toBe(3);
    // The same page with and without a fragment is one page loaded twice.
    expect(b.loadsPerPage).toEqual({ median: 1.5, max: 2, pagesLoaded: 2 });
    expect(b.requests).toEqual({ all: 3, site: 2, siteDocuments: 1 });
    expect(b.browser).toEqual({ contextMs: 630, openMs: 20, loadMs: 30, timerMs: 500, closeMs: 10, otherMs: 70 });
    expect(b.wallMs).toBe(630);
  });

  it('hears each load\'s wait and run from the pace controller, and each page turn', async () => {
    let t = 0;
    const heard: PaceTiming[] = [];
    const pace = createPace({ concurrency: 1, now: () => t, sleep: async (ms) => { t += ms; }, onTiming: (e) => heard.push(e) });
    pace.setCrawlDelay('site.example', 2);
    const run = async () => { t += 300; return 200; };
    await pace.load('https://site.example/a', run, (status) => ({ status }));
    await pace.load('https://site.example/b', run, (status) => ({ status }));
    await pace.load('https://site.example/robots.txt', run, (status) => ({ status }), { page: false });
    const slot = await pace.page();
    slot.release();
    pace.stop();
    expect(heard).toEqual([
      { kind: 'load', url: 'https://site.example/a', page: true, waitMs: 0, runMs: 300 },
      // The Crawl-delay gap (2 s between page starts) less the first load's own 300 ms.
      { kind: 'load', url: 'https://site.example/b', page: true, waitMs: 1700, runMs: 300 },
      { kind: 'load', url: 'https://site.example/robots.txt', page: false, waitMs: 0, runMs: 300 },
      { kind: 'turn', waitMs: 0 },
    ]);
  });

  it('measures nothing unless asked: a listener that throws changes nothing', async () => {
    let t = 0;
    const pace = createPace({ concurrency: 1, now: () => t, onTiming: () => { throw new Error('listener'); } });
    const r = await pace.load('https://site.example/a', async () => { t += 5; return 200; }, (status) => ({ status }));
    expect(r).toEqual({ value: 200 });
    pace.stop();
  });
});
