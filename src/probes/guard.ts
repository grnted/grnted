// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The request guard (Plan 4 rule 1: never change a live site). Installed on a probe context before
// the page loads. Engine core: no Node-only imports.
import { isAnalyticsAddress } from '../analytics.js';
import type { ContextLike, DialogLike, GuardFrameLike, PageLike, RequestLike, RouteLike, WebSocketRouteLike } from '../types.js';
import { formReportPrefix, newPopupNonce, popupReportPrefix } from './listeners.js';
import type { GuardEvent, GuardLog } from './types.js';
import { cdpSession } from '../reconnect.js';

/**
 * Words in an address (path, query names or values) that mark an action rather than a page: signing
 * out, deleting, commerce (bag, cart, checkout, order, payment), account and messaging changes
 * (subscribe, transfer, erase), votes. Also the words the pointer probes refuse to press
 * (`ACTION_NAME` in pointerKit.ts).
 */
const ACTION_WORDS = new Set([
  'logout', 'logoff', 'signout', 'signoff', 'delete', 'remove', 'destroy', 'erase', 'unsubscribe', 'subscribe', 'cancel', 'confirm',
  'bag', 'cart', 'basket', 'checkout', 'pay', 'payment', 'paypal', 'purchase', 'buy', 'order', 'donate', 'donation', 'transfer',
  'vote', 'upvote', 'downvote', 'rsvp', 'deactivate',
]);
/** Word sequences: /log-out, /sign_out, /log-off, /check-out, /end-session, /session/end, /close-my-account. */
const ACTION_SEQUENCES: readonly (readonly string[])[] = [
  ['log', 'out'], ['sign', 'out'], ['log', 'off'], ['sign', 'off'], ['check', 'out'],
  ['end', 'session'], ['session', 'end'], ['close', 'account'], ['close', 'my', 'account'],
];
/** Query names that carry a command (`?action=…`, `?task=user.logout`, `?cmd=_donations`). */
const ACTION_PARAMS = new Set(['action', 'do', 'task', 'cmd', 'op']);
/**
 * Subresources every visitor loads to render the page. They are allowed whatever their address
 * says (a script named cart.js is not an action); the method rule still applies.
 */
const STATIC_TYPES = new Set(['stylesheet', 'script', 'image', 'font', 'media', 'texttrack', 'manifest']);

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function hasActionWords(s: string): boolean {
  const w = words(s);
  return w.some((x, i) => ACTION_WORDS.has(x) || ACTION_SEQUENCES.some((q) => q.every((y, k) => w[i + k] === y)));
}

/** The address looks like an action (log out, delete, unsubscribe, cart, checkout, payment…). */
export function isActionUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw path
  }
  if (hasActionWords(path)) return true;
  for (const [name, value] of u.searchParams) {
    if (ACTION_PARAMS.has(name.toLowerCase())) return true;
    if (hasActionWords(name) || hasActionWords(value)) return true;
  }
  return false;
}

/**
 * Asks the runner for a fresh page for the next test (`ProbeContext.discardPage`), as a test that pressed keys or tried a
 * dismissal must (popupAside.ts, rule 8), unless the page's address looks like an action: such a page is never loaded
 * again (F6), so the next test reuses it. The keyboard walk (5ce62d40) and setting a pop-up aside share it.
 */
export function discardUnlessAction(ctx: { page: { url?(): string }; url: string; discardPage?: () => void }): void {
  if (!isActionUrl(ctx.page.url?.() ?? ctx.url)) ctx.discardPage?.();
}

/** The address without its fragment. */
export function sameDocument(a: string, b: string): boolean {
  const strip = (x: string) => x.split('#')[0]!;
  return strip(a) === strip(b);
}

export type GuardDecision =
  | { action: 'continue' }
  | { action: 'block'; reason: 'method' | 'action' | 'data' }
  | { action: 'hold' }
  /** A frame's navigation after the load phase: nothing is sent and the frame keeps its document. */
  | { action: 'stay' };

export interface GuardRequest {
  method: string;
  url: string;
  resourceType: string;
  /** A navigation of a top-level frame (the page under test or a popup). */
  mainFrameNavigation: boolean;
  /**
   * The runner's own load of the page (`Guard.setPhase('load')`), or a redirect of it. Only that goes
   * ahead as a top-level navigation while loading; the page's own navigations then are treated as at
   * any other time.
   */
  runnerLoad?: boolean;
  /** A navigation of a frame inside the page (not the top-level frame, not a popup). */
  subframeNavigation?: boolean;
  /**
   * For a subframe navigation: the address exactly matches this frame's src/data recorded at the
   * load event. A src set later never authorizes a new address.
   */
  frameDeclared?: boolean;
}

/**
 * Safety principle: the scanner never sends data it typed (strict mode blocks new requests and drains
 * earlier ones before a probe types), non-GET/HEAD requests, form submissions carrying new data,
 * top-level navigations away, or GETs whose address looks like an action. The page's own GETs in
 * response to visitor-level resize, scroll, hover, focus or load actions are allowed, carrying the
 * page's own data. For example, a resize handler fetching /record?answer=42 from a prefilled field
 * is within policy.
 *
 * The policy, in order:
 * 1. Every method other than GET and HEAD is blocked.
 * 2. The page under test itself (any fragment) is allowed: it is the GET the audit already made.
 *    So is the runner's own load of the page and the server's redirects of it ('load', `runnerLoad`).
 *    This includes a GET form rebuilding exactly the current URL: /quiz?answer=42 with a GET form
 *    action=/quiz and answer=42 is a reload carrying no new data, even if stopImmediatePropagation()
 *    prevents the submit finalizer from cancelling it.
 *    The 'load' phase ends when that load does: while the page settles, its own navigations and
 *    requests are treated as between probes.
 * 3. A GET whose address looks like an action is blocked. While the page loads, static subresources
 *    (stylesheet, script, image, font, media, text track, manifest) are exempt: a cart.js is not an
 *    action. While a probe runs, they are not.
 * 4. While a probe runs, and between probes, a top-level navigation away from the page is held: it is
 *    recorded, nothing is sent, and the page stays. Between probes ('between') a top-level navigation
 *    to the page itself (a reload) is held too: only the runner loads the page then, and it does so
 *    in the 'load' phase.
 * 5. Everything else (GET and HEAD) is allowed.
 *
 * Server redirects of an allowed GET are within policy: they are the server's response to a
 * visitor-equivalent request. Playwright does not route redirect hops. For example, fetch('/config')
 * redirecting to /logout is detected afterward and makes settlement fail. When the completion
 * identity check finds a replacement the probe did not load itself (including a page-initiated
 * reload redirected elsewhere), every finding becomes not testable, including returned and
 * retained failures and timing-watch. A probe's completed load sets a new expected identity only
 * when the guard reports exactly one main-frame navigation from its start through the identity
 * read (server redirects belong to that navigation), and the committed URL matches the loaded URL,
 * ignoring its fragment. Otherwise ownership is unproven and the probe is not testable. A confirmed
 * replacement stays invalidating for the run, including across later keep() calls and owned loads.
 *
 * Frames (after rule 1, in every mode): after load, a navigation stays unless its address exactly
 * matches that frame's src/data captured at the load event (`frameDeclared`). Later src changes or
 * newly added frames cannot authorize new requests. While loading, frames load as the page has them.
 *
 * `strict` replaces rules 2 to 5: no new request is sent. Before typing, the runner requires the
 * reported in-flight request set to stay empty for 250 ms, within the probe's remaining time. Every
 * request report restarts this window, including redirect hops delivered after the previous hop's
 * completion. The runner rechecks quiet after its document-identity round trip, immediately before
 * starting the typing probe. Otherwise the probe is not testable: an earlier fetch could still
 * redirect with a cookie set from typed data. This is a bounded quiet window over browser reports,
 * not proof that no later transport report can arrive.
 * It is on while a probe that types into the page runs (`PageProbe.sendsNothing`) and stays on until
 * the runner loads a page again. Any request, even for an address the page already loaded, can carry
 * what was typed: in its path, its headers, or
 * a cookie the page set from it (Chromium adds cookies after the route sees the request, so they
 * cannot be checked there). So every request is blocked ('data'), and a top-level navigation,
 * including a reload of the page itself, is held.
 */
