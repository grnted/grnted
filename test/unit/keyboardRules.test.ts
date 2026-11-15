// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The keyboard and focus probes' pure rules (Plan 4 Task 4.1): every threshold and decision.
import { describe, expect, it } from 'vitest';
import type { Rgb, RgbaImage } from '../../src/probes/pixels.js';
import {
  bypassVerdict, CLOSE_NAME, confirmed, contextChange, eventEffects, findCycle, focusRingContrast, focusVerdict, footerBeforeMain, hiddenReason, laidOver, MIN_RING_PIXELS, obscuredBy,
  PIXEL_MIN_CHANGED, ringBands, SHORTCUT_CONTROL, shortcutEffect, shortcutRemapPattern, SKIP_LINK_NAME, tabindexJumps, type GridPoint, type SkipLinkTest, type VisibilityFacts,
} from '../../src/probes/keyboard/rules.js';
import { advisedExitKeys, isSkipControl } from '../../src/probes/keyboard/traverse.js';

describe('2.1.2 focus cycles', () => {
  it('finds a cycle repeated twice at the end of the sequence', () => {
    expect(findCycle([1, 2, 3, 4, 3, 4], 15)).toEqual({ members: [3, 4] });
    expect(findCycle([1, 2, 5, 6, 7, 5, 6, 7], 15)).toEqual({ members: [5, 6, 7] });
  });

  it('finds one element kept for three presses, not two', () => {
    expect(findCycle([1, 9, 9, 9], 15)).toEqual({ members: [9] });
    expect(findCycle([1, 9, 9], 15)).toBeNull();
  });

  it('ignores ordinary sequences, focus leaving the page, long cycles and frames', () => {
    expect(findCycle([1, 2, 3, 4, 5], 15)).toBeNull();
    // 0: focus left the page content (the end of the page), so the repeat is the normal wrap.
    expect(findCycle([1, 2, 0, 1, 2], 15)).toBeNull();
    expect(findCycle([1, 2, 0, 1, 2, 0, 1, 2], 15)).toBeNull();
    // Longer than the cap.
    expect(findCycle([1, 2, 3, 4, 1, 2, 3, 4], 3)).toBeNull();
    // Tab moving inside a frame shows the frame element again and again.
    expect(findCycle([1, 7, 7, 7], 15, new Set([7]))).toBeNull();
    expect(findCycle([1, 7, 8, 7, 8], 15, new Set([7]))).toEqual({ members: [7, 8] });
  });

  it('needs distinct members in one turn', () => {
    expect(findCycle([3, 3, 4, 3, 3, 4], 15)).toBeNull();
  });
});

const vis = (over: Partial<VisibilityFacts> = {}): VisibilityFacts =>
  ({ opacity: 1, width: 80, height: 20, inViewport: 1600, points: 1, hits: 1, hitTestable: true, ...over });

describe('2.4.3 focus on hidden elements', () => {
  it('says why a focused element cannot be seen', () => {
    expect(hiddenReason(vis())).toBeNull();
    expect(hiddenReason(vis({ opacity: 0 }))).toBe('style');
    expect(hiddenReason(vis({ opacity: 0.05 }))).toBe('style');
    expect(hiddenReason(vis({ opacity: 0.06 }))).toBeNull();
    expect(hiddenReason(vis({ width: 1, height: 1 }))).toBe('size');
    expect(hiddenReason(vis({ inViewport: 0 }))).toBe('offscreen');
    expect(hiddenReason(vis({ points: 25, hits: 0 }))).toBe('clipped');
    // pointer-events: none: hit testing says nothing.
    expect(hiddenReason(vis({ points: 25, hits: 0, hitTestable: false }))).toBeNull();
  });
});

