// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { mediaIssues } from '../../src/media/index.js';
import { PROBES } from '../../src/probes/registry.js';
import { AI_DISCLAIMER } from '../../src/report/ai.js';
import { buildReport } from '../../src/report/build.js';
import { carryAi } from '../helpers/carryAi.js';
import {
  AXE_RULES, CRITERIA, PENDING_METHOD, buildCriteria, criteriaCounts, criteriaTerminalLine, worstStatus, type CriterionExtra,
} from '../../src/report/criteria.js';
import { renderTerminal } from '../../src/report/terminal.js';
import { RULE_IMPACTS } from '../../src/ruleImpacts.js';
import type { AiFinding, AiReport, CriterionResult, DocumentCheck, Finding, MediaItem, PageAudit, SiteReport } from '../../src/types.js';

/** The AI checks the criterion table names (`ai:<id>` methods): opaque labels here; the closed AI package checks them. */
const AI_METHOD_IDS = [...new Set(CRITERIA.flatMap((d) => d.methods.filter((m) => m.startsWith('ai:')).map((m) => m.slice(3))))];

const finding = (id: string, help = `${id} help`): Finding =>
  ({ id, help, helpUrl: `https://x/${id}`, nodes: [{ target: `#${id}`, html: '<x>', viewports: ['desktop'] }] });
const page = (url: string, over: Partial<PageAudit> = {}): PageAudit =>
  ({ url, status: 'ok', rules: { label: 'inapplicable' }, violations: [], incomplete: [], links: [], ...over });
const build = (over: { pages?: PageAudit[]; documentChecks?: DocumentCheck[]; media?: MediaItem[]; ai?: AiReport; criteriaExtra?: CriterionExtra[] } = {}): SiteReport =>
  buildReport({
    site: 'https://e.org/', pages: over.pages ?? [page('https://e.org/')], documents: (over.documentChecks ?? []).map((d) => d.url),
    ...(over.documentChecks ? { documentChecks: over.documentChecks } : {}), media: over.media ?? [], skipped: [],
    startedAt: '2026-10-31T00:00:00.000Z', finishedAt: '2026-10-31T00:01:00.000Z', userAgent: 'UA',
    ...(over.ai ? { ai: over.ai, extension: carryAi } : {}), ...(over.criteriaExtra ? { criteriaExtra: over.criteriaExtra } : {}),
  });
const row = (r: SiteReport, criterion: string): CriterionResult => r.criteria!.find((x) => x.criterion === criterion)!;
const aiFinding = (over: Partial<AiFinding>): AiFinding => ({
  check: 'altText', criterion: '1.1.1', page: 'https://e.org/', target: 'https://e.org/a.png', verdict: 'accurate', label: 'Looks right', flagged: false,
  confidence: 'medium', observed: '', issue: '', suggestion: '', source: 'ai', ...over,
});

