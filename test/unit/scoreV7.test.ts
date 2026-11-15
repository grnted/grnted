// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Scoring v7 (docs/scoring.md): documents count. The quick PDF checks' problems (untagged, no
// language, no title, a scanned image, images without alt text, unnamed form fields, an XFA form,
// security that stops screen readers) become one scored check: weight DOCUMENT_CHECK_WEIGHT (4, like a
// core test criterion), share = PDFs with a problem ÷ PDFs checked. One check however many PDFs fail,
// so documents alone cost at most 4 of the total: a site whose only problems are its documents keeps
// Access Granted (94). The CLI's --no-document-score (engine option `documentScore: false`) leaves them
// out as before. Weights, formula and thresholds are otherwise v6's.
import { describe, expect, it } from 'vitest';
import { buildReport } from '../../src/report/build.js';
import { failingChecks, projectScore, reportChecks } from '../../src/report/projection.js';
import { buildProblems } from '../../src/report/problems.js';
import { DOCUMENT_CHECK_WEIGHT, defaultImpactOf, documentCriteria, documentOutcome, documentStanding, roundScore, scoreSite } from '../../src/score.js';
import type { DocumentCheck, PageAudit, PdfChecks, SiteReport } from '../../src/types.js';
import { SCORING_VERSION } from '../../src/version.js';

const fromTotal = (total: number) => 100 - 18 * Math.log(1 + total / 10);
const page = (url: string, rules: PageAudit['rules'] = { 'color-contrast': 'pass' }): PageAudit => ({
  url, status: 'ok', rules, incomplete: [], links: [],
  violations: Object.entries(rules).filter(([, o]) => o === 'fail').map(([id]) => ({ id, help: id, helpUrl: 'https://x', nodes: [{ target: '.x', html: '<p class="x">x</p>', viewports: ['desktop'] as ('desktop' | 'mobile')[] }] })),
});
const clean: PdfChecks = { pages: 2, pagesChecked: 2, tagged: true, hasLanguage: true, hasTitle: true, showsTitle: true, imageOnly: false, figuresWithoutAlt: 0, formFields: 0, untitledFormFields: 0, xfa: false, blocksAssistiveTech: false };
const pdf = (n: number, checks?: Partial<PdfChecks> | null, extra: Partial<DocumentCheck> = {}): DocumentCheck => ({
  url: `https://e.org/f${n}.pdf`, type: 'pdf', detectedBy: 'extension', linkedFrom: ['https://e.org/p0'],
  ...(checks === null ? {} : { checks: { ...clean, ...checks } }), ...extra,
});
const pages4 = () => [0, 1, 2, 3].map((i) => page(`https://e.org/p${i}`));
const report = (documentChecks: DocumentCheck[], extra: { pages?: PageAudit[]; documentScore?: boolean } = {}): SiteReport => buildReport({
  site: 'https://e.org/', pages: extra.pages ?? pages4(), documents: documentChecks.map((d) => d.url), documentChecks, skipped: [],
  startedAt: 't', finishedAt: '2026-11-03T00:00:00Z', userAgent: 'ua', ...(extra.documentScore === undefined ? {} : { scoreDocuments: extra.documentScore }),
});

describe('scoring v7: constants', () => {
  it('is v8, documents weigh 4', () => {
    expect(SCORING_VERSION).toBe('v14');
    expect(DOCUMENT_CHECK_WEIGHT).toBe(4);
  });
});

