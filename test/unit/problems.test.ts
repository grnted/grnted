// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Report v2 problem model (spec §5): buildProblems turns a SiteReport into "Fix these first".
import { describe, expect, it } from 'vitest';
import { buildReport } from '../../src/report/build.js';
import { DOCUMENTS_COPY, GENERIC_RULE_COPY, copyForCriterion, copyForRule } from '../../src/report/copy/index.js';
import { buildProblems, ownerCounts, problemsLede } from '../../src/report/problems.js';
import type { Problem } from '../../src/report/model.js';
import type { DocumentCheck, EvidenceShot, Impact, PageAudit, ProbeRun, RuleSummary, SiteReport, TestIssueSummary } from '../../src/types.js';

const base = { documents: [], skipped: [], startedAt: '2026-10-31T00:00:00.000Z', finishedAt: '2026-10-31T00:01:00.000Z', userAgent: 'UA' };
const page = (url: string, over: Partial<PageAudit> = {}): PageAudit => ({ url, status: 'ok', rules: {}, violations: [], incomplete: [], links: [], ...over });
const node = (html: string, target = 'x') => ({ target, html, viewports: ['desktop' as const] });
const fail = (id: string, nodes: ReturnType<typeof node>[]) => ({ id, help: `${id} help`, helpUrl: `https://x/${id}`, nodes });
const emptyReport = (): SiteReport => buildReport({ ...base, site: 'https://e.org/', pages: [page('https://e.org/'), page('https://e.org/b'), page('https://e.org/c')] });

const rule = (id: string, impact: Impact, pointsLost: number, pages: string[], elements: number, over: Partial<RuleSummary> = {}): RuleSummary => ({
  id, impact, help: `${id} help`, helpUrl: `https://x/${id}`, pagesAffected: pages, elements, pointsLost,
  examples: pages.map((p, i) => ({ page: p, target: `#${id}-${i}`, html: `<a href="/${i}">x</a>` })), ...over,
});
const issue = (criterion: string, pointsLost: number, pages: string[]): TestIssueSummary => ({
  criterion, title: criterion, probes: ['keyboard'], pagesAffected: pages, pointsLost,
  evidence: pages.map((p) => ({ page: p, target: 'header', detail: `fails on ${p}` })),
});
const run = (probe: string, pageUrl: string, criteria: string[], findings: ProbeRun['findings']): ProbeRun =>
  ({ probe, kind: 'interaction', page: pageUrl, criteria, status: 'ok', findings, ms: 1 });
const shot = (id: string, forWhat: EvidenceShot['for'], over: Partial<EvidenceShot> = {}): EvidenceShot => ({
  id, page: 'https://e.org/', viewport: { width: 1280, height: 900, deviceScaleFactor: 1 }, width: 100, height: 100, boxes: [], alt: `shot ${id}`, for: forWhat, ...over,
});
const keys = (ps: Problem[]) => ps.map((p) => p.key);
const A = 'https://e.org/';
const B = 'https://e.org/b';
const C = 'https://e.org/c';

