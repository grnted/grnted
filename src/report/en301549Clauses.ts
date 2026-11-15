// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// EN 301 549 V4.1.1 (2026-09): the clause numbers and titles of clauses 9 (web content) and 10 (non-web
// documents), one per WCAG 2.2 A and AA criterion (en301549.ts explains the source and rates them). Its own
// module, free of the conformance code, so the repair plan (jobScore.ts) can read the mapping without an
// import cycle. Engine core: no Node-only imports.
import { CRITERIA } from './criteria.js';

/** The standard and the version every EN 301 549 surface names. */
export const EN_STANDARD = 'EN 301 549 V4.1.1 (2026-09)';
export const EN_SHORT = 'EN 301 549 V4.1.1';

export interface EnWebClause {
  /** The WCAG 2.2 success criterion, "1.1.1". */
  criterion: string;
  /** Its EN 301 549 V4.1.1 clause, "9.1.1.1". */
  clause: string;
  /** The clause's title in the standard (British spelling, "Subtitles" for captions). */
  title: string;
}

/** Where a clause 10 title differs from clause 9's (V4.1.1). */
const DOC_TITLE: Readonly<Record<string, string>> = {
  '2.4.2': 'Non-web document titled',
  '3.1.1': 'Language of non-web document',
};
/** Clause 10 is "Void" here: WCAG 2.4.1 and 2.4.5 apply only to sets of non-web documents (V4.1.1 10.2.4.1, 10.2.4.5). */
const DOC_VOID: ReadonlySet<string> = new Set(['2.4.1', '2.4.5']);

/** Where the clause title differs from the WCAG criterion's title as the report writes it. */
const WEB_TITLE: Readonly<Record<string, string>> = {
  '1.2.1': 'Audio-only and video-only (pre-recorded)',
  '1.2.2': 'Subtitles (pre-recorded)',
  '1.2.3': 'Audio description or media alternative (pre-recorded)',
  '1.2.4': 'Subtitles (live)',
  '1.2.5': 'Audio description (pre-recorded)',
  '1.4.1': 'Use of colour',
};

/** The 55 clauses 9.1.1.1 to 9.4.1.3 (voids left out), in the order of the WCAG criteria. */
export const EN_WEB_CLAUSES: readonly EnWebClause[] = CRITERIA.map((c) => ({
  criterion: c.criterion,
  clause: `9.${c.criterion}`,
  title: WEB_TITLE[c.criterion] ?? `${c.title.charAt(0).toUpperCase()}${c.title.slice(1)}`,
}));

export interface EnDocClause {
  clause: string;
  title: string;
  /** The clause is "Void" for non-web documents. */
  void?: true;
}

/** Each criterion's clause 10 (non-web documents). */
export const EN_DOC_CLAUSES: Readonly<Record<string, EnDocClause>> = Object.fromEntries(EN_WEB_CLAUSES.map((w) => [w.criterion,
  DOC_VOID.has(w.criterion) ? { clause: `10.${w.criterion}`, title: 'Void', void: true as const } : { clause: `10.${w.criterion}`, title: DOC_TITLE[w.criterion] ?? w.title }]));

/** The clause 9 entry of a WCAG criterion, or undefined (4.1.1, AAA criteria). */
export function enWebClause(criterion: string): EnWebClause | undefined {
  return EN_WEB_CLAUSES.find((c) => c.criterion === criterion);
}

/** The clause 10 entry of a WCAG criterion, or undefined. */
export function enDocClause(criterion: string): EnDocClause | undefined {
  return EN_DOC_CLAUSES[criterion];
}

