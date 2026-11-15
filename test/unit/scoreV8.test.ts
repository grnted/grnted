// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Scoring v8 (docs/scoring.md, "Scoring v8"): one combined result per WCAG criterion, read from the
// report itself, with the newly scored methods (every registry test, the cross-page rules, the media
// rules, third-party frames at reduced weight, the gated AI checks) and minor failures.
import { describe, expect, it } from 'vitest';
import { LEGACY_AI_GATES, LEGACY_AI_WEIGHTS, aiGates } from '../../src/aiLegacy.js';
import { PROBE_CHECK_WEIGHT } from '../../src/score.js';
import {
  CONSISTENCY_WEIGHTS, MEDIA_WEIGHTS, MINOR_FACTOR, THIRD_PARTY_FACTOR, V8, criterionScore, primaryCriterion, reportCriterionChecks, scoreReportV8, v8ProbeWeight, type CriterionCheck,
} from '../../src/criterionScore.js';
import { PROBES, SCORED_PROBES } from '../../src/probes/registry.js';
import { AXE_RULES } from '../../src/report/criteria.js';
import { failingChecks, projectScore, reportChecks } from '../../src/report/projection.js';
import { RULE_CRITERION } from '../../src/ruleCriteria.js';
import { IN_CRITERION, criterionTotal, roundScore, ruleWeight } from '../../src/scoreCore.js';
import type { ProbeRun, SiteReport } from '../../src/types.js';
import { SCORING_VERSION } from '../../src/version.js';

const P = ['https://e.org/', 'https://e.org/a', 'https://e.org/b', 'https://e.org/c'];
const run = (page: string, probe: string, criterion: string, status: 'failed' | 'no_failures_found', minor = false): ProbeRun => ({
  probe, kind: 'render', page, criteria: [criterion], status: 'ok', ms: 1,
  findings: [{ criterion, status, detail: 'x', ...(minor ? { minor: true as const } : {}) }],
});
const report = (over: Partial<SiteReport> = {}): SiteReport => ({
  schemaVersion: 2, site: P[0]!, status: 'scored', score: 100, letter: 'A', headline: 'Access Granted', reasons: [],
  pages: P.map((url) => ({ url, status: 'ok', score: 100, violations: 0 })), rules: [], needsReview: [], documents: [], inventory: {} as SiteReport['inventory'],
  skipped: [], disclaimer: '', aiChecks: { ran: false, issues: [] },
  meta: { engine: '0', axe: '4.14.0', scoring: SCORING_VERSION, viewports: [], tags: [], enabledRules: [], userAgent: '', startedAt: '', finishedAt: '', pageList: P },
  ...over,
} as SiteReport);
const rule = (id: string, pages: string[], extra: object = {}) => ({ id, impact: 'serious' as const, help: '', helpUrl: '', pagesAffected: pages, elements: pages.length, pointsLost: 0, examples: [], ...extra });

