// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Scoring v5 (docs/scoring.md): every failing check adds w × √share to a total, and the site score is
// 100 − 18 × ln(1 + total ÷ 10), rounded. Diminishing returns: each further problem costs less than the
// one before, as the expert panel judged. AI-reviewed image checks count like a core test criterion at
// half weight, with no cap (how a review's answers count is the closed AI package's: its aiScoringV5.test.ts).
// Without the AI, the score is computed without them and says so.
import { describe, expect, it } from 'vitest';
import { AI_NOT_RUN_NOTE } from '../../src/aiScore.js';
import { buildReport } from '../../src/report/build.js';
import * as score from '../../src/score.js';
import {
  AI_CHECK_WEIGHTS, FORMULA_KNEE, FORMULA_SCALE, PROBE_CHECK_WEIGHT, checksTotal, combineChecks, defaultImpactOf, pageScore, roundScore,
  scoreSite, type ProbeChecks,
} from '../../src/score.js';
import type { AiFinding, AiReport, PageAudit, RuleOutcome } from '../../src/types.js';
import { SCORING_VERSION } from '../../src/version.js';

const page = (url: string, rules: Record<string, RuleOutcome> = { 'color-contrast': 'pass' }): PageAudit => ({
  url, status: 'ok', rules, violations: [], incomplete: [], links: [],
});
const PAGES = ['/a', '/b', '/c', '/d'].map((p) => page(`https://e.org${p}`));
/** n pages, each rule failing on the first `fails[id]` of them and passing elsewhere. */
const pagesWith = (n: number, fails: Record<string, number>): PageAudit[] =>
  Array.from({ length: n }, (_, i) => page(`/p${i}`, Object.fromEntries(Object.entries(fails).map(([id, k]) => [id, i < k ? 'fail' : 'pass'] as const))));
/** The formula on a total, unrounded (what the tests compare against). */
const fromTotal = (total: number) => 100 - 18 * Math.log(1 + total / 10);
const f = (pageUrl: string, src: string, extra: Partial<AiFinding> = {}): AiFinding => ({
  check: 'altText', criterion: '1.1.1', page: pageUrl, target: src, verdict: 'accurate', label: 'Looks right', flagged: false,
  confidence: 'high', observed: 'A picture.', issue: '', suggestion: '', source: 'ai', scoreTested: ['1.1.1', '1.4.5'], ...extra,
});
const flyer = (pageUrl: string, src: string): AiFinding[] => [
  f(pageUrl, src, { verdict: 'insufficient', flagged: true, scored: true, essentialText: 'Book Fair · April 14', current: { label: 'Current alt text', value: 'flyer' } }),
  f(pageUrl, src, { criterion: '1.4.5', verdict: 'image_of_text', flagged: true, scored: true, scoreTested: undefined, essentialText: 'Book Fair · April 14' }),
];
const aiReport = (findings: AiFinding[], check: AiFinding['check'] = 'altText'): AiReport => ({
  disclaimer: 'x',
  runs: [{ check, title: 'Image descriptions (alt text)', summary: '', model: 'm', promptVersion: 'alt-text@5', tier: 'core', inputs: findings.length, reviewed: findings.length, cached: 0, notReviewed: 0, findings }],
});
const report = (ai?: AiReport) => buildReport({
  site: 'https://e.org/', pages: PAGES, documents: [], skipped: [], startedAt: 't', finishedAt: '2026-11-01T00:00:00Z', userAgent: 'ua', ...(ai ? { ai } : {}),
});

describe('scoring v5: constants', () => {
  it('v5 constants, unchanged in v6 and v7: scale 18, knee 10, core tests 4, AI image checks at half weight, no AI cap', () => {
    expect(SCORING_VERSION).toBe('v14'); // v8: criterion-based (scoreV8.test.ts); v6 changed only the core test share (scoreV6.test.ts), v7 added documents (scoreV7.test.ts)
    expect(FORMULA_SCALE).toBe(18);
    expect(FORMULA_KNEE).toBe(10);
    expect(PROBE_CHECK_WEIGHT).toBe(4);
    expect(AI_CHECK_WEIGHTS).toEqual({ '1.1.1': 4.5, '1.4.5': 2 });
    expect('AI_POINTS_CAP' in score).toBe(false);
    expect('combineWithAi' in score).toBe(false);
  });
});

