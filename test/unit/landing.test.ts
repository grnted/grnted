// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// src/landing.ts on a fake page: the reviewer's event-level inputs (Sol r1 9, 10; r2 2, 6, 7, 8, 9; r3 1, 5,
// 6, 7) with short windows. The real-browser cases are in test/integration/selfNavigating.test.ts.
import { describe, expect, it } from 'vitest';
import { auditPage } from '../../src/audit.js';
import { fakeProbeBrowser } from '../helpers/probes.js';
import { BOT_CHECK, CANCELLED, TIME_LEFT, runProbes } from '../../src/probes/runner.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike, RouteLike } from '../../src/types.js';
import { BOT_CHALLENGE, CHALLENGE_PAGE } from '../../src/challenge.js';
import {
  KEEPS_NAVIGATING, LANDING_CANCELLED, LANDING_OUT_OF_TIME, LANDING_UNCHECKED, MAX_EXTRA_DOCUMENTS, NOT_HTML, OTHER_SITE, bindLanding, isOtherSite,
  landingFailure, markedStill, settleLanding, watchLanding, type DocumentFacts,
} from '../../src/landing.js';
import type { PageLike } from '../../src/types.js';

const response = (url: string, status = 200, headers: Record<string, string> = { 'content-type': 'text/html' }) => ({ url: () => url, status: () => status, headers: () => headers });

/** A page whose main-frame events the test sends; evaluate answers for the current document. */
function fakePage(opts: { markMs?: number } = {}) {
  const handlers = new Map<string, ((x: unknown) => void)[]>();
  const main = { url: () => doc.url, parentFrame: () => null };
  let n = 0;
  const doc = { url: 'https://example.org/a', navUrl: 'https://example.org/a', status: 200, origin: 1000, marks: new Map<string, unknown>(), ready: 'complete' };
  const emit = (ev: string, x: unknown) => { for (const h of handlers.get(ev) ?? []) h(x); };
  const request = (url: string) => ({ url: () => url, isNavigationRequest: () => true, frame: () => main, method: () => 'GET', resourceType: () => 'document' });
  const page = {
    on(ev: string, fn: (x: unknown) => void) { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); },
    mainFrame: () => main,
    isClosed: () => false,
    url: () => doc.url,
    async evaluate(fn: (a: unknown) => unknown, arg: unknown) {
      if (fn.name === 'timeOrigin') return doc.origin;
      if (fn.name === 'pageFacts') {
        if (opts.markMs) await new Promise((r) => setTimeout(r, opts.markMs));
        const a = arg as { name: string; token: string } | undefined;
        if (a) doc.marks.set(a.name, a.token);
        const facts: DocumentFacts = { href: doc.url, navUrl: doc.navUrl, status: doc.status, contentType: 'text/html', marked: !!a };
        return facts;
      }
      if (fn.name === 'readMark') return doc.marks.get(arg as string);
      return doc.ready;
    },
  } as unknown as PageLike;
  return {
    page,
    /** A navigation of the main frame: requested, answered, committed (a new document). */
    navigate(url: string, opts: { status?: number; headers?: Record<string, string>; commit?: boolean } = {}) {
      const r = request(url);
      emit('request', r);
      if (opts.commit === false) {
        emit('requestfailed', r);
        return;
      }
      emit('response', { ...response(url, opts.status, opts.headers), request: () => r });
      doc.url = url;
      doc.navUrl = url;
      doc.status = opts.status ?? 200;
      doc.origin = 1000 + ++n;
      doc.marks = new Map();
      emit('framenavigated', main);
    },
    /** An HTTP redirect has no document to commit. */
    redirectResponse(url: string, to: string) {
      const r = request(url);
      emit('request', r);
      emit('response', { ...response(url, 302, { location: to }), request: () => r });
      emit('requestfinished', r);
    },
    /** A navigation requested and still in flight (its answer not yet come). */
    request(url: string) {
      const r = request(url);
      emit('request', r);
      return r;
    },
    /** The answer to a request in flight comes, and its document commits. */
    answer(r: ReturnType<typeof request>, status: number) {
      emit('response', { ...response(r.url(), status), request: () => r });
      doc.url = r.url();
      doc.navUrl = r.url();
      doc.status = status;
      doc.origin = 1000 + ++n;
      doc.marks = new Map();
      emit('framenavigated', main);
    },
    /** Sol r3 5: a replacement whose request and answer arrive but whose commit event is missed. */
    missedCommit(url: string, status: number, headers?: Record<string, string>) {
      const r = request(url);
      emit('request', r);
      emit('response', { ...response(url, status, headers), request: () => r });
      doc.url = url;
      doc.navUrl = url;
      doc.status = status;
      doc.origin = 1000 + ++n;
      doc.marks = new Map();
    },
    /** A commit no response came before: same document (pushState) unless `newDocument`. */
    commitUnseen(url: string, newDocument: boolean) {
      doc.url = url;
      if (newDocument) {
        doc.navUrl = url;
        doc.origin = 1000 + ++n;
        doc.marks = new Map();
      }
      emit('framenavigated', main);
    },
  };
}

