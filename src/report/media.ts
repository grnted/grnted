// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The media results as the engine reports them: the counts and the terminal line. Media is listed with
// rules-based findings; whether they count toward the score is the report's scorer's answer (scoreScope.ts).
// The hosted report's "Video and audio" section is not part of the engine.
import type { SiteReport } from '../types.js';

export function mediaCounts(report: SiteReport): { found: number; withProblems: number; toCheck: number } {
  const items = report.media ?? [];
  return {
    found: items.length,
    withProblems: items.filter((m) => m.issues.some((i) => i.level === 'problem')).length,
    toCheck: items.filter((m) => m.issues.some((i) => i.level === 'review')).length,
  };
}

/** "N video and audio items found (K with problems)". */
export function mediaLine(report: SiteReport): string {
  const c = mediaCounts(report);
  return `${c.found} video and audio item${c.found === 1 ? '' : 's'} found (${c.withProblems} with problems)`;
}
