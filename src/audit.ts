// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { mergeThirdPartyRuns, mergeViewportRuns } from './axeMerge.js';
import { laterAxe } from './axeLater.js';
import { LATE_CONTENT_MS, mountingNow, trackMount } from './probes/mounting.js';
import { runAxe } from './axeRun.js';
import { collectLinks } from './pageLinks.js';
import { VIEWPORTS, auditPageScore } from './report/build.js';
import { runCollector, runsAt } from './collect/index.js';
import { captureWireframe, emptyWireframe, failingTargets, ruleHits, safeEmit, viewportChecks } from './events.js';
import {
  LANDING_CANCELLED, LANDING_OUT_OF_TIME, LANDING_UNCHECKED, MOVED_BY_ITSELF, OTHER_SITE, TOO_SLOW, bindLanding, checkMark, isNavigationError, isOtherSite, landingFailure, markedStill, settleLanding, watchLanding, within,
  type DocumentMark, type Landing, type LandingWatch,
} from './landing.js';
import { LIVE_SHOT_LIMITS, captureLiveShot, type LiveShotCapture } from './liveShot.js';
import { NOT_ALLOWED, documentGate, gateFailure, gateStopsLoad } from './navigationGate.js';
import { cdpSession, CONTEXT_CLOSE_MS, GATE_LOST, isBrowserGone, pageGone, settlesWithin } from './reconnect.js';
import { gotoPolitely, isUnstyledReason, type Pace } from './pace.js';
import { refusedSince, watchStyles } from './styles.js';
import { isResponseCodeFailure, navigationOf, thrownStatus, type NavigationStatus } from './egress.js';
import type {
  AxeRun, BrowserLike, LiveShot, LiveShotOptions, PageAudit, PageLike, PageCollector, ScanEvent, ThirdPartyRun, UntestedFrame, Viewport, Wireframe,
  ResponseLike,
} from './types.js';

/** Wait after load before axe runs (the evidence pass loads pages the same way). */
export const SETTLE_MS = 1500;

/** The scroll pass that wakes lazy content (runs in the page). */
export async function scrollThrough(): Promise<void> {
  const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
  const max = Math.min(document.body?.scrollHeight ?? 0, 20_000);
  for (let y = 0; y < max; y += step) {
    window.scrollTo({ left: 0, top: y, behavior: 'instant' as ScrollBehavior });
    await new Promise((r) => setTimeout(r, 100));
  }
  window.scrollTo({ left: 0, top: 0, behavior: 'instant' as ScrollBehavior });
}

/**
 * The address of the document a page shows now, without its fragment (undefined when the browser
 * can't say). A page that navigated itself (a meta refresh, a script) shows another document: anything
 * pictured then is not the page that was loaded (the live shots and the evidence pass check this).
 */
export function documentAddress(page: PageLike): string | undefined {
  try {
    return page.url ? page.url().split('#')[0] : undefined;
  } catch {
    return undefined;
  }
}



export interface AuditOptions {
  userAgent: string;
  axeSource: string;
  timeoutMs?: number;
  /**
   * The scan's cancellation and its deadline (epoch ms): a page still replacing itself after its load
   * stops waiting at either (src/landing.ts).
   */
  signal?: AbortSignal;
  deadline?: number;
  /** Run after axe at their viewport(s); results land in `PageAudit.collected`. */
  collectors?: readonly PageCollector[];
  /** The page's position in the scan order, passed to collectors (and the events' `index`). */
  index?: number;
  /**
   * Scan events for this page: `viewport-start` / `viewport-done` per width (with its wireframe), then
   * `page-done`. Observation only; a throwing listener is ignored. Without it no wireframe is captured.
   */
  onEvent?: (e: ScanEvent) => void;
  /**
   * The scan's politeness controller (`src/pace.ts`): page loads wait their turn, and a load the site
   * refused (HTTP 429/503, or a 403 after earlier successes) is tried again after a pause.
   */
  pace?: Pace;
  /**
   * Live screenshots (only with `onEvent`): each width that loads and passes the navigation gate gets one
   * first-screen JPEG, taken right after its wireframe and handed to the sink before its viewport-done
   * (which then carries `shot`). Bounded in time and size; any failure only means no shot.
   */
  liveShots?: LiveShotOptions;
  /**
   * Diagnostics: where each width's time went (`ViewportSteps`), once the width is done (loaded or
   * not). Observation only; a listener that throws is ignored.
   */
  onSteps?: (steps: ViewportSteps) => void;
  /**
   * Monitoring scans (docs/monitoring.md): keep what the desktop load answered in `PageAudit.document`
   * (its status and the rendered DOM's text length and element count).
   */
  document?: boolean;
}

