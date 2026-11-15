// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The report's note on the scan's pace (`SiteReport.pace`): plain sentences for the HTML report's
// page list and the terminal summary.
import type { SiteReport } from '../types.js';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))} s`;

/** The note, one sentence per fact; empty when the scan kept its normal pace. */
export function paceNotes(report: SiteReport): string[] {
  // Work the scan stopped or skipped for want of time (src/finishPlan.ts), first.
  const out: string[] = (report.notChecked ?? []).map((x) => `${x.detail}.`);
  const p = report.pace;
  if (!p) return out;
  if (p.slowedDown) {
    const total = p.refusals.reduce((n, r) => n + r.count, 0);
    // Status 0: a stylesheet that came back with no usable answer (blocked, failed, or not CSS).
    const label = (status: number) => (status === 0 ? 'no usable answer' : `HTTP ${status}`);
    const how = p.refusals.length === 1 ? label(p.refusals[0]!.status) : p.refusals.map((r) => `${label(r.status)}: ${r.count}`).join(', ');
    out.push(p.stylesheetsOnly
      ? 'The site asked us to slow down when sending stylesheets; pages that needed them were loaded again after a pause.'
      : 'The site asked us to slow down; pages were checked one at a time with pauses.');
    out.push(`It refused ${plural(total, 'request')} (${how}); we tried ${plural(p.retries, 'load')} again and paused ${seconds(p.pausedMs)} in all.`);
  }
  if (p.crawlDelayMs) out.push(`The site’s robots.txt asks for ${seconds(p.crawlDelayMs)} between pages, so page loads were spaced that far apart.`);
  if (p.failedPages) out.push(`${plural(p.failedPages, 'page')} still could not be checked (the reason is listed with each page).`);
  if (p.unstyledPages) {
    const n = p.unstyledPages;
    out.push(`${plural(n, 'page')} could not load ${n === 1 ? 'its' : 'their'} styles (the site refused ${n === 1 ? 'its stylesheet' : 'their stylesheets'}), so ${n === 1 ? 'it was' : 'they were'} left out of the score rather than checked without ${n === 1 ? 'it' : 'them'}.`);
  }
  return out;
}
