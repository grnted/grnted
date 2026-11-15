// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.1.1 (the controls test): what the pointer resting on an element shows by itself is no effect of clicking it
// (batch 17, motion-pointer; found by the 2.5.2 gold look-alike). A chart's tooltip that waits a quarter second
// before it shows appeared after the click's 100 ms hover baseline and was read as "it answers a mouse click"
// (2.1.1 failed on a chart that only shows its values on hover). Before a click-only failure stands, the pointer
// now comes to rest on the element again without clicking: a change that shows then too is not the click's.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { controlsProbe } from '../../src/probes/controls/index.js';
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
  const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/${file}`, index: 0 }], [controlsProbe], { userAgent: 'grnted-test', full: true });
  return runs.flatMap((r) => r.findings);
}

describe('2.1.1: a hover tooltip is no effect of a click', () => {
  // Sol r1 S7: the first click rests on the control 0.8 s first, so the tooltip is part of what the click is compared with.
  it('RED: a chart whose tooltip shows a quarter second after the pointer comes, with a press listener that does nothing: not failed', async () => {
    const list = (await findings('tooltip-delay-chart.html')).filter((f) => f.criterion === '2.1.1');
    expect(list.filter((f) => f.status === 'failed'), JSON.stringify(list)).toEqual([]);
  }, 90_000);

  it('(guard) a card that opens its hours on a click only, with a tooltip of its own: still fails', async () => {
    const list = (await findings('click-panel-tooltip.html')).filter((f) => f.criterion === '2.1.1');
    expect(list.filter((f) => f.status === 'failed').map((f) => f.target), JSON.stringify(list)).toEqual(['#card']);
  }, 90_000);
});
