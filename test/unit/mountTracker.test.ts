// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// fix/late-mount, review r2 (Sol 5): the content counts as mounted only when completed looks have found the
// page mounted over at least MOUNT_HOLD_MS, and never while a look is still out (a stalled look certifies
// nothing; one that does not answer ends the watch as not mounted).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOUNT_HOLD_MS, trackMount } from '../../src/probes/mounting.js';
import type { PageLike } from '../../src/types.js';

afterEach(() => { vi.restoreAllMocks(); });

/** `Date.now()` from now on, moved by `jump()` (a wall-clock correction); real time is `performance.now()`. */
function wallClock() {
  const real = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => real() + offset);
  return { jump: (ms: number) => { offset += ms; } };
}

/** A page whose looks answer from `answers` in turn; past the end, they never answer. */
const pageOf = (answers: boolean[]): PageLike => {
  let i = 0;
  return { evaluate: () => (i < answers.length ? Promise.resolve(answers[i++]) : new Promise(() => {})) } as unknown as PageLike;
};

describe('trackMount', () => {
  it('Sol r3 1: a slow first look (asked at 0, answered at 1.4 s) does not backdate the mount: answers 150 ms apart are not mounted', async () => {
    let n = 0;
    const page = { evaluate: () => (n++ === 0 ? new Promise((r) => setTimeout(() => r(false), 1400)) : Promise.resolve(false)) } as unknown as PageLike;
    const t0 = performance.now();
    const t = trackMount(page);
    // At about 1.6 s: answers at 1.4 s and 1.55 s only.
    const early = await t.settle(1600);
    expect(early.mounted).toBe(false);
    const later = await t.settle(2000);
    t.stop();
    expect(later.mounted).toBe(true);
    // Held from the first answer (1.4 s) for MOUNT_HOLD_MS.
    expect(performance.now() - t0).toBeGreaterThanOrEqual(1400 + MOUNT_HOLD_MS - 10);
  }, 10_000);

  it('Sol r4 2: a forward 10 s wall-clock jump while the confirming look is pending certifies nothing (holds are timed on the monotonic clock)', async () => {
    const clock = wallClock();
    let n = 0;
    // Answers: mounted at once, then (150 ms later) a confirming look that answers 24 ms after it is asked (174 ms after the first), during which the clock jumps 10 s.
    const page = {
      evaluate: () => {
        n++;
        if (n === 2) return new Promise((r) => setTimeout(() => { clock.jump(10_000); setTimeout(() => r(false), 14); }, 10));
        return Promise.resolve(false);
      },
    } as unknown as PageLike;
    const t0 = performance.now();
    const t = trackMount(page);
    const r = await t.settle(300);
    const real = performance.now() - t0;
    t.stop();
    expect(r.mounted).toBe(false);
    expect(real).toBeLessThan(MOUNT_HOLD_MS);
  });

  it('Sol r4 2: a 1 s backward wall-clock jump keeps settle(300) at about 300 ms', async () => {
    const clock = wallClock();
    // A page that stays mounting: settle runs to its bound.
    const t = trackMount({ evaluate: () => Promise.resolve(true) } as unknown as PageLike);
    const t0 = performance.now();
    const settling = t.settle(300);
    setTimeout(() => clock.jump(-1000), 20);
    const r = await settling;
    const real = performance.now() - t0;
    t.stop();
    expect(r.mounted).toBe(false);
    expect(real).toBeGreaterThanOrEqual(290);
    expect(real).toBeLessThan(600);
    expect(Math.abs(r.ms - real)).toBeLessThan(50);
  });

  it('Sol input A: one look says mounted and the next never answers: not mounted (the pending look blocks it)', async () => {
    const t = trackMount(pageOf([false]));
    const r = await t.settle(1000);
    t.stop();
    expect(r.mounted).toBe(false);
  });

  it('a look that never answers ends the watch as not mounted (failed), within the look bound', async () => {
    const t = trackMount(pageOf([]));
    const t0 = Date.now();
    const r = await t.settle(4000);
    t.stop();
    expect(r).toMatchObject({ mounted: false, failed: true });
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('completed looks that find it mounted over the hold: mounted, held from the first of them', async () => {
    const t0 = performance.now();
    const t = trackMount(pageOf([true, true, ...Array<boolean>(20).fill(false)]));
    const r = await t.settle(3000);
    t.stop();
    expect(r.mounted).toBe(true);
    // Two busy looks (150 ms apart), then the hold.
    expect(performance.now() - t0).toBeGreaterThanOrEqual(250 + MOUNT_HOLD_MS);
  });

  it('busy again before the hold ends starts the hold over', async () => {
    const t0 = performance.now();
    const t = trackMount(pageOf([false, false, true, ...Array<boolean>(20).fill(false)]));
    const r = await t.settle(4000);
    t.stop();
    expect(r.mounted).toBe(true);
    // The run that counts began after the third look (the busy one).
    expect(performance.now() - t0).toBeGreaterThanOrEqual(400 + MOUNT_HOLD_MS);
  });
});