describe('scoring v8: constants and flags', () => {
  it('is v8: within a criterion every check costs in full (calibrated); third-party at 0.75; minor at a quarter', () => {
    expect(SCORING_VERSION).toBe('v14');
    expect(IN_CRITERION).toBe(1);
    expect(THIRD_PARTY_FACTOR).toBe(0.75);
    expect(MINOR_FACTOR).toBe(0.25);
    expect(V8.inCriterion).toBe(IN_CRITERION);
  });

  it('scores every registry test but those not verified by the gold standard yet', () => {
    // Listed but not scored until the gold standard verifies them.
    const unscored = new Set(['keyboard-deep', 'controls', 'page-titles', 'route-titles', 'timing-entry', 'media-players', 'flash-motion', 'screen-reader', 'screen-reader-live', 'forced-colors', 'language-parts', 'names', 'media-alternatives', 'picture-text', 'state-text-contrast']);
    expect([...SCORED_PROBES].sort()).toEqual(PROBES.map((p) => p.id).filter((id) => !unscored.has(id)).sort());
    expect(SCORED_PROBES.has('link-purpose') && SCORED_PROBES.has('aria-states') && SCORED_PROBES.has('hover-content')).toBe(true);
  });

  it('reads a report from before the AI engine left with that report\'s gates and weights (frozen at scoring v13)', () => {
    expect(Object.keys(LEGACY_AI_GATES).sort()).toEqual(['altText', 'consistency', 'document', 'focusOrder', 'forms', 'listener', 'media', 'pageText', 'vision']);
    // The PDF review counts through the documents check (scoring v10): no page-share weights of its own.
    for (const [check, criteria] of Object.entries(LEGACY_AI_GATES)) {
      if (check === 'document') expect(LEGACY_AI_WEIGHTS.document).toBeUndefined();
      else expect(Object.keys(LEGACY_AI_WEIGHTS[check as 'altText']!).sort(), check).toEqual([...criteria!].sort());
    }
    expect(V8.ai).toBe(LEGACY_AI_WEIGHTS);
    expect(Object.keys(CONSISTENCY_WEIGHTS).sort()).toEqual(['2.4.5', '3.2.3', '3.2.4', '3.2.6']);
    expect(Object.keys(MEDIA_WEIGHTS).sort()).toEqual(['1.2.2', '1.4.2']);
  });

  it('a report the AI package scored carries its own weights and gates: the engine adds up what it says', () => {
    const issue = { check: 'vision' as const, criterion: '1.4.1', pagesAffected: [P[0]!], pagesTested: 2, pointsLost: 0, findings: [] };
    // The stamped weight wins over the legacy table; an issue with no weight anywhere costs nothing.
    expect(reportCriterionChecks(report({ aiChecks: { ran: true, issues: [{ ...issue, weight: 7 }] } } as Partial<SiteReport>))).toEqual([{ key: 'ai:vision:1.4.1', criterion: '1.4.1', weight: 7, share: 0.5 }]);
    expect(reportCriterionChecks(report({ aiChecks: { ran: true, issues: [{ ...issue, check: 'listener', criterion: '9.9.9' }] } } as Partial<SiteReport>))).toEqual([]);
    expect(reportCriterionChecks(report({ aiChecks: { ran: true, issues: [{ ...issue, check: 'listener', criterion: '9.9.9', weight: 1 }] } } as Partial<SiteReport>))).toEqual([{ key: 'ai:listener:9.9.9', criterion: '9.9.9', weight: 1, share: 0.5 }]);
    // A weight that is not a finite number of zero or more is no weight.
    for (const weight of [Number.NaN, -1, Number.POSITIVE_INFINITY]) expect(reportCriterionChecks(report({ aiChecks: { ran: true, issues: [{ ...issue, weight }] } } as Partial<SiteReport>))![0]!.weight).toBe(LEGACY_AI_WEIGHTS.vision!['1.4.1']);
    // Gates: the stamped ones, else the report's scoring version's.
    expect(aiGates(report({ aiChecks: { ran: true, issues: [], gates: { forms: ['3.3.4'] } } } as Partial<SiteReport>))).toEqual({ forms: ['3.3.4'] });
    expect(Object.keys(aiGates(report()))).toEqual(Object.keys(LEGACY_AI_GATES));
    expect(Object.keys(aiGates(report({ meta: { ...report().meta, scoring: 'v8' } })))).toEqual(['altText', 'vision', 'forms']);
    expect(aiGates(report({ meta: { ...report().meta, scoring: 'v7' } }))).toEqual({ altText: ['1.1.1', '1.4.5'] });
  });

  it('counts an axe rule under its first criterion, the same table the live score uses', () => {
    const first = new Map<string, string>();
    const order = (c: string) => c.split('.').map((x) => x.padStart(3, '0')).join('.');
    for (const [criterion, rules] of Object.entries(AXE_RULES)) for (const id of rules) if (!first.has(id) || order(criterion) < order(first.get(id)!)) first.set(id, criterion);
    expect(RULE_CRITERION).toEqual(Object.fromEntries([...first].sort(([a], [b]) => (a < b ? -1 : 1))));
    expect(primaryCriterion('link-name')).toBe('2.4.4');
    expect(primaryCriterion('label')).toBe('4.1.2');
  });
});

