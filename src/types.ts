// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import type { AutomatedElement } from './crossDedupe.js';
import type { IncrementalSummary, PageRevision } from './incremental/index.js';
export type Impact = 'minor' | 'moderate' | 'serious' | 'critical';
export type RuleOutcome = 'pass' | 'fail' | 'incomplete' | 'inapplicable';

/** The subset of Playwright's Response the engine uses. */
export interface ResponseLike {
  status(): number;
  url(): string;
  headers(): Record<string, string>;
}

/** A response the page got for any request (Playwright's Response): its request tells what it was for. */
export interface SubresourceResponseLike extends ResponseLike {
  request(): RequestLike;
  /** The frame that asked for it. */
  frame?(): unknown;
  /** The body as text (read only for stylesheets that answered with CSS). */
  text?(): Promise<string>;
  /** The body as bytes, once the request finished (record and replay, src/replay). */
  body?(): Promise<Uint8Array>;
  /** Every response header, the ones the page cannot read included (Playwright's `allHeaders()`); names in lower case. */
  allHeaders?(): Promise<Record<string, string>>;
  /** The answer came from a service worker, not from the network. */
  fromServiceWorker?(): boolean;
  /** The server address the answer came from (Playwright's `serverAddr()`); null when it came from no server. */
  serverAddr?(): Promise<{ ipAddress: string; port: number } | null>;
}

/** The subset of Playwright's Page the engine uses. */
export interface PageLike {
  goto(url: string, opts?: { waitUntil?: 'load' | 'domcontentloaded'; timeout?: number }): Promise<ResponseLike | null>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  addScriptTag(opts: { content: string }): Promise<unknown>;
  /**
   * Every frame of the page, the main frame included (Playwright's `page.frames()`). axe runs in each
   * one (scoring v2). Optional: without it axe runs in the main frame only, and the page's frames are
   * listed as not tested.
   */
  frames?(): FrameLike[];
  waitForTimeout(ms: number): Promise<void>;
  /**
   * Image of the page (the viewport unless `fullPage`). Used by the vision collector. Playwright's
   * Page satisfies it; @cloudflare/playwright support is on Plan 2's Task 1 spike checklist.
   */
  screenshot(opts?: {
    type?: 'jpeg' | 'png';
    quality?: number;
    fullPage?: boolean;
    scale?: 'css' | 'device';
    clip?: { x: number; y: number; width: number; height: number };
  }): Promise<Uint8Array>;
  close(): Promise<void>;

  // Optional members used by the interaction and render probes (`src/probes/`, Plan 4). Local
  // Playwright has all of them; each is on Plan 2's Task 1 spike checklist for @cloudflare/playwright.
  // A probe that needs a member the browser lacks reports `not_testable` (see `ProbeNotTestable`);
  // the runner never runs probes without `route` (the request guard).
  keyboard?: KeyboardLike;
  mouse?: MouseLike;
  hover?(selector: string, opts?: { timeout?: number; force?: boolean }): Promise<void>;
  focus?(selector: string, opts?: { timeout?: number }): Promise<void>;
  setViewportSize?(size: { width: number; height: number }): Promise<void>;
  emulateMedia?(opts: {
    media?: 'screen' | 'print' | null;
    colorScheme?: 'light' | 'dark' | 'no-preference' | null;
    reducedMotion?: 'reduce' | 'no-preference' | null;
    forcedColors?: 'active' | 'none' | null;
    contrast?: 'no-preference' | 'more' | null;
  }): Promise<void>;
  /** Intercepts this page's requests (the request guard, when the context has no `route`). */
  route?(url: string | RegExp, handler: (route: RouteLike) => unknown): Promise<void>;
  /** Intercepts WebSockets. A handler that never connects to the server keeps the socket in the page. */
  routeWebSocket?(url: string | RegExp, handler: (ws: WebSocketRouteLike) => unknown): Promise<void>;
  addInitScript?(script: string | { content: string }): Promise<void>;
  on?: PageEvents;
  url?(): string;
  mainFrame?(): GuardFrameLike;
  isClosed?(): boolean;
}

/** `page.on` for the events the probes listen to (Playwright's Page satisfies it). */
export interface PageEvents {
  (event: 'framenavigated', fn: (frame: GuardFrameLike) => void): unknown;
  (event: 'popup', fn: (page: PageLike) => void): unknown;
  (event: 'dialog', fn: (dialog: DialogLike) => void): unknown;
  (event: 'request' | 'requestfinished' | 'requestfailed', fn: (request: RequestLike) => void): unknown;
  /** Every response the page gets, subresources included (the stylesheet watch, `src/styles.ts`). */
  (event: 'response', fn: (response: SubresourceResponseLike) => void): unknown;
  (event: 'websocket', fn: (ws: { url(): string }) => void): unknown;
  (event: 'console', fn: (message: { type(): string; text(): string }) => void): unknown;
}

export interface KeyboardLike {
  press(key: string, opts?: { delay?: number }): Promise<void>;
  down(key: string): Promise<void>;
  up(key: string): Promise<void>;
  type(text: string, opts?: { delay?: number }): Promise<void>;
}

export interface MouseLike {
  move(x: number, y: number, opts?: { steps?: number }): Promise<void>;
  click(x: number, y: number, opts?: { button?: 'left' | 'right' | 'middle'; clickCount?: number; delay?: number }): Promise<void>;
  down(opts?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }): Promise<void>;
  up(opts?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }): Promise<void>;
  wheel(deltaX: number, deltaY: number): Promise<void>;
}

/** The minimal frame the request guard reads (URL, parent, owning page). */
export interface GuardFrameLike {
  url(): string;
  parentFrame(): GuardFrameLike | null;
  /** The page the frame belongs to (tells the page under test from a popup). */
  page?(): unknown;
  /** The frame's element in its parent (Playwright's `frameElement()`): tells what address the page gave the frame. */
  frameElement?(): Promise<{ evaluate<R, A = undefined>(fn: (e: Element, arg: A) => R, arg?: A): Promise<R>; dispose?(): Promise<void> }>;
}

/** The subset of Playwright's Request the request guard reads. */
export interface RequestLike {
  method(): string;
  url(): string;
  resourceType(): string;
  isNavigationRequest?(): boolean;
  frame?(): GuardFrameLike;
  /** The request this one is a redirect of (the browser follows redirects without the route). */
  redirectedFrom?(): RequestLike | null;
  /** Request headers, names in lower case (Playwright's `headers()`): tells a speculative load (`Sec-Purpose: prefetch`). */
  headers?(): Record<string, string>;
  /** Why a failed request failed (Playwright's `failure()`, on `requestfailed`): the browser's error text. */
  failure?(): { errorText: string } | null;
  /** The response, null when none came (Playwright's `response()`). */
  response?(): Promise<unknown>;
}

/** The subset of Playwright's Route the request guard uses. */
export interface RouteLike {
  request(): RequestLike;
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
  /**
   * Hands the request to the next matching route handler (Playwright ≥ 1.23), or sends it when there
   * is none. The request guard lets requests go this way, so a handler installed on the context before
   * it (the hosted Worker's target safety) still decides them; `continue()` would skip that handler.
   */
  fallback?(overrides?: { headers?: Record<string, string> }): Promise<void>;
  /** `body` as bytes must be a Node Buffer for Playwright (src/replay/browser.ts `fulfillBody`). */
  fulfill?(opts: { status?: number; headers?: Record<string, string>; contentType?: string; body?: string | Uint8Array }): Promise<void>;
}

/** A Chrome DevTools Protocol session (Playwright's CDPSession): the guard's popup sandbox. */
export interface CDPSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, fn: (params: never) => void): unknown;
  /** Ends the session (Playwright's `CDPSession.detach`). */
  detach?(): Promise<void>;
}

export interface DialogLike {
  type(): string;
  message(): string;
  dismiss(): Promise<void>;
}

/** Playwright's WebSocketRoute. A handler that never calls `connectToServer` keeps the socket in the page. */
export interface WebSocketRouteLike {
  url(): string;
}

/** The subset of Playwright's Frame the engine uses to run axe in every frame of a page. */
export interface FrameLike {
  url(): string;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  /** Runs script source in the frame. Unlike a script tag, the frame's Content-Security-Policy cannot block it. */
  evaluate(expression: string): Promise<unknown>;
  /** null for the main frame. */
  parentFrame(): FrameLike | null;
  /** The frame's `<iframe>` or `<frame>` element, as a handle the parent frame's `evaluate` accepts as an argument. */
  frameElement(): Promise<unknown>;
}

/** A frame on a page that axe could not test, and why. */
export interface UntestedFrame {
  url: string;
  reason: string;
}

/**
 * axe's result inside one frame from another site (scoring v3), at one width: the frame and the frames
 * inside it, targets relative to the frame's document. Never scored.
 */
export interface ThirdPartyRun {
  /** The frame's address. */
  url: string;
  run: AxeRun;
}

/** Failures inside one frame from another site, merged across widths (scoring v3). Never scored. */
export interface ThirdPartyFrame {
  /** The frame's address (the outermost frame from the other site; frames inside it are included). */
  url: string;
  /** Targets are relative to the frame's document. */
  violations: Finding[];
}

export interface ContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
  /** Runs in every page and frame of the context before the page's own scripts (the listener hook). */
  addInitScript?(script: string | { content: string }): Promise<void>;
  /** Intercepts the requests of every page in the context, popups included (the request guard). */
  route?(url: string | RegExp, handler: (route: RouteLike) => unknown): Promise<void>;
  routeWebSocket?(url: string | RegExp, handler: (ws: WebSocketRouteLike) => unknown): Promise<void>;
  /** Requests of every page in the context, as the browser reports them (the guard's `settled`). */
  on?: RequestEvents;
  /** A CDP session on one of its pages (Chromium only): the guard's popup sandbox. */
  newCDPSession?(page: PageLike): Promise<CDPSessionLike>;
  /** Grants browser permissions to an origin in this context (Playwright's `grantPermissions`; src/replay). */
  grantPermissions?(permissions: string[], opts?: { origin?: string }): Promise<void>;
  /** Network off for every page of the context (the SVG drawer, src/ai/rasterize.ts; data: URLs still load). */
  setOffline?(offline: boolean): Promise<void>;
}

/** `on` for request events (Playwright's BrowserContext and Page satisfy it). */
export interface RequestEvents {
  (event: 'request' | 'requestfinished' | 'requestfailed', fn: (request: RequestLike) => void): unknown;
  /** A page the context opened (the request guard closes every one but the page under test). */
  (event: 'page', fn: (page: PageLike) => void): unknown;
}

/**
 * The subset of Playwright's Browser the engine uses. Local Playwright and
 * @cloudflare/playwright both satisfy it; cast with `as unknown as BrowserLike`.
 */
