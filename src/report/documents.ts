// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The documents' results as the engine reports them: the document rows, each one's problems, the counts and
// the terminal line. Documents are listed and quickly checked; since scoring v7 the checked PDFs with problems
// are one scored check (unless the scan turned it off). Word, Excel and PowerPoint files are scored with the PDFs
// in the documents check since v10 (their problems; never their hints). The visual report's Documents section
// is not part of the engine.
import { typeFromFileName } from '../documents/detect.js';
import { reportDocumentProblems } from '../aiScore.js';
import { officeFindings } from '../documents/office.js';
import { officeDocumentsCount } from '../documents/officeScore.js';
import { pdfProblems } from '../documents/pdf.js';
import type { DocumentCheck, DocumentType, SiteReport } from '../types.js';

/** Document checks for a report, rebuilt from the plain URL list for reports made without them. */
export function documentRows(report: SiteReport): DocumentCheck[] {
  return report.documentChecks ?? report.documents.map((url) => ({
    url, type: safeType(url), detectedBy: 'extension' as const, linkedFrom: [],
  }));
}

function safeType(url: string): DocumentType {
  try {
    return typeFromFileName(new URL(url).pathname) ?? 'other';
  } catch {
    return 'other';
  }
}

/**
 * Plain-language problems for one document (a PDF that needs a password counts as blocking assistive technology),
 * then (scoring v10, `report` given) the problems the AI document review confirmed in a checked PDF.
 */
export function documentProblems(d: DocumentCheck, report?: Pick<SiteReport, 'ai' | 'meta'>): string[] {
  if (!d.checks) return [];
  const ai = report ? reportDocumentProblems(report).get(d.url) : undefined;
  return [...pdfProblems(d.checks), ...(ai?.labels ?? []).map((l) => `${l} (AI review)`)];
}

/**
 * Documents found; PDFs checked and with problems; Office files checked and with problems (never
 * scored); originals with a version labelled accessible.
 */
export function documentCounts(report: SiteReport): { found: number; checked: number; withProblems: number; withAlternative: number; officeChecked: number; officeWithProblems: number } {
  const rows = documentRows(report);
  const office = rows.filter((d) => d.officeChecks);
  return {
    found: report.documents.length,
    checked: rows.filter((d) => d.checks).length,
    withProblems: rows.filter((d) => documentProblems(d, report).length > 0).length,
    withAlternative: rows.filter((d) => d.accessibleAlternative).length,
    officeChecked: office.length,
    officeWithProblems: office.filter((d) => officeFindings(d.officeChecks!).some((f) => f.level === 'problem')).length,
  };
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** "N documents found (M checked, K with problems)", and the Office files apart when there are any. */
export function documentsLine(report: SiteReport): string {
  const c = documentCounts(report);
  const found = `${num(c.found)} document${c.found === 1 ? '' : 's'} found`;
  if (!c.officeChecked) return `${found} (${num(c.checked)} checked, ${num(c.withProblems)} with problems)`;
  return `${found} (${count(c.checked, 'PDF')} checked, ${num(c.withProblems)} with problems; ${count(c.officeChecked, 'Office file')} checked, ${officeCounted(report) ? `${num(c.officeWithProblems)} with problems` : 'not in the score'})`;
}

/** A count as people write it: 3,500. */
const num = (n: number) => n.toLocaleString('en-US');

/** Whether the report's score counts the Office files it checked (scoring v10 and later, documents scored). */
export function officeCounted(report: Pick<SiteReport, 'meta' | 'documentScore'>): boolean {
  return report.documentScore?.scored === true && officeDocumentsCount(report.meta?.scoring);
}
