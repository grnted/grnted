// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 2.2.1 Timing Adjustable (Plan 4 Task 4.4): a time limit the page sets (a timer that sends the
// user to another page, reloads it, submits a form, or warns that the session or time is running out)
// needs a way to turn it off, adjust it or extend it. Engine core: no Node-only imports.
//
// Two probes:
// - `timing` (core): runs every pending timer of 1 s to 20 h early (the listener hook's
//   __grntedFire), with script navigations trapped, and looks at what each did: navigations and
//   reloads (cancelled, so the page stays), form submits, dialogs (dismissed by the guard) and new
//   content that warns about a time limit. Timers under 1 s and code that runs only after a network
//   response are seen by the deep probe.
// - `timing-watch` (deep): watches a fresh copy of the page for 20 s in real time (meta refresh,
//   countdowns built from short timers, string timers, anything else) with the same checks.
// A time limit with a control to extend it, turn it off or adjust it (in the warning, page-wide, or
// a confirm dialog asking whether to continue) gives no failure; without one it is failed. Timers of
// 20 h or more are exempt (WCAG's 20-hour exception). Meta refresh is also tested by axe
// (`meta-refresh`).
import { EXTEND_VOCAB, type Kit, type KitBox, type KitElement } from './kit.js';
import { MOTION_CONTEXT, hasTime, kitReady, requireHook } from './motionShared.js';
import { blockedReason } from './guard.js';
import { ProbeNotTestable, type GuardEvent, type PageProbe, type ProbeContext, type ProbeFinding } from './types.js';
import { registrableDomain } from '../domain.js';

/** Re-exported from its shared home (`src/domain.ts`; scoring v3 uses it too). */
export { registrableDomain };

/** WCAG's exception: time limits longer than 20 hours. */
export const TWENTY_HOURS_MS = 20 * 3_600_000;
/**
 * Phrases of a time-limit warning (in new content or a dialog's message). Phrases, not single words:
 * a news slide about a "board session" or a "refresh" of the website is not a warning. A sentence that
 * says session cookies or storage end when the browser closes (`COOKIE_CLOSE`) is not one either, unless
 * it also gives a time (`STATED_TIME`): see `isTimeWarning`.
 */
export const TIME_WORDS = [
  String.raw`\b(session|log-?in|sign-?in)\b.{0,40}\b(expir\w*|time ?out|timed out)\b`,
  String.raw`\b(you (will|'ll) be|you have been|you've been|automatically) (logged|signed) (out|off)\b`,
  String.raw`\b(redirect\w*|refresh\w*|reload\w*)\b.{0,30}\b(in|after) \d+\s*(s|secs?|seconds?|mins?|minutes?)\b`,
  String.raw`\b(in|after) \d+\s*(seconds?|minutes?)\b.{0,40}\b(redirect\w*|refresh\w*|reload\w*|log(ged)? (out|off)|sign(ed)? (out|off)|expir\w*)`,
  String.raw`\b(inactiv\w*|idle)\b.{0,60}\b(log(ged)?|sign(ed)?|expir\w*|session)\b`,
  String.raw`\b(still there|are you (still )?(there|here))\b`,
  String.raw`\b(session|time) (has )?(expired|timed out)\b`,
  // "Your session ends in 2 minutes" (batch 17: a warning in other words, missed, so its OK button was never looked at).
  String.raw`\b(session|log-?in|sign-?in)\b.{0,30}\b(ends?|will end|closes?|will close)\b.{0,20}\b(in|after) \d+\s*(seconds?|secs?|minutes?|mins?)\b`,
].join('|');
/**
 * Countdown words alone ("time remaining", "time left", "5 minutes left", "time is running out"): a countdown to
 * an event or a deadline says them too. A time-limit warning only when the text ties them to the visitor's own
 * input or session (`TIED_WORDS`), or (in the page) its box holds a form field (act-watch review r1, F7c).
 */
export const COUNTDOWN_WORDS = String.raw`\b(time (limit|is running out|remaining|left)|\d+ (seconds?|minutes?) (left|remaining))\b`;
export const TIED_WORDS = String.raw`\b(session|log(ged)?[\s-]?(in|out|off)|sign(ed)?[\s-]?(in|out|off)|your (work|answers?|form|entry|entries|changes|progress|application|draft|reservation|booking|cart|basket|order|seats?|tickets?)|inactiv\w*|idle|still there|more time|extend\w*|unsaved|save your|time limit)\b`;
/** A cookie notice's sentence: session cookies or storage that end when the visitor closes the browser. */
export const COOKIE_CLOSE = String.raw`\bsession[\s-]+(cookies?|storage|data)\b.{0,80}\b(expir\w*|ends?|(is|are|gets?) (deleted|removed|cleared|erased))\b.{0,40}\b(when|once|after|as soon as|until)\s+(you\s+)?(close|exit|quit|leave|end)\s+(the\s+|your\s+)?(browser|tab|window|browsing session)\b`;
/** A duration or time of day ("in two minutes", "at noon", "at 5 pm", "by 17:00"). */
export const STATED_TIME = String.raw`\b(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|sixty|few)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b|\b(at|by)\s+(noon|midnight|\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?|\d{1,2}\s*[ap]\.?m\.?)\b`;

/**
 * A statement that the visitor's session or time HAS ended (the page says so itself, at the moment it ends),
 * not a warning that it will: "Your session has expired", "You have been signed out", "Session timed out".
 * With such a statement the limit has been seen running out; a warning alone shows no such thing (batch 17).
 */
export const ENDED_WORDS = [
  String.raw`\byour (session|sign-?in|log-?in) (has |is |was )?(expired|timed out|ended|over)\b`,
  String.raw`\byour time (has |is )?(expired|run out|up|over)\b`,
  String.raw`\byou (have been|were|are|'ve been|are now) (automatically )?(logged|signed) (out|off)\b`,
  String.raw`\bsession (has )?(expired|timed out)\b`,
  String.raw`\b(logged|signed) (out|off) (due to|because of|after|for) (your )?inactivity\b`,
].join('|');

/**
 * Signs that a time limit may be one of 2.2.1's exceptions: the activity itself is against the clock, as part of
 * a real-time event people take part in (an auction, a live vote) or because timing is essential to it (an exam,
 * a quiz, a timed test, a typing-speed test). Read in the page's title and its first headings, and in the form
 * or warning the limit is about: what the page says it is. With one, a limit that would have failed is not
 * testable (the test cannot tell whether the exception holds); a sign never fails anything. Not a sign: "bids" or
 * "assessments" alone (a procurement list, a county assessor's page name no timed activity), a word in a
 * section heading or a menu (only the page's title, its main heading and the limit's own text say what the page
 * is), and "live" or
 * "real-time" said of what a page shows (live results, a real-time arrivals board): a page that reloads itself
 * to show them is the criterion's own failure (F41), whatever it is called.
 */
export const LIMIT_EXCEPTION = String.raw`\b(auctions?|bidding|exams?|examinations?|quiz(?:zes)?|(?:practice|timed|online|placement|typing|skills?|knowledge)\s+(?:tests?|assessments?)|timed\s+(?:quiz(?:zes)?|exams?|rounds?|activit(?:y|ies)|challenges?|exercises?|games?)|typing\s+speed|words\s+per\s+minute|time\s+trials?|live\s+(?:auctions?|bidding|votes?|voting|draws?))\b`;

/**
 * A setting that turns an automatic refresh or sign-out off, or sets how often it runs, by its label: a check
 * box, a switch, a toggle button, or a list or group of choices of durations ("Auto-refresh", "Refresh every",
 * "Pause updates", "Keep me signed in"). Looked for only, never changed (`limitSettings`).
 */