export function decideRequest(req: GuardRequest, ctx: { pageUrl: string; phase: 'load' | 'probe' | 'between'; strict?: boolean }): GuardDecision {
  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return { action: 'block', reason: 'method' };
  if (req.subframeNavigation && ctx.phase !== 'load' && !req.frameDeclared) return { action: 'stay' };
  if (ctx.strict) return req.mainFrameNavigation ? { action: 'hold' } : { action: 'block', reason: 'data' };
  if (req.mainFrameNavigation && ctx.phase === 'load') {
    // While loading, only the runner's own load and the server's redirects of it go ahead. A redirect
    // is the site's behaviour for any visitor, so it is not action-checked (lead decision).
    if (req.runnerLoad) return { action: 'continue' };
  } else if (sameDocument(req.url, ctx.pageUrl)) {
    return ctx.phase === 'between' && req.mainFrameNavigation ? { action: 'hold' } : { action: 'continue' };
  }
  // While a probe runs, a static file at an action address is blocked too: a clicked control or a timer
  // can load `/logout` as an image. While the page loads, what it asks for is what the audit loaded.
  if ((ctx.phase !== 'load' || !STATIC_TYPES.has(req.resourceType)) && isActionUrl(req.url)) return { action: 'block', reason: 'action' };
  if (req.mainFrameNavigation) return { action: 'hold' };
  return { action: 'continue' };
}


const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Plain-language reason for a `not_testable` result caused by a blocked request. */
export function blockedReason(e: GuardEvent): string {
  const what = e.reason === 'method' ? `${e.method ?? 'a'} request`
    : e.reason === 'data' ? `${e.resourceType ?? 'a'} request made while or after the test typed into the page`
      : 'request to an address that looks like an action';
  return `the test would have sent data to the live site (${what}${e.url ? ` to ${e.url}` : ''}), so it was stopped`;
}

/** A host on an allowlist: its registrable-domain suffix, and optionally the only paths (prefixes) that count. */
export interface ListedHost {
  host: string;
  paths?: readonly string[];
}


/**
 * Public font and static-file servers: they only serve the same public files to everyone. During the
 * gesture test a blocked stylesheet, font, image or media file from one of them (or from an analytics
 * host), with no query string, does not end the test (`pointerStop`).
 */
export const STATIC_FILE_HOSTS: readonly ListedHost[] = Object.freeze([
  { host: 'fonts.googleapis.com' }, { host: 'fonts.gstatic.com' }, { host: 'gstatic.com' }, { host: 'use.typekit.net' },
  { host: 'use.fontawesome.com' }, { host: 'ajax.googleapis.com' }, { host: 'cdnjs.cloudflare.com' }, { host: 'cdn.jsdelivr.net' },
  { host: 'unpkg.com' }, { host: 'code.jquery.com' }, { host: 'maxcdn.bootstrapcdn.com' }, { host: 'stackpath.bootstrapcdn.com' },
]);

/** The address is on the list: an http(s) URL whose host is an entry's host or under it, at one of its paths if it has any. */
export function onHostList(url: string | undefined, list: readonly ListedHost[]): boolean {
  let u: URL;
  try {
    u = new URL(url ?? '');
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  return list.some((e) => (host === e.host || host.endsWith(`.${e.host}`)) && (!e.paths || e.paths.some((p) => u.pathname.startsWith(p))));
}

/**
 * A write to an analytics or telemetry service (`GuardEvent.cause` 'background', `isAnalyticsAddress`):
 * blocked like every request that would send data, but it does not end a test.
 */
export function isBackgroundWrite(e: GuardEvent): boolean {
  return e.kind === 'blocked' && e.cause === 'background';
}

/**
 * Why a test could not finish, from what the request guard stopped while it ran: a request that would
 * have sent data, a navigation to another page (held), a popup (closed) or a WebSocket (kept in the page). null when it stopped nothing.
 * A control or timer run with any of these gives no verdict for its item, even when something else
 * changed: what the page would have done next could not happen. The page's background writes
 * (`isBackgroundWrite`) are not stops: they were blocked, and the test goes on.
 */
export function guardStop(events: readonly GuardEvent[]): string | null {
  const blocked = events.find((e) => e.kind === 'blocked' && !isBackgroundWrite(e));
  if (blocked) return blockedReason(blocked);
  const nav = events.find((e) => e.kind === 'navigation');
  if (nav) return `the test would have opened another page${nav.url ? ` (${nav.url})` : ''}, so it was stopped`;
  const popup = events.find((e) => e.kind === 'popup');
  if (popup) return `the test would have opened a new window${popup.url ? ` (${popup.url})` : ''}, so it was closed`;
  const socket = events.find((e) => e.kind === 'websocket');
  if (socket) return `the test would have connected to the live site (WebSocket${socket.url ? ` ${socket.url}` : ''}), so the connection was kept inside the page`;
  return null;
}

/**
 * Events the log keeps; after that it records nothing more (probes must not trust its silence). The
 * page's background writes do not count toward it, up to `BACKGROUND_LOG_CAP` of them.
 */
export const GUARD_LOG_CAP = 500;
/** Background writes the log keeps beyond `GUARD_LOG_CAP`. */
export const BACKGROUND_LOG_CAP = 5000;

/** 'load' while the runner's own load of the page runs; 'between' from then on except while a probe runs. */
export type GuardPhase = 'load' | 'between' | { probe: string; strict?: boolean; ending?: boolean };

export interface Guard {
  log: GuardLog;
  /** Reported main-frame navigation requests of this page, excluding server redirect hops. */
  readonly mainFrameNavigations: number;
  /** Latch strict mode and wait for 250 ms with no reported requests in flight before typing. */
  drain(timeoutMs: number): Promise<boolean>;
  /** Recheck that quiet still holds, without a round trip or another wait. */
  isDrained(): boolean;
  /**
   * 'load' while the runner's own load of the page runs (it and the server's redirects of it go ahead;
   * the runner leaves 'load' as soon as the load event came, before the page settles); the id of the probe running, and `strict` for a probe that
   * types into the page (see `decideRequest`); 'between' at all other times: as during a probe, but
   * with no probe id and a reload of the page held too, so a page can neither leave nor reload itself
   * between two probes. Once a strict probe has run, nothing is
   * sent until the page is loaded again (`setPageUrl`), so a handler the probe set off (a delayed
   * autosave, a timer) cannot send what was typed after the probe ends. The runner never reuses a
   * page after a strict probe (it opens a fresh context), so the latch never meets a reload.
   */
  setPhase(phase: GuardPhase): Promise<void>;
  /** The page under test (after any redirect while loading). Ends the strict mode a strict probe left on. */
  setPageUrl(url: string): void;
  /**
   * The popup sandbox (`GuardOptions.sandbox`): 'on' (a CDP session adds it to the page's documents),
   * 'off' (turned off) or 'unavailable' (the browser could not open a CDP session: only the listener
   * hook keeps windows from opening).
   */
  readonly popupSandbox: 'on' | 'off' | 'unavailable' | 'lost';
  /**
   * The address of the page's document when 'auto' let it through without the sandbox because it is
   * at a local address (`isLocalAddress`); null when the document the page shows was sandboxed.
   */
  readonly unsandboxedDocument: string | null;
}

/** How things stood when the browser reported a request: the guard decides it by these, however late. */
interface Snapshot {
  phase: 'load' | 'probe' | 'between';
  strict: boolean;
  pageUrl: string;
  probe?: string;
  /** The first page navigation the runner's load started in this load phase, or a redirect of it. */
  runnerLoad?: boolean;
}

const STRICTNESS: Record<GuardDecision['action'], number> = { continue: 0, hold: 1, stay: 1, block: 2 };

/** How long the guard waits for a frame's load-time address. */
const FRAME_ELEMENT_MS = 3000;
/** Continuous quiet before a typing probe, covering redirect handoffs and late request reports. */
const DRAIN_QUIET_MS = 250;

/** Installed before page scripts: only the load event can populate this document's frozen map. */
function frameSourcesScript(key: string): string {
  return String.raw`(function () {
    var addresses = new WeakMap();
    function visit(root) {
      var elements = root.querySelectorAll('*');
      for (var i = 0; i < elements.length; i++) {
        var e = elements[i];
        if (/^(iframe|frame|object|embed)$/.test(e.localName)) {
          var value = e.getAttribute(e.localName === 'object' ? 'data' : 'src');
          if (value !== null) { try { addresses.set(e, new URL(value, e.baseURI).href); } catch (x) {} }
        }
        if (e.shadowRoot) visit(e.shadowRoot);
      }
    }
    var captured = false;
    addEventListener('load', function (e) {
      if (captured || e.target !== document) return;
      captured = true;
      visit(document);
    }, true);
    Object.defineProperty(window, ${JSON.stringify(key)}, { value: function (e) { return addresses.get(e) || null; }, configurable: false, writable: false });
  })();`;
}

/** Read only the frozen map in the element's owning document, never its current src/data. */
async function frameAddress(frame: GuardFrameLike, key: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), FRAME_ELEMENT_MS); });
  try {
    if (!frame.frameElement) return null;
    const el = await Promise.race([frame.frameElement(), late]);
    if (!el) return null;
    const src = await Promise.race([el.evaluate((e: Element, key: string) => {
      const read = (e.ownerDocument.defaultView as unknown as Record<string, ((el: Element) => string | null) | undefined> | null)?.[key];
      return typeof read === 'function' ? read(e) : null;
    }, key), late]).finally(() => { void el.dispose?.().catch(() => {}); });
    return typeof src === 'string' ? src : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The sandbox every page under test is loaded in: everything a visitor's page can do except open a
 * window (no allow-popups, no allow-popups-to-escape-sandbox). Its frames inherit it, whatever their
 * origin or address (data:, srcdoc, about:blank, a frame with scripts off), so a window.open the
 * listener hook never saw (a realm it does not run in, a race it loses) is refused by the browser and
 * nothing loads. It does not stop a person's ctrl/cmd-, shift- or middle-click (a new tab is the
 * user's choice): the listener hook cancels those.
 */
export const POPUP_SANDBOX = 'sandbox allow-scripts allow-same-origin allow-forms allow-modals allow-top-navigation allow-downloads allow-orientation-lock allow-pointer-lock';

/**
 * Response headers to drop when the browser's document is handed back to it: the body is already
 * decoded (CDP gives the decoded bytes, checked with gzip and brotli), and Speculation-Rules would have
 * the browser load other pages by itself, outside the request guard and the page's own sandbox.
 */
const DROP_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'speculation-rules']);

