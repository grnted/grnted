// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The navigation gate (Plan 2, H0): `ScanOptions.allowUrl` and `allowIp` on every document the browser
// loads, each redirect hop included. A route handler is not enough: the browser follows a server
// redirect by itself and Playwright does not route the next hop, so `https://public.example/go` → 302 →
// `http://169.254.169.254/…` would load; and a name that resolved to a public address for the caller's
// check can resolve to a private one for the browser (DNS rebinding). Engine core: no Node-only imports.
import { cdpSession, GATE_LOST, isBrowserGone } from './reconnect.js';
import { withoutSpeculativeHeaders, type HeaderEntry } from './probes/guard.js';
import type { BrowserLike, CDPSessionLike, ContextLike, PageLike } from './types.js';

/** Hosted use: false for an address the scan must never load (see `ScanOptions.allowUrl`). */
export type AllowUrl = (url: string) => Promise<boolean>;
/** Hosted use: false for a server address the browser must not take a page from (see `ScanOptions.allowIp`). */
export type AllowIp = (ip: string) => boolean;

export interface GateOptions {
  allowIp?: AllowIp;
  /**
   * When the browser-level session that holds new windows cannot be opened (after one more try):
   * 'fail-closed' (default) opens contexts whose pages all fail closed (`NOT_ALLOWED`); 'lost' opens
   * no context and throws `GATE_UNARMED`, an error read as lost work, so a scan with several browser
   * sessions moves the work to another one (`sessionPool`) and never scores without it.
   */
  unarmed?: 'fail-closed' | 'lost';
  /**
   * Record and replay (src/replay): a document answered from the scan's own copy of the site carries
   * this response header. It came from an address that passed these checks when it was recorded and
   * from no server now, so the server address check does not apply to it; the header is taken off
   * before the page gets the response.
   */
  replayed?: { name: string; value: string };
}

/**
 * A browser session whose window hold could not be armed (`GateOptions.unarmed: 'lost'`): nothing can
 * be checked there. Worded as a closed browser (`isBrowserGone`): the work is lost, never a refusal.
 */
export const GATE_UNARMED = 'Target page, context or browser has been closed (its browser session could not be told to hold new windows, so nothing could be checked there)';

/** The error of a session whose window hold could not be armed. */
export function isGateUnarmed(err: unknown): boolean {
  return String((err as Error)?.message ?? err) === GATE_UNARMED;
}

/**
 * 'on': every document request of the page is checked, and no window it opens loads a document
 * (`gatedBrowser`); 'unavailable': a CDP session for that could not be opened; 'lost': a
 * session closed (a lost page session fails every document it still decides; a lost browser session
 * fails every window pause it still decides and closes the gated pages, though a request already
 * sent, or one Chromium resumes on detach, is not taken back). Anything but 'on' means nothing
 * measured on the page stands (`gateFailure`): nothing rechecks addresses after the fact.
 */
export type DocumentGateState = 'on' | 'unavailable' | 'lost';

/** The browser-level session that keeps new windows from loading (`openHold`), shared by a gated browser's contexts. */
export interface WindowHold {
  state: DocumentGateState;
  /** Browser context ids and target ids of the gated pages: any other page in those contexts is a window they opened. */
  contexts: Set<string>;
  pages: Set<string>;
  /** The gated pages themselves: closed when the hold is lost, so none of them opens a window nobody holds. */
  open: Set<PageLike>;
}

interface Gate {
  state: DocumentGateState;
  hold?: WindowHold;
  /** A document (the page or a frame) came from a server address `allowIp` refuses, seen once its headers arrived. */
  refused?: string;
  /** Documents whose server address class Chromium reported as 'Unknown' before they loaded (allowed). */
  unverified: number;
}

const gates = new WeakMap<object, Gate>();
const gatedBrowsers = new WeakSet<object>();

/** A browser `gatedBrowser` made (or one marked gated: a view over gated sessions, `sessionPool`). */
export function isGatedBrowser(browser: BrowserLike): boolean {
  return gatedBrowsers.has(browser);
}

/**
 * Marks a browser whose every context opens in a gated browser (`sessionPool`'s views over the
 * scan's gated sessions): `gatedBrowser` returns it as it is, instead of gating it again on top
 * (a view has no browser-level CDP session of its own, so a second gate would fail every page closed).
 */
