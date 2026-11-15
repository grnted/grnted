// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Record once, test on the copy (docs/record-replay.md): the browser side. One layer below the probes,
// the guard and the navigation gate: a BrowserLike wrapper (next to analytics.ts and userAgent.ts) whose
// contexts record what the site answers and answer every later request for it from the scan's snapshot.
//
// - Recording is passive: the live request is the browser's own, exactly as without replay; its answer
//   is read once it finished (`requestfinished`). Nothing is fetched on the side.
// - Replay is a route on the context (`route.fulfill`). The route is registered when the context opens,
//   so every handler added later (the probes' request guard) decides first, and a request a guard
//   stops is stopped as before. A miss goes on to the next handler and to the site, as before.
// - A recorded redirect cannot be replayed from a route: Playwright does not route the next hop, and a
//   page session opened later sits in front of Playwright (its answers would never reach it). So the
//   whole chain is answered one layer further in, from a browser-level CDP session (Chromium asks the
//   browser target's Fetch handler last, closest to the network): the route marks the request with a
//   header, that session answers it and each following hop from the copy, and takes the mark off
//   anything it lets through. It is opened only once the scan has recorded a redirect, and it pauses
//   only documents and the addresses on recorded redirect chains, never every request.
// Engine core: no Node-only imports.
import { isAnalyticsBeacon } from '../analytics.js';
import type { BrowserLike, CDPSessionLike, ContextLike, PageLike, RequestLike, RouteLike, SubresourceResponseLike } from '../types.js';
import { sentToSite } from './sent.js';
import { createSnapshot, replayUrl, type Lease, type ReplayHit, type ReplayRequest, type ReplayStats, type Snapshot, type SnapshotOptions } from './snapshot.js';

export type ReplayMode = 'off' | 'record-replay';

export interface ReplayOptions extends SnapshotOptions {
  /** Keep the snapshot's store when the scan ends (default: cleared). */
  keep?: boolean;
  /**
   * The navigation gate checks server addresses (`ScanOptions.allowIp`): a document answered from the
   * copy says so to the gate in a response header (`gateMark`), which the gate takes off again.
   */
  gateMark?: boolean;
}

/** One scan's record-and-replay: its snapshot and the browsers that record into it and answer from it. */
export interface Replay {
  snapshot: Snapshot;
  /** `browser` whose contexts record and replay. The context and page objects are the browser's own. */
  browser(browser: BrowserLike): BrowserLike;
  /** The whole load of this page address would be answered from the copy (the pace controller's question). */
  ready(url: string): boolean;
  /**
   * This answer (a Playwright response of any context of the scan) was given from the copy, not by the
   * site: what judges the site by its answers leaves it out (the pace controller, the session pool).
   * Exact for an answer given at the route; a redirect chain answered further in is told by the
   * browser's own timing (`sentToSite`), and only for requests this layer sent that way.
   */
  copied(response: unknown): boolean;
  /** The response header (name and value) a replayed document carries for the gate, when `gateMark` is on. */
  gateMark?: { name: string; value: string };
  stats(): ReplayStats;
  /** The scan ended: sessions let go, waiting requests go live, the snapshot cleared (unless kept). */
  close(): Promise<void>;
}

/** The request header that marks a recorded redirect for the browser-level session (never sent to a site). */
export const REPLAY_MARK = 'x-grnted-replay';
/** Longest wait for the browser-level session to open, and for each of its commands at start. */
const INNER_MS = 5000;
/** Request ids the browser-level session remembers as this scan's (their next hops are too). */
const OURS_MAX = 4000;
/**
 * Longest a context's close waits for the answers it is still recording (their bodies are read once each
 * request finished): a page closed right after its load event would otherwise leave its last resources
 * out of the copy, and every later load would ask the site for them again.
 */
const CLOSE_WAIT_MS = 500;

type Pattern = { urlPattern: string; resourceType?: string; requestStage: 'Request' };
const DOCUMENTS: Pattern[] = [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }];
/**
 * Most addresses on recorded redirect chains of things that are not documents (a stylesheet, a script, an
 * image that redirects) the browser-level session pauses by name. Past it such a chain is not replayed
 * (its first hop is asked of the site again). Never "every request": a pause costs a round trip to the
 * browser, and on a remote browser that is the network.
 */
