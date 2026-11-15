// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { aiNotRunNote } from '../aiScore.js';
import type { SiteReport } from '../types.js';
import { aiTerminalLines } from './ai.js';
import { CRITERIA, criteriaTerminalLine } from './criteria.js';
import { documentsLine } from './documents.js';
import { mediaLine } from './media.js';
import { paceNotes } from './pace.js';
import type { Problem } from './model.js';
import { verdictLine } from './blocked.js';
import { buildProblems, keyCriterion } from './problems.js';
import { countsTowardScore } from './scoreScope.js';

const criterionTitle = (c: string) => CRITERIA.find((d) => d.criterion === c)?.title ?? '';

/** Problems listed in the terminal; the rest are counted. */
export const TERMINAL_PROBLEMS = 8;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Terminal output: control characters (from rule ids in a report read back from JSON) become spaces. */
const plain = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

/** One problem: plain title, count, repetition, points, then the rule id or criterion for reference. */
function problemLine(p: Problem): string {
  const pages = plural(p.pages.length, 'page');
  const count = p.count.unit === 'page' ? pages
    : p.count.unit === 'document' ? plural(p.count.n, 'PDF')
      : p.count.unit === 'file' ? plural(p.count.n, 'Office file')
      : `${plural(p.count.n, p.count.unit)} on ${pages}`;
  const parts = [count];
  if (p.repeats) parts.push(`repeats on ${p.repeats.pages} of ${p.repeats.of} pages`);
  if (p.scored && p.pointsLost > 0) parts.push(`+${p.pointsLost} if fixed`);
  if (!p.scored) parts.push('not in the score');
  const ref = p.key.startsWith('rule:') ? p.key.slice(5)
    : p.key.startsWith('criterion:') ? `${p.criteria[0]?.criterion ?? keyCriterion(p.key)} ${criterionTitle(keyCriterion(p.key))}`.trim()
      : p.key.startsWith('ai:') ? `${p.key.split(':').pop()} ${criterionTitle(p.key.split(':').pop()!)}, AI review confirmed by two runs`.trim()
        : p.key === 'documents' ? 'documents'
          : p.key === 'office' ? 'Office files'
          : `${p.key.split(':').pop()} ${criterionTitle(p.key.split(':').pop()!)}`.trim();
  return plain(`${p.copy.title}: ${parts.join(', ')} (${ref})`);
}

export function renderTerminal(report: SiteReport, htmlPath?: string): string {
  const lines: string[] = [];
  // Batch 19: the score and the verdict with its reason first; the address on its own line (never "Access Denied · <url>",
  // which read as the site refusing the scanner).
  const verdict = verdictLine(report);
  lines.push('', `  ${verdict ?? report.headline}`, `  ${report.site}`);
  if (report.status === 'scored') {
    // Scoring v5: a score without the AI image checks says so.
    const notRun = aiNotRunNote(report);
    if (notRun) lines.push(`  ${plain(notRun)}`);
  } else {
    lines.push('  No score', ...report.reasons.map((r) => `  - ${r}`));
  }
  const ok = report.pages.filter((p) => p.status === 'ok').length;
  lines.push(`  ${ok}/${report.pages.length} ${report.pages.length === 1 ? 'page' : 'pages'} scanned · ${documentsLine(report)}`);
  const frames = report.pages.reduce((n, p) => n + (p.untestedFrames?.length ?? 0), 0);
  if (frames) lines.push(`  ${frames} embedded frame${frames === 1 ? '' : 's'} could not be tested (listed in the report)`);
  const third = report.thirdParty?.length ?? 0;
  if (third) lines.push(`  ${third} issue${third === 1 ? '' : 's'} inside frames from other sites (listed in the report, ${countsTowardScore(report, 'third-party') ? 'in the score' : 'not in the score'})`);
  if (report.media?.length) lines.push(`  ${mediaLine(report)}`);
  for (const note of paceNotes(report)) lines.push(`  ${plain(note)}`);
  lines.push('');
  // Report v2: the same problems, in the same order and with the same plain titles, as "Fix these first".
  const problems = buildProblems(report);
  if (problems.length) {
    lines.push('  Fix these first:');
    for (const p of problems.slice(0, TERMINAL_PROBLEMS)) lines.push(`  - ${problemLine(p)}`);
    if (problems.length > TERMINAL_PROBLEMS) lines.push(`  and ${problems.length - TERMINAL_PROBLEMS} more (listed in the report)`);
    lines.push('');
  }
  if (report.ai?.runs.length) {
    lines.push(...aiTerminalLines(report.ai).map((l) => `  ${l}`), '');
  }
  lines.push(`  ${criteriaTerminalLine(report)}`, '');
  if (htmlPath) lines.push(`  Full report: ${htmlPath}`, '');
  return lines.join('\n');
}