describe('scoring v7: which documents count', () => {
  it('a checked PDF with any quick-check problem fails; one the checks found nothing in passes', () => {
    const docs = [
      pdf(1, { tagged: false }), pdf(2, { hasLanguage: false }), pdf(3, { hasTitle: false }), pdf(4, { imageOnly: true }),
      pdf(5, { figuresWithoutAlt: 2 }), pdf(6, { untitledFormFields: 1 }), pdf(7, { xfa: true }), pdf(8), pdf(9, { showsTitle: false }),
    ];
    expect(documentOutcome(docs)).toEqual({ checked: 9, failed: 8, minor: 2 });
  });

  it('one rule per document (documentStanding): a title-only PDF is minor, a confirmed AI problem (v10) fails it in full', () => {
    expect(documentStanding(pdf(1))).toBe('clean');
    expect(documentStanding(pdf(2, { tagged: false }))).toBe('failed');
    expect(documentStanding(pdf(3, { hasTitle: false }))).toBe('minor');
    expect(documentStanding(pdf(4, { showsTitle: false }))).toBe('minor');
    expect(documentStanding(pdf(5, { showsTitle: false, hasLanguage: false }))).toBe('failed');
    expect(documentStanding(pdf(6, null, { notChecked: 'Limit reached (10 PDFs per scan)' }))).toBe('not_counted');
    expect(documentStanding(undefined)).toBe('not_counted');
    const confirmed = new Map([[pdf(1).url, {}], [pdf(3).url, {}]]);
    expect(documentStanding(pdf(1), confirmed)).toBe('failed');
    expect(documentStanding(pdf(3, { hasTitle: false }), confirmed)).toBe('failed');
    expect(documentOutcome([pdf(1), pdf(3, { hasTitle: false }), pdf(7)], confirmed)).toEqual({ checked: 3, failed: 2, minor: 0 });
  });

  it('a counted document\'s criteria (documentCriteria): its quick checks\', then the AI review\'s confirmed ones (v10)', () => {
    const confirmed = new Map([[pdf(1).url, { criteria: ['1.3.2'] }], [pdf(2).url, { criteria: ['1.1.1'] }]]);
    expect(documentCriteria(pdf(1), confirmed)).toEqual(['1.3.2']);
    expect(documentCriteria(pdf(2, { tagged: false, hasTitle: false }), confirmed)).toEqual(['1.3.1', '2.4.2', '1.1.1']);
    expect(documentCriteria(pdf(3))).toEqual([]);
    expect(documentCriteria(pdf(4, null, { notChecked: 'Limit reached (10 PDFs per scan)' }), new Map([[pdf(4).url, { criteria: ['1.3.2'] }]]))).toEqual([]);
  });

  it('PDFs that could not be read, were not checked, and other documents never count; a PDF that needs a password fails', () => {
    const docs = [
      pdf(1, null, { error: 'Could not read it: the file is damaged or not a valid PDF' }),
      pdf(2, null, { notChecked: 'Limit reached (10 PDFs per scan)' }),
      { url: 'https://e.org/a.docx', type: 'word', detectedBy: 'extension', linkedFrom: [], notChecked: 'Only PDFs are checked in this version' } satisfies DocumentCheck,
      pdf(3, null, { error: 'Needs a password to open', checks: { pages: 0, pagesChecked: 0, blocksAssistiveTech: true } }),
      pdf(4),
    ];
    expect(documentOutcome(docs)).toEqual({ checked: 2, failed: 1, minor: 0 });
    expect(documentOutcome([])).toEqual({ checked: 0, failed: 0, minor: 0 });
    expect(documentOutcome(undefined)).toEqual({ checked: 0, failed: 0, minor: 0 });
  });
});

describe('scoring v7: the documents check', () => {
  it('weight 4 × √(PDFs with a problem ÷ PDFs checked), in one total with everything else', () => {
    const pages = [page('/a', { 'link-name': 'fail' }), page('/b')];
    const r = scoreSite(pages, defaultImpactOf, new Map(), [], { checked: 4, failed: 3 });
    // link-name (names 7) on 1 of 2: 7 × √0.5 = 4.95; documents 4 × √0.75 = 3.46.
    expect(r.score).toBe(roundScore(fromTotal(7 * Math.sqrt(0.5) + 4 * Math.sqrt(0.75))));
    expect(r.documentPointsLost).toBe(r.score === null ? 0 : roundScore(fromTotal(7 * Math.sqrt(0.5))) - r.score);
    expect(r.pointsLost['link-name']).toBe(roundScore(fromTotal(4 * Math.sqrt(0.75))) - r.score!);
  });

  it('is capped by being one check: every PDF failing costs 4 of the total, so documents alone keep Access Granted (94)', () => {
    const r = scoreSite(pages4(), defaultImpactOf, new Map(), [], { checked: 10, failed: 10 });
    expect(r.score).toBe(94);
    expect(r.headline).toBe('Access Granted');
    expect(r.documentPointsLost).toBe(6);
  });

  it('costs nothing when no PDF was checked or none failed, and without the documents argument (v6 callers)', () => {
    for (const d of [{ checked: 0, failed: 0 }, { checked: 5, failed: 0 }, null, undefined]) {
      const r = scoreSite(pages4(), defaultImpactOf, new Map(), [], d);
      expect(r.score).toBe(100);
      expect(r.documentPointsLost).toBe(0);
    }
  });

  it('never counts more than every PDF, whatever the input says', () => {
    expect(scoreSite(pages4(), defaultImpactOf, new Map(), [], { checked: 2, failed: 9 }).score).toBe(94);
  });

  it('an incomplete scan has no score, documents or not', () => {
    const pages = [page('/a'), { ...page('/b'), status: 'failed' as const }, { ...page('/c'), status: 'failed' as const }];
    const r = scoreSite(pages, defaultImpactOf, new Map(), [], { checked: 3, failed: 3 });
    expect(r.status).toBe('incomplete');
    expect(r.documentPointsLost).toBe(0);
  });
});

