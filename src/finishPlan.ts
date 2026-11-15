// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Finishing in time (Paul, 2026-11-04: a staging scan of accessibe.com audited all 25 pages, then ran
// out of its budget in the work after them and ended with no score). Once the pages are audited, the
// scan always ends with a report of its own: the work after the pages is planned against the caller's
// `finishBy` (ScanOptions), and whatever does not fit is stopped or skipped, lowest value first:
//   1. the pictures of the images the AI review flagged (never scored);
//   2. the deep tests (never scored) and the pictures of the problems (never scored);
//   3. the AI review (its gated checks at half weight, the rest never scored);
//   4. the document checks (scored since v7);
//   5. the core tests last (scored, most criteria).
// The time for building the report is always kept. A stopped stage keeps what it finished (core tests'
// completed runs, PDFs checked); the rest is "not tested" and costs nothing (docs/scoring.md). Engine
// core: no Node-only imports.

export const FINISH = {
  /** Kept at the end for building and handing back the report. */
  reportMs: 15_000,
  /** The AI review's wait after the pages (its model calls overlap the pages before that). */
  aiMs: 45_000,
  /** The thumbnails of the images the AI review flagged. */
  aiPicturesMs: 15_000,
  /** The least time the core tests (and documents) keep before the AI review gets any. */
  minTestsMs: 60_000,
  /** The deep tests and the problem pictures stop this long before the core tests. */
  deepMarginMs: 30_000,
  /** After a stop, how long a stage may take to hand back what it has. */
  graceMs: 5_000,
} as const;

export type FinishTiming = { -readonly [K in keyof typeof FINISH]: number };

/** When each stage must end (epoch ms), from the time the pages were done. */
export interface FinishPlan {
  /** Deep tests and problem pictures. */
  deepBy: number;
  picturesBy: number;
  /** Core tests, document checks, the video and audio inventory. */
  testsBy: number;
  docsBy: number;
  /** The AI review (skipped when `skipAi`, unless time is left over once the stages before it end). */
  aiBy: number;
  skipAi: boolean;
  /** The AI-flagged image pictures. */
  aiPicturesBy: number;
  /** The report is built from here on. */
  end: number;
}

export function planFinish(now: number, finishBy: number, o: { ai: boolean; timing?: Partial<FinishTiming> }): FinishPlan {
  const t: FinishTiming = { ...FINISH, ...o.timing };
  const at = (x: number) => Math.max(now, x);
  const end = at(finishBy - t.reportMs);
  const room = end - now;
  const aiFits = o.ai && room >= t.minTestsMs + t.aiMs;
  const picturesMs = aiFits && room >= t.minTestsMs + t.aiMs + t.aiPicturesMs ? t.aiPicturesMs : 0;
  const aiBy = at(end - picturesMs);
  const testsBy = at(aiBy - (aiFits ? t.aiMs : 0));
  const deepBy = at(testsBy - t.deepMarginMs);
  return { deepBy, picturesBy: deepBy, testsBy, docsBy: testsBy, aiBy, skipAi: o.ai && !aiFits, aiPicturesBy: end, end };
}

/** A stage the scan stopped or skipped for want of time (`SiteReport.notChecked`). */
export type FinishStage = 'core-tests' | 'deep-tests' | 'documents' | 'ai-review' | 'pictures';

const STAGE_NAME: Record<FinishStage, string> = {
  'core-tests': 'the automated tests',
  'deep-tests': 'the deep tests',
  documents: 'the document checks',
  'ai-review': 'the AI review',
  pictures: 'some pictures of the problems',
};

/** The report's line for a stage: "Not checked" when none of it ran, "Not finished" when part did. */
export function notCheckedLine(stage: FinishStage, partly: boolean): string {
  return partly
    ? `Not finished: ${STAGE_NAME[stage]} (the scan ran out of time; what ran counts)`
    : `Not checked: ${STAGE_NAME[stage]} (the scan ran out of time)`;
}
