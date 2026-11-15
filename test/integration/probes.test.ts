// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { probeCriteriaResults } from '../../src/probes/criteria.js';
// The probe framework in real Chromium: request guard, listener hook, time boxes, fresh contexts,
// scanSite wiring (template sample) and the dogfood test. Fixture site: test/fixtures/probes/.
import { type IncomingMessage } from 'node:http';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageShape } from '../../src/collect/shape.js';
import { visionCollector } from '../../src/collect/vision.js';
import { LEFT_BY_ITSELF, LOADING_ITSELF, STOPPED_AFTER, UNSETTLED_AFTER, runProbes } from '../../src/probes/runner.js';
import type { GuardEvent, PageProbe, RecordedHooks, RecordedListener } from '../../src/probes/types.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';
import { exampleProbe } from '../helpers/probes.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const requests: string[] = [];
const B = () => browser as unknown as BrowserLike;
const OPTS = { userAgent: 'grnted-test' };

beforeAll(async () => {
  server = await startFixtureServer('probes', {
    '/go-between': { type: 'text/html', status: 302, headers: { location: '/between.html' } },
    '/img/redirect-ok': { type: 'image/png', status: 302, headers: { location: '/images/a.png' } },
    '/img/redirect-bad': { type: 'image/png', status: 302, headers: { location: '/account/logout' } },
    '/images/a.png': { type: 'image/png', body: 'not really a png' },
    // A bot challenge (AWS WAF answers 202 with a script page that needs a POST to pass).
    '/challenge': { type: 'text/html', status: 202, body: '<!doctype html><html><head><title></title></head><body><script>/* challenge */</script></body></html>' },
  }, { onRequest: (req: IncomingMessage) => requests.push(`${req.method} ${req.url}`) });
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const probe = (id: string, run: PageProbe['run'], extra: Partial<PageProbe> = {}): PageProbe =>
  ({ id, criteria: ['0.0.1'], kind: 'interaction', tier: 'core', timeoutMs: 15_000, run, ...extra });

/** The real browser, counting every page its contexts open (the page under test included). */
function countingPages(count: { pages: number }): BrowserLike {
  return {
    async newContext(o: Parameters<Browser['newContext']>[0]) {
      const context = await browser.newContext(o);
      context.on('page', () => { count.pages++; });
      return context;
    },
  } as unknown as BrowserLike;
}

describe('request guard (real browser)', () => {
  it('stops everything that could change the site, keeps the page, and logs what it stopped', async () => {
    let events: GuardEvent[] = [];
    let after: { url: string; confirm: unknown; open: unknown } | undefined;
    const ACTIONS = ['post-submit', 'get-submit', 'put', 'delete', 'beacon', 'logout-xhr', 'data', 'img', 'del', 'about', 'skip', 'popup', 'popup-timer', 'dialogs', 'ws', 'blank', 'named', 'fget-b', 'fpost-b'];
    const clicker = probe('clicker', async (ctx) => {
      for (const id of ACTIONS) {
        await ctx.page.evaluate((x: string) => document.getElementById(x)!.click(), id);
        await ctx.page.waitForTimeout(120);
      }
      // As a person would: Enter on a new-window link, ctrl/cmd-click and middle-click on a plain link,
      // and a button in a frame that opens a window.
      const page = ctx.page as unknown as Page;
      await page.focus('#blank');
      await page.keyboard.press('Enter');
      await page.click('#plain', { modifiers: ['ControlOrMeta'] });
      await page.click('#plain', { button: 'middle' });
      await page.frameLocator('#kid').locator('#fopen').click();
      await ctx.page.waitForTimeout(300);
      events = [...ctx.guard.events];
      after = {
        url: ctx.page.url!(),
        ...await ctx.page.evaluate(() => {
          const w = window as unknown as { __confirmResult?: boolean; __openResult?: unknown };
          return { confirm: w.__confirmResult, open: w.__openResult };
        }, undefined),
      };
      return [];
    });
    requests.length = 0;
    const count = { pages: 0 };
    const [run] = await runProbes(countingPages(count), [{ url: `${server.origin}/guard.html`, index: 0 }], [clicker], OPTS);
    expect(run!.status).toBe('ok');

    // Nothing that changes state reached the server; plain GETs did. While a probe runs, a static image at an
    // action-like address (a clicked control loading /images/cart-icon.png) is stopped too.
    const hit = (s: string) => requests.some((r) => r.startsWith(s));
    for (const blocked of ['POST /submit', 'PUT /api/item', 'DELETE /api/item/1', 'POST /beacon', 'GET /account/logout', 'GET /items/delete', 'GET /about.html', 'GET /search', 'GET /popup.html', 'GET /ws']) {
      expect(hit(blocked), blocked).toBe(false);
    }
    expect(requests.filter((r) => !r.startsWith('GET ')), 'only GET requests').toEqual([]);
    expect(hit('GET /data.json')).toBe(true);
    expect(hit('GET /images/cart-icon.png')).toBe(false);
    // No new window opened at all: none of their addresses was requested, and the context only ever had the page.
    expect(requests.filter((r) => r.includes('/pop/'))).toEqual([]);
    expect(count.pages).toBe(1);

    // The page stayed (the in-page anchor moved to #end), the confirm dialog was dismissed, and
    // window.open returned null, as for a popup the browser blocked.
    expect(after).toEqual({ url: `${server.origin}/guard.html#end`, confirm: false, open: null });

    const path = (u?: string) => (u ? new URL(u).pathname : '');
    const summary = events.map((e) => [e.kind, e.method ?? e.dialog ?? '', e.reason ?? '', path(e.url), e.probe]);
    expect(summary).toEqual(expect.arrayContaining([
      ['blocked', 'POST', 'method', '/submit', 'clicker'],
      ['navigation', 'GET', '', '/search', 'clicker'],
      ['blocked', 'PUT', 'method', '/api/item', 'clicker'],
      ['blocked', 'DELETE', 'method', '/api/item/1', 'clicker'],
      ['blocked', 'POST', 'method', '/beacon', 'clicker'],
      ['blocked', 'GET', 'action', '/account/logout', 'clicker'],
      ['blocked', 'GET', 'action', '/items/delete', 'clicker'],
      ['blocked', 'GET', 'action', '/images/cart-icon.png', 'clicker'],
      ['navigation', 'GET', '', '/about.html', 'clicker'],
      ['url-change', '', '', '/guard.html', 'clicker'],
      ['dialog', 'alert', '', '', 'clicker'],
      ['dialog', 'confirm', '', '', 'clicker'],
      ['websocket', '', '', '/ws', 'clicker'],
    ]));
    // Each window the page tried to open is recorded with the address it would have loaded, under the probe.
    const popups = events.filter((e) => e.kind === 'popup');
    expect(popups.map((e) => path(e.url)).sort()).toEqual([
      '/pop/blank', '/pop/blank', '/pop/form-get', '/pop/form-post', '/pop/frame', '/pop/named', '/pop/plain', '/pop/plain', '/pop/timer', '/popup.html',
    ]);
    expect(popups.every((e) => e.probe === 'clicker')).toBe(true);
    expect(events.filter((e) => e.kind === 'blocked').every((e) => e.probe === 'clicker')).toBe(true);
  }, 60_000);
});

describe('listener hook (real browser)', () => {
  it('records click, key, touch, motion, drag and property handlers without breaking the page', async () => {
    let listeners: RecordedListener[] = [];
    let hooks: RecordedHooks | undefined;
    let self: { errors: string[]; illegal?: string; timeoutArgs?: string[]; longTimer?: boolean } | undefined;
    let resolved: boolean[] = [];
    const reader = probe('reader', async (ctx) => {
      await ctx.page.waitForTimeout(600); // let the 1.2 s timer fire (settle is 1 s)
      listeners = await ctx.listeners();
      hooks = await ctx.hooks();
      self = await ctx.page.evaluate(() => (window as unknown as { __selfTest: typeof self }).__selfTest, undefined);
      // Each element's path finds the same element as its ref.
      resolved = await ctx.page.evaluate((list) => list.filter((l) => l.target.kind === 'element').map((l) => {
        const w = window as unknown as { __grntedTarget(ref: number): unknown };
        return document.querySelector((l.target as { path: string }).path) === w.__grntedTarget(l.ref);
      }), listeners);
      return [];
    });
    const [run] = await runProbes(B(), [{ url: `${server.origin}/listeners.html`, index: 0 }], [reader], OPTS);
    expect(run!.status).toBe('ok');
    expect(self!.errors).toEqual([]);
    expect(self!.illegal).toBe('TypeError');
    expect(self!.timeoutArgs).toEqual(['x', 'y']);
    expect(self!.longTimer).toBe(true);

    const rows = listeners.map((l) => {
      const t = l.target;
      const who = t.kind === 'element' ? t.path : t.kind;
      return `${who} ${l.type} x${l.count}${l.passive ? ' passive' : ''}${l.capture ? ' capture' : ''} ${l.via.join('+')}`;
    });
    expect(rows).toEqual([
      'window devicemotion x1 add',
      'document keydown x1 property',
      '#btn click x2 add',
      '#btn mousedown x1 capture add',
      '#card keydown x1 add',
      '#inline click x1 attribute',
      '#swipe touchstart x1 passive add',
      '#drag dragstart x1 add',
      '#list > li:nth-of-type(3) click x1 property',
    ]);
    expect(resolved.length).toBe(7);
    expect(resolved.every(Boolean)).toBe(true);
    expect(listeners.find((l) => l.type === 'keydown' && l.target.kind === 'element')!.target)
      .toEqual({ kind: 'element', tag: 'div', id: 'card', classes: ['card', 'featured'], role: 'button', name: 'Open card', path: '#card' });

    expect(hooks!.audio).toEqual({ created: 1, running: expect.any(Number) });
    const timers = hooks!.timers.map((t) => [t.kind, t.delay, t.snippet.slice(0, 30)]);
    expect(timers).toEqual([
      ['interval', 5000, 'function rotateSlides() { t.ti'],
      ['timeout', 1200, 'function () { t.longTimer = tr'],
    ]);
    expect(hooks!.timers[1]).toMatchObject({ count: 1, fired: 1 });
    // The alert came from the 1.2 s timer's callback.
    expect(hooks!.calls).toEqual([{ api: 'alert', timer: 1, at: expect.any(Number) }]);
  }, 60_000);

  it('keeps a page with thousands of listeners and removals working', async () => {
    let listeners: RecordedListener[] = [];
    let self: { errors: string[]; bad: number; delegated: number; timers?: number } | undefined;
    let ms = 0;
    const reader = probe('reader', async (ctx) => {
      const t = Date.now();
      listeners = await ctx.listeners();
      ms = Date.now() - t;
      self = await ctx.page.evaluate(() => (window as unknown as { __selfTest: typeof self }).__selfTest, undefined);
      return [];
    });
    await runProbes(B(), [{ url: `${server.origin}/heavy.html`, index: 0 }], [reader], OPTS);
    expect(self).toMatchObject({ errors: [], bad: 0, delegated: 1000, timers: 500 });
    expect(listeners.filter((l) => l.type === 'click')).toHaveLength(1001);
    expect(listeners.filter((l) => l.type === 'pointerdown' && l.passive)).toHaveLength(1000);
    expect(listeners.every((l) => l.count === 1)).toBe(true);
    expect(ms).toBeLessThan(3000);
  }, 60_000);
});

describe('probe runner (real browser)', () => {
  it('never tests a bot challenge page (HTTP 202) as if it were the page: its results are not testable', async () => {
    const read = probe('read', async () => [{ criterion: '0.0.1', status: 'failed', detail: 'judged the challenge page' }]);
    const [run] = await runProbes(B(), [{ url: `${server.origin}/challenge`, index: 0 }], [read], OPTS);
    expect(run).toMatchObject({ probe: 'read', status: 'error' });
    expect(run!.findings).toEqual([expect.objectContaining({ criterion: '0.0.1', status: 'not_testable' })]);
    expect(run!.findings[0]!.detail).toMatch(/challenge \(HTTP 202\)/);
  });

  it('uses a fresh context per page, time-boxes a hung probe, and reports a probe that throws', async () => {
    const storage: (string | null)[] = [];
    const remember = probe('remember', async (ctx) => {
      storage.push(await ctx.page.evaluate(() => localStorage.getItem('grnted-test'), undefined));
      await ctx.page.evaluate(() => localStorage.setItem('grnted-test', 'set by an earlier probe'), undefined);
      return [{ criterion: '0.0.1', status: 'no_failures_found', detail: 'ok' }];
    });
    const hang = probe('hang', (ctx) => ctx.page.evaluate(() => new Promise<never>(() => {}), undefined), { timeoutMs: 400 });
    const boom = probe('boom', async () => { throw new Error('boom'); });
    const pages = [{ url: `${server.origin}/`, index: 0 }, { url: `${server.origin}/about.html`, index: 1 }];
    const runs = await runProbes(B(), pages, [remember, hang, boom], OPTS);
    expect(runs.map((r) => [new URL(r.page).pathname, r.probe, r.status, r.findings[0]?.detail])).toEqual([
      ['/', 'remember', 'ok', 'ok'],
      ['/', 'hang', 'timeout', 'timed out after 400 ms'],
      ['/', 'boom', 'error', 'the test could not run: boom'],
      ['/about.html', 'remember', 'ok', 'ok'],
      ['/about.html', 'hang', 'timeout', 'timed out after 400 ms'],
      ['/about.html', 'boom', 'error', 'the test could not run: boom'],
    ]);
    // Same origin, but each page's context started empty.
    expect(storage).toEqual([null, null]);
  }, 60_000);

  it('computes the same DOM shape as the vision collector', async () => {
    const shapes: string[][] = [];
    const compare = probe('compare', async (ctx) => {
      const vision = await visionCollector.collect(ctx.page, { url: ctx.url, viewport: 'desktop', index: 0 });
      shapes.push([await ctx.page.evaluate(pageShape, undefined), vision!.shape]);
      return [];
    });
    const pages = ['/', '/about.html', '/news/1.html', '/guard.html'].map((p, index) => ({ url: `${server.origin}${p}`, index }));
    await runProbes(B(), pages, [compare], OPTS);
    expect(shapes).toHaveLength(4);
    for (const [mine, vision] of shapes) expect(mine).toBe(vision);
    expect(new Set(shapes.map((s) => s[0])).size).toBe(4);
  }, 60_000);
});

/**
 * The real browser, with the runner's tidy-up between two probes (its `resetPage` call) started
 * `ms` late: whatever the page does by itself right after a probe then falls in the gap.
 */
function slowBetween(ms: number): BrowserLike {
  return {
    async newContext(o: Parameters<Browser['newContext']>[0]) {
      const context = await browser.newContext(o);
      const newPage = context.newPage.bind(context);
      return Object.assign(context, {
        async newPage() {
          const page = await newPage();
          const evaluate = page.evaluate.bind(page) as (...a: unknown[]) => Promise<unknown>;
          return Object.assign(page, {
            async evaluate(fn: unknown, ...rest: unknown[]) {
              if ((fn as { name?: string }).name === 'resetPage') await new Promise((r) => setTimeout(r, ms));
              return evaluate(fn, ...rest);
            },
          });
        },
      });
    },
  } as unknown as BrowserLike;
}

/** The real browser, with every request decision of the guard `ms` late (a busy machine); the browser's own request events are not delayed. */
function slowGuard(ms: number): BrowserLike {
  return {
    async newContext(o: Parameters<Browser['newContext']>[0]) {
      const context = await browser.newContext(o);
      const route = context.route.bind(context);
      return Object.assign(context, {
        route(pattern: RegExp, handler: (r: unknown) => unknown) {
          return route(pattern, (r) => { setTimeout(() => { void handler(r); }, ms); });
        },
      });
    },
  } as unknown as BrowserLike;
}

/**
 * The real browser, with the runner's tidy-up between two probes preceded by `before(page)`: what
 * the page (or a test standing in for it) does in that gap (`after`: right after the tidy-up, as the
 * next probe is about to start). `guardDelayMs` also makes each guard decision that late.
 */
function inGap(before: (evaluate: (fn: () => unknown) => Promise<unknown>) => Promise<void>, guardDelayMs = 0, after = false): BrowserLike {
  return {
    async newContext(o: Parameters<Browser['newContext']>[0]) {
      const context = await browser.newContext(o);
      const newPage = context.newPage.bind(context);
      if (guardDelayMs) {
        const route = context.route.bind(context);
        Object.assign(context, {
          route(pattern: RegExp, handler: (r: unknown) => unknown) {
            return route(pattern, (r) => { setTimeout(() => { void handler(r); }, guardDelayMs); });
          },
        });
      }
      return Object.assign(context, {
        async newPage() {
          const page = await newPage();
          const evaluate = page.evaluate.bind(page) as (...a: unknown[]) => Promise<unknown>;
          let done = false;
          return Object.assign(page, {
            async evaluate(fn: unknown, ...rest: unknown[]) {
              if ((fn as { name?: string }).name === 'resetPage' && !done) {
                done = true;
                if (after) {
                  // Right after the tidy-up, as the next probe is about to start.
                  const out = await evaluate(fn, ...rest);
                  await before((f) => evaluate(f));
                  return out;
                }
                await before((f) => evaluate(f));
              }
              return evaluate(fn, ...rest);
            },
          });
        },
      });
    },
  } as unknown as BrowserLike;
}

describe('request guard: the runner\'s load and late decisions (real browser)', () => {
  const where = probe('where', async (ctx) => [{ criterion: '0.0.1', status: 'no_failures_found', detail: await ctx.page.evaluate(() => location.pathname + location.search, undefined) }]);

  it('while the page settles after the runner\'s load, nothing at an action address goes out; a page that sends itself elsewhere 300 ms after load is still loading itself, so no test runs on it (self-navigating r3)', async () => {
    requests.length = 0;
    const runs = await runProbes(B(), [{ url: `${server.origin}/settle-act.html`, index: 0 }], [where], OPTS);
    expect(runs[0]!.findings).toEqual([expect.objectContaining({ status: 'not_testable', loadFailure: 'not-loaded', detail: expect.stringContaining(LOADING_ITSELF) })]);
    expect(requests.filter((r) => /logout/.test(r))).toEqual([]);
  }, 30_000);

  it('the runner\'s load still follows the server\'s redirects', async () => {
    const runs = await runProbes(B(), [{ url: `${server.origin}/go-between`, index: 0 }], [where], OPTS);
    expect(runs[0]!.findings).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: '/between.html' })]);
  }, 30_000);

  it('a reload the page starts just before a probe is decided as the page\'s own: held, however late the decision (3 s)', async () => {
    requests.length = 0;
    const slow = probe('slow-where', async (ctx) => { await ctx.page.waitForTimeout(4500); return where.run(ctx); });
    const runs = await runProbes(inGap(async (ev) => { await ev(() => { location.reload(); }); }, 3000, true),
      [{ url: `${server.origin}/between.html`, index: 0 }], [probe('first', async () => []), slow], OPTS);
    expect(runs.map((r) => [r.probe, r.status])).toEqual([['first', 'ok'], ['slow-where', 'ok']]);
    expect(runs[1]!.findings).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: '/between.html' })]);
    // Only the runner's own load reached the server.
    expect(requests.filter((r) => r.startsWith('GET /between.html'))).toHaveLength(1);
  }, 60_000);
});

