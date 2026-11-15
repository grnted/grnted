// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The pointer probes' decision rules (Plan 4 Task 4.5): names, press outcomes, gesture results,
// region screenshots, registration, and the criteria rows when the probes are off or deep.
import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../../src/probes/pixels.js';
import {
  cancelDetail, cancelFindings, cancelOutcome, pointerCancellationProbe,
  type CancelResult, type DownCandidate, type PressFacts,
} from '../../src/probes/pointerCancellation.js';
import {
  familiesOf, gestureDetail, gestureFindings, keptAfterStop, pointerGesturesProbe, quietPixels, regionChanged,
  type GestureCandidate, type GestureResult,
} from '../../src/probes/pointerGestures.js';
import { framesReason, isActionName, isAlternativeName, requestKey, type StateDiff } from '../../src/probes/pointerKit.js';
import { PROBES } from '../../src/probes/registry.js';
import type { GuardEvent } from '../../src/probes/types.js';
import { CRITERIA } from '../../src/report/criteria.js';
import { scanSite } from '../../src/scan.js';
import { fakeProbeBrowser } from '../helpers/probes.js';

const why = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return 'did not throw';
};

describe('names', () => {
  it('elements named for an action on the live site are never pressed', () => {
    for (const n of ['Log out', 'Sign out', 'logout', 'Delete account', 'Remove item', 'Subscribe', 'Unsubscribe', 'Checkout', 'Check out', 'Buy now', 'Pay', 'Donate', 'Cancel my order', 'Place order',
      'Sign off', 'sign-off', 'signoff', 'Log me out', 'Sign me out', 'End session', 'Deactivate', 'Close account']) {
      expect(isActionName(n), n).toBe(true);
    }
    for (const n of ['Read more', 'Show details', 'Next', 'Payroll calendar', 'Removal of snow', undefined, '']) expect(isActionName(n), String(n)).toBe(false);
  });

  it('single-pointer alternatives are recognised by name only', () => {
    // Unambiguous whole names only: a nearby word from a long list is no proof.
    for (const n of ['Next', 'Previous', 'prev', 'Next slide', 'Previous slide', 'Go to slide 3', 'Slide 2', '2', '›', '❯', '→']) expect(isAlternativeName('swipe', n), n).toBe(true);
    for (const n of ['Show more', 'Read the story', 'Back', 'Left', 'Back to top', 'Next steps for families', 'Scroll right']) expect(isAlternativeName('swipe', n), n).toBe(false);
    for (const n of ['Zoom in', 'Zoom out', '+', '−']) expect(isAlternativeName('zoom', n), n).toBe(true);
    for (const n of ['Directions', 'Minus', 'Zoom meeting link']) expect(isAlternativeName('zoom', n), n).toBe(false);
    for (const n of ['Pan left', 'Pan up', '↑', '←']) expect(isAlternativeName('pan', n), n).toBe(true);
    for (const n of ['Left', 'Move north', 'Left-handed scissors']) expect(isAlternativeName('pan', n), n).toBe(false);
    for (const n of ['Move up', 'Move down', '▼', '↑']) expect(isAlternativeName('sort', n), n).toBe(true);
    // The item named between the verb and the direction (sim lab: "Move Parks up" was not recognised).
    for (const n of ['Move Parks up', 'Move Parks down', 'Move Street repairs up one place']) expect(isAlternativeName('sort', n), n).toBe(true);
    for (const n of ['Up', 'Sign up', 'Move to top', 'Move', 'Moved up', 'Remove Parks up']) expect(isAlternativeName('sort', n), n).toBe(false);
    for (const n of ['Increase', 'Decrease', '+', '−']) expect(isAlternativeName('slider', n), n).toBe(true);
    for (const n of ['Font size', 'Add', 'Add to calendar', 'Less']) expect(isAlternativeName('slider', n), n).toBe(false);
  });
});

const NO_CHANGE: StateDiff = { changed: false, shown: 0, hidden: 0 };
const SHOWN: StateDiff = { changed: true, shown: 1, hidden: 0, text: 'Opening hours' };
const ev = (e: Partial<GuardEvent>): GuardEvent => ({ kind: 'blocked', at: 0, ...e });
const facts = (f: Partial<PressFacts> = {}): PressFacts => ({
  moving: false, down: [], all: [], background: [], onPress: NO_CHANGE, afterRelease: NO_CHANGE, clicks: [], ...f,
});