describe('scoring v5: the formula', () => {
  it('total = Σ w × √share; score = 100 − 18 × ln(1 + total ÷ 10)', () => {
    expect(checksTotal([])).toBe(0);
    expect(combineChecks([])).toBe(100);
    expect(checksTotal([{ weight: 9, share: 1 }, { weight: 7, share: 0.25 }])).toBeCloseTo(9 + 3.5, 12);
    expect(combineChecks([{ weight: 9, share: 1 }])).toBeCloseTo(fromTotal(9), 10); // 88.45
    expect(combineChecks([{ weight: 9, share: 1 }, { weight: 7, share: 0.25 }])).toBeCloseTo(fromTotal(12.5), 10);
  });

  it('diminishing returns: each further identical problem costs fewer points than the one before', () => {
    const costs: number[] = [];
    for (let k = 1; k <= 30; k++) {
      const checks = Array.from({ length: k }, () => ({ weight: 7, share: 1 }));
      costs.push(combineChecks(checks.slice(1)) - combineChecks(checks));
    }
    for (let k = 1; k < costs.length; k++) expect(costs[k]!).toBeLessThan(costs[k - 1]!);
    // The lead's example shape: ~20 failing checks of mixed weight and share land in the C–D range, not at 50.
    const city = Array.from({ length: 20 }, (_, i) => ({ weight: [9, 7, 3, 4][i % 4]!, share: [1, 0.5, 0.2, 0.04][i % 4]! }));
    expect(roundScore(combineChecks(city))).toBeGreaterThanOrEqual(60);
  });

  it('guards: NaN, infinite or negative weights and shares cost nothing; shares above 1 count as 1', () => {
    expect(combineChecks([{ weight: Number.NaN, share: 1 }])).toBe(100);
    expect(combineChecks([{ weight: Number.POSITIVE_INFINITY, share: 1 }])).toBe(100);
    expect(combineChecks([{ weight: -9, share: 1 }])).toBe(100);
    expect(combineChecks([{ weight: 9, share: Number.NaN }])).toBe(100);
    expect(combineChecks([{ weight: 9, share: -1 }])).toBe(100);
    expect(combineChecks([{ weight: 9, share: 4 }])).toBeCloseTo(fromTotal(9), 10);
    // A negative weight cannot buy back points another check cost.
    expect(combineChecks([{ weight: 9, share: 1 }, { weight: -50, share: 1 }])).toBeCloseTo(fromTotal(9), 10);
  });

  it('hundreds of checks drive the score toward 0, never below, never NaN', () => {
    const many = Array.from({ length: 500 }, () => ({ weight: 9, share: 1 }));
    expect(combineChecks(many)).toBe(0);
    expect(roundScore(combineChecks(many.slice(0, 80)))).toBe(roundScore(fromTotal(720)));
    const r = scoreSite(pagesWith(3, Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`rule-${i}`, 3]))), () => 'serious');
    expect(r.score).toBe(0);
    expect(r.letter).toBe('F');
    expect(Object.values(r.pointsLost).every((n) => n === 0)).toBe(true);
  });

  it('one tiny check costs a point or less; rounding is half up at the Access Granted line', () => {
    // A markup rule (3) minor-halved (1.5) on 1 page of 25: total 1.5 × 0.2 = 0.3 → 99.47 → 99.
    const r = scoreSite(pagesWith(25, { 'aria-deprecated-role': 1 }), defaultImpactOf);
    expect(r.score).toBe(roundScore(fromTotal(0.3)));
    expect(r.score).toBe(99);
    expect(r.pointsLost).toEqual({ 'aria-deprecated-role': 1 });
    // The A line is 90: a total just under 10 × (e^(10.5/18) − 1) = 7.92 rounds to 90, just over to 89.
    const edge = 10 * Math.expm1(10.5 / 18);
    expect(roundScore(fromTotal(edge - 1e-6))).toBe(90);
    expect(roundScore(fromTotal(edge + 1e-6))).toBe(89);
    expect(roundScore(89.5)).toBe(90);
  });

  it('one problem on every page: names (7) is still an A, visible (9) is not', () => {
    expect(scoreSite(pagesWith(2, { 'link-name': 2 }), defaultImpactOf)).toMatchObject({ score: 90, letter: 'A', headline: 'Access Granted' });
    expect(scoreSite(pagesWith(2, { 'color-contrast': 2 }), defaultImpactOf)).toMatchObject({ score: 88, letter: 'B', headline: 'Access Denied' });
  });

  it('"+N if fixed" is the score without that one check, minus the score; fixes together give at least their sum', () => {
    const r = scoreSite(pagesWith(2, { 'color-contrast': 2, 'link-in-text-block': 2, list: 1 }), defaultImpactOf);
    const total = 9 + 9 + 3 * Math.SQRT1_2;
    expect(r.score).toBe(roundScore(fromTotal(total)));
    expect(r.pointsLost['color-contrast']).toBe(roundScore(fromTotal(total - 9)) - r.score!);
    expect(r.pointsLost.list).toBe(roundScore(fromTotal(18)) - r.score!);
    const sum = Object.values(r.pointsLost).reduce((a, b) => a + b, 0);
    expect(100 - r.score!).toBeGreaterThanOrEqual(sum);
  });

  it('page score: the same formula over the page\'s own checks at share 1', () => {
    expect(pageScore({ 'color-contrast': 'fail', list: 'fail' }, defaultImpactOf, { '2.4.11': 'fail' })).toBeCloseTo(fromTotal(9 + 3 + 4), 10);
    expect(pageScore({ 'link-name': 'pass' }, defaultImpactOf, { '1.4.10': 'fail' })).toBeCloseTo(fromTotal(4), 10);
    expect(pageScore({ 'link-name': 'pass' }, defaultImpactOf)).toBe(100);
  });

  it('core test criteria (headings, overlays and the rest) weigh 4 by the same constant', () => {
    const pages = pagesWith(4, { 'color-contrast': 0 });
    const probes = new Map<string, ProbeChecks>(pages.map((p, i) => [p.url, { '2.4.6': i < 2 ? 'fail' : 'pass', '1.4.10': i === 0 ? 'fail' : 'pass', '2.4.11': 'pass' }]));
    const r = scoreSite(pages, defaultImpactOf, probes);
    expect(r.score).toBe(roundScore(fromTotal(4 * Math.SQRT1_2 + 4 * 0.5)));
  });
});

