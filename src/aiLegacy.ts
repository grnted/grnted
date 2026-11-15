// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// How a report made before the AI engine left the open engine (scoring up to v13, 2026-11-13) counts its AI
// review: frozen, never edited. Since then the closed AI package (the hosted, paid Granted) scores a review through
// its `ReportExtension` and stamps what counts into the report itself: each failing AI check's `weight` and the gated
// checks with their criteria (`aiChecks.gates`). A report made before carries neither, so these tables (the ones
// docs/scoring.md published for those versions) read it exactly as it was scored. They score nothing new: buildReport
// never scores an AI review without the package's report extension. Engine core: no Node-only imports.
import type { AiCheckId, SiteReport } from './types.js';

/** Gated checks and the criteria each may score, per check (scoring v10 to v13; v8 and v9 take a subset of checks). */
export type AiGates = Readonly<Partial<Record<AiCheckId, readonly string[]>>>;
/** Weight per gated check and criterion. */
export type AiWeights = Readonly<Partial<Record<AiCheckId, Readonly<Record<string, number>>>>>;

/** The gate table of scoring v13 (and of v10 to v13 as their reports are read). */
export const LEGACY_AI_GATES: AiGates = Object.freeze({
  altText: Object.freeze(['1.1.1', '1.4.5']),
  vision: Object.freeze(['1.4.1', '1.3.2', '1.1.1', '4.1.2']),
  forms: Object.freeze(['3.3.4', '1.3.5', '3.3.3']),
  pageText: Object.freeze(['2.4.2', '2.4.4', '2.4.6', '3.3.2', '1.3.3', '3.1.2', '1.3.1']),
  consistency: Object.freeze(['3.2.4']),
  media: Object.freeze(['1.2.1', '1.2.2', '1.2.3']),
  focusOrder: Object.freeze(['2.4.3']),
  listener: Object.freeze(['1.3.2', '1.1.1', '1.3.1', '4.1.2', '2.4.4', '2.4.6', '4.1.3']),
  document: Object.freeze(['1.1.1', '1.3.1', '1.3.2', '1.4.5', '3.3.2']),
});

/** The checks gated in scoring v8. */
export const LEGACY_AI_GATED_V8: readonly AiCheckId[] = Object.freeze(['altText', 'vision', 'forms']);
/** The checks gated in scoring v9. */
export const LEGACY_AI_GATED_V9: readonly AiCheckId[] = Object.freeze(['altText', 'vision', 'forms', 'pageText', 'consistency', 'media', 'focusOrder', 'listener']);

/** The weights of scoring v5 to v13 (v5 to v7: altText only). The document check counts through the documents check. */
export const LEGACY_AI_WEIGHTS: AiWeights = Object.freeze({
  altText: Object.freeze({ '1.1.1': 4.5, '1.4.5': 2 }),
  vision: Object.freeze({ '1.4.1': 4.5, '1.3.2': 2, '1.1.1': 4.5, '4.1.2': 3.5 }),
  forms: Object.freeze({ '3.3.4': 2, '1.3.5': 2, '3.3.3': 2 }),
  pageText: Object.freeze({ '2.4.2': 3.5, '2.4.4': 3.5, '2.4.6': 2, '3.3.2': 2.375, '1.3.3': 2, '3.1.2': 1.5, '1.3.1': 1.5 }),
  consistency: Object.freeze({ '3.2.4': 1.875 }),
  media: Object.freeze({ '1.2.1': 2, '1.2.2': 4.5, '1.2.3': 2 }),
  focusOrder: Object.freeze({ '2.4.3': 2 }),
  listener: Object.freeze({ '1.3.2': 2, '1.1.1': 4.5, '1.3.1': 1.5, '4.1.2': 3.5, '2.4.4': 3.5, '2.4.6': 2, '4.1.3': 2 }),
});

const pick = (ids: readonly AiCheckId[]): AiGates => Object.freeze(Object.fromEntries(ids.map((id) => [id, LEGACY_AI_GATES[id]!])));

/**
 * The AI checks whose confirmed answers count in this report, with the criteria each may score: what the report
 * carries (`aiChecks.gates`, stamped by the package that scored it), else what its scoring version counted.
 */
export function aiGates(report: Pick<SiteReport, 'aiChecks' | 'meta'>): AiGates {
  const stamped = report.aiChecks?.gates;
  if (stamped) return stamped;
  const scoring = report.meta?.scoring ?? '';
  if (/^v[1-7]$/.test(scoring)) return pick(['altText']);
  if (scoring === 'v8') return pick(LEGACY_AI_GATED_V8);
  if (scoring === 'v9') return pick(LEGACY_AI_GATED_V9);
  return LEGACY_AI_GATES;
}
