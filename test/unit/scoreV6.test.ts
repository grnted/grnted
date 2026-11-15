// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Scoring v6 (docs/scoring.md): a page where a core test could not test a criterion (its run timed
// out or broke, the browser closed, the page never stood still, the time box ran out: every scored
// result for the criterion there is "not testable") leaves that criterion's share denominator, so it
// can no longer dilute a failure found elsewhere. A criterion no page could be tested for costs
// nothing, as before, and the report says so. Weights, formula and thresholds are v5's.
import { describe, expect, it } from 'vitest';
import { buildReport } from '../../src/report/build.js';
import { defaultImpactOf, pageScore, probeChecksFrom, roundScore, scoreSite, untestedCriteria, type ProbeChecks } from '../../src/score.js';
import { SCORED_PROBES } from '../../src/probes/registry.js';
import type { PageAudit, ProbeFinding, ProbeRun } from '../../src/types.js';
import { SCORING_VERSION } from '../../src/version.js';

const page = (url: string): PageAudit => ({ url, status: 'ok', rules: { 'color-contrast': 'pass' }, violations: [], incomplete: [], links: [] });
const run = (probe: string, url: string, criteria: string[], findings: ProbeFinding[], extra: Partial<ProbeRun> = {}): ProbeRun =>
  ({ probe, kind: 'render', page: url, criteria, status: 'ok', findings, ms: 5, ...extra });
const core = (id: string) => SCORED_PROBES.has(id);
const fromTotal = (total: number) => 100 - 18 * Math.log(1 + total / 10);
const untestable = (criterion: string, detail = 'timed out'): ProbeFinding => ({ criterion, status: 'not_testable', detail });

describe('scoring v6: constants', () => {
  it('is v8 now (v6 rules unchanged by it)', () => {
    expect(SCORING_VERSION).toBe('v14');
  });
});

describe('scoring v6: which pages were tested for a criterion', () => {
  it('a criterion every scored result calls "not testable" on a page is "untested" there; any other result keeps the page', () => {
    const runs = [
      // A timed-out run: one not_testable finding per criterion.
      run('text-spacing', '/', ['1.4.12'], [untestable('1.4.12')], { status: 'timeout' }),
      // A run that broke.
      run('reflow', '/', ['1.4.10'], [untestable('1.4.10', 'the test broke')], { status: 'error' }),
      // The probe itself could not test it (no time left, the page never stood still).
      run('keyboard', '/', ['2.4.11', '2.1.1'], [untestable('2.4.11', 'no time left'), { criterion: '2.1.1', status: 'failed', detail: 'x' }], { kind: 'interaction' }),
      // Two scored probes on 1.4.11: one could not test it, the other did (no failures): tested.
      run('keyboard', '/b', ['1.4.11'], [untestable('1.4.11')], { kind: 'interaction' }),
      run('non-text-contrast', '/b', ['1.4.11'], [], { kind: 'pixels' }),
      // Flagged and not applicable were tested.
      run('overlays', '/b', ['1.4.10', '2.4.11'], [{ criterion: '1.4.10', status: 'flagged', detail: 'x' }, { criterion: '2.4.11', status: 'not_applicable', detail: 'x' }]),
      // A deep probe's not_testable never counts at all.
      run('keyboard-deep', '/b', ['2.1.2'], [untestable('2.1.2')], { kind: 'interaction' }),
    ];
    expect(Object.fromEntries(probeChecksFrom(runs, core))).toEqual({
      '/': { '1.4.10': 'untested', '1.4.12': 'untested', '2.1.1': 'fail', '2.4.11': 'untested' },
      '/b': { '1.4.10': 'ran', '1.4.11': 'ran', '2.4.11': 'ran' },
    });
  });

  it('page scores are unchanged: "untested", like "ran", is not a result that applies', () => {
    expect(pageScore({}, defaultImpactOf, { '1.4.10': 'untested' })).toBeNull();
    expect(pageScore({ 'link-name': 'pass' }, defaultImpactOf, { '1.4.10': 'untested', '2.4.11': 'fail' })).toBeCloseTo(fromTotal(4), 10);
  });
});