const quick = { quietMs: 40, maxMs: 1500 };
const noSettle = async () => {};

describe('landingFailure: the checks on the answer of the document measured', () => {
  it('a WAF challenge whatever its status, an HTTP error, a 202, a file; a page passes', () => {
    expect(landingFailure(response('u', 200, { 'cf-mitigated': 'challenge', 'content-type': 'text/html' }))).toEqual({ reason: BOT_CHALLENGE, status: 200, kind: 'challenge' });
    expect(landingFailure(response('u', 403, { 'x-amzn-waf-action': 'captcha' }))).toEqual({ reason: BOT_CHALLENGE, status: 403, kind: 'challenge' });
    expect(landingFailure(response('u', 404))).toEqual({ reason: 'HTTP 404', status: 404, kind: 'http' });
    expect(landingFailure(response('u', 202))).toEqual({ reason: CHALLENGE_PAGE, status: 202, kind: 'challenge' });
    expect(landingFailure(response('u', 200, { 'Content-Type': 'text/plain' }))).toEqual({ reason: NOT_HTML, status: 200, kind: 'not-html' });
    expect(landingFailure(response('u', 200, {}))).toBeUndefined();
    expect(landingFailure(response('u', 200))).toBeUndefined();
  });
});

describe('settleLanding on page events', () => {
  const start = () => {
    const f = fakePage();
    const w = watchLanding(f.page)!;
    w.begin();
    f.navigate('https://example.org/a');
    return { f, w };
  };

  it('a page that does not move: landed at once on its own answer, marked', async () => {
    const { f, w } = start();
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    const l = await settleLanding(f.page, w, { ...quick, settle: noSettle });
    expect('mark' in l && l.response?.url()).toBe('https://example.org/a');
    expect(Date.now() - t0).toBeLessThan(200);
    expect(await markedStill(f.page, w, 'mark' in l ? l.mark : undefined)).toBe(true);
  });

  it('a navigation in flight holds the landing until it commits (Sol r1 3); its answer is the one checked (Sol r1 5)', async () => {
    const { f, w } = start();
    const r = f.request('https://example.org/gone');
    setTimeout(() => f.answer(r, 404), 200);
    const t0 = Date.now();
    const l = await settleLanding(f.page, w, { ...quick, settle: noSettle });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    expect('mark' in l && l.response?.status()).toBe(404);
  });

  it('Sol r1 9 / r2 6: documents are counted from commits only: cancelled requests are free; the 6th extra commit stops it', async () => {
    const { f, w } = start();
    for (let i = 0; i < 10; i++) f.navigate(`https://example.org/stop-${i}`, { commit: false });
    expect(w.commits).toBe(1);
    const settled = settleLanding(f.page, w, { ...quick, settle: noSettle });
    for (let i = 1; i <= MAX_EXTRA_DOCUMENTS + 1; i++) f.navigate(`https://example.org/n${i}`);
    expect(await settled).toEqual({ stop: KEEPS_NAVIGATING });
  });

  it('…and a settle still running when the budget runs out is cut short (no more documents are waited for)', async () => {
    const { f, w } = start();
    const t0 = Date.now();
    const settled = settleLanding(f.page, w, { ...quick, settle: () => new Promise((r) => setTimeout(r, 1000)) });
    setTimeout(() => { for (let i = 1; i <= MAX_EXTRA_DOCUMENTS + 1; i++) f.navigate(`https://example.org/n${i}`); }, 20);
    expect(await settled).toEqual({ stop: KEEPS_NAVIGATING });
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('pushState and fragments (commits with no answer, same time origin) are not documents', async () => {
    const { f, w } = start();
    f.commitUnseen('https://example.org/a?tab=2', false);
    f.commitUnseen('https://example.org/a?tab=2#x', false);
    const l = await settleLanding(f.page, w, { ...quick, settle: noSettle });
    expect('mark' in l && l.response?.url()).toBe('https://example.org/a');
    expect(w.commits).toBe(1);
  });

  it('Sol r2 7: a new document with no answer the watch saw (a cache restore, an error page): settled promptly, its answer unknown (null)', async () => {
    const { f, w } = start();
    setTimeout(() => f.commitUnseen('https://example.org/back', true), 30);
    const t0 = Date.now();
    const l = await settleLanding(f.page, w, { ...quick, settle: () => new Promise((r) => setTimeout(r, 60)) });
    expect('mark' in l ? l.response : l).toBeNull();
    expect(Date.now() - t0).toBeLessThan(800);
  });

  it('Sol r1 10: a navigation that never answers: stopped at the cap, whatever the settles cost', async () => {
    const { f, w } = start();
    f.request('https://example.org/hang');
    const t0 = Date.now();
    expect(await settleLanding(f.page, w, { ...quick, maxMs: 400, settle: () => new Promise((r) => setTimeout(r, 100)) })).toEqual({ stop: KEEPS_NAVIGATING });
    expect(Date.now() - t0).toBeLessThan(700);
  });

  it('Sol r2 9: …at the scan\'s deadline when that comes sooner', async () => {
    const { f, w } = start();
    f.request('https://example.org/hang');
    const t0 = Date.now();
    expect(await settleLanding(f.page, w, { ...quick, scanDeadline: Date.now() + 200, settle: noSettle })).toEqual({ stop: LANDING_OUT_OF_TIME });
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('Sol r2 8: …and at once when the scan is cancelled', async () => {
    const { f, w } = start();
    f.request('https://example.org/hang');
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const t0 = Date.now();
    expect(await settleLanding(f.page, w, { ...quick, signal: stop.signal, settle: noSettle })).toEqual({ stop: LANDING_CANCELLED });
    expect(Date.now() - t0).toBeLessThan(300);
  });

  it('a settle that fails because the page navigated is part of loading; any other failure is thrown', async () => {
    const { f, w } = start();
    let first = true;
    const settle = async () => {
      if (!first) return;
      first = false;
      f.navigate('https://example.org/landed');
      throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
    };
    const l = await settleLanding(f.page, w, { ...quick, settle });
    expect('mark' in l && l.response?.url()).toBe('https://example.org/landed');
    await expect(settleLanding(f.page, w, { ...quick, settle: async () => { throw new Error('Target crashed'); } })).rejects.toThrow('Target crashed');
  });
});

describe('markedStill: the document measured is still the one marked (Sol r2 1, 2)', () => {
  it('a commit after marking, a navigation in flight, or a new document the events never showed: not the same', async () => {
    const f = fakePage();
    const w = watchLanding(f.page)!;
    w.begin();
    f.navigate('https://example.org/a');
    const land = async () => {
      const l = await settleLanding(f.page, w, { quietMs: 20, maxMs: 1000, settle: noSettle });
      if (!('mark' in l)) throw new Error('no landing');
      return l.mark;
    };
    let mark = await land();
    f.navigate('https://example.org/b');
    expect(await markedStill(f.page, w, mark)).toBe(false);
    mark = await land();
    f.request('https://example.org/c');
    expect(await markedStill(f.page, w, mark)).toBe(false);
    // Without any events (a watch that saw nothing): the mark alone tells.
    const g = fakePage();
    const l = await settleLanding(g.page, undefined, { settle: noSettle });
    const m = 'mark' in l ? l.mark : undefined;
    expect(await markedStill(g.page, undefined, m)).toBe(true);
    g.commitUnseen('https://example.org/elsewhere', true);
    expect(await markedStill(g.page, undefined, m)).toBe(false);
  });
});

describe('round 4 (Sol r3): what the tests get, and the document the answer belongs to', () => {
  it('Sol r3 4: another host is another site', () => {
    expect(isOtherSite('https://site.test/', 'https://external.test/login')).toBe(true);
    expect(isOtherSite('https://www.city.gov/', 'https://city.gov/home')).toBe(false);
    expect(isOtherSite('http://localhost:8080/', 'http://www.localhost:8080/')).toBe(false);
    expect(isOtherSite('https://www.ci.salem.or.us/', 'https://salem.or.us/x')).toBe(true);
  });

  it('Sol r3 5: the answer is bound to the marked document by its navigation entry (address, status), and an HTML type', () => {
    const facts = (f: Partial<DocumentFacts>): DocumentFacts => ({ href: 'https://e.org/a', navUrl: 'https://e.org/a', status: 200, contentType: 'text/html', marked: true, ...f });
    expect(bindLanding(response('https://e.org/a'), facts({ href: 'https://e.org/a?tab=2#x' }))).toBeUndefined();
    expect(bindLanding(response('https://e.org/a'), facts({ navUrl: 'https://e.org/missing', status: 404 }))).toBe(LANDING_UNCHECKED);
    expect(bindLanding(response('https://e.org/a'), facts({ status: 404 }))).toBe(LANDING_UNCHECKED);
    expect(bindLanding(response('https://e.org/a'), facts({ navUrl: undefined }))).toBe(LANDING_UNCHECKED);
    expect(bindLanding(response('https://e.org/a'), facts({ contentType: 'text/plain' }))).toBe(NOT_HTML);
    expect(bindLanding(response('https://e.org/a'), facts({ status: undefined }))).toBeUndefined();
  });

  it('Sol r3 5: a missed replacement commit makes binding unknown', async () => {
    const f = fakePage();
    const w = watchLanding(f.page)!;
    w.begin();
    f.navigate('https://example.org/a');
    f.missedCommit('https://example.org/missing', 404);
    expect(await settleLanding(f.page, w, { ...quick, settle: noSettle })).toEqual({ stop: LANDING_UNCHECKED });
  });

});

describe('round 4 (Sol r3 7): one deadline and one cancellation, the success decided after both', () => {
  const start = (markMs?: number) => {
    const f = fakePage(markMs ? { markMs } : {});
    const w = watchLanding(f.page)!;
    w.begin();
    f.navigate('https://example.org/a');
    return { f, w };
  };

  it('the scan\'s deadline 20 ms away, the first settle 160 ms: out of time at the deadline, not a landing at 160 ms', async () => {
    const { f, w } = start();
    const t0 = Date.now();
    const l = await settleLanding(f.page, w, { ...quick, scanDeadline: Date.now() + 20, settle: () => new Promise((r) => setTimeout(r, 160)) });
    expect(l).toEqual({ stop: LANDING_OUT_OF_TIME });
    expect(Date.now() - t0).toBeLessThan(120);
  });

  it('the cap 80 ms, the mark\'s answer 100 ms: no landing', async () => {
    const { f, w } = start(100);
    const l = await settleLanding(f.page, w, { quietMs: 0, maxMs: 80, settle: noSettle });
    expect('stop' in l).toBe(true);
  });

  it('cancelled while the mark is being set: cancelled, not a landing', async () => {
    const { f, w } = start(100);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 30);
    const l = await settleLanding(f.page, w, { quietMs: 0, maxMs: 1000, signal: stop.signal, settle: noSettle });
    expect(l).toEqual({ stop: LANDING_CANCELLED });
  });
});


describe('round 5: host boundary, unambiguous binding, shared deadline and cancellation', () => {
  it('Sol r4 3: another host is another site, ignoring only a leading www.', () => {
    for (const [a, b] of [
      ['https://a.onrender.com/', 'https://b.onrender.com/login'],
      ['https://a.b.ck/', 'https://c.b.ck/'],
      ['https://city.gov/', 'https://portal.city.gov/'],
      ['https://www.ci.salem.or.us/', 'https://salem.or.us/'],
    ]) expect(isOtherSite(a!, b!)).toBe(true);
    expect(isOtherSite('https://www.city.gov/', 'https://city.gov/home')).toBe(false);
  });

  it('an HTTP redirect is not a document response; its final HTML response binds to the single commit', async () => {
    const f = fakePage();
    const w = watchLanding(f.page)!;
    w.begin();
    f.redirectResponse('https://example.org/start', 'https://example.org/a');
    f.navigate('https://example.org/a');
    const l = await settleLanding(f.page, w, { ...quick, settle: noSettle });
    expect('mark' in l && l.response?.url()).toBe('https://example.org/a');
    expect(w.commits).toBe(1);
  });

  it('Sol r4 4: same-URL 200 then challenge 200 with a missed commit is ambiguous', async () => {
    const f = fakePage();
    const w = watchLanding(f.page)!;
    w.begin();
    f.navigate('https://example.org/a');
    f.missedCommit('https://example.org/a', 200, { 'cf-mitigated': 'challenge' });
    const l = await settleLanding(f.page, w, { ...quick, settle: noSettle });
    expect(l).toEqual({ stop: LANDING_UNCHECKED });
  });

  it.each(['deadline', 'cancel'] as const)('Sol r4 7: a hung final markedStill ends at the shared %s', async (mode) => {
    const f = fakePage();
    const l = await settleLanding(f.page, undefined, { settle: noSettle });
    if (!('mark' in l)) throw new Error('no landing');
    const original = f.page.evaluate;
    f.page.evaluate = ((fn: { name: string }, arg: unknown) => fn.name === 'readMark' ? new Promise(() => {}) : original(fn as never, arg)) as PageLike['evaluate'];
    const stop = new AbortController();
    const t0 = Date.now();
    if (mode === 'cancel') setTimeout(() => stop.abort(), 10);
    const r = await Promise.race([markedStill(f.page, undefined, l.mark, Date.now() + (mode === 'deadline' ? 20 : 1000), stop.signal), new Promise((r) => setTimeout(() => r('still pending'), 150))]);
    expect(r).toBe(false);
    expect(Date.now() - t0).toBeLessThan(130);
  });

  it.each(['deadline', 'cancel'] as const)('Sol r4 7: audit goto never answers, shared %s stops it', async (mode) => {
    const b = fakeProbeBrowser({ delayFor: () => 1000 });
    const stop = new AbortController();
    const t0 = Date.now();
    if (mode === 'cancel') setTimeout(() => stop.abort(), 10);
    const r = await Promise.race([
      auditPage(b.browser, 'https://e.org/', { userAgent: 'test', axeSource: '', deadline: Date.now() + (mode === 'deadline' ? 20 : 1000), signal: stop.signal }),
      new Promise((r) => setTimeout(() => r('still pending'), 150)),
    ]);
    expect(r).toMatchObject({ status: 'failed', reason: mode === 'cancel' ? LANDING_CANCELLED : LANDING_OUT_OF_TIME });
    expect(Date.now() - t0).toBeLessThan(130);
  });

  it('Sol r4 7: caller cancellation cuts a hung probe settle', async () => {
    const fake = fakeProbeBrowser();
    let settling!: () => void;
    const inSettle = new Promise<void>((r) => { settling = r; });
    const browser = {
      async newContext(o: Parameters<BrowserLike['newContext']>[0]) {
        const c = await fake.browser.newContext(o);
        const newPage = c.newPage.bind(c);
        c.newPage = async () => {
          const p = await newPage();
          p.waitForTimeout = () => { settling(); return new Promise(() => {}); };
          return p;
        };
        return c;
      },
    } as BrowserLike;
    const stop = new AbortController();
    const running = runProbes(browser, [{ url: 'https://e.org/', index: 0 }], [{ id: 'never', tier: 'core', kind: 'interaction', criteria: ['0.0.1'], timeoutMs: 1000, async run() { throw new Error('must not run'); } }], { userAgent: 'test', signal: stop.signal });
    await inSettle;
    stop.abort();
    const r = await Promise.race([running, new Promise((r) => setTimeout(() => r('still pending'), 150))]);
    expect(Array.isArray(r)).toBe(true);
  });
});

/** Actual guard and runner, with main-frame events and a POST delivered during a chosen page call. */
function reviewedSession(opts: { landing?: string; botAt?: string; botAfterMs?: number; challengeAt?: string } = {}) {
  const fake = fakeProbeBrowser();
  let identities = 0;
  let loads = 0;
  let blocked = 0;
  const browser: BrowserLike = {
    async newContext(o) {
      const c = await fake.browser.newContext(o);
      let route!: (r: RouteLike) => unknown;
      let botTimer: ReturnType<typeof setTimeout> | undefined;
      const close = c.close.bind(c);
      c.close = async () => { clearTimeout(botTimer); await close(); };
      c.route = async (_pattern, handler) => { route = handler; };
      const newPage = c.newPage.bind(c);
      c.newPage = async () => {
        const p = await newPage();
        const f = fakePage();
        const evaluate = p.evaluate.bind(p);
        // Goto models the server redirect's final response/commit; only the POST uses routing.
        p.on = ((event: string, handler: (x: unknown) => void) => {
          if (event !== 'request') f.page.on!(event as never, handler as never);
        }) as PageLike['on'];
        p.mainFrame = f.page.mainFrame;
        p.url = f.page.url;
        const verify = async () => {
          const request = { method: () => 'POST', url: () => new URL('/_sec/verify', p.url!()).href, resourceType: () => 'xhr', isNavigationRequest: () => false, frame: () => p.mainFrame!() };
          await route({ request: () => request, abort: async () => { blocked++; }, continue: async () => { throw new Error('POST must be blocked'); } } as RouteLike);
        };
        if (opts.botAfterMs !== undefined) p.waitForTimeout = (ms) => new Promise((r) => setTimeout(r, ms));
        p.goto = async (u) => {
          loads++;
          f.navigate(opts.landing ?? u);
          if (opts.botAfterMs !== undefined) botTimer = setTimeout(() => { void verify(); }, opts.botAfterMs);
          return response(opts.landing ?? u);
        };
        p.evaluate = (async (fn: { name: string }, arg: unknown) => {
          const call = fn.name === 'documentId' ? `identity-${++identities}` : fn.name;
          if (call === opts.botAt) await verify();
          if (call === opts.challengeAt) f.missedCommit(p.url!(), 200, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
          if (fn.name === 'documentId') return `document-${loads}`;
          if (['pageFacts', 'readMark', 'timeOrigin'].includes(fn.name)) return f.page.evaluate(fn as never, arg);
          if (fn.name === 'sinceLastShift') return 1e9;
          return evaluate(fn as never, arg);
        }) as PageLike['evaluate'];
        return p;
      };
      return c;
    },
  };
  return { browser, get blocked() { return blocked; }, get loads() { return loads; } };
}

describe('final narrow round (Sol r5)', () => {
  const target = { url: 'https://requested.test/', index: 0 };
  const failure: PageProbe = {
    id: 'failure', tier: 'core', kind: 'interaction', criteria: ['0.0.1'], timeoutMs: 1000,
    async run() { return [{ criterion: '0.0.1', status: 'failed', detail: 'wrong document' }]; },
  };

  it.each(['identity-2', 'identity-3', 'identity-4', 'identity-5', 'sinceLastShift', 'pageFacts'])('Sol r5 2: recorded bot evidence during %s stops the group', async (botAt) => {
    const fake = reviewedSession({ botAt });
    let entered = 0;
    const probe: PageProbe = {
      ...failure,
      ...(botAt === 'identity-5' ? { waitFor: { content: true } } : botAt === 'sinceLastShift' ? { waitFor: { layout: true } } : {}),
      async run(ctx) {
        entered++;
        if (botAt === 'pageFacts') {
          await ctx.page.goto(target.url, { waitUntil: 'load' });
          // Even a probe that catches the reload failure cannot keep its findings.
          await ctx.reloadedPage?.().catch(() => {});
        }
        return failure.run(ctx);
      },
    };
    const next: PageProbe = { ...failure, id: 'next', ...(probe.waitFor ? { waitFor: probe.waitFor } : {}), async run(ctx) { entered++; return failure.run(ctx); } };
    const runs = await runProbes(fake.browser, [target], [probe, next], { userAgent: 'test', settleMs: 0 });
    expect(fake.blocked).toBe(1);
    expect(entered).toBe(botAt === 'pageFacts' ? 1 : 0);
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(run.findings).toEqual([expect.objectContaining({ status: 'not_testable', loadFailure: 'challenge', detail: expect.stringContaining(BOT_CHECK) })]);
  });

  it.each([
    ['https://requested.test/', 'https://other.test/login'],
    ['https://a.onrender.com/', 'https://b.onrender.com/login'],
    ['https://a.b.ck/', 'https://c.b.ck/'],
    ['https://city.gov/', 'https://portal.city.gov/'],
    ['https://www.city.gov/', 'https://city.gov/home'],
  ])('Sol r5 3: test load from %s to %s uses the audit host boundary', async (url, landing) => {
    const fake = reviewedSession({ landing });
    const [run] = await runProbes(fake.browser, [{ url, index: 0 }], [failure], { userAgent: 'test', settleMs: 0 });
    expect(run!.findings[0]!.status).toBe(landing === 'https://city.gov/home' ? 'failed' : 'not_testable');
    if (landing !== 'https://city.gov/home') expect(run!.findings[0]!.detail).toContain(OTHER_SITE.toLowerCase());
  });

  it('Sol r5 3: a foreign owned reload invalidates its findings', async () => {
    const fake = reviewedSession();
    const [run] = await runProbes(fake.browser, [target], [{ ...failure, async run(ctx) {
      await ctx.page.goto('https://other.test/login', { waitUntil: 'load' });
      await ctx.reloadedPage?.().catch(() => {});
      return failure.run(ctx);
    } }], { userAgent: 'test', settleMs: 0 });
    expect(run!.findings).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining(OTHER_SITE.toLowerCase()) })]);
  });

  it.each(['foreign', 'bot'] as const)('a late pass owned reload still applies the %s check and preserves its first pass', async (mode) => {
    const fake = reviewedSession(mode === 'bot' ? { botAt: 'lateReload' } : {});
    const reasons: string[] = [];
    const first = [{ criterion: '0.0.1', status: 'no_failures_found' as const, detail: 'first pass document' }];
    const [run] = await runProbes(fake.browser, [target], [{
      ...failure, async run() { return first; },
      late: { timeoutMs: 1000, async run(ctx) {
        await ctx.page.goto(mode === 'foreign' ? 'https://other.test/login' : ctx.url, { waitUntil: 'load' });
        await ctx.page.evaluate(function lateReload() {}, undefined);
        await ctx.reloadedPage?.().catch((error: unknown) => { if (error instanceof Error) reasons.push(error.message); });
        return failure.run(ctx);
      } },
    }], { userAgent: 'test', settleMs: 0 });
    if (mode === 'bot') expect(fake.blocked).toBe(1);
    expect(reasons).toEqual([expect.stringContaining(mode === 'bot' ? BOT_CHECK : OTHER_SITE.toLowerCase())]);
    expect(run!.findings).toEqual(first);
  });

  it.each(['deadline', 'cancel', 'probe timeout'] as const)('Sol r5 4: a hung probe ends on the shared %s', async (mode) => {
    const fake = fakeProbeBrowser();
    const stop = new AbortController();
    let started = 0;
    const [run] = await runProbes(fake.browser, [target], [{ ...failure, timeoutMs: mode === 'probe timeout' ? 20 : 180, async run() {
      started = Date.now();
      if (mode === 'cancel') setTimeout(() => stop.abort(), 10);
      return new Promise(() => {});
    } }], { userAgent: 'test', settleMs: 0, deadline: Date.now() + (mode === 'deadline' ? 20 : 1000), signal: stop.signal });
    expect(started).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(130);
    expect(run!.findings[0]!.detail).toBe(mode === 'deadline' ? TIME_LEFT : mode === 'cancel' ? CANCELLED : 'timed out after 20 ms');
  });

  it.each(['context', 'axe'] as const)('Sol r5 4: hung audit %s ends at the deadline or cancellation', async (step) => {
    for (const mode of ['deadline', 'cancel'] as const) {
      const stop = new AbortController();
      let entered = false;
      const fake = fakeProbeBrowser({ evaluate: (name) => {
        if (name !== 'runAxeInPage') return undefined;
        entered = true;
        if (mode === 'cancel') setTimeout(() => stop.abort(), 10);
        return new Promise(() => {});
      } });
      const browser: BrowserLike = { async newContext(o) {
        if (step === 'context') {
          entered = true;
          if (mode === 'cancel') setTimeout(() => stop.abort(), 10);
          return new Promise(() => {});
        }
        const c = await fake.browser.newContext(o);
        const newPage = c.newPage.bind(c);
        c.newPage = async () => {
          const p = await newPage();
          // This fake reports identity through evaluate, without navigation events.
          p.on = undefined;
          return p;
        };
        return c;
      } };
      const result = await Promise.race([
        auditPage(browser, target.url, { userAgent: 'test', axeSource: '', deadline: Date.now() + (mode === 'deadline' ? 20 : 1000), signal: stop.signal }),
        new Promise((r) => setTimeout(() => r('still pending'), 130)),
      ]);
      expect(entered).toBe(true);
      expect(result).toMatchObject({ status: 'failed', reason: mode === 'deadline' ? LANDING_OUT_OF_TIME : LANDING_CANCELLED });
    }
  });

  it('Sol r5 5: a commit during marking settles the replacement before accepting it', async () => {
    const f = fakePage();
    const w = watchLanding(f.page)!;
    w.begin();
    f.navigate('https://example.org/');
    const evaluate = f.page.evaluate.bind(f.page);
    let marking = 0;
    let settles = 0;
    f.page.evaluate = (async (fn: { name: string }, arg: unknown) => {
      if (fn.name === 'pageFacts' && ++marking === 1) f.navigate('https://example.org/home');
      return evaluate(fn as never, arg);
    }) as PageLike['evaluate'];
    const landed = await settleLanding(f.page, w, { quietMs: 0, maxMs: 1000, settle: async () => { settles++; } });
    expect(settles).toBe(2);
    expect('mark' in landed && landed.mark.commits).toBe(w.commits);
    expect('mark' in landed && landed.response?.url()).toBe('https://example.org/home');
    expect(await markedStill(f.page, w, 'mark' in landed ? landed.mark : undefined)).toBe(true);
  });
});

