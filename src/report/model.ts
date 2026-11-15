// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Report v2 contracts (docs/specs/2026-10-31-report-v2-design.md §4–§5): the plain-English copy for
// each problem and the problem list that leads the report. Types only: the copy library lives in
// `report/copy/`, `buildProblems` in `report/problems.ts`, the HTML in `report/html.ts`.
import type { CriterionEvidence, EvidenceShot, OfficeFormat } from '../types.js';

/** Who usually makes the change. Shown as "Web developer", "Content" or "Documents". */
export type OwnerId = 'developer' | 'content' | 'documents';

/** What a snippet builder gets from the scan. Every string is untrusted page content. */
export interface SnippetInput {
  /** The failing element's HTML as axe reported it (start of it, max 300 characters). */
  html?: string;
  target?: string;
  /** Values a probe measured (for example `coverHeight` for 2.4.11), from its finding's data. */
  data?: Record<string, unknown>;
}

/** A code change shown under "How to fix it". Plain text: the renderer escapes it. */
export interface Snippet {
  /** 'change': built from the page's own HTML or a measured value. 'example': a common pattern. */
  kind: 'change' | 'example';
  language: 'html' | 'css';
  /** Lines removed (shown with "-"); empty for an addition only. */
  before: string[];
  /** Lines added (shown with "+"). */
  after: string[];
}

/** Reviewed, versioned wording for one problem type (an axe rule, a probe criterion or documents). */
export interface ProblemCopy {
  /** Plain title, ≤ 70 characters, no rule ids: "Link names don't match the words on screen". */
  title: string;
  /** Who it stops and how, one or two sentences. */
  who: string;
  /** The change that fixes it, one or two sentences. */
  fix: string;
  owner: OwnerId;
  /** Builds a code change from the scan's own evidence; null when it can't. */
  snippet?: (ex: SnippetInput) => Snippet | null;
}

/** One PDF in the documents problem, with the checks it fails. */
export interface DocumentProblemRow {
  url: string;
  linkedFrom: string[];
  /** Batch 19: the words people know it by: its link's words, the file name the server gave and the PDF's title. */
  linkText?: string;
  fileName?: string;
  title?: string;
  pages?: number;
  untagged: boolean;
  noTitle: boolean;
  noLanguage: boolean;
  imageOnly: boolean;
  /**
   * Every problem the quick checks found, in words (`pdfProblems`), the four above included, then (scoring v10)
   * the AI document review's confirmed ones, each marked " (AI review)" as the Documents section shows them.
   */
  problems: string[];
  /** Scoring v10: how many of `problems` (the last ones) the AI document review confirmed; absent: none. */
  aiProblems?: number;
  /** Short names of the problems not in the four columns above ("Image alt text", "Form field names"…). */
  other: string[];
}

/** One Word, Excel or PowerPoint file in the Office problem (scored since v10), with its problems in words. */
export interface OfficeProblemRow {
  url: string;
  linkedFrom: string[];
  /** Batch 19: its link's words and the file name the server gave. */
  linkText?: string;
  fileName?: string;
  format: OfficeFormat;
  /** The quick checks' problems in words (`officeProblems`; hints are left out). */
  problems: string[];
}

/** One entry in "Fix these first". */
export interface Problem {
  /** 'rule:<axe id>' | 'criterion:<n.n.n>' | 'ai:<n.n.n>' (scoring v5) | 'documents' | 'office' (scored since v10). Stable; used as the card's anchor. */
  key: string;
  copy: ProblemCopy;
  /** WCAG criteria it fails, e.g. [{ criterion: '2.5.3', level: 'A' }]. */
  criteria: { criterion: string; level: 'A' | 'AA' }[];
  scored: boolean;
  pointsLost: number;
  /** Pages affected, scan order. */
  pages: string[];
  /** `document`: PDFs; `file`: Word, Excel and PowerPoint files. */
  count: { n: number; unit: 'element' | 'link' | 'page' | 'document' | 'image' | 'file' };
  /** The failing element repeats on at least half of the loaded pages (and on 3 or more). */
  repeats?: { pages: number; of: number };
  /** Evidence images for this problem, in display order (group members together). */
  evidence: EvidenceShot[];
  /** Why a planned picture is missing ("the page could not be loaded again…"), when it has none. */
  evidenceMissed?: string;
  /** Text evidence (as v1 shows it), max 3. */
  textEvidence: CriterionEvidence[];
  /**
   * Who makes the change: the copy's owner, except a failing element repeated in the shared template,
   * which the web developer changes once there (the fix plan's template fix). The one value the card,
   * the owner counts and the fix plan all show.
   */
  owner: OwnerId;
  /**
   * What other tests found on the same elements for the same criteria (the screen-reader test hearing a
   * link the axe rule found with no name), merged into this problem instead of repeating it. Max 3.
   */
  sameElement?: CriterionEvidence[];
  snippet?: Snippet;
  /** Documents problem only. */
  documents?: DocumentProblemRow[];
  /** Office problem only. */
  officeFiles?: OfficeProblemRow[];
  /** AI-scored problems only (scoring v5): the confirmed images, with what the AI read in each. */
  aiImages?: AiProblemImage[];
  /**
   * The same elements, as other methods found them (src/crossDedupe.ts): a test's failure an axe rule also
   * found, an AI finding of an element axe, a test or a heavier AI check found. Listed on this card; never
   * a problem or a cost of their own. At most MAX_ALSO_FOUND.
   */
  alsoFound?: AlsoFound[];
  /**
   * A test's problem only, when one of its failures was measured outside the score's own runs (the wider test
   * coverage, src/probes/sample.ts): **every** page where the failure was measured, in scan order, with how
   * (`METHOD_FULL`: the whole test ran on the page; `METHOD_CHECKED`: the element that failed elsewhere was
   * measured on this page by itself) and whether that page counts in the score. `pages` stays the pages of
   * the score (of a problem that is not scored: all of them). Absent: every page is a full test, as before.
   */
  measured?: MeasuredPage[];
}

/** One page where a test measured a problem's failure (`Problem.measured`). */
export interface MeasuredPage {
  page: string;
  method: string;
  scored: boolean;
}

/** One element another method also found, listed on the problem that counts it. */
export interface AlsoFound {
  /** 'test' (an automated test) or 'ai' (the AI review). */
  by: 'test' | 'ai';
  page: string;
  target?: string;
  detail: string;
}

/** One confirmed image of an AI-scored problem: where it is, its alt text and the words read from it. */
export interface AiProblemImage {
  page: string;
  src: string;
  /** The current alt text ('' = marked decorative); absent when the image has no alt attribute. */
  alt?: string;
  /** The key information read from the image, verbatim (untrusted page content). */
  essentialText: string;
  /** What the AI saw. */
  observed: string;
}