/** Longest body (base64 characters) the sandbox hands back; a longer document is not loaded. */
export const SANDBOX_BODY_CAP = 10 * 1024 * 1024;

/** A Link header without the links that prefetch or prerender (the browser loads those outside the guard). */
function withoutSpeculativeLinks(value: string): string {
  return value.split(/,(?=\s*<)/).filter((part) => !/;\s*rel\s*=\s*"?[^";,]*\b(prefetch|prerender)\b/i.test(part)).map((x) => x.trim()).join(', ');
}

export interface HeaderEntry {
  name: string;
  value: string;
}

/**
 * A document's response headers without what asks the browser to load other pages ahead of time (a
 * Speculation-Rules header, the prefetch and prerender links of a Link header), every other header
 * kept as it was; null when there is none (nothing to change). For documents the popup sandbox hands
 * on unchanged: a local page `auto` does not sandbox, a frame's document, a redirect.
 */
export function withoutSpeculativeHeaders(headers: readonly HeaderEntry[]): HeaderEntry[] | null {
  let changed = false;
  const out: HeaderEntry[] = [];
  for (const h of headers) {
    const name = h.name.toLowerCase();
    if (name === 'speculation-rules') {
      changed = true;
      continue;
    }
    if (name === 'link' && /\b(prefetch|prerender)\b/i.test(h.value)) {
      const kept = withoutSpeculativeLinks(h.value);
      changed = true;
      if (kept) out.push({ name: h.name, value: kept });
      continue;
    }
    out.push(h);
  }
  return changed ? out : null;
}

/**
 * A speculative load: the browser asks for a page ahead of time (`<link rel=prefetch>`, a prefetch
 * Link header, a speculation rule), which says so in `Sec-Purpose` (or the older `Purpose`). Nothing a
 * probe tests needs one, and its address is not one the page or a person chose to visit (a rule can
 * ask for every link on the page, a logout link included). The request guard aborts every one it sees.
 */
export function isSpeculativeRequest(req: RequestLike): boolean {
  try {
    if (req.resourceType() === 'prefetch') return true;
    const h = req.headers?.() ?? {};
    return /\b(prefetch|prerender)\b/i.test(`${h['sec-purpose'] ?? ''} ${h['purpose'] ?? ''}`);
  } catch {
    return false;
  }
}

// --- Requests that end before the guard decides them (docs/triage/guard-prefetch-race.md) ---------------
// The browser reports a request (Playwright's 'request') before the route gets it. One that ends first had
// no decision: it counts as unchecked (`Guard.log.settled` is false), unless it provably never left the
// browser. Two kinds can be proven, from what the browser and Playwright report, never from timing:
// - refused: the browser refused it itself before sending it (`REFUSED_BEFORE_SENDING`);
// - cancelled: one of the page's own loads that the route sees at the request stage (`ROUTED_CDP_TYPES`),
//   cancelled before it got there. Playwright never had a route for it (Playwright 1.61 builds one only
//   from the browser's request-stage pause, and when the cancellation is reported first it reports the
//   request with no route and fails it at once), so nothing ever let it go. Because Playwright calls the
//   browser's own prefetches (which no route sees) 'other' too, the guard's own CDP session must show
//   what kind of request it was (`cdpRequestLog`). An accepted cancellation stays revocable: any later
//   report that contradicts it makes it unchecked again (`Guard.log.settled` recomputes).

/**
 * Failures the browser reports for a request it refused itself before sending it: its `blockedReason`,
 * which Playwright gives as the failure text when the browser gives no error text, says the page's
 * Content Security Policy or the mixed-content rules stopped it (checked in Chromium 149: reported, never
 * routed, never sent). A redirect hop is never judged this way: the request before it was sent.
 */
const REFUSED_BEFORE_SENDING = new Set(['csp', 'mixed-content']);
/** The browser's report of a request the page (or the browser) cancelled. */
const CANCELLED = 'net::ERR_ABORTED';
/**
 * The CDP types of the page's own loads (Blink's resource fetcher, through the page's own loaders), which
 * the route sees at the request stage, before anything is sent: images, stylesheets, scripts, fonts, and
 * 'Other' (a prefetch link). Never 'Prefetch' (the browser's own prefetch service: no route or CDP
 * interception sees it), nor any other type Playwright also calls 'other' (SignedExchange, Preflight, FedCM).
 */
const ROUTED_CDP_TYPES = new Set(['Image', 'Stylesheet', 'Script', 'Font', 'Other']);
/** The same loads as Playwright names them; its 'other' counts only for a prefetch link (`isSpeculativeRequest`). */
const ROUTED_TYPES = new Set(['image', 'stylesheet', 'script', 'font']);
/**
 * Addresses, requests in flight, ended requests still able to matter, early wire reports and judgments the
 * guard's CDP record keeps. Past any of them the record is lost (`CdpRequestLog.lose`): it proves nothing
 * more, and every cancellation it accepted is unchecked again. Nothing is ever dropped silently.
 */
export const REQUEST_REPORT_CAP = 5000;

/**
 * What the guard's own CDP session reported about the page's requests (`sandboxPage` feeds it), by address.
 * It answers one question (`verdict`) about a request Playwright reported failed as cancelled, with no route:
 * could it be anything but one of the page's own loads that never left the browser? Playwright gives no
 * request id, so a request is matched by its exact address, and only where the two views agree in full:
 * every request the session reported for the address ended without leaving the browser, as many as
 * Playwright reported for it. A report that does not fit what Chromium 149 and Playwright 1.61 send makes the
 * addresses it names unprovable (a second report for a request in flight, a report after an end), or, when it
 * names none (a hop, a response or an end for a request never reported), loses the record.
 */
interface CdpRequestLog {
  /** False once the session closed, the record overflowed or a report could not be placed: it proves nothing. */
  readonly usable: boolean;
  sent(ev: { requestId: string; type?: string; request?: { url?: string }; redirectResponse?: unknown }): void;
  /** `Network.requestWillBeSentExtraInfo`: the network stack sent the request (CDP allows it before `sent`). */
  wire(ev: { requestId: string }): void;
  responded(ev: { requestId: string }): void;
  finished(ev: { requestId: string }): void;
  failed(ev: { requestId: string; errorText?: string; canceled?: boolean; blockedReason?: string }): void;
  /** Playwright reported a request for this address (any request of the context, routed or not). */
  playwrightReported(url: string): void;
  /**
   * 'no' when the address can never be proven (a request for it of a type the route may not see, redirected,
   * sent to the network (a wire report), answered, finished, or failed some other way; or the record lost);
   * 'wait' while one of its requests is still in flight, or the two views do not yet count the same number
   * of requests for it; 'yes' when every request the session reported for it ended never sent, as many as
   * Playwright reported. A 'yes' can turn into 'no' later, never the other way.
   */
  verdict(url: string): 'yes' | 'no' | 'wait';
  lose(): void;
}

