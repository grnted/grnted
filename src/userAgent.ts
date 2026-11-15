// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The User-Agent a scan sends, on every page load and every plain fetch: the browser's OWN user agent
// with Granted's token appended. Never a hard-coded browser version (P1, 2026-11-06): a User-Agent that
// claims one Chrome while the browser's client hints (Sec-CH-UA, navigator.userAgentData) say another
// is what bot shields block as a disguised bot (WordPress.com hosting refused every page with 403).
// The client hints always carry the browser's real brands and version, whatever the User-Agent says
// (Playwright's override does not change them), so the browser's own string is the only one that agrees
// with them.
// Granted's name (Paul 2026-11-07): "grnted/<version> (grnted.co)". Measured on a city site behind Akamai Bot Manager
// from Cloudflare's own browser: "HeadlessChrome", the word "bot" and a "(+https://…)" crawler link are each refused
// on sight, while the same browser named "grnted/0.9 (grnted.co)" loads. The name points owners to grnted.co with no
// crawler link; robots.txt rules for "grnted" still apply.
// "HeadlessChrome/" is read as "Chrome/" only where the browser's client hints agree (presentHeadlessAsChrome):
// Cloudflare's hosted browser sends Sec-CH-UA "Chromium" with no HeadlessChrome brand (measured on staging
// 2026-11-07), and signs every request as Cloudflare's browser (Web Bot Auth). A local headless browser's hints do
// carry HeadlessChrome, so the CLI keeps the browser's own string (a mismatch is what bot shields refuse).
// Engine core: no Node-only imports.
import type { BrowserLike, CDPSessionLike } from './types.js';
import { DEFAULT_USER_AGENT, ENGINE_VERSION } from './version.js';

/** How the scanner names itself: always the end of the User-Agent it sends. */
export const UA_TOKEN = `grnted/${ENGINE_VERSION} (grnted.co)`;
/** The name before 2026-11-07, still recognised so a scan stored with it gets the current one. */
const OLD_UA_TOKEN = `grnted/${ENGINE_VERSION} (+https://grnted.co/bot)`;

/** `ua` with Granted's token at its end (added once); an empty one gives the fallback user agent. */
let headlessAsChrome = false;

/**
 * Send "Chrome/" for the browser's "HeadlessChrome/" from now on in this process: only for a browser whose client
 * hints carry no HeadlessChrome brand (Cloudflare's hosted browser; the Worker turns it on). Off by default.
 */
export function presentHeadlessAsChrome(on = true): void {
  headlessAsChrome = on;
}

export function withToken(ua: string): string {
  let base = ua.trim();
  if (!base) return DEFAULT_USER_AGENT;
  if (base.endsWith(OLD_UA_TOKEN)) base = base.slice(0, -OLD_UA_TOKEN.length).trimEnd();
  if (headlessAsChrome) base = base.replace(/\bHeadlessChrome\//, 'Chrome/');
  return base.endsWith(UA_TOKEN) ? base : `${base} ${UA_TOKEN}`;
}

/** The user agent is one Granted sends (ends with its token): a browser may put its own in its place. */
export function isGrntedAgent(ua: string | undefined): ua is string {
  return typeof ua === 'string' && (ua.trimEnd().endsWith(UA_TOKEN) || ua.trimEnd().endsWith(OLD_UA_TOKEN));
}

/** Each step of reading the browser's user agent is bounded: a browser that does not answer gives none. */
export const READ_UA_MS = 5000;

/**
 * What a browser needs for its user agent to be read: a browser-level CDP session (Chromium: local
 * Playwright and Browser Rendering alike; the hosted navigation gate needs one too). Read there, nothing
 * is opened in the browser: no context, no page, so no session's work or counts change.
 */
export interface UserAgentSource {
  newBrowserCDPSession?(): Promise<CDPSessionLike | unknown>;
}

/** A browser with no CDP session of its own (a wrapper that hides it): read from a blank page instead. */
export interface PageUserAgentSource extends UserAgentSource {
  newContext(opts: never): Promise<unknown>;
}

const bounded = async <T>(p: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), ms); })]);
  } finally {
    clearTimeout(timer);
  }
};

const plausible = (ua: unknown): ua is string => typeof ua === 'string' && /^Mozilla\/5\.0 \S/.test(ua.trim()) && ua.length < 512;