/** The timed steps of one page width, in the order they run. */
export const VIEWPORT_STEPS = ['context', 'newPage', 'load', 'settle', 'styles', 'axe', 'links', 'collectors', 'wireframe', 'shot', 'late', 'close'] as const;
export type ViewportStep = (typeof VIEWPORT_STEPS)[number];

/**
 * Where one page width's time went (ms), for timing runs: opening its context and page, the loads
 * (`load`: the navigations and any wait the pace controller made them take, every try), the scroll
 * pass and settle window after each load (`settle`), the stylesheet watch's settle and judgement
 * after each try (`styles`), axe, the link list, the collectors (each in `collectorMs`), the live
 * view's wireframe and shot, the checks after them (`late`: the gate and the stylesheets refused
 * since) and closing the context.
 */
export interface ViewportSteps {
  url: string;
  index: number;
  viewport: Viewport['name'];
  status: 'ok' | 'failed';
  /** Epoch ms when the width started. */
  startedAt: number;
  totalMs: number;
  /** Page loads made (tries of the navigation). */
  loads: number;
  ms: Record<ViewportStep, number>;
  collectorMs: Record<string, number>;
}

/** Hands a taken shot to the sink, time-boxed. The event's `shot`, or undefined when the sink failed. */
async function deliverShot(opts: LiveShotOptions, id: string, cap: LiveShotCapture): Promise<LiveShot | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const put = Promise.resolve().then(() => opts.sink(id, cap.jpeg));
    put.catch(() => undefined);
    await Promise.race([
      put,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Live shot sink timed out')), opts.sinkTimeoutMs ?? LIVE_SHOT_LIMITS.sinkTimeoutMs); }),
    ]);
    return { id, w: cap.w, h: cap.h };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function auditPage(browser: BrowserLike, url: string, opts: AuditOptions): Promise<PageAudit> {
  const emit = safeEmit(opts.onEvent);
  const index = opts.index ?? 0;
  // Both widths load in parallel; results stay in VIEWPORTS order so the merge is deterministic.
  const done = await Promise.all(VIEWPORTS.map(async (vp) => {
    if (!emit) return { r: await auditViewport(browser, url, vp, opts, false), ms: 0 };
    const started = Date.now();
    emit({ type: 'viewport-start', index, url, viewport: vp.name });
    const r = await auditViewport(browser, url, vp, opts, true);
    return { r, ms: Date.now() - started };
  }));
  const results = done.map((d) => d.r);
  const failure = results.find((r): r is PageAudit => 'status' in r);
  if (emit) {
    // Each width's result once both are done: a picture is kept only of a page that loaded at both
    // widths (one width that lost its styles or failed takes the other's picture with it).
    for (const [i, vp] of VIEWPORTS.entries()) {
      const { r, ms } = done[i]!;
      const ok = !('status' in r);
      // The context is closed by now: the sink's write never holds a browser page open.
      const shot = ok && !failure && r.shot && opts.liveShots ? await deliverShot(opts.liveShots, `${index}-${vp.name}`, r.shot) : undefined;
      if (ok) delete r.shot;
      emit({
        type: 'viewport-done', index, url, viewport: vp.name,
        checks: ok ? viewportChecks(r.run) : 0,
        elements: ok ? (r.wire?.elements ?? 0) : 0,
        failing: ok ? ruleHits(r.run.violations) : [],
        wireframe: ok && r.wire ? r.wire.wireframe : emptyWireframe(),
        ms,
        ...(shot ? { shot } : {}),
      });
    }
  }
  if (failure) {
    emit?.({ type: 'page-done', index, url, status: 'failed', score: null, rules: [], ...(failure.reason ? { reason: failure.reason } : {}) });
    return failure;
  }
  const runs = results as ViewportResult[];
  const audit: PageAudit = { url, status: 'ok', ...mergeViewportRuns(runs), links: runs[0]?.links ?? [] };
  const untestedFrames = mergeUntestedFrames(runs);
  if (untestedFrames.length) audit.untestedFrames = untestedFrames;
  const thirdParty = mergeThirdPartyRuns(runs);
  if (thirdParty.length) audit.thirdParty = thirdParty;
  const served = runs.find((r) => r.served)?.served;
  if (served) audit.document = served;
  if (runs.some((r) => r.unsettled)) audit.animationsUnsettled = true;
  if (opts.collectors?.length) {
    const collected: Record<string, unknown> = {};
    for (const c of opts.collectors) {
      if (c.viewport === 'both') {
        collected[c.id] = Object.fromEntries(runs.map((r) => [r.viewport, r.collected[c.id]]));
      } else {
        collected[c.id] = runs.find((r) => r.viewport === c.viewport)?.collected[c.id];
      }
    }
    audit.collected = collected;
  }
  if (emit) {
    // The page's score from its audit, as the report computes page scores (the tests, media and
    // cross-page rules are added later, with the report).
    emit({ type: 'page-done', index, url, status: 'ok', score: auditPageScore(audit), rules: ruleHits(audit.violations) });
  }
  return audit;
}

