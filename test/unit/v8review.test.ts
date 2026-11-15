// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Scoring v8, review round 1 (Grok r1): each finding closed as a class, test-first.
import { describe, expect, it } from 'vitest';
import { MEDIA_WEIGHTS, criterionTotal, reportCriterionChecks, v8ProbeWeight } from '../../src/criterionScore.js';
import { mediaItems } from '../../src/media/index.js';
import { buildReport as build } from '../../src/report/build.js';
import { projectScore } from '../../src/report/projection.js';
import { countsTowardScore } from '../../src/report/scoreScope.js';
import { scoringScope } from '../../src/report/scope.js';
import type { DocumentCheck, PageAudit, ProbeRun, SiteReport } from '../../src/types.js';
import { costsNotShown } from '../helpers/costsShown.js';

const U = (p: string) => `https://e.org${p}`;
const P4 = ['/', '/a', '/b', '/c'];
const finding = (id: string, summary?: string) => ({ id, help: id, helpUrl: 'https://x', nodes: [{ target: '.x', html: '<img src="x.png">', viewports: ['desktop' as const], ...(summary ? { failureSummary: summary } : {}) }] });
const clean = (p: string, extra: Partial<PageAudit> = {}): PageAudit => ({ url: U(p), status: 'ok', rules: { 'image-alt': 'pass', 'color-contrast': 'pass' }, violations: [], incomplete: [], links: [], ...extra });
const base = { site: U('/'), documents: [], skipped: [], startedAt: 't', finishedAt: 't', userAgent: 'ua' };
/** Every report this file builds, for the invariant at the end. */
const built: SiteReport[] = [];
const buildReport = (input: Parameters<typeof build>[0]) => {
  const r = build(input);
  built.push(r);
  return r;
};

describe('finding 2: media is judged per page and element, whatever the scan order', () => {
  const page = (p: string, el: { autoplay: boolean; controls: boolean }) => ({
    url: U(p), status: 'ok' as const, rules: {}, violations: [], incomplete: [], links: [],
    collected: { media: { elements: [{ tag: 'video' as const, audio: 'present' as const, src: U('/a.mp4'), tracks: [], autoplay: el.autoplay, muted: false, controls: el.controls, loop: false, transcriptNearby: false }], frames: [], links: [] } },
  });
  it('the same file needs autoplay review only on the applicable page, in both orders', () => {
    for (const order of [['/', '/b'], ['/b', '/']]) {
      const pages = order.map((p) => page(p, p === '/b' ? { autoplay: true, controls: false } : { autoplay: false, controls: true }));
      const items = mediaItems(pages);
      const reviewPages = items.filter((m) => m.issues.some((i) => i.criterion === '1.4.2' && i.level === 'review')).flatMap((m) => m.foundOn);
      expect(reviewPages.sort(), order.join(',')).toEqual([U('/b')]);
    }
  });
});

const audioRun = (page: string, status: 'failed' | 'no_failures_found'): ProbeRun => ({
  probe: 'audio', kind: 'interaction', page: U(page), criteria: ['1.4.2'], status: 'ok', ms: 1, findings: [{ criterion: '1.4.2', status, detail: 'x' }],
});
const autoplayItem = (pages: string[]) => ({ kind: 'audio' as const, content: 'audio' as const, url: U('/t.wav'), foundOn: pages.map(U), autoplay: true, muted: false, controls: false, captions: 'no-transcript' as const,
  issues: [{ criterion: '1.4.2', level: 'problem' as const, rule: 'autoplay-sound-no-controls' as const, message: 'x' }] });

