// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { auditPage, type ViewportSteps } from './audit.js';
import { discoverPages, readRobots } from './crawl.js';
import { DEFAULT_COLLECTORS, uniqueCollectors } from './collect/index.js';
import { shapeCollector } from './collect/shape.js';
import { addHomeMarks, AI_EVIDENCE_RESERVE, createEvidenceRecorder, createProbeEvidencePool, holdEvidencePass, runEvidencePass, type HeldPass } from './evidence/index.js';
import { createDocumentInventory, mergeInventory, type AiRefetch, type DocumentOptions, type DocumentStore, type InventoryResult } from './documents/index.js';
import type { PdfReader } from './documents/pdf.js';
import { TIME_LIMIT_REACHED } from './documents/pdf.js';
import { STAGE_DETAIL_MAX, safeEmit } from './events.js';
import { foundTracker } from './found.js';
import { gatedBrowser } from './navigationGate.js';
import { asksPlatforms, buildMediaInventory, type MediaInventoryOptions } from './media/index.js';
import { createPace, isPaceReason, isUnstyledReason, type Pace, type PaceAdapt, type PageSlot, type PaceTuning } from './pace.js';
import { PROBES } from './probes/registry.js';
import { BROWSER_LOST_PAGE, isWorkLost } from './reconnect.js';
import { CANCELLED, createProbeRunner, MAX_TEST_TABS, type OptionalSkip, type ProbeRunnerOptions } from './probes/runner.js';
import type { NavigatorHook } from './probes/plan.js';
import { listenerFlaggedPages, screenReaderSection } from './probes/screenReader/index.js';
import { componentKinds, COVERAGE_PAGES_LONG, EVERY_PAGE_CAP_LONG, NOVELTY_PAGE_CAP_LONG, templateProbes } from './probes/sample.js';
import { kindsCollector, kindsCollectorFor } from './collect/kinds.js';
import { CONTRAST_RULES, TEXT_CONTRAST_LIMITS, undecidedTexts } from './probes/textContrast.js';
import { CHECKS } from './probes/components.js';
import { keyboardCheckProbe } from './probes/componentCheck.js';
import { createIncrementalRun, incrementalIsFull, incrementalSummary, type IncrementalDecision, type IncrementalOptions } from './incremental/index.js';
import type { ProbeGroupTiming } from './probes/runner.js';
import type { PageProbe } from './probes/types.js';
import { buildReport, ruleSummaries, VIEWPORTS } from './report/build.js';
import type { AiProgress, AiReport, AiScanPlan, BrowserLike, DocumentCheck, EvidenceOptions, LiveShotOptions, PageAudit, PageCollector, ProbeRun, ScanEvent, ScanStage, SiteReport } from './types.js';
import { isSessionWait, SESSION_WAIT_PAGE, sessionPool, type EgressHooks } from './sessions.js';
import { REFUSED_RETRIES } from './egress.js';
import { BOT_CHALLENGE, CHALLENGE_PAGE, isChallengeStatus, isRefusalStatus } from './challenge.js';
import { FINISH, notCheckedLine, planFinish, type FinishPlan, type FinishStage, type FinishTiming } from './finishPlan.js';
import { measureStart, pageTimeoutFor, siteTiming, slowedReason, slowing, type SiteTiming, type StartSpeed } from './siteSpeed.js';
import { ACTION_SKIP_REASON, isActionLikeUrl, isDocumentUrl, isLikelyHtml, normalizeUrl, sameSite } from './url.js';
import { actionSkips, isActionMoreRecord, isRobotsMoreRecord, isWide, MAX_CRAWL_ROBOTS_SKIPPED, MAX_PAGES_LIMIT, ROBOTS_SKIP_REASON, robotsMoreReason, wideFilter, wideNormalize } from './wide.js';
import { scanUserAgent } from './userAgent.js';
import { createTimeBudget, envTimeBudget, type TimeBudget, type TimeBudgetRecorder } from './timeBudget.js';
import { createReplay, envReplay, type Replay, type ReplayMode, type ReplayOptions, type ReplayStats } from './replay/index.js';

export interface ScanProgress {
  phase: 'discover' | 'audit' | 'documents' | 'review' | 'done';
  done: number;
  total: number;
  url?: string;
}