export interface BrowserLike {
  newContext(opts: {
    viewport: { width: number; height: number };
    userAgent?: string;
    reducedMotion?: 'reduce' | 'no-preference';
    /** Probes (Plan 4): touch input and the mobile meta viewport. */
    hasTouch?: boolean;
    isMobile?: boolean;
    deviceScaleFactor?: number;
    /** Probes block service workers: the request guard cannot see their requests. */
    serviceWorkers?: 'allow' | 'block';
    /** False: the context refuses every download (the probes that press or type). */
    acceptDownloads?: boolean;
  }): Promise<ContextLike>;
  /**
   * A CDP session on the browser itself (Chromium only): the navigation gate holds every new window a
   * gated page opens there, before it loads anything (`gatedBrowser`).
   */
  newBrowserCDPSession?(): Promise<CDPSessionLike>;
}

export interface Viewport {
  name: 'desktop' | 'mobile';
  width: number;
  height: number;
}

/** One axe rule result, trimmed to what we keep. */
export interface AxeRuleLite {
  id: string;
  impact: Impact | null;
  help: string;
  helpUrl: string;
  /**
   * `unknownState`: an incomplete node moved from a violation whose missing state (a checkbox's `aria-checked`, a
   * combobox's `aria-expanded`) the browser gives a default: whether that default is the state shown is unknown, so its
   * criterion is not tested (`axeRun.ts` `reviewNode`; Fable review F1, W3C precision lane).
   * `flag`: an incomplete node moved from a violation that a human must judge, its criterion's axe result reading Needs
   * review, never "no failures found" (batch 19: a label-in-name name that starts with the words shown first and leaves
   * out other text set apart).
   */
  nodes: { target: string; html: string; failureSummary?: string; unknownState?: true; flag?: true }[];
}

/** One axe run at one viewport. Passes and inapplicable are ids only. */
export interface AxeRun {
  violations: AxeRuleLite[];
  incomplete: AxeRuleLite[];
  passes: string[];
  inapplicable: string[];
}

export interface Finding {
  id: string;
  help: string;
  helpUrl: string;
  nodes: { target: string; html: string; failureSummary?: string; unknownState?: true; flag?: true; viewports: Viewport['name'][] }[];
  /**
   * Set by the report builder only (`SecondLookDemotion`): the rule's failure on this page, moved to the page's
   * undecided results because the review's second look doubted it, with the reason it gave. Never in the score.
   */
  secondLook?: string;
}

export interface PageAudit {
  url: string;
  status: 'ok' | 'failed';
  reason?: string;
  httpStatus?: number;
  /** Outcome per rule id, merged across viewports. */
  rules: Record<string, RuleOutcome>;
  violations: Finding[];
  incomplete: Finding[];
  /** Absolute hrefs found on the page (desktop run). Used for the document inventory. */
  links: string[];
  /** Output of the page collectors that ran, by collector id (see `PageCollector`). */
  collected?: Record<string, unknown>;
  /** Frames on the page axe could not test, at either width. Absent when every frame was tested. */
  untestedFrames?: UntestedFrame[];
  /**
   * Animations on the page were still running when axe ran, at either width (they did not finish within
   * the audit's bounded wait, `ANIMATION_SETTLE_MS`): its results may differ between scans. Absent otherwise.
   */
  animationsUnsettled?: true;
  /**
   * Frames from other sites with failures (scoring v3): listed, never in `rules`, `violations` or the
   * score. Absent when there are none.
   */
  thirdParty?: ThirdPartyFrame[];
  /**
   * Monitoring scans (docs/monitoring.md): the page had not changed since this date (ISO), so its audit
   * from then was carried forward instead of loading it again. Absent on a page audited now.
   */
  unchangedSince?: string;
  /** Monitoring scans: how the scan decided the page and what the monitor keeps for the next one. */
  revision?: PageRevision;
  /**
   * Monitoring scans: what the browser's own load of the page answered at the desktop width (its status,
   * and the rendered DOM's text length and element count, for the client-rendered rule). The hash and
   * validators never come from here (r2-4: always from the worker's own GET). Dropped from the audit by
   * the incremental decision; only asked for on monitoring scans.
   */
  document?: { status: number; url: string; rendered?: { text: number; elements: number } };
  /** Monitoring scans (r1-8): a carried page's every-page core test runs from the scan that checked it. */
  probeRuns?: ProbeRun[];
}