describe('probe runner: what the guard stops after a probe has looked (real browser)', () => {
  /**
   * The test's own write: a click on a button whose handler POSTs (made inside the click, so the guard
   * counts it as the test's, not the page's background traffic).
   */
  const clickSave = () => {
    const b = document.createElement('button');
    b.textContent = 'Save';
    b.addEventListener('click', () => { void fetch('/api/save', { method: 'POST', body: 'x' }).catch(() => {}); });
    document.body.appendChild(b);
    b.click();
    b.remove();
  };
  /** Starts a POST and returns a clean result at once, before the guard has decided the POST. */
  const quick = probe('quick', async (ctx) => {
    await ctx.page.evaluate(clickSave, undefined);
    return [];
  });
  const twoCriteria = probe('two', async (ctx) => {
    await ctx.page.evaluate(clickSave, undefined);
    return [
      { criterion: '0.0.1', status: 'no_failures_found', detail: 'looked clean' },
      { criterion: '0.0.2', status: 'failed', detail: 'measured failure' },
    ];
  }, { criteria: ['0.0.1', '0.0.2', '0.0.3'] });

  it('a clean result becomes not_testable when the guard stops the test\'s request after the test looked (decision 400 ms late)', async () => {
    requests.length = 0;
    const runs = await runProbes(slowGuard(400), [{ url: `${server.origin}/between.html`, index: 0 }], [quick, twoCriteria], OPTS);
    expect(runs[0]!.findings).toEqual([{ criterion: '0.0.1', status: 'not_testable', detail: STOPPED_AFTER }]);
    // Measured failures stay failed; clean and silent criteria become not_testable.
    expect(runs[1]!.findings).toEqual([
      { criterion: '0.0.1', status: 'not_testable', detail: STOPPED_AFTER },
      { criterion: '0.0.2', status: 'failed', detail: 'measured failure' },
      { criterion: '0.0.3', status: 'not_testable', detail: STOPPED_AFTER },
    ]);
    expect(requests.filter((r) => r.startsWith('POST'))).toEqual([]);
  }, 30_000);

  it('a probe that only reads the page (onlyNavigationVoids) keeps its clean result when the guard stops a request late', async () => {
    const reader = probe('reader', quick.run, { onlyNavigationVoids: true });
    const runs = await runProbes(slowGuard(400), [{ url: `${server.origin}/between.html`, index: 0 }], [reader], OPTS);
    expect(runs[0]!.findings).toEqual([]);
  }, 30_000);

  it('and when the decision has not come by the end of the runner\'s wait (1.5 s late)', async () => {
    const runs = await runProbes(slowGuard(1500), [{ url: `${server.origin}/between.html`, index: 0 }], [quick], OPTS);
    expect(runs[0]!.findings).toEqual([{ criterion: '0.0.1', status: 'not_testable', detail: UNSETTLED_AFTER }]);
  }, 30_000);
});

