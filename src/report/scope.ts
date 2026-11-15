// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// What counts toward the score, in plain words, derived from the scoring data and the report's own
// scoring version (a report made before v8 keeps what was true when it was scored). Results only:
// what is scored, never how much (public what, private how). Engine core: no Node-only imports.
import { aiGates } from '../aiLegacy.js';
import { scoredBeforeV8 } from './projection.js';
import { countsTowardScore } from './scoreScope.js';
import type { AiCheckId, SiteReport } from '../types.js';

export interface ScoringScope {
  /** Failures inside frames from other sites count. */
  thirdParty: boolean;
  /** The video and audio rules' problems count. */
  media: boolean;
  /** The cross-page rules count. */
  crossPage: boolean;
  /** The deep tests count when they ran. */
  deepTests: boolean;
  /** The AI checks whose double-checked findings count. */
  aiChecks: AiCheckId[];
}

/** A report scored before v8 (v1 to v7): one definition, the projection's. */
export { scoredBeforeV8 };

export function scoringScope(report: Pick<SiteReport, 'meta' | 'aiChecks'>): ScoringScope {
  // The kinds of failure: the report's own scorer's answer (scoreScope.ts asks it with a sample).
  return {
    thirdParty: countsTowardScore(report, 'third-party'),
    media: countsTowardScore(report, 'media'),
    crossPage: countsTowardScore(report, 'consistency'),
    deepTests: countsTowardScore(report, 'deep'),
    // The gated AI checks the report carries (stamped by the package that scored its review), else its version's.
    aiChecks: Object.keys(aiGates(report)) as AiCheckId[],
  };
}

export { AI_CHECK_NAMES, aiScoredWords, listWords } from '../aiScore.js';
