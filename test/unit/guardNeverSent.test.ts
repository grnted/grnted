// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Requests that end before the request guard decides them (docs/triage/guard-prefetch-race.md), at the
// guard's seams: Playwright's reports (request, requestfailed, the route callback) and the reports of the
// guard's own CDP session, each fired by the test in the order it chooses. The race a loaded machine
// loses (the browser cancels a prefetch link before its request-stage pause, so Playwright never has a
// route for it) is reproduced here every time, and so is each look-alike that must stay unchecked.
import { describe, expect, it } from 'vitest';
import { REQUEST_REPORT_CAP, installGuard, type SandboxMode } from '../../src/probes/guard.js';
import type { ContextLike, PageLike, RequestLike, RouteLike } from '../../src/types.js';

const PAGE = 'https://e.org/news/1';
const PF = 'https://e.org/pf/next';

type Fn = (x: unknown) => void;

interface Seam {
  /** Playwright's own reports and the route callback. */
  sandbox?: SandboxMode;
  /** The browser can open no CDP session. */
  noCdp?: boolean;
  /** The page's address when the guard is installed (a fresh page shows about:blank). */
  pageUrl?: string;
  /** `context.route` resolves only when the test says so. */
  holdRoute?: boolean;
}

/** A guard on a fake context and CDP session whose reports the test fires itself. */
async function seam(o: Seam = {}) {
  let handler: ((r: RouteLike) => unknown) | undefined;
  const on: Record<string, Fn[]> = {};
  const cdpOn: Record<string, Fn[]> = {};
  const evaluated: string[] = [];
  let release: (() => void) | undefined;
  let called!: () => void;
  const routeCalled = new Promise<void>((r) => { called = r; });
  const cdp = {
    async send(method: string, params: Record<string, unknown> = {}) {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Runtime.evaluate') {
        evaluated.push(String(params.expression));
        return { result: { type: 'number', value: 0 } };
      }
      return {};
    },
    on(event: string, fn: Fn) { (cdpOn[event] ??= []).push(fn); },
  };
  const context = {
    route(_: unknown, h: (r: RouteLike) => unknown) {
      handler = h;
      called();
      return o.holdRoute ? new Promise<void>((r) => { release = r; }) : Promise.resolve();
    },
    on(event: string, fn: Fn) { (on[event] ??= []).push(fn); },
    ...(o.noCdp ? {} : { async newCDPSession() { return cdp; } }),
  } as unknown as ContextLike;
  const mainRef = { url: () => PAGE, parentFrame: () => null };
  const pageRef = { on() {}, url: () => o.pageUrl ?? 'about:blank', mainFrame: () => mainRef } as unknown as PageLike;
  const installed = installGuard(context, pageRef, PAGE, o.sandbox ? { sandbox: o.sandbox } : {});
  // The guard's request reports are listened to before its route is set: a test can report one in between.
  await routeCalled;
  const emit = (event: string, x: unknown) => { for (const fn of on[event] ?? []) fn(x); };
  const cdpEmit = (event: string, x: unknown) => { for (const fn of cdpOn[event] ?? []) fn(x); };
  /** A request as Playwright reports it; `decide()` runs the guard's route callback for it. */
  const request = (url: string, r: { type?: string; purpose?: string | null; failure?: string | null; response?: unknown; redirectedFrom?: RequestLike | null; frame?: 'main' | 'child' | 'popup' } = {}) => {
    const frame = r.frame === 'child' ? { url: () => PAGE, parentFrame: () => mainRef, page: () => pageRef }
      : r.frame === 'popup' ? { url: () => PAGE, parentFrame: () => null, page: () => ({}) }
        : { ...mainRef, page: () => pageRef };
    const req: RequestLike = {
      method: () => 'GET', url: () => url, resourceType: () => r.type ?? 'other', isNavigationRequest: () => false,
      frame: () => frame as unknown as ReturnType<NonNullable<RequestLike['frame']>>, redirectedFrom: () => r.redirectedFrom ?? null,
      headers: (): Record<string, string> => (r.purpose === null ? {} : { 'sec-purpose': r.purpose ?? 'prefetch' }),
      failure: () => (r.failure === null ? null : { errorText: r.failure ?? 'net::ERR_ABORTED' }),
      response: async () => r.response ?? null,
    };
    const calls: string[] = [];
    const route: RouteLike = { request: () => req, async abort(c) { calls.push(`abort:${c ?? ''}`); }, async continue() { calls.push('continue'); } };
    return { r: req, calls, report: () => emit('request', req), fail: () => emit('requestfailed', req), finish: () => emit('requestfinished', req), decide: () => handler!(route) };
  };
  let n = 0;
  /** The same request as the browser reports it on the guard's own CDP session. */
  const browser = (url: string, type = 'Other') => {
    const id = `id${++n}`;
    return {
      sent: (extra: Record<string, unknown> = {}) => cdpEmit('Network.requestWillBeSent', { requestId: id, request: { url, method: 'GET' }, type, ...extra }),
      wire: () => cdpEmit('Network.requestWillBeSentExtraInfo', { requestId: id }),
      responded: () => cdpEmit('Network.responseReceived', { requestId: id, type }),
      finished: () => cdpEmit('Network.loadingFinished', { requestId: id }),
      cancelled: () => cdpEmit('Network.loadingFailed', { requestId: id, type, errorText: 'net::ERR_ABORTED', canceled: true }),
      failed: (p: Record<string, unknown>) => cdpEmit('Network.loadingFailed', { requestId: id, type, ...p }),
    };
  };
  const guard = o.holdRoute ? undefined : (await installed)!;
  return { guard: guard!, installed, release: () => release?.(), request, browser, cdpEmit, evaluated };
}

