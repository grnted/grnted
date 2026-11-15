// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The probe API (Plan 4): automated interaction and render tests that run in a fresh, guarded
// browser context on each page of the template sample. Engine core: no Node-only or AI imports.
import type { CDPSessionLike, EvidenceBox, PageAudit, PageLike, ProbeFinding, ProbeRun } from '../types.js';
import type { PlannedTarget } from './plan.js';

export type { CriterionMethodResult, CriterionStatus, ProbeCriterionResult, ProbeFinding, ProbeRun } from '../types.js';

/** Browser context settings a probe needs. Probes with equal settings share one page per sampled page. */
export interface ProbeContextOptions {
  hasTouch?: boolean;
  isMobile?: boolean;
  deviceScaleFactor?: number;
  /** Default 'reduce', as in the audit. Motion probes ask for 'no-preference'. */
  reducedMotion?: 'reduce' | 'no-preference';
}

/**
 * One automated test. Register it with one line in `PROBES` (src/probes/registry.ts).
 *
 * The runner loads the page in a fresh context with the request guard and the listener hook
 * installed, then runs the probes that share the same viewport and context options one after the
 * other on that page, in registry order. Between probes it scrolls to the top and blurs the focused
 * element, and reloads the page only if its URL changed. A probe that leaves other lasting changes
 * (injected CSS, opened menus, filled fields) sets `isolate: true` to get a page of its own.
 */