describe('round 7 final rulings (Sol r6)', () => {
  const target = { url: 'https://requested.test/', index: 0 };
  const failure: PageProbe = {
    id: 'failure', tier: 'core', kind: 'interaction', criteria: ['0.0.1'], timeoutMs: 1000,
    async run() { return [{ criterion: '0.0.1', status: 'failed', detail: 'wrong document' }]; },
  };

  it.each(['probe', 'final identity'] as const)('Sol r6 1: a stable 200 interstitial verifies during the %s; no failure survives', async (during) => {
    const fake = reviewedSession(during === 'probe' ? { botAfterMs: 1100 } : { botAt: 'identity-5' });
    let entered = 0;
    const probe: PageProbe = { ...failure, async run(ctx) {
      entered++;
      expect(fake.blocked).toBe(0);
      if (during === 'probe') await new Promise((r) => setTimeout(r, 200));
      return failure.run(ctx);
    } };
    const next: PageProbe = { ...failure, id: 'next', async run(ctx) { entered++; return failure.run(ctx); } };
    const runs = await runProbes(fake.browser, [target], [probe, next], { userAgent: 'test' });
    expect(fake.blocked).toBe(1);
    expect(entered).toBe(1);
    expect(fake.loads).toBe(1);
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(run.findings).toEqual([expect.objectContaining({ status: 'not_testable', loadFailure: 'challenge', detail: expect.stringContaining(BOT_CHECK) })]);
  });

  it.each(['probeChallenge', 'identity-5'])('Sol r6 1: a challenge response during %s voids the probe before a commit is reported', async (challengeAt) => {
    const fake = reviewedSession({ challengeAt });
    let entered = 0;
    const probe: PageProbe = { ...failure, async run(ctx) {
      entered++;
      await ctx.page.evaluate(function probeChallenge() {}, undefined);
      return failure.run(ctx);
    } };
    const next: PageProbe = { ...failure, id: 'next', async run(ctx) { entered++; return failure.run(ctx); } };
    const runs = await runProbes(fake.browser, [target], [probe, next], { userAgent: 'test', settleMs: 0 });
    expect(entered).toBe(1);
    expect(fake.loads).toBe(1);
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(run.findings).toEqual([expect.objectContaining({ status: 'not_testable', loadFailure: 'challenge', detail: expect.stringContaining(BOT_CHECK) })]);
  });

  it.each(['newPage', 'settleAnimationsInPage', 'collectLinks', 'stillMounting'])('Sol r6 2: hung audit %s takes the shared deadline and cancellation', async (step) => {
    for (const mode of ['deadline', 'cancel'] as const) {
      const stop = new AbortController();
      let entered = false;
      const hang = () => {
        entered = true;
        if (mode === 'cancel') setTimeout(() => stop.abort(), 10);
        return new Promise<never>(() => {});
      };
      const fake = fakeProbeBrowser({ evaluate: (name) => name === step ? hang() : undefined });
      const browser: BrowserLike = { async newContext(o) {
        const c = await fake.browser.newContext(o);
        const newPage = c.newPage.bind(c);
        c.newPage = async () => {
          if (step === 'newPage') return hang();
          const p = await newPage();
          p.on = undefined;
          return p;
        };
        return c;
      } };
      const started = Date.now();
      const result = await Promise.race([
        auditPage(browser, target.url, { userAgent: 'test', axeSource: '', deadline: started + (mode === 'deadline' ? 30 : 1000), signal: stop.signal }),
        new Promise((r) => setTimeout(() => r('still pending'), 140)),
      ]);
      expect(entered).toBe(true);
      expect(result).toMatchObject({ status: 'failed', reason: mode === 'deadline' ? LANDING_OUT_OF_TIME : LANDING_CANCELLED });
      expect(Date.now() - started).toBeLessThan(130);
      expect(fake.open).toBe(0);
    }
  });

  it.each(['content', 'layout'] as const)('Sol r6 2: a hung probe %s wait takes the shared deadline and cancellation', async (wait) => {
    for (const mode of ['deadline', 'cancel'] as const) {
      const stop = new AbortController();
      let waiting = false;
      let entered = false;
      const fake = fakeProbeBrowser({ evaluate: (name) => {
        if (name !== (wait === 'content' ? 'stillMounting' : 'sinceLastShift')) return undefined;
        waiting = true;
        if (mode === 'cancel') setTimeout(() => stop.abort(), 10);
        return new Promise(() => {});
      } });
      const started = Date.now();
      const result = await Promise.race([
        runProbes(fake.browser, [target], [{ ...failure, waitFor: { [wait]: true }, async run(ctx) { entered = true; return failure.run(ctx); } }], {
          userAgent: 'test', settleMs: 0, deadline: started + (mode === 'deadline' ? 20 : 1000), signal: stop.signal,
        }),
        new Promise((r) => setTimeout(() => r('still pending'), 140)),
      ]);
      expect(waiting).toBe(true);
      expect(entered).toBe(false);
      expect(Array.isArray(result)).toBe(true);
      expect((result as Awaited<ReturnType<typeof runProbes>>)[0]!.findings).toEqual([expect.objectContaining({ status: 'not_testable', detail: mode === 'deadline' ? TIME_LEFT : CANCELLED })]);
      expect(Date.now() - started).toBeLessThan(130);
      expect(fake.open).toBe(0);
    }
  });

  it.each(['mount-settle', 'mount-rerun'] as const)('the audit %s takes the shared deadline and cancellation', async (step) => {
    for (const mode of ['deadline', 'cancel'] as const) {
      let waiting = false;
      const stop = new AbortController();
      const fake = fakeProbeBrowser();
      const browser: BrowserLike = { async newContext(o) {
        const c = await fake.browser.newContext(o);
        const newPage = c.newPage.bind(c);
        c.newPage = async () => {
          const p = await newPage();
          p.on = undefined;
          let looks = 0, axes = 0;
          const evaluate = p.evaluate.bind(p);
          p.evaluate = ((fn: { name: string }, arg: unknown) => {
            if (fn.name === 'stillMounting') return Promise.resolve(step === 'mount-settle' || ++looks === 1);
            if (fn.name === 'runAxeInPage' && (step === 'mount-settle' || ++axes === 2)) {
              waiting = true;
              if (mode === 'cancel') setTimeout(() => stop.abort(), 10);
              if (step === 'mount-rerun') return new Promise(() => {});
            }
            return evaluate(fn as never, arg);
          }) as PageLike['evaluate'];
          return p;
        };
        return c;
      } };
      const started = Date.now();
      const budget = step === 'mount-settle' ? 40 : 1000;
      const result = await Promise.race([
        auditPage(browser, target.url, { userAgent: 'test', axeSource: '', deadline: started + (mode === 'deadline' ? budget : 5000), signal: stop.signal }),
        new Promise((r) => setTimeout(() => r('still pending'), budget + 200)),
      ]);
      expect(waiting).toBe(true);
      expect(result).toMatchObject({ status: 'failed', reason: mode === 'deadline' ? LANDING_OUT_OF_TIME : LANDING_CANCELLED });
      expect(Date.now() - started).toBeLessThan(budget + 150);
      expect(fake.open).toBe(0);
    }
  });
});
