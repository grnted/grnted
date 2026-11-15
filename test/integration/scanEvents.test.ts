// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Scan events (Plan 5, Task 5.9) against a local fixture site: order, the page score, the wireframe's
// bounds and privacy, and that events are observation only (the report is the same with or without
// a listener, even one that throws, rejects or mutates the events).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WIREFRAME_LIMITS, captureWireframe, wireframeInPage } from '../../src/events.js';
import { criterionScore, pageReportFor, reportCriterionChecks } from '../../src/criterionScore.js';
import { scanSite, type ScanOptions, type ScanProgress } from '../../src/scan.js';
import { roundScore } from '../../src/scoreCore.js';
import type { BrowserLike, ContextLike, PageLike, ScanEvent, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const NOW = () => new Date('2026-10-31T12:00:00.000Z');

/** Counts in-page wireframe captures through a wrapped browser. */
function countingBrowser(inner: BrowserLike): { browser: BrowserLike; wireframes: () => number } {
  let n = 0;
  const wrapPage = (page: PageLike): PageLike => new Proxy(page, {
    get(target, prop) {
      if (prop === 'evaluate') {
        return (fn: unknown, arg: unknown) => {
          if (fn === wireframeInPage) n++;
          return (target.evaluate as (f: unknown, a: unknown) => Promise<unknown>).call(target, fn, arg);
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const wrapCtx = (ctx: ContextLike): ContextLike => new Proxy(ctx, {
    get(target, prop) {
      if (prop === 'newPage') return async () => wrapPage(await target.newPage());
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { browser: { newContext: async (o) => wrapCtx(await inner.newContext(o)) }, wireframes: () => n };
}

const scan = (b: BrowserLike, extra: Partial<ScanOptions> = {}) =>
  scanSite(`${server.origin}/`, { browser: b, maxPages: 10, probes: false, documents: false, now: NOW, ...extra });

let plain: SiteReport;
let plainProgress: ScanProgress[];
let plainWireframes: number;
let withEvents: SiteReport;
let events: ScanEvent[];
let eventProgress: ScanProgress[];
let eventWireframes: number;
const others: Record<string, SiteReport> = {};

beforeAll(async () => {
  server = await startFixtureServer('events');
  browser = await chromium.launch();
  const b = browser as unknown as BrowserLike;
  {
    const c = countingBrowser(b);
    plainProgress = [];
    plain = await scan(c.browser, { onProgress: (p) => plainProgress.push(p) });
    plainWireframes = c.wireframes();
  }
  {
    const c = countingBrowser(b);
    events = [];
    eventProgress = [];
    withEvents = await scan(c.browser, { onEvent: (e) => events.push(e), onProgress: (p) => eventProgress.push(p) });
    eventWireframes = c.wireframes();
  }
  others.throwing = await scan(b, { onEvent: () => { throw new Error('listener boom'); } });
  others.rejecting = await scan(b, { onEvent: (async () => { throw new Error('async boom'); }) as (e: ScanEvent) => void });
  others.mutating = await scan(b, {
    onEvent: (e) => {
      if (e.type === 'selected') { e.pages.reverse(); e.skipped.length = 0; }
      if (e.type === 'viewport-done') { e.failing.length = 0; e.wireframe.els.length = 0; }
      if (e.type === 'page-done') { e.rules.length = 0; e.score = 0; }
    },
  });
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const path = (u: string) => new URL(u).pathname;
const ofType = <T extends ScanEvent['type']>(t: T) => events.filter((e): e is Extract<ScanEvent, { type: T }> => e.type === t);

describe('scan events on the fixture site', () => {
  it('selects the expected pages (one fails to load)', () => {
    expect(withEvents.pages.map((p) => [path(p.url), p.status])).toEqual([['/', 'ok'], ['/bad.html', 'ok'], ['/fields.html', 'ok'], ['/missing.html', 'failed']]);
  });

  it('emits discover → selected → per page viewport-start ×2, viewport-done ×2, page-done → scoring → done', () => {
    const firstPageEvent = events.findIndex((e) => e.type === 'viewport-start');
    const head = events.slice(0, firstPageEvent);
    // Said before robots.txt and before the home page (no sitemap here), then each step's result. The second
    // 'home': the home page's links do not fill the scan, so the pages found are read for more (crawl.ts `deepen`).
    expect(head.map((e) => (e.type === 'discover' ? e.step : e.type))).toEqual(['start', 'robots', 'sitemap', 'home', 'home', 'normalize', 'select', 'documents', 'selected']);
    const selected = ofType('selected')[0]!;
    expect(selected.pages.map(path)).toEqual(['/', '/bad.html', '/fields.html', '/missing.html']);
    expect(selected.skipped.map((s) => path(s.url))).toEqual(['/private.html']);
    expect(selected.documents.map(path)).toEqual(['/board.pdf']);

    for (let i = 0; i < 4; i++) {
      const own = events.map((e, at) => ({ e, at })).filter(({ e }) => 'index' in e && e.index === i);
      expect(own.map(({ e }) => e.type)).toEqual(['viewport-start', 'viewport-start', 'viewport-done', 'viewport-done', 'page-done']);
      expect(new Set(own.filter(({ e }) => e.type === 'viewport-done').map(({ e }) => (e as { viewport: string }).viewport))).toEqual(new Set(['desktop', 'mobile']));
      for (const { e } of own) expect((e as { url: string }).url).toBe(selected.pages[i]);
    }
    const lastPageDone = events.map((e) => e.type).lastIndexOf('page-done');
    const firstScoring = events.findIndex((e) => e.type === 'scoring');
    expect(firstScoring).toBeGreaterThan(lastPageDone);
    expect(events.slice(firstScoring).map((e) => (e.type === 'scoring' ? e.step : e.type))).toEqual(['weighting', 'writing', 'done']);
  });

  it('page-done carries the page score of its audit, as the report scores pages (cross-page findings come later)', () => {
    const done = ofType('page-done');
    expect(done).toHaveLength(4);
    for (const e of done) {
      const page = withEvents.pages.find((p) => p.url === e.url)!;
      expect(e.status).toBe(page.status);
      if (page.status !== 'ok') continue;
      // The report's page score from the audit's own results: without the cross-page rules, media and tests.
      const alone = { ...pageReportFor(withEvents, e.url), consistency: [], media: [] };
      delete (alone as { probes?: unknown }).probes;
      expect(e.score).toBe(roundScore(criterionScore(reportCriterionChecks(alone)!)));
      expect(e.score).toBeGreaterThanOrEqual(page.score!);
    }
    // A page with a cross-page finding (2.4.5 here) scores lower in the report than at page-done.
    expect(done.some((e) => e.score! > withEvents.pages.find((p) => p.url === e.url)!.score!)).toBe(true);
    const bad = done.find((e) => path(e.url) === '/bad.html')!;
    expect(bad.rules.find((r) => r.id === 'image-alt')).toEqual({ id: 'image-alt', impact: 'critical', count: 1 });
    expect(bad.rules.map((r) => r.id)).toEqual(expect.arrayContaining(['image-alt', 'color-contrast', 'link-name']));
  });

  it('a page that fails to load: page-done failed with the reason, viewport-done with an empty wireframe', () => {
    const missing = events.filter((e) => 'url' in e && path((e as { url: string }).url) === '/missing.html');
    const done = missing.find((e) => e.type === 'page-done')!;
    expect(done).toEqual({ type: 'page-done', index: 3, url: `${server.origin}/missing.html`, status: 'failed', score: null, rules: [], reason: 'HTTP 404' });
    for (const e of missing.filter((x) => x.type === 'viewport-done')) {
      expect(e).toMatchObject({ checks: 0, elements: 0, failing: [], wireframe: { W: 0, H: 0, els: [] } });
    }
  });

  it('viewport-done: checks, elements, failing rules and time', () => {
    for (const e of ofType('viewport-done').filter((x) => path(x.url) !== '/missing.html')) {
      expect(e.checks).toBeGreaterThan(5);
      expect(e.elements).toBeGreaterThan(5);
      expect(e.ms).toBeGreaterThan(0);
      expect(Number.isInteger(e.ms)).toBe(true);
    }
    const badDesktop = ofType('viewport-done').find((e) => path(e.url) === '/bad.html' && e.viewport === 'desktop')!;
    expect(badDesktop.failing[0]).toEqual({ id: 'image-alt', impact: 'critical', count: 1 });
    // The failing image is located in the wireframe (its id needs an escaped selector).
    const tagged = badDesktop.wireframe.els.filter((el) => el.rule === 'image-alt');
    expect(tagged).toHaveLength(1);
    expect(tagged[0]).toMatchObject({ t: 'img', impact: 'critical', w: 40, h: 40 });
  });

  it('wireframes stay within the page and the caps; only short public text', () => {
    const widths = { desktop: 1280, mobile: 390 };
    for (const e of ofType('viewport-done').filter((x) => path(x.url) !== '/missing.html')) {
      const { W, H, els } = e.wireframe;
      expect(W).toBeGreaterThan(0);
      expect(W).toBeLessThanOrEqual(widths[e.viewport]);
      expect(H).toBeGreaterThan(0);
      expect(H).toBeLessThanOrEqual(WIREFRAME_LIMITS.maxHeight);
      expect(els.filter((x) => !x.rule).length).toBeLessThanOrEqual(WIREFRAME_LIMITS.layout);
      expect(els.length).toBeGreaterThan(0);
      for (const el of els) {
        for (const n of [el.x, el.y, el.w, el.h]) expect(Number.isInteger(n)).toBe(true);
        expect(el.x).toBeGreaterThanOrEqual(0);
        expect(el.y).toBeGreaterThanOrEqual(0);
        expect(el.x + el.w).toBeLessThanOrEqual(W);
        expect(el.y + el.h).toBeLessThanOrEqual(H);
        if (el.text !== undefined) {
          expect(el.text.length).toBeLessThanOrEqual(WIREFRAME_LIMITS.text);
          expect(['h1', 'h2', 'h3', 'a', 'button', 'label']).toContain(el.t);
        }
      }
    }
    const home = ofType('viewport-done').find((e) => path(e.url) === '/' && e.viewport === 'desktop')!;
    const h1 = home.wireframe.els.find((el) => el.t === 'h1')!;
    expect(h1.text).toBe('Events home: a heading that is much longer than');
    expect(home.wireframe.els.map((el) => el.t)).toEqual(expect.arrayContaining(['header', 'main', 'footer', 'a', 'p']));
  });

  it('never captures field values, typed text or attribute values', () => {
    const json = JSON.stringify(events);
    expect(json).not.toContain('secret');
    // Labels' own text is public and kept.
    const fields = ofType('viewport-done').find((e) => path(e.url) === '/fields.html' && e.viewport === 'desktop')!;
    const layout = fields.wireframe.els.filter((el) => !el.rule);
    expect(layout.filter((el) => el.t === 'label').map((el) => el.text)).toEqual(['Name', 'Notes', 'Choice', 'Later']);
    expect(layout.filter((el) => el.t === 'button').map((el) => el.text)).toEqual(['Send']);
    // Failing elements carry no text at all.
    expect(fields.wireframe.els.filter((el) => el.rule).every((el) => el.text === undefined)).toBe(true);
    expect(fields.wireframe.els.filter((el) => el.t === 'input').every((el) => el.text === undefined)).toBe(true);
  });

  it('done carries the verdict', () => {
    const done = events.at(-1)!;
    expect(done).toEqual({
      type: 'done', status: withEvents.status, score: withEvents.score, letter: withEvents.letter, headline: withEvents.headline,
      critical: withEvents.rules.filter((r) => r.impact === 'critical').length,
    });
    expect((done as { critical: number }).critical).toBeGreaterThan(0);
  });

  it('events are observation only: the same report with no listener, a throwing, a rejecting or a mutating one', () => {
    expect(withEvents).toEqual(plain);
    expect(others.throwing).toEqual(plain);
    expect(others.rejecting).toEqual(plain);
    expect(others.mutating).toEqual(plain);
  });

  it('onProgress is unchanged by onEvent', () => {
    // Pages finish in any order with concurrency: compare the same updates, ignoring their order.
    const key = (p: ScanProgress) => JSON.stringify([p.phase, p.done, p.total, p.url ?? '']);
    expect(eventProgress.map((p) => p.phase)).toEqual(plainProgress.map((p) => p.phase));
    expect(eventProgress.map((p) => p.done)).toEqual(plainProgress.map((p) => p.done));
    expect(new Set(eventProgress.filter((p) => p.url).map((p) => p.url))).toEqual(new Set(plainProgress.filter((p) => p.url).map((p) => p.url)));
    expect(eventProgress.filter((p) => !p.url).map(key)).toEqual(plainProgress.filter((p) => !p.url).map(key));
    expect(plainProgress.map((p) => p.phase)).toEqual(['discover', 'audit', 'audit', 'audit', 'audit', 'documents', 'done']);
  });

  it('no wireframe is captured without a listener; one per loaded width with one', () => {
    expect(plainWireframes).toBe(0);
    expect(eventWireframes).toBe(6);
  });
});

describe('captureWireframe on a hostile page', () => {
  it('survives hostile selectors and still places the valid targets', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await ctx.newPage();
      await page.goto(`${server.origin}/bad.html`);
      const out = await captureWireframe(page as unknown as PageLike, [
        { id: 'image-alt', impact: 'critical', target: '[[[' },
        { id: 'image-alt', impact: 'critical', target: ':has(' },
        { id: 'image-alt', impact: 'critical', target: 'img' },
        { id: 'region', impact: 'moderate', target: 'html' },
      ]);
      const failing = out.wireframe.els.filter((e) => e.rule);
      expect(failing).toEqual([expect.objectContaining({ t: 'img', rule: 'image-alt', impact: 'critical' })]);
    } finally {
      await ctx.close();
    }
  });

  it('returns an empty wireframe when the page never answers (time box)', async () => {
    const hung = { evaluate: () => new Promise(() => {}) } as unknown as PageLike;
    const started = Date.now();
    const out = await captureWireframe(hung, [], 200);
    expect(out).toEqual({ elements: 0, wireframe: { W: 0, H: 0, els: [] } });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('returns an empty wireframe when evaluate throws', async () => {
    const broken = { evaluate: () => Promise.reject(new Error('Target closed')) } as unknown as PageLike;
    expect(await captureWireframe(broken, [])).toEqual({ elements: 0, wireframe: { W: 0, H: 0, els: [] } });
  });

  it('a page that overrides DOM methods cannot inject oversized output', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const page = await ctx.newPage();
      await page.goto(`${server.origin}/`);
      await page.evaluate(() => {
        Element.prototype.getBoundingClientRect = function () { return { left: -1e9, top: 1e9, width: 1e12, height: 1e12, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect; };
        Object.defineProperty(Node.prototype, 'textContent', { get() { return 'z'.repeat(1e5); } });
      });
      const out = await captureWireframe(page as unknown as PageLike, []);
      expect(out.wireframe.H).toBeLessThanOrEqual(WIREFRAME_LIMITS.maxHeight);
      for (const el of out.wireframe.els) expect((el.text ?? '').length).toBeLessThanOrEqual(WIREFRAME_LIMITS.text);
      expect(JSON.stringify(out).length).toBeLessThan(60_000);
    } finally {
      await ctx.close();
    }
  });
});
