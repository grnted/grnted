// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it, vi } from 'vitest';
import { CANCELLED, DOCUMENT_CHANGED, TIME_LEFT, MAX_PROBE_SLOTS, NO_GUARD, NO_SANDBOX, PROBE_DATA_MAX_CHARS, PROBE_DEFAULTS, UNSANDBOXED, createProbeRunner, groupProbes, runProbes } from '../../src/probes/runner.js';
import { probeCriteriaResults } from '../../src/probes/criteria.js';
import type { BrowserLike, ProbeFinding, RequestLike, RouteLike } from '../../src/types.js';
import { ProbeNotTestable, type PageProbe } from '../../src/probes/types.js';
import { fakeProbeBrowser } from '../helpers/probes.js';

const OPTS = { userAgent: 'test-agent' };
const page = (index: number, path = `/p${index}`) => ({ url: `https://e.org${path}`, index });

function probe(id: string, run: PageProbe['run'], extra: Partial<PageProbe> = {}): PageProbe {
  return { id, criteria: ['2.1.1'], kind: 'interaction', tier: 'core', timeoutMs: 1000, run, ...extra };
}
const ok = (id: string, extra: Partial<PageProbe> = {}) =>
  probe(id, async (ctx) => [{ criterion: '2.1.1', status: 'no_failures_found', detail: `${id} on ${ctx.url}` }], extra);