type Ready = Awaited<ReturnType<typeof seam>>;

/**
 * The race: the browser reports the request on both sessions, then cancels it before its request-stage
 * pause, so Playwright synthesizes the request with no route and reports it failed at once.
 */
function cancelledUnrouted(t: Ready, url = PF, opts: { type?: string; cdpType?: string; purpose?: string | null } = {}) {
  const b = t.browser(url, opts.cdpType ?? 'Other');
  const pw = t.request(url, { type: opts.type ?? 'other', purpose: opts.purpose });
  b.sent();
  pw.report();
  b.cancelled();
  pw.fail();
  return { b, pw };
}

describe('a request that ended before the guard decided it', () => {
  it('a prefetch link the page cancelled before the route saw it (reported, never routed, failed as cancelled; the guard\'s own CDP session saw the same) does not hold up settle, while loading or under a probe, and logs nothing', async () => {
    const t = await seam();
    // While the page loads (the runner's load check asks with no probe).
    cancelledUnrouted(t);
    expect(await t.guard.log.settled!(1000)).toBe(true);
    // Under a probe.
    t.guard.setPhase('between');
    t.guard.setPhase({ probe: 'p' });
    cancelledUnrouted(t, 'https://e.org/pf/other');
    expect(await t.guard.log.settled!(1000, 'p')).toBe(true);
    expect(t.guard.log.events).toEqual([]);
    // The proof makes no call into the page: it rests on the reports alone.
    expect(t.evaluated).toEqual([]);
  });

  it('one of the page\'s own images, stylesheets, scripts or fonts cancelled before the route saw it does not hold it up either', async () => {
    const t = await seam();
    for (const [type, cdpType] of [['image', 'Image'], ['stylesheet', 'Stylesheet'], ['script', 'Script'], ['font', 'Font']] as const) {
      cancelledUnrouted(t, `https://e.org/${type}/a`, { type, cdpType, purpose: null });
    }
    expect(await t.guard.log.settled!(1000)).toBe(true);
  });

  it('the guard\'s own CDP session may report it after Playwright did: settle waits for that (false until it comes, within its time box)', async () => {
    const t = await seam();
    const pw = t.request(PF);
    const b = t.browser(PF);
    pw.report();
    pw.fail();
    expect(await t.guard.log.settled!(60)).toBe(false);
    setTimeout(() => { b.sent(); b.cancelled(); }, 30);
    expect(await t.guard.log.settled!(1000)).toBe(true);
  });

  it('an image the page\'s Content Security Policy refused, or blocked mixed content, never left the browser: it does not hold up settle, with no CDP session too', async () => {
    for (const o of [{}, { noCdp: true }, { sandbox: 'off' as const }]) {
      const t = await seam(o);
      const img = t.request('https://cdn.example/a.png', { type: 'image', purpose: null, failure: 'csp' });
      img.report();
      img.fail();
      const js = t.request('http://cdn.example/a.js', { type: 'script', purpose: null, failure: 'mixed-content' });
      js.report();
      js.fail();
      expect(await t.guard.log.settled!(1000), JSON.stringify(o)).toBe(true);
    }
  });

  it('waiting for proof holds up only the probe the request was made in', async () => {
    const t = await seam();
    t.guard.setPhase({ probe: 'p' });
    const pw = t.request(PF);
    pw.report();
    t.guard.setPhase('between');
    t.guard.setPhase({ probe: 'q' });
    pw.fail();
    expect(await t.guard.log.settled!(60, 'p')).toBe(false);
    expect(await t.guard.log.settled!(60, 'q')).toBe(true);
  });
});

