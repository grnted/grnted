// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The popup blocker of the listener hook (src/probes/listeners.ts) in real Chromium. In Cloudflare's
// browser a popup's first request is not routed, so the request guard cannot stop it: the page must
// never open a window at all. The first suite runs the hook alone, with no request routing, as there:
// the fixture server's request log is the proof that nothing a new window would load was requested.
import { createServer, type IncomingMessage } from 'node:http';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { installGuard } from '../../src/probes/guard.js';
import { listenerHookScript, popupReportPrefix } from '../../src/probes/listeners.js';
import { runProbes } from '../../src/probes/runner.js';
import type { GuardEvent, PageProbe } from '../../src/probes/types.js';
import type { BrowserLike, ContextLike, PageLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const requests: string[] = [];
const NONCE = 'test-nonce-1234';
const PREFIX = popupReportPrefix(NONCE);
const path = (u?: string) => {
  try {
    return u ? new URL(u).pathname : '';
  } catch {
    return u ?? '';
  }
};
const popupRequests = () => requests.filter((r) => r.includes('/pop/'));

beforeAll(async () => {
  server = await startFixtureServer('probes', {
    '/go-grok': { type: 'text/html', status: 302, headers: { location: '/go-grok-2' } },
    '/go-grok-2': { type: 'text/html', status: 301, headers: { location: '/popups-grok.html' } },
    '/go-popups': { type: 'text/html', status: 307, headers: { location: '/popups.html' } },
    '/popups-spec-headers.html': {
      type: 'text/html; charset=utf-8', body: '<!doctype html><title>Speculative loads by header</title><main><h1>By header</h1></main>',
      headers: { 'speculation-rules': '"/spec-rules.json"', link: '</pop/link-header-prefetch>; rel=prefetch, </pop/link-header-prerender>; rel=prerender' },
    },
    '/spec-rules.json': { type: 'application/speculationrules+json', body: '{"prefetch":[{"source":"list","urls":["/pop/header-prefetch"]}],"prerender":[{"source":"list","urls":["/pop/header-prerender"]}]}' },
  }, { onRequest: (req: IncomingMessage) => requests.push(`${req.method} ${req.url}`) });
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('popup blocker in the page alone (no request routing, as in Cloudflare\'s browser)', () => {
  let context: BrowserContext;
  let page: Page;
  let reports: string[];
  let pages: number;

  beforeEach(async () => {
    reports = [];
    pages = 0;
    requests.length = 0;
    context = await browser.newContext();
    await context.addInitScript({ content: listenerHookScript(NONCE) });
    context.on('page', () => { pages++; });
    page = await context.newPage();
    page.on('console', (m) => {
      const t = m.text();
      if (t.startsWith(PREFIX)) reports.push(t.slice(PREFIX.length));
    });
  });

  afterEach(async () => {
    await context.close();
  });

  /** Runs `act` and waits until the page reported a window at `want` (a path) after it. */
  async function reported(want: string, act: () => Promise<unknown>): Promise<void> {
    const n = reports.length;
    await act();
    await expect.poll(() => reports.slice(n).map(path), { timeout: 3000, message: want }).toContain(want);
  }
  const click = (sel: string) => () => page.evaluate((s: string) => (document.querySelector(s) as HTMLElement).click(), sel);
  const shadow = (fn: string) => () => page.evaluate((f: string) => {
    const root = document.getElementById('host')!.shadowRoot!;
    if (f === 'click') (root.getElementById('sb') as HTMLElement).click();
    else (root.getElementById('sform') as HTMLFormElement).requestSubmit();
  }, fn);
  const quiet = async (act: () => Promise<unknown>) => {
    const n = reports.length;
    await act();
    await page.waitForTimeout(200);
    expect(reports.slice(n)).toEqual([]);
  };

  it('stops every way a page opens a window, and still lets the page work in its own window', async () => {
    await page.goto(`${server.origin}/popups.html`);
    // While loading: the page itself, a frame of another origin, a data: frame and an object element's frame.
    for (const want of ['/pop/onload', '/pop/frame-xo', '/pop/data', '/pop/frame-obj']) {
      await expect.poll(() => reports.map(path), { timeout: 3000, message: want }).toContain(want);
    }

    // Script: window.open (direct, from a timer, a reference saved before the page ran, a new about:blank
    // frame's own), document.open with three arguments, a link not in the page, a click the page
    // cannot cancel, a form in a shadow root.
    await reported('/pop/open', click('#open'));
    await reported('/pop/timer', click('#open-timer'));
    await reported('/pop/saved', click('#open-saved'));
    await reported('/pop/blank-frame', click('#open-blank-frame'));
    await reported('/pop/docopen', click('#open-docopen'));
    await reported('/pop/detached', click('#detached'));
    await reported('/pop/noncancel', click('#noncancel'));
    await reported('/pop/shadow-form', shadow('click'));
    await reported('/pop/shadow-form', shadow('requestSubmit'));
    await reported('/pop/form-post', click('#submit-call'));
    // A shadow root the parser made (no attachShadow call, so no listener of ours on it).
    await reported('/pop/declarative', () => page.evaluate(() => (document.getElementById('host-declarative')!.shadowRoot!.getElementById('dform') as HTMLFormElement).requestSubmit()));
    await reported('/pop/declarative', () => page.click('#db'));
    expect(await page.evaluate(() => (window as unknown as { __openResult: unknown }).__openResult)).toBeNull();

    // Links, areas, SVG links and forms that target a new window: clicked by script and by a person.
    for (const [sel, want] of [
      ['#blank', '/pop/blank'], ['#blank-upper', '/pop/blank-upper'], ['#named', '/pop/named'], ['#area', '/pop/area'],
      ['#fget-b', '/pop/form-get'], ['#fpost-b', '/pop/form-post'], ['#fsub-b', '/pop/formtarget'],
      ['#late-link', '/pop/late-link'], ['#flate-b', '/pop/late-form'], ['#flate-attr-b', '/pop/late-form-attr'],
    ] as const) {
      await reported(want, click(sel));
      if (sel !== '#area') await reported(want, () => page.click(sel));
    }
    await reported('/pop/area', () => page.click('img[usemap]'));
    await reported('/pop/svg', () => page.evaluate(() => document.getElementById('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))));
    await reported('/pop/svg', () => page.click('#svg text'));
    await reported('/pop/shadow-form', () => page.click('#sb'));
    await reported('/pop/shadow-implicit', async () => { await page.focus('#si'); await page.keyboard.press('Enter'); });
    await reported('/pop/closed', async () => {
      const box = await page.evaluate(() => {
        const r = (window as unknown as { __closedLink: HTMLElement }).__closedLink.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.mouse.click(box.x, box.y);
    });
    await reported('/pop/closed', () => page.evaluate(() => (window as unknown as { __closedLink: HTMLElement }).__closedLink.click()));
    // A base element added by the click's own handler (the browser's own click: checked between listeners).
    await reported('/pop/late-base', () => page.click('#late-base'));

    // Keys and modifiers: Enter on a new-window link, shift+Enter on a plain link and in a form,
    // ctrl/cmd-click, shift-click and middle-click on a plain link.
    await reported('/pop/blank', async () => { await page.focus('#blank'); await page.keyboard.press('Enter'); });
    await reported('/pop/plain', async () => { await page.focus('#plain'); await page.keyboard.press('Shift+Enter'); });
    await reported('/pop/implicit', async () => { await page.focus('#fimplicit-i'); await page.keyboard.press('Shift+Enter'); });
    await reported('/pop/plain', () => page.click('#plain', { modifiers: ['ControlOrMeta'] }));
    await reported('/pop/plain', () => page.click('#plain', { modifiers: ['Shift'] }));
    await reported('/pop/plain', () => page.click('#plain', { button: 'middle' }));

    // A frame's own button.
    await reported('/pop/frame', () => page.frameLocator('#kid').locator('#fopen').click());

    // What stays as for any visitor: a link into a named frame that exists, an in-page link,
    // window.open in this window, a dialog form.
    await quiet(() => page.click('#to-kid'));
    await expect.poll(() => requests).toContain('GET /popups-frame.html?via=link');
    await quiet(() => page.click('#frag'));
    expect(new URL(page.url()).hash).toBe('#end');
    await page.evaluate(() => { history.replaceState(null, '', location.pathname); });
    await quiet(click('#open-self'));
    expect(new URL(page.url()).hash).toBe('#end');
    expect(await page.evaluate(() => (window as unknown as { __selfResult: unknown }).__selfResult === window)).toBe(true);
    await quiet(click('#fdialog-b'));
    // Links the page clicks by script that open nothing new still work (a link not in the page, a
    // click the page cannot cancel); a link in a document with no window does nothing.
    await quiet(click('#detached-ok'));
    expect(new URL(page.url()).hash).toBe('#detached-ok');
    await page.evaluate(() => { history.replaceState(null, '', location.pathname); });
    await quiet(click('#noncancel-ok'));
    expect(new URL(page.url()).hash).toBe('#end');
    await quiet(click('#windowless'));

    // A page that breaks preventDefault, toLowerCase and getAttribute changes nothing.
    await page.evaluate(() => document.getElementById('tamper')!.click());
    await reported('/pop/tampered', () => page.click('#tampered'));
    await reported('/pop/tampered', click('#tampered'));

    await page.waitForTimeout(300);
    expect(popupRequests()).toEqual([]);
    expect(pages).toBe(1);
    expect(context.pages()).toHaveLength(1);
  }, 90_000);

  it('a click the page cannot cancel is never delivered as it is: the page gets a cancelable copy, on any element', async () => {
    await page.goto(`${server.origin}/popups.html`);
    const seen = await page.evaluate(() => {
      const out: { same: boolean; cancelable: boolean; type: string }[] = [];
      const div = document.getElementById('end')!;
      for (const type of ['click', 'auxclick']) {
        const ev = new MouseEvent(type, { bubbles: true, button: type === 'auxclick' ? 1 : 0 });
        const fn = (e: Event) => { out.push({ same: e === ev, cancelable: e.cancelable, type: e.type }); };
        div.addEventListener(type, fn);
        div.dispatchEvent(ev);
        div.removeEventListener(type, fn);
      }
      return out;
    });
    expect(seen).toEqual([{ same: false, cancelable: true, type: 'click' }, { same: false, cancelable: true, type: 'auxclick' }]);
  }, 30_000);

  it('a base element that sends every link and form to a new window', async () => {
    await page.goto(`${server.origin}/popups-base.html`);
    await reported('/pop/base-link', () => page.click('#base-link'));
    await reported('/pop/base-link', click('#base-link'));
    await reported('/pop/base-form', () => page.click('#bform-b'));
    await quiet(() => page.click('#self'));
    expect(new URL(page.url()).hash).toBe('#end');
    await page.waitForTimeout(300);
    expect(popupRequests()).toEqual([]);
    expect(pages).toBe(1);
  }, 30_000);
});

describe('popup blocker with the probe runner (real browser)', () => {
  const probe = (id: string, run: PageProbe['run'], extra: Partial<PageProbe> = {}): PageProbe =>
    ({ id, criteria: ['0.0.1'], kind: 'interaction', tier: 'core', timeoutMs: 15_000, run, ...extra });

  it('a window the page opens as it loads is recorded with no probe and never opened; the probes still run', async () => {
    requests.length = 0;
    let events: GuardEvent[] = [];
    let result: unknown = 'unset';
    const reader = probe('reader', async (ctx) => {
      events = [...ctx.guard.events];
      result = await ctx.page.evaluate(() => (window as unknown as { __popupResult: unknown }).__popupResult, undefined);
      return [{ criterion: '0.0.1', status: 'no_failures_found', detail: 'ran' }];
    });
    const [run] = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/popup-onload.html`, index: 0 }], [reader], { userAgent: 'grnted-test' });
    expect(run!.findings).toEqual([{ criterion: '0.0.1', status: 'no_failures_found', detail: 'ran' }]);
    expect(result).toBeNull();
    expect(events.filter((e) => e.kind === 'popup').map((e) => [path(e.url), e.probe])).toEqual([['/pop/onload-runner', undefined]]);
    expect(popupRequests()).toEqual([]);
  }, 30_000);

  it('a window a timer opens between two probes is recorded with no probe and never opened', async () => {
    requests.length = 0;
    let events: GuardEvent[] = [];
    // The runner's tidy-up between the probes starts 600 ms late, so the page's 200 ms timer fires in the gap.
    const slow = {
      async newContext(o: Parameters<Browser['newContext']>[0]) {
        const context = await browser.newContext(o);
        const newPage = context.newPage.bind(context);
        return Object.assign(context, {
          async newPage() {
            const p = await newPage();
            const evaluate = p.evaluate.bind(p) as (...a: unknown[]) => Promise<unknown>;
            return Object.assign(p, {
              async evaluate(fn: unknown, ...rest: unknown[]) {
                if ((fn as { name?: string }).name === 'resetPage') await new Promise((r) => setTimeout(r, 600));
                return evaluate(fn, ...rest);
              },
            });
          },
        });
      },
    } as unknown as BrowserLike;
    const first = probe('first', async (ctx) => {
      await ctx.page.evaluate(() => { setTimeout(() => { window.open('/pop/between'); }, 200); }, undefined);
      return [];
    });
    const second = probe('second', async (ctx) => {
      events = [...ctx.guard.events];
      return [];
    });
    await runProbes(slow, [{ url: `${server.origin}/between.html`, index: 0 }], [first, second], { userAgent: 'grnted-test' });
    expect(events.filter((e) => e.kind === 'popup').map((e) => [path(e.url), e.probe])).toEqual([['/pop/between', undefined]]);
    expect(popupRequests()).toEqual([]);
  }, 30_000);
});

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

// The fixture server is local, so these force the sandbox ('always'); by default ('auto') a page at a
// local address is not sandboxed (see GuardOptions.sandbox).
describe('the sandbox backstop: documents the guard lets through cannot open windows (real browser)', () => {
  /** Script-driven ways to open a window in popups.html (a person's ctrl/cmd-, middle- or shift-click is the hook's job: see below). */
  async function scriptPopups(page: Page): Promise<void> {
    const ids = ['open', 'open-timer', 'open-docopen', 'open-saved', 'open-blank-frame', 'detached', 'noncancel', 'blank', 'blank-upper', 'named', 'area',
      'fget-b', 'fpost-b', 'fsub-b', 'flate-b', 'flate-attr-b', 'late-link', 'submit-call'];
    for (const id of ids) {
      await page.evaluate((x: string) => (document.getElementById(x) as HTMLElement).click(), id);
      await page.waitForTimeout(60);
    }
    await page.evaluate(() => document.getElementById('host')!.shadowRoot!.getElementById('sb')!.click());
    await page.evaluate(() => document.getElementById('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    for (const sel of ['#blank', '#named', '#fget-b', '#fpost-b', '#late-link', '#late-base', '#svg text']) await page.click(sel);
    await page.focus('#blank');
    await page.keyboard.press('Enter');
    await page.frameLocator('#kid').locator('#fopen').click();
  }

  for (const [name, start] of [['loaded directly', '/popups.html'], ['reached through a server redirect', '/go-popups']] as const) it(`with the hook OFF, no script-driven popup in popups.html opens a window or loads anything (${name})`, async () => {
    requests.length = 0;
    const context = await browser.newContext();
    let pages = 0;
    context.on('page', () => { pages++; });
    try {
      const page = await context.newPage();
      const guard = await installGuard(context as unknown as ContextLike, page as unknown as PageLike, `${server.origin}${start}`, { sandbox: 'always' });
      expect(guard!.popupSandbox).toBe('on');
      await page.goto(`${server.origin}${start}`);
      expect(new URL(page.url()).pathname).toBe('/popups.html');
      guard!.setPageUrl(page.url());
      guard!.setPhase({ probe: 'backstop' });
      await page.waitForTimeout(300); // the frames' own windows as they load
      await scriptPopups(page);
      await page.waitForTimeout(500);
      expect(pages, 'no window was ever created').toBe(1);
      expect(popupRequests()).toEqual([]);
      // With no hook, the browser's own console error for each refused window is what the guard logs.
      const logged = guard!.log.events.filter((e) => e.kind === 'popup' && e.probe === 'backstop').map((e) => path(e.url));
      for (const want of ['/pop/open', '/pop/blank', '/pop/form-post', '/pop/form-get', '/pop/named', '/pop/frame']) expect(logged, want).toContain(want);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('with both layers on, the guard logs each of them under the probe, and no window opens', async () => {
    requests.length = 0;
    let events: GuardEvent[] = [];
    const count = { pages: 0 };
    const p = {
      id: 'both', criteria: ['0.0.1'], kind: 'interaction', tier: 'core', timeoutMs: 30_000,
      async run(ctx) {
        await scriptPopups(ctx.page as unknown as Page);
        await ctx.page.waitForTimeout(300);
        await ctx.guard.settled?.(1000);
        events = [...ctx.guard.events];
        return [];
      },
    } as PageProbe;
    await runProbes(countingPages(count), [{ url: `${server.origin}/popups.html`, index: 0 }], [p], { userAgent: 'grnted-test', popupSandbox: 'always' });
    expect(count.pages).toBe(1);
    expect(popupRequests()).toEqual([]);
    const logged = new Set(events.filter((e) => e.kind === 'popup' && e.probe === 'both').map((e) => path(e.url)));
    for (const want of ['/pop/open', '/pop/timer', '/pop/docopen', '/pop/saved', '/pop/blank-frame', '/pop/detached', '/pop/noncancel', '/pop/blank', '/pop/blank-upper',
      '/pop/named', '/pop/area', '/pop/form-get', '/pop/form-post', '/pop/formtarget', '/pop/late-form', '/pop/late-form-attr', '/pop/late-link', '/pop/form-post',
      '/pop/shadow-form', '/pop/svg', '/pop/late-base', '/pop/frame']) expect(logged, want).toContain(want);
  }, 60_000);

  // Grok review round 1: races and realms the hook cannot reach. Only the safety outcome is asserted.
  async function grokAttempts(page: Page): Promise<void> {
    // 1: a script click whose handler inserts a base element; 2: formdata retargets the form.
    await page.evaluate(() => document.getElementById('script-base')!.click());
    await page.evaluate(() => (document.getElementById('fd') as HTMLFormElement).requestSubmit());
    await page.click('#fd-b');
    // 3: a frame with scripts off: form.submit() to a new window, and its window.open used on this window.
    await page.evaluate(() => document.getElementById('clean-submit')!.click());
    await page.evaluate(() => document.getElementById('stolen')!.click());
    // 4: Window.prototype.open, and open after deleting it.
    await page.evaluate(() => document.getElementById('proto-open')!.click());
    // 6a: a trusted click in a closed shadow root the parser made.
    const box = (await page.locator('#dhost').boundingBox())!;
    await page.mouse.click(box.x + 20, box.y + 20);
    await page.evaluate(() => document.getElementById('deleted-open')!.click());
    await page.waitForTimeout(500);
  }
  const grokState = (page: Page) => page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return { where: w.__openWhere, url: location.pathname };
  });
  // In this Chromium, open is the window's own property (Window.prototype has none).
  const GROK_STATE = { where: { own: true, proto: 'undefined' }, url: '/popups-grok.html' };

  for (const [name, start] of [['loaded directly', '/popups-grok.html'], ['reached through two server redirects', '/go-grok']] as const) it(`with the hook OFF, the races and realms of popups-grok.html open nothing (${name})`, async () => {
    requests.length = 0;
    const context = await browser.newContext();
    let pages = 0;
    context.on('page', () => { pages++; });
    try {
      const page = await context.newPage();
      const guard = await installGuard(context as unknown as ContextLike, page as unknown as PageLike, `${server.origin}${start}`, { sandbox: 'always' });
      await page.goto(`${server.origin}${start}`);
      guard!.setPageUrl(page.url());
      guard!.setPhase({ probe: 'backstop' });
      await grokAttempts(page);
      expect(pages, 'no window was ever created').toBe(1);
      expect(popupRequests()).toEqual([]);
      expect(await grokState(page)).toEqual(GROK_STATE);
      const logged = guard!.log.events.filter((e) => e.kind === 'popup' && e.probe === 'backstop').map((e) => path(e.url));
      for (const want of ['/pop/g-base', '/pop/g-formdata', '/pop/g-closed', '/pop/g-srcdoc', '/pop/g-stolen']) expect(logged, want).toContain(want);
    } finally {
      await context.close();
    }
  }, 60_000);

  for (const [name, url] of [['loaded directly', '/popups-grok.html'], ['reached through two server redirects', '/go-grok']] as const) {
    it(`with both layers, the races and realms of popups-grok.html open nothing (${name})`, async () => {
      requests.length = 0;
      let state: unknown;
      let stolenHooked: unknown;
      const count = { pages: 0 };
      const p = {
        id: 'grok', criteria: ['0.0.1'], kind: 'interaction', tier: 'core', timeoutMs: 30_000,
        async run(ctx) {
          const page = ctx.page as unknown as Page;
          await grokAttempts(page);
          state = await grokState(page);
          stolenHooked = await page.evaluate(() => (window as unknown as { __stolenHooked: unknown }).__stolenHooked);
          return [];
        },
      } as PageProbe;
      const [run] = await runProbes(countingPages(count), [{ url: `${server.origin}${url}`, index: 0 }], [p], { userAgent: 'grnted-test', popupSandbox: 'always' });
      expect(run!.status).toBe('ok');
      expect(count.pages, 'no window was ever created').toBe(1);
      expect(popupRequests()).toEqual([]);
      expect(state).toEqual(GROK_STATE);
      // Chromium runs the init script even in a frame with scripts off (it keeps the window of the
      // frame's first about:blank document), so that realm is hooked too; the sandbox covers it either way.
      expect(stolenHooked).toBe(true);
      if (url === '/go-grok') expect(requests.filter((r) => /go-grok|popups-grok/.test(r))).toEqual(['GET /go-grok', 'GET /go-grok-2', 'GET /popups-grok.html']);
    }, 60_000);
  }

  /** A context with the guard (sandbox always) and no hook; `pages` counts every page it opens. */
  async function hookOff(url: string): Promise<{ context: Awaited<ReturnType<Browser['newContext']>>; page: Page; guard: NonNullable<Awaited<ReturnType<typeof installGuard>>>; pages: () => number }> {
    const context = await browser.newContext();
    let n = 0;
    context.on('page', () => { n++; });
    const page = await context.newPage();
    const guard = (await installGuard(context as unknown as ContextLike, page as unknown as PageLike, url, { sandbox: 'always' }))!;
    expect(guard.popupSandbox).toBe('on');
    return { context, page, guard, pages: () => n };
  }

  it('with the hook OFF, a blob: page the sandboxed page navigates to cannot open a window (Grok round 2 #2)', async () => {
    requests.length = 0;
    const t = await hookOff(`${server.origin}/popups-grok.html`);
    try {
      await t.page.goto(`${server.origin}/popups-grok.html`);
      t.guard.setPageUrl(t.page.url());
      t.guard.setPhase({ probe: 'backstop' });
      await t.page.evaluate(() => {
        location.href = URL.createObjectURL(new Blob(['<script>window.open("' + location.origin + '/pop/blob")<\/script>'], { type: 'text/html' }));
      });
      await t.page.waitForTimeout(800);
      expect(t.page.url()).toMatch(/^blob:/);
      expect(t.pages()).toBe(1);
      expect(popupRequests()).toEqual([]);
    } finally {
      await t.context.close();
    }
  }, 30_000);

  /** A server of its own: a page with an ETag (a reload is answered 304), and gzip and brotli copies of one page. */
  async function ownServer(): Promise<{ origin: string; seen: string[]; close(): Promise<void> }> {
    const seen: string[] = [];
    const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Own</title></head><body><p id="p">café ✓ déjà vu</p></body></html>';
    const srv = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers['if-none-match'] ?? ''}`.trim());
      if (req.url === '/etag.html') {
        if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304, { etag: '"v1"' }); res.end(); return; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"v1"', 'cache-control': 'max-age=0, must-revalidate' });
        res.end(html);
        return;
      }
      if (req.url === '/gzip.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' }); res.end(gzipSync(html)); return; }
      if (req.url === '/br.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'br' }); res.end(brotliCompressSync(html)); return; }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    return { origin: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, seen, close: () => new Promise((r) => srv.close(() => r())) };
  }

  it('with the hook OFF, a page loaded again with an ETag comes from the server, sandboxed, never from the cache (Grok round 2 #1)', async () => {
    const own = await ownServer();
    const t = await hookOff(`${own.origin}/etag.html`);
    try {
      for (let i = 0; i < 2; i++) {
        t.guard.setPhase('between');
        t.guard.setPageUrl(`${own.origin}/etag.html`);
        t.guard.setPhase('load');
        await t.page.goto(`${own.origin}/etag.html`);
      }
      t.guard.setPhase({ probe: 'backstop' });
      expect(await t.page.textContent('#p')).toBe('café ✓ déjà vu');
      expect(await t.page.evaluate(() => window.open('/pop/etag'))).toBeNull();
      await t.page.waitForTimeout(400);
      expect(t.pages()).toBe(1);
      // Both loads went to the server, the second without If-None-Match (the cache is off), so no 304.
      expect(own.seen.filter((x) => x.includes('/etag.html'))).toEqual(['GET /etag.html', 'GET /etag.html']);
      expect(own.seen.filter((x) => x.includes('/pop/'))).toEqual([]);
    } finally {
      await t.context.close();
      await own.close();
    }
  }, 30_000);

  it('a page sent with gzip or brotli reads right after the sandbox is added (Grok round 2 #7)', async () => {
    const own = await ownServer();
    const t = await hookOff(`${own.origin}/gzip.html`);
    try {
      for (const p of ['/gzip.html', '/br.html']) {
        t.guard.setPhase('between');
        t.guard.setPageUrl(own.origin + p);
        t.guard.setPhase('load');
        await t.page.goto(own.origin + p);
        expect(await t.page.textContent('#p'), p).toBe('café ✓ déjà vu');
        expect(await t.page.evaluate(() => window.open('/pop/x')), p).toBeNull();
      }
      expect(t.pages()).toBe(1);
    } finally {
      await t.context.close();
      await own.close();
    }
  }, 30_000);

  it('with the hook OFF, speculative loads a response header asks for are never made (Grok round 2 #6)', async () => {
    requests.length = 0;
    const t = await hookOff(`${server.origin}/popups-spec-headers.html`);
    try {
      await t.page.goto(`${server.origin}/popups-spec-headers.html`);
      await t.page.waitForTimeout(1500);
      expect(t.pages()).toBe(1);
      expect(popupRequests()).toEqual([]);
    } finally {
      await t.context.close();
    }
  }, 30_000);

  it('with the hook OFF, nothing is prerendered (Grok round 2 #6)', async () => {
    requests.length = 0;
    const t = await hookOff(`${server.origin}/popups-spec.html`);
    try {
      await t.page.goto(`${server.origin}/popups-spec.html`);
      await t.page.waitForTimeout(1500);
      expect(t.pages()).toBe(1);
      // Prerendering is turned off on the session. A prefetch the page asks for (speculation rules or a
      // prefetch link) is made by the browser outside any interception: without the hook only the ones
      // in its HTML would run (as for any visitor, while it loads), so those addresses are not asserted.
      expect(popupRequests().filter((r) => /prerender/.test(r))).toEqual([]);
    } finally {
      await t.context.close();
    }
  }, 30_000);

  it('with both layers, speculation rules and prefetch links the page adds are never acted on; the ones in its HTML are load-time requests (Grok round 2 #6)', async () => {
    requests.length = 0;
    const count = { pages: 0 };
    const p = {
      id: 'spec', criteria: ['0.0.1'], kind: 'interaction', tier: 'core', timeoutMs: 30_000,
      async run(ctx) { await ctx.page.waitForTimeout(1500); return []; },
    } as PageProbe;
    await runProbes(countingPages(count), [{ url: `${server.origin}/popups-spec.html`, index: 0 }], [p], { userAgent: 'grnted-test', popupSandbox: 'always' });
    expect(count.pages).toBe(1);
    // Not even the prefetch link written in the HTML (the preload scanner may ask for it before the hook
    // removes the element): the request guard aborts every request that says it is a prefetch (H0).
    expect(popupRequests()).toEqual([]);
  }, 30_000);

  it('the hook alone (sandbox off) reports a base element a script click inserts, and sends no form a formdata handler would retarget (Grok round 2 #4)', async () => {
    requests.length = 0;
    let events: GuardEvent[] = [];
    const count = { pages: 0 };
    const p = {
      id: 'hook', criteria: ['0.0.1'], kind: 'interaction', tier: 'core', timeoutMs: 30_000,
      async run(ctx) {
        const page = ctx.page as unknown as Page;
        await page.evaluate(() => document.getElementById('script-base')!.click());
        await page.evaluate(() => { document.querySelectorAll('base').forEach((b) => b.remove()); });
        await page.evaluate(() => (document.getElementById('fd') as HTMLFormElement).requestSubmit());
        await page.click('#fd-b');
        await page.waitForTimeout(400);
        await ctx.guard.settled?.(1000);
        events = [...ctx.guard.events];
        return [];
      },
    } as PageProbe;
    await runProbes(countingPages(count), [{ url: `${server.origin}/popups-grok.html`, index: 0 }], [p], { userAgent: 'grnted-test', popupSandbox: 'off' });
    expect(count.pages, 'no window was ever created').toBe(1);
    const logged = events.filter((e) => e.kind === 'popup' && e.probe === 'hook').map((e) => path(e.url));
    expect(logged).toContain('/pop/g-base');
    // The form never gets as far as its formdata event: the hook sends no form (requestSubmit fires a
    // synthetic submit event, a trusted one is cancelled), so there is no submission to retarget.
    expect(requests.filter((r) => r.includes('/pop/g-formdata'))).toEqual([]);
  }, 30_000);
});
