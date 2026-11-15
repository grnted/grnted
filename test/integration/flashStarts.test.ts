// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 2.3.1 in real Chromium: flashing the film used to miss because of when it starts (the 2026-11
// red-team sites; fresh fixtures, test/fixtures/motion/flash-*.html). The film used to begin once the page had
// loaded and settled, and looked further down only where something was already moving, so it never saw:
// - flashing that starts on arrival and is over within two seconds (the test now films across its own load);
// - flashing that starts some seconds later (the page's timers are now run early, on film, with the page's own gaps);
// - flashing that starts when the content is scrolled into view (the places the page watches are now filmed);
// - flashing a button starts (buttons that say they show or play something are now pressed on film).
// WCAG 2.3.1 has no exception for flashing that is short or that follows a click: "Web pages do not contain
// anything that flashes more than three times in any one second period" (above the thresholds).
// Each has its look-alike that must keep passing: a slower sign, a single change, a fade-in, a still panel.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flashProbe } from '../../src/probes/flash.js';
import type { ProbeRun } from '../../src/probes/types.js';
import { motionSite, statuses, type MotionSite } from '../helpers/motionProbes.js';

let site: MotionSite;
let runs: Record<string, ProbeRun[]>;
const PAGES = ['flash-arrival-below.html', 'flash-arrival-below-calm.html', 'flash-delayed-below.html', 'flash-arrival.html', 'flash-arrival-slow.html', 'flash-delayed.html', 'flash-delayed-calm.html', 'flash-on-view.html', 'flash-on-view-calm.html', 'flash-on-click.html', 'flash-on-click-calm.html'];
beforeAll(async () => {
  site = await motionSite();
  // One page at a time: the frame rate is what this test is about.
  runs = await site.run([flashProbe], PAGES, { concurrency: 1 });
  for (const p of PAGES) console.log(`flash starts: ${p}: ${JSON.stringify(runs[p]![0]!.data)} ${runs[p]![0]!.ms} ms`);
}, 300_000);
afterAll(async () => { await site?.close(); });
const findings = (page: string) => runs[page]![0]!.findings;
const failed = (page: string) => findings(page).filter((f) => f.status === 'failed');

describe('flash (2.3.1): flashing by when it starts', () => {
  it('fails a sign that flashes four times a second for two seconds as the page arrives', () => {
    expect(failed('flash-arrival.html'), JSON.stringify(findings('flash-arrival.html'))).toEqual([expect.objectContaining({ target: expect.stringContaining('#sign'), detail: expect.stringMatching(/^flashing: \d+ changes of brightness in one second/) })]);
    expect(runs['flash-arrival.html']![0]!.data).toMatchObject({ method: 'screencast', arrival: true });
  });

  it('fails the same sign when it starts six seconds after arrival, and says a timer of the page started it', () => {
    expect(failed('flash-delayed.html'), JSON.stringify(findings('flash-delayed.html'))).toEqual([expect.objectContaining({ target: expect.stringContaining('#sign'), detail: expect.stringMatching(/once a timer the page set has run$/) })]);
  });

  it('fails the same sign far down the page when it starts as it is scrolled into view', () => {
    expect(failed('flash-on-view.html'), JSON.stringify(findings('flash-on-view.html'))).toEqual([expect.objectContaining({ target: expect.stringContaining('#sign') })]);
  });

  it('fails the same sign when a button starts it, and names the button', () => {
    expect(failed('flash-on-click.html'), JSON.stringify(findings('flash-on-click.html'))).toEqual([expect.objectContaining({ target: expect.stringContaining('#sign'), detail: expect.stringContaining('once the button “Show the lantern sign” was pressed') })]);
  });

  it('fails the sign below the first screen that flashes as the page arrives, or six seconds later: the same animation is played again where it sits', () => {
    expect(failed('flash-arrival-below.html'), JSON.stringify(findings('flash-arrival-below.html'))).toEqual([expect.objectContaining({ target: expect.stringContaining('#sign'), detail: expect.stringContaining('as it plays when the page arrives (the test played it again where it sits)') })]);
    expect(runs['flash-arrival-below.html']![0]!.data).toMatchObject({ arrival: true, replays: 1 });
    expect(failed('flash-delayed-below.html'), JSON.stringify(findings('flash-delayed-below.html'))).toEqual([expect.objectContaining({ target: expect.stringContaining('#sign'), detail: expect.stringContaining('once a timer the page set has run (the test played it again where it sits)') })]);
  });

  it('look-alike: a sign below the first screen that slides in once as the page arrives passes (played again, nothing flashes)', () => {
    expect(statuses(runs['flash-arrival-below-calm.html']![0]!), JSON.stringify(findings('flash-arrival-below-calm.html'))).toEqual(['no_failures_found']);
    expect(runs['flash-arrival-below-calm.html']![0]!.data).toMatchObject({ replays: 1 });
  });

  it('look-alikes pass: a slower sign on arrival, one change after a delay, a fade-in on coming into view, a still sign behind a button', () => {
    for (const page of ['flash-arrival-slow.html', 'flash-delayed-calm.html', 'flash-on-view-calm.html', 'flash-on-click-calm.html']) {
      expect(statuses(runs[page]![0]!), `${page}: ${JSON.stringify(findings(page))}`).toEqual(['no_failures_found']);
    }
    // Each was looked at where its content starts: the timer was run, the watched place filmed, the button pressed.
    expect(runs['flash-delayed-calm.html']![0]!.data).toMatchObject({ timers: 1 });
    // (a fade-in starts nothing: the place was looked at as it came into view, and needed no more film)
    expect(runs['flash-on-view-calm.html']![0]!.data).toMatchObject({ viewsQuiet: 1 });
    expect(runs['flash-on-click-calm.html']![0]!.data).toMatchObject({ buttons: 1 });
  });
});
