// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The site owner's scanner key (hosted, 2026-11-03): a site that turns automated visitors away can let
// Granted in by allowing one secret request header in its own firewall, after its owner proved control
// of the domain (apps/worker/src/ownerSite.ts). This module only carries that header, and only to the
// hosts the caller says it covers. Engine core: no Node-only imports.
//
// Browser: every request of every page the scan opens is paused once at the CDP Fetch request stage
// (its own session, next to the navigation gate's), and decided on its own URL: a covered request gets
// the header, any other request goes out without it. Chromium pauses each redirect hop as a request of
// its own, and a header set at that stage applies to that one hop only (CDP Fetch.continueRequest:
// "the overrides do not extend to subsequent redirect hops"), so a covered page or file that redirects
// to another host does not take the key with it. A header that still shows up on a request that is not
// covered (whatever put it there) is taken off.
//
// Only GET and HEAD requests carry it (Paul, 2026-11-05): the key lets page loads past the owner's bot
// checks, never a request that sends data (a form post, a beacon, a script's PUT), whoever started
// the scan. Any other method goes out without it, the same as a request that is not covered.
//
// NOT Playwright's route.continue({ headers }): Playwright applies those headers to every redirect the
// request initiates, another host included (its docs, and test/integration/ownerKey.test.ts).
//
// Fails safe: a context without CDP sessions, or a page whose session can't be opened, sends no key;
// a page whose session closes is closed (Chromium resumes requests paused on a closed session).
import type { BrowserLike, CDPSessionLike, ContextLike, PageLike } from './types.js';
import { cdpSession } from './reconnect.js';

export interface ScopedHeader {
  /** The header's name, e.g. `X-Grnted-Key`. */
  name: string;
  value: string;
  /** True only for an address the header may be sent to (the owner's verified hosts). Must not throw. */
  covers: (url: string) => boolean;
}

interface PausedRequest {
  requestId: string;
  request?: { url?: string; method?: string; headers?: Record<string, unknown> };
}

/**
 * The methods that may carry the key: page loads, which send no data. Every covered GET or HEAD the
 * scanner's browser makes (the page, its files, its scripts' reads) is the scanner's own request, and
 * exempting those is the key's purpose (Paul, 2026-11-05: the key is on every scan; review r1, no change).
 */
const KEYED_METHODS = new Set(['GET', 'HEAD']);
const keyedMethod = (method: unknown): boolean => KEYED_METHODS.has(String(method ?? 'GET').toUpperCase());

const covered = (h: ScopedHeader, url: string): boolean => {
  try {
    return h.covers(url) === true;
  } catch {
    return false;
  }
};

/** The request's headers as CDP takes them, without `name`, plus `extra`. */
function headerList(headers: Record<string, unknown> | undefined, lname: string, extra?: { name: string; value: string }): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== lname) out.push({ name, value: String(value) });
  }
  if (extra) out.push(extra);
  return out;
}

async function keyPage(ctx: ContextLike, page: PageLike, h: ScopedHeader): Promise<void> {
  const lname = h.name.toLowerCase();
  const cdp: CDPSessionLike = await cdpSession(ctx, page);
  let lost = false;
  cdp.on('close', () => {
    // Chromium resumes whatever was paused on a closed session: nothing more loads in this page.
    lost = true;
    void page.close().catch(() => {});
  });
  const send = (method: string, params: Record<string, unknown>) => cdp.send(method, params);
  cdp.on('Fetch.requestPaused', ((ev: PausedRequest) => {
    void (async () => {
      const id = { requestId: ev.requestId };
      const headers = ev.request?.headers ?? {};
      const has = Object.keys(headers).some((k) => k.toLowerCase() === lname);
      // CDP always names the method; a paused request without one is never keyed.
      const want = !lost && typeof ev.request?.method === 'string' && keyedMethod(ev.request.method) && covered(h, String(ev.request?.url ?? ''));
      try {
        if (want) {
          await send('Fetch.continueRequest', { ...id, headers: headerList(headers, lname, { name: h.name, value: h.value }) })
            // Refused with the header: it goes on without it (never a key it can't control).
            .catch(() => (has ? Promise.reject(new Error('strip')) : send('Fetch.continueRequest', id)));
        } else if (has) {
          await send('Fetch.continueRequest', { ...id, headers: headerList(headers, lname) });
        } else {
          await send('Fetch.continueRequest', id);
        }
      } catch {
        // The header could not be taken off: the request is not sent.
        await send('Fetch.failRequest', { ...id, errorReason: 'BlockedByClient' }).catch(() => {});
      }
    })();
  }) as never);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
}

/**
 * A browser whose pages send `h` on covered requests only. The contexts and pages are the real ones
 * (the engine compares pages by identity); each context's `newPage` is patched in place.
 */
export function keyedBrowser(browser: BrowserLike, h: ScopedHeader): BrowserLike {
  return {
    ...(typeof browser.newBrowserCDPSession === 'function' ? { newBrowserCDPSession: () => browser.newBrowserCDPSession!() } : {}),
    async newContext(opts) {
      const ctx = await browser.newContext(opts);
      if (typeof ctx.newCDPSession !== 'function') return ctx;
      const newPage = ctx.newPage.bind(ctx);
      ctx.newPage = async () => {
        const page = await newPage();
        try {
          await keyPage(ctx, page, h);
        } catch {
          // Not armed: the page loads without the key.
        }
        return page;
      };
      return ctx;
    },
  };
}

const MAX_HOPS = 10;

/**
 * fetch with `h` on covered addresses only. A covered request's redirects are followed here, by hand,
 * each hop decided on its own address (a fetch that followed them itself would send the header to
 * wherever the site points). A caller that asks for `redirect: 'manual'` gets the 3xx, as before.
 * It checks no address itself: the hosted Worker puts it INSIDE its redirect-checking fetch
 * (browserGuard.ts guardedFetch, which asks for every hop by hand), so each hop passes target safety
 * first and is then decided here.
 */
export function keyedFetch(fetchFn: typeof fetch, h: ScopedHeader): typeof fetch {
  const one = (url: string, init: RequestInit, base: Headers) => {
    const headers = new Headers(base);
    headers.delete(h.name);
    if (keyedMethod(init.method) && covered(h, url)) headers.set(h.name, h.value);
    return fetchFn(url, { ...init, headers, redirect: 'manual' });
  };
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const req = input instanceof Request ? input : null;
    let url = req ? req.url : String(input);
    const base = new Headers(init.headers ?? req?.headers);
    const { redirect, ...rest } = init;
    const opts: RequestInit = { ...(req ? { method: req.method, signal: req.signal } : {}), ...rest };
    const manual = redirect === 'manual' || redirect === 'error' || req?.redirect === 'manual';
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const res = await one(url, opts, base);
      const location = res.headers.get('location');
      if (manual || res.status < 300 || res.status > 399 || !location) return res;
      await res.body?.cancel().catch(() => {});
      url = new URL(location, url).href;
      // A 303 (and a 301/302 after a POST) is a GET with no body, as fetch does it.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && opts.method && opts.method.toUpperCase() === 'POST')) {
        opts.method = 'GET';
        delete opts.body;
      }
    }
    throw new TypeError('Too many redirects');
  }) as typeof fetch;
}