describe('2.4.11 focus not obscured', () => {
  const f = (by: string): GridPoint => ({ k: 'f', by });
  it('fails only when every point that reaches the element is under opaque fixed or sticky content', () => {
    expect(obscuredBy([f('header'), f('header'), f('header')])).toBe('header');
    expect(obscuredBy([f('header'), f('header'), { k: 'm' }, f('banner'), f('header')])).toBe('header');
    // Partly visible is not a failure (the AA criterion says "entirely hidden").
    expect(obscuredBy([f('header'), f('header'), { k: 's' }])).toBeNull();
    // Covered by ordinary content: not this criterion.
    expect(obscuredBy([f('header'), { k: 'o' }, f('header')])).toBeNull();
    // Too few points to tell.
    expect(obscuredBy([f('header'), f('header')])).toBeNull();
    expect(obscuredBy([{ k: 's' }])).toBeNull();
    expect(obscuredBy([{ k: 'f' }, { k: 'f' }, { k: 'f' }])).toBe('fixed content');
  });
  it('content laid over the element hides it as fixed content does; its own skin and flow content do not', () => {
    const p = (by: string): GridPoint => ({ k: 'p', by });
    expect(obscuredBy([p('#panel'), p('#panel'), p('#panel')])).toBe('#panel');
    expect(laidOver([p('#panel'), p('#panel'), p('#panel')])).toBe(true);
    // A panel and a sticky header together still hide all of it: the one that covers more is named.
    expect(obscuredBy([p('#panel'), f('header'), f('header')])).toBe('header');
    expect(laidOver([p('#panel'), f('header'), f('header')])).toBe(false);
    // A point where it shows, or where only its own skin is over it: not entirely hidden.
    expect(obscuredBy([p('#panel'), p('#panel'), { k: 's' }])).toBeNull();
    expect(obscuredBy([p('#panel'), p('#panel'), { k: 'o' }])).toBeNull();
    expect(laidOver([f('header'), f('header'), f('header')])).toBe(false);
  });
});

describe('2.4.7 focus visible', () => {
  const base = { styleIndicator: false, styleClipped: false, styleChanged: [], textField: false };
  it('an unclipped outline, shadow or border by computed style is visible without pixels', () => {
    expect(focusVerdict({ ...base, styleIndicator: true })).toBe('visible');
  });
  it('otherwise pixels decide', () => {
    expect(focusVerdict({ ...base, changed: PIXEL_MIN_CHANGED, total: 900 })).toBe('visible');
    expect(focusVerdict({ ...base, changed: PIXEL_MIN_CHANGED - 1, total: 900 })).toBe('none');
    expect(focusVerdict({ ...base, styleIndicator: true, styleClipped: true, changed: 0, total: 900 })).toBe('clipped');
    expect(focusVerdict({ ...base, styleIndicator: true, styleClipped: true, changed: 40, total: 900 })).toBe('visible');
  });
  it('a pseudo-element or an ancestor that changed where pixels may not reach: unknown, not a failure (F9)', () => {
    for (const k of ['::before', '::after', 'parent', 'grandparent', 'ancestor3', 'ancestor4']) {
      expect(focusVerdict({ ...base, styleChanged: [k], changed: 0, total: 900 }), k).toBe('unknown');
    }
    expect(focusVerdict({ ...base, styleChanged: ['outline'], changed: 0, total: 900 })).toBe('none');
  });
  it('no failure without a pixel measurement, or on a text field', () => {
    expect(focusVerdict(base)).toBe('unknown');
    expect(focusVerdict({ ...base, textField: true, changed: 0, total: 900 })).toBe('unknown');
  });
});

describe('2.4.3 focus order', () => {
  const s = (inMain: boolean, inFooter: boolean, fixed = false) => ({ inMain, inFooter, fixed });
  it('fails footer stops reached before the main content when the footer is shown below it', () => {
    expect(footerBeforeMain([s(false, false), s(false, true), s(false, true), s(true, false)], { mainBottom: 800, footerTop: 820 })).toBe(2);
  });
  it('accepts the usual order, a footer shown above main, fixed footers and pages without both', () => {
    expect(footerBeforeMain([s(false, false), s(true, false), s(false, true)], { mainBottom: 800, footerTop: 820 })).toBe(0);
    expect(footerBeforeMain([s(false, true), s(true, false)], { mainBottom: 800, footerTop: 100 })).toBe(0);
    expect(footerBeforeMain([s(false, true, true), s(true, false)], { mainBottom: 800, footerTop: 820 })).toBe(0);
    expect(footerBeforeMain([s(false, true), s(true, false)], { mainBottom: 800 })).toBe(0);
    expect(footerBeforeMain([s(false, true)], { mainBottom: 800, footerTop: 820 })).toBe(0);
  });

  it('flags positive tabindex that sends focus more than a viewport back up the same column', () => {
    const stop = (pageY: number, pageX = 20, tabIndex?: number) => ({ pageX, pageY, w: 100, h: 20, ...(tabIndex ? { tabIndex } : {}) });
    expect(tabindexJumps([stop(1600, 20, 1), stop(30)], 900)).toEqual([0]);
    // Among positive values too.
    expect(tabindexJumps([stop(30), stop(1600, 20, 1), stop(30, 20, 2)], 900)).toEqual([1]);
    // No positive tabindex: a CSS layout jump is not this rule.
    expect(tabindexJumps([stop(1600), stop(30)], 900)).toEqual([]);
    // Less than a viewport back.
    expect(tabindexJumps([stop(800, 20, 1), stop(30)], 900)).toEqual([]);
    // The next stop is in a column to the right (a sidebar).
    expect(tabindexJumps([stop(1600, 20, 1), stop(30, 700)], 900)).toEqual([]);
    // Forward down the page.
    expect(tabindexJumps([stop(30, 20, 1), stop(1600)], 900)).toEqual([]);
  });
});