export interface PageProbe {
  /** Unique id, shown as the method id in the criteria table. */
  id: string;
  /** WCAG success criteria it reports on, e.g. ['2.1.1', '2.1.2']. Findings for other criteria are dropped. */
  criteria: string[];
  kind: 'interaction' | 'render' | 'pixels';
  /** 'core' runs on every scan; 'deep' only with `full` (CLI `--full`). */
  tier: 'core' | 'deep';
  /**
   * Core probes only: false to run it on every scan and list its results without scoring them
   * (`SCORED_PROBES` leaves it out), until calibration supports scoring it. Default: scored.
   */
  scored?: false;
  /**
   * Hard time box for one run on one page (page loading not included). A run that exceeds it gives
   * `not_testable` ("timed out") for each of its criteria, and its page is closed.
   */
  timeoutMs: number;
  /** Default: the desktop viewport (1280×900). */
  viewport?: { width: number; height: number };
  contextOptions?: ProbeContextOptions;
  /** Run on a page of its own (no other probe before or after it on that page). */
  isolate?: boolean;
  /**
   * The probe types into the page: from the moment it starts, the request guard blocks every new
   * request and holds every top-level navigation (see `decideRequest`). Before running it, the
   * runner waits for earlier requests to finish within its time box; otherwise it is not testable.
   * The page is not reused by a later probe.
   */
  sendsNothing?: boolean;
  /**
   * What the request guard blocks (a request, a popup it closes, a WebSocket it keeps in the page)
   * cannot change what this probe reads (styles, screenshots): only a navigation the guard holds makes
   * its clean result not stand, also when the guard decides it after the probe looked. For probes that
   * only read the page (they never press or type anything).
   */
  onlyNavigationVoids?: boolean;
  /**
   * Script source the runner adds to the probe's context before the page loads (after the listener
   * hook), so it runs in every frame before the page's own scripts. A probe with one gets a page of
   * its own (as with `isolate`). The probe should check inside the page that it ran.
   */
  initScript?: string;
  /**
   * Deep probes only: also run on audited pages outside the template sample for which this returns
   * true (from the audit's collector output), so content found on any scanned page gets tested, for
   * example every page with a video player. Decided in scan order, at most `ALSO_ON_PAGE_CAP` such
   * pages per scan (`src/probes/sample.ts`).
   */
  alsoOn?(collected: PageAudit['collected']): boolean;
  /**
   * Criteria (of `criteria`) the probe speaks to only through what one rule of its own measured on the page (the
   * pointer-gestures test's 2.1.1 for a list it reordered by dragging; keyboard-op lane, fix round 1, F5). A run that
   * could not start, timed out, failed, was not opened or whose results do not stand says nothing for them: they are
   * left out of that run (its `criteria` and findings), so another test's result for them stands. Only the rule's
   * own findings count.
   */
  measuredOnly?: readonly string[];
  /**
   * Core probes only: run on every scanned page that loaded in the audit, not only on the template
   * sample (no cap, so the probe must be cheap). Its criteria then get a result on each such page,
   * which is what the score counts. Probes with this flag that share a page group run together on the
   * pages outside the sample (one page load for all of them).
   */
  everyPage?: boolean;
  /**
   * Findings that need every page's result (the same main heading on every page, say), computed once
   * all runs are in: gets this probe's runs with their `data`, in scan order, and returns findings
   * to add to some of them, by page address. Only findings for the probe's criteria are kept. A
   * function that throws adds nothing.
   */
  acrossPages?(runs: readonly { run: ProbeRun; index: number }[]): ReadonlyMap<string, ProbeFinding[]>;
  /**
   * Criteria (of `criteria`) for which a FAILED finding from `acrossPages` takes the place of the page's own
   * `not_testable` finding for the same criterion and target: the page alone could not decide that element, and the
   * site's pages together demonstrated the failure (batch 17: the headings test's 1.3.1, a line another scanned
   * page marks up as a real heading). Default none: a cross-page finding is added and nothing is taken away. Never
   * for a criterion whose cross-page rule only raises a doubt.
   */
  acrossSettles?: readonly string[];
  /**
   * What a clean result from this probe does not cover, shown with its method in the criteria
   * table when it found no failures (for example what only a deep probe watches).
   */
  note?: string;
  /**
   * The probe takes planned targets (`ProbeContext.planned`, src/probes/plan.ts): with a navigator, the
   * runner waits for the page's plan (within the navigator's budget, outside the probe's time box) before
   * it runs. It tests them after its own targets, and only adds what it measures on them.
   */
  usesPlan?: boolean;
  /**
   * Waits before the test runs (bounded, outside its time box), for tests that misread a page still
   * mounting or moving: `content` while the page is still putting its content in (`stillMounting`, at most
   * `LATE_CONTENT_MS`; src/probes/mounting.ts), `layout` until the
   * layout has stopped shifting (`LATE_LAYOUT_MS`). Tests that judge what the page does by itself (flash,
   * sound, motion, keyboard traps) never ask for them, and on a shared page the tests that wait run after
   * all the others (`groupProbes`).
   */
  waitFor?: { content?: true; layout?: true };
  /**
   * The probe needs the page's timers as the page set them: when an earlier probe on its shared page ran
   * any timer early (`Kit.fire`; the motion test does), the runner closes that page and gives this probe
   * the page loaded again in a fresh context (as after a probe that typed), with the guard and hooks.
   * That load counts inside the probe's time box; when it fails, the probe's result is not_testable with
   * the reason. When no timer was run early, nothing changes (no extra load).
   */
  freshAfterFiredTimers?: true;
  /**
   * A late pass (fix/late-mount, review r2), for a test that judges what a page does by itself and so never
   * waits before it starts (sound, motion, device motion): after every other test that shares its page has
   * run (on the motion page: after the timing test, so nothing waits in real time before it), the runner
   * runs `run` on the same page in its own time box (`timeoutMs`), with the findings of the test's first
   * pass. It returns the test's findings for the page (the first pass's with what it found since; the first
   * pass's unchanged when it has nothing to add). When the late pass throws, times out or cannot run (the
   * page was reloaded or left), the first pass's findings stand as they were.
   */
  late?: { timeoutMs: number; run(ctx: ProbeContext, first: readonly ProbeFinding[]): Promise<ProbeFinding[]> };
  /**
   * Returns findings for its criteria. A criterion with no finding on a page counts as "no failures
   * found" there; return an explicit `not_applicable` finding when there was nothing to test. Throw
   * `ProbeNotTestable` when the test cannot run on this page (the reason is reported).
   */
  run(ctx: ProbeContext): Promise<ProbeFinding[]>;
}

