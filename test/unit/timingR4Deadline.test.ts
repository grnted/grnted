// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { gateDocuments } from '../../src/navigationGate.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike, CDPSessionLike, ContextLike, ProbeFinding, RouteLike } from '../../src/types.js';
import { fakeProbeBrowser } from '../helpers/probes.js';

afterEach(() => vi.useRealTimers());
const target = [{ url: 'https://e.org/quiz', index: 0 }];
const first: PageProbe = { id: 'first', criteria: [], kind: 'interaction', tier: 'core', timeoutMs: 1000, run: async () => [] };
const timing: PageProbe = { ...first, id: 'timing', criteria: ['2.2.1'], freshAfterFiredTimers: true, timeoutMs: 10000 };

describe('round 4 absolute timing deadline', () => {
  it.each(['returned', 'kept', 'close'])('preserves a confirmed failure (%s) when completion or close hangs after a nine-second fresh load', async (mode) => {
    vi.useFakeTimers();
    let opens = 0, measuring = false, started = 0, ended = 0;
    const failure: ProbeFinding = { criterion: '2.2.1', status: 'failed', detail: 'confirmed time limit without an extension' };
    const fake = fakeProbeBrowser({
      delayFor: () => opens > 1 ? 9000 : 0,
      evaluate: (name) => {
        if (name === 'firedCount') return 1;
        if (name === 'documentId' && opens > 1 && measuring && mode !== 'close') return new Promise(() => {});
        return undefined;
      },
    });
    const browser = { async newContext(o: Parameters<BrowserLike['newContext']>[0]) {
      opens++;
      const c = await fake.browser.newContext(o);
      if (opens > 1 && mode === 'close') c.close = () => new Promise(() => {});
      return c;
    } } as BrowserLike;
    const confirmed: PageProbe = { ...timing, async run(ctx) {
      measuring = true;
      if (mode === 'kept') { ctx.keep!([failure]); return new Promise(() => {}); }
      return [failure];
    } };
    const promise = runProbes(browser, target, [first, confirmed], { userAgent: 'test', onStart: (r) => { if (r.probe === 'timing') started = Date.now(); } }).then((r) => { ended = Date.now(); return r; });
    await vi.advanceTimersByTimeAsync(15000);
    const run = (await promise).find((r) => r.probe === 'timing')!;
    expect(ended - started).toBeLessThanOrEqual(10000);
    expect(run.ms).toBe(ended - started);
    expect(run.findings).toContainEqual(failure);
  });

  it.each(['gate-lost', 'refused-address', 'stylesheet', 'navigation'])('a kept failure still loses validity after %s before the deadline', async (invalid) => {
    vi.useFakeTimers();
    let opens = 0;
    let route!: (r: RouteLike) => unknown;
    const events: Record<string, ((r: never) => void)[]> = {};
    const gateEvents: Record<string, (r: never) => void> = {};
    const fake = fakeProbeBrowser({
      delayFor: () => opens > 1 ? 9000 : 0,
      evaluate: (name) => name === 'firedCount' ? 1 : name === 'linkState' ? ['applies'] : undefined,
    });
    const browser = { async newContext(o: Parameters<BrowserLike['newContext']>[0]) {
      opens++;
      const c = await fake.browser.newContext(o);
      const newPage = c.newPage.bind(c);
      c.route = async (_url, handler) => { route = handler; };
      c.newPage = async () => {
        const page = await newPage();
        page.on = ((event: string, fn: (r: never) => void) => { (events[event] ??= []).push(fn); }) as typeof page.on;
        page.mainFrame = () => ({ url: () => target[0]!.url, parentFrame: () => null });
        return page;
      };
      return c;
    } } as BrowserLike;
    const confirmed: PageProbe = { ...timing, async run(ctx) {
      const cdp = { async send() { return {}; }, on(event: string, fn: (r: never) => void) { gateEvents[event] = fn; } } as CDPSessionLike;
      await gateDocuments({ async newCDPSession() { return cdp; } } as unknown as ContextLike, ctx.page, async () => true, { allowIp: () => false });
      ctx.keep!([{ criterion: '2.2.1', status: 'failed', detail: 'confirmed time limit' }]);
      setTimeout(() => {
        if (invalid === 'gate-lost') gateEvents.close!(undefined as never);
        if (invalid === 'refused-address') gateEvents['Network.responseReceived']!({ type: 'Document', response: { url: target[0]!.url, remoteIPAddress: '10.0.0.5' } } as never);
        if (invalid === 'stylesheet') {
          const request = { url: () => 'https://e.org/style.css', resourceType: () => 'stylesheet', frame: () => ctx.page.mainFrame!() };
          events.request?.forEach((fn) => fn(request as never));
          events.response?.forEach((fn) => fn({ request: () => request, url: request.url, status: () => 503, headers: () => ({ 'content-type': 'text/css' }), frame: request.frame } as never));
          events.requestfinished?.forEach((fn) => fn(request as never));
        }
        if (invalid === 'navigation') void route({
          request: () => ({ method: () => 'GET', url: () => 'https://e.org/elsewhere', resourceType: () => 'document', isNavigationRequest: () => true, frame: () => ctx.page.mainFrame!() }),
          async abort() {}, async continue() {},
        });
      }, 100);
      return new Promise(() => {});
    } };
    const promise = runProbes(browser, target, [first, confirmed], { userAgent: 'test' });
    await vi.advanceTimersByTimeAsync(15000);
    const run = (await promise).find((r) => r.probe === 'timing')!;
    expect(run.ms).toBe(10000);
    expect(run.findings).toEqual([expect.objectContaining({ status: 'not_testable' })]);
  });

  it.each(['startup', 'completion', 'close'])('nine-second fresh load and hung %s end within ten seconds and report elapsed ms', async (hang) => {
    vi.useFakeTimers();
    let opens = 0, docs = 0, measuring = false;
    const fake = fakeProbeBrowser({
      delayFor: () => opens > 1 ? 9000 : 0,
      evaluate: (name) => {
        if (name === 'firedCount') return 1;
        // The load validates its identity three times; completion starts only after the probe runs.
        if (name === 'documentId' && opens > 1 && hang !== 'close' && (hang === 'startup' ? ++docs >= 4 : measuring)) return new Promise(() => {});
        return undefined;
      },
    });
    const browser = { async newContext(o: Parameters<BrowserLike['newContext']>[0]) {
      opens++;
      const c = await fake.browser.newContext(o);
      if (opens > 1 && hang === 'close') c.close = () => new Promise(() => {});
      return c;
    } } as BrowserLike;
    let started = 0, ended = 0;
    const observed: PageProbe = { ...timing, async run() { measuring = true; return []; } };
    const promise = runProbes(browser, target, [first, observed], { userAgent: 'test', onStart: (r) => { if (r.probe === 'timing') started = Date.now(); } }).then((r) => { ended = Date.now(); return r; });
    await vi.advanceTimersByTimeAsync(15000);
    const run = (await promise).find((r) => r.probe === 'timing')!;
    expect(ended - started).toBeLessThanOrEqual(10000);
    expect(run.ms).toBe(ended - started);
    if (hang !== 'close') expect(run.findings).toEqual([expect.objectContaining({ status: 'not_testable' })]);
  });

  it('a fresh-load browser loss spends the only retry; a second loss during the probe never requeues', async () => {
    vi.useFakeTimers();
    let opens = 0, started = 0, ended = 0;
    const fake = fakeProbeBrowser({ delayFor: () => opens > 1 ? 6000 : 0, evaluate: (name) => name === 'firedCount' ? 1 : undefined });
    const browser = { async newContext(o: Parameters<BrowserLike['newContext']>[0]) {
      if (++opens === 2) throw new Error('Target page, context or browser has been closed');
      return fake.browser.newContext(o);
    } } as BrowserLike;
    const losing = { ...timing, async run() { await new Promise((r) => setTimeout(r, 1000)); throw new Error('Target page, context or browser has been closed'); } };
    const promise = runProbes(browser, target, [first, losing], { userAgent: 'test', onStart: (r) => { if (r.probe === 'timing' && !started) started = Date.now(); } }).then((r) => { ended = Date.now(); return r; });
    await vi.advanceTimersByTimeAsync(25000);
    const run = (await promise).find((r) => r.probe === 'timing')!;
    expect(opens).toBe(3);
    expect(ended - started).toBeLessThanOrEqual(10000);
    expect(run.ms).toBe(ended - started);
    expect(run.findings).toEqual([expect.objectContaining({ status: 'not_testable', loadFailure: 'browser-lost' })]);
  });

  it('a first loss during the probe requeues with only the original remaining allowance', async () => {
    vi.useFakeTimers();
    let started = 0, ended = 0, attempts = 0;
    const fake = fakeProbeBrowser({ delayFor: () => fake.contexts > 1 ? 6000 : 0, evaluate: (name) => name === 'firedCount' ? 1 : undefined });
    const losing = { ...timing, async run() {
      await new Promise((r) => setTimeout(r, 1000));
      if (++attempts === 1) throw new Error('Target page, context or browser has been closed');
      return [];
    } };
    const promise = runProbes(fake.browser, target, [first, losing], { userAgent: 'test', onStart: (r) => { if (r.probe === 'timing' && !started) started = Date.now(); } }).then((r) => { ended = Date.now(); return r; });
    await vi.advanceTimersByTimeAsync(25000);
    const run = (await promise).find((r) => r.probe === 'timing')!;
    expect(fake.contexts).toBe(3);
    expect(attempts).toBe(1);
    expect(ended - started).toBe(10000);
    expect(run.ms).toBe(10000);
    expect(run.status).toBe('timeout');
  });
});
