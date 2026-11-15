// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The live screen's "score so far" (scoring v5 from the axe results of the pages done so far): the
// engine's own formula, in a light module the web app can bundle (scoreCore.ts imports only the
// rule groups), so the web never re-implements it.
import { describe, expect, it } from 'vitest';
import { axeSiteScore } from '../../src/scoreCore.js';
import { defaultImpactOf, scoreSite } from '../../src/score.js';
import type { PageAudit, RuleOutcome } from '../../src/types.js';

const page = (url: string, rules: Record<string, RuleOutcome>): PageAudit => ({ url, status: 'ok', rules, violations: [], incomplete: [], links: [] });
/** What a page-done event carries for a page: its failing rules with the scoring table's impact. */
const hits = (p: PageAudit) => Object.entries(p.rules).filter(([, o]) => o === 'fail').map(([id]) => ({ id, impact: defaultImpactOf(id), count: 1 }));

describe('axeSiteScore', () => {
  it('equals scoreSite for the same loaded pages when no core test ran', () => {
    const sets: PageAudit[][] = [
      [page('/a', { 'image-alt': 'fail', 'color-contrast': 'pass' }), page('/b', { 'image-alt': 'pass', 'color-contrast': 'fail' }), page('/c', { 'link-name': 'fail', list: 'fail' })],
      Array.from({ length: 25 }, (_, i) => page(`/p${i}`, { 'color-contrast': i < 20 ? 'fail' : 'pass', 'image-alt': i < 3 ? 'fail' : 'pass', 'meta-viewport': i === 0 ? 'fail' : 'pass' })),
      [page('/a', { 'color-contrast': 'pass' }), page('/b', {}), page('/c', { label: 'pass' })],
    ];
    for (const pages of sets) {
      expect(axeSiteScore(pages.map((p) => ({ rules: hits(p) })))).toBe(scoreSite(pages).score);
    }
  });

  it('is not the mean of the page scores', () => {
    // One page fails a heavy rule, nine are clean: the mean would be ~99; v5 gives the share's √:
    // total 9 × √0.1 = 2.85 → 100 − 18 × ln 1.285 = 95.49 → 95.
    const pages = [page('/a', { 'color-contrast': 'fail' }), ...Array.from({ length: 9 }, (_, i) => page(`/c${i}`, { 'color-contrast': 'pass' }))];
    expect(axeSiteScore(pages.map((p) => ({ rules: hits(p) })))).toBe(95);
    expect(scoreSite(pages).score).toBe(95);
  });

  it('null with no pages; counts a rule once per page however often it is listed', () => {
    expect(axeSiteScore([])).toBeNull();
    const dup = [{ rules: [{ id: 'image-alt', impact: 'critical' as const, count: 3 }, { id: 'image-alt', impact: 'critical' as const, count: 1 }] }, { rules: [] }];
    expect(axeSiteScore(dup)).toBe(axeSiteScore([{ rules: [{ id: 'image-alt', impact: 'critical' }] }, { rules: [] }]));
  });
});