export interface ProbeContext {
  /** The loaded page (route guard and listener hook installed). */
  page: PageLike;
  /** Address of the page under test. */
  url: string;
  /** Position in the scan order (0 = start page). */
  pageIndex: number;
  viewport: { width: number; height: number };
  /** What the request guard blocked or held, and popups and dialogs it closed. */
  guard: GuardLog;
  /**
   * axe-core's source (the scan's), when the runner has it: a test that changed the page (a page-load pop-up set
   * aside, `popupAside.ts`) runs axe's color-contrast rule again there to find what it must measure.
   */
  axeSource?: string;
  /** Aborted when the time box ends or the scan is cancelled. */
  signal: AbortSignal;
  /** Epoch ms when the time box ends. */
  deadline: number;
  /**
   * When the time box ends on the monotonic clock (`performance.now()` ms, set by the runner): what the motion
   * tests use for their time left (`timeLeft`), so a wall-clock correction neither uses it up nor extends it.
   */
  ends?: number;
  /** The audit's collector output for this page (`PageAudit.collected`), when available. */
  collected?: PageAudit['collected'];
  /** What axe could not decide on this page in the audit (`PageAudit.incomplete`), when available. */
  incomplete?: PageAudit['incomplete'];
  /**
   * Extra targets the page's plan gives this probe (only for probes with `usesPlan`, only when the scan has a
   * navigator and the plan came in time). Never instead of the probe's own targets: it tests them after its
   * own and adds only what it measured on them.
   */
  planned?: readonly PlannedTarget[];
  /**
   * Event listeners recorded by the init-script hook (main frame). Throws `ProbeNotTestable` when the
   * browser could not install the hook.
   */
  /**
   * The listeners the hook recorded. `shadowInline`: handlers written on elements in open shadow roots too (the keyboard
   * test's 2.1.1 alone asks for them; chart fix round 4, S4).
   */
  listeners(opts?: { shadowInline?: boolean }): Promise<RecordedListener[]>;
  /** Everything the hook recorded: listeners, timers, dialog/open/submit calls and audio contexts. */
  hooks(): Promise<RecordedHooks>;
  /**
   * Attaches small JSON evidence to this run (`ProbeRun.data`) for the AI review; the last call wins.
   * It is copied as JSON when the run ends and dropped when it is larger than `PROBE_DATA_MAX_CHARS`
   * serialized, or when the run times out or fails. Optional so hand-built contexts in tests need not
   * provide it: call it as `ctx.setData?.(data)`.
   */
  setData?(data: unknown): void;
  /**
   * Attaches data that is not JSON (a screenshot's bytes) to this run for the AI review only: never copied into the
   * run, the report or any store, read with `runAttachment(run)` by whoever gets the run from `onRun`; the last call
   * wins, and a run that times out or fails has none. Call it as `ctx.attach?.(value)`.
   */
  attach?(value: unknown): void;
  /**
   * True when an AI review listens to this scan's runs (`ProbeRunnerOptions.aiEvidence`): pictures taken only for the
   * review (`attach`) are wanted. Absent: take none.
   */
  aiEvidence?: boolean;
  /**
   * Report v2: takes an evidence image now (the viewport, or `clip` in CSS px of the viewport) with
   * callout boxes relative to the image. At most 4 per run (2 per criterion); present only when the scan has an
   * evidence sink, so call it as `await ctx.evidence?.(shot)`. Shots of runs that time out or error
   * are dropped. Resolves false when the cap was reached or the capture failed.
   *
   * Details (`src/probes/evidence.ts`): it never throws; it resolves false once the time box is nearly
   * over (and a screenshot still running then is abandoned), for a criterion the probe does not
   * declare, for empty alt text, and when no box is left inside the image. Only shots for criteria the
   * run ends up failing reach the report. A viewport shot records the viewport as it is at that moment
   * (a probe that resized it gets the resized size).
   */
  evidence?(shot: ProbeEvidenceShot): Promise<boolean>;
  /**
   * True when a picture of a `criterion` failure (of kind `variant`) would still be used: the scan has
   * an evidence sink, the run has calls and time left, and the scan does not yet hold enough pictures
   * of that criterion (`POOL_PER_KEY`). Probes ask before measuring for a picture.
   */
  evidenceWanted?(criterion: string, variant?: string): boolean;
  /**
   * The start page's failing elements for `criterion`, in CSS px of its first screen at the desktop
   * width (document coordinates at scroll 0): outlined on "Homepage, as checked" when the run ends
   * failing it (and `when` accepts the failure). Present only on the start page at the desktop width
   * with an evidence sink. Never throws.
   */
  evidenceHome?(criterion: string, rects: { x: number; y: number; width: number; height: number }[], when?: (f: ProbeFinding) => boolean): void;
  /**
   * The probe could not confirm that it undid a change it made to the page (a call into the page that
   * never answered, so the page may still be held still, say): the runner does not reuse the page, and
   * the next probe gets a fresh context, as after a time-out. The run's own results are unaffected.
   * Optional so hand-built contexts in tests need not provide it: call it as `ctx.discardPage?.()`.
   */
  discardPage?(): void;
  /**
   * Call right after the probe loaded the page again itself (the keyboard tests' `reloadPage`): the
   * runner settles it and rechecks bot detection and the landing response before accepting its new
   * baseline; a failed check throws ProbeNotTestable. The runner checks, after the run,
   * that the page still shows it (`LOADED_DURING`): a later replacement is never exempt. Optional: call
   * it as `await ctx.reloadedPage?.()`.
   */
  reloadedPage?(): Promise<void>;
  /**
   * A CDP session on the page (Chromium only), opened on the first call and let go when the run
   * ends; undefined when the browser has none. The pixel probes take their screenshots through it
   * (`shoot`): one round trip per screenshot instead of Playwright's several, which on a remote
   * browser (Browser Rendering) decides whether a test finishes in its time box. Optional so
   * hand-built contexts in tests need not provide it.
   */
  cdp?(): Promise<CDPSessionLike | undefined>;
  /**
   * The SVG picture file the page was given at `url` on this load, as its body arrived (`pictureFiles.ts`): its text,
   * how many responses the address gave on this load and whether they were all that same file; or 'too-large', or
   * 'unread' (its body could not be had); undefined when none was kept (it arrived before the store listened, or
   * never). It waits for a body still arriving: bound the wait. Optional: hand-built contexts lack it.
   */
  pictureFile?(url: string): Promise<{ source: string; responses: number; identical: boolean } | { error: 'too-large' | 'unread' } | undefined>;
  /**
   * The failures measured so far, which stand even if the run is then cut by its time box (the last
   * call wins). On a time-out the run keeps these failed findings, and its other criteria are
   * not_testable, unless the page then fails a check that voids the run (a held navigation, a
   * refused address or stylesheet, a gate that was lost). Optional: call it as `ctx.keep?.(found)`.
   */
  keep?(failed: readonly ProbeFinding[]): void;
}

