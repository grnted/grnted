// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Report v3 stage 2: the score after each repair job (the real scorer on the report with the job's problems,
// and every earlier job's, taken out of what the scan found) and the job after which each standard has no
// automated failures left (src/report/jobScore.ts).
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildReport } from '../../src/report/build.js';
import { buildJobs, type RepairJob } from '../../src/report/jobs.js';
import { failsStandard, milestones, projectJobs, reportWithFixed } from '../../src/report/jobScore.js';
import { projectGranted, projectScore, rescore } from '../../src/report/projection.js';
import type { PageAudit, SiteReport } from '../../src/types.js';
import { fullReport } from '../helpers/reportFixture.js';

const fixture = (): SiteReport => JSON.parse(gunzipSync(readFileSync(new URL('../fixtures/print/e2e-fixture-report.json.gz', import.meta.url))).toString());

describe('score after each job (the e2e fixture: 14 pages, 73 problems, 8 jobs)', () => {
  const r = fixture();
  const model = buildJobs(r);

  it('runs the real scorer job by job: 57 at the start, 100 with every job done', () => {
    expect(r.score).toBe(57);
    expect(model.jobs.map((j) => j.scoreAfter)).toEqual([60, 62, 66, 74, 84, 87, 90, 100]);
    expect(model.jobs.map((j) => j.gain)).toEqual([3, 2, 4, 8, 10, 3, 3, 10]);
    // The gains add up to the whole way from the score to the last job's score.
    expect(model.jobs.reduce((n, j) => n + j.gain!, 0)).toBe(100 - 57);
  });

  it('agrees with the existing projection wherever a prefix of jobs fixes whole checks (no check half fixed)', () => {
    const keysOf = (codes: Set<string>) => {
      const all = new Map<string, { done: number; total: number }>();
      for (const p of model.problems) for (const k of p.sourceKeys) {
        const e = all.get(k) ?? { done: 0, total: 0 };
        e.total++; if (codes.has(p.code)) e.done++;
        all.set(k, e);
      }
      return { whole: [...all].filter(([, e]) => e.done === e.total).map(([k]) => k), partial: [...all].filter(([, e]) => e.done && e.done < e.total).map(([k]) => k) };
    };
    const done = new Set<string>();
    let compared = 0;
    model.jobs.forEach((j) => {
      for (const c of j.problems) done.add(c);
      const { whole, partial } = keysOf(done);
      if (partial.length) return;
      expect(j.scoreAfter, j.code).toBe(projectScore(r, whole));
      expect(j.grantedAfter, j.code).toBe(projectGranted(r, whole));
      compared++;
    });
    expect(compared).toBeGreaterThanOrEqual(6);
  });

  it('Access Granted needs 90 or more AND no failure left in the four blocking checks', () => {
    expect(model.jobs.map((j) => j.grantedAfter)).toEqual([false, false, false, false, false, false, true, true]);
    expect(model.grantedAfterJob).toBe(7);
    // The same plan with the keyboard trap itself (P72, 2.1.2: a blocking check) split off and done last: every
    // other repair gives a score over 90, but with the trap left the site is not Access Granted.
    const trap = model.problems.find((x) => x.criteria.includes('2.1.2'))!;
    const plan = [...model.jobs.map((j) => ({ ...j, problems: j.problems.filter((c) => c !== trap.code) })), { ...model.jobs[1]!, code: 'JX', problems: [trap.code] }];
    const p = projectJobs(r, plan, model.problems)!;
    const beforeTrap = p.scores[7]!;
    expect(beforeTrap.scoreAfter).toBeGreaterThanOrEqual(90); // a score that would be enough…
    expect(beforeTrap.grantedAfter).toBe(false); // …but the keyboard trap is left
    expect(p.scores[8]).toMatchObject({ scoreAfter: 100, grantedAfter: true });
    expect(p.grantedAfterJob).toBe(9);
  });

  it('changes no score: the report, its problems\' points and the public score are as before', () => {
    const again = fixture();
    buildJobs(again);
    expect(again.score).toBe(57);
    expect(rescore(again)!.score).toBe(57);
    expect(reportWithFixed(again, model.problems, new Set())).toBe(again);
  });

  it('per standard, the job after which no automated failure of it is left', () => {
    expect(model.milestones).toEqual([
      { id: 'A', afterJob: 8, job: 'J8' }, { id: '2.1-AA-title-ii', afterJob: 8, job: 'J8' },
      { id: '2.2-AA', afterJob: 8, job: 'J8' }, { id: 'en-301-549', afterJob: 8, job: 'J8' },
    ]);
  });
});

