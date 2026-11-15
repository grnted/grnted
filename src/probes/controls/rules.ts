// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The controls test's decisions (`./index.ts`): pure functions over what the in-page kit measured, so
// every rule is unit-tested. Engine core: no Node-only imports.
import type { ProbeFinding } from '../../types.js';
import type { GuardEvent } from '../types.js';
import type { ControlCandidate, Effect, Message, Opened, ShortcutSource } from './page.js';

export const CONTROLS_LIMITS = {
  /** Controls pressed per page. */
  candidates: 8,
  /** Search and filter fields typed into per page. */
  fields: 1,
  /** Wait after a key press or a click before the page is compared (plus two animation frames). */
  settleMs: 220,
  /** How long the page is watched, with nothing pressed, for changes of its own. */
  idleMs: 160,
  /** Wait after the pointer moves onto a control (hover content is part of the baseline). */
  hoverMs: 100,
  /**
   * Before a click-only control fails (batch 17): the pointer leaves for `hoverAwayMs` (what hovering showed hides
   * again), then rests on it again without clicking for `hoverMs + hoverShowMs`: content that waits a moment before
   * it shows on hover (a tooltip) shows then too, and was no effect of the click.
   */
  hoverAwayMs: 900,
  hoverShowMs: 700,
  /** How long more the page is given to return to how it was before the click once the pointer left (Sol r1 S7). */
  hoverRestoreMs: 2500,
  /** Wait after focus is set (focus handlers are part of the baseline). */
  focusMs: 60,
  /**
   * After a press whose change cannot be tied to the press's own events: how long the page is watched
   * for changes of its own (at least; at most, while waiting for the intervals that ran to run again).
   */
  quietMs: 400,
  quietMaxMs: 2500,
  /** Keys a control names for itself (aria-keyshortcuts, accesskey, "press F2") that are tried on it. */
  shortcuts: 4,
  /**
   * Other controls with the same name or target that are looked at, and how many of them are pressed. One that
   * was found and not pressed may be the one that does the same: with any left, the control is not testable.
   */
  alternatives: 12,
  alternativesPressed: 2,
  /** Tab presses after a control opened a dialog, menu or layer: one of them must land in it (F85). */
  tabs: 3,
  /** Tab presses when looking for a focus loop in what a control opened. */
  trapTabs: 12,
  /** Longest focus loop recognised there. */
  maxCycle: 6,
  /** Time for examining one focus loop (the ways out). */
  trapMs: 9000,
  /** Soft budget for the whole page, and the time kept back before the time box ends. */
  budgetMs: 30_000,
  reserveMs: 3000,
  /** Findings kept per criterion and page. */
  perCriterion: 6,
} as const;

/**
 * Words of a status message (WCAG 4.1.3: the success or result of an action, a waiting state, progress,
 * an error): a short text a press shows that says the action happened, how many results there are,
 * that something is in progress, or that something went wrong. Phrases, not topics: a paragraph about
 * "application status" is not one. Matched on short texts only (`Message`), never on content a control
 * shows and hides (`DISCLOSURE_NAME`, `Message.ofOpened`).
 */
export const STATUS_TEXT = [
  // The action happened.
  String.raw`\b(saved|added|removed|deleted|updated|copied|sent|submitted|received|subscribed|unsubscribed|applied|cleared|uploaded|completed?|success(ful|fully)?|confirmed|registered|booked|reserved|scheduled|cancell?ed|refreshed|selected|chosen|thank you|thanks)\b`,
  String.raw`\b(is|are|was|were|has been|have been)\s+(now\s+)?(ready|available|saved|added|sent|updated|removed|selected|turned (on|off)|enabled|disabled)\b`,
  String.raw`\b(now\s+)?(un)?available\b|\bturned (on|off)\b`,
  // Results.
  String.raw`\b(no|\d[\d,.]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(\w+\s+){0,2}(results?|match(es|ing)?|items?|records?|rows?|entries|entry|found|listings?|events?|documents?|locations?|options?)\b`,
  String.raw`\b(showing|displaying|sorted by|filtered by|results for|nothing found|not found)\b`,
  // Waiting and progress.
  String.raw`\b(loading|searching|sending|saving|processing|uploading|refreshing|please wait|in progress)\b`,
  // Errors.
  String.raw`\b(error|invalid|failed|could ?n[o’']t|unable to|try again|incorrect|(is|are) required|expired)\b`,
].join('|');

/**
 * Names of controls that show and hide content (a disclosure, a menu): what they show is content, not
 * a status message. Also a name that ends in a question mark (an FAQ's question).
 */
