// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Lead checks on Grok round 2 (2026-11-07): Grok's literal inputs where the builder's fixture changed the shape,
// plus a look-alike that must stay clean.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import { overlaysProbe } from '../../src/probes/overlays.js';
import { runProbes } from '../../src/probes/runner.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike, ProbeFinding } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
beforeAll(async () => { server = await startFixtureServer('lead-r2'); browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

async function findings(file: string, probe: PageProbe, criterion: string): Promise<ProbeFinding[]> {
  const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/${file}.html`, index: 0 }], [probe], { userAgent: 'grnted-test', full: true });
  for (const r of runs) expect(r.status, `${file} ${r.probe}`).toBe('ok');
  return runs.flatMap((r) => r.findings).filter((f) => f.criterion === criterion);
}
const failed = (fs: ProbeFinding[]) => fs.filter((f) => f.status === 'failed');

describe('lead r2', () => {
  it('Grok literal: unarmed 80 ms interval trap fails 2.1.2', async () => {
    const fs = await findings('kb-interval-trap-literal', keyboardProbe, '2.1.2');
    console.log('trap', JSON.stringify(fs.map((f) => [f.status, f.target, f.detail.slice(0, 140)])));
    expect(failed(fs).length).toBeGreaterThan(0);
  }, 90_000);
  it('Grok literal: 39vh bottom panel on a long page fails 1.4.10', async () => {
    const fs = await findings('ov-long-39-literal', overlaysProbe, '1.4.10');
    console.log('39', JSON.stringify(fs.map((f) => [f.status, f.detail.slice(0, 140)])));
    expect(failed(fs).length).toBeGreaterThan(0);
  }, 90_000);
  it('look-alike: a working skip link to main still passes 2.4.1', async () => {
    const fs = await findings('kb-skip-works', keyboardProbe, '2.4.1');
    console.log('skip', JSON.stringify(fs.map((f) => [f.status, f.detail.slice(0, 140)])));
    expect(failed(fs)).toEqual([]);
  }, 90_000);
});