describe('buildProblems: order', () => {
  const r: SiteReport = {
    ...emptyReport(),
    rules: [
      rule('label', 'critical', 0, [A], 1),
      rule('color-contrast', 'serious', 5, [A, B], 4),
      rule('image-alt', 'critical', 5, [A], 1),
      rule('link-name', 'serious', 5, [A, B], 9),
      rule('list', 'serious', 5, [A, B], 9),
      rule('target-size', 'serious', 2, [A], 1),
    ],
    testIssues: [issue('2.4.11', 3, [A, B]), issue('1.4.10', 2, [A, B, C])],
    probes: { runs: [
      run('keyboard', A, ['2.4.11'], [{ criterion: '2.4.11', status: 'failed', target: 'header', detail: 'covered' }]),
      run('hover-content', B, ['1.4.13'], [{ criterion: '1.4.13', status: 'failed', detail: 'vanishes' }]),
      run('hover-content', C, ['1.4.13'], [{ criterion: '1.4.13', status: 'failed', detail: 'vanishes' }]),
      run('pointer-gestures', A, ['2.5.1', '2.5.7'], [{ criterion: '2.5.7', status: 'failed', detail: 'drag only' }, { criterion: '2.5.1', status: 'flagged', detail: 'maybe' }]),
    ] },
    documentChecks: [{ url: 'https://e.org/a.pdf', type: 'pdf', detectedBy: 'extension', linkedFrom: [A], checks: { pages: 2, pagesChecked: 2, tagged: false } }],
  };
  const ps = buildProblems(r);

  it('scored by points, impact, pages, elements, key; then unscored; documents last', () => {
    expect(keys(ps)).toEqual([
      'rule:image-alt', // 5 points, critical
      'rule:link-name', // 5, serious, 2 pages, 9 elements (tie with list broken by key)
      'rule:list',
      'rule:color-contrast', // 5, serious, 2 pages, 4 elements
      'criterion:2.4.11', // 3 (probe criteria weigh as serious)
      'criterion:1.4.10', // 2, serious, 3 pages
      'rule:target-size', // 2, serious, 1 page
      'rule:label', // 0 points, still scored
      'criterion:1.4.13', // unscored, 2 pages
      'criterion:2.5.7', // unscored, 1 page
      'documents',
    ]);
  });

  it('scored problems carry points; unscored and documents do not', () => {
    const by = Object.fromEntries(ps.map((p) => [p.key, p]));
    expect(by['rule:image-alt']).toMatchObject({ scored: true, pointsLost: 5, pages: [A], count: { n: 1, unit: 'element' } });
    expect(by['rule:link-name']!.count).toEqual({ n: 9, unit: 'link' });
    expect(by['criterion:2.4.11']).toMatchObject({ scored: true, pointsLost: 3, pages: [A, B], count: { n: 2, unit: 'page' } });
    expect(by['criterion:1.4.13']).toMatchObject({ scored: false, pointsLost: 0, pages: [B, C], count: { n: 2, unit: 'page' } });
    expect(by['documents']).toMatchObject({ scored: false, pointsLost: 0, count: { n: 1, unit: 'document' }, pages: [A] });
    expect(by['criterion:2.5.1']).toBeUndefined(); // flagged is not a failure
  });

  it('uses the copy library and lists criteria with levels', () => {
    const by = Object.fromEntries(ps.map((p) => [p.key, p]));
    expect(by['rule:image-alt']!.copy).toBe(copyForRule('image-alt'));
    expect(by['criterion:2.4.11']!.copy).toBe(copyForCriterion('2.4.11'));
    expect(by['documents']!.copy).toBe(DOCUMENTS_COPY);
    expect(by['rule:link-name']!.criteria).toEqual([{ criterion: '2.4.4', level: 'A' }, { criterion: '4.1.2', level: 'A' }]);
    expect(by['rule:color-contrast']!.criteria).toEqual([{ criterion: '1.4.3', level: 'AA' }]);
    expect(by['criterion:2.4.11']!.criteria).toEqual([{ criterion: '2.4.11', level: 'AA' }]);
    expect(by['documents']!.criteria).toEqual([{ criterion: '1.3.1', level: 'A' }]); // only the checks that failed
  });

  it('text evidence: up to 3, plain', () => {
    const by = Object.fromEntries(ps.map((p) => [p.key, p]));
    expect(by['rule:image-alt']!.textEvidence).toEqual([{ page: A, target: '#image-alt-0', detail: 'Failing element: <a href="/0">x</a>' }]);
    expect(by['criterion:1.4.10']!.textEvidence).toHaveLength(3);
    expect(by['criterion:1.4.13']!.textEvidence).toEqual([{ page: B, detail: 'vanishes' }, { page: C, detail: 'vanishes' }]);
    const many = buildProblems({ ...r, rules: [rule('image-alt', 'critical', 1, [A, B, C, 'https://e.org/d'], 4)] });
    expect(many.find((p) => p.key === 'rule:image-alt')!.textEvidence).toHaveLength(3);
  });

  it('an unknown rule id gets the generic copy and no criteria', () => {
    const ps2 = buildProblems({ ...r, rules: [rule('brand-new-rule', 'moderate', 1, [A], 1)], testIssues: [] });
    expect(ps2[0]!.copy).toBe(GENERIC_RULE_COPY);
    expect(ps2[0]!.criteria).toEqual([]);
  });

  it('ownerCounts counts problems by owner', () => {
    expect(ownerCounts(ps)).toEqual({ developer: 8, content: 2, documents: 1 });
    expect(ownerCounts([])).toEqual({ developer: 0, content: 0, documents: 0 });
  });
});