export interface ScanOptions {
  browser: BrowserLike;
  /**
   * More browser sessions for this scan, beside `browser` (hosted: more Browser Rendering sessions,
   * each with its own CPU; at most `MAX_SESSIONS` in all). While pages are audited the core tests run
   * in the last session and the page audits in the others; after that every session takes any work
   * (`sessionPool`). The report is the same however many sessions there are: only when work runs
   * changes. The site sees the same pace (one politeness controller, the same pages and tests at
   * once), and each session gets its own navigation gate. A session lost for good is left and its
   * work opens in another one.
   */
  sessions?: readonly BrowserLike[];
  /**
   * Hosted use: sessions the site refuses (one egress address turned away, another let in; src/sessions.ts).
   * A page the site refused is loaded again in a session that has not refused it, at most
   * REFUSED_RETRIES times, through the same pace controller; `refused` hears of each session the
   * evidence says the site refuses (its place: 0 is `browser`, then `sessions` in order), and `swap`
   * replaces one with a fresh session. Without it the scan still retries in its other sessions.
   */
  egress?: EgressHooks;
  maxPages?: number;
  /**
   * The most pages audited at once (each page loads both widths in parallel). Default 6, clamped to 1–16.
   * A scan starts at `startConcurrency` and goes up to this one step at a time while the site is
   * comfortable, and down at any sign of strain (src/pace.ts, the page gate).
   */
  concurrency?: number;
  /** Pages audited at once at the start. Default `concurrency` (no raising); clamped to 1–`concurrency`. */
  startConcurrency?: number;
  /**
   * Hosted: the most pages at once this scan may run now (its share of its host's budget), read before
   * each raise and each page's turn; 0 holds new pages until it rises. Absent: no share.
   */
  concurrencyCap?: () => number;
  /** The pages-at-once limit changed (a host logs it). */
  onConcurrency?: (e: PaceAdapt) => void;
  /**
   * The host gave up on the scan (out of time): its politeness controller stops (`Pace.stop`): page turns
   * still waiting are refused and its timers cleared. The controller stops on any exit of scanSite too.
   */
  signal?: AbortSignal;
  /** Default: the browser's own User-Agent with Granted's token (src/userAgent.ts scanUserAgent). */
  userAgent?: string;
  /** axe-core source to inject. Defaults to the bundled axe-core. */
  axeSource?: string;
  fetchFn?: typeof fetch;
  /**
   * Hosted use: refuse anything this returns false for: the start URL, robots.txt and sitemaps (each
   * redirect hop), document fetches, AI image and media fetches (each hop, from the Worker), the AI
   * frame sampler's video requests (each hop, from the browser), and every document the browser loads
   * in any context the scan opens, frames and each redirect hop included, checked before it connects
   * (`gatedBrowser`). A document that is not http(s) (a redirect to `data:`) is refused. A window a
   * page opens by itself (a popup, a new tab) never loads a document: a window document the
   * browser-level session cannot tie to a target (no frame id, a lookup that fails, a frame id still
   * unknown after one short wait is taken for a same-process frame, which its page gate decides) is
   * failed. A page whose documents could not all be checked that way (no CDP session, or one lost
   * while it was used) is not loaded, or does not stand: its audit fails, it gives no links, no
   * evidence pictures and no probe results. The window check needs a browser-level CDP session
   * (`BrowserLike.newBrowserCDPSession`): without one, every page fails closed; when it is lost, every
   * window pause it still holds is failed and the gated pages are closed, so none opens a window later.
   *
   * Not covered (residual): subresources (images, scripts, fetches, workers' requests) are not checked
   * here; a caller's own route guard can check them (it sees their first request, not their redirect
   * hops), and the hosted Worker's guard checks navigations only, so there they are not checked at
   * all; a speculation-rule prefetch the in-page block misses reaches no interception; the Worker's
   * own fetches (robots, documents, images, media) only ask `allowUrl` before each hop and never see
   * the address connected to (`allowIp` does not apply to them); the AI frame sampler runs in the
   * browser, asks `allowUrl` per hop and never applies `allowIp` (a public name that resolves to a
   * private address is downloaded by the browser); `data:` and `blob:` frames do not load at all; a
   * window whose pause Chromium resumes when the browser session detaches mid-decision is not taken
   * back (the page does not stand); a same-process frame inside a window opened without a document
   * (`window.open()` then written into) is taken for a frame and has no page gate of its own.
   */
  allowUrl?: (url: string) => Promise<boolean>;
  /**
   * Hosted use (DNS rebinding): false for a server address (IPv4 or IPv6, no brackets) a page or frame
   * must not come from. Chromium reports only the class of the address before the body reaches the
   * page (loopback, private/local, public; names vary across versions): a class in which this refuses
   * any address, a class it does not know, or no class reported within a short wait, is refused then,
   * and the document never loads. A class reported as 'Unknown' is allowed. The exact address comes
   * with the response, and a refused class can be reported after the document went on: either way,
   * if this refuses it, the page counts as not loaded and its probe results do not stand. The request
   * itself was already sent when either check runs (the TCP connection is made first). Where the
   * browser connects through a local proxy (Cloudflare Browser Run: every address is `::1`), the
   * connected address says nothing about the site, so this is not used there (the hosted Worker and
   * the CLI do not pass it).
   */
  allowIp?: (ip: string) => boolean;
  onProgress?: (p: ScanProgress) => void;
  /**
   * Scan events for a live view (see `ScanEvent` for the order): discovery, each page's widths with
   * their wireframes, each page's score, the work after the pages as it runs (`stage`: the automated
   * tests, document checks, report pictures, AI review), scoring and the verdict. Observation only: the report is the
   * same with or without it, and a listener that throws (or rejects) is ignored. Wireframes are only
   * captured when it is set.
   */
  onEvent?: (e: ScanEvent) => void;
  now?: () => Date;
  /** Extra page collectors to run (results in `PageAudit.collected`). */
  collectors?: PageCollector[];
  /**
   * Optional AI review (`createAiReview` from `grnted/ai`). Reported in `report.ai`; only its confirmed image failures are scored (scoring v5, `report.aiChecks`).
   * Its checks start while pages are still loading; a failing AI review never fails the scan.
   */
  ai?: AiScanPlan;
  /** Cancels the AI review's outstanding calls; the page audits are not affected. */
  aiSignal?: AbortSignal;
  /**
   * The time (epoch ms) by which scanSite must hand back its report, once the pages are audited
   * (hosted: the scan's budget less the time to store it). The work after the pages is planned against
   * it (src/finishPlan.ts): what does not fit is stopped or skipped, lowest value first, listed in
   * `report.notChecked`, and the score comes from what ran. It never stops a page audit: before the
   * pages are done the host's own budget decides.
   */
  finishBy?: number;
  /** Tests: the finish plan's times (`FINISH`). */
  finishTiming?: Partial<FinishTiming>;
  /**
   * Document inventory limits (probes of possible document links, quick PDF checks). Documents are
   * scored since v7 (`documentScore`). `false` lists only documents recognisable from their links and checks none.
   */
  documents?: DocumentOptions | false;
  /**
   * Long scans: the PDF outcomes the host kept from earlier runs of this scan (its document runs,
   * `checkDocuments`), and where new ones go. A PDF with an outcome is not downloaded or read again.
   */
  documentStore?: DocumentStore;
  /**
   * Reads one PDF (src/documents/pdf.ts `PdfReader`); default in this thread. The hosted checker reads in
   * its PDF reader Worker (its own isolate), so a hostile PDF never takes the scan down.
   */
  readPdf?: PdfReader;
  /** With `documentStore` and an AI document review: its sample and caps, for the stored PDFs read again (AI_REFETCH_DEFAULT). */
  aiRefetch?: AiRefetch;
  /**
   * Long scans: the documents as the host's documents segments listed them (each with its outcome). They
   * are merged with what this run's inventory hands back, so a document with an outcome there is never
   * reported without one here, whichever way the work after the pages ends (`mergeInventory`).
   */
  documentBase?: { checks: DocumentCheck[]; notPages: InventoryResult['notPages'] };
  /**
   * Scoring v7: the checked PDFs' problems count toward the score (default true). `false` (CLI
   * --no-document-score) leaves them out, as before v7; the report says so (`report.documentScore`).
   */
  documentScore?: boolean;
  /**
   * Video and audio inventory. With `youtubeApiKey` (CLI: YOUTUBE_API_KEY) or `vimeoToken` (CLI:
   * VIMEO_TOKEN), YouTube and Vimeo videos say what caption tracks the platform lists (plan C14:
   * unscored evidence for 1.2.2); only the video id is sent, and the key is never stored or reported.
   * `fetchFn` is the fetch for those APIs (default: the scan's); `cache`, `quota` and `lookups` are the
   * hosted checker's (src/media/platformCaptions.ts).
   */
  media?: Omit<MediaInventoryOptions, 'userAgent' | 'allowUrl' | 'by'>;
  /**
   * Automated interaction and render tests (Plan 4) on the template sample (up to 5 pages), each page
   * in a fresh browser context whose request guard stops anything that could change the site. They
   * start as soon as a sampled page's audit is done. Default: the registry's probes (`PROBES`);
   * `false` turns them off. Results: `report.probes` and, per criterion, `report.criteria`; not scored yet.
   */
  probes?: PageProbe[] | false;
  /** Also run the deep probes (CLI `--full`). Without it only core probes run. */
  full?: boolean;
  /**
   * `false` turns the wider test coverage off (docs/scoring.md, "Where the slow tests go"): every test but
   * scoring v10's four every-page tests then runs on the template sample only (the five newer every-page
   * tests too), nothing is optional work, no targeted check is sent, and no page is read for element kinds:
   * the schedule scoring v10 had. Default on. A host's switch for a scan that must stay cheap.
   */
  coverage?: boolean;
  /**
   * Browser tabs the optional tests (the wider coverage and the targeted checks) may open beyond the room the
   * required tests have, once every page is audited (perf/split-tests, 2026-11-10; queue rule 8 in
   * src/probes/runner.ts): most of those tests wait on the page's timers, animations and focus moves, so several
   * share a browser. Their page loads take the page gate's low turn, so the site never gets more loads at once.
   * Default: the room the page audits had (two tabs a page at the pages at once of the moment), so the tests use
   * what the audits gave back; 0 keeps the optional tests within the required room. A host whose browsers are
   * CPU-bound sets what its sessions hold. At most `MAX_TEST_TABS` tabs in all.
   */
  optionalTabs?: number;
  /**
   * Diagnostics: tests of the wider coverage that were queued and did not run, with why ('cutoff': their time
   * was over; 'stopped': the scan stopped its tests; 'failed': their own load of the page failed). Never in the
   * report: coverage that did not happen leaves no trace there. Observation only; must not throw.
   */
  onOptionalSkipped?: (e: OptionalSkip) => void;
  /**
   * The AI navigator (src/probes/plan.ts, src/ai/navigator.ts `createNavigator`): picks extra targets for the
   * tests that take them (menus, tabs, dialogs opened by plain elements, carousels, tooltips, forms without
   * a form element). The tests judge as always; it only adds targets. Off unless given.
   */
  navigator?: NavigatorHook;
  /** Diagnostics: the timing of each probe page group (see `ProbeGroupTiming`). */
  onProbeGroup?: (timing: ProbeGroupTiming) => void;
  /** Diagnostics: where each page width's time went in the audit (see `ViewportSteps`). */
  onViewportSteps?: (steps: ViewportSteps) => void;
  /**
   * Record once, test on the copy (docs/record-replay.md). 'off' (default): every load goes to the site,
   * as before. 'record-replay' (or its options): the first live answer to each GET or HEAD in any browser
   * context of the scan is recorded, and every later request for it (the other width, each test's own
   * page, the late pass, the report pictures, every extra browser session) is answered from that copy;
   * a request the copy cannot answer goes to the site as before, through the same gate, guards and
   * analytics blocking, and is recorded. A page load the copy answers whole takes no turn from the pace
   * controller. The report is the same either way. The snapshot is the scan's own and is cleared when
   * scanSite ends (`keep` leaves its store). Only what the browsers load: the scan's plain fetches
   * (robots.txt, sitemaps, documents) are made as before.
   */
  replay?: ReplayMode | ReplayOptions;
  /** What record and replay did, once, when scanSite ends (only with `replay` on). Observation only. */
  onReplay?: (stats: ReplayStats) => void;
  /**
   * Diagnostics (docs/scan-time-budget.md): where the whole scan's time went, once, when scanSite ends
   * (a scan that fails or pauses says what it measured so far). Off when absent: nothing is measured.
   */
  onTimeBudget?: (budget: TimeBudget) => void;
  /**
   * Evidence images for the report (report v2): screenshots of failures with callout boxes. The
   * JPEGs go to `sink`; `report.evidence` gets the metadata. Off when absent (no screenshots taken).
   */
  evidence?: EvidenceOptions;
  /**
   * Hosted use: the time (epoch ms) by which the scan must be done. When the site asks us to slow down
   * (HTTP 429 or 503, or a 403 after earlier pages loaded) or its robots.txt sets a Crawl-delay, no wait
   * is started that would end after it: the load fails with the reason, and the minimum-pages rule
   * decides whether the scan is scored. Without it waits are bounded only by their caps (20 s each,
   * 3 retries per load; Crawl-delay at most 10 s).
   */
  deadline?: number;
  /** Tuning of the politeness controller (tests shorten the backoff). */
  pace?: PaceTuning;
  /**
   * Live screenshots for a live view (only with `onEvent`): one first-screen JPEG per width of each
   * page that loaded and passed the navigation gate, sent to `sink` before that width's viewport-done,
   * which then carries `shot` (see `LiveShot` for how the wireframe maps onto it). Off when absent (no
   * screenshot taken). The report is the same with or without it.
   */
  liveShots?: LiveShotOptions;
  /**
   * Provisional `found` events this run may send one by one (default and most FOUND_EVENTS_MAX); past
   * it they are gathered (src/found.ts). A long scan's host passes what its earlier segments left, so
   * the whole scan's event log stays bounded.
   */
  foundBudget?: number;
  /**
   * Long scans (hosted 250-page and whole-site tiers): go on from an earlier run's pages. The page list
   * (as it had grown) and every page it audited, by index: those pages are not loaded again, and their
   * results go to the document checks, the core tests and the AI review as if audited now. Discovery
   * is not run again (robots.txt is read again for its rules and Crawl-delay). No events are sent for
   * the stored pages; the report is the same as one uninterrupted scan's.
   */
  resume?: ScanResume;
  /**
   * Checked before each page audit starts: true stops the scan between pages. The pages already
   * running finish, then scanSite rejects with `ScanPaused` (nothing after the pages runs). Resume with
   * `resume`.
   */
  pause?: () => boolean;
  /**
   * Audit the pages only (with the page collectors), then reject with `ScanPaused`: no document
   * checks, core tests or AI review hooks run, and every session audits pages. A later `resume` does
   * the work after the pages. Hosted long scans use it for every segment but the last.
   */
  pagesOnly?: boolean;
  /**
   * Checked once every page is done, before the work after the pages (core tests, documents, AI review,
   * report): true stops the scan there with ScanPaused, as `pagesOnly` does. A long scan's host uses it
   * to check lost pages again in a later run before the core tests.
   */
  pauseAfterPages?: () => boolean;
  /** Each page audited in this run (not the resumed ones), by index: a host keeps them for `resume`. */
  onPageAudited?: (page: PageAudit, index: number) => void;
  /** Sitemap files listed on other sites, not fetched: their count (a host logs it). */
  onSitemapsSkipped?: (count: number) => void;
  /**
   * The politeness controller's state for the site, when it changes: its Crawl-delay (robots.txt) and
   * its limit on loads at once (null: not slowed down). A host sizes its browser sessions by it.
   */
  onPaceState?: (state: { crawlDelayMs: number; limit: number | null }) => void;
  /** Long scans: the crawl added pages (or skipped some); the whole lists so far (a host keeps them for `resume`). */
  onPagesAdded?: (pages: readonly string[], skipped: readonly { url: string; reason: string }[]) => void;
  /**
   * Hosted: one more try, once the page pass is done, for the pages the site turned away (406, 429, a
   * challenge, a wait for a session its refusals took: `isLateRetryPage`). After a short cool-off, in a
   * fresh session, one page at a time, each page loaded once (no pace retries); the pass stops at its
   * first refusal. It runs only inside the time left: never past `deadline`, `lateRetry.by`, or the time
   * the work after the pages needs before `finishBy` (FINISH); without `finishBy` or `by` it never runs.
   * A page that loads is checked like any other (its rules, its core tests, the AI review) and replaces
   * its failed audit; a page refused again keeps its answer. Not run by a pages-only segment, nor when
   * `pauseAfterPages` stops the scan (a long scan's later segment does it, once).
   */
  lateRetry?: LateRetryOptions;
  /**
   * Monitoring scans (docs/monitoring.md): each page is first checked for changes since the monitor's
   * previous scan (sitemap lastmod, a conditional GET, the normalised HTML and the site's stylesheets and
   * scripts), cheapest first, through the scan's politeness controller; an unchanged page carries its
   * previous audit forward (`PageAudit.unchangedSince`) instead of loading in the browser. Every page
   * gets its `revision` (what the host keeps for the next scan) and the report its `incremental` counts.
   * The score covers every page and is the same as a full scan's.
   */
  incremental?: IncrementalOptions;
  /**
   * Tests: the slow-site timings (`SITE_TIMING`): the first-byte threshold, page timeouts, slow-site
   * concurrency and the discovery budgets.
   */
  timing?: Partial<SiteTiming>;
  /** The start page's measured speed, once known (a host logs it). */
  onStartSpeed?: (speed: StartSpeed) => void;
  /**
   * The start page's speed as the host already measured it (`measureStart`, hosted: before the browsers
   * launch, to size the scan's budget): the engine does not measure again.
   */
  startSpeed?: StartSpeed;
}

/** The late retry (`ScanOptions.lateRetry`): its cool-off and its bounds. */
export const LATE_RETRY = {
  /**
   * The cool-off before its first load. A rate limit or a bot filter that turned pages away counts
   * requests over a short window: Retry-After answers run from seconds to tens of seconds, and the pace
   * controller never waits more than 20 s at a time (PACE_DEFAULTS.maxWaitMs), so 20 s lets most such
   * windows pass. The fresh session launches meanwhile, so the cool-off rarely adds time of its own.
   */
  coolMs: 20_000,
  /** Longest the fresh session is waited for (hosted: one bounded launch, 45 s, and a margin). */
  sessionMs: 60_000,
  /** Least time left before the pass's limit to start a page (each audit is cut off at the limit). */
  minPageMs: 10_000,
} as const;

