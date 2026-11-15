// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The waits for late content and a moving layout (`PageProbe.waitFor`) never delay a test that judges what a
// page does by itself: on a shared page, the tests that wait run after all the others (review round 2 of
// fix/deny-guard: the headings test's content wait, first on the desktop page, pushed the keyboard walk up to
// 3 s later than on hosted/integration).
import { describe, expect, it, vi } from 'vitest';
import { probesFor, PROBES } from '../../src/probes/registry.js';
import { groupProbes, runProbes, waitersLater } from '../../src/probes/runner.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike } from '../../src/types.js';
import { fakeProbeBrowser } from '../helpers/probes.js';

describe('tests that wait run last on a shared page', () => {
  it.each(['unchanged', 'hash', 'reloaded'])('Sol b15b 4: consecutive waiters on a permanently busy document share its timeout (%s)', async (mode) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    try {
      let doc = 0, url = 'https://e.org/p0';
      const starts: number[] = [], documents: number[] = [];
      const fake = fakeProbeBrowser({
        statusFor: () => { doc++; return 200; },
        evaluate: (name) => name === 'stillMounting' ? true : name === 'documentId' ? doc : undefined,
      });
      const browser: BrowserLike = { async newContext(options) {
        const context = await fake.browser.newContext(options);
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          const page = await newPage();
          const goto = page.goto.bind(page);
          page.goto = async (...args) => { const response = await goto(...args); url = args[0]; return response; };
          page.url = () => url;
          return page;
        };
        return context;
      } };
      const waiter = (id: string): PageProbe => ({
        id, criteria: ['2.1.1'], kind: 'interaction', tier: 'core', timeoutMs: 1000, waitFor: { content: true },
        async run() {
          starts.push(Date.now()); documents.push(doc);
          if (id === 'first' && mode !== 'unchanged') url += mode === 'hash' ? '#history' : '/history';
          return [];
        },
      });
      const running = runProbes(browser, [{ url, index: 0 }], [waiter('first'), waiter('second')], { userAgent: 't', settleMs: 0 });
      await vi.advanceTimersByTimeAsync(10_000);
      await running;
      expect(documents).toEqual(mode === 'reloaded' ? [1, 2] : [1, 1]);
      if (mode === 'reloaded') expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(3000);
      else expect(starts[1]! - starts[0]!).toBeLessThan(20);
      expect(fake.open).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('in every group of the registry, no test that waits comes before one that does not; the keyboard test has only the non-waiting tests of its page before it', () => {
    for (const full of [false, true]) {
      const groups = groupProbes(probesFor({ full }));
      for (const g of groups) {
        // Every test that waits comes after every test that does not, up to the first test that types.
        const firstWait = g.probes.findIndex((p) => p.waitFor);
        if (firstWait >= 0) expect(g.probes.slice(firstWait).every((p) => p.waitFor || g.probes.slice(firstWait, g.probes.indexOf(p)).some((q) => q.sendsNothing) || p.sendsNothing), g.probes.map((p) => p.id).join(',')).toBe(true);
      }
      const kb = groups.find((g) => g.probes.some((p) => p.id === 'keyboard'))!;
      const registry = PROBES.filter((p) => kb.probes.includes(p));
      const before = (list: readonly PageProbe[]) => list.slice(0, list.findIndex((p) => p.id === 'keyboard')).map((p) => p.id);
      expect(before(kb.probes)).toEqual(before(registry).filter((id) => !PROBES.find((p) => p.id === id)!.waitFor));
      // The headings test is on that page and waits: it now runs after the keyboard test.
      expect(kb.probes.findIndex((p) => p.id === 'headings')).toBeGreaterThan(kb.probes.findIndex((p) => p.id === 'keyboard'));
    }
  });

  it('the tests that wait go just before the first test that types (no extra page load), or last', () => {
    const t = (id: string, extra: Partial<PageProbe> = {}): PageProbe => ({ id, criteria: ['2.1.1'], kind: 'render', tier: 'core', timeoutMs: 1, run: async () => [], ...extra });
    const w = { waitFor: { content: true as const } };
    const ids = (l: PageProbe[]) => l.map((p) => p.id);
    expect(ids(waitersLater([t('h', w), t('a'), t('kb'), t('forms', { sendsNothing: true }), t('live', { sendsNothing: true })]))).toEqual(['a', 'kb', 'h', 'forms', 'live']);
    expect(ids(waitersLater([t('h', w), t('a'), t('kb')]))).toEqual(['a', 'kb', 'h']);
    expect(ids(waitersLater([t('a'), t('kb')]))).toEqual(['a', 'kb']);
  });

  it('a page that never shows its content: the test that does not wait starts at once, the one that waits after it (and after its bounded wait)', async () => {
    const fake = fakeProbeBrowser({ evaluate: (name) => (name === 'stillMounting' ? true : undefined) });
    const at: Record<string, number> = {};
    let t0 = 0;
    const mk = (id: string, extra: Partial<PageProbe> = {}): PageProbe => ({
      id, criteria: ['2.1.1'], kind: 'interaction', tier: 'core', timeoutMs: 1000,
      async run() { at[id] = Date.now() - t0; return []; }, ...extra,
    });
    t0 = Date.now();
    await runProbes(fake.browser, [{ url: 'https://e.org/p0', index: 0 }], [mk('waits', { waitFor: { content: true } }), mk('keyboard-like')], { userAgent: 't', settleMs: 0 });
    expect(at['keyboard-like']!).toBeLessThan(at['waits']!);
    expect(at['keyboard-like']!).toBeLessThan(1000);
  }, 20_000);
});
