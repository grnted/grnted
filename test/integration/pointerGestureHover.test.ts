// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.5.7 / 2.5.1 (pointer gestures): what the pointer moving over content shows by itself is no drag (batch 17,
// motion-pointer). A chart's tooltip that waits a moment before it shows appeared during the test's drag and was
// read as "dragging pans the content" (2.5.7 failed on a chart that only shows its values on hover). A change now
// counts only when the drag changes the content beyond what the same moves without pressing show.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pointerGesturesProbe } from '../../src/probes/pointerGestures.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeFinding } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
beforeAll(async () => {
  server = await startFixtureServer('pointer');
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});
async function findings(file: string): Promise<ProbeFinding[]> {
  const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/${file}`, index: 0 }], [pointerGesturesProbe], { userAgent: 'grnted-test', full: true });
  return runs.flatMap((r) => r.findings);
}

describe('2.5.7: a hover tooltip is no drag', () => {
  it('RED: a chart whose tooltip shows a quarter second after the pointer comes, with a press listener that does nothing: not failed, not testable, saying why', async () => {
    const list = (await findings('tooltip-delay-chart.html')).filter((f) => f.criterion === '2.5.7');
    expect(list, JSON.stringify(list)).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('changes when the pointer only moves over it, without pressing') })]);
  }, 90_000);

  it('(guard) a map that pans only by dragging, with a tooltip that follows the pointer, still fails', async () => {
    const list = (await findings('pan-map-tooltip.html')).filter((f) => f.criterion === '2.5.7');
    expect(list.filter((f) => f.status === 'failed').map((f) => f.target), JSON.stringify(list)).toEqual(['#map']);
  }, 90_000);
});