describe('scoring v5: the formula with AI checks', () => {
  it('each AI kind adds weight × √share to the same total, like a core test criterion', () => {
    const r = scoreSite(PAGES, undefined, undefined, [{ criterion: '1.1.1', failedPages: 1, testedPages: 4 }, { criterion: '1.4.5', failedPages: 2, testedPages: 4 }]);
    const total = 4.5 * 0.5 + 2 * Math.SQRT1_2;
    expect(r.score).toBe(roundScore(fromTotal(total)));
    expect(r.aiPointsLost['1.1.1']).toBe(roundScore(fromTotal(2 * Math.SQRT1_2)) - r.score!);
    expect(r.aiPointsLost['1.4.5']).toBe(roundScore(fromTotal(4.5 * 0.5)) - r.score!);
    expect('aiCapped' in r).toBe(false);
  });

  it('a kind that failed nowhere, was tested nowhere, or has no weight costs nothing', () => {
    const r = scoreSite(PAGES, undefined, undefined, [
      { criterion: '1.1.1', failedPages: 0, testedPages: 3 }, { criterion: '1.4.5', failedPages: 0, testedPages: 0 }, { criterion: '2.4.4', failedPages: 2, testedPages: 2 },
    ]);
    expect(r.score).toBe(100);
    expect(r.aiPointsLost).toEqual({});
  });

  it('no cap: the AI checks cost what their weight and share say, on top of everything else', () => {
    const pages = [page('https://e.org/a', { 'color-contrast': 'fail' })];
    const r = scoreSite(pages, undefined, undefined, [{ criterion: '1.1.1', failedPages: 1, testedPages: 1 }, { criterion: '1.4.5', failedPages: 1, testedPages: 1 }]);
    expect(r.score).toBe(roundScore(fromTotal(9 + 4.5 + 2)));
    expect(r.pointsLost['color-contrast']).toBe(roundScore(fromTotal(6.5)) - r.score!);
  });

  it('page scores leave the AI checks out', () => {
    const r = scoreSite(PAGES, undefined, undefined, [{ criterion: '1.1.1', failedPages: 4, testedPages: 4 }]);
    expect(r.score).toBeLessThan(100);
    expect([...r.pageScores.values()]).toEqual([100, 100, 100, 100]);
  });
});

