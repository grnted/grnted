// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Report v3 (stage 2, 2026-11-09): the score after each repair job, and the job after which each standard
// has no automated failures left. The score is the real scorer's (projection.ts `rescore`, the same
// computation as the report's own score) run on the report with the job's problems, and every earlier
// job's, taken out of what the scan found: never an estimate. Problems are taken out at the level the
// scorer counts them: an axe rule's page only when no unfixed problem of that rule is on it; a test's own
// findings (same page, test, element and words); a media file's issue; a cross-page rule's page; an AI
// check's page; a document made clean. Nothing here changes a score: it only computes projections.
// Engine core: no Node-only imports.
import { noBlocker } from '../criterionScore.js';
import { aiDocumentsCount } from '../aiScore.js';
import { officeProblems } from '../documents/office.js';
import type { DocumentCheck, SiteReport } from '../types.js';
import { buildCriteria, CRITERIA } from './criteria.js';
import { enDocClause, enWebClause } from './en301549Clauses.js';
import type { RepairJob, RepairProblem } from './jobs.js';
import { rescore } from './projection.js';

export interface JobScore {
  /** The score once this job and every earlier one is done; null when the report has no projection. */
  scoreAfter: number | null;
  /** What this job adds (scoreAfter minus the score before it). */
  gain: number | null;
  /** Access Granted once this job and every earlier one is done: 90 or more and no blocking failure left. */
  grantedAfter: boolean | null;
}

/** The standards a plan can reach: WCAG 2.2 Level A, WCAG 2.1 AA (the DOJ Title II rule), WCAG 2.2 AA, EN 301 549. */
export type MilestoneId = 'A' | '2.1-AA-title-ii' | '2.2-AA' | 'en-301-549';
export const MILESTONE_IDS: readonly MilestoneId[] = ['A', '2.1-AA-title-ii', '2.2-AA', 'en-301-549'];

export interface Milestone {
  id: MilestoneId;
  /**
   * The job (its place in the plan, 1 = first) after which no failure of this standard found by these automated
   * checks is left; 0 when none was found to begin with; null when one is left after the whole plan (a failing
   * criterion no job repairs). Never "conforms": only "no failures found in these automated checks".
   */
  afterJob: number | null;
  /** That job's public code (J3), or null. */
  job: string | null;
}

const unique = <T>(xs: Iterable<T>) => [...new Set(xs)];
const LEVEL = new Map(CRITERIA.map((c) => [c.criterion, c.level]));
const WCAG = new Map(CRITERIA.map((c) => [c.criterion, c.wcag]));
const isDocument = (p: RepairProblem) => p.sourceKey === 'documents' || p.sourceKey === 'office';

/** Whether a problem fails a standard (EN 301 549: clause 9 for web content, clause 10 for documents; WCAG 2.2 A/AA throughout). */
export function failsStandard(p: Pick<RepairProblem, 'criteria' | 'sourceKey'>, id: MilestoneId): boolean {
  return p.criteria.some((c) => {
    if (!LEVEL.has(c)) return false;
    if (id === 'A') return LEVEL.get(c) === 'A';
    if (id === '2.1-AA-title-ii') return WCAG.get(c) !== '2.2';
    if (id === '2.2-AA') return true;
    if (isDocument(p as RepairProblem)) { const d = enDocClause(c); return !!d && !d.void; }
    return !!enWebClause(c);
  });
}

/** A PDF's quick checks with every problem repaired (the same fields `pdfProblems` reads). */
function cleanPdf(d: DocumentCheck): DocumentCheck {
  const c = d.checks!;
  return { ...d, checks: { ...c, blocksAssistiveTech: false, xfa: false, imageOnly: false, ...(c.tagged === false ? { tagged: true } : {}),
    figuresWithoutAlt: 0, untitledFormFields: 0, ...(c.hasLanguage === false ? { hasLanguage: true } : {}), ...(c.hasTitle === false ? { hasTitle: true } : {}),
    ...(c.showsTitle === false ? { showsTitle: true } : {}) } };
}
/** An Office file's checks with its five problem findings repaired (hints are never counted). */
function cleanOffice(d: DocumentCheck): DocumentCheck {
  const o = d.officeChecks!;
  return { ...d, officeChecks: { ...o, passwordToOpen: false, imagesWithoutAlt: 0, slidesWithoutTitle: 0,
    ...(o.hasLanguage === false ? { hasLanguage: true } : {}), ...(o.hasTitle === false ? { hasTitle: true } : {}) } };
}

/**
 * The report as it would be with the problems in `fixed` (public codes) repaired: what the scan found, less
 * those problems. Everything the scorer reads is kept as it is except what a fixed problem accounts for, and
 * a page stays failing a check while any unfixed problem of that check is on it.
 */
