// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// fix/late-mount, review r2 (Sol 1, 2, 6, 11): no merging of axe runs. When the page settled (a fade at rest,
// content mounted), the later axe run IS the result for that width; the earlier run is the result only when
// there is no later run (not ready, another document, the run threw or did not finish), and every wait is
// bounded.
import { describe, expect, it } from 'vitest';
import { laterAxe } from '../../src/axeLater.js';
import type { AxeRuleLite, AxeRun } from '../../src/types.js';

const rule = (id: string, ...targets: string[]): AxeRuleLite => ({ id, impact: 'serious', help: id, helpUrl: `https://x/${id}`, nodes: targets.map((target) => ({ target, html: `<a>${target}</a>` })) });
const run = (o: Partial<AxeRun>): AxeRun => ({ violations: [], incomplete: [], passes: [], inapplicable: [], ...o });
const never = <T>() => new Promise<T>(() => {});

describe('laterAxe: the later run is the result', () => {
  it('Sol 1: an element the page replaced leaves no stale failure (the later run passed the rule)', async () => {
    const first = run({ violations: [rule('target-size', '#a')] });
    const later = run({ inapplicable: ['target-size'] });
    expect((await laterAxe(first, { ready: async () => true, rerun: async () => later, sameDocument: () => true })).outcome).toBe(later);
  });

  it('Sol 2: an incomplete result of the later run stands (no earlier failure in its place)', async () => {
    const first = run({ violations: [rule('color-contrast', '#text')] });
    const later = run({ incomplete: [rule('color-contrast', '#text')] });
    const r = await laterAxe(first, { ready: async () => true, rerun: async () => later, sameDocument: () => true });
    expect(r.outcome.violations).toEqual([]);
    expect(r.outcome.incomplete.map((x) => x.id)).toEqual(['color-contrast']);
  });

  it('Sol 11: a failure inside a frame (#frame >>> #bad) is decided by the later run', async () => {
    const first = run({ violations: [rule('image-alt', '#frame >>> #bad')] });
    const later = run({ passes: ['image-alt'] });
    expect((await laterAxe(first, { ready: async () => true, rerun: async () => later, sameDocument: () => true })).outcome.violations).toEqual([]);
  });

  it('Sol 6: a later run that rejects, or never answers, gives back the earlier run within the bound', async () => {
    const first = run({ violations: [rule('label', '#f')] });
    expect((await laterAxe(first, { ready: async () => true, rerun: async () => { throw new Error('connection closed'); }, sameDocument: () => true })).outcome).toBe(first);
    const t0 = Date.now();
    const r = await laterAxe(first, { ready: async () => true, rerun: never, sameDocument: () => true, rerunMs: 300 });
    expect(r).toEqual({ outcome: first, later: false });
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('a wait that never answers, a page not ready, or another document: the earlier run, at once or within the bound', async () => {
    const first = run({ violations: [rule('label', '#f')] });
    const later = run({});
    const t0 = Date.now();
    expect((await laterAxe(first, { ready: never, rerun: async () => later, sameDocument: () => true, readyMs: 300 })).outcome).toBe(first);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect((await laterAxe(first, { ready: async () => false, rerun: async () => later, sameDocument: () => true })).outcome).toBe(first);
    expect((await laterAxe(first, { ready: async () => true, rerun: async () => later, sameDocument: () => false })).outcome).toBe(first);
    let calls = 0;
    // The page went to another document while the later run ran: that run is not the page's.
    expect((await laterAxe(first, { ready: async () => true, rerun: async () => later, sameDocument: () => (calls++ === 0) })).outcome).toBe(first);
  });
});