function cdpRequestLog(changed: () => void): CdpRequestLog {
  interface Live { url: string | null; wire: boolean; responded: boolean }
  interface Address { live: number; unsent: number; tainted: boolean; playwright: number }
  const live = new Map<string, Live>();
  /** Ended requests (by id: their address, null for one not over http), oldest first: a later report for one is seen. */
  const ended = new Map<string, string | null>();
  const byUrl = new Map<string, Address>();
  /** Wire reports that came before their request's report. */
  const early = new Set<string>();
  let usable = true;
  const lose = () => {
    if (!usable) return;
    usable = false;
    live.clear(); ended.clear(); byUrl.clear(); early.clear();
    changed();
  };
  const http = (url: string | undefined): url is string => typeof url === 'string' && /^https?:/i.test(url);
  const address = (url: string): Address | undefined => {
    let a = byUrl.get(url);
    if (!a) {
      if (byUrl.size >= REQUEST_REPORT_CAP) { lose(); return undefined; }
      a = { live: 0, unsent: 0, tainted: false, playwright: 0 };
      byUrl.set(url, a);
    }
    return a;
  };
  const taint = (url: string | null) => {
    if (url === null) return;
    const a = address(url);
    if (a) a.tainted = true;
  };
  /**
   * Past the cap, the oldest ended request whose address can no longer be proven anyway (tainted, or not
   * over http) is forgotten (a later report for it then does not fit: lost). One that could still matter is
   * never forgotten: with none to forget, the record is lost.
   */
  const keepEnded = () => {
    if (ended.size <= REQUEST_REPORT_CAP) return;
    for (const [id, url] of ended) {
      if (url === null || byUrl.get(url)?.tainted) { ended.delete(id); return; }
    }
    lose();
  };
  /**
   * A response or an end for a request that is not in flight. After its end it does not fit (Chromium 149 does
   * send one: a frame's document that failed and then finished): its address can never be proven. For a
   * request never reported it cannot be placed: the record is lost.
   */
  const afterEnd = (id: string) => {
    if (!ended.has(id)) return lose();
    taint(ended.get(id)!);
    changed();
  };
  const end = (id: string, rec: Live, unsent: boolean) => {
    live.delete(id);
    if (rec.url !== null) {
      const a = address(rec.url);
      if (!a) return;
      a.live--;
      if (unsent && !rec.wire && !rec.responded) a.unsent++;
      else a.tainted = true;
    }
    ended.set(id, rec.url);
    keepEnded();
    changed();
  };
  return {
    get usable() { return usable; },
    sent(ev) {
      if (!usable) return;
      const id = ev.requestId;
      const before = live.get(id);
      const hop = ev.redirectResponse !== undefined;
      // The same id again is a redirect hop (the request before it got an answer). A hop of a request never
      // reported cannot be placed: the record is lost. A second report without a redirect, or one after the
      // end, does not fit either: both addresses can never be proven.
      if (!before && !ended.has(id) && hop) return lose();
      const odd = before ? !hop : ended.has(id);
      if (before) {
        live.delete(id);
        taint(before.url);
        if (before.url !== null) { const b = byUrl.get(before.url); if (b) b.live--; }
      } else if (odd) {
        taint(ended.get(id)!);
      }
      const url = ev.request?.url;
      if (!http(url)) {
        live.set(id, { url: null, wire: false, responded: false });
      } else {
        const a = address(url);
        if (!a) return;
        a.live++;
        const wire = early.delete(id);
        if (!ev.type || !ROUTED_CDP_TYPES.has(ev.type) || hop || wire || odd) a.tainted = true;
        live.set(id, { url, wire, responded: false });
      }
      if (live.size > REQUEST_REPORT_CAP) return lose();
      changed();
    },
    wire(ev) {
      if (!usable) return;
      const rec = live.get(ev.requestId);
      if (rec) {
        rec.wire = true;
        taint(rec.url);
      } else if (ended.has(ev.requestId)) {
        // A wire report after the end: that request was sent after all.
        taint(ended.get(ev.requestId)!);
      } else {
        early.add(ev.requestId);
        if (early.size > REQUEST_REPORT_CAP) return lose();
        return;
      }
      changed();
    },
    responded(ev) {
      if (!usable) return;
      const rec = live.get(ev.requestId);
      if (!rec) return afterEnd(ev.requestId);
      rec.responded = true;
      taint(rec.url);
      changed();
    },
    finished(ev) {
      if (!usable) return;
      const rec = live.get(ev.requestId);
      if (!rec) return afterEnd(ev.requestId);
      end(ev.requestId, rec, false);
    },
    failed(ev) {
      if (!usable) return;
      const rec = live.get(ev.requestId);
      if (!rec) return afterEnd(ev.requestId);
      const cancelled = ev.canceled === true && ev.errorText === CANCELLED;
      // 'inspector': a route refused it at the request stage (only documents are ever failed at the
      // response stage, by the popup sandbox or the hosted gate, and a document taints its address
      // anyway); the others: the browser refused it itself.
      const refused = ev.blockedReason === 'inspector' || (ev.blockedReason !== undefined && REFUSED_BEFORE_SENDING.has(ev.blockedReason));
      end(ev.requestId, rec, cancelled || refused);
    },
    playwrightReported(url) {
      if (!usable || !http(url)) return;
      const a = address(url);
      if (!a) return;
      a.playwright++;
      changed();
    },
    verdict(url) {
      if (!usable) return 'no';
      const a = byUrl.get(url);
      if (a?.tainted) return 'no';
      return a && a.live === 0 && a.unsent === a.playwright ? 'yes' : 'wait';
    },
    lose,
  };
}

/**
 * The response's headers with the popup sandbox added as one more policy (the site's own CSP and every
 * other header, each Set-Cookie included, kept). `textBody`: the browser gave the body back as text,
 * which is sent as UTF-8, so the content type says so.
 */
export function sandboxedHeaders(headers: readonly HeaderEntry[], textBody: boolean): HeaderEntry[] {
  const out: HeaderEntry[] = [];
  let typed = false;
  for (const h of headers) {
    const name = h.name.toLowerCase();
    if (DROP_HEADERS.has(name)) continue;
    if (name === 'link') {
      const kept = withoutSpeculativeLinks(h.value);
      if (kept) out.push({ name: h.name, value: kept });
      continue;
    }
    if (textBody && name === 'content-type') {
      typed = true;
      const type = h.value.split(';')[0]!.trim() || 'text/html';
      out.push({ name: h.name, value: `${type}; charset=utf-8` });
      continue;
    }
    out.push({ name: h.name, value: h.value });
  }
  if (textBody && !typed) out.push({ name: 'Content-Type', value: 'text/html; charset=utf-8' });
  out.push({ name: 'Content-Security-Policy', value: POPUP_SANDBOX });
  return out;
}

/** Base64 of a string's UTF-8 bytes (no Node-only Buffer: the Worker bundles the engine). */
function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export interface GuardOptions {
  /**
   * The nonce the listener hook was built with (`listenerHookScript`): the windows its popup blocker
   * did not open are then logged as popups. That blocker is the first layer against popups: in some
   * browsers (Cloudflare's) a new window's first request is not routed, so only the page can stop it.
   */
  popupNonce?: string;
  /**
   * Loading the page under test in the popup sandbox (`POPUP_SANDBOX`): 'auto' (default) for every
   * page except one at a local address (`isLocalAddress`), 'always', or 'off'. The browser fetches each
   * document of the page as usual; a CDP session pauses it at the response and hands it back with the
   * sandbox added (Fetch.fulfillRequest: status, headers and body as the server sent them). A document
   * handed back counts as a public one in Chromium's local network access checks, so a local page
   * would lose its other local resources (another port, another local name); local pages are only
   * scanned by a local browser, which routes a popup's first request (the guard stops it). Without a
   * CDP session the sandbox is 'unavailable' (`Guard.popupSandbox`).
   */
  sandbox?: SandboxMode;
  /**
   * The context's WebSocket route, set before its page opened (`routeWebSocketsEarly`): the guard's
   * handler is attached to it instead of routing again.
   */
  webSockets?: EarlyWebSocketRoute;
}

/** A WebSocket route set on a context before its page opens, for `installGuard` to take over. */
export interface EarlyWebSocketRoute {
  /** The route is in place. */
  ready: Promise<void>;
  /** Hands each socket (any that came before too) to `handler`. */
  attach(handler: (ws: WebSocketRouteLike) => void): void;
}

/**
 * Routes the context's WebSockets before its page opens: on a remote browser, routing them once a
 * page exists costs ~600 ms of round trips (the page is updated too), before it nothing. Undefined when
 * the context cannot route WebSockets (`installGuard` then routes them on the page, as before).
 */
export function routeWebSocketsEarly(context: ContextLike): EarlyWebSocketRoute | undefined {
  if (!context.routeWebSocket) return undefined;
  let handler: ((ws: WebSocketRouteLike) => void) | undefined;
  const early: WebSocketRouteLike[] = [];
  const ready = context.routeWebSocket(/.*/, (socket) => {
    if (handler) handler(socket);
    else early.push(socket);
  });
  ready.catch(() => {});
  return {
    ready,
    attach(h) {
      handler = h;
      for (const socket of early.splice(0)) h(socket);
    },
  };
}

