// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 19 (first-run feedback): which failures a problem shows as its evidence lines. A problem on 7 pages showed 3
// lines from one page, and the same failure twice (once from each screen width). Now: the same page, element and
// words once; clear failures before minor ones; one line per page before a second line from any page.
import type { CriterionEvidence } from '../types.js';

export interface EvidenceCandidate extends CriterionEvidence {
  /** A failure of the lighter kind (`ProbeFinding.minor`): shown after the clear ones. */
  minor?: boolean;
}

export function pickEvidence(candidates: readonly EvidenceCandidate[], max: number): CriterionEvidence[] {
  const seen = new Set<string>();
  const unique: EvidenceCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.page}\n${c.target ?? ''}\n${c.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }
  const ordered = [...unique.filter((c) => !c.minor), ...unique.filter((c) => c.minor)];
  const pages = new Set<string>();
  const first: EvidenceCandidate[] = [];
  const rest: EvidenceCandidate[] = [];
  for (const c of ordered) {
    if (pages.has(c.page)) rest.push(c);
    else {
      pages.add(c.page);
      first.push(c);
    }
  }
  return [...first, ...rest].slice(0, max).map(({ minor: _minor, ...e }) => e);
}