export const LIMIT_SETTING = String.raw`\bauto(?:matic(?:ally)?)?[\s-]*(?:refresh\w*|reload\w*|updat\w*|redirect\w*|advanc\w*|sign[\s-]*out|log[\s-]*out|logout)\b|\b(?:refresh|reload|update)(?:s|es)?\s+(?:this\s+page\s+)?(?:automatically|every|interval|rate|frequency)\b|\blive\s+updates?\b|\b(?:pause|stop|turn\s+off|disable)\s+(?:the\s+)?(?:live\s+|auto(?:matic)?[\s-]*)?(?:updates?|refresh\w*|reload\w*|redirect\w*)\b|\bkeep\s+me\s+(?:signed|logged)\s+in\b|\bstay\s+(?:signed|logged)\s+in\b|\b(?:time[\s-]*out|time[\s-]*limit|session\s+length)\b`;

/**
 * The text warns about a time limit (`TIME_WORDS`), leaving out sentences that only say session cookies
 * or storage end when the browser closes (`COOKIE_CLOSE` with no `STATED_TIME`). Kept in step with the
 * same rule inside `collect` (which runs in the page).
 */
export function isTimeWarning(text: string, field = false): boolean {
  const cookie = new RegExp(COOKIE_CLOSE, 'i');
  const stated = new RegExp(STATED_TIME, 'i');
  const kept = text.split(/;|(?<=[.!?])\s+/).filter((x) => !(cookie.test(x) && !stated.test(x))).join(' ');
  return new RegExp(TIME_WORDS, 'i').test(kept) || (new RegExp(COUNTDOWN_WORDS, 'i').test(kept) && (field || new RegExp(TIED_WORDS, 'i').test(kept)));
}

/** Timers the core probe runs early on one page, and rounds of timers started by timers it ran. */
export const TIMER_CAP = 60;
export const TIMER_ROUNDS = 3;
/** Passes after the first for timers started asynchronously (a promise, a response, a timer under 1 s). */
export const TIMER_PASSES = 8;
/** The wait for a pending timer under 1 s (MIN_TIMER_MS): longer than any of them; at most BRIDGE_WAITS in a chain. */
export const BRIDGE_WAIT_MS = 1100;
export const BRIDGE_WAITS = 3;
/** The one longer wait for a request still out (a response that then sets the time limit). */
export const SLOW_RESPONSE_MS = 3000;

/**
 * 2.2.1 controls that turn off or extend a time limit, named in more than the vocabulary's words
 * ("Turn off automatic sign-out", "Extend the time limit by 20 minutes"): a turn-off or extend verb
 * with a time-limit noun, in either order. "Disable" but not "disability"; "session" alone is not a
 * time-limit noun ("Disability support sessions"), only next to one ("session timeout"). Looked for
 * only (never clicked), on buttons only (kit `controls`, `phrase`).
 */
const LIMIT_VERB = String.raw`\b(?:turn(?:ing)?\s+(?:it\s+)?off|switch(?:ing)?\s+off|disabl(?:e|ed|es|ing)|stop|extend\w*|keep|stay|pause|prolong\w*|renew)\b`;
const LIMIT_NOUN = String.raw`\b(?:(?:auto(?:matic)?[\s-]*)?(?:sign|log)[\s-]*(?:out|off)|logout|signout|time[\s-]*(?:out|limits?)|timeouts?|timers?|countdown|auto(?:matic)?[\s-]*(?:refresh|reload|redirect)\w*)\b`;
export const LIMIT_CONTROL = `${LIMIT_VERB}.{0,60}${LIMIT_NOUN}|${LIMIT_NOUN}.{0,60}${LIMIT_VERB}`;

/** What a timer did when run (in the page). */
interface Fired { handle: number; kind: 'timeout' | 'interval'; delay: number; snippet: string; string: boolean }

/**
 * Runs in the page: turns navigation trapping on and runs each pending timer of `min`..`max` ms once.
 * A timer that a run timer started (a page that mounts its app from a timer, and the app then sets
 * its time limit) is run too: up to `rounds` rounds, each running the timers that the round before
 * started, within `cap` timers in all. `skip`: handles already run by an earlier call (`more`: that
 * call already started trapping and recording, so they go on).
 */
