// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The scoring formula's pure core (scoring v5, docs/scoring.md): rule weights, the diminishing-returns
// total over failing checks and rounding. It imports only the rule groups, so the web app can bundle it
// for the live screen's "score so far" without the rest of the engine (src/score.ts re-exports all of
// it). Engine core: no Node-only imports.
import { RULE_CRITERION } from './ruleCriteria.js';
import { GROUP_WEIGHTS, ruleGroupOf } from './ruleGroups.js';
import type { Impact } from './types.js';

/**
 * Scoring v8: per-rule multipliers on the group weight, where the gold standard's declared severity
 * order needs a rule to weigh more or less than its group (docs/scoring.md, "Scoring v8").
 */
export const RULE_WEIGHT_FACTORS: Readonly<Record<string, number>> = Object.freeze({
  // Blockers in the gold standard (an informative image with no text alternative, an unnamed button).
  'image-alt': 1.7, 'button-name': 2.15,
  // Serious: a scrolling box keyboard users cannot reach; zoom blocked.
  'scrollable-region-focusable': 2.3, 'meta-viewport': 1.5,
  // Moderate: structure and language markup that reaches people through assistive technology.
  'td-has-header': 1.3, 'html-lang-valid': 1.3, 'css-orientation-lock': 0.9, 'frame-title': 0.95,
  // Lighter than their group: label in name, small targets, autofill tokens.
  'label-content-name-mismatch': 0.4, 'target-size': 0.7, 'autocomplete-valid': 0.3,
});

/** An axe rule's weight: its group's weight, halved for moderate or minor impact, times its v8 factor. */
export function ruleWeight(id: string, impact: Impact): number {
  const w = GROUP_WEIGHTS[ruleGroupOf(id)];
  const f = Object.prototype.hasOwnProperty.call(RULE_WEIGHT_FACTORS, id) ? RULE_WEIGHT_FACTORS[id]! : 1;
  return (impact === 'moderate' || impact === 'minor' ? w / 2 : w) * f;
}

/** Scoring v8: an axe rule's criterion (its first WCAG criterion); a rule with none is its own. */
export function ruleCriterion(id: string): string {
  return Object.prototype.hasOwnProperty.call(RULE_CRITERION, id) ? RULE_CRITERION[id]! : `rule:${id}`;
}

/**
 * Scoring v8: within one criterion the worst failing check costs in full and each further one this
 * share of its own cost (one combined result per criterion; 0 would count only the worst). Calibrated:
 * 0, 0.25, 0.5, 0.75 and 1 all satisfy the gold standard; the panel agrees best at 1 (docs/scoring.md).
 */
export const IN_CRITERION = 1;

/** Scoring v8: a third-party frame's failure weighs this share of the same failure on the site's own page. */
export const THIRD_PARTY_FACTOR = 0.75;
/** Scoring v8: the cross-page rules' weights, per criterion (a criterion not listed is not scored). */
export const CONSISTENCY_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({ '2.4.5': 4, '3.2.3': 4, '3.2.4': 3.75, '3.2.6': 3.75 });
/**
 * Scoring v8: the media rules' weights, per criterion (only "problem" findings count). 1.4.2 is the
 * criterion's one weight, the same for the listening test (PROBE_WEIGHT_OVERRIDES): since review
 * round 2 its share is the union of every method's failing pages over the pages any method judged
 * (ONE_VERDICT_CRITERIA), and 14 is the smallest whole weight that keeps the gold standard's declared
 * severity order and verdicts (5.25 when it was added to the test's cost, 9 in review round 1).
 */
export const MEDIA_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({ '1.2.2': 5, '1.4.2': 14 });
/**
 * Scoring v8 (Paul, 2026-11-04): the WCAG non-interference criteria, the four that conformance
 * requirement 5 names (they must be met on every page, whatever else the page does). A scored failure
 * of one of them on any page blocks Access Granted, whatever the score (criterionScore.ts
 * `accessBlockers`); the score itself is unchanged.
 */
export const NON_INTERFERENCE_CRITERIA: readonly string[] = Object.freeze(['1.4.2', '2.1.2', '2.2.2', '2.3.1']);
/** Scoring v8: a minor failure's share of the weight. */
export const MINOR_FACTOR = 0.25;
/**
 * Scoring v8 (review rounds 1 and 2): the media criteria (1.2.2, 1.4.2) have one verdict per page. The
 * audio test, the media rules and axe describe the same failure, so a criterion's failing pages by ANY
 * of them join one share over the pages any of them judged, at one weight (the costliest of the
 * failing methods): w × √(|∪ failing pages| ÷ |∪ judged pages|), never the methods added up
 * (criterionTotal). A page a scored test cleared costs nothing for them (criterionScore.ts).
 */
export const ONE_VERDICT_CRITERIA: ReadonlySet<string> = new Set(Object.keys(MEDIA_WEIGHTS));
/** One failing check under its criterion (scoring v8). */
export interface CriterionCost {
  criterion: string;
  weight: number;
  share: number;
  /**
   * `ONE_VERDICT_CRITERIA` only: the pages this check fails on and the size of the criterion's
   * denominator (pages any of its methods judged): the criterion's share is the union of its checks'
   * pages over it.
   */
  pages?: readonly string[];
  of?: number;
}

/**
 * Σ over criteria of (the largest w × √share + inCriterion × the others; the largest alone for
 * `ONE_VERDICT_CRITERIA`), criteria in a fixed order. A
 * share is clamped to 0..1; a weight or share that is not a finite number, and a negative weight, count
 * as 0.
 */
