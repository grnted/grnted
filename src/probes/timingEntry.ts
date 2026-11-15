// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 2.2.1 Timing Adjustable, for a time limit on what a visitor enters: a draft, an inquiry or a
// session that is cleared, locked or taken away when a timer runs out. The timing test (`timing`) runs
// the timers a page sets when it loads and looks for redirects, reloads, sent forms and warnings; it
// does not type, so it cannot see a timer that silently empties a field, nor one that only starts
// when the visitor types or presses a "Start" control. This deep test does what a visitor does:
// - types a few characters into up to three empty text fields (the strict guard is on: nothing the
//   page then tries to send leaves the browser);
// - runs the page's own timers early, in the order and at the times they were set for: those set when
//   the page loaded, those the typing started, and (when these take nothing away) those that pressing
//   one of up to three plain buttons starts. The page's clock (Date and performance.now) is moved to
//   each timer's time before it runs, so a countdown ends when it would, whether it counts ticks or
//   reads the clock;
// - after each timer, looks at what it typed: emptied, locked (disabled or read-only) or removed = a
//   time limit on the entry (5 s to 20 h after the page loaded, the typing or the press);
// - a tick under 1 s that was already running when the test started cannot be run by hand (the hook
//   lists timers of 1 s or more). So for the timers of the page's load the clock goes forward in six
//   steps (5 s to 20 h after the load): the timers due by each step are run, then the page's own ticks
//   get a moment to run, and a countdown that reads the clock ends in one of them. Such a limit is
//   known only between two steps, so when a button to extend showed on the way it is not a failure.
// A limit fails unless the page lets the visitor turn it off, adjust it over a range of at least ten
// times the default, or extend it from a warning that leaves at least 20 seconds (the criterion's own
// numbers). A control that says so by its name ("No time limit", "Extend", a list of durations) is
// looked for and never pressed. Not decided here: content with no field in it (a reference shown for a
// few seconds), and limits kept by the server.
// Deep: one page load of its own and about 3 s. Engine core: no Node-only imports.
import type { PageLike, ProbeFinding } from '../types.js';
import { EXTEND_VOCAB } from './kit.js';
import { DOWNLOAD_STOP_KEY, stopDownloads, undoDownloadStop } from './noDownloads.js';
import { ACTION_NAME } from './pointerKit.js';
import { LEAVE_BUTTON, LIMIT_CONTROL, TWENTY_HOURS_MS } from './timing.js';
import { ProbeNotTestable, type PageProbe, type ProbeContext } from './types.js';

export const ENTRY_PROBE_ID = 'timing-entry';
export const ENTRY_LIMITS = {
  /** Text fields typed into, and plain buttons pressed. */
  fields: 3,
  buttons: 3,
  /**
   * Timer runs per call, and the longest the timers may take to run (real time): all the sweeps after the page
   * loaded and the typing together, and each press. A page whose timers cannot be run to the end in that time
   * is "not testable", never clean.
   */
  events: 400_000,
  loadBudgetMs: 4000,
  runBudgetMs: 2500,
  /** After a press: how far the page's short timers are run before the test looks for new fields (ms on the page's clock). */
  pressRunMs: 600,
  /** The shortest limit judged (what a script clears sooner is its own start-up). */
  minMs: 5000,
  /** Timers under 1 s that re-arm themselves are seen once they have: the wait for that after the test starts. */
  rearmMs: 1100,
  /** The clock steps for ticks the test cannot run by hand (ms after the page loaded), and the wait for a tick after each. */
  sweep: [5000, 30_000, 120_000, 600_000, 3_600_000, 71_000_000],
  sweepWaitMs: 280,
  settleMs: 150,
  /** How far the page's timers are run on after a field was locked, to see whether the lock lasts (ms on the page's clock). */
  lockHoldMs: 3000,
  /** When a timer the page set meanwhile is still to run, the page's timers of this long after the lock are run too (Sol r1 S6). */
  lockReleaseMs: 60_000,
  pressMs: 350,
  reserveMs: 2500,
  /** The criterion's numbers: 20 seconds to extend, ten times the default to adjust. */
  extendMs: 20_000,
  adjustTimes: 10,
} as const;
const KEY = '__grntedEntry';
/** What the test types: plain words in a text field, a small number in a number field. */
export const ENTRY_TEXT = 'alder seven';
export const ENTRY_NUMBER = '47';

/** A control that turns a limit off or extends it, by its name (with `LIMIT_CONTROL`). */
export const ENTRY_OFF = String.raw`\b(no|without( a| any)?|turn(ing)? off( the)?|switch off( the)?|disable( the)?|remove( the)?|stop( the)?)\s+(time[\s-]*limits?|time[\s-]*outs?|timers?|countdown|expir\w+|auto(matic)?[\s-]*(clear\w*|log[\s-]*out|sign[\s-]*out))\b|\bnever\s+(expires?|times?\s+out)\b|\bunlimited\s+time\b`;
export const ENTRY_EXTEND = String.raw`\b(extend|more\s+time|add\s+(\d+\s+)?(more\s+)?(time|seconds?|minutes?)|keep\s+(working|editing|writing|going|my\s+\w+|me\s+(signed|logged)\s+in)|stay\s+(signed|logged)\s+in|i(?:'| a)?m\s+still\s+here|still\s+(here|working)|continue\s+(my\s+)?(session|draft|working)|restart\s+(the\s+)?(timer|clock|countdown))\b`;
/** A list of durations to choose the limit from, by its label. */
export const ENTRY_ADJUST = String.raw`\b(time[\s-]*limits?|time[\s-]*outs?|expir\w+|duration|session\s+length|how\s+long|keep\s+(the\s+|my\s+)?\w+\s+for|allow(ed)?\s+time)\b`;

/**
 * Signs that a time limit may be one of 2.2.1's exceptions: part of a real-time event (an auction, a live
 * event) or essential to the activity (an exam, a quiz, a timed test, typing speed). Looked for in the page's
 * title and headings, around the field, and anywhere in the page's visible text as it was before the timers
 * were run. A sign never fails anything: with one, a limit that would have failed is "not testable" (the test
 * cannot tell whether the exception holds).
 */
export const ENTRY_EXCEPTION = String.raw`\b(auctions?|bid(?:s|ding|ders?)?|exams?|examinations?|quiz(?:zes)?|tests?|assessments?|timed|typing\s+speed|words\s+per\s+minute|wpm|time\s+trials?|real[\s-]?time|live\s+(?:events?|auctions?|bidding|streams?|broadcasts?|sessions?|class(?:es)?|webinars?|draws?|votes?|voting))\b`;

/**
 * Signs, in the form or section around a field (and the page's title and headings), that what happens to it
 * follows the time of day, not how long the visitor has been on the page: opening hours, a closing time, a
 * deadline ("Chat is open 8 am to 5 pm", "Registration closes at noon on Friday", "Bids are due by 2 pm"). The
 * test moves the page's clock forward by up to 20 hours, so a form that closes at five o'clock is seen locking
 * "some hours after the page loads". With such a sign a limit counted from the page's load is not testable.
 */
export const ENTRY_CLOCK = String.raw`\b(?:clos(?:es?|ed|ing)|opens?|opening|hours|deadline|due|until|ends?|available|offline|after[\s-]hours)\b.{0,80}\b(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|noon|midnight|\d{1,2}:\d{2}|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|weekdays?|weekends?|today|tonight|tomorrow)\b|\b(?:office|business|opening|chat|phone|support|service|counter|lobby)\s+hours\b`;

/** A field that answers a CAPTCHA (by its name, id, label or placeholder): its picture is replaced on a timer, and the answer with it. Never typed into. */
export const ENTRY_CAPTCHA = String.raw`captcha|\b(?:type|enter|copy)\s+the\s+(?:characters|letters|numbers|code|text|words?)\b|\b(?:characters|letters|code|text|words?)\s+(?:you\s+see|shown|above|below|in\s+the\s+(?:image|picture|box))\b|\b(?:security|verification)\s+(?:code|check|question)\b|\bnot\s+a\s+robot\b`;

export interface EntryField { i: number; name: string; path: string; number: boolean }
export interface EntryButton { i: number; name: string }
export interface EntryState {
  /** Per kept field: its value, whether it is gone (removed or hidden) and whether it is locked. */
  fields: { v: string; gone: boolean; off: boolean; moved?: boolean; covered?: boolean }[];
  /** Lines of visible text that were not there at the last look (max 600 characters). */
  fresh: string;
  /** Names of the visible buttons that were not there at the last look (max 8). */
  buttons: string[];
}
export interface EntryControl {
  name: string;
  kind: 'off' | 'extend' | 'adjust';
  /** adjust: the durations offered (ms), the one chosen now, and whether one of them is "no limit". */
  options?: number[];
  chosen?: number;
  none?: boolean;
}

