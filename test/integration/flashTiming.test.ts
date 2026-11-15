// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 2.3.1 in real Chromium: the page's own timing is kept, and what the test did not film is never clean
// (review r1, findings 1 and 11; fresh fixtures, test/fixtures/motion/flash-*.html).
//
// 1. The test runs the page's timers early. It used to run each alone and film 1.3 s before the next, so a lamp
//    that one timer starts blinking four times a second and another stops 0.4 s later (fewer than three flashes on
//    the real page) was filmed blinking for over a second: a failure the page does not have. "Web pages do not
//    contain anything that flashes more than three times in any one second period" (SC 2.3.1): what counts is what
//    the page does in its own time. Timers due close together are now run with the page's gaps; when that cannot
//    be done (repeating timers of the page that tick in between and never line up) the result is not testable.
//    Look-alikes: the same lamp stopped only after 2.5 s still fails; with a clock ticking every second it is
//    still measured (the test waits for a moment when the clock's tick falls where it would have).
// 11. Limits of the test (places where content waits to come into view, animations played again further down,
//    buttons pressed, timers filmed) used to end in a clean result with the rest never looked at. Each now says so
//    (not testable), and a place where nothing starts when it comes into view no longer uses up a film. No button
//    is passed over because it looks and reads like one already pressed (review r2, finding 1).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flashProbe } from '../../src/probes/flash.js';
import type { ProbeRun } from '../../src/probes/types.js';
import { motionSite, statuses, type MotionSite } from '../helpers/motionProbes.js';

let site: MotionSite;
let runs: Record<string, ProbeRun[]>;
const PAGES = ['flash-stopped-soon.html', 'flash-stopped-late.html', 'flash-stopped-soon-clock.html', 'flash-stopped-soon-two-clocks.html', 'flash-on-view-fourth.html', 'flash-on-view-busy.html',
  'flash-on-click-kinds.html', 'flash-on-click-same.html', 'flash-on-click-twins.html', 'flash-timers-six.html', 'flash-timers-three.html', 'flash-arrival-below-many.html'];
beforeAll(async () => {
  site = await motionSite();
  // One page at a time: the frame rate is what this test is about.
  runs = await site.run([flashProbe], PAGES, { concurrency: 1 });
  for (const p of PAGES) console.log(`flash timing: ${p}: ${JSON.stringify(runs[p]![0]!.data)} ${runs[p]![0]!.ms} ms ${JSON.stringify(runs[p]![0]!.findings.map((f) => `${f.status}: ${f.detail.slice(0, 150)}`))}`);
}, 480_000);
afterAll(async () => { await site?.close(); });
const findings = (page: string) => runs[page]![0]!.findings;
const failed = (page: string) => findings(page).filter((f) => f.status === 'failed');
const untested = (page: string) => findings(page).filter((f) => f.status === 'not_testable').map((f) => f.detail);
const text = (page: string) => JSON.stringify(findings(page));

describe('flash (2.3.1): the page’s timers are run with the page’s own timing', () => {
  it('does not fail a lamp that one timer starts blinking at 10 s and another stops 0.4 s later', () => {
    expect(statuses(runs['flash-stopped-soon.html']![0]!), text('flash-stopped-soon.html')).toEqual(['no_failures_found']);
    // Both timers were run, on one film.
    expect(runs['flash-stopped-soon.html']![0]!.data).toMatchObject({ timers: 2, timerFilms: 1 });
  });

  it('look-alike: the same lamp stopped only 2.5 s later fails', () => {
    expect(failed('flash-stopped-late.html'), text('flash-stopped-late.html')).toEqual([expect.objectContaining({ target: expect.stringContaining('#lamp'), detail: expect.stringMatching(/once a timer the page set has run$/) })]);
  });

  it('look-alike: with a clock that ticks every second the lamp stopped after 0.4 s is still measured, and not failed', () => {
    expect(statuses(runs['flash-stopped-soon-clock.html']![0]!), text('flash-stopped-soon-clock.html')).toEqual(['no_failures_found']);
  });

  it('is not testable, never failed and never only clean, when repeating timers that never line up tick in between', () => {
    expect(failed('flash-stopped-soon-two-clocks.html'), text('flash-stopped-soon-two-clocks.html')).toEqual([]);
    expect(untested('flash-stopped-soon-two-clocks.html'), text('flash-stopped-soon-two-clocks.html')).toEqual([expect.stringMatching(/^2 of the page’s timers could not be run early with the page’s own timing kept \(a repeating timer of the page ticks in between\)/)]);
  });
});