const E = 'https://agency.example';
/** A rules-only report, scored as the scorer scores it (no tests ran, so buildReport leaves it unscored). */
function site(pages: { path: string; violations: PageAudit['violations'] }[]): SiteReport {
  const r = buildReport({
    site: `${E}/`, documents: [], skipped: [], userAgent: 'test', startedAt: '2026-11-09T18:00:00Z', finishedAt: '2026-11-09T18:01:00Z',
    pages: pages.map((p) => ({ url: `${E}${p.path}`, status: 'ok', rules: {}, incomplete: [], links: [], violations: p.violations })),
  });
  return { ...r, status: 'scored', score: rescore(r)!.score };
}
const header = { id: 'button-name', help: 'Buttons need names', helpUrl: 'https://example.org/rule', nodes: [{ target: 'header.site > button.menu', html: '<button class="menu"></button>', viewports: ['desktop' as const] }] };

describe('a check half fixed', () => {
  it('a page stays failing a rule while an unfixed problem of that rule is on it', () => {
    // button-name: the shared header button on every page, and a second, different button on the homepage only.
    const r = site([
      { path: '/', violations: [{ ...header, nodes: [...header.nodes, { target: 'main > form > button.go', html: '<button class="go"><svg></svg></button>', viewports: ['desktop'] }] }] },
      { path: '/a', violations: [header] }, { path: '/b', violations: [header] }, { path: '/c', violations: [header] },
    ]);
    const m = buildJobs(r);
    expect(m.problems).toHaveLength(2);
    expect(m.jobs).toHaveLength(2);
    expect(m.jobs[0]!.pages).toHaveLength(4); // the header button first: it is on every page
    // By hand: after the header job the rule still fails on the homepage only.
    const homeOnly = { ...r, rules: r.rules.map((x) => (x.id === 'button-name' ? { ...x, pagesAffected: [`${E}/`] } : x)) };
    expect(m.jobs[0]!.scoreAfter).toBe(rescore(homeOnly)!.score);
    expect(m.jobs[0]!.scoreAfter).toBeLessThan(100); // never the whole rule's points for half the repair
    expect(m.jobs[1]!.scoreAfter).toBe(100);
    expect(m.jobs.map((j) => j.gain)).toEqual([m.jobs[0]!.scoreAfter! - r.score!, 100 - m.jobs[0]!.scoreAfter!]);
  });

  it('no projection when the report has no score or its checks do not give its score', () => {
    const r = site([{ path: '/', violations: [header] }]);
    const unscored = { ...r, status: 'blocked', score: null } as unknown as SiteReport;
    expect(buildJobs(unscored).jobs.every((j) => j.scoreAfter === null && j.gain === null && j.grantedAfter === null)).toBe(true);
    expect(buildJobs({ ...r, score: (r.score as number) + 7 }).jobs[0]!.scoreAfter).toBeNull(); // an altered report
    expect(buildJobs(unscored).grantedAfterJob).toBeNull();
  });
});

describe('milestones per standard', () => {
  it('A and WCAG 2.1 AA (Title II) end before a WCAG 2.2-only failure; 2.2 AA and EN 301 549 after it', () => {
    const r = site([
      { path: '/', violations: [{ id: 'image-alt', help: 'Images need alt', helpUrl: 'https://example.org/rule', nodes: [{ target: '#hero', html: '<img id="hero" src="/g.png">', viewports: ['desktop'] }] }] },
      { path: '/b', violations: [{ id: 'target-size', help: 'Targets', helpUrl: 'https://example.org/rule', nodes: [{ target: 'a.feed', html: '<a class="feed" href="/f"></a>', viewports: ['desktop'] }] }] },
    ]);
    const m = buildJobs(r);
    expect(m.jobs.map((j) => m.problems.find((p) => p.code === j.problems[0])!.criteria)).toEqual([['1.1.1'], ['2.5.8']]);
    expect(Object.fromEntries(m.milestones.map((x) => [x.id, x.afterJob]))).toEqual({ A: 1, '2.1-AA-title-ii': 1, '2.2-AA': 2, 'en-301-549': 2 });
    expect(m.milestones.find((x) => x.id === 'A')!.job).toBe(m.jobs[0]!.code);
  });

  it('0 when nothing failed to begin with; null when a failing criterion has no job', () => {
    const clean = buildJobs(site([{ path: '/', violations: [] }]));
    expect(clean.jobs).toEqual([]);
    expect(clean.milestones.every((x) => x.afterJob === 0 && x.job === null)).toBe(true);
    expect(clean.grantedAfterJob).toBe(0);
    // This report fails 2.1.2 (Level A, in every standard) with no problem in the plan.
    const orphan = buildJobs(fullReport());
    expect(orphan.milestones.map((x) => x.afterJob)).toEqual([null, null, null, null]);
    expect(milestones({ ...fullReport(), criteria: [] }, orphan.jobs as RepairJob[], orphan.problems).some((x) => x.afterJob !== null)).toBe(true);
  });

  it('which standards a criterion is in (A, 2.1 AA, 2.2 AA; EN 301 549 clause 9 for pages, clause 10 for documents)', () => {
    const web = (c: string) => ({ criteria: [c], sourceKey: 'rule:x' });
    const pdf = (c: string) => ({ criteria: [c], sourceKey: 'documents' });
    expect(['A', '2.1-AA-title-ii', '2.2-AA', 'en-301-549'].map((id) => failsStandard(web('2.5.8'), id as never))).toEqual([false, false, true, true]); // AA, new in 2.2
    expect(['A', '2.1-AA-title-ii', '2.2-AA', 'en-301-549'].map((id) => failsStandard(web('3.2.6'), id as never))).toEqual([true, false, true, true]); // A, new in 2.2
    expect(['A', '2.1-AA-title-ii', '2.2-AA', 'en-301-549'].map((id) => failsStandard(web('1.4.3'), id as never))).toEqual([false, true, true, true]);
    expect(failsStandard(pdf('2.4.5'), 'en-301-549')).toBe(false); // clause 10.2.4.5 is void for documents
    expect(failsStandard(web('2.4.5'), 'en-301-549')).toBe(true);
    expect(failsStandard(pdf('3.1.1'), 'en-301-549')).toBe(true);
    expect(failsStandard(web('4.1.1'), '2.2-AA')).toBe(false); // obsolete in 2.2: never a failure here
  });
});

