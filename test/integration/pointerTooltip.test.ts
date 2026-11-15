// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.5.2 (pointer cancellation): what the pointer resting on an element shows is no outcome of pressing it (batch 17,
// motion-pointer; seen on a Highcharts chart: "pressing down shows the tooltip"). A chart's tooltip follows the pointer,
// fades in by a timer and hides some time after the pointer leaves; the container also listens for presses.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pointerCancellationProbe } from '../../src/probes/pointerCancellation.js';
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
  const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/${file}`, index: 0 }], [pointerCancellationProbe], { userAgent: 'grnted-test', full: true });
  return runs.flatMap((r) => r.findings);
}

describe('2.5.2: a hover tooltip is no outcome of a press', () => {
  it('a chart whose tooltip follows the pointer, with a press listener that does nothing: not failed', async () => {
    const list = (await findings('tooltip-hover-chart.html')).filter((f) => f.criterion === '2.5.2');
    expect(list.filter((f) => f.status === 'failed'), JSON.stringify(list)).toEqual([]);
  }, 90_000);

  it('RED: the same tooltip with a show delay (it appears while the button is held, and hides a while after the pointer leaves): not failed, not testable, saying why', async () => {
    const list = (await findings('tooltip-hover-delay.html')).filter((f) => f.criterion === '2.5.2');
    expect(list, JSON.stringify(list)).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('shows the same change when the pointer only rests on it') })]);
  }, 90_000);

  it('(guard) a button that saves the moment it goes down, with nothing on hover, still fails', async () => {
    const list = (await findings('press-message-guard.html')).filter((f) => f.criterion === '2.5.2');
    expect(list.filter((f) => f.status === 'failed').map((f) => f.target), JSON.stringify(list)).toEqual(['#save']);
  }, 90_000);
});