/** An image whose alt text an AI reviewer can judge. `alt` is '' when the image is marked decorative. */
export interface ImageCandidate {
  page: string;
  src: string;
  alt: string;
  width: number;
  height: number;
  /** Set when the image sits inside a link, so its alt text is (part of) the link's name. */
  link?: { href: string; text: string };
  caption?: string;
  /**
   * Visible text around the image, closest first, as the AI review reads it (its context): the siblings of the image
   * and of its wrappers, up to the nearest sectioning element (section, article, main, aside, li, td, th) or a block
   * with a heading of its own. Trimmed, at most 1,500 characters.
   */
  nearbyText?: string;
  /**
   * The text the alt-text claim rule checks a confirmed 1.1.1 failure against (`givenShare` only, never sent to the
   * model): the same walk, but after the image it stops before any heading, so words of the next section can never
   * discard a real failure (review r1). Absent on candidates from before it existed: the rule then uses `nearbyText`.
   */
  claimText?: string;
  /**
   * The image has no alt attribute and no other text alternative, so axe already fails it
   * (`image-alt`, scored); `alt` is then ''. The AI only suggests alt text for these.
   */
  missingAlt?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Page collectors: extra in-page data gathered during the audit (AI inputs and other inventories).

/**
 * Gathers data from a loaded page after axe has run. Each collector runs in its own time box and a
 * failure never fails the page: the result is then `{ error }`. Results land in
 * `PageAudit.collected[id]`; for `viewport: 'both'` the value is `{ desktop, mobile }`.
 * Collectors must not navigate the page. Add built-ins to `src/collect/index.ts`.
 */
export interface PageCollector<T = unknown> {
  /** Key in `PageAudit.collected`. Unique; a scan runs each id once. */
  id: string;
  viewport: 'desktop' | 'mobile' | 'both';
  /** Time box for one run of this collector. Default 3000 ms. */
  timeoutMs?: number;
  /**
   * `index` is the page's position in the scan order (0 = start page); absent when auditPage runs on its own. `cdp`
   * opens a CDP session on this page when the browser offers one (the vision collector asks it for accessible names).
   */
  collect(page: PageLike, ctx: { url: string; viewport: Viewport['name']; index?: number; cdp?: () => Promise<CDPSessionLike> }): Promise<T>;
}

/** What a collector that threw or timed out leaves in `PageAudit.collected`. */
export interface CollectorError {
  error: string;
}

// ---------------------------------------------------------------------------------------------
// AI review: an unscored opinion layer (see `grnted/ai`). Nothing here is ever part of the score.

/**
 * An AI check's id, as the closed AI package names it: plain data in the report JSON. The open engine
 * lists no check of its own (it has no AI review); the package keeps the typed list of the ids it knows. The engine reads
 * a few ids only to render reports stored before the AI engine left it (src/aiLegacy.ts, src/aiScore.ts).
 */
export type AiCheckId = string;

/**
 * One item an AI check (or a deterministic helper rule shown alongside it) looked at.
 * Verdicts `cannot_judge` and `not_reviewed` are reported as "not judged"; any other unflagged
 * verdict is reported as "looked fine". Never wording such as "passes" or "compliant".
 */
export interface AiFinding {
  check: AiCheckId;
  /** WCAG success criterion, e.g. '1.1.1'. Used for grouping, never shown as a pass. */
  criterion: string;
  /** Page or document URL. */
  page: string;
  /** Human-readable pointer: image URL, link text, heading text, PDF page. */
  target: string;
  /** Check-specific verdict value. */
  verdict: string;
  /** Plain-language verdict text shown as the report heading for this item. */
  label: string;
  /** true = the AI (or a rule shown with it) judged this a likely problem. */
  flagged: boolean;
  confidence: 'high' | 'medium' | 'low';
  /** What the AI saw, so its judgment can be checked against the page. */
  observed: string;
  issue: string;
  suggestion: string;
  /** Optional: the current value that was judged (alt text, link text), shown in the report. */
  current?: { label: string; value: string };
  /** 'rules' = deterministic finding computed in code, shown in the same section. */
  source: 'ai' | 'rules';
  /**
   * altText (alt-text@4): the key information the AI read in the image, copied from it (title, date,
   * place, numbers), as evidence. Absent when the image shows no essential text.
   */
  essentialText?: string;
  /**
   * Scoring v5 (altText only): the criteria this answer tested for the score, set on an image's main
   * finding when the AI answered: its page then counts toward those criteria's share.
   */
  scoreTested?: string[];
  /**
   * Scoring v5: a failure that counts toward the score: a scored kind at high confidence, confirmed by
   * a second, independent run (docs/scoring.md). Absent on every other finding.
   */
  scored?: boolean;
  /**
   * Keys naming the element the finding is about (src/aiDedupe.ts): `box:x,y,w,h` for a screenshot fact,
   * `text:<words>` for its text or name, `page` for the page as a whole. Two gated checks' confirmed
   * failures that share a key on the same page and criterion cost once.
   */
  elements?: string[];
  /**
   * A confirmed failure (`scored`) of an element another gated check's confirmed failure already counts
   * for (one cost per element, src/aiDedupe.ts): it costs nothing and the report lists it as AI-flagged.
   * Set by the report builder; a re-scoring of the report drops it again either way.
   */
  countedElsewhere?: boolean;
  /**
   * The problem that counts for this element (`rule:<id>`, `criterion:<n.n.n>`, `ai:<check>:<n.n.n>`): an axe
   * rule or a scored test failing the same element for the same criterion (they win over the AI), or a
   * heavier gated AI check. Set with `countedElsewhere`; also set on an unconfirmed AI-flagged finding of
   * an element a scored automated check fails (listed with that problem, not as a recommendation).
   */
  countedBy?: string;
  /**
   * Set by the report builder only (`SecondLookDemotion`): a confirmed failure the review's second look doubted,
   * with the reason it gave. It no longer counts (`scored` is dropped) and is listed for a person to check.
   */
  secondLook?: string;
}

export interface AiCheckRun {
  check: AiCheckId;
  /** Section heading in the report. */
  title: string;
  /** One-line description of what the check looks at. */
  summary: string;
  model: string;
  promptVersion: string;
  tier: 'core' | 'deep';
  /** Items eligible for the check. */
  inputs: number;
  /** Items that got an AI verdict (fresh or from the cache). */
  reviewed: number;
  /** Of `reviewed`, served from the cache. */
  cached: number;
  /** Items sent for review that failed (timeout, error, unreadable input). */
  notReviewed: number;
  /** Includes unflagged findings so "looked fine" can be listed. */
  findings: AiFinding[];
}

/** AI opinion, outside the score. */
export interface AiReport {
  runs: AiCheckRun[];
  disclaimer: string;
  /**
   * The closed AI package's second look at the failures the scan was about to report (its record: what it
   * reviewed and answered). The engine reads none of it; what it moves to Needs review comes only from the
   * package's `ReportExtension.demotions`. Absent when no second look ran.
   */
  secondLook?: AiSecondLook;
}

/** A second look's record (`AiReport.secondLook`): plain data, written by the closed AI package. */
export interface AiSecondLook {
  model: string;
  promptVersion: string;
  /** 'shadow': answers recorded, nothing moved; 'on': confirmed doubts move their failures to Needs review. */
  mode: 'shadow' | 'on';
  /** Failures (one criterion on one page) found to look at, and of those, answered and not answered. */
  inputs: number;
  reviewed: number;
  notReviewed: number;
  /**
   * A first screen before the review, when one ran: its model and version, the threshold under which a unit went to the
   * review, and how many were sent, kept as found, or had no answer from it (those were sent).
   */
  triage?: { model: string; version: string; threshold: number; sent: number; kept: number; unanswered: number };
  /** One per failure looked at, in report order. */
  units: AiSecondLookUnit[];
}

/** One failure the second look reviewed: one criterion on one page, with every method that failed it there. */
export interface AiSecondLookUnit {
  page: string;
  criterion: string;
  /** The failing methods: `axe:<rule>`, `test:<test id>`, `ai:<check>`. */
  methods: string[];
  /** 'failure_confirmed' | 'not_a_failure' | 'cannot_tell' | 'not_reviewed' | 'kept_by_triage' (a first screen kept it as found). */
  verdict: string;
  /** A first screen's probability that the failure is real, when one ran; under its threshold the unit was reviewed. */
  triage?: number;
  confidence?: 'high' | 'medium' | 'low';
  /** The second run's answer when one was asked (a confident doubt is asked twice). */
  second?: { verdict: string; confidence?: 'high' | 'medium' | 'low' };
  /** What the evidence showed, as the reviewer cited it. */
  evidence: string[];
  reason: string;
  /** Both runs doubted it with confidence: the failure would move to Needs review. */
  doubted: boolean;
  /** It did move (`doubted` and mode 'on'). */
  demoted: boolean;
}

/**
 * One failure the closed AI package's second look moves to Needs review (`ReportExtension.demotions`): the
 * failure of `criterion` on `page` by one method. `axe`: the rule `id`'s failure on the page (all its elements);
 * `test`: the test `id`'s failed findings of the criterion on the page; `ai`: the check `id`'s confirmed findings
 * of the criterion on the page. A demotion that matches nothing changes nothing.
 */
export interface SecondLookDemotion {
  method: 'axe' | 'test' | 'ai';
  id: string;
  page: string;
  criterion: string;
  /** The reviewer's reason, kept with the moved failure. */
  reason: string;
}

/**
 * What `scanSite` needs from an AI review (`grnted/ai`'s `createAiReview` builds one). The engine
 * runs `collectors`, reports page progress and awaits `finish` after the audits. Callbacks must not
 * throw; the engine still guards them so the scan never fails because of the AI.
 */
export interface AiScanPlan {
  collectors: PageCollector[];
  /** A page was picked for audit; `started` counts pages started so far, including this one. */
  onPageStarted?(ctx: { started: number; total: number }): void;
  /**
   * A page was audited. `sampleOnly`: a long scan's page past its first pages, given only to bounded
   * checks (`bounded`), which keep a bounded seeded reservoir of candidates from every page.
   */
  onPageAudited(page: PageAudit, ctx: { index: number; done: number; total: number; site: string; sampleOnly?: boolean }): void;
  /** Some check keeps a bounded reservoir of candidates, so it can hear about every page of a long scan. */
  bounded?: boolean;
  /**
   * A PDF was downloaded and its quick checks succeeded (only PDFs, only when this is set). Called
   * from the document pipeline as each PDF is read, in any order and before `finish`. It must return
   * at once (keep a reference; do not parse or upload here). `bytes` must not be modified.
   */
  onDocument?(doc: DocumentCheck, bytes: Uint8Array, details: PdfDetails): void;
  /**
   * A probe run finished (only when probes run and this is set), with the probe's evidence in
   * `run.data`. Called as each run completes, in any order and before `finish`. It must return at
   * once (keep a reference; do not call a model here synchronously).
   */
  onProbeRun?(run: ProbeRun): void;
  /**
   * False when this plan reviews nothing (a caller's page tap with no AI review behind it): the scan
   * then reports no AI review stage in its live events (`ScanEvent` `stage`). Default: it reviews.
   */
  reviews?: boolean;
  /**
   * Hears each AI finding as its item is answered, while the pages are still audited as well as in
   * `finish`, for the live view's provisional events (`ScanEvent` `found`). The same finding may come
   * again (in `finish`); the listener must not throw.
   */
  watch?(listener: (check: AiCheckId, findings: readonly AiFinding[]) => void): void;
  /**
   * `onProgress`: called as the review moves (a check finished, or one more item of a sampled check
   * was reviewed), for the live view. Must not throw; calls after `finish` settles are ignored.
   * `by`: when the caller stops waiting for the review (epoch ms; a review that comes later is lost
   * whole). Checks with long waits (documents, media) end theirs a little before it, so their unfinished
   * items are "not reviewed" and the rest of the review still counts.
   */
  /**
   * `probeRuns`: the tests' runs as the report will score them (with their `data`), for a review that looks at the
   * scan's own failures (the closed package's second look). Absent when no tests ran.
   */
  finish(ctx: { site: string; pages: PageAudit[]; documents: string[]; probeRuns?: readonly ProbeRun[]; signal?: AbortSignal; by?: number; onProgress?: (p: AiProgress) => void }): Promise<AiReport>;
  /** What the review did before `finish` (for logs; never in the report). Read after `finish` settles. */
  stats?(): AiReviewStats;
  /**
   * How the review counts in the report (`ReportExtension`): the scan hands it to `buildReport` with the review.
   * Without it the review is left out of the report and nothing of it is scored.
   */
  report?: ReportExtension;
  /**
   * The review wants the elements each test's undecided and failing findings name (`ProbeRun.elements`), read from the
   * test's page when it is done. Without it the tests read nothing more.
   */
  elementFacts?: boolean;
}

/**
 * A closed package's part of the report (the hosted AI review's scoring): it decides what of its own review
 * counts and how much; the engine only carries and adds up what it returns. The open engine has none.
 */
export interface ReportExtension {
  /** Who scored the review (for logs and tests). */
  readonly name: string;
  /** Called once by `buildReport` when the scan has a review to report. */
  score(input: ReportExtensionInput): ReportExtensionResult;
  /**
   * The failures the review's second look moves to Needs review (`SecondLookDemotion`), read from the review
   * before anything is scored. Absent or empty: every failure stands.
   */
  demotions?(ai: AiReport): readonly SecondLookDemotion[];
}

export interface ReportExtensionInput {
  /** The review as the scan returned it. */
  ai: AiReport;
  /** The loaded pages, in scan order. */
  pages: readonly string[];
  /** The elements the scored automated methods fail (one problem per element: an AI finding of one of them counts there). */
  automated: readonly AutomatedElement[];
  /** The report's scoring version. */
  scoring: string;
}

export interface ReportExtensionResult {
  /** The review as the report lists it (its findings marked where another method or check counts their element). */
  ai: AiReport;
  /** The review answered for at least one item the score can count (`AiScoreSummary.ran`). */
  ran: boolean;
  /** The failing checks that count, each with its pages, findings and `weight` (`pointsLost` 0: the engine fills it). */
  issues: AiIssueSummary[];
  /**
   * The checks whose confirmed answers count, with their criteria (`AiScoreSummary.gates`). The review's confirmed
   * PDF problems (`scored` findings of its document run) count in the documents check (scoring v10 and later).
   */
  gates: Readonly<Partial<Record<AiCheckId, readonly string[]>>>;
}

/** How much of an AI review ran before its `finish` (`AiScanPlan.stats`): counts only, for logs. */
export interface AiReviewStats {
  /**
   * Items of the final selections already answered when `finish` was called (a call that settles in
   * finish's own turn counts as not early; one that came back not reviewed is asked again and is not early).
   */
  early: number;
  /** Reviews started, then dropped because their item left a selection (a sample's, or a changed item). */
  wasted: number;
  /** Model calls asked again after a rate limit, a server error or a lost connection (`AiRetryStats`). */
  retries?: number;
  /** Model calls that still failed that way with no retry left: those items are not reviewed. */
  retryFailed?: number;
  /** Tokens the provider reported, per check (model calls only; cached answers cost none). For cost logs. */
  usage?: Partial<Record<AiCheckId, AiUsageTotals>>;
}

/** Token counts one check's model calls added up to (`AiReviewStats.usage`). */
export interface AiUsageTotals {
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** The AI review's progress (`AiScanPlan.finish` `onProgress`): real counts only. */
export interface AiProgress {
  /** Checks finished so far, and checks in the review. */
  checksDone: number;
  checks: number;
  /** The check this update is about (its title). */
  check: string;
  /** For a check that reviews a sample (images, pages): items reviewed so far, and in its sample. */
  reviewed?: number;
  sample?: number;
}

export interface RuleSummary {
  /** Report v3: complete observed cause distributions, before the legacy example/occurrence caps. */
  causes?: { fingerprint: string; pages: string[]; target: string; html: string; occurrences: number; locations?: import('./report/jobs.js').RepairObservation[] }[];
  id: string;
  impact: Impact;
  help: string;
  helpUrl: string;
  pagesAffected: string[];
  /**
   * Scoring v8: pages where the failure is minor (colour contrast: every failing element within 10% of
   * the ratio it needs). Absent when none (and on reports before v8).
   */
  minorPages?: string[];
  elements: number;
  /** Points the site score rises by if this rule is fixed everywhere. 0 for needs-review items. */
  pointsLost: number;
  examples: { page: string; target: string; html: string }[];
  /**
   * Needs-review items only (Fable review F1, W3C precision lane): elements whose checked or expanded state the page
   * leaves to the browser's default (`AxeRuleLite` `unknownState`). Their criterion's axe result is not tested
   * (`report/criteria.ts` `axeMethod`). Absent when none.
   */
  unknownState?: number;
  /**
   * Needs-review items only (batch 19): elements a human must judge (`AxeRuleLite` `flag`): their criterion's axe result
   * reads Needs review (`report/criteria.ts` `axeMethod`). Absent when none.
   */
  flagged?: number;
  /**
   * Needs-review items only: elements whose failure the review's second look doubted (`Finding.secondLook`): their
   * criterion's axe result reads Needs review (`report/criteria.ts` `axeMethod`). Absent when none.
   */
  secondLook?: number;
  /**
   * Report v2 repetition (failures only): the failing elements' page-independent signatures
   * (`elementSignature`: start tag without ids, data-* and numeric class suffixes) with the number of
   * loaded pages each fails on, most pages first: every pattern (batch 19; at most 200, was 5). Absent on needs-review
   * items and on reports made before report v2. `elements` (report v3): its failing elements over those pages.
   * `example` (batch 19): one of its elements, on a page no earlier pattern's example is on when it can be.
   */
  signatures?: { sig: string; pages: number; elements?: number; example?: { page: string; target: string; html: string } }[];
  /**
   * Report v3 (failures only): every failing element's page and selector, in scan order, at most
   * MAX_OCCURRENCES (500) per rule, for the issue list exports. Absent on older reports.
   */
  occurrences?: { page: string; target: string }[];
}

/**
 * One axe rule failing inside frames from one other site (scoring v3), e.g. a video player or a map.
 * Listed in the report, never scored and never capping the score.
 */
export interface ThirdPartyRuleSummary {
  /** The frames' origin, e.g. 'https://www.youtube.com'. */
  origin: string;
  id: string;
  impact: Impact;
  help: string;
  helpUrl: string;
  pagesAffected: string[];
  elements: number;
  /** `target` is relative to the frame's document. */
  examples: { page: string; frame: string; target: string; html: string }[];
}

/**
 * A criterion the core automated tests (core probes) found failed (scoring v3): it costs points by the
 * share of tested pages it failed on (scoring v4, docs/scoring.md). One entry per criterion.
 */
export interface TestIssueSummary {
  criterion: string;
  title: string;
  /** The core probes that failed it. */
  probes: string[];
  pagesAffected: string[];
  /** Points the site score rises by if it no longer fails on any page. */
  pointsLost: number;
  /** The first failures found (at most 3). */
  evidence: CriterionEvidence[];
}

/**
 * An AI-reviewed image check that found confirmed failures (scoring v5): it costs points by the share of
 * the pages whose images the AI reviewed. One entry per criterion.
 */
export interface AiIssueSummary {
  /** The AI check (scoring v8: every gated check; absent on older reports: altText). */
  check?: AiCheckId;
  /** '1.1.1' (information shown only in a picture) or '1.4.5' (pictures of text), or a gated check's criterion. */
  criterion: string;
  /** Pages with a confirmed failing image, in scan order. */
  pagesAffected: string[];
  /** Pages with at least one image the AI answered for (the share's denominator). */
  pagesTested: number;
  /** Points the site score rises by if no image fails it. */
  pointsLost: number;
  /**
   * Its weight in the score (scoring v8: `criterionScore.ts`), as the closed AI package that scored the review set it.
   * Absent on a report made before the AI engine left the open engine: its scoring version's weight (src/aiLegacy.ts).
   */
  weight?: number;
  /** The confirmed findings, one per image (at most 10), in scan order. */
  findings: AiFinding[];
}

/** Scoring v5: the AI-reviewed image checks and their place in the score. */
export interface AiScoreSummary {
  /** The AI image review answered for at least one image, so its checks are in the score. */
  ran: boolean;
  /** 'AI checks not run: automated-only score' when `ran` is false; absent otherwise. */
  note?: string;
  /** Failing AI checks, most points first (empty when none failed). */
  issues: AiIssueSummary[];
  /**
   * The AI checks whose confirmed answers count, with the criteria each may score, as the closed AI package that
   * scored the review stamped them. Absent when no review was scored, and on a report made before the AI engine left
   * the open engine (its scoring version's gates then: src/aiLegacy.ts `aiGates`).
   */
  gates?: Readonly<Partial<Record<AiCheckId, readonly string[]>>>;
}

export interface PageSummary {
  url: string;
  status: 'ok' | 'failed';
  score: number | null;
  violations: number;
  reason?: string;
  /** Frames on the page axe could not test. Absent when every frame was tested. */
  untestedFrames?: UntestedFrame[];
  /** Animations were still running when axe checked the page (`PageAudit.animationsUnsettled`): its results may vary between scans. */
  animationsUnsettled?: true;
  /** Monitoring scans: not changed since this date (ISO), so its results from then are carried forward. */
  unchangedSince?: string;
}

// ---------------------------------------------------------------------------------------------
// WCAG results by criterion (Plan 4, rule 3): one row per WCAG 2.2 Level A and AA criterion.

/**
 * A criterion's or method's automated result. A criterion's status is the worst over its methods:
 * failed > flagged > not_testable > no_failures_found > not_applicable. Never "passed".
 */
export type CriterionStatus = 'failed' | 'flagged' | 'no_failures_found' | 'not_applicable' | 'not_testable';

/** One automated method's result for one criterion (axe rules, rules-based inventory, a probe, an AI check). */
export interface CriterionMethodResult {
  id: string;
  kind: 'axe' | 'rules' | 'interaction' | 'render' | 'pixels' | 'ai';
  status: CriterionStatus;
  /** Pages (or documents) the result covers: those with failures when failed, else those tested. */
  pages: number;
  /** Plain-language detail, e.g. the rules run or why it could not be tested. */
  note?: string;
}

export interface CriterionResult {
  /** e.g. '1.4.10'. */
  criterion: string;
  level: 'A' | 'AA';
  /** The WCAG version that introduced it. Everything but '2.2' is part of WCAG 2.1 AA. */
  wcag: '2.0' | '2.1' | '2.2';
  /** Plain title, e.g. 'Reflow'. */
  title: string;
  status: CriterionStatus;
  methods: CriterionMethodResult[];
  /** What was found (capped). `anchor` is an in-page id in the HTML report. Escaped when rendered. */
  evidence: CriterionEvidence[];
}

export interface CriterionEvidence {
  page: string;
  target?: string;
  detail: string;
  anchor?: string;
}

/** Page features found by the scan, from axe rule applicability (no extra page work). Never scored. */
export interface ScanInventory {
  /** Loaded pages with form fields (text fields, text areas, drop-down lists), in scan order. */
  formPages: string[];
  /** Loaded pages with embedded frames (iframes), whose content the scan does not test. */
  framePages: string[];
}

// ---------------------------------------------------------------------------------------------
// Evidence images (report v2, docs/specs/2026-10-31-report-v2-design.md §3): screenshots with
// callout boxes. The bytes never go into the report JSON; they go to an `EvidenceSink`.

/** A box drawn over an evidence image, in CSS px of the image (top-left origin). */
export interface EvidenceBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** fail: the failing element; ghost: where a hidden element is; expected: how it should look. */
  kind: 'fail' | 'ghost' | 'expected';
  /** Short tag drawn on the box (a measurement or a number), max 24 characters. */
  label?: string;
  /**
   * The problem this box outlines, as its `Problem.key` ('rule:<axe id>', 'criterion:<n.n.n>'). The
   * start page's shots carry it, so the report numbers each box with its problem's card number.
   */
  problem?: string;
  /**
   * The element this box outlines: the selector the scan looked it up by (an axe target), at most
   * `BOX_TARGET_MAX` characters. Lets a report match a box to one cause of a problem (report v3's numbered
   * pins). Absent on reports made before it and on boxes a test measured itself.
   */
  target?: string;
}

/** What an evidence image is evidence for. `{ rule: '$start' }` is a start page shot: desktop (1280×900) or phone (`viewport.width` 390). */
/**
 * What a picture is evidence for. A probe's picture may name the element it boxes (`target`: the
 * failed finding's target), so the report shows that finding beside it.
 */
export type EvidenceFor = { rule: string } | { criterion: string; probe: string; target?: string } | { ai: string };

/** One evidence image (metadata). */
export interface EvidenceShot {
  /** 'e1', 'e2', ... in report order; the sink got the bytes under this id. */
  id: string;
  page: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  /** Image size in CSS px (image pixels = CSS px × deviceScaleFactor). */
  width: number;
  height: number;
  /**
   * Where the image sits on the page, in document CSS px at its viewport (a start page shot: the first
   * screen, at 0,0). A rescan's "Since your last scan" pictures the same place again (report/compare.ts).
   * Absent on reports made before it, and when the page did not say where it had scrolled.
   */
  area?: { x: number; y: number; width: number; height: number };
  boxes: EvidenceBox[];
  /** Alt text: what the image shows. */
  alt: string;
  /** Short caption under the image. */
  caption?: string;
  for: EvidenceFor;
  /** Shots of one pair (100%/200%, hidden/expected) share a group id and render side by side. */
  group?: string;
  /** Label above the image inside its group ("Browser zoom 200%"). */
  groupLabel?: string;
}

/** Receives each evidence image (JPEG) during the scan. Without a sink no images are taken. */
export type EvidenceSink = (id: string, jpeg: Uint8Array) => void | Promise<void>;

/**
 * Receives each live screenshot (JPEG) during the scan (`ScanOptions.liveShots`). `id` is
 * `<page index>-<desktop|mobile>`. A sink that throws, rejects or takes longer than `sinkTimeoutMs`
 * means no shot: that width's viewport-done goes out without `shot`.
 */
export type LiveShotSink = (id: string, jpeg: Uint8Array) => void | Promise<void>;

/** Live screenshots for the live scan view (`ScanOptions.liveShots`). */
export interface LiveShotOptions {
  sink: LiveShotSink;
  /** The capture's time box (default `LIVE_SHOT_LIMITS.timeoutMs`). */
  timeoutMs?: number;
  /** How long the sink may take (default `LIVE_SHOT_LIMITS.sinkTimeoutMs`). */
  sinkTimeoutMs?: number;
  /** A lower byte cap than `LIVE_SHOT_LIMITS.maxBytes` (never higher). */
  maxBytes?: number;
}

/**
 * A live screenshot on a `viewport-done` event: the sink got the JPEG under `id`. `w` × `h` is the
 * image size in px. It shows the width's first screen, scrolled to the top: CSS px [0, wireframe.W) ×
 * [0, h × W / w). A wireframe box at CSS (x, y, w, h) is at (x, y, w, h) × (shot.w / wireframe.W) in
 * the image. `url` is set by a host that serves the image (the hosted Worker), never by the engine.
 */
export interface LiveShot {
  id: string;
  w: number;
  h: number;
  url?: string;
}

/** Evidence settings for a scan (`ScanOptions.evidence`). */
export interface EvidenceOptions {
  sink: EvidenceSink;
  /** Most images per scan. Default 16, clamped to 1–40. */
  maxImages?: number;
}

/** A non-interference criterion that blocks Access Granted (`SiteReport.accessBlockedBy`). */
export interface AccessBlocker {
  criterion: string;
  title: string;
  /** The loaded pages where a scored check fails it, in report order. */
  pages: string[];
  /** The failing checks' keys ('criterion:2.1.2', 'media:1.4.2', 'third-party:marquee'...): the problems that fix it. */
  keys: string[];
}

export interface SiteReport {
  /** Assignable work and stable problem codes. Presentation only; never changes scoring. */
  repair?: import('./report/jobs.js').RepairModel;
  coverage?: import('./report/jobs.js').ReportCoverage;
  /** 2: scoring v4 removed `capped` (the critical cap). */
  schemaVersion: 2;
  site: string;
  status: 'scored' | 'incomplete';
  score: number | null;
  letter: 'A' | 'B' | 'C' | 'D' | 'F' | null;
  headline: 'Access Granted' | 'Access Denied' | 'Scan incomplete';
  /**
   * Scoring v8: the WCAG non-interference criteria (1.4.2, 2.1.2, 2.2.2, 2.3.1) a scored check fails on
   * some page. Any makes the headline Access Denied, whatever the score (the score is unchanged). Absent
   * when none, and on reports made before the rule.
   */
  accessBlockedBy?: AccessBlocker[];
  reasons: string[];
  pages: PageSummary[];
  rules: RuleSummary[];
  /**
   * Criteria failed by the core automated tests (scoring v3), scored as failing checks (v4). Present
   * when probes ran (empty when they found no failure).
   */
  testIssues?: TestIssueSummary[];
  /**
   * Scoring v6: scored criteria a core test ran for but could test on none of the pages that loaded
   * (every run for it timed out, broke or could not test it). Not in the score. Absent when none.
   */
  untestedCriteria?: string[];
  needsReview: RuleSummary[];
  /** axe failures inside frames from other sites (scoring v3): listed, never scored. Absent when there are none. */
  thirdParty?: ThirdPartyRuleSummary[];
  documents: string[];
  /**
   * One entry per URL in `documents`: how it was found and the quick PDF checks. Since scoring v7 the
   * checked PDFs' problems are one scored check (`documentScore`).
   */
  documentChecks?: DocumentCheck[];
  /**
   * Scoring v7: the documents check. `scored` false when the scan left documents out of the score
   * (`ScanOptions.documentScore: false`, CLI --no-document-score; `note` says so). Absent on reports
   * made before v7 (their documents were never scored).
   */
  documentScore?: DocumentScoreSummary;
  /**
   * The platform the site is built on, from fixed signs the scan saw (src/platform.ts): the generator
   * meta tag, asset hosts and paths. `id` 'unknown' when none. Absent on reports made before it (the
   * report then reads its own addresses, `reportPlatform`).
   */
  platform?: { id: string; name: string; signs: string[] };
  /** Video and audio on the scanned pages, with rules-based findings (no AI). Never scored. */
  media?: MediaItem[];
  /**
   * "What a screen reader hears" (the screen-reader pass, `src/probes/screenReader/`): bounded
   * transcript excerpts for the start page and pages with findings. Not scored. Absent when the pass
   * did not run.
   */
  screenReader?: ScreenReaderSection;
  /**
   * What the scanned pages contain (form fields, frames), read from the axe results already
   * gathered. Decides which criteria apply. Never scored.
   */
  inventory?: ScanInventory;
  /**
   * One automated result per WCAG 2.2 Level A and AA criterion (55 rows), derived from everything
   * above (see `report/criteria.ts`). axe failures and core probe failures count toward the score
   * (scoring v3); the rest does not.
   */
  criteria?: CriterionResult[];
  /**
   * The cross-page comparison rules' results (2.4.5, 3.2.3, 3.2.4, 3.2.6), computed from facts the
   * scan collected on every page (the facts themselves are not kept). Feeds `criteria`. Never scored.
   */
  consistency?: { criterion: string; method: CriterionMethodResult; evidence: CriterionEvidence[] }[];
  skipped: { url: string; reason: string }[];
  /**
   * Present only when an AI review was configured for the scan. Only its confirmed altText failures
   * (`AiFinding.scored`) count toward the score (scoring v5, `aiChecks`); the rest is an opinion.
   */
  ai?: AiReport;
  /** Scoring v5: the AI-reviewed image checks in the score. Absent on reports made before v5. */
  aiChecks?: AiScoreSummary;
  /**
   * Evidence images (report v2): metadata only, in report order. The JPEG bytes went to the scan's
   * evidence sink (`ScanOptions.evidence`). Absent when the scan had no sink.
   */
  evidence?: EvidenceShot[];
  /**
   * Pictures of axe rules the evidence pass planned but could not take (the page did not load again,
   * the element was gone), with the reason in plain words. Absent when none was missed.
   */
  evidenceMissed?: { rule: string; page: string; reason: string }[];
  /**
   * Work after the pages the scan stopped or skipped for want of time (src/finishPlan.ts), each with
   * its line ("Not checked: the deep tests (the scan ran out of time)"). What it would have tested is
   * "not tested" and costs nothing in the score. Absent when everything ran.
   */
  notChecked?: { stage: 'core-tests' | 'deep-tests' | 'documents' | 'ai-review' | 'pictures'; detail: string }[];
  /**
   * Interaction, render and pixel probe runs on the template sample (Plan 4). Present when probes ran.
   * Core probes' failed and no-failures-found results are scored (scoring v3, `testIssues`); deep ones never.
   */
  probes?: { runs: ProbeRun[] };
  /**
   * The scan's pace, when the site asked it to slow down (HTTP 429 or 503, or a 403 after earlier pages
   * loaded) or its robots.txt set a Crawl-delay. Absent otherwise. Only timing and which loads
   * succeeded change: the page selection never does.
   */
  pace?: ScanPace;
  /**
   * Monitoring scans (docs/monitoring.md): how many pages were checked again and how many had not
   * changed since the monitor's previous scan (their results carried forward). Absent on other scans.
   */
  incremental?: IncrementalSummary;
  meta: {
    engine: string;
    axe: string;
    scoring: string;
    viewports: Viewport[];
    /** axe-core tags whose rules ran. */
    tags: string[];
    /** WCAG A/AA axe rules turned on by id on top of `tags` (experimental, or off by default). */
    enabledRules: string[];
    userAgent: string;
    startedAt: string;
    finishedAt: string;
    pageList: string[];
    /**
     * Hosted page tiers: one plain line on the scan's size, set by the host (never by the engine): the
     * tier, and "Checked the first 5,000 pages." when a whole-site scan reached its page cap.
     * Shown in the hosted bar. Absent on 25-page and CLI reports.
     */
    scope?: string;
  };
}

/** The documents check in a report (scoring v7, `SiteReport.documentScore`). */
export interface DocumentScoreSummary {
  scored: boolean;
  /** PDFs the quick checks read. */
  checked: number;
  /** Of those, PDFs with at least one problem. */
  failed: number;
  /** Points the site gains when no checked PDF has a problem (0 when not scored). */
  pointsLost: number;
  /** Why documents are not in the score, when they are not. */
  note?: string;
}

/** How the scan slowed down for the site (`SiteReport.pace`). */
export interface ScanPace {
  /** The site refused loads, and the scan went to one load at a time with pauses. */
  slowedDown: boolean;
  /** The refusals, by HTTP status. */
  refusals: { status: number; count: number }[];
  /** Every refusal was of a stylesheet a page needed (the pages themselves were never refused). */
  stylesheetsOnly?: boolean;
  /** Loads tried again after a pause. */
  retries: number;
  /** Time the scan paused for the site (overlapping pauses counted once), in ms. */
  pausedMs: number;
  /** robots.txt Crawl-delay honoured between page loads (capped at 10 s), in ms. */
  crawlDelayMs?: number;
  /** Selected pages that still failed because the site kept refusing, or no time was left to wait. */
  failedPages: number;
  /**
   * Of those, pages that loaded but whose stylesheet the site kept refusing: left out of the score
   * rather than checked without their styles. Absent when none.
   */
  unstyledPages?: number;
}

// ---------------------------------------------------------------------------------------------
// Documents: PDF and Office files linked from the scanned pages. Listed and quickly checked (PDFs,
// and Word, Excel and PowerPoint files; no AI). Checked PDFs are scored since scoring v7; Office
// files are never scored.

export type DocumentType = 'pdf' | 'word' | 'excel' | 'powerpoint' | 'other';

/**
 * How a link was recognised as a document: `extension` (.pdf, .docx…), `attribute` (`type` or
 * `download` on the link), `text` (the link text names a format and the address looks like a
 * document download), `host` (a document service such as Google Docs or SharePoint), `probe`
 * (the server's answer to a HEAD or ranged GET: content type, file name or the file's first bytes).
 */
export type DocumentDetectedBy = 'extension' | 'attribute' | 'text' | 'host' | 'probe';

/** A link as the `documentLinks` collector saw it in the page. */
export interface DocumentLink {
  /** Absolute href. */
  href: string;
  /** Accessible name: aria-label, aria-labelledby, text, image alt or title (max 200 chars). */
  text: string;
  /** The link's `type` attribute, when present. */
  type?: string;
  /** The link's `download` attribute: the suggested file name, '' when present without one. */
  download?: string;
  /** Text of the closest block around the link (max 150 chars). */
  nearby?: string;
  /**
   * Links that share one small container (a list item, paragraph, table row or small card) share
   * this number, unique within the page. Absent when the link is the only one in its container.
   * Used to find an accessible version linked next to a document (see `documents/alternatives.ts`).
   */
  group?: number;
  /** Grouped links only: up to 60 characters of the container's text right before the link. */
  before?: string;
}

/**
 * Quick automated structure checks on one PDF (pdf.js through `unpdf`). A missing field means the
 * check could not tell. These find common problems; they never show that a document is accessible.
 */
export interface PdfChecks {
  /** Pages in the document. */
  pages: number;
  /** Pages read for the per-page checks (at most 20). */
  pagesChecked: number;
  /** A structure tree (tags) was found. MarkInfo /Marked alone, without tags, does not count. */
  tagged?: boolean;
  /** The catalog has a /Lang that looks like a language tag (e.g. `en-US`). */
  hasLanguage?: boolean;
  /** A title is set (Info /Title or XMP dc:title), and it is not a file name or "Untitled". */
  hasTitle?: boolean;
  /** Batch 19: that title (at most 200 characters), so the report can name the document. */
  title?: string;
  /** ViewerPreferences /DisplayDocTitle is on, so PDF readers show the title, not the file name. */
  showsTitle?: boolean;
  /** No text at all on the first pages (up to 5): probably a scanned image. */
  imageOnly?: boolean;
  /**
   * A page with no text has figures with alternative text, and whether those hold what the page shows could not
   * be shown (an image outside them, or a page that could not be measured). `imageOnly` is then left out: the
   * PDF is neither called a scan nor clean, and its 1.1.1 result is "not testable".
   */
  scanUnmeasured?: boolean;
  /** Figure tags with no /Alt (or /ActualText) on the pages read. */
  figuresWithoutAlt?: number;
  /** Form fields (by name) on the pages read. */
  formFields?: number;
  /**
   * Form fields with no tooltip (/TU), which screen readers use as the field's name. Only fields
   * whose widget holds the tooltip are counted: pdf.js cannot read one kept on a parent field.
   */
  untitledFormFields?: number;
  /** An XFA form, which most PDF readers and screen readers cannot use. */
  xfa?: boolean;
  /** Encryption forbids copying text, including for accessibility, or a password is needed to open it. */
  blocksAssistiveTech?: boolean;
}

/** A tagged figure (structure type Figure) in a PDF, in tag order. */
export interface PdfFigure {
  /** 1-based page number. */
  page: number;
  /** 1-based position among the figures tagged on that page. */
  orderOnPage: number;
  /** Its /Alt (or /ActualText, which pdf.js does not tell apart); absent when it has none. */
  alt?: string;
}

/** A tagged heading (H, H1–H6) in a PDF, in tag order. */
export interface PdfHeading {
  page: number;
  /** The structure type: 'H1'…'H6', or 'H' for a heading with no level. */
  tag: string;
  /** Its text, from the marked content it points at (max 200 chars). */
  text: string;
}

/** A form field (widget) in a PDF. */
export interface PdfField {
  page: number;
  /** The field's internal name (/T). */
  name: string;
  /** Its tooltip (/TU), which screen readers announce as its name; '' when it has none. */
  tooltip: string;
  /** 'text', 'checkbox', 'radio', 'choice', 'signature' or 'other'. */
  type: string;
}

/**
 * Facts about one downloaded PDF for the AI document review (`AiScanPlan.onDocument`). Never part
 * of the report. Lists are in tag order and capped (40 figures, 60 headings, 40 fields).
 */
export interface PdfDetails {
  /** Document title as written in the file (Info /Title or XMP dc:title), when set. */
  title?: string;
  /** The catalog /Lang as written, when set. */
  lang?: string;
  /** PDF /ModDate (or XMP xmp:ModifyDate) as an ISO date, when readable. */
  modified?: string;
  /** The HTTP Last-Modified header of the download, as an ISO date. */
  lastModified?: string;
  /** Pages whose structure was read for the lists (from page 1). */
  pagesRead: number;
  figures: PdfFigure[];
  headings: PdfHeading[];
  fields: PdfField[];
  /** How many were found on the pages read, before the caps. */
  totals: { figures: number; headings: number; fields: number };
}

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';

/**
 * Quick automated checks on one Word, Excel or PowerPoint file (`documents/office.ts`). A missing
 * field means the check does not apply to the format or could not tell. Never scored: evidence and
 * report rows only (docs/scoring.md, Documents).
 */
export interface OfficeChecks {
  /** What the file holds (its parts decide, not the link). */
  format: OfficeFormat;
  /** docProps/core.xml sets a title that is not a file name or a default name ("Document1"). */
  hasTitle?: boolean;
  /** A language is set (Word: the default or on the text; PowerPoint: on the text). Not checked for Excel. */
  hasLanguage?: boolean;
  /** Pictures (charts and shapes are left out). */
  images?: number;
  /** Pictures with no alt text (descr or title) that are not marked decorative. */
  imagesWithoutAlt?: number;
  /**
   * Batch 18 (neutral, for the AI review's 1.4.5 decision): Word and PowerPoint, the file holds pictures and no text at
   * all, as a scanned page pasted in does. No quick check reads it.
   */
  pictureOnly?: true;
  /** Word: paragraphs with a heading style or outline level. */
  headings?: number;
  /** Word: headings more than one level deeper than the one before (Heading 1 then Heading 3). */
  headingSkips?: number;
  /** Word, no heading styles at all: short lines that are all bold or large (14 pt or more), outside tables and lists. */
  fakeHeadings?: number;
  /** Word and PowerPoint: tables of at least 2 rows and 2 columns. */
  tables?: number;
  /** Of those, tables with no header row marked (Word: repeat header row or the Header Row option; PowerPoint: Header Row). */
  tablesWithoutHeader?: number;
  /** PowerPoint: slides shown (hidden slides are left out). */
  slides?: number;
  /** PowerPoint: shown slides with no title placeholder holding text. */
  slidesWithoutTitle?: number;
  /** Excel: visible sheets. */
  sheets?: number;
  /** Excel: visible sheets that keep a default name (Sheet1). */
  defaultSheetNames?: number;
  /** Excel: sheets with merged cells starting in the first two rows. */
  mergedHeaderSheets?: number;
  /** Word and PowerPoint: links with text. */
  links?: number;
  /** Of those, links whose text is a web address. */
  rawUrlLinks?: number;
  /** Encrypted: it needs a password (or rights) to open, so nothing in it can be read. */
  passwordToOpen?: boolean;
  /** Editing is restricted ("Restrict editing", protected sheets). Screen readers still read it: never a finding. */
  editingRestricted?: boolean;
  /** A size limit left part of the file unread: the checks cover the part read. */
  partial?: boolean;
}

/** One Office quick-check result in words (`officeFindings`): a `problem` fails the check, a `hint` is worth a look. */
export interface OfficeFinding {
  key: 'password' | 'alt' | 'tableHeader' | 'slideTitle' | 'language' | 'title' | 'headingOrder' | 'fakeHeadings' | 'linkText' | 'sheetNames' | 'mergedCells';
  criterion: string;
  level: 'problem' | 'hint';
  text: string;
}

/** One document in the inventory (`SiteReport.documentChecks`). */
export interface DocumentCheck {
  url: string;
  type: DocumentType;
  detectedBy: DocumentDetectedBy;
  /** Scanned pages that link to it, in audit order (max 20). Empty when it came from the sitemap only. */
  linkedFrom: string[];
  /** Present when the PDF was downloaded and read. */
  checks?: PdfChecks;
  /** Present when the Word, Excel or PowerPoint file was downloaded and read. Never scored. */
  officeChecks?: OfficeChecks;
  /** Plain-language reason the check failed (download error, not a PDF, unreadable…). */
  error?: string;
  /** Plain-language reason the document is listed but was not checked (limit reached, Office file…). */
  notChecked?: string;
  /**
   * Address of a version the site labels as accessible ("Accessible PDF", "HTML version", "Large
   * print"…), linked right next to this document (same list item, paragraph, table row or card) on
   * a scanned page. This document is then the original. The label is the site's; nothing here
   * checks that version.
   */
  accessibleAlternative?: string;
  /**
   * The first link to the document: its accessible name (`linkText`; batch 19: in the report too, at most 160
   * characters, so documents served from addresses like /download/<token> can be told apart) and the text of the
   * block around it (`linkNearby`: only on the snapshot handed to an AI plan's `onDocument`, never in a report).
   */
  linkText?: string;
  linkNearby?: string;
  /** Batch 19: the file name the server gave it (Content-Disposition), when it gave one. */
  fileName?: string;
}

// ---------------------------------------------------------------------------------------------
// Media: video and audio on the scanned pages. Listed with rules-based findings (no AI), never
// scored. Embedded players (YouTube, Vimeo…) are never downloaded.

/**
 * How the item is on the page: a native `<video>` or `<audio>` element, a player `<iframe>`
 * (`embed`), or a link to a video or audio file (`link`).
 */
export type MediaItemKind = 'video' | 'audio' | 'embed' | 'link';

/** Embedded players recognised by their address (see `classifyPlayer`). */
export type MediaPlayer =
  | 'youtube' | 'vimeo' | 'wistia' | 'brightcove' | 'kaltura' | 'panopto' | 'microsoft-stream' | 'facebook'
  | 'vidyard' | 'dailymotion' | 'twitch' | 'loom' | 'boxcast' | 'swagit' | 'granicus' | 'iqm2'
  | 'spotify' | 'soundcloud' | 'buzzsprout' | 'apple-podcasts';

/** A `<track>` of a native media element. */
export interface MediaTrack {
  /**
   * The browser's reading of the `kind` attribute: 'subtitles' (also when it is missing), 'captions',
   * 'descriptions', 'chapters' or 'metadata' (also when it is not a known kind).
   */
  kind: string;
  srclang?: string;
  label?: string;
  /** Absolute address of the WebVTT file. Absent when the track has no `src`. */
  src?: string;
}

/**
 * Captions (or, for sound-only media, transcript) status in plain terms:
 * `track` a captions or subtitles track with a file; `none` a native video without one;
 * `check-manually` an embedded player or a linked file, whose captions the scanner cannot see;
 * `transcript-nearby` / `no-transcript` sound-only media with or without the word "transcript"
 * in the same section of the page.
 */
export type MediaCaptions = 'track' | 'none' | 'check-manually' | 'transcript-nearby' | 'no-transcript';

/**
 * Rule ids of the media findings. `uploader-captions-missing` is in reports made before plan C14
 * (the CLI's old YouTube `videos.list` lookup); it is no longer made.
 */
export type MediaRule =
  | 'no-captions-track' | 'silent-video' | 'autoplay-sound-no-controls' | 'no-transcript-nearby'
  | 'check-captions-manually' | 'uploader-captions-missing' | 'platform-no-captions' | 'platform-auto-captions-only';

/**
 * Why a YouTube or Vimeo video's captions could not be read from the platform: `not-found` the
 * platform has no public video with that id (private, removed or unknown); `api-error` the platform's
 * API failed or answered something else; `daily-limit` the day's YouTube quota is spent; `scan-limit`
 * more videos than one scan checks; `time-limit` the scan's time ran out; `no-token` no API key or
 * token for that platform; `free-check` the free homepage check uses stored answers only.
 */
export type PlatformUncheckedReason = 'not-found' | 'api-error' | 'daily-limit' | 'scan-limit' | 'time-limit' | 'no-token' | 'free-check';

/**
 * The platform's own list of caption tracks for a YouTube or Vimeo video (plan C14): `captions` at
 * least one made by a person; `auto-only` only automatic ones; `none` no captions at all (forced
 * subtitles alone are none); `unchecked` it could not be read, with the reason.
 */
export interface PlatformCaptions {
  status: 'captions' | 'auto-only' | 'none' | 'unchecked';
  /** Languages of the tracks behind the status (BCP 47 as the platform gives them), at most 10. */
  languages?: string[];
  reason?: PlatformUncheckedReason;
  /** `api-error`: the platform's HTTP status, when it answered. */
  httpStatus?: number;
}

/** One rules-based finding for a media item. Only `problem` findings of 1.2.2 and 1.4.2 are scored (v8). */
export interface MediaIssue {
  /** WCAG success criterion, e.g. '1.2.2'. */
  criterion: string;
  /** `problem`: the rule found a definite failure. `review`: a possible problem the rules cannot decide. */
  level: 'problem' | 'review';
  rule: MediaRule;
  /** Plain-language explanation and fix for a site editor. */
  message: string;
}

/** One video or audio item in `SiteReport.media` (de-duplicated by kind and address). */
export interface MediaItem {
  kind: MediaItemKind;
  /** What it plays: sound only (`audio`: `<audio>`, audio files, podcast players) or pictures (`video`). */
  content: 'video' | 'audio';
  /** Media, player or file address (absolute). '' for a native element with no fetchable address (a stream). */
  url: string;
  /** Scanned pages it is on, in audit order (max 20). */
  foundOn: string[];
  /** Accessible name, `title` or figure caption, when the page gives one (max 150 characters). */
  name?: string;
  /** The embedded player, for `embed`. */
  player?: MediaPlayer;
  /** The video id in a YouTube or Vimeo player address. */
  videoId?: string;
  /** Native elements: their `<track>` elements. */
  tracks?: MediaTrack[];
  /** Native elements: starts playing by itself. */
  autoplay?: boolean;
  /** Native elements: muted by the page. */
  muted?: boolean;
  /** Native elements: the browser's own play/pause and volume controls are shown. */
  controls?: boolean;
  /**
   * Native elements: a background video by its markup (aria-hidden="true" or role presentation/none on the
   * video itself, muted, looping, no controls: `MediaElementFact.decorative`). It needs no captions or
   * description (`mediaIssues`).
   */
  decorative?: true;
  /** Native elements: length in seconds, when the browser had loaded it. */
  duration?: number;
  /** Native elements: plays again from the start when it ends (`loop`), so it never stops by itself. */
  loop?: boolean;
  /**
   * Native video: `none` when the browser had read the file's tracks and it has no sound track (a video-only file).
   * `present` confirms an audio track; absent means unknown (metadata/capture unavailable). A video without sound needs no captions (1.2.2) and plays
   * no sound by itself (1.4.2).
   */
  audio?: 'none' | 'present';
  /** Native elements: not shown on the page when it was scanned (not displayed, hidden, or no size). */
  hidden?: true;
  /**
   * Native video: text next to it says it shows the same information as the text on the page (a media alternative
   * for text, which WCAG 1.2.2 exempts when it is clearly labelled as such). Whether it really does is not checked.
   */
  alternativeForText?: true;
  /** Native video: the poster image address. */
  poster?: string;
  /** Sound-only items: the word "transcript" appears in the same section of the page. */
  transcriptNearby?: boolean;
  captions: MediaCaptions;
  /** Reports made before plan C14 only (the CLI's old `videos.list` lookup): the uploader added captions. */
  uploaderCaptions?: boolean;
  /**
   * YouTube and Vimeo videos with an id, when the scan could ask the platform (a key, a token or stored
   * answers): the platform's own caption tracks. Unscored evidence for 1.2.2.
   */
  platformCaptions?: PlatformCaptions;
  /** Rules-based findings, problems first. Empty when the rules found nothing to report. */
  issues: MediaIssue[];
}

// ---------------------------------------------------------------------------------------------
// Probes (Plan 4): automated interaction and render tests in a guarded browser. The probe API
// (PageProbe, ProbeContext) is in `src/probes/types.ts`; these are the parts that reach the report.

/** One thing a probe found on one page, for one of its criteria. */
export interface ProbeFinding {
  /** WCAG success criterion, e.g. '2.1.1'. Must be one of the probe's `criteria`. */
  criterion: string;
  status: CriterionStatus;
  /**
   * Scoring v8: a failure of a lighter kind than the criterion's usual one (a required field whose only
   * problem is that nothing visible says it is required). A page where every failure of the criterion
   * is minor costs a quarter of the weight there.
   */
  minor?: true;
  /**
   * A recommendation, not a failure (2026-11-07): a best practice WCAG does not require, such as heading
   * levels in order or a level-1 heading on every page. Only on a `no_failures_found` finding. Never in the
   * score, never the criterion's result (`probeCriteriaResults` leaves it out); the report lists it under
   * "Other recommendations for improvement".
   */
  advice?: true;
  /** Human-readable pointer: CSS path, element text, control name. */
  target?: string;
  /**
   * Keys naming the failing element (src/aiDedupe.ts: `sel:` its CSS path, `text:` its name, `role:` its
   * role), so one element another method also fails is one problem and one cost. Optional: without them
   * the target is read (`probeFindingElements`).
   */
  elements?: string[];
  /**
   * Set by the report builder only: a scored axe rule fails the same element on this page for the same
   * criterion (`rule:<id>`). The failure is listed with that rule's problem and costs nothing here.
   */
  coveredBy?: string;
  /** Plain-language detail. For `not_testable`, the reason (shown after "could not be tested automatically on this site:"). */
  detail: string;
  /**
   * Small measured values for the report's fix snippets (report v2 §4.1), e.g. `{ coverHeight: 92 }`
   * on a 2.4.11 failure (the covering element's height in CSS px). At most 5 keys; values are finite
   * numbers or strings (max 200 characters). The runner drops anything else.
   */
  data?: Record<string, number | string>;
  /**
   * Set by the probe runner only (a probe's own findings never carry it): the test could not run on
   * this page because the runner's load of it failed, and why. 'challenge': a bot challenge (HTTP 202);
   * 'unstyled': the site refused its stylesheet; 'browser-lost': the browser closed and the work could
   * not be redone; 'not-loaded': any other load failure. The report keys on this code
   * (`challengedPages`, `browserLost`), never on the detail text.
   */
  loadFailure?: ProbeLoadFailure;
  /**
   * Set by the probe runner and the scan only (on a `not_testable` finding): the scan's time limit
   * stopped this test on this page, before it finished or before it started. The criterion reads
   * "Partly tested", never "no failures found" (`probeCriteriaResults`).
   */
  timeLimit?: true;
  /**
   * Set by a probe (on a `not_testable` finding): the page has nothing this test needs to judge the
   * criterion (the status-message test on a page with no form to submit). Unlike a page where the test
   * ran and could not judge what it found, it does not hold back the result the test gave on its other
   * pages (`probeCriteriaResults`). Scoring treats the finding as any other not_testable one.
   */
  nothingToTest?: true;
  /**
   * Set by the scan only, on a failed finding whose `target` names an element: the element's kind
   * (src/collect/kinds.ts: what it is to styles and scripts, whatever it says), as read when the test's page
   * loaded. It sends a check of the same kind of element to other pages (`ProbeRun.checked`); it is never
   * what a failure there is reported from.
   */
  kind?: string;
  /**
   * Set by the scan only (on a `not_testable` finding): the scan's own limits left content for this test
   * untested (a deep test's page cap). Like `timeLimit`, a criterion with such a finding never rolls up to
   * "no failures found" from the pages that were tested (`probeCriteriaResults`).
   */
  limit?: true;
  /**
   * Set by the report builder only (`SecondLookDemotion`): a failure the review's second look doubted, now
   * `flagged` (Needs review), with the reason it gave. Never in the score.
   */
  secondLook?: string;
}

/** One element a test's finding names (`ProbeRun.elements`), as the page showed it: data only, capped. */
export interface ProbeElementFacts {
  /** The finding's target (a CSS path, ' >>> ' into a shadow root). */
  target: string;
  /** How many elements the path matched (0: none; the facts describe the first). */
  found: number;
  /** Its start tag, and its text (whitespace collapsed), each cut. */
  tag?: string;
  text?: string;
  /** Its box in document CSS px: x, y, width, height. */
  box?: [number, number, number, number];
  /** A few computed values. */
  style?: Record<string, string>;
  /** The next element after it: its tag name and text. */
  next?: { tag: string; text: string };
  /** Its nearest container (table, list, form, nav, section, landmark, any element with a role): start tag, text length. */
  container?: { tag: string; text: number };
  /** Up to five controls in that container (links, buttons, fields, summaries, focusable elements). */
  controls?: { tag: string; text: string }[];
}

/** Why a probe runner's load of a page failed (`ProbeFinding.loadFailure`). */
export type ProbeLoadFailure = 'challenge' | 'unstyled' | 'browser-lost' | 'not-loaded';

/** One probe on one page. Summarised: no screenshots or other large data. */
export interface ProbeRun {
  probe: string;
  kind: 'interaction' | 'render' | 'pixels';
  page: string;
  criteria: string[];
  /** `timeout` and `error` runs carry one `not_testable` finding per criterion with the reason. */
  status: 'ok' | 'timeout' | 'error';
  findings: ProbeFinding[];
  /** Run time in ms (excludes loading the page). */
  ms: number;
  /**
   * Small JSON evidence the probe attached with `ProbeContext.setData` (at most `PROBE_DATA_MAX_CHARS`
   * characters serialized), for the AI review (`AiScanPlan.onProbeRun`). Kept out of the report.
   */
  data?: unknown;
  /**
   * Set by the probe runner only, when the scan's AI review asks for it (`AiScanPlan.elementFacts`): the elements the
   * run's failed, not-testable and flagged findings name, as the page showed them when the test was done (src/probes/
   * elementFacts.ts). Neutral evidence for the review; every string is untrusted page content. Kept out of the report,
   * like `data`.
   */
  elements?: ProbeElementFacts[];
  /**
   * 'unavailable' when the browser could not load the page in the popup sandbox (no CDP session),
   * 'lost' when the session closed while the probe ran: only the listener hook kept windows from
   * opening, and the run's clean results are not_testable (see `GuardOptions.sandbox`).
   */
  popupSandbox?: 'unavailable' | 'lost';
  /**
   * Requests that would have sent data that the page made by itself while the test ran (analytics
   * beacons, heartbeats, retries: `GuardEvent.cause` 'background'): blocked, never sent, and the test
   * went on. How many, and their hosts (at most 5).
   */
  backgroundWrites?: { count: number; hosts: string[] };
  /**
   * Set by the scan only (src/probes/componentCheck.ts): the test was not run on the whole of this page.
   * Elements of a kind that failed it on other pages (`from`, at most 3 of them) were found on this page and
   * **measured here**, each on its own: its findings are what was measured on this page's own elements, with
   * their own selectors. `criteria` lists only the criteria with such a failure: the run says nothing about the
   * rest of the page or the test's other criteria. Always a run of the wider coverage too (`coverage`).
   */
  checked?: { from: string[] };
  /**
   * Set by the scan only: a run of the wider test coverage (2026-11-10, src/probes/sample.ts): a test on a
   * page outside the template sample that scoring v10 did not run there (the newer every-page tests, the
   * slow tests sent to pages with something new). Its results are the page's and the criterion's, in the
   * report like any run's. They are **listed, not scored** until a scoring version is calibrated with them:
   * a criterion's share stays over the pages scoring v10 tested it on (`probeChecksFrom`), so the same
   * site scores what it scored before.
   */
  coverage?: true;
}

/** One probe's result for one criterion, aggregated over the pages it ran on (`probeCriteriaResults`). */
export interface ProbeCriterionResult {
  criterion: string;
  method: CriterionMethodResult;
  evidence: CriterionEvidence[];
}

// ---------------------------------------------------------------------------------------------------
// Scan events (Plan 5, Task 5.9): what the live scan screen draws while a scan runs
// (docs/design/2026-10-31-grnted-site/README.md §3.2). Observation only: they never change the report.

/** One failing axe rule at one width (or merged over a page's widths), with how many elements fail it. */
export interface RuleHit {
  /** axe rule id. */
  id: string;
  /** The rule's impact in the scoring table (`RULE_IMPACTS`), the same one the report uses. */
  impact: Impact;
  /** Failing elements (axe nodes) for this rule. */
  count: number;
}

/**
 * One box in a page wireframe, in CSS px relative to the top left of the page (rounded integers, clipped
 * to the wireframe's `W` × `H`). Layout boxes carry no `rule`; failing elements carry `rule` and `impact`.
 */
export interface WireEl {
  /**
   * The element's kind. `select` and `textarea` are `input`; for failing elements, h4–h6 are `h3`, nav is
   * `header`, media and frames are `img`, and anything else is `p` (a generic block).
   */
  t: 'header' | 'main' | 'footer' | 'h1' | 'h2' | 'h3' | 'p' | 'a' | 'button' | 'img' | 'input' | 'label';
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Public text only, whitespace collapsed, at most 48 characters: on h1–h3, links, buttons and labels.
   * Never a form field's value or content, never an attribute value (alt, title, aria-label…).
   */
  text?: string;
  /** For a failing element: the axe rule it fails. */
  rule?: string;
  /** For a failing element: that rule's impact (`RuleHit.impact`). */
  impact?: Impact;
}

/**
 * A page's layout at one width: `W` is the page's client width, `H` its scroll height (capped at
 * 20,000 px). At most 220 layout boxes, then up to 6 failing elements per rule (120 in all). Empty
 * (`{ W: 0, H: 0, els: [] }`) when the page failed or the capture failed or timed out.
 */
export interface Wireframe {
  W: number;
  H: number;
  els: WireEl[];
}

/**
 * Events a scan emits to `ScanOptions.onEvent`, in this order: `discover` steps, `selected`, then for
 * each page `viewport-start` ×2, `viewport-done` ×2 and `page-done` (pages interleave with
 * concurrency, but a page's viewport events always come before its `page-done`), then, once every
 * page is done, `stage` events for the work that follows the pages (each stage's `start` before its
 * `progress` and its `done`; stages run side by side, see `ScanStage`), then `scoring` steps and `done`
 * last. `pace` can come at any time. Each event is a fresh object: a listener may keep or change it
 * without effect.
 */
export type ScanEvent =
  /**
   * A discovery step. `robots`: robots.txt read (`count` = sitemaps it lists); `sitemap`: page
   * addresses kept from the sitemaps; `normalize`: candidate addresses (the sitemap's, or the home
   * page's links when the sitemap has none); `select`: pages selected; `documents`: document links found.
   */
  /** `start` and `home`: said before reading robots.txt and before loading the home page (the live view is never silent). */
  | { type: 'discover'; step: 'start' | 'home' | 'robots' | 'sitemap' | 'normalize' | 'select' | 'documents'; detail: string; count?: number }
  /** The selection: pages to audit (in order; `index` in later events is the position here), documents, skipped addresses. */
  | { type: 'selected'; pages: string[]; documents: string[]; skipped: { url: string; reason: string }[] }
  /** A page starts loading at one width (both widths load in parallel). */
  | { type: 'viewport-start'; index: number; url: string; viewport: 'desktop' | 'mobile' }
  /**
   * A width is done. `checks`: applicable axe rules there (passes + violations + incomplete).
   * `elements`: elements in the page's document there (DOM count; 0 when the width failed).
   * `failing`: that width's violations by rule, worst first. `ms`: how long the width took (load,
   * settle, axe, collectors, wireframe, live shot). A width that failed has zeros and an empty wireframe.
   * `shot`: the width's live screenshot (`LiveShot`), only with `ScanOptions.liveShots`, only for a
   * width that loaded and passed the navigation gate, and only once the sink took it.
   */
  | {
    type: 'viewport-done'; index: number; url: string; viewport: 'desktop' | 'mobile';
    checks: number; elements: number; failing: RuleHit[]; wireframe: Wireframe; ms: number; shot?: LiveShot;
  }
  /**
   * A page is done (both widths merged). `score`: the page's score from its audit (`auditPageScore`:
   * its axe rules and the frames from other sites on it, scored as the report scores pages; null when
   * it failed). It equals the report's page score, except on pages whose test results, media or
   * cross-page findings are added once those finish. `rules`: the page's violations by rule, worst
   * first. `reason`: why it failed.
   */
  | { type: 'page-done'; index: number; url: string; status: 'ok' | 'failed'; score: number | null; rules: RuleHit[]; reason?: string }
  /**
   * The site asked us to slow down (`slowed`: HTTP `status`; pages now load one at a time with pauses),
   * or answers normally again (`recovered`). Any time from discovery until the report is written.
   */
  | { type: 'pace'; step: 'slowed' | 'recovered'; detail: string; status?: number }
  /**
   * The work after the page checks, as it runs: after the last `page-done`, before `scoring`. A stage
   * sends `start`, then `progress` as it really moves (only where the engine can count it), then
   * `done`. `detail`: one plain sentence for the live view (stage names, test names and page paths
   * only, never page content), at most `STAGE_DETAIL_MAX` characters. `done`/`total`: real counts of
   * the stage's units so far (`ScanStage`); `total` may grow while a stage runs (PDFs found late).
   * `found`: the `documents` stage only, on every step: the documents found so far (never goes back;
   * at `done` it is the report's document count). The live view's Documents counter reads it.
   */
  /**
   * `units`: the `tests` and `ai` stages only, real counts of whole checks: the tests that have finished
   * every page they were given, of the tests this scan runs; the AI checks finished, of those in the review.
   */
  /**
   * `now`: what just started, for the live view's "Now" line: the test (its id) and its page's index in
   * the selection (`tests`), or the AI check (its title, `ai`). Names only, never a count or a sample.
   */
  | { type: 'stage'; stage: ScanStage; step: 'start' | 'progress' | 'done'; detail: string; done?: number; total?: number; found?: number; units?: { done: number; total: number }; now?: { check: string; page?: number } }
  /** Scoring steps: `weighting` (rules and pages scored), `writing` (the report). Scoring v4 has no cap step. */
  | { type: 'scoring'; step: 'weighting' | 'writing'; detail: string }
  /**
   * Long scans (hosted 250-page and whole-site tiers) only, sent by the host, never by scanSite: the
   * live view shows the first pages tile by tile and the rest as this summary. `done` of `total` pages
   * so far (`total` grows while the crawl finds pages), `failed` of them did not load; `detail` is one
   * plain line (for example that the report is emailed when the scan is done). `endsAt`: when the scan
   * should end (epoch ms, never past its deadline): the live view counts its "About N minutes left" down
   * from it, and says "Finishing up…" once it has passed.
   */
  | { type: 'progress'; done: number; total: number; failed: number; detail: string; endsAt?: number }
  /**
   * A line for the buyer, sent by the host, never by scanSite. `slow-site`: the site answers slowly, so
   * the scan was given more time (the live view shows `detail` until the scan ends).
   */
  /**
   * `refused`, `paced`, `relaunch`, `segment`, `refusing`, `retry` (sent by the host for its own waits, one
   * per occurrence, coalesced and capped): the site turned pages away and they are tried again; pages at
   * once lowered; a fresh browser; a long scan's next stretch; the refused pages are no longer tried
   * (the whole site refuses us, or the fresh starts ran out), so they can't be checked (once a scan); the
   * pages the site turned away get one more try at the end (`ScanOptions.lateRetry`, once a scan).
   * The live view lists them and says each once. `fallback`: the hosted checker's own scanner retries a
   * site that turned our cloud browsers away, and where that wait is (never sent by the engine itself).
   */
  | { type: 'notice'; kind: 'slow-site' | 'refused' | 'paced' | 'relaunch' | 'segment' | 'refusing' | 'retry' | 'fallback'; detail: string }
  /**
   * Provisional results so far, for the live view's criteria grid and findings feed (src/found.ts): as
   * each page's audit (`rules`), each test run (`test`) and each AI review item (`ai`) finishes. Only
   * what is new: `checked`, the criteria this kind of check gave a result for that it had not named
   * before; `problems`, the problems it adds (a check, a criterion and the count it adds on `page`, the
   * page's index in the selection; absent for something that isn't a page, such as a PDF). `flag`: the
   * AI review (or a test) flagged it for a closer look. Provisional: the verdict comes from scoring, and
   * nothing here is a weight, share, threshold or point. Sent from the first page audit until scoring.
   */
  | { type: 'found'; provisional: true; source: 'rules' | 'test' | 'ai'; page?: number; checked: string[]; problems: FoundProblem[] }
  /** The verdict. `critical`: failing rules with critical impact. */
  | { type: 'done'; status: 'scored' | 'incomplete'; score: number | null; letter: string | null; headline: string; critical: number };

/**
 * One provisional problem in a `found` event: `check` is the axe rule, the test (probe) or the AI check
 * that found it, `count` the elements (a rule), failures (a test) or flagged items (the AI review) it adds.
 * `pages`: the pages it adds on, when the event gathers several (past FOUND_EVENTS_MAX, src/found.ts); then
 * the event has no `page`, and a problem without `pages` in it was found off any page (a PDF).
 */
export interface FoundProblem { check: string; criterion: string; count: number; flag?: true; pages?: number[] }

/**
 * A stage of the work that follows the page checks (`ScanEvent` `stage`), and its unit:
 * - `tests`: the automated tests (probes) still running on the template sample; test runs (one test on one page).
 * - `documents`: the document checks (link probes, PDF checks); PDFs checked of those started.
 * - `media`: the video and audio inventory, only when it asks YouTube or Vimeo for captions; no counts.
 * - `pictures`: screenshots of the problems for the report; pictures in the report at `done`.
 * - `ai`: the AI review (only with one that reviews); AI checks finished.
 * `tests`, `documents`, `media` and the first `pictures` run side by side; `ai` follows them, then a
 * second `pictures` (the images the AI review flagged) when the review gave any.
 */
export type ScanStage = 'tests' | 'documents' | 'media' | 'pictures' | 'ai';

// ---------------------------------------------------------------------------------------------------
// The screen-reader pass's report excerpt (src/probes/screenReader/, FORMAT.md for the full transcript).

/** One line of a read-through excerpt: its position in the full read-through, the words, and its flag. */
export interface SrLine {
  n: number;
  text: string;
  /** Index into `SrReportData.flags`. */
  flag?: number;
}

/** What the screen-reader pass keeps for one page (`ProbeRun.data` of the `screen-reader` probe). */
export interface SrReportData {
  v: 1;
  voice: 'nvda' | 'voiceover';
  /** The read-through excerpt: the first lines, then every flagged line (gaps where `n` jumps). */
  read: SrLine[];
  lists: { headings: string[]; landmarks: string[]; links: string[]; formControls: string[]; tables: string[] };
  tab: string[];
  /** criterion '' marks a note that is not a failure (duplicate names). */
  flags: { criterion: string; note: string }[];
  /** Full sizes before the excerpt was cut. */
  counts: { read: number; headings: number; landmarks: number; links: number; formControls: number; tables: number; tab: number };
  truncated: boolean;
}

/** One spoken line while the page is used. `heard: false`: shown on the page but not spoken. */
export interface LiveLine {
  flow: 'menu' | 'form';
  /** What was done ("pressed Menu"). */
  action: string;
  text: string;
  heard: boolean;
  /**
   * A message not heard at once but tied to a field (aria-describedby, aria-errormessage, its label): the
   * field's label. A screen reader says it as that field's description when focus reaches the field.
   */
  withField?: string;
  /** The criterion this line fails, when it does. */
  criterion?: string;
}

/** What the live pass keeps for one page (`ProbeRun.data` of the `screen-reader-live` probe). */
export interface SrLiveData {
  v: 1;
  voice: 'nvda' | 'voiceover';
  lines: LiveLine[];
  menus: number;
  forms: number;
}

/** One page of "What a screen reader hears". */
export interface ScreenReaderPage {
  page: string;
  read?: SrReportData;
  live?: SrLiveData;
  /** The two passes' failed findings on this page (criterion, detail). */
  failed: { criterion: string; detail: string }[];
}

export interface ScreenReaderSection {
  voice: 'nvda' | 'voiceover';
  pages: ScreenReaderPage[];
  /** Pages with findings left out by the page cap. */
  morePages: number;
}
