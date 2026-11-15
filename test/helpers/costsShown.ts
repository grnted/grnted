// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The report-truth invariant (scoring v8, review round 1): a WCAG criterion that costs a report points
// is never shown as passing. For every check `scoreReportV8` charges (positive weight and share), its
// criteria (a rule's primary criterion, a test's criterion; the documents check: the criteria the
// failing PDFs fail) must not read "No failures found" in the WCAG results. Used by the gold suite over
// every scan. (A conformance level of "Supports" is exactly a "No failures found" row, so this also covers the
// hosted conformance report; its own check of both is in the hosted report's tests.)
import { reportCriterionChecks } from '../../src/criterionScore.js';
import { buildCriteria, pdfCriteria } from '../../src/report/criteria.js';
import type { SiteReport } from '../../src/types.js';

/** The broken promises, as "<key>: <criterion> <what it says>"; empty when the report is truthful. */
export function costsNotShown(r: SiteReport): string[] {
  if (r.status !== 'scored') return [];
  const bad: string[] = [];
  const rows = new Map((r.criteria ?? buildCriteria(r)).map((c) => [c.criterion, c]));
  for (const c of reportCriterionChecks(r) ?? []) {
    if (!(c.weight > 0 && c.share > 0)) continue;
    const criteria = c.key === 'documents'
      ? [...new Set((r.documentChecks ?? []).filter((d) => d?.type === 'pdf' && d.checks).flatMap((d) => pdfCriteria(d.checks!)))]
      : [c.criterion];
    for (const k of criteria) if (rows.get(k)?.status === 'no_failures_found') bad.push(`${c.key}: ${k} reads no failures found`);
  }
  return bad;
}
