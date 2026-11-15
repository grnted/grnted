// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The lab's statistics: the confusion matrix per test and criterion, and Wilson lower bounds. Pure.
import type { CaseResult } from './types.js';

/**
 * One-sided 95% confidence (z = 1.645): "at least p with 95% confidence". With no errors it needs 52
 * cases to clear 0.95 (the exact binomial bound needs 59: 0.95^59 < 0.05); the scorecard shows both.
 */
export const Z_ONE_SIDED_95 = 1.6448536269514722;

/** Wilson score interval, lower end, for `k` successes in `n` trials. 0 when n is 0. */
export function wilsonLower(k: number, n: number, z: number = Z_ONE_SIDED_95): number {
  if (n <= 0) return 0;
  const p = k / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

/** Exact (Clopper-Pearson) one-sided lower bound with no errors: (0.05)^(1/n). */
export function exactLowerNoErrors(n: number, alpha = 0.05): number {
  return n > 0 ? Math.pow(alpha, 1 / n) : 0;
}

export interface Confusion {
  test: string;
  criterion: string;
  cases: number;
  tp: number;
  fp: number;
  tn: number;
  /** Missed failures (the engine said pass or not applicable). */
  fn: number;
  /** Cases the engine could not decide (not testable, timed out, errored): on a failing page they count as missed. */
  undecidedPos: number;
  undecidedNeg: number;
  /** Not applicable expected and found (or not). */
  naRight: number;
  naWrong: number;
  precision: number;
  recall: number;
  precisionLower: number;
  recallLower: number;
  meets95: boolean;
}

const UNDECIDED = new Set(['not_testable', 'timeout', 'error']);

/**
 * Positive = the auditor's 'fail'. A case expected 'pass' or 'na' that the engine fails is a false
 * positive; an expected failure the engine passes, finds not applicable or cannot decide is a false
 * negative (an undecided page tells the customer nothing about the defect). An undecided negative is
 * neither: it is listed but not counted as an error, since nothing false was claimed.
 */
export function confusion(results: readonly CaseResult[]): Confusion[] {
  const by = new Map<string, CaseResult[]>();
  for (const r of results) {
    if (r.expected.verdict === 'any') continue;
    const k = `${r.test}|${r.criterion}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  const out: Confusion[] = [];
  for (const [k, rs] of by) {
    const [test, criterion] = k.split('|') as [string, string];
    let tp = 0, fp = 0, tn = 0, fn = 0, undecidedPos = 0, undecidedNeg = 0, naRight = 0, naWrong = 0;
    for (const r of rs) {
      const pos = r.expected.verdict === 'fail';
      const und = UNDECIDED.has(r.observed);
      if (pos) {
        if (r.observed === 'fail') tp++;
        else if (und) { undecidedPos++; fn++; } else fn++;
      } else {
        if (r.observed === 'fail') fp++;
        else if (und) undecidedNeg++;
        else tn++;
        if (r.expected.verdict === 'na') {
          if (r.observed === 'na') naRight++;
          else naWrong++;
        }
      }
    }
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const precisionLower = wilsonLower(tp, tp + fp);
    const recallLower = wilsonLower(tp, tp + fn);
    out.push({
      test, criterion, cases: rs.length, tp, fp, tn, fn, undecidedPos, undecidedNeg, naRight, naWrong,
      precision, recall, precisionLower, recallLower, meets95: precisionLower >= 0.95 && recallLower >= 0.95,
    });
  }
  return out.sort((a, b) => (a.test + a.criterion < b.test + b.criterion ? -1 : 1));
}