describe('scale', () => {
  it('a 3,500-page site: content, the score after each job and milestones in a few seconds', () => {
    const paths = Array.from({ length: 3500 }, (_, i) => (i ? `/section-${i % 40}/page-${i}` : '/'));
    const r = site(paths.map((path, i) => ({ path, violations: [
      header,
      ...(i % 7 === 0 ? [{ id: 'image-alt', help: 'Images need alt', helpUrl: 'https://example.org/rule', nodes: [{ target: `#photo-${i}`, html: `<img id="photo-${i}" src="/p/${i}.jpg">`, viewports: ['desktop' as const] }] }] : []),
      ...(i % 11 === 0 ? [{ id: 'color-contrast', help: 'Contrast', helpUrl: 'https://example.org/rule', nodes: [{ target: 'main > p.note', html: '<p class="note">Note</p>', viewports: ['desktop' as const] }] }] : []),
    ] })));
    const t0 = Date.now();
    const m = buildJobs(r);
    const first = Date.now() - t0;
    expect(m.problems.length).toBeGreaterThan(500);
    expect(m.jobs.at(-1)!.scoreAfter).toBe(100);
    expect(first).toBeLessThan(15_000);
    // A second plan of the same report gives the same projection (computed once per report and plan).
    expect(buildJobs(r).jobs.map((j) => j.scoreAfter)).toEqual(m.jobs.map((j) => j.scoreAfter));
  }, 60_000);
});

describe('Sol review r1 (2026-11-09): a PDF with no title and no shown title', () => {
  it('#4 its steps set the title AND show it, and the score after its job is what those two repairs give', () => {
    const url = `${E}/files/notice.pdf`;
    const checks = { pages: 1, pagesChecked: 1, tagged: true, hasTitle: false, showsTitle: false, hasLanguage: true, imageOnly: false, figuresWithoutAlt: 0 };
    const built = buildReport({ site: `${E}/`, pages: [{ url: `${E}/`, status: 'ok', rules: {}, incomplete: [], links: [], violations: [] }], documents: [url], skipped: [], userAgent: 'test',
      startedAt: '', finishedAt: '', scoreDocuments: true, documentChecks: [{ url, type: 'pdf', detectedBy: 'extension', linkedFrom: [`${E}/`], checks }] });
    const r = { ...built, status: 'scored', score: rescore(built)!.score } as SiteReport;
    const m = buildJobs(r);
    const doc = m.problems.find((p) => p.sourceKey === 'documents')!;
    const text = doc.steps.join(' ');
    expect(text).toMatch(/title in the file’s properties|File, Info, Title/);
    expect(text).toMatch(/show its title|Show Document Title|DisplayDocTitle/);
    const fixedBoth = { ...r, documentChecks: [{ ...r.documentChecks![0]!, checks: { ...checks, hasTitle: true, showsTitle: true } }] };
    const titleOnly = { ...r, documentChecks: [{ ...r.documentChecks![0]!, checks: { ...checks, hasTitle: true } }] };
    expect(rescore(titleOnly)!.score).toBeLessThan(rescore(fixedBoth)!.score); // showing the title is a repair of its own
    expect(m.jobs.find((j) => j.problems.includes(doc.code))!.scoreAfter).toBe(rescore(fixedBoth)!.score);
  });
});
