// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The simulation lab's pure parts (test/sim/): statistics, determinism of the generators, and that
// every case's expectation agrees with the numbers it was built from. No browser.
import { describe, expect, it } from 'vitest';
import { ratio, solve } from '../sim/color.js';
import { SIM_TESTS } from '../sim/index.js';
import { confusion, exactLowerNoErrors, wilsonLower } from '../sim/stats.js';
import { realisedHz } from '../sim/tests/flash.js';
import { isLarge } from '../sim/tests/textContrast.js';
import type { CaseResult } from '../sim/types.js';

describe('statistics', () => {
  it('Wilson lower bound (one-sided 95%)', () => {
    expect(wilsonLower(0, 0)).toBe(0);
    // 52/52 is the first all-correct run that clears 0.95; 51/51 does not.
    expect(wilsonLower(52, 52)).toBeGreaterThanOrEqual(0.95);
    expect(wilsonLower(51, 51)).toBeLessThan(0.95);
    expect(wilsonLower(59, 60)).toBeLessThan(0.95);
    expect(wilsonLower(50, 100)).toBeCloseTo(0.418, 2);
    expect(exactLowerNoErrors(59)).toBeGreaterThan(0.95);
    expect(exactLowerNoErrors(58)).toBeLessThan(0.95);
  });

  it('confusion: undecided failing pages are missed, undecided passing pages are not errors', () => {
    const r = (verdict: 'fail' | 'pass' | 'na', observed: CaseResult['observed']): CaseResult => ({
      id: `${verdict}-${observed}`, test: 't', criterion: '1.1.1', hazard: 'none', params: {}, expected: { verdict }, observed, observedCount: 0, details: [], why: '', ms: 0,
    });
    const [c] = confusion([r('fail', 'fail'), r('fail', 'pass'), r('fail', 'not_testable'), r('pass', 'pass'), r('pass', 'fail'), r('pass', 'timeout'), r('na', 'na')]);
    expect(c).toMatchObject({ tp: 1, fn: 2, undecidedPos: 1, fp: 1, tn: 2, undecidedNeg: 1, naRight: 1, cases: 7 });
    expect(c!.precision).toBeCloseTo(0.5);
    expect(c!.recall).toBeCloseTo(1 / 3);
    expect(c!.meets95).toBe(false);
  });
});

// Batch 19 precision lane: fixed sets of look-alikes built around one false-alarm class each (a pause control the
// vocabulary does not name, an on-screen keypad, independent sections, a field whose label tells of the change). They
// show a class is fixed beside the failures that must stay failed; they report their own counts and make no 95% claim.
const LOOK_ALIKE_SETS = new Set(['b19-pause', 'b19-keypad', 'b19-order', 'b19-on-input']);

describe('generators', () => {
  it('are deterministic and their ids are unique', () => {
    for (const t of SIM_TESTS) {
      const a = t.cases(1);
      const b = t.cases(1);
      if (!LOOK_ALIKE_SETS.has(t.id)) expect(a.length, t.id).toBeGreaterThan(50);
      expect(new Set(a.map((c) => c.id)).size, `${t.id}: duplicate ids`).toBe(a.length);
      expect(a.map((c) => c.site.files['/']), t.id).toEqual(b.map((c) => c.site.files['/']));
      for (const c of a) for (const k of t.criteria) expect(c.expect[k], `${c.id} has no expectation for ${k}`).toBeDefined();
    }
  });

  it('have enough failing and passing cases to support a 95% claim on each side', () => {
    // A lab of pages a fresh writer built (served as written, the writer's own expectations) is a fixed set, not a
    // generator: it reports its own Wilson bounds and need not reach 52 a side (b18-focus-writer: 17 failures, 43
    // look-alikes; the visual lane's precision check after its round-2 blind grade).
    const WRITTEN = new Set(['b18-focus-writer']);
    for (const t of SIM_TESTS) {
      if (WRITTEN.has(t.id) || LOOK_ALIKE_SETS.has(t.id)) continue;
      const cs = t.cases(1);
      const pos = cs.filter((c) => t.criteria.some((k) => c.expect[k]!.verdict === 'fail')).length;
      expect(pos, `${t.id}: failing cases`).toBeGreaterThanOrEqual(52);
      expect(cs.length - pos, `${t.id}: passing cases`).toBeGreaterThanOrEqual(52);
    }
  });

  it('flash: fails exactly above three flashes a second over more than 25% of the field', () => {
    const flash = SIM_TESTS.find((t) => t.id === 'flash')!;
    for (const c of flash.cases(1)) {
      const hz = Number(c.params.realisedHz);
      const area = Number(c.params.area);
      // A video at exactly 3 Hz is not counted (its frame timing is the player's, not the page's).
      expect(c.expect['2.3.1']!.verdict, c.id).toBe(c.params.mech === 'video' && hz === 3 ? 'any' : hz > 3 && area > 25 ? 'fail' : 'pass');
    }
    expect(realisedHz('gif', 3)).toBeCloseTo(100 / 34);
    expect(realisedHz('css', 3.5)).toBe(3.5);
  });

  it('contrast: the colours solved land on the side of the threshold the expectation says', () => {
    const s = solve([255, 255, 255], [0, 0, 0], [255, 255, 255], 4.5, 'above');
    expect(ratio(s.color, [255, 255, 255])).toBeGreaterThanOrEqual(4.505);
    expect(isLarge(18.67, 700)).toBe(true);
    expect(isLarge(18.5, 700)).toBe(false);
    expect(isLarge(23, 400)).toBe(false);
    expect(isLarge(24, 400)).toBe(true);
    const text = SIM_TESTS.find((t) => t.id === 'text-contrast')!;
    for (const c of text.cases(1)) {
      if (c.params.control) continue;
      const need = c.params.large ? 3 : 4.5;
      expect(c.expect['1.4.3']!.verdict, c.id).toBe(Number(c.params.actual) < need ? 'fail' : 'pass');
      // Nothing lands within 0.004 of the line (8-bit colours make an exact tie ambiguous).
      expect(Math.abs(Number(c.params.actual) - need), c.id).toBeGreaterThan(0.004);
    }
  });
});