describe('2.5.2: one press', () => {
  it('fails a navigation, a new window or an address change while the button is down', () => {
    const nav = ev({ kind: 'navigation', url: 'https://e.org/about' });
    expect(cancelOutcome(facts({ down: [nav], all: [nav] }))).toEqual({ kind: 'failed', how: 'navigation', url: 'https://e.org/about' });
    expect(cancelOutcome(facts({ down: [ev({ kind: 'url-change', url: 'https://e.org/#x' })] }))).toMatchObject({ kind: 'failed', how: 'navigation' });
    expect(cancelOutcome(facts({ down: [ev({ kind: 'popup', url: 'https://e.org/p' })] }))).toEqual({ kind: 'failed', how: 'popup', url: 'https://e.org/p' });
  });

  it('fails a change on press that moving away and releasing does not undo; not one it undoes, nor a list of choices', () => {
    expect(cancelOutcome(facts({ onPress: SHOWN, afterRelease: SHOWN }))).toEqual({ kind: 'failed', how: 'content', diff: SHOWN });
    expect(cancelOutcome(facts({ onPress: SHOWN, afterRelease: NO_CHANGE }))).toEqual({ kind: 'ok' });
    const menu = { ...SHOWN, choices: true };
    expect(cancelOutcome(facts({ onPress: menu, afterRelease: menu }))).toEqual({ kind: 'ok' });
    // Something that only happens after the release is not an action on the down event.
    expect(cancelOutcome(facts({ onPress: NO_CHANGE, afterRelease: SHOWN }))).toEqual({ kind: 'ok' });
  });

  it('a measured failure stays failed when the guard also stopped a request; a form sent while pressed is failed', () => {
    const get = ev({ method: 'GET', url: 'https://e.org/api/session/end', reason: 'data', resourceType: 'fetch' });
    expect(cancelOutcome(facts({ all: [get], down: [get], onPress: SHOWN, afterRelease: SHOWN }))).toEqual({ kind: 'failed', how: 'content', diff: SHOWN });
    expect(cancelOutcome(facts({ all: [get], down: [get] }))).toMatchObject({ kind: 'unmeasured', reason: 'stopped' });
    // Strict guard: a beacon is a request like any other.
    expect(cancelOutcome(facts({ all: [{ ...get, resourceType: 'beacon' }] }))).toMatchObject({ kind: 'unmeasured', reason: 'stopped' });
    expect(cancelOutcome(facts({ submits: { down: 1, all: 1 } }))).toEqual({ kind: 'failed', how: 'submit' });
    expect(cancelOutcome(facts({ submits: { down: 0, all: 1 } }))).toMatchObject({ kind: 'unmeasured', reason: 'stopped' });
  });

  it('never a result when the guard stopped a request, a click reached the element, or the page moves by itself', () => {
    const post = ev({ method: 'POST', url: 'https://e.org/api/like', reason: 'method', resourceType: 'fetch' });
    expect(cancelOutcome(facts({ all: [post] }))).toEqual({
      kind: 'unmeasured', reason: 'stopped', detail: 'the test would have sent data to the live site (POST request to https://e.org/api/like), so it was stopped',
    });
    // Known requests are matched by method and the whole address: a blocked POST is never known, nor a
    // GET with another query; the same GET the page made before is (round 2, A).
    expect(cancelOutcome(facts({ all: [post], background: [{ ...post, url: 'https://e.org/api/like?t=1' }] }))).toMatchObject({ kind: 'unmeasured', reason: 'stopped' });
    expect(cancelOutcome(facts({ all: [post], background: [post] }))).toMatchObject({ kind: 'unmeasured', reason: 'stopped' });
    const feed = ev({ method: 'GET', url: 'https://e.org/api/feed?page=2', reason: 'data', resourceType: 'fetch' });
    expect(cancelOutcome(facts({ all: [feed], known: [requestKey('GET', 'https://e.org/api/feed?page=1')] }))).toMatchObject({ kind: 'unmeasured', reason: 'stopped' });
    expect(cancelOutcome(facts({ all: [feed], known: [requestKey('GET', 'https://e.org/api/feed?page=2#x')] }))).toEqual({ kind: 'ok' });
    expect(cancelOutcome(facts({ all: [feed], background: [feed] }))).toEqual({ kind: 'ok' });
    // A navigation held after the release (not during the press): not measured.
    expect(cancelOutcome(facts({ all: [ev({ kind: 'navigation', url: 'https://e.org/x' })] }))).toMatchObject({ kind: 'unmeasured', reason: 'stopped' });
    expect(cancelOutcome(facts({ clicks: ['click'], onPress: SHOWN, afterRelease: SHOWN }))).toEqual({ kind: 'unmeasured', reason: 'click' });
    expect(cancelOutcome(facts({ moving: true, onPress: SHOWN, afterRelease: SHOWN }))).toEqual({ kind: 'unmeasured', reason: 'moving' });
    expect(cancelOutcome(facts({ onPress: null }))).toEqual({ kind: 'unmeasured', reason: 'gone' });
  });
});