export type SandboxMode = 'auto' | 'always' | 'off';

/**
 * A loopback, private or link-local address, or a local name (localhost, *.localhost, *.local):
 * only a browser on the same machine or network reaches it. A public name that resolves to a private
 * address is not detected (its page is sandboxed, and its other private hosts may not load in probes).
 */
export function isLocalAddress(url: string): boolean {
  let host = url; // a bare host name or address
  if (url.includes('://')) {
    try {
      host = new URL(url).hostname;
    } catch {
      return false;
    }
  }
  host = host.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.includes(':')) return isLocalIPv6(host.split('%')[0]!);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  return isLocalIPv4(host);
}

function isLocalIPv4(host: string): boolean {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** ::1, fc00::/7 (unique local), fe80::/10 (link-local), and an IPv4-mapped address by its IPv4. */
function isLocalIPv6(host: string): boolean {
  if (host === '::1') return true;
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(host);
  if (mapped) {
    if (mapped[1]) return isLocalIPv4(mapped[1]);
    const hi = parseInt(mapped[2]!, 16), lo = parseInt(mapped[3]!, 16);
    return isLocalIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(host.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/**
 * Installs the guard on a context (preferred: covers popups) or, failing that, on the page. Returns
 * null when the browser cannot intercept requests: probes must then not run.
 *
 * Popups have two layers. The listener hook's popup blocker never opens a window and reports each one
 * it did not open (logged here as a 'popup', under the probe running when the report arrives). If a
 * window still opens, its requests are stopped (its first, the address it tried to load, is logged
 * as a 'popup') and it is closed, as is any other page the context opens.
 */
export async function installGuard(context: ContextLike, page: PageLike, pageUrl: string, opts: GuardOptions = {}): Promise<Guard | null> {
  const frameKey = `__grntedFrameSources_${newPopupNonce()}`;
  const frameScript = { content: frameSourcesScript(frameKey) };
  if (context.addInitScript) await context.addInitScript(frameScript);
  else if (page.addInitScript) await page.addInitScript(frameScript);
  const events: GuardEvent[] = [];
  let phase: GuardPhase = 'load';
  const start = pageUrl;
  let current = pageUrl;
  /** Preparation for a strict probe began since the page last loaded. */
  let latched = false;
  const probe = () => (typeof phase === 'string' ? undefined : phase.probe);
  /** The first page navigation reported in the current load phase: the runner's own load. */
  let firstLoad: RequestLike | null = null;
  const fromFirstLoad = (req: RequestLike): boolean => {
    for (let r = safeRedirect(req), n = 0; r && n < 30; r = safeRedirect(r), n++) if (r === firstLoad) return true;
    return false;
  };
  const snapshot = (req?: RequestLike): Snapshot => {
    const p = probe();
    // A probe that is ending: its last requests are still its own, under the rules between probes.
    const s: Snapshot = { phase: typeof phase === 'string' ? phase : phase.ending ? 'between' : 'probe', strict: latched || (typeof phase !== 'string' && !!phase.strict), pageUrl: current, ...(p ? { probe: p } : {}) };
    if (req && s.phase === 'load') {
      try {
        const o = origin(req);
        if (o.mainFrameNavigation && !o.popup) {
          if (safeRedirect(req)) s.runnerLoad = fromFirstLoad(req);
          else if (!firstLoad && (sameDocument(req.url(), start) || sameDocument(req.url(), current))) {
            firstLoad = req;
            s.runnerLoad = true;
          }
        }
      } catch {
        // Not readable: not the runner's load.
      }
    }
    return s;
  };
  /** A record was dropped because the log was full: its silence can no longer be trusted. */
  let dropped = false;
  /** Background writes in the log (they do not count toward `GUARD_LOG_CAP`). */
  let background = 0;
  /** Requests that went out without a decision, by the probe they were made in (undefined: outside probes). */
  const unchecked: (string | undefined)[] = [];
  /**
   * The guard's own CDP session's reports of the page's requests (`sandboxPage` feeds it; none without a
   * session): what proves a cancelled request was one of the page's own loads (`unsent`).
   */
  let cdpLog: CdpRequestLog | undefined;
  /**
   * Failed requests the guard never decided that may yet prove never sent (`unsent`), with the probe each
   * was made in. Until one is proven ('ready', then a 'yes' verdict: `accepted`) `settled` for its probe
   * waits. An accepted cancellation is kept, so that a later report that contradicts it (`CdpRequestLog
   * .verdict` 'no') makes it unchecked again; a refusal is the browser's own report of that request and is
   * final. Proof never comes from timing: one that never comes leaves that probe unsettled.
   */
  const judging = new Map<RequestLike, { probe: string | undefined; url: string; kind: 'refused' | 'cancelled'; ready: boolean; accepted: boolean }>();
  const review = () => {
    for (const [r, j] of judging) {
      if (!j.ready) continue;
      // The accept path. What makes a 'yes' safe (docs/triage/guard-prefetch-race.md, "Why it is safe"):
      // 1. Nobody let it go: it had no route (Playwright 1.61 `crNetworkManager._onLoadingFailed` builds a
      //    route-less request only when the cancellation came before the request-stage pause), and a route
      //    exists for every load of the page's own (the route sees them before anything is sent).
      // 2. It was one of those loads: a request no route sees is the browser's own (its prefetch service,
      //    FedCM, preflights), whose start the browser reports to every session at once, in one synchronous
      //    loop (`DispatchToAgents`, content/browser/devtools/devtools_instrumentation.cc), each sent at once
      //    (`DevToolsSession::SendProtocolNotification`, devtools_session.cc), every flattened session through
      //    the root session's client (`GetRootClient()->DispatchProtocolMessage`, protocol/target_handler.cc),
      //    one pipe and its one writer thread (devtools_pipe_handler.cc), and that Playwright emits in arrival
      //    order for every session
      //    (crConnection.ts `CRSession._onMessage`): so its type had tainted the address before Playwright
      //    reported its end, the first report Playwright makes of a request it never had a route for.
      // 3. Defense in depth, if that ordering ever broke: a 'yes' is never final. A later report of the
      //    address (that type, a wire report, a response, a completion) or a record lost (overflow, a report
      //    that does not fit) turns it to 'no' here, and the probe is unchecked again.
      const v = j.kind === 'refused' ? 'yes' : cdpLog ? cdpLog.verdict(j.url) : 'no';
      if (v === 'no') {
        judging.delete(r);
        unchecked.push(j.probe);
      } else if (v === 'yes') {
        if (j.kind === 'refused') judging.delete(r);
        else j.accepted = true;
      } else {
        // 'wait': the two views no longer agree in full (another request for the address in flight, or a
        // count that differs). Accepted only while the verdict is 'yes' now: `settled` for its probe waits again.
        j.accepted = false;
      }
    }
    // Every accepted cancellation is kept to stay revocable: past the cap, the record is lost (all unchecked).
    if (judging.size > REQUEST_REPORT_CAP) cdpLog?.lose();
  };
  /** The page showed nothing yet: no request of its own can have started before the route was in place. */
  const fresh = safeUrl(page) === 'about:blank';
  /** The route is in place: every request reported from now on is paused at the request stage until decided. */
  let routed = false;
  const beforeRoute = new WeakSet<RequestLike>();
  const record = (e: Omit<GuardEvent, 'at' | 'probe'>, p: string | undefined = probe()): void => {
    // A background write past its own cap is not kept (it changes no verdict, so the log's silence
    // still holds); any other event past `GUARD_LOG_CAP` marks the log as no longer complete.
    const bg = (e.kind === 'blocked' && e.cause === 'background') || e.kind === 'frame';
    if (bg ? background >= BACKGROUND_LOG_CAP : events.length - background >= GUARD_LOG_CAP) {
      if (!bg) dropped = true;
      return;
    }
    events.push({ ...e, ...(e.url ? { url: clip(e.url, 300) } : {}), ...(p ? { probe: p } : {}), at: Date.now() });
    if (bg) background++;
  };
  /** Where the request comes from: a top-level navigation, and whether it belongs to a popup. */
  const origin = (req: RequestLike): { mainFrameNavigation: boolean; popup: boolean; subframe?: boolean } => {
    const nav = req.isNavigationRequest ? req.isNavigationRequest() : req.resourceType() === 'document';
    try {
      const frame = req.frame?.();
      const owner = frame?.page?.();
      const popup = owner !== undefined && owner !== page;
      const sub = nav && !!frame && frame.parentFrame() !== null && !popup;
      return { mainFrameNavigation: nav && (frame ? frame.parentFrame() === null : true), popup, ...(sub ? { subframe: true } : {}) };
    } catch (e) {
      // No frame: a service worker request, or a navigation issued before its frame exists, which is a
      // new popup (whether Chromium creates the frame first varies by build).
      const notCreatedYet = /is not available/.test(e instanceof Error ? e.message : String(e));
      return { mainFrameNavigation: nav, popup: nav && notCreatedYet };
    }
  };
  let mainFrameNavigations = 0;
  // Requests the browser reported whose decision has not been made yet. The browser reports a request
  // (synchronously, in order) before the route handler below gets it, and that handler can be held up
  // on a busy machine: `settled` waits for these, so a probe never reads the log before it is complete.
  // Each is decided by how things stood when it was reported (`snapshots`), never by a later phase.
  const reports: ((event: 'request' | 'requestfinished' | 'requestfailed', fn: (request: RequestLike) => void) => unknown) | undefined =
    context.on ? context.on.bind(context) : page.on?.bind(page);
  const waiting = new Set<RequestLike>();
  /** Requests still on the wire, even after an allowed route decision: they may redirect later. */
  const active = new Set<RequestLike>();
  let quietSince: number | undefined;
  const isDrained = () => !active.size && quietSince !== undefined && Date.now() - quietSince >= DRAIN_QUIET_MS;
  const decided = new WeakSet<RequestLike>();
  const snapshots = new WeakMap<RequestLike, Snapshot>();
  let frameSources = new WeakMap<GuardFrameLike, string>();
  const decide = (req: RequestLike, s: Snapshot, declared?: boolean): { decision: GuardDecision; info: GuardRequest; popup: boolean } => {
    const o = origin(req);
    const info: GuardRequest = {
      method: req.method(), url: req.url(), resourceType: req.resourceType(), mainFrameNavigation: o.mainFrameNavigation, ...(s.runnerLoad ? { runnerLoad: true } : {}),
      ...(o.subframe ? { subframeNavigation: true, frameDeclared: declared ?? false } : {}),
    };
    // A strict probe that started since the report makes it stricter, never laxer.
    return { decision: decideRequest(info, { pageUrl: s.pageUrl, phase: s.phase, strict: s.strict || latched }), info, popup: o.popup };
  };
  /**
   * A request whose callback came before the browser's report (or with no reports at all): when it
   * started is unknown, so it is decided by the strictest of now and between probes (only the runner's
   * own load keeps its load rule), never by a looser reading.
   */
  const unreported = (req: RequestLike, declared?: boolean): { s: Snapshot; d: ReturnType<typeof decide> } => {
    const s = snapshot(req);
    const now = decide(req, s, declared);
    if (!reports || s.strict || s.runnerLoad) return { s, d: now };
    const gap = decide(req, { ...s, phase: 'between' }, declared);
    return { s, d: STRICTNESS[gap.decision.action] > STRICTNESS[now.decision.action] ? gap : now };
  };
  const handler = async (route: RouteLike): Promise<void> => {
    const req = route.request();
    const known = snapshots.get(req);
    decided.add(req);
    waiting.delete(req);
    // A speculative load (a prefetch link, a prefetch Link header) is never sent, in any phase. It is
    // not logged: the page did not try to change anything, so it must not make a probe's item untestable.
    if (isSpeculativeRequest(req)) {
      await route.abort('blockedbyclient').catch(() => {});
      return;
    }
    let s: Snapshot;
    let decision: GuardDecision;
    let info: GuardRequest;
    let popup = false;
    try {
      // Compare only with the frozen load-time address, never the current mutable element.
      let declared: boolean | undefined;
      const phaseNow = known?.phase ?? snapshot().phase;
      if (phaseNow !== 'load' && origin(req).subframe) {
        const frame = req.frame?.();
        const key = frame && frameSources.get(frame);
        const address = frame && typeof key === 'string' ? await frameAddress(frame, key) : null;
        declared = typeof address === 'string' && sameDocument(address, req.url());
      }
      if (known) {
        s = known;
        ({ decision, info, popup } = decide(req, s, declared));
      } else {
        let d: ReturnType<typeof decide>;
        ({ s, d } = unreported(req, declared));
        ({ decision, info, popup } = d);
      }
    } catch {
      // A request the guard cannot read is not sent.
      await route.abort().catch(() => {});
      return;
    }
    // ERR_ABORTED cancels a top-level navigation without an error page, so the page stays as it was.
    // A popup gets the error page instead: it commits, so the popup event fires and the popup is closed
    // (with ERR_ABORTED it would stay pending, unseen).
    const code = popup || !info.mainFrameNavigation ? 'blockedbyclient' : 'aborted';
    // A popup is logged here, with the address it tried to load and the probe running now; its page then
    // shows the error page and is closed (below). What a popup loads besides its document is just stopped.
    if (popup && info.mainFrameNavigation) record({ kind: 'popup', url: info.url }, s.probe);
    try {
      if (decision.action === 'block') {
        // A write that is not a navigation (a form sent, a link followed) to an analytics or telemetry
        // service (`isAnalyticsAddress`, the scan's one analytics list) is background traffic: blocked, and logged as such. Every other
        // blocked request is the test's to account for.
        const write = decision.reason === 'method' && !info.mainFrameNavigation && info.resourceType !== 'document' && !popup;
        const cause = write ? (isAnalyticsAddress(info.url) ? 'background' as const : 'own' as const) : undefined;
        record({ kind: 'blocked', url: info.url, method: info.method, resourceType: info.resourceType, reason: decision.reason, ...(info.mainFrameNavigation ? { mainFrame: true } : {}), ...(cause ? { cause } : {}) }, s.probe);
        await route.abort(code);
      } else if (popup) {
        // Popups are recorded (below) and closed; nothing they load is needed.
        await route.abort(code);
      } else if (decision.action === 'hold') {
        record({ kind: 'navigation', url: info.url, method: info.method }, s.probe);
        await route.abort(code);
      } else if (decision.action === 'stay') {
        // ERR_ABORTED: the frame's navigation is cancelled without an error page, so it keeps its document.
        record({ kind: 'frame', url: info.url, method: info.method }, s.probe);
        await route.abort('aborted');
      } else if (route.fallback) {
        // Allowed by this guard, which is not the only one: a route handler installed before it (the
        // hosted Worker's target safety on the context) still decides, and with none, it is sent.
        await route.fallback();
      } else {
        await route.continue();
      }
    } catch {
      // The page or context closed meanwhile.
    }
  };
  const target = context.route ? context : page.route ? page : null;
  if (!target?.route) return null;
  const mode = opts.sandbox ?? 'auto';
  const sandbox: SandboxState = { state: 'off', unsandboxed: null };
  // A speculation-rule prefetch reaches neither the route above nor CDP interception (checked in
  // Chromium: the browser's prefetch service makes it). The listener hook takes the rules out of the
  // page before the browser acts on them; one that still went out is a request no decision covered.
  const speculated = () => { unchecked.push(probe()); };
  // WebSockets bypass `route`: keep them inside the page (never connected to the server, so there is
  // nothing to wait for). Each is logged under the probe running when the page opened it: the page's
  // 'websocket' event, or this callback when it comes first (a later page event for it is then paired).
  const opened = new Map<string, (string | undefined)[]>();
  const early = new Map<string, number>();
  page.on?.('websocket', (w: { url(): string }) => {
    const url = w.url();
    const n = early.get(url) ?? 0;
    if (n) {
      if (n > 1) early.set(url, n - 1);
      else early.delete(url);
      return;
    }
    opened.set(url, [...(opened.get(url) ?? []), probe()]);
  });
  const onSocket = (socket: WebSocketRouteLike) => {
    const url = socket.url();
    const queue = opened.get(url);
    if (queue?.length) {
      const p = queue.shift();
      if (!queue.length) opened.delete(url);
      record({ kind: 'websocket', url }, p);
      return;
    }
    early.set(url, (early.get(url) ?? 0) + 1);
    record({ kind: 'websocket', url });
  };
  // A route set before the page opened (`routeWebSocketsEarly`) takes the handler; otherwise one is set
  // now, while the sandbox and the request route are (a remote browser: ~600 ms of round trips of its
  // own). Awaited after the request route, so a route that fails still fails first, as before.
  const ws = context.routeWebSocket ? context : page.routeWebSocket ? page : null;
  let wsRouted: Promise<void> | undefined;
  if (opts.webSockets) {
    opts.webSockets.attach(onSocket);
    wsRouted = opts.webSockets.ready;
  } else {
    wsRouted = ws?.routeWebSocket?.(/.*/, onSocket);
    wsRouted?.catch(() => {});
  }
  if (mode !== 'off') {
    cdpLog = cdpRequestLog(review);
    sandbox.state = (await sandboxPage(context, page, mode, sandbox, speculated, cdpLog)) ? 'on' : 'unavailable';
    if (sandbox.state !== 'on') cdpLog.lose();
  }
  // Every reported request, redirect hops included, is snapshotted and waited for until the callback
  // decides it. (Playwright 1.61 does not route redirect hops: a hop the browser fetches by itself ends
  // while still waiting, and is judged by its own snapshot then, below.)
  reports?.('request', (r) => {
    if (!routed) beforeRoute.add(r);
    if (cdpLog) {
      try {
        cdpLog.playwrightReported(r.url());
      } catch {
        // Unreadable: its address can never match the CDP session's count (any judgment of it waits).
      }
    }
    const o = origin(r);
    if (o.mainFrameNavigation && !o.popup && !safeRedirect(r)) mainFrameNavigations++;
    quietSince = undefined;
    active.add(r);
    if (decided.has(r)) return;
    snapshots.set(r, snapshot(r));
    waiting.add(r);
  });
  /**
   * Why a request that failed before the guard decided it may never have left the browser: 'refused' (its
   * failure says so: `REFUSED_BEFORE_SENDING`), 'cancelled' (one of the page's own loads the route sees,
   * cancelled: the guard's CDP session must still show it, `cdpRequestLog`), or null: unchecked. A
   * cancellation is judged only in the page's own frame (the frame the CDP session reports), on a page that
   * showed nothing before the guard, for a request reported once the route was in place.
   */
  const unsent = (r: RequestLike): 'refused' | 'cancelled' | null => {
    try {
      const text = r.failure?.()?.errorText;
      if (text !== undefined && REFUSED_BEFORE_SENDING.has(text)) return 'refused';
      if (text !== CANCELLED || !fresh || beforeRoute.has(r) || !cdpLog?.usable) return null;
      const frame = r.frame?.();
      if (!frame || frame.parentFrame() !== null || origin(r).popup) return null;
      const type = r.resourceType();
      return ROUTED_TYPES.has(type) || (type === 'other' && isSpeculativeRequest(r)) ? 'cancelled' : null;
    } catch {
      return null;
    }
  };
  /**
   * Waits, after Playwright reported the failure, for proof that it got no response (Playwright's
   * `response()`); `review` then gives the verdict, for a cancellation from the CDP session's reports
   * (`CdpRequestLog.verdict`), as they come. Anything unreadable or refused leaves it unchecked.
   */
  const judge = (r: RequestLike, probe: string | undefined, kind: 'refused' | 'cancelled') => {
    let url: string;
    let answers: Promise<unknown>;
    try {
      url = r.url();
      const noResponse = r.response
        ? r.response().then((resp) => { if (resp !== null) throw new Error('a response came'); })
        : Promise.reject(new Error('no response() to read'));
      answers = noResponse;
    } catch {
      unchecked.push(probe);
      return;
    }
    const j = { probe, url, kind, ready: false, accepted: false };
    judging.set(r, j);
    answers.then(() => { j.ready = true; review(); }, () => { if (judging.delete(r)) unchecked.push(probe); });
  };
  // A request that ends before the guard decided it went out unchecked, except a redirect hop the
  // guard would have let through anyway (CDNs redirect files all the time): decided by its snapshot;
  // and a failed one that proves it never left the browser (`unsent`, `judge`).
  const ended = (r: RequestLike, failed: boolean) => {
    active.delete(r);
    if (!active.size) quietSince = Date.now();
    if (!waiting.has(r)) return;
    waiting.delete(r);
    const s = snapshots.get(r);
    if (s && safeRedirect(r)) {
      try {
        if (decide(r, s).decision.action === 'continue') return;
      } catch {
        // Unreadable: unchecked.
      }
    } else if (s && failed) {
      const why = unsent(r);
      if (why) {
        judge(r, s.probe, why);
        return;
      }
    }
    unchecked.push(s?.probe);
  };
  reports?.('requestfinished', (r) => ended(r, false));
  reports?.('requestfailed', (r) => ended(r, true));
  await target.route(/.*/, handler);
  routed = true;
  await wsRouted;

  // Windows the page's popup blocker did not open (its reports, with the nonce), and windows the
  // browser itself refused in the popup sandbox (its own console error): a race the hook lost, or a
  // realm it never ran in, still counts as a popup for the probe.
  const prefix = opts.popupNonce ? popupReportPrefix(opts.popupNonce) : null;
  const formPrefix = opts.popupNonce ? formReportPrefix(opts.popupNonce) : null;
  /**
   * A form submission the listener hook cancelled (it never reached the network): logged as the guard
   * would have decided it, so a test still sees that its press would have sent a form.
   */
  const formReport = (json: string) => {
    const f = JSON.parse(json) as { method?: unknown; url?: unknown; frame?: unknown };
    if (typeof f.method !== 'string' || typeof f.url !== 'string') return;
    const frame = f.frame === true;
    const req: GuardRequest = { method: f.method, url: f.url, resourceType: 'document', mainFrameNavigation: !frame, ...(frame ? { subframeNavigation: true, frameDeclared: false } : {}) };
    const s = snapshot();
    const d = decideRequest(req, { pageUrl: s.pageUrl, phase: s.phase === 'load' ? 'between' : s.phase, strict: s.strict });
    if (d.action === 'block') record({ kind: 'blocked', url: f.url, method: req.method, resourceType: 'document', reason: d.reason, ...(frame ? {} : { mainFrame: true }) }, s.probe);
    else if (d.action === 'stay') record({ kind: 'frame', url: f.url, method: req.method }, s.probe);
    else record({ kind: 'navigation', url: f.url, method: req.method }, s.probe);
  };
  page.on?.('console', (m) => {
    try {
      const type = m.type();
      if (type === 'debug' && prefix) {
        const text = m.text();
        if (text.startsWith(prefix)) record({ kind: 'popup', url: text.slice(prefix.length) });
        else if (formPrefix && text.startsWith(formPrefix)) formReport(text.slice(formPrefix.length));
      } else if (type === 'error' || type === 'warning') {
        const refused = SANDBOX_REFUSED.exec(m.text());
        if (refused) record({ kind: 'popup', url: refused[1]! });
      }
    } catch {
      // Not readable: not a report.
    }
  });
  // A window that opened anyway: a popup (it has an opener) or a new tab (ctrl/cmd-click: only the
  // context sees it). Each is logged once and closed.
  const strays = new WeakSet<object>();
  const stray = (other: PageLike) => {
    if (other === page || strays.has(other)) return;
    strays.add(other);
    // An error page means the request above stopped it, and it is logged already. A window with an
    // address of its own (e.g. window.open('') shows about:blank) is logged here.
    const url = safeUrl(other);
    if (!url?.startsWith('chrome-error:')) record({ kind: 'popup', url });
    other.close().catch(() => {});
  };
  page.on?.('popup', stray);
  context.on?.('page', stray);
  page.on?.('dialog', (d: DialogLike) => {
    record({ kind: 'dialog', dialog: d.type(), message: clip(d.message(), 200) });
    d.dismiss().catch(() => {});
  });
  const main = page.mainFrame?.();
  if (main) {
    let last = pageUrl;
    page.on?.('framenavigated', (frame: GuardFrameLike) => {
      if (frame !== main) return;
      const url = frame.url();
      if (phase !== 'load' && url !== last) record({ kind: 'url-change', url });
      last = url;
    });
  }

  return {
    async drain(timeoutMs) {
      latched = true;
      const end = Date.now() + Math.max(0, timeoutMs);
      if (!active.size) quietSince ??= Date.now();
      for (;;) {
        const left = end - Date.now();
        if (left <= 0) return false;
        if (isDrained()) return true;
        await new Promise((resolve) => setTimeout(resolve, Math.min(10, left)));
      }
    },
    isDrained,
    log: {
      get events() { return events; },
      mark: () => events.length,
      since: (m: number) => events.slice(m).filter((e) => !isBackgroundWrite(e)),
      async settled(timeoutMs: number, probeId?: string) {
        const p = probeId ?? probe();
        const end = Date.now() + Math.max(0, timeoutMs);
        // A failed request made under this probe that may yet prove never sent (`judging`): its answer is to come.
        const judged = () => {
          review();
          for (const j of judging.values()) if (j.probe === p && !j.accepted) return false;
          return true;
        };
        // Always yield first: a report already on its way (queued behind this call) arrives before the answer.
        for (;;) {
          await new Promise((r) => setTimeout(r, waiting.size || !judged() ? 10 : 0));
          if (!waiting.size && judged()) break;
          if (Date.now() >= end) return false;
        }
        // One round trip to the page: a popup report it sent before (console) arrives before the
        // answer, so it is logged under its probe before this returns. Best effort: a page that does
        // not answer in time is not waited for (whatever it tried to open, the sandbox refused).
        if (opts.popupNonce && page.evaluate) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            page.evaluate(() => 0, undefined).catch(() => {}),
            new Promise((r) => { timer = setTimeout(r, Math.max(250, end - Date.now())); }),
          ]).finally(() => clearTimeout(timer));
        }
        return !dropped && !unchecked.includes(p) && judged();
      },
      latchStrict() { latched = true; },
      inFlight() {
        if (!reports) return undefined;
        const out: string[] = [];
        for (const r of active) {
          try { if (r.resourceType() === 'document') out.push(r.url()); } catch { /* a request that went away */ }
        }
        return out;
      },
    },
    get mainFrameNavigations() { return mainFrameNavigations; },
    get popupSandbox() { return sandbox.state; },
    get unsandboxedDocument() { return sandbox.unsandboxed; },
    async setPhase(p) {
      const endingLoad = phase === 'load' && p !== 'load';
      if (p === 'load' && phase !== 'load') { firstLoad = null; frameSources = new WeakMap(); }
      if (endingLoad) {
        // frameElement() initializes Playwright's injected pointer listeners in the parent. Doing
        // that at startup would misread the browser tool's handlers as the page's own. The frame
        // addresses were already captured by the page-side load listener. No live DOM read here can
        // turn a later src assignment into a load-time address, even if evaluation is delayed.
        for (const frame of page.frames?.() ?? []) {
          if (frame.parentFrame()) frameSources.set(frame as unknown as GuardFrameLike, frameKey);
        }
      }
      phase = p;
      if (typeof p !== 'string' && p.strict) latched = true;
    },
    setPageUrl(url) {
      current = url;
      latched = false;
      quietSince = undefined;
    },
  };
}

interface PausedResponse {
  requestId: string;
  frameId?: string;
  request?: { url?: string };
  responseStatusCode?: number;
  responseStatusText?: string;
  responseErrorReason?: string;
  responseHeaders?: HeaderEntry[];
}

/** Chromium's console error for a window the sandbox refused (the address it would have loaded). */
const SANDBOX_REFUSED = /^Blocked opening '(.+)' in a new window because the request was made in a sandboxed frame whose 'allow-popups' permission is not set\.?$/;

/**
 * Documents at their response. (Not requests at the request stage: pausing them here as well would
 * delay the browser's report of the page's own requests past the request guard's settle wait.)
 */
const SANDBOX_PATTERNS = [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }];

