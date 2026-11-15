// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// fix/late-mount, review r2: a test's late pass (`PageProbe.late`) runs after every other test of its page
// (on the motion page: after the timing test), and a late pass that throws or times out never loses what the
// first pass found (Sol 9: a throwing second look dropped the first pass's failure).
import { describe, expect, it, vi } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, PageLike } from '../../src/types.js';
import type { GuardEvent, PageProbe, ProbeFinding } from '../../src/probes/types.js';
import { fakeProbeBrowser } from '../helpers/probes.js';

const FAILED: ProbeFinding = { criterion: '2.2.2', status: 'failed', detail: 'found by the first pass' };
const order: string[] = [];
const withLate = (late: PageProbe['late']): PageProbe => ({
  id: 'mover', criteria: ['2.2.2'], kind: 'interaction', tier: 'core', timeoutMs: 2000,
  async run() { order.push('first'); return [FAILED]; },
  late,
});
const timing: PageProbe = { id: 'timer', criteria: ['2.2.1'], kind: 'interaction', tier: 'core', timeoutMs: 2000, async run() { order.push('timing'); return [{ criterion: '2.2.1', status: 'no_failures_found', detail: 'none' }]; } };

const run = async (p: PageProbe) => {
  order.length = 0;
  const fake = fakeProbeBrowser();
  const runs = await runProbes(fake.browser, [{ url: 'https://e.org/p0', index: 0 }], [p, timing], { userAgent: 't', settleMs: 0 });
  return runs.find((r) => r.probe === 'mover')!;
};

