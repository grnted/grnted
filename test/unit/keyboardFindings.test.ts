// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Keyboard traversal → findings (Plan 4 Task 4.1), with synthetic traversals: one rule per criterion,
// the evidence, grouping and caps, and the not_testable cases (guarded exits, time budget, no focus).
import { describe, expect, it } from 'vitest';
import { clickableFindings, isListedClickable, traversalFindings } from '../../src/probes/keyboard/findings.js';
import type { Stop, Traversal } from '../../src/probes/keyboard/traverse.js';
import type { GuardEvent } from '../../src/probes/types.js';

const URL0 = 'https://e.org/page';
const NO_EXITS = { links: [], submits: [], buttons: [] };
const ALL = ['2.1.1', '2.1.2', '2.4.1', '2.4.3', '2.4.7', '2.4.11', '3.2.1'];
let next = 1;
const stop = (over: Partial<Stop> = {}): Stop => {
  const id = over.id ?? next++;
  return {
    id, tag: 'a', name: `Link ${id}`, path: `#l${id}`, sig: 'a.<p.', group: 'main', box: { x: 20, y: 20, w: 80, h: 20 }, pageX: 20, pageY: 20 * id,
    dir: 'forward', events: [], hidden: null, obscuredBy: null, focusins: 1, added: 0, removed: 0, semantic: 0, opens: 0, navs: 0, elements: 300, inMain: true, ...over,
  };
};
const trav = (over: Partial<Traversal> = {}): Traversal => ({
  forward: [stop(), stop(), stop()], backward: [], traps: [], skips: [], layout: { hasMain: true, headings: 3 }, tabbables: 3, partial: false,
  skipsUntested: 0, noFocus: false, viewportHeight: 900, ...over,
});
const by = (list: ReturnType<typeof traversalFindings>, c: string) => list.filter((f) => f.criterion === c);

