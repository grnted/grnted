// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Live announcements: what a screen reader says while people use the page, in the two flows screen-
// reader users meet most: opening a menu (a button with aria-expanded) and submitting a form with its
// fields empty. The form flow is the forms test's own empty attempt (its in-page agent and its judge,
// `judgeAttempt`), so both tests read errors the same way; this pass adds what would be spoken: live
// region and alert text, where focus moves, and the browser's own validation messages. The network is
// shut for the whole run (`sendsNothing`): nothing is sent, and the page is never reused.
// Findings: 4.1.3 a status shown that is not announced, 3.3.1 an error not tied to its field (both as
// the forms test judges them), and 4.1.2 for a toggle whose state the page does not keep (2026-11-10):
// a button that opens what it controls (aria-controls, or the hidden block right after it) while it
// still says it is collapsed; a toggle button (aria-pressed) that switches something next to it on and
// back off while it goes on saying "not pressed"; and a button that shows and hides a block, with no
// change of its name, that never says whether it is open (no aria-expanded at any time). The names are the
// ones the browser computes (the accessibility tree); a name that changes with the press says the state.
// Every press lands on the button found first, by reference; a toggle is activated at most twice.
// Engine core: no Node-only imports.
import type { LiveLine, ProbeFinding, SrLiveData } from '../../types.js';
import { formFacts, formTarget, judgeAttempt, validationSkip, FORMS_CAPS, FORMS_WAITS, dropSelfChanging } from '../forms.js';
import { callFormsAgent, installFormsAgent, type CollectedMessage, type CollectResult, type ScannedField, type ScannedForm, type ScannedPage } from '../formsPage.js';
import { axContentOf, axNameOf } from '../axName.js';
import { ProbeNotTestable, type PageProbe, type ProbeContext } from '../types.js';
import { LIVE_WORDS, speak, type Voice } from './rules.js';
import { withoutDownloads } from '../pressSafely.js';

export const SCREEN_READER_LIVE_PROBE_ID = 'screen-reader-live';
export const SCREEN_READER_LIVE_CRITERIA = ['3.3.1', '4.1.2', '4.1.3'] as const;

export const LIVE_LIMITS = {
  /** Toggle buttons pressed per page (menu and disclosure buttons, pressed-state toggles). */
  menus: 4,
  /** Activations of one toggle at most: one press, and one more to put it back when the first changed something. */
  presses: 2,
  /** Forms submitted empty per page. */
  forms: 2,
  /** Wait after pressing a menu button (ms). */
  menuWait: 300,
  /** Lines kept for the report. */
  lines: 30,
  /** Time kept back at the end of the run (ms). */
  reserve: 1_500,
} as const;

/** Where the page keeps the toggles the test presses, by reference (`findToggles`). */
const TOGGLES_KEY = '__grntedLiveToggles';
/**
 * Requests whose completion a page's script cannot observe at all (a ping, a beacon): refusing one changes nothing the
 * script could tell afterwards. Every other request can: an image or a stylesheet has a load event a script can wait
 * for (it can write the toggle's state there), a font has the font set's events (Sol review of batch 17, S5).
 */
const ANSWERLESS: ReadonlySet<string> = new Set(['ping', 'beacon']);

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
type Gone = { gone: true };
const isGone = (x: unknown): x is Gone => !!x && typeof x === 'object' && (x as Gone).gone === true;

/** A disclosure button as found in the page. */
export interface Disclosure { path: string; name: string }
/** Its state before or after a press. */
export interface DisclosureState { expanded: string | null; shown: boolean; ok: boolean }