describe('buildProblems: empty and incomplete reports', () => {
  it('a clean report has no problems', () => {
    expect(buildProblems(emptyReport())).toEqual([]);
  });
  it('a report with no loaded pages has no problems and does not throw', () => {
    const r = buildReport({ ...base, site: A, pages: [page(A, { status: 'failed', reason: 'HTTP 500' })] });
    expect(r.status).toBe('incomplete');
    expect(buildProblems(r)).toEqual([]);
  });
  it('an older report without testIssues, probes, documentChecks or evidence still works', () => {
    const r = emptyReport();
    const old = { ...r, rules: [rule('image-alt', 'critical', 3, [A], 1)] } as SiteReport;
    delete old.testIssues; delete old.probes; delete old.documentChecks; delete old.evidence;
    expect(keys(buildProblems(old))).toEqual(['rule:image-alt']);
  });
});

describe('buildProblems: repetition across loaded pages', () => {
  const pad = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`p${i}`, 'pass' as const]));
  // The same header link (ids, data-* and numeric class suffixes differ per page) on some pages.
  const linkOn = (n: number) => fail('link-name', [node(`<a id="logo-${n}" class="brand brand-${n}" data-astro-cid-x${n} href="/"><img src="/logo.svg"></a>`)]);
  const site = (fails: Record<string, PageAudit['violations']>, failedPage?: PageAudit['violations']) => buildReport({
    ...base, site: A,
    pages: [
      ...[A, B, C, 'https://e.org/d'].map((u) => page(u, { rules: { ...pad, ...(fails[u] ? Object.fromEntries(fails[u]!.map((f) => [f.id, 'fail' as const])) : {}) }, violations: fails[u] ?? [] })),
      page('https://e.org/e', { status: 'failed', reason: 'HTTP 500', violations: failedPage ?? [] }),
    ],
  });

  it('the same element on 3 of 4 loaded pages repeats', () => {
    const r = site({ [A]: [linkOn(1)], [B]: [linkOn(2)], [C]: [linkOn(3)] });
    // Batch 19: each pattern carries an example (its first page here).
    expect(r.rules[0]!.signatures).toEqual([{ sig: '<a class="brand" href="/">', pages: 3, elements: 3, example: expect.objectContaining({ page: A }) }]);
    expect(buildProblems(r)[0]!.repeats).toEqual({ pages: 3, of: 4 });
  });

  it('on 1 of 4 it does not', () => {
    const r = site({ [A]: [linkOn(1)] });
    expect(buildProblems(r)[0]!.repeats).toBeUndefined();
  });

  it('different elements on every page do not repeat', () => {
    const other = (n: number) => fail('link-name', [node(`<a href="/page-x${'abcd'[n]}"></a>`)]);
    const r = site({ [A]: [other(0)], [B]: [other(1)], [C]: [other(2)], 'https://e.org/d': [other(3)] });
    expect(buildProblems(r)[0]!.repeats).toBeUndefined();
  });

  it('failed pages are not counted', () => {
    const r = site({ [A]: [linkOn(1)], [B]: [linkOn(2)] }, [linkOn(5)]);
    expect(r.rules[0]!.signatures).toEqual([{ sig: '<a class="brand" href="/">', pages: 2, elements: 2, example: expect.objectContaining({ page: A }) }]);
    expect(buildProblems(r)[0]!.repeats).toBeUndefined();
  });

  it('the same element twice on one page counts once', () => {
    const r = site({ [A]: [fail('link-name', [node('<a href="/"></a>', 'a1'), node('<a href="/"></a>', 'a2')])], [B]: [linkOn(2)] });
    // Batch 19: the second pattern's example is on a page the first's is not.
    expect(r.rules[0]!.signatures).toEqual([
      { sig: '<a href="/">', pages: 1, elements: 2, example: expect.objectContaining({ page: A, target: 'a1' }) },
      { sig: '<a class="brand" href="/">', pages: 1, elements: 1, example: expect.objectContaining({ page: B }) },
    ]);
  });

  it('lists every failing element by page and selector for the exports (report v3)', () => {
    const r = site({ [A]: [fail('link-name', [node('<a href="/"></a>', 'a1'), node('<a href="/"></a>', 'a2')])], [B]: [linkOn(2)] });
    expect(r.rules[0]!.occurrences).toEqual([{ page: A, target: 'a1' }, { page: A, target: 'a2' }, { page: B, target: expect.any(String) }]);
    expect(r.needsReview.every((x) => x.occurrences === undefined)).toBe(true);
  });

  it('keeps every signature (batch 19: was at most 5), most pages first, each with an example', () => {
    const many = fail('link-name', Array.from({ length: 12 }, (_, i) => node(`<a href="/n${'abcdefghijkl'[i]}"></a>`, `t${i}`)));
    const r = site({ [A]: [many, linkOn(1)], [B]: [linkOn(2)] });
    const sigs = r.rules[0]!.signatures!;
    expect(sigs).toHaveLength(13);
    expect(sigs[0]).toEqual({ sig: '<a class="brand" href="/">', pages: 2, elements: 2, example: expect.objectContaining({ page: A }) });
    expect(sigs.every((x) => x.example)).toBe(true);
  });

  it('needs at least 3 pages even on small sites', () => {
    const r = buildReport({ ...base, site: A, pages: [A, B].map((u, i) => page(u, { rules: { ...pad, 'link-name': 'fail' }, violations: [linkOn(i)] })) });
    expect(buildProblems(r)[0]!.repeats).toBeUndefined();
  });

  it('half of 6 pages is enough', () => {
    const urls = [A, B, C, 'https://e.org/d', 'https://e.org/f', 'https://e.org/g'];
    const r = buildReport({ ...base, site: A, pages: urls.map((u, i) => page(u, { rules: { ...pad, ...(i < 3 ? { 'link-name': 'fail' as const } : {}) }, violations: i < 3 ? [linkOn(i)] : [] })) });
    expect(buildProblems(r)[0]!.repeats).toEqual({ pages: 3, of: 6 });
  });
});