const CHAIN_URLS_MAX = 300;
/** `url` as a CDP Fetch pattern that matches only itself (`*` and `?` are its wildcards, `\\` its escape). */
const exactly = (url: string): string => url.replace(/[\\*?]/g, '\\$&');

interface PausedRequest {
  requestId: string;
  request: { url: string; method: string; headers?: Record<string, string> };
  resourceType?: string;
  redirectedRequestId?: string;
}

/**
 * The kind of request a marked request carries after this scan's mark (`<mark>:<kind>`, the kind as the
 * route saw it; empty when it had none); undefined when the header is not this scan's mark.
 */
const kindOf = (value: string | undefined, mark: string): string | undefined =>
  value !== undefined && value.startsWith(`${mark}:`) ? value.slice(mark.length + 1).toLowerCase() : undefined;

const token = (): string => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
};

const bounded = async <T>(p: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), ms); })]);
  } finally {
    clearTimeout(timer);
  }
};

type NodeBuffer = { from(data: ArrayBufferLike, offset: number, length: number): Uint8Array & { toString(encoding: string): string } };
const nodeBuffer = (): NodeBuffer | undefined => (globalThis as { Buffer?: NodeBuffer }).Buffer;

/** The body as Playwright's `route.fulfill` takes bytes (a Buffer: any other array is sent as text). */
function fulfillBody(bytes: Uint8Array): Uint8Array {
  const B = nodeBuffer();
  return B ? B.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes;
}

