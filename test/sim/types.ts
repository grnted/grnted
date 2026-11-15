// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The simulation lab's types (test/sim/): generated pages whose answer is known by construction.
//
// A generator is a pure function from parameters (and a seed) to a page (HTML, CSS, JS, assets) plus
// the result a careful auditor expects for each criterion it is about. The runner scans each case with
// the engine's real probes in real Chromium (the gold suite's path: scanSite on a local site) and
// compares. Nothing here looks at a result before the expectation is written down.
import type { PageProbe } from '../../src/probes/types.js';

/** What a careful auditor expects for one criterion on the case's page. */
/** 'any': the case is not about this criterion and either answer is defensible (not counted). */
export type Verdict = 'fail' | 'pass' | 'na' | 'any';

export interface Expectation {
  verdict: Verdict;
  /** Failing elements (or places), when the generator knows how many; informational. */
  count?: number;
}

/** What the engine said for one criterion on the case's page. */
export type Observed = 'fail' | 'pass' | 'na' | 'not_testable' | 'timeout' | 'error';

/** A server-side answer for one path: a status, a delay and a body (forms, late fonts, lazy images). */
export interface SimRoute {
  status?: number;
  type?: string;
  body?: string | Uint8Array;
  /** Hold the answer back this long (a slow font, a late API). */
  delayMs?: number;
  headers?: Record<string, string>;
}

/** The page of one case: files served at their paths ('/' is the page under test), and routes. */
export interface SimSite {
  files: Record<string, string | Uint8Array>;
  /** Answers by path (and method), checked before files. Key 'POST /submit' or '/path'. */
  routes?: Record<string, SimRoute>;
}

/** A harness hazard real sites have, crossed with each boundary sweep. */
export type Hazard =
  | 'none'
  | 'smooth-scroll'
  | 'scroll-snap'
  | 'lazy-images'
  | 'late-mount'
  | 'font-swap'
  | 'cookie-banner'
  /** A news-alert lightbox opened on load over a dark backdrop, closed by its own button (popupAside.ts). */
  | 'load-popup'
  | 'sticky-header'
  | 'reduced-motion-honored'
  | 'reduced-motion-ignored'
  | 'animation-in-flight';

export interface SimCase {
  /** Stable id: test, parameters and hazard (the same inputs give the same id and the same page). */
  id: string;
  test: string;
  /** The parameters the page was generated from (shown in failure reports). */
  params: Record<string, string | number | boolean>;
  hazard: Hazard;
  site: SimSite;
  /** The expected result for each criterion the test is about. */
  expect: Record<string, Expectation>;
  /** Why the expectation is what it is, in one line (for the failure report). */
  why: string;
}

/** One test of the engine (a probe, or axe with a probe) and its generated cases. */
export interface SimTest {
  id: string;
  /** Criteria scored for this test. */
  criteria: string[];
  /** The probes that run (the scan's other probes are off, so nothing else changes the verdict). */
  probes: () => PageProbe[];
  /** Deep probes need `full`. */
  full: boolean;
  /**
   * How the verdict is read: 'criterion' reads the report's criteria table (axe and every probe that
   * ran, as a customer sees it); 'probe' reads only the named probes' findings for the page.
   */
  read: 'criterion' | 'probe';
  /** For read 'probe': the probe ids whose findings count. */
  readProbes?: string[];
  /** Time cap per case (ms): the scan is stopped and the case counts as 'timeout'. */
  capMs: number;
  /** At most this many cases at once (pixel tests that time frames run one at a time). */
  maxConcurrency?: number;
  /**
   * Pages of the case's site the scan takes (default 1: the page under test alone). A test of a rule across pages
   * (the same line marked up as a heading on another page, a title that names another page) gives its cases a site
   * of several pages, linked from '/', and sets this to their number.
   */
  maxPages?: number;
  /** All cases for `seed`. Deterministic. */
  cases(seed: number): SimCase[];
  /** Known issue another branch owns (shown on the scorecard). */
  knownIssue?: string;
}

/** One case's outcome for one criterion. */
export interface CaseResult {
  id: string;
  test: string;
  criterion: string;
  hazard: Hazard;
  params: SimCase['params'];
  expected: Expectation;
  observed: Observed;
  /** Failures the engine reported for the criterion on the page (its findings or axe nodes). */
  observedCount: number;
  /** The engine's details for the criterion (findings, not-testable reasons), capped. */
  details: string[];
  why: string;
  ms: number;
}

/** A test run's file (test/sim/results/<test>.json). */
export interface TestRun {
  test: string;
  criteria: string[];
  seed: number;
  cases: number;
  engine: { scoring: string; commit?: string };
  startedAt: string;
  ms: number;
  knownIssue?: string;
  /** Another engine build than the branch's own (SIM_VARIANT), e.g. a fix branch's commit. */
  variant?: string;
  results: CaseResult[];
}