describe('scoring v6: the share leaves out pages that could not be tested', () => {
  const pages = Array.from({ length: 5 }, (_, i) => page(`/p${i}`));

  it('failed on 1 page, not testable on the 4 others: share 1 of 1 (v5 counted 1 of 5)', () => {
    const probes = new Map<string, ProbeChecks>(pages.map((p, i) => [p.url, { '2.4.11': i === 0 ? 'fail' : 'untested' }]));
    const r = scoreSite(pages, defaultImpactOf, probes);
    // total 4 × √1 = 4 → 100 − 18 × ln 1.4 = 93.94 → 94. v5: 4 × √(1/5) = 1.79 → 97.
    expect(r.score).toBe(94);
    expect(r.score).toBe(roundScore(fromTotal(4)));
    expect(r.probePointsLost).toEqual({ '2.4.11': 6 });
  });

  it('failed on 1, tested clean on 2, not testable on 2: share 1 of 3', () => {
    const outcome = ['fail', 'pass', 'pass', 'untested', 'untested'] as const;
    const probes = new Map<string, ProbeChecks>(pages.map((p, i) => [p.url, { '1.4.10': outcome[i]! }]));
    expect(scoreSite(pages, defaultImpactOf, probes).score).toBe(roundScore(fromTotal(4 * Math.sqrt(1 / 3))));
  });

  it('"ran" (flagged, not applicable, or tested by another probe) still counts in the denominator', () => {
    const outcome = ['fail', 'ran', 'ran', 'ran', 'untested'] as const;
    const probes = new Map<string, ProbeChecks>(pages.map((p, i) => [p.url, { '1.4.10': outcome[i]! }]));
    expect(scoreSite(pages, defaultImpactOf, probes).score).toBe(roundScore(fromTotal(4 * Math.sqrt(1 / 4))));
  });

  it('each criterion keeps its own denominator', () => {
    const probes = new Map<string, ProbeChecks>(pages.map((p, i) => [p.url, { '1.4.10': i === 0 ? 'fail' : 'untested', '2.4.11': i < 2 ? 'fail' : 'pass' }]));
    expect(scoreSite(pages, defaultImpactOf, probes).score).toBe(roundScore(fromTotal(4 * 1 + 4 * Math.sqrt(2 / 5))));
  });

  it('no page could be tested: costs nothing, and the criterion is listed as untested', () => {
    const probes = new Map<string, ProbeChecks>(pages.map((p) => [p.url, { '1.4.10': 'untested', '2.4.11': 'pass' }]));
    const r = scoreSite(pages, defaultImpactOf, probes);
    expect(r.score).toBe(100);
    expect(r.probePointsLost).toEqual({});
    expect(untestedCriteria(pages, probes)).toEqual(['1.4.10']);
    // Tested on one page: not listed.
    const one = new Map(probes);
    one.set('/p3', { '1.4.10': 'ran' });
    expect(untestedCriteria(pages, one)).toEqual([]);
  });
});

describe('scoring v6: the report', () => {
  const urls = ['https://e.org/', 'https://e.org/a', 'https://e.org/b'];
  const base = { site: 'https://e.org/', pages: urls.map(page), documents: [], skipped: [], startedAt: 't', finishedAt: '2026-11-02T00:00:00Z', userAgent: 'ua' };

  it('a criterion that failed on the one page it could be tested on costs its full share', () => {
    const r = buildReport({
      ...base,
      probeRuns: [
        run('reflow', urls[0]!, ['1.4.10'], [{ criterion: '1.4.10', status: 'failed', target: 'main', detail: 'scrolls sideways' }]),
        run('reflow', urls[1]!, ['1.4.10'], [untestable('1.4.10')], { status: 'timeout' }),
        run('reflow', urls[2]!, ['1.4.10'], [untestable('1.4.10', 'the test broke')], { status: 'error' }),
      ],
    });
    expect(r.meta.scoring).toBe('v14');
    expect(r.score).toBe(94);
    expect(r.testIssues).toMatchObject([{ criterion: '1.4.10', pagesAffected: [urls[0]], pointsLost: 6 }]);
    expect(r.untestedCriteria).toBeUndefined();
  });
});
