// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.3.1 without frames of the screen (flash-motion, deep, not scored) in real Chromium on
// test/fixtures/motion/ (synthetic patterns): animations from their keyframes, script restyles,
// animated GIFs decoded frame by frame, and what it cannot read.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flashMotionProbe } from '../../src/probes/flashMotion.js';
import type { ProbeRun } from '../../src/probes/types.js';
import { motionSite, statuses, type MotionSite } from '../helpers/motionProbes.js';

let site: MotionSite;
beforeAll(async () => { site = await motionSite(); }, 30_000);
afterAll(async () => { await site?.close(); });

describe('the animation and media check (2.3.1, flash-motion)', () => {
  let runs: Record<string, ProbeRun[]>;
  const pages = ['flash-fast.html', 'flash-4hz.html', 'flash-red.html', 'flash-gif.html', 'flash-below-script.html', 'flash-2hz.html', 'flash-small.html', 'flash-slow.html', 'static.html', 'flash-video.html'];
  beforeAll(async () => { runs = await site.run([flashMotionProbe], pages); }, 120_000);
  const findings = (page: string) => runs[page]![0]!.findings;

  it('fails a large CSS animation flashing 4 and 5 times a second, and a red one, from their keyframes', () => {
    for (const page of ['flash-fast.html', 'flash-4hz.html']) {
      expect(findings(page), page).toEqual([expect.objectContaining({ status: 'failed', target: expect.stringContaining('div'), detail: expect.stringMatching(/^flashing in an animation \(from its keyframes\): \d+ changes of brightness in one second/) })]);
    }
    expect(findings('flash-red.html')).toEqual([expect.objectContaining({ status: 'failed', detail: expect.stringMatching(/^red flashing in an animation/) })]);
  });

  it('fails an animated GIF flashing 6 times a second, from its decoded frames', () => {
    expect(findings('flash-gif.html')).toEqual([expect.objectContaining({ status: 'failed', target: expect.stringContaining('img'), detail: expect.stringMatching(/^flashing in an animated GIF: /) })]);
  });

  it('fails an element a script swaps black and white, from its recorded style changes', () => {
    expect(findings('flash-below-script.html')).toEqual([expect.objectContaining({ status: 'failed', detail: expect.stringMatching(/^flashing as a script restyles it: /) })]);
  });

  it('finds no failure, saying how, for flashing at 2 a second, a small flashing area, slow flashing and a still page', () => {
    for (const page of ['flash-2hz.html', 'flash-small.html', 'flash-slow.html', 'static.html']) {
      expect(statuses(runs[page]![0]!), `${page}: ${JSON.stringify(findings(page))}`).toEqual(['no_failures_found']);
    }
    expect(findings('static.html')[0]!.detail).toMatch(/judged from their keyframes, style changes and image frames, without frames of the screen$/);
  });

  it('cannot test a page with a large playing video, and says why', () => {
    expect(findings('flash-video.html')).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('a playing video') })]);
  });

  it('never changes the page: no request beyond loading it', () => {
    expect(site.requests.filter((r) => !r.startsWith('GET '))).toEqual([]);
  });
});
