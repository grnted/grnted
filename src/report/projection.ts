// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The projected score (report v3): the real scorer run again over the report's failing checks with
// some removed, never an approximation. Since scoring v8 the scorer itself reads the report
// (src/criterionScore.ts: one combined cost per WCAG criterion), so the projection is the same
// computation. The rebuilt checks must give the report's own score, or there is no projection (an
// older or altered report): a number the scorer would not give is never shown. Engine core: no
// Node-only imports.
import { criterionScore, noBlocker, reportCriterionChecks, V8, withMinor, type CriterionCheck } from '../criterionScore.js';
import { reportDocumentProblems } from '../aiScore.js';
import { countedDocuments, officeDocumentsCount } from '../documents/officeScore.js';
import { GROUP_WEIGHTS, ruleGroupOf } from '../ruleGroups.js';
import { combineChecks, documentOutcome, documentStanding, probeChecksFrom, roundScore } from '../score.js';
import { PROBES } from '../probes/registry.js';
import type { SiteReport } from '../types.js';

/**
 * One failing check, under the key of the problem it is (`Problem.key`: 'rule:<id>', 'criterion:<n>',
 * 'ai:<n>', 'documents'; scoring v8 adds 'third-party:<id>', 'consistency:<n>', 'media:<n>' and
 * 'ai:<check>:<n>'). A key has one entry (criterionScore.ts `withMinor`).
 */
export type ReportCheck = CriterionCheck;

/**
 * The report's failing checks in the scorer's order, or null when the report has no score or the
 * rebuilt checks do not give its score (an older or altered report).
 */
export function reportChecks(report: SiteReport): ReportCheck[] | null {
  if (report.status !== 'scored' || typeof report.score !== 'number' || !Number.isFinite(report.score)) return null;
  const checks = failingChecks(report);
  return checks && scoreOfChecks(report, checks) === report.score ? checks : null;
}

/**
 * A report made before scoring v8 (v1 to v7: every check added in full). The same version set as
 * the report's wording (scope.ts re-exports this), so the report's wording and its projection agree on what an older report
 * scored. Its checks are rebuilt with v7's weights; for v1 to v6 the rebuilt score must still equal
 * the stored one, or there is no projection.
 */
export const scoredBeforeV8 = (report: Pick<SiteReport, 'meta'>) => /^v[1-7]$/.test(report.meta?.scoring ?? '');
const legacy = scoredBeforeV8;
const scoreOfChecks = (report: SiteReport, checks: readonly ReportCheck[]) => roundScore(legacy(report) ? combineChecks(checks) : criterionScore(checks));

/** v7's core tests (the ones it scored): core, not link-purpose or aria-states. */
const V7_SCORED: ReadonlySet<string> = new Set(PROBES.filter((p) => p.tier === 'core' && p.id !== 'link-purpose' && p.id !== 'aria-states').map((p) => p.id));
const V7_AI: Readonly<Record<string, number>> = { '1.1.1': 4.5, '1.4.5': 2 };

/** The failing checks as scoring v1 to v7 built them (v7's weights), so a stored older report still projects. */
function legacyChecks(report: SiteReport): ReportCheck[] | null {
  const okUrls = new Set((report.pages ?? []).filter((p) => p.status === 'ok').map((p) => p.url));
  if (!okUrls.size) return null;
  const byKey = (a: ReportCheck, b: ReportCheck) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const rules: ReportCheck[] = (report.rules ?? []).map((r) => {
    const w = GROUP_WEIGHTS[ruleGroupOf(r.id)];
    return { key: `rule:${r.id}`, criterion: `rule:${r.id}`, weight: r.impact === 'moderate' || r.impact === 'minor' ? w / 2 : w, share: new Set(r.pagesAffected.filter((u) => okUrls.has(u))).size / okUrls.size };
  });
  const tested = new Map<string, number>();
  for (const [url, checks] of probeChecksFrom(report.probes?.runs ?? [], (id) => V7_SCORED.has(id))) {
    if (!okUrls.has(url)) continue;
    for (const [criterion, outcome] of Object.entries(checks)) if (outcome !== 'untested') tested.set(criterion, (tested.get(criterion) ?? 0) + 1);
  }
  const criteria: ReportCheck[] = [];
  for (const t of report.testIssues ?? []) {
    const n = tested.get(t.criterion);
    if (!n) return null;
    criteria.push({ key: `criterion:${t.criterion}`, criterion: t.criterion, weight: 4, share: new Set(t.pagesAffected.filter((u) => okUrls.has(u))).size / n });
  }
  const ai: ReportCheck[] = [];
  for (const i of report.aiChecks?.ran ? report.aiChecks.issues : []) {
    if ((i.check ?? 'altText') !== 'altText' || !V7_AI[i.criterion] || !i.pagesAffected.length || !(i.pagesTested > 0)) continue;
    ai.push({ key: `ai:${i.criterion}`, criterion: i.criterion, weight: V7_AI[i.criterion]!, share: Math.min(1, i.pagesAffected.length / i.pagesTested) });
  }
  const docs: ReportCheck[] = [];
  if (report.documentScore?.scored === true) {
    const d = documentOutcome(report.documentChecks);
    if (d.checked > 0 && d.failed > 0) docs.push({ key: 'documents', criterion: 'documents', weight: 4, share: Math.min(1, d.failed / d.checked) });
  }
  return [...rules.sort(byKey), ...criteria.sort(byKey), ...ai.sort(byKey), ...docs];
}