/** A fresh browser session for the late retry; `release` ends it (the engine does not wait for it). */
export interface LateSession {
  browser: BrowserLike;
  release(): Promise<void>;
}

export interface LateRetryOptions {
  /** A fresh browser session (hosted: a new Browser Rendering session), or null when none came. */
  session(): Promise<LateSession | null>;
  /** The pass starts, with `pages` to try (a host says so on the live view and remembers it). Must not throw. */
  onStart?(pages: number): void;
  /** The latest time (epoch ms) the pass may run until (a long segment's pages window). */
  by?: number;
  /** Tests: LATE_RETRY's times. */
  coolMs?: number;
  sessionMs?: number;
  minPageMs?: number;
}

/**
 * A page the late retry tries again: the site turned the scan away (406, 429, a challenge), or its audit
 * waited past the bound for a session the refusals were replacing. Never a page's own access rule (401,
 * 403), a broken page (404, 5xx), a lost browser or a time-out.
 */
export function isLateRetryPage(p: PageAudit): boolean {
  if (p.status !== 'failed') return false;
  if (p.reason === SESSION_WAIT_PAGE || p.reason === CHALLENGE_PAGE || p.reason === BOT_CHALLENGE) return true;
  const s = p.httpStatus;
  return s === 406 || s === 429 || (s !== undefined && isChallengeStatus(s));
}

/** Long scans: failing elements kept per rule per page (the page still counts as failing it). */
export const LONG_NODES_PER_RULE = 5;
/**
 * Long scans: the first pages whose cross-page consistency facts (not scored) and undecided elements
 * ("Not decided by axe", not scored) are kept; past them a page keeps what the score and the issue
 * list need.
 */
export const CONSISTENCY_PAGES_LONG = 100;
/**
 * Long scans: the AI review hears about the first this-many pages (in page order) and gathers its
 * candidates from them only, so what it holds does not grow with the page count. Past them a compact
 * audit keeps only what the engine itself needs (LONG_KEEP_COLLECTED).
 */
export const AI_PAGES_LONG = 25;
/** Collected data the engine reads after the pages (the media inventory, the core tests' sample, the platform signs of the first pages). */
const LONG_KEEP_COLLECTED = ['media', 'shape', 'platform'];
/**
 * Long scans: the first pages whose element kinds are kept (src/collect/kinds.ts): the pages the wider
 * coverage reaches (COVERAGE_PAGES_LONG), which are the ones the slow tests and the targeted checks can be
 * sent to. Past them a page keeps none, so what a long scan holds stays bounded.
 */
export const KINDS_PAGES_LONG = COVERAGE_PAGES_LONG;

/**
 * A long scan's page audit once the crawl, the document checks, the core tests and the AI review have
 * read it: without its links and document links, with at most LONG_NODES_PER_RULE failing (and
 * undecided) elements per rule, and its consistency facts only on the first CONSISTENCY_PAGES_LONG
 * pages. What the report needs from a page stays; thousands of pages then fit in a Worker's memory.
 * One exception: the undecided text the text-contrast test measures (`CONTRAST_RULES`) keeps the elements
 * that test takes (at most `TEXT_CONTRAST_LIMITS.elements`, 30, on the first CONSISTENCY_PAGES_LONG pages,
 * which are the pages it runs on: `EVERY_PAGE_CAP_LONG`); at most about 30 KB a page more.
 */
export function compactLong(p: PageAudit, index: number): PageAudit {
  const cap = (fs: PageAudit['violations']) => fs.map((f) => (f.nodes.length > LONG_NODES_PER_RULE ? { ...f, nodes: f.nodes.slice(0, LONG_NODES_PER_RULE) } : f));
  // The undecided text the text-contrast test measures (1.4.3: text over pictures and gradients) stays as that
  // test takes it, up to its own limit, desktop first (`undecidedTexts`): capped at the report's 5, the test
  // measured only the first 5 of a page (often a menu's icons) and called the rest of its text not shown.
  const undecided = (fs: PageAudit['incomplete']) => fs.map((f) => {
    if (!(CONTRAST_RULES as readonly string[]).includes(f.id)) return f.nodes.length > LONG_NODES_PER_RULE ? { ...f, nodes: f.nodes.slice(0, LONG_NODES_PER_RULE) } : f;
    const taken = new Set(undecidedTexts([f]).slice(0, TEXT_CONTRAST_LIMITS.elements).map((t) => t.target));
    const nodes = f.nodes.filter((n) => taken.delete(n.target));
    return nodes.length < f.nodes.length ? { ...f, nodes } : f;
  });
  let collected = p.collected;
  if (collected) {
    const { documentLinks: _links, ...rest } = collected;
    collected = Object.fromEntries(Object.entries(rest).filter(([k]) => LONG_KEEP_COLLECTED.includes(k)
      || (k === 'consistency' ? index < CONSISTENCY_PAGES_LONG : k === kindsCollector.id ? index < KINDS_PAGES_LONG : index < AI_PAGES_LONG)));
  }
  return { ...p, links: [], violations: cap(p.violations), incomplete: index < CONSISTENCY_PAGES_LONG ? undecided(p.incomplete) : [], ...(collected ? { collected } : {}) };
}

/**
 * What a long scan's host stores for a page (to resume from): the page as a later run needs it. The
 * links, document links and images stay (the crawl, the document checks and the alt-text reservoir read
 * them again); past the first
 * pages, the data only the first pages use (the AI review's, consistency facts, undecided elements)
 * goes, and failing elements are capped, as `compactLong` does. A resume from it gives the same report.
 */
export function storableLong(p: PageAudit, index: number): PageAudit {
  const c = compactLong(p, index);
  // What a resume reads again: the document links, and the images the alt-text reservoir takes from every page.
  const again = Object.fromEntries(['documentLinks', 'images'].filter((k) => p.collected?.[k] !== undefined).map((k) => [k, p.collected![k]]));
  return { ...c, links: p.links, ...(Object.keys(again).length ? { collected: { ...c.collected, ...again } } : {}) };
}

/** What a long scan's host kept from earlier runs (`ScanOptions.resume`). */
export interface ScanResume {
  pages: readonly string[];
  documents: readonly string[];
  skipped: readonly { url: string; reason: string }[];
  /** The stored audit of a page, by index; undefined: not audited yet. */
  audit(index: number): PageAudit | undefined;
  /** The first segment's start page measurement (`onStartSpeed`): a resume does not measure again. */
  startSpeed?: StartSpeed;
}

/** A scan stopped between pages (`pause`, `pagesOnly`): `audited` of `total` pages are done. */
export class ScanPaused extends Error {
  override name = 'ScanPaused';
  constructor(readonly audited: number, readonly total: number) {
    super(`The scan stopped between pages: ${audited} of ${total} audited`);
  }

  get remaining(): number {
    return this.total - this.audited;
  }
}

/** A page the site turned away (src/egress.ts `loadOutcome`; apps/worker/src/loadFailure.ts calls it blocked). */
function isRefusedLoad(p: PageAudit): boolean {
  if (p.status !== 'failed') return false;
  if (p.reason === CHALLENGE_PAGE || p.reason === BOT_CHALLENGE) return true;
  return p.httpStatus !== undefined && isRefusalStatus(p.httpStatus);
}

/** `settleBy`'s answer when the time came first. */
const TOO_LATE = Symbol('too late');