describe('buildProblems: evidence', () => {
  const r: SiteReport = {
    ...emptyReport(),
    rules: [rule('image-alt', 'critical', 5, [A], 1), rule('label', 'critical', 4, [A], 1)],
    testIssues: [issue('2.4.11', 3, [A])],
    evidence: [
      shot('e1', { rule: '$start' }),
      shot('e2', { rule: 'image-alt' }),
      shot('e3', { criterion: '2.4.11', probe: 'keyboard' }, { group: 'g1', groupLabel: 'Covered' }),
      shot('e4', { criterion: '2.4.11', probe: 'keyboard' }),
      shot('e5', { criterion: '2.4.11', probe: 'keyboard' }, { group: 'g1', groupLabel: 'Expected' }),
      shot('e6', { ai: 'altText:1' }),
      shot('e10', { rule: 'image-alt' }),
      shot('e7', { rule: 'color-contrast' }),
    ],
  };
  const ps = buildProblems(r);
  const by = Object.fromEntries(ps.map((p) => [p.key, p]));

  it('attaches shots by what they are for, in id order', () => {
    expect(by['rule:image-alt']!.evidence.map((s) => s.id)).toEqual(['e2', 'e10']);
    expect(by['rule:label']!.evidence).toEqual([]);
  });
  it('keeps group members together', () => {
    expect(by['criterion:2.4.11']!.evidence.map((s) => s.id)).toEqual(['e3', 'e5', 'e4']);
  });
  it('a criterion keeps the pictures of one probe, the core one when both took any (--full)', () => {
    const both: SiteReport = { ...r, evidence: [
      shot('e1', { criterion: '2.4.11', probe: 'keyboard-deep' }, { group: 'd', groupLabel: 'Covered' }),
      shot('e2', { criterion: '2.4.11', probe: 'keyboard' }, { group: 'k', groupLabel: 'Covered' }),
      shot('e3', { criterion: '2.4.11', probe: 'keyboard' }, { group: 'k', groupLabel: 'Expected' }),
    ] };
    const p = buildProblems(both).find((x) => x.key === 'criterion:2.4.11')!;
    expect(p.evidence.map((s) => s.id)).toEqual(['e2', 'e3']);
    const deepOnly: SiteReport = { ...r, evidence: [shot('e1', { criterion: '2.4.11', probe: 'keyboard-deep' })] };
    expect(buildProblems(deepOnly).find((x) => x.key === 'criterion:2.4.11')!.evidence.map((s) => s.id)).toEqual(['e1']);
  });
  it('never attaches the start page, AI shots or shots for rules not in the list', () => {
    const all = ps.flatMap((p) => p.evidence.map((s) => s.id));
    expect(all).not.toContain('e1');
    expect(all).not.toContain('e6');
    expect(all).not.toContain('e7');
  });
});