interface ShortTimer { fn: (...a: unknown[]) => unknown; args: unknown[]; delay: number; once: boolean; at: number }
interface Store {
  fields: HTMLElement[]; buttons: HTMLElement[]; lines: Set<string>; names: Set<string>;
  /** The page clock's shift (ms), and what it was when each of the hook's timers was first seen. */
  shift: number; born: Map<number, number>;
  /** Timers under 1 s set since the test started (the hook lists only timers of 1 s or more). */
  short: Map<number, ShortTimer>;
  /**
   * What each timer goes back to: the page's load, or something the visitor did (a trusted event was being
   * handled when it was set). A timer set by a timer has its setter's (`current`, while `entryRun` runs one).
   */
  origin: Map<number, 'load' | 'input'>;
  current?: 'load' | 'input';
  started: boolean;
  /**
   * The timers' schedule, kept from one `entryRun` to the next (a stage runs them in several sweeps): when each
   * is due next, the timer its chain began with, how often it has run. Never rebuilt: a repeating timer goes on
   * from its last tick.
   */
  due: Map<number, number>; root: Map<number, number>; runs: Map<number, number>;
  /**
   * Set by the first `entryRun` and never cleared: from then on the page's timers run only when the test runs
   * them, at their times (a tick that also fired by itself would be counted twice). Until then they run as on
   * any page, and the first run starts each repeating timer at its next tick.
   */
  frozen: boolean;
  /** The buttons in view when the stage began, and the first button to extend that showed since (with its time). */
  base?: Set<string>; warn?: { at: number; name: string; tick: number };
  /** What each kept field was when it was kept, to find it again when the page swaps it for a new element. */
  facts: { id: string; name: string; tag: string; type: string; label: string; aria: string; x: number; y: number }[];
  /** The kept field `i`, or the element the page put in its place (found by id, name, label, accessible name or place); null when it is gone. */
  relink: (i: number) => HTMLElement | null;
  /**
   * The kept field `i` is gone with nothing found in its place, but another enabled text field on the page holds
   * the very text it held: the page may have moved what was typed there. A doubt, never a loss.
   */
  twin: (i: number) => boolean;
  /** The page's visible text as it was before the test ran any timer, and after each press (`entrySaid`). */
  said: string[];
  undo: () => void;
}