describe('finding 3: 1.4.2 is counted once per clip', () => {
  it('the media rule yields to the audio test on a page it tested and found a working control', () => {
    const r = buildReport({ ...base, pages: P4.map((p) => clean(p)), media: [autoplayItem(['/'])], probeRuns: P4.map((p) => audioRun(p, 'no_failures_found')) });
    expect(reportCriterionChecks(r)!.filter((c) => c.criterion === '1.4.2')).toEqual([]);
    expect(r.score).toBe(100);
    // And the WCAG row agrees: the media rules' flag on that page yields to the test.
    const row = r.criteria!.find((c) => c.criterion === '1.4.2')!;
    expect(row.methods.find((m) => m.id === 'media-rules')!.status).not.toBe('failed');
    expect(row.status).not.toBe('failed');
  });
  it('one clip the audio test fails, that the media rule flags and that axe fails is one share at one weight, never the three added up', () => {
    const pages = P4.map((p, i) => clean(p, i === 0 ? { rules: { 'no-autoplay-audio': 'fail' }, violations: [finding('no-autoplay-audio')] } : {}));
    const r = buildReport({ ...base, pages, media: [autoplayItem(['/'])], probeRuns: P4.map((p, i) => audioRun(p, i === 0 ? 'failed' : 'no_failures_found')) });
    const k142 = reportCriterionChecks(r)!.filter((c) => c.criterion === '1.4.2');
    expect(k142.map((c) => c.key).sort()).toEqual(['criterion:1.4.2', 'media:1.4.2', 'rule:no-autoplay-audio']);
    // The failing pages ({/}) over the pages any method judged (the four the test listened to).
    expect(criterionTotal(k142)).toBeCloseTo(Math.max(...k142.map((c) => c.weight)) * Math.sqrt(1 / 4), 10);
    expect(criterionTotal(k142)).toBeLessThan(k142.reduce((a, c) => a + c.weight * Math.sqrt(c.share), 0));
  });
  it('with no audio test on the page, axe and the media rule are one share too', () => {
    const pages = P4.map((p, i) => clean(p, i === 0 ? { rules: { 'no-autoplay-audio': 'fail' }, violations: [finding('no-autoplay-audio')] } : {}));
    const r = buildReport({ ...base, pages, media: [autoplayItem(['/'])] });
    const k142 = reportCriterionChecks(r)!.filter((c) => c.criterion === '1.4.2');
    expect(criterionTotal(k142)).toBeCloseTo(Math.max(...k142.map((c) => c.weight)), 10);
  });
  it('the other criteria still add their checks up (IN_CRITERION 1)', () => {
    const two = [{ key: 'rule:a', criterion: '1.1.1', weight: 4, share: 1 }, { key: 'rule:b', criterion: '1.1.1', weight: 3, share: 1 }];
    expect(criterionTotal(two)).toBeCloseTo(7, 10);
  });
});

describe('finding 4: a page\'s score follows the v8 rules', () => {
  it('a minor contrast failure: the page scores what the site scores', () => {
    const pages = [clean('/', { rules: { 'color-contrast': 'fail' }, violations: [finding('color-contrast', 'Element has insufficient color contrast of 4.4 (foreground color: #777, background color: #fff). Expected contrast ratio of 4.5:1')] })];
    const r = buildReport({ ...base, pages });
    expect(r.pages[0]!.score).toBe(r.score);
  });
  it('a third-party failure only: the page loses points too', () => {
    const r = buildReport({ ...base, pages: [clean('/', { thirdParty: [{ url: 'https://maps.example/embed', violations: [finding('image-alt')] }] })] });
    expect(r.score!).toBeLessThan(100);
    expect(r.pages[0]!.score).toBe(r.score);
  });
});

describe('finding 4, on a site of four pages', () => {
  const minorSum = 'Element has insufficient color contrast of 4.4 (foreground color: #777, background color: #fff). Expected contrast ratio of 4.5:1';
  it('each page scores what a scan of that page alone would, and clean pages score 100', () => {
    const pages = P4.map((p, i) => clean(p, i === 0 ? { rules: { 'color-contrast': 'fail' }, violations: [finding('color-contrast', minorSum)] }
      : i === 1 ? { thirdParty: [{ url: 'https://maps.example/embed', violations: [finding('image-alt')] }] } : {}));
    const r = buildReport({ ...base, pages });
    const alone = (i: number) => buildReport({ ...base, pages: [pages[i]!] }).score;
    expect(r.pages.map((x) => x.score)).toEqual([alone(0), alone(1), 100, 100]);
    expect(r.pages[0]!.score!).toBeGreaterThan(88);
    expect(r.pages[1]!.score!).toBeLessThan(100);
  });
});

describe('finding 5: a check cut short is never read as a pass', () => {
  it('core tests: two clean pages and three never returned read "Partly tested: 2 of 5 pages"', () => {
    const runs: ProbeRun[] = ['/', '/a'].map((p) => ({ probe: 'keyboard', kind: 'interaction', page: U(p), criteria: ['2.1.2'], status: 'ok', ms: 1, findings: [] }));
    const abandoned: ProbeRun[] = ['/b', '/c', '/d'].map((p) => ({ probe: 'keyboard', kind: 'interaction', page: U(p), criteria: ['2.1.2'], status: 'timeout', ms: 0, findings: [{ criterion: '2.1.2', status: 'not_testable', detail: 'x', timeLimit: true }] }));
    const r = buildReport({ ...base, pages: ['/', '/a', '/b', '/c', '/d'].map((p) => clean(p)), probeRuns: [...runs, ...abandoned] });
    const m = r.criteria!.find((x) => x.criterion === '2.1.2')!.methods.find((x) => x.id === 'keyboard')!;
    expect(m.status).toBe('not_testable');
    expect(m.note).toBe('Partly tested: 2 of 5 pages (the scan ran out of time)');
  });
});