export function toBase64(bytes: Uint8Array): string {
  const B = nodeBuffer();
  if (B) return B.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A loopback server address (IPv4 127/8, IPv6 ::1), as Playwright's `serverAddr()` gives it. */
const isLoopback = (ip: string): boolean => /^127\./.test(ip) || /^\[?(?:0*:)*:?0*1\]?$/.test(ip) || /^\[?::ffff:127\./i.test(ip);

const entries = (h: Record<string, string>): { name: string; value: string }[] => Object.entries(h).map(([name, value]) => ({ name, value }));

/** The request as the snapshot reads it; undefined for one that cannot be read, or a service worker's own. */
function requestOf(req: RequestLike): ReplayRequest | undefined {
  try {
    if ((req as { serviceWorker?: () => unknown }).serviceWorker?.()) return undefined;
    return { method: req.method(), url: req.url(), headers: req.headers?.() ?? {}, resourceType: req.resourceType(), navigation: req.isNavigationRequest?.() ?? false };
  } catch {
    return undefined;
  }
}

/** The browser-level session of one browser: answers marked requests and their redirect hops from the copy. */
interface Inner {
  /** A marked request for this address would be answered (the session is on, and pauses it: a document, or a listed address). */
  covers(resourceType: string | undefined, url: string): boolean;
  /** Opens the session, or tells it the addresses to pause now; settles once it is on with them, or cannot be. */
  ensure(): Promise<void>;
  on(): boolean;
  close(): Promise<void>;
}

export function createReplay(opts: ReplayOptions = {}): Replay {
  const snapshot = createSnapshot(opts);
  const mark = token();
  const gateMark = opts.gateMark ? { name: 'x-grnted-replayed', value: token() } : undefined;
  const inners = new Set<Inner>();
  /** Requests answered from the copy at a route, and requests whose redirect chain was sent to the browser-level session. */
  const served = new WeakSet<object>();
  const chained = new WeakSet<object>();
  /** Requests a route let go to the network (counted as sent to it: `ReplayStats.sent`). */
  const passedOn = new WeakSet<object>();
  /** A redirect was recorded: the browser-level sessions are wanted (until then none is opened). */
  let wanted = false;
  /**
   * The addresses on recorded redirect chains of things that are not documents: each chain's own
   * address and where each hop points. Beside every document, these are all the sessions pause.
   */
  const chainUrls = new Set<string>();
  let closed = false;

  /** A redirect from `url` to `location` was recorded (or is about to be replayed): the sessions pause its chain. */
  const sawRedirect = (resourceType: string | undefined, url: string, location: string | undefined): void => {
    let news = !wanted;
    wanted = true;
    if (resourceType !== 'document') {
      for (const u of [url, location]) {
        const at = u === undefined ? undefined : replayUrl(u);
        if (at && !chainUrls.has(at) && chainUrls.size < CHAIN_URLS_MAX) {
          chainUrls.add(at);
          news = true;
        }
      }
    }
    if (news) for (const i of inners) void i.ensure();
  };

  const withGateMark = (hit: ReplayHit, document: boolean): Record<string, string> =>
    gateMark && document ? { ...hit.headers, [gateMark.name]: gateMark.value } : hit.headers;

  const innerOf = (browser: BrowserLike): Inner => {
    let state: 'off' | 'on' | 'lost' | 'none' = browser.newBrowserCDPSession ? 'off' : 'none';
    /** The listed addresses the session pauses now (beside every document). */
    let pausing = new Set<string>();
    let session: CDPSessionLike | undefined;
    let opening: Promise<void> | undefined;
    let released = false;
    /** This scan's paused requests, each with the kind of request its route saw (see `kindOf`). */
    const ours = new Map<string, string | undefined>();
    const remember = (id: string, kind: string | undefined) => {
      ours.set(id, kind);
      if (ours.size > OURS_MAX) ours.delete(ours.keys().next().value!);
    };
    const paused = (cdp: CDPSessionLike, ev: PausedRequest): void => {
      void (async () => {
        const id = { requestId: ev.requestId };
        const send = (method: string, params: Record<string, unknown>) => cdp.send(method, params).catch(() => {});
        try {
          const h = ev.request.headers ?? {};
          const markName = Object.keys(h).find((k) => k.toLowerCase() === REPLAY_MARK);
          const kind = markName === undefined ? undefined : kindOf(h[markName], mark);
          const marked = kind !== undefined;
          const hop = ev.redirectedRequestId !== undefined && ours.has(ev.redirectedRequestId);
          // This scan's: marked by its route, or the next hop of a request that was.
          if (!marked && !hop) return await send('Fetch.continueRequest', id);
          // The kind of request as the route saw it, which the answer was recorded under: this session
          // sees a script's fetch as an XHR.
          const type = (marked ? kind : ours.get(ev.redirectedRequestId!)) || ev.resourceType?.toLowerCase();
          remember(ev.requestId, type);
          const headers = { ...h };
          if (markName !== undefined) delete headers[markName];
          // The mark never goes on to a site.
          const live = () => send('Fetch.continueRequest', markName !== undefined ? { ...id, headers: entries(headers) } : id);
          const req: ReplayRequest = { method: ev.request.method, url: ev.request.url, headers, ...(type ? { resourceType: type } : {}), navigation: type === 'document' };
          const a = closed || state !== 'on' ? { live: true as const } : await snapshot.answer(req);
          if ('live' in a) {
            // An address of a chain the copy does not hold: the site is asked for it (counted here, where it is known).
            snapshot.sent();
            return await live();
          }
          await cdp.send('Fetch.fulfillRequest', {
            ...id, responseCode: a.status, responseHeaders: entries(withGateMark(a, type === 'document')), body: toBase64(a.body),
          }).catch(live);
        } catch {
          // Never left paused.
          await send('Fetch.continueRequest', id);
        }
      })();
    };
    const open = async (): Promise<void> => {
      if (state === 'none' || state === 'lost' || closed) return;
      if (state === 'on' && pausing.size === chainUrls.size) return;
      try {
        if (!session) {
          const asked = browser.newBrowserCDPSession!();
          const s = await bounded(asked.catch(() => undefined), INNER_MS);
          if (!s) {
            // One that answers late is let go (never left open).
            void asked.then((late) => late?.detach?.(), () => {}).catch(() => {});
            state = 'lost';
            return;
          }
          if (closed) {
            void Promise.resolve(s.detach?.()).catch(() => {});
            return;
          }
          session = s;
          s.on('close', () => { if (!released) state = 'lost'; });
          s.on('Fetch.requestPaused', (ev: PausedRequest) => paused(s, ev));
        }
        // Sent again whenever the list grew: the new patterns take the place of the old ones.
        const listed = [...chainUrls];
        const patterns: Pattern[] = [...DOCUMENTS, ...listed.map((url): Pattern => ({ urlPattern: exactly(url), requestStage: 'Request' }))];
        const enabled = await bounded(session.send('Fetch.enable', { patterns }).then(() => true, () => false), INNER_MS);
        if (!enabled) {
          state = 'lost';
          return;
        }
        pausing = new Set(listed);
        if (state === 'off') state = 'on';
      } catch {
        state = 'lost';
      }
    };
    return {
      covers: (type, url) => state === 'on' && (type === 'document' || pausing.has(url)),
      on: () => state === 'on',
      ensure() {
        // One at a time: a longer list waits for the opening before it.
        opening = (opening ?? Promise.resolve()).then(open);
        return opening;
      },
      async close() {
        released = true;
        const s = session;
        session = undefined;
        if (state === 'on') state = 'off';
        // Letting the session go resumes anything it still holds.
        await bounded(Promise.resolve(s?.detach?.()).catch(() => {}), INNER_MS);
      },
    };
  };

  const arm = async (ctx: ContextLike, inner: Inner): Promise<void> => {
    if (!ctx.route || !ctx.on) return;
    /** This context's requests that are recording a resource: ended when it closes. */
    const leases = new Map<object, Lease>();
    /** Redirect targets this context's requests are on their way to: given up when it closes. */
    const hops = new Set<string>();
    /** Answers being read and stored now. */
    const recording = new Set<Promise<void>>();
    /** Pages of this context whose own document last came from the copy (true) or from the site (false). */
    const copied = new WeakMap<object, boolean>();
    /**
     * Requests the browser-level session can pause. It does not see a request that began before it was
     * switched on, nor anything a document asks for whose own load began before that (the browser fixes
     * who sees a document's requests when the document loads): marked, such a request would go on to the
     * site with the mark. So only these are ever marked; every other request for a recorded redirect is
     * the site's to answer. Noted when a request starts, before any route decides on it:
     * - a document (a page's or a frame's own load) that starts while the session is on;
     * - what a frame asks for when its document started that way, and the session pauses the address.
     */
    const covered = new WeakSet<object>();
    /** Frames whose current document began to load while the session was on. */
    const underCover = new WeakMap<object, boolean>();
    ctx.on('request', (req: RequestLike) => {
      try {
        // A request without a frame (a service worker's) throws here, and is never marked.
        const frame = req.frame?.();
        if (!frame) return;
        if (req.isNavigationRequest?.()) {
          const on = inner.on();
          underCover.set(frame, on);
          if (on) covered.add(req);
          return;
        }
        const url = req.url();
        if (underCover.get(frame) === true && inner.covers(req.resourceType(), replayUrl(url) ?? url)) covered.add(req);
      } catch {
        // a request that cannot be read is never marked
      }
    });
    /** Requests such a page sent to the site: the page's address, until the request ends (`Snapshot.leak`). */
    const askedBy = new WeakMap<object, string>();
    /** The page a request belongs to, and whether it is that page's own document. */
    const ownerOf = (req: RequestLike): { page: object; own: boolean } | undefined => {
      try {
        const frame = req.frame?.();
        const page = frame?.page?.();
        if (!frame || !page || typeof page !== 'object') return undefined;
        return { page, own: frame.parentFrame() === null && (req.isNavigationRequest?.() ?? false) };
      } catch {
        return undefined; // a service worker's request has no frame
      }
    };
    /** The address of the page a request belongs to, when that page's own document came from the copy. */
    const copiedPage = (owner: { page: object; own: boolean } | undefined): string | undefined => {
      if (!owner || owner.own || copied.get(owner.page) !== true) return undefined;
      try {
        return (owner.page as PageLike).url?.();
      } catch {
        return undefined;
      }
    };
    const pass = async (route: RouteLike): Promise<void> => {
      const req = route.request();
      const first = !passedOn.has(req);
      passedOn.add(req);
      try {
        if (route.fallback) await route.fallback();
        else await route.continue();
      } catch (e) {
        if (first) passedOn.delete(req);
        throw e;
      }
      if (first) snapshot.sent();
    };
    /**
     * The rest of the count of what went to the network, when a request ends. A request a route let go
     * was counted then: it is taken back when the scan itself stopped it before it left the browser.
     * The later addresses of its redirect never reach a route: each is one more. (A chain sent to the
     * browser-level session is counted there, which knows what it answered.)
     */
    const ended = (req: RequestLike, error?: string): void => {
      try {
        const stopped = error !== undefined && /ERR_BLOCKED_BY_CLIENT/i.test(error);
        let root = req;
        for (let hop = 0; hop <= 12; hop++) {
          const from = root.redirectedFrom?.() ?? null;
          if (!from) break;
          root = from;
        }
        if (!passedOn.has(root)) return;
        if (root === req) {
          if (stopped) snapshot.sent(-1);
        } else if (!stopped) snapshot.sent();
      } catch {
        // a request that cannot be read is not counted
      }
    };
    /** Origins of this context granted Local Network Access (see `Snapshot.local`). */
    const granted = new Set<string>();
    /**
     * Before a document of a site on this machine is answered from the copy: its origin may reach
     * loopback hosts, as the document the site sent could. Bounded; never for any other origin.
     */
    const reach = async (url: string): Promise<void> => {
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        return;
      }
      if (granted.has(origin) || !snapshot.local(origin) || !ctx.grantPermissions) return;
      granted.add(origin);
      await bounded(ctx.grantPermissions(['local-network-access'], { origin }).catch(() => {}), INNER_MS);
    };
    const landed = (req: RequestLike): void => {
      const lease = leases.get(req);
      if (lease) {
        leases.delete(req);
        lease.done();
      }
      try {
        hops.delete(req.url());
      } catch {
        // a request that cannot be read was nobody's hop
      }
    };
    ctx.on('requestfinished', (req: RequestLike) => {
      const work = (async () => {
        try {
          ended(req);
          if (served.has(req)) return;
          const rr = requestOf(req);
          if (!rr || !snapshot.eligible(rr)) return;
          const resp = await (req as { response?: () => Promise<SubresourceResponseLike | null> }).response?.();
          if (!resp || resp.fromServiceWorker?.()) return snapshot.failed(rr);
          const status = resp.status();
          const headers = (await resp.allHeaders?.().catch(() => undefined)) ?? resp.headers();
          const from = rr.resourceType === 'document' ? await resp.serverAddr?.().catch(() => null) : null;
          await snapshot.record(rr, { status, headers, ...(from && isLoopback(from.ipAddress) ? { loopback: true } : {}) }, async () => resp.body?.().catch(() => undefined));
          const after = snapshot.peek(rr);
          // A page loaded from the copy asked the site for this, and the answer is not one that is kept
          // (a refusal, too large): its next load would ask again, so it takes its turn like a live load.
          const asker = askedBy.get(req);
          if (asker !== undefined && !after) snapshot.leak(asker);
          if (after?.location && status >= 300 && status < 400) {
            hops.add(after.location);
            sawRedirect(rr.resourceType, rr.url, after.location);
          }
        } catch {
          // A request that cannot be read is not recorded.
        } finally {
          landed(req);
        }
      })();
      recording.add(work);
      void work.finally(() => recording.delete(work));
    });
    ctx.on('requestfailed', (req: RequestLike) => {
      const rr = requestOf(req);
      if (rr && !served.has(req)) snapshot.failed(rr);
      landed(req);
      let error = '';
      try {
        error = req.failure?.()?.errorText ?? '';
      } catch {
        error = '';
      }
      ended(req, error);
      // A page loaded from the copy sent this to the site and it came to nothing (a stylesheet the site
      // refused fails its load; a cut connection): it is asked for again on the page's next load. Not a
      // request this scan stopped itself before it left the browser.
      const asker = askedBy.get(req);
      if (asker === undefined) return;
      if (!/ERR_BLOCKED_BY_CLIENT/i.test(error)) snapshot.leak(asker);
    });
    /** Nothing this context was recording will come any more: the requests waiting for it go on. */
    const letGo = (): void => {
      for (const lease of leases.values()) lease.done();
      leases.clear();
      for (const url of hops) snapshot.failed({ method: 'GET', url, headers: {} });
      hops.clear();
    };
    // A context that goes without being closed here (its browser closed or was lost under the scan): the
    // same, at once. Without it the requests of other sessions that wait for its recordings would wait out
    // their whole bound (15 s each) for answers that cannot come.
    (ctx.on as unknown as (event: 'close', fn: () => void) => unknown)('close', letGo);
    const close = ctx.close.bind(ctx);
    Object.assign(ctx, {
      async close() {
        // What finished is recorded first (bounded).
        if (recording.size) await bounded(Promise.allSettled([...recording]), CLOSE_WAIT_MS);
        letGo();
        return close();
      },
    });
    await ctx.route('**/*', async (route) => {
      try {
        const req = route.request();
        const rr = closed ? undefined : requestOf(req);
        const owner = rr ? ownerOf(req) : undefined;
        if (!rr || !snapshot.eligible(rr)) {
          if (owner?.own) copied.set(owner.page, false);
          // Never kept (media, anything but GET and HEAD): a page loaded from the copy that sends one asks
          // the site every time. A beacon is not sent at all (the analytics blocking under this aborts it).
          const asker = rr && /^https?:/i.test(rr.url) && !isAnalyticsBeacon(rr.method, rr.url, rr.navigation === true) ? copiedPage(owner) : undefined;
          if (asker !== undefined) snapshot.leak(asker);
          return await pass(route);
        }
        // A recorded redirect: answered, with its hops, by the browser-level session (see the top).
        const chain = async (): Promise<void> => {
          // Each address of the chain may be where the document ends up.
          if (rr.resourceType === 'document') {
            let at: string | undefined = rr.url;
            for (let hop = 0; at && hop < 10; hop++) {
              await reach(at);
              at = snapshot.peek({ ...rr, url: at })?.location;
            }
          }
          sawRedirect(rr.resourceType, rr.url, snapshot.peek(rr)?.location);
          await inner.ensure();
          if (!covered.has(req) || !inner.covers(rr.resourceType, replayUrl(rr.url) ?? rr.url) || !route.fallback) {
            if (owner?.own) copied.set(owner.page, false);
            return pass(route);
          }
          if (owner?.own) copied.set(owner.page, true);
          chained.add(req);
          return route.fallback({ headers: { ...rr.headers, [REPLAY_MARK]: `${mark}:${rr.resourceType ?? ''}` } });
        };
        if (snapshot.peek(rr)?.location) return await chain();
        const a = await snapshot.answer(rr, { lead: true });
        if ('live' in a) {
          if (a.lease) leases.set(req, a.lease);
          if (owner?.own) copied.set(owner.page, false);
          const asker = copiedPage(owner);
          if (asker !== undefined) askedBy.set(req, asker);
          return await pass(route);
        }
        if (a.location) return await chain();
        if (!route.fulfill) {
          if (owner?.own) copied.set(owner.page, false);
          return await pass(route);
        }
        if (rr.resourceType === 'document') await reach(rr.url);
        if (owner?.own) copied.set(owner.page, true);
        served.add(req);
        await route.fulfill({ status: a.status, headers: withGateMark(a, rr.resourceType === 'document'), body: fulfillBody(a.body) });
      } catch {
        // The page or context closed meanwhile, or the answer could not be given: the request goes on.
        await pass(route).catch(() => {});
      }
    });
  };

  return {
    snapshot,
    ...(gateMark ? { gateMark } : {}),
    browser(browser) {
      const inner = innerOf(browser);
      inners.add(inner);
      if (wanted) void inner.ensure();
      return new Proxy(browser, {
        get(target, prop, receiver) {
          if (prop === 'newContext') {
            return async (o: Parameters<BrowserLike['newContext']>[0]) => {
              const ctx = await target.newContext(o);
              try {
                if (!closed) await arm(ctx, inner);
              } catch (err) {
                await ctx.close().catch(() => {});
                throw err;
              }
              return ctx;
            };
          }
          const v = Reflect.get(target, prop, receiver) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    },
    copied(response) {
      try {
        let req = (response as { request?: () => RequestLike | null } | null)?.request?.() ?? null;
        if (req && served.has(req)) return true;
        // The answer at the end of a chain this layer sent to the browser-level session.
        for (let hop = 0; req && hop <= 12; hop++) {
          if (chained.has(req)) return !sentToSite(response);
          req = req.redirectedFrom?.() ?? null;
        }
        return false;
      } catch {
        return false;
      }
    },
    ready(url) {
      // A chain's hops are answered only where every browser of the scan has its session on.
      const chains = inners.size > 0 && [...inners].every((i) => i.on());
      return !closed && snapshot.ready(url, chains);
    },
    stats: () => snapshot.stats(),
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...inners].map((i) => i.close()));
      inners.clear();
      await snapshot.close(opts.keep === true);
    },
  };
}