/** Longest wait for entrance animations to finish before axe runs (bounded: an endless one never holds a page up). */
export const ANIMATION_SETTLE_MS = 3000;
/** Longest wait for content a contrast failure was found on to reach full opacity. */
export const OPACITY_SETTLE_MS = 2000;

/**
 * Waits, at most `maxMs`, until no finite animation or transition (Web Animations API, CSS animations
 * and transitions) is running or waiting out its delay. Endless ones (a spinner) are not waited for.
 * True when it settled; false when the time ran out; never throws.
 */
export async function settleAnimations(p: PageLike, maxMs: number): Promise<boolean> {
  const r = await p.evaluate(async function settleAnimationsInPage(max: number): Promise<boolean> {
    const busy = () => {
      try {
        return document.getAnimations().some((a) => (a.playState === 'running' || a.pending) && Number.isFinite(Number(a.effect?.getComputedTiming().endTime ?? Infinity)));
      } catch {
        return false;
      }
    };
    const t0 = Date.now();
    while (busy() && Date.now() - t0 < max) await new Promise((r) => setTimeout(r, 100));
    return !busy();
  }, maxMs).catch(() => true);
  return r !== false;
}

/** The top-document selectors of the colour-contrast failures (frames are left out). */
/**
 * The top-document selectors of `color-contrast` failures, for the fade re-run. A node's target is one string
 * (axeRun.ts joins frame and shadow parts with " >>> "); only a plain selector names an element of this document.
 * (Before 2026-11-08 this read the string as an array, so only one-character selectors like "p" were re-run and a
 * fading "#text" kept its false failure: Sol, late-mount r3.)
 */
export function contrastTargets(run: Pick<AxeRun, 'violations'>): string[] {
  const out = new Set<string>();
  for (const f of run.violations) {
    if (f.id !== 'color-contrast') continue;
    for (const n of f.nodes) {
      const t: unknown = n.target;
      if (typeof t === 'string' && t.trim() && !t.includes(' >>> ')) out.add(t.trim());
    }
  }
  return [...out].slice(0, 50);
}

/**
 * Whether the elements at `selectors` are still fading: 'rested' when some had an effective opacity
 * (its own times its ancestors') below 1 and all reached 1 within `maxMs`; 'none' when none was
 * below 1; 'moving' when the time ran out. Never throws.
 */