describe('2.4.1 bypass blocks', () => {
  const skip = (over: Partial<SkipLinkTest> = {}): SkipLinkTest => ({ name: 'Skip to content', path: '#skip', targetFound: true, works: true, toMain: true, ...over });
  const page = { hasMain: true, headings: 2 };
  const bare = { hasMain: false, headings: 0 };
  it('fails a skip link to nowhere or one that does not move focus, on a page with no main landmark and no headings', () => {
    expect(bypassVerdict([skip({ targetFound: false, works: false, toMain: false })], bare)).toMatchObject({ status: 'failed', target: '#skip', detail: expect.stringContaining('does not exist') });
    expect(bypassVerdict([skip({ works: false, toMain: false })], bare)).toMatchObject({ status: 'failed', detail: expect.stringContaining('does not move keyboard focus') });
  });
  // Batch 19 (precision lane, real-site dev split): ARIA11 (landmarks) and H69 (headings) are sufficient techniques of
  // their own, and ACT cf77f2 passes when any of its atomic rules passes, so the page has a way to bypass the blocks: the
  // broken link is listed for a person to check (Needs review), never failed.
  it('lists a broken skip link for review when the page has a main landmark or headings', () => {
    expect(bypassVerdict([skip({ targetFound: false, works: false, toMain: false })], page)).toMatchObject({ status: 'flagged', target: '#skip', detail: expect.stringContaining('does not exist') });
    expect(bypassVerdict([skip({ works: false, toMain: false })], page)).toMatchObject({ status: 'flagged', detail: expect.stringContaining('does not move keyboard focus') });
    expect(bypassVerdict([skip({ works: false, toMain: false })], { hasMain: false, headings: 3 })).toMatchObject({ status: 'flagged', detail: expect.stringContaining('headings') });
    expect(bypassVerdict([skip({ works: false, toMain: false })], { hasMain: true, headings: 0 })).toMatchObject({ status: 'flagged', detail: expect.stringContaining('main landmark') });
  });
  it('a broken skip link beside one that works: the working one is the mechanism', () => {
    expect(bypassVerdict([skip({ name: 'Skip to search', path: '#s2', works: false, toMain: false }), skip()], bare)).toMatchObject({ status: 'ok' });
  });
  it('accepts a working skip link, or a main landmark or headings', () => {
    expect(bypassVerdict([skip()], { hasMain: false, headings: 0 })).toMatchObject({ status: 'ok' });
    expect(bypassVerdict([], { hasMain: true, headings: 0 })).toMatchObject({ status: 'ok' });
    expect(bypassVerdict([], { hasMain: false, headings: 1 })).toMatchObject({ status: 'ok' });
  });
  // W3C ACT cf77f2's passed examples (2026-11-07 audit: 10 false failures).
  it('accepts a working skip link to any target but the page end, content that comes first, and a toggle for the navigation', () => {
    expect(bypassVerdict([skip({ toMain: false, name: "Skip to translator's biography" })], { hasMain: false, headings: 0 })).toMatchObject({ status: 'ok' });
    expect(bypassVerdict([skip({ toMain: false, name: 'Skip to footer' })], { hasMain: false, headings: 0 })).toMatchObject({ status: 'failed' });
    expect(bypassVerdict([], { hasMain: false, headings: 0, contentFirst: true })).toMatchObject({ status: 'ok', detail: expect.stringContaining('nothing to bypass') });
    // A toggle counts only once pressing it took the navigation's links out of the Tab order (Grok round 1).
    expect(bypassVerdict([], { hasMain: false, headings: 0, toggle: 'Hide table of content', toggleWorks: true })).toMatchObject({ status: 'ok' });
    expect(bypassVerdict([], { hasMain: false, headings: 0, toggle: 'Show menu', toggleWorks: false })).toMatchObject({ status: 'failed' });
    expect(bypassVerdict([], { hasMain: false, headings: 0, toggle: 'Show menu' })).toMatchObject({ status: 'failed' });
    expect(bypassVerdict([], { hasMain: false, headings: 0, toggle: 'Show menu', toggleUntested: 'no time' })).toMatchObject({ status: 'not_testable' });
  });
  it('a working skip link whose target is not past the repeated blocks bypasses nothing (Grok round 1)', () => {
    expect(bypassVerdict([skip({ toMain: false, past: false })], { hasMain: false, headings: 0 })).toMatchObject({ status: 'failed', detail: expect.stringContaining('bypasses nothing') });
    // A main landmark or headings still pass the page.
    expect(bypassVerdict([skip({ toMain: false, past: false })], { hasMain: true, headings: 0 })).toMatchObject({ status: 'ok' });
  });
  it('fails a page with none of them', () => {
    expect(bypassVerdict([], { hasMain: false, headings: 0 })).toMatchObject({ status: 'failed', detail: expect.stringContaining('No skip link') });
  });
  // W3C precision lane (2026-11-11): a skip control (a button) bypasses when it works, and never fails of its own.
  it('a skip control is a button whose name names where it goes, never an action, a show-or-hide or a step (Fable review F2)', () => {
    const b = (name: string, o: Partial<Parameters<typeof isSkipControl>[0]> = {}) => isSkipControl({ tag: 'button', name, ...o });
    for (const n of ['Skip to main content', 'Skip navigation', 'Skip to content', 'Jump to content', 'Main content', 'Skip over the menu', 'Aller au contenu']) expect(b(n), n).toBe(true);
    for (const n of ['Skip', 'Skip intro', 'Skip tour', 'Skip this step', 'Skip survey', 'Hide main content', 'Show main content', 'Content', 'Skip to checkout']) expect(b(n), n).toBe(false);
    expect(b('Skip to main content', { tag: 'a', anchor: { targetFound: true, toMain: true } })).toBe(false);
    expect(b('Skip to main content', { tag: 'span', role: 'button' })).toBe(true);
    expect(b('Skip to main content', { tag: 'input', itype: 'button' })).toBe(true);
    expect(b('Skip to main content', { tag: 'div' })).toBe(false);
  });

  it('a skip control counts when it works, is not tested when it could not be pressed, and is nothing when it moved nothing', () => {
    const control = (o: Partial<SkipLinkTest> = {}): SkipLinkTest => skip({ path: '#btn', control: true, ...o });
    const none = { hasMain: false, headings: 0 };
    expect(bypassVerdict([control()], none)).toMatchObject({ status: 'ok' });
    expect(bypassVerdict([control({ works: false, toMain: false, untested: 'it sends a form' })], none)).toMatchObject({ status: 'not_testable', target: '#btn', detail: 'it sends a form' });
    expect(bypassVerdict([control({ works: false, toMain: false, untested: 'it sends a form' })], { hasMain: true, headings: 0 })).toMatchObject({ status: 'ok' });
    // Moved nothing: never "a broken skip link", whatever else the page has; with nothing else, the page still fails.
    expect(bypassVerdict([control({ targetFound: false, works: false, toMain: false, name: 'Skip intro' })], { hasMain: false, headings: 2 })).toMatchObject({ status: 'ok' });
    expect(bypassVerdict([control({ targetFound: false, works: false, toMain: false })], none)).toMatchObject({ status: 'failed', target: '#btn', detail: expect.stringContaining('was pressed and did not move keyboard focus') });
    // A skip link's own failure still stands beside a control that moved nothing.
    expect(bypassVerdict([skip({ targetFound: false, works: false, toMain: false }), control({ targetFound: false, works: false, toMain: false })], none)).toMatchObject({ status: 'failed', target: '#skip', detail: expect.stringContaining('does not exist') });
    // One that moved focus to a place before the repeated links bypasses nothing either.
    expect(bypassVerdict([control({ past: false })], none)).toMatchObject({ status: 'failed', detail: expect.stringContaining('No working skip link') });
  });
  it('a skip link that could not be activated is not testable, never working (F2)', () => {
    expect(bypassVerdict([skip({ works: false, toMain: false, untested: 'could not be focused again' })], page)).toMatchObject({ status: 'not_testable', detail: 'could not be focused again' });
    expect(bypassVerdict([skip({ works: false, toMain: false, untested: 'x' }), skip({ path: '#s2' })], page)).toMatchObject({ status: 'ok' });
  });
  it('is not testable when the skip link needed a request the guard stopped, or was not tried in time', () => {
    const stopped = { kind: 'blocked', method: 'POST', reason: 'method' as const, url: 'https://e.org/track' };
    expect(bypassVerdict([skip({ works: false, toMain: false, stopped })], page)).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('https://e.org/track') });
    expect(bypassVerdict([skip({ works: false, toMain: false, stopped: { kind: 'navigation', url: 'https://e.org/x' } })], page)).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('page load') });
    // Another skip link works: that is enough.
    expect(bypassVerdict([skip({ works: false, toMain: false, stopped }), skip({ path: '#s2' })], page)).toMatchObject({ status: 'ok' });
    expect(bypassVerdict([], { hasMain: false, headings: 0 }, 1)).toMatchObject({ status: 'not_testable' });
  });
  it('recognises skip link names in several languages, not ordinary links', () => {
    for (const n of ['Skip to main content', 'Jump to content', 'Skip navigation', 'Main content', 'Content', 'Aller au contenu', 'Zum Inhalt', 'Ir al contenido']) expect(SKIP_LINK_NAME.test(n), n).toBe(true);
    for (const n of ['Contact us', 'Our content strategy', 'Home', 'Back to top']) expect(SKIP_LINK_NAME.test(n), n).toBe(false);
  });
});