describe('buildProblems: the line beside a picture names the element the picture boxes', () => {
  const ev = (target: string, detail: string, pageUrl = A) => ({ page: pageUrl, target, detail });
  const t332 = (evidence: ReturnType<typeof ev>[]): TestIssueSummary => ({ criterion: '3.3.2', title: '3.3.2', probes: ['form-fields'], pagesAffected: [A, B], pointsLost: 2, evidence });
  const findings = [
    { criterion: '3.3.2', status: 'failed' as const, target: 'Trap (text field)', detail: 'the field has no visible label or instructions' },
    { criterion: '3.3.2', status: 'failed' as const, target: 'Email (email field)', detail: 'the field must be filled in, but nothing visible says so' },
  ];
  const withRuns = (r: SiteReport): SiteReport => ({ ...r, probes: { ...(r.probes ?? { runs: [] }), runs: [run('form-fields', A, ['3.3.2'], findings), run('form-fields', B, ['3.3.2'], [
    { criterion: '3.3.2', status: 'failed', target: 'Phone (tel field)', detail: "the field's only label is its placeholder" }])] } as SiteReport['probes'] });

  it('the pictured finding leads the text evidence', () => {
    const r = withRuns({ ...emptyReport(), testIssues: [t332([ev('Trap (text field)', findings[0]!.detail), ev('Email (email field)', findings[1]!.detail)])],
      evidence: [shot('e1', { criterion: '3.3.2', probe: 'form-fields', target: 'Email (email field)' })] });
    const p = buildProblems(r).find((x) => x.key === 'criterion:3.3.2')!;
    expect(p.textEvidence.map((e) => e.target)).toEqual(['Email (email field)', 'Trap (text field)']);
  });
  it('a pictured finding past the text evidence cap comes from the runs', () => {
    const r = withRuns({ ...emptyReport(), testIssues: [t332([ev('Trap (text field)', findings[0]!.detail), ev('Email (email field)', findings[1]!.detail), ev('X (text field)', 'x'), ])],
      evidence: [shot('e1', { criterion: '3.3.2', probe: 'form-fields', target: 'Phone (tel field)' }, { page: B })] });
    const p = buildProblems(r).find((x) => x.key === 'criterion:3.3.2')!;
    expect(p.textEvidence[0]).toEqual({ page: B, target: 'Phone (tel field)', detail: "the field's only label is its placeholder" });
    expect(p.textEvidence).toHaveLength(3);
  });
  it('a picture without a target leaves the order as it was', () => {
    const r = withRuns({ ...emptyReport(), testIssues: [t332([ev('Trap (text field)', 'a'), ev('Email (email field)', 'b')])],
      evidence: [shot('e1', { criterion: '3.3.2', probe: 'form-fields' })] });
    expect(buildProblems(r).find((x) => x.key === 'criterion:3.3.2')!.textEvidence.map((e) => e.target)).toEqual(['Trap (text field)', 'Email (email field)']);
  });
});

