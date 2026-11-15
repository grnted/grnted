// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Scoring v8 (Paul, 2026-11-04): a scored failure of a WCAG non-interference criterion (conformance
// requirement 5: 1.4.2, 2.1.2, 2.2.2, 2.3.1) on any page blocks Access Granted, whatever the score. The
// score and grade are unchanged; only the verdict changes, and the report says why in one plain line.
import { describe, expect, it } from 'vitest';
import { NON_INTERFERENCE_CRITERIA, accessBlockers, scoreReportV8 } from '../../src/criterionScore.js';
import { blockedLine } from '../../src/report/blocked.js';
import { buildReport } from '../../src/report/build.js';
import { projectGranted } from '../../src/report/projection.js';
import { renderTerminal } from '../../src/report/terminal.js';
import type { PageAudit, ProbeRun } from '../../src/types.js';

const U = (p: string) => `https://e.org${p}`;
const P5 = ['/', '/a', '/b', '/c', '/d'];
const clean = (p: string, extra: Partial<PageAudit> = {}): PageAudit => ({ url: U(p), status: 'ok', rules: { 'image-alt': 'pass' }, violations: [], incomplete: [], links: [], ...extra });
const base = { site: U('/'), documents: [], skipped: [], startedAt: 't', finishedAt: '2026-11-04T00:00:00Z', userAgent: 'ua' };
const motion = (page: string, status: 'failed' | 'no_failures_found' | 'not_testable', extra: Record<string, unknown> = {}): ProbeRun => ({
  probe: 'motion', kind: 'render', page: U(page), criteria: ['2.2.2'], status: 'ok', ms: 1, findings: [{ criterion: '2.2.2', status, detail: 'a slideshow that never stops', ...extra }],
});
/** Unstoppable motion on one of five pages: a high score, and Access Denied. */
const blocked = () => buildReport({ ...base, pages: P5.map((p) => clean(p)), probeRuns: P5.map((p, i) => motion(p, i === 0 ? 'failed' : 'no_failures_found')) });
const LINE = 'Access Denied: a page fails WCAG 2.2.2 Pause, stop, hide, which blocks Access Granted whatever the score.';

describe('a non-interference failure blocks Access Granted', () => {
  it('names the four criteria of conformance requirement 5', () => {
    expect([...NON_INTERFERENCE_CRITERIA]).toEqual(['1.4.2', '2.1.2', '2.2.2', '2.3.1']);
  });

  it('the score and grade are unchanged; the verdict is Access Denied, and the report says which criterion and where', () => {
    const r = blocked();
    expect(r.score).toBe(scoreReportV8(r)!.score);
    expect(r.score!).toBeGreaterThanOrEqual(90);
    expect(r.letter).toBe('A');
    expect(r.headline).toBe('Access Denied');
    expect(r.accessBlockedBy?.map((b) => [b.criterion, b.title, b.pages])).toEqual([['2.2.2', 'Pause, stop, hide', [U('/')]]]);
    expect(blockedLine(r)).toBe(LINE);
  });

  it('a criterion that was not testable, or cut short by the time limit, never blocks', () => {
    for (const extra of [{}, { timeLimit: true }]) {
      const r = buildReport({ ...base, pages: P5.map((p) => clean(p)), probeRuns: P5.map((p, i) => motion(p, i === 0 ? 'not_testable' : 'no_failures_found', extra)) });
      expect(r.headline).toBe('Access Granted');
      expect(r.accessBlockedBy).toBeUndefined();
      expect(blockedLine(r)).toBeNull();
    }
  });

  it('a scored failure inside a frame from another site blocks too (a marquee in an embed)', () => {
    const marquee = { id: 'marquee', help: 'marquee', helpUrl: 'https://x', nodes: [{ target: 'marquee', html: '<marquee>', viewports: ['desktop' as const] }] };
    const r = buildReport({ ...base, pages: P5.map((p, i) => clean(p, i === 2 ? { thirdParty: [{ url: 'https://w.example/embed', violations: [marquee] }] } : {})) });
    expect(accessBlockers(r).map((b) => [b.criterion, b.keys])).toEqual([['2.2.2', ['third-party:marquee']]]);
    expect(r.headline).toBe('Access Denied');
  });

  it('several pages and criteria: one line, every criterion named', () => {
    const trap = (p: string): ProbeRun => ({ probe: 'keyboard', kind: 'interaction', page: U(p), criteria: ['2.1.2'], status: 'ok', ms: 1, findings: [{ criterion: '2.1.2', status: 'failed', detail: 'focus stays' }] });
    const r = buildReport({ ...base, pages: P5.map((p) => clean(p)), probeRuns: [...P5.map((p, i) => motion(p, i < 2 ? 'failed' : 'no_failures_found')), trap('/c')] });
    expect(blockedLine(r)).toBe('Access Denied: 3 pages fail WCAG 2.1.2 No keyboard trap and WCAG 2.2.2 Pause, stop, hide, which block Access Granted whatever the score.');
  });
});

describe('everywhere the verdict is shown, it says why', () => {
  it('the terminal output', () => {
    // Batch 19: the reason is on the verdict line itself.
    expect(renderTerminal(blocked())).toContain(LINE.replace(/\.$/, ''));
  });
});

describe('the fixes put the non-interference fix first, and the road reaches Access Granted only with it', () => {
  /** A bigger, unrelated problem (contrast on every page) and a 2.2.2 failure on one page. */
  const both = () => buildReport({
    ...base,
    pages: P5.map((p) => clean(p, { rules: { 'color-contrast': 'fail' }, violations: [{ id: 'color-contrast', help: 'c', helpUrl: 'https://x', nodes: [{ target: 'p', html: '<p>', viewports: ['desktop' as const] }] }] })),
    probeRuns: P5.map((p, i) => motion(p, i === 0 ? 'failed' : 'no_failures_found')),
  });
  it('the projection: granted only once the score is 90 or more AND the blocking failure is fixed', () => {
    const r = blocked();
    expect(projectGranted(r, [])).toBe(false);
    expect(projectGranted(r, ['criterion:2.2.2'])).toBe(true);
    const r2 = both();
    expect(projectGranted(r2, ['rule:color-contrast'])).toBe(false);
    expect(projectGranted(r2, ['rule:color-contrast', 'criterion:2.2.2'])).toBe(true);
  });
});