/** `p`'s value, or TOO_LATE once `until` (epoch ms) has passed; `p` is never cancelled, only no longer waited for. */
async function settleBy<T>(p: Promise<T>, until: number): Promise<T | typeof TOO_LATE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<typeof TOO_LATE>((r) => { timer = setTimeout(() => r(TOO_LATE), Math.max(0, until - Date.now())); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Waits until `until` (epoch ms), or less when `signal` aborts. */
function sleepUntil(until: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, until - Date.now()));
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Node-only (lazy import keeps `node:module` out of the Worker's code path). */
export async function defaultAxeSource(): Promise<string> {
  const { createRequire } = await import('node:module');
  return (createRequire(import.meta.url)('axe-core') as { source: string }).source;
}

export async function scanSite(start: string, opts: ScanOptions): Promise<SiteReport> {
  // However the scan ends, its politeness controller leaves no waiting turn and no timer behind.
  const stops: (() => void)[] = [];
  // Debug only (off by default): where the time went, said once however the scan ends.
  const said = opts.onTimeBudget ?? envTimeBudget();
  const budget = said ? { recorder: undefined as TimeBudgetRecorder | undefined, pages: { total: 0, ok: 0 } } : undefined;
  // Record and replay: one snapshot for the scan, cleared however it ends.
  const fromEnv = opts.replay === undefined ? envReplay() : undefined;
  const mode = opts.replay ?? fromEnv ?? 'off';
  const replay = mode === 'off' ? undefined : createReplay({ ...(typeof mode === 'object' ? mode : {}), ...(opts.allowIp ? { gateMark: true } : {}) });
  try {
    return await scanSiteRun(start, opts, stops, budget, replay);
  } finally {
    for (const stop of stops) stop();
    if (said && budget?.recorder) guard(() => said(budget.recorder!.summary(budget.pages)));
    if (replay) {
      const stats = replay.stats();
      // Bounded: letting the sessions go and clearing the store never holds the report.
      await settleBy(replay.close().catch(() => {}), Date.now() + REPLAY_CLOSE_MS);
      guard(() => opts.onReplay?.(stats));
      if (fromEnv) console.log(`GRNTED_REPLAY ${JSON.stringify(stats)}`);
    }
  }
}

/** Longest scanSite waits for record and replay to let go of its sessions and clear its snapshot. */
const REPLAY_CLOSE_MS = 10_000;

async function scanSiteRun(
  start: string, opts: ScanOptions, stops: (() => void)[],
  budget?: { recorder: TimeBudgetRecorder | undefined; pages: { total: number; ok: number } }, replay?: Replay,
): Promise<SiteReport> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const site = normalizeUrl(start);
  if (!site) throw new Error(`Invalid URL: ${start}`);
  if (opts.allowUrl && !(await opts.allowUrl(site))) throw new Error('That address is not allowed.');
  // The browser's own User-Agent with Granted's token (src/userAgent.ts): the one its client hints agree
  // with, sent on every page load and every plain fetch of the scan, and named in the report.
  const userAgent = opts.userAgent ?? (await scanUserAgent(opts.browser));
  const maxPages = Math.min(Math.max(opts.maxPages ?? 25, 1), MAX_PAGES_LIMIT);
  // Long scans (wide.ts): the crawl, long-scan de-duplication and a bounded every-page test sample.
  const wide = isWide(maxPages);
  // The page loop that can stop between pages and go on later (only long or resumable scans use it).
  const resumable = wide || !!opts.resume || !!opts.pause || !!opts.pagesOnly || !!opts.incremental;
  const axeSource = opts.axeSource ?? (await defaultAxeSource());
  const emit = safeEmit(opts.onEvent);
  // Hosted use: every document any context loads (each redirect hop too) is checked with allowUrl, and
  // the server address it came from with allowIp.
  // With several sessions, each is gated on its own (its own browser-level CDP session holds its windows).
  // A session whose window hold cannot be armed takes no work when there are others: its contexts
  // fail as lost work (`GATE_UNARMED`), so the pool moves the work and the scan never scores without it.
  const all = [opts.browser, ...(opts.sessions ?? [])];
  const tb = budget ? (budget.recorder = createTimeBudget(site)) : undefined;
  const gateOnly = (b: BrowserLike) => (opts.allowUrl || opts.allowIp
    ? gatedBrowser(b, opts.allowUrl ?? (async () => true), {
      ...(opts.allowIp ? { allowIp: opts.allowIp } : {}),
      ...(all.length > 1 ? { unarmed: 'lost' as const } : {}),
      ...(replay?.gateMark ? { replayed: replay.gateMark } : {}),
    })
    : b);
  // Below the gate, so the gate's own page and context wrappers stay outermost; record and replay sits
  // right under it (its route is the context's first, so every guard added later decides before it).
  const timed = (b: BrowserLike) => (tb ? tb.browser(b) : b);
  const gate = (b: BrowserLike) => gateOnly(replay ? replay.browser(timed(b)) : timed(b));
  // A site that refuses even a session that loaded it is refusing the scan: one page at a time from then
  // on (`pace` is made below; this is only called once loads run).
  const sessions = sessionPool(all.map(gate), {
    ...(opts.egress ? { egress: opts.egress } : {}),
    // An answer the scan's own copy gave says nothing about which sessions the site lets in.
    ...(replay ? { copied: (answer: unknown) => replay.copied(answer) } : {}),
    onSiteRefuses: () => pace.hold(1, 'refused'),
  });
  // Discovery, the page audits and the evidence pass; the core tests use `sessions.probe`.
  const browser = sessions.audit;

  const concurrency = Math.min(Math.max(Math.floor(opts.concurrency ?? 6), 1), 16);
  // One politeness controller for every load from the site (src/pace.ts): when it says slow down, the
  // whole scan does. Only timing and the outcome of loads change, never the page selection.
  const paceState = () => {
    if (!opts.onPaceState) return;
    const host = new URL(site).host;
    guard(() => opts.onPaceState!({ crawlDelayMs: pace.summary()?.crawlDelayMs ?? 0, limit: pace.limit(host) }));
  };
  const pace = createPace({
    ...opts.pace, concurrency,
    // Pages at once adapt between these (src/pace.ts ADAPTIVE), within the host's share.
    start: Math.min(concurrency, Math.max(1, Math.floor(opts.startConcurrency ?? concurrency))),
    ...(opts.concurrencyCap ? { cap: opts.concurrencyCap } : {}),
    ...(opts.onConcurrency ? { onAdapt: (e: PaceAdapt) => guard(() => opts.onConcurrency!(e)) } : {}),
    ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
    ...(tb ? { onTiming: tb.pace } : {}),
    // A page load the scan's own copy answers whole waits for no turn (src/replay).
    ...(replay ? { replayed: (url: string) => replay.ready(url), copied: (answer: unknown) => replay.copied(answer) } : {}),
    ...(emit || opts.onPaceState ? {
      onChange: (c) => paceState() ?? emit?.(c.step === 'slowed'
        ? {
          type: 'pace', step: 'slowed', status: c.status,
          detail: c.file
            ? c.status === 0
              ? 'The site stopped sending a page’s stylesheet (no usable answer): pausing before loading pages that need it'
              : `The site asked us to slow down (HTTP ${c.status}) when sending a page’s stylesheet: pausing before loading pages that need it`
            : `The site asked us to slow down (HTTP ${c.status}): checking one page at a time, with pauses`,
        }
        : { type: 'pace', step: 'recovered', detail: `The site is answering normally again: back to ${c.concurrency} ${c.concurrency === 1 ? 'page' : 'pages'} at a time` }),
    } : {}),
  });

  stops.push(() => pace.stop());
  if (opts.signal?.aborted) pace.stop();
  else opts.signal?.addEventListener('abort', () => pace.stop(), { once: true });
  opts.onProgress?.({ phase: 'discover', done: 0, total: 0 });
  // The start page's first byte, bounded, beside robots.txt and the sitemaps (siteSpeed.ts): a site that
  // slows us gets longer page timeouts and fewer pages at once.
  const timing = siteTiming(opts.timing);
  // A resumed segment of a long scan has its first segment's measurement: the start page is not asked again.
  const known = opts.startSpeed ?? opts.resume?.startSpeed;
  const startSpeed = known
    ? Promise.resolve({ ...known })
    : measureStart(site, { userAgent, fetchFn: opts.fetchFn, allowUrl: opts.allowUrl, timing, pace });
  // Monitoring scans: the sitemaps' lastmods, read by discovery (a resumed segment has the host's copy).
  const lastmods = opts.incremental && !opts.resume ? new Map<string, string>() : undefined;
  const selection = opts.resume
    ? {
      pages: [...opts.resume.pages], documents: [...opts.resume.documents], skipped: opts.resume.skipped.map((x) => ({ ...x })),
      isAllowed: (await readRobots(new URL(site).origin, { userAgent, fetchFn: opts.fetchFn, allowUrl: opts.allowUrl, pace, timing })).isAllowed,
    }
    : await discoverPages(site, {
      browser, maxPages, userAgent, fetchFn: opts.fetchFn, allowUrl: opts.allowUrl, pace, ...(emit ? { onEvent: emit } : {}), ...(lastmods ? { lastmods } : {}),
      startSpeed, timing, ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
      // A monitoring scan that carries pages forward keeps its previous scan's pages (no page is read for links).
      ...(opts.incremental?.previous && !incrementalIsFull(opts.incremental) ? { known: opts.incremental.previous.pages.map((p) => p.url) } : {}),
      refusedRetry: (url: string) => sessions.refusedRetry(url),
      ...(opts.onSitemapsSkipped ? { onSitemapsSkipped: (n: number) => guard(() => opts.onSitemapsSkipped!(n)) } : {}),
    });
  if (!selection.pages.length) selection.pages.push(site);
  tb?.mark('discovered');
  paceState();
  const speed = await startSpeed;
  if (opts.onStartSpeed) guard(() => opts.onStartSpeed!({ ...speed }));
  // A site that slows us (or challenges us) is not sent more slow requests at once than it answers.
  const pageConcurrency = slowing(speed) ? Math.min(concurrency, timing.slowConcurrency) : concurrency;
  // The page gate judges "comfortable" against the start page's first byte; a slow site never goes up.
  pace.baseline(speed.firstByteMs);
  if (slowing(speed)) pace.hold(pageConcurrency);
  if (lastmods && opts.incremental?.onLastmods) guard(() => opts.incremental!.onLastmods!(Object.fromEntries(lastmods)));

  // A fixed-size worker pool; each result lands at its page's index, so output order never
  // depends on which page finishes first.
  let total = selection.pages.length;
  const ai = opts.ai;
  // Evidence images (report v2): one recorder per scan, shared by the evidence pass and the probes.
  // Without a sink there is no recorder and no screenshot is taken for the report.
  const recorder = opts.evidence ? createEvidenceRecorder(opts.evidence, undefined, ai ? AI_EVIDENCE_RESERVE : 0) : undefined;
  // The probes' pictures wait here until their runs are final and the evidence pass is done.
  const pool = recorder ? createProbeEvidencePool() : undefined;
  // Probes run on the template sample, starting while the remaining pages are still being audited.
  let pagesAudited = false;
  const probeList = opts.probes === false ? [] : (opts.probes ?? PROBES).filter((p) => p.tier === 'core' || opts.full);
  // The live view's stage events (only with a listener; sent only once every page is done).
  const stage = emit ? stageEvents(emit) : undefined;
  // The live view's provisional results so far (src/found.ts): each page audit, test run and AI item as
  // it finishes, until scoring. Observation only.
  let foundOpen = true;
  const pageIndex = (url: string) => { const i = selection.pages.indexOf(url); return i < 0 ? undefined : i; };
  const found = emit ? foundTracker((e) => { if (foundOpen) emit(e); }, pageIndex, opts.foundBudget) : undefined;
  if (found && ai?.watch) guard(() => ai.watch!((check, findings) => guard(() => found.ai(check, findings))));
  // The AI review hears about each probe run as it completes (`run.data` carries the probe's evidence);
  // the live view hears which test starts and ends on which page, with the real counts.
  // Public what, private how (Paul, 2026-11-03): the live view says how far along the tests are, never
  // how many test runs the sample has. Since the "Now" line (Paul, 2026-11-05) it names the test that
  // just started and its page, as the report does once the scan ends.
  // Whole tests as `units` (tests finished on every page they were given, of the tests queued): the
  // test names a scan runs are public (the report lists them), its test runs are not.
  const testsUnits = () => { const t = probes!.tests(); return { done: t.done, total: t.queued }; };
  // The live view's "Now" line: the test that just started and its page (public: the report names
  // both), on at most STAGE_NOW_MAX events, so the progress cap is left for the AI review.
  let nowSent = 0;
  const testsSaid = (now?: { check: string; page?: number }) => {
    if (!stage?.isOpen() || !probes) return;
    const c = percent({ done: probes.counts().done, total: probes.counts().queued });
    const withNow = now && nowSent < STAGE_NOW_MAX ? (nowSent++, { now }) : {};
    stage.progress('tests', `Running the automated tests: ${c.done}%`, { ...c, units: testsUnits(), ...withNow });
  };
  // Every run as it completes: a stage stopped for want of time keeps the runs it finished.
  const finishedRuns: ProbeRun[] = [];
  // The finish plan's stops (src/finishPlan.ts): the deep tests first, then every test.
  const testsStop = new AbortController();
  const deepStop = new AbortController();
  const onRun = ai?.onProbeRun || stage || opts.finishBy !== undefined
    ? (run: ProbeRun) => {
      finishedRuns.push(run);
      // The AI review hears the runs it always heard (the sample's, and four tests' on every page): the
      // runs added for coverage are not its evidence (`TemplateProbes.aiHears`).
      if (ai?.onProbeRun && (probes?.aiHears(run) ?? true)) guard(() => ai.onProbeRun!(run));
      if (found) guard(() => found.run(run));
      guard(() => testsSaid());
    }
    : undefined;
  // The caller's cancellation reaches the tests too (as the finish plan's stops do).
  if (opts.signal) {
    const stopTests = () => { deepStop.abort(); testsStop.abort(); };
    if (opts.signal.aborted) stopTests();
    else opts.signal.addEventListener('abort', stopTests, { once: true });
  }
  // Coverage (src/probes/components.ts): each page's element kinds, so the slow tests go to the pages with
  // something new, and an element of a kind that failed a slow test is measured on the other pages that carry it.
  const kinds = opts.coverage === false ? undefined : componentKinds();
  // The extra coverage runs are not started once the work that must fit before `finishBy` needs the time
  // (FINISH: the report, the least time for the tests, the deep tests' margin and, with an AI review, its wait).
  const fin = { ...FINISH, ...opts.finishTiming };
  const optionalUntil = opts.finishBy === undefined ? undefined
    : opts.finishBy - (fin.reportMs + fin.minTestsMs + fin.deepMarginMs + (ai ? fin.aiMs + fin.aiPicturesMs : 0));
  /** What every test load of the scan shares: the tests' runner and the targeted checks' runner. */
  const runnerOptions: ProbeRunnerOptions = {
    userAgent, full: opts.full, pace, axeSource, ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
    ...kinds?.hooks, ...(optionalUntil !== undefined ? { optionalUntil: () => optionalUntil } : {}),
    ...(opts.onOptionalSkipped ? { onOptionalSkipped: (e: OptionalSkip) => guard(() => opts.onOptionalSkipped!(e)) } : {}),
    // A page load the site refused in one session is tried again in another (src/sessions.ts).
    refusedRetry: (url: string) => sessions.refusedRetry(url, 'probe'),
    // Room lent as the audits end never takes the tests past what the pages at once of the moment
    // would open (each page audit is one context per width): at the start's 4, the 8 of before.
    lendLimit: () => VIEWPORTS.length * pace.pages().limit,
    // Once every page is audited, each test load takes a page-gate turn beside the evidence pass's; an optional
    // test's load the low turn, which gives way to every other load (queue rule 8).
    loadTurn: () => (pagesAudited ? pace.page() : undefined),
    optionalLoadTurn: () => (pagesAudited ? pace.page({ low: true }) : undefined),
    // Once every page is audited, the optional tests may open more tabs: the room the audits had, or the host's.
    optionalTabs: () => (!pagesAudited ? 0 : opts.optionalTabs !== undefined ? opts.optionalTabs : VIEWPORTS.length * pace.pages().limit),
    maxSlots: MAX_TEST_TABS,
    ...(opts.finishBy !== undefined || opts.signal ? { signal: testsStop.signal, deepSignal: deepStop.signal } : {}),
    // A site that slows us: the core tests' loads get the slow page timeout and as few at once as the pages.
    ...(slowing(speed) ? { loadTimeoutMs: timing.slowPageTimeoutMs, concurrency: timing.slowConcurrency } : {}),
    ...(recorder && pool ? { evidence: recorder, evidencePool: pool } : {}),
    // The time budget (debug only) counts the targeted checks' groups too.
    ...(tb ? { onGroup: (t: ProbeGroupTiming) => tb.group(t) } : {}),
  };
  // The targeted checks (src/probes/componentCheck.ts) run on a runner of their own, after every other test,
  // all of it optional work: the keyboard test's check of single elements, and the cheap tests sent whole.
  // Their runs are not handed to the AI review or the live view: they are added when the tests are done.
  const checkProbes = kinds ? [
    ...(probeList.some((p) => p.id === keyboardCheckProbe.id) ? [keyboardCheckProbe] : []),
    ...probeList.filter((p) => CHECKS[p.id]?.send === 'test' && (p.tier === 'core' || opts.full)),
  ] : [];
  const checker = kinds && checkProbes.length ? createProbeRunner(sessions.probe, checkProbes, { ...runnerOptions, full: true }) : undefined;
  const probes = probeList.length && !opts.pagesOnly
    ? templateProbes(createProbeRunner(sessions.probe, probeList, {
      ...runnerOptions,
      ...(opts.navigator ? { navigator: opts.navigator } : {}),
      // The AI review that asks for them gets the elements the tests' undecided and failing findings name.
      ...(ai?.elementFacts ? { elementFacts: true } : {}),
      ...(opts.onProbeGroup || tb ? { onGroup: (t: ProbeGroupTiming) => { tb?.group(t); opts.onProbeGroup?.(t); } } : {}),
      ...(onRun ? { onRun } : {}),
      ...(ai?.onProbeRun ? { aiEvidence: true } : {}),
      ...(stage ? { onStart: (st: { probe: string; page: string }) => guard(() => testsSaid({ check: st.probe, ...(pageIndex(st.page) !== undefined ? { page: pageIndex(st.page)! } : {}) })) } : {}),
    }), undefined, wide ? EVERY_PAGE_CAP_LONG : undefined, kinds ? { kinds, ...(wide ? { pageCap: NOVELTY_PAGE_CAP_LONG, reach: COVERAGE_PAGES_LONG } : {}), ...(checker ? { checker } : {}) } : undefined)
    : undefined;
  const collectors = uniqueCollectors([
    // A pages-only run collects what its resume's core tests will need (the page shapes) too.
    ...DEFAULT_COLLECTORS, ...(probes || (opts.pagesOnly && probeList.length) ? [shapeCollector, ...(opts.coverage === false ? [] : [wide ? kindsCollectorFor(KINDS_PAGES_LONG) : kindsCollector])] : []), ...(opts.collectors ?? []), ...(ai?.collectors ?? []),
  ]);
  // Document probes and PDF checks start as each page finishes, overlapping the remaining audits.
  const docs = createDocumentInventory({
    site, userAgent, fetchFn: opts.fetchFn, allowUrl: opts.allowUrl, isAllowed: selection.isAllowed, documents: opts.documents, pace,
    ...(opts.documentStore ? { store: opts.documentStore } : {}),
    ...(opts.readPdf ? { readPdf: opts.readPdf } : {}),
    ...(opts.aiRefetch !== undefined ? { aiRefetch: opts.aiRefetch } : {}),
    // Only an AI review that asks for documents gets them (and only then are PDFs read in detail).
    ...(ai?.onDocument ? { onDocument: (doc, bytes, details) => guard(() => ai.onDocument!(doc, bytes, details)) } : {}),
    ...(stage ? {
      onPdfDone: (c: { done: number; started: number }) => {
        if (stage.isOpen()) stage.progress('documents', `PDF checks: ${c.done} of ${c.started} done`, { done: c.done, total: c.started, found: docs.found() });
      },
    } : {}),
  });
  // The start page turned us away in discovery and nothing else is known (crawl.ts `refusedStart`):
  // that answer is its audit. It is not loaded again, and the scan ends from there.
  const refusedStart = 'refusedStart' in selection ? selection.refusedStart : undefined;
  const auditIn = (b: BrowserLike, i: number, url: string, onEvent: ((e: ScanEvent) => void) | undefined, how: Pace = pace) => auditPage(b, url, {
    userAgent, axeSource, collectors, index: i, pace: how, timeoutMs: pageTimeoutFor(speed, timing, opts.deadline, Date.now()),
    ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
    // Monitoring scans: the browser's own load gives the page's validators and HTML (no second request).
    ...(opts.incremental ? { document: true } : {}),
    ...(opts.onViewportSteps || tb ? { onSteps: (st: ViewportSteps) => { tb?.viewport(st); opts.onViewportSteps?.(st); } } : {}),
    ...(onEvent ? { onEvent, ...(opts.liveShots ? { liveShots: opts.liveShots } : {}) } : {}),
  });
  const auditAt = async (i: number, url: string): Promise<PageAudit> => {
    if (refusedStart && i === 0) {
      emit?.({ type: 'page-done', index: i, url, status: 'failed', score: null, rules: [], reason: refusedStart.reason });
      return { url, status: 'failed', reason: refusedStart.reason, httpStatus: refusedStart.status, rules: {}, violations: [], incomplete: [], links: [] };
    }
    // A failed try's page-done waits for the page's last try (a retry follows it): one per page.
    let held: ScanEvent | undefined;
    const pageEmit = emit
      ? (e: ScanEvent) => {
        if (e.type === 'page-done' && e.index === i && e.status === 'failed') {
          held = e;
          return;
        }
        if (e.type === 'page-done' && e.index === i) held = undefined;
        emit(e);
      }
      : undefined;
    const audit = (b: BrowserLike) => auditIn(b, i, url, pageEmit);
    // The browser closed under the audit (a remote session that ended): audited again, once, in a
    // new context (a host that reopens the browser gives a new one). Still lost: the page says so,
    // and the report gives no score (BROWSER_LOST_PAGE), never one without the page.
    // A page that waited for a session past the bound (src/sessions.ts SESSION_WAIT) is not audited again
    // (it would wait as long again), and it is never a lost browser (review r1: that would take the
    // scan's score): it is not checked, said as such (SESSION_WAIT_PAGE), and `waited` says so.
    const once = async (b: BrowserLike): Promise<{ page: PageAudit; waited: boolean }> => {
      let p = await audit(b);
      if (p.status === 'failed' && isSessionWait(p.reason)) return { page: { ...p, reason: SESSION_WAIT_PAGE }, waited: true };
      if (p.status === 'failed' && isWorkLost(p.reason)) p = await audit(b);
      if (p.status === 'failed' && isSessionWait(p.reason)) return { page: { ...p, reason: SESSION_WAIT_PAGE }, waited: true };
      const lost = p.status === 'failed' && isWorkLost(p.reason);
      return { page: lost ? { ...p, reason: BROWSER_LOST_PAGE } : p, waited: false };
    };
    let page = (await once(browser)).page;
    // The site refused the load (a refusing status or a challenge): tried again in a session that has
    // not refused it, when there is one (src/sessions.ts); the same audit, through the same pace. A retry
    // that found no session in time leaves the page with the site's answer (staging 5b4986ad).
    for (let n = 0; n < REFUSED_RETRIES && isRefusedLoad(page); n++) {
      const other = await sessions.refusedRetry(url);
      if (!other) break;
      const again = await once(other);
      if (again.waited) break;
      page = again.page;
    }
    if (held) emit?.(held);
    // A load time-out on a site that slows us is the site slowing us, not a plain time-out.
    if (page.status === 'failed' && page.reason) {
      const reason = slowedReason(speed, page.reason);
      if (reason !== page.reason) page = { ...page, reason };
    }
    return page;
  };
  // Monitoring scans: a page that has not changed carries its previous audit forward (no browser load).
  const inc = opts.incremental ? createIncrementalRun({
    options: opts.incremental, site, startedAt, userAgent, isAllowed: selection.isAllowed, pace,
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}), ...(opts.allowUrl ? { allowUrl: opts.allowUrl } : {}),
    lastmods: opts.incremental.lastmods ?? Object.fromEntries(lastmods ?? []),
    list: () => selection.pages, known: (i) => opts.resume?.audit(i),
  }) : undefined;
  const auditOrCarry = inc
    ? async (i: number, url: string): Promise<PageAudit> => {
      let d: IncrementalDecision | null = null;
      try {
        d = await inc.decide(i, url);
      } catch {
        d = null; // unsure: audited
      }
      if (d?.kind === 'carry') return d.page;
      return inc.audited(i, await auditAt(i, url), d);
    }
    : auditAt;
  /**
   * A page the late retry got: in place of its failed audit, and to everything that heard of that one
   * (the long scan's store, the live view's results, the documents, the core tests, the AI review), as
   * if it had loaded the first time. Each of those keys on the page's index, so the page counts once.
   */
  const reconsume = (i: number, page: PageAudit) => {
    const kept = wide ? compactLong(page, i) : page;
    pages[i] = kept;
    if (resumable) guard(() => opts.onPageAudited?.(page, i));
    if (found) guard(() => found.page(page, i));
    guard(() => docs.addPage(i, page));
    probes?.pageAudited(kept, i);
    if (ai && (!wide || i < AI_PAGES_LONG)) guard(() => ai.onPageAudited(kept, { index: i, done: total, total, site }));
    else if (ai?.bounded) guard(() => ai.onPageAudited(page, { index: i, done: total, total, site, sampleOnly: true }));
  };
  /**
   * The late retry (`ScanOptions.lateRetry`): one more try for the pages the site turned away, once the
   * page pass is done. Every wait is bounded: the cool-off and the fresh session by the pass's limit
   * (and `sessionMs`), each page's audit cut off at the limit (its session is then released, which ends
   * what is left of it), and the release never waited for.
   */
  const latePass = async (lr: LateRetryOptions): Promise<void> => {
    if (opts.signal?.aborted) return;
    const todo = pages.flatMap((p, i) => (p && isLateRetryPage(p) ? [i] : []));
    if (!todo.length) return;
    const t = { ...LATE_RETRY, ...(lr.coolMs !== undefined ? { coolMs: lr.coolMs } : {}), ...(lr.sessionMs !== undefined ? { sessionMs: lr.sessionMs } : {}), ...(lr.minPageMs !== undefined ? { minPageMs: lr.minPageMs } : {}) };
    // Inside the time left: never past the deadline or the host's limit, and the work after the pages keeps
    // all it plans for (FINISH: the report, the core tests' least time and, with an AI review, its wait).
    const fin = { ...FINISH, ...opts.finishTiming };
    const after = fin.reportMs + fin.minTestsMs + (ai ? fin.aiMs + fin.aiPicturesMs : 0);
    const limit = Math.min(lr.by ?? Infinity, opts.deadline ?? Infinity, opts.finishBy === undefined ? Infinity : opts.finishBy - after);
    if (!Number.isFinite(limit) || limit - Date.now() < t.minPageMs) return;
    guard(() => lr.onStart?.(todo.length));
    // The fresh session launches during the cool-off; one that comes after the wait for it is released.
    let gaveUp = false;
    const asked = Promise.resolve().then(() => lr.session()).catch(() => null);
    void asked.then((s) => { if (gaveUp && s) release(s); });
    await sleepUntil(Math.min(limit, Date.now() + t.coolMs), opts.signal);
    const s = await settleBy(asked, Math.min(limit, Date.now() + t.sessionMs));
    if (s === TOO_LATE || !s) {
      gaveUp = true;
      return;
    }
    // One load per page (no retries), sent even to a host the pace gave up on; every other load still sees the give-up.
    const once: Pace = { ...pace, load: (url, run, answer, o) => pace.load(url, run, answer, { ...o, retries: 0, again: true }) };
    try {
      const b = gate(s.browser);
      for (const i of todo) {
        if (opts.signal?.aborted || limit - Date.now() < t.minPageMs) break;
        if (!(await lateOne(b, i, limit, once))) break;
      }
    } finally {
      release(s);
    }
  };
  /** The release of a late session: never waited for (the host bounds it). */
  const release = (s: LateSession) => {
    void Promise.resolve().then(() => s.release()).catch(() => {});
  };
  /**
   * One page of the late retry, cut off at `limit`. The live view hears its widths and one page-done:
   * the new audit when it loaded, else the page's answer as it stands. False: the pass stops (the site
   * refused it again, or the session is not usable).
   */
  const lateOne = async (b: BrowserLike, i: number, limit: number, how: Pace): Promise<boolean> => {
    const before = pages[i]!;
    const url = selection.pages[i] ?? before.url;
    let open = true;
    let started = false;
    let held: ScanEvent | undefined;
    const onEvent = emit
      ? (e: ScanEvent) => {
        if (!open) return;
        if (e.type === 'page-done' && e.index === i) { held = e; return; }
        if (e.type === 'viewport-start') started = true;
        emit(e);
      }
      : undefined;
    const r = await settleBy(auditIn(b, i, url, onEvent, how).catch((err: unknown): PageAudit => ({
      url, status: 'failed', reason: err instanceof Error ? err.message.split('\n')[0]!.slice(0, 200) : 'The browser could not open a page', rules: {}, violations: [], incomplete: [], links: [],
    })), limit);
    open = false;
    if (r === TOO_LATE || r.status !== 'ok') {
      if (started) emit?.({ type: 'page-done', index: i, url, status: 'failed', score: null, rules: [], ...(before.reason ? { reason: before.reason } : {}) });
      return r !== TOO_LATE && !isRefusedLoad(r) && !isSessionWait(r.reason) && !isWorkLost(r.reason);
    }
    let page = r;
    if (inc) page = await inc.audited(i, page, null).catch(() => page);
    if (held) emit?.(held);
    reconsume(i, page);
    return true;
  };
  let pages: PageAudit[];
  if (!resumable) {
    // A fixed-size worker pool; each result lands at its page's index, so output order never
    // depends on which page finishes first.
    pages = new Array<PageAudit>(total);
    let next = 0;
    let done = 0;
    // `pageConcurrency` workers, each taking a turn from the page gate (pages at once adapt) before a page.
    // A worker that ran a page when the list ran out lends its room to the probes; one that only waited does not.
    const worker = async (): Promise<void> => {
      while (next < total) {
        const slot = await pace.page();
        if (next >= total) {
          slot.release();
          return;
        }
        const i = next++;
        // AI checks hear about each page as it starts and finishes, so model calls overlap the
        // remaining pages instead of running after them.
        if (ai?.onPageStarted) guard(() => ai.onPageStarted!({ started: next, total }));
        const url = selection.pages[i]!;
        slot.url(url);
        try {
          pages[i] = await auditAt(i, url);
        } finally {
          slot.release();
        }
        const page = pages[i];
        done++;
        if (found) guard(() => found.page(page, i));
        guard(() => docs.addPage(i, page));
        probes?.pageAudited(page, i);
        if (ai) guard(() => ai.onPageAudited(page, { index: i, done, total, site }));
        opts.onProgress?.({ phase: 'audit', done, total, url });
      }
      // This worker's pages are done: the probes may use its room in the browser.
      probes?.auditWorkerDone();
    };
    await Promise.all(Array.from({ length: Math.min(pageConcurrency, total) }, worker));
  } else {
    // A segment that stops here (paused, or pages only) sends what its found tracker gathered first.
    pages = await longPages({
      site, maxPages, concurrency: pageConcurrency, slot: () => pace.page(), wide, list: selection.pages, skipped: selection.skipped, isAllowed: selection.isAllowed,
      stored: opts.resume ? (i) => opts.resume!.audit(i) : () => undefined,
      audit: auditOrCarry,
      ...(opts.pause ? { pause: opts.pause } : {}),
      // Pages only: every session audits pages from the start (no core tests wait for one).
      ...(opts.pagesOnly ? { start: () => sessions.pagesDone() } : {}),
      consume: (i, page, kept, total, done, fresh) => {
        if (fresh) guard(() => opts.onPageAudited?.(page, i));
        if (fresh && found) guard(() => found.page(page, i));
        if (opts.pagesOnly) return;
        guard(() => docs.addPage(i, page));
        probes?.pageAudited(kept, i);
        // A long scan's AI review hears about its first AI_PAGES_LONG pages; past them only its bounded
        // checks do (the alt-text reservoir, the scored one), with the page as audited (Grok r2-5).
        if (ai && (!wide || i < AI_PAGES_LONG)) guard(() => ai.onPageAudited(kept, { index: i, done, total, site }));
        else if (ai?.bounded) guard(() => ai.onPageAudited(page, { index: i, done, total, site, sampleOnly: true }));
      },
      started: (started, total) => {
        if (!opts.pagesOnly && ai?.onPageStarted) guard(() => ai.onPageStarted!({ started, total }));
      },
      progress: (done, total, url) => opts.onProgress?.({ phase: 'audit', done, total, url }),
      added: (list, skipped) => guard(() => opts.onPagesAdded?.(list, skipped)),
      workerDone: () => probes?.auditWorkerDone(),
    }).catch((e: unknown) => { if (found) guard(() => found.flush()); throw e; });
    total = pages.length;
    if (found) guard(() => found.flush());
    if (opts.pagesOnly) throw new ScanPaused(total, total);
    let stop = false;
    guard(() => { stop = opts.pauseAfterPages?.() === true; });
    if (stop) throw new ScanPaused(total, total);
  }
  // One more try for the pages the site turned away, now that the pass is done (bounded; see lateRetry).
  if (opts.lateRetry) await latePass(opts.lateRetry);
  tb?.mark('pages');
  if (budget) budget.pages = { total: pages.length, ok: pages.filter((p) => p?.status === 'ok').length };
  // Every page is audited: the work left (core tests, pictures) may use every browser session, and
  // the core tests' loads share the page gate with the evidence pass.
  sessions.pagesDone();
  pagesAudited = true;
  if (found) guard(() => found.flush());

  opts.onProgress?.({ phase: 'documents', done: 0, total: 0 });
  // The finish plan (src/finishPlan.ts): with `finishBy`, the work after the pages ends in time, what
  // does not fit stopped or skipped (lowest value first) and listed in the report.
  const plan: FinishPlan | undefined = opts.finishBy !== undefined ? planFinish(Date.now(), opts.finishBy, { ai: !!ai, ...(opts.finishTiming ? { timing: opts.finishTiming } : {}) }) : undefined;
  const grace = opts.finishTiming?.graceMs ?? 5_000;
  const cut = new Map<FinishStage, boolean>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  /** `fn` at `t` (epoch ms). */
  const at = (t: number, fn: () => void) => { timers.push(setTimeout(fn, Math.max(0, t - Date.now()))); };
  /** `p`, or `fallback` once `t` (epoch ms) has passed (the stage is then cut: `stageCut` is set). */
  /**
   * `p`, or `fallback` once `t` (epoch ms) has passed (the stage is then cut: `stageCut` is set). A `lazy`
   * fallback is taken at that moment (what the stage has done by then).
   */
  const within = <T>(p: Promise<T>, t: number | undefined, fallback: T | { lazy: () => T }, stageCut?: FinishStage): Promise<T> => {
    const give = () => (typeof fallback === 'object' && fallback !== null && 'lazy' in fallback ? (fallback as { lazy: () => T }).lazy() : fallback as T);
    if (t === undefined) return p;
    return new Promise<T>((resolve) => {
      let settled = false;
      const id = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (stageCut) cut.set(stageCut, cut.get(stageCut) ?? false);
        resolve(give());
      }, Math.max(0, t - Date.now()));
      timers.push(id);
      p.then((v) => { if (!settled) { settled = true; clearTimeout(id); resolve(v); } }, () => { if (!settled) { settled = true; clearTimeout(id); resolve(give()); } });
    });
  };
  // Every page is done: from here the live view hears what really runs until the scoring (progress
  // only once each stage's start has gone out, below).
  const docsDone = docs.finish({ documents: selection.documents, ...(plan ? { by: plan.docsBy } : {}) });
  const mediaDone = buildMediaInventory(pages, {
    ...opts.media, fetchFn: opts.media?.fetchFn ?? opts.fetchFn, userAgent, allowUrl: opts.allowUrl, ...(plan ? { by: plan.docsBy } : {}),
  });
  // finish() queues the rest of the sample at once, so the counts read after it are the final total.
  const testsDone = probes?.finish();
  let testsSettled = false;
  void testsDone?.then(() => { testsSettled = true; }, () => { testsSettled = true; });
  if (plan && testsDone) {
    // The deep tests stop first, then every test; a stop that came while tests were still running is listed.
    at(plan.deepBy, () => { if (!testsSettled) deepStop.abort(); });
    at(plan.testsBy, () => { if (!testsSettled) testsStop.abort(); });
  }
  if (stage) {
    if (probes && testsDone) {
      stage.start('tests', 'Running the automated tests', { ...percent({ done: probes.counts().done, total: probes.counts().queued }), units: testsUnits() });
      void testsDone.then(() => {
        if (found) guard(() => found.flush());
        stage.done('tests', 'Automated tests done', { done: 100, total: 100, units: testsUnits() });
      }, () => {});
    }
    if (opts.documents !== false) {
      const c = docs.pdfs();
      stage.start('documents', c.started ? `Checking documents: ${c.done} of ${c.started} PDF checks done` : 'Checking the document links', { done: c.done, total: c.started, found: docs.found() });
      void docsDone.then((inv) => {
        const k = docs.pdfs();
        stage.done('documents', `Documents done: ${inv.documents.length} found, ${inv.stats.pdfsChecked} ${inv.stats.pdfsChecked === 1 ? 'PDF' : 'PDFs'} checked`, { done: k.done, total: k.started, found: inv.documents.length });
      }, () => {});
    }
    // The inventory only waits on the network when it asks YouTube or Vimeo about captions.
    if (opts.media && asksPlatforms(opts.media)) {
      stage.start('media', 'Checking which videos have captions');
      void mediaDone.then((items) => stage.done('media', `Video and audio: ${items.length} found`), () => {});
    }
    if (recorder) stage.start('pictures', 'Taking pictures of the problems for the report');
    stage.open();
  }
  /** The tests were still running when their time came (some results are missing, not cancelled). */
  let testsLeft = false;
  // Past the documents' time (and its grace), the inventory as it stands: every PDF checked so far stays
  // in the report, never an empty one (Grok r2 #1).
  const docsNow = { lazy: () => { try { return docs.snapshot(); } catch { return { documents: [...selection.documents].sort(), checks: [], notPages: [], stats: { probes: 0, pdfsChecked: 0, officeChecked: 0 } } as InventoryResult; } } };
  const [inventory, media, probeRuns, held] = await Promise.all([
    // Past their time (and a short grace to hand back what they have), each stage gives what it has.
    within(docsDone, plan && plan.docsBy + grace, docsNow, 'documents').then((r) => (opts.documentBase ? mergeInventory(r, opts.documentBase) : r)),
    within(mediaDone, plan && plan.docsBy + grace, []),
    // Stopped tests hand back their runs at once; one stuck in a page load is left, with the runs finished so far.
    testsDone ? within(testsDone, plan && plan.testsBy + grace, null as ProbeRun[] | null).then((r) => {
      if (r) return r;
      testsLeft = true;
      // What finish would give from the runs that finished: cross-page findings computed on them, the
      // carried and capped runs, and the runs that never came back marked not tested (timeLimit).
      return probes ? probes.partial(finishedRuns) : [...finishedRuns];
    }) : undefined,
    // The evidence pass: the start page and one image per axe rule (problem order, as many as the cap
    // could hold), beside the inventories and probes. Held, not recorded: the pool records them with
    // the core tests' pictures so every problem gets one before any gets a second.
    // It plans no more rule pictures than can be recorded beside one picture per criterion the probes
    // have pictured so far (each one is a page reload, ahead of the probes' loads).
    recorder ? within(holdEvidencePass(browser, {
      pages, rules: ruleSummaries(pages), userAgent, concurrency: Math.max(1, Math.min(pageConcurrency, pace.pages().limit)), pace,
      room: recorder.room('pass') - Math.min(pool?.criteria() ?? 0, recorder.room('probe')),
    }), plan?.picturesBy, { start: [], rules: [], missed: [] } as HeldPass, 'pictures') : undefined,
  ]);
  // Tests the plan stopped: a stage is listed when some of its runs were cancelled (or never came back).
  const tierOf = (id: string) => probeList.find((p) => p.id === id)?.tier ?? 'core';
  const stopped = (r: ProbeRun) => r.findings.some((f) => f.detail === CANCELLED);
  for (const [st, tier, ctl] of [['deep-tests', 'deep', deepStop], ['core-tests', 'core', testsStop]] as const) {
    if (!ctl.signal.aborted && !(testsLeft && st === 'core-tests')) continue;
    const mine = (probeRuns ?? []).filter((r) => (tierOf(r.probe) === 'core') === (tier === 'core'));
    if (mine.some(stopped) || (testsLeft && st === 'core-tests') || (tier === 'deep' && opts.full && !mine.length && probeList.some((p) => p.tier !== 'core'))) cut.set(st, mine.some((r) => !stopped(r)));
  }
  // A documents check past its time: a PDF left unchecked says so; listed when any was.
  // (Decided from what is reported: a stage the deadline cut whose PDFs all have an outcome is not listed.)
  if (plan && inventory.checks.some((c) => c.notChecked === TIME_LIMIT_REACHED)) cut.set('documents', inventory.checks.some((c) => c.checks));
  else cut.delete('documents');
  // A selected address that turned out to be a document (e.g. an extensionless /download/<token>)
  // is not a failed page: it leaves the page list, so it never counts towards the score or the
  // "too few pages loaded" rule.
  const notPages = new Set(inventory.notPages.map((p) => p.url));
  const scanned = notPages.size ? pages.filter((p) => !notPages.has(p.url)) : pages;
  const documents = inventory.documents;
  const keptRuns = probeRuns ? (notPages.size ? probeRuns.filter((r) => !notPages.has(r.page)) : probeRuns) : undefined;
  // The axe pass's and the core tests' pictures, fairly shared, and the core tests' start page marks.
  const pass: HeldPass | undefined = held && notPages.size ? { ...held, rules: held.rules.filter((s) => !notPages.has(s.shot.page)) } : held;
  if (recorder && pool) addHomeMarks(recorder, await within(pool.commit(keptRuns ?? [], recorder, scanned[0]?.url, pass), plan && Math.max(plan.testsBy + grace, Date.now() + grace), []));
  if (recorder) stage?.done('pictures', `${recorder.shots().length} pictures for the report`);
  let aiReport: AiReport | undefined;
  // The AI review: skipped when the plan leaves it no time (unless the stages before it ended early).
  const aiRoom = plan ? plan.aiBy - Date.now() : Infinity;
  const aiSkipped = !!ai && !!plan && (plan.skipAi ? aiRoom < (opts.finishTiming?.aiMs ?? 45_000) / 3 : aiRoom <= 0);
  if (ai && aiSkipped) cut.set('ai-review', false);
  if (ai && !aiSkipped) {
    opts.onProgress?.({ phase: 'review', done: 0, total: 0 });
    // A page tap with no review behind it (`reviews: false`) gets no AI stage in the live view.
    const said = stage && ai.reviews !== false ? stage : undefined;
    let open = true;
    let last: StageCounts | undefined;
    const onProgress = said
      ? (p: AiProgress) => {
        // Only while finish() runs: a review that ran past its time says nothing afterwards.
        if (!open) return;
        last = { ...percent({ done: p.checksDone, total: p.checks }), units: { done: Math.max(0, Math.floor(p.checksDone)), total: Math.max(0, Math.floor(p.checks)) } };
        said.progress('ai', aiDetail(p), { ...last, now: { check: p.check } });
      }
      : undefined;
    said?.start('ai', 'Running the AI review');
    // Stopped at the plan's time (its outstanding calls too), and the caller's own signal still applies.
    const aiStop = new AbortController();
    const onCallerAbort = () => aiStop.abort();
    opts.aiSignal?.addEventListener('abort', onCallerAbort, { once: true });
    if (opts.aiSignal?.aborted) aiStop.abort();
    if (plan) at(plan.aiBy, () => aiStop.abort());
    try {
      // `by`: the plan's end for the review, so its slow checks (documents, media) stop in time and the rest counts.
      // `probeRuns`: the tests' runs as the report scores them, for a review that looks again at the scan's failures.
      const out = await within(ai.finish({ site, pages: scanned, documents, ...(keptRuns ? { probeRuns: keptRuns } : {}), signal: aiStop.signal, ...(plan ? { by: plan.aiBy } : {}), ...(onProgress ? { onProgress } : {}) }), plan && plan.aiBy + grace, undefined);
      // A review stopped by the plan is not a result.
      aiReport = plan && aiStop.signal.aborted && !opts.aiSignal?.aborted ? undefined : out;
      if (plan && aiStop.signal.aborted && !opts.aiSignal?.aborted) cut.set('ai-review', false);
    } catch {
      // The AI review is an optional extra; the scored report stands without it.
      aiReport = undefined;
    } finally {
      opts.aiSignal?.removeEventListener('abort', onCallerAbort);
    }
    open = false;
    said?.done('ai', aiReport ? 'AI review done' : 'The AI review ended without a result', last);
  }
  // Thumbnails of the images the AI review flagged (they exist only now), with the room left.
  if (recorder && aiReport && (!plan || plan.aiPicturesBy > Date.now())) {
    // Said only when the pass has pictures to take (it plans none when the review flagged nothing).
    let planned = false;
    await within(runEvidencePass(browser, recorder, {
      pages: scanned, ai: aiReport, start: false, userAgent, concurrency: pageConcurrency, pace,
      ...(stage ? {
        onPlanned: (n: number) => {
          planned = true;
          stage.start('pictures', `Taking ${n === 1 ? 'a picture' : 'pictures'} of images the AI review flagged`);
        },
      } : {}),
    }), plan?.aiPicturesBy, undefined, 'pictures');
    if (planned) stage?.done('pictures', `${recorder.shots().length} pictures for the report`);
  }
  for (const id of timers) clearTimeout(id);
  // The stages stopped or skipped for want of time, in the plan's order of value (lowest first).
  const notChecked = (['pictures', 'deep-tests', 'ai-review', 'documents', 'core-tests'] as const)
    .filter((st) => cut.has(st))
    .map((st) => ({ stage: st, detail: notCheckedLine(st, cut.get(st) === true) }));
  opts.onProgress?.({ phase: 'done', done: total, total });
  if (found) guard(() => found.flush());
  foundOpen = false;
  if (emit) {
    const loaded = scanned.filter((p) => p.status === 'ok').length;
    emit({ type: 'scoring', step: 'weighting', detail: `Scoring the results of ${loaded} of ${scanned.length} ${scanned.length === 1 ? 'page' : 'pages'}` });
  }
  const paced = pace.summary();
  const report = buildReport({
    ...(wide ? { consistencyPages: CONSISTENCY_PAGES_LONG } : {}),
    site, pages: scanned, documents, documentChecks: inventory.checks, media, skipped: [...selection.skipped, ...inventory.notPages],
    ...(opts.documentScore === false ? { scoreDocuments: false } : {}),
    startedAt, finishedAt: now().toISOString(), userAgent,
    // The review goes into the report with the package that scores it (`AiScanPlan.report`); without one it is left out.
    ...(aiReport && ai?.report ? { ai: aiReport, extension: ai.report } : {}),
    ...(recorder ? { evidence: recorder.shots() } : {}),
    ...(pass?.missed.length ? { evidenceMissed: pass.missed.filter((m) => !notPages.has(m.page)) } : {}),
    ...(paced ? { pace: { ...paced, ...paceFailures(scanned) } } : {}),
    // `data` is evidence for the AI review only; the report keeps the summarised runs.
    ...(keptRuns ? { probeRuns: keptRuns.map(({ data: _data, elements: _elements, ...run }) => run) } : {}),
    // The screen-reader excerpts come from the runs' data before it is dropped.
    ...(keptRuns && scanned[0] ? { screenReader: screenReaderSection(keptRuns, scanned[0].url, undefined, listenerFlaggedPages(aiReport)) } : {}),
    ...(opts.incremental ? { incremental: incrementalSummary(scanned, !!opts.incremental.full || !opts.incremental.previous) } : {}),
    ...(notChecked.length ? { notChecked } : {}),
  });
  if (emit) {
    emit({ type: 'scoring', step: 'writing', detail: 'Writing the report' });
    emit({
      type: 'done', status: report.status, score: report.score, letter: report.letter, headline: report.headline,
      critical: report.rules.filter((r) => r.impact === 'critical').length,
    });
  }
  return report;
}