describe('3.2.1 change of context on focus', () => {
  const e = { added: 0, removed: 0, elements: 500 };
  it('navigation, a popup, a dialog, a window.open call or focus taken away', () => {
    expect(contextChange({ ...e, navigation: 'https://e.org/next' })).toBe('started a navigation to https://e.org/next');
    expect(contextChange({ ...e, popup: 'https://e.org/promo' })).toBe('opened a new window (https://e.org/promo)');
    expect(contextChange({ ...e, popup: '' })).toBe('opened a new window');
    expect(contextChange({ ...e, opens: 1 })).toBe('tried to open a new window');
    expect(contextChange({ ...e, dialog: 'alert' })).toBe('opened a browser alert dialog');
    expect(contextChange({ ...e, focusLost: true })).toContain('took the focus away');
  });
  it('a large replacement of content, but not content only added or a small change', () => {
    expect(contextChange({ added: 200, removed: 200, elements: 600 })).toContain('replaced a large part of the page');
    expect(contextChange({ added: 400, removed: 0, elements: 600 })).toBeNull();
    expect(contextChange({ added: 30, removed: 30, elements: 100 })).toBeNull();
    expect(contextChange({ added: 60, removed: 60, elements: 5000 })).toBeNull();
    expect(contextChange(e)).toBeNull();
  });
});