function fireAll(arg: { min: number; max: number; cap: number; rounds: number; more?: boolean; skip?: number[]; offer?: { words: readonly string[]; phrase: string; warn?: string; leave?: string } }): { fired: Fired[]; skipped: number; navStart: number; callStart: number; exempt: number[]; offered?: { name: string; delay: number }; warnButton?: boolean; unobserved?: boolean } {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  // How many fields a visitor fills the page shows before its timers run (Sol r1 S1): a page that says the session
  // has ended has ended the visitor's task only if it took fields away (`collect` counts them again).
  const w0 = window as unknown as { __grntedFieldsBefore?: number };
  if (w0.__grntedFieldsBefore === undefined) {
    let n = 0;
    for (const e of [...document.querySelectorAll('input, select, textarea')].slice(0, 400)) {
      const t = String((e as HTMLInputElement).type || '').toLowerCase();
      if (/^(hidden|submit|button|reset|image)$/.test(t) || (e as HTMLInputElement).disabled || (e as HTMLInputElement).readOnly) continue;
      if (e.getClientRects().length && !e.closest('[inert]')) n++;
    }
    w0.__grntedFieldsBefore = n;
  }
  if (!arg.more) {
    kit.trap(true);
    kit.observe();
    kit.take();
    // From here on, count timers under 1 s (the hook does not list them) and requests still out: what
    // a timer run early may still be waiting for before it sets the time limit (see pendingWork).
    const w = window as unknown as Record<string, unknown> & { __grntedWork?: () => { short: number; inflight: number } };
    if (!w.__grntedWork) {
      const short = new Set<unknown>();
      let inflight = 0;
      const st = window.setTimeout as unknown as (fn: unknown, delay?: number, ...rest: unknown[]) => number;
      const ct = window.clearTimeout;
      window.setTimeout = function (this: unknown, fn: TimerHandler, delay?: number, ...rest: unknown[]) {
        const d = Number(delay) || 0;
        if (typeof fn !== 'function' || d >= 1000) return st.apply(window, [fn, delay, ...rest]);
        let h: unknown;
        const once = function (this: unknown, ...a: unknown[]) { short.delete(h); return (fn as (...x: unknown[]) => unknown).apply(this, a); };
        h = st.apply(window, [once, delay, ...rest]);
        short.add(h);
        return h as number;
      } as typeof window.setTimeout;
      window.clearTimeout = function (h?: number) { short.delete(h); return ct.call(window, h); } as typeof window.clearTimeout;
      const f = window.fetch;
      if (typeof f === 'function') {
        window.fetch = function (this: unknown, ...a: Parameters<typeof fetch>) {
          inflight++;
          const p = f.apply(window, a);
          p.then(() => { inflight--; }, () => { inflight--; });
          return p;
        } as typeof fetch;
      }
      const send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...a: Parameters<XMLHttpRequest['send']>) {
        inflight++;
        this.addEventListener('loadend', () => { inflight--; }, { once: true });
        return send.apply(this, a);
      };
      Object.defineProperty(w, '__grntedWork', { value: () => ({ short: short.size, inflight: Math.max(0, inflight) }), configurable: true });
    }
  }
  const navStart = kit.navs.length;
  const callStart = kit.calls().length;
  const done = new Set<number>(arg.skip ?? []);
  const exempt = new Set<number>();
  const fired: Fired[] = [];
  let skipped = 0;
  let offered: { name: string; delay: number } | undefined;
  let checks = 0;
  /** At a timer boundary a warning about time with a button of any kind was on screen (Sol r1 S2). */
  let warnButton = false;
  /** Timers ran after the boundaries looked at (30): what they showed in between was not seen. */
  let unobserved = false;
  const warnRe = arg.offer?.warn ? new RegExp(arg.offer.warn, 'i') : null;
  const leaveRe = arg.offer?.leave ? new RegExp(arg.offer.leave, 'i') : null;
  for (let round = 0; round < arg.rounds; round++) {
    const all = kit.pending().filter((p) => !done.has(p.handle));
    for (const p of all) if (p.delay >= arg.max) exempt.add(p.handle);
    const due = all.filter((p) => p.delay >= arg.min && p.delay < arg.max);
    if (!due.length) break;
    const list = due.slice(0, Math.max(0, arg.cap - fired.length));
    skipped = due.length - list.length;
    for (const p of due) done.add(p.handle);
    for (const p of list) {
      kit.fire(p.handle);
      fired.push({ handle: p.handle, kind: p.kind, delay: p.delay, snippet: p.snippet, string: p.string });
      // All the timers run in one go here, so a warning's "Stay signed in" button may be gone again by the end
      // (the page puts "Your session has expired" in its place when the last timer runs). A control to extend or
      // turn off the limit that shows right after a timer ran is kept: the page did offer it (batch 17). Looked
      // at only, after at most 30 timers.
      if (arg.offer && checks < 30) {
        checks++;
        try {
          const c = offered ? null : kit.controls(null, arg.offer.words, 1, { lookOnly: true, maxWords: 4, phrase: arg.offer.phrase })[0];
          if (c) offered = { name: (kit.name(c) || c.localName).slice(0, 60), delay: p.delay };
          // A warning box on screen with a button the test does not know may be the way to extend: kept, as it may
          // be gone by the end (the page puts its "expired" text in its place).
          if (warnRe && !warnButton) {
            for (const b of [...document.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"], [role="alert"], [role="status"], [aria-live]')].slice(0, 40)) {
              // A button that only leaves or signs out is no way to extend.
              const buttons = [...b.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')].filter((x) => !leaveRe || !leaveRe.test(String((x as HTMLElement).innerText || (x as HTMLInputElement).value || x.getAttribute('aria-label') || '')));
              if (!b.getClientRects().length || !buttons.length) continue;
              if (warnRe.test(String((b as HTMLElement).innerText ?? b.textContent ?? '').replace(/\s+/g, ' ').slice(0, 600))) { warnButton = true; break; }
            }
          }
        } catch { /* the end state is still looked at */ }
      } else if (arg.offer) unobserved = true;
    }
    if (skipped) break;
  }
  return { fired, skipped, navStart, callStart, exempt: [...exempt], ...(offered ? { offered } : {}), ...(warnButton ? { warnButton } : {}), ...(unobserved ? { unobserved } : {}) };
}

/** Runs in the page: timers under 1 s and requests still out since the timers were first run. */
function pendingWork(): { short: number; inflight: number } {
  const f = (window as unknown as { __grntedWork?: () => { short: number; inflight: number } }).__grntedWork;
  return typeof f === 'function' ? f() : { short: 0, inflight: 0 };
}

/** Runs in the page: work still pending: short timers and requests since the timers were first run, and timers of `min`..`max` not run. */
function leftOver(arg: { skip: number[]; min: number; max: number }): { short: number; inflight: number; due: number } {
  const w = window as unknown as { __grntedWork?: () => { short: number; inflight: number }; __grntedKit?: Kit };
  const work = typeof w.__grntedWork === 'function' ? w.__grntedWork() : { short: 0, inflight: 0 };
  const done = new Set(arg.skip);
  const due = (w.__grntedKit?.pending() ?? []).filter((p) => !done.has(p.handle) && p.delay >= arg.min && p.delay < arg.max).length;
  return { short: work.short, inflight: work.inflight, due };
}

/** Runs in the page: starts watching (trap navigations, record mutations, mark the document). */
function startWatch(): { navStart: number; callStart: number } {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  kit.trap(true);
  kit.observe();
  kit.take();
  (window as unknown as { __grntedWatch?: boolean }).__grntedWatch = true;
  return { navStart: kit.navs.length, callStart: kit.calls().length };
}

/** A warning about a time limit that appeared in the page; `ended`: it says the session or time has run out (`ENDED_WORDS`). */
interface Warning { el: KitElement; box: KitBox; text: string; ended?: boolean }

interface Collected {
  navs: { type: string; url: string; handle?: number }[];
  /**
   * `form` (a submit): how many fields a visitor fills the form shows, whether it would have been sent (the page's
   * own handler did not stop it), whether sending it would replace this page (not a frame or a new window), and its
   * words; absent when the hook could not say (an older record).
   */
  calls: { api: string; timer?: number; form?: { fields: number; sent: boolean; page: boolean; text?: string } }[];
  warnings: Warning[];
  /** A visible fixed layer (5% of the viewport or more) appeared or changed: a modal, banner or popup. */
  overlay: boolean;
  /** Fields a visitor fills were taken away (removed, hidden, disabled or made read-only) since the timers first ran. */
  lostFields?: boolean;
}

/** Runs in the page: what happened since `fireAll`/`startWatch` (and turns trapping off). */
function collect(arg: { navStart: number; callStart: number; words: string; countdown: string; tied: string; cookie: string; stated: string; ended?: string; keepTrap?: boolean }): Collected {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const re = new RegExp(arg.words, 'i');
  const endedRe = arg.ended ? new RegExp(arg.ended, 'i') : null;
  // A slide of a carousel, a ticker's line or a rotating notice is content that takes turns, whatever its words
  // ("Summer session registration expires Friday"): never a warning to the visitor (batch 17).
  const ROTATING = '[aria-roledescription="carousel" i], [aria-roledescription="slide" i], [role="marquee"], marquee, [class*="carousel" i], [class*="slider" i], [class*="slideshow" i], [class*="ticker" i], [class*="marquee" i], [class*="rotat" i], [class*="swiper" i], [class*="slick" i], [class*="splide" i]';
  // The element or one of its five nearest ancestors below the body (a page-wide class such as "has-slider" on the
  // body says nothing about the warning in it).
  const rotating = (e: Element | null): boolean => {
    for (let a = e, i = 0; a && a !== document.body && a !== document.documentElement && i < 6; a = a.parentElement, i++) if (a.matches(ROTATING)) return true;
    return false;
  };
  const countdown = new RegExp(arg.countdown, 'i');
  const tied = new RegExp(arg.tied, 'i');
  const cookie = new RegExp(arg.cookie, 'i');
  const stated = new RegExp(arg.stated, 'i');
  // As `isTimeWarning`: a sentence that only says session cookies end when the browser closes is left out, and
  // countdown words alone count only when tied to the visitor's input or session (or a field in the box).
  const warns = (text: string, field: boolean) => {
    const kept = text.split(/;|(?<=[.!?])\s+/).filter((x) => !(cookie.test(x) && !stated.test(x))).join(' ');
    return re.test(kept) || (countdown.test(kept) && (field || tied.test(kept)));
  };
  const records = kit.take().flatMap((b) => b.records);
  if (!arg.keepTrap) kit.trap(false);
  const here = location.href.split('#')[0];
  const navs = kit.navs.slice(arg.navStart)
    .filter((n) => !n.sameDocument && !(n.type !== 'reload' && n.url.split('#')[0] === here && n.url.includes('#')))
    .map((n) => ({ type: n.type, url: n.url.slice(0, 300), ...(n.handle !== undefined ? { handle: n.handle } : {}) }));
  const calls = kit.calls().slice(arg.callStart).map((c) => {
    const form = (c as { form?: { fields?: unknown; sent?: unknown; page?: unknown; text?: unknown } }).form;
    return {
      api: c.api, ...(c.timer !== undefined ? { timer: c.timer } : {}),
      ...(form && typeof form.fields === 'number' ? { form: { fields: form.fields, sent: form.sent !== false, page: form.page !== false, ...(typeof form.text === 'string' ? { text: form.text.slice(0, 600) } : {}) } } : {}),
    };
  });
  /** The element, or its nearest ancestor with a box (an element with `display: contents` has none). */
  const boxed = (el: Element | null): Element | null => {
    let e = el;
    for (let i = 0; e && i < 50 && getComputedStyle(e).display === 'contents'; i++) e = e.parentElement;
    return e;
  };
  const changed = [...new Set(kit.changed(records).map(boxed).filter((e): e is Element => !!e && kit.visible(e, true)))];
  const vp = innerWidth * innerHeight;
  let overlay = false;
  const warnings: Warning[] = [];
  const seen = new Set<Element>();
  // Whether a text node's words are on screen, by its parent (judged on the nearest ancestor with a box).
  // Opacity 0 hides them, unless the text is announced (a live region, an alert or a status) or being
  // revealed (a running animation or transition on it or an ancestor): such a warning still counts.
  const shownBy = new Map<Element, boolean>();
  const revealing = (from: Element): boolean => {
    for (let a: Element | null = from; a; a = a.parentElement) {
      if (a.getAnimations?.().some((x) => x.playState === 'running')) return true;
    }
    return false;
  };
  const textShown = (el: Element): boolean => {
    let ok = shownBy.get(el);
    if (ok !== undefined) return ok;
    ok = false;
    const b = boxed(el);
    if (b && getComputedStyle(el).visibility === 'visible') {
      const check = (opacity: boolean) => {
        const f = (b as Element & { checkVisibility?: (o: Record<string, boolean>) => boolean }).checkVisibility;
        return typeof f === 'function' ? f.call(b, { opacityProperty: opacity, visibilityProperty: true, contentVisibilityAuto: true }) : kit.visible(b, !opacity);
      };
      const live = el.closest('[aria-live]:not([aria-live="off"]), [role="alert"], [role="status"]');
      const exposed = live && !el.closest('[aria-hidden="true"], [inert], [hidden]');
      if (check(false)) ok = check(true) || !!exposed || revealing(b);
    }
    shownBy.set(el, ok);
    return ok;
  };
  // The rendered words a user can see in a container, with inline boundaries kept ("ex<b>pire</b>" is
  // one word) and a space at each block boundary, as innerText has them. Bounded.
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
  const seenText = (root: Element): string => {
    const out: string[] = [];
    let n = 0;
    const walk = (el: Element): void => {
      for (const c of Array.from(el.childNodes)) {
        if (++n > 5000) return;
        if (c.nodeType === 3) {
          if (c.nodeValue && textShown(el)) out.push(c.nodeValue);
          continue;
        }
        if (c.nodeType !== 1) continue;
        const e = c as Element;
        if (SKIP_TAGS.has(e.tagName)) continue;
        if (e.localName === 'br') { out.push(' '); continue; }
        const display = getComputedStyle(e).display;
        if (display === 'none') continue;
        const block = !/^(inline|contents|ruby)/.test(display);
        if (block) out.push(' ');
        walk(e);
        if (block) out.push(' ');
      }
    };
    walk(root);
    return out.join('').replace(/\s+/g, ' ').trim();
  };
  for (const el of changed) {
    // The warning's container: climb while the text alone does not show the whole message.
    let box: Element = el;
    for (let i = 0; i < 4 && box.parentElement && box.parentElement !== document.body && kit.area(box) < 20_000; i++) box = box.parentElement;
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      // A fixed layer of some size is a modal, banner or popup (carousel slides are absolute, not fixed).
      if (getComputedStyle(e).position === 'fixed' && kit.area(e) >= vp * 0.05) { overlay = true; box = e; break; }
    }
    if (seen.has(box) || [...seen].some((s) => s.contains(box))) continue;
    const text = ((box as HTMLElement).innerText ?? box.textContent ?? '').replace(/\s+/g, ' ').trim();
    // The warning's words must be ones a user sees (or hears announced): a transparent "Your session
    // has expired" that nothing reveals or announces was never shown.
    const field = !!(box.querySelector('input:not([type="hidden"]), textarea, select') || box.closest('form'));
    if (!text || !warns(text, field) || !warns(seenText(box), field)) continue;
    if (rotating(box) || rotating(el)) continue;
    seen.add(box);
    if (warnings.length < 3) warnings.push({ el: kit.describe(box), box: kit.box(box), text: text.slice(0, 160), ...(endedRe && endedRe.test(text) ? { ended: true } : {}) });
  }
  const before = (window as unknown as { __grntedFieldsBefore?: number }).__grntedFieldsBefore;
  let fieldsNow = 0;
  for (const e of [...document.querySelectorAll('input, select, textarea')].slice(0, 400)) {
    const t = String((e as HTMLInputElement).type || '').toLowerCase();
    if (/^(hidden|submit|button|reset|image)$/.test(t) || (e as HTMLInputElement).disabled || (e as HTMLInputElement).readOnly) continue;
    if (e.getClientRects().length && !e.closest('[inert]')) fieldsNow++;
  }
  return { navs, calls, warnings, overlay, ...(typeof before === 'number' && fieldsNow < before ? { lostFields: true } : {}) };
}

