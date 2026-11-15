// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Why a site with a passing score is Access Denied (scoring v8, Paul 2026-11-04): a scored failure of a
// WCAG non-interference criterion (1.4.2, 2.1.2, 2.2.2, 2.3.1) on any page blocks Access Granted,
// whatever the score. One plain line, the same in the report, the PDF, the JSON, the terminal, the
// badge and the emails (the hosted report links each criterion to its problem). Read from
// the report's own `accessBlockedBy`, so a report made before the rule never claims it. Results only: never a weight. Engine core: no Node-only imports.
import type { AccessBlocker, SiteReport } from '../types.js';

/** The rule in plain words, for reports scored under it ("How this score works"). */
export const NON_INTERFERENCE_RULE = 'A failure of a non-interference criterion (1.4.2 Audio control, 2.1.2 No keyboard trap, 2.2.2 Pause, stop, hide, or 2.3.1 Three flashes) on any page means Access Denied, whatever the score: WCAG requires these on every page, because they can stop someone using the rest of the site.';

/** The blockers of a scored, Access Denied report; empty otherwise. */
export function blockersOf(report: Pick<SiteReport, 'status' | 'headline' | 'accessBlockedBy'>): AccessBlocker[] {
  if (report.status !== 'scored' || report.headline !== 'Access Denied' || !Array.isArray(report.accessBlockedBy)) return [];
  return report.accessBlockedBy.filter((b) => b && typeof b.criterion === 'string' && typeof b.title === 'string');
}

/** "a, b and c". */
export const andList = (xs: readonly string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Who fails ("a page fails", "3 pages fail", "the site fails") and the verb for the blockers' count. */
export function blockedParts(blockers: readonly AccessBlocker[]): { who: string; verb: string } {
  const pages = new Set(blockers.flatMap((b) => (Array.isArray(b.pages) ? b.pages : [])));
  const who = pages.size === 0 ? 'the site fails' : pages.size === 1 ? 'a page fails' : `${pages.size} pages fail`;
  return { who, verb: blockers.length === 1 ? 'blocks' : 'block' };
}

/** "Access Denied: a page fails WCAG 2.1.2 No keyboard trap, which blocks Access Granted whatever the score." Null when nothing blocks. */
export function blockedLine(report: Pick<SiteReport, 'status' | 'headline' | 'accessBlockedBy'>): string | null {
  const b = blockersOf(report);
  if (!b.length) return null;
  const { who, verb } = blockedParts(b);
  return `Access Denied: ${who} ${andList(b.map((x) => `WCAG ${x.criterion} ${x.title}`))}, which ${verb} Access Granted whatever the score.`;
}

/**
 * What Access Granted means, in one plain sentence (batch 19, first-run correctness: "Access Denied" read as the site
 * refusing the scanner). The same words in the help, the README, the plain HTML report and both fix briefs.
 */
/**
 * The same, short, for the fix briefs: every character there is room a problem cannot have (the brief keeps under
 * FIX_PROMPT_MAX_CHARS and leaves the cheapest problems out).
 */
export const ACCESS_GRANTED_SHORT = 'Access Granted means 90 or more and no failure of 1.4.2, 2.1.2, 2.2.2 or 2.3.1; it is this check\'s verdict, not the site blocking the scanner.';
export const ACCESS_GRANTED_RULE = 'Access Granted means a score of 90 or more and no failure of a criterion that blocks it (1.4.2 Audio control, 2.1.2 No keyboard trap, 2.2.2 Pause, stop, hide, 2.3.1 Three flashes); anything else is Access Denied. It is the verdict of this check on how accessible the site is, not the site blocking the scanner.';

/** Why the verdict is what it is, without "Access Denied: " ("84 is below the 90 needed for Access Granted"). */
function verdictReasons(report: Pick<SiteReport, 'status' | 'headline' | 'accessBlockedBy' | 'score'>): string {
  if (report.headline === 'Access Granted') return '90 or more, and no failure blocks it';
  const reasons: string[] = [];
  if (typeof report.score === 'number' && report.score < 90) reasons.push(`${report.score} is below the 90 needed for Access Granted`);
  const b = blockersOf(report);
  if (b.length) {
    const { who, verb } = blockedParts(b);
    reasons.push(`${who} ${andList(b.map((x) => `WCAG ${x.criterion} ${x.title}`))}, which ${verb} Access Granted whatever the score`);
  }
  return reasons.join(', and ') || 'the score does not reach Access Granted';
}

/**
 * The verdict line every surface leads with (batch 19): the score and grade first, then the verdict and its reason on
 * the same line: "84/100 · Grade B · Access Denied: 84 is below the 90 needed for Access Granted". Null with no score.
 */
export function verdictLine(report: Pick<SiteReport, 'status' | 'headline' | 'accessBlockedBy' | 'score' | 'letter'>): string | null {
  if (report.status !== 'scored' || typeof report.score !== 'number' || !Number.isFinite(report.score)) return null;
  return `${report.score}/100 · Grade ${report.letter ?? ''} · ${report.headline}: ${verdictReasons(report)}`;
}