export const DISCLOSURE_NAME = String.raw`\b(show|hide|more|less|details?|expand|collapse|open|close|view|toggle|menu|read|learn|see|about|help|info|information|what|why|how|faq|question)\b|\?\s*$`;

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const quote = (s: string, n = 80) => `“${clip(s, n)}”`;

/** What a press changed, in words (for a finding's detail). */
export function effectWords(e: Effect): string {
  if (e.url) return `changes the address to ${clip(e.url, 100)}`;
  if (e.shown && e.text) return `shows ${quote(e.text)}`;
  if (e.textChange?.to) return e.textChange.from ? `changes ${quote(e.textChange.from, 60)} to ${quote(e.textChange.to, 60)}` : `shows ${quote(e.textChange.to)}`;
  if (e.shown) return e.shown === 1 ? 'shows new content' : `shows ${e.shown} new pieces of content`;
  if (e.hidden) return e.hidden === 1 ? 'hides content' : `hides ${e.hidden} pieces of content`;
  if (e.textChange) return `removes ${quote(e.textChange.from, 60)}`;
  if (e.values) return `changes the value of ${e.values === 1 ? 'a form field' : `${e.values} form fields`}`;
  if (e.own) return e.own;
  if (e.focus) return `moves keyboard focus to ${e.focus.name ? quote(e.focus.name, 60) : clip(e.focus.path, 80)}`;
  return 'changes the page';
}

/**
 * Whose change it is, for a change seen after a press:
 * - `press`: scripts made it while the press's own events were dispatched (`Effect.direct`);
 * - `unknown`: a one-off timer of 1 s or more ran in the same moment: it may have been the timer's;
 * - `watch`: anything else is settled by watching the page (`quiet`) and comparing again without what
 *   changed by itself (`rediff`): what is left is the press's.
 * A page that changes by itself (a carousel, a clock, a pop-up on a timer) never passes for the press.
 */
export function changeOwner(e: Effect): 'press' | 'unknown' | 'watch' {
  if (e.direct) return 'press';
  return e.timeouts > 0 ? 'unknown' : 'watch';
}

/** What one press did. */
export interface Did {
  what: string;
  /** The address a held navigation went to. */
  url?: string;
  /** The page itself changed (not only a request or a navigation the guard stopped). */
  page: boolean;
}

const real = (events: readonly GuardEvent[]) => events.filter((e) => e.kind !== 'websocket' && e.kind !== 'frame' && e.cause !== 'background');

/**
 * What a key press did, or null. Anything counts: a change scripts made to the page, a navigation or a
 * request the guard stopped, a new window, a browser dialog, the address. Liberal on purpose: a key that
 * does anything at all is a control that answers the keyboard.
 */
export function keyDid(e: Effect | null, events: readonly GuardEvent[]): Did | null {
  if (e?.changed) return { what: effectWords(e), page: true };
  const ev = real(events)[0];
  if (!ev) return null;
  if (ev.kind === 'navigation') return { what: `goes to ${clip(ev.url ?? 'another page', 100)}`, ...(ev.url ? { url: ev.url } : {}), page: false };
  if (ev.kind === 'popup') return { what: 'opens a new window', page: false };
  if (ev.kind === 'dialog') return { what: `opens a browser ${ev.dialog ?? 'alert'} dialog`, page: false };
  return { what: 'starts a request', page: false };
}

/**
 * What a mouse click did, or null. Strict on purpose (a click that "did something" while the keys did
 * nothing is a failure): content shown, hidden or changed by a script, a form value, the control's own
 * state, the address, a navigation the guard held, a new window or a browser dialog. A blocked request
 * alone is not counted (the page may have made it by itself), nor is focus that only moved.
 */
export function clickDid(e: Effect | null, events: readonly GuardEvent[]): Did | null {
  // Focus that only moves is not a function of its own: Tab moves focus too.
  if (e && (e.shown || e.hidden || e.textChange || e.values || e.own || e.url)) return { what: effectWords(e), page: true };
  const evs = real(events);
  const nav = evs.find((x) => x.kind === 'navigation');
  if (nav) return { what: `goes to ${clip(nav.url ?? 'another page', 100)}`, ...(nav.url ? { url: nav.url } : {}), page: false };
  if (evs.some((x) => x.kind === 'popup')) return { what: 'opens a new window', page: false };
  const dialog = evs.find((x) => x.kind === 'dialog');
  if (dialog) return { what: `opens a browser ${dialog.dialog ?? 'alert'} dialog`, page: false };
  return null;
}