/** What a probe passes to `ProbeContext.evidence` (the runner adds id, page and viewport). */
export interface ProbeEvidenceShot {
  criterion: string;
  /** In CSS px of `ProbeContext.viewport`; rounded outwards and clamped inside it (max 1280×900). */
  clip?: { x: number; y: number; width: number; height: number };
  /** Relative to the clip (or the viewport); clamped to the image, empty ones dropped, at most 8. */
  boxes: EvidenceBox[];
  alt: string;
  caption?: string;
  /** Pair shots of this run with the same group key (rendered side by side). */
  group?: string;
  groupLabel?: string;
  /** A picture with no box (the top of a page with no main heading): `boxes` must be empty and a caption given. */
  bare?: boolean;
  /** Kind of failure the picture shows, for the scan's per-criterion picture count (see `evidenceWanted`). */
  variant?: string;
  /** The target of the failed finding whose element the picture boxes (kept on the shot; max 200 characters). */
  target?: string;
  /**
   * Kept only when the run, once final (cross-page findings added), has a failed finding for the
   * criterion that passes this test. Default: any failed finding for it.
   */
  when?: (f: ProbeFinding) => boolean;
}

/** What probes attached to their runs (`ProbeContext.attach`), by run: held only as long as the run object is. */
const RUN_ATTACHMENTS = new WeakMap<object, unknown>();
/** Sets a run's attachment (the runner). */
export function setRunAttachment(run: object, value: unknown): void { RUN_ATTACHMENTS.set(run, value); }
/** A run's attachment (`ProbeContext.attach`), or undefined. */
export function runAttachment(run: object | undefined): unknown { return run ? RUN_ATTACHMENTS.get(run) : undefined; }