describe('buildProblems: snippets', () => {
  it('label-in-name uses the first example', () => {
    const r: SiteReport = { ...emptyReport(), rules: [rule('label-content-name-mismatch', 'serious', 2, [A], 1, {
      examples: [{ page: A, target: 'a.card', html: '<a aria-label="Visit Lincoln School" href="/l">Lincoln</a>' }] })] };
    expect(buildProblems(r)[0]!.snippet).toEqual({ kind: 'change', language: 'html', before: ['<a aria-label="Visit Lincoln School" href="/l">'], after: ['<a href="/l">'] });
  });
  it('no snippet when the copy has none or it cannot be built', () => {
    const r: SiteReport = { ...emptyReport(), rules: [rule('color-contrast', 'serious', 2, [A], 1), rule('label-content-name-mismatch', 'serious', 1, [A], 1, { examples: [] })] };
    for (const p of buildProblems(r)) expect(p).not.toHaveProperty('snippet');
  });
  it('2.4.11 reads coverHeight from the first failed finding data', () => {
    const r: SiteReport = { ...emptyReport(), testIssues: [issue('2.4.11', 3, [A, B])], probes: { runs: [
      run('keyboard', A, ['2.4.11'], [{ criterion: '2.4.11', status: 'flagged', detail: 'x', data: { coverHeight: 999 } } as never,
        { criterion: '2.4.11', status: 'failed', target: 'header', detail: 'covered', data: { coverHeight: 64 } } as never]),
    ] } };
    expect(buildProblems(r)[0]!.snippet!.after).toEqual(['html { scroll-padding-top: 76px; }']);
  });
  it('2.4.11 with no data gives no snippet', () => {
    const r: SiteReport = { ...emptyReport(), testIssues: [issue('2.4.11', 3, [A])] };
    expect(buildProblems(r)[0]).not.toHaveProperty('snippet');
  });
});

describe('buildProblems: documents', () => {
  const doc = (url: string, over: Partial<DocumentCheck>): DocumentCheck => ({ url, type: 'pdf', detectedBy: 'extension', linkedFrom: [B], ...over });
  const r: SiteReport = { ...emptyReport(), documentChecks: [
    doc('https://e.org/1.pdf', { checks: { pages: 3, pagesChecked: 3, tagged: true, hasTitle: true, hasLanguage: true, imageOnly: false } }),
    doc('https://e.org/2.pdf', { linkedFrom: [C, A], checks: { pages: 1, pagesChecked: 1, tagged: false, hasTitle: false, hasLanguage: false } }),
    doc('https://e.org/3.pdf', { checks: { pages: 9, pagesChecked: 5, imageOnly: true } }),
    doc('https://e.org/4.pdf', { error: 'download failed' }),
    doc('https://e.org/5.docx', { type: 'word', notChecked: 'Office file' }),
    doc('https://e.org/6.pdf', { checks: { pages: 1, pagesChecked: 1, figuresWithoutAlt: 3 } }),
  ] };
  const d = buildProblems(r).find((p) => p.key === 'documents')!;
  it('lists every checked PDF with a quick-check problem (untagged, untitled, no language, image-only, and since v7 the rest)', () => {
    expect(d.documents).toEqual([
      { url: 'https://e.org/2.pdf', linkedFrom: [C, A], pages: 1, untagged: true, noTitle: true, noLanguage: true, imageOnly: false, other: [],
        problems: ['Not tagged: screen readers cannot tell its headings, lists and tables apart, and may read it out of order.', 'No document language is set, so screen readers may pronounce it wrongly.', 'No title is set, so people see the file name instead.'] },
      { url: 'https://e.org/3.pdf', linkedFrom: [B], pages: 9, untagged: false, noTitle: false, noLanguage: false, imageOnly: true, other: [],
        problems: ['No text found: it looks like a scanned image, which screen readers cannot read.'] },
      { url: 'https://e.org/6.pdf', linkedFrom: [B], pages: 1, untagged: false, noTitle: false, noLanguage: false, imageOnly: false, other: ['Image alt text'],
        problems: ['3 images have no text description (alt text).'] },
    ]);
    expect(d.count).toEqual({ n: 3, unit: 'document' });
    expect(d.criteria.map((c) => c.criterion)).toEqual(['1.1.1', '1.3.1', '2.4.2', '3.1.1']);
    // A report with no documentScore (made before v7): unscored, as it was.
    expect(d.scored).toBe(false);
    expect(d.pages).toEqual([A, B, C]);
  });
  it('no documents problem when every checked PDF is fine', () => {
    expect(buildProblems({ ...r, documentChecks: r.documentChecks!.slice(0, 1) }).some((p) => p.key === 'documents')).toBe(false);
  });
});

