// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Turns a keyboard traversal into findings, one rule per criterion (pure: unit-tested with
// synthetic traversals). Engine core: no Node-only imports.
import type { ProbeFinding } from '../../types.js';
import { blockedReason } from '../guard.js';
import type { GuardEvent } from '../types.js';
import type { ClickableGroup } from './page.js';
import { hex, NON_TEXT_THRESHOLD, ratioText } from '../pixels.js';
import { bypassVerdict, clip, containerOrderJumps, contextChange, eventEffects, footerBeforeMain, HIDDEN_TEXT, label, plural, tabindexJumps, type Hidden } from './rules.js';
import type { Stop, TrapResult, Traversal } from './traverse.js';

/** Findings kept per criterion and page (the report keeps 20 per criterion and test overall). */
const MAX_PER_CRITERION = 8;

/** Every stop once (forward first), by element. */
function uniqueStops(t: Traversal, direct = false): Stop[] {
  const seen = new Set<number>();
  const out: Stop[] = [];
  for (const s of [...t.forward, ...t.backward, ...(direct ? t.direct ?? [] : [])]) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

/** 2.1.1: elements that react to the mouse but cannot be reached or used with the keyboard. */
export function clickableFindings(groups: readonly ClickableGroup[]): ProbeFinding[] {
  const more = (g: ClickableGroup) => (g.count > 1 ? ` (and ${plural(g.count - 1, 'more element')} like it)` : '');
  const failed: ProbeFinding[] = groups.filter((g) => !g.listed).slice(0, MAX_PER_CRITERION).map((g) => ({
    criterion: '2.1.1',
    status: 'failed',
    target: g.path,
    detail: `${label(g.name, g.path)} responds to the mouse (${clip(g.why, 120)}) but is not focusable and has no focusable element inside or around it, so it cannot be used with the keyboard${more(g)}.`,
  }));
  // Candidates (`ClickableGroup.listed`): a listener alone proves no control, and this test presses nothing.
  const listed: ProbeFinding[] = groups.filter((g) => g.listed).slice(0, MAX_LISTED_CLICKABLES).map((g) => ({
    criterion: '2.1.1',
    status: 'not_testable',
    target: g.path,
    detail: g.listed === 'surface'
      ? `${label(g.name, g.path)} cannot get keyboard focus and ${LISTENS} (${clip(g.why, 120)}). It is a drawing or a part of one (a canvas, an svg or an image), which a charting or map library listens on whether or not a click does anything, and this test presses nothing, so whether a click there does anything the keyboard cannot was not shown${more(g)}`
      : g.listed === 'shadow'
      ? `${label(g.name, g.path)} cannot get keyboard focus and ${LISTENS} (${clip(g.why, 120)}), but what it shows could not all be read (a closed shadow root, a custom element's own content, or more than this test reads), so whether it holds a control the keyboard reaches, or is only a drawing, could not be seen, and this test presses nothing${more(g)}`
      : `${label(g.name, g.path)} cannot get keyboard focus and ${LISTENS} (${clip(g.why, 120)}), but the page does not declare it a control (it is no link or button element, has no control role and no pointer cursor of its own) and this test presses nothing, so whether a click there does anything the keyboard cannot was not shown${more(g)}`,
  }));
  return [...failed, ...listed];
}

/** Candidates listed per page, its frames included (elements and drawings that listen for clicks with nothing shown). */
export const MAX_LISTED_CLICKABLES = 3;
/** The words every candidate's finding has (`isListedClickable`). */
const LISTENS = 'a script listens for clicks on it';
/** A candidate's finding (as `clickableFindings` words it), to count candidates across a page and its frames. */
export const isListedClickable = (f: ProbeFinding): boolean => f.criterion === '2.1.1' && f.status === 'not_testable' && f.detail.includes(LISTENS);

/** Why a guarded request or navigation leaves a result undecided. */
export function stoppedReason(e: GuardEvent): string {
  if (e.kind === 'navigation') return `the test would have loaded another page${e.url ? ` (${clip(e.url, 120)})` : ''}, so it was stopped`;
  return blockedReason(e);
}

const pressedText = (names: readonly string[], lead = ', ') =>
  (names.length ? `${lead}${lead ? '' : ' '}${names.slice(0, 3).map((n) => `"${clip(n, 30)}"`).join(', ')}` : '');

const names3 = (list: readonly string[]) => list.slice(0, 3).map((n) => `"${clip(n, 30)}"`).join(', ') + (list.length > 3 ? ', …' : '');

function trapFindings(t: Traversal): ProbeFinding[] {
  return t.traps.flatMap(oneTrap);
}

/** The finding (or none) for one focus cycle and the ways out that were tried. */
export function oneTrap(trap: TrapResult): ProbeFinding[] {
  if (trap.outside === 0) return [];
  const where = trap.region.name ? `"${clip(trap.region.name, 60)}" (${clip(trap.region.path, 100)})` : clip(trap.region.path, 120);
  const notTestable = (detail: string): ProbeFinding[] => [{ criterion: '2.1.2', status: 'not_testable', target: trap.region.path, detail }];
  if (trap.stopped) {
    return notTestable(trap.escaped
      ? `Pressing${pressedText(trap.pressed, '')} moved focus out of ${where}, but the press needed the live site: ${stoppedReason(trap.stopped)}.`
      : `Keyboard focus stays in ${where}; the ways out tried (Shift+Tab, Esc${pressedText(trap.pressed)}) need the live site: ${stoppedReason(trap.stopped)}.`);
  }
  // A full log after a press: what the press sent may be missing, even when focus got out.
  if (trap.logFull && (!trap.escaped || trap.escaped === 'close')) return notTestable(`Keyboard focus stays in ${where} or left it only by a button press, but the request log was full, so a request the test stopped could not be ruled out.`);
  if (trap.escaped) return [];
  if (trap.untested) return notTestable(`Keyboard focus stayed in ${where} as far as the test went, but ${trap.untested}.`);
  const untried = [...trap.exits.links, ...trap.exits.submits];
  if (untried.length) {
    return notTestable(`Keyboard focus stays in ${where}; the only ways out follow a link or submit a form (${names3(untried)}), which this test does not activate.`);
  }
  if (trap.dialog && trap.exits.buttons.length) {
    return notTestable(`Keyboard focus stays in the dialog ${where}; its other buttons (${names3(trap.exits.buttons)}) may close it, but this test presses only buttons named Close, Cancel or the like.`);
  }
  const names = trap.names.slice(0, 4).map((n) => `"${clip(n, 40)}"`).join(', ');
  const count = trap.members.length === 1 ? 'Tab keeps focus on one element' : `Tab cycles through ${trap.members.length} elements`;
  return [{
    criterion: '2.1.2',
    status: 'failed',
    target: trap.region.path,
    detail: `Keyboard focus is trapped in ${where}: ${count}${names ? ` (${names})` : ''}, and neither Shift+Tab nor Esc${trap.pressed.length ? ` nor pressing${pressedText(trap.pressed, '')}` : ''} moves focus out, while ${plural(trap.outside, 'other focusable element')} ${trap.outside === 1 ? 'is' : 'are'} out of reach.`,
  }];
}

/**
 * Focus stops that cannot be seen when focused, grouped by container and reason: 2.4.7, Focus Visible (batch 19, the
 * lead's ruling on the real-site dev split: off screen, fully transparent or clipped away, the focused element and its
 * indicator are not visible; 2.4.3 keeps an order that is actually wrong). On a page (or in a region) that snaps its
 * scroll position, an element left outside the visible area is the snapping hiding it: that is filed under 2.4.11,
 * focus not obscured (lead's ruling, 2026-11-07), when `obscured` is wanted.
 */
function hiddenFindings(stops: readonly Stop[], wanted: { visible: boolean; obscured: boolean }): ProbeFinding[] {
  const groups = new Map<string, { reason: Hidden; group: string; stops: Stop[]; snapped: boolean }>();
  for (const s of stops) {
    // A skip link's target (out of the Tab order) that focus reached by the link, an empty marker at a place on the
    // screen: the next Tab goes on (2026-11-07 audit, thprd). Off screen, clipped or transparent still fails.
    if (!s.hidden || (s.linkTarget && s.hidden === 'size')) continue;
    const snapped = s.hidden === 'offscreen' && !!s.snap;
    if (snapped ? !wanted.obscured : !wanted.visible) continue;
    const key = `${s.group ?? s.path}\u0000${s.hidden}\u0000${snapped}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { reason: s.hidden, group: s.group ?? s.path ?? '', stops: [], snapped }));
    g.stops.push(s);
  }
  const all = [...groups.values()];
  return [...all.filter((g) => !g.snapped).slice(0, MAX_PER_CRITERION), ...all.filter((g) => g.snapped).slice(0, MAX_PER_CRITERION)].map((g) => {
    const first = g.stops[0]!;
    const n = g.stops.length;
    if (g.snapped) {
      return {
        criterion: '2.4.11',
        status: 'failed',
        target: n > 1 ? g.group : first.path ?? g.group,
        detail: n > 1
          ? `Keyboard focus moves to ${n} elements that the page's scroll snapping leaves outside the visible area when focused, for example ${label(first.name, first.path ?? '')}: focus is hidden from view.`
          : `Keyboard focus moves to ${label(first.name, first.path ?? '')}, which the page's scroll snapping leaves outside the visible area when focused: focus is hidden from view.`,
      } satisfies ProbeFinding;
    }
    return {
      criterion: '2.4.7',
      status: 'failed',
      target: n > 1 ? g.group : first.path ?? g.group,
      detail: n > 1
        ? `Keyboard focus moves to ${n} elements that are ${HIDDEN_TEXT[g.reason]} when focused, for example ${label(first.name, first.path ?? '')}: focus disappears from view.`
        : `Keyboard focus moves to ${label(first.name, first.path ?? '')}, which is ${HIDDEN_TEXT[g.reason]} when focused: focus disappears from view.`,
    } satisfies ProbeFinding;
  });
}

