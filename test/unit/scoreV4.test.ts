// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Weights by user-impact group (scoring v4, kept in v5), halved for moderate/minor, and how failing checks
// and their shares are counted. The v5 formula (100 − 18 × ln(1 + Σ w × √share ÷ 10)) and the worked
// example are pinned in scoreV5.test.ts; the numbers here are computed with it (docs/scoring.md).
import { describe, expect, it } from 'vitest';
import { RULE_IMPACTS } from '../../src/ruleImpacts.js';
import { GROUP_WEIGHTS, RULE_GROUPS, ruleGroupOf } from '../../src/ruleGroups.js';
import {
  PROBE_CHECK_WEIGHT, PROBE_WEIGHT_OVERRIDES, combineChecks, defaultImpactOf, pageScore, probeWeight, roundScore, ruleWeight, scoreSite,
  type ProbeChecks,
} from '../../src/score.js';
import type { Impact, PageAudit, RuleOutcome } from '../../src/types.js';

const page = (url: string, rules: Record<string, RuleOutcome>, status: 'ok' | 'failed' = 'ok'): PageAudit => ({
  url, status, rules, violations: [], incomplete: [], links: [],
});
/** n pages, rule `id` failing on the first `fails` of them and passing elsewhere. */
const pagesWith = (n: number, fails: Record<string, number>): PageAudit[] =>
  Array.from({ length: n }, (_, i) => page(`/p${i}`, Object.fromEntries(Object.entries(fails).map(([id, k]) => [id, i < k ? 'fail' : 'pass'] as const))));

describe('scoring v4: weights', () => {
  it('weighs axe rules by user-impact group, halved for moderate and minor impact', () => {
    expect(GROUP_WEIGHTS).toEqual({ visible: 9, markup: 3, names: 7 });
    expect(ruleWeight('color-contrast', 'serious')).toBe(9);
    expect(ruleWeight('input-image-alt', 'critical')).toBe(9);
    expect(ruleWeight('list', 'serious')).toBe(3);
    expect(ruleWeight('aria-allowed-attr', 'critical')).toBe(3);
    expect(ruleWeight('link-name', 'serious')).toBe(7);
    expect(ruleWeight('input-button-name', 'critical')).toBe(7);
    // Scoring v8 multiplies some rules' weight (RULE_WEIGHT_FACTORS): zoom blocked weighs 4.5 × 1.5.
    expect(ruleWeight('meta-viewport', 'moderate')).toBeCloseTo(4.5 * 1.5, 10);
    expect(ruleWeight('image-alt', 'critical')).toBeCloseTo(9 * 1.7, 10);
    expect(ruleWeight('aria-deprecated-role', 'minor')).toBe(1.5);
    expect(ruleWeight('html-xml-lang-mismatch', 'moderate')).toBe(3.5);
  });

  it('every rule in the rule set has an explicit group (a new rule is classified on purpose)', () => {
    const missing = Object.keys(RULE_IMPACTS).filter((id) => !Object.prototype.hasOwnProperty.call(RULE_GROUPS, id));
    expect(missing).toEqual([]);
    for (const g of Object.values(RULE_GROUPS)) expect(Object.keys(GROUP_WEIGHTS)).toContain(g);
  });

  it('an unknown rule id falls back to the names group', () => {
    expect(ruleGroupOf('some-future-rule')).toBe('names');
    expect(ruleWeight('some-future-rule', 'serious')).toBe(7);
    expect(ruleWeight('some-future-rule', 'minor')).toBe(3.5);
    // Prototype keys are not rules.
    expect(ruleGroupOf('constructor')).toBe('names');
    expect(ruleGroupOf('__proto__')).toBe('names');
    expect(defaultImpactOf('constructor')).toBe('moderate');
  });

  it('a core test criterion weighs 4 unless scoring v8 overrides it (the gold standard\'s severity order)', () => {
    expect(PROBE_CHECK_WEIGHT).toBe(4);
    expect(Object.keys(PROBE_WEIGHT_OVERRIDES).sort()).toEqual(['1.2.2', '1.3.5', '1.4.1', '1.4.2', '1.4.3', '2.1.1', '2.1.2', '2.2.2', '2.3.1', '2.4.7', '3.3.2']);
    expect(probeWeight('2.1.2')).toBe(15.25);
    expect(probeWeight('2.3.1')).toBe(10);
    expect(probeWeight('2.4.11')).toBe(4);
    expect(probeWeight('constructor')).toBe(4);
  });
});