describe('the criterion table', () => {
  it('has the 55 WCAG 2.2 Level A and AA criteria, in order, six of them new in 2.2', () => {
    expect(CRITERIA).toHaveLength(55);
    const ids = CRITERIA.map((d) => d.criterion);
    expect(new Set(ids).size).toBe(55);
    expect([...ids].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))).toEqual(ids);
    expect(CRITERIA.filter((d) => d.wcag === '2.2').map((d) => d.criterion)).toEqual(['2.4.11', '2.5.7', '2.5.8', '3.2.6', '3.3.7', '3.3.8']);
    // WCAG 2.1 AA without 4.1.1 Parsing (removed in 2.2): 49 criteria.
    expect(CRITERIA.filter((d) => d.wcag !== '2.2')).toHaveLength(49);
    expect(CRITERIA.filter((d) => d.level === 'A')).toHaveLength(31);
    expect(CRITERIA.filter((d) => d.level === 'AA')).toHaveLength(24);
    expect(ids).not.toContain('4.1.1');
  });

  it('declares every core probe for each of its criteria, only registered probes, and a deep probe where it is the only method', () => {
    const core = PROBES.filter((p) => p.tier === 'core');
    for (const d of CRITERIA) {
      for (const m of d.methods) {
        if (!m.startsWith('probe:')) continue;
        const probe = PROBES.find((p) => p.id === m.slice(6));
        expect(probe, m).toBeDefined();
        expect(probe!.criteria, `${m} on ${d.criterion}`).toContain(d.criterion);
      }
    }
    for (const p of core) {
      for (const c of p.criteria) expect(CRITERIA.find((d) => d.criterion === c)?.methods, `${p.id} on ${c}`).toContain(`probe:${p.id}`);
    }
    // A deep probe's results join its criteria with --full. It must be declared where the criterion would otherwise
    // have no automated method; next to a core probe or other methods, declaring it is optional (a declared deep probe
    // makes a core scan show the row as not tested).
    for (const p of PROBES.filter((x) => x.tier === 'deep')) {
      for (const c of p.criteria) {
        const methods = CRITERIA.find((d) => d.criterion === c)!.methods;
        const coreCovers = core.some((q) => q.criteria.includes(c));
        const otherMethods = methods.filter((m) => m !== `probe:${p.id}`);
        if (!coreCovers && otherMethods.length === 0) expect(methods, `${p.id} on ${c}`).toContain(`probe:${p.id}`);
      }
    }
    // Task 4.1: keyboard and focus.
    for (const c of ['2.1.1', '2.1.2', '2.1.4', '2.4.1', '2.4.3', '2.4.7', '2.4.11', '3.2.1']) {
      expect(CRITERIA.find((d) => d.criterion === c)!.methods.some((m) => m === 'probe:keyboard' || m === 'probe:key-shortcuts'), c).toBe(true);
    }
  });

  it('coverage (Task 4.10): every one of the 55 criteria has an automated method that gives it a result, none left pending', () => {
    // Every criterion declares at least one method.
    expect(CRITERIA.filter((d) => d.methods.length === 0).map((d) => d.criterion)).toEqual([]);
    // Every declared method is a live one: a registered probe, axe rules for the criterion (an AI check's id is checked
    // against the AI checks in the closed AI package's own suite, criteriaAi.test.ts).
    for (const d of CRITERIA) {
      for (const m of d.methods) {
        if (m.startsWith('probe:')) expect(PROBES.some((p) => p.id === m.slice(6)), `${m} on ${d.criterion}`).toBe(true);
        else if (m === 'axe') expect(AXE_RULES[d.criterion]?.length, `axe on ${d.criterion}`).toBeGreaterThan(0);
      }
    }
    // With every input present (a page, a checked PDF, a media item, every AI check run), each declared
    // method gives the row a result under its own id: none is silently dropped.
    const ai: AiReport = { disclaimer: AI_DISCLAIMER, runs: (AI_METHOD_IDS as AiFinding['check'][]).map((check) => ({
      check, title: check, summary: '', model: 'm', promptVersion: `${check}@1`, tier: 'core' as const, inputs: 1, reviewed: 1, cached: 0, notReviewed: 0, findings: [],
    })) };
    const pdf: DocumentCheck = {
      url: 'https://e.org/a.pdf', type: 'pdf', detectedBy: 'extension', linkedFrom: [],
      checks: { pages: 1, pagesChecked: 1, tagged: true, hasLanguage: true, hasTitle: true, showsTitle: true, imageOnly: false, figuresWithoutAlt: 0 },
    };
    const video: Omit<MediaItem, 'issues'> = { kind: 'video', content: 'video', url: 'https://e.org/v.mp4', foundOn: ['https://e.org/'], tracks: [], autoplay: false, muted: false, controls: true, captions: 'none' };
    const full = build({ documentChecks: [pdf], media: [{ ...video, issues: mediaIssues(video) }], ai });
    const idOf = (m: string) => (m === 'site:consistency' ? 'consistency' : m.startsWith('probe:') || m.startsWith('ai:') ? m.slice(m.indexOf(':') + 1) : m);
    for (const d of CRITERIA) {
      const ids = row(full, d.criterion).methods.map((m) => m.id);
      for (const m of d.methods) expect(ids, `${m} on ${d.criterion}`).toContain(idOf(m));
    }
    // With nothing but one page (no probes, no AI, no documents or media), no row falls back to "being built".
    for (const r of [build(), full]) {
      const pending = r.criteria!.filter((x) => x.methods.some((m) => m.id === PENDING_METHOD.id)).map((x) => x.criterion);
      expect(pending).toEqual([]);
    }
  });

  it('lists exactly the axe rules the scan runs, by criterion (checked against the installed axe-core)', () => {
    const axe = createRequire(import.meta.url)('axe-core') as { getRules(): { ruleId: string; tags: string[] }[] };
    const expected: Record<string, string[]> = {};
    // The rules the scan runs are exactly the generated rule set (scoring v2).
    const run = new Set(Object.keys(RULE_IMPACTS));
    for (const r of axe.getRules()) {
      if (!run.has(r.ruleId)) continue;
      for (const t of r.tags) {
        const m = /^wcag(\d)(\d)(\d+)$/.exec(t);
        const c = m && `${m[1]}.${m[2]}.${m[3]}`;
        if (c && CRITERIA.some((d) => d.criterion === c)) (expected[c] ??= []).push(r.ruleId);
      }
    }
    for (const list of Object.values(expected)) list.sort();
    expect(Object.fromEntries(Object.entries(AXE_RULES).map(([k, v]) => [k, [...v].sort()]))).toEqual(expected);
    // A criterion has the axe method exactly when axe has rules for it.
    expect(CRITERIA.filter((d) => d.methods.includes('axe')).map((d) => d.criterion).sort()).toEqual(Object.keys(AXE_RULES).sort());
  });

});