/** Pages that failed because of the site's pace, and of those, the ones left out for want of their styles. */
function paceFailures(pages: readonly PageAudit[]): { failedPages: number; unstyledPages?: number } {
  const failed = pages.filter((p) => p.status === 'failed' && isPaceReason(p.reason));
  const unstyled = failed.filter((p) => isUnstyledReason(p.reason)).length;
  return { failedPages: failed.length, ...(unstyled ? { unstyledPages: unstyled } : {}) };
}

/** Test starts the live view's "Now" line names, at most, per scan (within STAGE_PROGRESS_MAX). */
export const STAGE_NOW_MAX = 150;

/** Most `progress` stage events per scan (each stage's `start` and `done` are always sent). */
export const STAGE_PROGRESS_MAX = 400;

/** A stage event's counts; `found` only for the documents stage (documents found so far); `units` for tests and ai. */
interface StageCounts { done: number; total: number; found?: number; units?: { done: number; total: number }; now?: { check: string; page?: number } }

/**
 * The live view's stage events: nothing before `open()` (every page done), progress capped, details
 * clipped. A progress event that says the same as the stage's last event is not sent (staging 2026-11-04:
 * the tests stage repeated its percentage hundreds of times, spending the cap before the AI review spoke).
 */
export function stageEvents(emit: (e: ScanEvent) => void) {
  let opened = false;
  let progress = 0;
  const last = new Map<ScanStage, string>();
  const build = (stage: ScanStage, step: 'start' | 'progress' | 'done', detail: string, counts?: StageCounts): Extract<ScanEvent, { type: 'stage' }> => {
    const text = detail.length > STAGE_DETAIL_MAX ? `${detail.slice(0, STAGE_DETAIL_MAX - 1)}…` : detail;
    return {
      type: 'stage', stage, step, detail: text,
      ...(counts ? { done: counts.done, total: counts.total } : {}),
      ...(counts?.found !== undefined ? { found: counts.found } : {}),
      ...(counts?.units ? { units: { done: counts.units.done, total: counts.units.total } } : {}),
      ...(counts?.now ? { now: { check: counts.now.check, ...(counts.now.page !== undefined ? { page: counts.now.page } : {}) } } : {}),
    };
  };
  const said = (e: Extract<ScanEvent, { type: 'stage' }>) => JSON.stringify([e.detail, e.done, e.total, e.found, e.units, e.now]);
  const send = (stage: ScanStage, step: 'start' | 'progress' | 'done', detail: string, counts?: StageCounts) => {
    const e = build(stage, step, detail, counts);
    last.set(stage, said(e));
    emit(e);
  };
  return {
    open: () => { opened = true; },
    isOpen: () => opened,
    start: (stage: ScanStage, detail: string, counts?: StageCounts) => send(stage, 'start', detail, counts),
    progress(stage: ScanStage, detail: string, counts?: StageCounts) {
      if (!opened || progress >= STAGE_PROGRESS_MAX) return;
      if (last.get(stage) === said(build(stage, 'progress', detail, counts))) return;
      progress++;
      send(stage, 'progress', detail, counts);
    },
    done: (stage: ScanStage, detail: string, counts?: StageCounts) => send(stage, 'done', detail, counts),
  };
}