/**
 * The failing checks as the report describes them (scoring v8, src/criterionScore.ts), null when no
 * page loaded. `reportChecks` is these, when they give the score.
 */
export function failingChecks(report: SiteReport): ReportCheck[] | null {
  return legacy(report) ? legacyChecks(report) : reportCriterionChecks(report);
}

/** Whether the report scored its documents (scoring v7) and they cost points. */
export function documentsScored(report: SiteReport): boolean {
  return report.documentScore?.scored === true && report.documentScore.failed > 0;
}

/**
 * The checks left with the problems under `gone` fixed. Scoring v10: the PDFs ('documents') and the Office
 * files ('office') share one documents check, so fixing one kind leaves the check with the other kind's
 * failures (`documentsCheckFixed`); fixing both, or a report that counts no Office file,
 * removes it as before.
 */
function checksLeft(report: SiteReport, checks: readonly ReportCheck[], gone: ReadonlySet<string>): ReportCheck[] {
  const pdf = gone.has('documents');
  const office = gone.has('office');
  const left = checks.filter((c) => !gone.has(c.key));
  // Neither or both kinds fixed, an older report, or no documents check: removing by key is the answer
  // ('office' is never a check's key, so on its own it removes nothing there).
  if (pdf === office || legacy(report) || !officeDocumentsCount(report.meta?.scoring) || !checks.some((c) => c.key === 'documents')) return left;
  const rest = documentsCheckFixed(report, pdf ? 'pdf' : 'office');
  return [...left.filter((c) => c.key !== 'documents'), ...(rest ? [rest] : [])];
}

/**
 * The documents check (criterionScore.ts: every document's `documentStanding`, one share) with one kind's
 * failures fixed: the PDFs ('pdf') or the Office files ('office'). Fixed documents still count as checked.
 */
function documentsCheckFixed(report: SiteReport, fixed: 'pdf' | 'office'): ReportCheck | null {
  if (report.documentScore?.scored === false) return null;
  const confirmed = reportDocumentProblems(report);
  let checked = 0;
  let failed = 0;
  let minor = 0;
  for (const d of countedDocuments(report) ?? []) {
    const standing = documentStanding(d, confirmed);
    if (standing === 'not_counted') continue;
    checked++;
    if (standing === 'clean' || (d.type === 'pdf' ? 'pdf' : 'office') === fixed) continue;
    failed++;
    if (standing === 'minor') minor++;
  }
  if (!(checked > 0) || !(failed > 0)) return null;
  return withMinor('documents', 'documents', V8.documents, V8.minor, failed - minor, minor, checked);
}

/**
 * The report scored again by the real scorer (its failing checks and their score), for a report whose raw
 * results were changed (jobScore.ts takes repaired problems out of them); null when no page loaded. The
 * same computation as the report's own score: `reportChecks` is this, when it gives the stored score.
 */
export function rescore(report: SiteReport): { score: number; checks: ReportCheck[]; legacy: boolean } | null {
  const checks = failingChecks(report);
  return checks ? { score: scoreOfChecks(report, checks), checks, legacy: legacy(report) } : null;
}

/** The score with the checks under `remove` (problem keys) fixed, from the real scorer; null when there is no projection. */
export function projectScore(report: SiteReport, remove: Iterable<string>): number | null {
  const checks = reportChecks(report);
  if (!checks) return null;
  return scoreOfChecks(report, checksLeft(report, checks, new Set(remove)));
}

/**
 * Whether the site would be Access Granted with the checks under `remove` fixed (scoring v8): the
 * projected score is 90 or more AND no non-interference failure is left. Null when there is no
 * projection. A report made before v8 has no such rule: only its score decides.
 */
export function projectGranted(report: SiteReport, remove: Iterable<string>): boolean | null {
  const checks = reportChecks(report);
  if (!checks) return null;
  const left = checksLeft(report, checks, new Set(remove));
  const score = scoreOfChecks(report, left);
  return score >= 90 && (legacy(report) || noBlocker(left));
}
