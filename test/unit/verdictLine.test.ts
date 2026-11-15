// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 19, first-run correctness: "Access Denied · <address>" read as "the site blocked the scanner". The verdict line
// leads with the score, gives the reason on the same line, and puts the address on its own line; what Access Granted
// means (90 or more and no blocking failure) is said in the help, the plain HTML report and both fix briefs.
import { describe, expect, it } from 'vitest';
import { ACCESS_GRANTED_RULE, ACCESS_GRANTED_SHORT, verdictLine } from '../../src/report/blocked.js';
import { buildReport } from '../../src/report/build.js';
import { fixPrompt } from '../../src/report/fixPrompt.js';
import { renderPlainHtml } from '../../src/report/plain.js';
import { renderTerminal } from '../../src/report/terminal.js';
import type { PageAudit, ProbeRun, SiteReport } from '../../src/types.js';

const U = (p: string) => `https://e.org${p}`;
const P5 = ['/', '/a', '/b', '/c', '/d'];
const clean = (p: string, extra: Partial<PageAudit> = {}): PageAudit => ({ url: U(p), status: 'ok', rules: { 'image-alt': 'pass' }, violations: [], incomplete: [], links: [], ...extra });
const base = { site: U('/'), documents: [], skipped: [], startedAt: 't', finishedAt: '2026-11-04T00:00:00Z', userAgent: 'ua' };
const motion = (page: string, status: 'failed' | 'no_failures_found'): ProbeRun => ({
  probe: 'motion', kind: 'render', page: U(page), criteria: ['2.2.2'], status: 'ok', ms: 1, findings: [{ criterion: '2.2.2', status, detail: 'a slideshow that never stops' }],
});
const imageAlt = { id: 'image-alt', help: 'Images must have alternate text', helpUrl: 'https://x', nodes: [{ target: 'img', html: '<img src="a.png">', viewports: ['desktop' as const] }] };
const granted = (): SiteReport => buildReport({ ...base, pages: P5.map((p) => clean(p)) });
const blocked = (): SiteReport => buildReport({ ...base, pages: P5.map((p) => clean(p)), probeRuns: P5.map((p, i) => motion(p, i === 0 ? 'failed' : 'no_failures_found')) });
const low = (): SiteReport => buildReport({ ...base, pages: P5.map((p) => clean(p, { rules: { 'image-alt': 'fail' }, violations: [imageAlt] })), probeRuns: P5.map((p) => ({ ...motion(p, 'no_failures_found'), probe: 'keyboard', criteria: ['2.1.1'], findings: [{ criterion: '2.1.1', status: 'failed' as const, detail: 'x' }] })) });

describe('the verdict line: the score first, then the verdict and why, on one line', () => {
  it('Access Granted', () => {
    const r = granted();
    expect(r.headline).toBe('Access Granted');
    expect(verdictLine(r)).toBe(`${r.score}/100 · Grade ${r.letter} · Access Granted: 90 or more, and no failure blocks it`);
  });
  it('Access Denied by the score says it is below the 90 Access Granted needs', () => {
    const r = low();
    expect(r.score!).toBeLessThan(90);
    expect(verdictLine(r)).toBe(`${r.score}/100 · Grade ${r.letter} · Access Denied: ${r.score} is below the 90 needed for Access Granted`);
  });
  it('Access Denied by a blocking failure names it', () => {
    const r = blocked();
    expect(r.score!).toBeGreaterThanOrEqual(90);
    expect(verdictLine(r)).toBe(`${r.score}/100 · Grade ${r.letter} · Access Denied: a page fails WCAG 2.2.2 Pause, stop, hide, which blocks Access Granted whatever the score`);
  });
  it('no line for a report with no score', () => {
    expect(verdictLine({ ...granted(), status: 'incomplete', score: null, letter: null, headline: 'Scan incomplete' })).toBeNull();
  });
});

describe('every surface leads with the verdict line and says what Access Granted means', () => {
  it('the terminal: the verdict line first, the address on its own line', () => {
    const r = low();
    const lines = renderTerminal(r).split('\n').filter((l) => l.trim());
    expect(lines[0]).toBe(`  ${verdictLine(r)}`);
    expect(lines[1]).toBe(`  ${r.site}`);
    expect(renderTerminal(r)).not.toMatch(/Access Denied {2}· /);
  });
  it('the plain HTML report and both fix briefs give the reason and define Access Granted', () => {
    for (const r of [low(), blocked(), granted()]) {
      const html = renderPlainHtml(r);
      expect(html).toContain(ACCESS_GRANTED_RULE);
      expect(html).toContain(verdictLine(r)!.split(' · ').slice(2).join(' · '));
      for (const audience of ['developer', 'content'] as const) {
        const brief = fixPrompt(r, { audience });
        // The briefs carry the short form (room in a brief is room for a problem).
        expect(brief, audience).toContain(ACCESS_GRANTED_SHORT);
        expect(brief, audience).toContain(verdictLine(r)!.split(' · ').slice(2).join(' · '));
      }
    }
  });
  it('Access Granted is defined in plain words: 90 or more, no blocking failure, the verdict of the check', () => {
    expect(ACCESS_GRANTED_RULE).toMatch(/90 or more/);
    expect(ACCESS_GRANTED_RULE).toMatch(/1\.4\.2.*2\.1\.2.*2\.2\.2.*2\.3\.1/);
    expect(ACCESS_GRANTED_RULE).toMatch(/not the site blocking the scanner/);
    expect(ACCESS_GRANTED_SHORT).toMatch(/^Access Granted means 90 or more and no failure of 1\.4\.2, 2\.1\.2, 2\.2\.2 or 2\.3\.1; .*not the site blocking the scanner\.$/);
    expect(ACCESS_GRANTED_SHORT.length).toBeLessThan(150);
  });
});