const cand = (c: Partial<DownCandidate> = {}): DownCandidate => ({ i: 0, path: '#b', name: 'Show details', tag: 'button', types: ['mousedown'], ...c });
const res = (outcome: CancelResult['outcome'], c: Partial<DownCandidate> = {}): CancelResult => ({ candidate: cand(c), outcome });

describe('2.5.2: the page result', () => {
  it('words a failure by what was measured', () => {
    const d = (diff: StateDiff, c: Partial<DownCandidate> = {}) => cancelDetail({ candidate: cand(c), outcome: { kind: 'failed', how: 'content', diff } } as never);
    expect(d(SHOWN)).toBe('Pressing down on “Show details” shows “Opening hours” before the button is released, and moving the pointer away before releasing does not undo it');
    expect(d({ changed: true, shown: 0, hidden: 2 }, { name: '' })).toBe('Pressing down on this button hides 2 pieces of content before the button is released, and moving the pointer away before releasing does not undo it');
    expect(d({ changed: true, shown: 0, hidden: 0, own: 'its state changes' })).toMatch(/^Pressing down on “Show details” its state changes before/);
    expect(cancelDetail({ candidate: cand(), outcome: { kind: 'failed', how: 'popup', url: 'https://e.org/p' } } as never))
      .toBe('Pressing down on “Show details” opens a new window (https://e.org/p) before the button is released, so moving the pointer away cannot cancel it');
  });

  it('failures first; otherwise not testable with the reason, never a clean result unmeasured', () => {
    const failed = res({ kind: 'failed', how: 'content', diff: SHOWN });
    expect(cancelFindings([res({ kind: 'unmeasured', reason: 'moving' }), failed]).map((f) => [f.status, f.target])).toEqual([['failed', '#b']]);
    expect(why(() => cancelFindings([res({ kind: 'ok' }), res({ kind: 'unmeasured', reason: 'stopped', detail: 'blocked POST' })]))).toBe('blocked POST');
    expect(why(() => cancelFindings([res({ kind: 'unmeasured', reason: 'action' }, { name: 'Delete account' })])))
      .toBe('1 element that reacts to pressing down was not pressed because it is a link, a submit button or a form field, or its name says it performs an action (“Delete account”)');
    expect(why(() => cancelFindings([res({ kind: 'ok' }), res({ kind: 'unmeasured', reason: 'covered' })])))
      .toBe('1 element of 2 that react to pressing down could not be reached by the pointer (covered by other content)');
    expect(why(() => cancelFindings([res({ kind: 'ok' }), res({ kind: 'unmeasured', reason: 'time' }), res({ kind: 'unmeasured', reason: 'time' })])))
      .toBe('the time ran out after 1 of 3 elements that react to pressing down');
    expect(why(() => cancelFindings([res({ kind: 'ok' })], ['/w.html']))).toBe('Content that reacts to pressing down inside an embedded frame from this site was not tested (/w.html)');
    expect(why(() => cancelFindings([res({ kind: 'ok' })], [], 2))).toBe('2 more kinds of element that react to pressing down were not pressed (the test presses 6 kinds per page)');
    expect(cancelFindings([res({ kind: 'ok' }), res({ kind: 'ok' })])).toEqual([]);
  });

  it('round 2: a press that left the page changed, a closed shadow root, a document handler with nothing to sample', () => {
    expect(why(() => cancelFindings([res({ kind: 'ok' }), res({ kind: 'unmeasured', reason: 'left' }), res({ kind: 'unmeasured', reason: 'left' })])))
      .toBe('an earlier press left the page changed (Escape did not undo it), so 2 elements that react to pressing down could not be pressed');
    expect(why(() => cancelFindings([res({ kind: 'unmeasured', reason: 'closed' })])))
      .toBe('1 element that reacts to pressing down is inside a closed shadow root, where the pressed target cannot be seen, so it was not pressed');
    expect(why(() => cancelFindings([res({ kind: 'ok' })], [], 0, true)))
      .toBe('the page reacts to pressing down anywhere (a handler on the document or the window), and it has no buttons, tabs or summaries the test could press for it, so that handler was not tested');
  });

  it('not applicable with nothing to press, or only sliders and native pickers', () => {
    expect(cancelFindings([])).toEqual([{ criterion: '2.5.2', status: 'not_applicable', detail: 'no element on the page reacts to pressing down (no pointerdown, mousedown or touchstart handlers on page elements)' }]);
    expect(cancelFindings([res({ kind: 'ok' }, { skip: 'slider' }), res({ kind: 'ok' }, { skip: 'picker' })])[0]).toMatchObject({ status: 'not_applicable', detail: expect.stringMatching(/^only sliders and native pickers/) });
  });
});