describe('late passes', () => {
  it('Sol b15b 3: a history address change followed by a cleanup reload challenged with HTTP 202 preserves the completed first failure', async () => {
    let loads = 0, lateCalls = 0, nextCalls = 0;
    const fake = fakeProbeBrowser({
      evaluate: (name) => name === 'documentId' ? 'same document' : undefined,
      statusFor: () => ++loads === 2 ? 202 : 200,
    });
    const mover: PageProbe = {
      ...withLate({ timeoutMs: 2000, async run() { lateCalls++; return []; } }),
      async run(ctx) { ctx.page.url = () => 'https://e.org/history-address'; return [FAILED]; },
    };
    const next: PageProbe = { ...timing, async run() { nextCalls++; return []; } };
    const runs = await runProbes(fake.browser, [{ url: 'https://e.org/p0', index: 0 }], [mover, next], { userAgent: 't', settleMs: 0 });
    expect(loads).toBe(2);
    expect(fake.events.filter((e) => e.type === 'goto').map((e) => e.url)).toEqual(['https://e.org/p0', 'https://e.org/p0']);
    expect(lateCalls).toBe(0);
    expect(nextCalls).toBe(0);
    expect(runs.find((r) => r.probe === 'mover')!.findings).toEqual([FAILED]);
    expect(runs.find((r) => r.probe === 'timer')!.findings).toEqual([expect.objectContaining({ status: 'not_testable', loadFailure: 'challenge' })]);
    expect(fake.open).toBe(0);
  });

  it('Sol b15b 2: a same-address replacement confirmed by the navigation watcher during settlement keeps the first pass', async () => {
    vi.useFakeTimers();
    try {
      let doc = 'document 1', completing = false, settling = false;
      const sequence: string[] = [];
      const navigated: ((frame: unknown) => void)[] = [];
      const frame = { url: () => 'https://e.org/p0' } as ReturnType<NonNullable<PageLike['mainFrame']>>;
      const fake = fakeProbeBrowser({ evaluate(name) {
        if (name === 'documentId') {
          if (completing) sequence.push(doc);
          return doc;
        }
        if (name === '' && completing && !settling) {
          settling = true;
          sequence.push('settlement starts');
          setTimeout(() => { doc = 'document 2'; navigated.forEach((fn) => fn(frame)); }, 20);
          return new Promise((resolve) => setTimeout(() => { sequence.push('settlement answers'); resolve(0); }, 250));
        }
        return undefined;
      } });
      const browser: BrowserLike = { async newContext(options) {
        const context = await fake.browser.newContext(options);
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          const page = await newPage();
          page.mainFrame = () => frame;
          page.on = ((event: string, fn: (frame: unknown) => void) => { if (event === 'framenavigated') navigated.push(fn); }) as PageLike['on'];
          return page;
        };
        return context;
      } };
      const mover = withLate({ timeoutMs: 2000, async run() { sequence.push('late failure'); completing = true; return [{ ...FAILED, detail: 'late failure' }]; } });
      const running = runProbes(browser, [{ url: 'https://e.org/p0', index: 0 }], [mover], { userAgent: 't', settleMs: 0 });
      await vi.advanceTimersByTimeAsync(5000);
      const [result] = await running;
      expect(sequence).toEqual(['late failure', 'document 1', 'document 1', 'settlement starts', 'document 2', 'settlement answers']);
      expect(result!.findings).toEqual([FAILED]);
      expect(fake.open).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each([
    { status: 'failed', replace: true }, { status: 'no_failures_found', replace: true },
    { status: 'failed', replace: false }, { status: 'no_failures_found', replace: false },
  ] as const)('Sol b15b r2: late $status, replacement during settlement: $replace', async ({ status, replace }) => {
    vi.useFakeTimers();
    try {
      let doc = 'document 1', completing = false, settling = false, settled = false;
      const sequence: string[] = [];
      const navigated: ((frame: unknown) => void)[] = [];
      const frame = { url: () => 'https://e.org/p0' } as ReturnType<NonNullable<PageLike['mainFrame']>>;
      const fake = fakeProbeBrowser({ evaluate(name) {
        if (name === 'documentId') {
          if (completing) sequence.push(settled ? `acceptance ${doc}` : doc);
          if (settling && !settled) return new Promise((resolve) => setTimeout(() => { sequence.push('watcher answers'); resolve(doc); }, 500));
          return doc;
        }
        if (name === '' && completing && !settling) {
          settling = true;
          sequence.push('settlement starts');
          if (replace) setTimeout(() => { doc = 'document 2'; navigated.forEach((fn) => fn(frame)); }, 20);
          return new Promise((resolve) => setTimeout(() => { settled = true; sequence.push('settlement answers'); resolve(0); }, 250));
        }
        return undefined;
      } });
      const browser: BrowserLike = { async newContext(options) {
        const context = await fake.browser.newContext(options);
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          const page = await newPage();
          page.mainFrame = () => frame;
          page.on = ((event: string, fn: (frame: unknown) => void) => { if (event === 'framenavigated') navigated.push(fn); }) as PageLike['on'];
          return page;
        };
        return context;
      } };
      const late: ProbeFinding = { ...FAILED, status, detail: 'late result' };
      const mover = withLate({ timeoutMs: 2000, async run() { sequence.push('late result'); completing = true; return [late]; } });
      const running = runProbes(browser, [{ url: 'https://e.org/p0', index: 0 }], [mover], { userAgent: 't', settleMs: 0 });
      await vi.advanceTimersByTimeAsync(5000);
      const [result] = await running;
      expect(sequence).toEqual([
        'late result', 'document 1', ...(status === 'failed' ? ['document 1'] : []),
        'settlement starts', ...(replace && status === 'failed' ? ['document 2'] : []), 'settlement answers',
        `acceptance document ${replace ? 2 : 1}`, ...(replace && status === 'failed' ? ['watcher answers'] : []),
      ]);
      expect(result!.findings).toEqual(replace ? [FAILED] : [late]);
      expect(fake.open).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(['deadline', 'cancel', 'own-box'] as const)('Sol b15b r2: a hung final acceptance read takes the existing %s and keeps the first pass', async (mode) => {
    vi.useFakeTimers();
    try {
      let completing = false, settling = false, settled = false, checked = false, checkedAt = 0, startedAt = 0, endedAt = 0;
      const stop = new AbortController();
      const fake = fakeProbeBrowser({ evaluate(name) {
        if (name === 'documentId' && settled) {
          checked = true;
          checkedAt = Date.now();
          if (mode === 'cancel') setTimeout(() => stop.abort(), 20);
          return new Promise(() => {});
        }
        if (name === '' && completing && !settling) {
          settling = true;
          return new Promise((resolve) => setTimeout(() => { settled = true; resolve(0); }, 20));
        }
        return undefined;
      } });
      const mover = withLate({ timeoutMs: 100, async run() { completing = true; startedAt = Date.now(); return [{ ...FAILED, detail: 'unconfirmed late failure' }]; } });
      const running = runProbes(fake.browser, [{ url: 'https://e.org/p0', index: 0 }], [mover], {
        userAgent: 't', settleMs: 0, signal: stop.signal, ...(mode === 'deadline' ? { deadline: Date.now() + 60 } : {}),
      }).then((runs) => { endedAt = Date.now(); return runs; });
      await vi.advanceTimersByTimeAsync(5000);
      const [result] = await running;
      expect(checked).toBe(true);
      expect(endedAt - (mode === 'cancel' ? checkedAt : startedAt)).toBeLessThanOrEqual(mode === 'deadline' ? 60 : mode === 'cancel' ? 20 : 100);
      expect(result!.findings).toEqual([FAILED]);
      expect(fake.open).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each([true, false])('Sol b15b 1: late completion settles after cancellation (%s); only an uncancelled pass adds its late finding', async (cancel) => {
    vi.useFakeTimers();
    try {
      const stop = new AbortController();
      const sequence: string[] = [];
      let completing = false, settling = false;
      const clean: ProbeFinding = { ...FAILED, status: 'no_failures_found', detail: 'first pass clean' };
      const late: ProbeFinding = { ...FAILED, detail: 'late failure' };
      const fake = fakeProbeBrowser({ evaluate(name) {
        if (name === 'documentId' && completing) sequence.push('completion identity');
        if (name === '' && completing && !settling) {
          settling = true;
          sequence.push('settlement starts');
          if (cancel) setTimeout(() => { sequence.push('cancel'); stop.abort(); }, 20);
          return new Promise((resolve) => setTimeout(() => { sequence.push('settlement answers'); resolve(0); }, 250));
        }
        return undefined;
      } });
      const mover: PageProbe = {
        ...withLate({ timeoutMs: 2000, async run() { sequence.push('late failure'); completing = true; return [late]; } }),
        async run() { sequence.push('first clean'); return [clean]; },
      };
      const running = runProbes(fake.browser, [{ url: 'https://e.org/p0', index: 0 }], [mover], { userAgent: 't', settleMs: 0, signal: stop.signal });
      await vi.advanceTimersByTimeAsync(5000);
      const [result] = await running;
      expect(sequence).toEqual(['first clean', 'late failure', 'completion identity', 'completion identity', 'settlement starts', ...(cancel ? ['cancel'] : []), 'settlement answers', ...(!cancel ? ['completion identity'] : [])]);
      expect(result!.findings).toEqual(cancel ? [clean] : [late]);
      expect(fake.open).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each([0, 1])('a timing test that needs untouched timers: late passes keep their original session (fired: %s)', async (fired) => {
    const calls: number[] = [];
    const fake = fakeProbeBrowser({ evaluate: (name) => name === 'firedCount' ? fired : undefined });
    const mover = withLate({ timeoutMs: 2000, async run(ctx, first) { calls.push(fake.contextOf(ctx.page)); return [...first]; } });
    const timer = { ...timing, freshAfterFiredTimers: true as const };
    const runs = await runProbes(fake.browser, [{ url: 'https://e.org/p0', index: 0 }], [mover, timer], { userAgent: 't', settleMs: 0 });
    expect(fake.contexts).toBe(fired ? 2 : 1);
    expect(calls).toEqual(fired ? [] : [0]);
    expect(runs.find((r) => r.probe === 'mover')!.findings).toEqual([FAILED]);
  });

  it('a document replaced during a completed late pass keeps the first pass', async () => {
    let doc = 1;
    const fake = fakeProbeBrowser({ evaluate: (name) => name === 'documentId' ? `doc${doc}` : undefined });
    const mover = withLate({ timeoutMs: 2000, async run() { doc++; return [{ ...FAILED, detail: 'from a replacement document' }]; } });
    const runs = await runProbes(fake.browser, [{ url: 'https://e.org/p0', index: 0 }], [mover, timing], { userAgent: 't', settleMs: 0 });
    expect(runs.find((r) => r.probe === 'mover')!.findings).toEqual([FAILED]);
  });

  it.each(['deadline', 'cancel', 'own-box'] as const)('a hung late admission takes the shared %s and keeps every first pass', async (mode) => {
    vi.useFakeTimers();
    try {
      let admitting = false, admittedAt = 0, endedAt = 0;
      const stop = new AbortController();
      const fake = fakeProbeBrowser({ evaluate: (name) => name === 'documentId' && admitting ? new Promise(() => {}) : undefined });
      const mover = withLate({ timeoutMs: 100, async run() { throw new Error('must not enter'); } });
      const running = runProbes(fake.browser, [{ url: 'https://e.org/p0', index: 0 }], [mover, timing], {
        userAgent: 't', settleMs: 0, signal: stop.signal,
        ...(mode === 'deadline' ? { deadline: Date.now() + 100 } : {}),
        onRun(run) {
          if (run.probe === 'timer') {
            admitting = true; admittedAt = Date.now();
            if (mode === 'cancel') setTimeout(() => stop.abort(), 20);
          }
        },
      }).then((runs) => { endedAt = Date.now(); return runs; });
      await vi.advanceTimersByTimeAsync(10_000);
      const runs = await running;
      expect(endedAt - admittedAt).toBeLessThanOrEqual(mode === 'cancel' ? 20 : 100);
      expect(runs.find((r) => r.probe === 'mover')!.findings).toEqual([FAILED]);
    } finally { vi.useRealTimers(); }
  });

  it('a hung completion identity read stays inside the late pass time box', async () => {
    vi.useFakeTimers();
    try {
      let completing = false, startedAt = 0, endedAt = 0;
      const fake = fakeProbeBrowser({ evaluate: (name) => name === 'documentId' && completing ? new Promise(() => {}) : undefined });
      const mover = withLate({ timeoutMs: 100, async run() { completing = true; startedAt = Date.now(); return [{ ...FAILED, detail: 'unconfirmed late result' }]; } });
      const running = runProbes(fake.browser, [{ url: 'https://e.org/p0', index: 0 }], [mover, timing], { userAgent: 't', settleMs: 0 })
        .then((runs) => { endedAt = Date.now(); return runs; });
      await vi.advanceTimersByTimeAsync(10_000);
      const runs = await running;
      expect(endedAt - startedAt).toBeLessThanOrEqual(100);
      expect(runs.find((r) => r.probe === 'mover')!.findings).toEqual([FAILED]);
    } finally { vi.useRealTimers(); }
  });

  it('bot evidence during late admission keeps all first passes and enters no late probe', async () => {
    let admitting = false, entered = 0;
    let guard: Parameters<NonNullable<PageProbe['late']>['run']>[0]['guard'];
    const fake = fakeProbeBrowser({ evaluate: (name) => {
      if (name === 'documentId' && admitting) (guard.events as GuardEvent[]).push({ kind: 'blocked', method: 'POST', url: 'https://e.org/_sec/verify', reason: 'method', at: Date.now() });
      return undefined;
    } });
    const mover = withLate({ timeoutMs: 2000, async run() { entered++; return []; } });
    mover.run = async (ctx) => { guard = ctx.guard; return [FAILED]; };
    const second = { ...mover, id: 'second' };
    const runs = await runProbes(fake.browser, [{ url: 'https://e.org/p0', index: 0 }], [mover, second, timing], {
      userAgent: 't', settleMs: 0, onRun(run) { if (run.probe === 'timer') admitting = true; },
    });
    expect(entered).toBe(0);
    for (const id of ['mover', 'second']) expect(runs.find((r) => r.probe === id)!.findings).toEqual([FAILED]);
  });

  it('run after every other test of the page, and their findings are the test\'s', async () => {
    const r = await run(withLate({ timeoutMs: 2000, async run(_ctx, first) { order.push('late'); return [...first, { criterion: '2.2.2', status: 'failed', detail: 'found late' }]; } }));
    expect(order).toEqual(['first', 'timing', 'late']);
    expect(r.findings.map((f) => f.detail)).toEqual(['found by the first pass', 'found late']);
  });

  it('a late pass that throws keeps the first pass exactly (its failure included)', async () => {
    const r = await run(withLate({ timeoutMs: 2000, async run() { throw new Error('the second inventory failed'); } }));
    expect(r.status).toBe('ok');
    expect(r.findings).toEqual([FAILED]);
  });

  it('a late pass that times out keeps the first pass exactly', async () => {
    const r = await run(withLate({ timeoutMs: 100, run: () => new Promise<ProbeFinding[]>(() => {}) }));
    expect(r.status).toBe('ok');
    expect(r.findings).toEqual([FAILED]);
  }, 20_000);

  it('Sol r3 2: a late pass that times out retires the session: no later late pass runs on it, and its first pass stands', async () => {
    const calls: string[] = [];
    const second: PageProbe = {
      id: 'sound', criteria: ['1.4.2'], kind: 'interaction', tier: 'core', timeoutMs: 2000,
      async run() { return [{ criterion: '1.4.2', status: 'no_failures_found', detail: 'first pass of the second test' }]; },
      late: { timeoutMs: 2000, async run() { calls.push('second late'); return [{ criterion: '1.4.2', status: 'failed', detail: 'late' }]; } },
    };
    const fake = fakeProbeBrowser();
    const runs = await runProbes(fake.browser, [{ url: 'https://e.org/p0', index: 0 }], [withLate({ timeoutMs: 100, run: () => new Promise<ProbeFinding[]>(() => {}) }), second, timing], { userAgent: 't', settleMs: 0 });
    expect(calls).toEqual([]);
    expect(runs.find((r) => r.probe === 'mover')!.findings).toEqual([FAILED]);
    expect(runs.find((r) => r.probe === 'sound')!.findings.map((f) => f.detail)).toEqual(['first pass of the second test']);
  }, 20_000);

  it('Sol r3 3: a page loaded again (another document at the same address) before the late pass: the first pass stands, the late pass never runs', async () => {
    let doc = 1;
    const calls: string[] = [];
    const reloads: PageProbe = { ...timing, id: 'reloads', async run() { doc++; return [{ criterion: '2.2.1', status: 'no_failures_found', detail: 'none' }]; } };
    const fake = fakeProbeBrowser({ evaluate: (name) => (name === 'documentId' ? `doc${doc}` : undefined) });
    const runs = await runProbes(fake.browser, [{ url: 'https://e.org/p0', index: 0 }], [withLate({ timeoutMs: 2000, async run() { calls.push('late'); return [{ criterion: '2.2.2', status: 'failed', detail: 'late' }]; } }), reloads], { userAgent: 't', settleMs: 0 });
    expect(calls).toEqual([]);
    expect(runs.find((r) => r.probe === 'mover')!.findings).toEqual([FAILED]);
  }, 20_000);
});