describe('probe runner: redirects the browser follows during a probe (real browser)', () => {
  const imageVia = (path: string) => probe('image', async (ctx) => {
    await ctx.page.evaluate((src: string) => { const i = new Image(); i.src = src; document.body.appendChild(i); }, path);
    await ctx.page.waitForTimeout(500);
    return [];
  });

  it('a redirect to an address the guard would allow leaves the clean result clean', async () => {
    requests.length = 0;
    const [run] = await runProbes(B(), [{ url: `${server.origin}/between.html`, index: 0 }], [imageVia('/img/redirect-ok')], OPTS);
    expect(run!.findings).toEqual([]);
    expect(requests).toContain('GET /images/a.png');
  }, 30_000);

  it('a redirect to an address the guard would stop (the browser follows it without asking) makes it not_testable', async () => {
    const [run] = await runProbes(B(), [{ url: `${server.origin}/between.html`, index: 0 }], [imageVia('/img/redirect-bad')], OPTS);
    expect(run!.findings).toEqual([{ criterion: '0.0.1', status: 'not_testable', detail: UNSETTLED_AFTER }]);
  }, 30_000);
});

describe('probe runner: the gap between two probes on one page (real browser)', () => {
  const where = probe('where', async (ctx) => [{ criterion: '0.0.1', status: 'no_failures_found', detail: await ctx.page.evaluate(() => location.pathname, undefined) }]);
  /** A probe that sets the page's own timer to go to `to` 200 ms after the probe ends. */
  const leaveSoon = (to: string) => probe('leave-soon', async (ctx) => {
    await ctx.page.evaluate((u: string) => { setTimeout(() => { location.href = u; }, 200); }, to);
    return [];
  });

  it('holds the page\'s own navigation between probes: the next probe runs on the page under test', async () => {
    requests.length = 0;
    const later = probe('later', where.run);
    const runs = await runProbes(slowBetween(600), [{ url: `${server.origin}/between.html`, index: 0 }], [leaveSoon('/elsewhere-between.html'), where, later], OPTS);
    expect(runs.map((r) => [r.probe, r.status])).toEqual([['leave-soon', 'ok'], ['where', 'ok'], ['later', 'ok']]);
    expect(runs[1]!.findings).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: '/between.html' })]);
    expect(runs[2]!.findings).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: '/between.html' })]);
    // Nothing went to the other address: the navigation was held, as during a probe.
    expect(requests.filter((r) => r.includes('elsewhere-between'))).toEqual([]);
  }, 30_000);

  it('holds the page\'s own reload of itself between probes too (only the runner loads the page)', async () => {
    requests.length = 0;
    const reloadSoon = probe('reload-soon', async (ctx) => {
      await ctx.page.evaluate(() => { setTimeout(() => { location.reload(); }, 200); }, undefined);
      return [];
    });
    const runs = await runProbes(slowBetween(600), [{ url: `${server.origin}/between.html`, index: 0 }], [reloadSoon, where], OPTS);
    expect(runs.map((r) => [r.probe, r.status])).toEqual([['reload-soon', 'ok'], ['where', 'ok']]);
    expect(runs[1]!.findings).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: '/between.html' })]);
    expect(requests.filter((r) => r.startsWith('GET /between.html'))).toHaveLength(1);
  }, 30_000);

  it('gives the next probe not_testable when the page left by itself between probes (a navigation the guard never sees)', async () => {
    let ran = 0;
    const counted = probe('where', async (ctx) => { ran++; return where.run(ctx); });
    const later = probe('later', where.run);
    const runs = await runProbes(slowBetween(600), [{ url: `${server.origin}/between.html`, index: 0 }], [leaveSoon('about:blank'), counted, later], OPTS);
    expect(runs.map((r) => [r.probe, r.status])).toEqual([['leave-soon', 'ok'], ['where', 'ok'], ['later', 'ok']]);
    expect(ran).toBe(0);
    expect(runs[1]!.findings).toEqual([{ criterion: '0.0.1', status: 'not_testable', detail: LEFT_BY_ITSELF }]);
    expect(LEFT_BY_ITSELF).toBe('the page loaded another page by itself, so this test was not run on it');
    // The probe after it runs on the page under test again (the runner loads it).
    expect(runs[2]!.findings).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: '/between.html' })]);
  }, 30_000);

  it('a history change of the address in the gap is the same document: the next probe runs', async () => {
    let ran = 0;
    const counted = probe('where', async (ctx) => { ran++; return where.run(ctx); });
    const runs = await runProbes(inGap(async (ev) => { await ev(() => history.pushState({}, '', '/between.html?tab=2')); }),
      [{ url: `${server.origin}/between.html`, index: 0 }], [probe('first', async () => []), counted], OPTS);
    expect(ran).toBe(1);
    expect(runs[1]!.findings).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: '/between.html' })]);
  }, 30_000);

  it('a page that left and came back from the back-forward cache in the gap is caught (pagehide/pageshow)', async () => {
    let ran = 0;
    const counted = probe('where', async (ctx) => { ran++; return where.run(ctx); });
    // A restore from the back-forward cache keeps the document and its time origin; only its
    // pagehide and pageshow events show the trip (Chromium under automation does not cache pages, so
    // the events stand in for one).
    const runs = await runProbes(inGap(async (ev) => {
      await ev(() => { dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
    }), [{ url: `${server.origin}/between.html`, index: 0 }], [probe('first', async () => []), counted], OPTS);
    expect(ran).toBe(0);
    expect(runs[1]!.findings).toEqual([{ criterion: '0.0.1', status: 'not_testable', detail: LEFT_BY_ITSELF }]);
  }, 30_000);

  it('about:blank and history.back() in the gap: caught, never run on the wrong page', async () => {
    let ran = 0;
    const counted = probe('where', async (ctx) => { ran++; return where.run(ctx); });
    const runs = await runProbes(inGap(async (ev) => {
      await ev(() => { location.href = 'about:blank'; }).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      await ev(() => { history.back(); }).catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }), [{ url: `${server.origin}/between.html`, index: 0 }], [probe('first', async () => []), counted], OPTS);
    expect(ran).toBe(0);
    expect(runs[1]!.findings).toEqual([{ criterion: '0.0.1', status: 'not_testable', detail: LEFT_BY_ITSELF }]);
  }, 30_000);

  it('a page a probe itself sent elsewhere is loaded again for the next probe (no result is lost)', async () => {
    const away = probe('away', async (ctx) => {
      await ctx.page.evaluate(() => { location.href = 'about:blank'; }, undefined);
      await ctx.page.waitForTimeout(300);
      return [];
    });
    const runs = await runProbes(B(), [{ url: `${server.origin}/between.html`, index: 0 }], [away, where], OPTS);
    expect(runs[1]!.findings).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: '/between.html' })]);
  }, 30_000);
});

describe('scanSite with probes (real browser)', () => {
  let report: SiteReport;
  beforeAll(async () => {
    report = await scanSite(`${server.origin}/`, { browser: B(), maxPages: 10, probes: [exampleProbe] });
  }, 90_000);

  it('runs the probes on the template sample (one news page stands for both)', () => {
    expect(report.meta.pageList.map((u) => new URL(u).pathname)).toEqual(['/', '/about.html', '/news/1.html', '/news/2.html']);
    expect(report.probes!.runs.map((r) => [new URL(r.page).pathname, r.probe, r.status])).toEqual([
      ['/', 'example', 'ok'], ['/about.html', 'example', 'ok'], ['/news/1.html', 'example', 'ok'],
    ]);
    // The home page's button handler was recorded.
    expect(report.probes!.runs[0]!.findings[0]!.detail).toBe('1 listener groups recorded');
    // A clean result's first detail becomes the method's note (what it covered).
    expect(probeCriteriaResults(report.probes!.runs)).toEqual([{ criterion: '0.0.1', method: { id: 'example', kind: 'interaction', status: 'no_failures_found', pages: 3, note: '1 listener groups recorded' }, evidence: [] }]);
  });
});