/** Runs in the page (self-contained): visible, enabled buttons with aria-expanded="false" that control something on the page. */
export function findDisclosures(max: number): Disclosure[] {
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && document.querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      if (!parent) { parts.unshift(esc(cur.localName)); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${esc(cur.localName)}:nth-of-type(${same.indexOf(cur) + 1})` : esc(cur.localName));
    }
    return parts.join(' > ');
  };
  const out: Disclosure[] = [];
  const all = document.querySelectorAll('button[aria-expanded="false"], [role="button"][aria-expanded="false"]');
  for (let k = 0; k < all.length && out.length < max; k++) {
    const el = all[k] as HTMLElement;
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue;
    if (el.closest('form')) continue;
    const controls = (el.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean);
    if (!controls.length || !controls.every((id) => document.getElementById(id))) continue;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || s.visibility === 'hidden' || s.display === 'none') continue;
    const name = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    out.push({ path: cssPath(el), name });
  }
  return out;
}

/** Runs in the page (self-contained): the button's aria-expanded, and whether everything it controls is shown. */
export function disclosureState(path: string): DisclosureState {
  const el = document.querySelector(path);
  if (!el) return { expanded: null, shown: false, ok: false };
  const ids = (el.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean);
  const targets = ids.map((id) => document.getElementById(id)).filter((x): x is HTMLElement => !!x);
  const shown = targets.length > 0 && targets.every((t) => {
    if (typeof t.checkVisibility === 'function' && !t.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    const r = t.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2 && /[\p{L}\p{N}]/u.test(t.innerText ?? '');
  });
  return { expanded: el.getAttribute('aria-expanded'), shown, ok: true };
}

/** A button whose state the live test presses to hear. */
export interface Toggle {
  path: string;
  name: string;
  /** What it says of itself: aria-expanded="false", aria-pressed="false", or neither (a button that may show and hide a block). */
  kind: 'expanded' | 'pressed' | 'bare';
}

/** A toggle's state, read before and after a press. */
export interface ToggleState {
  ok: boolean;
  expanded: string | null;
  pressed: string | null;
  /** aria-selected, aria-checked or aria-haspopup is set: another pattern's state. */
  other: boolean;
  /**
   * Its accessible name as the browser computes it (the accessibility tree: aria-labelledby, aria-label, its
   * content, a title). Undefined when the browser did not give one: a name the test cannot read proves nothing.
   */
  name: string | undefined;
  /** Focus is on it. */
  focused: boolean;
  /** It has a block it shows and hides (its aria-controls targets, or the block right after it), and whether all of it is shown. */
  panel: boolean;
  panelShown: boolean;
  /** That block is a dialog, a menu, a list box, a tooltip or a tab panel (other patterns, with other states). */
  panelOther: boolean;
  /** What is shown around it (its parent's markup, the button's own aria-pressed and aria-expanded left out), as a hash. */
  around: string;
  /** How the button itself looks: its own markup (those two attributes left out) and its colours, weight and outline, as a hash. */
  own: string;
  /**
   * The text seen on screen around it (its parent's, the button's own left out; at most 600 characters), and what
   * assistive technology is given in the same place, read from the browser's accessibility tree (`told`: the names,
   * values and descriptions of every node there that the tree does not ignore, an image's text alternative, an
   * aria-label and shadow content included, then their roles and states; `toldText`: the content alone; Sol review of
   * batch 17, S4). Absent where they could not be read (and in states read before 2026-11-12). A state the page shows
   * only in text that is seen and not told is `toggleVerdict`'s 'hidden-state'.
   */
  seen?: string;
  told?: string;
  toldText?: string;
  /** There is more text around the button than `seen` and `told` hold: they are not compared. */
  cut?: boolean;
  /** It has a description of its own (aria-describedby or aria-details), which may tell its state from elsewhere on the page. */
  described?: boolean;
}

/**
 * Runs in the page (self-contained): visible, enabled buttons (native or role="button") that cannot send a
 * form, in the order the test presses them: toggle buttons (aria-pressed="false"), collapsed ones
 * (aria-expanded="false"), then buttons with neither that control a hidden block (aria-controls, or the hidden
 * block right after them).
 */
export function findToggles(arg: number | { max: number; key: string }): Toggle[] {
  const max = typeof arg === 'number' ? arg : arg.max;
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && document.querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      if (!parent) { parts.unshift(esc(cur.localName)); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${esc(cur.localName)}:nth-of-type(${same.indexOf(cur) + 1})` : esc(cur.localName));
    }
    return parts.join(' > ');
  };
  const hiddenBlock = (el: Element | null): boolean => {
    if (!el || !/[\p{L}\p{N}]/u.test(el.textContent ?? '')) return false;
    const c = el as Element & { checkVisibility?: (o: object) => boolean };
    return typeof c.checkVisibility === 'function' ? !c.checkVisibility({ visibilityProperty: true }) : getComputedStyle(el).display === 'none';
  };
  const usable = (el: HTMLElement): boolean => {
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[aria-hidden="true"], [inert]')) return false;
    // Inside a form only a button that cannot send it: type="button", or an element with role="button".
    if (el.closest('form') && !(el.localName === 'button' ? (el as HTMLButtonElement).type === 'button' : el.localName !== 'input')) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width >= 2 && r.height >= 2 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const all: (Toggle & { el: Element; sig: string })[] = [];
  const seen = new Set<Element>();
  const take = (el: Element, kind: Toggle['kind']) => {
    if (all.length >= 200 || seen.has(el) || !usable(el as HTMLElement)) return;
    seen.add(el);
    const name = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    // Buttons of one make (a menu's five openers, a list's "more" buttons): the same kind, tag and classes.
    all.push({ path: cssPath(el), name, kind, el, sig: `${kind}|${el.localName}|${typeof el.className === 'string' ? el.className.trim().split(/\s+/).sort().join('.') : ''}` });
  };
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).slice(0, 2000);
  for (const el of buttons) if (el.getAttribute('aria-pressed') === 'false') take(el, 'pressed');
  for (const el of buttons) if (el.getAttribute('aria-expanded') === 'false') take(el, 'expanded');
  for (const el of buttons) {
    if (el.hasAttribute('aria-expanded') || el.hasAttribute('aria-pressed') || el.hasAttribute('aria-haspopup') || el.hasAttribute('aria-selected') || el.hasAttribute('aria-checked')) continue;
    if (el.localName === 'button' && (el as HTMLButtonElement).type !== 'button' && el.closest('form')) continue;
    // The browser's own disclosure: its state is kept on the details element, whatever role the summary carries.
    if (el.closest('details > summary')) continue;
    const ids = (el.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean);
    const targets = ids.map((id) => document.getElementById(id));
    const controls = targets.length > 0 && targets.every((t) => hiddenBlock(t));
    // The block right after it (after its heading or wrapper, when it is alone in one).
    let at: Element = el;
    while (!at.nextElementSibling && at.parentElement && at.parentElement !== document.body && (at.parentElement.textContent ?? '').trim() === (el.textContent ?? '').trim()) at = at.parentElement;
    if (controls || hiddenBlock(at.nextElementSibling)) take(el, 'bare');
  }
  // One of each make first (so a menu's openers do not use up every press), those in the main content before
  // the rest; then the others, in the same order.
  const firsts: typeof all = [];
  const rest: typeof all = [];
  const sigs = new Set<string>();
  for (const t of all) {
    if (sigs.has(t.sig)) rest.push(t);
    else { sigs.add(t.sig); firsts.push(t); }
  }
  const inMain = (t: { el: Element }) => (t.el.closest('main, [role="main"]') ? 0 : 1);
  firsts.sort((a, b) => inMain(a) - inMain(b));
  const picked = [...firsts, ...rest].slice(0, max);
  // The elements themselves, in the order returned: every later read and press goes to them by reference.
  if (typeof arg !== 'number') (window as unknown as Record<string, Element[]>)[arg.key] = picked.map((t) => t.el);
  return picked.map(({ path, name, kind }) => ({ path, name, kind }));
}