/** Runs in the page (self-contained): empty, visible, enabled text fields not kept yet. */
export function entryFields(arg: { key: string; max: number; captcha?: string }): EntryField[] {
  const W = window as unknown as Record<string, unknown>;
  const captcha = arg.captcha ? new RegExp(arg.captcha, 'i') : null;
  let store = W[arg.key] as Store | undefined;
  if (!store) {
    const made: Store = {
      fields: [], buttons: [], lines: new Set<string>(), names: new Set<string>(), shift: 0, born: new Map(), short: new Map(), origin: new Map(), started: false,
      due: new Map(), root: new Map(), runs: new Map(), frozen: false, facts: [], relink: () => null, twin: () => false, said: [], undo: () => {},
    };
    made.twin = (i: number): boolean => {
      const f = made.fields[i] as HTMLInputElement | undefined;
      const had = f ? String(f.value ?? '') : '';
      if (!f || f.isConnected || !had) return false;
      const all = document.querySelectorAll('input, textarea');
      for (let k = 0; k < all.length && k < 400; k++) {
        const e = all[k] as HTMLInputElement;
        if (e !== f && !made.fields.includes(e) && e.value === had && !e.disabled && !e.readOnly && !e.closest('fieldset[disabled], [inert]')) return true;
      }
      return false;
    };
    made.relink = (i: number): HTMLElement | null => {
      const ariaName = (e: Element): string => {
        const by = (e.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
        return (by.trim() ? by : e.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      };
      const f = made.fields[i];
      if (!f) return null;
      if (f.isConnected) return f;
      const m = made.facts[i];
      if (!m) return null;
      const typeOf = (e: Element) => (e.localName === 'textarea' ? 'text' : (e.getAttribute('type') || 'text').toLowerCase());
      const fits = (e: Element | null | undefined): e is HTMLElement => !!e && e !== f && e.isConnected && e.localName === m.tag && typeOf(e) === m.type && !made.fields.includes(e as HTMLElement);
      const text = (x: string | null | undefined) => (x ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      let found: HTMLElement | null = null;
      if (m.id) { const e = document.getElementById(m.id); if (fits(e)) found = e; }
      if (!found && m.name) { const all = document.getElementsByName(m.name); for (let k = 0; k < all.length && !found; k++) if (fits(all[k])) found = all[k] as HTMLElement; }
      if (!found && m.label) {
        const labels = document.querySelectorAll('label');
        for (let k = 0; k < labels.length && k < 400 && !found; k++) { const l = labels[k] as HTMLLabelElement; if (text(l.innerText) === m.label && fits(l.control)) found = l.control as HTMLElement; }
      }
      // By its accessible name where that comes from aria-labelledby or aria-label (a field with no id, name or label).
      if (!found && m.aria) {
        const all = document.querySelectorAll('input, textarea');
        for (let k = 0; k < all.length && k < 400 && !found; k++) if (fits(all[k]) && ariaName(all[k]!) === m.aria) found = all[k] as HTMLElement;
      }
      if (!found) {
        const at = document.elementFromPoint(m.x - scrollX, m.y - scrollY);
        const c = at && at.closest ? at.closest('input, textarea') : null;
        if (fits(c)) found = c;
      }
      if (found) made.fields[i] = found;
      return found;
    };
    store = made;
    Object.defineProperty(W, arg.key, { value: store, configurable: true, enumerable: false, writable: true });
    // The page's clock, which `entryFire` moves forward: Date and performance.now read the real time plus `shift`.
    try {
      const RealDate = Date;
      const perf = performance;
      const realPerf = perf.now;
      const Clock = function (this: unknown, ...a: unknown[]) {
        if (!new.target) return new RealDate(RealDate.now() + made.shift).toString();
        return a.length ? Reflect.construct(RealDate, a) : new RealDate(RealDate.now() + made.shift);
      } as unknown as DateConstructor;
      (Clock as unknown as { prototype: unknown }).prototype = RealDate.prototype;
      Clock.now = () => RealDate.now() + made.shift;
      Clock.parse = RealDate.parse;
      Clock.UTC = RealDate.UTC;
      (window as unknown as { Date: DateConstructor }).Date = Clock;
      perf.now = () => realPerf.call(perf) + made.shift;
      // Timers under 1 s set from now on (a countdown's ticks): kept so `entryRun` can run them at their times.
      const st = window.setTimeout;
      const si = window.setInterval;
      const ct = window.clearTimeout;
      const ci = window.clearInterval;
      const keep = (once: boolean, set: typeof window.setTimeout) => function (this: unknown, fn: TimerHandler, delay?: number, ...rest: unknown[]) {
        const d = Number(delay) || 0;
        if (typeof fn !== 'function' || d >= 1000 || (d < 50 && once) || made.short.size >= 200) return set.apply(window, [fn, delay, ...rest] as unknown as Parameters<typeof window.setTimeout>) as unknown as number;
        const run = fn as ShortTimer['fn'];
        // Once the test runs the timers itself (`frozen`), a run the browser makes is dropped: the test makes it, at its time.
        const own = function (this: unknown, ...a: unknown[]) {
          if (made.frozen) return undefined;
          if (once) made.short.delete(h);
          return run.apply(this, a);
        };
        const h: number = set.apply(window, [own, delay, ...rest] as unknown as Parameters<typeof window.setTimeout>) as unknown as number;
        made.short.set(h, { fn: run, args: rest, delay: Math.max(d, 4), once, at: perf.now() });
        const ev = window.event;
        made.origin.set(h, made.current ?? (ev && ev.isTrusted ? 'input' : 'load'));
        return h;
      };
      window.setTimeout = keep(true, st) as unknown as typeof window.setTimeout;
      window.setInterval = keep(false, si as unknown as typeof window.setTimeout) as unknown as typeof window.setInterval;
      window.clearTimeout = function (h?: number) { made.short.delete(h as number); return ct.call(window, h); } as typeof window.clearTimeout;
      window.clearInterval = function (h?: number) { made.short.delete(h as number); return ci.call(window, h); } as typeof window.clearInterval;
      // A button the test presses may be "Print": the print dialog is not opened.
      const print = window.print;
      window.print = () => {};
      made.undo = () => {
        (window as unknown as { Date: DateConstructor }).Date = RealDate;
        perf.now = realPerf;
        window.setTimeout = st; window.setInterval = si; window.clearTimeout = ct; window.clearInterval = ci;
        window.print = print;
      };
    } catch { /* a page that locks its clock or its timers is read without moving them */ }
  }
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const nameOf = (el: HTMLElement): string => {
    const lab = (el as HTMLInputElement).labels?.[0];
    return clean(el.getAttribute('aria-label') || lab?.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || el.localName);
  };
  const out: EntryField[] = [];
  const all = document.querySelectorAll('input, textarea');
  for (let k = 0; k < all.length && k < 400 && store.fields.length < arg.max; k++) {
    const el = all[k] as HTMLInputElement | HTMLTextAreaElement;
    if (store.fields.includes(el)) continue;
    const type = el.localName === 'textarea' ? 'text' : ((el.getAttribute('type') || 'text').toLowerCase());
    if (type !== 'text' && type !== 'search' && type !== 'number') continue;
    if (el.disabled || el.readOnly || el.value !== '' || el.closest('[inert], [aria-hidden="true"], fieldset[disabled]')) continue;
    if (/^(cc-|one-time-code|current-password|new-password)/.test(el.autocomplete || '') || el.getAttribute('list') || el.getAttribute('role') === 'combobox') continue;
    // A CAPTCHA's answer goes with its picture when the page puts up a new one: no entry of the visitor's own.
    if (captcha && captcha.test(`${el.getAttribute('name') ?? ''} ${el.id} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('placeholder') ?? ''} ${(el as HTMLInputElement).labels?.[0]?.innerText ?? ''}`)) continue;
    const e = el as Element & { checkVisibility?: (o: Record<string, boolean>) => boolean };
    if (typeof e.checkVisibility === 'function' && !e.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 8) continue;
    store.fields.push(el);
    const by = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    store.facts.push({ id: el.id, name: el.getAttribute('name') ?? '', tag: el.localName, type, label: clean((el as HTMLInputElement).labels?.[0]?.innerText), aria: clean(by.trim() ? by : el.getAttribute('aria-label')), x: r.left + r.width / 2 + scrollX, y: r.top + r.height / 2 + scrollY });
    const d = (W as { __grntedDescribe?: (e: Element) => { path?: string } | null }).__grntedDescribe;
    out.push({ i: store.fields.length - 1, name: nameOf(el), path: (typeof d === 'function' ? d(el)?.path : '') || (el.id ? `#${el.id}` : el.localName), number: type === 'number' });
  }
  return out;
}

/** Runs in the page (self-contained): puts focus in a kept field (the caller then types). */
export function entryFocus(arg: { key: string; i: number }): boolean {
  const el = ((window as unknown as Record<string, Store | undefined>)[arg.key]?.fields ?? [])[arg.i];
  if (!el || !el.isConnected) return false;
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
  el.focus({ preventScroll: true });
  return document.activeElement === el;
}

/**
 * Runs in the page (self-contained): plain buttons a visitor would press to start something, focused
 * one at a time by `entryPress`. Never a submit or reset button, a link, a control named for an action
 * (`action`), or one that opens a menu. Buttons that share a form or section with a field come first.
 */
export function entryButtons(arg: { key: string; max: number; action: string }): EntryButton[] {
  const store = (window as unknown as Record<string, Store | undefined>)[arg.key];
  if (!store) return [];
  const action = new RegExp(arg.action, 'i');
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const found: { el: HTMLElement; near: boolean; name: string }[] = [];
  const all = document.querySelectorAll('button, input[type="button"], [role="button"][tabindex]');
  for (let k = 0; k < all.length && k < 300; k++) {
    const el = all[k] as HTMLElement;
    const b = el as HTMLButtonElement;
    if (b.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[inert], [aria-hidden="true"], nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]')) continue;
    if (el.localName === 'button' && b.form && (b.type === 'submit' || b.type === 'reset')) continue;
    if (el.hasAttribute('aria-haspopup')) continue;
    const name = clean(el.getAttribute('aria-label') || el.innerText || (el as HTMLInputElement).value || el.getAttribute('title'));
    if (!name || action.test(name)) continue;
    const e = el as Element & { checkVisibility?: (o: Record<string, boolean>) => boolean };
    if (typeof e.checkVisibility === 'function' && !e.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const box = el.closest('form, fieldset, section, article, [role="group"], [role="region"], [role="form"]');
    found.push({ el, near: !!box && !!box.querySelector('input:not([type="hidden"]), textarea'), name });
  }
  found.sort((a, b) => Number(b.near) - Number(a.near));
  store.buttons = found.slice(0, arg.max).map((f) => f.el);
  return found.slice(0, arg.max).map((f, i) => ({ i, name: f.name }));
}

/** Runs in the page (self-contained): puts focus on a kept button (the caller then presses Enter). */
export function entryPress(arg: { key: string; i: number }): boolean {
  const el = ((window as unknown as Record<string, Store | undefined>)[arg.key]?.buttons ?? [])[arg.i];
  if (!el || !el.isConnected) return false;
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
  el.focus({ preventScroll: true });
  return document.activeElement === el;
}

/** Runs in the page (self-contained): the page's clock now (ms since the page started loading, with the test's shift), or null without the hook. */
export function entryNow(arg: { key: string }): { now: number; timers: number[] } | null {
  const W = window as unknown as { __grntedPending?: () => { handle: number }[] } & Record<string, Store | undefined>;
  const store = W[arg.key];
  if (!store || typeof W.__grntedPending !== 'function') return null;
  const timers = W.__grntedPending().map((p) => p.handle);
  for (const h of timers) {
    if (!store.born.has(h)) store.born.set(h, store.shift);
    // The timers pending at the test's first look were set while the page loaded; later ones by what the test did.
    if (!store.origin.has(h)) store.origin.set(h, store.started ? 'input' : 'load');
  }
  store.started = true;
  return { now: performance.now(), timers: [...timers, ...store.short.keys()] };
}

/**
 * Runs in the page (self-contained): keeps the page's visible text as it is now (at most six times, 40,000
 * characters each). Called before the test runs any timer and after each press, so that a sign of a real-time or
 * essential limit is still known when the page has taken it away with the limit's end.
 */
export function entrySaid(arg: { key: string }): number {
  const store = (window as unknown as Record<string, Store | undefined>)[arg.key];
  if (!store) return 0;
  if (store.said.length < 6) store.said.push(String(document.body?.innerText ?? '').slice(0, 40_000));
  return store.said.length;
}

/**
 * Runs in the page (self-contained): the first sign (`words`) that a limit on kept field `i` may be real-time or
 * essential, read in the page's title, its headings, the form or section around the field with its label, and
 * then anywhere in the page's visible text as it was before the timers were run (`entrySaid`); '' when there
 * is none.
 */
export function entrySigns(arg: { key: string; i: number; words: string; near?: boolean }): string {
  const store = (window as unknown as Record<string, Store | undefined>)[arg.key];
  const re = new RegExp(arg.words, 'i');
  const texts: string[] = [document.title];
  const hs = document.querySelectorAll('h1, h2, h3, [role="heading"]');
  for (let k = 0; k < hs.length && k < 20; k++) texts.push((hs[k] as HTMLElement).innerText ?? hs[k]!.textContent ?? '');
  const f = store ? (store.relink(arg.i) ?? store.fields[arg.i]) : undefined;
  if (store?.facts[arg.i]?.label) texts.push(store.facts[arg.i]!.label);
  if (f && f.isConnected) {
    const box = f.closest('form, fieldset, section, article, [role="group"], [role="region"], [role="form"], main, [role="main"]') ?? f.parentElement;
    if (box) texts.push(String((box as HTMLElement).innerText ?? box.textContent ?? '').slice(0, 2000));
    const by = (f.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    for (const id of by) texts.push(document.getElementById(id)?.textContent ?? '');
  }
  // Anywhere in the page's visible text, as it was before the limit ran out: a paragraph outside the field's form
  // says what the page is as well. (Not the text as it is now: "your session timed out" is the limit's own
  // message, not a sign that the limit is essential.)
  // (`near`: only what the page says of itself and of the field: its title, headings, the field's form or section.)
  if (store && !arg.near) texts.push(...store.said);
  for (const t of texts) {
    const m = re.exec(t.replace(/\s+/g, ' '));
    if (m) return m[0].slice(0, 60);
  }
  return '';
}

/** Runs in the page (self-contained): moves the page's clock forward to `to` ms after the page started loading. */
export function entryShift(arg: { key: string; to: number }): number {
  const store = (window as unknown as Record<string, Store | undefined>)[arg.key];
  if (!store) return 0;
  const behind = arg.to - performance.now();
  if (behind > 0) store.shift += behind;
  return performance.now();
}

/** What running the page's timers did (`entryRun`). Times are on the page's (moved) clock. */
export interface EntryRun {
  /** Timer runs made, and whether the run stopped at its cap. */
  events: number;
  capped: boolean;
  /** The first field that held typed text and lost it, the time, and the timer that did it. */
  lost?: {
    field: number; effect: 'cleared' | 'locked' | 'removed'; at: number;
    /** Removed with nothing found in its place, while another enabled field holds the same text (`Store.twin`). */
    moved?: boolean;
    /** The timer whose run took it: the first in its chain, what the chain goes back to, whether the timer repeats, its delay, and how often it had run. */
    root: number; origin: 'load' | 'input'; repeat: boolean; delay: number; runs: number;
    /** How many timers of its chain the test had run by then (a chain of timeouts, each setting the next). */
    chain: number;
    /** The run that took it set a new timer with the same delay: the chain goes on (a refresh that comes round again). */
    rearmed?: boolean;
    /** Locked while a dialog is open that shows now (a "Still there?" box that switches the form off behind it). */
    dialog?: boolean;
    /** A repeating timer took it and is still set afterwards (it did not end itself). */
    goesOn?: boolean;
  };
  /** The first time a button to extend showed, and its name. */
  warn?: { at: number; name: string; tick: number };
}

/**
 * Runs in the page (self-contained): runs the page's pending timers in the order and at the times they
 * were set for, moving the page's clock to each one's time first (a small event loop: a timer one of them
 * sets is run in its turn). Stops when a kept field that holds typed text is emptied, locked or removed,
 * when no timer is due by `until` (the page's clock; `settle`: the clock is then moved there), or at
 * `events` runs or `budgetMs` of real time.
 */
export async function entryRun(arg: { key: string; until: number; settle: boolean; fresh: boolean; events: number; budgetMs: number; extend: string; vocab: readonly string[]; leave?: string }): Promise<EntryRun> {
  const W = window as unknown as {
    __grntedFire?: (h: number, keep?: boolean) => unknown;
    __grntedPending?: () => { handle: number; kind: string; delay: number; at: number }[];
  } & Record<string, Store | undefined>;
  const store = W[arg.key];
  const out: EntryRun = { events: 0, capped: false };
  if (!store || typeof W.__grntedFire !== 'function' || typeof W.__grntedPending !== 'function') return out;
  const fields = store.fields.map((f, i) => ({ f: (store.relink(i) ?? f) as HTMLInputElement, i })).filter((x) => x.f.isConnected && x.f.value !== '' && !x.f.disabled && !x.f.readOnly && !x.f.closest('fieldset[disabled]'));
  const lostNow = (): { field: number; effect: 'cleared' | 'locked' | 'removed'; moved?: boolean } | null => {
    for (const x of fields) {
      if (!x.f.isConnected) {
        // The page may have put a new element in the field's place: what counts is whether the text is still there.
        const now = store.relink(x.i) as HTMLInputElement | null;
        if (!now) return { field: x.i, effect: 'removed', ...(store.twin(x.i) ? { moved: true } : {}) };
        x.f = now;
      }
      if (x.f.value === '') return { field: x.i, effect: 'cleared' };
      if (x.f.disabled || x.f.readOnly || x.f.closest('fieldset[disabled]')) return { field: x.i, effect: 'locked' };
    }
    return null;
  };
  const extend = new RegExp(arg.extend, 'i');
  const vocab = new Set(arg.vocab);
  const isExtend = (name: string) => {
    if (extend.test(name)) return true;
    const words = name.toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean);
    return words.length > 0 && words.length <= 4 && words.every((w) => vocab.has(w)) && !/^(the|my|me|in|off|time|minutes|session|timer|countdown)$/.test(words.join(' '));
  };
  const buttons = (): string[] => {
    const names: string[] = [];
    const all = document.querySelectorAll('button, [role="button"], input[type="button"]');
    for (let k = 0; k < all.length && k < 200; k++) {
      const b = all[k] as HTMLElement & { checkVisibility?: (o: Record<string, boolean>) => boolean };
      if (typeof b.checkVisibility === 'function' && !b.checkVisibility({ visibilityProperty: true })) continue;
      const name = (b.getAttribute('aria-label') || b.innerText || (b as unknown as HTMLInputElement).value || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (name) names.push(name);
    }
    return names;
  };
  // A new stage (the page as it is after typing, or after a press): the buttons in view now are not a warning's.
  if (arg.fresh || !store.base) { store.base = new Set(buttons()); delete store.warn; }
  const base = store.base;
  // From the first run on the timers run only here. Until now they ran by themselves: a repeating timer starts
  // at its next tick (the earlier ones have happened), a later timer at its first.
  const first = !store.frozen;
  if (first) {
    store.frozen = true;
    try { (W as unknown as { __grntedFreeze?: (on: boolean) => unknown }).__grntedFreeze?.(true); } catch { /* the hook's own timers then run by themselves too */ }
  }
  // What scripts added or switched since the last look (a button can only show through one of these): the
  // buttons are read again only then. The records come to the callback at the end of each timer run, or are
  // taken here.
  let touched = true;
  let watching = true;
  const note = (recs: MutationRecord[]): void => {
    for (const r of recs) {
      if (r.type === 'attributes') { touched = true; return; }
      for (let k = 0; k < r.addedNodes.length; k++) if (r.addedNodes[k]!.nodeType === 1) { touched = true; return; }
    }
  };
  const seen = new MutationObserver(note);
  try { seen.observe(document.documentElement, { subtree: true, childList: true, attributes: true }); } catch { watching = false; }
  interface T { handle: number; repeat: boolean; delay: number; short: boolean; at: number }
  const list = (): T[] => {
    const ts: T[] = [];
    for (const p of W.__grntedPending!()) {
      if (!store.born.has(p.handle)) store.born.set(p.handle, store.shift);
      // The hook's times are on the real clock: a timer set while the clock was moved starts from there.
      ts.push({ handle: p.handle, repeat: p.kind === 'interval', delay: p.delay, short: false, at: p.at + store.born.get(p.handle)! });
    }
    store.short.forEach((e, h) => ts.push({ handle: h, repeat: !e.once, delay: e.delay, short: true, at: e.at }));
    return ts;
  };
  // The schedule is the store's: the next sweep goes on where this one stops (a tick is never run twice).
  const due = store.due;
  const root = store.root;
  const runs = store.runs;
  const real0 = performance.now() - store.shift;
  let current: number | undefined;
  let from: 'load' | 'input' | undefined;
  let starting = first;
  while (out.events < arg.events) {
    const ts = list();
    for (const t of ts) {
      if (!due.has(t.handle)) {
        const now = performance.now();
        const next = t.at + t.delay;
        due.set(t.handle, starting && t.repeat && next < now ? t.at + Math.ceil((now - t.at) / t.delay) * t.delay : next);
      }
      if (!root.has(t.handle)) root.set(t.handle, current ?? t.handle);
      if (!store.origin.has(t.handle)) store.origin.set(t.handle, from ?? 'input');
    }
    starting = false;
    let next: T | undefined;
    for (const t of ts) if (!next || due.get(t.handle)! < due.get(next.handle)!) next = t;
    if (!next) break;
    const at = due.get(next.handle)!;
    if (at > arg.until) break;
    const behind = at - performance.now();
    if (behind > 0) store.shift += behind;
    current = root.get(next.handle);
    from = store.origin.get(next.handle) ?? 'input';
    store.current = from;
    if (next.repeat) due.set(next.handle, at + next.delay); else due.delete(next.handle);
    const n = (runs.get(next.handle) ?? 0) + 1;
    runs.set(next.handle, n);
    // The chain this timer belongs to (a timeout that sets the next one): how many of its timers have run.
    const chainKey = -1 - (current ?? next.handle);
    const chain = (runs.get(chainKey) ?? 0) + 1;
    runs.set(chainKey, chain);
    const known = new Set(ts.map((t) => t.handle));
    try {
      if (next.short) {
        const e = store.short.get(next.handle);
        if (e) {
          if (e.once) { store.short.delete(next.handle); window.clearTimeout(next.handle); }
          e.fn.apply(window, e.args);
        }
      } else {
        W.__grntedFire(next.handle);
      }
    } catch { /* a timer that throws is the page's own error */ }
    out.events++;
    // Let what the timer started in promises finish before looking.
    await null;
    store.current = undefined;
    if (watching) note(seen.takeRecords()); else touched = true;
    if (!store.warn && touched) {
      touched = false;
      const name = buttons().find((b) => !base.has(b) && isExtend(b));
      if (name) store.warn = { at: performance.now(), name, tick: next.repeat ? next.delay : 0 };
    }
    const lost = lostNow();
    if (lost) {
      // The run set a new timer with its own delay: it comes round again (a refresh), it is no countdown's end.
      const fired = next;
      const rearmed = !fired.repeat && list().some((t) => !known.has(t.handle) && !t.repeat && t.delay === fired.delay);
      // Locked while a dialog shows that has a button other than one to leave or sign in again: the box asks
      // something ("Still there?") and may give the field back when answered. (A box that only says the time is up
      // and offers "Sign in again" gives nothing back: the lock stands.)
      const leave = arg.leave ? new RegExp(arg.leave, 'i') : null;
      const dialog = lost.effect === 'locked' && [...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')].some((d) => {
        if (d.closest('[inert]') || d.getClientRects().length === 0 || getComputedStyle(d).visibility === 'hidden') return false;
        const bs = d.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]');
        for (let k = 0; k < bs.length && k < 20; k++) {
          const b = bs[k] as HTMLButtonElement;
          const name = (b.getAttribute('aria-label') || b.innerText || (b as unknown as HTMLInputElement).value || '').replace(/\s+/g, ' ').trim();
          if (!b.disabled && b.getClientRects().length > 0 && name && !(leave && leave.test(name))) return true;
        }
        return false;
      });
      const goesOn = fired.repeat && list().some((t) => t.handle === fired.handle);
      out.lost = { ...lost, at: performance.now(), root: current ?? next.handle, origin: from, repeat: next.repeat, delay: next.delay, runs: n, chain, ...(rearmed ? { rearmed: true } : {}), ...(dialog ? { dialog: true } : {}), ...(goesOn ? { goesOn: true } : {}) };
      break;
    }
    if (performance.now() - store.shift - real0 > arg.budgetMs) { out.capped = true; break; }
  }
  if (out.events >= arg.events) out.capped = true;
  seen.disconnect();
  if (store.warn) out.warn = { ...store.warn };
  if (arg.settle && !out.lost && !out.capped) {
    const behind = arg.until - performance.now();
    if (behind > 0) store.shift += behind;
  }
  return out;
}

/** Runs in the page (self-contained): one kept field as it is now (nothing else is read or kept); null when the test's store is gone. */
export function entryField(arg: { key: string; i: number }): { v: string; gone: boolean; off: boolean } | null {
  const store = (window as unknown as Record<string, Store | undefined>)[arg.key];
  const kept = store?.fields[arg.i];
  if (!store || !kept) return null;
  const el = (store.relink(arg.i) ?? kept) as HTMLInputElement;
  return { v: String(el.value ?? '').slice(0, 80), gone: !el.isConnected, off: !!(el.disabled || el.readOnly || el.closest('fieldset[disabled]') || el.getAttribute('aria-disabled') === 'true') };
}

/** Runs in the page (self-contained): the kept fields as they are now, and the visible text that is new since the last look. */
export function entryState(arg: { key: string }): EntryState {
  const store = (window as unknown as Record<string, Store | undefined>)[arg.key];
  const fields = (store?.fields ?? []).map((kept, i) => {
    // The element the page put in the field's place counts as the field (found by id, name, label or place).
    const f = store!.relink(i) ?? kept;
    const el = f as HTMLInputElement;
    // Gone = taken out of the page with nothing in its place. A field that is only hidden keeps what was typed: not judged.
    // Inert under a dialog that is open (a newsletter, survey or cookie dialog opened on a timer): the page behind
    // it is out of reach while it is open, and closing it gives the field back. Not a lock (review r1 F7a).
    // (Batch 17: inert with no dialog found is the same doubt. A page makes its content inert while something else
    // is in front of it, whatever that is built from; a field that is itself still enabled was not locked.)
    const inert = !!f.closest('[inert]');
    const own = !!(el.disabled || el.readOnly || f.closest('fieldset[disabled]') || f.getAttribute('aria-disabled') === 'true');
    const covered = inert && !own;
    return {
      v: String(el.value ?? '').slice(0, 80), gone: !f.isConnected,
      off: !!(el.disabled || el.readOnly || f.closest('fieldset[disabled]') || inert || f.getAttribute('aria-disabled') === 'true'),
      ...(covered ? { covered: true } : {}),
      ...(!f.isConnected && store!.twin(i) ? { moved: true } : {}),
    };
  });
  const fresh: string[] = [];
  if (store) {
    const now = new Set<string>();
    for (const raw of (document.body?.innerText ?? '').slice(0, 60_000).split('\n')) {
      const line = raw.replace(/\s+/g, ' ').trim();
      if (line.length < 4) continue;
      now.add(line);
      if (!store.lines.has(line) && fresh.join(' ').length < 600) fresh.push(line.slice(0, 200));
    }
    store.lines = now;
  }
  const buttons: string[] = [];
  if (store) {
    const names = new Set<string>();
    const all = document.querySelectorAll('button, [role="button"], input[type="button"], a[href]');
    for (let k = 0; k < all.length && k < 600; k++) {
      const b = all[k] as HTMLElement & { checkVisibility?: (o: Record<string, boolean>) => boolean };
      if (typeof b.checkVisibility === 'function' && !b.checkVisibility({ visibilityProperty: true })) continue;
      const name = (b.getAttribute('aria-label') || b.innerText || (b as unknown as HTMLInputElement).value || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!name) continue;
      names.add(name);
      if (!store.names.has(name) && buttons.length < 8) buttons.push(name);
    }
    store.names = names;
  }
  return { fields, fresh: fresh.join(' ').slice(0, 600), buttons };
}

/**
 * Runs in the page (self-contained): visible controls that turn a time limit off, extend it, or let the
 * visitor choose how long it is (looked for by name and label, never pressed).
 */
export function entryControls(arg: { off: string; extend: string; adjust: string; phrase: string }): EntryControl[] {
  const off = new RegExp(arg.off, 'i');
  const extend = new RegExp(arg.extend, 'i');
  const adjust = new RegExp(arg.adjust, 'i');
  const phrase = new RegExp(arg.phrase, 'i');
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const shown = (el: Element) => {
    const e = el as Element & { checkVisibility?: (o: Record<string, boolean>) => boolean };
    return (typeof e.checkVisibility !== 'function' || e.checkVisibility({ visibilityProperty: true, opacityProperty: true })) && el.getBoundingClientRect().width > 0;
  };
  const labelOf = (el: HTMLElement): string => {
    const lab = (el as HTMLInputElement).labels?.[0];
    const group = el.closest('fieldset')?.querySelector('legend');
    // A label that wraps its control: its own words, not the control's options.
    let own = '';
    if (lab) {
      const copy = lab.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('select, input, textarea, button').forEach((c) => c.remove());
      own = copy.textContent ?? '';
    }
    return clean([el.getAttribute('aria-label'), own, group?.textContent].filter(Boolean).join(' '));
  };
  const ms = (text: string): number | null => {
    const m = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(text);
    if (!m) return null;
    const u = m[2]!.toLowerCase();
    return Number(m[1]) * (u.startsWith('h') ? 3_600_000 : u.startsWith('m') ? 60_000 : 1000);
  };
  const none = /\b(no|without)\s+(time\s*)?(limit|expiry|time\s*out)|\bnever\b|\bunlimited\b|\boff\b/i;
  const out: EntryControl[] = [];
  const controls = document.querySelectorAll('button, a[href], input, select, summary, [role="button"], [role="checkbox"], [role="switch"], [role="link"]');
  const groups = new Map<string, HTMLInputElement[]>();
  for (let k = 0; k < controls.length && k < 1500 && out.length < 6; k++) {
    const el = controls[k] as HTMLElement;
    if (!shown(el) && !(el.localName === 'input' && (el as HTMLInputElement).labels?.[0] && shown((el as HTMLInputElement).labels![0]!))) continue;
    if ((el as HTMLInputElement).disabled) continue;
    const input = el as HTMLInputElement;
    if (el.localName === 'select') {
      const label = labelOf(el);
      const opts = [...(el as unknown as HTMLSelectElement).options];
      const times = opts.map((o) => ms(o.text)).filter((x): x is number => x !== null);
      if (times.length >= 2 && (adjust.test(label) || times.length === opts.filter((o) => !none.test(o.text)).length)) {
        const sel = (el as unknown as HTMLSelectElement).selectedOptions[0];
        const chosen = sel ? ms(sel.text) : null;
        out.push({ name: label || 'a list of durations', kind: 'adjust', options: times, ...(chosen !== null ? { chosen } : {}), none: opts.some((o) => none.test(o.text) && ms(o.text) === null) });
      }
      continue;
    }
    if (el.localName === 'input' && input.type === 'radio' && input.name) { groups.set(input.name, [...(groups.get(input.name) ?? []), input]); continue; }
    if (el.localName === 'input' && !['checkbox', 'button', 'submit'].includes(input.type)) continue;
    const name = clean(el.getAttribute('aria-label') || (el.localName === 'input' ? (input.type === 'checkbox' ? labelOf(el) : input.value) : el.innerText) || el.getAttribute('title'));
    if (!name || name.split(' ').length > 12) continue;
    if (off.test(name)) out.push({ name, kind: 'off' });
    else if (extend.test(name) || phrase.test(name)) out.push({ name, kind: 'extend' });
  }
  for (const radios of groups.values()) {
    const texts = radios.map((r) => clean(r.labels?.[0]?.innerText || r.getAttribute('aria-label') || r.value));
    const times = texts.map((t) => ms(t)).filter((x): x is number => x !== null);
    const label = clean(radios[0]!.closest('fieldset')?.querySelector('legend')?.textContent || radios[0]!.closest('[role="radiogroup"]')?.getAttribute('aria-label'));
    if (times.length < 2 || !(adjust.test(label) || times.length === texts.filter((t) => !none.test(t)).length)) continue;
    const on = radios.findIndex((r) => r.checked);
    const chosen = on >= 0 ? ms(texts[on]!) : null;
    out.push({ name: label || 'a choice of durations', kind: 'adjust', options: times, ...(chosen !== null ? { chosen } : {}), none: texts.some((t) => none.test(t) && ms(t) === null) });
  }
  return out;
}

/** One time limit on what was typed. */
/** What a press shows when it took the entry (review r1 F7b): an acknowledgement of what was typed. */
export const ENTRY_ACK = /\b(thanks?|thank you|received|sent|submitted|saved|recorded|got your)\b/i;

export interface EntryLimit {
  /** What started the timer. */
  start: 'load' | 'typing' | 'press';
  /** The button pressed (start = press). */
  press?: string;
  /** The limit: the time from its start to the timer run that took the text. */
  ms: number;
  /** The limit was found by moving the clock in steps: it lies between `afterMs` and `ms`. */
  afterMs?: number;
  effect: 'cleared' | 'locked' | 'removed';
  /** The field's name and its path. */
  field: string;
  path?: string;
  /** A button to extend that showed before the limit, and how long it leaves (`slackMs`: how exact that is, for a countdown read tick by tick). */
  warning?: { text: string; leavesMs?: number; slackMs?: number };
  /** A sign on the page that the limit may be real-time or essential (`ENTRY_EXCEPTION`): the words found. */
  exception?: string;
  /** The field was taken away with nothing found in its place, while another enabled field holds the same text. */
  moved?: boolean;
  /** Locked only as part of the page made inert (under a dialog that is open, or anything else in front of it; review r1 F7a). */
  covered?: boolean;
  /** Locked at the moment the page sent a request that the test held back: the lock may only last until the answer comes. */
  waiting?: boolean;
  /** The text was typed before the press, and the press took it (acknowledged it, or changed the field; review r1 F7b). */
  used?: boolean;
  /** Locked while a dialog is open that the same timer showed (a box that switches the form off behind it while it asks). */
  dialog?: boolean;
  /** A repeating timer took the text and went on running afterwards (it did not end itself). */
  goesOn?: boolean;
  /**
   * The limit may follow the time of day, not the visit (batch 17): it was found only by moving the page's clock
   * more than an hour ahead, its timer's delay is no round number (worked out from the clock), or the form says
   * when it closes (`ENTRY_CLOCK`: the words found).
   */
  clock?: string;
}

const secs = (ms: number) => (ms < 120_000 ? `${Math.round(ms / 100) / 10} s` : ms < 7_200_000 ? `${Math.round(ms / 6000) / 10} min` : `${Math.round(ms / 360_000) / 10} h`);
const quote = (s: string, n = 60) => `“${s.length > n ? `${s.slice(0, n - 1)}…` : s}”`;

/** A button that came with a warning and whose whole name is words of extending or staying ("Continue", "Stay signed in", "Yes"). */
export function isExtendName(name: string): boolean {
  const words = name.toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 4 && words.every((w) => EXTEND_VOCAB.includes(w)) && !/^(the|my|me|in|off|time|minutes|session|timer|countdown)$/.test(words.join(' '));
}

/** The verdict (pure): the limit found, and the controls the page offers for it. */
export function entryFindings(limit: EntryLimit | null, controls: readonly EntryControl[], info: { fields: number; ran: number; pressed: number; incomplete?: boolean }): ProbeFinding[] {
  if (!info.fields) return [{ criterion: '2.2.1', status: 'not_applicable', detail: 'no empty text field on this page to type into, so no time limit on what a visitor enters could be looked for' }];
  if (!limit && info.incomplete) {
    // The timers were not all run: "none of them took the text" would claim more than was seen.
    return [{ criterion: '2.2.1', status: 'not_testable', detail: `the page's timers could not be run to the end (${info.ran} timer runs were made, and a timer here fires faster than the test can follow), so a time limit set for later could not be ruled out` }];
  }
  if (!limit) {
    return [{ criterion: '2.2.1', status: 'no_failures_found', detail: `typed into ${info.fields} text field${info.fields === 1 ? '' : 's'}${info.pressed ? ` and pressed ${info.pressed} button${info.pressed === 1 ? '' : 's'}` : ''}, then ran the page's timers early (${info.ran} run${info.ran === 1 ? '' : 's'}): none of them cleared, locked or removed what was typed` }];
  }
  const started = limit.start === 'load' ? 'after the page loads' : limit.start === 'typing' ? 'after typing starts' : `after ${quote(limit.press ?? 'a button', 40)} is pressed`;
  const did = limit.effect === 'cleared' ? 'clears what was typed into' : limit.effect === 'locked' ? 'locks' : 'takes away';
  const what = `${limit.afterMs !== undefined ? `between ${secs(limit.afterMs)} and ${secs(limit.ms)}` : secs(limit.ms)} ${started}, the page ${did} ${quote(limit.field, 40)}`;
  const target = limit.path ? { target: limit.path } : {};
  const ok = (how: string): ProbeFinding[] => [{ criterion: '2.2.1', status: 'no_failures_found', ...target, detail: `time limit found (${what}); ${how}` }];
  const off = controls.find((c) => c.kind === 'off' || (c.kind === 'adjust' && c.none));
  if (off) return ok(`the page lets the visitor turn it off (${quote(off.name, 40)})`);
  const extend = controls.find((c) => c.kind === 'extend');
  const leaves = limit.warning?.leavesMs;
  const short = extend && leaves !== undefined && leaves + (limit.warning?.slackMs ?? 0) < ENTRY_LIMITS.extendMs;
  if (extend && !short) return ok(`the page offers ${quote(extend.name, 40)}${leaves !== undefined ? `, with ${secs(leaves)} to press it` : ''}`);
  const adjust = controls.find((c) => c.kind === 'adjust' && c.options?.length);
  const base = adjust ? adjust.chosen ?? limit.ms : 0;
  const max = adjust ? Math.max(...adjust.options!) : 0;
  if (adjust && (base <= 0 || max >= base * ENTRY_LIMITS.adjustTimes)) return ok(`the visitor can set it up to ${secs(max)} (${quote(adjust.name, 40)}), at least ten times the default`);
  // The field is gone, but another field holds the very text that was typed: the page may have moved it there
  // (a replacement the test could not tie to the field by id, name, label or place). Not a loss it can show.
  if (limit.moved) {
    return [{ criterion: '2.2.1', status: 'not_testable', ...target, detail: `${what}, but another field on the page now holds the same text: whether the page moved what was typed there or took it away could not be told` }];
  }
  if (limit.covered) {
    return [{ criterion: '2.2.1', status: 'not_testable', ...target, detail: `${what}, but only as part of the page made inert (as under a dialog that is open): closing what is in front of it may give the field back, which the test did not try` }];
  }
  if (limit.waiting) {
    return [{ criterion: '2.2.1', status: 'not_testable', ...target, detail: `${what}, at the moment it sent a request that the test held back (nothing is sent to the site): the field may be locked only until the answer comes, as while a draft is saved` }];
  }
  if (limit.dialog) {
    return [{ criterion: '2.2.1', status: 'not_testable', ...target, detail: `${what}, but only while a dialog with a button to answer it is showing: answering the dialog may give the field back, which the test did not try` }];
  }
  if (limit.clock) {
    return [{ criterion: '2.2.1', status: 'not_testable', ...target, detail: `${what}, but ${limit.clock}: this may be a time of day (opening hours, a closing time, a deadline) and not a limit counted from the visit, which the test cannot tell apart by moving the page's clock` }];
  }
  if (limit.goesOn) {
    return [{ criterion: '2.2.1', status: 'not_testable', ...target, detail: `${what}, but the timer that did it repeats and went on running afterwards: the page may do this over and over (a refresh of what it shows), which is no limit counted from the visit, and the test cannot tell the two apart` }];
  }
  if (limit.used) {
    return [{ criterion: '2.2.1', status: 'not_testable', ...target, detail: `${what}, but the text was typed before ${quote(limit.press ?? 'the button', 40)} was pressed and the press took it (it acknowledged it or changed the field): the entry may have been used, so whether an entry still being worked on was taken away could not be told` }];
  }
  // 2.2.1's exceptions: a limit that is part of a real-time event, or essential to the activity, is allowed.
  // The page shows a sign of one, and the test cannot tell whether it holds: no failure.
  if (limit.exception) {
    return [{ criterion: '2.2.1', status: 'not_testable', ...target, detail: `${what}, and nothing turns the limit off, adjusts it or extends it in time. But the page says ${quote(limit.exception, 40)}: a time limit that is part of a real-time event or essential to the activity is allowed, and whether this one is could not be told` }];
  }
  const why: string[] = [];
  if (short) why.push(`${quote(extend!.name, 30)} shows ${secs(leaves!)} before that, which is all the time there is to press it: a visitor has to be given at least 20 seconds to extend a limit`);
  if (adjust) why.push(`the limit can be set (${quote(adjust.name, 40)}) to at most ${secs(max)}, ${Math.round((max / base) * 10) / 10} times the default ${secs(base)}: an adjustable limit has to reach at least ten times the default`);
  if (why.length) return [{ criterion: '2.2.1', status: 'failed', ...target, detail: `${what}. ${why.join('; ')}. Nothing else turns this time limit off, adjusts it or extends it` }];
  return [{ criterion: '2.2.1', status: 'failed', ...target, detail: `${what}; nothing on the page turns this time limit off, adjusts it or extends it` }];
}

/** Types, presses and runs the page's timers early (see the top of this file). */
export async function runTimingEntry(ctx: ProbeContext): Promise<ProbeFinding[]> {
  const { page } = ctx;
  const L = ENTRY_LIMITS;
  if (!page.keyboard) throw new ProbeNotTestable('the browser cannot send key presses, which this test needs');
  const late = () => ctx.signal.aborted || Date.now() > ctx.deadline - L.reserveMs;
  const wait = (ms: number) => page.waitForTimeout(ms);
  const clock = async () => {
    const c = await page.evaluate(entryNow, { key: KEY });
    if (!c) throw new ProbeNotTestable('the page\'s timers could not be listed (the test\'s hook did not load in this page)');
    return c;
  };
  let controls: EntryControl[] = [];
  /** Adds the limit controls on the page now. */
  const moreControls = async (): Promise<void> => {
    const now = await page.evaluate(entryControls, { off: ENTRY_OFF, extend: ENTRY_EXTEND, adjust: ENTRY_ADJUST, phrase: LIMIT_CONTROL }).catch(() => [] as EntryControl[]);
    controls = [...controls, ...now.filter((c) => !controls.some((x) => x.name === c.name && x.kind === c.kind))];
  };
  const fields: EntryField[] = [];
  const typed = new Set<number>();
  /** Types into the empty fields that are there now; returns how many it typed into. */
  const typeNew = async (): Promise<number> => {
    let n = 0;
    for (const f of await page.evaluate(entryFields, { key: KEY, max: L.fields, captcha: ENTRY_CAPTCHA })) {
      fields[f.i] = f;
      if (late() || !(await page.evaluate(entryFocus, { key: KEY, i: f.i }))) continue;
      await page.keyboard!.type(f.number ? ENTRY_NUMBER : ENTRY_TEXT);
      typed.add(f.i);
      n++;
    }
    if (n) await wait(L.settleMs);
    return n;
  };
  let ran = 0;
  /**
   * Not every timer due in the 20 hours was run: the last run to that horizon stopped at its cap (a later run
   * to the horizon that finishes makes up for an earlier one that did not: the schedule is one).
   */
  let incomplete = false;
  /**
   * Runs the page's timers due by `until` (`entryRun`) and returns the limit that took the typed text, or
   * `gone` when the text was taken by something that is not judged. `from`: the time the limit counts
   * from (the page's clock), by the timer its chain began with.
   */
  const examine = async (from: (lost: NonNullable<EntryRun['lost']>) => { start: EntryLimit['start']; at: number }, until: number, settle: boolean, fresh: boolean, budgetMs: number, press?: string, used?: { typed: ReadonlySet<number>; changed: boolean }): Promise<{ limit: EntryLimit | null; gone: boolean; capped?: boolean }> => {
    const mark = ctx.guard.mark();
    const before = await pendingTimeouts(page);
    const r = await page.evaluate(entryRun, { key: KEY, until, settle, fresh, events: L.events, budgetMs, extend: ENTRY_EXTEND, vocab: EXTEND_VOCAB, leave: LEAVE_BUTTON });
    ran += r.events;
    const lost = r.lost;
    // `capped`: the timers due by `until` were not all run (the cap on runs or on time).
    if (!lost) return { limit: null, gone: false, capped: r.capped };
    const origin = from(lost);
    const ms = lost.at - origin.at;
    // What a script clears in its first seconds is its start-up; a timer of 1 s or more that repeats and
    // takes the text on its first run is a refresh, not a countdown. Neither is judged.
    if (ms < L.minMs || (lost.repeat && lost.runs < 2 && lost.delay >= 1000)) return { limit: null, gone: true };
    // The same refresh made of timeouts that each set the next (batch 17): the first of its chain the test ran
    // emptied the field and set itself again. A countdown's chain runs many times before it ends.
    if (lost.effect === 'cleared' && lost.rearmed && lost.chain < 2 && lost.delay >= 1000) return { limit: null, gone: true };
    await wait(L.settleMs);
    // A lock has to last (batch 17): a page that switches a field off for a moment while it saves or checks
    // something gives it back by itself. The page's timers of the next 3 s are run (they run only when the test
    // runs them), what they started gets a moment, and the field is looked at again.
    let waiting = false;
    if (lost.effect === 'locked') {
      const more = await page.evaluate(entryRun, { key: KEY, until: lost.at + L.lockHoldMs, settle: true, fresh: false, events: 2000, budgetMs: 600, extend: ENTRY_EXTEND, vocab: EXTEND_VOCAB, leave: LEAVE_BUTTON }).catch(() => null);
      if (more) ran += more.events;
      await wait(L.settleMs);
      const now = await page.evaluate(entryField, { key: KEY, i: lost.field }).catch(() => null);
      if (now && !now.gone && !now.off && now.v !== '') return { limit: null, gone: false, capped: !!more?.capped };
      // Still locked (Sol r1 S6): shown to stay so only when the field could be read, the follow-up ran, and either no
      // one-off timer the page set meanwhile is still to run, or those of the next minute were run too and the field
      // is still locked (a lock a timer gives back, after a save or a check, is no limit).
      if (!more || !now) throw new ProbeNotTestable(LOCK_UNSURE);
      const after = await pendingTimeouts(page);
      if (!before || !after) throw new ProbeNotTestable(LOCK_UNSURE);
      if (after.some((h) => !before.includes(h))) {
        const later = await page.evaluate(entryRun, { key: KEY, until: lost.at + L.lockReleaseMs, settle: true, fresh: false, events: 4000, budgetMs: 1500, extend: ENTRY_EXTEND, vocab: EXTEND_VOCAB, leave: LEAVE_BUTTON }).catch(() => null);
        if (later) ran += later.events;
        await wait(L.settleMs);
        const then = await page.evaluate(entryField, { key: KEY, i: lost.field }).catch(() => null);
        if (then && !then.gone && !then.off && then.v !== '') return { limit: null, gone: false, capped: !!later?.capped };
        if (!later || later.capped || !then) throw new ProbeNotTestable(LOCK_UNSURE);
      }
      // Still locked, and the page sent something at that moment that the test held back: it may be waiting for the answer.
      waiting = ctx.guard.since(mark).some((e) => e.kind === 'blocked' && !e.mainFrame);
    }
    await moreControls();
    const f = fields[lost.field];
    const limit: EntryLimit = { start: origin.start, ...(press && origin.start === 'press' ? { press } : {}), ms: ms >= 10_000 ? Math.round(ms / 1000) * 1000 : ms, effect: lost.effect, field: f?.name || 'a text field', ...(f?.path ? { path: f.path } : {}), ...(lost.moved ? { moved: true } : {}) };
    // Typed before the press that started the timer, and the press itself changed the page (review r1 F7b).
    if (origin.start === 'press' && used?.changed && used.typed.has(lost.field)) limit.used = true;
    if (lost.dialog) limit.dialog = true;
    if (waiting) limit.waiting = true;
    if (lost.goesOn) limit.goesOn = true;
    // Counted from the page's load by one timer whose delay is no whole number of seconds: worked out from the
    // clock ("until five o'clock"), not a length of time someone chose.
    if (origin.start === 'load' && !lost.repeat && lost.runs === 1 && lost.chain === 1 && lost.delay >= 60_000 && lost.delay % 1000 !== 0) limit.clock = `its timer was set for ${secs(lost.delay)} (${lost.delay} ms, no round length of time)`;
    if (origin.start === 'load' && !limit.clock) {
      const when = await page.evaluate(entrySigns, { key: KEY, i: lost.field, words: ENTRY_CLOCK, near: true }).catch(() => '');
      if (when) limit.clock = `the page says ${quote(when, 50)} by the field`;
    }
    if (r.warn) {
      const leavesMs = Math.round((lost.at - r.warn.at) / 100) * 100;
      limit.warning = { text: r.warn.name, leavesMs, slackMs: 2 * Math.max(r.warn.tick, lost.repeat ? lost.delay : 0) };
      // The button may be gone again once the limit has run out: it still was the way to extend.
      if (!controls.some((c) => c.kind === 'extend')) controls = [...controls, { name: r.warn.name, kind: 'extend' }];
    }
    const sign = await page.evaluate(entrySigns, { key: KEY, i: lost.field, words: ENTRY_EXCEPTION }).catch(() => '');
    if (sign) limit.exception = sign;
    return { limit, gone: false };
  };
  const state = () => page.evaluate(entryState, { key: KEY });
  /** A typed field that held its text at `a` and has lost it at `b`. */
  const lostBetween = (a: EntryState, b: EntryState) => [...typed].find((i) => {
    const x = a.fields[i];
    const y = b.fields[i];
    return !!x && !!y && x.v !== '' && !x.gone && !x.off && (y.gone || y.off || y.v === '');
  });

  let limit: EntryLimit | null = null;
  let pressed = 0;
  try {
    // No press may save a file.
    if (!(await page.evaluate(stopDownloads, DOWNLOAD_STOP_KEY).catch(() => false))) throw new ProbeNotTestable('the test could not make sure that no press saves a file on this page');
    // Sets the test's clock and timer list up; the timers pending now were set while the page loaded.
    await page.evaluate(entryFields, { key: KEY, max: 0 });
    // What the page says now: a sign of a real-time or essential limit may be gone once the limit has run out.
    await page.evaluate(entrySaid, { key: KEY }).catch(() => 0);
    const began = Date.now();
    await clock();
    await state();
    const typing = (await clock()).now;
    let gone = false;
    if (await typeNew()) {
      // A short timer that re-arms itself goes through the test's list from its next run on.
      await wait(Math.max(0, L.rearmMs - (Date.now() - began)));
      await moreControls();
      const from = (lost: { origin: 'load' | 'input' }) => (lost.origin === 'load' ? { start: 'load' as const, at: 0 } : { start: 'typing' as const, at: typing });
      let prev = await state();
      let last = 0;
      // One budget for all the sweeps: the early ones use little, the last one (to 20 hours) what is left.
      let left: number = L.loadBudgetMs;
      for (const [n, to] of L.sweep.entries()) {
        if (late() || left <= 0) { incomplete = true; break; }
        // The timers due by this step, at their times; then the page's own short ticks, with the clock at the step.
        const t0 = Date.now();
        const got = await examine(from, to, true, n === 0, left);
        left -= Date.now() - t0;
        incomplete = !!got.capped;
        if (got.limit || got.gone) { limit = got.limit; gone = got.gone; break; }
        await wait(L.sweepWaitMs);
        const st = await state();
        const stay = st.buttons.find((b) => isExtendName(b) || new RegExp(ENTRY_EXTEND, 'i').test(b));
        if (stay && !controls.some((c) => c.kind === 'extend')) controls = [...controls, { name: stay, kind: 'extend' }];
        const lost = lostBetween(prev, st);
        if (lost !== undefined) {
          gone = true;
          // Gone by the first step: a script's start-up, not a limit.
          if (to <= L.minMs) break;
          const f = st.fields[lost]!;
          if (!f.gone && f.v !== '' && !f.covered) {
            // A lock has to last (as in `examine`): the page's timers of the next 3 s, then another look.
            const pend0 = await pendingTimeouts(page);
            const more = await page.evaluate(entryRun, { key: KEY, until: to + L.lockHoldMs, settle: true, fresh: false, events: 2000, budgetMs: 600, extend: ENTRY_EXTEND, vocab: EXTEND_VOCAB, leave: LEAVE_BUTTON }).catch(() => null);
            if (more) ran += more.events;
            await wait(L.sweepWaitMs);
            const now = await page.evaluate(entryField, { key: KEY, i: lost }).catch(() => null);
            if (now && !now.gone && !now.off && now.v !== '') { gone = false; prev = await state(); last = to; continue; }
            // Shown to stay locked, as in `examine` (Sol r1 S6).
            if (!more || !now) throw new ProbeNotTestable(LOCK_UNSURE);
            const pend1 = await pendingTimeouts(page);
            if (!pend0 || !pend1) throw new ProbeNotTestable(LOCK_UNSURE);
            if (pend1.some((h) => !pend0.includes(h))) {
              const later = await page.evaluate(entryRun, { key: KEY, until: to + L.lockReleaseMs, settle: true, fresh: false, events: 4000, budgetMs: 1500, extend: ENTRY_EXTEND, vocab: EXTEND_VOCAB, leave: LEAVE_BUTTON }).catch(() => null);
              if (later) ran += later.events;
              await wait(L.sweepWaitMs);
              const then = await page.evaluate(entryField, { key: KEY, i: lost }).catch(() => null);
              if (then && !then.gone && !then.off && then.v !== '') { gone = false; prev = await state(); last = to; continue; }
              if (!later || later.capped || !then) throw new ProbeNotTestable(LOCK_UNSURE);
            }
          }
          await moreControls();
          limit = { start: 'load', ms: to, afterMs: last, effect: f.gone ? 'removed' : f.v === '' ? 'cleared' : 'locked', field: fields[lost]?.name || 'a text field', ...(fields[lost]?.path ? { path: fields[lost]!.path } : {}), ...(f.moved ? { moved: true } : {}), ...(!f.gone && f.v !== '' && f.covered ? { covered: true } : {}) };
          const sign = await page.evaluate(entrySigns, { key: KEY, i: lost, words: ENTRY_EXCEPTION }).catch(() => '');
          if (sign) limit.exception = sign;
          // Found by moving the clock more than an hour ahead: a time of day (closing hours) looks the same from here.
          if (to > 3_600_000) limit.clock = `it was found only by moving the page's clock ${secs(to)} ahead`;
          else {
            const when = await page.evaluate(entrySigns, { key: KEY, i: lost, words: ENTRY_CLOCK, near: true }).catch(() => '');
            if (when) limit.clock = `the page says ${quote(when, 50)} by the field`;
          }
          break;
        }
        prev = st;
        last = to;
      }
    }
    if (!limit && !gone && !late()) {
      const buttons = await page.evaluate(entryButtons, { key: KEY, max: L.buttons, action: ACTION_NAME });
      for (const b of buttons) {
        if (late()) break;
        const before = await clock();
        // What was typed before this press, and the page as it was (to tell whether the press itself changed it).
        const typedBefore = new Set(typed);
        const pre = await state().catch(() => null);
        if (!(await page.evaluate(entryPress, { key: KEY, i: b.i }))) continue;
        await page.keyboard.press('Enter');
        pressed++;
        await wait(L.pressMs);
        const post = await state().catch(() => null);
        // The press used the entry (review r1 F7b): it changed a field typed before it (cleared, locked or took it
        // away: a reset, a closed box), or what it showed acknowledges it ("Thanks", "Sent", "Received"). A press
        // that only moves on (a next step, more fields) leaves the entry being worked on: judged as before.
        const changed = !pre || !post || ENTRY_ACK.test(post.fresh)
          || [...typedBefore].some((i) => pre.fields[i]?.v !== post.fields[i]?.v || pre.fields[i]?.gone !== post.fields[i]?.gone || pre.fields[i]?.off !== post.fields[i]?.off);
        const used = { typed: typedBefore, changed };
        await page.evaluate(entrySaid, { key: KEY }).catch(() => 0);
        const known = new Set(before.timers);
        const from = (lost: { origin: 'load' | 'input'; root: number }) => (lost.origin === 'load' ? { start: 'load' as const, at: 0 } : known.has(lost.root) ? { start: 'typing' as const, at: typing } : { start: 'press' as const, at: before.now });
        // The test runs the page's timers itself by now: what the press set for the next moment (a field shown
        // after a short delay) is run first, so the field is there to type into.
        if (typed.size || (await clock()).timers.some((h) => !known.has(h))) {
          const soon = await examine(from, before.now + L.pressRunMs, true, true, L.runBudgetMs, b.name, used);
          if (soon.limit || soon.gone) { limit = soon.limit; break; }
          if (soon.capped) incomplete = true;
        }
        await typeNew();
        if (!typed.size) continue;
        if (!(await clock()).timers.some((h) => !known.has(h))) continue;
        await moreControls();
        // Everything the press started is on the test's list: run to the end of the 20 hours in one go.
        const got = await examine(from, before.now + TWENTY_HOURS_MS, false, false, L.runBudgetMs, b.name, used);
        limit = got.limit;
        if (limit || got.gone) break;
        incomplete = !!got.capped;
      }
    }
  } finally {
    await page.evaluate((key: string) => {
      const W = window as unknown as Record<string, { undo?: () => void } | undefined>;
      try { W[key]?.undo?.(); } catch { /* the page is not used again */ }
      delete W[key];
    }, KEY).catch(() => {});
    await page.evaluate(undoDownloadStop, DOWNLOAD_STOP_KEY).catch(() => {});
  }
  ctx.setData?.({ v: 1, limit, controls: controls.map((c) => ({ name: c.name, kind: c.kind })) });
  return entryFindings(limit, controls, { fields: typed.size, ran, pressed, incomplete });
}

const LOCK_UNSURE = 'a field with typed text was switched off when one of the page\'s timers ran and was still off 3 s later, but the page\'s timers of the next minute could not all be run, or the field could not be read again: whether it stays locked could not be told';

/** One-off timers of 1 s or more pending on the page (Sol r1 S6): one a run set that is still to run may give a field back. */
function pendingTimeouts(page: PageLike): Promise<number[] | null> {
  // Longer than the 3 s follow-up (those it ran already), up to the minute run after it: a tick of a countdown or a
  // refresh chain is shorter and gives nothing back.
  return page.evaluate((min: number) => {
    const list = (window as unknown as { __grntedPending?: () => { handle: number; kind: string; delay: number }[] }).__grntedPending;
    return typeof list === 'function' ? list().filter((p) => p.kind === 'timeout' && p.delay > min && p.delay <= 60_000).map((p) => p.handle) : null;
  }, ENTRY_LIMITS.lockHoldMs).catch(() => null);
}

/**
 * A time limit on what a visitor enters (2.2.1), deep: types, presses up to three plain buttons and
 * runs the page's timers early. Listed, not scored, until the gold standard verifies it (docs/scoring.md).
 */
export const timingEntryProbe: PageProbe = {
  id: ENTRY_PROBE_ID,
  criteria: ['2.2.1'],
  waitFor: { content: true },
  kind: 'interaction',
  tier: 'deep',
  scored: false,
  // Room for the maxima: 4 s of timer runs after the load and the typing, 5 s per press, about 4 s of fixed waits.
  timeoutMs: 30_000,
  // It types into the page's fields and presses its buttons: a page of its own, and nothing is sent.
  isolate: true,
  sendsNothing: true,
  run: runTimingEntry,
};