describe('3.2.1 event effects', () => {
  it('a document navigation the guard blocked counts, whatever the reason (F6)', () => {
    const url = 'https://e.org/page';
    for (const reason of ['method', 'action']) {
      expect(eventEffects({ events: [{ kind: 'blocked', reason, resourceType: 'document', mainFrame: true, url: 'https://e.org/logout' }] }, url), reason).toEqual({ navigation: 'https://e.org/logout' });
    }
    // Not a frame or a beacon.
    expect(eventEffects({ events: [{ kind: 'blocked', reason: 'action', resourceType: 'ping', url: 'https://e.org/logout' }] }, url)).toEqual({});
    // A frame's document (no mainFrame mark) is not a change of context (5).
    expect(eventEffects({ events: [{ kind: 'blocked', reason: 'action', resourceType: 'document', url: 'https://e.org/cart/w' }] }, url)).toEqual({});
  });
});

describe('2.1.4 character key shortcuts', () => {
  const quiet = { changed: 0, toggled: 0 };
  const k = { scrolled: 0, changed: 0, toggled: 0 };
  it('decisive effects need no confirmation', () => {
    expect(shortcutEffect({ ...k, focus: '#q' }, quiet)).toEqual({ what: 'moved keyboard focus to #q', confirm: false, recheck: true });
    expect(shortcutEffect({ ...k, scrolled: 400 }, quiet)).toEqual({ what: 'scrolled the page by 400 px', confirm: false });
    expect(shortcutEffect({ ...k, navigation: 'https://e.org/s' }, quiet)?.confirm).toBe(false);
    expect(shortcutEffect({ ...k, popup: '' }, quiet)?.what).toBe('opened a new window');
    expect(shortcutEffect({ ...k, dialog: 'confirm' }, quiet)?.what).toBe('opened a browser confirm dialog');
  });
  it('DOM changes count on a quiet page, and need a second press on a page that changes by itself', () => {
    // On a quiet page a DOM change is done again from a fresh load (real sites, 2026-11-07: a carousel tick met a key press).
    expect(shortcutEffect({ ...k, changed: 3 }, quiet)).toEqual({ what: 'changed the page (3 elements added or removed)', confirm: false, recheck: true });
    expect(shortcutEffect({ ...k, changed: 1 }, quiet)).toEqual({ what: 'changed the page (1 element added or removed)', confirm: false, recheck: true });
    expect(shortcutEffect({ ...k, toggled: 1 }, { changed: 2, toggled: 0 })?.confirm).toBe(true);
    expect(confirmed(3, 0)).toBe(true);
    expect(confirmed(1, 0)).toBe(true);
    expect(confirmed(0, 0)).toBe(false);
    expect(confirmed(5, 1)).toBe(false);
    expect(confirmed(6, 1)).toBe(true);
  });
  it('small scrolls and nothing are no effect', () => {
    expect(shortcutEffect({ ...k, scrolled: 39 }, quiet)).toBeNull();
    expect(shortcutEffect(k, quiet)).toBeNull();
  });
  it('recognises a control that turns shortcuts off or remaps them', () => {
    for (const n of ['Keyboard shortcuts', 'Shortcuts: on', 'Hotkeys', 'Hot-keys', 'Key bindings', 'Access keys']) expect(SHORTCUT_CONTROL.test(n), n).toBe(true);
    for (const n of ['Keyboard', 'Short story', 'Cuts']) expect(SHORTCUT_CONTROL.test(n), n).toBe(false);
  });
});

