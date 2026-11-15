// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { expect } from 'vitest';

/**
 * Hostile-input timing helpers. The machine is shared, so nothing here trusts one wall-clock reading:
 * each sample repeats the call until it has run for `minMs`, and the best of several samples is kept.
 */

/** Milliseconds per call: the best of `samples` runs, each repeating `fn` until `minMs` have passed. */
export function msPerCall(fn: () => unknown, samples = 3, minMs = 15): number {
  let best = Infinity;
  for (let s = 0; s < samples; s++) {
    let calls = 0;
    const t0 = performance.now();
    let elapsed = 0;
    do {
      fn();
      calls++;
      elapsed = performance.now() - t0;
    } while (elapsed < minMs);
    best = Math.min(best, elapsed / calls);
  }
  return best;
}

/** Best wall time of one call over `samples` runs (for inputs big enough to time on their own). */
export function msOnce(fn: () => unknown, samples = 2): number {
  let best = Infinity;
  for (let s = 0; s < samples; s++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/**
 * Linear scaling: four times the input costs at most `factor` times as much per call (6x leaves room for
 * noise; quadratic code gives 16x, the old sitemap regex about 1000x). `slackMs` absorbs timer noise on
 * inputs that run in microseconds. Both sizes are warmed up first (compiled, caches filled), then timed in
 * alternating rounds and the best of each kept: a busy spell on a shared machine (other test workers, a
 * collection) falls on both sizes alike instead of on whichever ran during it. One pass of each, small then
 * big, read 8.9x for a linear merge on the CI runner (2026-11-09).
 */
export function expectLinear(make: (n: number) => () => unknown, n: number, factor = 6, slackMs = 0.05, rounds = 5): void {
  const smallFn = make(n);
  const bigFn = make(4 * n);
  msPerCall(smallFn, 1, 5);
  msPerCall(bigFn, 1, 5);
  let small = Infinity;
  let big = Infinity;
  for (let r = 0; r < rounds; r++) {
    small = Math.min(small, msPerCall(smallFn, 1));
    big = Math.min(big, msPerCall(bigFn, 1));
  }
  expect(big, `n=${n}: ${small.toFixed(4)} ms, 4n: ${big.toFixed(4)} ms`).toBeLessThanOrEqual(factor * small + slackMs);
}