describe('traversal findings', () => {
  it('an ordinary page gives no findings', () => {
    expect(traversalFindings(trav(), ALL, URL0)).toEqual([]);
  });

  it('a page where nothing takes focus: not applicable', () => {
    const list = traversalFindings(trav({ forward: [], tabbables: 0 }), ALL, URL0);
    expect(list.map((f) => [f.criterion, f.status])).toEqual(['2.1.2', '2.4.1', '2.4.3', '2.4.7', '2.4.11', '3.2.1'].map((c) => [c, 'not_applicable']));
  });

  it('focusable elements that Tab never reaches: 2.1.1 failed, the rest not testable', () => {
    const list = traversalFindings(trav({ forward: [], tabbables: 12, noFocus: true }), ALL, URL0);
    expect(by(list, '2.1.1')).toEqual([expect.objectContaining({ status: 'failed', detail: expect.stringContaining('none of the 12 focusable elements') })]);
    for (const c of ['2.1.2', '2.4.3', '2.4.7', '2.4.11', '3.2.1']) expect(by(list, c).map((f) => f.status), c).toEqual(['not_testable']);
    // The bypass verdict still applies (landmarks and headings): no finding here.
    expect(by(list, '2.4.1')).toEqual([]);
  });

  it('2.1.2: a trap with no way out fails; a way out, or nothing outside it, does not', () => {
    const trap = { members: [1, 2], names: ['Prev', 'Next'], region: { path: '#widget', name: 'Date picker' }, escaped: null, pressed: [], outside: 3, exits: NO_EXITS, dialog: false, logFull: false };
    expect(by(traversalFindings(trav({ traps: [trap] }), ALL, URL0), '2.1.2')).toEqual([{
      criterion: '2.1.2', status: 'failed', target: '#widget',
      detail: 'Keyboard focus is trapped in "Date picker" (#widget): Tab cycles through 2 elements ("Prev", "Next"), and neither Shift+Tab nor Esc moves focus out, while 3 other focusable elements are out of reach.',
    }]);
    expect(by(traversalFindings(trav({ traps: [{ ...trap, escaped: 'escape' }] }), ALL, URL0), '2.1.2')).toEqual([]);
    expect(by(traversalFindings(trav({ traps: [{ ...trap, outside: 0 }] }), ALL, URL0), '2.1.2')).toEqual([]);
  });

  it('2.1.2: untried exits, a full log, or a press that also sent something are not testable, never failed (F5, F7)', () => {
    const trap = { members: [1, 2], names: [], region: { path: '#d', name: 'Survey' }, escaped: null, pressed: [], outside: 3, exits: NO_EXITS, dialog: true, logFull: false };
    const one = (over: object) => by(traversalFindings(trav({ traps: [{ ...trap, ...over }] }), ALL, URL0), '2.1.2');
    expect(one({ exits: { ...NO_EXITS, links: ['Leave'] } })).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('follow a link or submit a form ("Leave")') })]);
    expect(one({ exits: { ...NO_EXITS, submits: ['Save'] } })).toEqual([expect.objectContaining({ status: 'not_testable' })]);
    expect(one({ exits: { ...NO_EXITS, buttons: ['Accept all'] } })).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('"Accept all"') })]);
    // Other buttons outside a dialog (a date picker's "Next month"): a trap.
    expect(one({ exits: { ...NO_EXITS, buttons: ['Next month'] }, dialog: false })).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(one({ logFull: true })).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('log was full') })]);
    const stopped: GuardEvent = { kind: 'blocked', method: 'POST', reason: 'method', url: 'https://e.org/closed', at: 1 };
    expect(one({ escaped: 'close', pressed: ['Close'], stopped })).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('https://e.org/closed') })]);
    expect(one({ escaped: 'close', pressed: ['Close'] })).toEqual([]);
  });

  // Batch 19: a hidden stop is 2.4.7 now, so a stop that never settled leaves 2.4.7 (not 2.4.3) and 2.4.11 untested.
  it('stops measured while the page kept scrolling are not testable for 2.4.7 and 2.4.11, never failed', () => {
    const list = traversalFindings(trav({ forward: [stop({ unsettled: true, path: '#m' }), stop()] }), ALL, URL0);
    for (const c of ['2.4.7', '2.4.11']) expect(by(list, c), c).toEqual([expect.objectContaining({ status: 'not_testable', target: '#m', detail: expect.stringContaining('kept scrolling') })]);
  });

  it('a walk that ended inside a frame is not testable for the walk criteria (F3)', () => {
    const list = traversalFindings(trav({ frameStuck: 'iframe' }), ALL, URL0);
    for (const c of ['2.1.2', '2.4.3', '2.4.7', '2.4.11', '3.2.1']) expect(by(list, c).map((f) => f.status), c).toEqual(['not_testable']);
    expect(by(list, '2.4.1')).toEqual([]);
  });

  it('2.1.2: a way out that needed a stopped request is not testable', () => {
    const stopped: GuardEvent = { kind: 'blocked', method: 'POST', reason: 'method', url: 'https://e.org/seen', at: 1 };
    const trap = { members: [1, 2], names: [], region: { path: '#d' }, escaped: null, pressed: ['Close'], outside: 3, stopped, exits: NO_EXITS, dialog: false, logFull: false };
    const [f] = by(traversalFindings(trav({ traps: [trap] }), ALL, URL0), '2.1.2');
    expect(f).toMatchObject({ status: 'not_testable', target: '#d' });
    expect(f!.detail).toContain('POST request to https://e.org/seen');
    const held = by(traversalFindings(trav({ traps: [{ ...trap, stopped: { kind: 'navigation', url: 'https://e.org/x', at: 1 } }] }), ALL, URL0), '2.1.2');
    expect(held[0]!.detail).toContain('would have loaded another page (https://e.org/x)');
  });

  // Batch 19 (the lead's ruling): hidden focus stops are 2.4.7 (the indicator is not visible); 2.4.3 keeps order problems.
  it('2.4.7: hidden focus stops grouped by container; 2.4.3: positive tabindex jumps', () => {
    const forward = [stop({ group: '#drawer', hidden: 'offscreen' }), stop({ group: '#drawer', hidden: 'offscreen' }), stop()];
    const hidden = by(traversalFindings(trav({ forward }), ALL, URL0), '2.4.7').filter((f) => f.status === 'failed');
    expect(hidden).toEqual([expect.objectContaining({ status: 'failed', target: '#drawer', detail: expect.stringContaining('2 elements that are outside the visible page area') })]);
    expect(by(traversalFindings(trav({ forward }), ALL, URL0), '2.4.3').filter((f) => f.status === 'failed')).toEqual([]);
    const jump = [stop({ tabIndex: 1, pageY: 1600, path: '#contact', name: 'Contact' }), stop({ pageY: 30, path: '#home', name: 'Home' })];
    expect(by(traversalFindings(trav({ forward: jump }), ALL, URL0), '2.4.3')).toEqual([
      expect.objectContaining({ status: 'failed', target: '#contact', detail: expect.stringContaining('tabindex="1"') }),
    ]);
    // Fixed content and hidden stops are not part of the reading order.
    expect(by(traversalFindings(trav({ forward: [jump[0]!, { ...jump[1]!, fixed: true }] }), ALL, URL0), '2.4.3')).toEqual([]);
  });

  it('2.4.7: a skip link\'s target (out of the Tab order) is no hidden focus stop (2026-11-07 audit, thprd-parks:175)', () => {
    const forward = [stop({ path: '#skip', name: 'Skip to Main Content' }), stop({ path: '#cc9b', hidden: 'size', linkTarget: true }), stop()];
    const failedOf = (list: ReturnType<typeof traversalFindings>) => by(list, '2.4.7').filter((f) => f.status === 'failed');
    expect(failedOf(traversalFindings(trav({ forward }), ALL, URL0))).toEqual([]);
    expect(failedOf(traversalFindings(trav({ forward: forward.map((s) => ({ ...s, linkTarget: undefined })) }), ALL, URL0))).toHaveLength(1);
  });

  it('2.4.7: only "none" and "clipped" fail, with the measurement', () => {
    const focus = (verdict: 'visible' | 'none' | 'clipped' | 'unknown', changed?: number) =>
      ({ verdict, ...(changed !== undefined ? { changed, total: 900 } : {}), outline: 'none 0px', styleChanged: [] });
    const forward = [stop({ focus: focus('none', 0), path: '#a' }), stop({ focus: focus('clipped', 1), path: '#b' }), stop({ focus: focus('visible', 300) }), stop({ focus: focus('unknown') })];
    const list = by(traversalFindings(trav({ forward }), ALL, URL0), '2.4.7');
    expect(list.map((f) => f.target)).toEqual(['#a', '#b']);
    expect(list[0]!.detail).toContain('0 of 900 pixels changed');
    expect(list[1]!.detail).toContain('cut off by a parent element');
  });

  it('2.4.11: grouped by the covering element, from both directions, each element once', () => {
    const a = stop({ obscuredBy: 'html > body > div', path: '#a' });
    const b = stop({ obscuredBy: 'html > body > div' });
    const c = stop({ obscuredBy: 'header' });
    const list = by(traversalFindings(trav({ forward: [a, b, stop()], backward: [{ ...c, dir: 'backward' }, { ...a, obscuredBy: null, dir: 'backward' }] }), ALL, URL0), '2.4.11');
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ target: '#a', detail: expect.stringContaining('so is 1 more focus stop') });
    expect(list[1]!.detail).toContain('behind header');
  });

  it('3.2.1: navigation, popups, dialogs, window.open and lost focus; not same-page anchors or blocked beacons', () => {
    const ev = (e: Partial<GuardEvent>): GuardEvent => ({ kind: 'navigation', at: 1, ...e });
    const forward = [
      stop({ path: '#nav', events: [ev({ kind: 'navigation', url: 'https://e.org/other' })] }),
      stop({ path: '#post', events: [ev({ kind: 'blocked', method: 'POST', reason: 'method', resourceType: 'document', mainFrame: true, url: 'https://e.org/f' })] }),
      stop({ path: '#pop', events: [ev({ kind: 'popup', url: 'https://e.org/p' })] }),
      stop({ path: '#dlg', events: [ev({ kind: 'dialog', dialog: 'alert' })] }),
      stop({ path: '#open', opens: 1 }),
      stop({ path: '#lost', lost: true }),
      stop({ path: '#hash', events: [ev({ kind: 'url-change', url: `${URL0}#section` })] }),
      stop({ path: '#beacon', events: [ev({ kind: 'blocked', method: 'POST', reason: 'method', resourceType: 'ping', url: 'https://e.org/b' })] }),
      stop({ path: '#menu', added: 40, removed: 0 }),
    ];
    const list = by(traversalFindings(trav({ forward }), ALL, URL0), '3.2.1');
    expect(list.map((f) => f.target)).toEqual(['#nav', '#post', '#pop', '#dlg', '#open', '#lost']);
    expect(list[0]!.detail).toBe('Moving keyboard focus to "Link ' + forward[0]!.id + '" (#nav) started a navigation to https://e.org/other, without the user activating anything.');
  });

  it('2.4.1: bypass verdicts become findings', () => {
    expect(by(traversalFindings(trav({ layout: { hasMain: false, headings: 0 } }), ALL, URL0), '2.4.1')).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(by(traversalFindings(trav({ layout: { hasMain: false, headings: 0 }, skipsUntested: 1 }), ALL, URL0), '2.4.1')).toEqual([expect.objectContaining({ status: 'not_testable' })]);
  });

  it('a budget or a cut that ended the walk before its first stop is not testable, never not applicable (F8)', () => {
    for (const over of [{ partial: true }, { cutReason: 'the page kept trying to load another page by itself' }]) {
      const list = traversalFindings(trav({ forward: [], tabbables: 12, ...over }), ALL, URL0);
      expect(list.filter((f) => f.status === 'not_applicable')).toEqual([]);
      for (const c of ['2.1.2', '2.4.1', '2.4.3', '2.4.7', '2.4.11', '3.2.1']) expect(by(list, c).map((f) => f.status), c).toEqual(['not_testable']);
    }
  });

  it('a walk stopped by its caps: a coverage note, not not_testable (F1)', () => {
    const forward = Array.from({ length: 6 }, () => stop());
    const list = traversalFindings(trav({ forward, tabbables: 40, limits: { forward: 4, backward: 2, fullForward: 300, fullBackward: 300 } }), ALL, URL0);
    expect(list.filter((f) => f.status === 'not_testable')).toEqual([]);
    // Only what was followed: 6 forward, none backward (2).
    expect(by(list, '2.4.7')).toEqual([{ criterion: '2.4.7', status: 'no_failures_found', detail: 'checked 6 focus stops forward and 0 backward of 40 (300 each way with --full)' }]);
  });

  it('a traversal cut by the time budget: not testable where nothing failed, failures kept', () => {
    const forward = [stop({ obscuredBy: 'header' }), stop()];
    const list = traversalFindings(trav({ forward, partial: true }), ALL, URL0);
    expect(by(list, '2.4.11').map((f) => f.status)).toEqual(['failed']);
    for (const c of ['2.1.2', '2.4.3', '2.4.7', '3.2.1']) {
      expect(by(list, c), c).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('only 2 focus stops') })]);
    }
  });

  it('reports only the criteria the probe declares, at most 8 per criterion', () => {
    const forward = Array.from({ length: 20 }, (_, i) => stop({ path: `#x${i}`, sig: `s${i}`, focus: { verdict: 'none', changed: 0, total: 100, outline: 'none 0px', styleChanged: [] } }));
    expect(by(traversalFindings(trav({ forward }), ALL, URL0), '2.4.7')).toHaveLength(8);
    expect(traversalFindings(trav({ forward }), ['2.4.11'], URL0)).toEqual([]);
  });
});