const gc = (c: Partial<GestureCandidate> = {}): GestureCandidate => ({ i: 0, kind: 'region', path: '#car', name: 'Photos', types: ['pointerdown'], ...c });
const gr = (outcomes: GestureResult['outcomes'], c: Partial<GestureCandidate> = {}): GestureResult => ({ candidate: gc(c), outcomes });

describe('2.5.1 and 2.5.7: the page result', () => {
  it('swipes of carousels and pinches go under 2.5.1, panning, sorting and sliders under 2.5.7', () => {
    const f = gestureFindings([
      gr([{ kind: 'failed', what: 'swipe' }, { kind: 'failed', what: 'pinch', zoom: 1.6 }]),
      gr([{ kind: 'failed', what: 'pan' }], { path: '#map' }),
      gr([{ kind: 'failed', what: 'sort' }], { kind: 'draggable', path: '#list > li' }),
      gr([{ kind: 'ok', what: 'slider', alternative: 'Increase' }], { kind: 'slider', path: '#s' }),
    ]);
    expect(f.map((x) => [x.criterion, x.status, x.target])).toEqual([
      ['2.5.1', 'failed', '#car'], ['2.5.1', 'failed', '#car'], ['2.5.7', 'failed', '#map'], ['2.5.7', 'failed', '#list > li'],
    ]);
    expect(f[1]!.detail).toMatch(/^Pinching with two fingers on this content \(“Photos”\) zooms it \(×1\.6\), a multipoint gesture/);
  });

  it('a region it could not measure leaves both criteria not testable; an item only 2.5.7', () => {
    expect(gestureFindings([gr([{ kind: 'unmeasured', reason: 'moving' }])])).toEqual([
      { criterion: '2.5.1', status: 'not_testable', detail: '1 element of content with gesture handlers changes by itself, so a change made by a gesture could not be attributed' },
      { criterion: '2.5.7', status: 'not_testable', detail: '1 element of draggable content changes by itself, so a change made by a gesture could not be attributed' },
    ]);
    const f = gestureFindings([gr([{ kind: 'none' }]), gr([{ kind: 'unmeasured', reason: 'stopped', detail: 'blocked POST' }], { kind: 'draggable' })]);
    expect(f).toEqual([{ criterion: '2.5.7', status: 'not_testable', detail: 'blocked POST' }]);
    // A failure under one criterion does not hide what could not be measured under the other.
    expect(gestureFindings([gr([{ kind: 'failed', what: 'swipe' }]), gr([{ kind: 'unmeasured', reason: 'time' }], { kind: 'slider' })]).map((x) => [x.criterion, x.status]))
      .toEqual([['2.5.1', 'failed'], ['2.5.7', 'not_testable']]);
    expect(gestureFindings([gr([{ kind: 'unmeasured', reason: 'action' }], { kind: 'handle', name: 'Remove' })])[1]!.detail)
      .toBe('1 element of draggable content was not tested because every point to start a gesture on is a link, a submit button, a form field or named for an action (“Remove”)');
  });

  it('controls without a name next to it, and kinds left out by the limits: not testable', () => {
    expect(gestureFindings([gr([{ kind: 'unmeasured', reason: 'unnamed' }])])[0]).toEqual({
      criterion: '2.5.1', status: 'not_testable',
      detail: '1 element of content with gesture handlers reacts to a gesture or drag, and the controls next to it have no name, or a name the test does not recognize as doing the same (next, previous, a slide number, zoom in or out, pan, move up or down, increase or decrease, or an arrow), so the test cannot tell whether they do the same',
    });
    const capped = gestureFindings([gr([{ kind: 'none' }])], [], { regions: 1, items: 2 });
    expect(capped.map((f) => f.detail)).toEqual([
      '1 more kind of content with gesture handlers was not tested (the test takes 3 regions and 4 draggable items per page)',
      '3 more kinds of draggable content were not tested (the test takes 3 regions and 4 draggable items per page)',
    ]);
    // Items left out do not affect 2.5.1.
    expect(gestureFindings([gr([{ kind: 'none' }])], [], { regions: 0, items: 1 }).map((f) => f.criterion)).toEqual(['2.5.7']);
  });

  it('frames from the site, nothing to test, and a clean page', () => {
    expect(gestureFindings([gr([{ kind: 'none' }])], ['/f.html']).map((x) => x.detail)).toEqual([
      'Content with gesture handlers inside an embedded frame from this site was not tested (/f.html)',
      'Draggable content inside an embedded frame from this site was not tested (/f.html)',
    ]);
    expect(gestureFindings([]).map((x) => [x.criterion, x.status])).toEqual([['2.5.1', 'not_applicable'], ['2.5.7', 'not_applicable']]);
    expect(gestureFindings([gr([{ kind: 'ok', what: 'sort' }], { kind: 'draggable' })])).toEqual([
      { criterion: '2.5.1', status: 'not_applicable', detail: 'no swipe, pinch or other gesture handlers found on page content' },
    ]);
    expect(gestureFindings([gr([{ kind: 'ok', what: 'swipe', alternative: 'Next' }]), gr([{ kind: 'none' }], { kind: 'slider' })])).toEqual([]);
  });

  it('words each failure by what was measured (a select is never claimed)', () => {
    expect(gestureDetail(gc({ name: '' }), { kind: 'failed', what: 'pan' })).toBe('Dragging across this content moves what it shows, and there is no control next to it that could move it with a single tap or click');
    expect(gestureDetail(gc({ kind: 'draggable', name: 'Math' }), { kind: 'failed', what: 'sort' })).toBe('Dragging this item (“Math”) onto another item reorders the list, clicking its items does not, and the page has no other control that could move it with a single tap or click');
    expect(gestureDetail(gc({ kind: 'slider', name: 'Volume' }), { kind: 'failed', what: 'slider' })).toMatch(/^Dragging this slider's handle \(“Volume”\) changes its value, and neither pressing on its track nor any control/);
    expect(framesReason(['/a', '/b', '/c', '/d'], 'X')).toBe('X inside 4 embedded frames from this site were not tested (/a, /b, /c, …)');
  });

  it('round 2, A: after the guard stopped a request, only failures measured in the DOM are kept (order, value, size); a pixel change is not', () => {
    const stop = { kind: 'unmeasured' as const, reason: 'stopped' as const, detail: 'stopped' };
    expect(keptAfterStop([{ kind: 'failed', what: 'swipe' }], stop)).toEqual([stop]);
    expect(keptAfterStop([{ kind: 'failed', what: 'pan' }], stop)).toEqual([stop]);
    for (const what of ['sort', 'slider', 'pinch'] as const) expect(keptAfterStop([{ kind: 'failed', what }], stop)).toEqual([{ kind: 'failed', what }]);
    expect(keptAfterStop([{ kind: 'ok', what: 'swipe' }], stop)).toEqual([stop]);
    expect(keptAfterStop([{ kind: 'none' }], undefined)).toEqual([{ kind: 'none' }]);
  });

  it('tries the event families the element listens to', () => {
    expect(familiesOf(['mousedown', 'touchstart', 'pointerdown'])).toEqual(['pointer', 'touch', 'mouse']);
    expect(familiesOf(['touchstart'])).toEqual(['touch']);
    expect(familiesOf([])).toEqual([]);
  });
});

const img = (w: number, h: number, fill: (x: number, y: number) => number): RgbaImage => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = fill(x, y); data.set([v, v, v, 255], (y * w + x) * 4); }
  return { width: w, height: h, data };
};

