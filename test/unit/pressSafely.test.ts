// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Safety (review round 1, ruling 1): a test that presses controls runs only once no click on the page can
// save a file, and the page's own download links work again when it is done.
import { describe, expect, it } from 'vitest';
import { withoutDownloads } from '../../src/probes/pressSafely.js';
import { ProbeNotTestable, type ProbeContext } from '../../src/probes/types.js';

const ctxOf = (answer: (name: string) => unknown, calls: string[]): ProbeContext =>
  ({ page: { evaluate: async (fn: unknown) => { const name = (fn as { name?: string }).name ?? ''; calls.push(name); return answer(name); } } }) as unknown as ProbeContext;

describe('withoutDownloads', () => {
  it('presses nothing when the page could not be stopped from saving files: not testable, and the test never runs', async () => {
    for (const answer of [() => undefined, () => false, () => { throw new Error('the page is gone'); }]) {
      const calls: string[] = [];
      let ran = false;
      const run = withoutDownloads(async () => { ran = true; return []; });
      await expect(run(ctxOf(answer, calls))).rejects.toBeInstanceOf(ProbeNotTestable);
      expect(ran).toBe(false);
      expect(calls).toEqual(['stopDownloads']);
    }
  });
  it('look-alike: with the stop in place the test runs, and the stop is taken out again, also when the test breaks', async () => {
    const calls: string[] = [];
    const ok = withoutDownloads(async () => [{ criterion: '4.1.2', status: 'no_failures_found' as const, detail: 'x' }]);
    expect(await ok(ctxOf((n) => n === 'stopDownloads', calls))).toHaveLength(1);
    expect(calls).toEqual(['stopDownloads', 'undoDownloadStop']);
    const calls2: string[] = [];
    const broken = withoutDownloads(async () => { throw new Error('boom'); });
    await expect(broken(ctxOf((n) => n === 'stopDownloads', calls2))).rejects.toThrow('boom');
    expect(calls2).toEqual(['stopDownloads', 'undoDownloadStop']);
  });
});