describe('scoring v8: one combined cost per criterion', () => {
  it('cost = the largest w × √share + inCriterion × the others; criteria add up; the order of checks never matters', () => {
    const c = (criterion: string, weight: number, share: number): CriterionCheck => ({ key: `k${weight}${criterion}`, criterion, weight, share });
    const checks = [c('4.1.2', 7, 1), c('4.1.2', 7, 0.25), c('1.4.3', 9, 1)];
    expect(criterionTotal(checks, 0.5)).toBeCloseTo(7 + 0.5 * 3.5 + 9, 10);
    expect(criterionTotal(checks, 0)).toBeCloseTo(7 + 9, 10);
    expect(criterionTotal(checks)).toBeCloseTo(7 + 3.5 + 9, 10);
    expect(criterionTotal([...checks].reverse())).toBe(criterionTotal(checks));
    expect(criterionScore(checks)).toBeCloseTo(100 - 18 * Math.log1p(19.5 / 10), 10);
  });

  it('two axe rules of one criterion are one combined result: at the calibrated share 1 their costs add up', () => {
    const r = report({ rules: [rule('button-name', [P[0]!]), rule('select-name', [P[0]!])] });
    const checks = reportCriterionChecks(r)!;
    expect(checks.map((x) => [x.key, x.criterion])).toEqual([['rule:button-name', '4.1.2'], ['rule:select-name', '4.1.2']]);
    expect(criterionTotal(checks)).toBeCloseTo(ruleWeight('button-name', 'serious') * 0.5 + 7 * 0.5, 10);
  });

  it('a test criterion and an axe rule of the same criterion combine; a minor page costs a quarter', () => {
    const runs = [run(P[0]!, 'form-fields', '3.3.2', 'failed', true), run(P[1]!, 'form-fields', '3.3.2', 'failed'), run(P[2]!, 'form-fields', '3.3.2', 'no_failures_found'), run(P[3]!, 'form-fields', '3.3.2', 'no_failures_found')];
    const checks = reportCriterionChecks(report({ probes: { runs } }))!;
    // One check: the full page's cost plus a quarter of the minor page's, w × (√0.25 + ¼ × √0.25).
    expect(checks).toEqual([{ key: 'criterion:3.3.2', criterion: '3.3.2', weight: v8ProbeWeight('3.3.2'), share: (0.5 + MINOR_FACTOR * 0.5) ** 2 }]);
    expect(criterionTotal(checks)).toBeCloseTo(v8ProbeWeight('3.3.2') * (0.5 + MINOR_FACTOR * 0.5), 10);
  });

  it('colour contrast on pages where every element is within 10% of its ratio costs a quarter there', () => {
    const checks = reportCriterionChecks(report({ rules: [rule('color-contrast', [P[0]!, P[1]!], { minorPages: [P[1]!] })] }))!;
    expect(checks).toEqual([{ key: 'rule:color-contrast', criterion: '1.4.3', weight: 9, share: (0.5 + MINOR_FACTOR * 0.5) ** 2 }]);
    const minorOnly = reportCriterionChecks(report({ rules: [rule('color-contrast', [P[1]!], { minorPages: [P[1]!] })] }))!;
    expect(minorOnly).toEqual([{ key: 'rule:color-contrast', criterion: '1.4.3', weight: 9 * MINOR_FACTOR, share: 0.25, minor: true }]);
  });

  it('third-party frames, cross-page rules, media rules, gated AI checks and documents each become checks', () => {
    const r = report({
      thirdParty: [{ origin: 'https://maps.example', id: 'image-alt', impact: 'critical', help: '', helpUrl: '', pagesAffected: [P[1]!], elements: 1, examples: [] }],
      consistency: [{ criterion: '3.2.3', method: { id: 'consistency', kind: 'rules', status: 'failed', pages: 2 }, evidence: [{ page: P[1]!, detail: '' }, { page: P[2]!, detail: '' }] }],
      media: [{ kind: 'video', content: 'video', url: 'https://e.org/v.webm', foundOn: [P[3]!], captions: 'none', issues: [{ criterion: '1.2.2', level: 'problem', rule: 'no-captions-track', message: '' }] }],
      aiChecks: { ran: true, issues: [{ check: 'vision', criterion: '1.4.1', pagesAffected: [P[0]!], pagesTested: 2, pointsLost: 0, findings: [] }, { check: 'pageText', criterion: '2.4.4', pagesAffected: [P[0]!], pagesTested: 4, pointsLost: 0, findings: [] }, { check: 'document', criterion: '1.3.1', pagesAffected: [P[0]!], pagesTested: 1, pointsLost: 0, findings: [] }] },
      documentChecks: [{ url: 'https://e.org/a.pdf', type: 'pdf', detectedBy: 'extension', linkedFrom: [], checks: { pages: 1, pagesChecked: 1, tagged: false, hasLanguage: true, hasTitle: true, showsTitle: true, imageOnly: false, figuresWithoutAlt: 0, formFields: 0, untitledFormFields: 0, xfa: false, blocksAssistiveTech: false } }],
      documentScore: { scored: true, checked: 1, failed: 1, pointsLost: 0 },
    } as Partial<SiteReport>);
    expect(reportCriterionChecks(r)).toEqual([
      { key: 'ai:pageText:2.4.4', criterion: '2.4.4', weight: LEGACY_AI_WEIGHTS.pageText!['2.4.4'], share: 0.25 },
      { key: 'ai:vision:1.4.1', criterion: '1.4.1', weight: LEGACY_AI_WEIGHTS.vision!['1.4.1'], share: 0.5 },
      { key: 'consistency:3.2.3', criterion: '3.2.3', weight: CONSISTENCY_WEIGHTS['3.2.3'], share: 0.5 },
      { key: 'documents', criterion: 'documents', weight: 4, share: 1 },
      { key: 'media:1.2.2', criterion: '1.2.2', weight: MEDIA_WEIGHTS['1.2.2'], share: 1, pages: [P[3]!], of: 1 },
      { key: 'third-party:image-alt', criterion: '1.1.1', weight: ruleWeight('image-alt', 'critical') * THIRD_PARTY_FACTOR, share: 0.25 },
    ]);
  });

  it('scoring v9: a confirmed focus-order answer is a check under 2.4.3 at half the test weight', () => {
    // Which answers count is the AI package's (its aiScoringV8.test.ts); a report from before reads at v13's weight.
    expect(LEGACY_AI_WEIGHTS.focusOrder).toEqual({ '2.4.3': PROBE_CHECK_WEIGHT / 2 });
    const r = report({ aiChecks: { ran: true, issues: [{ check: 'focusOrder', criterion: '2.4.3', pagesAffected: [P[0]!], pagesTested: 2, pointsLost: 0, findings: [] }] } } as Partial<SiteReport>);
    expect(reportCriterionChecks(r)).toEqual([{ key: 'ai:focusOrder:2.4.3', criterion: '2.4.3', weight: 2, share: 0.5 }]);
  });

  it('a confirmed AI captions failure joins the one verdict for 1.2.2: one share over the union of pages, at the costliest weight', () => {
    const video = (page: string, captions: 'none' | 'track') => ({ kind: 'video', content: 'video', url: `${page}v.webm`, foundOn: [page], captions, issues: captions === 'none' ? [{ criterion: '1.2.2', level: 'problem', rule: 'no-captions-track', message: '' }] : [] });
    const ai = (pages: string[]) => ({ ran: true, issues: [{ check: 'media' as const, criterion: '1.2.2', pagesAffected: pages, pagesTested: 2, pointsLost: 0, findings: [] }] });
    // Captions present on both pages, wrong on the first: the AI answer alone fails 1.2.2 there, over the 2 pages with video.
    const alone = reportCriterionChecks(report({ media: [video(P[0]!, 'track'), video(P[1]!, 'track')], aiChecks: ai([P[0]!]) } as Partial<SiteReport>));
    expect(alone).toEqual([{ key: 'ai:media:1.2.2', criterion: '1.2.2', weight: LEGACY_AI_WEIGHTS.media!['1.2.2'], share: 0.5, pages: [P[0]!], of: 2 }]);
    // No captions on the second page as well: one verdict over both pages, not two costs added.
    const both = report({ media: [video(P[0]!, 'track'), video(P[1]!, 'none')], aiChecks: ai([P[0]!]) } as Partial<SiteReport>);
    const once = scoreReportV8(both)!;
    const onlyRule = scoreReportV8(report({ media: [video(P[0]!, 'none'), video(P[1]!, 'none')] } as Partial<SiteReport>))!;
    expect(once.score).toBe(onlyRule.score);
  });

  it('scoring v10: a checked PDF with a confirmed AI document problem fails the documents check, never as a title-only one', () => {
    const pdf = (url: string, over: object = {}) => ({ url, type: 'pdf', detectedBy: 'extension', linkedFrom: [P[0]!], checks: { pages: 1, pagesChecked: 1, tagged: true, hasLanguage: true, hasTitle: true, showsTitle: true, imageOnly: false, figuresWithoutAlt: 0, formFields: 0, untitledFormFields: 0, xfa: false, blocksAssistiveTech: false, ...over } });
    const finding = (page: string, scored: boolean) => ({ check: 'document' as const, criterion: '1.3.2', page, target: 'Reading order', verdict: 'order_jumps', label: 'Reading order jumps around', flagged: true, confidence: 'high' as const, observed: 'x', issue: '', suggestion: '', source: 'ai' as const, ...(scored ? { scored: true } : {}) });
    const ai = (fs: ReturnType<typeof finding>[]) => ({ disclaimer: '', runs: [{ check: 'document' as const, title: 'PDF review', summary: '', model: 'm', promptVersion: 'document@2', tier: 'deep' as const, inputs: 3, reviewed: 3, cached: 0, notReviewed: 0, findings: fs }] });
    const docs = [pdf('https://e.org/a.pdf'), pdf('https://e.org/b.pdf', { showsTitle: false }), pdf('https://e.org/c.pdf')];
    const base = { documentChecks: docs, documentScore: { scored: true, checked: 3, failed: 0, pointsLost: 0 } } as Partial<SiteReport>;
    const docCheck = (r: SiteReport) => reportCriterionChecks(r)!.find((c) => c.key === 'documents');
    // a.pdf: confirmed (fails in full); b.pdf: title not shown (minor) AND confirmed (fails in full); c.pdf: an unconfirmed opinion (clean).
    const withAi = report({ ...base, ai: ai([finding('https://e.org/a.pdf', true), finding('https://e.org/b.pdf', true), finding('https://e.org/c.pdf', false), finding('https://e.org/unchecked.pdf', true)]) } as Partial<SiteReport>);
    expect(docCheck(withAi)).toEqual({ key: 'documents', criterion: 'documents', weight: 4, share: 2 / 3 });
    // The same report scored with v9: the AI review's PDF answers never counted then (b.pdf is the minor title-only one).
    const v9 = report({ ...base, ai: withAi.ai, meta: { ...withAi.meta, scoring: 'v9' } } as Partial<SiteReport>);
    expect(docCheck(v9)).toMatchObject({ key: 'documents', minor: true, share: 1 / 3 });
    // No confirmed answer: only the quick checks decide.
    expect(docCheck(report({ ...base, ai: ai([finding('https://e.org/a.pdf', false)]) } as Partial<SiteReport>))).toMatchObject({ minor: true, share: 1 / 3 });
  });

  it('the report, its "+N if fixed" and its projection are one computation', () => {
    const r = report({ rules: [rule('color-contrast', P), rule('link-name', [P[0]!])], probes: { runs: P.map((u, i) => run(u, 'keyboard', '2.4.7', i ? 'no_failures_found' : 'failed')) } });
    const v8 = scoreReportV8(r)!;
    const scored = { ...r, score: v8.score };
    expect(reportChecks(scored)).toEqual(failingChecks(scored));
    expect(projectScore(scored, [])).toBe(v8.score);
    expect(projectScore(scored, ['rule:color-contrast'])! - v8.score).toBe(v8.pointsLost.get('rule:color-contrast'));
    expect(v8.score).toBe(roundScore(criterionScore(v8.checks)));
    // An altered report (another score) has no projection.
    expect(reportChecks({ ...r, score: v8.score + 1 })).toBeNull();
  });
});