describe('probe runner', () => {
  it('a browser that cannot open a CDP session: the popup sandbox is off and each run says so; with popupSandbox "always" no probe runs', async () => {
    const auto = await runProbes(fakeProbeBrowser({ noCdp: true }).browser, [page(0)], [ok('a')], OPTS);
    // Its clean result does not stand: nothing structural kept windows from opening.
    expect(auto.map((r) => [r.probe, r.status, r.popupSandbox, r.findings])).toEqual([['a', 'ok', 'unavailable', [{ criterion: '2.1.1', status: 'not_testable', detail: UNSANDBOXED }]]]);
    expect(probeCriteriaResults(auto)[0]!.method.status).toBe('not_testable');
    const always = await runProbes(fakeProbeBrowser({ noCdp: true }).browser, [page(0)], [ok('a')], { ...OPTS, popupSandbox: 'always' });
    expect(always.map((r) => [r.probe, r.status, r.findings])).toEqual([['a', 'error', [{ criterion: '2.1.1', status: 'not_testable', detail: NO_SANDBOX, loadFailure: 'not-loaded' }]]]);
    expect(always[0]!.popupSandbox).toBeUndefined();
  });

  /** The fake browser with a CDP session per context; `lose()` closes the newest one (as when the browser drops it). */
  function withCdp(): { browser: BrowserLike; lose(): void } {
    const fake = fakeProbeBrowser({ noCdp: true });
    const closers: (() => void)[] = [];
    const browser = {
      async newContext(o: unknown) {
        const c = await (fake.browser.newContext as unknown as (o: unknown) => Promise<Record<string, unknown>>)(o);
        return Object.assign(c, {
          async newCDPSession() {
            return {
              async send(method: string) { return method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main' } } } : {}; },
              on(event: string, fn: () => void) { if (event === 'close') closers.push(fn); },
            };
          },
        });
      },
    } as unknown as BrowserLike;
    return { browser, lose: () => closers.at(-1)?.() };
  }

  it('a CDP session lost while a probe runs: its clean result does not stand, and the next probe gets a fresh context', async () => {
    const b = withCdp();
    const losing = probe('losing', async () => { b.lose(); return [{ criterion: '2.1.1', status: 'no_failures_found', detail: 'clean' }]; });
    const runs = await runProbes(b.browser, [page(0)], [losing, ok('next')], OPTS);
    expect(runs.map((r) => [r.probe, r.findings[0]!.status, r.findings[0]!.detail])).toEqual([
      ['losing', 'not_testable', UNSANDBOXED],
      ['next', 'no_failures_found', 'next on https://e.org/p0'],
    ]);
  });

  it('a page that did not answer for a test (no response) is loaded again once; still nothing: not testable, with the reason', async () => {
    const once = fakeProbeBrowser({ noResponse: (path, n) => path === '/p0' && n === 1 });
    const runs = await runProbes(once.browser, [page(0)], [ok('a'), ok('b')], OPTS);
    expect(runs.map((r) => [r.probe, r.status, r.findings[0]!.status])).toEqual([['a', 'ok', 'no_failures_found'], ['b', 'ok', 'no_failures_found']]);
    const never = fakeProbeBrowser({ noResponse: (path) => path === '/p0' });
    const lost = await runProbes(never.browser, [page(0)], [ok('a')], OPTS);
    expect(lost.map((r) => [r.probe, r.status, r.findings])).toEqual([['a', 'error', [{ criterion: '2.1.1', status: 'not_testable', detail: 'the page did not load for this test: no response from the server', loadFailure: 'not-loaded' }]]]);
  });

  it('gives not_testable "timed out" for a probe over its time box, and a fresh page for the next probe', async () => {
    const fake = fakeProbeBrowser();
    const contexts: number[] = [];
    const hang = probe('hang', (ctx) => { contexts.push(fake.contextOf(ctx.page)); return new Promise(() => {}); }, { timeoutMs: 50, criteria: ['2.1.1', '2.1.2'] });
    const after = probe('after', async (ctx) => { contexts.push(fake.contextOf(ctx.page)); return []; });
    const runs = await runProbes(fake.browser, [page(0)], [hang, after], OPTS);
    expect(runs.map((r) => [r.probe, r.status])).toEqual([['hang', 'timeout'], ['after', 'ok']]);
    expect(runs[0]!.findings).toEqual([
      { criterion: '2.1.1', status: 'not_testable', detail: 'timed out after 50 ms' },
      { criterion: '2.1.2', status: 'not_testable', detail: 'timed out after 50 ms' },
    ]);
    expect(runs[0]!.ms).toBeGreaterThanOrEqual(45);
    // The timed-out probe's context was closed; the next probe got a new one.
    expect(contexts[0]).not.toBe(contexts[1]);
    expect(fake.contexts).toBe(2);
    expect(fake.open).toBe(0);
  });

  it('fix round 1, F5: a criterion a probe judges only through its own measurement (measuredOnly) is left out of a run that timed out, threw or could not start, so the keyboard test\'s result for it stands', async () => {
    const fake = fakeProbeBrowser();
    const gestures = (id: string, run: PageProbe['run'], extra: Partial<PageProbe> = {}) => probe(id, run, { criteria: ['2.5.7', '2.1.1'], measuredOnly: ['2.1.1'], ...extra });
    const keyboard = ok('kb');
    const hang = gestures('hang', () => new Promise(() => {}), { timeoutMs: 50 });
    const boom = gestures('boom', async () => { throw new Error('the kit is gone'); });
    const cannot = gestures('cannot', async () => { throw new ProbeNotTestable('the page was still loading when the test would have typed'); });
    const fine = gestures('fine', async () => [{ criterion: '2.5.7', status: 'not_applicable', detail: 'nothing to drag' }, { criterion: '2.1.1', status: 'not_applicable', detail: 'no list was measured reordering by dragging' }]);
    const runs = await runProbes(fake.browser, [page(0)], [keyboard, hang, boom, cannot, fine], OPTS);
    const of = (id: string) => runs.find((r) => r.probe === id)!;
    for (const id of ['hang', 'boom', 'cannot']) {
      expect([id, of(id).criteria, of(id).findings.map((f) => [f.criterion, f.status])]).toEqual([id, ['2.5.7'], [['2.5.7', 'not_testable']]]);
    }
    // A run that measured keeps its rule's own verdict.
    expect(of('fine').criteria).toEqual(['2.5.7', '2.1.1']);
    // The roll-up (what the report reads): 2.1.1 is the keyboard test's alone, and stays "no failures found".
    const rows = probeCriteriaResults(runs).filter((x) => x.criterion === '2.1.1');
    expect(rows.map((x) => [x.method.id, x.method.status])).toEqual([['kb', 'no_failures_found'], ['fine', 'not_applicable']]);
    // Before fix round 1 the timed-out run's "not testable" sank it: the worst over the methods.
    expect(rows.every((x) => x.method.status !== 'not_testable')).toBe(true);
  });

  it('gives not_testable "the test could not run" for a probe that throws; ProbeNotTestable gives its reason', async () => {
    const fake = fakeProbeBrowser();
    const boom = probe('boom', async () => { throw new Error('Cannot read properties of null\n    at stack'); });
    const cannot = probe('cannot', async () => { throw new ProbeNotTestable('the page has no form to test'); });
    const runs = await runProbes(fake.browser, [page(0)], [boom, cannot, ok('fine')], OPTS);
    expect(runs.map((r) => [r.probe, r.status, r.findings])).toEqual([
      ['boom', 'error', [{ criterion: '2.1.1', status: 'not_testable', detail: 'the test could not run: Cannot read properties of null' }]],
      ['cannot', 'ok', [{ criterion: '2.1.1', status: 'not_testable', detail: 'the page has no form to test' }]],
      ['fine', 'ok', [{ criterion: '2.1.1', status: 'no_failures_found', detail: 'fine on https://e.org/p0' }]],
    ]);
    // A thrown error does not cost a reload: all three shared one context.
    expect(fake.contexts).toBe(1);
  });

  it('attaches a JSON copy of the probe\'s evidence (setData) and tells onRun; too large, timed out or failed runs carry none', async () => {
    const fake = fakeProbeBrowser();
    const live = { n: 1 };
    const withData = probe('data', async (ctx) => { ctx.setData?.(live); live.n = 2; return []; });
    const big = probe('big', async (ctx) => { ctx.setData?.('x'.repeat(PROBE_DATA_MAX_CHARS + 1)); return []; });
    const notTestable = probe('nt', async (ctx) => { ctx.setData?.({ forms: [] }); throw new ProbeNotTestable('no form'); });
    const hangs = probe('hangs', (ctx) => { ctx.setData?.({ n: 3 }); return new Promise(() => {}); }, { timeoutMs: 30 });
    const fails = probe('fails', async (ctx) => { ctx.setData?.({ n: 4 }); throw new Error('boom'); });
    const heard: string[] = [];
    const runs = await runProbes(fake.browser, [page(0)], [withData, big, notTestable, hangs, fails], { ...OPTS, onRun: (r) => heard.push(r.probe) });
    expect(runs.map((r) => [r.probe, r.data])).toEqual([['data', { n: 2 }], ['big', undefined], ['nt', { forms: [] }], ['hangs', undefined], ['fails', undefined]]);
    expect(heard.sort()).toEqual(['big', 'data', 'fails', 'hangs', 'nt']);
  });

  it('never reuses a page after a probe that typed (sendsNothing): the next probe gets a fresh context', async () => {
    const fake = fakeProbeBrowser();
    const contexts: number[] = [];
    const typed = probe('typed', async (ctx) => { contexts.push(fake.contextOf(ctx.page)); return []; }, { sendsNothing: true });
    const next = probe('next', async (ctx) => { contexts.push(fake.contextOf(ctx.page)); return []; });
    const plain = probe('plain', async (ctx) => { contexts.push(fake.contextOf(ctx.page)); return []; });
    await runProbes(fake.browser, [page(0)], [plain, typed, next], OPTS);
    expect(contexts[0]).toBe(contexts[1]);
    expect(contexts[2]).not.toBe(contexts[1]);
    expect(fake.open).toBe(0);
  });

  it.each(['finishes', 'hung'])('rechecks quiet after identity when a split redirect hop %s: no typed cookie is sent', async (mode) => {
    vi.useFakeTimers();
    try {
      const events: Record<string, ((r: RequestLike) => void)[]> = {};
      const emit = (event: string, r: RequestLike) => events[event]?.forEach((fn) => fn(r));
      const request = (url: string, from: RequestLike | null = null): RequestLike => ({ method: () => 'GET', url: () => url, resourceType: () => 'fetch', redirectedFrom: () => from });
      const first = request('https://e.org/config');
      const hop = request('https://e.org/config-pending', first);
      let route!: (r: RouteLike) => unknown;
      let typingStarted = false, typingIdentities = 0, activeHop = false, typed = false, typedWithActiveHop = false, cookie = '';
      const sentCookies: string[] = [];
      const fake = fakeProbeBrowser({ evaluate(name) {
        // The typing probe's second identity read follows drain, regardless of load validation reads.
        if (name === 'documentId' && typingStarted && ++typingIdentities === 2) {
          activeHop = true;
          emit('request', hop);
          if (mode === 'finishes') setTimeout(() => {
            // The pending hop redirects again without a route callback; Chromium attaches cookies.
            sentCookies.push(cookie);
            activeHop = false;
            emit('requestfinished', hop);
          }, 100);
        }
        return undefined;
      } });
      const browser = { async newContext(o: Parameters<BrowserLike['newContext']>[0]) {
        const c = await fake.browser.newContext(o);
        c.on = ((event: string, fn: (r: RequestLike) => void) => { (events[event] ??= []).push(fn); }) as typeof c.on;
        c.route = async (_, handler) => { route = handler; };
        return c;
      } } as BrowserLike;
      const pending = probe('pending', async () => {
        emit('request', first);
        await route({ request: () => first, async abort() {}, async continue() {} });
        return [];
      });
      const typing = probe('typing', async () => {
        typed = true;
        typedWithActiveHop = activeHop;
        cookie = 'scanner-value';
        await new Promise((resolve) => setTimeout(resolve, 200));
        return [];
      }, { sendsNothing: true });
      const running = runProbes(browser, [page(0)], [pending, typing], { ...OPTS, onStart(run) {
        if (run.probe === 'typing') { typingStarted = true; emit('requestfinished', first); }
      } });
      await vi.advanceTimersByTimeAsync(5000);
      const run = (await running).find((r) => r.probe === 'typing')!;
      expect(typedWithActiveHop).toBe(false);
      expect(sentCookies).not.toContain('scanner-value');
      expect(typed).toBe(mode === 'finishes');
      if (mode === 'hung') expect(run.findings).toEqual([{ criterion: '2.1.1', status: 'not_testable', detail: 'the page was still loading when the test would have typed' }]);
      else expect(sentCookies).toEqual(['']);
    } finally { vi.useRealTimers(); }
  });

  it.each(['returned', 'kept-returned', 'kept-timeout', 'boxed-kept-timeout'])('a replacement document voids every finding, including %s failures', async (mode) => {
    vi.useFakeTimers();
    try {
      let doc = 'original';
      const fake = fakeProbeBrowser({ evaluate: (name) => name === 'documentId' ? doc : undefined });
      const failure: ProbeFinding = { criterion: '2.1.1', status: 'failed', detail: 'measured on replacement' };
      const changed = probe('changed', async (ctx) => {
        doc = 'replacement';
        if (mode !== 'returned') ctx.keep!([failure]);
        if (mode.endsWith('timeout')) return new Promise(() => {});
        return [failure];
      }, { ...(mode.startsWith('boxed') ? { freshAfterFiredTimers: true } : {}) });
      const running = runProbes(fake.browser, [page(0)], [changed], OPTS);
      await vi.advanceTimersByTimeAsync(5000);
      const [run] = await running;
      expect(run!.findings).toEqual([expect.objectContaining({ criterion: '2.1.1', status: 'not_testable' })]);
    } finally { vi.useRealTimers(); }
  });

  it.each(['ordinary', 'boxed', 'late'])('an owned load cannot adopt a page reload redirected to /expired before its identity read (%s)', async (mode) => {
    vi.useFakeTimers();
    try {
      const events: Record<string, ((r: RequestLike) => void)[]> = {};
      const emit = (event: string, r: RequestLike) => events[event]?.forEach((fn) => fn(r));
      let doc = 'original', url = page(0).url, loads = 0, replace = false, allowed = false;
      let route!: (r: RouteLike) => unknown;
      const request = (address: string, from: RequestLike | null = null): RequestLike => ({
        method: () => 'GET', url: () => address, resourceType: () => 'document', isNavigationRequest: () => true, redirectedFrom: () => from,
      });
      const fake = fakeProbeBrowser({ evaluate: async (name) => {
        if (name !== 'documentId') return undefined;
        if (replace) {
          replace = false;
          const reload = request(url);
          emit('request', reload);
          await route({ request: () => reload, async abort() {}, async continue() { allowed = true; } });
          emit('requestfinished', reload);
          url = 'https://e.org/expired';
          const redirect = request(url, reload);
          emit('request', redirect);
          doc = 'unowned-redirect-destination';
          emit('requestfinished', redirect);
        }
        return doc;
      } });
      const browser = { async newContext(o: Parameters<BrowserLike['newContext']>[0]) {
        const context = await fake.browser.newContext(o);
        context.on = ((event: string, fn: (r: RequestLike) => void) => { (events[event] ??= []).push(fn); }) as typeof context.on;
        context.route = async (_, handler) => { route = handler; };
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          const p = await newPage();
          const goto = p.goto.bind(p);
          p.url = () => url;
          p.goto = async (...args) => {
            const owned = request(args[0]);
            emit('request', owned);
            await route({ request: () => owned, async abort() {}, async continue() {} });
            const response = await goto(...args);
            url = args[0];
            doc = `owned-${++loads}`;
            emit('requestfinished', owned);
            replace = loads === 2;
            return response;
          };
          return p;
        };
        return context;
      } } as BrowserLike;
      const measure: PageProbe['run'] = async (ctx) => {
        await ctx.page.goto(ctx.url, { waitUntil: 'load' });
        return [{ criterion: '2.1.1', status: 'failed', detail: `measured on ${doc}` }];
      };
      const first: ProbeFinding[] = [{ criterion: '2.1.1', status: 'no_failures_found', detail: 'first document' }];
      const reloading = probe('reloading', mode === 'late' ? async () => first : measure, {
        ...(mode === 'boxed' ? { freshAfterFiredTimers: true } : {}),
        ...(mode === 'late' ? { late: { timeoutMs: 1000, run: measure } } : {}),
      });
      const running = runProbes(browser, [page(0)], [reloading], OPTS);
      await vi.advanceTimersByTimeAsync(5000);
      const [run] = await running;
      expect(allowed).toBe(true);
      expect(doc).toBe('unowned-redirect-destination');
      expect(run!.findings).toEqual(mode === 'late' ? first : [{ criterion: '2.1.1', status: 'not_testable', detail: DOCUMENT_CHANGED }]);
    } finally { vi.useRealTimers(); }
  });

  it.each([false, true])('a confirmed replacement stays invalid when later identity calls hang (second keep: %s)', async (keepAgain) => {
    vi.useFakeTimers();
    try {
      let doc = 'original', hang = false, replacementReads = 0;
      const navigated: (() => void)[] = [];
      const fake = fakeProbeBrowser({ evaluate: (name) => {
        if (name !== 'documentId') return undefined;
        if (hang) return new Promise(() => {});
        if (doc === 'replacement') replacementReads++;
        return doc;
      } });
      const browser = { async newContext(o: Parameters<BrowserLike['newContext']>[0]) {
        const context = await fake.browser.newContext(o);
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          const p = await newPage();
          const frame = { url: () => p.url!(), parentFrame: () => null };
          p.mainFrame = () => frame;
          p.on = ((event: string, listener: (f: typeof frame) => void) => {
            if (event === 'framenavigated') navigated.push(() => listener(frame));
          }) as typeof p.on;
          return p;
        };
        return context;
      } } as BrowserLike;
      const failure: ProbeFinding = { criterion: '2.1.1', status: 'failed', detail: 'confirmed failure' };
      const changed = probe('changed', async (ctx) => {
        ctx.keep!([failure]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        doc = 'replacement';
        navigated.forEach((fn) => fn());
        await new Promise((resolve) => setTimeout(resolve, 10));
        hang = true;
        if (keepAgain) ctx.keep!([failure]);
        return new Promise(() => {});
      }, { freshAfterFiredTimers: true });
      const running = runProbes(browser, [page(0)], [changed], OPTS);
      await vi.advanceTimersByTimeAsync(5000);
      const [run] = await running;
      expect(replacementReads).toBe(1);
      expect(run!.findings).toEqual([expect.objectContaining({ criterion: '2.1.1', status: 'not_testable' })]);
    } finally { vi.useRealTimers(); }
  });

  it.each(['returned', 'kept-returned', 'kept-timeout', 'boxed-returned', 'boxed-kept-timeout', 'late-returned', 'late-kept-timeout'])('an owned reload validates %s findings; a late pass still needs the first document', async (mode) => {
    vi.useFakeTimers();
    try {
      for (const changesAgain of [false, true]) {
        let doc = 'original', loads = 0;
        const navigated: (() => void)[] = [];
        const events: Record<string, ((r: RequestLike) => void)[]> = {};
        let route!: (r: RouteLike) => unknown;
        const fake = fakeProbeBrowser({ evaluate: (name) => name === 'documentId' ? doc : undefined });
        const browser = { async newContext(o: Parameters<BrowserLike['newContext']>[0]) {
          const context = await fake.browser.newContext(o);
          context.on = ((event: string, listener: (r: RequestLike) => void) => { (events[event] ??= []).push(listener); }) as typeof context.on;
          context.route = async (_, handler) => { route = handler; };
          const newPage = context.newPage.bind(context);
          context.newPage = async () => {
            const p = await newPage();
            const goto = p.goto.bind(p);
            const frame = { url: () => p.url!(), parentFrame: () => null };
            p.mainFrame = () => frame;
            p.on = ((event: string, listener: (f: typeof frame) => void) => {
              if (event === 'framenavigated') navigated.push(() => listener(frame));
            }) as typeof p.on;
            p.goto = async (...args) => {
              const request: RequestLike = { method: () => 'GET', url: () => args[0], resourceType: () => 'document', frame: () => frame };
              events.request?.forEach((fn) => fn(request));
              await route({ request: () => request, async abort() {}, async continue() {} });
              const response = await goto(...args);
              doc = `owned-${++loads}`;
              navigated.forEach((fn) => fn());
              events.requestfinished?.forEach((fn) => fn(request));
              return response;
            };
            return p;
          };
          return context;
        } } as BrowserLike;
        const failure: ProbeFinding = { criterion: '2.1.1', status: 'failed', detail: 'confirmed failure' };
        const measure: PageProbe['run'] = async (ctx) => {
          if (mode.includes('kept')) ctx.keep!([failure]);
          // The same call used by reloadPage and other probes, at the same address.
          await ctx.page.goto(ctx.url, { waitUntil: 'load' });
          if (changesAgain) {
            doc = 'page-initiated-replacement';
            navigated.forEach((fn) => fn());
          }
          if (mode.includes('kept')) ctx.keep!([failure]);
          if (mode.endsWith('timeout')) return new Promise(() => {});
          return [failure];
        };
        const first: ProbeFinding[] = [{ criterion: '2.1.1', status: 'no_failures_found', detail: 'first document' }];
        const reloading = probe('reloading', mode.startsWith('late') ? async () => first : measure, {
          ...(mode.startsWith('boxed') ? { freshAfterFiredTimers: true } : {}),
          ...(mode.startsWith('late') ? { late: { timeoutMs: 1000, run: measure } } : {}),
        });
        const running = runProbes(browser, [page(0)], [reloading], OPTS);
        await vi.advanceTimersByTimeAsync(5000);
        const [run] = await running;
        expect(loads).toBe(2);
        // Even an owned reload in a late pass cannot replace findings from the first document.
        expect(run!.findings, `page navigates again: ${changesAgain}`).toEqual(mode.startsWith('late') ? first : changesAgain
          ? [expect.objectContaining({ criterion: '2.1.1', status: 'not_testable' })]
          : [failure]);
      }
    } finally { vi.useRealTimers(); }
  });

  it.each([200, 404, 202])('boxed owned-reload validation cannot retain failures while identity hangs (HTTP %s)', async (status) => {
    vi.useFakeTimers();
    try {
      let doc = 'original', hang = false, loads = 0;
      let route!: (r: RouteLike) => unknown;
      const requests: ((r: RequestLike) => void)[] = [];
      const navigated: (() => void)[] = [];
      const fake = fakeProbeBrowser({
        statusFor: () => ++loads === 2 ? status : 200,
        evaluate: (name) => name === 'documentId' ? hang ? new Promise(() => {}) : doc : undefined,
      });
      const browser: BrowserLike = { async newContext(o) {
        const context = await fake.browser.newContext(o);
        context.on = ((event: string, listener: (r: RequestLike) => void) => { if (event === 'request') requests.push(listener); }) as typeof context.on;
        context.route = async (_, handler) => { route = handler; };
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          const p = await newPage();
          const goto = p.goto.bind(p);
          const frame = { url: () => p.url!(), parentFrame: () => null };
          p.mainFrame = () => frame;
          p.on = ((event: string, listener: (f: typeof frame) => void) => {
            if (event === 'framenavigated') navigated.push(() => listener(frame));
          }) as typeof p.on;
          p.goto = async (...args) => {
            const request: RequestLike = { method: () => 'GET', url: () => args[0], resourceType: () => 'document', frame: () => frame };
            requests.forEach((fn) => fn(request));
            await route({ request: () => request, async abort() {}, async continue() {} });
            const response = await goto(...args);
            doc = `owned-${loads}`;
            navigated.forEach((fn) => fn());
            return response;
          };
          return p;
        };
        return context;
      } };
      const reloading = probe('reloading', async (ctx) => {
        ctx.keep!([{ criterion: '2.1.1', status: 'failed', detail: 'must not survive an unchecked reload' }]);
        await ctx.page.goto(ctx.url, { waitUntil: 'load' });
        hang = true;
        await ctx.reloadedPage!();
        return [];
      }, { freshAfterFiredTimers: true });
      const running = runProbes(browser, [page(0)], [reloading], OPTS);
      await vi.advanceTimersByTimeAsync(5000);
      const [run] = await running;
      expect(loads).toBe(2);
      expect(run!.findings).toEqual([expect.objectContaining({ status: 'not_testable', ...(status === 202 ? { loadFailure: 'challenge' } : {}) })]);
    } finally { vi.useRealTimers(); }
  });

  it('boxed completion cannot retain failures after bot evidence, even when identity hangs', async () => {
    vi.useFakeTimers();
    try {
      let route!: (r: RouteLike) => unknown;
      let hang = false, entered = 0;
      const fake = fakeProbeBrowser({ evaluate: (name) => name === 'documentId' && hang ? new Promise(() => {}) : undefined });
      const browser: BrowserLike = { async newContext(o) {
        const context = await fake.browser.newContext(o);
        context.route = async (_, handler) => { route = handler; };
        return context;
      } };
      const challenged = probe('challenged', async (ctx) => {
        ctx.keep!([{ criterion: '2.1.1', status: 'failed', detail: 'must be voided' }]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        await route({
          request: () => ({ method: () => 'POST', url: () => 'https://e.org/_sec/verify', resourceType: () => 'xhr' }),
          async abort() {}, async continue() { throw new Error('verification must be blocked'); },
        });
        hang = true;
        return new Promise(() => {});
      }, { freshAfterFiredTimers: true });
      const next = probe('next', async () => { entered++; return []; });
      const running = runProbes(browser, [page(0)], [challenged, next], OPTS);
      await vi.advanceTimersByTimeAsync(5000);
      const runs = await running;
      expect(entered).toBe(0);
      expect(runs).toHaveLength(2);
      for (const run of runs) expect(run.findings).toEqual([expect.objectContaining({ status: 'not_testable', loadFailure: 'challenge' })]);
    } finally { vi.useRealTimers(); }
  });

  it.each(['deadline', 'cancel'])('strict request draining takes the shared %s before typing', async (mode) => {
    vi.useFakeTimers();
    try {
      let request!: (r: RequestLike) => void;
      let entered = false;
      const stop = new AbortController();
      const fake = fakeProbeBrowser();
      const browser: BrowserLike = { async newContext(o) {
        const context = await fake.browser.newContext(o);
        context.on = ((event: string, handler: (r: RequestLike) => void) => { if (event === 'request') request = handler; }) as typeof context.on;
        return context;
      } };
      const typing = probe('typing', async () => { entered = true; return []; }, { sendsNothing: true });
      const running = runProbes(browser, [page(0)], [typing], {
        ...OPTS, deadline: Date.now() + (mode === 'deadline' ? 100 : 1000), signal: stop.signal,
        onStart() {
          request({ method: () => 'GET', url: () => 'https://e.org/pending', resourceType: () => 'fetch' });
          if (mode === 'cancel') setTimeout(() => stop.abort(), 20);
        },
      });
      await vi.advanceTimersByTimeAsync(2000);
      const [run] = await running;
      expect(entered).toBe(false);
      expect(run!.findings).toEqual([expect.objectContaining({ status: 'not_testable', detail: mode === 'deadline' ? TIME_LEFT : CANCELLED })]);
    } finally { vi.useRealTimers(); }
  });

  it('drops findings for criteria the probe does not declare, malformed findings and over-long text', async () => {
    const fake = fakeProbeBrowser();
    const messy = probe('messy', async () => [
      { criterion: '2.1.1', status: 'failed', target: '#a', detail: 'x'.repeat(900) },
      { criterion: '9.9.9', status: 'failed', detail: 'not mine' },
      { criterion: '2.1.1', status: 'passed' as never, detail: 'bad status' },
      { criterion: '2.1.1', status: 'flagged' } as never,
    ]);
    const [run] = await runProbes(fake.browser, [page(0)], [messy], OPTS);
    expect(run!.findings).toHaveLength(1);
    expect(run!.findings[0]!.detail).toHaveLength(500);
    expect(run!.findings[0]!.target).toBe('#a');
  });

  it('opens a fresh context per page and probe set, with the probe set’s viewport and options, and closes them all', async () => {
    const fake = fakeProbeBrowser();
    const seen: [string, string, number][] = [];
    const rec = (id: string, extra: Partial<PageProbe> = {}) =>
      probe(id, async (ctx) => { seen.push([id, new URL(ctx.url).pathname, fake.contextOf(ctx.page)]); return []; }, extra);
    const probes = [
      rec('a'), rec('b'),
      rec('mobile', { viewport: { width: 320, height: 256 }, contextOptions: { hasTouch: true, isMobile: true } }),
      rec('c'),
      rec('alone', { isolate: true }),
    ];
    expect(groupProbes(probes).map((g) => g.probes.map((p) => p.id))).toEqual([['a', 'b', 'c'], ['mobile'], ['alone']]);
    const runs = await runProbes(fake.browser, [page(0), page(1)], probes, { ...OPTS, concurrency: 1 });
    expect(fake.contexts).toBe(6);
    expect(fake.open).toBe(0);
    // Each context saw one page only.
    const pagesByContext = new Map<number, Set<string>>();
    for (const [, path, ctx] of seen) pagesByContext.set(ctx, new Set([...(pagesByContext.get(ctx) ?? []), path]));
    expect([...pagesByContext.values()].every((s) => s.size === 1)).toBe(true);
    expect(fake.options.map((o) => [o.viewport, o.hasTouch, o.isMobile, o.reducedMotion, o.serviceWorkers, o.userAgent])).toEqual([
      [{ width: 1280, height: 900 }, undefined, undefined, 'reduce', 'block', 'test-agent'],
      [{ width: 320, height: 256 }, true, true, 'reduce', 'block', 'test-agent'],
      [{ width: 1280, height: 900 }, undefined, undefined, 'reduce', 'block', 'test-agent'],
      [{ width: 1280, height: 900 }, undefined, undefined, 'reduce', 'block', 'test-agent'],
      [{ width: 320, height: 256 }, true, true, 'reduce', 'block', 'test-agent'],
      [{ width: 1280, height: 900 }, undefined, undefined, 'reduce', 'block', 'test-agent'],
    ]);
    // Output: page order, then registry order (not group order).
    expect(runs.map((r) => `${new URL(r.page).pathname}:${r.probe}`)).toEqual([
      '/p0:a', '/p0:b', '/p0:mobile', '/p0:c', '/p0:alone', '/p1:a', '/p1:b', '/p1:mobile', '/p1:c', '/p1:alone',
    ]);
  });

  it('orders runs by page index and registry order when pages finish out of order', async () => {
    const fake = fakeProbeBrowser({ delayFor: (p) => (p === '/p0' ? 60 : p === '/p2' ? 30 : 1) });
    const finished: string[] = [];
    const rec = (id: string) => probe(id, async (ctx) => { finished.push(`${new URL(ctx.url).pathname}:${id}`); return []; });
    const runs = await runProbes(fake.browser, [page(0), page(1), page(2)], [rec('x'), rec('y')], { ...OPTS, concurrency: 3 });
    expect(finished[0]).toBe('/p1:x');
    expect(runs.map((r) => `${new URL(r.page).pathname}:${r.probe}`)).toEqual(['/p0:x', '/p0:y', '/p1:x', '/p1:y', '/p2:x', '/p2:y']);
  });

  it('keeps at most `concurrency` contexts open (default 4)', async () => {
    const fake = fakeProbeBrowser({ delayFor: () => 10 });
    await runProbes(fake.browser, [0, 1, 2, 3, 4].map((i) => page(i)), [ok('a'), ok('b', { isolate: true })], OPTS);
    expect(fake.contexts).toBe(10);
    expect(fake.maxOpen).toBe(PROBE_DEFAULTS.concurrency);
    expect(PROBE_DEFAULTS.concurrency).toBe(4);
  });

  it('opens more contexts at once when slots are lent (the audit freed room), never more than MAX_PROBE_SLOTS', async () => {
    const fake = fakeProbeBrowser({ delayFor: () => 20 });
    const runner = createProbeRunner(fake.browser, [ok('a'), ok('b', { isolate: true })], { ...OPTS, concurrency: 2 });
    for (let i = 0; i < 10; i++) runner.add(page(i));
    runner.lend(3);
    runner.lend(0);
    await runner.finish();
    expect(fake.maxOpen).toBe(5);
    const again = fakeProbeBrowser({ delayFor: () => 20 });
    const big = createProbeRunner(again.browser, [ok('a'), ok('b', { isolate: true })], { ...OPTS, concurrency: 2 });
    for (let i = 0; i < 10; i++) big.add(page(i));
    big.lend(50);
    await big.finish();
    expect(again.maxOpen).toBe(MAX_PROBE_SLOTS);
  });

  it('lending never takes the runner past its lend limit (the scan\'s pages at once), nor below its own concurrency', async () => {
    let most = 3;
    const fake = fakeProbeBrowser({ delayFor: () => 20 });
    const runner = createProbeRunner(fake.browser, [ok('a'), ok('b', { isolate: true })], { ...OPTS, concurrency: 2, lendLimit: () => most });
    for (let i = 0; i < 10; i++) runner.add(page(i));
    runner.lend(4);
    await runner.finish();
    expect(fake.maxOpen).toBe(3);
    // A limit under its own concurrency never takes contexts away; a throw is ignored.
    most = 1;
    const low = fakeProbeBrowser({ delayFor: () => 20 });
    const r2 = createProbeRunner(low.browser, [ok('a'), ok('b', { isolate: true })], { ...OPTS, concurrency: 2, lendLimit: () => most });
    for (let i = 0; i < 6; i++) r2.add(page(i));
    r2.lend(4);
    await r2.finish();
    expect(low.maxOpen).toBe(2);
  });

  it('starts a page\'s heavier probe sets first (by their time boxes); results keep registry order', async () => {
    const fake = fakeProbeBrowser();
    const started: string[] = [];
    const tag = (id: string, extra: Partial<PageProbe>) => probe(id, async () => { started.push(id); return []; }, extra);
    const runs = await runProbes(fake.browser, [page(0), page(1)], [tag('light', { isolate: true, timeoutMs: 1000 }), tag('heavy1', { timeoutMs: 5000 }), tag('heavy2', { timeoutMs: 5000 })], { ...OPTS, concurrency: 1 });
    expect(started).toEqual(['heavy1', 'heavy2', 'light', 'heavy1', 'heavy2', 'light']);
    expect(runs.map((r) => r.probe)).toEqual(['light', 'heavy1', 'heavy2', 'light', 'heavy1', 'heavy2']);
  });

  it('reports a page that does not load as not_testable for each probe', async () => {
    const fake = fakeProbeBrowser({ statusFor: (p) => (p === '/p1' ? 503 : 200) });
    const runs = await runProbes(fake.browser, [page(0), page(1)], [ok('a'), ok('b')], OPTS);
    expect(runs.map((r) => [new URL(r.page).pathname, r.probe, r.status, r.findings[0]!.detail])).toEqual([
      ['/p0', 'a', 'ok', 'a on https://e.org/p0'],
      ['/p0', 'b', 'ok', 'b on https://e.org/p0'],
      ['/p1', 'a', 'error', 'the page did not load for this test: HTTP 503'],
      ['/p1', 'b', 'error', 'the page did not load for this test: HTTP 503'],
    ]);
    expect(fake.open).toBe(0);
  });

  it('never runs a probe when the request guard cannot be installed', async () => {
    const fake = fakeProbeBrowser({ noRoute: true });
    let ran = false;
    const runs = await runProbes(fake.browser, [page(0)], [probe('a', async () => { ran = true; return []; })], OPTS);
    expect(ran).toBe(false);
    expect(runs[0]).toMatchObject({ status: 'error', findings: [{ status: 'not_testable', detail: NO_GUARD }] });
    expect(fake.events.some((e) => e.type === 'goto')).toBe(false);
  });

  it('listeners() is not_testable when the browser cannot add the init script', async () => {
    const fake = fakeProbeBrowser({ noInitScript: true });
    const runs = await runProbes(fake.browser, [page(0)], [probe('a', async (ctx) => { await ctx.listeners(); return []; })], OPTS);
    expect(runs[0]).toMatchObject({ status: 'ok', findings: [{ status: 'not_testable', detail: 'the browser could not record event listeners on this page' }] });
  });

  it('runs deep probes only with `full`, and rejects duplicate ids', async () => {
    const fake = fakeProbeBrowser();
    const probes = [ok('core'), ok('deep', { tier: 'deep' })];
    expect((await runProbes(fake.browser, [page(0)], probes, OPTS)).map((r) => r.probe)).toEqual(['core']);
    expect((await runProbes(fake.browser, [page(0)], probes, { ...OPTS, full: true })).map((r) => r.probe)).toEqual(['core', 'deep']);
    expect(() => createProbeRunner(fake.browser, [ok('a'), ok('a')], OPTS)).toThrow(/Duplicate probe id/);
  });

  it('adds each page once, and cancels outstanding runs on the signal', async () => {
    const fake = fakeProbeBrowser();
    const abort = new AbortController();
    const slow = probe('slow', (ctx) => new Promise((resolve) => {
      ctx.signal.addEventListener('abort', () => resolve([]));
      setTimeout(() => abort.abort(), 10);
    }), { timeoutMs: 5000 });
    const runner = createProbeRunner(fake.browser, [slow, ok('next')], { ...OPTS, signal: abort.signal, concurrency: 1 });
    runner.add(page(0));
    runner.add(page(0));
    runner.add(page(1));
    const runs = await runner.finish();
    expect(runs.map((r) => [new URL(r.page).pathname, r.probe, r.status, r.findings[0]!.detail])).toEqual([
      ['/p0', 'slow', 'error', CANCELLED],
      ['/p0', 'next', 'error', CANCELLED],
      ['/p1', 'slow', 'error', CANCELLED],
      ['/p1', 'next', 'error', CANCELLED],
    ]);
    expect(fake.open).toBe(0);
    // A cancelled run is the time limit's (only the finish plan cancels runs): marked so.
    expect(runs.every((r) => r.findings.every((f) => f.timeLimit === true))).toBe(true);
  });

  it('unfinished: a not-tested run, marked timeLimit, for each queued run that never came back', async () => {
    const fake = fakeProbeBrowser();
    const runner = createProbeRunner(fake.browser, [ok('a'), ok('b')], OPTS);
    runner.add(page(0));
    runner.add(page(1));
    const runs = await runner.finish();
    expect(runner.unfinished(runs)).toEqual([]);
    const left = runner.unfinished(runs.filter((r) => new URL(r.page).pathname === '/p0'));
    expect(left.map((r) => [new URL(r.page).pathname, r.probe, r.findings.map((f) => [f.status, f.detail, f.timeLimit])])).toEqual([
      ['/p1', 'a', [['not_testable', TIME_LEFT, true]]],
      ['/p1', 'b', [['not_testable', TIME_LEFT, true]]],
    ]);
  });
});