describe('2.1.2 close buttons', () => {
  it('recognises close buttons by name', () => {
    for (const n of ['Close', 'Close dialog', '×', '✕', '✖', 'X', 'Dismiss', 'Cancel', 'No thanks', 'No, thanks', 'Not now']) expect(CLOSE_NAME.test(n), n).toBe(true);
    // Primary actions are never pressed (F5): they may agree, submit or move on.
    for (const n of ['Sign up', 'Good', 'Closet sale', 'Continue', 'OK', 'Done', 'Skip', 'Back', 'Accept', 'Accept all', 'Got it']) expect(CLOSE_NAME.test(n), n).toBe(false);
    // The whole name, from an exact list (4): never a destructive action that starts the same way.
    for (const n of ['Close window', 'close modal', ' Close menu ', 'Close popup', 'No, thanks']) expect(CLOSE_NAME.test(n.trim()), n).toBe(true);
    for (const n of ['Close account', 'Cancel subscription', 'Close and delete', 'Cancel order', 'Dismiss all notifications', 'Close dialog and sign out']) expect(CLOSE_NAME.test(n), n).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.4.11 focus indicator contrast (Task 4.10): the ring around the element, focused against unfocused.

/** A W×H RGBA image filled with `bg`; `paint` sets single pixels. */
function canvas(w: number, h: number, bg: Rgb): RgbaImage & { paint(x: number, y: number, c: Rgb): void; rect(x: number, y: number, rw: number, rh: number, c: Rgb): void } {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([bg[0], bg[1], bg[2], 255], i * 4);
  const img = {
    width: w, height: h, data,
    paint(x: number, y: number, c: Rgb) { if (x >= 0 && y >= 0 && x < w && y < h) data.set([c[0], c[1], c[2], 255], (y * w + x) * 4); },
    rect(x: number, y: number, rw: number, rh: number, c: Rgb) { for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) img.paint(xx, yy, c); },
  };
  return img;
}
/** The element (a button, 40×20 at 10,10, filled `fill`) on a white page; `ring` draws its focus ring of width `wd` just outside the box. */
function focusPair(fill: Rgb, ring?: { c: Rgb; wd: number; offset?: number; aa?: Rgb }) {
  const before = canvas(60, 40, [255, 255, 255]);
  before.rect(10, 10, 40, 20, fill);
  const after = canvas(60, 40, [255, 255, 255]);
  after.rect(10, 10, 40, 20, fill);
  if (ring) {
    const o = ring.offset ?? 0;
    for (let k = 0; k < ring.wd; k++) {
      const d = o + k + 1;
      after.rect(10 - d, 10 - d, 40 + 2 * d, 1, ring.c);
      after.rect(10 - d, 30 + d - 1, 40 + 2 * d, 1, ring.c);
      after.rect(10 - d, 10 - d, 1, 20 + 2 * d, ring.c);
      after.rect(50 + d - 1, 10 - d, 1, 20 + 2 * d, ring.c);
    }
    if (ring.aa) {
      // An anti-aliased outer edge: a lighter one-pixel line around the ring.
      const d = o + ring.wd + 1;
      after.rect(10 - d, 10 - d, 40 + 2 * d, 1, ring.aa);
      after.rect(10 - d, 30 + d - 1, 40 + 2 * d, 1, ring.aa);
      after.rect(10 - d, 10 - d, 1, 20 + 2 * d, ring.aa);
      after.rect(50 + d - 1, 10 - d, 1, 20 + 2 * d, ring.aa);
    }
  }
  return { before, after, box: [10, 10, 40, 20] as const };
}

describe('1.4.11 focus indicator contrast', () => {
  it('the band around the box: four strips outside it, the box rounded outward', () => {
    expect(ringBands([10.5, 10.2, 40, 20], 3)).toEqual([[7, 7, 47, 3], [7, 31, 47, 3], [7, 10, 3, 21], [51, 10, 3, 21]]);
  });

  it('a thin pale ring fails; a strong one does not', () => {
    const pale = focusPair([240, 240, 240], { c: [221, 221, 221], wd: 1 });
    const v = focusRingContrast({ ...pale, band: 3 });
    expect(v).toMatchObject({ kind: 'failed', colour: [221, 221, 221], behind: [255, 255, 255] });
    expect(v.kind === 'failed' && v.ratio).toBeCloseTo(1.36, 1);
    // Batch 18 precision: the same pale ring touching a blue button has 3:1 against the button's fill next to it, so it is
    // not proven insufficient (not measured); set 4 px off the button it touches only the page, and fails.
    expect(focusRingContrast({ ...focusPair([0, 95, 204], { c: [221, 221, 221], wd: 1 }), band: 3 })).toEqual({ kind: 'unmeasured', reason: 'adjacent' });
    expect(focusRingContrast({ ...focusPair([0, 95, 204], { c: [221, 221, 221], wd: 2, offset: 4 }), band: 7, gap: 4 }).kind).toBe('failed');
    const strong = focusRingContrast({ ...focusPair([0, 95, 204], { c: [26, 79, 160], wd: 2 }), band: 3 });
    expect(strong).toMatchObject({ kind: 'ok' });
    expect(strong.kind === 'ok' && strong.ratio).toBeGreaterThan(7);
  });

  it('a ring just at the threshold (#767676 on white, 4.5:1) and a 3:1 one do not fail; 2.9:1 does', () => {
    expect(focusRingContrast({ ...focusPair([255, 255, 255], { c: [118, 118, 118], wd: 1 }), band: 2 }).kind).toBe('ok');
    expect(focusRingContrast({ ...focusPair([255, 255, 255], { c: [148, 148, 148], wd: 1 }), band: 2 }).kind).toBe('ok');
    expect(focusRingContrast({ ...focusPair([255, 255, 255], { c: [151, 151, 151], wd: 1 }), band: 2 }).kind).toBe('failed');
  });

  it('anti-aliased edges do not lower a strong ring (98th percentile of the changed pixels)', () => {
    const v = focusRingContrast({ ...focusPair([255, 255, 255], { c: [0, 0, 0], wd: 2, aa: [235, 235, 235] }), band: 4 });
    expect(v.kind).toBe('ok');
    // Even when the faint edge pixels outnumber the solid ones: a 1 px ring with a 2 px faint halo.
    const halo = focusPair([255, 255, 255], { c: [40, 40, 40], wd: 1, aa: [240, 240, 240] });
    halo.after.rect(5, 5, 50, 1, [245, 245, 245]);
    expect(focusRingContrast({ ...halo, band: 6 }).kind).toBe('ok');
  });

  it('a ring with an offset (a gap between the box and the ring) is measured', () => {
    expect(focusRingContrast({ ...focusPair([255, 255, 255], { c: [230, 230, 230], wd: 1, offset: 2 }), band: 4 }).kind).toBe('failed');
    expect(focusRingContrast({ ...focusPair([255, 255, 255], { c: [20, 20, 20], wd: 1, offset: 2 }), band: 4 }).kind).toBe('ok');
  });

  it('changes inside the box (a fill or border colour change on focus) are not the ring: not measured', () => {
    const { before, after, box } = focusPair([200, 200, 200]);
    after.rect(10, 10, 40, 20, [210, 210, 210]);
    expect(focusRingContrast({ before, after, box, band: 3 })).toEqual({ kind: 'unmeasured', reason: 'no-ring' });
    // Fewer than MIN_RING_PIXELS changed pixels outside the box: no ring either.
    const speck = focusPair([200, 200, 200]);
    for (let i = 0; i < MIN_RING_PIXELS - 1; i++) speck.after.paint(9, 10 + i, [0, 0, 0]);
    expect(focusRingContrast({ ...speck, band: 3 })).toEqual({ kind: 'unmeasured', reason: 'no-ring' });
  });

  it('a pale ring is judged against what it covers: a pale ring on a dark page passes, a dark ring on a dark page fails', () => {
    const dark = (ring: Rgb) => {
      const before = canvas(60, 40, [20, 20, 20]);
      before.rect(10, 10, 40, 20, [80, 80, 80]);
      const after = canvas(60, 40, [20, 20, 20]);
      after.rect(10, 10, 40, 20, [80, 80, 80]);
      after.rect(8, 8, 44, 2, ring); after.rect(8, 30, 44, 2, ring); after.rect(8, 8, 2, 24, ring); after.rect(50, 8, 2, 24, ring);
      return { before, after, box: [10, 10, 40, 20] as const, band: 3 };
    };
    expect(focusRingContrast(dark([230, 230, 230])).kind).toBe('ok');
    expect(focusRingContrast(dark([60, 60, 60])).kind).toBe('failed');
  });

  it('an outline whose colour has 3:1 but whose pixels never show it is not failed (not confirmed)', () => {
    // The style says a black outline; the pixels show only a faint grey (opacity, scaling): unconfirmed, not a failure.
    const pair = focusPair([255, 255, 255], { c: [200, 200, 200], wd: 1 });
    expect(focusRingContrast({ ...pair, band: 2, outline: [0, 0, 0, 1] })).toEqual({ kind: 'unmeasured', reason: 'unconfirmed' });
    // The same pixels with the matching style colour: a real failure.
    expect(focusRingContrast({ ...pair, band: 2, outline: [200, 200, 200, 1] }).kind).toBe('failed');
    // A see-through outline colour is not a reason to doubt the pixels.
    expect(focusRingContrast({ ...pair, band: 2, outline: [0, 0, 0, 0.2] }).kind).toBe('failed');
  });

  it('a pale ring that comes with another focus cue (fill, border, colour change) is not failed on the ring alone', () => {
    const pair = focusPair([255, 255, 255], { c: [221, 221, 221], wd: 1 });
    expect(focusRingContrast({ ...pair, band: 2, alsoChanged: true })).toEqual({ kind: 'unmeasured', reason: 'combined' });
    // A strong ring with other cues is still measured as ok.
    expect(focusRingContrast({ ...focusPair([255, 255, 255], { c: [0, 0, 0], wd: 1 }), band: 2, alsoChanged: true }).kind).toBe('ok');
  });

  it('screenshots of different sizes are not measured', () => {
    const a = focusPair([255, 255, 255], { c: [0, 0, 0], wd: 1 });
    expect(focusRingContrast({ before: canvas(61, 40, [255, 255, 255]), after: a.after, box: a.box, band: 2 })).toEqual({ kind: 'unmeasured', reason: 'no-ring' });
  });
});

describe('shortcutRemapPattern (2.1.4 remap option, 2026-11-09)', () => {
  const remaps = (key: string, name: string) => new RegExp(shortcutRemapPattern(key), 'i').test(name);
  it('matches a setting that names a modifier key and the shortcut key', () => {
    expect(remaps('j', 'Add notes only with the Alt key held down with "J"')).toBe(true);
    expect(remaps('+', 'Use the Ctrl key together with the "+" key')).toBe(true);
    expect(remaps('/', 'Require modifier keys for the / key')).toBe(true);
    expect(remaps('?', 'Command key plus “?” opens help')).toBe(true);
  });
  it('does not match a modifier-key setting about something else, or about another key', () => {
    expect(remaps('j', 'Hold the Shift key to pick several days')).toBe(false);
    expect(remaps('j', 'Use the Alt key with "K"')).toBe(false);
    expect(remaps('j', 'Jump to the "J" section')).toBe(false);
    expect(remaps('.', 'Use the Ctrl key with "x"')).toBe(false);
  });
});

describe('advisedExitKeys (2.1.2: the method the page tells, 2026-11-09)', () => {
  it('reads modifier combinations and function keys tied to leaving', () => {
    expect(advisedExitKeys('Use Alt+Q to leave the seat picker.')).toEqual(['Alt+q']);
    expect(advisedExitKeys('Press Ctrl + Shift + E to exit the editor. Press F6 to move out of the toolbar.')).toEqual(['Control+Shift+e', 'F6']);
  });
  it('tries plain letters and other named instructions as candidates, regardless of word order', () => {
    expect(advisedExitKeys('Press Ctrl+S to save your draft.')).toEqual(['Control+s']);
    expect(advisedExitKeys('Press Q to exit.')).toEqual(['q']);
    expect(advisedExitKeys('To leave, press Alt+Q.')).toEqual(['Alt+q']);
    expect(advisedExitKeys('Press Ctrl+F6 to exit.')).toEqual(['Control+F6']);
  });
});
