// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 2.2.2 (the motion test), batch 17 item 1: a control is credited for stopping motion only when the stop is
// not explained by the motion's own end. Before, an end that came during a control's check ("motion ended during the
// control check; control treated as working") passed a Pause button that does nothing (the release 0.2.0 lab
// allowlist: motion/ticker/8s/broken and motion/canvas/8s/broken). Now: a CSS animation is run again from its start
// and the control tried on it once more; a canvas that was drawn on after the press, or a rotation whose timer ran
// again after the press and then cleared itself, came to its own end: the control is left undecided (not testable).
// The fixtures end their motion a quarter second after the pointer reaches the Pause button: an end that lands in
// the control check every time, as an 8 s run does by its own clock in the lab.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { motionProbe } from '../../src/probes/motion.js';
import { runProbes } from '../../src/probes/runner.js';
import type { ProbeRun } from '../../src/probes/types.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let runs: Record<string, ProbeRun>;
const PAGES = ['ended-canvas-broken.html', 'ended-canvas-pause.html', 'ended-timer-broken.html', 'ended-timer-pause.html'];

beforeAll(async () => {
  server = await startFixtureServer('motion');
  browser = await chromium.launch();
  const list = await runProbes(browser as unknown as BrowserLike, PAGES.map((p, index) => ({ url: `${server.origin}/${p}`, index })), [motionProbe], { userAgent: 'grnted-test', full: true });
  runs = Object.fromEntries(list.map((r) => [new URL(r.page).pathname.slice(1), r]));
}, 240_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});
const motion = (page: string) => runs[page]!.findings.filter((f) => f.criterion === '2.2.2');

describe('motion (2.2.2): a stop that the motion\'s own end explains is no control\'s', () => {
  it('RED: a canvas whose drawing goes on after Pause is pressed and then ends by itself: Pause is not credited (not testable, saying why)', () => {
    expect(motion('ended-canvas-broken.html'), JSON.stringify(runs['ended-canvas-broken.html']!.findings)).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('came to its own end while the control "Pause" was checked') })]);
  });

  it('(guard) a canvas whose Pause button cancels its drawing loop: credited', () => {
    expect(motion('ended-canvas-pause.html'), JSON.stringify(runs['ended-canvas-pause.html']!.findings)).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: expect.stringContaining('the control "Pause" stops it') })]);
  });

  it('RED: rotating headlines whose timer runs again after Pause is pressed and then clears itself: Pause is not credited (not testable, saying why)', () => {
    expect(motion('ended-timer-broken.html'), JSON.stringify(runs['ended-timer-broken.html']!.findings)).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('came to its own end while the control "Pause" was checked') })]);
  });

  it('(guard) rotating headlines whose Pause button clears the timer: credited', () => {
    expect(motion('ended-timer-pause.html'), JSON.stringify(runs['ended-timer-pause.html']!.findings)).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: expect.stringContaining('the control "Pause" stops it') })]);
  });
});