describe('1.4.11 focus indicator contrast (Task 4.10)', () => {
  const C = ['1.4.11'];
  type Focus = NonNullable<Stop['focus']>;
  const ring = (contrast?: Focus['contrast']): Focus => ({ verdict: 'visible', outline: 'solid 1px', styleChanged: ['outline'], indicator: 'ring', ...(contrast ? { contrast } : {}) });
  const failed = (ratio: number): Focus['contrast'] => ({ kind: 'failed', ratio, colour: [221, 221, 221], behind: [255, 255, 255], pixels: 120 });
  const ok: Focus['contrast'] = { kind: 'ok', ratio: 8.2, colour: [26, 79, 160], behind: [255, 255, 255], pixels: 240 };
  const other: Focus = { verdict: 'visible', outline: 'none 0px', styleChanged: ['background'], indicator: 'other' };
  const browser: Focus = { verdict: 'visible', outline: 'auto 1px', styleChanged: ['outline'], indicator: 'browser' };
  const run = (focus: (Focus | undefined)[], over: Partial<Traversal> = {}) =>
    by(traversalFindings(trav({ forward: focus.map((f, i) => stop({ path: `#s${i}`, name: `Item ${i}`, sig: `k${i}`, ...(f ? { focus: f } : {}) })), ...over }), C, URL0), '1.4.11');

  it('a focus ring under 3:1 against the colors next to it fails, with the ratio and colors', () => {
    expect(run([ring(failed(1.36)), ring(ok)])).toEqual([{
      criterion: '1.4.11', status: 'failed', target: '#s0',
      detail: 'The focus indicator of "Item 0" (#s0) has a contrast of 1.3:1 against the colors next to it (#dddddd on #ffffff); a focus indicator needs at least 3:1.',
    }]);
  });

  it('at most 8 failures, one per kind of element, saying how many more of the kind were not measured', () => {
    expect(run(Array.from({ length: 12 }, () => ring(failed(2))))).toHaveLength(8);
    const list = by(traversalFindings(trav({ forward: [stop({ sig: 'a', focus: ring(failed(2)) }), stop({ sig: 'a' }), stop({ sig: 'a' })] }), C, URL0), '1.4.11');
    expect(list[0]!.detail).toContain('2 other focus stops of the same kind were not measured separately');
  });

  it('only strong rings: no finding (no failures found)', () => {
    expect(run([ring(ok), ring(ok), browser])).toEqual([]);
  });

  it('strong rings plus indicators it does not measure: no failures found, with what was not measured', () => {
    expect(run([ring(ok), other, ring({ kind: 'unmeasured', reason: 'unconfirmed' })])).toEqual([{
      criterion: '1.4.11', status: 'no_failures_found',
      detail: 'measured the focus ring of 1 kind of element; 2 focus indicators were not measured (a change inside the element such as its fill or border, a drop shadow, a ring whose color the screenshots could not confirm, a ring next to another focus change, a ring with enough contrast against one of the colors next to it, or an element that only appears when focused)',
    }]);
  });

  it('no ring measured but indicators of the page exist: not testable, never a clean result', () => {
    expect(run([other, other])).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('2 focus indicators') })]);
    expect(run([ring()])).toEqual([expect.objectContaining({ status: 'not_testable' })]);
    expect(run([ring({ kind: 'unmeasured', reason: 'no-ring' })])).toEqual([expect.objectContaining({ status: 'not_testable' })]);
  });

  it("only the browser's own focus ring, or no indicator at all: not applicable (the browser's ring is exempt)", () => {
    expect(run([browser, browser, undefined])).toEqual([{
      criterion: '1.4.11', status: 'not_applicable',
      detail: "no focus indicator styled by the page was found on the focus stops measured (the browser's own focus ring is exempt from 1.4.11)",
    }]);
    expect(run([{ verdict: 'none', outline: 'none 0px', styleChanged: [] }])).toEqual([expect.objectContaining({ status: 'not_applicable' })]);
  });

  it("the browser's own ring on other kinds counts as decided: unmeasured indicators next to it are a note", () => {
    expect(run([browser, other])).toEqual([{
      criterion: '1.4.11', status: 'no_failures_found',
      detail: "1 kind of element shows the browser's own focus ring, which 1.4.11 exempts; 1 focus indicator was not measured (a change inside the element such as its fill or border, a drop shadow, a ring whose color the screenshots could not confirm, a ring next to another focus change, a ring with enough contrast against one of the colors next to it, or an element that only appears when focused)",
    }]);
  });

  it('a time budget cut or a page where nothing takes focus: the usual traversal results', () => {
    expect(run([ring(ok)], { partial: true }).map((f) => f.status)).toEqual(['not_testable']);
    expect(run([ring(failed(1.5))], { partial: true }).map((f) => f.status)).toEqual(['failed']);
    expect(run([], { tabbables: 0 }).map((f) => f.status)).toEqual(['not_applicable']);
    // Not declared by the probe: nothing.
    expect(by(traversalFindings(trav({ forward: [stop({ focus: ring(failed(1.2)) })] }), ['2.4.7'], URL0), '1.4.11')).toEqual([]);
  });

  it('a walk stopped by its caps: the same coverage note as the other criteria when every ring measured fine', () => {
    const list = run([ring(ok)], { tabbables: 40, limits: { forward: 1, backward: 0 } });
    expect(list).toEqual([{ criterion: '1.4.11', status: 'no_failures_found', detail: 'checked 1 focus stops forward and 0 backward of 40' }]);
  });

  it('kinds of element left unmeasured by the sample cap are said, not hidden', () => {
    expect(run([ring(ok)], { samples: { measured: 25, skipped: 4, fullCap: 100 } })).toEqual([{
      criterion: '1.4.11', status: 'no_failures_found',
      detail: 'measured the focus ring of 1 kind of element; 4 more kinds were not measured (100 kinds with --full)',
    }]);
  });
});

