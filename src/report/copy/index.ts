// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The report v2 copy library (spec §4): reviewed, versioned wording for every problem the report can
// show. Lookups never return undefined: an id the library doesn't know (a newer axe rule, a probe
// added outside the registry) gets safe generic copy. The version is COPY_VERSION in src/version.ts.
import type { ProblemCopy } from '../model.js';
import { AI_CHECK_COPY, AI_COPY } from './ai.js';
import { CRITERION_COPY, GENERIC_CRITERION_COPY, KIND_CRITERION_COPY, PROBE_CRITERION_COPY } from './criteria.js';
import { DOCUMENTS_COPY, OFFICE_COPY } from './documents.js';
import { GENERIC_RULE_COPY, RULE_COPY } from './rules.js';

export { AI_CHECK_COPY, AI_COPY, DOCUMENTS_COPY, GENERIC_CRITERION_COPY, GENERIC_RULE_COPY, OFFICE_COPY };

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** The axe rules and criteria the library has copy for. */
export const COPY_RULE_IDS: readonly string[] = Object.freeze(Object.keys(RULE_COPY));
export const COPY_CRITERIA: readonly string[] = Object.freeze(Object.keys(CRITERION_COPY));
/** The `<probe>:<criterion>` pairs with their own copy. */
export const COPY_PROBE_CRITERIA: readonly string[] = Object.freeze(Object.keys(PROBE_CRITERION_COPY));

/** Copy for an axe rule; generic copy for a rule the library doesn't know. */
export function copyForRule(id: string): ProblemCopy {
  return own(RULE_COPY, id) ? RULE_COPY[id]! : GENERIC_RULE_COPY;
}

/** Copy for a criterion a probe failed; generic copy for one the library doesn't know. */
export function copyForCriterion(criterion: string): ProblemCopy {
  return own(CRITERION_COPY, criterion) ? CRITERION_COPY[criterion]! : GENERIC_CRITERION_COPY;
}

/** Copy for a criterion as `probe` finds it, when the library has it (`PROBE_CRITERION_COPY`); otherwise the criterion's copy. */
export function copyForProbeCriterion(probe: string, criterion: string): ProblemCopy {
  const key = `${probe}:${criterion}`;
  return own(PROBE_CRITERION_COPY, key) ? PROBE_CRITERION_COPY[key]! : copyForCriterion(criterion);
}

/** The `<criterion>:<kind>` pairs with their own copy (batch 19). */
export const COPY_KIND_CRITERIA: readonly string[] = Object.freeze(Object.keys(KIND_CRITERION_COPY));

/** Copy for a criterion whose failures are all of one kind of evidence; the criterion's copy otherwise. */
export function copyForKindCriterion(criterion: string, kind: string): ProblemCopy {
  const key = `${criterion}:${kind}`;
  return own(KIND_CRITERION_COPY, key) ? KIND_CRITERION_COPY[key]! : copyForCriterion(criterion);
}

/** Copy for a gated AI check's criterion (scoring v9, `AI_CHECK_COPY`); the criterion's copy when it has none. */
export function copyForAiCheck(check: string, criterion: string): ProblemCopy {
  const key = `${check}:${criterion}`;
  return own(AI_CHECK_COPY, key) ? AI_CHECK_COPY[key]! : copyForCriterion(criterion);
}