describe('region screenshots', () => {
  it('a region that changes by itself between quiet screenshots is moving; small noise is masked', () => {
    const a = img(100, 50, () => 200);
    const b = img(100, 50, (x) => (x < 50 ? 200 : 20));
    expect(quietPixels([a, a, b]).moving).toBe(true);
    expect(quietPixels([a, b, a]).moving).toBe(true);
    const caret = img(100, 50, (x, y) => (x === 3 && y < 2 ? 0 : 200));
    const q = quietPixels([a, caret, a]);
    expect(q.moving).toBe(false);
    expect(q.at).toHaveLength(100 * 50 - 2);
    expect(quietPixels([a, img(10, 10, () => 0)]).moving).toBe(true);
  });

  it('a gesture changed the region when over 1% of its quiet pixels (and at least 50) changed', () => {
    const a = img(100, 50, () => 200);
    const at = quietPixels([a, a, a]).at;
    expect(regionChanged(a, img(100, 50, (x, y) => (x < 10 && y < 4 ? 0 : 200)), at)).toBe(false); // 40 px
    expect(regionChanged(a, img(100, 50, (x, y) => (x < 10 && y < 10 ? 0 : 200)), at)).toBe(true); // 100 px
    expect(regionChanged(a, img(99, 50, () => 200), at)).toBe(true);
  });
});