describe('flash (2.3.1): what the test did not film is said, never clean', () => {
  it('finds the fourth of four places that wait to come into view (the first three only fade in and use no film)', () => {
    expect(failed('flash-on-view-fourth.html'), text('flash-on-view-fourth.html')).toEqual([expect.objectContaining({ target: expect.stringContaining('#p4') })]);
    expect(runs['flash-on-view-fourth.html']![0]!.data).toMatchObject({ views: 1, viewsQuiet: 3 });
    // The places that only faded in are not filmed again later, and nothing is reported as left over.
    expect(untested('flash-on-view-fourth.html'), text('flash-on-view-fourth.html')).toEqual([]);
  });

  it('says so when more places start something on coming into view than it films', () => {
    expect(failed('flash-on-view-busy.html'), text('flash-on-view-busy.html')).toEqual([]);
    expect(untested('flash-on-view-busy.html'), text('flash-on-view-busy.html')).toEqual(expect.arrayContaining([expect.stringMatching(/^3 more places where content waits to come into view were not filmed/)]));
  });

  // Review r2, finding 1: a button that looks and reads like another is still pressed, or said to be left out.
  it('presses a second button that looks and reads like the first: the one that starts the lamp blinking fails', () => {
    expect(failed('flash-on-click-twins.html'), text('flash-on-click-twins.html')).toEqual([expect.objectContaining({ target: expect.stringContaining('#n1'), detail: expect.stringContaining('once the button “Play preview” was pressed') })]);
    expect(runs['flash-on-click-twins.html']![0]!.data).toMatchObject({ buttons: 2 });
  });

  it('says so when there are more buttons that show something than it presses, whether they differ or all read the same', () => {
    expect(failed('flash-on-click-kinds.html'), text('flash-on-click-kinds.html')).toEqual([]);
    expect(untested('flash-on-click-kinds.html'), text('flash-on-click-kinds.html')).toEqual([expect.stringMatching(/^2 more buttons that say they show or play something were not pressed/)]);
    // Six buttons with one name and one class: four are pressed, and the other two are not passed over in silence.
    expect(failed('flash-on-click-same.html'), text('flash-on-click-same.html')).toEqual([]);
    expect(untested('flash-on-click-same.html'), text('flash-on-click-same.html')).toEqual([expect.stringMatching(/^2 more buttons that say they show or play something were not pressed/)]);
    expect(runs['flash-on-click-same.html']![0]!.data).toMatchObject({ buttons: 4 });
  });

  it('says so when the page sets more timers that change the screen than it films; three such timers are all run', () => {
    expect(failed('flash-timers-six.html'), text('flash-timers-six.html')).toEqual([]);
    expect(untested('flash-timers-six.html'), text('flash-timers-six.html')).toEqual([expect.stringMatching(/^the page set more timers for the next 20 s than the test ran/)]);
    expect(statuses(runs['flash-timers-three.html']![0]!), text('flash-timers-three.html')).toEqual(['no_failures_found']);
    expect(runs['flash-timers-three.html']![0]!.data).toMatchObject({ timers: 3 });
  });

  it('says so when animations played in more places further down, as the page arrived, than it plays again', () => {
    expect(failed('flash-arrival-below-many.html'), text('flash-arrival-below-many.html')).toEqual([]);
    expect(untested('flash-arrival-below-many.html'), text('flash-arrival-below-many.html')).toEqual([expect.stringMatching(/^animations that played in 2 more places further down the page were not filmed/)]);
  });
});