describe('scoring v4 weights in the v5 formula: counting failing checks', () => {
  it('adds w × √share per failing check into one total (the v5 formula)', () => {
    expect(combineChecks([])).toBe(100);
    expect(combineChecks([{ weight: 9, share: 1 }, { weight: 7, share: 0.25 }])).toBeCloseTo(100 - 18 * Math.log(1 + 12.5 / 10), 10);
    // The result stays within 0..100; a share above 1 counts as 1, below 0 as 0.
    expect(combineChecks([{ weight: 5000, share: 1 }])).toBe(0);
    expect(combineChecks([{ weight: 7, share: 2 }])).toBeCloseTo(combineChecks([{ weight: 7, share: 1 }]), 10);
    expect(combineChecks([{ weight: 7, share: -1 }])).toBe(100);
  });

  it('rounds halves up, robust to floating-point noise, clamped to 0..100', () => {
    expect(roundScore(89.5)).toBe(90);
    expect(roundScore(100 * (1 - 10.5 / 100))).toBe(90); // 89.5 in exact arithmetic, 89.49999999999999 in floating point
    expect(roundScore(89.4999)).toBe(89);
    expect(roundScore(-3)).toBe(0);
    expect(roundScore(100.4)).toBe(100);
  });

  it('has no cap: one critical failure on 1 of 25 pages scores well above 89', () => {
    const r = scoreSite(pagesWith(25, { 'input-image-alt': 1, 'link-name': 0 }), defaultImpactOf);
    // total 9 × √0.04 = 1.8: 100 − 18 × ln 1.18 = 97.02 → 97.
    expect(r.score).toBe(97);
    expect(r.letter).toBe('A');
    expect(r.headline).toBe('Access Granted');
    expect(r.pointsLost).toEqual({ 'input-image-alt': 3 });
    expect('capped' in r).toBe(false);
  });

  it('a check failing on 0 of N pages costs nothing, and a passing site scores 100', () => {
    const r = scoreSite(pagesWith(5, { 'color-contrast': 0, 'link-name': 0 }), defaultImpactOf);
    expect(r.score).toBe(100);
    expect(r.pointsLost).toEqual({});
    expect(r.probePointsLost).toEqual({});
  });

  it('share counts pages that loaded; failures on pages that did not load are ignored', () => {
    const pages = [...pagesWith(4, { 'color-contrast': 1 }), page('/gone', { 'color-contrast': 'fail', 'link-name': 'fail' }, 'failed')];
    // color-contrast on 1 of 4 loaded pages: total 9 × 0.5 = 4.5 → 100 − 18 × ln 1.45 = 93.31 → 93.
    const r = scoreSite(pages, defaultImpactOf, new Map([['/gone', { '2.4.11': 'fail' }]]));
    expect(r.score).toBe(93);
    expect(r.pointsLost).toEqual({ 'color-contrast': 7 });
    expect(r.probePointsLost).toEqual({});
    expect(r.pageScores.get('/gone')).toBeNull();
  });

  it('many failing checks drive the score down, each further one costing less', () => {
    const fails = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`rule-${i}`, 3]));
    const r = scoreSite(pagesWith(3, fails), () => 'serious');
    // 80 checks of weight 7 at share 1: total 560 → 100 − 18 × ln 57 = 27.23 → 27; one more or less moves it < 0.5.
    expect(r.score).toBe(27);
    expect(r.letter).toBe('F');
    expect(Object.values(r.pointsLost).every((n) => n === 0)).toBe(true);
  });

  it('"+N if fixed" is the score without that one check, minus the score', () => {
    // Two visible checks at share 1: total 18 → 81.47 → 81. Without one: total 9 → 88.45 → 88, +7.
    const r = scoreSite(pagesWith(2, { 'color-contrast': 2, 'link-in-text-block': 2 }), defaultImpactOf);
    expect(r.score).toBe(81);
    expect(r.pointsLost).toEqual({ 'color-contrast': 7, 'link-in-text-block': 7 });
  });

  it('crosses the Access Granted line at exactly 90, and not at 89', () => {
    // One names check at share 1: total 7 → 90.45 → 90, A.
    expect(scoreSite(pagesWith(1, { 'link-name': 1 }), defaultImpactOf)).toMatchObject({ score: 90, letter: 'A', headline: 'Access Granted' });
    // Names (7) and markup (3) at share 1: total 10 → 100 − 18 × ln 2 = 87.52 → 88, B.
    const r = scoreSite(pagesWith(1, { 'link-name': 1, list: 1 }), defaultImpactOf);
    expect([r.score, r.letter, r.headline]).toEqual([88, 'B', 'Access Denied']);
  });

  it('the result does not depend on page or rule order', () => {
    const a = pagesWith(7, { 'color-contrast': 3, 'link-name': 2, list: 5, 'meta-viewport': 1 });
    const b = [...a].reverse().map((p) => ({ ...p, rules: Object.fromEntries(Object.entries(p.rules).reverse()) }));
    expect(scoreSite(b, defaultImpactOf).score).toBe(scoreSite(a, defaultImpactOf).score);
    expect(scoreSite(b, defaultImpactOf).pointsLost).toEqual(scoreSite(a, defaultImpactOf).pointsLost);
  });
});