export async function waitOpacityAtRest(p: PageLike, selectors: readonly string[], maxMs: number): Promise<'rested' | 'none' | 'moving'> {
  const r = await p.evaluate(async function opacityAtRestInPage(a: { selectors: readonly string[]; max: number }): Promise<'rested' | 'none' | 'moving'> {
    const opacity = (el: Element | null) => {
      let o = 1;
      for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity) || 0;
      return o;
    };
    const els = a.selectors.map((s) => { try { return document.querySelector(s); } catch { return null; } }).filter((e): e is Element => !!e);
    const low = () => els.filter((e) => opacity(e) < 0.999);
    if (!low().length) return 'none';
    const t0 = Date.now();
    while (low().length && Date.now() - t0 < a.max) await new Promise((r) => setTimeout(r, 100));
    return low().length ? 'moving' : 'rested';
  }, { selectors, max: maxMs }).catch(() => 'none' as const);
  return r === 'rested' || r === 'moving' ? r : 'none';
}

type ViewportResult = {
  viewport: Viewport['name'];
  run: AxeRun;
  untestedFrames: UntestedFrame[];
  /** axe inside frames from other sites (scoring v3): listed, not scored. */
  thirdParty: ThirdPartyRun[];
  links: string[];
  collected: Record<string, unknown>;
  /** Animations were still running when axe ran (`ANIMATION_SETTLE_MS` ran out). */
  unsettled?: true;
  /** Only when events are on: the wireframe at this width and the page's DOM element count. */
  wire?: { wireframe: Wireframe; elements: number };
  /** Only with live shots on: this width's first screen (handed to the sink, then dropped). */
  shot?: LiveShotCapture;
  /** Only with `document`: what the desktop load answered (`PageAudit.document`). */
  served?: NonNullable<PageAudit['document']>;
};

/** What the page's own load answered (its status) and the rendered DOM's size: never fatal (a missing part is left out). */
async function servedDocument(p: PageLike, resp: ResponseLike, url: string): Promise<NonNullable<PageAudit['document']>> {
  let rendered: { text: number; elements: number } | undefined;
  try {
    rendered = await p.evaluate(() => ({
      text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().length,
      elements: document.getElementsByTagName('*').length,
    }), undefined);
  } catch {
    rendered = undefined;
  }
  let at = url;
  try {
    at = resp.url() || url;
  } catch {
    // the requested address
  }
  return { status: resp.status(), url: at, ...(rendered ? { rendered } : {}) };
}