const MODIFIER: Record<string, string> = { ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt', opt: 'Alt', shift: 'Shift', cmd: 'Meta', command: 'Meta', meta: 'Meta' };
const NAMED_KEY: Record<string, string> = {
  enter: 'Enter', return: 'Enter', space: 'Space', spacebar: 'Space', esc: 'Escape', escape: 'Escape', tab: 'Tab',
  delete: 'Delete', del: 'Delete', backspace: 'Backspace', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  plus: '+', minus: '-', slash: '/', period: '.', comma: ',',
};
const KEY_WORD = String.raw`f\d{1,2}|enter|return|space(?:bar)?|delete|del|backspace|home|end|page ?up|page ?down|(?:arrow ?)?(?:up|down|left|right)|plus|minus|slash|period|comma|[a-z0-9]|[/?.,;=\[\]\\]`;
const MOD_WORD = 'ctrl|control|alt|option|opt|shift|cmd|command|meta';

/**
 * One shortcut as Playwright writes it ("Control+m", "F2"), and what the test does with it: `press` it;
 * `tried` (Enter and Space are pressed on every control anyway; Tab only moves focus); or `never` (the
 * browser or the operating system takes it: the Meta key, closing, reloading, printing or saving the tab,
 * the history, the developer tools). null: not a key the test knows.
 */
function oneShortcut(mods: readonly string[], raw: string): { key: string; kind: 'press' | 'tried' | 'never' } | null {
  const word = raw.replace(/\s+/g, '').toLowerCase();
  const key = /^f([1-9]|1[0-2])$/.test(word) ? word.toUpperCase() : NAMED_KEY[word] ?? ([...word].length === 1 ? word : '');
  const set = [...new Set(mods.map((m) => MODIFIER[m.toLowerCase()] ?? ''))];
  if (!key || set.includes('')) return null;
  const order = ['Control', 'Alt', 'Shift', 'Meta'].filter((m) => set.includes(m));
  const combo = [...order, key].join('+');
  const has = (m: string) => order.includes(m);
  if (/^(Enter|Space|Tab|Shift\+Tab)$/.test(combo)) return { key: combo, kind: 'tried' };
  const never = has('Meta')
    || /^F(5|11|12)$/.test(key)
    || (has('Control') && !has('Alt') && (/^[wqtnrpsojhdlu]$/.test(key) || /^(F4|Tab|PageUp|PageDown)$/.test(key)))
    || (has('Control') && has('Shift') && (/^[a-z]$/.test(key) || key === 'Delete'))
    || (has('Alt') && !has('Control') && /^(F4|ArrowLeft|ArrowRight|Home)$/.test(key));
  return { key: combo, kind: never ? 'never' : 'press' };
}

/** The keys a control names for itself: the ones the test presses, the ones it never presses, and how many it has no room for. */
export interface ShortcutPlan { press: string[]; never: string[]; more: number }

/**
 * The keys a control names for itself, in the order they are tried (at most `max`): its aria-keyshortcuts,
 * its accesskey (with the modifiers browsers use for it), and what the texts tied to it say ("Press F2",
 * "Ctrl+M", "shortcut: M", "(Esc)", "use the arrow keys"). Understanding 2.1.1 allows any key: a control
 * that names one is tried with it before it is said to answer the pointer only, and a named key that was
 * not tried (`never`: one the browser takes, or one an instruction names that the test cannot read; `more`)
 * leaves the control not testable. Instructions are read in any case ("press m", "Press F2"). A word in a
 * text only ever adds a key press or a doubt; it never makes a failure.
 */
export function shortcutPlan(src: ShortcutSource, max: number = CONTROLS_LIMITS.shortcuts): ShortcutPlan {
  const press: string[] = [];
  const never: string[] = [];
  /** `shown`: how the key is named when it is not pressed (as the page wrote it, for a declared one). */
  const add = (mods: readonly string[], key: string, shown?: string, declared = false) => {
    const k = oneShortcut(mods, key);
    if (!k) { if (declared && shown && !never.includes(shown)) never.push(shown); return; }
    if (k.kind === 'press' && !press.includes(k.key)) press.push(k.key);
    if (k.kind === 'never' && !never.includes(shown ?? k.key)) never.push(shown ?? k.key);
  };
  for (const sc of src.aria.split(/\s+/)) {
    if (!sc) continue;
    const parts = sc.split('+');
    // "Control++": the key is the plus sign.
    const plus = sc.endsWith('++') || sc === '+';
    add(plus ? parts.slice(0, -2) : parts.slice(0, -1), plus ? '+' : parts[parts.length - 1]!, sc.slice(0, 30), true);
  }
  for (const ch of src.access.split(/\s+/)) {
    if ([...ch].length !== 1) continue;
    add(['alt'], ch);
    add(['ctrl', 'alt'], ch);
  }
  const combo = new RegExp(String.raw`(?<![a-z0-9])((?:(?:${MOD_WORD})\s*[+-]\s*)+)(${KEY_WORD})(?![a-z0-9])`, 'gi');
  // An instruction names its key in any case: "Press M to…", "press m to…", "press f2".
  const pressed = new RegExp(String.raw`\b(?:press(?:ing|es)?|hit(?:ting)?)\s+(?:the\s+)?(?:letter\s+)?(?:["“'‘]([^\s"”'’])["”'’]|(f\d{1,2}|[a-z0-9/?])(?=\s+(?:keys?|to|for)\b|\s*[.,;:)]|\s*$)|(delete|del|backspace|home|end|page ?up|page ?down)\b)`, 'gi');
  // A key an instruction names that the test cannot read: a combination with a part it does not know
  // ("Press Fn+M"), or a word before "key" that is no key it knows ("Press the star key").
  const instructedCombo = /\b(?:press(?:ing|es)?|hit(?:ting)?)\s+(?:the\s+)?((?:[a-z]+\s*\+\s*)+[a-z0-9]+)/gi;
  const instructedKey = /\b(?:press(?:ing|es)?|hit(?:ting)?)\s+(?:the\s+)?([^\s.,;:()"“”'‘’+]{1,20})\s+keys?\b/gi;
  const NO_KEY = /^(a|an|any|that|this|these|those|each|either|every|one|another|same|other|both|which|what|your|its|arrow|arrows|shortcut|access|hot|following|correct|next|keyboard)$/i;
  // "Shortcut: G", "shortcut is G", "shortcut key G", "shortcut (G)". Something has to stand between the word and
  // the key: the word "shortcuts" itself, or a word that follows it ("shortcuts I use"), names none.
  const named = /\b(?:keyboard\s+)?(?:shortcut|hot ?key|access ?key)s?\b\s*(?:[:=]|\bis\b|\bkey\b:?|(?=[(["“'‘]))\s*[(["“'‘]?(F\d{1,2}|[A-Za-z0-9/?])[)\]"”'’]?(?![A-Za-z0-9+-])/gi;
  const arrows = /\b(?:(left|right|up|down)(?:\s*(?:and|or|\/|,)\s*(?:left|right|up|down))*\s+arrows?(?:\s+keys?)?|arrow\s+keys?)\b/i;
  // The Escape key by its name as a key ("Esc", "press Escape", "(Escape)"), not the word in a sentence.
  const escape = /\bEsc\b|\bESC\b|\b[Ee]scape\s+key\b|\b(?:[Pp]ress(?:ing|es)?|[Hh]it(?:ting)?)\s+(?:the\s+)?[Ee]scape\b|\([Ee]scape\)/;
  for (const t of src.texts) {
    for (const m of t.matchAll(combo)) add(m[1]!.split(/[+-]/).map((x) => x.trim()).filter(Boolean), m[2]!);
    for (const m of t.matchAll(/(?<![A-Za-z0-9+-])F([1-9]|1[0-2])(?![A-Za-z0-9])/g)) add([], `F${m[1]}`);
    for (const m of t.matchAll(pressed)) {
      // "Press a key to go on": the article, not the key A.
      if (m[2] && /^a$/i.test(m[2]) && /^\s+keys?\b/i.test(t.slice(m.index + m[0].length))) continue;
      add([], m[1] ?? m[2] ?? m[3]!);
    }
    for (const m of t.matchAll(instructedCombo)) {
      const parts = m[1]!.split('+').map((x) => x.trim());
      const shown = parts.join('+').slice(0, 30);
      if (!oneShortcut(parts.slice(0, -1), parts[parts.length - 1]!) && !never.includes(shown)) never.push(shown);
    }
    for (const m of t.matchAll(instructedKey)) if (!NO_KEY.test(m[1]!)) add([], m[1]!, m[1]!.slice(0, 30), true);
    for (const m of t.matchAll(named)) add([], m[1]!);
    if (escape.test(t)) add([], 'escape');
    const a = arrows.exec(t);
    if (a) for (const k of a[1] && /^(up|down)$/i.test(a[1]) ? ['down', 'right'] : ['right', 'down']) add([], k);
  }
  return { press: press.slice(0, max), never: never.slice(0, 4), more: Math.max(0, press.length - max) };
}

/** The keys a control names for itself that the test presses (`shortcutPlan`). */
export const shortcutKeys = (src: ShortcutSource, max: number = CONTROLS_LIMITS.shortcuts): string[] => shortcutPlan(src, max).press;

/**
 * Whether a press on another control (`b`) did what a click did (`a`): it went to the same address, or it
 * showed, hid and changed at least everything the click did (`Effect.where`), or it changed the clicked
 * control's own state the same way. `unknown`: the click left nothing on the page to compare (a new
 * window, a browser dialog).
 */
export function sameEffect(a: { did: Did; effect: Effect | null }, b: { did: Did; effect: Effect | null }): 'same' | 'different' | 'unknown' {
  const bare = (u?: string) => (u ? u.split('#')[0] : undefined);
  const ua = a.did.url ?? a.effect?.url;
  const ub = b.did.url ?? b.effect?.url;
  if (ua) return ub !== undefined && (ua === ub || (bare(ua) === bare(ub) && !a.did.page)) ? 'same' : 'different';
  const wa = a.effect?.where ?? [];
  if (wa.length) {
    const wb = new Set(b.effect?.where ?? []);
    return wa.every((w) => wb.has(w)) ? 'same' : 'different';
  }
  if (a.effect?.own) return a.effect.own === b.effect?.own ? 'same' : 'different';
  return 'unknown';
}

/** The outcome of pressing one control with the keyboard and, when the keys did nothing, the mouse. */
export type Operation =
  /** A key did something: the control answers the keyboard. */
  | { kind: 'keys'; key: string; did: Did }
  /**
   * No key did anything and a click did: the failure. `keys`: the keys the control names for itself, which
   * did nothing either; `others`: the other controls that were tried and do not do the same.
   */
  | { kind: 'pointer-only'; did: Did; keys?: string[]; others?: string[] }
  /** A click did something the keys do not, and there is a keyboard way to the same thing. */
  | { kind: 'equivalent'; did: Did; how: string }
  /**
   * A click did something Enter and Space do not, and whether the keyboard reaches the same thing another
   * way could not be told (`reason`): not testable, never a failure.
   */
  | { kind: 'unsure'; did: Did; reason: string; hover?: true }
  /** Nothing did anything (or the click could not be made): no verdict. */
  | { kind: 'none' }
  /** Not measured, and why (the page changes by itself, the control is covered). */
  | { kind: 'unmeasured'; reason: string }
  /**
   * No key did anything, and what changed in the click's window (the pointer's rest on the control included) was
   * written by timers the page set before it (the listener hook's timer notes), with nothing else left: the click's
   * effect is not testable, never credited and never failed (the lead's cut, batch 17).
   */
  | { kind: 'self' };

/** Why a click whose window only the page's own timers wrote in is not testable (the lead's cut, batch 17). */
export const SELF_DURING_CLICK = 'the page changed by itself during the click; the change can\'t be credited to the click';

const label = (c: ControlCandidate) => (c.name ? `${quote(c.name, 60)} (${clip(c.path, 100)})` : clip(c.path, 120));
const KEY_NAMES: Record<string, string> = { Enter: 'Enter', Space: 'Space', ArrowRight: 'the Right Arrow', ArrowDown: 'the Down Arrow', ArrowLeft: 'the Left Arrow', ArrowUp: 'the Up Arrow', Home: 'Home', End: 'End' };
export const keyName = (k: string) => KEY_NAMES[k] ?? k;
const memberWord = (role?: string) => (role === 'tab' ? 'tab' : role === 'radio' ? 'choice' : role === 'option' ? 'option' : role?.startsWith('menuitem') ? 'menu item' : role === 'treeitem' ? 'tree item' : 'button');

const list = (items: readonly string[], last: string) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`);

/**
 * 2.1.1 for one control that only the pointer can use (WCAG failure F54), in the words of what was measured.
 * A failure only when Enter, Space and every key the control names for itself did nothing, and no other
 * control with the same name or target does the same with the keyboard (Understanding 2.1.1: any key, and
 * any other way to the same function, will do). Where that could not be told (`unsure`): not testable.
 */
export function operationFinding(c: ControlCandidate, op: Operation): ProbeFinding | null {
  if (op.kind === 'self') {
    return { criterion: '2.1.1', status: 'not_testable', target: c.path, detail: `What a mouse click on ${label(c)} does could not be told: ${SELF_DURING_CLICK}.` };
  }
  if (op.kind === 'unsure' && op.hover) {
    return {
      criterion: '2.1.1', status: 'not_testable', target: c.path,
      detail: `${label(c)} changes when it is clicked (it ${op.did.what}), but the same change shows when the pointer only rests on it without clicking (content that waits a moment before it shows on hover, such as a tooltip), so whether the click itself does anything that keyboard users lack could not be told.`,
    };
  }
  if (op.kind === 'unsure') {
    return {
      criterion: '2.1.1', status: 'not_testable', target: c.path,
      detail: `${label(c)} answers a mouse click (it ${op.did.what}), and Enter and Space do nothing on it. Whether the keyboard reaches the same thing another way could not be told: ${op.reason}.`,
    };
  }
  if (op.kind !== 'pointer-only') return null;
  const what = op.did.what;
  const named = (op.keys ?? []).map(keyName);
  const none = `${list(['Enter', 'Space', ...named], 'and')} do nothing`;
  let detail: string;
  if (c.kind === 'composite') {
    detail = `The ${memberWord(c.role)} ${label(c)} can be chosen with the mouse (a click ${what}), but not with the keyboard: neither the arrow keys nor Enter or Space reach it or choose it${named.length ? `, and ${list(named, 'and')} ${named.length === 1 ? 'does' : 'do'} nothing` : ''}.`;
  } else if (!c.focusable) {
    detail = `${label(c)} answers a mouse click (it ${what}) but cannot take keyboard focus, and nothing next to it does the same${named.length ? ` (${list(named, 'and')}, which it names as its ${named.length === 1 ? 'key, does' : 'keys, do'} nothing)` : ''}, so it cannot be used with the keyboard.`;
  } else if (c.kind === 'native') {
    const on = c.types.filter((t) => t !== 'click');
    detail = `The button ${label(c)} answers a mouse click (it ${what}) but not the keyboard: with focus on it, ${none}${on.length ? ` (its action runs on ${on.slice(0, 3).join(', ')}, which a key press never sends)` : ''}.`;
  } else {
    detail = `${label(c)} takes keyboard focus, but ${none} on it, while a mouse click ${what}: it cannot be used with the keyboard.`;
  }
  if (op.others?.length) detail += ` ${op.others.slice(0, 2).join('; ')}.`;
  return { criterion: '2.1.1', status: 'failed', target: c.path, detail };
}

/**
 * 4.1.3: a status message a press showed that screen readers are not told about. It must read as a
 * status (`STATUS_TEXT`, on a control that does not show and hide content), not be part of what the press
 * opened, not be in a live region, an alert or a status that was there before, and focus must not have
 * moved to it. A message that came into view and went away again on the next press was a panel the
 * control toggles, not a status (`toggled`). One whose announcement could not be told (`unsure`) is not failed.
 */
export function unannounced(m: Message, toggled: boolean): boolean {
  return m.status && !m.ofOpened && !m.live && !m.focus && !m.unsure && !(m.appeared && toggled);
}

export function statusFinding(c: { name: string; path: string }, m: Message, typed = false, chose?: string): ProbeFinding {
  return {
    criterion: '4.1.3', status: 'failed', target: m.path,
    detail: `${chose ? `After choosing ${quote(chose, 60)}, pressing` : typed ? 'Typing in' : 'Pressing'} ${c.name ? quote(c.name, 60) : clip(c.path, 80)} shows ${quote(m.text, 120)}, but screen readers are not told: the message is not in a live region (role="status", role="alert" or aria-live), and focus stays where it was.`,
  };
}

/** What typing in one search or filter field showed (4.1.3 only). */
export interface FieldResult {
  field: { name: string; path: string };
  /** Status messages it showed that are not announced, and how many were. */
  status: Message[];
  announced: number;
  /** Status messages whose announcement could not be told (`Message.unsure`). */
  unsure?: Message[];
}

const openedWord = (o: Opened) => (o.kind === 'dialog' ? 'a dialog' : o.kind === 'menu' ? 'a list of choices' : 'a panel over the page');

/**
 * 2.4.3 (failure F85): a control opened a dialog, a menu or a layer that holds controls of its own;
 * focus did not go into it, and none of the next Tab presses reached it either.
 */
export function orderFinding(c: ControlCandidate, o: Opened, tabs: number, went: string): ProbeFinding {
  return {
    criterion: '2.4.3', status: 'failed', target: o.path,
    detail: `Pressing ${c.name ? quote(c.name, 60) : clip(c.path, 80)} opens ${openedWord(o)}${o.name ? ` (${quote(o.name, 50)})` : ''} with ${o.tabbables === 1 ? '1 control' : `${o.tabbables} controls`} in it, but keyboard focus is not moved into it and the next ${tabs === 1 ? 'Tab press does' : `${tabs} Tab presses do`} not reach it${went ? ` (focus goes to ${went})` : ''}: it is not next to its control in the focus order.`,
  };
}

/**
 * 2.4.11: after a press, the element that holds focus is entirely hidden behind other content, and stays so:
 * Escape did not bring it back into view, nor (`again`: when focus was still on the control that was pressed)
 * the same press a second time. Content the user opened and can take away without moving focus is no failure
 * (Understanding 2.4.11, note 2), so this is only reported once those were tried.
 */
export function hiddenFinding(c: ControlCandidate, active: { path: string; name: string }, cover: string, same: boolean, again = false): ProbeFinding {
  const who = active.name ? `${quote(active.name, 60)} (${clip(active.path, 100)})` : clip(active.path, 120);
  return {
    criterion: '2.4.11', status: 'failed', target: active.path,
    detail: same
      ? `After ${who} is pressed, it is entirely hidden behind ${clip(cover, 100)} while it still holds keyboard focus, and ${again ? 'neither Escape nor pressing it again brings' : 'Escape does not bring'} it back into view.`
      : `Pressing ${c.name ? quote(c.name, 60) : clip(c.path, 80)} moves keyboard focus to ${who}, which is entirely hidden behind ${clip(cover, 100)} (fixed or sticky content); Escape does not bring it into view.`,
  };
}

/**
 * 2.4.11, not testable: the focused element stays hidden behind what the press opened after Escape and the same
 * press again, but what opened has a control to close it. Understanding 2.4.11, note 2, allows content the user
 * opened when it can be dismissed without moving focus (a close control that keeps focus, a key it names); the
 * test does not press that control, so it cannot say the cover stays.
 */
export function hiddenDoubt(c: ControlCandidate, active: { path: string; name: string }, cover: string, same: boolean): ProbeFinding {
  const who = active.name ? `${quote(active.name, 60)} (${clip(active.path, 100)})` : clip(active.path, 120);
  const lead = same
    ? `After ${who} is pressed, it is entirely hidden behind ${clip(cover, 100)} while it still holds keyboard focus`
    : `Pressing ${c.name ? quote(c.name, 60) : clip(c.path, 80)} moves keyboard focus to ${who}, which is entirely hidden behind ${clip(cover, 100)}`;
  return {
    criterion: '2.4.11', status: 'not_testable', target: active.path,
    detail: `${lead}. Escape and the same press again do not bring it back into view, but what opened has a control to close it, which the test did not try: whether that takes the cover away without moving focus could not be told.`,
  };
}

/**
 * 4.1.3, not testable: the message's only live region is inside a shadow root and was not there (or not live)
 * before the press. The test's observer does not see what scripts do inside a shadow root, so it cannot tell
 * whether the region was there before its message (announced) or came with it (not announced, ARIA22).
 */
export function statusDoubt(c: { name: string; path: string }, m: Message, typed = false): ProbeFinding {
  return {
    criterion: '4.1.3', status: 'not_testable', target: m.path,
    detail: `${typed ? 'Typing in' : 'Pressing'} ${c.name ? quote(c.name, 60) : clip(c.path, 80)} shows ${quote(m.text, 120)} in a live region inside a shadow root that was not there, or not live, before the press. What scripts do inside a shadow root is not seen by the test, so whether the region was there before its message (and the message is announced) could not be told.`,
  };
}

/** What happened with one control. */
export interface ControlResult {
  candidate: ControlCandidate;
  operation: Operation;
  /** The press worked (by key or by click) and what it left was looked at. */
  looked: boolean;
  /** Status messages it showed: unannounced ones, and how many were announced. */
  status: Message[];
  announced: number;
  /** Status messages whose announcement could not be told (`Message.unsure`). */
  statusUnsure?: Message[];
  /** Findings measured after the press (2.4.3, 2.4.11, 2.1.2), ready-made. */
  after: ProbeFinding[];
  /** It opened a dialog, a menu or a layer with controls in it (the focus-order rule had something to judge). */
  openedControls: boolean;
  /** Focus moved, or something opened (the focus-hidden rule had something to judge). */
  focusJudged: boolean;
  /** A focus loop was looked for in what it opened. */
  trapJudged: boolean;
  /** The page was left with something open that could not be closed: later controls were not pressed. */
  left?: boolean;
  /** What the press that worked did, for comparing it with what other controls do (`sameEffect`). */
  effect?: Effect | null;
  /** The choice made beside it before the press that worked (it did nothing before): "December in Month". */
  chose?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The page's findings. Failures first, per criterion. Without one: a note on what was pressed when
 * the rule had something to judge, `not_applicable` when it had nothing. Controls not pressed (beyond the
 * limit, after a press that could not be undone, when the time ran out) are named in the notes: they
 * never turn a result into "not testable" by themselves.
 */
export function controlsFindings(results: readonly ControlResult[], info: { more: number; refused: number; skipped: number; skippedWhy?: string; max?: number; per?: string }, fields: readonly FieldResult[] = []): ProbeFinding[] {
  const out: ProbeFinding[] = [];
  const cap = CONTROLS_LIMITS.perCriterion;
  const pressed = results.filter((r) => r.operation.kind !== 'unmeasured');
  const notes: string[] = [];
  if (info.more) notes.push(`${plural(info.more, 'more control')} not pressed (the test presses ${info.max ?? CONTROLS_LIMITS.candidates} per ${info.per ?? 'page'}, one of each kind first)`);
  if (info.skipped) notes.push(`${plural(info.skipped, 'control')} not pressed${info.skippedWhy ? ` (${info.skippedWhy})` : ''}`);
  if (info.refused) notes.push(`${plural(info.refused, 'control')} never pressed (a link, a form field, a submit button, or named for an action on the site)`);
  const note = notes.length ? `; ${notes.join('; ')}` : '';
  const none = (criterion: string, why: string): ProbeFinding => ({ criterion, status: 'not_applicable', detail: `${why}${note}` });
  const clean = (criterion: string, what: string): ProbeFinding => ({ criterion, status: 'no_failures_found', detail: `${what}${note}` });

  // 2.1.1: failures first; without one, the controls that could not be judged (not testable).
  const judged = results.map((r) => operationFinding(r.candidate, r.operation)).filter((f): f is ProbeFinding => !!f);
  const op = judged.some((f) => f.status === 'failed') ? judged.filter((f) => f.status === 'failed') : judged;
  if (op.length) out.push(...op.slice(0, cap));
  else if (!pressed.length) out.push(none('2.1.1', results.length ? 'no control on this page could be pressed by the test' : 'no custom controls or buttons to press on this page'));
  else {
    const keys = pressed.filter((r) => r.operation.kind === 'keys').length;
    out.push(clean('2.1.1', `${plural(pressed.length, 'control')} pressed with the keyboard and, where the keys did nothing, the mouse (${keys} answered the keyboard)`));
  }

  // 4.1.3
  const status = [...results.flatMap((r) => r.status.map((m) => statusFinding(r.candidate, m, false, r.chose))), ...fields.flatMap((f) => f.status.map((m) => statusFinding(f.field, m, true)))];
  const announced = results.reduce((n, r) => n + r.announced, 0) + fields.reduce((n, f) => n + f.announced, 0);
  // Without a failure: the messages whose announcement could not be told (not testable), before any "announced".
  const doubts = [...results.flatMap((r) => (r.statusUnsure ?? []).map((m) => statusDoubt(r.candidate, m))), ...fields.flatMap((f) => (f.unsure ?? []).map((m) => statusDoubt(f.field, m, true)))];
  if (status.length) out.push(...status.slice(0, cap));
  else if (doubts.length) out.push(...doubts.slice(0, cap));
  else if (announced) out.push(clean('4.1.3', `${plural(announced, 'status message')} shown by the controls pressed ${announced === 1 ? 'is' : 'are'} announced (a live region, or focus moved to it)`));
  else out.push(none('4.1.3', pressed.length || fields.length ? 'no control pressed showed a status message' : 'no controls to press on this page'));

  // 2.4.3, 2.4.11, 2.1.2: what the presses opened.
  const rules: [string, (r: ControlResult) => boolean, string, string][] = [
    ['2.4.3', (r) => r.openedControls, 'no control pressed opened a dialog, a menu or a layer with controls in it', 'what the controls pressed opened is reached by the next Tab presses'],
    ['2.4.11', (r) => r.focusJudged, 'no control pressed moved keyboard focus or opened anything', 'the element holding focus after each press is not left hidden behind other content (what a press opened over it goes away with Escape or the same press again)'],
    ['2.1.2', (r) => r.trapJudged, 'no control pressed opened a dialog or moved focus into new content', 'keyboard focus can leave what the controls pressed opened'],
  ];
  for (const [criterion, judged, nothing, fine] of rules) {
    const all = results.flatMap((r) => r.after.filter((f) => f.criterion === criterion));
    // Failures first; without one, what could not be judged.
    const found = all.some((f) => f.status === 'failed') ? all.filter((f) => f.status === 'failed') : all;
    if (found.length) out.push(...found.slice(0, cap));
    else if (results.some(judged)) out.push(clean(criterion, fine));
    else out.push(none(criterion, nothing));
  }
  return out;
}