describe('scoring v7: the report', () => {
  const docs = [pdf(1, { tagged: false, hasTitle: false }), pdf(2, { imageOnly: true }), pdf(3), pdf(4, { hasLanguage: false })];

  it('scores the documents and says so in report.documentScore', () => {
    const r = report(docs);
    expect(r.meta.scoring).toBe('v14');
    expect(r.score).toBe(roundScore(fromTotal(4 * Math.sqrt(3 / 4))));
    expect(r.documentScore).toEqual({ scored: true, checked: 4, failed: 3, pointsLost: 100 - r.score! });
  });

  it('documentScore: false leaves them out of the score, and the report says why', () => {
    const r = report(docs, { documentScore: false });
    expect(r.score).toBe(100);
    expect(r.documentScore).toMatchObject({ scored: false, checked: 4, failed: 3, pointsLost: 0 });
    expect(r.documentScore!.note).toMatch(/turned off/i);
  });

  it('the documents problem is scored, ranks among the scored problems by its points, and fixing it is projected exactly', () => {
    const r = report(docs, { pages: [page('https://e.org/p0', { region: 'fail' }), ...[1, 2, 3].map((i) => page(`https://e.org/p${i}`))] });
    const problems = buildProblems(r);
    const d = problems.find((p) => p.key === 'documents')!;
    expect(d.scored).toBe(true);
    expect(d.pointsLost).toBe(r.documentScore!.pointsLost);
    expect(d.pointsLost).toBeGreaterThan(0);
    // region (markup 3, moderate → 1.5 × √¼ = 0.75) costs less than the documents (4 × √¾ = 3.46): documents first.
    expect(problems.map((p) => p.key)).toEqual(['documents', 'rule:region']);
    // Every PDF with a problem is listed, with its problems in words.
    expect(d.documents!.map((x) => x.url)).toEqual(['https://e.org/f1.pdf', 'https://e.org/f2.pdf', 'https://e.org/f4.pdf']);
    expect(reportChecks(r)).not.toBeNull();
    expect(failingChecks(r)!.find((c) => c.key === 'documents')).toEqual({ key: 'documents', criterion: 'documents', weight: 4, share: 0.75 });
    expect(projectScore(r, ['documents'])).toBe(r.score! + d.pointsLost);
  });

  it('a PDF whose only problem the old card did not list (alt text, form fields) is now in the documents problem', () => {
    const r = report([pdf(1, { figuresWithoutAlt: 3 }), pdf(2, { untitledFormFields: 1 })]);
    const d = buildProblems(r).find((p) => p.key === 'documents')!;
    expect(d.documents!.map((x) => x.url)).toEqual(['https://e.org/f1.pdf', 'https://e.org/f2.pdf']);
    expect(d.count).toEqual({ n: 2, unit: 'document' });
    expect(d.criteria.map((c) => c.criterion)).toEqual(['1.1.1', '4.1.2']);
  });

  it('with the document score off, or on a report made before v7, the documents problem is unscored and last, and projections still add up', () => {
    for (const r of [report(docs, { documentScore: false }), (() => {
      const v6 = report(docs, { documentScore: false });
      const { documentScore: _d, ...rest } = v6;
      return { ...rest, meta: { ...rest.meta, scoring: 'v6' } } as SiteReport;
    })()]) {
      const d = buildProblems(r).find((p) => p.key === 'documents')!;
      expect(d.scored).toBe(false);
      expect(d.pointsLost).toBe(0);
      expect(reportChecks(r)).not.toBeNull();
      expect(failingChecks(r)!.some((c) => c.key === 'documents')).toBe(false);
    }
  });
});
