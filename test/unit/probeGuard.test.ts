// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { isAnalyticsAddress } from '../../src/analytics.js';
import { describe, expect, it, vi } from 'vitest';
import { backgroundWrites } from '../../src/probes/runner.js';
import { STATIC_FILE_HOSTS, blockedReason, decideRequest, guardStop, installGuard, onHostList, isActionUrl, isLocalAddress, isSpeculativeRequest, routeWebSocketsEarly, GUARD_LOG_CAP, POPUP_SANDBOX, SANDBOX_BODY_CAP, sandboxedHeaders, withoutSpeculativeHeaders, type GuardRequest, type SandboxMode } from '../../src/probes/guard.js';
import { popupReportPrefix } from '../../src/probes/listeners.js';
import type { ContextLike, PageLike, RequestLike, RouteLike } from '../../src/types.js';

const PAGE = 'https://e.org/news/1';
const req = (method: string, url: string, resourceType = 'fetch', mainFrameNavigation = false): GuardRequest => ({ method, url, resourceType, mainFrameNavigation });
const probe = { pageUrl: PAGE, phase: 'probe' as const };
const loading = { pageUrl: PAGE, phase: 'load' as const };

describe('isActionUrl', () => {
  it.each([
    'https://e.org/logout', 'https://e.org/account/log-out', 'https://e.org/user/sign_out', 'https://e.org/signout?next=/',
    'https://e.org/items/delete?id=1', 'https://e.org/api/remove/7', 'https://e.org/newsletter/unsubscribe?t=abc',
    'https://e.org/cart', 'https://e.org/shop/cart/add', 'https://e.org/?add-to-cart=12', 'https://e.org/checkout/step-1',
    'https://e.org/pay', 'https://e.org/payment/confirm', 'https://e.org/purchase', 'https://e.org/order?item=5',
    'https://e.org/donate', 'https://e.org/poll/vote?choice=2', 'https://e.org/subscribe', 'https://e.org/index.php?action=edit',
    'https://e.org/index.php?option=com_users&task=user.logout', 'https://e.org/wiki?do=x', 'https://www.paypal.com/cgi-bin/webscr?cmd=_donations',
    'https://e.org/events/12/rsvp', 'https://e.org/%64elete',
    'https://e.org/bag/add?sku=1', 'https://e.org/api/transfer', 'https://e.org/account/erase', 'https://e.org/sign-off', 'https://e.org/signoff',
    'https://e.org/check-out', 'https://e.org/api/session/end', 'https://e.org/end-session', 'https://e.org/close-account', 'https://e.org/api/close_my_account',
  ])('%s is an action', (url) => expect(isActionUrl(url)).toBe(true));

  it.each([
    'https://e.org/', 'https://e.org/about', 'https://e.org/news/2026-spring-open-house', 'https://e.org/border-collie-club',
    'https://e.org/departments/payroll', 'https://e.org/calendar?month=5', 'https://e.org/search?q=report+card', 'https://e.org/ordering-info',
    'https://e.org/data.json', 'not a url',
  ])('%s is not an action', (url) => expect(isActionUrl(url)).toBe(false));
});

describe('decideRequest', () => {
  it('blocks every method but GET and HEAD, everywhere', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'post']) {
      expect(decideRequest(req(method, 'https://e.org/api/item'), probe)).toEqual({ action: 'block', reason: 'method' });
      expect(decideRequest(req(method, PAGE, 'document', true), loading)).toEqual({ action: 'block', reason: 'method' });
    }
    expect(decideRequest(req('HEAD', 'https://e.org/x.pdf'), probe)).toEqual({ action: 'continue' });
  });

  it('blocks action GETs; static subresources are exempt only while the page loads; the page itself is allowed', () => {
    expect(decideRequest(req('GET', 'https://e.org/account/logout', 'xhr'), probe)).toEqual({ action: 'block', reason: 'action' });
    expect(decideRequest(req('GET', 'https://e.org/items/delete?id=1', 'document', true), probe)).toEqual({ action: 'block', reason: 'action' });
    expect(decideRequest(req('GET', 'https://e.org/items/delete?id=1', 'document', false), loading)).toEqual({ action: 'block', reason: 'action' });
    // While the page loads, a script named cart.js is not an action.
    expect(decideRequest(req('GET', 'https://e.org/assets/cart.js', 'script'), loading)).toEqual({ action: 'continue' });
    expect(decideRequest(req('GET', 'https://e.org/img/donate-banner.png', 'image'), loading)).toEqual({ action: 'continue' });
    expect(decideRequest(req('GET', 'https://e.org/logout', 'image'), loading)).toEqual({ action: 'continue' });
    // While a probe runs, a clicked control or a timer loading `/logout` as an image is an action.
    expect(decideRequest(req('GET', 'https://e.org/logout', 'image'), probe)).toEqual({ action: 'block', reason: 'action' });
    expect(decideRequest(req('GET', 'https://e.org/account/delete', 'script'), probe)).toEqual({ action: 'block', reason: 'action' });
    expect(decideRequest(req('GET', 'https://e.org/assets/cart.js', 'script'), probe)).toEqual({ action: 'block', reason: 'action' });
    expect(decideRequest(req('GET', 'https://e.org/img/photo.png', 'image'), probe)).toEqual({ action: 'continue' });
    const donate = { pageUrl: 'https://e.org/donate', phase: 'probe' as const };
    expect(decideRequest(req('GET', 'https://e.org/donate#amounts', 'document', true), donate)).toEqual({ action: 'continue' });
  });

  it('holds top-level navigations while a probe runs, and lets the page load (and redirect) as in the audit', () => {
    expect(decideRequest(req('GET', 'https://e.org/about', 'document', true), probe)).toEqual({ action: 'hold' });
    expect(decideRequest(req('GET', 'https://other.example/', 'document', true), probe)).toEqual({ action: 'hold' });
    expect(decideRequest(req('GET', PAGE, 'document', true), probe)).toEqual({ action: 'continue' });
    // While loading, only the runner's own load (and the server's redirects of it) goes ahead; the
    // page's own navigations are held, and action addresses blocked, as at any other time.
    expect(decideRequest({ ...req('GET', 'https://e.org/en/news/1', 'document', true), runnerLoad: true }, loading)).toEqual({ action: 'continue' });
    expect(decideRequest(req('GET', 'https://e.org/en/news/1', 'document', true), loading)).toEqual({ action: 'hold' });
    expect(decideRequest(req('GET', 'https://e.org/logout', 'document', true), loading)).toEqual({ action: 'block', reason: 'action' });
    // Frames and data requests are not navigations of the page.
    expect(decideRequest(req('GET', 'https://www.youtube.com/embed/x', 'document', false), probe)).toEqual({ action: 'continue' });
    expect(decideRequest(req('GET', 'https://e.org/data.json', 'fetch'), probe)).toEqual({ action: 'continue' });
  });

  it('strict (a probe that types, and after it until the page loads again): nothing is sent; navigations are held', () => {
    for (const ctx of [{ ...probe, strict: true }, { ...loading, strict: true }]) {
      for (const type of ['fetch', 'xhr', 'ping', 'eventsource', 'other', 'websocket', 'script', 'stylesheet', 'image', 'font', 'media', 'manifest']) {
        // A new address, a value in the path or the query, and an address the page already loaded: all blocked.
        for (const url of ['https://e.org/suggest?q=grntedtest', 'https://e.org/leak/grntedtest.png', 'https://e.org/app.js', 'https://e.org/v;x=grntedtest']) {
          expect(decideRequest(req('GET', url, type), ctx)).toEqual({ action: 'block', reason: 'data' });
        }
      }
      // The page's own address: other requests for it (with a header or cookie set from a value) are blocked, a reload is held.
      expect(decideRequest(req('GET', PAGE, 'xhr'), ctx)).toEqual({ action: 'block', reason: 'data' });
      expect(decideRequest(req('GET', PAGE, 'document', true), ctx)).toEqual({ action: 'hold' });
      expect(decideRequest(req('GET', 'https://e.org/about', 'document', true), ctx)).toEqual({ action: 'hold' });
      expect(decideRequest(req('GET', 'https://e.org/frame?q=grntedtest', 'document', false), ctx)).toEqual({ action: 'block', reason: 'data' });
      expect(decideRequest(req('POST', PAGE, 'document', true), ctx)).toEqual({ action: 'block', reason: 'method' });
    }
    // A late timer's pixel after the probe (load phase, still latched) is blocked.
    expect(decideRequest(req('GET', 'https://e.org/late.gif?v=grntedtest', 'image'), { ...loading, strict: true })).toEqual({ action: 'block', reason: 'data' });
    // Without strict, data GETs are allowed as before.
    expect(decideRequest(req('GET', 'https://e.org/suggest?q=Test', 'fetch'), probe)).toEqual({ action: 'continue' });
  });

  it('the allowlists: analytics and static-file hosts by registrable-domain suffix, some only at their paths; nothing else', () => {
    for (const u of ['https://www.google-analytics.com/g/collect?v=2', 'https://region1.analytics.google.com/g/collect', 'https://www.googletagmanager.com/gtag/js',
      'https://stats.g.doubleclick.net/j/collect', 'https://www.google.com/g/collect?v=2', 'https://us.i.posthog.com/i/v0/e/', 'https://i.apptegy-edge.com/i/v0/e/?_=1',
      'https://i.apptegy-edge.com/e/?retry_count=2', 'https://events.launchdarkly.com/events/bulk/x', 'https://api.segment.io/v1/batch', 'https://api-js.mixpanel.com/track/',
      'https://api2.amplitude.com/2/httpapi', 'https://in.hotjar.com/api', 'https://a.clarity.ms/collect', 'https://www.facebook.com/tr/?id=1', 'https://plausible.io/api/event',
      'https://cdn.usefathom.com/x', 'https://heapanalytics.com/h', 'https://rs.fullstory.com/rec', 'https://bam.nr-data.net/1/x', 'https://rum.browser-intake-datadoghq.com/api/v2/rum',
      'https://o1.ingest.us.sentry.io/api/1/envelope/']) expect(isAnalyticsAddress(u), u).toBe(true);
    for (const u of ['https://www.google.com/search?q=x', 'https://www.facebook.com/sharer', 'https://i.apptegy-edge.com/upload', 'https://app.launchdarkly.com/sdk/evalx',
      'https://evil-google-analytics.com/g/collect', 'https://google-analytics.com.evil.net/g/collect', 'https://e.org/api/save', 'https://203.0.113.10/checkout',
      'http://localhost:8080/checkout', 'http://127.0.0.1/x', 'https://api.shop.example.net/order', 'data:text/plain,x', 'not a url']) expect(isAnalyticsAddress(u), u).toBe(false);
    for (const u of ['https://fonts.gstatic.com/s/a.woff2', 'https://www.gstatic.com/recaptcha/styles__ltr.css', 'https://cdnjs.cloudflare.com/x.css', 'https://use.typekit.net/x.css']) expect(onHostList(u, STATIC_FILE_HOSTS)).toBe(true);
    for (const u of ['https://e.org/drag.css', 'https://cdn.e.org/x.css', 'https://gstatic.com.evil.net/x.css']) expect(onHostList(u, STATIC_FILE_HOSTS)).toBe(false);
  });

  it('explains a blocked request in plain words', () => {
    expect(blockedReason({ kind: 'blocked', method: 'POST', url: 'https://e.org/submit', reason: 'method', at: 0 }))
      .toBe('the test would have sent data to the live site (POST request to https://e.org/submit), so it was stopped');
    expect(blockedReason({ kind: 'blocked', method: 'GET', url: 'https://e.org/logout', reason: 'action', at: 0 }))
      .toBe('the test would have sent data to the live site (request to an address that looks like an action to https://e.org/logout), so it was stopped');
    expect(blockedReason({ kind: 'blocked', method: 'GET', url: 'https://e.org/suggest?q=Test', resourceType: 'fetch', reason: 'data', at: 0 }))
      .toBe('the test would have sent data to the live site (fetch request made while or after the test typed into the page to https://e.org/suggest?q=Test), so it was stopped');
  });
});