/**
 * The AI review's progress in one plain line: the check's name and how far along it is, never how many
 * items it reviews (its sample) or how many checks the review has.
 */
function aiDetail(p: AiProgress): string {
  const check = String(p.check).slice(0, 70);
  return p.reviewed !== undefined && p.sample !== undefined
    ? `Reviewing ${check}: ${percent({ done: p.reviewed, total: p.sample }).done}%`
    : `${check} done`;
}

/**
 * A stage's progress as a percentage (`done` of `total: 100`): the live view's bar keeps its share, and
 * the event never carries the real counts of test runs or AI checks.
 */
function percent(c: { done: number; total: number }): { done: number; total: number } {
  const done = c.total > 0 && Number.isFinite(c.done) ? Math.max(0, Math.min(100, Math.floor((100 * c.done) / c.total))) : 0;
  return { done, total: 100 };
}

/** AI callbacks must never break the page audits. */
function guard(fn: () => void): void {
  try {
    fn();
  } catch {
    // ignored: see AiScanPlan
  }
}

interface LongPagesOptions {
  site: string;
  maxPages: number;
  /** Workers; each takes a turn from `slot` (the page gate) before a page. */
  concurrency: number;
  slot(): Promise<PageSlot>;
  /** Long-scan crawl: the audited pages' links grow the list (wide.ts). */
  wide: boolean;
  /** The page list (grown in place by the crawl), and the skipped list (the crawl adds to it). */
  list: string[];
  skipped: { url: string; reason: string }[];
  isAllowed: (url: string) => boolean;
  stored(index: number): PageAudit | undefined;
  audit(index: number, url: string): Promise<PageAudit>;
  pause?: () => boolean;
  start?: () => void;
  /** Every page's result in turn, stored ones first (`fresh` false), with the running counts. */
  consume(index: number, page: PageAudit, kept: PageAudit, total: number, done: number, fresh: boolean): void;
  started(started: number, total: number): void;
  progress(done: number, total: number, url: string): void;
  added(list: readonly string[], skipped: readonly { url: string; reason: string }[]): void;
  workerDone(): void;
}