describe('registration', () => {
  it('registers both probes in PROBES and the criteria rows, both deep: the press test on the desktop page, the gestures on a touch screen of their own', () => {
    for (const p of [pointerCancellationProbe, pointerGesturesProbe]) {
      expect(PROBES).toContain(p);
      // 2.1.1 (keyboard-op lane: a list only dragging reorders) is the keyboard test's row: a deep test listed there would
      // leave 2.1.1 "not tested" on every core scan, so, like the controls test, it reports 2.1.1 without being listed.
      for (const c of p.criteria) if (c !== '2.1.1') expect(CRITERIA.find((d) => d.criterion === c)!.methods, `${p.id} ${c}`).toContain(`probe:${p.id}`);
    }
    expect(CRITERIA.find((d) => d.criterion === '2.1.1')!.methods).toContain('probe:keyboard');
    expect([pointerCancellationProbe, pointerGesturesProbe].map((p) => [p.id, p.criteria.join(), p.kind, p.tier])).toEqual([
      ['pointer-cancellation', '2.5.2', 'interaction', 'deep'], ['pointer-gestures', '2.5.1,2.5.7,2.1.1', 'interaction', 'deep'],
    ]);
    expect([pointerCancellationProbe.viewport, pointerCancellationProbe.contextOptions, pointerCancellationProbe.isolate]).toEqual([undefined, undefined, undefined]);
    expect([pointerGesturesProbe.viewport, pointerGesturesProbe.contextOptions, pointerGesturesProbe.isolate]).toEqual([undefined, { hasTouch: true }, true]);
    // Strict guard: nothing a press, a gesture or a drop makes the page ask for is sent.
    expect([pointerCancellationProbe.sendsNothing, pointerGesturesProbe.sendsNothing]).toEqual([true, true]);
    // The press test runs last on the desktop page (it reloads the page when a press changed it).
    const desktop = PROBES.filter((p) => !p.viewport && !p.contextOptions && !p.isolate);
    expect(desktop[desktop.length - 1]).toBe(pointerCancellationProbe);
  });

  it('in a scan: the three criteria say the tests are deep, run them with --full, and say why when the probes are off', async () => {
    // `stopDownloads`: the tests that press run only once no click can save a file (src/probes/pressSafely.ts).
    const site = () => fakeProbeBrowser({ evaluate: (name) => (name === '' || name === 'collectLinks' ? [] : name === 'stopDownloads' ? true : undefined) });
    const notFound = (async () => new Response('', { status: 404 })) as typeof fetch;
    const methods = (r: Awaited<ReturnType<typeof scanSite>>, c: string) => r.criteria!.find((x) => x.criterion === c)!.methods;
    const dflt = await scanSite('https://e.org/', { browser: site().browser, fetchFn: notFound, axeSource: '' });
    for (const [c, id] of [['2.5.1', 'pointer-gestures'], ['2.5.2', 'pointer-cancellation'], ['2.5.7', 'pointer-gestures']] as const) {
      expect(methods(dflt, c)).toEqual([{ id, kind: 'interaction', status: 'not_testable', pages: 0, note: 'a deep automated test, not run in this scan' }]);
    }
    const full = await scanSite('https://e.org/', { browser: site().browser, fetchFn: notFound, axeSource: '', full: true });
    // The fake page records no listeners: nothing reacts to pressing down there.
    expect(methods(full, '2.5.2')).toEqual([expect.objectContaining({ id: 'pointer-cancellation', status: 'not_applicable', pages: 1 })]);
    expect(methods(full, '2.5.1')).toEqual([expect.objectContaining({ id: 'pointer-gestures', pages: 1 })]);
    const off = await scanSite('https://e.org/', { browser: site().browser, fetchFn: notFound, axeSource: '', probes: false });
    for (const c of ['2.5.1', '2.5.2', '2.5.7']) expect(methods(off, c)[0]!.note).toBe('the automated interaction and render tests were turned off for this scan');
  });
});