// Review r2 (Grok): a core test whose context waited past the pool's session wait (src/sessions.ts) is
// not a lost browser: it is not tried again (that is another full wait), and it never takes the score.
describe('a core test that waited for a browser session past the bound', () => {
  it('is not tested, with that reason, never BROWSER_LOST or browser-lost, tried once, and the scan keeps its score', async () => {
    const { SESSION_WAIT } = await import('../../src/sessions.js');
    const { browserLost } = await import('../../src/report/build.js');
    const { BROWSER_LOST } = await import('../../src/reconnect.js');
    const { SCORED_PROBES } = await import('../../src/probes/registry.js');
    let contexts = 0;
    const waiting = { async newContext() { contexts++; throw new Error(`Target page, context or browser has been closed (${SESSION_WAIT})`); } } as unknown as BrowserLike;
    const id = [...SCORED_PROBES][0]!;
    const runs = await runProbes(waiting, [page(0)], [ok(id)], OPTS);
    expect(contexts).toBe(1);
    expect(runs).toHaveLength(1);
    for (const f of runs[0]!.findings) {
      expect(f.status).toBe('not_testable');
      expect(f.detail).not.toBe(BROWSER_LOST);
      expect(f.loadFailure).not.toBe('browser-lost');
    }
    const scored = { status: 'scored' as const, score: 91, letter: 'A' as const, headline: 'Access Granted' as const, reasons: [] as string[], pageScores: new Map(), pointsLost: { x: 1 }, probePointsLost: {}, aiPointsLost: {}, documentPointsLost: 0 };
    expect(browserLost(scored, [], runs)).toBe(scored);
  });
});

