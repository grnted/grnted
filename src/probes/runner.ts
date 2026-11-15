// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Runs the probes on the template sample: a fresh, guarded browser context per page and probe set,
// every probe under a hard time box. Engine core: no Node-only imports.
import { isRefusalStatus } from '../challenge.js';
import { REFUSED_RETRIES, isResponseCodeFailure, navigationOf } from '../egress.js';
import { VIEWPORTS } from '../report/build.js';
import { createProbeEvidencePool, type ProbeEvidencePool } from '../evidence/probePool.js';
import { forgetBusy } from './ready.js';
import type { EvidenceRecorder } from '../evidence/recorder.js';
import { documentGate, documentRefused, gateStopsLoad } from '../navigationGate.js';
import { LANDING_UNCHECKED, OTHER_SITE, QUIET_MS, bindLanding, isOtherSite, landingFailure, markDocument, watchLanding, within, type LandingWatch } from '../landing.js';
import { gotoPolitely, isUnstyledReason, type Pace } from '../pace.js';
import { refusedSince, watchStyles, type StyleWatch } from '../styles.js';
import { watchPictureFiles, type PictureFileStore } from './pictureFiles.js';
import type { BrowserLike, CDPSessionLike, ContextLike, CriterionStatus, PageAudit, PageLike, ProbeFinding, ProbeLoadFailure, ProbeRun } from '../types.js';
import { cleanFindingData, createRunEvidence, type RunEvidence } from './evidence.js';
import { stoppedSince } from './layout.js';
import { BROWSER_LOST, cdpSession, GATE_LOST, isBrowserGone, isWorkLost, pageGone, settlesWithin } from '../reconnect.js';
import { isSessionWait, SESSION_WAIT_PAGE } from '../sessions.js';
export { BROWSER_LOST } from '../reconnect.js';
import { guardStop, installGuard, isBackgroundWrite, isLocalAddress, routeWebSocketsEarly, sameDocument, type Guard, type SandboxMode } from './guard.js';
import { listenerHookScript, newPopupNonce, readHooks, readListeners } from './listeners.js';
import { LATE_CONTENT_MS, waitForMount } from './mounting.js';
import { capturePlanInput, plannedFor, resolvePlan, type NavigatorHook, type PlanEvent, type TargetPlan } from './plan.js';
import { elementFacts } from './elementFacts.js';
import { PROBE_DATA_MAX_CHARS, ProbeNotTestable, setRunAttachment, type GuardEvent, type PageProbe, type ProbeContext, type ProbeContextOptions } from './types.js';

export { PROBE_DATA_MAX_CHARS };

/** A page to probe: its address, its position in the scan order and the audit's collector output. */
export interface ProbeTarget {
  url: string;
  index: number;
  collected?: PageAudit['collected'];
  /** What axe could not decide on the page in the audit. */
  incomplete?: PageAudit['incomplete'];
}

export interface ProbeRunnerOptions {
  userAgent: string;
  /** The scan's absolute deadline, shared by page loads, settling and identity checks. */
  deadline?: number;
  /** axe-core's source, for tests that run axe again on the page they changed (`ProbeContext.axeSource`). */
  axeSource?: string;
  /**
   * A page load the site refused (a refusing HTTP status): a browser to load it again in, a
   * session that has not refused it (src/sessions.ts `refusedRetry`), at most REFUSED_RETRIES times
   * per run of a probe set; null when there is none (the runs then report the page did not load).
   */
  refusedRetry?: (url: string) => Promise<BrowserLike | null>;
  /** Cancels the runs: probes not yet finished report "the scan was cancelled". */
  signal?: AbortSignal;
  /**
   * Cancels the deep probes only (the scan's finish plan stops them before the core ones,
   * src/finishPlan.ts): deep runs not yet finished report "the scan was cancelled".
   */
  deepSignal?: AbortSignal;
  /** Also run the deep probes. */
  full?: boolean;
  /**
   * Browser contexts open at once (each runs one probe set on one page). Default 4; `lend` adds more
   * as the audit frees room, up to `MAX_PROBE_SLOTS`.
   */
  concurrency?: number;
  /**
   * The most contexts the runner keeps open beyond `concurrency` (the scan's pages at once of the
   * moment, its page gate): read before each context opens, so a pool lent up comes back down when the
   * limit drops; never below `concurrency`. Absent: `MAX_PROBE_SLOTS`.
   */
  lendLimit?: () => number;
  /**
   * A turn to take for each page load (the scan's page gate, `Pace.page`, once the audits are done):
   * the core tests' loads and the evidence pass's then share one budget of pages at once. Undefined:
   * no turn for this load. A turn that is refused (the scan stopped) fails the load.
   */
  loadTurn?: () => Promise<{ release(): void }> | undefined;
  /** Wait after the load event before the first probe. Default 1000 ms. */
  settleMs?: number;
  /** Time box for loading the page. Default 30 s. */
  loadTimeoutMs?: number;
  /** The popup sandbox for the pages under test (see `GuardOptions.sandbox`). Default 'auto'. */
  popupSandbox?: SandboxMode;
  /** Called with each run as it completes (any order), e.g. to pass `run.data` to the AI review. Must not throw. */
  onRun?(run: ProbeRun): void;
  /**
   * An AI review listens to the runs (`AiScanPlan.onProbeRun`): probes may then take pictures for it
   * (`ProbeContext.aiEvidence`, `attach`). Neutral: without it no probe takes a picture for the review.
   */
  aiEvidence?: boolean;
  /** Called as each probe starts on a page (its page is loaded), for a live view. Must not throw. */
  onStart?(start: { probe: string; page: string }): void;
  /** Diagnostics: called with the timing of each page group when it ends (any order). Must not throw. */
  onGroup?(timing: ProbeGroupTiming): void;
  /**
   * The scan's evidence recorder (report v2). With it, each run's context gets `evidence`, and the
   * pictures of runs that end `ok` wait in the evidence pool until the runs are final. Without it no
   * evidence image is taken.
   */
  evidence?: EvidenceRecorder;
  /**
   * Where the pictures wait (`src/evidence/probePool.ts`). Given: the caller commits it (the scan does,
   * after the evidence pass). Not given: the runner makes one and commits it in `finish`.
   */
  evidencePool?: ProbeEvidencePool;
  /**
   * The scan's politeness controller (`src/pace.ts`): each page load waits its turn and is tried again
   * after a pause when the site refused it. Without it pages load at once, as before.
   */
  pace?: Pace;
  /**
   * The AI navigator (src/probes/plan.ts): for each page with a test that takes planned targets
   * (`PageProbe.usesPlan`), the page is loaded once more in a context of its own (desktop width, the guard
   * and the listener hook as for any test), summarised and photographed, and the navigator picks extra
   * targets from that summary. Those tests wait for the plan within `budgetMs` and then run as before, with
   * the planned targets after their own. Without it nothing changes.
   */
  navigator?: NavigatorHook;
  /**
   * Coverage lane (src/probes/components.ts), both observation only: a hook that throws, rejects or takes
   * longer than `HOOK_MS` is left behind, and no result depends on it.
   * `onPageOpened`: a page was loaded for a group of tests, before its first test starts.
   * `onFindings`: a test returned its findings (as it gave them), while its page still shows what it tested.
   */
  onPageOpened?: (page: PageLike, target: ProbeTarget) => Promise<void> | void;
  onFindings?: (page: PageLike, probe: PageProbe, target: ProbeTarget, findings: readonly ProbeFinding[]) => Promise<void> | void;
  /**
   * Record the elements each run's failed, not-testable and flagged findings name (`ProbeRun.elements`,
   * src/probes/elementFacts.ts), read from the test's page when it is done: one bounded read, no request. For an AI
   * review that asks for them (`AiScanPlan.elementFacts`); without it nothing more is read.
   */
  elementFacts?: boolean;
  /**
   * Optional runs (`ProbeRunner.add` with `optional`) are not started from this time on (epoch ms). They are
   * extra coverage: one that does not fit is left out without a trace, never reported as cut short. Checked
   * before each optional test starts, not only when its job starts.
   */
  optionalUntil?: () => number | undefined;
  /**
   * Tabs (contexts) optional runs may open beyond the room the required runs have (`concurrency` and what
   * was lent), read before each start (perf/split-tests, 2026-11-10): most of the optional tests wait on
   * timers, animations and focus moves, so several share a browser. Required runs never use them. A throw,
   * a non-number or less than 0 is 0. Default 0 (the scan gives some once every page is audited).
   */
  optionalTabs?: () => number;
  /**
   * The page-gate turn for an optional run's load (src/pace.ts `page({ low: true })`: it gives way to every
   * other load, and counts against the same pages at once, so more tabs never mean more loads at once on the
   * site). Undefined: `loadTurn`.
   */
  optionalLoadTurn?: () => Promise<{ release(): void }> | undefined;
  /** Most contexts open at once, lent room and optional tabs included. Default `MAX_TEST_TABS`. */
  maxSlots?: number;
  /**
   * Diagnostics: optional tests that were queued and did not run, with why. Never in a report (an optional
   * test that did not happen leaves no trace there); for a host's log and for timing runs. Must not throw.
   */
  onOptionalSkipped?: (e: OptionalSkip) => void;
}

/**
 * Optional tests that run together as one job (`ProbeRunner.add` `units`): a novelty group's tests, say.
 * Each unit is a job of its own per context group, which any free tab can take with a load of its own. A
 * `rider` unit is cheap (less than a page load): it is never started on its own while its page has a required
 * job of the same context group, and runs on that job's page once its required tests are done instead (no
 * second load), or as a job of its own when it may not start then. Optional tests in no unit are one unit
 * per context group, as before units existed.
 */
export interface OptionalUnit {
  probes: readonly string[];
  rider?: boolean;
}

/**
 * Optional tests of one page that did not run (`ProbeRunnerOptions.onOptionalSkipped`). `why`: 'cutoff' their
 * time was over (`optionalUntil`), asked before the page is opened and again immediately before each test
 * starts; 'stopped' the scan stopped its tests or its deep tests; 'failed' their own load of the page failed,
 * was refused or challenged, or the run was cut.
 */
export interface OptionalSkip {
  page: string;
  probes: string[];
  why: 'cutoff' | 'stopped' | 'failed';
}

/** A run's options inside the runner: the scan's, and for optional work the question asked before each test. */
interface RunOptions extends ProbeRunnerOptions {
  /**
   * Optional work only: asked immediately before the test starts (after its page load, its wait for the
   * page's plan and the page's own settling). False: the test is not started.
   */
  admit?: () => boolean;
}

/** Longest a coverage hook (`onPageOpened`, `onFindings`) is waited for. */
export const HOOK_MS = 1500;

/** Where a page group's time went (epoch ms and durations in ms), for timing runs. */
export interface ProbeGroupTiming {
  page: string;
  index: number;
  probes: string[];
  /** When the group was queued, got a slot and ended. */
  queuedAt: number;
  startedAt: number;
  endedAt: number;
  /** Opening contexts (with the guard and hooks), loading pages and the settle waits, summed over every load of the group. */
  openMs: number;
  loadMs: number;
  settleMs: number;
  loads: number;
  /** Each probe's own time. */
  probeMs: Record<string, number>;
  /**
   * Probes given the page loaded again in a fresh context because an earlier probe had run its timers
   * early (`PageProbe.freshAfterFiredTimers`): the time that load took, by probe (part of its `probeMs`).
   */
  freshMs?: Record<string, number>;
}

export const PROBE_DEFAULTS = { concurrency: 4, settleMs: 1000, loadTimeoutMs: 30_000 } as const;
/** The desktop audit viewport (1280×900). */
export const DEFAULT_PROBE_VIEWPORT = { width: VIEWPORTS[0]!.width, height: VIEWPORTS[0]!.height };

const STATUSES = new Set<CriterionStatus>(['failed', 'flagged', 'no_failures_found', 'not_applicable', 'not_testable']);

/** A JSON copy of a probe's data, or undefined when it is missing, not JSON or too large. */
export function probeData(data: unknown): unknown {
  if (data === undefined) return undefined;
  try {
    const json = JSON.stringify(data);
    if (json === undefined || json.length > PROBE_DATA_MAX_CHARS) return undefined;
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}
const MAX_FINDINGS = 200;
export const CANCELLED = 'the scan was canceled before this test finished';
/** A run that never came back before the scan's time limit (`ProbeRunner.unfinished`). */
export const TIME_LEFT = 'the scan ran out of time before this test finished on this page';
export const NO_GUARD = 'the browser could not install the request guard, so the test was not run';
/** `popupSandbox: 'always'` and the browser could not open the CDP session the popup sandbox needs. */
export const NO_SANDBOX = 'the browser could not load the page in the popup sandbox (no CDP session), so the test was not run';
/**
 * A clean result that does not stand: the browser could not be told to refuse new windows on the page
 * (no CDP session, a session lost while the test ran, or a page that ended on a local address the
 * sandbox is not used on, when the page under test is not at one).
 */
export const UNSANDBOXED = 'the browser could not be told to refuse new windows on this page, so a clean result cannot be trusted';
/**
 * No result stands: the scan checks every address a page loads (`ScanOptions.allowUrl`), and the
 * browser could not be told to check each document and redirect hop, and to keep each new window from
 * loading anything (no CDP session: the page is not loaded at all; or one lost while the test ran).
 */
export const NO_DOCUMENT_GATE = 'the browser could not be told to check each page and frame address (and each redirect) before loading it, so no result on this page can be trusted';
/** A page (or a frame of it) that came from a server address `ScanOptions.allowIp` refuses: no result stands. */
/** A page whose stylesheet the site refused (throttling us): it renders unstyled, which is not the page people get. */
export const UNSTYLED_PAGE = 'the site refused the page’s stylesheet, so the page could not load its styles and was not tested without them';
export const REFUSED_PAGE = 'the page came from a server address that is not allowed, so nothing measured on it stands';
/**
 * Said with a failed fresh load (`PageProbe.freshAfterFiredTimers`): why this test needed the page loaded
 * again, after the load's own reason.
 */
export const FRESH_AFTER_TIMERS = 'loaded again for this test, because an earlier test on this page had already run its timers early';
/** A page that went to another document between two probes (see `runGroup`). */
export const LEFT_BY_ITSELF = 'the page loaded another page by itself, so this test was not run on it';
/** A page that went to another document while a probe ran (not the probe's own load): nothing it found stands. */
export const LOADED_DURING = 'the page loaded another page by itself while this test ran, so its results do not stand';
/** The page did not say which document it showed after a probe (it did not answer): nothing it found stands. */
export const UNCONFIRMED = 'the page did not answer when the test was over, so it could not be confirmed that the results are of the page, and they do not stand';
/**
 * The page tried to go to another page by itself as it loaded for a test (before its load event or within
 * QUIET_MS after it: a client-side redirect, a reload, a bot manager's check), which the request guard
 * holds: the page shown is still loading itself, so no test runs on it (src/landing.ts).
 */
export const LOADING_ITSELF = 'the page kept trying to load another page by itself as it loaded (a redirect, a reload or a bot check), so the tests were not run on it';
/** A blocked verification endpoint on the page host, or a challenge landing response. */
export const BOT_CHECK = 'a bot check stood in front of the page, so the tests were not run on it';
/** An unowned replacement document cannot supply findings about the page under test. */
export const DOCUMENT_CHANGED = LOADED_DURING;
/** A clean result that does not stand: the guard stopped a request the probe caused after it had looked. */
export const STOPPED_AFTER = 'the request guard stopped a request this test caused after the test had looked, so its clean result does not stand';
/** A clean result that does not stand: a request the probe caused went unchecked, or was still being decided. */
export { CHALLENGE_PAGE } from '../challenge.js';

export const UNSETTLED_AFTER = 'the request guard could not check every request this test caused (its decision came too late, or the browser followed a redirect to an address the guard would have stopped), so its clean result does not stand';
/** How long the runner waits for its own small calls into the page (its tidy-up, document checks). */
const PAGE_CALL_MS = 5000;
/** Longest wait at the end of a probe for the guard to decide the requests made during it. */
const END_SETTLE_MS = 1000;

/**
 * Probes that share a context: same viewport and context options, unless isolated. Within a group the
 * probes run in registry order, except that those that wait for the page first (`PageProbe.waitFor`) run
 * after the others that share the page (`waitersLater`), so a wait never delays a test that judges what the
 * page does by itself (the keyboard test starts when it did before the waits existed).
 */
export interface ProbeGroup {
  viewport: { width: number; height: number };
  contextOptions: ProbeContextOptions;
  probes: PageProbe[];
}

/**
 * A shared page's tests with those that wait (`PageProbe.waitFor`) moved after the others, in registry
 * order otherwise: just before the first test that types (`sendsNothing`, after which the page is never
 * reused), so they still share the page they were loaded on and cost no extra load; at the end when there is
 * none.
 */
export function waitersLater(list: readonly PageProbe[]): PageProbe[] {
  const waiting = list.filter((p) => p.waitFor);
  if (!waiting.length) return [...list];
  const rest = list.filter((p) => !p.waitFor);
  const at = rest.findIndex((p) => p.sendsNothing);
  const cut = at < 0 ? rest.length : at;
  return [...rest.slice(0, cut), ...waiting, ...rest.slice(cut)];
}

/** The context a group's tests share (`groupProbes`): its viewport and context options. */
export function groupKeyOf(g: Pick<ProbeGroup, 'viewport' | 'contextOptions'>): string {
  const o = g.contextOptions;
  return JSON.stringify([g.viewport.width, g.viewport.height, !!o.hasTouch, !!o.isMobile, o.deviceScaleFactor ?? 1, o.reducedMotion ?? 'reduce']);
}

export function groupProbes(probes: readonly PageProbe[]): ProbeGroup[] {
  const groups = new Map<string, ProbeGroup>();
  for (const p of probes) {
    const viewport = p.viewport ?? DEFAULT_PROBE_VIEWPORT;
    const o = p.contextOptions ?? {};
    const key = p.isolate || p.initScript
      ? `isolate\u0000${p.id}`
      : groupKeyOf({ viewport, contextOptions: o });
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { viewport, contextOptions: o, probes: [] }));
    g.probes.push(p);
  }
  for (const g of groups.values()) g.probes = waitersLater(g.probes);
  return [...groups.values()];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const lowerFirst = (t: string) => (t ? t[0]!.toLowerCase() + t.slice(1) : t);