export function reportWithFixed(report: SiteReport, problems: readonly RepairProblem[], fixed: ReadonlySet<string>): SiteReport {
  if (!fixed.size) return report;
  const keysOf = (p: RepairProblem) => (p.sourceKeys?.length ? p.sourceKeys : [p.sourceKey]);
  /** Pages a check (problem key) no longer fails on: every problem of it there is fixed. */
  const clearedPages = (key: string): Set<string> => {
    const done = new Set<string>();
    const open = new Set<string>();
    for (const p of problems) if (keysOf(p).includes(key)) for (const u of p.pages) (fixed.has(p.code) ? done : open).add(u);
    return new Set([...done].filter((u) => !open.has(u)));
  };
  const fixedProblems = problems.filter((p) => fixed.has(p.code));
  const fixedKeys = new Set(fixedProblems.flatMap(keysOf));
  const out: SiteReport = { ...report };

  // axe rules (and their minor pages): a page leaves the rule when no unfixed problem of it is there.
  out.rules = (report.rules ?? []).map((r) => {
    if (!fixedKeys.has(`rule:${r.id}`)) return r;
    const gone = clearedPages(`rule:${r.id}`);
    return { ...r, pagesAffected: r.pagesAffected.filter((u) => !gone.has(u)), ...(r.minorPages ? { minorPages: r.minorPages.filter((u) => !gone.has(u)) } : {}) };
  });
  if (report.thirdParty) out.thirdParty = report.thirdParty.map((t) => {
    if (!fixedKeys.has(`third-party:${t.id}`)) return t;
    const gone = clearedPages(`third-party:${t.id}`);
    return { ...t, pagesAffected: t.pagesAffected.filter((u) => !gone.has(u)) };
  });

  // Tests: the fixed problem's own findings (same page, test, element and words). A problem from an older
  // report with no recorded findings clears its criterion's failures on its pages instead.
  if (report.probes) {
    const exact = new Set<string>();
    const byPage = new Map<string, Set<string>>(); // criterion -> pages cleared as a whole
    for (const p of fixedProblems) {
      const keys = keysOf(p).filter((k) => k.startsWith('criterion:'));
      if (!keys.length) continue;
      const criteria = keys.map((k) => k.slice(10).replace(/\/listed$/, ''));
      const found = p.observations.filter((o) => o.test && !/^(?:rule:|criterion:|media:|ai:|consistency:)/.test(o.test));
      if (found.length) for (const o of found) for (const c of criteria) exact.add(`${o.page}\n${o.test}\n${c}\n${o.target}\n${o.detail}`);
      else for (const k of keys) {
        const c = k.slice(10).replace(/\/listed$/, '');
        const gone = clearedPages(k);
        byPage.set(c, new Set([...(byPage.get(c) ?? []), ...gone]));
      }
    }
    out.probes = { ...report.probes, runs: report.probes.runs.map((run) => {
      const findings = run.findings.filter((f) => !(f.status === 'failed' && (exact.has(`${run.page}\n${run.probe}\n${f.criterion}\n${f.target ?? ''}\n${f.detail}`) || byPage.get(f.criterion)?.has(run.page))));
      return findings.length === run.findings.length ? run : { ...run, findings };
    }) };
  }
  // Reports scored before v8 count tests through testIssues.
  if (report.testIssues) out.testIssues = report.testIssues.map((t) => {
    if (!fixedKeys.has(`criterion:${t.criterion}`)) return t;
    const gone = clearedPages(`criterion:${t.criterion}`);
    return { ...t, pagesAffected: t.pagesAffected.filter((u) => !gone.has(u)) };
  });

  // Cross-page rules: the page's evidence goes; a rule with none left no longer fails.
  if (report.consistency) out.consistency = report.consistency.flatMap((c) => {
    if (!fixedKeys.has(`consistency:${c.criterion}`) || c.method.status !== 'failed') return [c];
    const gone = clearedPages(`consistency:${c.criterion}`);
    const evidence = c.evidence.filter((e) => !gone.has(e.page));
    return evidence.length ? [{ ...c, evidence }] : [];
  });

  // Media: a file's (or an inline player's, per page) issue under a fixed problem's criterion.
  if (report.media) {
    const ident = (m: NonNullable<SiteReport['media']>[number]) => m.url || m.name || `Inline ${m.kind}`;
    const status = (criterion: string, page: string | null, target: string) => {
      let done = false;
      let open = false;
      for (const p of problems) {
        if (!keysOf(p).includes(`media:${criterion}`)) continue;
        if (!p.locations.some((l) => l.target === target && (page === null || l.page === page))) continue;
        if (fixed.has(p.code)) done = true; else open = true;
      }
      return done && !open;
    };
    out.media = report.media.flatMap((m) => {
      const criteria = unique(m.issues.filter((i) => i.level === 'problem' && fixedKeys.has(`media:${i.criterion}`)).map((i) => i.criterion));
      if (!criteria.length) return [m];
      if (m.url) {
        const gone = criteria.filter((c) => status(c, null, m.url));
        return [gone.length ? { ...m, issues: m.issues.filter((i) => !(i.level === 'problem' && gone.includes(i.criterion))) } : m];
      }
      // An inline player is one problem per page: split it into the pages repaired and the rest.
      const parts = new Map<string, { pages: string[]; gone: string[] }>();
      for (const page of m.foundOn) {
        const gone = criteria.filter((c) => status(c, page, ident(m)));
        const key = gone.join(',');
        const part = parts.get(key) ?? { pages: [], gone };
        part.pages.push(page);
        parts.set(key, part);
      }
      return [...parts.values()].map((part) => ({ ...m, foundOn: part.pages, issues: m.issues.filter((i) => !(i.level === 'problem' && part.gone.includes(i.criterion))) }));
    });
  }

  // Gated AI checks: a page leaves the check when its problem is fixed.
  if (report.aiChecks) out.aiChecks = { ...report.aiChecks, issues: report.aiChecks.issues.map((i) => {
    const key = (i.check ?? 'altText') === 'altText' ? `ai:${i.criterion}` : `ai:${i.check}:${i.criterion}`;
    if (!fixedKeys.has(key)) return i;
    const gone = clearedPages(key);
    return { ...i, pagesAffected: i.pagesAffected.filter((u) => !gone.has(u)) };
  }) };

  // Documents: a fixed document is clean (its quick checks repaired, the AI review's confirmed problems gone).
  const docs = new Set(fixedProblems.filter(isDocument).map((p) => p.locations[0]?.page ?? ''));
  if (docs.size && report.documentChecks) {
    out.documentChecks = report.documentChecks.map((d) => !docs.has(d.url) ? d : d.type === 'pdf' && d.checks ? cleanPdf(d) : d.officeChecks && officeProblems(d.officeChecks).length ? cleanOffice(d) : d);
    if (report.ai && aiDocumentsCount(report.meta?.scoring)) out.ai = { ...report.ai, runs: report.ai.runs.map((run) => run?.check !== 'document' || !Array.isArray(run.findings) ? run
      : { ...run, findings: run.findings.filter((f) => !(f && f.check === 'document' && typeof f.page === 'string' && docs.has(f.page))) }) };
  }
  return out;
}