function orderFindings(t: Traversal): ProbeFinding[] {
  const out: ProbeFinding[] = [];
  const skipped = footerBeforeMain(t.forward.filter((s) => !s.lost).map((s) => ({ inMain: !!s.inMain, inFooter: !!s.inFooter, fixed: !!s.fixed })), t.layout);
  if (skipped) {
    out.push({
      criterion: '2.4.3',
      status: 'failed',
      target: 'main',
      detail: `Tab reaches ${plural(skipped, 'element')} of the page footer before any element of the main content, although the footer is shown below it: the focus order skips the main content.`,
    });
  }
  // Positive tabindex sending focus far back up the page (F44). Flow stops only.
  // A stop scroll snapping left outside the visible area keeps its place on the page (2.4.11 reports the snapping).
  const flow = t.forward.filter((s) => !s.lost && !s.fixed && (!s.hidden || (s.hidden === 'offscreen' && s.snap)) && !s.frame && !s.dialog && s.box && s.pageY !== undefined && s.pageX !== undefined);
  const jumps = tabindexJumps(flow.map((s) => ({ ...(s.tabIndex ? { tabIndex: s.tabIndex } : {}), pageX: s.pageX!, pageY: s.pageY!, w: s.box!.w, h: s.box!.h })), t.viewportHeight);
  const reported = new Set<number>();
  for (const i of jumps) {
    const a = flow[i]!;
    const b = flow[i + 1]!;
    const culprit = a.tabIndex ? a : b;
    if (reported.has(culprit.id) || out.length >= MAX_PER_CRITERION) continue;
    reported.add(culprit.id);
    out.push({
      criterion: '2.4.3',
      status: 'failed',
      ...(culprit.path ? { target: culprit.path } : {}),
      detail: `Tab moves focus from ${label(a.name, a.path ?? '')} to ${label(b.name, b.path ?? '')}, ${Math.round(a.pageY! - b.pageY!)} px back up the page: tabindex="${culprit.tabIndex}" on ${culprit === a ? 'the first' : 'the second'} puts it out of the visual reading order.`,
    });
  }
  // Inside one container, at any distance: a positive tabindex sends focus back against the document and the screen (F44).
  const inBox = containerOrderJumps(flow.map((s) => ({
    ...(s.tabIndex ? { tabIndex: s.tabIndex } : {}), pageX: s.pageX!, pageY: s.pageY!, w: s.box!.w, h: s.box!.h,
    ...(s.ord ? { box: s.ord.box, moved: !!s.ord.moved, rtl: !!s.ord.rtl, ...(s.ord.dom !== undefined ? { dom: s.ord.dom } : {}), ...(s.ord.group ? { group: s.ord.group } : {}) } : {}),
  })));
  for (const i of inBox.fail) {
    const a = flow[i]!;
    const b = flow[i + 1]!;
    const culprit = a.tabIndex ? a : b;
    if (reported.has(culprit.id) || out.length >= MAX_PER_CRITERION) continue;
    reported.add(culprit.id);
    out.push({
      criterion: '2.4.3',
      status: 'failed',
      ...(culprit.path ? { target: culprit.path } : {}),
      detail: `Tab moves focus from ${label(a.name, a.path ?? '')} back to ${label(b.name, b.path ?? '')}, which comes before it on the page and in the HTML: tabindex="${culprit.tabIndex}" on ${culprit === a ? 'the first' : 'the second'} puts it out of order.`,
    });
  }
  // CSS showing controls in another order than focus takes them: a recommendation, never a failure.
  const advised = new Set<string>();
  for (const i of inBox.advice) {
    const a = flow[i]!;
    const b = flow[i + 1]!;
    const box = a.ord?.box ?? '';
    if (advised.has(box) || advised.size >= MAX_PER_CRITERION) continue;
    advised.add(box);
    out.push({
      criterion: '2.4.3', status: 'no_failures_found', advice: true,
      ...(box ? { target: box } : {}),
      detail: `Tab moves focus from ${label(a.name, a.path ?? '')} to ${label(b.name, b.path ?? '')}, which CSS shows before it: check that this order makes sense, or put the HTML in the order shown.`,
    });
  }
  return out;
}