const short = (err: unknown) => clip(err instanceof Error ? (err.message.split('\n')[0] ?? '').trim() || err.name : String(err), 160);
const isNotTestable = (err: unknown): err is Error => err instanceof ProbeNotTestable || (err instanceof Error && err.name === 'ProbeNotTestable');
const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} s`);

/** A criterion the probe speaks to only through its own rule's measurement (`PageProbe.measuredOnly`). */
const measuredOnly = (p: Pick<PageProbe, 'measuredOnly'>, criterion: string): boolean => !!p.measuredOnly?.includes(criterion);

/**
 * A run with one `not_testable` finding per criterion, all with the same reason. The probe's measured-only
 * criteria are left out: a run that did not measure says nothing for them (`PageProbe.measuredOnly`).
 */
function notTestableRun(p: PageProbe, url: string, status: ProbeRun['status'], reason: string, ms = 0, loadFailure?: ProbeLoadFailure): ProbeRun {
  const criteria = p.criteria.filter((c) => !measuredOnly(p, c));
  return {
    probe: p.id, kind: p.kind, page: url, criteria, status,
    // Only the finish plan's stops cancel a run (`ProbeRunnerOptions.signal`): the time limit.
    findings: criteria.map((criterion) => ({ criterion, status: 'not_testable', detail: reason, ...(loadFailure ? { loadFailure } : {}), ...(reason === CANCELLED || reason === TIME_LEFT ? { timeLimit: true as const } : {}) })), ms,
  };
}

/** A load of the page under test that failed, with its typed reason (`ProbeFinding.loadFailure`). */
class ProbeLoadError extends Error {
  constructor(message: string, readonly code: ProbeLoadFailure) {
    super(message);
  }
}

/** Keeps well-formed findings for the probe's own criteria, with capped text. */
function cleanFindings(p: PageProbe, findings: unknown): ProbeFinding[] | null {
  if (!Array.isArray(findings)) return null;
  const out: ProbeFinding[] = [];
  for (const f of findings as Partial<ProbeFinding>[]) {
    if (out.length >= MAX_FINDINGS) break;
    if (!f || typeof f !== 'object' || typeof f.criterion !== 'string' || !p.criteria.includes(f.criterion)) continue;
    if (!STATUSES.has(f.status as CriterionStatus) || typeof f.detail !== 'string') continue;
    const data = cleanFindingData(f.data);
    out.push({
      criterion: f.criterion, status: f.status as CriterionStatus,
      ...(f.target ? { target: clip(String(f.target), 200) } : {}),
      ...(Array.isArray(f.elements) && f.elements.length ? { elements: f.elements.filter((k) => typeof k === 'string' && k).slice(0, 6).map((k) => clip(k, 200)) } : {}),
      detail: clip(f.detail, 500),
      ...(data ? { data } : {}),
      ...(f.minor === true && f.status === 'failed' ? { minor: true as const } : {}),
      ...(f.nothingToTest === true && f.status === 'not_testable' ? { nothingToTest: true as const } : {}),
      ...(f.advice === true && f.status === 'no_failures_found' ? { advice: true as const } : {}),
    });
  }
  return out;
}

/** Runs in the page between probes (self-contained). */
function resetPage(): void {
  window.scrollTo({ left: 0, top: 0, behavior: 'instant' as ScrollBehavior });
  const el = document.activeElement as HTMLElement | null;
  if (el && el !== document.body && typeof el.blur === 'function') el.blur();
}

/**
 * Added before every other init script: names the document for the runner. The time origin is read
 * before the page's own scripts run (they cannot replace it), and a generation counts pagehide and
 * pageshow from the back-forward cache, which keep the document and its time origin. The function is
 * a fixed, non-configurable property, so the page cannot redefine it.
 */
export const DOCUMENT_ID_SCRIPT = `(function () {
  var origin = String(performance.timeOrigin), gen = 0;
  try {
    addEventListener('pagehide', function () { gen++; }, true);
    addEventListener('pageshow', function (e) { if (e.persisted) gen++; }, true);
    Object.defineProperty(window, '__grntedDocument', { value: function () { return origin + ':' + gen; }, configurable: false, writable: false, enumerable: false });
  } catch (e) {}
})();`;

/**
 * Runs in the page: names the document (time origin and back-forward cache trips, see
 * `DOCUMENT_ID_SCRIPT`). A history change of the address (pushState, a hash) keeps the name.
 */
function documentId(): string {
  const named = (window as unknown as { __grntedDocument?: () => string }).__grntedDocument;
  return typeof named === 'function' ? named() : `t${performance.timeOrigin}`;
}

const NO_ANSWER = 'the page stopped responding, so this test was not run';
/** The reason a waiting test gives when its bounded content wait ended without the page mounted (review r1 of fix/redteam-visual, 13). */
export const STILL_MOUNTING = `the page had not finished putting its main content in ${LATE_CONTENT_MS / 1000} s after it loaded, so this test could not judge it`;
const MOUNT_UNREAD = 'the page did not answer when asked whether its main content had loaded, so this test could not judge it';

/**
 * The findings of a test whose content wait (`PageProbe.waitFor.content`) did not end with the page mounted:
 * what it found failing (or left undecided) on the shell stands; a criterion it would call clean or not
 * applicable is not testable instead, because what was not there yet was not measured.
 */
export function unmountedFindings(p: Pick<PageProbe, 'criteria' | 'measuredOnly'>, findings: readonly ProbeFinding[], reason: string): ProbeFinding[] {
  // A measured-only criterion keeps its rule's own findings as they are, and gets none added.
  const kept = findings.filter((f) => measuredOnly(p, f.criterion) || (f.status !== 'no_failures_found' && f.status !== 'not_applicable'));
  const decided = new Set(kept.map((f) => f.criterion));
  return [...kept, ...p.criteria.filter((c) => !decided.has(c) && !measuredOnly(p, c)).map((criterion): ProbeFinding => ({ criterion, status: 'not_testable', detail: reason }))];
}

/**
 * The page's document and address now; 'gone' when the call failed (the page is going to another
 * document), 'closed' when the page, its context or the browser is closed, 'hung' when the page did
 * not answer in time.
 */
async function whereNow(page: PageLike, by = Date.now() + PAGE_CALL_MS, signal?: AbortSignal): Promise<Where | 'gone' | 'closed' | 'hung'> {
  try {
    const doc = await within(page.evaluate(documentId, undefined), Math.min(by, Date.now() + PAGE_CALL_MS), signal);
    return doc === 'cut' ? 'hung' : { doc, url: page.url?.() };
  } catch (err) {
    return page.isClosed?.() || isBrowserGone(err) ? 'closed' : 'gone';
  }
}

/** A document of the page (`documentId`) and its address then. */
interface Where {
  doc: unknown;
  url: string | undefined;
}

/** The same document; a history change of its address (pushState) does not count as leaving. */
const sameWhere = (a: Where, b: Session['left']) => typeof b !== 'string' && a.doc === b.doc;

interface Session {
  context: ContextLike;
  page: PageLike;
  guard: Guard;
  /** The page's stylesheet watch (`src/styles.ts`); undefined when the browser cannot report responses. */
  styles?: StyleWatch;
  hooks: boolean;
  /** The page's address after loading (redirects included). */
  loadedUrl: string;
  /** Main-frame responses used to check a probe's own reload. */
  watch?: LandingWatch;
  /** The SVG picture files the page was given on its last load, kept as they arrived (`pictureFiles.ts`). */
  pictureFiles?: PictureFileStore;
  /** A main-frame challenge response, even before its commit is reported. Ends this group. */
  challenge?: string;
  /**
   * The document as the runner last left it: after loading it, or when the last probe ended ('gone'
   * while it was being replaced then, 'hung' when it did not answer). A probe that starts on another
   * document gets `LEFT_BY_ITSELF`.
   */
  left: Where | 'gone' | 'closed' | 'hung';
  /** How many times the page was loaded again in this context (`resetSession`): a late pass needs the same document. */
  reloads?: number;
}

/** The probe's expected document, re-marked after each load it performs itself. */
interface ProbeDocument {
  expected: Session['left'];
  loading: number;
  /** A confirmed replacement or an unproven completed load invalidates the whole run, permanently. */
  documentChanged: boolean;
}

/** Time spent per group (see `ProbeGroupTiming`). */
type Clock = Pick<ProbeGroupTiming, 'openMs' | 'loadMs' | 'settleMs' | 'loads' | 'probeMs' | 'freshMs'>;

/** The page-gate turn, or 'stopped' when the signal came first (the turn is then released as soon as it is granted). */
function turnOrStop(turn: Promise<{ release(): void }> | undefined, signal: AbortSignal | undefined): Promise<{ release(): void } | undefined | 'stopped'> {
  if (!turn) return Promise.resolve(undefined);
  if (!signal) return turn;
  if (signal.aborted) {
    void turn.then((t) => t?.release(), () => {});
    return Promise.resolve('stopped');
  }
  return new Promise((resolve, reject) => {
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true;
      void turn.then((t) => t?.release(), () => {});
      resolve('stopped');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    turn.then((t) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      resolve(t);
    }, (err) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

/**
 * Loads the page under test (the guard lets this load and the server's redirects of it through) and
 * waits for it to settle. The 'load' phase ends with the load event: while the page settles, and
 * until a probe starts, the guard treats what the page does by itself as between probes.
 *
 * Every page load of the tests goes through here (a job's first load in `openSession`, a load again in
 * `resetSession`, a fresh load for a test that needs the page's timers as set, the navigator's capture), so
 * whatever answers a load (the live site, or a recorded copy of it: out/specs/2026-11-10-record-replay.md)
 * sits below this one function, in the browser or context it is given. Nothing here assumes a load is live.
 */
async function load(s: Pick<Session, 'page' | 'guard' | 'styles' | 'watch' | 'challenge' | 'pictureFiles'>, url: string, opts: ProbeRunnerOptions, clock: Clock): Promise<{ loadedUrl: string; left: Where }> {
  const t0 = Date.now();
  const deadline = opts.deadline ?? Infinity;
  clock.loads++;
  // A new document: its content wait starts fresh (ready.ts).
  forgetBusy(s.page);
  // The scan's page gate once the audits are done: this load and its settle hold one turn. A stop while it
  // waits for its turn ends the wait at once (the turn is given back when it comes): a stopped job holds
  // its browser context no longer than it must.
  const turn = await turnOrStop(opts.loadTurn?.(), opts.signal);
  if (turn === 'stopped') throw new ProbeLoadError(CANCELLED, 'not-loaded');
  // The 'load' phase covers each try only: while the scan waits for the site (a refused try, its turn),
  // what the page shown does by itself is between probes.
  const nav = navigationOf(s.page);
  // Each try: where the guard's log stood as it began, and when its load event came.
  let mark = s.guard.log.mark();
  let loadedAt = Date.now();
  /** The document shown as the try's load event came (the check below). */
  let atLoad: Awaited<ReturnType<typeof whereNow>> | undefined;
  const answered = await within(gotoPolitely(opts.pace, url, async () => {
    s.guard.setPhase('load');
    nav.reset();
    s.watch?.begin();
    s.pictureFiles?.reset();
    mark = s.guard.log.mark();
    // A navigation of its own the page starts before its load event, which the guard holds: the outcome is
    // known (LOADING_ITSELF), and Playwright's load wait would never end (it waits for the held document).
    const held = whenHeld(s.guard, mark, () => s.page.url?.() || url);
    // The scan's cancellation ends the wait for the load too (the context is closed after it).
    try {
      const going = s.page.goto(url, { waitUntil: 'load', timeout: opts.loadTimeoutMs ?? PROBE_DEFAULTS.loadTimeoutMs });
      going.catch(() => {});
      const resp = await within(Promise.race([
        going,
        held.promise.then((reason): never => { throw new ProbeLoadError(reason, reason === BOT_CHECK ? 'challenge' : 'not-loaded'); }),
      ]), deadline, opts.signal);
      if (resp === 'cut') throw new ProbeLoadError(opts.signal?.aborted ? CANCELLED : TIME_LEFT, 'not-loaded');
      loadedAt = Date.now();
      const refusal = resp ? landingFailure(resp) : undefined;
      if (refusal?.kind === 'challenge') throw new ProbeLoadError(`${BOT_CHECK}: ${refusal.reason}`, 'challenge');
      return resp;
    } catch (err) {
      if (err instanceof ProbeLoadError) throw err;
      // An HTTP error the browser would not show (no body): the site's answer, as when the response comes back.
      const status = nav.status();
      if (status !== undefined && status >= 400 && isResponseCodeFailure(err instanceof Error ? err.message : String(err))) throw new Error(`HTTP ${status}`);
      throw err;
    } finally {
      held.stop();
      await s.guard.setPhase('between');
    }
  }, {
    deadline, ...(opts.signal ? { signal: opts.signal } : {}),
    ...(s.styles ? { styles: s.styles } : {}),
    // Each try the page answered settles before its stylesheets are judged (a sheet the page adds
    // while it settles is part of the try).
    prepare: async (resp) => {
      s.guard.setPageUrl(s.page.url?.() ?? url);
      const t1 = Date.now();
      atLoad = await whereNow(s.page, deadline, opts.signal);
      checkBotEvidence(s, s.page.url?.() ?? url, mark);
      await s.page.waitForTimeout(opts.settleMs ?? PROBE_DEFAULTS.settleMs);
      // At least QUIET_MS after the load event (the check below).
      const rest = loadedAt + QUIET_MS - Date.now();
      if (rest > 0) await s.page.waitForTimeout(rest);
      clock.settleMs += Date.now() - t1;
      await checkedLoad(s, resp, url, mark, loadedAt, atLoad, deadline, opts.signal);
    },
  }), deadline, opts.signal).finally(() => {
    turn?.release();
    clock.loadMs += Date.now() - t0;
  });
  // The answer of the document loaded (the guard holds the page's own navigations, so it is the load's,
  // redirects included), with the audit's checks (src/landing.ts). A bot challenge (AWS WAF answers 202
  // with a script page that needs a POST, which the guard stops; a WAF's challenge headers): never the
  // page, so nothing measured on it may stand. Checked first: a challenge whose stylesheet was refused
  // too is a challenge.
  if (answered === 'cut') throw new ProbeLoadError(opts.signal?.aborted ? CANCELLED : TIME_LEFT, 'not-loaded');
  const first = answered.value;
  const refusal = first ? landingFailure(first) : undefined;
  if (refusal?.kind === 'challenge' || s.guard.log.events.slice(mark).some((e) => e.kind === 'blocked' && !!e.url && isBotVerification(e.url, s.page.url?.() ?? url))) throw new ProbeLoadError(refusal?.kind === 'challenge' ? `${BOT_CHECK}: ${refusal.reason}` : BOT_CHECK, 'challenge');
  // A page whose stylesheet the site kept refusing is never tested unstyled.
  if (answered.refused) {
    const unstyled = isUnstyledReason(answered.refused);
    throw new ProbeLoadError(unstyled ? UNSTYLED_PAGE : answered.refused, unstyled ? 'unstyled' : 'not-loaded');
  }
  const resp = answered.value;
  if (!resp) throw new Error('no response from the server');
  if (refusal?.kind === 'http') throw new Error(refusal.reason);
  if (refusal) throw new ProbeLoadError(lowerFirst(refusal.reason), 'not-loaded');
  return checkedLoad(s, resp, url, mark, loadedAt, atLoad, deadline, opts.signal);
}

/** Only documented verification paths on the page's own host; unrelated writes are not bot checks. */
function isBotVerification(url: string, pageUrl: string): boolean {
  try {
    const u = new URL(url);
    return u.host === new URL(pageUrl).host && (u.pathname === '/_sec/verify' || u.pathname.startsWith('/cdn-cgi/challenge-platform/'));
  } catch {
    return false;
  }
}

/** Recorded bot evidence, read again after asynchronous page calls can deliver more of it. */
function botEvidence(s: Pick<Session, 'guard' | 'challenge'>, pageUrl: string, mark = 0, since?: number): string | undefined {
  if (s.challenge) return `${BOT_CHECK}: ${s.challenge}`;
  if (s.guard.log.events.slice(mark).some((e) => (since === undefined || e.at >= since) && e.kind === 'blocked' && !!e.url && isBotVerification(e.url, pageUrl))) return BOT_CHECK;
  return undefined;
}

function checkBotEvidence(s: Pick<Session, 'guard' | 'challenge'>, pageUrl: string, mark = 0, since?: number): void {
  const reason = botEvidence(s, pageUrl, mark, since);
  if (reason) throw new ProbeLoadError(reason, 'challenge');
}

/** The same checks after the runner's load and a probe's own reload. */
async function checkedLoad(
  s: Pick<Session, 'page' | 'guard' | 'watch' | 'challenge'>, resp: Parameters<typeof landingFailure>[0], url: string,
  mark: number, loadedAt: number, atLoad: Awaited<ReturnType<typeof whereNow>> | undefined,
  deadline: number, signal?: AbortSignal, ownReload = false,
): Promise<{ loadedUrl: string; left: Where }> {
  if (signal?.aborted || Date.now() >= deadline) throw new ProbeNotTestable(signal?.aborted ? CANCELLED : TIME_LEFT);
  // Requests already reported by the browser may still await the guard's decision. Its silence is
  // not evidence that a verification was allowed: settle those decisions before judging the page.
  const guarded = await within(s.guard.log.settled?.(END_SETTLE_MS) ?? Promise.resolve(true), deadline, signal);
  if (guarded !== true) throw new ProbeNotTestable(signal?.aborted ? CANCELLED : Date.now() >= deadline ? TIME_LEFT : 'the browser could not finish checking the page load, so the tests were not run on it');
  const loaded = s.page.url?.() ?? url;
  const since = ownReload ? s.watch?.currentSince() : undefined;
  if (ownReload && since === undefined) throw new ProbeNotTestable(LANDING_UNCHECKED);
  const checkLoad = () => {
    checkBotEvidence(s, s.page.url?.() ?? url, mark, since);
    if (isOtherSite(url, s.page.url?.() ?? loaded) || isOtherSite(url, resp.url())) throw new ProbeLoadError(lowerFirst(OTHER_SITE), 'not-loaded');
  };
  checkLoad();
  // Earlier probe actions belong to the old document, not this reload. Its response preceded every
  // verification script in the new document, including one that ran before the load event.
  const events = s.guard.log.events.slice(mark).filter((e) => since === undefined || e.at >= since);
  const refusal = landingFailure(resp);
  if (refusal?.kind === 'challenge') throw new ProbeLoadError(`${BOT_CHECK}: ${refusal.reason}`, 'challenge');
  if (refusal) throw new ProbeLoadError(lowerFirst(refusal.reason), 'not-loaded');
  if (events.some((e) => (isOwnNavigation(e) || ownReload && (e.kind === 'navigation' || e.kind === 'blocked' && e.mainFrame)) && e.at <= loadedAt + QUIET_MS)) throw new ProbeLoadError(LOADING_ITSELF, 'not-loaded');
  s.guard.setPageUrl(loaded);
  const left = await whereNow(s.page, deadline, signal);
  checkLoad();
  if (typeof left === 'string') throw new ProbeNotTestable(left === 'hung' ? UNCONFIRMED : LOADING_ITSELF);
  if (atLoad !== undefined && (typeof atLoad === 'string' || !sameWhere(left, atLoad))) throw new ProbeLoadError(LOADING_ITSELF, 'not-loaded');
  if (ownReload) {
    const marked = await markDocument(s.page, s.watch, deadline, signal);
    checkLoad();
    if (!marked || s.watch?.ambiguous() || bindLanding(resp, marked.facts)) throw new ProbeNotTestable(LANDING_UNCHECKED);
  }
  if (signal?.aborted || Date.now() >= deadline) throw new ProbeNotTestable(signal?.aborted ? CANCELLED : TIME_LEFT);
  return { loadedUrl: loaded, left };
}

/** A navigation of the page under test the guard held or blocked while no test ran (it went nowhere). */
const isOwnNavigation = (e: GuardEvent) => !e.probe && (e.kind === 'navigation' || (e.kind === 'blocked' && !!e.mainFrame));

/** Resolves when a bot verification is blocked or the page's own navigation is held during load. */
function whenHeld(guard: Guard, mark: number, pageUrl: () => string): { promise: Promise<string>; stop(): void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  const promise = new Promise<string>((resolve) => {
    timer = setInterval(() => {
      const events = guard.log.events.slice(mark);
      const bot = events.some((e) => e.kind === 'blocked' && !!e.url && isBotVerification(e.url, pageUrl()));
      if (!bot && !events.some(isOwnNavigation)) return;
      clearInterval(timer);
      resolve(bot ? BOT_CHECK : LOADING_ITSELF);
    }, 100);
  });
  return { promise, stop: () => clearInterval(timer) };
}

/**
 * Longest extra wait, before a test that asks for it (`PageProbe.waitFor.content`), for a page whose main
 * content is still mounting (`stillMounting`, src/probes/mounting.ts): an app that hydrates late (1 to 2 s
 * after load is common) is tested with its content, never as an empty shell (gold harness hazard
 * `hazard-late-mount`: before this, the headings test found "no headings at all" and the orientation test
 * compared an empty portrait screen with a full landscape one). Tests that judge what a page does by itself
 * (flashing, sound, motion, keyboard traps) never ask for it, so a loading state is judged as it is (review
 * round 1); sound, motion and device motion have a late pass instead (`PageProbe.late`, fix/late-mount).
 */
export { LATE_CONTENT_MS } from './mounting.js';

/**
 * Before a test that asks for it (`PageProbe.waitFor.layout`), a page that still moves (layout shifts: a
 * picture without dimensions arriving, a web font swapped in) is waited for until it has not moved for
 * `LAYOUT_QUIET_MS`, at most `LATE_LAYOUT_MS` more (gold harness hazard `hazard-layout-shift`: the
 * forced-colours comparison found every control "moving" when a web font swapped in while it ran). A page
 * that keeps moving is tested after the cap. The flash test never waits: a short flash at load is real.
 */
export const LAYOUT_QUIET_MS = 400;
export const LATE_LAYOUT_MS = 1500;

/**
 * Runs in the page: ms since its last layout shift that no input caused (Layout Instability API,
 * buffered); a very large number when it never shifted or the browser cannot say.
 */
function sinceLastShift(): Promise<number> {
  return new Promise((resolve) => {
    let last = -Infinity;
    const read = (list: readonly PerformanceEntry[]) => {
      for (const e of list as readonly (PerformanceEntry & { hadRecentInput?: boolean })[]) if (!e.hadRecentInput) last = Math.max(last, e.startTime);
    };
    try {
      const po = new PerformanceObserver((l) => read(l.getEntries()));
      po.observe({ type: 'layout-shift', buffered: true });
      setTimeout(() => {
        read(po.takeRecords());
        po.disconnect();
        resolve(Number.isFinite(last) ? performance.now() - last : 1e9);
      }, 20);
    } catch {
      resolve(1e9);
    }
  });
}

/** Waits, at most `maxMs`, until the page's layout has not shifted for `quietMs` (`sinceLastShift`); never throws. */
async function waitForStillLayout(page: PageLike, quietMs: number, maxMs: number): Promise<void> {
  const end = Date.now() + maxMs;
  for (;;) {
    let since: number;
    try {
      const answer = await Promise.race([page.evaluate(sinceLastShift, undefined), new Promise<number>((r) => setTimeout(() => r(1e9), PAGE_CALL_MS))]);
      since = typeof answer === 'number' && Number.isFinite(answer) ? answer : 1e9;
    } catch {
      return;
    }
    if (since >= quietMs || Date.now() >= end) return;
    await page.waitForTimeout(Math.min(quietMs - since + 10, Math.max(1, end - Date.now())));
  }
}

/** A fresh context with the listener hook and the request guard, and the page loaded in it. */
async function openSession(browser: BrowserLike, target: ProbeTarget, g: ProbeGroup, opts: ProbeRunnerOptions, clock: Clock, onContext?: (c: ContextLike) => void): Promise<Session | { error: string; code?: ProbeLoadFailure }> {
  let context: ContextLike | undefined;
  let opened: PageLike | undefined;
  const t0 = Date.now();
  try {
    const o = g.contextOptions;
    context = await browser.newContext({
      // No test page may save a file, whatever a test presses in it (the media test clicks play with the guard open).
      acceptDownloads: false,
      viewport: g.viewport, userAgent: opts.userAgent, reducedMotion: o.reducedMotion ?? 'reduce', serviceWorkers: 'block',
      ...(o.hasTouch !== undefined ? { hasTouch: o.hasTouch } : {}),
      ...(o.isMobile !== undefined ? { isMobile: o.isMobile } : {}),
      ...(o.deviceScaleFactor !== undefined ? { deviceScaleFactor: o.deviceScaleFactor } : {}),
      // A test that presses or types (`sendsNothing`) must never save a file: its context refuses downloads.
      ...(g.probes.some((p) => p.sendsNothing) ? { acceptDownloads: false } : {}),
    });
    onContext?.(context);
    // The listener hook (with the popup blocker), then each probe's own init script (`PageProbe.initScript`),
    // before the page loads. The document name first, so the listener hook does not record its two
    // listeners as the page's. The guard logs the windows the blocker reports under this context's nonce.
    const popupNonce = newPopupNonce();
    const scripts = [DOCUMENT_ID_SCRIPT, listenerHookScript(popupNonce), ...g.probes.flatMap((p) => (p.initScript ? [p.initScript] : []))];
    let hooks = false;
    if (context.addInitScript) {
      for (const content of scripts) await context.addInitScript({ content });
      hooks = true;
    }
    // The guard's WebSocket route, set while the context has no page (after the scripts above, as
    // before): it costs nothing then, ~600 ms of round trips on a remote browser once a page exists.
    const webSockets = hooks ? routeWebSocketsEarly(context) : undefined;
    const page = await context.newPage();
    opened = page;
    // Hosted use: a page whose documents cannot be checked before they load is not loaded at all.
    const stop = gateStopsLoad(page);
    if (stop) {
      await context.close().catch(() => {});
      // A gate whose session already closed (the browser is closing): lost work, opened again (`runGroup`).
      return { error: stop === GATE_LOST ? GATE_LOST : NO_DOCUMENT_GATE };
    }
    if (!hooks && page.addInitScript) {
      for (const content of scripts) await page.addInitScript({ content });
      hooks = true;
    }
    const guard = await installGuard(context, page, target.url, { popupNonce, ...(webSockets ? { webSockets } : {}), ...(opts.popupSandbox ? { sandbox: opts.popupSandbox } : {}) });
    clock.openMs += Date.now() - t0;
    if (!guard) {
      await context.close().catch(() => {});
      return { error: NO_GUARD };
    }
    if (opts.popupSandbox === 'always' && guard.popupSandbox !== 'on') {
      await context.close().catch(() => {});
      return { error: NO_SANDBOX };
    }
    const styles = watchStyles(page, opts.pace, target.url);
    const watch = watchLanding(page);
    const pictureFiles = watchPictureFiles(page);
    const s: Omit<Session, 'loadedUrl' | 'left'> = { context, page, guard, ...(styles ? { styles } : {}), hooks, ...(watch ? { watch } : {}), ...(pictureFiles ? { pictureFiles } : {}) };
    page.on?.('response', (resp) => {
      // Record challenge answers as they arrive: a commit can be delayed or never reported.
      try {
        const request = resp.request();
        const frame = request.frame?.();
        const main = page.mainFrame?.();
        if (!request.isNavigationRequest?.() || !frame || (main ? frame !== main : frame.parentFrame() !== null)) return;
      } catch {
        return; // a service worker's response has no frame
      }
      const refusal = landingFailure(resp);
      if (refusal?.kind === 'challenge') s.challenge ??= refusal.reason;
    });
    return Object.assign(s, await load(s, target.url, opts, clock));
  } catch (err) {
    // The browser went away while the page loaded (the load may end net::ERR_ABORTED): said as a
    // closed browser, so the run is done again in a new one (`runGroup`).
    const gone = !opts.signal?.aborted && !(err instanceof ProbeLoadError) && !isBrowserGone(err) && opened && (await pageGone(opened));
    await context?.close().catch(() => {});
    return {
      error: `the page did not load for this test: ${gone ? 'Target page, context or browser has been closed (' : ''}${short(err)}${gone ? ')' : ''}`,
      code: !gone && err instanceof ProbeLoadError ? err.code : 'not-loaded',
    };
  }
}

/** The longest wait for the old page's close before a fresh load (`freshAfterFiredTimers`). */
const CLOSE_MS = 2000;
/** `openWithin`'s error when the time box ended first. */
const TIMED_OUT = 'timed out';

/**
 * `openSession` within `ms` (and the scan's cancel): past either, its context is closed as soon as it
 * exists (a load still running included): `TIMED_OUT` for its box, `TIME_LEFT` for the scan, or `CANCELLED`.
 */
async function openWithin(browser: BrowserLike, target: ProbeTarget, g: ProbeGroup, opts: ProbeRunnerOptions, clock: Clock, ms: number): Promise<Session | { error: string; code?: ProbeLoadFailure }> {
  const deadline = Math.min(Date.now() + ms, opts.deadline ?? Infinity);
  const expired = (opts.deadline ?? Infinity) <= deadline ? TIME_LEFT : TIMED_OUT;
  let context: ContextLike | undefined;
  let ended: string | undefined;
  const end = (why: string) => {
    ended ??= why;
    void context?.close().catch(() => {});
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<{ error: string }>((resolve) => {
    timer = setTimeout(() => { end(expired); resolve({ error: expired }); }, Math.max(0, deadline - Date.now()));
    onAbort = () => { end(CANCELLED); resolve({ error: CANCELLED }); };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
  const opening = openSession(browser, target, g, { ...opts, deadline }, clock, (c) => { context = c; if (ended) void c.close().catch(() => {}); });
  // A session that opens after the time box ended is closed (it is never used).
  void opening.then((o) => { if (ended && !('error' in o)) void o.context.close().catch(() => {}); }, () => {});
  try {
    const first = await Promise.race([opening, stopped]);
    if ('error' in first && 'code' in first && first.code === 'challenge') return first;
    if (opts.signal?.aborted) end(CANCELLED);
    else if (Date.now() >= deadline) end(expired);
    return ended ? { error: ended } : first;
  } finally {
    clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Runs in the page: how many timers probes ran early on it (`Kit.fired`; 0 without the kit). */
function firedCount(): number {
  const kit = (window as unknown as { __grntedKit?: { fired?: unknown[] } }).__grntedKit;
  return Array.isArray(kit?.fired) ? kit.fired.length : 0;
}

/** Timers an earlier probe ran early on the page; -1 when the page did not answer within `ms` (it may have). */
async function timersRunEarly(page: PageLike, ms: number, signal?: AbortSignal): Promise<number> {
  try {
    const n = await within(page.evaluate(firedCount, undefined), Date.now() + ms, signal);
    if (n === 'cut') return -1;
    // `firedCount` answers a number; anything else is a page without the kit (none ran early).
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  } catch {
    return -1;
  }
}

/**
 * Gets the page ready for the next probe; false when it needs a fresh context instead. It loads the
 * page again when the last probe left it on another address, or when `reload` is set. A page that
 * goes to another document after this is caught when the next probe starts (`runOne`).
 */
async function resetSession(s: Session, target: ProbeTarget, opts: ProbeRunnerOptions, clock: Clock, reload = false): Promise<boolean> {
  try {
    if (s.page.isClosed?.() || s.left === 'hung' || s.left === 'closed') return false;
    const now = s.page.url?.();
    // Loaded again: a page the last probe left on another address, or still going to one as it ended.
    if (reload || s.left === 'gone' || (now !== undefined && !sameDocument(now, s.loadedUrl))) {
      Object.assign(s, await load(s, target.url, opts, clock));
      s.reloads = (s.reloads ?? 0) + 1;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answered = await Promise.race([
      s.page.evaluate(resetPage, undefined).then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), PAGE_CALL_MS); }),
    ]).finally(() => clearTimeout(timer));
    return answered;
  } catch (err) {
    if (err instanceof ProbeLoadError && err.code === 'challenge') throw err;
    return false;
  }
}

/**
 * `startedAt`: when the probe's time box began, if before this call (a fresh load for it counts inside
 * its time box, `PageProbe.freshAfterFiredTimers`).
 */
async function runOne(s: Session, p: PageProbe, target: ProbeTarget, g: ProbeGroup, opts: RunOptions, plan?: Promise<TargetPlan | null>, startedAt?: number, established?: (findings: ProbeFinding[], kept: boolean, mark: number) => void, identity?: ProbeDocument): Promise<{ run: ProbeRun; broken: boolean; leftByItself?: boolean }> {
  const viewport = g.viewport;
  // A probe that takes planned targets waits for the page's plan first (bounded by the navigator's budget,
  // and outside its own time box); without one in time it runs on its own targets only.
  const planned = p.usesPlan && plan ? plannedFor((await waitPlan(plan, opts.signal))?.targets, p.id) : [];
  // The page must still show the document the runner left it on: one that went elsewhere by itself in
  // between (a navigation the guard never sees, such as about:blank) is never tested as if it were the
  // page. The check runs while the guard still treats the page as between probes: a navigation the
  // page started before it (reported by the time the check answers) is decided as the page's own.
  let started = startedAt ?? Date.now();
  const ms = () => Date.now() - started;
  const left = () => Math.max(0, deadline - Date.now());
  const by = () => Math.min(startedAt === undefined ? Infinity : started + p.timeoutMs, opts.deadline ?? Infinity);
  let deadline = Math.min(started + p.timeoutMs, opts.deadline ?? Infinity);
  /** Set when this test's content wait ended without the page mounted. */
  let unmounted: string | undefined;
  const now = await whereNow(s.page, by(), opts.signal);
  checkBotEvidence(s, s.page.url?.() ?? target.url);
  if (now === 'hung' && startedAt !== undefined && !left()) return { run: notTestableRun(p, target.url, 'timeout', `timed out after ${duration(p.timeoutMs)}`, ms()), broken: true };
  if (now === 'hung') return { run: notTestableRun(p, target.url, 'error', NO_ANSWER, ms()), broken: true };
  // The page, its context or the browser closed since the last probe: the run is tried again in a new context (`runGroup`).
  if (now === 'closed') return { run: notTestableRun(p, target.url, 'error', 'the test could not run: Target page, context or browser has been closed', ms()), broken: true };
  if (now === 'gone' || !sameWhere(now, s.left)) return { run: notTestableRun(p, target.url, 'ok', LEFT_BY_ITSELF, ms()), broken: false, leftByItself: true };
  const document = identity ?? { expected: now, loading: 0, documentChanged: false };
  // Tests that misread a page still mounting or moving wait for it first (bounded; outside their time box).
  if (p.waitFor?.content) {
    // Use the primary-content mount detector, keeping the shared time limit and the document check:
    // a document replaced while waiting is never tested as the page (Sol round 1).
    const waited = await within(waitForMount(s.page, LATE_CONTENT_MS, now.doc), by(), opts.signal);
    if (waited === 'cut') return { run: notTestableRun(p, target.url, 'error', opts.signal?.aborted ? CANCELLED : TIME_LEFT), broken: true };
    // The wait ended without the page mounted (or without an answer): the test still runs, and what it finds failing
    // stands, but it may not call the page clean or not applicable (`unmountedFindings`).
    if (!waited.mounted) unmounted = waited.failed ? MOUNT_UNREAD : STILL_MOUNTING;
    checkBotEvidence(s, s.page.url?.() ?? target.url);
    const after = await whereNow(s.page, by(), opts.signal);
    checkBotEvidence(s, s.page.url?.() ?? target.url);
    if (after === 'hung') return { run: notTestableRun(p, target.url, 'error', NO_ANSWER), broken: true };
    if (after === 'closed') return { run: notTestableRun(p, target.url, 'error', 'the test could not run: Target page, context or browser has been closed'), broken: true };
    if (after === 'gone' || !sameWhere(after, s.left)) return { run: notTestableRun(p, target.url, 'ok', LEFT_BY_ITSELF), broken: false, leftByItself: true };
  }
  if (p.waitFor?.layout) {
    const waited = await within(waitForStillLayout(s.page, LAYOUT_QUIET_MS, LATE_LAYOUT_MS), by(), opts.signal);
    if (waited === 'cut') return { run: notTestableRun(p, target.url, 'error', opts.signal?.aborted ? CANCELLED : TIME_LEFT), broken: true };
  }
  checkBotEvidence(s, s.page.url?.() ?? target.url);
  if (startedAt === undefined) started = Date.now();
  deadline = Math.min(started + p.timeoutMs, opts.deadline ?? Infinity);
  if (p.sendsNothing) {
    // Blocking new requests cannot stop an earlier allowed fetch from redirecting with a cookie
    // copied from input. Require continuous quiet and recheck it after the identity round trip:
    // the transport can deliver a redirect hop while that call is in flight.
    for (;;) {
      const drained = await within(s.guard.drain(left()), deadline, opts.signal);
      checkBotEvidence(s, s.page.url?.() ?? target.url);
      if (drained !== true) return { run: notTestableRun(p, target.url, 'ok', opts.signal?.aborted ? CANCELLED : Date.now() >= (opts.deadline ?? Infinity) ? TIME_LEFT : 'the page was still loading when the test would have typed', ms()), broken: true };
      const after = await whereNow(s.page, deadline, opts.signal);
      checkBotEvidence(s, s.page.url?.() ?? target.url);
      if (after === 'closed') return { run: notTestableRun(p, target.url, 'error', 'the test could not run: Target page, context or browser has been closed', ms()), broken: true };
      if (after === 'hung' || !left()) return { run: notTestableRun(p, target.url, 'ok', 'the page was still loading when the test would have typed', ms()), broken: true };
      if (after === 'gone' || !sameWhere(after, s.left)) return { run: notTestableRun(p, target.url, 'ok', LEFT_BY_ITSELF, ms()), broken: false, leftByItself: true };
      if (s.guard.isDrained()) break;
    }
  }
  checkBotEvidence(s, s.page.url?.() ?? target.url);
  // Optional work: asked once more at the last moment (the waits above may have used up its time). Not
  // started: no result of its own (`optionalCut`), and its page is not used again.
  if (opts.admit && !opts.admit()) return { run: notTestableRun(p, target.url, 'error', CANCELLED, ms()), broken: true };
  // From here on the probe's own rules apply. Drained requests belong to the page before this test.
  s.guard.setPhase({ probe: p.id, ...(p.sendsNothing ? { strict: true } : {}) });
  /** The time box's end on the monotonic clock, including the scan's earlier deadline. */
  const startedMono = performance.now();
  const abort = new AbortController();
  const onCancel = () => abort.abort();
  opts.signal?.addEventListener('abort', onCancel, { once: true });
  const deep = p.tier !== 'core' ? opts.deepSignal : undefined;
  deep?.addEventListener('abort', onCancel, { once: true });
  if (deep?.aborted || opts.signal?.aborted) abort.abort();
  let data: unknown;
  /** Non-JSON data for the AI review (`ProbeContext.attach`), kept beside the run, never in it. */
  let attachment: unknown;
  /** The probe asked that the page not be reused (`ProbeContext.discardPage`). */
  let discard = false;
  /**
   * The document the probe's results must be of: the one it started on, or the one it loaded itself last
   * (`ProbeContext.reloadedPage`); 'unknown' when the page did not say which that was.
   */
  let base = now as Where | 'unknown';
  /** The last host-side navigation, whose ownership must still hold after reload validation. */
  let owned: { navigation: number; url: string; document: Where } | undefined;
  /** A failed owned reload stops this probe, even if it catches the exception. */
  let reloadFailure: { reason: string; code: ProbeLoadFailure } | undefined;
  /** Failures the probe said stand even if the run is cut (`ProbeContext.keep`). */
  let kept: ProbeFinding[] = [];
  /** The run's CDP session for screenshots (`ProbeContext.cdp`), opened on first use. */
  let shotSession: Promise<CDPSessionLike | undefined> | undefined;
  // Evidence images only when the scan has a recorder (no screenshot is ever taken without one).
  // Start page marks ("Homepage, as checked") only from the start page at the desktop width.
  const desktop = viewport.width === DEFAULT_PROBE_VIEWPORT.width && viewport.height === DEFAULT_PROBE_VIEWPORT.height
    && !g.contextOptions.isMobile && (g.contextOptions.deviceScaleFactor ?? 1) === 1;
  const ev: RunEvidence | undefined = opts.evidence && opts.evidencePool
    ? createRunEvidence({
      page: s.page, probe: p, target, viewport, deadline, signal: abort.signal, recorder: opts.evidence, pool: opts.evidencePool,
      home: target.index === 0 && desktop,
      ...(g.contextOptions.deviceScaleFactor !== undefined ? { deviceScaleFactor: g.contextOptions.deviceScaleFactor } : {}),
    })
    : undefined;
  const ctx: ProbeContext = {
    page: s.page,
    url: target.url,
    pageIndex: target.index,
    viewport,
    guard: s.guard.log,
    signal: abort.signal,
    deadline,
    ends: startedMono + Math.max(0, deadline - Date.now()),
    ...(target.collected ? { collected: target.collected } : {}),
    ...(target.incomplete ? { incomplete: target.incomplete } : {}),
    ...(planned.length ? { planned } : {}),
    ...(opts.axeSource ? { axeSource: opts.axeSource } : {}),
    ...(opts.aiEvidence ? { aiEvidence: true } : {}),
    async listeners(opts?: { shadowInline?: boolean }) {
      if (!s.hooks) throw new ProbeNotTestable('the browser could not record event listeners on this page');
      const list = await s.page.evaluate(readListeners, opts?.shadowInline ? { shadowInline: true } : undefined);
      if (!list) throw new ProbeNotTestable('the event listener hook did not run on this page');
      return list;
    },
    async hooks() {
      if (!s.hooks) throw new ProbeNotTestable('the browser could not record event listeners on this page');
      const all = await s.page.evaluate(readHooks, undefined);
      if (!all) throw new ProbeNotTestable('the event listener hook did not run on this page');
      return all;
    },
    setData(value) {
      data = value;
    },
    attach(value) {
      attachment = value;
    },
    discardPage() {
      discard = true;
    },
    async reloadedPage() {
      base = 'unknown';
      document.loading++;
      try {
        const loadedAt = Date.now();
        const atLoad = await whereNow(s.page, ctx.deadline, abort.signal);
        checkBotEvidence(s, s.page.url?.() ?? ctx.url, mark0, s.watch?.currentSince());
        s.guard.setPhase('between');
        const waited = await within(s.page.waitForTimeout(Math.max(QUIET_MS, opts.settleMs ?? PROBE_DEFAULTS.settleMs)), ctx.deadline, abort.signal);
        if (waited === 'cut') throw new ProbeNotTestable(opts.signal?.aborted ? CANCELLED : TIME_LEFT);
        const resp = s.watch?.current();
        if (!resp || s.watch?.ambiguous()) throw new ProbeNotTestable(LANDING_UNCHECKED);
        const loaded = await checkedLoad(s, resp, ctx.url, mark0, loadedAt, atLoad, ctx.deadline, abort.signal, true);
        checkBotEvidence(s, s.page.url?.() ?? ctx.url, mark0, s.watch?.currentSince());
        if (!owned || s.guard.mainFrameNavigations !== owned.navigation + 1
          || loaded.left.url === undefined || !sameDocument(loaded.left.url, owned.url)
          || !sameWhere(loaded.left, owned.document)) document.documentChanged = true;
        if (document.documentChanged) throw new ProbeNotTestable(DOCUMENT_CHANGED);
        base = document.expected = loaded.left;
        s.guard.setPhase({ probe: p.id, ...(p.sendsNothing ? { strict: true } : {}) });
      } catch (err) {
        document.documentChanged = true;
        if (!(err instanceof ProbeLoadError) && !isNotTestable(err)) throw err;
        reloadFailure ??= { reason: err.message, code: err instanceof ProbeLoadError ? err.code : 'not-loaded' };
        abort.abort();
        throw new ProbeNotTestable(reloadFailure.reason);
      } finally {
        document.loading--;
      }
    },
    keep(found) {
      kept = (cleanFindings(p, found) ?? []).filter((f) => f.status === 'failed');
      established?.(kept, true, mark0);
    },
    pictureFile(url) {
      return s.pictureFiles?.get(url) ?? Promise.resolve(undefined);
    },
    cdp() {
      shotSession ??= (async () => {
        if (!s.context.newCDPSession) return undefined;
        try {
          return await cdpSession(s.context, s.page);
        } catch {
          return undefined;
        }
      })();
      return shotSession;
    },
    ...(ev ? { evidence: ev.evidence, evidenceWanted: ev.wanted, evidenceHome: ev.home } : {}),
  };
  const withData = (run: ProbeRun): ProbeRun => {
    const d = probeData(data);
    const out = d === undefined ? run : { ...run, data: d };
    if (attachment !== undefined) setRunAttachment(out, attachment);
    return out;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The log's position when the probe started (for a timed-out run's kept failures). */
  const mark0 = s.guard.log.mark();
  /** The log's position when the probe's function was done: what the guard logs after it, the probe never saw. */
  let looked = s.guard.log.mark();
  let result: { run: ProbeRun; broken: boolean; leftByItself?: boolean };
  /** A timed-out run that keeps failures (`ProbeContext.keep`): they stand only if the settlement below finds nothing that voids the run. */
  let keptTimeout: ProbeRun | null = null;
  // Tie each host-side load (including reloadPage) to the guard's navigation reports and committed
  // address before adopting its identity. Keep the Page object for the document gate and CDP.
  const goto = s.page.goto;
  s.page.goto = async (...args) => {
    const navigation = s.guard.mainFrameNavigations;
    document.loading++;
    try {
      const response = await goto.apply(s.page, args);
      checkBotEvidence(s, s.page.url?.() ?? ctx.url, mark0);
      const refusal = response ? landingFailure(response) : undefined;
      if (refusal?.kind === 'challenge') s.challenge ??= refusal.reason;
      const reason = refusal?.kind === 'challenge' ? `${BOT_CHECK}: ${refusal.reason}`
        : isOtherSite(ctx.url, s.page.url?.() ?? args[0]) || response && isOtherSite(ctx.url, response.url()) ? lowerFirst(OTHER_SITE)
        : refusal ? lowerFirst(refusal.reason) : undefined;
      if (reason) {
        reloadFailure ??= { reason, code: refusal?.kind === 'challenge' ? 'challenge' : 'not-loaded' };
        document.documentChanged = true;
      }
      // An extra page navigation, another committed address, or an unanswered identity read cannot
      // prove this document belongs to our load. Keep that invalidation for the rest of the run.
      if (!abort.signal.aborted) {
        const after = await whereNow(s.page, deadline, abort.signal);
        checkBotEvidence(s, s.page.url?.() ?? ctx.url, mark0);
        if (typeof after !== 'string' && s.guard.mainFrameNavigations === navigation + 1
          && after.url !== undefined && sameDocument(after.url, args[0]) && !document.documentChanged) {
          owned = { navigation, url: args[0], document: after };
          base = document.expected = after;
        }
        else document.documentChanged = true;
      } else document.documentChanged = true;
      return response;
    } finally {
      document.loading--;
    }
  };
  try {
    const running = Promise.resolve().then(() => p.run(ctx));
    running.catch(() => {});
    const outcome = await Promise.race([
      running.then((findings) => {
        established?.((cleanFindings(p, findings) ?? []).filter((f) => f.status === 'failed'), false, mark0);
        return { findings };
      }),
      new Promise<{ timeout: true }>((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), Math.max(0, deadline - Date.now())); }),
      new Promise<{ cancelled: true }>((resolve) => {
        if (abort.signal.aborted) resolve({ cancelled: true });
        abort.signal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true });
      }),
    ]);
    // Report v2: the start page's failing elements this probe named but did not mark itself (keyboard
    // focus, hover content, ...), measured where they sit on the first screen. Bounded and time-boxed.
    if (ev && 'findings' in outcome && Array.isArray(outcome.findings)) await ev.markFailures(outcome.findings);
    if (opts.onFindings && 'findings' in outcome && Array.isArray(outcome.findings)) await hook(() => opts.onFindings!(s.page, p, target, outcome.findings as ProbeFinding[]));
    // The named elements, for the AI review that asked (data only, kept out of the report).
    const elements = opts.elementFacts && 'findings' in outcome && Array.isArray(outcome.findings) ? await elementFacts(s.page, outcome.findings as ProbeFinding[]) : undefined;
    looked = s.guard.log.mark();
    // The outcome is decided: a probe still running after its time box takes no more pictures.
    ev?.seal();
    if ('timeout' in outcome) {
      abort.abort();
      const reason = (opts.deadline ?? Infinity) <= started + p.timeoutMs ? TIME_LEFT : `timed out after ${duration(p.timeoutMs)}`;
      const timedOut = notTestableRun(p, target.url, 'timeout', reason, ms());
      // Failures measured before the time box ended stand (`ProbeContext.keep`), unless what voids a
      // run happened: a navigation the guard held (any stop, for probes whose blocked requests count),
      // a refused address, a lost gate, a stylesheet refused since the page loaded.
      const stop = stoppedSince(s.guard.log, mark0);
      const voided = !!stop && (stop.navigation || !p.onlyNavigationVoids) || !!documentRefused(s.page) || documentGate(s.page) === 'lost'
        || documentGate(s.page) === 'unavailable' || !!(await refusedSince(s.styles, opts.pace, target.url));
      const keptRun: ProbeRun | null = kept.length && !voided
        ? { ...timedOut, criteria: p.criteria.filter((c) => timedOut.criteria.includes(c) || kept.some((k) => k.criterion === c)), findings: [...kept, ...timedOut.findings.filter((f) => !kept.some((k) => k.criterion === f.criterion))] }
        : null;
      if (keptRun) keptTimeout = timedOut;
      result = { run: keptRun ?? timedOut, broken: true };
    } else if ('cancelled' in outcome) {
      result = { run: notTestableRun(p, target.url, 'error', CANCELLED, ms()), broken: true };
    } else {
      const cleaned = cleanFindings(p, outcome.findings);
      const findings = cleaned && unmounted ? unmountedFindings(p, cleaned, unmounted) : cleaned;
      result = findings
        ? { run: withData({ probe: p.id, kind: p.kind, page: target.url, criteria: [...p.criteria], status: 'ok', findings, ms: ms(), ...(elements ? { elements } : {}) }), broken: false }
        : { run: notTestableRun(p, target.url, 'error', 'the test could not run: it returned no results', ms()), broken: false };
    }
  } catch (err) {
    looked = s.guard.log.mark();
    ev?.seal();
    result = isNotTestable(err)
      ? { run: withData(notTestableRun(p, target.url, 'ok', clip(err.message, 300), ms())), broken: false }
      : { run: notTestableRun(p, target.url, 'error', `the test could not run: ${short(err)}`, ms()), broken: false };
  } finally {
    s.page.goto = goto;
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onCancel);
    deep?.removeEventListener('abort', onCancel);
    // The screenshot session goes with the run (in the background: a page that hangs never holds the runner).
    if (shotSession) void shotSession.then((c) => c?.detach?.()).catch(() => {});
    // From the moment the probe is done, what the page starts is decided as between probes (the
    // page's own navigations held). Until the call below answers, requests the browser reports are
    // still logged under this probe: they are the ones it started.
    s.guard.setPhase({ probe: p.id, ending: true, ...(p.sendsNothing ? { strict: true } : {}) });
  }
  if (!abort.signal.aborted || keptTimeout) {
    // A returned or retained finding must belong to the expected document: the starting document,
    // or the one loaded by the probe's own last reload. A page-initiated replacement voids it.
    // A check that hangs does not erase a confirmed failure; an answered replacement does.
    // This call into the page also lets the browser's reports of requests the probe started arrive.
    s.left = await whereNow(s.page, startedAt === undefined ? opts.deadline : deadline, opts.signal);
    if (s.left === 'gone' || (typeof s.left !== 'string' && !sameWhere(s.left, document.expected))) document.documentChanged = true;
  }
  if (document.documentChanged || document.loading) {
    result = { run: notTestableRun(p, target.url, result.run.status, DOCUMENT_CHANGED, ms()), broken: true };
    keptTimeout = null;
  }
  s.guard.setPhase('between');
  if (keptTimeout) {
    // The same settlement a run that finished gets, before its kept failures stand: the guard's late
    // decisions on what the probe started (a stop it never saw voids the run) and the page's
    // stylesheets since it loaded (one refused, or still on its way and then refused, voids it too).
    const done = (await s.guard.log.settled?.(END_SETTLE_MS, p.id)) ?? true;
    const late = guardStop(s.guard.log.since(mark0).filter((e) => e.probe === p.id && (!p.onlyNavigationVoids || e.kind === 'navigation')));
    if (!done || late || (await refusedSince(s.styles, opts.pace, target.url))) result = { ...result, run: keptTimeout };
  }
  if (!abort.signal.aborted) {
    // Late decisions on this probe's requests land now (each is logged under the probe it was made in).
    // A stop the probe never saw, or a guard that did not finish, means its clean results do not stand.
    const done = (await s.guard.log.settled?.(END_SETTLE_MS, p.id)) ?? true;
    const late = guardStop(s.guard.log.since(looked).filter((e) => e.probe === p.id && (!p.onlyNavigationVoids || e.kind === 'navigation')));
    if (result.run.status === 'ok' && (!done || late)) result = { ...result, run: notCleanAfterAll(p, result.run, done ? STOPPED_AFTER : UNSETTLED_AFTER) };
  }
  // The page's own writes the guard blocked while the probe ran (never sent; the probe went on): how
  // many, and to which hosts, in the run.
  const background = backgroundWrites(s.guard.log.events, p.id);
  if (background) result = { ...result, run: { ...result.run, backgroundWrites: background } };
  // Only the listener hook kept windows from opening: the run says so, and its clean results do not stand.
  const state = s.guard.popupSandbox;
  const local = s.guard.unsandboxedDocument !== null && !isLocalAddress(target.url);
  if (state === 'unavailable' || state === 'lost' || local) {
    if (result.run.status === 'ok') result = { ...result, run: notCleanAfterAll(p, result.run, UNSANDBOXED) };
    // A lost session: the next probe gets a fresh context (and a new session).
    if (state === 'lost') result = { ...result, broken: true };
    if (state === 'unavailable' || state === 'lost') result = { ...result, run: { ...result.run, popupSandbox: state } };
  }
  // The scan checks every address a page loads (`gatedBrowser`). A document of the page came from a
  // server address allowIp refuses, or its documents and windows were not all checked before they
  // loaded (the gate was lost): nothing measured on it stands, and the next probe gets a fresh context.
  const gate = documentGate(s.page);
  // A stylesheet the page needs, refused since the page was loaded (a reload by the probe, a sheet
  // added by script; one still on its way is waited for, briefly): the page was unstyled for some of
  // the run, so nothing it found stands either. Not after a time-out or cancel (that page may hang).
  const unstyled = !abort.signal.aborted && !!(await refusedSince(s.styles, opts.pace, target.url));
  // The page must still show the document the probe's results are of (`base`: the one it started on, or the
  // one it last loaded itself): one the page replaced while the probe ran (its own reload of its address,
  // which the guard lets go then) is another document, so nothing the probe found stands, and the page is
  // loaded again before the next probe. A page that did not say (it did not answer, it went away) is the
  // same: unconfirmed. A time-out that keeps failures is checked too; any other is not testable already.
  // (Only a run with results to lose: one already all not testable keeps its own reasons, a lost browser's included.)
  const stands = result.run.findings.some((f) => f.status !== 'not_testable');
  // Timeout findings need the final document's identity too, using the caller's signal (the probe's is already aborted).
  const check = !abort.signal.aborted ? { w: s.left, b: base } : stands ? { w: await whereNow(s.page, opts.deadline, opts.signal), b: base } : undefined;
  const after = check?.w;
  const was = check?.b ?? base;
  const unconfirmed = after !== undefined && (after === 'hung' || after === 'closed' || was === 'unknown');
  const moved = after !== undefined && !unconfirmed && (after === 'gone' || (typeof after !== 'string' && typeof was !== 'string' && after.doc !== was.doc));
  if ((moved || unconfirmed) && !abort.signal.aborted) result = { ...result, leftByItself: true };
  const unchecked = documentRefused(s.page) ? REFUSED_PAGE : gate === 'unavailable' || gate === 'lost' ? NO_DOCUMENT_GATE
    : unstyled ? UNSTYLED_PAGE : stands && moved ? LOADED_DURING : stands && unconfirmed ? UNCONFIRMED : undefined;
  if (gate === 'lost') {
    // The session checking the page's addresses closed (the browser closed, the page crashed):
    // nothing it found stands, and the run is done again in a new context (`runGroup`).
    result = { run: notTestableRun(p, target.url, 'error', GATE_LOST, result.run.ms), broken: true };
  } else if (unchecked) {
    const clean = notCleanAfterAll(p, result.run, unchecked);
    // Nothing the run found stands; a measured-only criterion then has no result from this run at all.
    const none = clean.findings.filter((f) => !measuredOnly(p, f.criterion)).map((f): ProbeFinding => (f.status === 'not_testable' ? f : { criterion: f.criterion, status: 'not_testable', ...(f.target ? { target: f.target } : {}), detail: unchecked }));
    result = { ...result, run: { ...clean, criteria: clean.criteria.filter((c) => !measuredOnly(p, c)), findings: none }, ...(unchecked === UNSTYLED_PAGE ? { broken: true } : {}) };
  }
  if (reloadFailure) result = { ...result, run: notTestableRun(p, target.url, 'ok', reloadFailure.reason, result.run.ms, reloadFailure.code), broken: true };
  // A verification reported during the probe, settlement or final identity read voids every finding,
  // including failures. Its typed reason stops all later probes without another load.
  const bot = botEvidence(s, s.page.url?.() ?? target.url, mark0);
  if (bot) result = { run: notTestableRun(p, target.url, 'error', bot, result.run.ms, 'challenge'), broken: true };
  // A page the probe could not confirm it left as it found it: the next probe gets a fresh context.
  if (discard) result = { ...result, broken: true };
  // Pictures of failures the run still reports (a run that timed out or errored keeps none).
  if (ev) await ev.flush(result.run);
  return result;
}

/** Startup, observation and completion all share the fresh probe's original deadline. */
async function runBoxed(s: Session, p: PageProbe, target: ProbeTarget, g: ProbeGroup, opts: ProbeRunnerOptions, plan: Promise<TargetPlan | null> | undefined, startedAt: number): ReturnType<typeof runOne> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  if (opts.signal?.aborted) cancel();
  else opts.signal?.addEventListener('abort', cancel, { once: true });
  // Validate established failures while there is still time. The deadline callback only reads this
  // state; it must not start another asynchronous completion check or lose the probe's own findings.
  let active = true;
  let revision = 0;
  const identity: ProbeDocument = { expected: s.left, loading: 0, documentChanged: false };
  let confirmed: { findings: ProbeFinding[]; kept: boolean; mark: number; checked: number } | undefined;
  const checkDocument = () => {
    const c = confirmed;
    if (!active || !c?.findings.length || identity.loading) return;
    // Independent of settlement: a hung identity check preserves established failures, but an
    // answered replacement invalidates them before the deadline callback can retain them.
    const expected = identity.expected;
    void whereNow(s.page, Math.min(startedAt + p.timeoutMs, opts.deadline ?? Infinity), abort.signal).then((after) => {
      if (active && !identity.loading && identity.expected === expected && typeof after !== 'string' && !sameWhere(after, expected)) identity.documentChanged = true;
    });
  };
  const validate = () => {
    const c = confirmed, version = revision;
    if (!active || !c?.findings.length) return;
    void Promise.all([
      refusedSince(s.styles, opts.pace, target.url),
      c.kept ? s.guard.log.settled?.(END_SETTLE_MS, p.id) ?? Promise.resolve(true) : Promise.resolve(true),
    ]).then(([unstyled, done]) => {
      if (active && confirmed === c && revision === version && !unstyled && done) c.checked = version;
    }).catch(() => {});
  };
  const changed = (r: { resourceType(): string }) => {
    if (!active || !confirmed) return;
    // A later stylesheet or request can invalidate the check already in flight. A kept failure
    // needs every request settled; a returned failure needs the document's styles to remain valid.
    if (confirmed.kept || r.resourceType() === 'stylesheet') { revision++; validate(); }
  };
  s.page.on?.('request', changed);
  s.page.on?.('requestfinished', changed);
  s.page.on?.('requestfailed', changed);
  s.page.on?.('response', (r) => changed(r.request()));
  s.page.on?.('framenavigated', (frame) => {
    if (active && frame === s.page.mainFrame?.()) { revision++; checkDocument(); validate(); }
  });
  const establish = (findings: ProbeFinding[], kept: boolean, mark: number) => {
    if (!active) return;
    confirmed = { findings, kept, mark, checked: -1 };
    checkDocument();
    validate();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      runOne(s, p, target, g, { ...opts, signal: abort.signal }, plan, startedAt, establish, identity),
      new Promise<Awaited<ReturnType<typeof runOne>>>((resolve) => {
        timer = setTimeout(() => {
          abort.abort();
          s.guard.setPhase('between');
          const bot = botEvidence(s, s.page.url?.() ?? target.url);
          const run = notTestableRun(p, target.url, bot ? 'error' : 'timeout', bot ?? (identity.documentChanged || identity.loading ? DOCUMENT_CHANGED
            : (opts.deadline ?? Infinity) <= startedAt + p.timeoutMs ? TIME_LEFT : `timed out after ${duration(p.timeoutMs)}`), Date.now() - startedAt, bot ? 'challenge' : undefined);
          const gate = documentGate(s.page);
          const c = confirmed;
          const stop = c?.kept && stoppedSince(s.guard.log, c.mark);
          const valid = c && !bot && !identity.documentChanged && !identity.loading && c.checked === revision && !documentRefused(s.page)
            && gate !== 'lost' && gate !== 'unavailable' && !(stop && (stop.navigation || !p.onlyNavigationVoids));
          if (valid) run.findings = [...c.findings, ...run.findings.filter((f) => !c.findings.some((k) => k.criterion === f.criterion))];
          resolve({ run, broken: true });
        }, Math.max(0, Math.min(startedAt + p.timeoutMs, opts.deadline ?? Infinity) - Date.now()));
      }),
    ]);
    // The navigation watcher can confirm a replacement during settlement or evidence flushing.
    if (identity.documentChanged || identity.loading) {
      const run = result.run.findings.length && result.run.findings.every((f) => f.status === 'not_testable') ? result.run
        : notTestableRun(p, target.url, result.run.status, DOCUMENT_CHANGED, Date.now() - startedAt);
      return { ...result, run, broken: true };
    }
    return result;
  } finally {
    active = false;
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', cancel);
  }
}

/** Background writes (`isBackgroundWrite`) logged under a probe: how many, and their hosts (at most 5). */
export function backgroundWrites(events: readonly GuardEvent[], probe: string): ProbeRun['backgroundWrites'] | undefined {
  const mine = events.filter((e) => e.probe === probe && isBackgroundWrite(e));
  if (!mine.length) return undefined;
  const hosts: string[] = [];
  for (const e of mine) {
    let host = '';
    try {
      host = new URL(e.url ?? '').host;
    } catch {
      continue;
    }
    if (host && !hosts.includes(host) && hosts.length < 5) hosts.push(host);
  }
  return { count: mine.length, hosts };
}

/**
 * The run with each clean result (a no_failures_found finding, or a declared criterion with no
 * finding) turned into not_testable with `reason`; failures and other results stay.
 */
function notCleanAfterAll(p: PageProbe, run: ProbeRun, reason: string): ProbeRun {
  // A measured-only criterion keeps its rule's own findings (its failures stand, as every failure here does; a
  // clean one says nothing about what else the page did) and gets none added (`PageProbe.measuredOnly`).
  const findings: ProbeFinding[] = run.findings.map((f) => (f.status === 'no_failures_found' && !f.advice && !measuredOnly(p, f.criterion) ? { criterion: f.criterion, status: 'not_testable', ...(f.target ? { target: f.target } : {}), detail: reason } : f));
  for (const c of run.criteria) if (!measuredOnly(p, c) && !run.findings.some((f) => f.criterion === c && !f.advice)) findings.push({ criterion: c, status: 'not_testable', detail: reason });
  return { ...run, findings };
}

/** A refusing HTTP status (`isRefusalStatus`); a detected bot check ends the group without retry. */
function isRefusedProbeLoad(opened: { error: string; code?: ProbeLoadFailure }): boolean {
  const m = /^the page did not load for this test: HTTP (\d{3})\b/.exec(opened.error);
  return !!m && isRefusalStatus(Number(m[1]));
}

/** An error of `openSession` the browser had no answer for, so worth one more load. */
const TRANSIENT_LOAD = /^the page did not load for this test: (no response from the server|.*net::ERR_|.*timeout|.*timed out|the page stopped responding)/i;

/**
 * One probe set on one page: probes in registry order; a fresh context after a timeout. A run the
 * browser closed under (or whose context could not be opened because it was closed) is run again,
 * once, in a new context: a host that opens a new browser (`reconnectingBrowser`) lets it finish
 * there; when it fails the same way again its result is `BROWSER_LOST`. Never throws.
 */
/** A coverage hook, bounded and silent (`ProbeRunnerOptions.onPageOpened`, `onFindings`). */
async function hook(run: () => Promise<void> | void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(run), new Promise<void>((r) => { timer = setTimeout(r, HOOK_MS); })]);
  } catch {
    // Observation only.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Optional tests that go on on a required job's page once its required tests (and their late passes) are done,
 * with no second load (`createProbeRunner`, queue rule 2). `begin` is asked once, only with the page still open
 * and usable: the tests to run on it now (same context group), the options they run under (their own stop, their
 * own `onRun`, the optional load turn) and the admission asked before each of them; null when there are none or
 * they may not start now. The runs of those tests are handed on through those options only.
 */
export interface GoOn {
  begin(): { probes: PageProbe[]; opts: ProbeRunnerOptions; admit: () => boolean } | null;
}

async function runGroup(
  given: BrowserLike, target: ProbeTarget, g: ProbeGroup, opts: ProbeRunnerOptions, clock: Clock, plan?: Promise<TargetPlan | null>,
  /**
   * Optional work only (the queue rules, `createProbeRunner`): asked before each test starts, and before its
   * page is opened. False ends the group there: the tests not yet started give no run at all.
   */
  admit?: () => boolean,
  /** A required job's page that may go on with optional tests (`GoOn`). */
  goOn?: GoOn,
): Promise<ProbeRun[]> {
  let browser = given;
  /** Loads the site refused, tried again in another session (`refusedRetry`). */
  let refusedTries = 0;
  const runs: ProbeRun[] = [];
  const remaining = [...g.probes];
  let s: Session | null = null;
  /** Optional work: each test is asked for once more immediately before it starts (`runOne`). */
  let inner: RunOptions = admit ? { ...opts, admit } : opts;
  /** Probes run again after the browser closed under them, and whether opening a context was tried again. */
  const again = new Set<string>();
  const boxedStarts = new Map<string, number>();
  let closingDeadline: number | undefined;
  const close = (session: Session, deadline?: number) => within(session.context.close().catch(() => {}), Math.min(Date.now() + CLOSE_MS, deadline ?? Infinity, opts.deadline ?? Infinity), opts.signal);
  let reopened = false;
  /** The page was loaded once more after a load that had no answer (no response, a network error, a hang). */
  let reloaded = false;
  const emitted = new Set<ProbeRun>();
  /**
   * First passes of the tests with a late pass (`PageProbe.late`), held back until every other test of the
   * page has run, with the session, the load and the document (`whereNow`) they ran on.
   */
  const pendingLate: { p: PageProbe; run: ProbeRun; s: Session; reloads: number; where: Session['left'] }[] = [];
  /**
   * The late passes, on the same page in the same document (review r3: never one the page or a test loaded
   * again, even at the same address); a first pass that cannot have one stands as it is. A late pass that
   * timed out retires the session, as any test that times out does (what it started may still be running):
   * no later late pass runs on it, and their first passes stand.
   */
  const runLate = async () => {
    while (pendingLate.length) {
      const item = pendingLate.shift()!;
      let run = item.run;
      // Optional work told to stop (`admit`) goes on into no late pass: the first pass stands as it is.
      if (s && s === item.s && (s.reloads ?? 0) === item.reloads && !opts.signal?.aborted && item.p.late && !(admit && !admit())) {
        // Admission is part of this late pass's own box; it also takes the scan's deadline and signal.
        const startedAt = Date.now();
        const deadline = Math.min(startedAt + item.p.late.timeoutMs, opts.deadline ?? Infinity);
        closingDeadline = deadline;
        try {
          const now = await whereNow(s.page, deadline, opts.signal);
          checkBotEvidence(s, s.page.url?.() ?? target.url);
          if (typeof now !== 'string' && sameWhere(now, item.where)) {
            const late = await latePass(s, item.p, item.run, target, g, opts, startedAt);
            run = late.run;
            clock.probeMs[item.p.id] = run.ms;
            if (late.broken) {
              await close(s, deadline);
              s = null;
            }
          } else if (now === 'hung' || now === 'closed') {
            await close(s, deadline);
            s = null;
          }
        } catch (err) {
          // A refused late admission cannot undo any of the completed first passes.
          if (!(err instanceof ProbeLoadError)) throw err;
          if (s) await close(s, deadline);
          s = null;
        }
      }
      runs.push(run);
      emit();
    }
  };
  const emit = () => {
    for (const run of runs) {
      if (emitted.has(run)) continue;
      emitted.add(run);
      try {
        opts.onRun?.(run);
      } catch {
        // A listener's bug must not stop the probes.
      }
    }
  };
  /** A bot check stood in front of the page: nothing more runs on it (and no optional test goes on on it). */
  let challenged = false;
  /** The tests in `remaining`, one after another (the loop of a group; again for the tests that go on, `goOn`). */
  const drain = async () => {
    while (remaining.length) {
      if (opts.signal?.aborted || Date.now() >= (opts.deadline ?? Infinity)) {
        runs.push(...remaining.map((p) => notTestableRun(p, target.url, 'error', opts.signal?.aborted ? CANCELLED : TIME_LEFT)));
        break;
      }
      // The deep probes were stopped (the finish plan): those left are not run.
      if (opts.deepSignal?.aborted && remaining.some((p) => p.tier !== 'core')) {
        for (const p of remaining.filter((x) => x.tier !== 'core')) runs.push(notTestableRun(p, target.url, 'error', CANCELLED));
        remaining.splice(0, remaining.length, ...remaining.filter((x) => x.tier === 'core'));
        if (!remaining.length) break;
      }
      if (admit && !admit()) break;
      if (!s) {
        const next = remaining[0]!;
        const box = boxedStarts.get(next.id);
        const opened = box === undefined ? await openSession(browser, target, g, opts, clock)
          : await openWithin(browser, target, g, opts, clock, Math.max(0, box + next.timeoutMs - Date.now()));
        if ('error' in opened) {
          // The scan was cancelled while the page loaded: not run.
          if (opts.signal?.aborted) {
            runs.push(...remaining.map((p) => notTestableRun(p, target.url, 'error', CANCELLED)));
            break;
          }
          // No browser session came free within the pool's bound (src/sessions.ts SESSION_WAIT): not tried
          // again (that is another full wait), and never a lost browser, which would take the scan's
          // score (review r2): not tested, said as such.
          if (isSessionWait(opened.error)) {
            runs.push(...remaining.map((p) => notTestableRun(p, target.url, 'error', SESSION_WAIT_PAGE, 0, 'not-loaded')));
            break;
          }
          // The browser was closed: once more (a host that reopens it gives a new one).
          if (isWorkLost(opened.error) && !reopened && (box === undefined || !again.has(next.id))) {
            if (box !== undefined) again.add(next.id);
            reopened = true;
            continue;
          }
          // The site refused the load: once more in a session that has not refused it (src/sessions.ts).
          if (box === undefined && opts.refusedRetry && refusedTries < REFUSED_RETRIES && !opts.signal?.aborted && isRefusedProbeLoad(opened)) {
            const other = await opts.refusedRetry(target.url);
            if (other) {
              refusedTries++;
              browser = other;
              continue;
            }
          }
          // A load the browser had no answer for (no response, a network error, a hang): loaded once
          // more (through the pace, like any load); the site's own answers (HTTP 4xx/5xx, a refused
          // stylesheet, a refused address) are not.
          if (box === undefined && TRANSIENT_LOAD.test(opened.error) && !reloaded) {
            reloaded = true;
            continue;
          }
          if (box !== undefined) {
            if (opened.code === 'challenge') {
              challenged = true;
              runs.push(...remaining.map((p) => notTestableRun(p, target.url, 'error', opened.error, p === next ? Date.now() - box : 0, 'challenge')));
              remaining.length = 0;
              break;
            }
            runs.push(notTestableRun(next, target.url, opened.error === TIMED_OUT ? 'timeout' : 'error', opened.error === TIMED_OUT ? `timed out after ${duration(next.timeoutMs)}` : isWorkLost(opened.error) ? BROWSER_LOST : opened.error, Date.now() - box, isWorkLost(opened.error) ? 'browser-lost' : opened.code));
            remaining.shift();
            continue;
          }
          const lost = isWorkLost(opened.error);
          const code: ProbeLoadFailure = lost ? 'browser-lost' : ('code' in opened && opened.code) || 'not-loaded';
          runs.push(...remaining.map((p) => notTestableRun(p, target.url, 'error', lost ? BROWSER_LOST : opened.error, 0, code)));
          break;
        }
        s = opened;
        reopened = false;
        if (opts.onPageOpened) await hook(() => opts.onPageOpened!(opened.page, target));
        // Optional work: its time may have run out while its page loaded. Asked again before any test of it starts.
        if (admit && !admit()) break;
      }
      const p = remaining.shift()!;
      try {
        opts.onStart?.({ probe: p.id, page: target.url });
      } catch {
        // A listener's bug must not stop the probes.
      }
      // A probe that needs the page's timers as the page set them, after an earlier probe on this page ran
      // some early (`freshAfterFiredTimers`): the page loaded again in a fresh context, inside its time box.
      let startedAt: number | undefined;
      closingDeadline = undefined;
      if (p.freshAfterFiredTimers) {
        // One absolute time box: from before the flag is read, through closing the page, the fresh load
        // and the probe itself. Each step gets only what is left of it.
        const firstAttempt = !boxedStarts.has(p.id);
        startedAt = boxedStarts.get(p.id) ?? Date.now();
        boxedStarts.set(p.id, startedAt);
        const deadline = Math.min(startedAt + p.timeoutMs, opts.deadline ?? Infinity);
        closingDeadline = deadline;
        const left = () => Math.max(0, deadline - Date.now());
        const fired = firstAttempt ? await timersRunEarly(s.page, Math.min(PAGE_CALL_MS, left()), opts.signal) : 0;
        checkBotEvidence(s, s.page.url?.() ?? target.url);
        if (opts.signal?.aborted || Date.now() >= (opts.deadline ?? Infinity)) {
          const reason = opts.signal?.aborted ? CANCELLED : TIME_LEFT;
          const run = notTestableRun(p, target.url, 'error', reason, Date.now() - startedAt);
          runs.push(run, ...remaining.map((next) => notTestableRun(next, target.url, 'error', reason)));
          clock.probeMs[p.id] = run.ms;
          remaining.length = 0;
          break;
        }
        if (fired !== 0) {
          // A close that hangs (a browser busy elsewhere) is not waited for past CLOSE_MS.
          await within(s.context.close().catch(() => {}), Math.min(Date.now() + CLOSE_MS, deadline), opts.signal);
          s = null;
          let fresh = left() > 0 ? await openWithin(browser, target, g, opts, clock, left())
            : { error: opts.signal?.aborted ? CANCELLED : Date.now() >= (opts.deadline ?? Infinity) ? TIME_LEFT : TIMED_OUT };
          // The browser closed under the load: tried once more, in the same box.
          if ('error' in fresh && isWorkLost(fresh.error) && !again.has(p.id) && left() > 0 && !opts.signal?.aborted) {
            again.add(p.id);
            fresh = await openWithin(browser, target, g, opts, clock, left());
          }
          (clock.freshMs ??= {})[p.id] = Date.now() - startedAt;
          if ('error' in fresh) {
            const ms = Date.now() - startedAt;
            const run = fresh.error === TIMED_OUT ? notTestableRun(p, target.url, 'timeout', `timed out after ${duration(p.timeoutMs)} (${FRESH_AFTER_TIMERS})`, ms)
              : fresh.error === CANCELLED ? notTestableRun(p, target.url, 'error', CANCELLED, ms)
              : fresh.error === TIME_LEFT ? notTestableRun(p, target.url, 'error', TIME_LEFT, ms)
              : isWorkLost(fresh.error) ? notTestableRun(p, target.url, 'error', BROWSER_LOST, ms, 'browser-lost')
              : notTestableRun(p, target.url, 'error', `${fresh.error} (${FRESH_AFTER_TIMERS})`, ms, fresh.code ?? 'not-loaded');
            runs.push(run);
            clock.probeMs[p.id] = run.ms;
            emit();
            if (fresh.code === 'challenge') {
              challenged = true;
              runs.push(...remaining.map((next) => notTestableRun(next, target.url, 'error', fresh.error, 0, 'challenge')));
              remaining.length = 0;
              break;
            }
            continue;
          }
          s = fresh;
          if (opts.onPageOpened) await hook(() => opts.onPageOpened!(fresh.page, target));
        }
      }
      const outcome = startedAt === undefined ? await runOne(s, p, target, g, inner, plan)
        : await runBoxed(s, p, target, g, inner, plan, startedAt);
      const { broken, leftByItself } = outcome;
      let { run } = outcome;
      const closedUnder = run.status === 'error' && run.findings.some((f) => isWorkLost(f.detail));
      if (closedUnder && !again.has(p.id) && !opts.signal?.aborted && (startedAt === undefined || Date.now() < startedAt + p.timeoutMs)) {
        // Run again, in a new context (and a new browser, if the host opens one).
        again.add(p.id);
        remaining.unshift(p);
        await close(s, startedAt === undefined ? undefined : startedAt + p.timeoutMs);
        s = null;
        continue;
      }
      const firstSession = s;
      const firstReloads = s.reloads ?? 0;
      const firstWhere = s.left;
      // Record the completed result before cleanup: a challenged reset stops later work, not this run.
      if (closedUnder) run = { ...run, findings: run.findings.map((f) => ({ ...f, detail: BROWSER_LOST, loadFailure: 'browser-lost' as const })) };
      if (p.late && !closedUnder && run.status === 'ok') pendingLate.push({ p, run, s: firstSession, reloads: firstReloads, where: firstWhere });
      else runs.push(run);
      // Pending late passes are further tests of this session too. A boxed last ordinary probe still
      // resets within its original box; only the separate late pass owns the subsequent close.
      const more = remaining.length || (p.late && run.status === 'ok') || pendingLate.some((item) => item.s === s);
      // Cleanup is part of a boxed run, including its elapsed-time report. It never receives a new box.
      const reset = () => resetSession(s!, target, opts, clock, leftByItself);
      if (broken || (startedAt !== undefined && !more) || (more && (p.sendsNothing || !(startedAt === undefined
        ? await reset() : (await within(reset(), Math.min(startedAt + p.timeoutMs, opts.deadline ?? Infinity), opts.signal)) === true)))) {
        await close(s, startedAt === undefined ? undefined : startedAt + p.timeoutMs);
        s = null;
      }
      if (startedAt !== undefined) run.ms = Date.now() - startedAt;
      clock.probeMs[p.id] = run.ms;
      emit();
      const bot = run.findings.find((f) => f.loadFailure === 'challenge');
      if (bot) {
        challenged = true;
        runs.push(...remaining.map((next) => notTestableRun(next, target.url, 'error', bot.detail ?? BOT_CHECK, 0, 'challenge')));
        remaining.length = 0;
        break;
      }
    }
  };
  try {
    await drain();
    // Every other test of the page has run (on the motion page: the timing test too): the late passes.
    await runLate();
    // A required job's page goes on with optional tests (queue rule 2), only while it is open and was not
    // challenged. Every run so far is handed on under the required job's options first.
    if (goOn && s && !challenged && !opts.signal?.aborted) {
      emit();
      const next = goOn.begin();
      if (next?.probes.length) {
        opts = next.opts;
        admit = next.admit;
        inner = { ...opts, admit };
        remaining.push(...next.probes);
        // The page as the next test needs it, under the optional work's own stop and load turn: scrolled to the
        // top with nothing focused, and loaded again when the last test left it on another document.
        if (admit()) {
          if (!(await resetSession(s, target, opts, clock))) {
            await close(s);
            s = null;
          }
          await drain();
          await runLate();
        }
      }
    }
  } catch (err) {
    // A bot check on a reset ends the remaining tests too; other unexpected failures report them untested.
    runs.push(...pendingLate.splice(0).map((x) => x.run));
    const done = new Set(runs.map((r) => r.probe));
    runs.push(...g.probes.filter((p) => !done.has(p.id)).map((p) => notTestableRun(p, target.url, 'error', `the test could not run: ${short(err)}`, 0, err instanceof ProbeLoadError ? err.code : undefined)));
  } finally {
    if (s) await close(s, closingDeadline);
  }
  emit();
  return runs;
}

/**
 * A test's late pass (`PageProbe.late`), run like any test on the session (its own time box, the guard's
 * rules, the same settlement), with the first pass's findings. Its findings are the test's for the page
 * when it ran to the end; otherwise (it threw, timed out, was cancelled, or the page left its document)
 * the first pass stands exactly as it was, every failure it found included.
 */
async function latePass(s: Session, p: PageProbe, first: ProbeRun, target: ProbeTarget, g: ProbeGroup, opts: ProbeRunnerOptions, startedAt: number): Promise<{ run: ProbeRun; broken: boolean }> {
  const late = p.late!;
  let completed = false;
  const { waitFor: _waitFor, usesPlan: _usesPlan, late: _late, ...rest } = p;
  const pass: PageProbe = {
    ...rest,
    timeoutMs: late.timeoutMs,
    async run(ctx) {
      const found = await late.run(ctx, first.findings);
      completed = true;
      return found;
    },
  };
  const expected = s.left;
  const { run, broken, leftByItself } = await runBoxed(s, pass, target, g, opts, undefined, startedAt);
  // Completion includes settlement and evidence calls: cancellation during any of them keeps the first pass.
  if (opts.signal?.aborted || p.tier !== 'core' && opts.deepSignal?.aborted || !completed || run.status !== 'ok' || broken || leftByItself) return { run: first, broken };
  // Every late result needs a fresh identity read after all completion awaits, within its original box.
  const after = await whereNow(s.page, Math.min(startedAt + late.timeoutMs, opts.deadline ?? Infinity), opts.signal);
  if (opts.signal?.aborted || p.tier !== 'core' && opts.deepSignal?.aborted || typeof after === 'string' || !sameWhere(after, expected)) return { run: first, broken: true };
  const writes = [first.backgroundWrites, run.backgroundWrites].filter((w): w is NonNullable<ProbeRun['backgroundWrites']> => !!w);
  const merged: ProbeRun = {
    ...first,
    findings: run.findings,
    ms: first.ms + run.ms,
    // The first pass's data stays as it was; the late pass's goes beside it.
    ...(run.data !== undefined ? { data: first.data !== null && typeof first.data === 'object' && !Array.isArray(first.data) ? { ...(first.data as object), late: run.data } : first.data === undefined ? { late: run.data } : first.data } : {}),
    ...(first.popupSandbox ?? run.popupSandbox ? { popupSandbox: (first.popupSandbox ?? run.popupSandbox)! } : {}),
    ...(writes.length ? { backgroundWrites: { count: writes.reduce((t, w) => t + w.count, 0), hosts: [...new Set(writes.flatMap((w) => w.hosts))].slice(0, 5) } } : {}),
  };
  return { run: merged, broken };
}

/** The page's plan, or null once the scan is cancelled (the plan promise itself is bounded by the budget). */
function waitPlan(plan: Promise<TargetPlan | null>, signal?: AbortSignal): Promise<TargetPlan | null> {
  if (!signal) return plan;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    plan.then(resolve, () => resolve(null)).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Loads the page in a context of its own (desktop width, guard and listener hook, as for a test) and
 * takes the navigator's input from it. No test ever runs on this page. Null when it did not load or the
 * summary could not be made.
 */
async function capturePage(browser: BrowserLike, target: ProbeTarget, opts: ProbeRunnerOptions, clock: Clock, signal: AbortSignal, withShot: boolean): Promise<Awaited<ReturnType<typeof capturePlanInput>>> {
  if (signal.aborted) return null;
  const g: ProbeGroup = { viewport: DEFAULT_PROBE_VIEWPORT, contextOptions: {}, probes: [] };
  // The plan's budget (or the scan's cancel) closes the capture's context at once, a load still running included.
  let context: ContextLike | undefined;
  const onAbort = () => { void context?.close().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const opened = await openSession(browser, target, g, opts, clock, (c) => { context = c; if (signal.aborted) onAbort(); });
    if ('error' in opened || signal.aborted) return null;
    const listeners = opened.hooks ? await opened.page.evaluate(readListeners, undefined).catch(() => null) : null;
    return signal.aborted ? null : await capturePlanInput(opened.page, listeners, withShot);
  } finally {
    signal.removeEventListener('abort', onAbort);
    await context?.close().catch(() => {});
  }
}

export interface ProbeRunner {
  /** The probes this runner runs (deep ones only with `full`), in registry order. */
  readonly probes: readonly PageProbe[];
  /**
   * Queues the probe sets for this page, or only the probes named in `only`. Each probe runs at
   * most once per address, however often the page is added. Returns at once.
   *
   * `optional`: probes (of those queued by this call) that are extra coverage. They never take time or a
   * context from required work, and one that does not happen leaves no trace: no "not tested" run, nothing
   * counted as cut short (the queue rules, `createProbeRunner`). `units`: how the optional ones are split
   * into jobs (`OptionalUnit`); without them, one job per context group.
   */
  add(target: ProbeTarget, only?: readonly string[], more?: { optional?: readonly string[]; units?: readonly OptionalUnit[] }): void;
  /**
   * Lets the runner open `slots` more contexts at once (up to `MAX_PROBE_SLOTS` in all), for example
   * when the audit has finished with pages of its own and the browser has room.
   */
  lend(slots: number): void;
  /** Waits for every queued run. Runs are ordered by page index, then registry order. */
  finish(): Promise<ProbeRun[]>;
  /** Runs queued so far (one probe on one page), and runs finished of those. */
  counts(): { queued: number; done: number };
  /**
   * Whole tests: the probes with a run queued so far, and of those the ones whose every queued run has
   * finished (a later page can queue another run, so `done` can go back while pages are still added).
   */
  tests(): { queued: number; done: number };
  /**
   * For a scan past its time limit: one `not_testable` run (marked `timeLimit`) for each probe queued
   * on a page with no run in `finished`, so a test that never came back is never read as clean.
   */
  unfinished(finished: readonly ProbeRun[]): ProbeRun[];
  /**
   * For a scan past its time limit, what `finish` would give from the runs that did finish: in page and
   * registry order, with every probe's cross-page findings (`acrossPages`) computed on them, and the
   * queued runs that never came back as `unfinished` gives them. Nothing computed after assembly is
   * dropped on the cut-short path.
   */
  partial(finished: readonly ProbeRun[]): ProbeRun[];
}

/** Most contexts the runner opens at once for required work, lent slots included. */
export const MAX_PROBE_SLOTS = 8;
/**
 * Most contexts a runner opens at once, optional work's extra tabs included (`ProbeRunnerOptions.maxSlots`):
 * twice what required work may hold. The tests that need them mostly wait on the page's timers, animations and
 * focus moves; the site never gets more loads at once for it (the optional load turn, `optionalLoadTurn`).
 */
export const MAX_TEST_TABS = 16;

/**
 * The probe runner for one scan. Pages can be added while the audit is still running; at most
 * `concurrency` contexts are open at once, so the probes do not starve the audit pool. Deep probes
 * run only with `full`.
 */
export function createProbeRunner(browser: BrowserLike, probes: readonly PageProbe[], options: ProbeRunnerOptions): ProbeRunner {
  // Pictures wait in a pool until the runs are final; without the caller's pool, this runner commits its own.
  const ownPool = options.evidence && !options.evidencePool ? createProbeEvidencePool() : undefined;
  const opts: ProbeRunnerOptions = ownPool ? { ...options, evidencePool: ownPool } : options;
  const selected = probes.filter((p) => p.tier === 'core' || opts.full);
  const order = new Map<string, number>();
  for (const [i, p] of selected.entries()) {
    if (order.has(p.id)) throw new Error(`Duplicate probe id: ${p.id}`);
    order.set(p.id, i);
  }
  // A page's heavier groups start first (their probes' time boxes as the measure of work), so the
  // last sampled page's longest group is not left to run alone at the end.
  const cost = (g: ProbeGroup) => g.probes.reduce((t, p) => t + p.timeoutMs, 0);
  const groups = groupProbes(selected).map((g, i) => ({ g, i })).sort((a, b) => cost(b.g) - cost(a.g) || a.i - b.i).map((x) => x.g);
  const base = Math.min(Math.max(Math.floor(opts.concurrency ?? PROBE_DEFAULTS.concurrency), 1), MAX_PROBE_SLOTS);
  let limit = base;
  /**
   * The queue rules (docs/redteam-triage-coverage.md, "Queue rules"). A job is one page's tests that share a
   * page load, and it is either required or optional (extra coverage, `add` with `optional`); a required job's page may go on with optional tests once its own are done (rule 2):
   *
   * 1. Required jobs (`queue`) start first, in the order queued, within the room (`concurrency` and what was
   *    lent). An optional job (`optionalQueue`) starts only when no required job is waiting.
   * 2. A page's tests that would share a load are split by that: the required ones in one job, the optional
   *    ones in jobs of their own (one per unit, `OptionalUnit`), each opening the page again when its turn
   *    comes, except what goes on on the required job's page (perf/split-tests, 2026-11-10): once the required
   *    tests (and their late passes) are done and the page is still open, its riders, and the page's units of
   *    the same context group no tab has started yet, run on that page with no second load, as optional work
   *    (rules 3 to 5 apply from there; the context counts as optional from then on). Only when they may start
   *    then (in their time, no required work waiting): otherwise the riders are a job of their own and the
   *    units stay queued.
   * 3. The runner asks again before an optional job's page is opened, once the page has loaded, and
   *    immediately before each of its tests starts (`runGroup`'s `admit`, and `runOne` after the test's own
   *    waits for the page's plan and the page's settling): past `optionalUntil`, or once the scan stopped its
   *    tests or its deep tests, the rest of the job is forgotten, and the skip is recorded
   *    (`onOptionalSkipped`); with required work waiting, the rest goes back to the end of the optional queue.
   * 4. Required work queued while every context is taken stops the optional job that started last
   *    (`yieldToRequired`): what that job had not finished goes back to the end of the optional queue, as
   *    often as that happens. Giving way is never a reason to drop a test: which tests a scan ran must not
   *    depend on how its jobs interleaved (only on its time, rule 3).
   * 5. An optional run that did not happen (not started, stopped, out of time, or its own load of the page
   *    failed, was refused or challenged, or lost its browser) leaves no trace: no run from `finish` or
   *    `partial`, none handed to `onRun`, not counted, never "unfinished". One filter decides it
   *    (`optionalCut`), and a run that ends after its job was stopped is cut whatever it says. What is
   *    handed to `onRun` and what `finish` gives are the same runs: each is listed as it is handed on. A
   *    forgotten optional test is not queued again by a later `add` of its page (only as a required one).
   * 6. `finish` waits for every required job, and for the optional ones only until they are done or the scan
   *    stops its tests (`signal`).
   * 7. A page plan (the navigator) that only optional tests want is optional work: its capture waits in the
   *    optional queue, is not made past the cutoff, and the wait for it counts from when the capture starts.
   *    The cutoff is asked again immediately before the navigator would be called: past it there is no call,
   *    and the plan is recorded as `cutoff` (`PlanEvent.outcome`).
   * 8. Optional work may open `optionalTabs` contexts beyond the room (at most `maxSlots` in all); required
   *    work never uses them. Its loads take the optional load turn (`optionalLoadTurn`), which gives way to
   *    every other load and counts against the same pages at once: more tabs, never more loads at once on
   *    the site. "Required work waiting" (rules 3 and 4) means work that could start if an optional job gave
   *    its context back.
   */
  /** A job, given its slot: a required job whose page goes on with optional tests hands its slot over (`toOptional`). */
  type Job = (slot: { toOptional(): void }) => Promise<void>;
  /** A queued job; `work`: an optional unit not started yet, which its page's required job may take over (rule 2). */
  interface Queued { job: Job; work?: OptionalWork }
  const queue: Queued[] = [];
  const optionalQueue: Queued[] = [];
  /** What `finish` waits for: the required jobs (and their plans), and the optional ones. */
  const pending: Promise<void>[] = [];
  const optionalPending: Promise<void>[] = [];
  const results: { index: number; runs: ProbeRun[] }[] = [];
  /** Probe ids queued per address. */
  const added = new Map<string, Set<string>>();
  /** Each address's page index (scan order), for `partial`. */
  const targetIndex = new Map<string, number>();
  /** Probe ids queued as optional and not yet run or forgotten, per address (`unfinished` leaves them out). */
  const optionalIds = new Map<string, Set<string>>();
  /** Probe ids ever queued as optional, per address (`partial` filters their cut runs). */
  const optionalEver = new Map<string, Set<string>>();
  /** Optional jobs holding a context now, oldest first, each with the switch that stops it. */
  const runningOptional: { stop: AbortController; yielded: boolean }[] = [];
  /** `finish` returned after a stop of the tests: optional work still running is not used. */
  let abandoned = false;
  const navigator = opts.navigator && opts.navigator.maxTargets > 0 ? opts.navigator : undefined;
  const planEvent = (e: PlanEvent) => {
    try {
      navigator?.onPlan?.(e);
    } catch {
      // Diagnostics must not stop the probes.
    }
  };
  /** The optional work's time is over (`optionalUntil`). */
  const pastCutoff = () => {
    try {
      const until = opts.optionalUntil?.();
      return typeof until === 'number' && Date.now() >= until;
    } catch {
      return false;
    }
  };
  /** The options optional work runs under: its own load turn (rule 8). */
  const withOptionalTurn = (o: ProbeRunnerOptions): ProbeRunnerOptions => (opts.optionalLoadTurn ? { ...o, loadTurn: opts.optionalLoadTurn } : o);
  /** Optional work is no longer started: the scan stopped its tests or its deep tests, or its time is over. */
  const optionalOver = () => !!(opts.signal?.aborted || opts.deepSignal?.aborted) || pastCutoff();
  /** Why optional work did not happen, for the record. */
  const whySkipped = (): OptionalSkip['why'] => (abandoned || opts.signal?.aborted || opts.deepSignal?.aborted ? 'stopped' : pastCutoff() ? 'cutoff' : 'failed');
  /** Each page's plan (navigator only): its promise settles within the navigator's budget, null when there is none. */
  interface PagePlan {
    slot: Promise<TargetPlan | null>;
    /** A required test wants it after all: its capture moves to the front of the required queue. */
    promote(): void;
  }
  const plans = new Map<string, PagePlan>();
  /**
   * Queues the page's capture (one load, taking a context slot like a test) and asks the navigator. The
   * answer counts only within the budget; the scan's cancel ends the wait too. For required tests the
   * capture goes to the front of the required queue and the budget counts from now. For optional tests
   * only (rule 7) it waits in the optional queue, is dropped past the cutoff, gives its context back to
   * required work, and the budget counts from when it starts.
   */
  const planFor = (target: ProbeTarget, optionalOnly: boolean): PagePlan => {
    const nav = navigator!;
    const t0 = Date.now();
    const stop = new AbortController();
    let done = false;
    let optional = optionalOnly;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveSlot!: (p: TargetPlan | null) => void;
    const slot = new Promise<TargetPlan | null>((r) => { resolveSlot = r; });
    const settle = (plan: TargetPlan | null, e: Omit<PlanEvent, 'page' | 'ms'>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onCancel);
      stop.abort();
      planEvent({ page: target.url, ms: Date.now() - t0, ...e });
      resolveSlot(plan);
    };
    const late = () => settle(null, { outcome: 'late', targets: 0 });
    const onCancel = late;
    const startBudget = () => { timer ??= setTimeout(late, Math.max(0, nav.budgetMs)); };
    opts.signal?.addEventListener('abort', onCancel, { once: true });
    if (opts.signal?.aborted) onCancel();
    const waits = optional ? optionalPending : pending;
    waits.push(slot.then(() => {}));
    // The capture's own context is closed before `finish` returns.
    let captured!: () => void;
    waits.push(new Promise<void>((r) => { captured = r; }));
    const me = { stop, yielded: false };
    const capture: Queued = {
      job: async () => {
        let input: Awaited<ReturnType<typeof capturePlanInput>> = null;
        try {
          if (done) return;
          if (optional) {
            if (abandoned || optionalOver()) return settle(null, { outcome: pastCutoff() ? 'cutoff' : 'late', targets: 0 });
            runningOptional.push(me);
          }
          startBudget();
          input = await capturePage(browser, target, optional ? withOptionalTurn(opts) : opts, { openMs: 0, loadMs: 0, settleMs: 0, loads: 0, probeMs: {} }, stop.signal, !!nav.screenshot);
        } catch {
          input = null;
        } finally {
          const at = runningOptional.indexOf(me);
          if (at >= 0) runningOptional.splice(at, 1);
          captured();
        }
        if (done) return;
        if (!input) {
          settle(null, { outcome: 'no-capture', targets: 0 });
          return;
        }
        const { summary, screenshot } = input;
        // Asked again immediately before the navigator is called: the capture may have used up the optional
        // work's time, and a plan for tests that will not run is a call for nothing.
        if (optional && pastCutoff()) return settle(null, { outcome: 'cutoff', targets: 0, elements: summary.elements.length });
        // The model call does not hold a context slot.
        void (async () => {
          try {
            const raw = await nav.plan({ url: target.url, summary, ...(screenshot ? { screenshot } : {}), maxTargets: nav.maxTargets }, stop.signal);
            if (!raw) return settle(null, { outcome: 'failed', targets: 0, elements: summary.elements.length });
            const plan = resolvePlan(summary, raw, nav.maxTargets);
            settle(plan, { outcome: 'planned', targets: plan.targets.length, cached: plan.cached, elements: summary.elements.length });
          } catch {
            settle(null, { outcome: 'failed', targets: 0, elements: summary.elements.length });
          }
        })();
      },
    };
    if (optional) optionalQueue.push(capture);
    else {
      startBudget();
      queue.unshift(capture);
    }
    return {
      slot,
      promote() {
        const at = optional ? optionalQueue.indexOf(capture) : -1;
        optional = false;
        // Already running: it is required work now, and no longer gives its context back.
        const running = runningOptional.indexOf(me);
        if (running >= 0) runningOptional.splice(running, 1);
        if (at < 0) return;
        optionalQueue.splice(at, 1);
        startBudget();
        queue.unshift(capture);
      },
    };
  };
  /** Contexts open now, and those of them held by required work. */
  let active = 0;
  let requiredActive = 0;
  let queuedRuns = 0;
  let doneRuns = 0;
  /** Runs queued and finished per probe id (whole tests for the live view). */
  const perProbe = new Map<string, { queued: number; done: number }>();
  // Each run is counted as it completes (runGroup hands every run to onRun once, failed ones too).
  const counted: ProbeRunnerOptions = {
    ...opts,
    onRun(run) {
      doneRuns++;
      const c = perProbe.get(run.probe);
      if (c) c.done++;
      opts.onRun?.(run);
    },
  };
  /** Contexts open at once now: what was lent, within the lend limit of the moment (never below `base`). */
  const room = () => {
    try {
      const v = opts.lendLimit?.();
      if (typeof v === 'number' && Number.isFinite(v)) return Math.min(limit, Math.max(base, Math.floor(v)));
    } catch {
      // no limit read: what was lent
    }
    return limit;
  };
  /** Rule 8: the contexts optional work may open beyond the room (0 when the option throws or is not a number). */
  const extraTabs = () => {
    try {
      const v = opts.optionalTabs?.();
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
    } catch {
      return 0;
    }
  };
  const maxSlots = Math.max(1, Math.floor(opts.maxSlots ?? MAX_TEST_TABS));
  /** Every context the runner may have open now, and of those the ones required work may hold. */
  const slots = () => Math.min(room() + extraTabs(), maxSlots);
  const requiredRoom = () => Math.min(room(), slots());
  /** Required work is queued that could start if an optional job gave its context back (rules 3 and 4). */
  const requiredWaits = () => queue.length > 0 && requiredActive < requiredRoom();
  /** Optional probe ids forgotten per address: a later `add` queues one again only as a required test. */
  const forgotten = new Map<string, Set<string>>();
  /** Rule 5: an optional run that did not happen is not queued, not counted, never "unfinished". Recorded for a host's log. */
  const forget = (url: string, ids: readonly string[], why: OptionalSkip['why']) => {
    try {
      if (ids.length) opts.onOptionalSkipped?.({ page: url, probes: [...ids], why });
    } catch {
      // Diagnostics must not stop the probes.
    }
    const done = added.get(url);
    const opt = optionalIds.get(url);
    const gone = forgotten.get(url) ?? new Set<string>();
    forgotten.set(url, gone);
    for (const id of ids) {
      gone.add(id);
      done?.delete(id);
      opt?.delete(id);
      const c = perProbe.get(id);
      if (c) {
        c.queued--;
        if (c.queued <= 0 && c.done <= 0) perProbe.delete(id);
      }
    }
    queuedRuns -= ids.length;
  };
  /**
   * Rule 4: required work that could start is waiting with no context free: the optional jobs that started last
   * give theirs back, as many as that work needs (one already stopping counts: it frees its context by itself).
   */
  const yieldToRequired = () => {
    const want = Math.min(queue.length, requiredRoom() - requiredActive);
    let need = want - Math.max(0, slots() - active);
    for (const job of runningOptional) if (job.stop.signal.aborted) need--;
    for (let i = runningOptional.length - 1; i >= 0 && need > 0; i--) {
      const job = runningOptional[i]!;
      if (job.stop.signal.aborted) continue;
      job.yielded = true;
      job.stop.abort();
      need--;
    }
  };
  /** Rule 1: required jobs first (within their room); an optional job only when none is waiting. */
  const pump = () => {
    for (;;) {
      if (queue.length) {
        if (requiredActive >= requiredRoom() || active >= slots()) break;
        start(queue.shift()!, true);
      } else if (optionalQueue.length && active < slots()) {
        start(optionalQueue.shift()!, false);
      } else break;
    }
    if (queue.length) yieldToRequired();
  };
  const start = (q: Queued, required: boolean) => {
    active++;
    if (required) requiredActive++;
    let held = required;
    if (q.work) q.work.started = true;
    void q.job({
      toOptional: () => {
        if (!held) return;
        held = false;
        requiredActive--;
        pump();
      },
    }).finally(() => {
      active--;
      if (held) requiredActive--;
      pump();
    });
  };
  const said = (target: ProbeTarget, g: ProbeGroup, queuedAt: number, startedAt: number, clock: Clock) => {
    try {
      opts.onGroup?.({ page: target.url, index: target.index, probes: g.probes.map((p) => p.id), queuedAt, startedAt, endedAt: Date.now(), ...clock });
    } catch {
      // Diagnostics must not stop the probes.
    }
  };
  const newClock = (): Clock => ({ openMs: 0, loadMs: 0, settleMs: 0, loads: 0, probeMs: {} });
  /**
   * A job that starts now, or (a group made only of tests that take planned targets) once the page's plan is in
   * or its budget is spent, so it never holds a context while it waits; other groups start now, and their
   * planned tests wait in turn (runOne).
   */
  const enqueue = (into: Queued[], q: Queued, g: ProbeGroup, plan: Promise<TargetPlan | null> | undefined) => {
    if (plan && g.probes.every((p) => p.usesPlan)) void plan.then(() => { into.push(q); pump(); });
    else into.push(q);
  };
  /** Tests that may share a page load: the same context group (`groupProbes`), never an isolated one. */
  const shareKey = (g: ProbeGroup) => (g.probes.some((p) => p.isolate || p.initScript) ? undefined : groupKeyOf(g));
  /**
   * The order optional tests go on in on one page: registry order, those that wait for the page later
   * (`waitersLater`), and those that type last (after a test that types the page is loaded again).
   */
  const goOnOrder = (list: readonly PageProbe[]): PageProbe[] => {
    const sorted = [...new Set(list)].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return [...waitersLater(sorted.filter((p) => !p.sendsNothing)), ...sorted.filter((p) => p.sendsNothing)];
  };
  /**
   * Riders that cannot go on on their page's required load: they join a unit of the same page and context group
   * still waiting in the optional queue (no tab has started it), so they share its load; with none, they are a
   * job of their own. Either way rules 3 to 5 apply as to any optional test.
   */
  const queueRiders = (target: ProbeTarget, g: ProbeGroup, plan: Promise<TargetPlan | null> | undefined, riders: readonly PageProbe[]) => {
    if (!riders.length) return;
    const key = shareKey(g);
    const join = key === undefined ? undefined : optionalQueue.find((q) => q.work && !q.work.started && q.work.target.url === target.url && shareKey(q.work.g) === key);
    if (join) join.work!.g = { ...join.work!.g, probes: goOnOrder([...riders, ...join.work!.g.probes]) };
    else queueOptional({ target, g: { ...g, probes: [...riders] }, plan, queuedAt: Date.now(), tries: 0 });
  };
  /** One page's optional tests that run as one job, and how often they gave their context back so far. */
  interface OptionalWork {
    target: ProbeTarget;
    g: ProbeGroup;
    plan: Promise<TargetPlan | null> | undefined;
    queuedAt: number;
    tries: number;
    /** A tab started it (it can no longer be taken over). */
    started?: boolean;
    /** Ends the wait `finish` has for it (`optionalPending`). */
    settle?: () => void;
  }
  /**
   * What optional work runs under (rules 3 to 5): its own stop (the scan's stop, and rule 4), its own `onRun` that
   * lists only the runs that happened, the admission asked before each test, and, when it ends, what it did not run
   * goes back to the optional queue (it gave way) or is forgotten (anything else).
   */
  const optionalScope = (target: ProbeTarget, g: ProbeGroup, plan: Promise<TargetPlan | null> | undefined, tries: number) => {
    const me = { stop: new AbortController(), yielded: false };
    const onStop = () => me.stop.abort();
    if (opts.signal?.aborted) onStop();
    else opts.signal?.addEventListener('abort', onStop, { once: true });
    runningOptional.push(me);
    // Rule 5: the job's runs are listed as they are handed on, and only those that happened: not cut, and
    // not ended after the job was stopped (a test caught mid-load can end in other words than "canceled").
    const entry = { index: target.index, runs: [] as ProbeRun[] };
    const mine: ProbeRunnerOptions = {
      ...withOptionalTurn(counted),
      signal: me.stop.signal,
      onRun(run) {
        if (abandoned || me.stop.signal.aborted || optionalCut(run)) return;
        if (!entry.runs.length) results.push(entry);
        entry.runs.push(run);
        counted.onRun!(run);
      },
    };
    // Rule 3, before each test (and before a late pass).
    const admit = () => {
      if (optionalOver()) return false;
      if (requiredWaits()) me.yielded = true;
      return !me.yielded;
    };
    const end = (given: readonly PageProbe[]) => {
      opts.signal?.removeEventListener('abort', onStop);
      const at = runningOptional.indexOf(me);
      if (at >= 0) runningOptional.splice(at, 1);
      if (abandoned) return;
      const have = new Set(entry.runs.map((r) => r.probe));
      for (const p of given) if (have.has(p.id)) optionalIds.get(target.url)?.delete(p.id);
      const left = given.filter((p) => !have.has(p.id));
      if (!left.length) return;
      // Gave its context back to required work: queued again, however often that happens (required work is
      // finite, and a scan's results must not depend on how its jobs happened to interleave). Anything else
      // that kept a test from running (its time, a stop, a failed load) is final.
      if (me.yielded && !optionalOver()) queueOptional({ target, g: { ...g, probes: left }, plan, queuedAt: Date.now(), tries: tries + 1 });
      else forget(target.url, left.map((p) => p.id), whySkipped());
    };
    return { mine, admit, end };
  };
  /**
   * Rule 2: a required job's page, its required tests done, goes on with optional tests of the same context group
   * that need no load of their own: its riders, and the page's units still waiting in the optional queue (no tab
   * has started them). Only when they may start now (rule 3: in their time, no required work waiting); else the
   * riders become a job of their own and the units stay queued. Null: nothing goes on.
   */
  const goOnWith = (target: ProbeTarget, g: ProbeGroup, plan: Promise<TargetPlan | null> | undefined, riders: readonly PageProbe[]) => {
    if (abandoned || optionalOver()) {
      if (riders.length) forget(target.url, riders.map((p) => p.id), whySkipped());
      return null;
    }
    // Rule 1: required work waiting goes first. The page goes on only when every required job that could start
    // once this one stops counting as required still finds a context free with this one kept (an extra tab).
    const could = Math.min(queue.length, requiredRoom() - (requiredActive - 1));
    if (could > Math.max(0, slots() - active)) {
      queueRiders(target, g, plan, riders);
      return null;
    }
    const key = shareKey(g);
    const taken = key === undefined ? [] : optionalQueue.filter((q) => q.work && !q.work.started && q.work.target.url === target.url && shareKey(q.work.g) === key);
    for (const q of taken) {
      optionalQueue.splice(optionalQueue.indexOf(q), 1);
      q.work!.started = true;
    }
    const probes = goOnOrder([...riders, ...taken.flatMap((q) => q.work!.g.probes)]);
    const settleTaken = () => { for (const q of taken) q.work!.settle?.(); };
    if (!probes.length) return null;
    const scope = optionalScope(target, g, plan, 0);
    return { probes, scope, settleTaken };
  };
  const queueRequired = (target: ProbeTarget, g: ProbeGroup, plan: Promise<TargetPlan | null> | undefined, queuedAt: number, riders: readonly PageProbe[]) => {
    pending.push(new Promise<void>((resolve) => {
      enqueue(queue, {
        job: async (slot) => {
          const startedAt = Date.now();
          const clock = newClock();
          const ids = new Set(g.probes.map((p) => p.id));
          let asked = false;
          let going: ReturnType<typeof goOnWith> = null;
          try {
            const runs = await runGroup(browser, target, g, counted, clock, plan, undefined, {
              begin: () => {
                asked = true;
                going = goOnWith(target, g, plan, riders);
                if (!going) return null;
                // From here this context holds optional work (rules 1 and 4).
                slot.toOptional();
                return { probes: going.probes, opts: going.scope.mine, admit: going.scope.admit };
              },
            });
            results.push({ index: target.index, runs: runs.filter((r) => ids.has(r.probe)) });
          } finally {
            const g2 = going as ReturnType<typeof goOnWith>;
            if (g2) {
              g2.scope.end(g2.probes);
              g2.settleTaken();
            } else if (!asked && riders.length) {
              // The page did not stay open for them (it did not load, was challenged, or its last test closed it).
              if (abandoned || optionalOver()) forget(target.url, riders.map((p) => p.id), whySkipped());
              else queueRiders(target, g, plan, riders);
            }
            // The timing names the tests that went on on this page too (their time is in the same clock).
            said(target, g2 ? { ...g, probes: [...g.probes, ...g2.probes] } : g, queuedAt, startedAt, clock);
            resolve();
          }
        },
      }, g, plan);
    }));
  };
  const runOptional = async (work: OptionalWork): Promise<void> => {
    const { target, g } = work;
    // Rule 3, before the page is opened.
    if (abandoned || optionalOver()) {
      forget(target.url, g.probes.map((p) => p.id), whySkipped());
      return;
    }
    const scope = optionalScope(target, g, work.plan, work.tries);
    const startedAt = Date.now();
    const clock = newClock();
    try {
      await runGroup(browser, target, g, scope.mine, clock, work.plan, scope.admit);
    } finally {
      scope.end(g.probes);
      said(target, g, work.queuedAt, startedAt, clock);
    }
  };
  const queueOptional = (work: OptionalWork) => {
    optionalPending.push(new Promise<void>((resolve) => {
      let ended = false;
      work.settle = () => { if (!ended) { ended = true; resolve(); } };
      enqueue(optionalQueue, { work, job: () => runOptional(work).catch(() => {}).finally(work.settle) }, work.g, work.plan);
    }));
  };
  /** Every promise in the list, those added while waiting included. */
  const settled = async (list: Promise<void>[]) => {
    for (let n = -1; n !== list.length;) {
      n = list.length;
      await Promise.all(list);
    }
  };
  /** Resolves when the scan stops its tests (never without a `signal`). */
  const stopped = () => new Promise<void>((resolve) => {
    if (opts.signal?.aborted) resolve();
    else opts.signal?.addEventListener('abort', () => resolve(), { once: true });
  });
  return {
    probes: selected,
    add(target, only, more) {
      if (!groups.length) return;
      const optional = new Set(more?.optional ?? []);
      const units = (more?.units ?? []).map((u) => ({ ids: new Set(u.probes.filter((id) => optional.has(id))), rider: u.rider === true }));
      const done = added.get(target.url) ?? new Set<string>();
      added.set(target.url, done);
      if (!targetIndex.has(target.url)) targetIndex.set(target.url, target.index);
      const gone = forgotten.get(target.url);
      // Each test once per address; a forgotten optional test only comes back as a required one.
      const fresh = (p: PageProbe) => !done.has(p.id) && (!only || only.includes(p.id)) && !(gone?.has(p.id) && optional.has(p.id));
      // A page with a test that takes planned targets gets its plan first (once per address): at the front of
      // the required queue when a required test wants it, as optional work when only optional tests do (rule 7).
      if (navigator) {
        const wanting = groups.flatMap((group) => group.probes.filter((p) => p.usesPlan && fresh(p)));
        const required = wanting.some((p) => !optional.has(p.id));
        const have = plans.get(target.url);
        if (have && required) have.promote();
        else if (!have && wanting.length && (required || !optionalOver())) plans.set(target.url, planFor(target, !required));
      }
      const plan = plans.get(target.url)?.slot;
      const part = (group: ProbeGroup, list: PageProbe[]): ProbeGroup => (list.length === group.probes.length ? group : { ...group, probes: list });
      for (const group of groups) {
        const todo = group.probes.filter(fresh);
        if (!todo.length) continue;
        for (const p of todo) done.add(p.id);
        queuedRuns += todo.length;
        for (const p of todo) {
          const c = perProbe.get(p.id) ?? { queued: 0, done: 0 };
          c.queued++;
          perProbe.set(p.id, c);
        }
        const queuedAt = Date.now();
        // Rule 2: the required tests of the group in one job, the optional ones in jobs of their own (by unit),
        // except the riders, which go on on the required job's page.
        const required = todo.filter((p) => !optional.has(p.id));
        const extra = todo.filter((p) => optional.has(p.id));
        if (extra.length) {
          for (const map of [optionalIds, optionalEver]) {
            const ids = map.get(target.url) ?? new Set<string>();
            map.set(target.url, ids);
            for (const p of extra) ids.add(p.id);
          }
        }
        const byUnit: { probes: PageProbe[]; rider: boolean }[] = [];
        const placed = new Set<string>();
        for (const u of units) {
          const list = extra.filter((p) => u.ids.has(p.id) && !placed.has(p.id));
          for (const p of list) placed.add(p.id);
          if (list.length) byUnit.push({ probes: list, rider: u.rider });
        }
        const loose = extra.filter((p) => !placed.has(p.id));
        if (loose.length) byUnit.push({ probes: loose, rider: false });
        // Riders need a required job of their group that shares its page (never an isolated one); without one,
        // they join the group's first other unit (one load for both), or are one job of their own together.
        const host = required.length > 0 && shareKey(part(group, required)) !== undefined;
        const riding = byUnit.filter((u) => u.rider).flatMap((u) => u.probes);
        const riders = host ? goOnOrder(riding) : [];
        const others = byUnit.filter((u) => !u.rider);
        const own = host || !riding.length ? others
          : others.length && shareKey(group) !== undefined ? [{ probes: goOnOrder([...riding, ...others[0]!.probes]), rider: false }, ...others.slice(1)]
          : [...others, { probes: riding, rider: true }];
        if (required.length) {
          for (const p of required) { optionalEver.get(target.url)?.delete(p.id); gone?.delete(p.id); }
          queueRequired(target, part(group, required), plan, queuedAt, riders);
        }
        for (const u of own) queueOptional({ target, g: part(group, u.probes), plan, queuedAt, tries: 0 });
      }
      pump();
    },
    counts: () => ({ queued: queuedRuns, done: doneRuns }),
    tests: () => {
      let done = 0;
      for (const c of perProbe.values()) if (c.done >= c.queued) done++;
      return { queued: perProbe.size, done };
    },
    partial(finished) {
      const indexOf = new Map<string, number>();
      for (const r of results) for (const run of r.runs) indexOf.set(run.page, r.index);
      for (const [url, i] of targetIndex) if (!indexOf.has(url)) indexOf.set(url, i);
      // Rule 5: the same filter as `finish`, whatever the caller kept of the runs it was handed.
      const ordered = finished
        .filter((run) => !(optionalEver.get(run.page)?.has(run.probe) && optionalCut(run)))
        .map((run, k) => ({ run, index: indexOf.get(run.page) ?? Number.MAX_SAFE_INTEGER, k }))
        .sort((a, b) => a.index - b.index || (order.get(a.run.probe) ?? 0) - (order.get(b.run.probe) ?? 0) || a.k - b.k);
      return [...withAcrossPages(selected, ordered.map(({ run, index }) => ({ run, index }))), ...this.unfinished(finished)];
    },
    unfinished(finished) {
      const have = new Set(finished.map((r) => `${r.page}\n${r.probe}`));
      const out: ProbeRun[] = [];
      for (const [url, ids] of added) {
        const opt = optionalIds.get(url);
        // An optional run that never came back is extra coverage that did not happen, not a test cut short.
        for (const p of selected) if (ids.has(p.id) && !opt?.has(p.id) && !have.has(`${url}\n${p.id}`)) out.push(notTestableRun(p, url, 'error', TIME_LEFT));
      }
      return out;
    },
    lend(slots) {
      if (!(slots > 0)) return;
      // What is lent; `room` keeps it within the lend limit of the moment (down as well as up).
      limit = Math.min(limit + Math.floor(slots), MAX_PROBE_SLOTS);
      pump();
    },
    async finish() {
      // Rule 6.
      await settled(pending);
      await Promise.race([settled(optionalPending), stopped()]);
      if (opts.signal?.aborted) {
        abandoned = true;
        for (const job of runningOptional) job.stop.abort();
      }
      const ordered = results
        .flatMap((r) => r.runs.map((run) => ({ run, index: r.index })))
        .sort((a, b) => a.index - b.index || order.get(a.run.probe)! - order.get(b.run.probe)!);
      const runs = withAcrossPages(selected, ordered);
      if (ownPool && opts.evidence) await ownPool.commit(runs, opts.evidence);
      return runs;
    },
  };
}

/**
 * Queue rule 5: an optional run that did not happen. It was stopped, ran out of the scan's time, or its own
 * load of the page failed (a refusal, a bot challenge, a lost browser): extra coverage that did not happen
 * never makes a page "not loaded", a test "cut short" or a scan incomplete.
 */
export function optionalCut(run: ProbeRun): boolean {
  return run.findings.some((f) => f.detail === CANCELLED || f.detail === TIME_LEFT || f.loadFailure !== undefined);
}

/**
 * Adds each probe's cross-page findings (`PageProbe.acrossPages`) to its runs, by page address. Only
 * well-formed findings for the probe's own criteria are kept, within the cap per run.
 */
export function withAcrossPages(probes: readonly PageProbe[], ordered: readonly { run: ProbeRun; index: number }[]): ProbeRun[] {
  const runs = ordered.map((x) => x.run);
  for (const p of probes) {
    if (!p.acrossPages) continue;
    let added: ReadonlyMap<string, ProbeFinding[]>;
    try {
      added = p.acrossPages(ordered.filter((x) => x.run.probe === p.id));
    } catch {
      continue;
    }
    if (!(added instanceof Map) || !added.size) continue;
    runs.forEach((run, i) => {
      if (run.probe !== p.id) return;
      const more = cleanFindings(p, added.get(run.page) ?? []) ?? [];
      if (!more.length) return;
      // A cross-page failure of the very element the page's own run left undecided settles it, for the criteria the
      // test names (`PageProbe.acrossSettles`; none by default): the undecided finding goes (the page alone could not
      // tell; the site's pages together demonstrated it). Every other criterion keeps both findings, as before.
      const settles = p.acrossSettles ?? [];
      const settled = new Set(more.filter((f) => f.status === 'failed' && f.target && settles.includes(f.criterion)).map((f) => `${f.criterion}\n${f.target}`));
      const kept = settled.size ? run.findings.filter((f) => !(f.status === 'not_testable' && f.target && settled.has(`${f.criterion}\n${f.target}`))) : run.findings;
      runs[i] = { ...run, findings: [...kept.slice(0, Math.max(0, MAX_FINDINGS - more.length)), ...more] };
    });
  }
  return runs;
}

/** Runs the probes on the given pages (see `createProbeRunner`). */
export async function runProbes(
  browser: BrowserLike,
  pages: readonly ProbeTarget[],
  probes: readonly PageProbe[],
  opts: ProbeRunnerOptions,
): Promise<ProbeRun[]> {
  const runner = createProbeRunner(browser, probes, opts);
  for (const p of pages) runner.add(p);
  return runner.finish();
}
