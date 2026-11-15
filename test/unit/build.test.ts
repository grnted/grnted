// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { buildReport } from '../../src/report/build.js';
import type { Impact, PageAudit } from '../../src/types.js';

const impactOf = (id: string): Impact => (id === 'input-image-alt' ? 'critical' : 'serious');
const finding = (id: string, target: string) => ({
  id, help: `${id} help`, helpUrl: `https://x/${id}`, nodes: [{ target, html: `<img id="${target}">`, viewports: ['desktop' as const] }],
});
// Scoring v5: image-alt fails on 2 of 3 loaded pages, label on 1 of 3.
const pad = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`p${i}`, 'pass' as const]));
const pages: PageAudit[] = [
  { url: 'https://e.org/', status: 'ok', rules: { ...pad, 'input-image-alt': 'fail', label: 'pass' }, violations: [finding('input-image-alt', '#a')],
    incomplete: [finding('color-contrast', '#h')], links: ['https://e.org/board.pdf'] },
  { url: 'https://e.org/b', status: 'ok', rules: { ...pad, 'input-image-alt': 'fail', label: 'fail' },
    violations: [finding('input-image-alt', '#b'), finding('label', '#in')], incomplete: [], links: [] },
  { url: 'https://e.org/c', status: 'failed', reason: 'HTTP 500', rules: {}, violations: [], incomplete: [], links: [] },
  // A fourth loaded page: scoring needs at least 3 loaded pages when 3+ were selected.
  { url: 'https://e.org/d', status: 'ok', rules: { label: 'pass' }, violations: [], incomplete: [], links: [],
    untestedFrames: [{ url: 'https://maps.example/embed', reason: 'The test inside the frame timed out.' }] },
];

describe('buildReport', () => {
  const report = buildReport({
    site: 'https://e.org/', pages, documents: ['https://e.org/board.pdf'], skipped: [],
    startedAt: '2026-10-30T00:00:00.000Z', finishedAt: '2026-10-30T00:01:00.000Z', userAgent: 'UA', impactOf,
  });

  it('carries the score result', () => {
    expect(report.schemaVersion).toBe(2);
    expect(report.status).toBe('scored');
    expect('capped' in report).toBe(false);
    // total 9 × √(2/3) + 7 × √(1/3) = 11.39 → 100 − 18 × ln(1 + 11.39 ÷ 10) = 86.31 → 86.
    expect(report.score).toBe(86);
    expect(report.letter).not.toBeNull();
  });
  it('summarises rules across pages, worst first', () => {
    expect(report.rules.map((r) => r.id)).toEqual(['input-image-alt', 'label']);
    const img = report.rules[0]!;
    expect(img.impact).toBe('critical');
    expect(img.pagesAffected).toEqual(['https://e.org/', 'https://e.org/b']);
    expect(img.elements).toBe(2);
    expect(img.examples).toHaveLength(2);
    expect(img.pointsLost).toBeGreaterThan(0);
  });
  it('lists needs-review items separately with no points', () => {
    expect(report.needsReview.map((r) => r.id)).toEqual(['color-contrast']);
    expect(report.needsReview[0]!.pointsLost).toBe(0);
  });
  it('summarises pages including failures', () => {
    expect(report.pages[2]).toEqual({ url: 'https://e.org/c', status: 'failed', score: null, violations: 0, reason: 'HTTP 500' });
  });
  it('carries the frames that could not be tested, only on the pages that have them', () => {
    expect(report.pages[3]!.untestedFrames).toEqual([{ url: 'https://maps.example/embed', reason: 'The test inside the frame timed out.' }]);
    expect(report.pages.filter((p) => 'untestedFrames' in p)).toHaveLength(1);
  });
  it('stamps reproducibility metadata, and no disclaimer', () => {
    expect(report.meta.scoring).toBe('v14');
    expect(report.meta.axe).toBe('4.14.0');
    expect(report.meta.tags).toEqual(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa']);
    expect(report.meta.enabledRules).toEqual(['css-orientation-lock', 'label-content-name-mismatch', 'p-as-heading', 'table-fake-caption', 'target-size', 'td-has-header']);
    expect(report.meta.pageList).toEqual(pages.map((p) => p.url));
    expect(report.meta.viewports.map((v) => v.width)).toEqual([1280, 390]);
    expect(report).not.toHaveProperty('disclaimer');
  });
});