/** Largest `ProbeRun.data`, in characters of JSON (larger data is dropped). */
export const PROBE_DATA_MAX_CHARS = 32_000;

/** Thrown by a probe (or the context) when the test cannot run on this page; `message` is the reason. */
export class ProbeNotTestable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ProbeNotTestable';
  }
}

// ---------------------------------------------------------------------------------------------
// The request guard's log.

export type GuardEventKind =
  /** A request the guard aborted (`reason`: 'method', 'action' or 'data'). */
  | 'blocked'
  /** A main-frame navigation away from the page during a probe: held, so the page stayed. */
  | 'navigation'
  /** The main frame's address changed while a probe ran (in-page anchor, history API). */
  | 'url-change'
  /** A popup the page opened: recorded and closed. */
  | 'popup'
  /** An alert, confirm, prompt or beforeunload dialog: recorded and dismissed. */
  | 'dialog'
  /** A WebSocket: kept inside the page, never connected to the server. */
  | 'websocket'
  /**
   * A frame's navigation after the load phase to an address its element does not declare (a form
   * submitted into it, a link or script sending it elsewhere): nothing sent, the frame kept its document.
   * Not a stop: it changes no verdict by itself (`guardStop`), and it does not count toward `GUARD_LOG_CAP`.
   */
  | 'frame';

export interface GuardEvent {
  kind: GuardEventKind;
  /** Address (max 300 characters). */
  url?: string;
  method?: string;
  resourceType?: string;
  /**
   * For 'blocked': not GET/HEAD ('method'), an address that looks like an action ('action'), or a
   * request that could carry typed data while a `sendsNothing` probe ran ('data').
   */
  reason?: 'method' | 'action' | 'data';
  /** For 'blocked': the request was a top-level navigation of the page (not a frame or a subresource). */
  mainFrame?: boolean;
  /** For 'dialog': alert, confirm, prompt or beforeunload. */
  dialog?: string;
  /** For 'dialog': its message (max 200 characters). */
  message?: string;
  /** The probe running at the time; absent while the page was loading. */
  probe?: string;
  /**
   * For a request blocked for its method (it would have sent data) that is not a navigation: 'background'
   * when it goes to another site than the page under test (`isOtherSite`: analytics, tag managers,
   * feature-flag services), which is never sent, logged in the run, and does not end a test; 'own' when
   * it goes to the page's own site, which ends the test as any blocked request does. Absent on every
   * other event.
   */
  cause?: 'own' | 'background';
  /** Epoch ms (comparable with the hook's call stamps, `RecordedCall.at`). */
  at: number;
}

export interface GuardLog {
  readonly events: readonly GuardEvent[];
  /**
   * Position in the log now; `since(mark)` returns what happened after it, except the page's background
   * writes (`GuardEvent.cause` 'background': blocked, never sent, and they end no test). `events` keeps them.
   */
  mark(): number;
  since(mark: number): GuardEvent[];
  /**
   * Waits until the guard has decided every request the browser has reported (also those reported
   * while it waits), so the log holds what it stopped (decisions can come late on a busy machine). It
   * always lets reports already on their way arrive first. False when that took longer than
   * `timeoutMs`, when the log is full (a record was dropped), or when a request made during probe
   * `probeId` (default: the probe running now; outside probes, outside any probe) ended before the
   * guard decided it (a redirect the browser followed by itself counts only when the guard would have
   * stopped its address, judged as reported). The log may then miss what
   * the page did. Optional so hand-built logs in tests need not provide it.
   */
  settled?(timeoutMs: number, probeId?: string): Promise<boolean>;
  /**
   * Addresses of the documents (pages and frames) the browser is loading now: requests it reported and has not
   * ended. Undefined when the browser does not report requests (nothing can be told). Optional, as above.
   */
  inFlight?(): string[] | undefined;
  /**
   * Turns the strict mode on from now until the page is loaded again (batch 17, Sol r1 S9): no new request is sent
   * and every navigation is held, as for a probe that types (`PageProbe.sendsNothing`). For a test that is not strict
   * as a whole (it watches the page as it loads and plays) but then presses something: called before its first press,
   * it keeps whatever the press and its later work ask for from leaving the page. Optional as above.
   */
  latchStrict?(): void;
}

