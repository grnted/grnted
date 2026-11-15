// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The AI review's results as the engine reports them: which findings count, are flagged or are
// suggestions, their counts, their in-page anchors, the plain "how to fix" text and the terminal lines.
// AI-flagged issues are not in the score; confirmed failures (scoring v5, `AiFinding.scored`) count toward it
// and are listed with the problems. The hosted report's AI section is not part of the engine.
import { aiDocumentsCount, aiScoredWords } from '../aiScore.js';
import { LEGACY_AI_GATES } from '../aiLegacy.js';
import type { AiCheckRun, AiFinding, AiReport, SiteReport } from '../types.js';

/** Confirmed PDF findings count only when this report actually scores their checked document. */
export function reportAi(report: Pick<SiteReport, 'ai' | 'meta' | 'documentScore' | 'documentChecks'>): AiReport | undefined {
  if (!report.ai) return undefined;
  const counted = report.documentScore?.scored === true && aiDocumentsCount(report.meta?.scoring)
    ? new Set((report.documentChecks ?? []).filter((d) => d.type === 'pdf' && d.checks).map((d) => d.url))
    : new Set<string>();
  return { ...report.ai, runs: report.ai.runs.map((run) => run.check !== 'document' ? run : {
    ...run, findings: run.findings.map((f) => f.scored && !counted.has(f.page) ? { ...f, scored: false } : f),
  }) };
}

/** Unflagged verdicts that mean "no opinion" rather than "looked fine". */
export const NOT_JUDGED_VERDICTS: readonly string[] = ['cannot_judge', 'not_reviewed'];

export function isNotJudged(f: AiFinding): boolean {
  return !f.flagged && NOT_JUDGED_VERDICTS.includes(f.verdict);
}

/**
 * Unflagged verdicts that offer a fix for something already reported elsewhere (e.g. alt text for
 * an image axe failed), so they are listed as suggestions, never as "looked fine".
 */
export const SUGGESTION_VERDICTS: readonly string[] = ['suggested_alt'];

export function isSuggestion(f: AiFinding): boolean {
  return !f.flagged && SUGGESTION_VERDICTS.includes(f.verdict);
}

/**
 * A confirmed failure that counts toward the score (scoring v5): a problem in "Fix these first". One that
 * another check already counts for (`countedElsewhere`, one cost per element) is listed as AI-flagged.
 */
export function isScored(f: AiFinding): boolean {
  return f.scored === true && f.countedElsewhere !== true;
}

/**
 * An AI-flagged issue (not in the score): flagged, not counted here, and not the same element another
 * review's confirmed failure already counts for (that one is a problem under Every problem, listed once).
 */
export function isAiFlagged(f: AiFinding): boolean {
  return f.flagged && !isScored(f) && f.countedElsewhere !== true;
}