describe('review round 2, item 2: a media criterion is one share over every method\'s failing pages, at one weight', () => {
  const P2 = ['/', '/b'];
  const audio = (page: string, status: 'failed' | 'no_failures_found'): ProbeRun => ({ probe: 'audio', kind: 'interaction', page: U(page), criteria: ['1.4.2'], status: 'ok', ms: 1, findings: [{ criterion: '1.4.2', status, detail: 'x' }] });
  const k142 = (r: SiteReport) => reportCriterionChecks(r)!.filter((c) => c.criterion === '1.4.2');
  it('a Web Audio-only page (the listening test alone fails it) costs the criterion\'s one weight (the media rule\'s), and blocks Access Granted', () => {
    const W = MEDIA_WEIGHTS['1.4.2']!;
    expect(v8ProbeWeight('1.4.2')).toBe(W);
    const r = buildReport({ ...base, pages: [clean('/')], probeRuns: [audio('/', 'failed')] });
    expect(k142(r).map((c) => [c.key, c.weight])).toEqual([['criterion:1.4.2', W]]);
    expect(criterionTotal(k142(r))).toBeCloseTo(W, 10);
    expect(r.headline).toBe('Access Denied');
  });
  it('page 1 native autoplay and page 2 Web Audio only: costs more than page 1 alone, and fixing page 1 leaves page 2 failing', () => {
    const both = buildReport({ ...base, pages: P2.map((p) => clean(p)), media: [autoplayItem(['/'])], probeRuns: [audio('/', 'failed'), audio('/b', 'failed')] });
    const one = buildReport({ ...base, pages: P2.map((p) => clean(p)), media: [autoplayItem(['/'])], probeRuns: [audio('/', 'failed'), audio('/b', 'no_failures_found')] });
    const fixed = buildReport({ ...base, pages: P2.map((p) => clean(p)), probeRuns: [audio('/', 'no_failures_found'), audio('/b', 'failed')] });
    expect(criterionTotal(k142(both))).toBeGreaterThan(criterionTotal(k142(one)));
    // One share at one weight: the union of the failing pages (both) over the pages any method judged (both).
    const W = MEDIA_WEIGHTS['1.4.2']!;
    expect(criterionTotal(k142(both))).toBeCloseTo(W, 10);
    expect(criterionTotal(k142(one))).toBeCloseTo(W * Math.sqrt(1 / 2), 10);
    expect(criterionTotal(k142(fixed))).toBeCloseTo(W * Math.sqrt(1 / 2), 10);
    for (const r of [both, one, fixed]) expect(r.headline).toBe('Access Denied');
    // Fixing one method's problem (its key) gives back only what the others do not still fail.
    expect(projectScore(both, ['media:1.4.2'])).toBe(both.score);
  });
});

describe('finding 7: every version before v8 describes what was true for it', () => {
  it('a v3 report: third-party, media, cross-page and deep tests did not count', () => {
    const r = { ...buildReport({ ...base, pages: [clean('/')] }), meta: { ...buildReport({ ...base, pages: [clean('/')] }).meta, scoring: 'v3' } } as SiteReport;
    for (const k of ['third-party', 'media', 'consistency', 'deep'] as const) expect(countsTowardScore(r, k), k).toBe(false);
    expect(scoringScope(r).thirdParty).toBe(false);
  });
});

describe('finding 8: the documents check costs at most its weight', () => {
  it('full failures and title-only PDFs together are one check, at most 4', () => {
    const pdf = (n: string, c: Partial<NonNullable<DocumentCheck['checks']>>) => ({ url: U(`/${n}.pdf`), type: 'pdf', detectedBy: 'extension', linkedFrom: [U('/')], checks: { pages: 1, pagesChecked: 1, tagged: true, hasLanguage: true, hasTitle: true, showsTitle: true, imageOnly: false, figuresWithoutAlt: 0, formFields: 0, untitledFormFields: 0, xfa: false, blocksAssistiveTech: false, ...c } }) as DocumentCheck;
    const r = buildReport({ ...base, pages: [clean('/')], documentChecks: [pdf('a', { tagged: false }), pdf('b', { hasTitle: false })] });
    const docs = reportCriterionChecks(r)!.filter((c) => c.key === 'documents');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.weight * Math.sqrt(docs[0]!.share)).toBeLessThanOrEqual(4);
  });
});

describe('finding 8, as a class: no key costs more than its weight', () => {
  it('a rule failing every page, some in full and some minor, costs at most its weight', () => {
    const sum = 'Element has insufficient color contrast of 4.4 (foreground color: #777, background color: #fff). Expected contrast ratio of 4.5:1';
    const pages = P4.map((p, i) => clean(p, { rules: { 'color-contrast': 'fail' }, violations: [finding('color-contrast', i ? sum : 'Element has insufficient color contrast of 2.1 (foreground color: #ccc, background color: #fff). Expected contrast ratio of 4.5:1')] }));
    const checks = reportCriterionChecks(buildReport({ ...base, pages }))!.filter((c) => c.key === 'rule:color-contrast');
    expect(checks).toHaveLength(1);
    expect(checks[0]!.share).toBeLessThanOrEqual(1);
  });
});

describe('the invariant, over every report above', () => {
  it('a criterion that costs points is never shown as passing', () => {
    expect(built.length).toBeGreaterThan(10);
    for (const r of built) expect(costsNotShown(r), r.pages.map((p) => p.url).join(' ')).toEqual([]);
  });
});