/**
 * The page audits of a long or resumable scan. Stored pages (a resume) are taken first, in page order,
 * and never loaded again; then a pool of `concurrency` workers audits the rest. With `wide`, the crawl
 * appends the links of page i (same site, pages robots.txt allows, one per long-scan key, at most
 * PER_SHAPE_MAX per shape) once every page before it is done, so the list is the same whatever order
 * the audits finish in; it stops at `maxPages`. `pause()` true stops the workers between pages: the
 * pages running finish, then this rejects with ScanPaused.
 */
async function longPages(o: LongPagesOptions): Promise<PageAudit[]> {
  const { list } = o;
  const results: (PageAudit | undefined)[] = [];
  const links = new Map<number, string[]>();
  const filter = o.wide ? wideFilter() : undefined;
  if (filter) for (const u of list) filter.seen(u);
  // Robots-blocked links: the first MAX_CRAWL_ROBOTS_SKIPPED listed, the rest counted in one record
  // (a site whose pages link to thousands of blocked addresses grew the list, its storage and the report
  // without bound). The count is not stored: a resumed segment replays the stored pages' links and
  // counts them again.
  let moreRecord = o.skipped.find(isRobotsMoreRecord);
  let robotsListed = o.skipped.filter((x) => x.reason === ROBOTS_SKIP_REASON).length;
  let robotsMore = 0;
  // Links the crawl may already have taken (robots-blocked or past the shape cap): never listed twice.
  if (filter) for (const x of o.skipped) if (x !== moreRecord && !isActionMoreRecord(x) && x.reason !== ACTION_SKIP_REASON) filter.seen(x.url);
  filter?.recorded(o.skipped);
  // Addresses that look like actions are never added (url.ts `isActionLikeUrl`): listed, bounded, each once.
  const actions = actionSkips(o.skipped, o.site);
  let frontier = 0;
  let done = 0;
  let running = 0;
  let wake: (() => void) | null = null;
  const signal = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const grow = () => {
    if (!filter) return;
    const before = list.length;
    const skippedBefore = o.skipped.length;
    while (frontier < list.length && results[frontier] !== undefined) {
      const found = links.get(frontier) ?? [];
      links.delete(frontier);
      frontier++;
      for (const raw of found) {
        if (list.length >= o.maxPages) break;
        const href = wideNormalize(raw, o.site);
        if (!href || isDocumentUrl(href) || !sameSite(href, o.site) || !isLikelyHtml(href)) continue;
        if (isActionLikeUrl(href, o.site)) {
          actions.add(href);
          continue;
        }
        const verdict = filter.admit(href);
        if (verdict === 'duplicate') continue;
        if (verdict === 'shape') {
          const record = filter.shapeRecord(href);
          if (record) o.skipped.push(record);
        } else if (!o.isAllowed(href)) {
          if (robotsListed < MAX_CRAWL_ROBOTS_SKIPPED) {
            o.skipped.push({ url: href, reason: ROBOTS_SKIP_REASON });
            robotsListed++;
          } else {
            robotsMore++;
            if (!moreRecord) o.skipped.push((moreRecord = { url: o.site, reason: robotsMoreReason() }));
          }
        } else list.push(href);
      }
    }
    if (list.length > before || o.skipped.length > skippedBefore) o.added(list, o.skipped);
  };
  const take = (i: number, page: PageAudit, fresh: boolean) => {
    if (filter) links.set(i, page.links);
    done++;
    // A long scan keeps the compact audit: the document checks read the whole page, the rest the compact one.
    const kept = o.wide ? compactLong(page, i) : page;
    results[i] = kept;
    o.consume(i, page, kept, list.length, done, fresh);
    grow();
  };
  // Stored pages first, in page order (the crawl replays their links the same way).
  for (let i = 0; i < list.length; i++) {
    const page = o.stored(i);
    if (page) take(i, page, false);
  }
  o.start?.();
  let next = 0;
  let paused = false;
  const pickNext = (): number | null => {
    while (next < list.length && results[next] !== undefined) next++;
    return next < list.length ? next++ : null;
  };
  const exhausted = () => {
    while (next < list.length && results[next] !== undefined) next++;
    return next >= list.length;
  };
  const worker = async (): Promise<void> => {
    for (;;) {
      if (o.pause?.()) {
        paused = true;
        break;
      }
      // Nothing left and nothing the crawl could still add: done (and the probes may use this room).
      if (exhausted() && !(running > 0 && filter && list.length < o.maxPages)) break;
      const slot = await o.slot();
      if (o.pause?.()) {
        slot.release();
        paused = true;
        break;
      }
      const i = pickNext();
      if (i === null) {
        slot.release();
        // The crawl may still add pages once the ones running are done.
        if (running > 0 && filter && list.length < o.maxPages) {
          await new Promise<void>((r) => {
            const prev = wake;
            wake = () => {
              prev?.();
              r();
            };
          });
          continue;
        }
        // Only waited for a turn: it held no room in the browser to lend.
        return;
      }
      running++;
      o.started(i + 1, list.length);
      const url = list[i]!;
      slot.url(url);
      try {
        const page = await o.audit(i, url);
        take(i, page, true);
        o.progress(done, list.length, url);
      } finally {
        slot.release();
        running--;
        signal();
      }
    }
    o.workerDone();
  };
  await Promise.all(Array.from({ length: o.concurrency }, worker));
  const audited = results.filter((x) => x !== undefined).length;
  if (paused && audited < list.length) throw new ScanPaused(audited, list.length);
  if (moreRecord && robotsMore > 0) moreRecord.reason = robotsMoreReason(robotsMore);
  actions.end();
  return results as PageAudit[];
}