describe('2.1.1 mouse-only controls', () => {
  it('one failure per kind of element, with how many more there are', () => {
    expect(clickableFindings([
      { path: '#tile', name: 'Open the gallery', tag: 'div', why: 'click handler', count: 1 },
      { path: '#tabs > li:nth-of-type(1)', name: 'One', tag: 'li', why: 'pointer cursor, click handled by #tabs', count: 3 },
    ])).toEqual([
      { criterion: '2.1.1', status: 'failed', target: '#tile', detail: '"Open the gallery" (#tile) responds to the mouse (click handler) but is not focusable and has no focusable element inside or around it, so it cannot be used with the keyboard.' },
      expect.objectContaining({ target: '#tabs > li:nth-of-type(1)', detail: expect.stringContaining('(and 2 more elements like it)') }),
    ]);
  });

  it('a candidate (nothing declares a control) is listed as not testable, never failed, after the failures', () => {
    const list = clickableFindings([
      { path: '#line', name: 'Office hours this week', tag: 'div', why: 'click handler', count: 2, listed: 'element' },
      { path: '#tile', name: 'Open the gallery', tag: 'div', why: 'click handler', count: 1 },
      { path: '#chart', name: 'Bar chart: enrollment by year', tag: 'canvas', why: 'click handler', count: 1, listed: 'surface' },
    ]);
    expect(list.map((f) => `${f.status} ${f.target}`)).toEqual(['failed #tile', 'not_testable #line', 'not_testable #chart']);
    expect(list[1]!.detail).toBe('"Office hours this week" (#line) cannot get keyboard focus and a script listens for clicks on it (click handler), but the page does not declare it a control (it is no link or button element, has no control role and no pointer cursor of its own) and this test presses nothing, so whether a click there does anything the keyboard cannot was not shown (and 1 more element like it)');
    expect(list[2]!.detail).toBe('"Bar chart: enrollment by year" (#chart) cannot get keyboard focus and a script listens for clicks on it (click handler). It is a drawing or a part of one (a canvas, an svg or an image), which a charting or map library listens on whether or not a click does anything, and this test presses nothing, so whether a click there does anything the keyboard cannot was not shown');
    expect(list.map(isListedClickable)).toEqual([false, true, true]);
  });

  it('a declared control whose content cannot be read (a closed shadow root) is listed as not testable, saying why', () => {
    const list = clickableFindings([{ path: '#hours-button', name: 'Show office hours', tag: 'hours-button', why: 'click handler', count: 1, listed: 'shadow' }]);
    expect(list).toEqual([{
      criterion: '2.1.1', status: 'not_testable', target: '#hours-button',
      detail: '"Show office hours" (#hours-button) cannot get keyboard focus and a script listens for clicks on it (click handler), but what it shows could not all be read (a closed shadow root, a custom element\'s own content, or more than this test reads), so whether it holds a control the keyboard reaches, or is only a drawing, could not be seen, and this test presses nothing',
    }]);
    expect(list.map(isListedClickable)).toEqual([true]);
  });

  it('at most 3 candidates are listed, and they never take the place of a failure', () => {
    const listed = Array.from({ length: 5 }, (_, i) => ({ path: `#c${i}`, tag: 'div', why: 'click handler', count: 1, listed: 'element' as const }));
    const failing = Array.from({ length: 8 }, (_, i) => ({ path: `#f${i}`, tag: 'div', why: 'click handler', count: 1 }));
    const list = clickableFindings([...listed, ...failing]);
    expect(list.filter((f) => f.status === 'failed')).toHaveLength(8);
    expect(list.filter((f) => f.status === 'not_testable').map((f) => f.target)).toEqual(['#c0', '#c1', '#c2']);
  });
});