export function criterionTotal(checks: readonly CriterionCost[], inCriterion = IN_CRITERION): number {
  const groups = new Map<string, number[]>();
  // One-verdict criteria whose checks all carry their pages: the costliest weight over the union share.
  const unions = new Map<string, { w: number; pages: Set<string>; of: number }>();
  for (const c of checks) {
    if (!ONE_VERDICT_CRITERIA.has(c.criterion) || !Array.isArray(c.pages) || !(Number(c.of) > 0)) continue;
    const w = Number.isFinite(c.weight) ? Math.max(0, c.weight) : 0;
    if (!(w > 0) || !c.pages.length) continue;
    const u = unions.get(c.criterion) ?? { w: 0, pages: new Set<string>(), of: 0 };
    u.w = Math.max(u.w, w);
    u.of = Math.max(u.of, Number(c.of));
    for (const pg of c.pages) u.pages.add(pg);
    unions.set(c.criterion, u);
  }
  for (const [criterion, u] of unions) groups.set(criterion, [u.w * Math.sqrt(Math.min(1, u.pages.size / u.of))]);
  for (const c of checks) {
    if (unions.has(c.criterion)) continue;
    const s = Number.isFinite(c.share) ? Math.min(1, Math.max(0, c.share)) : 0;
    const w = Number.isFinite(c.weight) ? Math.max(0, c.weight) : 0;
    const cost = w * Math.sqrt(s);
    if (cost <= 0) continue;
    const g = groups.get(c.criterion);
    if (g) g.push(cost);
    else groups.set(c.criterion, [cost]);
  }
  let total = 0;
  for (const criterion of [...groups.keys()].sort()) {
    const costs = groups.get(criterion)!.sort((a, b) => b - a);
    let rest = 0;
    for (let i = 1; i < costs.length; i++) rest += costs[i]!;
    total += costs[0]! + (ONE_VERDICT_CRITERIA.has(criterion) ? 0 : inCriterion) * rest;
  }
  return total;
}

/** The unrounded score (scoring v8) from criterion-grouped failing checks, clamped to 0..100. */
export function combineCriteria(checks: readonly CriterionCost[], inCriterion = IN_CRITERION): number {
  const value = 100 - FORMULA_SCALE * Math.log1p(criterionTotal(checks, inCriterion) / FORMULA_KNEE);
  return Math.min(100, Math.max(0, value));
}

/** One failing check: its weight and the share of pages it failed on (0..1). */
export interface WeightedCheck {
  weight: number;
  share: number;
}

/**
 * Scoring v5's scale: points lost per unit of ln(1 + total ÷ FORMULA_KNEE). Fitted on the calibration
 * panel (docs/scoring.md, "Calibration") with FORMULA_KNEE.
 */
export const FORMULA_SCALE = 18;

/**
 * Scoring v5's knee: the total (Σ weight × √share) at which the cost per further point of total has
 * halved. Below it, problems cost close to their weight; above it, each further problem costs less.
 */
export const FORMULA_KNEE = 10;

/**
 * Σ weight × √share over the failing checks. A share is clamped to 0..1; a weight or share that is not
 * a finite number, and a negative weight, count as 0, so a bad input never costs or gives back points.
 */
export function checksTotal(checks: readonly WeightedCheck[]): number {
  let total = 0;
  for (const { weight, share } of checks) {
    const s = Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0;
    const w = Number.isFinite(weight) ? Math.max(0, weight) : 0;
    total += w * Math.sqrt(s);
  }
  return total;
}

/**
 * The score from the failing checks, unrounded: 100 − FORMULA_SCALE × ln(1 + total ÷ FORMULA_KNEE),
 * clamped to 0..100 (`checksTotal` for the total). Diminishing returns: each further problem costs fewer
 * points than the one before. 100 with no failing check.
 */
export function combineChecks(checks: readonly WeightedCheck[]): number {
  const value = 100 - FORMULA_SCALE * Math.log1p(checksTotal(checks) / FORMULA_KNEE);
  return Math.min(100, Math.max(0, value));
}

/**
 * Rounded to a whole number, halves up, clamped to 0..100. The tiny tolerance keeps a value that is
 * exactly a half in exact arithmetic (89.5) from rounding down because of floating-point error.
 */
export function roundScore(value: number): number {
  return Math.min(100, Math.max(0, Math.floor(value + 0.5 + 1e-9)));
}

/** A loaded page's failing axe rules, as a page-done event carries them (id and the scoring table's impact). */
export interface AxePageResult {
  rules: readonly { id: string; impact: Impact }[];
}

/**
 * The site score (scoring v8: rules grouped by criterion) from axe results alone, over the loaded pages given: each rule that failed
 * on at least one of them is a failing check with share = pages it failed on ÷ pages given. For the same
 * pages it equals `scoreSite`'s score when no core test or AI check failed (the live screen's "score so far"; the
 * report's score adds the core tests and the completeness rules). Null with no pages. Rounded.
 */
export function axeSiteScore(pages: readonly AxePageResult[]): number | null {
  if (!pages.length) return null;
  const fails = new Map<string, { impact: Impact; pages: number }>();
  for (const p of pages) {
    const seen = new Set<string>();
    for (const r of p.rules) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const f = fails.get(r.id);
      if (f) f.pages++;
      else fails.set(r.id, { impact: r.impact, pages: 1 });
    }
  }
  const checks = [...fails].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, f]): CriterionCost => ({ criterion: ruleCriterion(id), weight: ruleWeight(id, f.impact), share: f.pages / pages.length }));
  return roundScore(combineCriteria(checks));
}
