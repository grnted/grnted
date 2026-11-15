// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The pointer probes (Plan 4 Task 4.5) in real Chromium: pointer cancellation (2.5.2), pointer
// gestures (2.5.1) and dragging movements (2.5.7). Fixture site: test/fixtures/pointer/ (planted
// failures, clean controls, and hostile pages). The fixture server logs every request so the safety
// test can show that nothing but plain page loads reached it while the probes ran.
import type { IncomingMessage } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isActionUrl } from '../../src/probes/guard.js';
import { pointerCancellationProbe } from '../../src/probes/pointerCancellation.js';
import { pointerGesturesProbe } from '../../src/probes/pointerGestures.js';
import { runProbes } from '../../src/probes/runner.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
interface Logged { method: string; path: string; dest: string; at: number }
const log: Logged[] = [];
const B = () => browser as unknown as BrowserLike;
const OPTS = { userAgent: 'grnted-test', full: true };

beforeAll(async () => {
  server = await startFixtureServer('pointer', {}, {
    onRequest: (req: IncomingMessage) => {
      log.push({ method: req.method ?? '', path: req.url ?? '', dest: String(req.headers['sec-fetch-dest'] ?? ''), at: Date.now() });
    },
  });
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const run = async (probe: PageProbe, ...paths: string[]): Promise<ProbeRun[]> =>
  runProbes(B(), paths.map((p, index) => ({ url: `${server.origin}${p}`, index })), [probe], OPTS);
const UNKNOWN = '1 element of content with gesture handlers reacts to a gesture or drag, and the controls next to it have no name, or a name the test does not recognize as doing the same (next, previous, a slide number, zoom in or out, pan, move up or down, increase or decrease, or an arrow), so the test cannot tell whether they do the same';
// The keyboard-op lane's 2.1.1 rule (a list reordered only by dragging) says "not applicable" wherever no list was
// reordered; those rows are left out here, and its own tests below look at them.
const gestures = (r: ProbeRun) => r.findings.filter((f) => !(f.criterion === '2.1.1' && f.status === 'not_applicable'));
const summary = (r: ProbeRun) => gestures(r).map((f) => [f.criterion, f.status, f.target ?? '']);
const ms: Record<string, number[]> = {};
const timed = (runs: ProbeRun[]) => {
  for (const r of runs) (ms[r.probe] ??= []).push(r.ms);
  return runs;
};

describe('pointer cancellation (2.5.2)', () => {
  it('fails actions on the down event (content, navigation, a touch-only handler); not a ripple with the action on click', async () => {
    const [planted] = timed(await run(pointerCancellationProbe, '/press.html'));
    expect(planted!.status).toBe('ok');
    // The link is never pressed (links are refused); the button that navigates on press is.
    // The touch press leaves the page changed and Escape does not undo it, so the toggle after it is
    // not pressed on a changed page (round 2, B); the failures found stand.
    expect(summary(planted!)).toEqual([['2.5.2', 'failed', '#down-go'], ['2.5.2', 'failed', '#touch-act']]);
    const [nav, touch] = planted!.findings.map((f) => f.detail);
    expect(nav).toBe(`Pressing down on “Go to the about page” goes to ${server.origin}/about.html before the button is released, so moving the pointer away cannot cancel it`);
    expect(touch).toBe('Pressing down on “Show the campus map” shows “Map of the campus with every building.” before the button is released, and moving the pointer away before releasing does not undo it');
  }, 60_000);

  it('finds nothing on the clean page: a ripple, a list of choices, press-and-hold that undoes itself, sliders and a carousel', async () => {
    const [clean] = timed(await run(pointerCancellationProbe, '/'));
    expect(clean!.status).toBe('ok');
    expect(clean!.findings).toEqual([]);
  }, 60_000);

  it('not applicable on a page with no down handlers', async () => {
    const [r] = await run(pointerCancellationProbe, '/about.html');
    expect(r!.findings).toEqual([{ criterion: '2.5.2', status: 'not_applicable', detail: 'no element on the page reacts to pressing down (no pointerdown, mousedown or touchstart handlers on page elements)' }]);
  }, 60_000);

  it('a press that posts to the server and changes the page: the POST never leaves, the measured failure stays failed', async () => {
    const start = log.length;
    const [r] = await run(pointerCancellationProbe, '/press-post.html');
    expect(log.slice(start).filter((x) => x.method !== 'GET')).toEqual([]);
    expect(summary(r!)).toEqual([['2.5.2', 'failed', '#like']]);
    expect(r!.findings[0]!.detail).toBe('Pressing down on “Like this story” changes “3 likes” to “4 likes” before the button is released, and moving the pointer away before releasing does not undo it');
  }, 60_000);

  it('an element named for an action is never pressed: not testable (pressing it would have been a measured failure)', async () => {
    const [r] = await run(pointerCancellationProbe, '/press-action.html');
    expect(r!.findings).toEqual([{ criterion: '2.5.2', status: 'not_testable', detail: '1 element that reacts to pressing down was not pressed because it is a link, a submit button or a form field, or its name says it performs an action (“Delete account”)' }]);
  }, 60_000);

  it('never completes a click; a link and a submit button are never pressed', async () => {
    const start = log.length;
    const [r] = await run(pointerCancellationProbe, '/press-click.html');
    expect(r!.findings).toEqual([{ criterion: '2.5.2', status: 'not_testable', detail: '2 elements that react to pressing down were not pressed because they are links, submit buttons or form fields, or their names say they perform an action (“Leave”, “Send”)' }]);
    expect(log.slice(start).filter((x) => x.dest !== 'document')).toEqual([]);
  }, 60_000);

  it('a new window opened on press is failed (the guard closes it)', async () => {
    const [r] = await run(pointerCancellationProbe, '/press-popup.html');
    expect(summary(r!)).toEqual([['2.5.2', 'failed', '#open']]);
    expect(r!.findings[0]!.detail).toBe(`Pressing down on “Open the gallery” opens a new window (${server.origin}/about.html) before the button is released, so moving the pointer away cannot cancel it`);
  }, 60_000);

  it('content in a frame from the site is not tested: not testable, never a clean result; a frame from another site is third-party content', async () => {
    const start = log.length;
    const [r] = await run(pointerCancellationProbe, '/press-frame.html');
    expect(r!.findings).toEqual([{ criterion: '2.5.2', status: 'not_testable', detail: 'Content that reacts to pressing down inside an embedded frame from this site was not tested (/press-frame-inner.html)' }]);
    // Both frames loaded (the one from another origin too), and only the site's own is named.
    expect(log.slice(start).filter((x) => x.path === '/press-frame-inner.html')).toHaveLength(2);
  }, 60_000);

  it('a handler on the document (event delegation) is found through the controls it acts for', async () => {
    const [r] = timed(await run(pointerCancellationProbe, '/press-delegated.html'));
    expect(summary(r!)).toEqual([['2.5.2', 'failed', '#reveal']]);
    expect(r!.findings[0]!.detail).toMatch(/^Pressing down on “Show the bell schedule” shows “First bell 8:05\.”/);
  }, 60_000);

  it('a notice that changes by itself every second never becomes a failure of the buttons pressed meanwhile', async () => {
    for (let k = 0; k < 2; k++) {
      const [r] = timed(await run(pointerCancellationProbe, '/press-ticker.html'));
      expect(r!.findings.filter((f) => f.status === 'failed')).toEqual([]);
      expect(r!.findings).toEqual([]);
    }
  }, 90_000);

  // A busy machine, pinned at the bad moment: around the listed snapshots of a press the probe stalls
  // until the notice on press-ticker.html changes by itself (as a slow round trip would let it).
  const busy = (pins: { after?: string[]; before?: string[]; likeD?: string[] }): PageProbe => ({
    ...pointerCancellationProbe,
    async run(ctx) {
      const page = ctx.page;
      // Resolves on the notice's next change (or at once when `to` is given and it is already so).
      const tick = (to: boolean | null) => page.evaluate((want: boolean | null) => new Promise<boolean>((done) => {
        const n = document.getElementById('n1')!;
        if (want !== null && n.hidden === want) return done(n.hidden);
        const o = new MutationObserver(() => { if (want === null || n.hidden === want) { o.disconnect(); done(n.hidden); } });
        o.observe(n, { attributes: true });
      }), to);
      let atD: boolean | null = null;
      const evaluate = async (fn: unknown, arg: unknown) => {
        const x = arg as { op?: string; a?: { label?: string } } | undefined;
        const label = x?.op === 'snap' ? x.a?.label ?? '' : '';
        if (pins.before?.includes(label)) await tick(null);
        if (pins.likeD?.includes(label) && atD !== null) await tick(atD);
        const out = await page.evaluate(fn as (a: unknown) => unknown, arg);
        if (label === 'd') atD = await page.evaluate(() => document.getElementById('n1')!.hidden, undefined);
        if (pins.after?.includes(label)) await tick(null);
        return out;
      };
      const slowed = new Proxy(page, { get: (t, p) => (p === 'evaluate' ? evaluate : (Reflect.get(t, p, t) as unknown)) });
      return pointerCancellationProbe.run({ ...ctx, page: slowed as typeof page });
    },
  });

  it('busy machine: the notice changes right after the press’s baseline, and again before the doubt check looks: never a failure', async () => {
    // The change lands between the baseline and the press (no timer counted from the press on), and
    // the check for a page that keeps changing starts right after a change (it sees none).
    const [r] = await run(busy({ after: ['b'], before: ['e'] }), '/press-ticker.html');
    expect(r!.findings).toEqual([]);
  }, 60_000);

  it('busy machine: the notice changes right after the baseline of every press: still nothing found, never not testable', async () => {
    const [r] = await run(busy({ after: ['b'] }), '/press-ticker.html');
    expect(r!.findings).toEqual([]);
  }, 60_000);

  it('busy machine: the notice changes after the press, and every look after Escape finds it as the press left it: never "left changed"', async () => {
    const [r] = await run(busy({ after: ['c'], likeD: ['r'] }), '/press-ticker.html');
    expect(r!.findings).toEqual([]);
  }, 60_000);

  // Carousel dots that act on click only, next to a testimonial that a 5 s interval swaps after a fade
  // (paused while hovered). Pinned: the interval's swap starts just before the press's baseline, and
  // lands while the button is held (a real scan hit this by chance).
  const swapAtBaseline: PageProbe = {
    ...pointerCancellationProbe,
    async run(ctx) {
      const page = ctx.page;
      let first = true;
      const evaluate = async (fn: unknown, arg: unknown) => {
        const x = arg as { op?: string; a?: { label?: string } } | undefined;
        if (x?.op === 'snap' && x.a?.label === 'b' && first) {
          first = false;
          await page.evaluate(() => (window as unknown as { __tick: () => void }).__tick(), undefined);
        }
        return page.evaluate(fn as (a: unknown) => unknown, arg);
      };
      const slowed = new Proxy(page, { get: (t, p) => (p === 'evaluate' ? evaluate : (Reflect.get(t, p, t) as unknown)) });
      return pointerCancellationProbe.run({ ...ctx, page: slowed as typeof page });
    },
  };

  it('a change already under way when the press starts (an animated swap) is never the press’s: no failure', async () => {
    const [r] = await run(swapAtBaseline, '/press-carousel-dots.html');
    expect(r!.findings.filter((f) => f.status === 'failed')).toEqual([]);
  }, 60_000);

  // A button that acts on mouse down beside a slideshow that changes by itself (the gold pair
  // mousedown-action + slideshow-with-pause). Pinned: the slideshow changes at the listed moment of the
  // first press, so that press is in doubt; a second press finds the message already shown and changes
  // nothing. The press's own change is still a failure, never a clean result.
  const slideAt = (label: string): PageProbe => ({
    ...pointerCancellationProbe,
    async run(ctx) {
      const page = ctx.page;
      let first = true;
      const evaluate = async (fn: unknown, arg: unknown) => {
        const x = arg as { op?: string; a?: { label?: string } } | undefined;
        const out = await page.evaluate(fn as (a: unknown) => unknown, arg);
        if (x?.op === 'snap' && x.a?.label === label && first) {
          first = false;
          await page.evaluate(() => new Promise<void>((done) => {
            const o = new MutationObserver(() => { o.disconnect(); done(); });
            o.observe(document.getElementById('slides')!, { characterData: true, subtree: true, childList: true });
          }), undefined);
        }
        return out;
      };
      const slowed = new Proxy(page, { get: (t, p) => (p === 'evaluate' ? evaluate : (Reflect.get(t, p, t) as unknown)) });
      return pointerCancellationProbe.run({ ...ctx, page: slowed as typeof page });
    },
  });
  const PRINTED = [['2.5.2', 'failed', '#print']];
  it('an action on press beside a slideshow that changes while the button is held: failed, never clean', async () => {
    const [r] = await run(slideAt('b'), '/press-beside-slides.html');
    expect(summary(r!)).toEqual(PRINTED);
    expect(r!.findings[0]!.detail).toBe('Pressing down on “Print this page” shows “Sent to the printer.” before the button is released, and moving the pointer away before releasing does not undo it');
  }, 60_000);

  it('an action on press beside a slideshow that changed just before the press: failed, never clean', async () => {
    const [r] = await run(slideAt('a2'), '/press-beside-slides.html');
    expect(summary(r!)).toEqual(PRINTED);
  }, 60_000);

  it('an action on press beside a slideshow, unpinned: failed every time', async () => {
    for (let k = 0; k < 3; k++) expect(summary((await run(pointerCancellationProbe, '/press-beside-slides.html'))[0]!)).toEqual(PRINTED);
  }, 90_000);

  it('a press that only marks the page (a class on body) beside a notice that changes by itself: nothing found', async () => {
    const [r] = await run(busy({ after: ['b'] }), '/press-body-class.html');
    expect(r!.findings).toEqual([]);
  }, 60_000);

  it('presses inside open shadow roots', async () => {
    const [r] = await run(pointerCancellationProbe, '/press-shadow.html');
    // Inside a closed shadow root the pressed target cannot be seen: not pressed (round 2, C).
    expect(summary(r!)).toEqual([['2.5.2', 'failed', '#alerts >>> #show']]);
    expect(r!.findings[0]!.detail).toMatch(/^Pressing down on “Show alerts” shows “No school on Friday\.”/);
  }, 60_000);

  it('a press that hangs the page times out: not testable', async () => {
    const [r] = await run({ ...pointerCancellationProbe, timeoutMs: 3000 }, '/press-hang.html');
    expect(r!.status).toBe('timeout');
    expect(r!.findings).toEqual([{ criterion: '2.5.2', status: 'not_testable', detail: 'timed out after 3 s' }]);
  }, 60_000);

  it('the next probe gets a fresh page (the strict guard never reuses one)', async () => {
    let state: unknown = 'not read';
    const after: PageProbe = {
      id: 'after', criteria: ['0.0.1'], kind: 'interaction', tier: 'core', timeoutMs: 5000,
      async run(ctx) {
        state = await ctx.page.evaluate(() => [document.getElementById('details')!.hidden, '__grntedPointer' in window, location.pathname], undefined);
        return [];
      },
    };
    await runProbes(B(), [{ url: `${server.origin}/press.html`, index: 0 }], [pointerCancellationProbe, after], OPTS);
    expect(state).toEqual([true, false, '/press.html']);
  }, 60_000);
});

describe('pointer gestures (2.5.1) and dragging movements (2.5.7)', () => {
  it('fails a swipe-only carousel and a pinch-only zoom (2.5.1); not the carousel with slide buttons', async () => {
    const [r] = timed(await run(pointerGesturesProbe, '/gesture.html'));
    expect(r!.status).toBe('ok');
    expect(summary(r!)).toEqual([['2.5.1', 'failed', '#swipe-only'], ['2.5.1', 'failed', '#pinch-only']]);
    expect(r!.findings[0]!.detail).toBe('Swiping across this content (“Spring concert Science fair Field day”) changes what it shows (a path-based gesture), and there is no control next to it that could do the same with a single tap or click');
    expect(r!.findings[1]!.detail).toMatch(/^Pinching with two fingers on this content \(“Floor plan”\) zooms it \(×\d\.\d\), a multipoint gesture, and there is no control next to it that could zoom/);
  }, 90_000);

  it('2.5.7: a list whose items take focus for the arrow keys has no single-pointer way; move buttons or click-then-click are one; a main content that is a focus target refuses nothing', async () => {
    const [r] = timed(await run(pointerGesturesProbe, '/drag-focusable.html'));
    expect(r!.status).toBe('ok');
    // The other items of the list are not "controls next to it": a tap on one does nothing (it is tried). The
    // list is not failed all the same: this page has other controls (the other lists' buttons are theirs, but
    // there are more), and one of them may be the way. Only a page with nothing else to press fails
    // (drag-bare.html, below).
    expect(summary(r!).filter((x) => x[0] === '2.5.7')).toEqual([['2.5.7', 'not_testable', '']]);
    expect(r!.findings.find((f) => f.criterion === '2.5.7')!.detail).toContain('another control on the page');
  }, 60_000);

  it('2.5.7: a sortable list whose move buttons are in a toolbar elsewhere on the page is not failed: the way is found and tried', async () => {
    const [r] = timed(await run(pointerGesturesProbe, '/drag-toolbar.html'));
    expect(r!.status).toBe('ok');
    // The same page failed before the search went page-wide (the drag works, and nothing is next to the list):
    // now the toolbar's button is found and tried after a click on an item, and the list is clean (no finding).
    expect(r!.findings.filter((x) => x.criterion === '2.5.7' && x.status !== 'no_failures_found')).toEqual([]);
  }, 60_000);

  it('2.5.7: move buttons that show only once an item is selected are found after the selecting click, and tried', async () => {
    const [r] = timed(await run(pointerGesturesProbe, '/drag-selected.html'));
    expect(r!.status).toBe('ok');
    expect(r!.findings.filter((x) => x.criterion === '2.5.7' && x.status === 'failed')).toEqual([]);
    expect(r!.findings.filter((x) => x.criterion === '2.5.7' && x.status !== 'no_failures_found')).toEqual([]);
  }, 60_000);

  it('2.5.7: buttons that show on selection are found whatever they are called and wherever they are: named "Up" and "Down", or inside the item', async () => {
    // "Up" and "Down" are no names the test accepts as a move control, so it does not press them: undecided, never failed.
    const [bar] = timed(await run(pointerGesturesProbe, '/drag-updown.html'));
    expect(bar!.findings.filter((x) => x.criterion === '2.5.7').map((x) => x.status)).toEqual(['not_testable']);
    // A "Move up" button inside each item, invisible until the item is selected: found after the click, and tried.
    const [inside] = timed(await run(pointerGesturesProbe, '/drag-inside.html'));
    expect(inside!.findings.filter((x) => x.criterion === '2.5.7' && x.status !== 'no_failures_found')).toEqual([]);
  }, 90_000);

  it('2.5.7: move controls are found when selecting toggles, inside a shadow root, and as plain spans with click handlers; a list that goes when clicked is not failed', async () => {
    for (const page of ['/drag-toggle.html', '/drag-shadow.html', '/drag-spans.html']) {
      const [r] = timed(await run(pointerGesturesProbe, page));
      expect(r!.findings.filter((x) => x.criterion === '2.5.7' && x.status !== 'no_failures_found'), page).toEqual([]);
    }
    // The list is gone after the first click: nothing was looked for, so nothing is failed.
    const [gone] = timed(await run(pointerGesturesProbe, '/drag-detail.html'));
    expect(gone!.findings.filter((x) => x.criterion === '2.5.7' && x.status === 'failed')).toEqual([]);
    expect(gone!.findings.filter((x) => x.criterion === '2.5.7').map((x) => x.status)).toEqual(['not_testable']);
  }, 180_000);

  it('2.5.7: a list only dragging reorders fails only on a page with nothing else to press; any other control leaves it undecided', async () => {
    const [bare] = timed(await run(pointerGesturesProbe, '/drag-bare.html'));
    expect(bare!.findings.filter((x) => x.criterion === '2.5.7').map((x) => [x.status, x.target])).toEqual([['failed', '#stops > li:nth-of-type(1)']]);
    expect(bare!.findings.find((x) => x.criterion === '2.5.7')!.detail).toBe('Dragging this item (“Welcome table”) onto another item reorders the list, clicking its items does not, and the page has no other control that could move it with a single tap or click');
    // One other button, named for nothing to do with the list: it may open what reorders it.
    const [other] = timed(await run(pointerGesturesProbe, '/drag-other.html'));
    expect(other!.findings.filter((x) => x.criterion === '2.5.7').map((x) => x.status)).toEqual(['not_testable']);
    expect(other!.findings.find((x) => x.criterion === '2.5.7')!.detail).toContain('“Options”');
  }, 120_000);

  it('2.5.7: arrow buttons in a toolbar built as a list, and controls made when an item is selected, are found and tried', async () => {
    for (const page of ['/drag-listbar.html', '/drag-made.html']) {
      const [r] = timed(await run(pointerGesturesProbe, page));
      expect(r!.findings.filter((x) => x.criterion === '2.5.7' && x.status !== 'no_failures_found'), page).toEqual([]);
    }
  }, 120_000);

  it('2.5.7: a control elsewhere on the page that may reorder the list (a menu the test does not open) leaves it undecided, never failed', async () => {
    const [r] = timed(await run(pointerGesturesProbe, '/drag-menu.html'));
    expect(r!.status).toBe('ok');
    const f = r!.findings.filter((x) => x.criterion === '2.5.7');
    expect(f.map((x) => x.status)).toEqual(['not_testable']);
    expect(f[0]!.detail).toContain('“Reorder stops”');
  }, 60_000);

  it('fails a map panned by dragging and a slider moved only by dragging (2.5.7); not the slider with buttons, and not the sortable list on a page with other controls', async () => {
    const [r] = timed(await run(pointerGesturesProbe, '/drag.html'));
    expect(r!.status).toBe('ok');
    // The list sorted by drag and drop is not failed on this page: it has other controls (the slider's buttons,
    // the map's), and the test cannot rule out that one of them reorders it (review round 1, ruling 10).
    // 2.1.1 (keyboard-op lane): the list's items take no focus, but the sliders next to it might reorder it with the keyboard.
    expect(summary(r!)).toEqual([['2.5.7', 'failed', '#map-only'], ['2.5.7', 'failed', '#slider-only'], ['2.1.1', 'not_testable', '#sort-only > li:nth-of-type(1)']]);
    const [pan, slider] = r!.findings.map((f) => f.detail);
    expect(pan).toBe('Dragging across this content moves what it shows, and there is no control next to it that could move it with a single tap or click');
    expect(slider).toMatch(/^Dragging this slider's handle \(“Font size”\) changes its value, and neither pressing on its track nor any control/);
  }, 90_000);

  it('finds nothing on the clean page: carousel with buttons, map with pan and zoom buttons, list with move buttons, slider with a track', async () => {
    const [clean] = timed(await run(pointerGesturesProbe, '/'));
    expect(clean!.status).toBe('ok');
    expect(gestures(clean!)).toEqual([]);
  }, 90_000);

  it('a fading carousel (slides stacked in one place) with Previous and Next buttons: nothing found', async () => {
    const [r] = timed(await run(pointerGesturesProbe, '/gesture-fade.html'));
    expect(r!.status).toBe('ok');
    expect(gestures(r!)).toEqual([]);
  }, 60_000);

  it('a carousel whose only buttons have no name: not testable, never failed', async () => {
    const [r] = await run(pointerGesturesProbe, '/gesture-unnamed.html');
    expect(gestures(r!).map((f) => [f.criterion, f.status])).toEqual([['2.5.1', 'not_testable'], ['2.5.7', 'not_testable']]);
    expect(r!.findings[0]!.detail).toBe(UNKNOWN);
  }, 60_000);

  it('content that moves by itself is not testable, never failed or clean', async () => {
    const [r] = await run(pointerGesturesProbe, '/gesture-auto.html');
    expect(gestures(r!)).toEqual([
      { criterion: '2.5.1', status: 'not_testable', detail: '1 element of content with gesture handlers changes by itself, so a change made by a gesture could not be attributed' },
      { criterion: '2.5.7', status: 'not_testable', detail: '1 element of draggable content changes by itself, so a change made by a gesture could not be attributed' },
    ]);
  }, 60_000);

  it('a drop that saves to the server: the POST never leaves; the reorder it measured stays failed', async () => {
    const start = log.length;
    const [r] = await run(pointerGesturesProbe, '/drag-post.html');
    expect(log.slice(start).filter((x) => x.method !== 'GET')).toEqual([]);
    // 2.1.1 (keyboard-op lane): nothing on the page gives the keyboard a way to reorder it.
    expect(summary(r!)).toEqual([['2.5.1', 'not_applicable', ''], ['2.5.7', 'failed', '#saved > li:nth-of-type(1)'], ['2.1.1', 'failed', '#saved > li:nth-of-type(1)']]);
  }, 60_000);

  it('a list that puts the dragged item before the one it lands on: dropped on the next item nothing changes, so it is dropped on the other side; failed without move buttons, not with them', async () => {
    const [r] = timed(await run(pointerGesturesProbe, '/drag-before.html'));
    expect(r!.status).toBe('ok');
    expect(summary(r!)).toEqual([['2.5.1', 'not_applicable', ''], ['2.5.7', 'failed', '#before-only > li:nth-of-type(1)'], ['2.1.1', 'failed', '#before-only > li:nth-of-type(1)']]);
    expect(r!.findings[1]!.detail).toBe('Dragging this item (“Parks”) onto another item reorders the list, clicking its items does not, and the page has no other control that could move it with a single tap or click');
    // The same list with "Move Pools up" / "Move Pools down" buttons (the item named between verb and direction).
    const [b] = timed(await run(pointerGesturesProbe, '/drag-before-buttons.html'));
    // Reordered by the drag, and the buttons are accepted: nothing found (an unrecognised name would leave 2.5.7 not testable).
    expect(summary(b!)).toEqual([['2.5.1', 'not_applicable', '']]);
  }, 90_000);

  it('a list of two that inserts before the drop target: the second item is dragged before the first; failed without move buttons', async () => {
    const [r] = timed(await run(pointerGesturesProbe, '/drag-two.html'));
    expect(summary(r!)).toEqual([['2.5.1', 'not_applicable', ''], ['2.5.7', 'failed', '#two-only > li:nth-of-type(1)'], ['2.1.1', 'failed', '#two-only > li:nth-of-type(1)']]);
  }, 90_000);

  it('not applicable on a page with nothing to drag or swipe', async () => {
    const [r] = await run(pointerGesturesProbe, '/about.html');
    expect(r!.findings.map((f) => [f.criterion, f.status])).toEqual([['2.5.1', 'not_applicable'], ['2.5.7', 'not_applicable'], ['2.1.1', 'not_applicable']]);
  }, 60_000);
});

describe('review round 1: hostile pages', () => {
  const since = (start: number) => log.slice(start).filter((r) => !(r.dest === 'document' || r.dest === 'iframe'));

  it('#1 a press that sends GETs, an image, a form or a request on release: nothing reaches the server; the measured failures stay failed', async () => {
    const start = log.length;
    const [r] = timed(await run(pointerCancellationProbe, '/press-requests.html'));
    expect(since(start)).toEqual([]);
    expect(summary(r!)).toEqual([['2.5.2', 'failed', '#submit-down'], ['2.5.2', 'failed', '#get-down']]);
    expect(r!.findings[0]!.detail).toBe('Pressing down on “Search for cats” sends a form before the button is released, so moving the pointer away cannot cancel it');
  }, 60_000);

  it('#2 controls named for an action (sign off, log me out, a descendant label, an image button alt, end session, close account, deactivate) are never pressed', async () => {
    const start = log.length;
    const [r] = await run(pointerCancellationProbe, '/press-names.html');
    expect(since(start)).toEqual([]);
    expect(r!.findings).toHaveLength(1);
    expect(r!.findings[0]).toMatchObject({ status: 'not_testable' });
    expect(r!.findings[0]!.detail).toMatch(/^8 elements that react to pressing down were not pressed because they are links, submit buttons or form fields, or their names say they perform an action \(“Sign off”, “Log me out”, “sign-off”, …\)$/);
  }, 60_000);

  it('#2 a swipe whose every point is a link is not testable; a drop goes onto the sibling item itself, never onto the Remove button over it', async () => {
    const start = log.length;
    const [r] = await run(pointerGesturesProbe, '/gesture-refused.html');
    expect(since(start)).toEqual([]);
    // The reorder is measured, but the Remove buttons next to the items are controls the test cannot
    // judge (round 2, E): not testable. Had the drop landed on a Remove button, the page would have
    // tried to leave (a held navigation, reported first).
    expect(summary(r!)).toEqual([['2.5.1', 'not_testable', ''], ['2.5.7', 'not_testable', '']]);
    expect(r!.findings[0]!.detail).toMatch(/^1 element of content with gesture handlers was not tested because every point to start a gesture on is a link, a submit button, a form field or named for an action/);
    expect(r!.findings[1]!.detail).not.toMatch(/another address/);
  }, 90_000);

  it('#3 the page’s own window capture listeners never see a click, a submit or a drag start while a test runs', async () => {
    // Had the page's listener seen the release click, it would have left the page (held: not testable).
    const [r] = await run(pointerCancellationProbe, '/press-capture.html');
    expect(r!.findings).toEqual([]);
  }, 60_000);

  it('#4 a seventh control under a document handler, beyond the limit, is disclosed: not testable, never clean', async () => {
    const [r] = await run(pointerCancellationProbe, '/press-delegated7.html');
    expect(r!.findings).toEqual([{ criterion: '2.5.2', status: 'not_testable', detail: '1 more kind of element that reacts to pressing down was not pressed (the test presses 6 kinds per page)' }]);
  }, 60_000);

  it('#4 a frame from the site whose handler is on its document is not tested: not testable', async () => {
    const [r] = await run(pointerCancellationProbe, '/press-frame-doc.html');
    expect(r!.findings).toEqual([{ criterion: '2.5.2', status: 'not_testable', detail: 'Content that reacts to pressing down inside an embedded frame from this site was not tested (/press-frame-doc-inner.html)' }]);
  }, 60_000);

  it('#4 a press that only changes text, a field value or a checkbox is failed', async () => {
    const runs = timed(await run(pointerCancellationProbe, '/press-text.html', '/press-value.html', '/press-check.html'));
    expect(runs.map((r) => summary(r))).toEqual([[['2.5.2', 'failed', '#save']], [['2.5.2', 'failed', '#plus']], [['2.5.2', 'failed', '#wrap']]]);
    expect(runs.map((r) => r.findings[0]!.detail)).toEqual([
      'Pressing down on “Save the draft” changes “Not saved” to “Saved” before the button is released, and moving the pointer away before releasing does not undo it',
      'Pressing down on “One more” changes the value of a form field before the button is released, and moving the pointer away before releasing does not undo it',
      'Pressing down on “Wrap it” changes the value of a form field before the button is released, and moving the pointer away before releasing does not undo it',
    ]);
  }, 90_000);

  it('#4 gesture handlers only on the document: not testable with the reason, not "not applicable"', async () => {
    const [r] = await run(pointerGesturesProbe, '/gesture-doc.html');
    const reason = 'the page handles gestures on the whole document (pointer, touch or mouse down and move handlers on the document or window), not on an element the test can find, so it was not tested';
    expect(gestures(r!)).toEqual([{ criterion: '2.5.1', status: 'not_testable', detail: reason }, { criterion: '2.5.7', status: 'not_testable', detail: reason }]);
  }, 60_000);
});

describe('review round 2', () => {
  it('A: a request like one made at load but with another query, and an image the guard stopped, are never a clean result', async () => {
    const [r] = await run(pointerCancellationProbe, '/press-known.html');
    expect(r!.findings).toHaveLength(1);
    expect(r!.findings[0]!.status).toBe('not_testable');
    expect(r!.findings[0]!.detail).toMatch(/^the page made a request when it was pressed or released \(fetch request to http:\/\/127\.0\.0\.1:\d+\/api\/feed\?page=2\)/);
  }, 60_000);

  it('B: a press that leaves the page changed (Escape does not undo it) stops the test: the rest is not testable', async () => {
    const [r] = await run(pointerCancellationProbe, '/press-left.html');
    expect(r!.findings).toEqual([{ criterion: '2.5.2', status: 'not_testable', detail: 'an earlier press left the page changed (Escape did not undo it), so 1 element that reacts to pressing down could not be pressed' }]);
  }, 60_000);

  it('C: plain elements named for an action (by text or aria-labelledby) are never pressed', async () => {
    const [r] = await run(pointerCancellationProbe, '/press-plain-names.html');
    expect(r!.findings).toEqual([{ criterion: '2.5.2', status: 'not_testable', detail: '2 elements that react to pressing down were not pressed because they are links, submit buttons or form fields, or their names say they perform an action (“Log out”, “Remove item”)' }]);
  }, 60_000);

  it('C: inside a closed shadow root the real mouse is never used', async () => {
    const [r] = await run(pointerCancellationProbe, '/press-closed.html');
    expect(r!.findings).toEqual([{ criterion: '2.5.2', status: 'not_testable', detail: '1 element that reacts to pressing down is inside a closed shadow root, where the pressed target cannot be seen, so it was not pressed' }]);
  }, 60_000);

  it('C: a pointer drag whose drop point is a Remove button is refused', async () => {
    const [r] = await run(pointerGesturesProbe, '/drag-handle-refused.html');
    expect(summary(r!)).toEqual([['2.5.1', 'not_applicable', ''], ['2.5.7', 'not_testable', '']]);
    expect(r!.findings[1]!.detail).toBe('1 element of draggable content was not tested because every point to start a gesture on is a link, a submit button, a form field or named for an action');
  }, 60_000);

  it('D: buttons sharing one handler are each pressed or disclosed; a delegated Delete is reported and Show is still pressed; a document handler with no buttons is not testable', async () => {
    const [shared, names, divs] = await run(pointerCancellationProbe, '/press-shared.html', '/press-delegated-names.html', '/press-delegated-divs.html');
    expect(shared!.findings).toEqual([{ criterion: '2.5.2', status: 'not_testable', detail: '1 more kind of element that reacts to pressing down was not pressed (the test presses 6 kinds per page)' }]);
    expect(summary(names!)).toEqual([['2.5.2', 'failed', expect.stringMatching(/button:nth-of-type\(2\)$/)]]);
    expect(divs!.findings).toEqual([{ criterion: '2.5.2', status: 'not_testable', detail: 'the page reacts to pressing down anywhere (a handler on the document or the window), and it has no buttons, tabs or summaries the test could press for it, so that handler was not tested' }]);
  }, 120_000);

  it('D: two carousels sharing one handler are both tested', async () => {
    const [r] = await run(pointerGesturesProbe, '/gesture-shared.html');
    expect(summary(r!)).toEqual([['2.5.1', 'failed', '#c2']]);
  }, 90_000);

  it('E: a control next to a gesture with a name the test does not recognise: not testable, never failed', async () => {
    const [r] = await run(pointerGesturesProbe, '/gesture-unknown.html');
    expect(gestures(r!)).toEqual([{ criterion: '2.5.1', status: 'not_testable', detail: UNKNOWN }, { criterion: '2.5.7', status: 'not_testable', detail: UNKNOWN.replace('content with gesture handlers', 'draggable content') }]);
  }, 60_000);
});

describe('live-site safety', () => {
  it('while the probes run, no POST, no action address and no other document reaches the server', async () => {
    const pages = ['/', '/press.html', '/press-post.html', '/press-action.html', '/press-click.html', '/press-shadow.html', '/press-delegated.html', '/press-requests.html', '/press-names.html', '/press-capture.html', '/press-known.html', '/press-plain-names.html', '/press-closed.html', '/drag-handle-refused.html', '/gesture.html', '/drag.html', '/drag-post.html', '/gesture-refused.html'];
    const start = log.length;
    const runs = await runProbes(B(), pages.map((p, index) => ({ url: `${server.origin}${p}`, index })), [pointerCancellationProbe, pointerGesturesProbe], OPTS);
    expect(runs).toHaveLength(pages.length * 2);
    const seen = log.slice(start);
    expect(seen.length).toBeGreaterThanOrEqual(pages.length * 2);
    expect(seen.filter((r) => r.method !== 'GET' && r.method !== 'HEAD')).toEqual([]);
    expect(seen.filter((r) => isActionUrl(`${server.origin}${r.path}`))).toEqual([]);
    // The fixtures load nothing but their own document (press-known.html also asks for its feed while
    // loading, which the audit would too): every other request would come from a test.
    const LOAD = ['/api/feed?page=1'];
    // The guard sends nothing while the probes run, so only the page loads (one per context) reach it.
    expect(seen.filter((r) => !LOAD.includes(r.path) && (r.dest !== 'document' || !pages.includes(r.path)))).toEqual([]);
    for (const p of pages) expect(seen.filter((r) => r.path === p).length, p).toBeLessThanOrEqual(2);
  }, 180_000);
});

afterAll(() => {
  // Per-probe time on the fixtures (ms per page, probe time without loading), for the shipped notes.
  for (const [probe, list] of Object.entries(ms)) console.log(`[timing] ${probe}: ${list.join(', ')} ms`);
});

describe('2.1.1: a list that only dragging reorders (keyboard-op lane, 2026-11-11; F54)', () => {
  const kb = (r: ProbeRun) => r.findings.filter((f) => f.criterion === '2.1.1').map((f) => [f.status, f.target ?? '']);
  it('fails a list dragging and clicking its items reorder when none of its items takes focus and nothing on the page offers the keyboard a way', async () => {
    const [r] = await run(pointerGesturesProbe, '/sort-click-none.html');
    expect(r!.status).toBe('ok');
    expect(kb(r!)).toEqual([['failed', '#shelters > li:nth-of-type(1)']]);
    expect(r!.findings.find((f) => f.criterion === '2.1.1')!.detail).toBe('Dragging this item (“Cedar Bend”) reorders its list, but none of its items can take keyboard focus, nothing near the list takes keyboard input, and no control, link or field on the page is named for ordering it or offers another way: the list cannot be put in order with the keyboard');
  }, 60_000);

  it('fix round 1, F1: a list only dragging reorders on a page with other controls and links is not testable, never failed (the 2.5.7 rule: another control on the page may do it)', async () => {
    const [r] = await run(pointerGesturesProbe, '/sort-keyboard-none.html');
    expect(r!.status).toBe('ok');
    expect(kb(r!)).toEqual([['not_testable', '#shelters > li:nth-of-type(1)']]);
    expect(r!.findings.find((f) => f.criterion === '2.1.1')!.detail).toMatch(/^Dragging this item \(“Cedar Bend”\) reorders its list and none of its items can take keyboard focus, but (another control or link on the page|controls next to it, with no name or one the test does not recognise,) may do it/);
  }, 60_000);

  it('fix round 1, F1 look-alikes: a keyboard way outside the list\'s section is not testable, never failed: a link to another way beside it, a "First choice" field in a sibling section, a button outside the block, a wrapper that takes focus', async () => {
    // Far from the list (no control next to it, so the 2.5.7 rule confirms that clicking the items reorders it): the
    // page-wide look finds the link, the field and the button; next to it (the link in its section, the wrapper), the
    // 2.5.7 rule's own doubt already holds.
    const why: Record<string, RegExp> = {
      '/sort-click-link-far.html': /a control or link on the page is named for ordering or another way \(“Rank them with a form instead”\)/,
      '/sort-click-sibling-select.html': /a field on the page \(“First choice”\) may set the order/,
      '/sort-click-outside-button.html': /a control or link on the page is named for ordering or another way \(“Put them in alphabetical order”\)/,
      '/sort-click-link.html': /controls next to it, with no name or one the test does not recognise/,
      '/sort-click-wrapper.html': /controls next to it, with no name or one the test does not recognise|the element around it/,
    };
    for (const [page, re] of Object.entries(why)) {
      const [r] = await run(pointerGesturesProbe, page);
      expect([page, r!.status]).toEqual([page, 'ok']);
      expect([page, kb(r!)]).toEqual([page, [['not_testable', '#shelters > li:nth-of-type(1)']]]);
      expect([page, r!.findings.find((f) => f.criterion === '2.1.1')!.detail]).toEqual([page, expect.stringMatching(re)]);
    }
  }, 180_000);

  it('look-alike: items that take focus and move with the arrow keys say nothing here (not applicable)', async () => {
    const [r] = await run(pointerGesturesProbe, '/sort-keyboard-arrows.html');
    expect(kb(r!)).toEqual([['not_applicable', '']]);
  }, 60_000);

  it('look-alikes: a field near the list that sets the order, and instructions naming a key, leave it not testable, never failed', async () => {
    const [sel] = await run(pointerGesturesProbe, '/sort-keyboard-select.html');
    expect(kb(sel!)).toEqual([['not_testable', '#shelters > li:nth-of-type(1)']]);
    const [told] = await run(pointerGesturesProbe, '/sort-keyboard-told.html');
    expect(kb(told!)).toEqual([['not_testable', '#shelters > li:nth-of-type(1)']]);
  }, 60_000);
});