export function markGated(browser: BrowserLike): void {
  gatedBrowsers.add(browser);
}

/** The gate on a page `gatedBrowser` (or `gateDocuments`) gated, or undefined for a page without one. */
export function documentGate(page: PageLike): DocumentGateState | undefined {
  const gate = gates.get(page);
  if (!gate) return undefined;
  if (gate.state !== 'on') return gate.state;
  return gate.hold && gate.hold.state !== 'on' ? gate.hold.state : 'on';
}

/**
 * A document of this page (or one of its frames) that came from a server address `allowIp` refuses
 * (the address, then the document's URL), or undefined. Its content may have reached the page before
 * the browser reported the address: whatever was measured on the page does not stand.
 */
export function documentRefused(page: PageLike): string | undefined {
  return gates.get(page)?.refused;
}

/** Plain-language reason for a page `documentRefused` names. */
export const REFUSED_ADDRESS = 'The page came from a server address that is not allowed';
/** Plain-language reason for a page the gate did not let load (or could not check). */
export const NOT_ALLOWED = 'The page\'s address, one of its redirects or the server it came from is not allowed';

/**
 * Why nothing measured on a gated page stands, or undefined when it does (and for a page without a
 * gate): a document came from a refused server address (`REFUSED_ADDRESS`); the gate is not 'on', so
 * its documents or windows were not all checked before they loaded; or the page is no longer an
 * http(s) document (`NOT_ALLOWED`). Callers check it once the page loaded and again before they keep
 * a result, since a session can be lost at any time.
 */
export function gateFailure(page: PageLike): string | undefined {
  const gate = gates.get(page);
  if (!gate) return undefined;
  if (gate.refused) return REFUSED_ADDRESS;
  const state = documentGate(page);
  // A session that closed is lost work (the browser closed, or the page crashed), not a refusal.
  if (state === 'lost') return GATE_LOST;
  if (state !== 'on') return NOT_ALLOWED;
  let url: string | undefined;
  try {
    url = page.url?.();
  } catch {
    return NOT_ALLOWED;
  }
  if (url !== undefined && !/^https?:/i.test(url)) return NOT_ALLOWED;
  return undefined;
}

/**
 * Like `gateFailure` without the page's address: for a page not loaded yet, or whose load failed. A
 * gated page whose gate is not 'on' must not be loaded (nothing would check its documents).
 */
export function gateStopsLoad(page: PageLike): string | undefined {
  const gate = gates.get(page);
  if (!gate) return undefined;
  if (gate.refused) return REFUSED_ADDRESS;
  const state = documentGate(page);
  return state === 'lost' ? GATE_LOST : state !== 'on' ? NOT_ALLOWED : undefined;
}

/**
 * Documents only, at the request stage (allowUrl, before the browser connects) and at the response
 * stage (the server address, before the body reaches the page): the page's own navigations, its
 * frames' (frames from other sites and frames inside them included: Chromium pauses their navigations
 * on the page's session, checked) and every redirect hop, which Chromium pauses as a request of its
 * own. Subresources are not paused, so they are not slowed down.
 */