function focusVisibleFindings(t: Traversal): ProbeFinding[] {
  const all = uniqueStops(t, true);
  const out: ProbeFinding[] = [];
  const failedIds = new Set<number>();
  for (const s of all) {
    const f = s.focus;
    if (!f || (f.verdict !== 'none' && f.verdict !== 'clipped' && f.verdict !== 'unseen')) continue;
    failedIds.add(s.id);
    const others = all.filter((x) => x !== s && x.sig === s.sig).length;
    const measured = f.changed !== undefined ? `${f.changed} of ${f.total} pixels changed` : 'no pixel change';
    const styles = f.styleChanged.length ? `changed styles: ${f.styleChanged.slice(0, 4).join(', ')}` : 'no outline, shadow, border or color change';
    const what = label(s.name, s.path ?? '');
    out.push({
      criterion: '2.4.7',
      status: 'failed',
      ...(s.path ? { target: s.path } : {}),
      detail: (f.verdict === 'clipped'
        ? `The focus outline of ${what} is cut off by a parent element, so keyboard focus is not visible (${measured}; focused outline: ${f.outline}).`
        : f.verdict === 'unseen'
          ? `The focus indicator of ${what} cannot be seen: its styles draw one (${f.outline}; ${styles}), but focusing it changes nothing on screen, so it is drawn in the colour behind it or covered (${measured}).`
          : `No visible focus indicator on ${what}: it looks the same focused and unfocused (${measured}; focused outline: ${f.outline}; ${styles}).`)
        + (others ? ` ${plural(others, 'other focus stop')} of the same kind ${others === 1 ? 'was' : 'were'} not measured separately.` : ''),
    });
    if (out.length >= MAX_PER_CRITERION) break;
  }
  // Batch 18, D9 (lead's ruling 2026-11-12): a stop entirely hidden, when it receives focus, behind content laid over
  // it (not fixed or sticky content, which scrolling or the page's scroll padding can clear, and not a panel the user
  // opened: the walk opens none) shows no focus indicator at all, so it fails 2.4.7 as well as 2.4.11.
  for (const s of [...t.forward, ...t.backward, ...(t.direct ?? [])]) {
    if (out.length >= MAX_PER_CRITERION) break;
    if (!s.obscuredBy || !s.coverOver || s.unsettled || s.ringShows || failedIds.has(s.id)) continue;
    failedIds.add(s.id);
    out.push({
      criterion: '2.4.7',
      status: 'failed',
      ...(s.path ? { target: s.path } : {}),
      detail: `${label(s.name, s.path ?? '')} is entirely hidden behind ${clip(s.obscuredBy, 100)} (content laid over it) when it receives keyboard focus, so no focus indicator can be seen.`,
    });
  }
  return out;
}

