// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The review's second look (src/report/secondLook.ts): the failures a report extension moves to Needs review
// (`ReportExtension.demotions`) leave the score and read Needs review everywhere, and nothing else changes. The
// engine only applies the list; a stand-in extension gives it here (the closed package is never imported).
import { describe, expect, it } from 'vitest';
import { buildReport } from '../../src/report/build.js';
import { applySecondLook } from '../../src/report/secondLook.js';
import type { AiReport, PageAudit, ProbeRun, ReportExtension, ReportExtensionInput, SecondLookDemotion } from '../../src/types.js';

const pad = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`p${i}`, 'pass' as const]));
const contrast = (target: string) => ({
  id: 'color-contrast', help: 'Elements must meet minimum color contrast ratio thresholds', helpUrl: 'https://x/color-contrast',
  nodes: [{ target, html: `<a class="${target}">Pay</a>`, failureSummary: 'contrast 2.1:1', viewports: ['desktop' as const] }],
});
const page = (url: string, failing: boolean): PageAudit => ({
  url, status: 'ok', rules: { ...pad, 'color-contrast': failing ? 'fail' : 'pass' }, violations: failing ? [contrast('btn')] : [], incomplete: [], links: [],
});
const pages = [page('https://e.org/', true), page('https://e.org/b', true), page('https://e.org/c', false)];
const runs: ProbeRun[] = pages.map((p) => ({
  probe: 'non-text-contrast', kind: 'pixels', page: p.url, criteria: ['1.4.11'], status: 'ok', ms: 1,
  findings: [p.url === 'https://e.org/b'
    ? { criterion: '1.4.11', status: 'failed', target: '#pay', detail: 'The button\'s edge is 1.2:1 against the page' }
    : { criterion: '1.4.11', status: 'no_failures_found', detail: 'checked 4 controls' }],
}));
const ai: AiReport = {
  disclaimer: 'x',
  runs: [{
    check: 'listener', title: 'Listener', summary: 's', model: 'm', promptVersion: 'listener@1', tier: 'core', inputs: 1, reviewed: 1, cached: 0, notReviewed: 0,
    findings: [{ check: 'listener', criterion: '4.1.2', page: 'https://e.org/c', target: 'Heard: “Customer Service”', verdict: 'role_or_state_wrong', label: 'l',
      flagged: true, confidence: 'high', observed: 'o', issue: 'i', suggestion: 's', source: 'ai', scored: true, elements: ['text:customer service'] }],
  }],
};

/** A stand-in for the closed package's extension: it gives the list, counts nothing and keeps what it was given. */
function extension(demotions: readonly SecondLookDemotion[] | undefined): ReportExtension & { seen: ReportExtensionInput[] } {
  const seen: ReportExtensionInput[] = [];
  return {
    name: 'stand-in', seen,
    score: (input) => { seen.push(input); return { ai: input.ai, ran: false, issues: [], gates: {} }; },
    ...(demotions ? { demotions: () => demotions } : {}),
  };
}
const build = (ext?: ReportExtension) => buildReport({
  site: 'https://e.org/', pages, documents: [], skipped: [], startedAt: '2026-11-13T00:00:00.000Z', finishedAt: '2026-11-13T00:01:00.000Z', userAgent: 'UA',
  probeRuns: runs, ...(ext ? { ai, extension: ext } : {}),
});
const row = (r: ReturnType<typeof build>, criterion: string) => r.criteria!.find((c) => c.criterion === criterion)!;
const DOUBT = 'The link is a text-only link with no boundary; 1.4.3 is met by its text';