describe('scoring v5: the report', () => {
  it('an AI review with no AI package to score it is left out of the report: nothing of it counts (the open engine has none)', () => {
    const ai = aiReport([...flyer(PAGES[0]!.url, 'https://e.org/fair.png'), f(PAGES[1]!.url, 'https://e.org/bus.png')]);
    const pdf = { url: 'https://e.org/a.pdf', type: 'pdf' as const, detectedBy: 'extension' as const, linkedFrom: [], checks: { pages: 1, pagesChecked: 1, tagged: true, hasLanguage: true, hasTitle: true, showsTitle: true, imageOnly: false, figuresWithoutAlt: 0 } };
    const withPdf: AiReport = { ...ai, runs: [...ai.runs, { ...ai.runs[0]!, check: 'document', findings: [f(pdf.url, 'Figure 1', { check: 'document', verdict: 'inaccurate', flagged: true, scored: true })] }] };
    const r = buildReport({ site: 'https://e.org/', pages: PAGES, documents: [pdf.url], documentChecks: [pdf], skipped: [], startedAt: 't', finishedAt: '2026-11-01T00:00:00Z', userAgent: 'ua', ai: withPdf });
    expect(r.ai).toBeUndefined();
    expect(r.aiChecks).toEqual({ ran: false, issues: [], note: AI_NOT_RUN_NOTE });
    expect(r.score).toBe(100);
    expect(r.documentScore).toMatchObject({ checked: 1, failed: 0 });
  });

  it('without the AI: the automated-only score, and the report says so plainly', () => {
    const r = report();
    expect(r.score).toBe(100);
    expect(r.aiChecks).toEqual({ ran: false, issues: [], note: AI_NOT_RUN_NOTE });
    expect(AI_NOT_RUN_NOTE).toBe('AI checks not run: automated-only score');
    // An AI review whose image check never answered is the same.
    expect(report(aiReport([f(PAGES[0]!.url, 'a', { verdict: 'not_reviewed', scoreTested: undefined })])).aiChecks!.ran).toBe(false);
  });
});

describe('scoring v8: the worked example in docs/scoring.md', () => {
  // 4 pages loaded; the core tests ran on all 4.
  const pages = pagesWith(4, { 'color-contrast': 4, 'image-alt': 1, 'link-name': 1, list: 1, 'meta-viewport': 4 });
  const probes = new Map<string, ProbeChecks>(pages.map((p, i) => [p.url, { '2.4.7': i === 0 ? 'fail' : 'pass' }]));

  it('total 30.775 → 100 − 18 × ln 4.0775 = 74.70 → 75, C; "+N if fixed"; the worst page 69', () => {
    // 9 × 1 + 15.3 × 0.5 + 7 × 0.5 + 3 × 0.5 + 6.75 × 1 + 4.75 × 0.5 = 30.775 (each criterion once: in-criterion share 1).
    const r = scoreSite(pages, defaultImpactOf, probes);
    expect(combineChecks([{ weight: 30.775, share: 1 }])).toBeCloseTo(74.7, 2);
    expect([r.score, r.letter, r.headline]).toEqual([75, 'C', 'Access Denied']);
    expect(r.pointsLost).toEqual({ 'color-contrast': 4, 'image-alt': 3, 'meta-viewport': 3, 'link-name': 1, list: 0 });
    expect(r.probePointsLost).toEqual({ '2.4.7': 1 });
    expect(r.pageScores.get('/p0')).toBeCloseTo(69.05, 2);
    expect(roundScore(r.pageScores.get('/p0')!)).toBe(69);
  });

  it('plus a confirmed flyer on 1 of 4 reviewed pages: total 34.025 → 73.32 → 73', () => {
    const r = scoreSite(pages, defaultImpactOf, probes, [{ criterion: '1.1.1', failedPages: 1, testedPages: 4 }, { criterion: '1.4.5', failedPages: 1, testedPages: 4 }]);
    expect(r.score).toBe(73);
    expect(r.aiPointsLost).toEqual({ '1.1.1': 1, '1.4.5': 1 });
    expect(r.pointsLost['color-contrast']).toBe(4);
  });
});