describe('buildCriteria', () => {
  it('worst status wins: failed > flagged > not_testable > no_failures_found > not_applicable', () => {
    expect(worstStatus(['not_applicable', 'no_failures_found'])).toBe('no_failures_found');
    expect(worstStatus(['no_failures_found', 'not_testable'])).toBe('not_testable');
    expect(worstStatus(['not_testable', 'flagged'])).toBe('flagged');
    expect(worstStatus(['flagged', 'failed', 'not_applicable'])).toBe('failed');
    expect(worstStatus([])).toBe('not_applicable');
  });

  it('a clean page with no media, forms, documents or AI', () => {
    const r = build();
    expect(r.criteria).toHaveLength(55);
    // Its core tests (names, 2026-11-10; picture-text, batch 17) are among its methods: with the tests turned off, the row says so.
    expect(row(r, '1.1.1')).toMatchObject({ status: 'not_testable', level: 'A', wcag: '2.0', title: 'Non-text content', evidence: [] });
    expect(row(r, '1.1.1').methods.map((m) => [m.id, m.kind, m.status, m.pages])).toEqual([['axe', 'axe', 'no_failures_found', 1], ['pdf-checks', 'rules', 'not_applicable', 0], ['names', 'render', 'not_testable', 0], ['picture-text', 'render', 'not_testable', 0]]);
    // A criterion that only axe tests keeps axe's result.
    expect(row(r, '2.5.8')).toMatchObject({ status: 'no_failures_found' });
    // Media and form criteria do not apply.
    expect(row(r, '1.2.2')).toMatchObject({ status: 'not_applicable' });
    expect(row(r, '1.2.4').methods).toEqual([{ id: 'media-players', kind: 'interaction', status: 'not_applicable', pages: 0, note: 'no video or audio found on the scanned pages' }]);
    expect(row(r, '3.3.1')).toMatchObject({ status: 'not_applicable', methods: [{ id: 'forms', note: 'no form fields found on the scanned pages' }, { id: 'screen-reader-live', note: 'no form fields found on the scanned pages' }] });
    // A criterion whose only method is a (deep) probe, with the probes off: not testable, with the reason.
    expect(row(r, '2.5.1')).toMatchObject({ status: 'not_testable', methods: [{ id: 'pointer-gestures', kind: 'interaction', status: 'not_testable', note: 'the automated interaction and render tests were turned off for this scan' }] });
    // Any criterion still without an automated method says so.
    for (const c of CRITERIA.filter((d) => d.methods.length === 0)) expect(row(r, c.criterion).methods.map((m) => m.id)).toEqual(['pending']);
    // A probe criterion when the probes did not run: not testable, with the reason.
    expect(row(r, '2.1.2')).toMatchObject({
      status: 'not_testable',
      methods: [{ id: 'keyboard', kind: 'interaction', status: 'not_testable', pages: 0, note: 'the automated interaction and render tests were turned off for this scan' }],
    });
    // Only the AI review could test it, and it did not run.
    expect(row(r, '1.3.3')).toMatchObject({ status: 'not_testable', methods: [{ id: 'ai', kind: 'ai', note: 'needs the AI review, which was not run in this scan' }] });
    const counts = criteriaCounts(r.criteria!);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(55);
    expect(counts.failed + counts.flagged).toBe(0);
  });

  it('axe violations fail their criteria (with anchors to the rule cards); undecided items are noted, not failed', () => {
    const r = build({ pages: [
      page('https://e.org/', { violations: [finding('image-alt', 'Images must have alternate text')], incomplete: [finding('color-contrast')] }),
      page('https://e.org/b', { violations: [finding('image-alt'), finding('link-name')] }),
    ] });
    expect(row(r, '1.1.1')).toMatchObject({ status: 'failed', methods: [{ id: 'axe', status: 'failed', pages: 2 }, { id: 'pdf-checks' }, { id: 'names' }, { id: 'picture-text' }] });
    expect(row(r, '1.1.1').evidence[0]).toEqual({
      page: 'https://e.org/', target: '#image-alt', detail: 'Images must have alternate text (image-alt: 2 elements on 2 pages)', anchor: 'rule-image-alt',
    });
    // link-name is tagged with 2.4.4 and 4.1.2.
    expect([row(r, '2.4.4').status, row(r, '4.1.2').status]).toEqual(['failed', 'failed']);
    // axe finds no failure; its undecided items are for the text-contrast probe, which did not run in this report.
    expect(row(r, '1.4.3')).toMatchObject({ evidence: [{ anchor: 'review-color-contrast' }] });
    expect(row(r, '1.4.3').methods.map((m) => [m.id, m.status])).toEqual([['axe', 'no_failures_found'], ['text-contrast', 'not_testable']]);
    expect(row(r, '1.4.3').methods[0]!.note).toBe('rules color-contrast; 1 element undecided by the rules');
  });

  // Fable review F1 (W3C precision lane): a checked or expanded state left to the browser's default is unknown.
  it('an undecided control whose checked or expanded state is left to the default makes axe\'s 4.1.2 not tested, never no failures found', () => {
    const state: Finding = { id: 'aria-required-attr', help: 'Required ARIA attributes must be provided', helpUrl: 'https://x/a',
      nodes: [{ target: '#switch', html: '<div role="switch">', unknownState: true, viewports: ['desktop'] }] };
    const r = build({ pages: [page('https://e.org/', { incomplete: [state] })] });
    expect(r.needsReview.find((x) => x.id === 'aria-required-attr')).toMatchObject({ elements: 1, unknownState: 1 });
    const axe = row(r, '4.1.2').methods.find((m) => m.id === 'axe')!;
    expect(axe.status).toBe('not_testable');
    expect(axe.note).toMatch(/^1 control leaves its checked or expanded state to the browser's default, which may not be the state shown; rules /);
    expect(row(r, '4.1.2').status).not.toBe('no_failures_found');
    // Look-alikes: a heading's missing level (no marker) stays no failures found; a failing rule still fails.
    const level: Finding = { ...state, nodes: [{ target: '#h', html: '<div role="heading">', viewports: ['desktop'] }] };
    expect(row(build({ pages: [page('https://e.org/', { incomplete: [level] })] }), '4.1.2').methods.find((m) => m.id === 'axe')!.status).toBe('no_failures_found');
    expect(row(build({ pages: [page('https://e.org/', { incomplete: [state], violations: [finding('button-name')] })] }), '4.1.2').methods.find((m) => m.id === 'axe')!.status).toBe('failed');
  });

  it('a page with form fields makes the form criteria apply', () => {
    const r = build({ pages: [page('https://e.org/', { rules: { label: 'pass' } })] });
    expect(row(r, '3.3.1')).toMatchObject({
      status: 'not_testable',
      methods: [
        { id: 'forms', kind: 'interaction', status: 'not_testable', pages: 0, note: 'the automated interaction and render tests were turned off for this scan' },
        { id: 'screen-reader-live', kind: 'interaction', status: 'not_testable', pages: 0, note: 'the automated interaction and render tests were turned off for this scan' },
      ],
    });
    // axe found nothing; the form-fields probe did not run in this report.
    expect(row(r, '1.3.5')).toMatchObject({ status: 'not_testable', methods: [{ id: 'axe', status: 'no_failures_found' }, { id: 'form-fields', status: 'not_testable' }] });
  });

  it('media rules: a missing captions track is a possible 1.2.2 problem, never a definite one (review round 2, finding 3); captions inside an embedded player cannot be tested', () => {
    const withIssues = (m: Omit<MediaItem, 'issues'>): MediaItem => ({ ...m, issues: mediaIssues(m) });
    const native = withIssues({ kind: 'video', content: 'video', audio: 'present', url: 'https://e.org/v.mp4', foundOn: ['https://e.org/'], tracks: [], autoplay: false, muted: false, controls: true, captions: 'none' });
    const embed = withIssues({ kind: 'embed', content: 'video', url: 'https://www.youtube.com/embed/x', foundOn: ['https://e.org/'], player: 'youtube', captions: 'check-manually' });
    const failed = build({ media: [native, embed] });
    // Its captions may be part of the picture (open captions), which the rules cannot see: undecided.
    expect(row(failed, '1.2.2')).toMatchObject({ status: 'not_testable', methods: [{ id: 'axe' }, { id: 'media-rules', status: 'not_testable', pages: 2 }, { id: 'media-files', status: 'not_testable' }] });
    expect(row(failed, '1.2.2').evidence.map((e) => e.anchor)).toEqual(['media', 'media']);
    expect(row(failed, '1.2.2').evidence[0]!.detail).toMatch(/^Possible problem: This video has no captions track/);
    const unknown = withIssues({ ...native, audio: undefined });
    expect(row(build({ media: [unknown] }), '1.2.2').status).toBe('not_testable');
    const embedOnly = build({ media: [embed] });
    expect(row(embedOnly, '1.2.2').status).toBe('not_testable');
    expect(row(embedOnly, '1.2.2').evidence[0]!.detail).toMatch(/^Possible problem: Embedded players are not downloaded/);
    // The embedded-player probe (Task 4.8) did not run in this report.
    expect(row(embedOnly, '1.2.4')).toMatchObject({
      status: 'not_testable', methods: [{ id: 'media-players', status: 'not_testable', note: 'the automated interaction and render tests were turned off for this scan' }],
    });
    // The audio probe (Task 4.4) did not run in this report, so 1.4.2 says so instead of looking clean.
    expect(row(embedOnly, '1.4.2')).toMatchObject({
      status: 'not_testable',
      methods: [{ id: 'axe', status: 'no_failures_found' }, { id: 'media-rules', status: 'no_failures_found' }, { id: 'audio', status: 'not_testable', note: 'the automated interaction and render tests were turned off for this scan' }],
    });
  });

  it('quick PDF checks fail the criteria of their problems, noting an accessible version next to the original', () => {
    const doc: DocumentCheck = {
      url: 'https://e.org/a.pdf', type: 'pdf', detectedBy: 'extension', linkedFrom: [], accessibleAlternative: 'https://e.org/a.html',
      checks: { pages: 2, pagesChecked: 2, tagged: false, hasLanguage: false, hasTitle: true, showsTitle: true, imageOnly: false, figuresWithoutAlt: 0 },
    };
    const r = build({ documentChecks: [doc, { url: 'https://e.org/m.docx', type: 'word', detectedBy: 'extension', linkedFrom: [], notChecked: 'Only PDFs are checked in this version' }] });
    expect(row(r, '1.3.1')).toMatchObject({ status: 'failed', methods: [{ id: 'axe', status: 'no_failures_found' }, { id: 'pdf-checks', status: 'failed', pages: 1 }, { id: 'headings', status: 'not_testable' }, { id: 'screen-reader', status: 'not_testable' }, { id: 'form-fields', status: 'not_testable' }] });
    expect(row(r, '1.3.1').evidence).toEqual([{
      page: 'https://e.org/a.pdf', anchor: 'docs',
      detail: 'Not tagged: screen readers cannot tell its headings, lists and tables apart, and may read it out of order. (a version labeled accessible is linked next to it)',
    }]);
    expect(row(r, '3.1.1').status).toBe('failed');
    // The page-titles test (core) is one of 2.4.2's methods. This scan has the automated tests turned off, so
    // it has no result and, as for every criterion with a core test, the row says so (worst status wins).
    expect(row(r, '2.4.2')).toMatchObject({ status: 'not_testable', methods: [{ id: 'axe' }, { id: 'pdf-checks', status: 'no_failures_found', note: '1 PDF checked' }, { id: 'page-titles', status: 'not_testable' }] });
  });

  it('review round 2, finding 2: a PDF whose text-less pages could not be shown to be described is not testable for 1.1.1, never "no failures found"', () => {
    const checks = { pages: 1, pagesChecked: 1, tagged: true, hasLanguage: true, hasTitle: true, showsTitle: true, figuresWithoutAlt: 0 };
    const doc = (extra: object): DocumentCheck => ({ url: 'https://e.org/n.pdf', type: 'pdf', detectedBy: 'extension', linkedFrom: [], checks: { ...checks, ...extra } });
    const pdf = (r: SiteReport, c: string) => row(r, c).methods.find((m) => m.id === 'pdf-checks')!;
    const unsure = build({ documentChecks: [doc({ scanUnmeasured: true })] });
    expect(pdf(unsure, '1.1.1')).toMatchObject({ status: 'not_testable', pages: 1 });
    expect(pdf(unsure, '1.1.1').note).toContain('could not be measured');
    expect(row(unsure, '1.1.1').evidence.some((e) => e.page === 'https://e.org/n.pdf' && /^Possible problem: /.test(e.detail))).toBe(true);
    // The PDF's other criteria are decided as before.
    expect(pdf(unsure, '2.4.2')).toMatchObject({ status: 'no_failures_found' });
    // Look-alikes: measured and described is clean; a plain scan fails.
    expect(pdf(build({ documentChecks: [doc({ imageOnly: false })] }), '1.1.1')).toMatchObject({ status: 'no_failures_found' });
    expect(pdf(build({ documentChecks: [doc({ imageOnly: true })] }), '1.1.1')).toMatchObject({ status: 'failed' });
  });

  it('a confirmed AI finding filed under several criteria fails the first and flags the others (media 1.2.3, 1.2.5)', () => {
    const ai: AiReport = { disclaimer: AI_DISCLAIMER, runs: [
      { check: 'media', title: 'Media review', summary: '', model: 'm', promptVersion: 'media@3', tier: 'deep', inputs: 1, reviewed: 1, cached: 0, notReviewed: 0,
        findings: [aiFinding({ check: 'media', criterion: '1.2.3, 1.2.5', target: 'https://e.org/v.webm', verdict: 'needs_audio_description', label: 'Needs audio description', flagged: true, confidence: 'high', scored: true, scoreTested: ['1.2.3'] })] },
    ] };
    const r = build({ ai });
    expect(row(r, '1.2.3').methods.find((m) => m.id === 'media')).toMatchObject({ kind: 'ai', status: 'failed' });
    expect(row(r, '1.2.3').status).toBe('failed');
    expect(row(r, '1.2.5').methods.find((m) => m.id === 'media')).toMatchObject({ kind: 'ai', status: 'flagged' });
  });

  it('declares every probe that is the only automated method for one of its criteria', () => {
    for (const p of PROBES) {
      for (const criterion of p.criteria) {
        const def = CRITERIA.find((d) => d.criterion === criterion);
        if (!def) continue;
        const others = def.methods.filter((m) => m !== `probe:${p.id}`);
        if (!others.length) expect(def.methods, `${criterion} ${p.id}`).toContain(`probe:${p.id}`);
      }
    }
  });

  it('a core scan shows the deep media-players probe as not run; with its results the rows take them', () => {
    const embed: Omit<MediaItem, 'issues'> = { kind: 'embed', content: 'video', url: 'https://www.youtube.com/embed/abcdefghijk', foundOn: ['https://e.org/'], player: 'youtube', captions: 'check-manually' };
    const media: MediaItem[] = [{ ...embed, issues: mediaIssues(embed) }];
    const core = buildReport({
      site: 'https://e.org/', pages: [page('https://e.org/')], documents: [], media, skipped: [], probeRuns: [],
      startedAt: '2026-10-31T00:00:00.000Z', finishedAt: '2026-10-31T00:01:00.000Z', userAgent: 'UA',
    });
    expect(row(core, '1.2.4')).toMatchObject({ status: 'not_testable', methods: [{ id: 'media-players', note: 'a deep automated test, not run in this scan' }] });
    const full = build({ media, criteriaExtra: [
      { criterion: '1.2.4', method: { id: 'media-players', kind: 'interaction', status: 'failed', pages: 1 }, evidence: [{ page: 'https://e.org/', target: embed.url, detail: 'this live stream offers no captions' }] },
      { criterion: '1.2.2', method: { id: 'media-players', kind: 'interaction', status: 'not_applicable', pages: 1 }, evidence: [] },
    ] });
    expect(row(full, '1.2.4')).toMatchObject({ status: 'failed', evidence: [{ detail: 'this live stream offers no captions' }] });
    // Not declared in 1.2.2 (the core media rules test it), but its results still join the row.
    // The every-page media-files test is declared for 1.2.2 (it did not run in this report).
    expect(row(full, '1.2.2').methods.map((m) => m.id)).toEqual(['axe', 'media-rules', 'media-players', 'media-files']);
  });

  it('review #4: a probe that could not test a player keeps the row not testable even when the inventory lists no media', () => {
    const r = build({ media: [], criteriaExtra: [
      { criterion: '1.2.4', method: { id: 'media-players', kind: 'interaction', status: 'not_testable', pages: 1, note: 'x' },
        evidence: [{ page: 'https://e.org/', target: 'lite-youtube', detail: 'a click-to-load video preview was not tested' }] },
    ] });
    expect(row(r, '1.2.4')).toMatchObject({ status: 'not_testable', evidence: [{ detail: 'a click-to-load video preview was not tested' }] });
  });

  it('takes results from other automated methods (the probe framework)', () => {
    const extra: CriterionExtra[] = [
      { criterion: '2.1.2', method: { id: 'keyboard', kind: 'interaction', status: 'failed', pages: 1 }, evidence: [{ page: 'https://e.org/', target: '#widget', detail: 'Focus is trapped in the date picker.' }] },
      { criterion: '1.4.10', method: { id: 'reflow', kind: 'render', status: 'no_failures_found', pages: 3 }, evidence: [] },
      { criterion: '1.4.10', method: { id: 'overlays', kind: 'render', status: 'no_failures_found', pages: 3 }, evidence: [] },
    ];
    const r = build({ criteriaExtra: extra });
    expect(row(r, '2.1.2')).toMatchObject({ status: 'failed', methods: [extra[0]!.method], evidence: extra[0]!.evidence });
    expect(row(r, '1.4.10')).toMatchObject({ status: 'no_failures_found', methods: [extra[1]!.method, extra[2]!.method] });
    expect(buildCriteria(r, extra)).toEqual(r.criteria);
  });
});

describe('the criteria in the report', () => {
  const r = build({ pages: [page('https://e.org/', { violations: [finding('image-alt')] })] });

  // The HTML section ("WCAG 2.2 results") is tested in criteriaView.test.ts.
  it('adds one line to the terminal summary', () => {
    const counts = criteriaCounts(r.criteria!);
    expect(criteriaTerminalLine(r)).toBe(
      `WCAG 2.2 A/AA criteria (55): ${counts.failed} failed · 0 need review · ${counts.not_testable} could not be tested automatically · `
      + `${counts.no_failures_found} no failures found by automated tests · ${counts.not_applicable} not applicable`,
    );
    expect(renderTerminal(r)).toContain(criteriaTerminalLine(r));
  });
});