/**
 * The score after each job in plan order (each job's and all earlier jobs' problems repaired), from the real
 * scorer. Null when the report has no projection (no score, or its checks do not rebuild its score).
 */
export function projectJobs(report: SiteReport, jobs: readonly RepairJob[], problems: readonly RepairProblem[]): { scores: JobScore[]; grantedAfterJob: number | null } | null {
  const start = rescore(report);
  if (!start || start.score !== report.score) return null;
  const fixed = new Set<string>();
  const scores: JobScore[] = [];
  let before = start.score;
  let grantedAfterJob: number | null = start.score >= 90 && (start.legacy || noBlocker(start.checks)) ? 0 : null;
  jobs.forEach((job, i) => {
    for (const code of job.problems) fixed.add(code);
    const after = rescore(reportWithFixed(report, problems, fixed));
    if (!after) { scores.push({ scoreAfter: null, gain: null, grantedAfter: null }); return; }
    const granted = after.score >= 90 && (after.legacy || noBlocker(after.checks));
    scores.push({ scoreAfter: after.score, gain: after.score - before, grantedAfter: granted });
    if (granted && grantedAfterJob === null) grantedAfterJob = i + 1;
    before = after.score;
  });
  return { scores, grantedAfterJob };
}

/**
 * For each standard, the job after which no failure of it found by these automated checks is left: the last
 * job holding a problem that fails it. Null when a failing criterion of it has no problem in the plan.
 */
export function milestones(report: SiteReport, jobs: readonly RepairJob[], problems: readonly RepairProblem[]): Milestone[] {
  const place = new Map(jobs.map((j, i) => [j.code, i + 1]));
  const covered = new Set(problems.flatMap((p) => p.criteria));
  const failing = (report.criteria ?? buildCriteria(report)).filter((c) => c.status === 'failed').map((c) => c.criterion);
  return MILESTONE_IDS.map((id) => {
    // A criterion the scan failed with no problem in the plan: no job takes it away.
    const orphan = failing.some((c) => !covered.has(c) && failsStandard({ criteria: [c], sourceKey: '' }, id));
    if (orphan) return { id, afterJob: null, job: null };
    let last = 0;
    for (const p of problems) if (failsStandard(p, id)) last = Math.max(last, place.get(p.job) ?? Number.POSITIVE_INFINITY);
    if (!Number.isFinite(last)) return { id, afterJob: null, job: null };
    return { id, afterJob: last, job: last ? jobs[last - 1]!.code : null };
  });
}
