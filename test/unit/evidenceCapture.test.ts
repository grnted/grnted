// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// captureEvidence with a stand-in browser: time limits, failures and closing every context.
import { describe, expect, it } from 'vitest';
import { captureEvidence } from '../../src/evidence/capture.js';
import { createPace } from '../../src/pace.js';
import { createEvidenceRecorder, runEvidencePass } from '../../src/evidence/index.js';
import type { BrowserLike, ContextLike, PageAudit, PageLike, ResponseLike } from '../../src/types.js';

const never = <T>() => new Promise<T>(() => undefined);
const okResponse: ResponseLike = { status: () => 200, url: () => 'x', headers: () => ({ 'content-type': 'text/html' }) };

function fakeBrowser(page: Partial<PageLike>, opts: { contextDelayMs?: number } = {}) {
  const stats = { opened: 0, closed: 0, shots: 0 };
  const browser: BrowserLike = {
    async newContext() {
      if (opts.contextDelayMs) await new Promise((r) => setTimeout(r, opts.contextDelayMs));
      stats.opened++;
      const ctx: ContextLike = {
        newPage: async () => ({
          goto: async () => okResponse,
          evaluate: async () => undefined as never,
          addScriptTag: async () => undefined,
          waitForTimeout: async () => undefined,
          screenshot: async () => { stats.shots++; return new Uint8Array([0xff, 0xd8]); },
          close: async () => undefined,
          ...page,
        } as PageLike),
        close: async () => { stats.closed++; },
      };
      return ctx;
    },
  };
  return { browser, stats };
}

const items = [
  { kind: 'start' as const, page: 'https://e.org/' },
  { kind: 'rule' as const, page: 'https://e.org/a', rule: 'r', help: 'h', targets: ['#a'] },
];
const fast = { pageBudgetMs: 300, evalTimeoutMs: 50, shotTimeoutMs: 50, loadTimeoutMs: 100, closeTimeoutMs: 50, passBudgetMs: 2_000 };

describe('captureEvidence and the page gate', () => {
  it('each load takes a turn of the scan\'s page gate: never more at once than its limit', async () => {
    let open = 0;
    let most = 0;
    const { browser } = fakeBrowser({
      goto: async () => { open++; most = Math.max(most, open); await new Promise((r) => setTimeout(r, 20)); open--; return okResponse; },
    });
    const pace = createPace({ concurrency: 2 });
    const many = Array.from({ length: 8 }, (_, i) => ({ kind: 'start' as const, page: `https://e.org/p${i}` }));
    const shots = await captureEvidence(browser, many, { userAgent: 'test', concurrency: 6, timeouts: fast, pace });
    expect(shots.filter(Boolean).length).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(2);
    expect(pace.pages().active).toBe(0);
  });

  it('a stopped scan takes no more evidence loads', async () => {
    const { browser, stats } = fakeBrowser({});
    const pace = createPace({ concurrency: 2 });
    pace.stop();
    const shots = await captureEvidence(browser, items, { userAgent: 'test', concurrency: 2, timeouts: fast, pace });
    expect(shots).toEqual([null, null]);
    expect(stats.opened).toBe(0);
  });
});

describe('captureEvidence time limits and failures', () => {
  it('gives up on a page that never loads within its budget and closes its context', async () => {
    const { browser, stats } = fakeBrowser({ goto: () => never() });
    const t0 = Date.now();
    expect(await captureEvidence(browser, items, { userAgent: 'x', timeouts: fast })).toEqual([null, null]);
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(stats).toMatchObject({ opened: 2, closed: 2, shots: 0 });
  });

  it('times out a page script or screenshot that hangs, item by item', async () => {
    const { browser, stats } = fakeBrowser({ evaluate: () => never(), screenshot: () => never() });
    expect(await captureEvidence(browser, items, { userAgent: 'x', timeouts: { ...fast, pageBudgetMs: 2_000 } })).toEqual([null, null]);
    expect(stats.closed).toBe(stats.opened);
  });

  it('starts no page after the pass budget, and still closes a context that opens late', async () => {
    const { browser, stats } = fakeBrowser({ goto: () => never() }, { contextDelayMs: 400 });
    const many = Array.from({ length: 5 }, (_, i) => ({ kind: 'start' as const, page: `https://e.org/${i}` }));
    const t0 = Date.now();
    expect(await captureEvidence(browser, many, { userAgent: 'x', concurrency: 1, timeouts: { ...fast, pageBudgetMs: 100, passBudgetMs: 250 } })).toEqual([null, null, null, null, null]);
    expect(Date.now() - t0).toBeLessThan(1_000);
    await new Promise((r) => setTimeout(r, 600));
    expect(stats.closed).toBe(stats.opened);
    expect(stats.opened).toBeLessThanOrEqual(3);
  });

  it('skips a page that answers with an error, or that is not HTML', async () => {
    for (const resp of [{ ...okResponse, status: () => 500 }, { ...okResponse, headers: () => ({ 'content-type': 'application/pdf' }) }, null]) {
      const { browser, stats } = fakeBrowser({ goto: async () => resp });
      expect(await captureEvidence(browser, items, { userAgent: 'x', timeouts: fast })).toEqual([null, null]);
      expect(stats.shots).toBe(0);
      expect(stats.closed).toBe(stats.opened);
    }
  });

  it('stops on a page that navigated itself away after load', async () => {
    let n = 0;
    const { browser, stats } = fakeBrowser({ url: () => (n++ === 0 ? 'https://e.org/' : 'https://elsewhere.example/') });
    expect(await captureEvidence(browser, [items[0]!], { userAgent: 'x', timeouts: fast })).toEqual([null]);
    expect(stats.shots).toBe(0);
  });

  it('survives a throwing browser and a throwing sink; the recorder never goes over its room', async () => {
    const throwing: BrowserLike = { newContext: async () => { throw new Error('boom'); } };
    const rec = createEvidenceRecorder({ sink: () => { throw new Error('sink'); }, maxImages: 2 });
    const page: PageAudit = { url: 'https://e.org/', status: 'ok', rules: {}, violations: [], incomplete: [], links: [] };
    await expect(runEvidencePass(throwing, rec, { pages: [page], userAgent: 'x' })).resolves.toBeUndefined();
    const { browser } = fakeBrowser({});
    await runEvidencePass(browser, rec, { pages: [page], userAgent: 'x', timeouts: fast });
    expect(rec.shots()).toEqual([]);
    // A reserve larger than the room plans nothing.
    const { browser: b2, stats } = fakeBrowser({});
    await runEvidencePass(b2, createEvidenceRecorder({ sink: () => undefined, maxImages: 2 }), { pages: [page], userAgent: 'x', reserve: 5 });
    expect(stats.opened).toBe(0);
  });
});
