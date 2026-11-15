// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Review r5 of fix/late-mount (Sol 4): the motion tests' time left is on the monotonic clock, so a wall-clock
// correction neither uses up nor extends a time box.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasTime, timeLeft } from '../../src/probes/motionShared.js';
import type { ProbeContext } from '../../src/probes/types.js';

afterEach(() => { vi.restoreAllMocks(); });

const ctxOf = (ms: number) => ({ deadline: Date.now() + ms, ends: performance.now() + ms, signal: new AbortController().signal }) as unknown as ProbeContext;

describe('timeLeft', () => {
  it('a forward 20 s wall-clock jump does not use up a 25 s time box', () => {
    const ctx = ctxOf(25_000);
    const real = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => real() + 20_000);
    expect(timeLeft(ctx)).toBeGreaterThan(24_000);
    expect(hasTime(ctx, 9000)).toBe(true);
  });

  it('a backward wall-clock jump does not extend it', () => {
    const ctx = ctxOf(5000);
    const real = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => real() - 60_000);
    expect(timeLeft(ctx)).toBeLessThanOrEqual(5000);
    expect(hasTime(ctx, 9000)).toBe(false);
  });

  it('without a monotonic end (a context made outside the runner), the wall-clock deadline is used', () => {
    const ctx = { deadline: Date.now() + 3000, signal: new AbortController().signal } as unknown as ProbeContext;
    expect(timeLeft(ctx)).toBeLessThanOrEqual(3000);
  });
});
