// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { buildReport } from '../../src/report/build.js';
import { renderTerminal } from '../../src/report/terminal.js';
import { AI_DISCLAIMER } from '../../src/report/ai.js';
import type { AiFinding, PageAudit, SiteReport } from '../../src/types.js';

const hostile = '<script>alert(1)</script>';
const pages: PageAudit[] = [{
  url: 'https://e.org/', status: 'ok', rules: { 'image-alt': 'fail', label: 'pass' },
  violations: [{ id: 'image-alt', help: `Images need alt ${hostile}`, helpUrl: 'https://x/image-alt',
    nodes: [{ target: '#a', html: `<img src=x onerror=alert(1)>${hostile}`, viewports: ['desktop'] }] }],
  incomplete: [], links: [],
  untestedFrames: [
    { url: 'https://maps.example/embed?q=1&z=2', reason: 'The test inside the frame timed out.' },
    { url: 'javascript:alert(1)', reason: `The test could not run inside the frame: ${hostile}` },
  ],
}];
const report = buildReport({ site: 'https://e.org/', pages, documents: ['https://e.org/a.pdf'], skipped: [],
  startedAt: '2026-10-30T00:00:00.000Z', finishedAt: '2026-10-30T00:01:00.000Z', userAgent: 'UA' });

describe('renderTerminal', () => {
  it('summarises the score and top rules', () => {
    const out = renderTerminal(report, 'report.html');
    expect(out).toContain(`${report.score}`);
    expect(out).toContain('image-alt');
    expect(out).toContain('report.html');
    expect(out).toContain('2 embedded frames could not be tested');
  });
  it('lists problems by plain title with counts and keeps the summary line (report v2)', () => {
    const out = renderTerminal(report);
    expect(out).toContain('  Fix these first:\n  - Images have no text description: 1 element on 1 page, +');
    expect(out).toContain('(image-alt)');
    // Batch 19: the verdict line leads with the score.
    expect(out).toContain(`${report.score}/100 · Grade ${report.letter}`);
    expect(out).toContain('1/1 page scanned');
  });
  it('keeps terminal control characters from rule ids out of the problems list, and counts the rest', () => {
    const r = { ...report, rules: Array.from({ length: 10 }, (_, i) => ({ ...report.rules[0]!, id: `x\u001b[2J${i}` })) };
    const out = renderTerminal(r);
    expect(out).not.toContain('\u001b');
    expect(out).toContain('  and 2 more (listed in the report)');
  });
  it('a clean report lists no problems', () => {
    expect(renderTerminal({ ...report, rules: [] })).not.toContain('Fix these first');
  });
});

describe('AI review section', () => {
  const finding = (over: Partial<AiFinding>): AiFinding => ({
    check: 'altText', criterion: '1.1.1', page: 'https://e.org/', target: 'https://e.org/img/a.png', verdict: 'inaccurate', label: hostile,
    flagged: true, confidence: 'high', observed: hostile, issue: hostile, suggestion: hostile, current: { label: 'Current alt text', value: hostile },
    source: 'ai', ...over,
  });
  const withAi: SiteReport = { ...report, ai: { disclaimer: AI_DISCLAIMER, runs: [{
    check: 'altText', title: 'Image descriptions (alt text)', summary: `Summary ${hostile}`, model: 'm', promptVersion: 'alt-text@1', tier: 'core',
    inputs: 9, reviewed: 3, cached: 2, notReviewed: 1,
    findings: [
      finding({}),
      finding({ target: 'inline image', verdict: 'accurate', label: 'Looks right', flagged: false, observed: 'A divider', issue: '', suggestion: '', current: { label: 'Current alt text (marked decorative)', value: '' } }),
      finding({ target: 'javascript:alert(1)', verdict: 'not_reviewed', label: 'Not reviewed', flagged: false, observed: '', issue: 'The AI reviewer did not answer in time.', suggestion: '', current: undefined }),
      finding({ check: 'altText', target: 'Same name, different page', verdict: 'same_name_different_target', label: 'Rules finding', source: 'rules', current: undefined }),
    ],
  }] } };
  it('summarises each AI run in the terminal', () => {
    expect(renderTerminal(withAi)).toContain('AI review · Image descriptions (alt text) (m): 2 AI-flagged issues (not in the score), 3 reviewed');
  });
});