/** Untested frames of both widths, each address and reason once, in viewport order. */
function mergeUntestedFrames(runs: ViewportResult[]): UntestedFrame[] {
  const seen = new Set<string>();
  const out: UntestedFrame[] = [];
  for (const f of runs.flatMap((r) => r.untestedFrames)) {
    const key = `${f.url}\n${f.reason}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

/** Times the steps of one width (see `ViewportSteps`). */
function stepClock() {
  const ms = Object.fromEntries(VIEWPORT_STEPS.map((k) => [k, 0])) as Record<ViewportStep, number>;
  const collectorMs: Record<string, number> = {};
  return {
    ms, collectorMs, loads: 0,
    async time<T>(step: ViewportStep, fn: () => Promise<T>): Promise<T> {
      const t0 = Date.now();
      try {
        return await fn();
      } finally {
        ms[step] += Date.now() - t0;
      }
    },
  };
}

async function auditViewport(
  browser: BrowserLike,
  url: string,
  vp: Viewport,
  opts: AuditOptions,
  withWire: boolean,
): Promise<ViewportResult | PageAudit> {
  if (!opts.onSteps) return auditViewportTimed(browser, url, vp, opts, withWire, undefined);
  const clock = stepClock();
  const startedAt = Date.now();
  const r = await auditViewportTimed(browser, url, vp, opts, withWire, clock);
  try {
    opts.onSteps({
      url, index: opts.index ?? 0, viewport: vp.name, status: 'status' in r ? 'failed' : 'ok', startedAt, totalMs: Date.now() - startedAt,
      loads: clock.loads, ms: clock.ms, collectorMs: clock.collectorMs,
    });
  } catch {
    // Diagnostics must not change the audit.
  }
  return r;
}

async function auditViewportTimed(
  browser: BrowserLike,
  url: string,
  vp: Viewport,
  opts: AuditOptions,
  withWire: boolean,
  clock: ReturnType<typeof stepClock> | undefined,
): Promise<ViewportResult | PageAudit> {
  // timeoutMs limits a navigation; only the caller's deadline limits the whole audit.
  const deadline = opts.deadline ?? Infinity;
  const stopped = () => opts.signal?.aborted ? LANDING_CANCELLED : Date.now() >= deadline ? LANDING_OUT_OF_TIME : undefined;
  const time = <T>(step: ViewportStep, fn: () => Promise<T>): Promise<T> => (clock ? clock.time(step, fn) : fn());
  let ctx: Awaited<ReturnType<BrowserLike['newContext']>>;
  try {
    const opened = await time('context', async () => {
      const opening = browser.newContext({ viewport: { width: vp.width, height: vp.height }, userAgent: opts.userAgent, reducedMotion: 'reduce' });
      const result = await within(opening, deadline, opts.signal);
      // A context delivered after the wait was cut still belongs to this audit and must be closed.
      if (result === 'cut') void opening.then((c) => c.close()).catch(() => {});
      return result;
    });
    if (opened === 'cut') return failed(url, stopped() ?? LANDING_OUT_OF_TIME);
    ctx = opened;
  } catch (err) {
    // No context (the browser closed): the page was not checked, with the reason; the scan goes on.
    if (stopped()) return failed(url, stopped()!);
    return failed(url, err instanceof Error ? err.message.split('\n')[0]!.slice(0, 200) : 'The browser could not open a page');
  }
  let page: PageLike | undefined;
  // The page's main-frame answers: a load the browser threw on (an HTTP error with no body) keeps its status.
  let nav: NavigationStatus | undefined;
  // The page's main-frame navigations (src/landing.ts), and the mark on the document measured.
  let watch: LandingWatch | undefined;
  let mark: DocumentMark | undefined;
  try {
    const c = ctx;
    const opened = await time('newPage', () => within(c.newPage(), deadline, opts.signal));
    if (opened === 'cut') return failed(url, stopped() ?? LANDING_OUT_OF_TIME);
    page = opened;
    nav = navigationOf(page);
    watch = watchLanding(page);
    const w = watch;
    // Hosted use: a page whose gate could not start is not loaded at all (nothing would check its hops).
    const stop = gateStopsLoad(page);
    if (stop) return failed(url, stop);
    const p = page;
    // The page's stylesheets: one the site refused (it was throttling us) means the page rendered
    // unstyled, which is not the page people get. Such a load is tried again like a refused one.
    const watched = watchStyles(page, opts.pace, url);
    // Timing runs: the watch's settle and judgement after each try are timed apart from the load.
    const styles = watched && clock
      ? { reset: () => watched.reset(), settle: (ms?: number) => time('styles', () => watched.settle(ms)), degraded: () => time('styles', () => watched.degraded()) }
      : watched;
    let loadedAddress: string | undefined;
    // Both widths load together: one load for a robots.txt Crawl-delay. Each try of an HTML page
    // settles (the scroll pass inside the settle window, so axe still starts at least SETTLE_MS after
    // load and lazy content triggered by the scroll gets the rest of the window to render) before its
    // stylesheets are judged, so a sheet the page adds while it settles is part of the try.
    // Timing runs: `load` is the navigations and the pace controller's waits, every try; the settle
    // window and the stylesheet watch are timed on their own.
    const loadStarted = Date.now();
    const settleBefore = clock?.ms.settle ?? 0;
    const stylesBefore = clock?.ms.styles ?? 0;
    const navigate = () => {
      if (clock) clock.loads++;
      nav?.reset();
      w?.begin();
      if (stopped()) throw new Error(stopped());
      return p.goto(url, { waitUntil: 'load', timeout: Math.max(1, Math.min(opts.timeoutMs ?? 45_000, deadline - Date.now())) });
    };
    // A page that replaces itself after its load (a client-side redirect, a reload, a bot manager's
    // interstitial) is measured where it lands, as a visitor sees it: each document it goes to gets the
    // scroll pass and settle window, until no main-frame navigation has been requested or committed for
    // QUIET_MS (src/landing.ts). The document landed on is then marked, and checked after measuring.
    let landing: Landing | undefined;
    const loaded = await within(gotoPolitely(opts.pace, url, navigate, {
      crawlGroup: `audit\n${url}`, deadline, ...(opts.signal ? { signal: opts.signal } : {}), ...(styles ? { styles } : {}),
      // A refusal with no body (the browser throws) is still the site refusing us, for the page limit.
      failedStatus: thrownStatus(nav),
      prepare: (resp) => time('settle', async () => {
        landing = undefined;
        if (!isHtml(resp)) return;
        landing = await settleLanding(p, w, {
          settle: async () => {
            const loadedAt = Date.now();
            await p.evaluate(scrollThrough, undefined);
            const remaining = SETTLE_MS - (Date.now() - loadedAt);
            if (remaining > 0) await p.waitForTimeout(remaining);
          },
          scanDeadline: deadline,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        loadedAddress = 'mark' in landing ? documentAddress(p) : undefined;
      }),
    }), deadline, opts.signal).finally(() => {
      if (!clock) return;
      clock.ms.load += Date.now() - loadStarted - (clock.ms.settle - settleBefore) - (clock.ms.styles - stylesBefore);
    });
    // The site kept asking us to slow down (for the page or its stylesheet), or the scan had no time
    // left to wait. A page that answered but whose stylesheet did not is not given a page status.
    if (loaded === 'cut') return failed(url, stopped() ?? LANDING_OUT_OF_TIME);
    if (loaded.refused) return failed(url, loaded.refused, isUnstyledReason(loaded.refused) ? undefined : loaded.status);
    const resp = loaded.value;
    if (!resp) return failed(url, 'No response from the server');
    // A page that kept replacing itself, or went to a document whose answer the browser never showed (an
    // error page): not the page. A refused address says so first (hosted use, navigationGate).
    const landed: Landing | undefined = landing;
    if (landed && 'stop' in landed) return failed(url, gateFailure(page) ?? landed.stop);
    if (landed?.response === null) return failed(url, gateFailure(page) ?? LANDING_UNCHECKED);
    mark = landed?.mark;
    const measured = landed?.response ?? resp;
    // The answer checked must be the marked document's own (its navigation entry's address and status, an
    // HTML document): one that cannot be tied to it may be another document's (src/landing.ts).
    const unbound = mark ? bindLanding(measured, mark.facts) : undefined;
    if (unbound) return failed(url, gateFailure(page) ?? unbound);
    // A page that went to another site (a sign-in elsewhere): that site's page, never this one's.
    if (isOtherSite(url, mark?.facts.navUrl ?? measured.url())) return failed(url, OTHER_SITE);
    // The answer of the document measured (the one the page landed on): a known WAF's challenge (Cloudflare,
    // AWS WAF) whatever its status, an HTTP error, a bot challenge (HTTP 202, docs/scoring.md v7) or a file
    // is never the page (src/landing.ts).
    const refusal = landingFailure(measured);
    if (refusal) return failed(url, refusal.reason, refusal.kind === 'not-html' ? undefined : refusal.status);
    // Hosted use: a document came from a refused server address, the gate was lost, or the page is
    // not an http(s) document (navigationGate): nothing measured on it would stand.
    const unchecked = gateFailure(page);
    if (unchecked) return failed(url, unchecked);
    // axe runs in the page and in every frame on it (see runAxe); frames from other sites come back
    // apart from the scored run (scoring v3).
    // Entrance animations (a call to action that fades in after a delay) settle first, at most
    // ANIMATION_SETTLE_MS: axe measuring colour contrast mid-fade gave one scan a failure and the next none.
    const settled = await time('settle', () => within(settleAnimations(p, ANIMATION_SETTLE_MS), deadline, opts.signal));
    if (settled === 'cut') return failed(url, stopped() ?? LANDING_OUT_OF_TIME);
    // A page still putting its content in as axe starts (an app that mounts late: `stillMounting`) is
    // watched from Node while axe runs; the first run is never delayed for it.
    const tracker = (await time('settle', () => within(mountingNow(p), deadline, opts.signal))) === true ? trackMount(p) : null;
    const rerun = () => time('axe', async () => {
      const result = await within(runAxe(p, opts.axeSource, undefined, { site: url }), deadline, opts.signal);
      if (result === 'cut') throw new Error(stopped() ?? LANDING_OUT_OF_TIME);
      return result;
    });
    let axed: AxeOutcome;
    try {
      axed = await rerun();
      const sameDocument = () => loadedAddress === undefined || documentAddress(p) === loadedAddress;
      // A contrast failure on content that is still fading in (its opacity, or an ancestor's, below 1
      // and rising: an animation the Web Animations API cannot see, run by a script): once it is at rest,
      // at most OPACITY_SETTLE_MS later, axe runs again and that run is the result (`laterAxe`).
      const fading = contrastTargets(axed.run);
      if (fading.length) {
        axed = (await laterAxe(axed, { ready: async () => (await time('settle', () => within(waitOpacityAtRest(p, fading, OPACITY_SETTLE_MS), deadline, opts.signal))) === 'rested', rerun, sameDocument })).outcome;
      }
      // The second look (fix/late-mount, review r2): once the page went from mounting to mounted (waited for
      // at most LATE_CONTENT_MS; never when the wait hit its cap or a look failed), axe runs again and that
      // run is the result for this width (`laterAxe`: the first run stands only when there is no later run).
      // Only this audit's own page waits: the tests run on pages of their own and are not held up.
      if (tracker) {
        axed = (await laterAxe(axed, {
          ready: async () => {
            const r = await time('settle', () => within(tracker.settle(LATE_CONTENT_MS), deadline, opts.signal));
            tracker.stop();
            return r !== 'cut' && r.mounted;
          },
          rerun, sameDocument,
        })).outcome;
      }
    } finally {
      tracker?.stop();
    }
    const { run, untestedFrames, thirdParty } = axed;

    const desktop = vp.name === 'desktop';
    const links = desktop ? await time('links', () => within(p.evaluate(collectLinks, undefined), deadline, opts.signal)) : [];
    if (links === 'cut') return failed(url, stopped() ?? LANDING_OUT_OF_TIME);
    const served = desktop && opts.document ? await servedDocument(p, measured, url) : undefined;
    // One at a time: collectors share the page and may scroll or measure it.
    const collected: Record<string, unknown> = {};
    // A CDP session on this page for collectors that ask the browser itself (the vision collector's accessible names).
    const browserCtx = ctx;
    const cdpFor = typeof browserCtx?.newCDPSession === 'function' ? () => cdpSession(browserCtx, p) : undefined;
    for (const c of opts.collectors ?? []) {
      if (!runsAt(c, vp.name)) continue;
      const t0 = Date.now();
      collected[c.id] = await time('collectors', () => runCollector(c, p, { url, viewport: vp.name, index: opts.index, ...(cdpFor ? { cdp: cdpFor } : {}) }));
      if (clock) clock.collectorMs[c.id] = (clock.collectorMs[c.id] ?? 0) + Date.now() - t0;
    }
    // The live scan screen's wireframe: after axe and the collectors, one time-boxed evaluate, never fatal.
    const wire = withWire ? await time('wireframe', () => captureWireframe(p, failingTargets(run.violations))) : undefined;
    // The live view's picture of the same moment: the first screen, scrolled to the top.
    // Only of the document that was loaded: a page that navigated itself since (a meta refresh onto an
    // error page, a script sending it to another site), before or while the shot is taken, gets none.
    const live = withWire ? opts.liveShots : undefined;
    const shown = page;
    const same = () => loadedAddress !== undefined && documentAddress(shown) === loadedAddress;
    let shot = live && same()
      ? await time('shot', () => captureLiveShot(p, c, vp.name, { ...(live.timeoutMs ? { timeoutMs: live.timeoutMs } : {}), ...(live.maxBytes ? { maxBytes: live.maxBytes } : {}) }))
      : null;
    if (shot && !same()) shot = null;
    // The document measured must still be the one marked as it landed, with no navigation in flight
    // (src/landing.ts): one that changed is never measured as the page. One that only answered too slowly did not
    // move: time (TOO_SLOW, or the scan's own deadline), never "went to another page by itself".
    const still = await checkMark(p, w, mark, deadline, opts.signal);
    if (still !== 'same') return failed(url, gateFailure(page) ?? stopped() ?? (still === 'unanswered' ? TOO_SLOW : MOVED_BY_ITSELF));
    // A frame from a refused address, or a gate lost, while axe, the collectors or the shot ran: the
    // page counts as not loaded, and its shot is dropped with it.
    // A stylesheet the page needs, refused while axe, the collectors or the shot ran (or still on its
    // way: it is waited for, briefly): this width is not the page either.
    const late = gateFailure(page) ?? (await time('late', () => refusedSince(watched, opts.pace, url)));
    if (late) return failed(url, late);
    if (stopped()) return failed(url, stopped()!);
    return { viewport: vp.name, run, untestedFrames, thirdParty, links, collected, ...(settled ? {} : { unsettled: true as const }), ...(wire ? { wire } : {}), ...(shot ? { shot } : {}), ...(served ? { served } : {}) };
  } catch (err) {
    if (stopped()) return failed(url, stopped()!);
    const message = err instanceof Error ? err.message.split('\n')[0]!.slice(0, 200) : 'Page failed to load';
    // Chromium turns a PDF or other file into a download instead of a page.
    if (/Download is starting/i.test(message)) return failed(url, 'Not an HTML page');
    // The navigation gate refused the page, a redirect of it, or the server address it came from; or
    // it was lost on the way (a hop may then stay paused until the load times out).
    if (page && documentGate(page)) {
      // A gate whose session closed fails what it still decides (ERR_BLOCKED_BY_CLIENT too): lost work, not a refusal.
      if (documentGate(page) === 'lost') return failed(url, GATE_LOST);
      if (/ERR_BLOCKED_BY_CLIENT/.test(message)) return failed(url, NOT_ALLOWED);
      const lost = gateStopsLoad(page);
      if (lost) return failed(url, lost);
    }
    // The site answered with an HTTP error the browser would not show (no body): its answer, as when
    // the browser hands the response back (staging 2026-11-04: HTTP 406 to one session's address).
    // The page went to another document while it was measured: never measured as the page.
    if (page && mark && isNavigationError(err) && !(await markedStill(page, watch, mark, deadline, opts.signal))) return failed(url, MOVED_BY_ITSELF);
    const answered = nav?.status();
    if (isResponseCodeFailure(message) && answered !== undefined && answered >= 400) return failed(url, `HTTP ${answered}`, answered);
    // Only then (the refusal signals come first): the browser or the page went away under the
    // audit. Lost work, done again (`scanSite`), whatever the error said (a load ends
    // net::ERR_ABORTED then), never the site's failure.
    if (page && !isBrowserGone(message) && (await pageGone(page))) return failed(url, `Target page, context or browser has been closed (${message})`);
    return failed(url, message);
  } finally {
    // A context the browser already lost cannot be closed: never a reason to stop the scan. Nor one whose
    // close never answers (a silent CDP connection): waited for at most CONTEXT_CLOSE_MS, so the page,
    // and the pace slot it holds, are released (review r1).
    const closing = ctx;
    await time('close', () => settlesWithin(closing.close(), CONTEXT_CLOSE_MS));
  }
}

type AxeOutcome = Awaited<ReturnType<typeof runAxe>>;

const isHtml = (resp: { headers(): Record<string, string> }) => {
  const type = resp.headers()['content-type'] ?? '';
  return !type || /html/i.test(type);
};

function failed(url: string, reason: string, httpStatus?: number): PageAudit {
  return { url, status: 'failed', reason, ...(httpStatus ? { httpStatus } : {}), rules: {}, violations: [], incomplete: [], links: [] };
}