describe('installGuard', () => {
  function fakeRoute(method: string, url: string, resourceType: string, nav = false) {
    const calls: string[] = [];
    const route: RouteLike = {
      request: () => ({ method: () => method, url: () => url, resourceType: () => resourceType, isNavigationRequest: () => nav, frame: () => ({ url: () => url, parentFrame: () => null }) }),
      async abort(code) { calls.push(`abort:${code ?? ''}`); },
      async continue() { calls.push('continue'); },
    };
    return { route, calls };
  }

  it('installs on the context, records what it stops, closes popups and dismisses dialogs', async () => {
    let handler: ((r: RouteLike) => unknown) | undefined;
    const listeners: Record<string, (x: unknown) => void> = {};
    const context = { async route(_: unknown, h: (r: RouteLike) => unknown) { handler = h; } } as unknown as ContextLike;
    const page = { on: (event: string, fn: (x: unknown) => void) => { listeners[event] = fn; } } as unknown as PageLike;
    const guard = await installGuard(context, page, PAGE);
    expect(guard).not.toBeNull();

    const post = fakeRoute('POST', 'https://e.org/submit', 'document', true);
    await handler!(post.route);
    expect(post.calls).toEqual(['abort:aborted']); // a top-level navigation: no error page
    guard!.setPhase({ probe: 'keyboard' });
    const mark = guard!.log.mark();
    const xhr = fakeRoute('GET', 'https://e.org/logout', 'xhr');
    await handler!(xhr.route);
    expect(xhr.calls).toEqual(['abort:blockedbyclient']);
    const nav = fakeRoute('GET', 'https://e.org/about', 'document', true);
    await handler!(nav.route);
    expect(nav.calls).toEqual(['abort:aborted']);
    const fine = fakeRoute('GET', 'https://e.org/style.css', 'stylesheet');
    await handler!(fine.route);
    expect(fine.calls).toEqual(['continue']);

    let closed = false;
    listeners.popup!({ url: () => 'https://e.org/popup', close: async () => { closed = true; } });
    let dismissed = false;
    listeners.dialog!({ type: () => 'confirm', message: () => 'Delete everything?', dismiss: async () => { dismissed = true; } });
    expect(closed && dismissed).toBe(true);

    const strip = (e: object) => { const { at: _at, ...rest } = e as { at: number }; return rest; };
    expect(guard!.log.events.map(strip)).toEqual([
      { kind: 'blocked', url: 'https://e.org/submit', method: 'POST', resourceType: 'document', reason: 'method', mainFrame: true },
      { kind: 'blocked', url: 'https://e.org/logout', method: 'GET', resourceType: 'xhr', reason: 'action', probe: 'keyboard' },
      { kind: 'navigation', url: 'https://e.org/about', method: 'GET', probe: 'keyboard' },
      { kind: 'popup', url: 'https://e.org/popup', probe: 'keyboard' },
      { kind: 'dialog', dialog: 'confirm', message: 'Delete everything?', probe: 'keyboard' },
    ]);
    expect(guard!.log.since(mark)).toHaveLength(4);
  });

  describe('requests whose frame does not exist yet (popups)', () => {
    const NOT_CREATED = 'Frame for this navigation request is not available, because the request\nwas issued before the frame is created.';
    async function setup() {
      let handler: ((r: RouteLike) => unknown) | undefined;
      const listeners: Record<string, (x: unknown) => void> = {};
      const context = { async route(_: unknown, h: (r: RouteLike) => unknown) { handler = h; } } as unknown as ContextLike;
      const page = { on: (event: string, fn: (x: unknown) => void) => { listeners[event] = fn; } } as unknown as PageLike;
      const guard = (await installGuard(context, page, PAGE))!;
      const send = async (method: string, url: string, resourceType: string, nav: boolean, error = NOT_CREATED) => {
        const calls: string[] = [];
        await handler!({
          request: () => ({ method: () => method, url: () => url, resourceType: () => resourceType, isNavigationRequest: () => nav, frame: () => { throw new Error(error); } }),
          async abort(code) { calls.push(`abort:${code ?? ''}`); },
          async continue() { calls.push('continue'); },
        });
        return calls;
      };
      const closed: string[] = [];
      const popup = (url: string) => listeners.popup!({ url: () => url, close: async () => { closed.push(url); } });
      const popups = () => guard.log.events.filter((e) => e.kind === 'popup').map((e) => e.url);
      return { guard, send, popup, popups, closed };
    }
    const ERROR_PAGE = 'chrome-error://chromewebdata/';

    // Playwright's request.frame() throws for a navigation issued before its frame is created: a new popup.
    it('stops the navigation with an error page (so the popup event fires and closes it) and logs the address it tried to load', async () => {
      const t = await setup();
      expect(await t.send('GET', 'https://e.org/popup.html', 'document', true)).toEqual(['abort:blockedbyclient']);
      expect(t.popups()).toEqual(['https://e.org/popup.html']); // logged when stopped, under the probe running then
      t.popup(ERROR_PAGE); // our own error page: closed, not logged twice
      expect(t.popups()).toEqual(['https://e.org/popup.html']);
      expect(t.closed).toEqual([ERROR_PAGE]);
    });

    it('uses an error page for a popup the policy blocks too (POST, or an action address during a probe)', async () => {
      const t = await setup();
      t.guard.setPhase({ probe: 'keyboard' });
      expect(await t.send('POST', 'https://e.org/submit', 'document', true)).toEqual(['abort:blockedbyclient']);
      expect(await t.send('GET', 'https://e.org/account/logout', 'document', true)).toEqual(['abort:blockedbyclient']);
      expect(t.popups()).toEqual(['https://e.org/submit', 'https://e.org/account/logout']);
      expect(t.guard.log.events.filter((e) => e.kind === 'blocked').map((e) => e.reason)).toEqual(['method', 'action']);
      expect(t.guard.log.events.every((e) => e.probe === 'keyboard')).toBe(true);
    });

    it('logs each popup once, in order, whatever order the requests and popup events arrive in', async () => {
      const t = await setup();
      await t.send('GET', 'https://e.org/a.html', 'document', true);
      await t.send('GET', 'https://e.org/b.html', 'document', true);
      t.popup('about:blank'); // window.open(''): an address of its own
      t.popup(ERROR_PAGE);
      t.popup(ERROR_PAGE);
      expect(t.popups()).toEqual(['https://e.org/a.html', 'https://e.org/b.html', 'about:blank']);
      expect(t.closed).toEqual(['about:blank', ERROR_PAGE, ERROR_PAGE]);
    });

    it('still serves frameless requests that are not navigations (service workers)', async () => {
      const t = await setup();
      expect(await t.send('GET', 'https://e.org/data.json', 'fetch', false, 'Service Worker requests do not have an associated frame.')).toEqual(['continue']);
    });

    it('treats only the "frame not created yet" error as a popup', async () => {
      const t = await setup();
      t.guard.setPhase({ probe: 'keyboard' });
      // Any other frame error on a navigation is the page under test: held without an error page.
      expect(await t.send('GET', 'https://e.org/about', 'document', true, 'Frame was detached')).toEqual(['abort:aborted']);
      expect(t.popups()).toEqual([]);
    });

    it('stops what a popup loads after it opens (e.g. its favicon) without logging it as another popup', async () => {
      let handler: ((r: RouteLike) => unknown) | undefined;
      const context = { async route(_: unknown, h: (r: RouteLike) => unknown) { handler = h; } } as unknown as ContextLike;
      const page = { on: () => {} } as unknown as PageLike;
      const guard = (await installGuard(context, page, PAGE))!;
      const other = {} as PageLike;
      const calls: string[] = [];
      await handler!({
        request: () => ({ method: () => 'GET', url: () => 'https://e.org/favicon.ico', resourceType: () => 'image', isNavigationRequest: () => false, frame: () => ({ url: () => 'https://e.org/', parentFrame: () => null, page: () => other }) }),
        async abort(code) { calls.push(`abort:${code ?? ''}`); },
        async continue() { calls.push('continue'); },
      });
      expect(calls).toEqual(['abort:blockedbyclient']);
      expect(guard.log.events).toEqual([]);
    });
  });

  describe('windows the page reported it did not open (the listener hook\'s popup blocker)', () => {
    const NONCE = 'n0nce';
    async function setup(withNonce = true) {
      const pageListeners: Record<string, ((x: unknown) => void)[]> = {};
      const contextListeners: Record<string, ((x: unknown) => void)[]> = {};
      const context = {
        async route() {},
        on: (event: string, fn: (x: unknown) => void) => { (contextListeners[event] ??= []).push(fn); },
      } as unknown as ContextLike;
      const page = { on: (event: string, fn: (x: unknown) => void) => { (pageListeners[event] ??= []).push(fn); } } as unknown as PageLike;
      const guard = (await installGuard(context, page, PAGE, withNonce ? { popupNonce: NONCE } : {}))!;
      const say = (text: string, type = 'debug') => pageListeners.console?.forEach((fn) => fn({ type: () => type, text: () => text }));
      const opened = (url: string, target: 'page' | 'popup' = 'page') => {
        const closed: string[] = [];
        const p = { url: () => url, close: async () => { closed.push(url); } };
        (target === 'page' ? contextListeners.page : pageListeners.popup)?.forEach((fn) => fn(p));
        return { p, closed };
      };
      const popupListeners = () => pageListeners.popup ?? [];
      const pageListeners2 = () => contextListeners.page ?? [];
      return { guard, page, say, opened, popupListeners, pageListeners: pageListeners2 };
    }
    const strip = (e: object) => { const { at: _at, ...rest } = e as { at: number }; return rest; };

    it('logs each report with the right nonce as a popup, with the address and the probe running then', async () => {
      const t = await setup();
      t.say(`${popupReportPrefix(NONCE)}https://e.org/pop/onload`);
      t.guard.setPhase({ probe: 'keyboard' });
      t.say(`${popupReportPrefix(NONCE)}https://e.org/pop/blank`);
      t.say(`${popupReportPrefix(NONCE)}https://e.org/pop/log`, 'log');
      // Not ours: another nonce, the page's own messages.
      t.say(`${popupReportPrefix('guessed')}https://e.org/pop/forged`);
      t.say('grnted:popup:');
      t.say('hello');
      expect(t.guard.log.events.map(strip)).toEqual([
        { kind: 'popup', url: 'https://e.org/pop/onload' },
        { kind: 'popup', url: 'https://e.org/pop/blank', probe: 'keyboard' },
      ]);
    });

    it("settled() lets one turn of the page's console arrive first, so a report in flight is logged under its probe", async () => {
      const pageListeners: Record<string, ((x: unknown) => void)[]> = {};
      const context = { async route() {} } as unknown as ContextLike;
      const page = {
        on: (event: string, fn: (x: unknown) => void) => { (pageListeners[event] ??= []).push(fn); },
        // The round trip: a report the page sent before it arrives before the answer.
        evaluate: async () => {
          await new Promise((r) => setTimeout(r, 20));
          pageListeners.console?.forEach((fn) => fn({ type: () => 'debug', text: () => `${popupReportPrefix(NONCE)}https://e.org/pop/late` }));
          return 0;
        },
      } as unknown as PageLike;
      const guard = (await installGuard(context, page, PAGE, { popupNonce: NONCE }))!;
      guard.setPhase({ probe: 'timing' });
      expect(await guard.log.settled!(1000)).toBe(true);
      expect(guard.log.events.map(strip)).toEqual([{ kind: 'popup', url: 'https://e.org/pop/late', probe: 'timing' }]);
    });

    it('logs a popup the browser refused in the sandbox from its console error, with or without a nonce, under the probe', async () => {
      for (const withNonce of [true, false]) {
        const t = await setup(withNonce);
        t.guard.setPhase({ probe: 'timing' });
        t.say("Blocked opening 'https://e.org/pop/open' in a new window because the request was made in a sandboxed frame whose 'allow-popups' permission is not set.", 'error');
        t.say("Blocked opening 'https://e.org/pop/form?q=a' in a new window because the request was made in a sandboxed frame whose 'allow-popups' permission is not set.", 'warning');
        t.say("Blocked opening 'https://e.org/pop/x' in a new window because of something else.", 'log');
        expect(t.guard.log.events.map(strip)).toEqual([
          { kind: 'popup', url: 'https://e.org/pop/open', probe: 'timing' },
          { kind: 'popup', url: 'https://e.org/pop/form?q=a', probe: 'timing' },
        ]);
      }
    });

    it('does not listen without a nonce', async () => {
      const t = await setup(false);
      t.say(`${popupReportPrefix('')}https://e.org/pop/blank`);
      expect(t.guard.log.events).toEqual([]);
    });

    it('closes any other page the context opens (a new tab has no opener, so no popup event), logging it once', async () => {
      const t = await setup();
      t.guard.setPhase({ probe: 'pointer' });
      const tab = t.opened('https://e.org/pop/tab');
      expect(tab.closed).toEqual(['https://e.org/pop/tab']);
      // One window can come as both a popup and a new page of the context: logged once.
      const closed: string[] = [];
      const both = { url: () => 'https://e.org/pop/both', close: async () => { closed.push('both'); } };
      t.popupListeners().forEach((fn) => fn(both));
      t.pageListeners().forEach((fn) => fn(both));
      // The page under test itself is never closed; an error page (a popup the route stopped) is closed, not logged.
      t.pageListeners().forEach((fn) => fn(t.page));
      const err = t.opened('chrome-error://chromewebdata/');
      expect(err.closed).toEqual(['chrome-error://chromewebdata/']);
      expect(t.guard.log.events.map(strip)).toEqual([
        { kind: 'popup', url: 'https://e.org/pop/tab', probe: 'pointer' },
        { kind: 'popup', url: 'https://e.org/pop/both', probe: 'pointer' },
      ]);
    });
  });

  describe('the popup sandbox (CDP response stage: the browser fetches the page, the guard adds a sandbox CSP)', () => {
    it('adds the sandbox as one more policy (the site\'s own CSP and every Set-Cookie kept) and drops headers of the encoded body', () => {
      expect(POPUP_SANDBOX).not.toMatch(/allow-popups/);
      expect(sandboxedHeaders([
        { name: 'Content-Type', value: 'text/html' }, { name: 'Content-Security-Policy', value: "img-src 'self'" }, { name: 'Content-Length', value: '10' },
        { name: 'content-encoding', value: 'gzip' }, { name: 'Set-Cookie', value: 'a=1' }, { name: 'Set-Cookie', value: 'b=2' }, { name: 'Transfer-Encoding', value: 'chunked' },
      ], false)).toEqual([
        { name: 'Content-Type', value: 'text/html' }, { name: 'Content-Security-Policy', value: "img-src 'self'" }, { name: 'Set-Cookie', value: 'a=1' }, { name: 'Set-Cookie', value: 'b=2' },
        { name: 'Content-Security-Policy', value: POPUP_SANDBOX },
      ]);
      // A body the browser gave back as text is sent as UTF-8, and said so.
      expect(sandboxedHeaders([{ name: 'content-type', value: 'text/html; charset=windows-1252' }], true)).toEqual([
        { name: 'content-type', value: 'text/html; charset=utf-8' }, { name: 'Content-Security-Policy', value: POPUP_SANDBOX },
      ]);
      expect(sandboxedHeaders([], true)).toEqual([{ name: 'Content-Type', value: 'text/html; charset=utf-8' }, { name: 'Content-Security-Policy', value: POPUP_SANDBOX }]);
      // Speculative loads the browser would make outside the request guard are dropped; other links stay.
      expect(sandboxedHeaders([
        { name: 'Speculation-Rules', value: '"/rules.json"' },
        { name: 'Link', value: '</pop/a>; rel=prefetch, </style.css>; rel=preload; as=style, </pop/b>; rel="prerender"' },
        { name: 'link', value: '</pop/c>; rel=prefetch' },
      ], false)).toEqual([{ name: 'Link', value: '</style.css>; rel=preload; as=style' }, { name: 'Content-Security-Policy', value: POPUP_SANDBOX }]);
    });

    const MAIN = 'main-frame';
    async function setup(sandbox?: SandboxMode, opts: { noCdp?: boolean; body?: { body: string; base64Encoded: boolean } | 'throws' } = {}) {
      const sent: [string, Record<string, unknown>][] = [];
      let paused: ((ev: Record<string, unknown>) => void) | undefined;
      let opened = 0;
      const session = {
        async send(method: string, params: Record<string, unknown> = {}) {
          sent.push([method, params]);
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: MAIN } } };
          if (method === 'Fetch.getResponseBody') {
            if (opts.body === 'throws') throw new Error('No data found for resource with given identifier');
            return opts.body ?? { body: 'PGgxPg==', base64Encoded: true };
          }
          return {};
        },
        on(event: string, fn: (ev: Record<string, unknown>) => void) { if (event === 'Fetch.requestPaused') paused = fn; if (event === 'close') closed = fn as unknown as () => void; },
      };
      let closed: (() => void) | undefined;
      const context = {
        async route() {},
        ...(opts.noCdp ? {} : { async newCDPSession() { opened++; return session; } }),
      } as unknown as ContextLike;
      const guard = await installGuard(context, { on: () => {} } as unknown as PageLike, PAGE, sandbox === undefined ? {} : { sandbox });
      const pause = async (ev: Record<string, unknown>) => {
        const n = sent.length;
        paused!({ requestId: 'r1', frameId: MAIN, resourceType: 'Document', request: { url: PAGE, method: 'GET' }, responseStatusCode: 200, responseStatusText: 'OK', responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], ...ev });
        await new Promise((r) => setTimeout(r, 5));
        return sent.slice(n);
      };
      return { guard, sent, pause, opened: () => opened, close: () => closed?.() };
    }

    it('enables response-stage interception of documents; fulfills the page\'s document with the sandbox, body and status kept', async () => {
      const t = await setup();
      expect(t.guard!.popupSandbox).toBe('on');
      // No document from the cache (a 304 or a cache hit would bring the response without the sandbox), no prerendering.
      expect(t.sent).toEqual([
        ['Page.getFrameTree', {}],
        ['Network.enable', {}],
        ['Network.setCacheDisabled', { cacheDisabled: true }],
        ['Page.setPrerenderingAllowed', { isAllowed: false }],
        ['Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }] }],
      ]);
      expect(await t.pause({})).toEqual([
        ['Fetch.getResponseBody', { requestId: 'r1' }],
        ['Fetch.fulfillRequest', { requestId: 'r1', responseCode: 200, responsePhrase: 'OK', responseHeaders: [{ name: 'Content-Type', value: 'text/html' }, { name: 'Content-Security-Policy', value: POPUP_SANDBOX }], body: 'PGgxPg==' }],
      ]);
    });

    it('lets a redirect, a frame\'s document and a failed response through unchanged (frames inherit the sandbox; the next hop is paused again)', async () => {
      const t = await setup();
      for (const code of [301, 302, 303, 307, 308]) expect(await t.pause({ responseStatusCode: code, responseHeaders: [{ name: 'Location', value: '/en/' }] }), String(code)).toEqual([['Fetch.continueResponse', { requestId: 'r1' }]]);
      // A 304 (the cached document, without the sandbox), a 300 or no status: not loaded.
      for (const code of [304, 300, undefined]) expect(await t.pause({ responseStatusCode: code }), String(code)).toEqual([['Fetch.failRequest', { requestId: 'r1', errorReason: 'BlockedByClient' }]]);
      expect(await t.pause({ frameId: 'child' })).toEqual([['Fetch.continueResponse', { requestId: 'r1' }]]);
      expect(await t.pause({ responseStatusCode: undefined, responseErrorReason: 'ConnectionRefused' })).toEqual([['Fetch.failRequest', { requestId: 'r1', errorReason: 'ConnectionRefused' }]]);
      expect(t.guard!.popupSandbox).toBe('on');
      expect(await t.pause({ responseStatusCode: 204 })).toEqual([['Fetch.continueResponse', { requestId: 'r1' }]]);
    });

    it('a body given back as text is sent as UTF-8; a body it cannot read means the document is not loaded', async () => {
      const text = await setup(undefined, { body: { body: 'café', base64Encoded: false } });
      const [, fulfill] = await text.pause({ responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=windows-1252' }] });
      expect(fulfill).toEqual(['Fetch.fulfillRequest', expect.objectContaining({ body: 'Y2Fmw6k=', responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }, { name: 'Content-Security-Policy', value: POPUP_SANDBOX }] })]);
      const broken = await setup(undefined, { body: 'throws' });
      expect((await broken.pause({})).slice(-1)).toEqual([['Fetch.failRequest', { requestId: 'r1', errorReason: 'BlockedByClient' }]]);
      // Over the size cap: not loaded.
      const huge = await setup(undefined, { body: { body: 'A'.repeat(SANDBOX_BODY_CAP + 4), base64Encoded: true } });
      expect((await huge.pause({})).slice(-1)).toEqual([['Fetch.failRequest', { requestId: 'r1', errorReason: 'BlockedByClient' }]]);
    });

    it('a CDP session that closes leaves the sandbox lost, never on', async () => {
      const t = await setup();
      t.close();
      expect(t.guard!.popupSandbox).toBe('lost');
    });

    it('auto: a page at a local address is let through unchanged (its other local resources would be refused); always: it is sandboxed', async () => {
      for (const u of ['http://localhost:3000/', 'http://app.localhost/', 'http://printer.local/', 'http://127.0.0.1:8080/x', 'http://10.1.2.3/', 'http://172.20.0.1/', 'http://192.168.1.1/', 'http://169.254.1.1/',
        'http://[::1]:5173/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:10.0.0.1]/']) {
        expect(isLocalAddress(u), u).toBe(true);
      }
      for (const u of ['https://e.org/', 'http://172.32.0.1/', 'http://8.8.8.8/', 'https://www.local-news.org/', 'http://[2001:db8::1]/', 'http://[::ffff:8.8.8.8]/', 'not a url']) expect(isLocalAddress(u), u).toBe(false);
      // The hostnames themselves (as `new URL(...).hostname` may give them, with or without brackets, a zone id).
      for (const h of ['::1', '[::1]', 'fe80::1%en0', 'FD12::3']) expect(isLocalAddress(h), h).toBe(true);
      const local = { request: { url: 'http://localhost:3000/', method: 'GET' } };
      const auto = await setup();
      expect(await auto.pause(local)).toEqual([['Fetch.continueResponse', { requestId: 'r1' }]]);
      // Recorded: the document the page shows now is not sandboxed.
      expect(auto.guard!.unsandboxedDocument).toBe('http://localhost:3000/');
      await auto.pause({});
      expect(auto.guard!.unsandboxedDocument).toBeNull();
      expect((await (await setup('always')).pause(local))[0]).toEqual(['Fetch.getResponseBody', { requestId: 'r1' }]);
    });

    it('no CDP session: the sandbox is unavailable (the hook alone); off: no session is opened', async () => {
      expect((await setup(undefined, { noCdp: true })).guard!.popupSandbox).toBe('unavailable');
      const off = await setup('off');
      expect(off.guard!.popupSandbox).toBe('off');
      expect(off.opened()).toBe(0);
    });
  });

  it('strict mode lasts while a strict probe runs and after it, until the page is loaded again', async () => {
    let handler: ((r: RouteLike) => unknown) | undefined;
    const context = { async route(_: unknown, h: (r: RouteLike) => unknown) { handler = h; } } as unknown as ContextLike;
    const guard = (await installGuard(context, { on: () => {} } as unknown as PageLike, PAGE))!;
    const send = async (url: string, type = 'fetch') => {
      const r = fakeRoute('GET', url, type);
      await handler!(r.route);
      return r.calls[0];
    };
    guard.setPhase({ probe: 'keyboard' });
    expect(await send('https://e.org/suggest?q=a')).toBe('continue');
    guard.setPhase({ probe: 'forms', strict: true });
    expect(await send('https://e.org/suggest?q=a')).toBe('abort:blockedbyclient');
    guard.setPhase('load');
    expect(await send('https://e.org/late?q=a')).toBe('abort:blockedbyclient');
    expect(await send('https://e.org/img.png', 'image')).toBe('abort:blockedbyclient');
    expect(await send(PAGE)).toBe('abort:blockedbyclient');
    guard.setPhase({ probe: 'keyboard' });
    expect(await send('https://e.org/late?q=a')).toBe('abort:blockedbyclient');
    guard.setPageUrl(PAGE);
    expect(await send('https://e.org/suggest?q=a')).toBe('continue');
    expect(guard.log.events.filter((e) => e.reason === 'data').map((e) => e.probe)).toEqual(['forms', undefined, undefined, undefined, 'keyboard']);
  });

  it('a write to an analytics service is blocked like any other, logged as background, and left out of since() and guardStop; one anywhere else ends the test', async () => {
    let handler: ((r: RouteLike) => unknown) | undefined;
    const context = { async route(_: unknown, h: (r: RouteLike) => unknown) { handler = h; } } as unknown as ContextLike;
    const guard = (await installGuard(context, { on: () => {} } as unknown as PageLike, PAGE))!;
    const write = async (url: string, type = 'fetch', nav = false) => {
      const r = fakeRoute('POST', url, type, nav);
      await handler!(r.route);
      return r.calls;
    };
    guard.setPhase({ probe: 'motion' });
    const mark = guard.log.mark();
    expect(await write('https://www.google-analytics.com/g/collect?_=1', 'ping')).toEqual(['abort:blockedbyclient']);
    for (const u of ['https://e.org/api/save', 'https://cdn.e.org/api/save', 'https://203.0.113.10/checkout', 'http://localhost:8080/checkout', 'https://api.shop.example.net/order']) {
      expect(await write(u, 'xhr')).toEqual(['abort:blockedbyclient']);
    }
    // A form sent to an analytics host (a navigation) is never background: always the test's.
    expect(await write('https://www.google-analytics.com/submit', 'document', true)).toEqual(['abort:aborted']);
    expect(guard.log.events.map((e) => e.cause)).toEqual(['background', 'own', 'own', 'own', 'own', 'own', undefined]);
    expect(guard.log.since(mark).map((e) => e.url)).toEqual(['https://e.org/api/save', 'https://cdn.e.org/api/save', 'https://203.0.113.10/checkout', 'http://localhost:8080/checkout', 'https://api.shop.example.net/order', 'https://www.google-analytics.com/submit']);
    expect(guardStop(guard.log.events.slice(0, 1))).toBeNull();
    expect(guardStop(guard.log.events.slice(0, 2))).toBe('the test would have sent data to the live site (POST request to https://e.org/api/save), so it was stopped');
    expect(backgroundWrites(guard.log.events, 'motion')).toEqual({ count: 1, hosts: ['www.google-analytics.com'] });
    expect(backgroundWrites(guard.log.events, 'hover-content')).toBeUndefined();
  });

  it('reads the one analytics list (ANALYTICS_SERVICES): a service only it named, and a first-party beacon address, are background too', async () => {
    let handler: ((r: RouteLike) => unknown) | undefined;
    const context = { async route(_: unknown, h: (r: RouteLike) => unknown) { handler = h; } } as unknown as ContextLike;
    const guard = (await installGuard(context, { on: () => {} } as unknown as PageLike, PAGE))!;
    guard.setPhase({ probe: 'motion' });
    for (const u of ['https://track.hubspot.com/__ptq.gif', 'https://stats.e.org/matomo.php?idsite=1', 'https://e.org/b/ss/rsid/1/x', 'https://e.org/api/save']) await handler!(fakeRoute('POST', u, 'fetch', false).route);
    expect(guard.log.events.map((e) => e.cause)).toEqual(['background', 'background', 'background', 'own']);
  });

  it('a flood of writes to an analytics service never fills the log: the page\'s own blocked requests are still recorded', async () => {
    let handler: ((r: RouteLike) => unknown) | undefined;
    const context = { async route(_: unknown, h: (r: RouteLike) => unknown) { handler = h; } } as unknown as ContextLike;
    const guard = (await installGuard(context, { on: () => {} } as unknown as PageLike, PAGE))!;
    guard.setPhase({ probe: 'motion' });
    for (let i = 0; i < GUARD_LOG_CAP + 10; i++) await handler!(fakeRoute('POST', `https://www.google-analytics.com/g/collect?i=${i}`, 'ping').route);
    await handler!(fakeRoute('POST', 'https://e.org/api/save', 'fetch').route);
    expect(guard.log.since(0).map((e) => e.url)).toEqual(['https://e.org/api/save']);
    expect(await guard.log.settled!(500)).toBe(true);
  });

  it('between probes, holds the page\'s own top-level navigations and reloads (logged with no probe); while loading, lets them through', async () => {
    let handler: ((r: RouteLike) => unknown) | undefined;
    const context = { async route(_: unknown, h: (r: RouteLike) => unknown) { handler = h; } } as unknown as ContextLike;
    const guard = (await installGuard(context, { on: () => {} } as unknown as PageLike, PAGE))!;
    const go = async (url: string) => {
      const r = fakeRoute('GET', url, 'document', true);
      await handler!(r.route);
      return r.calls[0];
    };
    expect(await go(PAGE)).toBe('continue');
    guard.setPhase('between');
    expect(await go('https://e.org/elsewhere')).toBe('abort:aborted');
    expect(await go(PAGE)).toBe('abort:aborted'); // a reload by the page itself: only the runner loads the page
    const same = fakeRoute('GET', PAGE, 'fetch');
    await handler!(same.route);
    expect(same.calls).toEqual(['continue']); // the page's own address as a subresource is fine
    const img = fakeRoute('GET', 'https://e.org/cart.png', 'image');
    await handler!(img.route);
    expect(img.calls).toEqual(['abort:blockedbyclient']); // an action address, as during a probe
    guard.setPhase('load');
    expect(await go(PAGE)).toBe('continue'); // the runner's load
    expect(await go('https://e.org/elsewhere')).toBe('abort:aborted'); // the page's own, while it loads
    const strip = (e: object) => { const { at: _at, ...rest } = e as { at: number }; return rest; };
    expect(guard.log.events.map(strip)).toEqual([
      { kind: 'navigation', url: 'https://e.org/elsewhere', method: 'GET' },
      { kind: 'navigation', url: PAGE, method: 'GET' },
      { kind: 'blocked', url: 'https://e.org/cart.png', method: 'GET', resourceType: 'image', reason: 'action' },
      { kind: 'navigation', url: 'https://e.org/elsewhere', method: 'GET' },
    ]);
  });

  /** A guard on a fake context whose request events and route callbacks the test fires itself. */
  async function reported() {
    let handler: ((r: RouteLike) => unknown) | undefined;
    let wsHandler: ((ws: { url(): string }) => unknown) | undefined;
    const on: Record<string, ((r: unknown) => void)[]> = {};
    const pageOn: Record<string, ((r: unknown) => void)[]> = {};
    const context = {
      async route(_: unknown, h: (r: RouteLike) => unknown) { handler = h; },
      async routeWebSocket(_: unknown, h: (ws: { url(): string }) => unknown) { wsHandler = h; },
      on(event: string, fn: (r: unknown) => void) { (on[event] ??= []).push(fn); },
    } as unknown as ContextLike;
    const page = { on(event: string, fn: (r: unknown) => void) { (pageOn[event] ??= []).push(fn); } } as unknown as PageLike;
    const guard = (await installGuard(context, page, PAGE))!;
    const emit = (event: string, r: unknown) => { for (const fn of on[event] ?? []) fn(r); };
    /** A request the browser reports now; `decide()` runs the guard's route callback for it. */
    const request = (method: string, url: string, type = 'fetch', nav = false, redirectedFrom: RequestLike | null = null) => {
      const calls: string[] = [];
      const r: RequestLike = { method: () => method, url: () => url, resourceType: () => type, isNavigationRequest: () => nav, frame: () => ({ url: () => url, parentFrame: () => null }), redirectedFrom: () => redirectedFrom };
      const route: RouteLike = { request: () => r, async abort(code) { calls.push(`abort:${code ?? ''}`); }, async continue() { calls.push('continue'); } };
      return { r, calls, report: () => emit('request', r), decide: () => handler!(route), finish: () => emit('requestfinished', r) };
    };
    return { guard, request, emit, page: (event: string, x: unknown) => { for (const fn of pageOn[event] ?? []) fn(x); }, ws: (url: string) => wsHandler!({ url: () => url }) };
  }

  it('settled() waits until every request the browser reported has been decided, and says false when that takes too long', async () => {
    const t = await reported();
    expect(await t.guard.log.settled!(0)).toBe(true);
    // A POST the browser reported; its decision comes 80 ms later (a busy machine).
    const post = t.request('POST', 'https://e.org/api/next');
    post.report();
    setTimeout(() => { void post.decide(); }, 80);
    const t0 = Date.now();
    expect(await t.guard.log.settled!(2000)).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(60);
    expect(t.guard.log.events.map((e) => e.kind)).toEqual(['blocked']);
    // One that is never decided: false once the time is up.
    const stuck = t.request('GET', 'https://e.org/slow');
    stuck.report();
    expect(await t.guard.log.settled!(50)).toBe(false);
    void stuck.decide();
    // A request decided before the browser's report arrived is not waited for.
    const early = t.request('GET', 'https://e.org/a.css', 'stylesheet');
    await early.decide();
    early.report();
    expect(await t.guard.log.settled!(0)).toBe(true);
  });

  it.each(['requestfinished', 'requestfailed'])('drain() waits for an allowed request to end (%s), including requests reported after it starts', async (event) => {
    const t = await reported();
    const first = t.request('GET', 'https://e.org/config');
    first.report();
    await first.decide();
    expect(await t.guard.log.settled!(50)).toBe(true);
    // A route decision is not a completed request: its response can still redirect with a cookie.
    expect(await t.guard.drain(30)).toBe(false);
    t.guard.setPhase({ probe: 'forms', strict: true });
    const hop = t.request('GET', 'https://e.org/config-result', 'fetch', false, first.r);
    const draining = t.guard.drain(1000);
    setTimeout(() => { hop.report(); first.finish(); }, 10);
    setTimeout(() => t.emit(event, hop.r), 70);
    const started = Date.now();
    expect(await draining).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
  });

  it('drain() tracks an early route callback when its request report arrives afterward', async () => {
    const t = await reported();
    const early = t.request('GET', 'https://e.org/config');
    await early.decide();
    early.report();
    expect(await t.guard.drain(30)).toBe(false);
    early.finish();
    expect(await t.guard.drain(1000)).toBe(true);
  });

  it('drain() requires 250 ms of continuous quiet across split redirect-hop reports', async () => {
    vi.useFakeTimers();
    try {
      const t = await reported();
      const first = t.request('GET', 'https://e.org/config');
      first.report();
      await first.decide();
      let drained = false;
      const draining = t.guard.drain(2000).then((done) => { drained = done; });
      first.finish();
      await vi.advanceTimersByTimeAsync(100);
      expect(drained).toBe(false);
      const hop = t.request('GET', 'https://e.org/config-pending', 'fetch', false, first.r);
      hop.report();
      await vi.advanceTimersByTimeAsync(200);
      expect(drained).toBe(false);
      hop.finish();
      await vi.advanceTimersByTimeAsync(249);
      expect(drained).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await draining;
      expect(drained).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('drain() restarts quiet for a request reported and finished between polls, and needs time for the whole window', async () => {
    vi.useFakeTimers();
    try {
      const t = await reported();
      const draining = t.guard.drain(300);
      await vi.advanceTimersByTimeAsync(200);
      const late = t.request('GET', 'https://e.org/config');
      late.report();
      late.finish();
      await vi.advanceTimersByTimeAsync(100);
      expect(await draining).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('drain() blocks new requests before typing and keeps strict mode latched afterward', async () => {
    const t = await reported();
    t.guard.setPhase('between');
    const draining = t.guard.drain(1000);
    const next = t.request('GET', 'https://e.org/config');
    next.report();
    await next.decide();
    expect(next.calls).toEqual(['abort:blockedbyclient']);
    next.finish();
    expect(await draining).toBe(true);
    t.guard.setPhase('between');
    const later = t.request('GET', PAGE);
    later.report();
    await later.decide();
    expect(later.calls).toEqual(['abort:blockedbyclient']);
  });

  it('drain() refuses a completion reported after its deadline', async () => {
    const t = await reported();
    const first = t.request('GET', 'https://e.org/config');
    first.report();
    await first.decide();
    let now = 100;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const draining = t.guard.drain(30);
      // A busy event loop delivers both the completion and the timer after the time box expired.
      now = 131;
      first.finish();
      expect(await draining).toBe(false);
    } finally { clock.mockRestore(); }
  });

  it('settled() lets a report already on its way arrive before it answers', async () => {
    const t = await reported();
    const post = t.request('POST', 'https://e.org/api/next');
    // Reported in the next turn, decided 40 ms later: settled must not answer before seeing it.
    setTimeout(() => { post.report(); setTimeout(() => { void post.decide(); }, 40); }, 0);
    expect(await t.guard.log.settled!(1000)).toBe(true);
    expect(t.guard.log.events.map((e) => e.kind)).toEqual(['blocked']);
  });

  it('settled() also waits for requests reported while it waits', async () => {
    const t = await reported();
    t.guard.setPhase({ probe: 'p' });
    const a = t.request('POST', 'https://e.org/api/a');
    const b = t.request('GET', 'https://e.org/logout', 'image');
    a.report();
    setTimeout(() => b.report(), 20);
    setTimeout(() => { void a.decide(); }, 40);
    setTimeout(() => { void b.decide(); }, 150);
    expect(await t.guard.log.settled!(2000)).toBe(true);
    expect(t.guard.log.events.map((e) => e.url)).toEqual(['https://e.org/api/a', 'https://e.org/logout']);
  });

  it('settled() is false when a reported request ended before the guard decided it (a redirect the browser followed on its own included)', async () => {
    const t = await reported();
    t.guard.setPhase({ probe: 'p' });
    const r = t.request('GET', 'https://e.org/data.json');
    r.report();
    r.finish(); // ended without reaching the guard
    expect(await t.guard.log.settled!(100)).toBe(false);
    // A redirect hop is waited for like any request. One the browser fetched without the guard counts
    // as unchecked only when the guard would have stopped it (decided by the hop's own snapshot).
    const t2 = await reported();
    t2.guard.setPhase({ probe: 'p' });
    const first = t2.request('GET', 'https://e.org/go');
    first.report();
    await first.decide();
    const hop = t2.request('GET', 'https://e.org/data.json', 'fetch', false, first.r);
    hop.report();
    hop.finish();
    expect(await t2.guard.log.settled!(100)).toBe(true);
    const bad = t2.request('GET', 'https://e.org/account/logout', 'fetch', false, first.r);
    bad.report();
    bad.finish();
    expect(await t2.guard.log.settled!(100)).toBe(false);
  });

  it('a redirect hop that reaches the route callback is decided by its own report, logged under that probe', async () => {
    const t = await reported();
    t.guard.setPhase({ probe: 'p' });
    const first = t.request('GET', 'https://e.org/go');
    first.report();
    await first.decide();
    const hop = t.request('GET', 'https://e.org/logout', 'fetch', false, first.r);
    hop.report();
    t.guard.setPhase('between');
    t.guard.setPhase({ probe: 'q' });
    // Waited for until the callback decides it.
    const answer = t.guard.log.settled!(1000, 'p');
    setTimeout(() => { void hop.decide(); }, 30);
    expect(await answer).toBe(true);
    expect(hop.calls).toEqual(['abort:blockedbyclient']);
    expect(t.guard.log.events.map((e) => [e.kind, e.url, e.probe])).toEqual([['blocked', 'https://e.org/logout', 'p']]);
  });

  it('while loading, only the first page navigation of the runner\'s load and its redirects go ahead (a redirect of the runner\'s load is not action-checked)', async () => {
    const t = await reported();
    t.guard.setPhase('load');
    const goto = t.request('GET', PAGE, 'document', true);
    goto.report();
    await goto.decide();
    expect(goto.calls).toEqual(['continue']);
    // The server redirects the runner's load: the site's behaviour for any visitor.
    const hop = t.request('GET', 'https://e.org/logout?next=/news/1', 'document', true, goto.r);
    hop.report();
    await hop.decide();
    expect(hop.calls).toEqual(['continue']);
    // A second navigation to the same address while loading is the page's own: held.
    const again = t.request('GET', PAGE, 'document', true);
    again.report();
    await again.decide();
    expect(again.calls).toEqual(['abort:aborted']);
    // A new load phase starts a new runner's load.
    t.guard.setPhase('between');
    t.guard.setPhase('load');
    const next = t.request('GET', PAGE, 'document', true);
    next.report();
    await next.decide();
    expect(next.calls).toEqual(['continue']);
  });

  it('a route callback that comes before the browser\'s report is decided by the strictest reading, never a looser one', async () => {
    const t = await reported();
    t.guard.setPhase({ probe: 'p' });
    // A probe may reload the page, but a reload of unknown start may be the page's own between probes: held.
    const reload = t.request('GET', PAGE, 'document', true);
    await reload.decide();
    expect(reload.calls).toEqual(['abort:aborted']);
    const css = t.request('GET', 'https://e.org/site.css', 'stylesheet');
    await css.decide();
    expect(css.calls).toEqual(['continue']);
  });

  it('a WebSocket is charged to the probe running when the page opened it; settled() never waits for sockets', async () => {
    const t = await reported();
    // The guard keeps it in the page while the page loads, before the page's own event.
    await t.ws('wss://e.org/live');
    t.guard.setPhase({ probe: 'p' });
    const mark = t.guard.log.mark();
    t.page('websocket', { url: () => 'wss://e.org/live' });
    expect(await t.guard.log.settled!(50)).toBe(true);
    expect(t.guard.log.since(mark)).toEqual([]);
    expect(t.guard.log.events.map((e) => [e.kind, e.probe])).toEqual([['websocket', undefined]]);
    // Page event first (in probe p), the guard's callback later (in probe q): charged to p.
    t.page('websocket', { url: () => 'wss://e.org/chat' });
    t.guard.setPhase({ probe: 'q' });
    await t.ws('wss://e.org/chat');
    expect(await t.guard.log.settled!(50)).toBe(true);
    expect(t.guard.log.events.map((e) => [e.url, e.probe])).toEqual([['wss://e.org/live', undefined], ['wss://e.org/chat', 'p']]);
  });

  it('a sandbox whose CDP setup fails part-way is unavailable and leaves nothing paused', async () => {
    for (const failing of ['Page.getFrameTree', 'Network.enable', 'Fetch.enable']) {
      const sent: string[] = [];
      const on: Record<string, () => void> = {};
      const cdp = {
        on(event: string, fn: () => void) { on[event] = fn; },
        async send(method: string) {
          sent.push(method);
          if (method === failing) throw new Error('refused');
          return method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main' } } } : {};
        },
      };
      const context = { async route() {}, on() {}, async newCDPSession() { return cdp; } } as unknown as ContextLike;
      const guard = (await installGuard(context, { on() {} } as unknown as PageLike, PAGE, { sandbox: 'always' }))!;
      expect([failing, guard.popupSandbox]).toEqual([failing, 'unavailable']);
      expect(sent.at(-1)).toBe('Fetch.disable');
      // Its session closing later does not make it a lost sandbox: it never came up.
      on.close?.();
      expect(guard.popupSandbox).toBe('unavailable');
    }
  });

  it('takes over a WebSocket route set before the page opened: sockets from before and after are kept in the page and logged, with no second route', async () => {
    let routes = 0;
    let wsHandler: ((ws: { url(): string }) => unknown) | undefined;
    const context = {
      async route() {},
      async routeWebSocket(_: unknown, h: (ws: { url(): string }) => unknown) { routes++; wsHandler = h; },
      on() {},
    } as unknown as ContextLike;
    const early = routeWebSocketsEarly(context)!;
    expect(routes).toBe(1);
    // A socket the route sees before the guard is installed is handed over, not lost.
    await wsHandler!({ url: () => 'wss://e.org/first' });
    const guard = (await installGuard(context, { on() {} } as unknown as PageLike, PAGE, { webSockets: early }))!;
    expect(routes).toBe(1);
    guard.setPhase({ probe: 'p' });
    await wsHandler!({ url: () => 'wss://e.org/later' });
    expect(guard.log.events.map((e) => [e.kind, e.url, e.probe])).toEqual([['websocket', 'wss://e.org/first', undefined], ['websocket', 'wss://e.org/later', 'p']]);
  });

  it('decides a request as things stood when the browser reported it, and logs it under that probe', async () => {
    const t = await reported();
    t.guard.setPhase('between');
    const reload = t.request('GET', PAGE, 'document', true);
    const img = t.request('GET', 'https://e.org/account/logout.png', 'image');
    reload.report();
    img.report();
    t.guard.setPhase('load'); // the runner starts loading the page again before the decisions come
    await reload.decide();
    await img.decide();
    expect(reload.calls).toEqual(['abort:aborted']);
    expect(img.calls).toEqual(['abort:blockedbyclient']);
    t.guard.setPhase({ probe: 'a' });
    const post = t.request('POST', 'https://e.org/api/save');
    post.report();
    t.guard.setPhase('between');
    t.guard.setPhase({ probe: 'b' });
    await post.decide();
    expect(t.guard.log.events.map((e) => [e.kind, e.probe])).toEqual([['navigation', undefined], ['blocked', undefined], ['blocked', 'a']]);
  });

  it('returns null when neither the context nor the page can intercept requests', async () => {
    expect(await installGuard({} as ContextLike, {} as PageLike, PAGE)).toBeNull();
  });
});

describe('the guard composes with an outer guard and stops speculative loads (Plan 2, H0)', () => {
  type Fake = { route: RouteLike; calls: string[] };
  function fake(url: string, opts: { type?: string; headers?: Record<string, string>; fallback?: boolean } = {}): Fake {
    const calls: string[] = [];
    const route: RouteLike = {
      request: () => ({ method: () => 'GET', url: () => url, resourceType: () => opts.type ?? 'fetch', isNavigationRequest: () => false, frame: () => ({ url: () => url, parentFrame: () => null }), headers: () => opts.headers ?? {} }),
      async abort(code) { calls.push(`abort:${code ?? ''}`); },
      async continue() { calls.push('continue'); },
      ...(opts.fallback === false ? {} : { async fallback() { calls.push('fallback'); } }),
    };
    return { route, calls };
  }
  async function guarded() {
    let handler: ((r: RouteLike) => unknown) | undefined;
    const context = { async route(_: unknown, h: (r: RouteLike) => unknown) { handler = h; } } as unknown as ContextLike;
    const guard = (await installGuard(context, { on: () => {} } as unknown as PageLike, PAGE))!;
    const send = async (f: Fake) => { await handler!(f.route); return f.calls; };
    return { guard, send };
  }

  it('lets an allowed request fall back to the next route handler (an outer guard decides), or continue when the route has none', async () => {
    const t = await guarded();
    t.guard.setPhase({ probe: 'p' });
    expect(await t.send(fake('https://e.org/data.json'))).toEqual(['fallback']);
    expect(await t.send(fake('https://e.org/data.json', { fallback: false }))).toEqual(['continue']);
    // What it stops is still stopped here, whatever handler comes after it.
    expect(await t.send(fake('https://e.org/logout'))).toEqual(['abort:blockedbyclient']);
  });

  it('aborts a prefetch or prerender request in every phase, without logging it', async () => {
    const t = await guarded();
    for (const phase of ['load', 'between', { probe: 'p' }] as const) {
      t.guard.setPhase(phase);
      expect(await t.send(fake('https://e.org/next.html', { type: 'other', headers: { 'sec-purpose': 'prefetch' } })), JSON.stringify(phase)).toEqual(['abort:blockedbyclient']);
      expect(await t.send(fake('https://e.org/next.html', { type: 'other', headers: { 'sec-purpose': 'prefetch;prerender' } }))).toEqual(['abort:blockedbyclient']);
      expect(await t.send(fake('https://e.org/next.html', { type: 'other', headers: { purpose: 'prefetch' } }))).toEqual(['abort:blockedbyclient']);
      expect(await t.send(fake('https://e.org/next.html', { type: 'prefetch' }))).toEqual(['abort:blockedbyclient']);
    }
    expect(t.guard.log.events).toEqual([]);
    // Not speculative: an ordinary preload, a request with no headers to read.
    expect(await t.send(fake('https://e.org/style.css', { type: 'stylesheet', headers: { purpose: '' } }))).toEqual(['fallback']);
    expect(isSpeculativeRequest({ method: () => 'GET', url: () => PAGE, resourceType: () => 'fetch' })).toBe(false);
  });

  it('takes the speculative headers off a document it hands on unchanged; reports nothing to change otherwise', () => {
    expect(withoutSpeculativeHeaders([{ name: 'Content-Type', value: 'text/html' }, { name: 'Link', value: '</style.css>; rel=preload; as=style' }])).toBeNull();
    expect(withoutSpeculativeHeaders([
      { name: 'Content-Type', value: 'text/html' }, { name: 'Speculation-Rules', value: '"/rules.json"' },
      { name: 'Link', value: '</a>; rel=prefetch, </style.css>; rel=preload; as=style' }, { name: 'link', value: '</b>; rel="prerender"' },
    ])).toEqual([{ name: 'Content-Type', value: 'text/html' }, { name: 'Link', value: '</style.css>; rel=preload; as=style' }]);
  });

  async function withSession(sandbox: SandboxMode = 'auto') {
    const sent: [string, Record<string, unknown>][] = [];
    const on: Record<string, (ev: Record<string, unknown>) => void> = {};
    const session = {
      async send(method: string, params: Record<string, unknown> = {}) {
        sent.push([method, params]);
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
        return {};
      },
      on(event: string, fn: (ev: Record<string, unknown>) => void) { on[event] = fn; },
    };
    const context = { async route() {}, async newCDPSession() { return session; } } as unknown as ContextLike;
    const guard = (await installGuard(context, { on: () => {} } as unknown as PageLike, PAGE, { sandbox }))!;
    return { guard, sent, on };
  }

  it('a local page, a frame\'s document and a redirect lose the headers that ask for speculative loads (status and other headers kept)', async () => {
    const t = await withSession();
    const headers = [{ name: 'Content-Type', value: 'text/html' }, { name: 'Speculation-Rules', value: '"/r.json"' }, { name: 'Link', value: '</p>; rel=prefetch' }];
    for (const ev of [
      { frameId: 'main', request: { url: 'http://localhost:3000/' }, responseStatusCode: 200, responseStatusText: 'OK' },
      { frameId: 'child', request: { url: 'https://e.org/frame' }, responseStatusCode: 200, responseStatusText: 'OK' },
      { frameId: 'main', request: { url: PAGE }, responseStatusCode: 302, responseStatusText: 'Found' },
    ]) {
      const n = t.sent.length;
      t.on['Fetch.requestPaused']!({ requestId: 'r1', responseHeaders: headers, ...ev });
      await new Promise((r) => setTimeout(r, 5));
      expect(t.sent.slice(n)).toEqual([['Fetch.continueResponse', { requestId: 'r1', responseCode: ev.responseStatusCode, responsePhrase: ev.responseStatusText, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }] }]]);
    }
  });

  it('a speculation-rule prefetch the browser reports (outside every interception) leaves the probe it ran in unsettled', async () => {
    const t = await withSession();
    t.guard.setPhase({ probe: 'p' });
    t.on['Network.requestWillBeSent']!({ type: 'Other', request: { url: 'https://e.org/a', headers: { 'Sec-Purpose': 'prefetch' } } });
    expect(await t.guard.log.settled!(50)).toBe(true); // a prefetch link: the route decides it
    t.on['Network.requestWillBeSent']!({ type: 'Prefetch', request: { url: 'https://e.org/b', headers: { 'Sec-Purpose': 'prefetch' } } });
    expect(await t.guard.log.settled!(50)).toBe(false);
    expect(await t.guard.log.settled!(50, 'other')).toBe(true);
  });
});