/** The browser's user agent from its CDP `Browser.getVersion` (no page, no context, nothing loaded). */
async function fromCdp(browser: UserAgentSource, ms: number): Promise<string | undefined> {
  if (typeof browser.newBrowserCDPSession !== 'function') return undefined;
  const opening = browser.newBrowserCDPSession() as Promise<CDPSessionLike>;
  const session = await bounded(opening.catch(() => undefined), ms);
  if (!session) {
    // One that answers late is ended (never left open).
    void opening.then((s) => s?.detach?.(), () => {}).catch(() => {});
    return undefined;
  }
  try {
    const v = (await bounded(session.send('Browser.getVersion').catch(() => undefined), ms)) as { userAgent?: unknown } | undefined;
    return plausible(v?.userAgent) ? v.userAgent.trim() : undefined;
  } finally {
    void Promise.resolve(session.detach?.()).catch(() => {});
  }
}

interface BlankContext {
  newPage(): Promise<{ evaluate(expression: string): Promise<unknown> }>;
  close(): Promise<void>;
}

/** navigator.userAgent of a blank page in a context with no override (nothing loaded); its context closed. */
async function fromBlankPage(browser: PageUserAgentSource, ms: number): Promise<string | undefined> {
  const opening = (browser.newContext as (o: unknown) => Promise<BlankContext>)({ viewport: { width: 100, height: 100 } });
  const ctx = await bounded(opening.catch(() => undefined), ms);
  if (!ctx) {
    void opening.then((c) => c?.close(), () => {}).catch(() => {});
    return undefined;
  }
  try {
    const ua = await bounded((async () => (await ctx.newPage()).evaluate('navigator.userAgent'))().catch(() => undefined), ms);
    return plausible(ua) ? ua.trim() : undefined;
  } finally {
    void Promise.resolve(ctx.close?.()).catch(() => {});
  }
}

const own = new WeakMap<object, Promise<string | undefined>>();
let lastRead: string | undefined;

/**
 * The browser's own user agent (what it sends with no override, the same string navigator.userAgent gives
 * a page), read once per browser object from CDP. Undefined when it cannot be read in time (each step at
 * most `ms`).
 */
export function ownUserAgent(browser: UserAgentSource, ms = READ_UA_MS): Promise<string | undefined> {
  let p = own.get(browser);
  if (!p) {
    p = (async () => {
      try {
        const ua = await fromCdp(browser, ms);
        if (ua) lastRead = ua;
        return ua;
      } catch {
        return undefined;
      }
    })();
    own.set(browser, p);
  }
  return p;
}

/**
 * The User-Agent a scan in this browser sends: its own with Granted's token. When it cannot be read,
 * the last one read in this process (the same browser build), else the fallback (`DEFAULT_USER_AGENT`).
 */
export async function browserUserAgent(browser: UserAgentSource, ms = READ_UA_MS): Promise<string> {
  const ua = await ownUserAgent(browser, ms);
  return withToken(ua ?? lastRead ?? DEFAULT_USER_AGENT);
}

const fromPage = new WeakMap<object, Promise<string | undefined>>();

/**
 * scanSite's: `browserUserAgent`, except that a browser with no CDP session of its own (a wrapper that
 * does not pass it on) is read from a blank page, so the scan never falls back to a made-up version.
 */
export async function scanUserAgent(browser: PageUserAgentSource, ms = READ_UA_MS): Promise<string> {
  if (typeof browser.newBrowserCDPSession === 'function') return browserUserAgent(browser, ms);
  let p = fromPage.get(browser);
  if (!p) {
    p = fromBlankPage(browser, ms).catch(() => undefined).then((ua) => {
      if (ua) lastRead = ua;
      return ua;
    });
    fromPage.set(browser, p);
  }
  return withToken((await p) ?? lastRead ?? DEFAULT_USER_AGENT);
}

/**
 * The User-Agent for plain fetches made before any browser is open (the hosted start-speed check): the
 * last browser's own read in this process with the token, else the fallback.
 */
export function lastBrowserUserAgent(): string {
  return withToken(lastRead ?? DEFAULT_USER_AGENT);
}

/**
 * `opts` for a new context in `browser`: a Granted User-Agent (one that ends with the token) is replaced
 * by this browser's own with the token, so every session, a replacement one included, sends what its
 * client hints agree with. Any other User-Agent, or one that cannot be read, is left as it is.
 */
export async function matchedContextOptions<O>(browser: UserAgentSource, opts: O): Promise<O> {
  const ua = (opts as { userAgent?: string } | undefined)?.userAgent;
  if (!isGrntedAgent(ua)) return opts;
  const mine = await ownUserAgent(browser);
  return mine ? { ...opts, userAgent: withToken(mine) } : opts;
}

/** `browser` whose contexts are given its own User-Agent in place of a Granted one (`matchedContextOptions`). */
export function userAgentMatching<B extends Pick<BrowserLike, 'newContext'>>(browser: B): B {
  return new Proxy(browser, {
    get(target, prop, receiver) {
      if (prop === 'newContext') {
        return async (opts: Parameters<BrowserLike['newContext']>[0]) => target.newContext(await matchedContextOptions(target as UserAgentSource, opts));
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