// ---------------------------------------------------------------------------------------------
// The listener hook (src/probes/listeners.ts).

export type ListenerTarget =
  | { kind: 'window' }
  | { kind: 'document' }
  | {
    kind: 'element';
    tag: string;
    id?: string;
    classes: string[];
    role?: string;
    /** Cheap accessible name: aria-label, labelledby text, alt, title, value or text (max 80). */
    name?: string;
    /** CSS path from the nearest ancestor with a unique id (or the root); inside a shadow root, from that root. */
    path: string;
    inShadow?: boolean;
  };

/** The handlers of one event type on one target. */
export interface RecordedListener {
  type: string;
  target: ListenerTarget;
  /** In-page handle: `window.__grntedTarget(ref)` returns the target inside `page.evaluate`. */
  ref: number;
  /** Handlers of this type on the target. */
  count: number;
  /** Every handler was added with `passive: true`. */
  passive: boolean;
  /** At least one handler listens in the capture phase. */
  capture: boolean;
  /** How the handlers were added: addEventListener, an on* property or an inline on* attribute. */
  via: ('add' | 'property' | 'attribute')[];
}

/** A setTimeout or setInterval of at least 1 s (shorter ones are animation and scheduling noise). */
export interface RecordedTimer {
  kind: 'timeout' | 'interval';
  delay: number;
  /** Calls with the same kind, delay and source. */
  count: number;
  /** Times the callback ran. */
  fired: number;
  /** Page `performance.now()` ms of the last run (monotonic). */
  lastFiredAt?: number;
  /** Page `performance.now()` ms of the first call (a chain of timeouts that re-arms itself keeps this one record). */
  firstAt?: number;
  /** Page `performance.now()` ms of the last run whose own callback changed the DOM, while a probe watched (__grntedTimerChanges). */
  lastChangeAt?: number;
  /** Length of the callback's source, and its first 120 characters (no stack). */
  sourceLength: number;
  snippet: string;
}

/**
 * A timer of at least 1 s that has not fired or been cleared yet (`window.__grntedPending()`). Its
 * callback can be run early with `window.__grntedFire(handle)`, as if its time had come: a timeout
 * is then cancelled, an interval keeps running.
 */
export interface PendingTimer {
  /** The page's timer handle. */
  handle: number;
  kind: 'timeout' | 'interval';
  delay: number;
  /** Index into `RecordedHooks.timers`. */
  timer: number;
  /** Page `performance.now()` ms when it was set (monotonic). */
  at: number;
  /** First 120 characters of the callback's source. */
  snippet: string;
  /** The page passed code as a string (fired with a 0 ms timer, so its effects come a moment later). */
  string: boolean;
}

/** A call the page made to alert/confirm/prompt, window.open or form submit. */
export interface RecordedCall {
  api: 'alert' | 'confirm' | 'prompt' | 'open' | 'submit' | 'requestSubmit';
  /** The timer whose callback made the call (index into `timers`), if any. */
  timer?: number;
  at: number;
  /**
   * A submit: how many fields a visitor fills the form shows, whether it would have been sent (the page's own handler
   * did not stop it), whether sending it would have replaced this page (into this window, not a frame or a new one),
   * and the form's words (at most 600 characters).
   */
  form?: { fields: number; sent: boolean; page: boolean; text: string };
}

export interface RecordedHooks {
  listeners: RecordedListener[];
  timers: RecordedTimer[];
  calls: RecordedCall[];
  audio: { created: number; running: number };
}