/** Runs in the page: controls that extend, adjust or turn off a time limit (looked for, never clicked). */
function limitControls(arg: { warnings: number[]; words: readonly string[]; max: number; phrase: string }): string[] {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const out: string[] = [];
  const opts = { lookOnly: true, maxWords: 4, phrase: arg.phrase };
  for (const id of arg.warnings) {
    const w = kit.get(id);
    if (!w || !w.isConnected) continue;
    for (const c of kit.controls(w, arg.words, arg.max, { ...opts, nearOnly: true })) if (w.contains(c)) out.push(kit.name(c) || c.localName);
  }
  for (const c of kit.controls(null, arg.words, arg.max, opts)) out.push(kit.name(c) || c.localName);
  return [...new Set(out)].slice(0, arg.max);
}

/**
 * Runs in the page: the buttons in a warning's own box (or the dialog or fixed layer it sits in) that the test does
 * not know: not a control to extend (those are found by `limitControls`), and not one that only leaves or signs
 * out or in (`leave`). Looked at, never pressed: what "OK", "Cancel", "Stay connected" or "Resume" does in a
 * warning about a time limit is not known until someone presses it.
 */
function warningButtons(arg: { warnings: number[]; leave: string; words: string; max: number }): string[] {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const leave = new RegExp(arg.leave, 'i');
  const words = new RegExp(arg.words, 'i');
  const textOf = (e: Element) => String((e as HTMLElement).innerText ?? e.textContent ?? '').replace(/\s+/g, ' ');
  const out: string[] = [];
  for (const id of arg.warnings) {
    const w = kit.get(id);
    if (!w || !w.isConnected) continue;
    // The smallest element that holds the warning's words (the box found may be a whole section).
    let core: Element = w;
    for (let i = 0; i < 12; i++) {
      const inner = [...core.children].filter((c) => words.test(textOf(c)));
      if (inner.length !== 1) break;
      core = inner[0]!;
    }
    // Its own box: the dialog, alert or status it is in, a fixed layer (a banner, a toast, a modal), or a small
    // parent that holds little more than the message and its buttons.
    let box: Element | null = core.closest('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="alert"], [role="status"]');
    for (let e: Element | null = core; !box && e && e !== document.body; e = e.parentElement) {
      if (getComputedStyle(e).position === 'fixed') box = e;
    }
    if (!box) box = core.parentElement && core.parentElement !== document.body && textOf(core.parentElement).length <= 400 ? core.parentElement : core;
    const all = box.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]');
    for (let k = 0; k < all.length && k < 40 && out.length < arg.max; k++) {
      const el = all[k]!;
      if ((el as HTMLButtonElement).disabled || el.closest('[aria-disabled="true"], [inert]') || !kit.visible(el, true)) continue;
      const name = (kit.name(el) || (el as HTMLInputElement).value || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!name || leave.test(name)) continue;
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** A warning's button that only leaves, or signs the visitor out or in again: no way to extend the limit. */
export const LEAVE_BUTTON = String.raw`\b(?:log|sign)[\s-]*(?:out|off|in)\b|\blog(?:out|in)\b|\bsign(?:out|in)\b|\b(?:exit|leave|quit)\b|\bend\s+(?:my\s+|the\s+|this\s+)?session\b|\bstart\s+(?:over|again)\b`;

/**
 * Runs in the page (self-contained): settings that turn an automatic refresh or sign-out off or set how often it
 * runs (`LIMIT_SETTING`), which the button search above does not look at: check boxes, switches, toggle buttons
 * (aria-pressed), and lists or radio groups of durations. Looked for only, never changed. `kind`: 'off' a
 * switch (or a list with an "Off" or "Never" choice), 'adjust' a choice of durations with none of those (`max`:
 * the longest, ms).
 */
function limitSettings(arg: { setting: string }): { name: string; kind: 'off' | 'adjust'; max?: number }[] {
  const setting = new RegExp(arg.setting, 'i');
  const clean = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const shown = (el: Element): boolean => {
    const e = el as Element & { checkVisibility?: (o: Record<string, boolean>) => boolean };
    const seen = (x: Element) => (typeof (x as typeof e).checkVisibility !== 'function' || (x as typeof e).checkVisibility!({ visibilityProperty: true })) && x.getClientRects().length > 0;
    // A check box drawn by its label (the input itself hidden) is still a setting a visitor can change.
    const label = (el as HTMLInputElement).labels?.[0];
    return seen(el) || (!!label && seen(label));
  };
  const labelOf = (el: Element): string => {
    const lab = (el as HTMLInputElement).labels?.[0];
    let own = '';
    if (lab) {
      const copy = lab.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('select, input, textarea, button').forEach((c) => c.remove());
      own = copy.textContent ?? '';
    }
    const by = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    const group = el.closest('fieldset')?.querySelector('legend')?.textContent ?? el.closest('[role="radiogroup"], [role="group"]')?.getAttribute('aria-label') ?? '';
    return clean([el.getAttribute('aria-label'), by, own, el.localName === 'button' || el.getAttribute('role') === 'switch' || el.getAttribute('role') === 'checkbox' ? (el as HTMLElement).innerText : '', group].filter(Boolean).join(' '));
  };
  const ms = (text: string): number | null => {
    const m = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(text);
    if (!m) return null;
    const u = m[2]!.toLowerCase();
    return Number(m[1]) * (u.startsWith('h') ? 3_600_000 : u.startsWith('m') ? 60_000 : 1000);
  };
  const NONE = /\b(off|never|none|no (auto(matic)?[\s-]*)?(refresh|reload|update|limit|time ?out)|don[’']?t (refresh|reload|update)|manual(ly)?|paused?)\b/i;
  const out: { name: string; kind: 'off' | 'adjust'; max?: number }[] = [];
  const add = (name: string, kind: 'off' | 'adjust', max?: number) => { if (out.length < 4 && !out.some((o) => o.name === name)) out.push({ name, kind, ...(max !== undefined ? { max } : {}) }); };
  const toggles = document.querySelectorAll('input[type="checkbox"], [role="switch"], [role="checkbox"], button[aria-pressed]');
  for (let k = 0; k < toggles.length && k < 600; k++) {
    const el = toggles[k]!;
    if ((el as HTMLInputElement).disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[inert], [aria-hidden="true"]') || !shown(el)) continue;
    const name = labelOf(el);
    if (name && name.split(' ').length <= 12 && setting.test(name)) add(name, 'off');
  }
  const selects = document.querySelectorAll('select');
  for (let k = 0; k < selects.length && k < 200; k++) {
    const el = selects[k] as HTMLSelectElement;
    if (el.disabled || el.closest('[inert], [aria-hidden="true"]') || !shown(el)) continue;
    const name = labelOf(el);
    if (!name || !setting.test(name)) continue;
    const texts = [...el.options].slice(0, 40).map((o) => clean(o.text));
    const times = texts.map(ms).filter((x): x is number => x !== null);
    if (texts.some((t) => NONE.test(t) && ms(t) === null)) add(name, 'off');
    else if (times.length >= 2) add(name, 'adjust', Math.max(...times));
  }
  const groups = new Map<string, HTMLInputElement[]>();
  const radios = document.querySelectorAll('input[type="radio"]');
  for (let k = 0; k < radios.length && k < 600; k++) {
    const r = radios[k] as HTMLInputElement;
    if (r.name && !r.disabled && shown(r)) groups.set(r.name, [...(groups.get(r.name) ?? []), r]);
  }
  for (const list of groups.values()) {
    const name = clean(list[0]!.closest('fieldset')?.querySelector('legend')?.textContent || list[0]!.closest('[role="radiogroup"]')?.getAttribute('aria-label'));
    if (!name || !setting.test(name)) continue;
    const texts = list.map((r) => clean(r.labels?.[0]?.innerText || r.getAttribute('aria-label') || r.value));
    const times = texts.map(ms).filter((x): x is number => x !== null);
    if (texts.some((t) => NONE.test(t) && ms(t) === null)) add(name, 'off');
    else if (times.length >= 2) add(name, 'adjust', Math.max(...times));
  }
  return out;
}

/**
 * Runs in the page (self-contained): the first sign (`words`) that a time limit on this page may be real-time or
 * essential, read in the page's title, its first headings (h1 to h3, 20 at most) and the texts given (the form a
 * timer sent, a warning's box); '' when there is none.
 */
function limitSigns(arg: { words: string; texts: string[] }): string {
  const re = new RegExp(arg.words, 'i');
  // What the page says it is: its title and its main headings (not a section heading or a menu), and the limit's own text.
  const texts: string[] = [document.title];
  const hs = document.querySelectorAll('h1, [role="heading"][aria-level="1"]');
  for (let k = 0; k < hs.length && k < 3; k++) texts.push((hs[k] as HTMLElement).innerText ?? hs[k]!.textContent ?? '');
  texts.push(...arg.texts);
  for (const t of texts) {
    const m = re.exec(String(t ?? '').replace(/\s+/g, ' '));
    if (m) return m[0].slice(0, 60);
  }
  return '';
}

/**
 * Runs in the page: what timers already run early on this page did (timing runs after the other
 * motion probes, and motion runs timers of up to 20 s): their navigations (trapped), form submits,
 * and the delay of each timer by handle. Empty when timing got the page loaded again
 * (`freshAfterFiredTimers`); a page probe used without the runner (or another caller) still gets them.
 */
function earlierRuns(): { navs: { type: string; url: string; handle: number }[]; submits: number; fired: { handle: number; delay: number }[] } {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const navs = kit.navs.filter((n) => n.handle !== undefined && !n.sameDocument).map((n) => ({ type: n.type, url: n.url.slice(0, 300), handle: n.handle! }));
  const submits = kit.calls().filter((c) => c.timer !== undefined && (c.api === 'submit' || c.api === 'requestSubmit')).length;
  return { navs, submits, fired: kit.fired.slice() };
}



const secs = (ms: number) => (ms < 120_000 ? `${Math.round(ms / 100) / 10} s` : ms < 7_200_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 360_000) / 10} h`);
const quote = (s: string, n = 80) => `"${s.length > n ? `${s.slice(0, n - 1)}…` : s}"`;

/**
 * One time limit the page set, in words. `kind`: 'left' the page was seen doing something to the visitor when
 * the time came (it went to another address, reloaded, sent the form they fill in); 'ended' the page itself said
 * the session or time has run out (`ENDED_WORDS`); 'warned' it only warned that a limit will run out, and
 * nothing was seen happening (batch 17: a warning alone demonstrates no limit on what the visitor is doing);
 * 'sent' it sent the form the visitor fills in into a frame or another window, with the page left as it is (a
 * draft saved in the background does that, and so does a timed form whose time is up: not told apart here).
 */
interface Limit { what: string; target?: string; kind: 'left' | 'ended' | 'warned' | 'sent'; delay?: number; text?: string }

/**
 * The verdict for 2.2.1 from what the timers (or the watch) did: no time limit → no failures found;
 * a time limit with a control → no failures found; without one → failed. A request the guard
 * stopped on the page's own site leaves the result open (not_testable), since what came after it
 * (a logout and a redirect, say) could not happen.
 */
async function verdict(ctx: ProbeContext, got: Collected, dialogs: GuardEvent[], blocked: GuardEvent[], opts: { delayOf: (handle?: number) => number | undefined; checked: string; when: string; offered?: { name: string; delay: number }; warnButton?: boolean; unobserved?: boolean }): Promise<ProbeFinding[]> {
  const limits: Limit[] = [];
  const after = (handle?: number) => {
    const d = opts.delayOf(handle);
    return d === undefined ? opts.when : `after ${secs(d)}`;
  };
  const ended = new RegExp(ENDED_WORDS, 'i');
  for (const n of got.navs.slice(0, 3)) {
    const delay = opts.delayOf(n.handle);
    limits.push({ kind: 'left', ...(delay !== undefined ? { delay } : {}), what: n.type === 'reload' ? `the page reloads itself ${after(n.handle)}` : `the page sends the user to ${n.url} ${after(n.handle)}` });
  }
  // A form a timer sends: when the page's own handler stopped it, nothing was sent (the page saves or checks by
  // itself); sent into this window, the page is replaced (the visitor is taken away, whatever the form holds);
  // sent into a frame or another window, a form with fields the visitor fills in is a doubt ('sent'), and one
  // with none (a keep-alive, a tracking post) takes nothing from what they are doing. (A record without these
  // facts is judged as before.)
  const submits = got.calls.filter((c) => c.api === 'submit' || c.api === 'requestSubmit');
  // A submit whose facts were not kept (where it went, whether the page stopped it) proves nothing (Sol r1 S3).
  const unread = submits.find((c) => !c.form);
  const away = submits.find((c) => c.form && c.form.sent && c.form.page);
  if (away) limits.push({ kind: 'left', what: `the page submits a form by itself ${opts.when}`, ...(away.form?.text ? { text: away.form.text } : {}) });
  const aside = away ? undefined : submits.find((c) => c.form && c.form.sent && !c.form.page && c.form.fields > 0);
  if (aside) limits.push({ kind: 'sent', what: `the page submits a form by itself ${opts.when}, into a frame or another window`, ...(aside.form?.text ? { text: aside.form.text } : {}) });
  else if (!away && unread) limits.push({ kind: 'sent', what: `the page submits a form by itself ${opts.when} (where to, and whether the page let it go, could not be read)` });
  const timeDialogs = dialogs.filter((d) => d.dialog !== 'beforeunload' && isTimeWarning(d.message ?? ''));
  const dialogName = (d?: string) => (d === 'alert' ? 'an alert' : d === 'confirm' ? 'a confirm dialog' : d === 'prompt' ? 'a prompt' : 'a dialog');
  // Words that the time has run out show it only when the page also took the visitor's fields away (Sol r1 S1): help
  // text that quotes them ("if your session has expired, reopen the page") leaves the task as it was.
  const endedNow = (text: string) => ended.test(text) && !!got.lostFields;
  for (const d of timeDialogs.slice(0, 2)) limits.push({ kind: endedNow(d.message ?? '') ? 'ended' : 'warned', what: `${dialogName(d.dialog)} says ${quote(d.message ?? '')} ${opts.when}`, text: d.message ?? '' });
  for (const w of got.warnings) limits.push({ kind: w.ended && got.lostFields ? 'ended' : 'warned', what: `a warning appears ${opts.when}: ${quote(w.text)}`, target: w.el.path, text: w.text });

  // A request to the page's own site the guard stopped, or a popup it closed, means what the page
  // meant to do next could not happen: no clean result (a third-party beacon does not count).
  const site = registrableDomain(ctx.url);
  const own = blocked.find((b) => b.kind === 'popup' || !b.url || registrableDomain(b.url) === site);
  const open = own ? (own.kind === 'popup' ? `the test would have opened a new window${own.url ? ` (${own.url})` : ''}, so it was closed` : blockedReason(own)) : null;
  if (!limits.length) {
    if (open) throw new ProbeNotTestable(`${open}; what the page does after its timers run could not be seen`);
    return [{ criterion: '2.2.1', status: 'no_failures_found', detail: `no time limit found: nothing navigated, reloaded, submitted a form or warned about time running out (${opts.checked})` }];
  }
  // A confirm or prompt about the limit asks the user whether to continue: that is the extension.
  const asked = timeDialogs.find((d) => d.dialog === 'confirm' || d.dialog === 'prompt');
  const controls = await ctx.page.evaluate(limitControls, {
    warnings: got.warnings.map((w) => w.el.id), words: EXTEND_VOCAB, max: 4, phrase: LIMIT_CONTROL,
  }).catch(() => [] as string[]);
  const target = limits.find((l) => l.target)?.target;
  const all = limits.map((l) => l.what).join('; ');
  const at = target ? { target } : {};
  if (asked || controls.length) {
    const how = asked ? `${dialogName(asked.dialog)} asks whether to continue` : `the page offers ${controls.map((c) => quote(c, 40)).join(', ')}`;
    if (open) return [{ criterion: '2.2.1', status: 'not_testable', ...at, detail: `time limit found (${all}); ${how}, but ${open}` }];
    return [{ criterion: '2.2.1', status: 'no_failures_found', ...at, detail: `time limit found (${all}); ${how}` }];
  }
  // A control to extend or turn off the limit showed right after one of the timers ran and is gone at the end (the
  // page has put its "expired" message in the warning's place): the page did offer it.
  if (opts.offered) {
    const how = `when its timer of ${secs(opts.offered.delay)} ran the page offered ${quote(opts.offered.name, 40)}`;
    if (open) return [{ criterion: '2.2.1', status: 'not_testable', ...at, detail: `time limit found (${all}); ${how}, but ${open}` }];
    return [{ criterion: '2.2.1', status: 'no_failures_found', ...at, detail: `time limit found (${all}); ${how}` }];
  }
  // A setting that turns the refresh or sign-out off, or sets how often it runs (a check box, a switch, a list of
  // durations): looked for, never changed. One that turns it off is the criterion's "turn off"; a choice of
  // durations is its "adjust" when it reaches ten times the limit seen, and otherwise leaves the result open.
  const settings = await ctx.page.evaluate(limitSettings, { setting: LIMIT_SETTING }).catch(() => [] as { name: string; kind: 'off' | 'adjust'; max?: number }[]);
  const off = settings.find((x) => x.kind === 'off');
  if (off) {
    if (open) return [{ criterion: '2.2.1', status: 'not_testable', ...at, detail: `time limit found (${all}); the page has a setting for it (${quote(off.name, 40)}), but ${open}` }];
    return [{ criterion: '2.2.1', status: 'no_failures_found', ...at, detail: `time limit found (${all}); the page has a setting that turns it off (${quote(off.name, 40)})` }];
  }
  const adjust = settings.find((x) => x.kind === 'adjust');
  if (adjust) {
    const delay = Math.max(0, ...limits.map((l) => l.delay ?? 0));
    if (!open && delay > 0 && (adjust.max ?? 0) >= delay * 10) return [{ criterion: '2.2.1', status: 'no_failures_found', ...at, detail: `time limit found (${all}); the visitor can set it up to ${secs(adjust.max!)} (${quote(adjust.name, 40)}), at least ten times the limit` }];
    return [{ criterion: '2.2.1', status: 'not_testable', ...at, detail: `time limit found (${all}); the page has a choice of durations for it (${quote(adjust.name, 40)}), and whether that reaches ten times the limit could not be told` }];
  }
  // Only a warning that a limit will run out, and nothing was seen happening when the timers ran: no limit on what
  // the visitor is doing was demonstrated (the session may be extended by using the page, or by the warning's own
  // OK button; the text may be about something else). The same for a form sent into a frame with the page left as
  // it is: a draft saved in the background, or the end of the time to fill it in. Not testable, never failed.
  const shown = limits.filter((l) => l.kind === 'left' || l.kind === 'ended');
  if (!shown.length) {
    const why = limits.some((l) => l.kind === 'sent')
      ? 'the page stayed as it was, so this may be a draft saved in the background or the end of the time to fill the form in, and the test cannot tell which'
      : 'the test saw the warning only, not the limit running out (nothing navigated, reloaded, sent a form or said the time had run out), and found no control to extend it: whether there is a limit the visitor cannot extend could not be told';
    return [{ criterion: '2.2.1', status: 'not_testable', ...at, detail: `${all}; ${why}` }];
  }
  // A warning that the limit will run out has a button the test does not know ("OK", "Cancel", "Stay connected"):
  // it may be the way to extend, and the test presses nothing here. Not when the page says the time has run out.
  const warnedIds = got.warnings.filter((w) => !w.ended).map((w) => w.el.id);
  if (warnedIds.length) {
    const unknown = await ctx.page.evaluate(warningButtons, { warnings: warnedIds, leave: LEAVE_BUTTON, words: `${TIME_WORDS}|${COUNTDOWN_WORDS}`, max: 3 }).catch(() => [] as string[]);
    if (unknown.length) {
      return [{ criterion: '2.2.1', status: 'not_testable', ...at, detail: `${all}. The warning has ${unknown.length === 1 ? 'a button' : 'buttons'} (${unknown.map((u) => quote(u, 30)).join(', ')}) that the test does not press: whether ${unknown.length === 1 ? 'it extends' : 'one of them extends'} the time limit could not be told` }];
    }
  }
  // A warning with a button was on screen when one of the timers ran, or timers ran after the moments looked at (Sol
  // r1 S2): a way to extend may have been offered and taken away again by the end. No failure on what is left.
  if (opts.warnButton || opts.unobserved) {
    const why = opts.warnButton ? 'when the timers ran, a warning about the time showed a button that the test does not press, and it is gone now' : 'the page ran more timers than the test looks between, so a way to extend it shown in between may not have been seen';
    return [{ criterion: '2.2.1', status: 'not_testable', ...at, detail: `${all}; ${why}: whether the visitor could extend the time limit could not be told` }];
  }
  // 2.2.1's exceptions: a limit that is part of a real-time event, or essential to the activity, is allowed. The
  // page says it may be one (its title, its headings, the form or warning itself): no failure.
  const sign = await ctx.page.evaluate(limitSigns, { words: LIMIT_EXCEPTION, texts: limits.map((l) => l.text ?? '').filter(Boolean) }).catch(() => '');
  if (sign) {
    return [{ criterion: '2.2.1', status: 'not_testable', ...at, detail: `${all}, and nothing turns this time limit off, adjusts it or extends it. But the page says ${quote(sign, 40)}: a time limit that is part of a real-time event or essential to the activity is allowed, and whether this one is could not be told` }];
  }
  return [{ criterion: '2.2.1', status: 'failed', ...at, detail: `${all}; nothing on the page turns this time limit off, adjusts it or extends it` }];
}

const guardDialogs = (events: readonly GuardEvent[]) => events.filter((e) => e.kind === 'dialog');
const guardBlocked = (events: readonly GuardEvent[]) => events.filter((e) => e.kind === 'blocked' || e.kind === 'popup');
/** Adds navigations the guard held (ones the in-page trap did not catch) to what the page recorded. */
function withHeld(got: Collected, events: readonly GuardEvent[]): Collected {
  const held = events.filter((e) => e.kind === 'navigation' && e.url && !got.navs.some((n) => n.url === e.url));
  return held.length ? { ...got, navs: [...got.navs, ...held.map((e) => ({ type: 'push', url: e.url! }))] } : got;
}
/** Runs in the page: navigation trapping off and mutation recording stopped (also after a failure part-way). */
const trapOff = () => {
  const kit = (window as unknown as { __grntedKit?: Kit }).__grntedKit;
  kit?.trap(false);
  kit?.stop();
};

export const timingProbe: PageProbe = {
  id: 'timing',
  criteria: ['2.2.1'],
  kind: 'interaction',
  tier: 'core',
  note: 'the core test runs the page\'s timers of 1 s or more early; it does not watch timers under 1 s, animation frames or workers (a deep test watches them for 20 s)',
  timeoutMs: 10_000,
  contextOptions: MOTION_CONTEXT,
  // Timing runs last on the shared page. When the motion test ran timers early there, their warnings and
  // redirects are spent: the runner gives timing the page loaded again (inside its time box).
  freshAfterFiredTimers: true,
  async run(ctx) {
    const { page } = ctx;
    const hooks = await ctx.hooks();
    await kitReady(page);
    const mark = ctx.guard.mark();
    // What timers already did (run naturally while the page settled) counts too. Dialogs come from the
    // guard's log, matched to calls the hook saw a timer make.
    const before = await page.evaluate(earlierRuns, undefined);
    const earlyDialogs = guardDialogs(ctx.guard.events.slice(0, mark));
    const timerCalls = new Set(hooks.calls.filter((c) => c.timer !== undefined && (c.api === 'alert' || c.api === 'confirm' || c.api === 'prompt')).map((c) => c.at));
    const early = earlyDialogs.filter((d) => [...timerCalls].some((at) => Math.abs(at - d.at) < 1000));
    let run: Awaited<ReturnType<typeof fireAll>>;
    let got: Collected;
    /** The time box ended before the test could follow work its timers started (checked below). */
    let cut = false;
    let left: { short: number; inflight: number; due: number } = { short: 0, inflight: 0, due: 0 };
    try {
      const offer = { words: EXTEND_VOCAB, phrase: LIMIT_CONTROL, warn: TIME_WORDS, leave: LEAVE_BUTTON };
      run = await page.evaluate(fireAll, { min: 1000, max: TWENTY_HOURS_MS, cap: TIMER_CAP, rounds: TIMER_ROUNDS, offer });
      // Code a timer starts asynchronously (a fetch, then a redirect) gets a moment to run.
      if (run.fired.length) await page.waitForTimeout(300);
      // Timers that code started asynchronously (after a promise or a response), or through a timer
      // under 1 s (which the hook does not list), appear a moment later. Each pass runs the new ones
      // (up to TIMER_PASSES). A pass that runs none waits again while a timer under 1 s it can see is
      // still pending (up to BRIDGE_WAITS times), and gives a request still out one longer wait
      // (SLOW_RESPONSE_MS), all within the cap and the time box.
      let bridges = 0;
      let slowWaited = false;
      for (let pass = 0; pass < TIMER_PASSES && run.fired.length && !run.skipped && run.fired.length < TIMER_CAP; pass++) {
        if (!hasTime(ctx, 2500)) { cut = true; break; }
        const more = await page.evaluate(fireAll, {
          min: 1000, max: TWENTY_HOURS_MS, cap: TIMER_CAP - run.fired.length, rounds: TIMER_ROUNDS, more: true, skip: run.fired.map((f) => f.handle), offer,
        });
        const offered = run.offered ?? more.offered;
        run = { ...run, fired: [...run.fired, ...more.fired], skipped: more.skipped, exempt: [...new Set([...run.exempt, ...more.exempt])], ...(offered ? { offered } : {}), ...(run.warnButton || more.warnButton ? { warnButton: true } : {}), ...(run.unobserved || more.unobserved ? { unobserved: true } : {}) };
        if (more.fired.length) {
          await page.waitForTimeout(300);
          continue;
        }
        const work = await page.evaluate(pendingWork, undefined).catch(() => ({ short: 0, inflight: 0 }));
        if (work.short > 0 && bridges < BRIDGE_WAITS) {
          if (!hasTime(ctx, BRIDGE_WAIT_MS + 2500)) { cut = true; break; }
          bridges++;
          await page.waitForTimeout(BRIDGE_WAIT_MS);
          continue;
        }
        if (work.inflight > 0 && !slowWaited) {
          if (!hasTime(ctx, SLOW_RESPONSE_MS + 2500)) { cut = true; break; }
          slowWaited = true;
          for (let waited = 0; waited < SLOW_RESPONSE_MS; waited += 250) {
            await page.waitForTimeout(250);
            const now = await page.evaluate(pendingWork, undefined).catch(() => ({ short: 0, inflight: 0 }));
            if (now.inflight === 0) break;
          }
          await page.waitForTimeout(300);
          continue;
        }
        break;
      }
      // Cut short: only known pending work counts (a short timer or a request its runs started, or a
      // timer of 1 s or more not run yet).
      if (cut) left = await page.evaluate(leftOver, { skip: run.fired.map((f) => f.handle), min: 1000, max: TWENTY_HOURS_MS }).catch(() => ({ short: 1, inflight: 0, due: 0 }));
      // The trap stays on until both the page's record and the guard's log have been read.
      got = await page.evaluate(collect, { navStart: run.navStart, callStart: run.callStart, words: TIME_WORDS, countdown: COUNTDOWN_WORDS, tied: TIED_WORDS, cookie: COOKIE_CLOSE, stated: STATED_TIME, ended: ENDED_WORDS, keepTrap: true });
    } catch (err) {
      await page.evaluate(trapOff, undefined).catch(() => {});
      throw err;
    }
    const events = ctx.guard.since(mark);
    await page.evaluate(trapOff, undefined).catch(() => {});
    got = withHeld(got, events);
    got = {
      ...got,
      navs: [...before.navs.filter((n) => !got.navs.some((m) => m.url === n.url)), ...got.navs],
      calls: before.submits ? [...got.calls, { api: 'submit' }] : got.calls,
    };
    const fired = new Map([...before.fired, ...run.fired].map((f) => [f.handle, f]));
    const total = new Set([...before.fired.map((f) => f.handle), ...run.fired.map((f) => f.handle)]).size;
    const checked = `${total} timer${total === 1 ? '' : 's'} of 1 s to 20 h run early${run.exempt.length ? `, ${run.exempt.length} of 20 h or more exempt` : ''}`;
    // No reload: timing is the last probe on this page (the timers it ran changed the page for good).
    const findings = await verdict(ctx, got, [...early, ...guardDialogs(events)], guardBlocked(events), {
      delayOf: (h) => (h === undefined ? undefined : fired.get(h)?.delay), checked, when: 'when its timers run', ...(run.offered ? { offered: run.offered } : {}),
      ...(run.warnButton ? { warnButton: true } : {}), ...(run.unobserved ? { unobserved: true } : {}),
    });
    // Known work the time box left unchecked: what the page does next was not seen, so no clean result.
    if (left.short || left.inflight || left.due) {
      const what = [left.short ? `${left.short} short timer${left.short === 1 ? '' : 's'}` : '', left.inflight ? `${left.inflight} request${left.inflight === 1 ? '' : 's'}` : '',
        left.due ? `${left.due} timer${left.due === 1 ? '' : 's'} not run yet` : ''].filter(Boolean).join(', ');
      for (let i = 0; i < findings.length; i++) {
        const f = findings[i]!;
        if (f.status === 'no_failures_found') findings[i] = { criterion: f.criterion, status: 'not_testable', ...(f.target ? { target: f.target } : {}), detail: `the time for this test ran out while the page still had work its timers started (${what}), so what it does next could not be seen` };
      }
    }
    if (run.skipped) {
      findings.push({ criterion: '2.2.1', status: 'not_testable', detail: `${run.skipped} more timer${run.skipped === 1 ? ' was' : 's were'} not run (the test runs ${TIMER_CAP} per page)` });
    }
    return findings;
  },
};

/** How long the deep probe watches the page. */
export const WATCH_MS = 20_000;

export const timingWatchProbe: PageProbe = {
  id: 'timing-watch',
  criteria: ['2.2.1'],
  kind: 'interaction',
  tier: 'deep',
  timeoutMs: WATCH_MS + 10_000,
  contextOptions: MOTION_CONTEXT,
  isolate: true,
  async run(ctx) {
    const { page } = ctx;
    await requireHook(ctx);
    await kitReady(page);
    const mark = ctx.guard.mark();
    let start: { navStart: number; callStart: number };
    try {
      start = await page.evaluate(startWatch, undefined);
    } catch (err) {
      await page.evaluate(trapOff, undefined).catch(() => {});
      throw err;
    }
    const until = Date.now() + WATCH_MS;
    let reloaded = false;
    while (Date.now() < until && hasTime(ctx, 3000)) {
      await page.waitForTimeout(Math.min(1000, until - Date.now()));
      // The guard lets a reload of the same address through; the mark is gone after one.
      const same = await page.evaluate(() => (window as unknown as { __grntedWatch?: boolean }).__grntedWatch === true, undefined).catch(() => false);
      if (!same) { reloaded = true; break; }
    }
    if (!reloaded && Date.now() < until) throw new ProbeNotTestable('the time for this test ran out before the page had been watched for 20 s');
    const watched = `the page watched for ${Math.round(WATCH_MS / 1000)} s`;
    let got: Collected;
    if (reloaded) {
      await kitReady(page);
      got = { navs: [{ type: 'reload', url: page.url?.() ?? ctx.url }], calls: [], warnings: [], overlay: false };
    } else {
      got = await page.evaluate(collect, { navStart: start.navStart, callStart: start.callStart, words: TIME_WORDS, countdown: COUNTDOWN_WORDS, tied: TIED_WORDS, cookie: COOKIE_CLOSE, stated: STATED_TIME, ended: ENDED_WORDS, keepTrap: true });
    }
    const events = ctx.guard.since(mark);
    await page.evaluate(trapOff, undefined).catch(() => {});
    got = withHeld(got, events);
    return verdict(ctx, got, guardDialogs(events), guardBlocked(events), { delayOf: () => undefined, checked: watched, when: `within ${Math.round(WATCH_MS / 1000)} s` });
  },
};
