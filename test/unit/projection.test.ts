// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The projected score (report v3, executive summary): the real scorer (src/score.ts, combineChecks)
// run again over the report's failing checks with some of them removed. Never an approximation: the
// checks rebuilt from the report must give the report's own score and each check's own "+N if fixed".
import { describe, expect, it } from 'vitest';
import { buildReport } from '../../src/report/build.js';
import { v8ProbeWeight } from '../../src/criterionScore.js';
import { projectScore, reportChecks } from '../../src/report/projection.js';
import { buildProblems } from '../../src/report/problems.js';
import type { AiFinding, AiReport, PageAudit, ProbeRun, SiteReport } from '../../src/types.js';
import { recordedAi } from '../helpers/carryAi.js';

const U = (i: number) => `https://e.org/p${i}`;
/** Eight pages; axe rules failing on some (their page outcomes say so, as a real scan's do) and core tests failing on some of the pages they ran on. */
function rulesAndTests(): SiteReport {
  const fails: Record<string, number> = { 'input-image-alt': 8, 'color-contrast': 3, 'link-name': 5, region: 8, 'link-in-text-block': 1 };
  const pages: PageAudit[] = Array.from({ length: 8 }, (_, i) => ({
    url: U(i), status: 'ok', links: [], incomplete: [],
    rules: { ...Object.fromEntries(Object.entries(fails).map(([id, n]) => [id, i < n ? 'fail' : 'pass'] as const)), label: 'pass' },
    violations: Object.entries(fails).filter(([, n]) => i < n).map(([id]) => ({ id, help: id, helpUrl: 'https://x', nodes: [{ target: `.${id}`, html: `<a class="${id}">x</a>`, viewports: ['desktop'] as ('desktop' | 'mobile')[] }] })),
  }));
  const probeRuns: ProbeRun[] = Array.from({ length: 5 }, (_, i): ProbeRun[] => [
    { probe: 'reflow', kind: 'render', page: U(i), criteria: ['1.4.10'], status: 'ok', ms: 1, findings: [{ criterion: '1.4.10', status: i < 2 ? 'failed' : 'no_failures_found', detail: 'x' }] },
    { probe: 'keyboard', kind: 'interaction', page: U(i), criteria: ['2.4.11'], status: 'ok', ms: 1, findings: [{ criterion: '2.4.11', status: i < 4 ? 'failed' : 'no_failures_found', detail: 'x' }] },
  ]).flat();
  return buildReport({ site: U(0), pages, documents: [], skipped: [], startedAt: 't', finishedAt: '2026-11-01T00:00:00Z', userAgent: 'ua', probeRuns });
}
const bigReport = rulesAndTests;

const f = (pageUrl: string, src: string, extra: Partial<AiFinding> = {}): AiFinding => ({
  check: 'altText', criterion: '1.1.1', page: pageUrl, target: src, verdict: 'accurate', label: 'Looks right', flagged: false,
  confidence: 'high', observed: 'A picture.', issue: '', suggestion: '', source: 'ai', scoreTested: ['1.1.1', '1.4.5'], ...extra,
});

function withAi(): SiteReport {
  const pages: PageAudit[] = ['/a', '/b', '/c', '/d'].map((p, i) => ({
    url: `https://e.org${p}`, status: 'ok', rules: { 'color-contrast': i < 2 ? 'fail' : 'pass', 'input-image-alt': 'pass' },
    violations: i < 2 ? [{ id: 'color-contrast', help: 'Contrast', helpUrl: 'https://x', nodes: [{ target: '.a', html: '<p class="a">x</p>', viewports: ['desktop'] }] }] : [],
    incomplete: [], links: [],
  }));
  const findings = [
    f('https://e.org/a', 'https://e.org/f.png', { verdict: 'insufficient', flagged: true, scored: true, essentialText: 'Fair · April 14' }),
    f('https://e.org/b', 'https://e.org/g.png'),
  ];
  const ai: AiReport = { disclaimer: 'x', runs: [{ check: 'altText', title: 'Alt', summary: '', model: 'm', promptVersion: 'p', tier: 'core', inputs: 2, reviewed: 2, cached: 0, notReviewed: 0, findings }] };
  // What the AI package counts of it: the confirmed flyer on /a, of the 2 pages the image review answered for.
  const extension = recordedAi([{ criterion: '1.1.1', pagesAffected: ['https://e.org/a'], pagesTested: 2, pointsLost: 0, weight: 4.5, findings: [findings[0]!] }]);
  return buildReport({ site: 'https://e.org/', pages, documents: [], skipped: [], startedAt: 't', finishedAt: '2026-11-01T00:00:00Z', userAgent: 'ua', ai, extension });
}

describe('projected score', () => {
  for (const [name, make] of [['axe rules and core tests', bigReport], ['an AI-scored image check', withAi]] as const) {
    it(`rebuilds the scorer's checks from the report (${name})`, () => {
      const report = make();
      const checks = reportChecks(report)!;
      expect(checks).not.toBeNull();
      expect(checks.length).toBeGreaterThan(0);
      // Nothing removed: the report's own score.
      expect(projectScore(report, [])).toBe(report.score);
      // One removed: exactly that problem's "fixing this adds N points".
      for (const p of buildProblems(report).filter((x) => x.scored)) {
        expect(projectScore(report, [p.key]), p.key).toBe(report.score! + p.pointsLost);
      }
    });
  }

  it('fixing several together gives back more than the sum of each alone (diminishing returns), never past 100', () => {
    const report = bigReport();
    const scored = buildProblems(report).filter((p) => p.scored);
    const top = scored.slice(0, 3);
    const projected = projectScore(report, top.map((p) => p.key))!;
    expect(projected).toBeGreaterThanOrEqual(report.score! + top.reduce((n, p) => n + p.pointsLost, 0));
    expect(projectScore(report, scored.map((p) => p.key))).toBe(100);
  });

  it('leaves pages a core test could not test out of the share, as the scorer does (scoring v6)', () => {
    const pages: PageAudit[] = Array.from({ length: 4 }, (_, i) => ({ url: U(i), status: 'ok', links: [], incomplete: [], rules: { label: 'pass' }, violations: [] }));
    // 2.4.7 failed on one page and could not be tested on the three others: share 1 of 1.
    const probeRuns: ProbeRun[] = pages.map((p, i): ProbeRun => ({
      probe: 'keyboard', kind: 'interaction', page: p.url, criteria: ['2.4.11'], status: i === 0 ? 'ok' : 'timeout', ms: 1,
      findings: [{ criterion: '2.4.11', status: i === 0 ? 'failed' : 'not_testable', detail: 'x' }],
    }));
    const report = buildReport({ site: U(0), pages, documents: [], skipped: [], startedAt: 't', finishedAt: '2026-11-01T00:00:00Z', userAgent: 'ua', probeRuns });
    expect(report.score).toBe(94);
    expect(reportChecks(report)).toEqual([{ key: 'criterion:2.4.11', criterion: '2.4.11', weight: v8ProbeWeight('2.4.11'), share: 1 }]);
    expect(projectScore(report, ['criterion:2.4.11'])).toBe(100);
  });

  it('gives no projection when the checks cannot be rebuilt (an incomplete scan, or a report that does not add up)', () => {
    const report = bigReport();
    expect(projectScore({ ...report, status: 'incomplete', score: null }, [])).toBeNull();
    // A tampered score: the rebuilt checks no longer give it, so no number is made up.
    expect(reportChecks({ ...report, score: report.score! + 7 })).toBeNull();
    expect(projectScore({ ...report, score: report.score! + 7 }, ['rule:input-image-alt'])).toBeNull();
  });
});