/** Runs in the page (self-contained): a toggle's state now. */
export function toggleState(at: string | { key: string; i: number }): ToggleState {
  const none: ToggleState = { ok: false, expanded: null, pressed: null, other: false, name: undefined, focused: false, panel: false, panelShown: false, panelOther: false, around: '', own: '' };
  const el = typeof at === 'string' ? document.querySelector(at) : (window as unknown as Record<string, Element[] | undefined>)[at.key]?.[at.i] ?? null;
  if (!el || !el.isConnected) return none;
  const shown = (t: Element): boolean => {
    const c = t as Element & { checkVisibility?: (o: object) => boolean };
    if (typeof c.checkVisibility === 'function' && !c.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    const r = t.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2 && /[\p{L}\p{N}]/u.test((t as HTMLElement).innerText ?? t.textContent ?? '');
  };
  const ids = (el.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean);
  let panels = ids.map((id) => document.getElementById(id)).filter((x): x is HTMLElement => !!x && !x.contains(el) && !el.contains(x));
  if (!panels.length) {
    let at: Element = el;
    while (!at.nextElementSibling && at.parentElement && at.parentElement !== document.body && (at.parentElement.textContent ?? '').trim() === (el.textContent ?? '').trim()) at = at.parentElement;
    const next = at.nextElementSibling as HTMLElement | null;
    if (next && /[\p{L}\p{N}]/u.test(next.textContent ?? '')) panels = [next];
  }
  const OTHER = /^(dialog|alertdialog|menu|menubar|listbox|tooltip|tabpanel|tree|grid)$/;
  const panelOther = panels.some((p) => p.localName === 'dialog' || p.hasAttribute('popover') || p.getAttribute('aria-modal') === 'true' || OTHER.test((p.getAttribute('role') ?? '').trim().toLowerCase()));
  // What is shown around it: its parent's markup without the button's own state attributes (FNV-1a).
  const scope = el.parentElement ?? el;
  const markup = scope.outerHTML.slice(0, 40_000).replace(/\saria-(?:pressed|expanded)="[^"]*"/g, '');
  let h = 2166136261;
  for (let i = 0; i < markup.length; i++) h = Math.imul(h ^ markup.charCodeAt(i), 16777619);
  // How the button itself looks: its own markup and the look a "switched on" style changes.
  const cs = getComputedStyle(el);
  // (A class or style attribute a script emptied again is the same as none.)
  const look = `${el.outerHTML.slice(0, 20_000).replace(/\saria-(?:pressed|expanded)="[^"]*"/g, '').replace(/\s(?:class|style)=""/g, '')}|${cs.backgroundColor}|${cs.backgroundImage}|${cs.color}|${cs.borderTopColor}|${cs.borderTopWidth}|${cs.fontWeight}|${cs.boxShadow}|${cs.textDecorationLine}|${cs.opacity}`;
  let o = 2166136261;
  for (let i = 0; i < look.length; i++) o = Math.imul(o ^ look.charCodeAt(i), 16777619);
  // The text around it as sighted people see it (the button's own text left out: its name is read from the
  // accessibility tree). What assistive technology is given there is read from that tree too, by the test
  // (`axContentOf`): a walk of the text nodes misses an image's text alternative, an aria-label, shadow content.
  let seen = '';
  // (Where there is more text around the button than the test compares, `cut` says so, and nothing is concluded.)
  let cut = false;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(), k = 0; n; n = walker.nextNode(), k++) {
    if (k >= 400 || seen.length > 600) { cut = true; break; }
    const t = (n.nodeValue ?? '').replace(/\s+/g, ' ').trim();
    const holder = n.parentElement;
    if (!t || !holder || el.contains(n) || holder.closest('script, style, template, noscript')) continue;
    const c = holder as Element & { checkVisibility?: (x: object) => boolean };
    // Not rendered at all: not seen.
    if (typeof c.checkVisibility === 'function' ? !c.checkVisibility({ visibilityProperty: true }) : getComputedStyle(holder).display === 'none') continue;
    let shownHere = typeof c.checkVisibility !== 'function' || c.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    for (let a: Element | null = holder, i = 0; shownHere && a && a !== scope.parentElement && i < 8; a = a.parentElement, i++) {
      const r = a.getBoundingClientRect();
      const st = getComputedStyle(a);
      if ((r.width < 2 || r.height < 2) && (st.overflow !== 'visible' || st.position === 'absolute')) shownHere = false;
      else if (/rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(st.clip) || /inset\(\s*(50%|100%)/.test(st.clipPath)) shownHere = false;
    }
    if (shownHere) seen += `${t} `;
  }
  if (seen.trim().length > 600) cut = true;
  return {
    ok: true,
    expanded: el.getAttribute('aria-expanded'),
    pressed: el.getAttribute('aria-pressed'),
    other: el.hasAttribute('aria-selected') || el.hasAttribute('aria-checked') || el.hasAttribute('aria-haspopup'),
    described: el.hasAttribute('aria-describedby') || el.hasAttribute('aria-details'),
    // Filled in from the accessibility tree by the test (`axNameOf`); never worked out here.
    name: undefined,
    focused: document.activeElement === el,
    panel: panels.length > 0,
    panelShown: panels.length > 0 && panels.every(shown),
    panelOther,
    around: `${markup.length}:${h >>> 0}`,
    own: `${look.length}:${o >>> 0}`,
    seen: seen.trim().slice(0, 600),
    ...(cut ? { cut: true } : {}),
  };
}

/** The words `after` shows that `before` did not (in order, at most 80 characters): what a press put on the screen. */
export function shownByPress(before: string, after: string): string {
  const had = new Map<string, number>();
  for (const w of before.split(' ')) if (w) had.set(w, (had.get(w) ?? 0) + 1);
  const out: string[] = [];
  for (const w of after.split(' ')) {
    if (!w) continue;
    const n = had.get(w) ?? 0;
    if (n > 0) had.set(w, n - 1);
    else out.push(w);
  }
  const text = out.join(' ');
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/**
 * Runs in the page (self-contained): puts focus on a held toggle, so that every read of how it looks (before
 * and after each press) is of the button with focus on it. False when it is gone or would not take focus.
 */
export function focusToggle(at: { key: string; i: number }): boolean {
  const el = (window as unknown as Record<string, HTMLElement[] | undefined>)[at.key]?.[at.i];
  if (!el || !el.isConnected) return false;
  el.focus();
  return document.activeElement === el;
}

/**
 * Runs in the page (self-contained): one activation of a held toggle, on the element itself (by reference, never
 * on whatever has focus): focus is put on it, then it is clicked once, as Enter or Space on a button does.
 * Null when the element is gone, disabled by now, or would not take focus (nothing is pressed then). Else the text
 * shown in the toggle's parent right before the click and right after it, read in the same turn of the page (the
 * click's handlers run inside `click()`; what they queue for the end of the turn, as some frameworks do, has run
 * after the two awaits): no timer of the page can run in between, so a difference is the press's own doing.
 */
export async function pressToggle(at: { key: string; i: number }): Promise<{ before: string; after: string } | null> {
  const el = (window as unknown as Record<string, HTMLElement[] | undefined>)[at.key]?.[at.i];
  if (!el || !el.isConnected || (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return null;
  el.focus();
  if (document.activeElement !== el) return null;
  const scope = el.parentElement ?? el;
  const shown = () => (scope.isConnected ? (scope.innerText ?? '') : '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  const before = shown();
  el.click();
  await Promise.resolve();
  await Promise.resolve();
  return { before, after: shown() };
}

/**
 * The words a press showed are not among the words assistive technology is given there: at least one of them is
 * hidden from it. (Words that are in the page for screen readers all the time and only become visible with the
 * press are told, pressed or not: another fault, and not this one.)
 */
function hiddenWords(shown: string, told: string): boolean {
  if (!shown) return false;
  const given = new Set(told.split(' '));
  return shown.split(' ').some((w) => w && !given.has(w));
}

/** What a toggle's two presses prove about its state (pure). `first` and `second`: after each press. */
export function toggleVerdict(kind: Toggle['kind'], before: ToggleState, first: ToggleState, second: ToggleState | null): 'stale-expanded' | 'stale-pressed' | 'hidden-state' | 'maybe-pressed' | 'no-state' | null {
  if (!before.ok || !first.ok) return null;
  // A name that changes with the press says the state (the button pattern's other way: "Mute" / "Unmute"), and
  // a name the browser did not give proves nothing: only a name read both times and found the same goes on.
  if (before.name === undefined || first.name === undefined || first.name !== before.name) return null;
  // It opened what it controls and still says collapsed.
  if (kind === 'expanded' && before.expanded === 'false' && first.expanded === 'false' && before.panel && !before.panelShown && first.panelShown) return 'stale-expanded';
  // It said "not pressed" throughout while a press changed something and the next press changed it back.
  if (kind === 'pressed' && before.pressed === 'false' && first.pressed === 'false' && second?.ok && second.pressed === 'false') {
    // The button itself looked switched on, then off again, with focus on it each time it was read (a look that
    // changes because focus left it is its focus style, not a state): it shows a state it does not tell.
    const focused = before.focused && first.focused && second.focused;
    if (focused && first.own !== before.own && second.own === before.own) return 'stale-pressed';
    // The page shows the state in text next to the button that only sighted people get (batch 17): a press puts
    // words on the screen beside it and the next press takes them away, while everything assistive technology is
    // given there (the button's "not pressed", its name, the content of the accessibility tree around it: text,
    // text alternatives, labels, states) stays exactly as it was, read all three times. What changes is seen and not
    // told, so it is no note a screen reader user could read.
    if (before.seen !== undefined && first.seen !== undefined && second.seen !== undefined
      && before.told !== undefined && first.told !== undefined && second.told !== undefined
      && !before.cut && !first.cut && !second.cut
      && first.seen !== before.seen && second.seen === before.seen && first.told === before.told && second.told === before.told
      // (A button with a description of its own may be told from there: the old candidate.)
      && !before.described && !first.described && hiddenWords(shownByPress(before.seen, first.seen), first.toldText ?? '')) return 'hidden-state';
    // Only what is next to it changed (a marker, a note that it could not be switched on), or its look changed
    // while focus was elsewhere: a candidate.
    if ((first.around !== before.around && second.around === before.around) || (first.own !== before.own && second.own === before.own)) return 'maybe-pressed';
  }
  // It shows and hides a block, its name stays the same, focus stays on it, and it never says open or closed.
  if (kind === 'bare' && second?.ok && before.panel && !before.panelOther && !before.panelShown && first.panelShown && !second.panelShown
    && [before, first, second].every((s) => s.expanded === null && s.pressed === null && !s.other)
    && first.focused) return 'no-state';
  return null;
}

/**
 * Runs in the page (self-contained): starts (or reads and restarts) a recorder of live-region and
 * alert text that changes. Regions count when they were on the page before the change, as screen
 * readers need (an alert counts also when it is added with its text, as NVDA and VoiceOver announce it).
 */
export function liveRecorder(op: 'start' | 'take'): { politeness: string; text: string }[] {
  type Rec = { observer: MutationObserver; heard: { politeness: string; text: string }[]; known: WeakSet<Element> };
  const W = window as unknown as { __grntedLive?: Rec };
  const SEL = '[aria-live], [role="alert"], [role="status"], [role="log"], output';
  const politeness = (el: Element): string => {
    const live = el.getAttribute('aria-live');
    if (live === 'off') return '';
    if (live) return live;
    return el.getAttribute('role') === 'alert' ? 'assertive' : 'polite';
  };
  if (op === 'start') {
    W.__grntedLive?.observer.disconnect();
    const known = new WeakSet<Element>();
    document.querySelectorAll(SEL).forEach((el) => known.add(el));
    const heard: Rec['heard'] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        const node = r.target.nodeType === 1 ? (r.target as Element) : r.target.parentElement;
        const region = node?.closest(SEL) ?? null;
        const added = [...r.addedNodes].filter((n): n is Element => n.nodeType === 1);
        const alerts = added.flatMap((a) => [a, ...a.querySelectorAll('[role="alert"]')].filter((x) => x.matches('[role="alert"]')));
        for (const el of [...(region ? [region] : []), ...alerts]) {
          if (!known.has(el) && el.getAttribute('role') !== 'alert') continue;
          const p = politeness(el);
          const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
          if (p && text && !heard.some((h) => h.text === text) && heard.length < 20) heard.push({ politeness: p, text });
        }
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    W.__grntedLive = { observer, heard, known };
    return [];
  }
  const rec = W.__grntedLive;
  if (!rec) return [];
  const out = rec.heard.splice(0);
  return out;
}

/** Spoken lines and findings for one empty-submit attempt, from the forms judge and what it collected. Pure. */
export function formLines(form: ScannedForm, byRef: ReadonlyMap<number, ScannedField>, obs: CollectResult, judged: ReturnType<typeof judgeAttempt>, voice: Voice): { lines: LiveLine[]; findings: ProbeFinding[] } {
  const action = `${form.submitter ? `pressed ${clip(form.submitter.label, 60)}` : 'submitted the form'} with the fields empty`;
  const lines: LiveLine[] = [];
  const findings = judged.findings.filter((f) => f.criterion === '3.3.1' || f.criterion === '4.1.3');
  const failed = new Set(findings.map((f) => f.criterion));
  const field = (ref: number) => byRef.get(ref);
  // Messages tied to the field focus lands on (aria-describedby, aria-errormessage, its label): a screen reader
  // says them with the field, as its description, so they are heard.
  const spokenWithFocus = new Set<CollectedMessage>();
  if (obs.focusMoved && obs.active.to === 'field') {
    const f = field(obs.active.ref);
    const role = f?.type === 'checkbox' ? 'checkbox' : f?.type === 'radio' ? 'radio' : f?.type === 'select' ? 'combobox' : 'textbox';
    const invalid = obs.marks.some((m) => m.ref === obs.active.ref && m.aria) || obs.invalid.some((i) => i.ref === obs.active.ref);
    for (const m of obs.messages) if (m.assoc.includes(obs.active.ref)) spokenWithFocus.add(m);
    const description = [...spokenWithFocus].map((m) => clip(m.text)).join(' ');
    lines.push({ flow: 'form', action, heard: true, text: speak(voice, { role, name: f?.label || obs.active.label, states: [...(invalid ? ['invalid'] : []), ...(f?.required ? ['required'] : [])], ...(description ? { description } : {}) }) });
  }
  for (const e of judged.errors.filter((x) => x.source === 'browser')) lines.push({ flow: 'form', action, heard: true, text: clip(e.text) });
  for (const a of obs.announcements) lines.push({ flow: 'form', action, heard: true, text: clip(a) });
  for (const m of obs.messages) {
    if (m.live || m.focus || spokenWithFocus.has(m) || obs.announcements.some((a) => a.includes(m.text) || m.text.includes(a))) continue;
    const criterion = failed.has('4.1.3') ? '4.1.3' : failed.has('3.3.1') && m.near >= 0 && !m.assoc.length && !m.names.length ? '3.3.1' : undefined;
    // Tied to a field focus did not reach: said with that field when the user gets there.
    const tied = m.assoc.map(field).find((f) => f?.label);
    lines.push({ flow: 'form', action, heard: false, text: clip(m.text), ...(tied ? { withField: clip(tied.label, 80) } : {}), ...(criterion ? { criterion } : {}) });
  }
  if (!lines.length) lines.push({ flow: 'form', action, heard: false, text: voice === 'nvda' ? LIVE_WORDS.nothing.nvda : LIVE_WORDS.nothing.voiceover });
  return { lines, findings };
}

/** The live pass on one page. */
export async function runScreenReaderLive(ctx: ProbeContext, voice: Voice = 'nvda'): Promise<ProbeFinding[]> {
  const page = ctx.page;
  const left = () => ctx.deadline - Date.now();
  const wait = (ms: number) => page.waitForTimeout(ms);
  const findings: ProbeFinding[] = [];
  const lines: LiveLine[] = [];
  let menus = 0;
  let forms = 0;

  // Toggles: press each one, hear its new state, press it again (which also puts it back). Every read and
  // press goes to the element found first, by reference; a toggle is activated at most `LIVE_LIMITS.presses`
  // times (once, and once more only when the first press changed something), so at most
  // `menus` × `presses` = 8 activations a page.
  const found = await page.evaluate(findToggles, { max: LIVE_LIMITS.menus, key: TOGGLES_KEY }).catch(() => [] as Toggle[]);
  const changed = (a: ToggleState, b: ToggleState) => a.expanded !== b.expanded || a.pressed !== b.pressed || a.panelShown !== b.panelShown || a.around !== b.around || a.name !== b.name;
  /** The toggle's state now, with the name the browser computes for it. */
  const read = async (i: number): Promise<ToggleState | null> => {
    const s = await page.evaluate(toggleState, { key: TOGGLES_KEY, i }).catch(() => null);
    if (!s?.ok) return s;
    const held = `window[${JSON.stringify(TOGGLES_KEY)}] && window[${JSON.stringify(TOGGLES_KEY)}][${i}]`;
    // (Never past the test's own time: a name not given in what is left is a name not given.)
    const name = await axNameOf(ctx, held, Math.min(1_500, Math.max(0, left() - LIVE_LIMITS.reserve)));
    // What assistive technology is given in the toggle's parent, from the accessibility tree (Sol review of batch 17,
    // S4); not read in time, or not at all: unknown, and the hidden state is not concluded.
    const told = await axContentOf(ctx, `(${held}) ? ((${held}).parentElement || (${held})) : null`, Math.min(1_500, Math.max(0, left() - LIVE_LIMITS.reserve)));
    return { ...s, name, ...(told ? { told: told.all, toldText: told.text, ...(told.cut ? { cut: true } : {}) } : {}) };
  };
  for (let i = 0; i < found.length; i++) {
    const d = found[i]!;
    if (left() < LIVE_LIMITS.reserve * 3 || ctx.signal.aborted) break;
    // Focus first, so the button is read with focus on it every time (its focus style is not a state).
    await page.evaluate(focusToggle, { key: TOGGLES_KEY, i }).catch(() => false);
    const before = await read(i);
    if (!before?.ok) continue;
    await page.evaluate(liveRecorder, 'start').catch(() => []);
    const mark = ctx.guard.mark();
    let activations = 0;
    /** What was shown beside the toggle right before and right after each activation (`pressToggle`). */
    const pressed: { before: string; after: string }[] = [];
    /** One activation of the toggle itself, then its state. */
    const press = async (): Promise<ToggleState | null> => {
      if (activations >= LIVE_LIMITS.presses) return null;
      activations++;
      const done = await page.evaluate(pressToggle, { key: TOGGLES_KEY, i }).catch(() => null);
      if (!done) return null;
      pressed.push(done);
      await wait(LIVE_LIMITS.menuWait);
      return read(i);
    };
    const first = await press();
    // A press that tried to leave the page (held by the guard) ends the flow.
    if (ctx.guard.since(mark).some((e) => e.kind === 'navigation' || e.kind === 'dialog')) break;
    const heard = await page.evaluate(liveRecorder, 'take').catch(() => []);
    if (!first?.ok) continue;
    menus++;
    // Press it again: back to where it was (the page is never reused, this also keeps the next test fair).
    const second = changed(before, first) ? await press() : null;
    let verdict = toggleVerdict(d.kind, before, first, second);
    // Words that show and go by themselves beside a button (a blinking label, a ticker) are no state. The hidden
    // state stands only when each press itself changed what is shown there: read around the click in one turn of
    // the page (the click's own handlers and what they queue for the same turn), where no timer of the page can
    // run. The first press showed words, the second put back exactly what was there, and nothing else changed it
    // between the two (batch 17).
    const [p1, p2] = pressed;
    const byPress = !!p1 && !!p2 && p1.after !== p1.before && p2.before === p1.after && p2.after === p1.before && !!shownByPress(p1.before, p1.after);
    if (verdict === 'hidden-state' && !byPress) verdict = 'maybe-pressed';
    // A press that asked the site for something the test did not let through (it never sends a visitor's choice
    // to a server) may tell its state once the answer comes, as it would for a real visitor: what the button says
    // without that answer proves nothing (review of batch 17). That holds for any request a script can see finish:
    // a picture or a style sheet has a load event the script may write the state in (Sol review of batch 17, S5).
    // Only a ping or a beacon, which no script can follow, is left out.
    const asked = ctx.guard.since(mark).some((e) => e.kind === 'blocked' && !ANSWERLESS.has(e.resourceType ?? ''));
    const unanswered = asked && (verdict === 'hidden-state' || verdict === 'stale-pressed');
    if (unanswered) verdict = 'maybe-pressed';
    // The browser gave no name (no accessibility tree to ask, or no answer in time): what the presses would
    // prove with a name that stays the same is not proven. Said, never clean.
    const unnamed = !verdict && (before.name === undefined || first.name === undefined) && !!toggleVerdict(d.kind, { ...before, name: '' }, { ...first, name: '' }, second);
    const name = before.name ?? d.name;
    const action = `pressed ${clip(name || 'a button', 60)}`;
    const states = d.kind === 'pressed' ? (first.pressed === 'true' ? ['pressed'] : []) : first.expanded === 'true' ? ['expanded'] : first.expanded === 'false' ? ['collapsed'] : [];
    lines.push({ flow: 'menu', action, heard: true, text: speak(voice, { role: 'button', name: first.name ?? name, states }), ...(verdict ? { criterion: '4.1.2' } : {}) });
    for (const h of heard) lines.push({ flow: 'menu', action, heard: true, text: clip(h.text) });
    const button = `the button ${name ? `“${clip(name, 60)}”` : 'with no name'}`;
    if (unanswered) {
      findings.push({ criterion: '4.1.2', status: 'not_testable', target: d.path, detail: `while ${button} was pressed the page asked the site for something, which the test never sends for a visitor; the button tells screen readers “not pressed” without the answer, and whether it tells its state once the site answers could not be checked` });
    } else if (verdict === 'stale-expanded') {
      findings.push({ criterion: '4.1.2', status: 'failed', target: d.path, detail: `Pressing ${button} opens what it controls, but it still tells screen readers it is collapsed` });
    } else if (verdict === 'stale-pressed') {
      findings.push({ criterion: '4.1.2', status: 'failed', target: d.path, detail: `Pressing ${button} switches it on and pressing it again switches it off (the button itself changes how it looks, and changes back), but it tells screen readers “not pressed” the whole time (aria-pressed stays "false")` });
    } else if (verdict === 'hidden-state' && !heard.length) {
      findings.push({ criterion: '4.1.2', status: 'failed', target: d.path, detail: `Pressing ${button} shows “${shownByPress(before.seen ?? '', first.seen ?? '')}” next to it and pressing it again takes that away, so the page shows whether it is switched on; but that text is hidden from screen readers (aria-hidden or inert), and the button tells them “not pressed” the whole time (aria-pressed stays "false")` });
    } else if (verdict === 'maybe-pressed' || verdict === 'hidden-state') {
      findings.push({ criterion: '4.1.2', status: 'not_testable', target: d.path, detail: `pressing ${button} changes the page next to it and pressing it again changes it back, while it tells screen readers “not pressed” the whole time and looks the same: whether what changes is its own state (switched on) or something else (a note, a count) could not be told` });
    } else if (unnamed) {
      findings.push({ criterion: '4.1.2', status: 'not_testable', target: d.path, detail: `the browser gave no accessible name for ${button} when it was pressed, so whether its name tells its state could not be checked` });
    } else if (verdict === 'no-state') {
      findings.push({ criterion: '4.1.2', status: 'failed', target: d.path, detail: `Pressing ${button} shows a block and pressing it again hides it, but it never tells screen readers whether it is open: it has no aria-expanded, and its name stays the same` });
    }
  }
  await page.evaluate((key: string) => { delete (window as unknown as Record<string, unknown>)[key]; }, TOGGLES_KEY).catch(() => {});

  // Forms: the forms test's empty attempt, main page only.
  let installed = false;
  try { installed = (await page.evaluate(installFormsAgent, FORMS_CAPS)) === true; } catch { installed = false; }
  const call = async <T>(op: string, arg?: unknown): Promise<T | Gone> => {
    try { return (await page.evaluate(callFormsAgent, { op, arg })) as T | Gone; } catch { return { gone: true }; }
  };
  let fieldsSeen = 0;
  let skipped = 0;
  let realForms = 0;
  if (installed && !isGone(await call('record'))) {
    const scanned = await call<ScannedPage>('scan');
    if (!isGone(scanned)) {
      fieldsSeen = scanned.fields.length;
      const byRef = new Map(scanned.fields.map((f) => [f.ref, f]));
      for (const form of scanned.forms) {
        if (forms >= LIVE_LIMITS.forms || left() < LIVE_LIMITS.reserve + FORMS_WAITS.submit * 2 || ctx.signal.aborted) break;
        if (form.search || form.kind === 'loose') continue;
        realForms++;
        const fx = formFacts(form, scanned.fields);
        if (!fx.own.some((f) => f.shown && !f.disabled && !f.readOnly) || validationSkip(form, fx)) { skipped++; continue; }
        await call('restore', { form: form.index });
        await call('observe', { form: form.index });
        const mark = ctx.guard.mark();
        if (await call<boolean>('arm', { form: form.index }) !== true) continue;
        await call('submit', { form: form.index, button: form.submitter?.ref ?? -1 });
        await wait(FORMS_WAITS.submit);
        const obs = await call<CollectResult>('collect');
        if (isGone(obs)) break;
        await dropSelfChanging(call, obs);
        const judged = judgeAttempt(form, byRef, obs, ctx.guard.since(mark), 'empty');
        if (judged.outcome !== 'client') { skipped++; continue; }
        forms++;
        const r = formLines(form, byRef, obs, judged, voice);
        lines.push(...r.lines);
        findings.push(...r.findings.map((f) => ({ ...f, target: f.target ?? formTarget(form) })));
        await call('restore', { form: form.index });
      }
    }
  }

  ctx.setData?.({ v: 1, voice, lines: lines.slice(0, LIVE_LIMITS.lines), menus, forms } satisfies SrLiveData);
  const has = (c: string) => findings.some((f) => f.criterion === c);
  // Toggle buttons found and none pressed and read (gone, disabled, out of time): not looked at, never clean.
  if (!menus && found.length && !has('4.1.2')) findings.push({ criterion: '4.1.2', status: 'not_testable', detail: `${found.length === 1 ? 'a toggle button was' : `${found.length} toggle buttons were`} found on this page, but none could be pressed and read in the time the test has` });
  if (!menus && !has('4.1.2')) findings.push({ criterion: '4.1.2', status: 'not_applicable', detail: 'no toggle button on this page (a button with aria-expanded or aria-pressed, or one that shows and hides a block)' });
  for (const c of ['3.3.1', '4.1.3']) {
    if (has(c)) continue;
    if (forms) findings.push({ criterion: c, status: 'no_failures_found', detail: 'error messages of a form submitted empty checked' });
    else if (!fieldsSeen) findings.push(c === '4.1.3' ? { criterion: c, status: 'not_testable', detail: 'status messages are tested through the messages of a form, and this page has no form fields', nothingToTest: true } : { criterion: c, status: 'not_applicable', detail: 'no form fields on this page' });
    else if (!realForms) findings.push({ criterion: c, status: 'not_testable', detail: 'only search forms and fields outside forms here, which have no error messages to test', nothingToTest: true });
    else findings.push({ criterion: c, status: 'not_testable', detail: skipped ? 'no form on this page showed its own error messages when submitted empty' : 'no form on this page could be submitted in the test' });
  }
  if (!installed && !menus) throw new ProbeNotTestable('the live announcement test could not start on this page');
  return findings;
}

/** Live announcements (core, every sampled page; listed, not scored, until calibrated). Network shut. */
export const screenReaderLiveProbe: PageProbe = {
  id: SCREEN_READER_LIVE_PROBE_ID,
  criteria: [...SCREEN_READER_LIVE_CRITERIA],
  kind: 'interaction',
  tier: 'core',
  scored: false,
  timeoutMs: 15_000,
  sendsNothing: true,
  // It presses toggle buttons and submits forms: nothing it presses may save a file (`withoutDownloads`).
  run: withoutDownloads((ctx) => runScreenReaderLive(ctx)),
};