describe('look-alikes that may have reached the network stay unchecked, as before', () => {
  it('the browser\'s own prefetch service (CDP type Prefetch: no route or interception sees it; Playwright calls it other, like a prefetch link) stays unchecked, even ended as cancelled', async () => {
    const t = await seam();
    t.guard.setPhase({ probe: 'p' });
    const pw = t.request(PF);
    pw.report();
    // Its CDP report comes under another probe, so the guard's speculation-rules check charges that one:
    // probe p is unsettled by this judgment alone.
    t.guard.setPhase('between');
    t.guard.setPhase({ probe: 'q' });
    const b = t.browser(PF, 'Prefetch');
    b.sent();
    b.cancelled();
    pw.fail();
    expect(await t.guard.log.settled!(200, 'p')).toBe(false);
    expect(await t.guard.log.settled!(200, 'q')).toBe(false);
  });

  it('a request the network stack sent (requestWillBeSentExtraInfo, before or after its report), or one that got a response, stays unchecked', async () => {
    for (const variant of ['wire', 'wire-first', 'wire-late', 'responded', 'playwright-response'] as const) {
      const t = await seam();
      const b = t.browser(PF);
      const pw = t.request(PF, variant === 'playwright-response' ? { response: { status: () => 200 } } : {});
      if (variant === 'wire-first') b.wire();
      b.sent();
      pw.report();
      if (variant === 'wire') b.wire();
      if (variant === 'responded') b.responded();
      b.cancelled();
      if (variant === 'wire-late') b.wire();
      pw.fail();
      expect(await t.guard.log.settled!(200), variant).toBe(false);
    }
  });

  it('a failure other than the browser\'s cancellation stays unchecked (net::ERR_EMPTY_RESPONSE: the server got it; a cancellation the CDP session does not call one)', async () => {
    const t = await seam();
    const b = t.browser(PF);
    const pw = t.request(PF, { failure: 'net::ERR_EMPTY_RESPONSE' });
    b.sent();
    pw.report();
    b.failed({ errorText: 'net::ERR_EMPTY_RESPONSE', canceled: false });
    pw.fail();
    expect(await t.guard.log.settled!(200)).toBe(false);
    const t2 = await seam();
    const b2 = t2.browser(PF);
    const pw2 = t2.request(PF);
    b2.sent();
    pw2.report();
    b2.failed({ errorText: 'net::ERR_ABORTED', canceled: false });
    pw2.fail();
    expect(await t2.guard.log.settled!(200)).toBe(false);
  });

  it('a kind of request the route may not see, or other than a prefetch link, stays unchecked: fetch, xhr, document, ping, media; other without Sec-Purpose', async () => {
    for (const [type, cdpType, purpose] of [['fetch', 'Fetch', null], ['xhr', 'XHR', null], ['document', 'Document', null], ['ping', 'Ping', null], ['media', 'Media', null], ['other', 'Other', null]] as const) {
      const t = await seam();
      cancelledUnrouted(t, PF, { type, cdpType, purpose });
      expect(await t.guard.log.settled!(200), type).toBe(false);
    }
  });

  it('with no CDP session (sandbox off, or the browser cannot open one), a cancelled request cannot be proven never sent', async () => {
    for (const o of [{ sandbox: 'off' as const }, { noCdp: true }]) {
      const t = await seam(o);
      const pw = t.request(PF);
      pw.report();
      pw.fail();
      expect(await t.guard.log.settled!(200), JSON.stringify(o)).toBe(false);
    }
  });

  it('another report for the same address that went further keeps it unchecked; Playwright reporting more failures for it than the CDP session has seen keeps it waiting', async () => {
    // A request for the address that was sent and then failed (the guard let it through earlier).
    const t = await seam();
    const sent = t.browser(PF, 'Other');
    sent.sent();
    sent.wire();
    sent.failed({ errorText: 'net::ERR_CONNECTION_RESET', canceled: false });
    cancelledUnrouted(t);
    expect(await t.guard.log.settled!(200)).toBe(false);
    // Playwright reported two failures for the address; the CDP session has seen one so far.
    const t2 = await seam();
    const first = t2.request(PF);
    first.report();
    first.fail();
    cancelledUnrouted(t2);
    expect(await t2.guard.log.settled!(100)).toBe(false);
    const late = t2.browser(PF);
    late.sent();
    late.cancelled();
    expect(await t2.guard.log.settled!(1000)).toBe(true);
  });

  it('a request the guard itself refused at the route earlier, for the same address, is no obstacle (the browser reports it blocked by the inspector: never sent)', async () => {
    const t = await seam();
    const b = t.browser(PF);
    const routed = t.request(PF);
    b.sent();
    routed.report();
    await routed.decide();
    expect(routed.calls).toEqual(['abort:blockedbyclient']);
    b.failed({ errorText: 'net::ERR_BLOCKED_BY_CLIENT.Inspector', canceled: false, blockedReason: 'inspector' });
    routed.fail();
    cancelledUnrouted(t);
    expect(await t.guard.log.settled!(1000)).toBe(true);
  });

  it('a redirect hop keeps its own rule (decided by its snapshot): one the guard would stop stays unchecked, cancelled or not', async () => {
    const t = await seam();
    t.guard.setPhase({ probe: 'p' });
    const first = t.request('https://e.org/go', { type: 'image', purpose: null });
    first.report();
    await first.decide();
    const b = t.browser('https://e.org/account/logout.png', 'Image');
    const hop = t.request('https://e.org/account/logout.png', { type: 'image', purpose: null, redirectedFrom: first.r });
    b.sent();
    hop.report();
    b.cancelled();
    hop.fail();
    expect(await t.guard.log.settled!(200, 'p')).toBe(false);
  });

  it('a request in a frame inside the page or in a popup stays unchecked (the guard\'s CDP session sees only the page\'s own frame)', async () => {
    for (const frame of ['child', 'popup'] as const) {
      const t = await seam();
      const b = t.browser(PF);
      const pw = t.request(PF, { frame });
      b.sent();
      pw.report();
      b.cancelled();
      pw.fail();
      expect(await t.guard.log.settled!(200), frame).toBe(false);
    }
  });

  it('a request reported before the route was in place, or on a page that had loaded something before the guard, stays unchecked', async () => {
    const held = await seam({ holdRoute: true });
    const b = held.browser(PF);
    const pw = held.request(PF);
    b.sent();
    pw.report();
    held.release();
    const guard = (await held.installed)!;
    b.cancelled();
    pw.fail();
    expect(await guard.log.settled!(200)).toBe(false);
    const used = await seam({ pageUrl: 'https://e.org/before' });
    cancelledUnrouted(used);
    expect(await used.guard.log.settled!(200)).toBe(false);
  });

  it('the CDP session closing, or its record overflowing, loses the proof: a judgment waiting for it becomes unchecked', async () => {
    const t = await seam();
    const pw = t.request(PF);
    pw.report();
    pw.fail();
    t.cdpEmit('close', {});
    const b = t.browser(PF);
    b.sent();
    b.cancelled();
    expect(await t.guard.log.settled!(200)).toBe(false);
    const full = await seam();
    for (let i = 0; i <= REQUEST_REPORT_CAP; i++) full.cdpEmit('Network.requestWillBeSent', { requestId: `x${i}`, request: { url: `https://e.org/x/${i}` }, type: 'Image' });
    cancelledUnrouted(full);
    expect(await full.guard.log.settled!(200)).toBe(false);
  });

  it('a request that finished before the guard decided it stays unchecked (it got a response), as before', async () => {
    const t = await seam();
    const pw = t.request(PF);
    pw.report();
    pw.finish();
    expect(await t.guard.log.settled!(200)).toBe(false);
  });
});