// A probe that needs a fresh page after timers were run early (`freshAfterFiredTimers`, the timing
// test): one absolute time box from before the flag is read, through the old page's close, the fresh
// load (with one retry when the browser closes under it) and the run (round 2, Sol 6 and 7).
describe('the fresh load counts inside one time box', () => {
  const fresh = (timeoutMs: number) => probe('fresh', async () => [{ criterion: '2.1.1', status: 'no_failures_found', detail: 'ran' }], { timeoutMs, freshAfterFiredTimers: true });
  const loadsOf = (fake: ReturnType<typeof fakeProbeBrowser>) => fake.events.filter((e) => e.type === 'goto').length;

  it.each(['deadline', 'cancel'])('a hung timer-flag read takes the shared %s', async (mode) => {
    vi.useFakeTimers();
    try {
      const stop = new AbortController();
      const fake = fakeProbeBrowser({ evaluate: (name) => name === 'firedCount' ? new Promise(() => {}) : undefined });
      let started = 0, ended = 0;
      const running = runProbes(fake.browser, [page(0)], [fresh(1000)], {
        ...OPTS, deadline: Date.now() + (mode === 'deadline' ? 100 : 2000), signal: stop.signal,
        onStart() { started = Date.now(); if (mode === 'cancel') setTimeout(() => stop.abort(), 20); },
      }).then((runs) => { ended = Date.now(); return runs; });
      await vi.advanceTimersByTimeAsync(5000);
      const [run] = await running;
      expect(ended - started).toBeLessThanOrEqual(mode === 'deadline' ? 100 : 20);
      expect(run!.findings).toEqual([expect.objectContaining({ status: 'not_testable', detail: mode === 'deadline' ? TIME_LEFT : CANCELLED })]);
    } finally { vi.useRealTimers(); }
  });

  it.each(['deadline', 'cancel'])('a hung fresh load takes the shared %s', async (mode) => {
    vi.useFakeTimers();
    try {
      const stop = new AbortController();
      let loads = 0, started = 0, ended = 0;
      const fake = fakeProbeBrowser({
        evaluate: (name) => name === 'firedCount' ? 1 : undefined,
        delayFor: () => ++loads > 1 ? 60000 : 0,
      });
      const running = runProbes(fake.browser, [page(0)], [fresh(1000)], {
        ...OPTS, deadline: Date.now() + (mode === 'deadline' ? 100 : 2000), signal: stop.signal,
        onStart() { started = Date.now(); if (mode === 'cancel') setTimeout(() => stop.abort(), 20); },
      }).then((runs) => { ended = Date.now(); return runs; });
      await vi.advanceTimersByTimeAsync(5000);
      const [run] = await running;
      expect(ended - started).toBeLessThanOrEqual(mode === 'deadline' ? 100 : 20);
      expect(run!.findings).toEqual([expect.objectContaining({ status: 'not_testable', detail: mode === 'deadline' ? TIME_LEFT : CANCELLED })]);
    } finally { vi.useRealTimers(); }
  });

  it('a bot challenge on a fresh timing load stops every remaining probe without loading again', async () => {
    vi.useFakeTimers();
    try {
      let loads = 0, entered = 0;
      const fake = fakeProbeBrowser({
        evaluate: (name) => name === 'firedCount' ? 1 : undefined,
        statusFor: () => ++loads === 2 ? 202 : 200,
      });
      const next = probe('next', async () => { entered++; return []; });
      const running = runProbes(fake.browser, [page(0)], [ok('first'), fresh(1000), next], OPTS);
      await vi.advanceTimersByTimeAsync(5000);
      const runs = await running;
      expect(entered).toBe(0);
      expect(loads).toBe(2);
      for (const run of runs.slice(1)) expect(run.findings).toEqual([expect.objectContaining({ status: 'not_testable', loadFailure: 'challenge' })]);
    } finally { vi.useRealTimers(); }
  });

  it('a flag that never answers and a fresh load that stalls: timed out, ending by the time box', async () => {
    let n = 0;
    const fake = fakeProbeBrowser({
      evaluate: (name) => (name === 'firedCount' ? new Promise(() => {}) : undefined),
      delayFor: (path) => (path === '/p0' && ++n > 1 ? 60_000 : 0),
    });
    const t0 = Date.now();
    const runs = await runProbes(fake.browser, [page(0)], [ok('first'), fresh(1000)], OPTS);
    const elapsed = Date.now() - t0;
    const r = runs.find((x) => x.probe === 'fresh')!;
    expect(r.status).toBe('timeout');
    expect(r.findings[0]!.detail).toMatch(/^timed out after 1 s \(loaded again for this test/);
    expect(r.ms).toBeLessThan(1150);
    expect(elapsed).toBeLessThan(2500);
  });

  it('an old page whose close never resolves: the close is bounded, and the fresh load and the run still fit', async () => {
    const fake = fakeProbeBrowser({ evaluate: (name) => (name === 'firedCount' ? 1 : undefined) });
    let first = true;
    const browser = {
      async newContext(o: unknown) {
        const c = await (fake.browser.newContext as unknown as (o: unknown) => Promise<Record<string, unknown>>)(o);
        if (first) { first = false; c.close = () => new Promise(() => {}); }
        return c;
      },
    } as unknown as BrowserLike;
    const t0 = Date.now();
    const runs = await runProbes(browser, [page(0)], [ok('first'), fresh(5000)], OPTS);
    const r = runs.find((x) => x.probe === 'fresh')!;
    expect(r.findings).toEqual([{ criterion: '2.1.1', status: 'no_failures_found', detail: 'ran' }]);
    expect(r.ms).toBeLessThan(5000);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(loadsOf(fake)).toBe(2);
  });

  it('the browser closing under the fresh load twice: one retry inside the box, then the browser-lost result', async () => {
    const fake = fakeProbeBrowser({ evaluate: (name) => (name === 'firedCount' ? 2 : undefined) });
    let opened = 0;
    const browser = {
      async newContext(o: unknown) {
        if (++opened > 1) throw new Error('Target page, context or browser has been closed');
        return (fake.browser.newContext as unknown as (o: unknown) => Promise<unknown>)(o);
      },
    } as unknown as BrowserLike;
    const runs = await runProbes(browser, [page(0)], [ok('first'), fresh(2000)], OPTS);
    const r = runs.find((x) => x.probe === 'fresh')!;
    expect(r.findings).toEqual([expect.objectContaining({ status: 'not_testable', loadFailure: 'browser-lost' })]);
    // The first page, the fresh load, and exactly one retry.
    expect(opened).toBe(3);
    expect(r.ms).toBeLessThan(2000);
  });

  it('no timer run early: no fresh load, and the probe runs on the same page', async () => {
    const fake = fakeProbeBrowser({ evaluate: (name) => (name === 'firedCount' ? 0 : undefined) });
    const runs = await runProbes(fake.browser, [page(0)], [ok('first'), fresh(1000), ok('next')], OPTS);
    expect(runs.map((r) => r.findings[0]!.status)).toEqual(['no_failures_found', 'no_failures_found', 'no_failures_found']);
    expect(loadsOf(fake)).toBe(1);
  });
});