describe('scoring v4: core test criteria', () => {
  it('share = pages where the criterion failed ÷ pages a scored core test tested it on', () => {
    // 10 pages loaded, the core tests ran on 5. 2.4.7 failed on 1 of them, flagged on 1 ('ran' counts; scoring v6 leaves out only 'untested').
    const pages = pagesWith(10, { 'color-contrast': 0 });
    const probes = new Map<string, ProbeChecks>([
      ['/p0', { '2.4.11': 'fail' }], ['/p1', { '2.4.11': 'ran' }], ['/p2', { '2.4.11': 'pass' }], ['/p3', { '2.4.11': 'pass' }], ['/p4', { '2.4.11': 'pass' }],
    ]);
    // total 4 × √(1/5) = 1.789 → 100 − 18 × ln 1.1789 = 97.04 → 97.
    const r = scoreSite(pages, defaultImpactOf, probes);
    expect(r.score).toBe(97);
    expect(r.probePointsLost).toEqual({ '2.4.11': 3 });
  });

  it('a criterion with only "ran" results, or only on pages that did not load, costs nothing', () => {
    const pages = [...pagesWith(3, { 'link-name': 0 }), page('/x', {}, 'failed')];
    const probes = new Map<string, ProbeChecks>([['/p0', { '1.4.10': 'ran' }], ['/x', { '1.4.10': 'fail' }]]);
    const r = scoreSite(pages, defaultImpactOf, probes);
    expect(r.score).toBe(100);
    expect(r.probePointsLost).toEqual({});
  });

  it('page score: only pass and fail results apply', () => {
    expect(pageScore({}, defaultImpactOf, { '1.4.10': 'ran' })).toBeNull();
    expect(pageScore({}, defaultImpactOf, { '1.4.10': 'pass' })).toBe(100);
    expect(pageScore({ 'link-name': 'pass' }, defaultImpactOf, { '1.4.10': 'fail' })).toBeCloseTo(100 - 18 * Math.log(1.4), 10);
    expect(pageScore({ 'link-name': 'inapplicable', 'color-contrast': 'incomplete' }, defaultImpactOf)).toBeNull();
  });
});

describe('scoring v4: when there is no score', () => {
  it('no pages, all pages failed, or too few loaded', () => {
    expect(scoreSite([], defaultImpactOf).status).toBe('incomplete');
    const all = scoreSite([page('/a', {}, 'failed'), page('/b', {}, 'failed')], defaultImpactOf);
    expect([all.status, all.score, all.letter, all.headline]).toEqual(['incomplete', null, null, 'Scan incomplete']);
    expect(scoreSite([...pagesWith(2, { list: 0 }), page('/c', {}, 'failed'), page('/d', {}, 'failed')], defaultImpactOf).status).toBe('incomplete');
  });

  it('nothing applied on the pages that loaded', () => {
    const r = scoreSite([page('/a', { 'link-name': 'inapplicable' })], defaultImpactOf, new Map([['/a', { '1.4.10': 'ran' } as ProbeChecks]]));
    expect(r.status).toBe('incomplete');
    expect(r.reasons[0]).toMatch(/No accessibility rules applied/);
  });

  it('a custom impact table halves moderate and minor rules', () => {
    const impactOf = (id: string): Impact => (id === 'mod' ? 'moderate' : 'serious');
    // Unknown ids are names (7): 'mod' moderate → 3.5 at share 1 → 94.60 → 95; 'ser' 7 → 90.45 → 90.
    expect(scoreSite([page('/', { mod: 'fail' })], impactOf).score).toBe(95);
    expect(scoreSite([page('/', { ser: 'fail' })], impactOf).score).toBe(90);
  });
});