describe('the second look moves only the failures it names, to Needs review', () => {
  const base = build(extension(undefined));

  it('without demotions or with an empty list the report is the same; with no extension the review (and its list) is left out', () => {
    expect(JSON.stringify(build(extension([])))).toBe(JSON.stringify(base));
    const noExtension = buildReport({
      site: 'https://e.org/', pages, documents: [], skipped: [], startedAt: '2026-11-13T00:00:00.000Z', finishedAt: '2026-11-13T00:01:00.000Z',
      userAgent: 'UA', probeRuns: runs, ai,
    });
    expect(noExtension.ai).toBeUndefined();
    expect(noExtension.rules.find((x) => x.id === 'color-contrast')!.pagesAffected).toEqual(['https://e.org/', 'https://e.org/b']);
  });

  it('a demotion that names nothing on the scan changes nothing', () => {
    const none = build(extension([
      { method: 'axe', id: 'color-contrast', page: 'https://e.org/c', criterion: '1.4.3', reason: DOUBT },
      { method: 'test', id: 'non-text-contrast', page: 'https://e.org/', criterion: '1.4.11', reason: DOUBT },
      { method: 'ai', id: 'listener', page: 'https://e.org/c', criterion: '1.3.1', reason: DOUBT },
      { method: 'axe', id: 'link-name', page: 'https://e.org/', criterion: '2.4.4', reason: DOUBT },
    ]));
    expect(JSON.stringify(none)).toBe(JSON.stringify(base));
  });

  it('axe: the rule\'s failure on that page goes to Needs review with the reason; the other page still fails', () => {
    const r = build(extension([{ method: 'axe', id: 'color-contrast', page: 'https://e.org/', criterion: '1.4.3', reason: DOUBT }]));
    expect(r.rules.find((x) => x.id === 'color-contrast')!.pagesAffected).toEqual(['https://e.org/b']);
    const review = r.needsReview.find((x) => x.id === 'color-contrast')!;
    expect(review).toMatchObject({ pagesAffected: ['https://e.org/'], secondLook: 1, pointsLost: 0 });
    expect(r.pages[0]!.violations).toBe(0);
    expect(r.score).toBeGreaterThan(base.score!);
    expect(row(r, '1.4.3').status).toBe('failed');
  });

  it('axe: when every failing page is doubted, the criterion reads Needs review, never "no failures found"', () => {
    const r = build(extension(['https://e.org/', 'https://e.org/b'].map((p) => ({ method: 'axe' as const, id: 'color-contrast', page: p, criterion: '1.4.3', reason: DOUBT }))));
    expect(r.rules.some((x) => x.id === 'color-contrast')).toBe(false);
    const axe = row(r, '1.4.3').methods.find((m) => m.id === 'axe')!;
    expect(axe.status).toBe('flagged');
    expect(axe.note).toMatch(/^2 elements found by the rules and doubted on a second look: needs review/);
    expect(row(r, '1.4.3').status).toBe('flagged');
  });

  it('test: the test\'s failed findings of that criterion on that page become flagged with the reason', () => {
    expect(row(base, '1.4.11').status).toBe('failed');
    const r = build(extension([{ method: 'test', id: 'non-text-contrast', page: 'https://e.org/b', criterion: '1.4.11', reason: DOUBT }]));
    const f = r.probes!.runs.find((x) => x.page === 'https://e.org/b')!.findings[0]!;
    expect(f).toMatchObject({ status: 'flagged', secondLook: DOUBT, target: '#pay' });
    expect(row(r, '1.4.11').status).toBe('flagged');
    expect(r.testIssues?.some((t) => t.criterion === '1.4.11')).toBe(false);
    expect(r.score).toBeGreaterThan(base.score!);
  });

  it('ai: the check\'s confirmed finding of that criterion on that page stops counting, with the reason', () => {
    const ext = extension([{ method: 'ai', id: 'listener', page: 'https://e.org/c', criterion: '4.1.2', reason: DOUBT }]);
    build(ext);
    const f = ext.seen[0]!.ai.runs[0]!.findings[0]!;
    expect(f.scored).toBeUndefined();
    expect(f.secondLook).toBe(DOUBT);
    expect(f.flagged).toBe(true);
  });

  it('never modifies its inputs', () => {
    const input = { pages, probeRuns: runs, ai };
    const before = JSON.stringify(input);
    const out = applySecondLook(input, [
      { method: 'axe', id: 'color-contrast', page: 'https://e.org/', criterion: '1.4.3', reason: DOUBT },
      { method: 'test', id: 'non-text-contrast', page: 'https://e.org/b', criterion: '1.4.11', reason: DOUBT },
      { method: 'ai', id: 'listener', page: 'https://e.org/c', criterion: '4.1.2', reason: DOUBT },
    ]);
    expect(JSON.stringify(input)).toBe(before);
    expect(out.pages[0]!.rules['color-contrast']).toBe('incomplete');
    expect(out.pages[0]!.incomplete[0]!.secondLook).toBe(DOUBT);
    expect(applySecondLook(input, [])).toBe(input);
  });
});
