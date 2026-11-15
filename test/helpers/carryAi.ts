// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Stand-ins for the closed AI package's report extension in the engine's own tests. The engine's tests check how the
// engine lists, reads and adds up a review; how a review counts is the AI package's, tested there. Gates: scoring
// v13's, as the engine reads a report from before the move.
import { LEGACY_AI_GATES } from '../../src/aiLegacy.js';
import type { AiIssueSummary, ReportExtension } from '../../src/types.js';

/** Carries a hand-made AI review into the report and scores none of it. */
export const carryAi: ReportExtension = {
  name: 'test: carries the review, scores none of it',
  score: ({ ai }) => ({ ai, ran: false, issues: [], gates: LEGACY_AI_GATES }),
};

/**
 * Carries the review and reports `issues` as what counts: a fixture's hand-made review with the failing checks the AI
 * package scores it to (written out by hand, so the engine's tests never compute an AI score).
 */
export function recordedAi(issues: AiIssueSummary[]): ReportExtension {
  return { name: 'test: a recorded scoring of the review', score: ({ ai }) => ({ ai, ran: true, issues, gates: LEGACY_AI_GATES }) };
}
