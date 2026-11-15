// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.2.2: motion whose own timing ran more than 5 s is not passed for having stopped by itself (sim lab:
// a carousel that changed every 1.5 s for 8 s and then stopped was passed, "no longer moving").
import { describe, expect, it } from 'vitest';
import { MOTION_TIMER_RECHECK, timerDue, timerRanLong } from '../../src/probes/motion.js';

describe('a repeating timer the page cleared: did it change content by itself for more than 5 s?', () => {
  // Set at 0 ms, a run every 1.5 s; the test's own early runs ended at 2500 ms.
  const since = { setAt: 0, testedAt: 2500, delay: 1500 };
  it('the last change seen in its region is when it last changed it, whether or not that run also cleared it', () => {
    // A ticker every 2 s whose run at 6 s updates it and clears it: changed for 6 s (the review's case;
    // less one period it would be 4 s).
    expect(timerRanLong({ setAt: 0, testedAt: 2500, delay: 2000 }, { lastFiredAt: 6000, lastChangeAt: 6000 })).toBe(true);
    // An 8 s carousel: its last change is at 7.5 s, the run at 9 s only clears it.
    expect(timerRanLong(since, { lastFiredAt: 9000, lastChangeAt: 7500 })).toBe(true);
    // Carousels of 4.5 s and 5.5 s: the last change is at 3 s or 4.5 s.
    expect(timerRanLong(since, { lastFiredAt: 4500, lastChangeAt: 3000 })).toBe(false);
    expect(timerRanLong(since, { lastFiredAt: 6000, lastChangeAt: 4500 })).toBe(false);
  });
  it('no change seen: its last natural run less one period (that run may only have cleared it)', () => {
    expect(timerRanLong(since, { lastFiredAt: 9000 })).toBe(true);
    expect(timerRanLong(since, { lastFiredAt: 6000 })).toBe(false);
    expect(timerRanLong({ setAt: 0, testedAt: 2500, delay: 2000 }, { lastFiredAt: 6000 })).toBe(false);
  });
  it('nothing after the test\'s own early runs: nothing is known, never "ended"', () => {
    expect(timerRanLong(since, {})).toBe(false);
    expect(timerRanLong(since, { lastFiredAt: 2400, lastChangeAt: 2400 })).toBe(false);
    expect(timerRanLong({ setAt: 0, testedAt: 9500, delay: 1500 }, { lastFiredAt: 9000 })).toBe(false);
  });
});

describe('a repeating timer is judged only after it has run more than 5 s', () => {
  it('waits until 5 s and a margin after it was set, at most 5.5 s, never a negative time', () => {
    expect(MOTION_TIMER_RECHECK).toEqual({ marginMs: 500, maxWaitMs: 5500 });
    expect(timerDue({ setAt: 1000 }, 3000)).toBe(3500); // a 3 s carousel caught at 2 s: looked at again at 6.5 s
    expect(timerDue({ setAt: 1000 }, 7000)).toBe(0);
    expect(timerDue({ setAt: 1000 }, -10_000)).toBe(5500);
  });
});
