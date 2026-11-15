// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// After the audits, the core tests' page loads and the evidence pass's share one budget: each takes a
// turn of the scan's page gate (src/pace.ts `Pace.page`), so together they never load more pages at
// once than the limit, and the probe pool lent up comes back down when the limit drops.
import { describe, expect, it } from 'vitest';
import { captureEvidence } from '../../src/evidence/capture.js';
import { createPace } from '../../src/pace.js';
import { createProbeRunner } from '../../src/probes/runner.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike, ContextLike, PageLike } from '../../src/types.js';
import { fakeProbeBrowser } from '../helpers/probes.js';

const LOAD_MS = 15;

/** Loads of both kinds open now, and each load's start: how many were open with it and the limit then. */
function loads(pace: ReturnType<typeof createPace>) {
  let open = 0;
  const starts: { open: number; limit: number; at: number }[] = [];
  return {
    start() {
      open++;
      starts.push({ open, limit: pace.pages().limit, at: Date.now() });
      setTimeout(() => { open--; }, LOAD_MS);
    },
    starts,
  };
}

function evidenceBrowser(onLoad: () => void): BrowserLike {
  return {
    async newContext() {
      const ctx: ContextLike = {
        newPage: async () => ({
          goto: async () => { onLoad(); await new Promise((r) => setTimeout(r, LOAD_MS)); return { status: () => 200, url: () => 'x', headers: () => ({ 'content-type': 'text/html' }) }; },
          evaluate: async () => undefined as never,
          addScriptTag: async () => undefined,
          waitForTimeout: async () => undefined,
          screenshot: async () => new Uint8Array([0xff, 0xd8]),
          close: async () => undefined,
        } as unknown as PageLike),
        close: async () => undefined,
      };
      return ctx;
    },
  };
}

const quick: PageProbe = { id: 'q', criteria: ['2.1.1'], kind: 'interaction', tier: 'core', timeoutMs: 1000, run: async () => [{ criterion: '2.1.1', status: 'no_failures_found', detail: 'ok' }] };
const timeouts = { pageBudgetMs: 2_000, evalTimeoutMs: 50, shotTimeoutMs: 50, loadTimeoutMs: 500, closeTimeoutMs: 50, passBudgetMs: 10_000 };

describe('the page gate after the audits: core tests and evidence share it', () => {
  it('together they never load more pages at once than the limit, also after it steps down', async () => {
    let cap = 4;
    const pace = createPace({ concurrency: 8, start: 4, cap: () => cap });
    const l = loads(pace);
    const fake = fakeProbeBrowser({ delayFor: () => { l.start(); return LOAD_MS; } });
    const runner = createProbeRunner(fake.browser, [quick], {
      userAgent: 'test', pace, settleMs: 0, concurrency: 4,
      lendLimit: () => 2 * pace.pages().limit, loadTurn: () => pace.page(),
    });
    for (let i = 0; i < 40; i++) runner.add({ url: `https://e.org/t${i}`, index: i });
    // The audits ended: the pool is lent up to 8 contexts (two per page at once).
    runner.lend(2);
    runner.lend(2);
    const items = Array.from({ length: 30 }, (_, i) => ({ kind: 'start' as const, page: `https://e.org/e${i}` }));
    const evidence = captureEvidence(evidenceBrowser(() => l.start()), items, { userAgent: 'test', concurrency: 8, timeouts, pace });
    // Part way through, the limit drops to 2.
    let droppedAt = Infinity;
    setTimeout(() => { cap = 2; droppedAt = Date.now(); }, 80);
    await Promise.all([runner.finish(), evidence]);
    expect(l.starts.length).toBeGreaterThan(60);
    // Every load started within the limit of its moment (both kinds counted together).
    for (const s of l.starts.filter((x) => x.at < droppedAt)) expect(s.open).toBeLessThanOrEqual(4);
    // Once the loads that were already on their way at the drop are done, never more than 2.
    const after = l.starts.filter((x) => x.at > droppedAt + 3 * LOAD_MS);
    expect(after.length).toBeGreaterThan(10);
    for (const s of after) expect(s.open).toBeLessThanOrEqual(2);
    expect(pace.pages().limit).toBe(2);
    expect(pace.pages().active).toBe(0);
  });

  it('optional tests in extra tabs (perf/split-tests): more tabs, never more loads at once than the limit', async () => {
    const pace = createPace({ concurrency: 2 });
    const l = loads(pace);
    const fake = fakeProbeBrowser({ delayFor: () => { l.start(); return LOAD_MS; } });
    const slow: PageProbe = { ...quick, id: 'slow', isolate: true, run: async () => { await new Promise((r) => setTimeout(r, 40)); return [{ criterion: '2.1.1', status: 'no_failures_found', detail: 'ok' }]; } };
    const runner = createProbeRunner(fake.browser, [quick, slow], {
      userAgent: 'test', pace, settleMs: 0, concurrency: 2,
      optionalTabs: () => 6, loadTurn: () => pace.page(), optionalLoadTurn: () => pace.page({ low: true }),
    });
    for (let i = 0; i < 24; i++) runner.add({ url: `https://e.org/o${i}`, index: i }, ['slow'], { optional: ['slow'] });
    for (let i = 24; i < 30; i++) runner.add({ url: `https://e.org/r${i}`, index: i }, ['q']);
    const runs = await runner.finish();
    expect(runs).toHaveLength(30);
    // The tests used the extra tabs (more contexts than the room of 2) ...
    expect(fake.maxOpen).toBeGreaterThan(2);
    // ... and the site never had more than the page limit's loads at once.
    expect(l.starts.length).toBe(30);
    for (const s of l.starts) expect(s.open).toBeLessThanOrEqual(2);
    expect(pace.pages().active).toBe(0);
  });

  it('the probe pool lent up comes back down when the lend limit drops (never below its own concurrency)', async () => {
    let most = 8;
    const fake = fakeProbeBrowser({ delayFor: () => 20 });
    const runner = createProbeRunner(fake.browser, [quick], { userAgent: 'test', settleMs: 0, concurrency: 2, lendLimit: () => most });
    for (let i = 0; i < 200; i++) runner.add({ url: `https://e.org/p${i}`, index: i });
    runner.lend(6);
    await new Promise((r) => setTimeout(r, 60));
    const before = fake.maxOpen;
    most = 1;
    const seen: number[] = [];
    const watch = setInterval(() => seen.push(fake.events.filter((e) => e.type === 'newContext').length - fake.events.filter((e) => e.type === 'closeContext').length), 5);
    await new Promise((r) => setTimeout(r, 120));
    const late = seen.slice(-10);
    const stillQueued = runner.counts().queued - runner.counts().done;
    await runner.finish();
    clearInterval(watch);
    expect(before).toBeGreaterThan(2);
    // Work was still waiting, so a pool that did not come down would have kept up to 8 open.
    expect(stillQueued).toBeGreaterThan(20);
    expect(Math.max(...late)).toBeLessThanOrEqual(2);
  });
});
