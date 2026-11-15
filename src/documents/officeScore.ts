// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Scoring v10: Word, Excel and PowerPoint files in the documents check (docs/scoring.md, Documents). The rule
// for each file is `documentStanding` (src/score.ts): one of the five problem findings fails it, a title-only
// one is a minor failure, hints never count. This file holds the version gate (a report scored before v10
// never counts its Office files) and the Office files' own counts. Engine core: no Node-only imports.
import { documentStanding, type DocumentOutcome } from '../score.js';
import type { DocumentCheck, SiteReport } from '../types.js';

/** Whether a report scored with `scoring` counts Office files (v10 and later). */
export function officeDocumentsCount(scoring: string | undefined): boolean {
  const m = /^v(\d+)(?:\.\d+){0,2}$/.exec(scoring ?? '');
  return !!m && Number(m[1]) >= 10;
}

/**
 * The documents the report's documents check counts: all of them from scoring v10, the PDFs alone before
 * (an Office file in a v9 report was evidence only, so rescoring it never adds Office points).
 */
export function countedDocuments(report: Pick<SiteReport, 'documentChecks' | 'meta'>): DocumentCheck[] | undefined {
  const all = report.documentChecks;
  if (!all || officeDocumentsCount(report.meta?.scoring)) return all;
  return all.filter((d) => d?.type === 'pdf');
}

/**
 * The Office files' part of the documents check, by `documentStanding`: files counted, failing, and of
 * those, failing on their title alone. The inventory has one entry per address, so a file linked from
 * many pages counts once; a file not read (the cap, a legacy format, an error) does not count.
 */
export function officeOutcome(checks: readonly DocumentCheck[] | undefined): DocumentOutcome {
  const out: DocumentOutcome = { checked: 0, failed: 0, minor: 0 };
  for (const d of checks ?? []) {
    if (!d || d.type === 'pdf') continue;
    const s = documentStanding(d);
    if (s === 'not_counted') continue;
    out.checked++;
    if (s === 'clean') continue;
    out.failed++;
    if (s === 'minor') out.minor++;
  }
  return out;
}