const DOCUMENT_PATTERNS = [
  { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
  { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' },
];

const LOOPBACK_SAMPLES = ['127.0.0.1', '::1'];
const PRIVATE_SAMPLES = ['10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', 'fc00::1', 'fe80::1'];

/**
 * Chromium reports the class of the address it connected to (`resourceIPAddressSpace`) before the
 * response stage, but the address itself only once the response is handed on. Before the body, a
 * class is refused when `allowIp` refuses an address of it (any of these). Chromium versions name the
 * classes differently (Loopback/Local, or Local/Private, for loopback/private), so Local and Private
 * each stand for both. 'Public' goes on (the exact address is judged later), 'Unknown' is allowed
 * (and counted), no report by the end of the wait is refused, and any other class is refused. A
 * refused class reported after its document went on, and an exact address `allowIp` refuses, make the
 * page not stand (`documentRefused`).
 */
const SPACE_SAMPLES: Record<string, string[]> = {
  Loopback: LOOPBACK_SAMPLES,
  Local: [...LOOPBACK_SAMPLES, ...PRIVATE_SAMPLES],
  Private: [...LOOPBACK_SAMPLES, ...PRIVATE_SAMPLES],
};

/** Longest wait at the response stage for Chromium's report of the server address class. */
const SPACE_WAIT_MS = 100;

interface PausedDocument {
  requestId: string;
  networkId?: string;
  request?: { url?: string };
  responseStatusCode?: number;
  responseStatusText?: string;
  responseErrorReason?: string;
  responseHeaders?: HeaderEntry[];
}

/**
 * Speculation rules and prefetch links are taken out of every document as soon as they are added: a
 * speculation-rule prefetch reaches no interception at all (not the route, not CDP Fetch), so the
 * browser must never act on one. Runs before the page's own scripts in every frame.
 */
export const SPECULATION_BLOCK_SCRIPT = String.raw`(function () {
  try {
    var rel = /(^|\s)(prefetch|prerender)(\s|$)/i;
    var spec = function (n) {
      if (!n || n.nodeType !== 1) return false;
      var t = n.localName;
      if (t === 'script') return String(n.getAttribute('type') || '').trim().toLowerCase() === 'speculationrules';
      return t === 'link' && rel.test(String(n.getAttribute('rel') || ''));
    };
    var sweep = function (n) {
      if (spec(n)) { n.remove(); return; }
      if (n && n.querySelectorAll) { var l = n.querySelectorAll('script[type], link[rel]'); for (var i = 0; i < l.length; i++) if (spec(l[i])) l[i].remove(); }
    };
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'childList') for (var j = 0; j < r.addedNodes.length; j++) sweep(r.addedNodes[j]);
        else if (spec(r.target)) r.target.remove();
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['rel', 'type'] });
  } catch (e) {}
})();`;

/**
 * Documents that are not http(s) load nothing from the network, but one the gate let through would
 * become the page or a frame (a redirect to `data:`): refused, except the initial empty page and a
 * frame's `srcdoc` (the page's own markup, never a redirect target).
 */
const EMPTY_DOCUMENTS = new Set(['about:blank', 'about:srcdoc']);

/** The decision for one document request: `allowUrl` for http(s) (one that throws refuses), `EMPTY_DOCUMENTS` otherwise. */
export async function documentAllowed(url: string, allowUrl: AllowUrl): Promise<boolean> {
  if (!/^https?:/i.test(url)) return EMPTY_DOCUMENTS.has(url);
  try {
    return await allowUrl(url);
  } catch {
    return false;
  }
}

/**
 * Checks every document request of `page` with `documentAllowed` before the browser connects, and
 * fails the ones it refuses. Each decision is made for that one request (nothing is remembered between
 * requests), and once the session is lost nothing more is let through on it. With `allowIp`, the
 * server address is checked too (see `SPACE_SAMPLES` and `documentRefused`). Every document also
 * loses the headers that ask for speculative loads. With `hold`, the page and its context are
 * registered with the browser-level hold (`openHold`), so the windows it opens load nothing. Returns
 * the gate's state.
 */
export async function gateDocuments(context: ContextLike, page: PageLike, allowUrl: AllowUrl, opts: GateOptions & { hold?: WindowHold } = {}): Promise<DocumentGateState> {
  const gate: Gate = { state: 'unavailable', unverified: 0, ...(opts.hold ? { hold: opts.hold } : {}) };
  gates.set(page, gate);
  if (!context.newCDPSession) return gate.state;
  const { allowIp } = opts;
  const refusesSpace = (space: string): boolean => {
    if (!allowIp || space === 'Public') return false;
    const samples = SPACE_SAMPLES[space];
    return samples ? samples.some((ip) => !safeIp(allowIp, ip)) : true;
  };
  try {
    const cdp = await cdpSession(context, page);
    cdp.on('close', () => { gate.state = 'lost'; });
    const send = (method: string, params: Record<string, unknown>) => cdp.send(method, params).catch(() => {});
    const fail = (id: { requestId: string }) => send('Fetch.failRequest', { ...id, errorReason: 'BlockedByClient' });
    /** Server address class by network request id (Network.responseReceivedExtraInfo), until its response stage. */
    const spaces = new Map<string, string>();
    /**
     * Network ids (and URLs) of documents let through at the response stage, until that request's next
     * redirect hop is paused: a class reported for one of them meanwhile came too late to stop the body.
     */
    const continued = new Map<string, string>();
    const spaceWaiters = new Map<string, () => void>();
    const spaceOf = async (id: string | undefined): Promise<string | undefined> => {
      if (!id) return undefined;
      if (!spaces.has(id)) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await new Promise<void>((resolve) => {
          spaceWaiters.set(id, resolve);
          timer = setTimeout(resolve, SPACE_WAIT_MS);
        });
        clearTimeout(timer);
        spaceWaiters.delete(id);
      }
      const s = spaces.get(id);
      spaces.delete(id);
      return s;
    };
    if (allowIp) {
      cdp.on('Network.responseReceivedExtraInfo', (ev: { requestId: string; resourceIPAddressSpace?: string }) => {
        if (!ev.resourceIPAddressSpace) return;
        const late = continued.get(ev.requestId);
        if (late !== undefined) {
          // Its document already went on (and its next hop is not paused yet): judged after the fact.
          if (ev.resourceIPAddressSpace !== 'Unknown' && refusesSpace(ev.resourceIPAddressSpace) && !gate.refused) gate.refused = `${ev.resourceIPAddressSpace} ${late}`.trim();
          return;
        }
        spaces.set(ev.requestId, ev.resourceIPAddressSpace);
        spaceWaiters.get(ev.requestId)?.();
        // Requests that never reach a document response stage: keep the map small.
        if (spaces.size > 500) spaces.delete(spaces.keys().next().value!);
      });
      cdp.on('Network.responseReceived', (ev: { type?: string; response?: { url?: string; remoteIPAddress?: string } }) => {
        const ip = ev.response?.remoteIPAddress;
        if (ev.type !== 'Document' || !ip || gate.refused) return;
        if (!safeIp(allowIp, ip.replace(/^\[|\]$/g, ''))) gate.refused = `${ip} ${ev.response?.url ?? ''}`.trim();
      });
    }
    cdp.on('Fetch.requestPaused', (ev: PausedDocument) => {
      void (async () => {
        const id = { requestId: ev.requestId };
        try {
          if (ev.responseStatusCode !== undefined || ev.responseErrorReason !== undefined) {
            // The response stage: headers are in, the body has not reached the page.
            if (ev.responseErrorReason) return await send('Fetch.continueResponse', id);
            if (gate.state !== 'on') return await fail(id);
            const fromCopy = !!opts.replayed && (ev.responseHeaders ?? []).some((h) => h.name.toLowerCase() === opts.replayed!.name && h.value === opts.replayed!.value);
            if (fromCopy) {
              const rest = (ev.responseHeaders ?? []).filter((h) => h.name.toLowerCase() !== opts.replayed!.name);
              const kept = withoutSpeculativeHeaders(rest) ?? rest;
              return await cdp.send('Fetch.continueResponse', { ...id, responseCode: ev.responseStatusCode!, ...(ev.responseStatusText ? { responsePhrase: ev.responseStatusText } : {}), responseHeaders: kept }).catch(() => fail(id));
            }
            if (allowIp) {
              const space = await spaceOf(ev.networkId);
              // Not reported by the end of the wait: nothing says where the body came from.
              if (space === 'Unknown') gate.unverified++;
              else if (space === undefined || refusesSpace(space)) return await fail(id);
              if (ev.networkId) {
                continued.set(ev.networkId, ev.request?.url ?? '');
                if (continued.size > 500) continued.delete(continued.keys().next().value!);
              }
            }
            const kept = withoutSpeculativeHeaders(ev.responseHeaders ?? []);
            if (!kept || ev.responseStatusCode === undefined) return await send('Fetch.continueResponse', id);
            const changed = { ...id, responseCode: ev.responseStatusCode, ...(ev.responseStatusText ? { responsePhrase: ev.responseStatusText } : {}), responseHeaders: kept };
            return await cdp.send('Fetch.continueResponse', changed).catch(() => send('Fetch.continueResponse', id));
          }
          // A new hop of this request: a class reported from here on is its own, judged at its response stage.
          if (ev.networkId) continued.delete(ev.networkId);
          const ok = await documentAllowed(ev.request?.url ?? '', allowUrl);
          // A session lost while allowUrl decided: nothing is let through (and the page does not stand).
          return await (ok && gate.state === 'on' ? send('Fetch.continueRequest', id) : fail(id));
        } catch {
          // Anything this could not read (a header with no name): failed, never left paused.
          return await fail(id);
        }
      })();
    });
    // Sent together, one round trip on a remote browser: the session runs them in order, and nothing
    // is paused before the page loads. Any that fails leaves the gate unavailable (a page is then not
    // loaded at all, and an interception left on fails every document while the gate is not on).
    const enabled = await Promise.allSettled([
      ...(allowIp ? [cdp.send('Network.enable', {})] : []),
      cdp.send('Fetch.enable', { patterns: DOCUMENT_PATTERNS }),
      ...(opts.hold ? [cdp.send('Target.getTargetInfo', {})] : []),
    ]);
    const refused = enabled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (refused) throw refused.reason;
    if (opts.hold) {
      // The page and its context, so the hold knows the windows they open.
      const info = (enabled[enabled.length - 1] as PromiseFulfilledResult<unknown>).value as { targetInfo?: { targetId?: string; browserContextId?: string } } | undefined;
      const t = info?.targetInfo;
      if (!t?.targetId || !t.browserContextId) throw new Error('The page\'s target is not known.');
      opts.hold.pages.add(t.targetId);
      opts.hold.contexts.add(t.browserContextId);
    }
    gate.state = 'on';
  } catch {
    gate.state = 'unavailable';
  }
  return gate.state;
}

/** `allowIp` that throws refuses. */
function safeIp(allowIp: AllowIp, ip: string): boolean {
  try {
    return allowIp(ip);
  } catch {
    return false;
  }
}

interface TargetInfo { targetId?: string; type?: string; browserContextId?: string; openerId?: string; openerFrameId?: string }

interface OpenHold {
  hold: WindowHold;
  session?: CDPSessionLike;
  /** The browser was gone when the hold was opened (its error): not a hold that cannot arm. */
  gone?: unknown;
  /** Set before the session is let go on purpose (its close is then not a lost hold). */
  released: { yes: boolean };
}

/** Longest wait for a frame id the browser session was not told about to be reported as a target. */
const TARGET_WAIT_MS = 200;

/** Chromium's answer to `Target.getTargetInfo` for an id that is no target (a same-process frame). */
const NO_TARGET = /no target with given id/i;

/**
 * The browser-level hold on new windows. A window is a target of its own, so the page's own Fetch
 * session never sees its navigation, and Chromium's `waitForDebuggerOnStart` does not hold a
 * same-process popup's first navigation (`window.open('/x')` reaches the server while held). So this
 * session pauses every document request in the browser (`Fetch.enable` on the browser target) and
 * knows every page target (`Target.setDiscoverTargets`, reported before its first request). A
 * document of a top-level page in a gated context that is not a gated page itself (a popup, a new
 * tab, a link or form with a target, `noopener` ones too) is failed, and that window closed. A frame
 * id this session was not told about is looked up; one Chromium says is no target is waited for once
 * (`TARGET_WAIT_MS`, a window reported late is still caught) and looked up again, and only one that is
 * still no target goes on, as a same-process frame its page gate decides. A document with no frame id,
 * a lookup that fails any other way, and any pause once the hold is lost are failed. Frames that are
 * targets of their own go on (their page gate decides); a target of another kind in a gated context is
 * failed. When this session is lost, the gated pages are closed: no window they open later is held.
 */
async function openHold(browser: BrowserLike): Promise<OpenHold> {
  const hold: WindowHold = { state: 'unavailable', contexts: new Set(), pages: new Set(), open: new Set() };
  const released = { yes: false };
  if (!browser.newBrowserCDPSession) return { hold, released };
  try {
    const session = await browser.newBrowserCDPSession();
    const send = (method: string, params: Record<string, unknown>) => session.send(method, params).catch(() => {});
    session.on('close', () => {
      if (released.yes) return;
      hold.state = 'lost';
      // Nothing holds their windows any more: the pages go (their results do not stand either way).
      for (const p of hold.open) p.close().catch(() => {});
      hold.open.clear();
    });
    /** Top-level page targets by id, until they are destroyed. */
    const pages = new Map<string, TargetInfo>();
    /** Pauses waiting for a target id to be reported. */
    const waiting = new Map<string, Set<() => void>>();
    const seen = (t: TargetInfo | undefined) => {
      if (!t?.targetId) return;
      if (t.type === 'page') pages.set(t.targetId, t);
      for (const wake of [...(waiting.get(t.targetId) ?? [])]) wake();
    };
    session.on('Target.targetCreated', (ev: { targetInfo?: TargetInfo }) => seen(ev.targetInfo));
    session.on('Target.targetInfoChanged', (ev: { targetInfo?: TargetInfo }) => seen(ev.targetInfo));
    session.on('Target.targetDestroyed', (ev: { targetId?: string }) => { if (ev.targetId) pages.delete(ev.targetId); });
    /** The target a frame id names, 'frame' for an id Chromium says is no target, or undefined when that is not known. */
    const lookUp = async (targetId: string): Promise<TargetInfo | 'frame' | undefined> => {
      try {
        const info = (await session.send('Target.getTargetInfo', { targetId })) as { targetInfo?: TargetInfo } | undefined;
        return info?.targetInfo?.targetId ? info.targetInfo : undefined;
      } catch (err) {
        return err instanceof Error && NO_TARGET.test(err.message) ? 'frame' : undefined;
      }
    };
    /** Resolves once `targetId` is reported, or after `TARGET_WAIT_MS`. */
    const reported = (targetId: string): Promise<void> => new Promise<void>((resolve) => {
      const set = waiting.get(targetId) ?? new Set<() => void>();
      waiting.set(targetId, set);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        if (!set.size) waiting.delete(targetId);
        resolve();
      };
      timer = setTimeout(done, TARGET_WAIT_MS);
      set.add(done);
    });
    /** The target behind a paused document's frame id, 'frame' for a confirmed same-process frame, undefined when unresolved. */
    const targetOf = async (frameId: string): Promise<TargetInfo | 'frame' | undefined> => {
      const known = pages.get(frameId);
      if (known) return known;
      const first = await lookUp(frameId);
      if (first !== 'frame') return first;
      // No target yet: a window can be reported a moment after its first request. Asked once more.
      await reported(frameId);
      return pages.get(frameId) ?? (await lookUp(frameId));
    };
    session.on('Fetch.requestPaused', (ev: { requestId: string; frameId?: string }) => {
      void (async () => {
        const id = { requestId: ev.requestId };
        const fail = () => send('Fetch.failRequest', { ...id, errorReason: 'BlockedByClient' });
        try {
          if (hold.state !== 'on' || !ev.frameId) return await fail();
          const t = await targetOf(ev.frameId);
          // The session lost during the lookup, or a frame id nothing could tie to a target: failed.
          if (hold.state !== 'on' || t === undefined) return await fail();
          if (t === 'frame') return await send('Fetch.continueRequest', id);
          const gated = !!t.browserContextId && hold.contexts.has(t.browserContextId);
          if (t.type === 'page') {
            if (!gated || hold.pages.has(t.targetId!)) return await send('Fetch.continueRequest', id);
          } else if (t.type === 'iframe' || !gated) {
            return await send('Fetch.continueRequest', id);
          }
          await fail();
          if (t.type === 'page') await send('Target.closeTarget', { targetId: t.targetId! });
        } catch {
          return await fail();
        }
      })();
    });
    await session.send('Target.setDiscoverTargets', { discover: true });
    // 'on' before the first pause can arrive: a pause while it is anything else is failed.
    hold.state = 'on';
    await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
    return { hold, session, released };
  } catch (err) {
    hold.state = 'unavailable';
    return { hold, released, ...(isBrowserGone(err) ? { gone: err } : {}) };
  }
}