/**
 * 1.4.11 for focus indicators: a focus ring (outline or outer box-shadow) under 3:1 against the
 * colours next to it fails. No failure: no finding when every indicator was a measured ring; a
 * coverage note when some indicators were not measured; not testable when none could be; not
 * applicable when the page styles no indicator (the browser's own ring is exempt).
 */
function focusContrastFindings(t: Traversal): ProbeFinding[] {
  const all = uniqueStops(t, true);
  const shown = all.filter((s) => s.focus?.verdict === 'visible' && s.focus.indicator && s.focus.indicator !== 'browser');
  const out: ProbeFinding[] = [];
  for (const s of shown) {
    const c = s.focus!.contrast;
    if (c?.kind !== 'failed') continue;
    const others = all.filter((x) => x !== s && x.sig === s.sig).length;
    out.push({
      criterion: '1.4.11',
      status: 'failed',
      ...(s.path ? { target: s.path } : {}),
      detail: `The focus indicator of ${label(s.name, s.path ?? '')} has a contrast of ${ratioText(c.ratio)} against the colors next to it (${hex(c.colour)} on ${hex(c.behind)}); a focus indicator needs at least ${NON_TEXT_THRESHOLD}:1.`
        + (others ? ` ${plural(others, 'other focus stop')} of the same kind ${others === 1 ? 'was' : 'were'} not measured separately.` : ''),
    });
    if (out.length >= MAX_PER_CRITERION) break;
  }
  // A walk cut short (time budget, a frame it cannot follow): failures stand, the rest is not testable (below).
  if (out.length || t.partial || t.frameStuck) return out;
  const measured = shown.filter((s) => s.focus!.contrast?.kind === 'ok').length;
  const unmeasured = shown.length - measured;
  const browser = all.filter((s) => s.focus?.verdict === 'visible' && s.focus.indicator === 'browser').length;
  const cap = t.samples && t.samples.skipped > 0
    ? `${plural(t.samples.skipped, 'more kind')} ${t.samples.skipped === 1 ? 'was' : 'were'} not measured${t.samples.fullCap ? ` (${t.samples.fullCap} kinds with --full)` : ''}`
    : '';
  const why = 'a change inside the element such as its fill or border, a drop shadow, a ring whose color the screenshots could not confirm, a ring next to another focus change, a ring with enough contrast against one of the colors next to it, or an element that only appears when focused';
  if (!measured && !browser) {
    return [unmeasured
      ? { criterion: '1.4.11', status: 'not_testable', detail: `the contrast of ${plural(unmeasured, 'focus indicator')} styled by the page could not be measured (${why})` }
      : { criterion: '1.4.11', status: 'not_applicable', detail: `no focus indicator styled by the page was found on the focus stops measured (the browser's own focus ring is exempt from 1.4.11)${cap ? `; ${cap}` : ''}` }];
  }
  if (!measured && !unmeasured) {
    return [{ criterion: '1.4.11', status: 'not_applicable', detail: `no focus indicator styled by the page was found on the focus stops measured (the browser's own focus ring is exempt from 1.4.11)${cap ? `; ${cap}` : ''}` }];
  }
  if (!unmeasured && !cap) return [];
  const notes = [
    ...(measured ? [`measured the focus ring of ${plural(measured, 'kind')} of element`] : []),
    ...(browser && !measured ? [`${plural(browser, 'kind')} of element ${browser === 1 ? 'shows' : 'show'} the browser's own focus ring, which 1.4.11 exempts`] : []),
    ...(unmeasured ? [`${plural(unmeasured, 'focus indicator')} ${unmeasured === 1 ? 'was' : 'were'} not measured (${why})`] : []),
    ...(cap ? [cap] : []),
  ];
  return [{ criterion: '1.4.11', status: 'no_failures_found', detail: notes.join('; ') }];
}

