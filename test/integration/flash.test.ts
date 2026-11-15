// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The 2.3.1 probe (flash, deep) in real Chromium on test/fixtures/motion/flash-*.html (synthetic CSS patterns).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flashProbe } from '../../src/probes/flash.js';
import type { ProbeRun } from '../../src/probes/types.js';
import { motionSite, statuses, type MotionSite } from '../helpers/motionProbes.js';

let site: MotionSite;
beforeAll(async () => { site = await motionSite(); }, 30_000);
afterAll(async () => { await site?.close(); });

describe('flash probe (2.3.1, deep)', () => {
  let runs: Record<string, ProbeRun[]>;
  beforeAll(async () => {
    // One page at a time: the frame rate is what this test is about.
    runs = await site.run([flashProbe], ['flash-fast.html', 'flash-red.html', 'flash-slow.html', 'flash-small.html', 'flash-below.html', 'flash-below-script.html', 'static.html'], { concurrency: 1 });
  }, 180_000);
  const findings = (page: string) => runs[page]![0]!.findings;

  it('fails large flashing above three a second, general and red, also further down the page', () => {
    expect(findings('flash-fast.html')).toEqual([expect.objectContaining({ status: 'failed', target: expect.stringContaining('div'), detail: expect.stringMatching(/^flashing: \d+ changes of brightness in one second/) })]);
    expect(findings('flash-red.html')).toEqual([expect.objectContaining({ status: 'failed', detail: expect.stringMatching(/^red flashing: /) })]);
    expect(findings('flash-below.html')).toEqual([expect.objectContaining({ status: 'failed', detail: expect.stringMatching(/^flashing: .* on the page$/) })]);
  });

  it('fails flashing a script makes further down the page (no CSS animation)', () => {
    expect(findings('flash-below-script.html')).toEqual([expect.objectContaining({ status: 'failed', detail: expect.stringMatching(/^flashing: .* on the page$/) })]);
  });

  it('finds no failure for slow flashing, a small flashing area and a still page', () => {
    for (const page of ['flash-slow.html', 'flash-small.html', 'static.html']) {
      expect(statuses(runs[page]![0]!), `${page}: ${JSON.stringify(findings(page))}`).toEqual(['no_failures_found']);
    }
    expect(findings('static.html')[0]!.detail).toContain('no general or red flashes above the threshold');
  });
});

// Pages that hold the window somewhere (mandatory scroll snapping) or build their content late.
describe('flash probe on pages that snap or show their content late', () => {
  let runs: Record<string, ProbeRun[]>;
  beforeAll(async () => {
    runs = await site.run([flashProbe], ['flash-snap-top.html', 'flash-late-below.html'], { concurrency: 1 });
  }, 120_000);
  const findings = (page: string) => runs[page]![0]!.findings;

  it('fails a flasher at the top of a page with mandatory scroll snapping (the window never sits at 0 there)', () => {
    expect(findings('flash-snap-top.html'), JSON.stringify(findings('flash-snap-top.html'))).toEqual([expect.objectContaining({ status: 'failed', target: expect.stringContaining('#flasher') })]);
  });

  it('fails a flasher far below that the page puts in 1.5 s after it loaded', () => {
    expect(findings('flash-late-below.html'), JSON.stringify(findings('flash-late-below.html'))).toEqual([expect.objectContaining({ status: 'failed', target: expect.stringContaining('#flasher') })]);
  });
});

// Places the test cannot reach, places taken by things that do not move, and late content behind busy ones.
describe('flash probe: which places get filmed', () => {
  let runs: Record<string, ProbeRun[]>;
  beforeAll(async () => {
    runs = await site.run([flashProbe], ['flash-scroll-back.html', 'flash-paused-posters.html', 'flash-late-busy.html'], { concurrency: 1 });
  }, 180_000);
  const findings = (page: string) => runs[page]![0]!.findings;

  it('a place the window will not stay at is not testable, never filmed at the top instead', () => {
    const f = findings('flash-scroll-back.html');
    expect(f.map((x) => x.status), JSON.stringify(f)).toContain('not_testable');
    expect(f.find((x) => x.status === 'not_testable')!.detail).toMatch(/did not stay where the test moved it/);
  });

  it('still video posters do not take the places: the flasher below them is filmed and fails', () => {
    const f = findings('flash-paused-posters.html');
    expect(f.filter((x) => x.status === 'failed'), JSON.stringify(f)).toEqual([expect.objectContaining({ target: expect.stringContaining('#flasher') })]);
  });

  it('the second look films a flasher shown late below two spinners that already took the first places', () => {
    const f = findings('flash-late-busy.html');
    expect(f.filter((x) => x.status === 'failed'), JSON.stringify(f)).toEqual([expect.objectContaining({ target: expect.stringContaining('#flasher') })]);
  });
});

// Smooth scrolling (`scroll-behavior: smooth` on html and body, as on portland.gov): the test's own
// scroll to a place further down must be instant, or the capture films text racing past and reads it
// as flashing (a false failure that sets Access Denied).
describe('flash probe on a page with smooth scrolling', () => {
  let runs: Record<string, ProbeRun[]>;
  beforeAll(async () => {
    runs = await site.run([flashProbe], ['smooth-scroll-text.html', 'smooth-scroll-flash.html'], { concurrency: 1 });
  }, 120_000);
  const findings = (page: string) => runs[page]![0]!.findings;

  it('finds no failure on a long page of text with moving (not flashing) content far below', () => {
    expect(statuses(runs['smooth-scroll-text.html']![0]!), JSON.stringify(findings('smooth-scroll-text.html'))).toEqual(['no_failures_found']);
  });

  it('still fails a real flasher far below, at its page position, naming the flashing element', () => {
    const f = findings('smooth-scroll-flash.html');
    expect(f, JSON.stringify(f)).toEqual([expect.objectContaining({ status: 'failed', target: expect.stringContaining('#flasher'), detail: expect.stringMatching(/^flashing: .* on the page$/) })]);
    // The flasher is at page y 3000 to 3400 (left 0, full width).
    const at = /at (\d+),(\d+) on the page$/.exec(f[0]!.detail)!;
    expect(Number(at[2])).toBeGreaterThanOrEqual(2990);
    expect(Number(at[2])).toBeLessThan(3400);
  });
});