describe('scoring v8: deep tests count only when they ran (hosted paid scans run them; the free check does not)', () => {
  const core = P.map((u, i) => run(u, 'keyboard', '2.4.7', i === 0 ? 'failed' : 'no_failures_found'));
  const deep = P.map((u, i) => run(u, 'hover-content', '1.4.13', i === 1 ? 'failed' : 'no_failures_found'));
  it('a paid scan (core and deep tests): the deep test\'s failure is a check of its own', () => {
    const keys = reportCriterionChecks(report({ probes: { runs: [...core, ...deep] } }))!.map((c) => c.key);
    expect(keys).toEqual(['criterion:1.4.13', 'criterion:2.4.7']);
  });
  it('the free check (core tests only): only what ran is scored, and a deep test that did not run costs nothing', () => {
    const only = report({ probes: { runs: core } });
    expect(reportCriterionChecks(only)!.map((c) => c.key)).toEqual(['criterion:2.4.7']);
    const withDeep = scoreReportV8(report({ probes: { runs: [...core, ...deep] } }))!.score;
    expect(scoreReportV8(only)!.score).toBeGreaterThan(withDeep);
    // A deep test that ran clean costs nothing either.
    const clean = P.map((u) => run(u, 'hover-content', '1.4.13', 'no_failures_found'));
    expect(scoreReportV8(report({ probes: { runs: [...core, ...clean] } }))!.score).toBe(scoreReportV8(only)!.score);
  });
});