/** Counts of a run's findings. `flagged` is the AI-flagged issues (not in the score); `scored` the confirmed ones (listed as problems). */
export function runCounts(run: AiCheckRun): { flagged: number; fine: number; notJudged: number; suggestions: number; scored: number; elsewhere: number } {
  const scored = run.findings.filter(isScored).length;
  const flagged = run.findings.filter(isAiFlagged).length;
  // Confirmed failures another review's finding of the same element counts for (one cost per element).
  const elsewhere = run.findings.filter((f) => f.countedElsewhere === true).length;
  const notJudged = run.findings.filter((f) => !isScored(f) && isNotJudged(f)).length;
  const suggestions = run.findings.filter((f) => !isScored(f) && isSuggestion(f)).length;
  return { flagged, fine: run.findings.length - scored - flagged - elsewhere - notJudged - suggestions, notJudged, suggestions, scored, elsewhere };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "N AI-flagged issues" (the label every count of unconfirmed AI findings uses). */
export function flaggedIssues(n: number): string {
  return plural(n, 'AI-flagged issue');
}

/** The WCAG criteria a finding is about ('1.4.5, 1.1.1' → ['1.4.5', '1.1.1']). */
export function criteriaOf(f: Pick<AiFinding, 'criterion'>): string[] {
  return f.criterion.split(/\s*,\s*/).filter(Boolean);
}

// Anchors ------------------------------------------------------------------------------------------

/** In-page ids of the AI area: one per run (unique even if a check ran twice), in report order. */
export function runIds(ai: AiReport): string[] {
  const seen = new Map<string, number>();
  return ai.runs.map((run) => {
    const base = `ai-${run.check}`.replace(/[^A-Za-z0-9_-]/g, '');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

/** In-page id of a flagged finding's card: its run's id and its position in `run.findings`. */
export function findingId(runId: string, index: number): string {
  return `${runId}-f${index}`;
}

// How to fix -----------------------------------------------------------------------------------------

/** Fallback fixes for a flagged item the AI gave no suggestion for, by check and verdict (`fixText`, and the report's "How to fix" line). */
export const FIX_BY_VERDICT: Readonly<Record<string, string>> = {
  'altText:should_be_decorative': 'Mark the image as decorative with an empty alt attribute (alt="") so screen readers skip it.',
  'document:should_be_decorative': 'Mark the figure as decoration (an artifact) in the PDF so screen readers skip it.',
  'media:captions_incomplete': 'Add the missing speech to the captions, with the speaker’s name where the speaker changes.',
  'media:captions_inaccurate': 'Correct the captions so they say exactly what is said, especially names, numbers and dates.',
  'media:needs_audio_description': 'Say out loud what is only shown on screen, or publish a version with audio description or a full text description.',
};

/** Fallback fixes by WCAG criterion (the first one a finding names). Plain words, no WCAG jargon. */
export const FIX_BY_CRITERION: Readonly<Record<string, string>> = {
  '1.1.1': 'Write a text alternative that gives the same information or does the same job as the image, or mark it as decorative if it adds nothing.',
  '1.2.1': 'Publish a full transcript next to the audio (or a text description next to a video without sound).',
  '1.2.2': 'Add accurate captions for all speech and important sounds; automatic captions need correcting before they count.',
  '1.2.3': 'Say out loud what is only shown on screen, or offer an audio-described version or a full text description.',
  '1.2.5': 'Say out loud what is only shown on screen, or offer an audio-described version.',
  '1.3.1': 'Mark headings, lists and tables as real headings, lists and tables (your editor’s heading and list tools, or the tags of a PDF).',
  '1.3.2': 'Change the order of the content itself (the page code, or the tag order of a PDF) so it matches the order people read it in.',
  '1.3.3': 'Name what an instruction points to in words, not only by its color, shape, position or sound.',
  '1.4.1': 'Add a second cue besides color: underline links in text, add a word or symbol to required fields and status messages, label chart parts.',
  '1.4.5': 'Put the text on the page as real text (or in a document people can read with a screen reader) and keep the image as a picture.',
  '2.4.2': 'Give the page a title that names its topic first, then the site.',
  '2.4.3': 'Put the elements in the page source in the order people read and use them, so the Tab key follows that order; do not move controls out of it with CSS.',
  '2.4.4': 'Make the link text, or the sentence around it, say where the link goes, for example "2026 budget (PDF)" instead of "Read more".',
  '2.4.6': 'Reword the heading or label so it says what its section or field is about.',
  '3.2.4': 'Give the component the same name on every page where it appears, for example "Board meetings" everywhere.',
  '3.1.2': 'Mark the passage with its language (the lang attribute, or your editor’s language setting) so screen readers pronounce it correctly.',
  '3.3.2': 'Add a visible label and the format or instructions people need, for example "Date of birth (MM/DD/YYYY)".',
  '4.1.2': 'Give the control or field a name that says what it does or asks for, for example "Search" or "Open the menu".',
};

export const FIX_FALLBACK = 'Look at the item described above and fix it where it is published.';


/** The fix for a flagged finding as plain text: the AI's or rules' suggestion, else the default for its kind. */
export function fixText(f: AiFinding): string {
  return f.suggestion.trim() || (FIX_BY_VERDICT[`${f.check}:${f.verdict}`] ?? criteriaOf(f).map((c) => FIX_BY_CRITERION[c]).find(Boolean) ?? FIX_FALLBACK);
}

/** One line per run for the terminal summary. */
export function aiTerminalLines(ai: AiReport): string[] {
  return ai.runs.map((run) => {
    const { flagged, scored, elsewhere } = runCounts(run);
    const also = elsewhere ? `, ${plural(elsewhere, 'finding')} also found by another check (listed there)` : '';
    // Scoring v5: confirmed image failures are in the score (and listed with the problems).
    if (scored) return `AI review · ${run.title} (${run.model}): ${plural(scored, 'finding')} confirmed by two runs (in the score), ${flaggedIssues(flagged)} not confirmed (not in the score)${also}, ${run.reviewed} reviewed`;
    return `AI review · ${run.title} (${run.model}): ${flaggedIssues(flagged)} (not in the score)${also}, ${run.reviewed} reviewed`;
  });
}

/**
 * The AI review's label as scoring v13 stored it (`AiReport.disclaimer`): what of it is in the score, with v13's gated
 * checks (src/aiLegacy.ts). The closed AI package labels the reviews it runs with its own gated checks.
 */
export const AI_DISCLAIMER = `AI review: ${aiScoredWords({ aiChecks: Object.keys(LEGACY_AI_GATES) as (keyof typeof LEGACY_AI_GATES)[] })}`;
