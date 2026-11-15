// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Review r4 of fix/late-mount: motion's look-again counts an element only when the test itself saw that same
// element (by identity) changing, and saw it changing again more than 5 s later (monotonic clock).
import { describe, expect, it } from 'vitest';
import { identityAt, pairsByElement, seenRanLong, type ShotIdentity } from '../../src/probes/motion.js';

describe('seenRanLong', () => {
  it('the same element, seen changing again more than 5 s after it was first seen changing: ran long', () => {
    expect(seenRanLong({ by: 1000, id: 7 }, { after: 6001, id: 7 })).toBe(true);
  });

  it('exactly 5 s, or less, is not more than 5 s', () => {
    expect(seenRanLong({ by: 1000, id: 7 }, { after: 6000, id: 7 })).toBe(false);
    expect(seenRanLong({ by: 1000, id: 7 }, { after: 5900, id: 7 })).toBe(false);
  });

  it('another element in the same place has its own clock (Sol r4 1: canvas A, then canvas B)', () => {
    expect(seenRanLong({ by: 1000, id: 7 }, { after: 9000, id: 8 })).toBe(false);
  });

  it('a region whose element could not be told is never counted', () => {
    expect(seenRanLong({ by: 1000, id: null }, { after: 9000, id: null })).toBe(false);
  });
});

// Review r5 (Sol 1): identity is taken right after each screenshot, and a pair of shots counts for an element
// only when that same element was there at both.
describe('pairsByElement', () => {
  const region = { x: 0, y: 0, w: 64, h: 64, pixels: 4096 };
  const at = (id: number): ShotIdentity => ({ x: [16, 32, 48], y: [16, 32, 48], hit: Array(9).fill(0), chains: [[id, 4096]] });
  const seen = (by: number, shots: readonly [number, number]) => ({ shots, by, after: by - 400, at: region });
  const r = { ...region, by: 500, after: 0, pairs: [seen(500, [0, 1]), seen(800, [1, 2]), seen(800, [0, 2])] };

  it('Sol r5 1: A at shots 1 and 2, B at shot 3: only the first pair counts, for A', () => {
    expect(pairsByElement([r], [at(1), at(1), at(2)])).toEqual([{ id: 1, pair: r.pairs[0] }]);
  });

  it('the same element at all three shots: every pair counts for it', () => {
    expect(pairsByElement([r], [at(1), at(1), at(1)]).map((p) => p.id)).toEqual([1, 1, 1]);
  });

  it('no identity for a shot (its sample failed): no pair with that shot counts', () => {
    expect(pairsByElement([r], [at(1), null, at(1)]).map((p) => p.pair.shots)).toEqual([[0, 2]]);
  });

  it('climbs to an element at least half the region, as before', () => {
    const chain: ShotIdentity = { ...at(7), chains: [[7, 100, 8, 3000, 9, 9000]] };
    expect(identityAt(chain, region, 400)).toBe(8);
  });

  it('uses only the exact centre sample, never a nearby point', () => {
    const grid = at(7);
    grid.hit[4] = -1; // (32,32), the actual centre: all its neighbours still hit element 7.
    expect(identityAt(grid, region, 400)).toBeNull();
    expect(identityAt(at(7), { x: 1, y: 0, w: 64, h: 64 }, 400)).toBeNull();
  });
});