/** Redirects: the browser follows them and pauses the next document again. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

interface SandboxState {
  state: 'on' | 'off' | 'unavailable' | 'lost';
  unsandboxed: string | null;
}

/**
 * Loads the page's documents in the popup sandbox: a CDP session pauses every document at its
 * response (the browser fetched it: its own DNS, TLS, cookies, Sec-Fetch headers and guardrails), and
 * the main frame's is handed back with `POPUP_SANDBOX` added (Fetch.fulfillRequest; continueResponse
 * with the header added does not sandbox). Frames inherit the sandbox, so theirs go on unchanged, as do
 * redirects (the next document is paused again), a response with no document (204, 205) and a local
 * page `auto` does not sandbox, except that every one of them loses the headers that ask for
 * speculative loads (`withoutSpeculativeHeaders`). Anything
 * else that is not a document of its own (304, 300, no status) is not loaded, nor is a failed
 * response, a body over `SANDBOX_BODY_CAP` or one that cannot be read. The cache is off (a cached
 * document would come without the sandbox), and so is prerendering. A session that closes leaves the
 * sandbox 'lost'. False when no CDP session could be opened. `speculated` is called for each
 * speculation-rule prefetch the browser reports (made outside every interception). `log` records the
 * session's reports of every request of the page (`cdpRequestLog`); a session that closes loses it.
 */
