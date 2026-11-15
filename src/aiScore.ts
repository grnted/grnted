// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// What a report says about its AI review, read from the report: whether it ran, the confirmed PDF problems the
// documents check counts, and the plain words for the checks that count. Reading only: which AI answers count and
// how much is decided by the closed AI package that scored the review (its `ReportExtension`; a report made before
// the AI engine left the open engine reads with its scoring version's tables, src/aiLegacy.ts). Engine core: no
// Node-only imports.
import type { AiCheckId, AiReport, SiteReport } from './types.js';

/** Shown with the score when the AI image checks could not count (no key, an error, out of time). */
export const AI_NOT_RUN_NOTE = 'AI checks not run: automated-only score';

/**
 * The "AI checks not run" note, only when the AI review did not run (no review, or no item answered).
 * An AI review that ran gives none, even when nothing it found counts toward the score (its checks are
 * listed, not scored, or the scored ones had nothing to judge): `aiChecks.ran` says what is scored,
 * this says what ran.
 */
export function aiNotRunNote(report: Pick<SiteReport, 'ai' | 'aiChecks'>): string | undefined {
  if (!report.aiChecks || report.aiChecks.ran) return undefined;
  if (report.ai?.runs.some((r) => r.reviewed > 0)) return undefined;
  return report.aiChecks.note ?? AI_NOT_RUN_NOTE;
}

/** Scoring v10: a report scored with it (or later) counts confirmed AI document problems in the documents check. */
export function aiDocumentsCount(scoring: string | undefined): boolean {
  const m = /^v(\d+)(?:\.\d+){0,2}$/.exec(scoring ?? '');
  return !!m && Number(m[1]) >= 10;
}

/**
 * Scoring v10: the PDFs the AI document review found a confirmed problem in (both runs agreeing, high
 * confidence; the check marks it `scored`), by address, with each problem's label. Plumbing only.
 */
export function confirmedDocumentProblems(ai: AiReport | undefined): Map<string, { labels: string[]; criteria: string[] }> {
  const out = new Map<string, { labels: string[]; criteria: string[] }>();
  for (const run of ai?.runs ?? []) {
    if (!run || run.check !== 'document' || !Array.isArray(run.findings)) continue;
    for (const f of run.findings) {
      if (!f || f.check !== 'document' || f.source !== 'ai' || f.scored !== true || typeof f.page !== 'string') continue;
      const e = out.get(f.page) ?? { labels: [], criteria: [] };
      if (!e.labels.includes(f.label)) e.labels.push(f.label);
      // A finding filed under several criteria counts under the first (as everywhere else).
      const c = String(f.criterion).split(',')[0]!.trim();
      if (c && !e.criteria.includes(c)) e.criteria.push(c);
      out.set(f.page, e);
    }
  }
  return out;
}

/** The confirmed AI document problems a report's documents check counts (scoring v10 and later), by PDF address. */
export function reportDocumentProblems(report: Pick<SiteReport, 'ai' | 'meta'>): Map<string, { labels: string[]; criteria: string[] }> {
  return aiDocumentsCount(report.meta?.scoring) ? confirmedDocumentProblems(report.ai) : new Map();
}

/**
 * Plain names of the AI checks reports name, for "what counts" sentences: the checks the AI engine had when it left the
 * open engine (a check the closed package added since reads as "another AI review").
 */
export const AI_CHECK_NAMES: Readonly<Record<AiCheckId, string>> = Object.freeze({
  altText: 'the image review (information shown only in a picture, pictures of text)',
  vision: 'the visual review (color, reading order, icons)',
  forms: 'the form review',
  pageText: 'the page text review',
  consistency: 'the names-across-pages review',
  document: 'the PDF review',
  media: 'the media review',
  focusOrder: 'the focus order review',
  listener: 'the screen reader review',
});

/** "a, b and c". */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The sentence about the AI checks that count (scoring v5: the image review; v8: every gated check). */
export function aiScoredWords(scope: { aiChecks: readonly AiCheckId[] }): string {
  const names = [...new Set(scope.aiChecks.map((c) => AI_CHECK_NAMES[c] ?? 'another AI review'))];
  return `Findings from ${listWords(names)} count toward the score, only after they are double-checked; the AI review's other findings are labeled AI-flagged, and those findings never change the score.`;
}