/**
 * The browser with the navigation gate on every page the engine opens (audit, discovery, probes,
 * evidence pass): each `newPage` is gated before it is returned, so its first navigation is checked
 * too, and every frame of every context gets `SPECULATION_BLOCK_SCRIPT`. A window a page opens by
 * itself (a popup, a new tab) never loads a document (`openHold`) and is closed; one the context
 * still reports is closed as well. Without the browser-level session (a browser with no
 * `newBrowserCDPSession`) the pages' gate is 'unavailable'; when it is lost, the gated pages are
 * closed and their gate is 'lost'. The session is let go when the last
 * context closes. The context and page objects are the browser's own (the request guard tells its
 * page from popups by identity).
 */
export function gatedBrowser(browser: BrowserLike, allowUrl: AllowUrl, opts: GateOptions = {}): BrowserLike {
  // Already gated (scanSite gates its browser, and discovery gates what it is given): once is enough.
  if (gatedBrowsers.has(browser)) return browser;
  let holding: Promise<OpenHold> | undefined;
  /** The hold was found unavailable and opened once more (only once per browser). */
  let rearmed = false;
  let users = 0;
  const release = async () => {
    const h = holding;
    holding = undefined;
    if (!h) return;
    const { session, released } = await h;
    released.yes = true;
    await session?.detach?.().catch(() => {});
  };
  const gated: BrowserLike = {
    async newContext(o) {
      users++;
      let context: ContextLike;
      let hold: WindowHold;
      try {
        holding ??= openHold(browser);
        let was = holding;
        let opened = await was;
        // The browser was gone as the hold opened: lost work (the caller may get a new browser); the
        // next context opens a hold again.
        if (opened.gone !== undefined) {
          if (holding === was) holding = undefined;
          throw opened.gone;
        }
        hold = opened.hold;
        // The hold's session was lost (the browser closed and the host opened a new one,
        // `reconnectingBrowser`): its pages stay failed, and new contexts get a hold of their own.
        // A hold that could not be armed is tried once more (a passing failure of the session).
        if (hold.state === 'lost' || (hold.state === 'unavailable' && !rearmed && browser.newBrowserCDPSession)) {
          if (hold.state === 'unavailable') rearmed = true;
          if (holding === was) holding = openHold(browser);
          was = holding!;
          opened = await was;
          if (opened.gone !== undefined) {
            if (holding === was) holding = undefined;
            throw opened.gone;
          }
          hold = opened.hold;
        }
        if (hold.state === 'unavailable' && opts.unarmed === 'lost') throw new Error(GATE_UNARMED);
        context = await browser.newContext(o);
      } catch (err) {
        if (--users === 0) await release();
        throw err;
      }
      await context.addInitScript?.({ content: SPECULATION_BLOCK_SCRIPT });
      const ours = new WeakSet<object>();
      // This context's pages on the hold's list, taken off it when the context closes.
      const listed = new Set<PageLike>();
      // newPage calls still opening: a page the context reports meanwhile is judged once they are done.
      const opening = new Set<Promise<void>>();
      context.on?.('page', (p: PageLike) => {
        if (ours.has(p)) return;
        void Promise.allSettled([...opening]).then(() => { if (!ours.has(p)) p.close().catch(() => {}); });
      });
      const newPage = context.newPage.bind(context);
      const close = context.close.bind(context);
      let closed = false;
      return Object.assign(context, {
        async newPage() {
          let done!: () => void;
          const marker = new Promise<void>((r) => { done = r; });
          opening.add(marker);
          let p: PageLike;
          try {
            p = await newPage();
            ours.add(p);
          } finally {
            opening.delete(marker);
            done();
          }
          await gateDocuments(context, p, allowUrl, { ...opts, hold });
          // The gate could not start because the page (or its browser) closed meanwhile: that is a
          // closed browser, not a refusal (the caller does the work again in a new context).
          if (gates.get(p)?.state === 'unavailable' && p.isClosed?.()) throw new Error('Target page, context or browser has been closed (while its gate started)');
          if (hold.state === 'on') { hold.open.add(p); listed.add(p); }
          return p;
        },
        async close() {
          try {
            await close();
          } finally {
            for (const p of listed) hold.open.delete(p);
            listed.clear();
            if (!closed) {
              closed = true;
              if (--users === 0) await release();
            }
          }
        },
      });
    },
  };
  gatedBrowsers.add(gated);
  return gated;
}