async function sandboxPage(context: ContextLike, page: PageLike, mode: SandboxMode, sandbox: SandboxState, speculated: () => void, log: CdpRequestLog): Promise<boolean> {
  if (!context.newCDPSession) return false;
  try {
    const cdp = await cdpSession(context, page);
    // The frame tree is asked for with the commands below, in one round trip: the session runs them in
    // order, and nothing is paused before the page loads, after this returns.
    const tree = cdp.send('Page.getFrameTree', {}) as Promise<{ frameTree?: { frame?: { id?: string } } }>;
    let main: string | undefined;
    const send = (method: string, params: Record<string, unknown>) => cdp.send(method, params).catch(() => {});
    // Only a sandbox that came up can be lost (one that did not is 'unavailable', whatever its session does).
    let armed = false;
    cdp.on('close', () => { if (armed) sandbox.state = 'lost'; log.lose(); });
    cdp.on('Network.requestWillBeSent', (ev: Parameters<typeof log.sent>[0]) => log.sent(ev));
    cdp.on('Network.requestWillBeSentExtraInfo', (ev: { requestId: string }) => log.wire(ev));
    cdp.on('Network.responseReceived', (ev: { requestId: string }) => log.responded(ev));
    cdp.on('Network.loadingFinished', (ev: { requestId: string }) => log.finished(ev));
    cdp.on('Network.loadingFailed', (ev: Parameters<typeof log.failed>[0]) => log.failed(ev));
    const fail = (id: { requestId: string }) => send('Fetch.failRequest', { ...id, errorReason: 'BlockedByClient' });
    // A document handed on as the server sent it, minus the headers that ask for speculative loads.
    // If the browser refuses the changed headers, it goes on unchanged (never left paused).
    const pass = (id: { requestId: string }, ev: PausedResponse) => {
      const kept = withoutSpeculativeHeaders(ev.responseHeaders ?? []);
      // Chromium overrides headers only with the status given too.
      if (!kept || ev.responseStatusCode === undefined) return send('Fetch.continueResponse', id);
      const changed = { ...id, responseCode: ev.responseStatusCode, ...(ev.responseStatusText ? { responsePhrase: ev.responseStatusText } : {}), responseHeaders: kept };
      return cdp.send('Fetch.continueResponse', changed).catch(() => send('Fetch.continueResponse', id));
    };
    cdp.on('Fetch.requestPaused', (ev: PausedResponse) => {
      void (async () => {
        const id = { requestId: ev.requestId };
        if (ev.responseErrorReason) return send('Fetch.failRequest', { ...id, errorReason: ev.responseErrorReason });
        if (ev.frameId !== main) return pass(id, ev);
        const status = ev.responseStatusCode;
        if (status !== undefined && (REDIRECTS.has(status) || status === 204 || status === 205)) return pass(id, ev);
        if (status === undefined || status < 200 || status >= 300 && status < 400) return fail(id);
        const url = ev.request?.url ?? '';
        if (mode === 'auto' && isLocalAddress(url)) {
          sandbox.unsandboxed = url;
          return pass(id, ev);
        }
        let body: { body: string; base64Encoded: boolean };
        try {
          body = (await cdp.send('Fetch.getResponseBody', id)) as typeof body;
        } catch {
          return fail(id);
        }
        if (body.body.length > SANDBOX_BODY_CAP) return fail(id);
        sandbox.unsandboxed = null;
        return send('Fetch.fulfillRequest', {
          ...id,
          responseCode: status,
          ...(ev.responseStatusText ? { responsePhrase: ev.responseStatusText } : {}),
          responseHeaders: sandboxedHeaders(ev.responseHeaders ?? [], !body.base64Encoded),
          body: body.base64Encoded ? body.body : utf8Base64(body.body),
        });
      })();
    });
    // The browser reports a speculation-rule prefetch here (type 'Prefetch') even though no interception
    // sees it. Prefetch links and prefetch Link headers are reported as other types: the route stops those.
    cdp.on('Network.requestWillBeSent', (ev: { type?: string }) => {
      if (ev.type === 'Prefetch') speculated();
    });
    const sent = [
      tree.then((t) => { main = t.frameTree?.frame?.id; }),
      cdp.send('Network.enable', {}),
      cdp.send('Network.setCacheDisabled', { cacheDisabled: true }),
      cdp.send('Page.setPrerenderingAllowed', { isAllowed: false }).catch(() => {}),
      cdp.send('Fetch.enable', { patterns: SANDBOX_PATTERNS }),
    ];
    const all = await Promise.allSettled(sent);
    if (main && all.every((r) => r.status === 'fulfilled')) {
      armed = true;
      return true;
    }
    // No sandbox: nothing is left paused (the interception is turned off again).
    await cdp.send('Fetch.disable', {}).catch(() => {});
    return false;
  } catch {
    return false;
  }
}

function safeRedirect(r: RequestLike): RequestLike | null {
  try {
    return r.redirectedFrom?.() ?? null;
  } catch {
    return null;
  }
}

function safeUrl(p: PageLike): string | undefined {
  try {
    return p.url?.();
  } catch {
    return undefined;
  }
}