/** Lets every pending promise of the guard (its response checks) settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('acceptance stays revocable; lost evidence and unfamiliar reports fail closed (review round 1)', () => {
  it('a wire report for the accepted request that comes after Playwright\'s failure, before the first settle, makes it unchecked', async () => {
    const t = await seam();
    const { b } = cancelledUnrouted(t);
    await flush();
    b.wire();
    expect(await t.guard.log.settled!(200)).toBe(false);
  });

  it('one that comes after a settle that said yes makes every later settle say no; so does a response or a completion', async () => {
    for (const late of ['wire', 'responded', 'finished'] as const) {
      const t = await seam();
      t.guard.setPhase({ probe: 'p' });
      const { b } = cancelledUnrouted(t);
      expect(await t.guard.log.settled!(1000, 'p'), late).toBe(true);
      b[late]();
      expect(await t.guard.log.settled!(200, 'p'), late).toBe(false);
    }
  });

  it('a report of the browser\'s own prefetch for the address that comes after acceptance (the ordering broken) revokes it too', async () => {
    const t = await seam();
    t.guard.setPhase({ probe: 'p' });
    cancelledUnrouted(t);
    expect(await t.guard.log.settled!(1000, 'p')).toBe(true);
    t.guard.setPhase('between');
    t.guard.setPhase({ probe: 'q' });
    t.browser(PF, 'Prefetch').sent();
    expect(await t.guard.log.settled!(200, 'p')).toBe(false);
  });

  it('a wire report that came early for a request, then 5,000 more, still taints that request when it is reported (overflow fails closed)', async () => {
    const t = await seam();
    const a = t.browser(PF);
    a.wire();
    for (let i = 0; i < REQUEST_REPORT_CAP; i++) t.cdpEmit('Network.requestWillBeSentExtraInfo', { requestId: `early-${i}` });
    const pw = t.request(PF);
    a.sent();
    pw.report();
    a.cancelled();
    pw.fail();
    expect(await t.guard.log.settled!(200)).toBe(false);
  });

  it('a cancelled record, then 5,000 more cancelled records, then its late wire report: still taints (overflow fails closed)', async () => {
    const t = await seam();
    const a = t.browser(PF);
    a.sent();
    a.cancelled();
    for (let i = 0; i < REQUEST_REPORT_CAP; i++) {
      t.cdpEmit('Network.requestWillBeSent', { requestId: `other-${i}`, request: { url: 'https://e.org/pf/many' }, type: 'Other' });
      t.cdpEmit('Network.loadingFailed', { requestId: `other-${i}`, type: 'Other', errorText: 'net::ERR_ABORTED', canceled: true });
    }
    a.wire();
    const pw = t.request(PF);
    pw.report();
    pw.fail();
    expect(await t.guard.log.settled!(200)).toBe(false);
  });

  it('a clean cancellation while another record for the address is still in flight with a wire report is not accepted, and its later completion keeps it unchecked', async () => {
    const t = await seam();
    const live = t.browser(PF);
    live.sent();
    live.wire();
    cancelledUnrouted(t);
    expect(await t.guard.log.settled!(200)).toBe(false);
    live.finished();
    expect(await t.guard.log.settled!(200)).toBe(false);
  });

  it('an unfamiliar report for a known request makes its own address unprovable, not every address: a frame document that failed and then finished (Chromium 149, the gold site\'s map frame)', async () => {
    const t = await seam();
    const frameDoc = t.browser('https://map.example/map', 'Document');
    frameDoc.sent();
    frameDoc.failed({ errorText: 'net::ERR_FAILED', canceled: false });
    frameDoc.finished();
    cancelledUnrouted(t);
    expect(await t.guard.log.settled!(1000)).toBe(true);
    // The same sequence on the address of a cancelled prefetch makes that one unchecked.
    const t2 = await seam();
    const { b } = cancelledUnrouted(t2);
    b.finished();
    expect(await t2.guard.log.settled!(200)).toBe(false);
  });

  it('unfamiliar reports reach unchecked: an end for a request never reported, a second report for a live request, a report after a request ended, more CDP records than Playwright requests', async () => {
    const cases: Record<string, (t: Ready) => void> = {
      'end for an unknown request': (t) => { cancelledUnrouted(t); t.cdpEmit('Network.loadingFinished', { requestId: 'never-seen' }); },
      'second report, no redirect': (t) => { const b = t.browser(PF); const pw = t.request(PF); b.sent(); b.sent(); pw.report(); b.cancelled(); pw.fail(); },
      'response after the end': (t) => { const { b } = cancelledUnrouted(t); b.responded(); },
      'two CDP records, one Playwright request': (t) => { const x = t.browser(PF); x.sent(); x.cancelled(); cancelledUnrouted(t); },
    };
    for (const [name, run] of Object.entries(cases)) {
      const t = await seam();
      run(t);
      expect(await t.guard.log.settled!(200), name).toBe(false);
    }
  });
});

describe('acceptance holds only while the agreement does (review round 2)', () => {
  it('another CDP request for the address left in flight after acceptance unsettles the probe, before the first settle and after one that said yes; cancelling it with no Playwright report keeps it unsettled (the counts disagree)', async () => {
    for (const settledFirst of [false, true]) {
      const t = await seam();
      t.guard.setPhase({ probe: 'p' });
      cancelledUnrouted(t);
      await flush();
      if (settledFirst) expect(await t.guard.log.settled!(1000, 'p'), 'accepted').toBe(true);
      const second = t.browser(PF);
      second.sent();
      expect(await t.guard.log.settled!(50, 'p'), `in flight (settled first: ${settledFirst})`).toBe(false);
      second.cancelled();
      expect(await t.guard.log.settled!(50, 'p'), `two CDP cancellations, one Playwright request (settled first: ${settledFirst})`).toBe(false);
    }
  });
});