function obscuredFindings(t: Traversal): ProbeFinding[] {
  // An element hidden when reached in either direction (Tab scrolls it up to the bottom edge,
  // Shift+Tab down to the top edge, so a footer bar and a header bar each hide a different pass).
  const byCover = new Map<string, Stop[]>();
  const seen = new Set<string>();
  for (const s of [...t.forward, ...t.backward, ...(t.direct ?? [])]) {
    if (!s.obscuredBy) continue;
    const key = `${s.id}\u0000${s.obscuredBy}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = byCover.get(s.obscuredBy) ?? [];
    list.push(s);
    byCover.set(s.obscuredBy, list);
  }
  return [...byCover.entries()].slice(0, MAX_PER_CRITERION).map(([cover, list]) => {
    const first = list[0]!;
    // The covering element's height, for the report's fix (scroll-padding).
    const coverHeight = list.find((s) => s.coverHeight !== undefined)?.coverHeight;
    return {
      criterion: '2.4.11',
      status: 'failed',
      ...(first.path ? { target: first.path } : {}),
      ...(coverHeight !== undefined ? { data: { coverHeight } } : {}),
      detail: `${label(first.name, first.path ?? '')} is entirely hidden behind ${clip(cover, 100)} (${first.coverOver ? 'content laid over it' : 'fixed or sticky content'}) when it receives keyboard focus${list.length > 1 ? `; so ${list.length - 1 === 1 ? 'is 1 more focus stop' : `are ${list.length - 1} more focus stops`}` : ''}.`,
    } satisfies ProbeFinding;
  });
}

function onFocusFindings(t: Traversal, pageUrl: string): ProbeFinding[] {
  const out: ProbeFinding[] = [];
  const seen = new Set<number>();
  for (const s of [...t.forward, ...t.backward]) {
    if (seen.has(s.id)) continue;
    // A navigation, popup or dialog that did not happen again when the element was focused a second
    // time came from something else (a timer), not from the focus.
    const events = s.unconfirmed ? {} : eventEffects(s, pageUrl);
    const what = contextChange({
      ...events,
      ...(s.lost ? { focusLost: true } : {}),
      ...(s.opensDialog ? { dialogOpened: s.opensDialog } : {}),
      added: s.added, removed: s.removed, elements: s.elements,
    });
    if (!what) continue;
    seen.add(s.id);
    out.push({
      criterion: '3.2.1',
      status: 'failed',
      ...(s.path ? { target: s.path } : {}),
      detail: `Moving keyboard focus to ${label(s.name, s.path ?? '')} ${what}, without the user activating anything.`,
    });
    if (out.length >= MAX_PER_CRITERION) break;
  }
  return out;
}

function bypassFindings(t: Traversal): ProbeFinding[] {
  const v = bypassVerdict(t.skips, t.layout, t.skipsUntested);
  return v.status === 'ok' ? [] : [{ criterion: '2.4.1', status: v.status, ...(v.target ? { target: v.target } : {}), detail: v.detail }];
}

/** Criteria the traversal reports on (2.1.1 comes from the clickable scan). */
export const TRAVERSAL_CRITERIA = ['1.4.11', '2.1.2', '2.4.1', '2.4.3', '2.4.7', '2.4.11', '3.2.1'] as const;

/**
 * Findings for the traversal criteria the probe declares. A page where nothing takes keyboard focus
 * gives `not_applicable` for each of them.
 */
export function traversalFindings(t: Traversal, criteria: readonly string[], pageUrl: string): ProbeFinding[] {
  const wanted = (c: string) => criteria.includes(c);
  if (t.noFocus) {
    // Focusable elements exist but Tab reaches none of them (a script cancels the Tab key).
    const out: ProbeFinding[] = [];
    if (wanted('2.1.1')) {
      out.push({
        criterion: '2.1.1', status: 'failed',
        detail: `Pressing Tab moves keyboard focus to none of the ${t.tabbables >= 2000 ? '2000 or more' : t.tabbables} focusable elements on this page (a script cancels the Tab key), so its controls cannot be reached with the keyboard.`,
      });
    }
    if (wanted('2.4.1')) out.push(...bypassFindings(t));
    for (const criterion of TRAVERSAL_CRITERIA) {
      if (criterion === '2.4.1' || !wanted(criterion)) continue;
      out.push({ criterion, status: 'not_testable', detail: 'Tab did not move keyboard focus to any element, so the focus could not be followed' });
    }
    return out;
  }
  if (!t.forward.length && !t.backward.length) {
    // The time budget or a broken page ended the walk before its first stop: that is not "nothing to test".
    const cut = t.cutReason ?? (t.partial ? 'timed out: the page answered key presses too slowly, so no focus stop could be followed in the time allowed' : undefined);
    return TRAVERSAL_CRITERIA.filter(wanted).map((criterion) => (cut
      ? { criterion, status: 'not_testable', detail: cut }
      : { criterion, status: 'not_applicable', detail: 'nothing on this page takes keyboard focus' }));
  }
  const out: ProbeFinding[] = [];
  if (wanted('2.1.2')) out.push(...trapFindings(t));
  if (wanted('2.4.1')) out.push(...bypassFindings(t));
  out.push(...hiddenFindings(uniqueStops(t), { visible: wanted('2.4.7'), obscured: wanted('2.4.11') }));
  if (wanted('2.4.3')) out.push(...orderFindings(t));
  if (wanted('2.4.7')) out.push(...focusVisibleFindings(t));
  if (wanted('1.4.11')) out.push(...focusContrastFindings(t));
  if (wanted('2.4.11')) out.push(...obscuredFindings(t));
  if (wanted('3.2.1')) {
    const found = onFocusFindings(t, pageUrl);
    out.push(...found);
    if (t.onFocusNoise && !found.length) {
      out.push({
        criterion: '3.2.1', status: 'not_testable',
        detail: 'the page loads other pages or opens windows by itself while nothing is pressed, so a change of context caused by focus could not be told apart',
      });
    }
  }
  const n = new Set([...t.forward, ...t.backward].map((s) => s.id)).size;
  const decided = (c: string) => out.some((f) => f.criterion === c && (f.status === 'failed' || f.status === 'not_testable'));
  const WALK = ['1.4.11', '2.1.2', '2.4.3', '2.4.7', '2.4.11', '3.2.1'].filter(wanted);
  if (t.frameStuck) {
    // Tab went on inside a frame until the walk ended: its content (a trap, hidden focus) is unseen.
    for (const c of WALK) {
      if (!decided(c)) out.push({ criterion: c, status: 'not_testable', target: t.frameStuck, detail: `focus moved into a frame (${clip(t.frameStuck, 100)}) and stayed there, and the test cannot follow focus inside frames` });
    }
  }
  if (t.partial) {
    // The time budget ended the traversal: what was measured stands, but "no failures" would claim
    // more than was tested.
    for (const c of WALK) {
      if (!decided(c)) out.push({ criterion: c, status: 'not_testable', detail: t.cutReason ?? `timed out: the page answered key presses too slowly, so only ${plural(n, 'focus stop')} could be followed in the time allowed` });
    }
  }
  // Stops that looked hidden or covered while the page kept scrolling: not measured, so not clean.
  // (Either direction: Shift+Tab is what scrolls links up under a header.)
  const moving = [...new Map([...t.forward, ...t.backward].filter((s) => s.unsettled).map((s) => [s.id, s])).values()];
  if (moving.length) {
    for (const c of ['2.4.7', '2.4.11'].filter(wanted)) {
      if (!decided(c)) out.push({ criterion: c, status: 'not_testable', ...(moving[0]!.path ? { target: moving[0]!.path } : {}), detail: `the page kept scrolling after focus moved to ${label(moving[0]!.name, moving[0]!.path ?? '')}${moving.length > 1 ? ` (and ${plural(moving.length - 1, 'more focus stop')})` : ''}, so whether focus was hidden could not be measured` });
    }
  }
  // The stop and sample caps are by design: a note on what was covered, not "not testable".
  const notes = new Map<string, string[]>();
  const lim = t.limits;
  if (lim && t.tabbables > n && (t.forward.length >= lim.forward || t.backward.length >= lim.backward)) {
    const full = lim.fullForward !== undefined
      ? ` (${lim.fullForward === lim.fullBackward ? `${lim.fullForward} each way` : `the first ${lim.fullForward} and last ${lim.fullBackward}`} with --full)` : '';
    // The stops actually followed in each direction, not the limits.
    // 1.4.11 states its own coverage when it has a result of its own (focusContrastFindings).
    for (const c of WALK.filter((x) => x !== '1.4.11' || !out.some((f) => f.criterion === x))) notes.set(c, [`checked ${t.forward.length} focus stops forward and ${t.backward.length} backward of ${t.tabbables >= 2000 ? '2000 or more' : t.tabbables}${full}`]);
  }
  if (t.samples && t.samples.skipped > 0 && wanted('2.4.7')) {
    const more = `measured the focus indicator of ${plural(t.samples.measured, 'kind')} of element; ${plural(t.samples.skipped, 'more kind')} ${t.samples.skipped === 1 ? 'was' : 'were'} not measured${t.samples.fullCap ? ` (${t.samples.fullCap} kinds with --full)` : ''}`;
    notes.set('2.4.7', [...(notes.get('2.4.7') ?? []), more]);
  }
  for (const [c, list] of notes) {
    if (!decided(c)) out.push({ criterion: c, status: 'no_failures_found', detail: list.join('; ') });
  }
  return out;
}