describe('problemsLede', () => {
  const p = (repeats?: { pages: number; of: number }): Problem => ({
    key: 'rule:x', copy: GENERIC_RULE_COPY, owner: GENERIC_RULE_COPY.owner, criteria: [], scored: true, pointsLost: 1, pages: [A], count: { n: 1, unit: 'element' },
    evidence: [], textEvidence: [], ...(repeats ? { repeats } : {}),
  });
  it('words every case truthfully', () => {
    expect(problemsLede([], 4)).toBe('The automated tests found no problems to fix.');
    expect(problemsLede([p()], 4)).toBe('One problem remains.');
    expect(problemsLede([p({ pages: 4, of: 4 })], 4)).toBe('One problem remains. It repeats on every page, so one change in the shared template can fix it.');
    expect(problemsLede([p({ pages: 3, of: 4 })], 4)).toBe('One problem remains. It repeats across many pages, so one change in the shared template can fix it.');
    expect(problemsLede([p(), p(), p(), p()], 4)).toBe('Four problems remain.');
    expect(problemsLede([p({ pages: 4, of: 4 }), p({ pages: 4, of: 4 }), p({ pages: 4, of: 4 }), p()], 4))
      .toBe('Four problems remain. Three repeat on every page, so one change in the shared template can fix each of them.');
    expect(problemsLede([p({ pages: 4, of: 4 }), p()], 4)).toBe('Two problems remain. One repeats on every page, so one change in the shared template can fix it.');
    expect(problemsLede([p({ pages: 4, of: 4 }), p({ pages: 3, of: 4 })], 4))
      .toBe('Two problems remain. Both repeat across many pages, so one change in the shared template can fix each of them.');
    expect(problemsLede([p({ pages: 6, of: 6 }), p({ pages: 6, of: 6 })], 6))
      .toBe('Two problems remain. Both repeat on every page, so one change in the shared template can fix each of them.');
    expect(problemsLede([p({ pages: 3, of: 3 }), p({ pages: 3, of: 3 }), p({ pages: 3, of: 3 })], 3))
      .toBe('Three problems remain. All three repeat on every page, so one change in the shared template can fix each of them.');
    expect(problemsLede(Array.from({ length: 12 }, () => p()), 4)).toBe('12 problems remain.');
    expect(problemsLede(Array.from({ length: 11 }, () => p({ pages: 5, of: 9 })), 9))
      .toBe('11 problems remain. All 11 repeat across many pages, so one change in the shared template can fix each of them.');
  });
});

describe('buildProblems: hostile or malformed report data', () => {
  it('never throws, and gives safe values, for odd ids, impacts, shots and pages', () => {
    const r: SiteReport = {
      ...emptyReport(),
      rules: [
        rule('__proto__', '__proto__' as Impact, NaN, [A, 'https://elsewhere.example/'], 1, { examples: [{ page: A, target: '', html: undefined as never }] }),
        rule('constructor', 'constructor' as Impact, 2, [A], 1),
        rule('image-alt', 'critical', 3, [A], 1),
      ],
      evidence: [
        shot('e1', null as never), shot(7 as never, { rule: 'image-alt' }), shot('ex', { rule: 'image-alt' }),
        shot('e2', { rule: 'image-alt' }, { group: '__proto__' }), shot('e3', 'x' as never),
      ],
      probes: { runs: [run('hover-content', 'https://other.example/', ['1.4.13'], [{ criterion: '1.4.13', status: 'failed', detail: 'x' }])] },
    };
    const ps = buildProblems(r);
    expect(keys(ps)).toEqual(['rule:image-alt', 'rule:constructor', 'rule:__proto__', 'criterion:1.4.13']);
    for (const p of ps) {
      expect(Number.isFinite(p.pointsLost)).toBe(true);
      expect(p.copy.title.length).toBeGreaterThan(0);
    }
    expect(ps[2]!.copy).toBe(GENERIC_RULE_COPY);
    expect(ps[2]!.pages).toEqual([A, 'https://elsewhere.example/']);
    expect(ps[2]!.textEvidence).toEqual([{ page: A, detail: 'Failing element (no HTML recorded).' }]);
    expect(ps[0]!.evidence.map((s) => String(s.id))).toEqual(['e2', '7', 'ex']);
    expect(problemsLede(ps, 3)).toBe('Four problems remain.');
  });
});

