// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Scoring rules that every version keeps: grade letters and when there is no score. The v5 formula
// itself is tested in scoreV5.test.ts.
import { describe, expect, it } from 'vitest';
import { letterFor, scoreSite } from '../../src/score.js';
import type { Impact, PageAudit, RuleOutcome } from '../../src/types.js';

const impactOf = (id: string): Impact => (id.startsWith('s') ? 'serious' : 'moderate');
const page = (url: string, rules: Record<string, RuleOutcome>, status: 'ok' | 'failed' = 'ok'): PageAudit => ({
  url, status, rules, violations: [], incomplete: [], links: [],
});
const passes = (n: number, prefix = 's'): Record<string, RuleOutcome> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, 'pass' as const]));

describe('letterFor', () => {
  it.each([[100, 'A'], [90, 'A'], [89, 'B'], [80, 'B'], [79, 'C'], [70, 'C'], [69, 'D'], [60, 'D'], [59, 'F'], [0, 'F']])(
    '%i → %s', (s, l) => expect(letterFor(s)).toBe(l),
  );
});

describe('scoreSite', () => {
  it('grants access at 90+', () => {
    const r = scoreSite([page('/a', passes(5))], impactOf);
    expect(r.score).toBe(100);
    expect(r.headline).toBe('Access Granted');
  });
  it('leaves failed pages out of the score', () => {
    const r = scoreSite([page('/a', passes(2)), page('/b', passes(2)), page('/c', passes(2)), page('/d', { s0: 'fail' }, 'failed')], impactOf);
    expect(r.score).toBe(100);
  });
  it('refuses to score when fewer than half the pages loaded', () => {
    const r = scoreSite([page('/a', passes(2)), page('/b', {}, 'failed'), page('/c', {}, 'failed'), page('/d', {}, 'failed')], impactOf);
    expect(r.status).toBe('incomplete');
    expect(r.score).toBeNull();
    expect(r.letter).toBeNull();
    expect(r.headline).toBe('Scan incomplete');
    expect(r.reasons[0]).toMatch(/1 of 4 pages/);
  });
  it('refuses to score with fewer than 3 loaded pages when 3+ were selected', () => {
    const r = scoreSite([page('/a', passes(2)), page('/b', passes(2)), page('/c', {}, 'failed'), page('/d', {}, 'failed')], impactOf);
    expect(r.status).toBe('incomplete');
  });
  it('scores a single-page site', () => {
    expect(scoreSite([page('/a', passes(2))], impactOf).status).toBe('scored');
  });
  it('reports the points each failing rule costs', () => {
    // One names rule (7) at share 1: 100 − 18 × ln 1.7 = 90.45 → 90, fixed 100.
    const r = scoreSite([page('/a', { sa: 'pass', sb: 'fail' })], impactOf);
    expect(r.score).toBe(90);
    expect(r.pointsLost).toEqual({ sb: 10 });
  });
});