describe('buildProblems: an unscored test failing a criterion a scored test also fails', () => {
  // Scored non-text contrast fails 1.4.11 on A; the unscored forced-colours test fails it on another page
  // and element (B). Both are reported; only the scored one counts.
  const nonText = (url: string, target: string) => run('non-text-contrast', url, ['1.4.11'], [{ criterion: '1.4.11', status: 'failed', target, detail: `low contrast ${target}` }]);
  const forced = (url: string, target: string) => run('forced-colors', url, ['1.4.11'], [{ criterion: '1.4.11', status: 'failed', target, detail: `In a contrast theme ${target} disappears` }]);
  const r = (runs: ProbeRun[]): SiteReport => ({
    ...emptyReport(),
    testIssues: [{ ...issue('1.4.11', 2, [A]), probes: ['non-text-contrast'], evidence: [{ page: A, target: '#icon', detail: 'low contrast #icon' }] }],
    probes: { runs },
  });

  it('RED (e2e): the unscored failure on its own page and element is listed, unscored, with its own evidence', () => {
    const ps = buildProblems(r([nonText(A, '#icon'), forced(B, '#fc-bad-icon')]));
    const scored = ps.find((p) => p.key === 'criterion:1.4.11')!;
    expect(scored).toMatchObject({ scored: true, pointsLost: 2, pages: [A] });
    const listed = ps.filter((p) => p.key !== 'criterion:1.4.11' && p.criteria.some((c) => c.criterion === '1.4.11'));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ scored: false, pointsLost: 0, pages: [B], textEvidence: [{ page: B, target: '#fc-bad-icon', detail: 'In a contrast theme #fc-bad-icon disappears' }] });
    // It reads as what the forced-colours test found, not as a second copy of the scored problem.
    expect(listed[0]!.copy.title).not.toBe(scored.copy.title);
    expect(listed[0]!.copy.title).toMatch(/contrast theme/i);
    // Listed after the scored problems (the hosted issue list's row for each element is tested with that list).
    expect(ps.indexOf(listed[0]!)).toBeGreaterThan(ps.indexOf(scored));
  });

  it('the same failure the scored test already lists (same page and element) is not listed twice', () => {
    const ps = buildProblems(r([nonText(A, '#icon'), forced(A, '#icon')]));
    expect(ps.filter((p) => p.criteria.some((c) => c.criterion === '1.4.11')).map((p) => p.key)).toEqual(['criterion:1.4.11']);
  });
});

describe('buildProblems: a focus ring that only the forced-colours test fails', () => {
  it('RED (e2e): reads as a forced-colours problem, never as focus invisible in normal colours', () => {
    const r: SiteReport = {
      ...emptyReport(),
      testIssues: [],
      probes: { runs: [
        run('keyboard', A, ['2.4.7'], [{ criterion: '2.4.7', status: 'no_failures_found', detail: 'every focus stop shows an indicator' }]),
        run('forced-colors', A, ['2.4.7'], [{ criterion: '2.4.7', status: 'failed', target: '#go', detail: 'In a dark contrast theme the focus ring disappears' }]),
      ] },
    };
    const p = buildProblems(r).find((x) => x.criteria.some((c) => c.criterion === '2.4.7'))!;
    expect(p).toMatchObject({ scored: false, pointsLost: 0, pages: [A] });
    expect(p.copy.title).toMatch(/contrast theme/i);
    expect(p.copy.title).not.toBe(copyForCriterion('2.4.7').title);
    expect(p.copy.fix).toMatch(/outline/);
  });
});
