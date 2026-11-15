// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, visual lane, D7 to D9 (docs/atlas/visual.md): a focus indicator is visible only when it changes what is
// on screen (D7), focus indicators are measured once per look and backdrop, not per markup kind, and also on the
// stops a focus loop kept the walk from (D8), and a stop entirely under content laid over it fails 2.4.7 as well as
// 2.4.11 (D9, the lead's ruling of 2026-11-12). Each red case has a look-alike that must stay clean.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeFinding } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer('keyboard');
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function findings(file: string): Promise<ProbeFinding[]> {
  const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/${file}`, index: 0 }], [keyboardProbe], { userAgent: 'grnted-test' });
  for (const r of runs) expect(r.status, `${file} ${r.probe}`).toBe('ok');
  return runs.flatMap((r) => r.findings);
}
const failed = (list: ProbeFinding[], criterion: string) => list.filter((f) => f.status === 'failed' && f.criterion === criterion);

describe('D7: an indicator the styles draw must change pixels', () => {
  it('fails a white ring on white, an inset ring under the link’s picture and a ring cut by clip-path; keeps a two-tone ring, a visible inset ring and a white ring on a dark band', async () => {
    const list = await findings('b18-focus-unseen.html');
    const f = failed(list, '2.4.7');
    expect(f.map((x) => x.target).sort(), JSON.stringify(f)).toEqual(['#clipped-path', '#covered', '#white']);
    expect(f.find((x) => x.target === '#white')!.detail).toMatch(/cannot be seen: its styles draw one/);
  }, 60_000);

  it('keeps a focus look a script shows only after a key press', async () => {
    const list = await findings('b18-focus-kbclass.html');
    expect(failed(list, '2.4.7'), JSON.stringify(failed(list, '2.4.7'))).toEqual([]);
  }, 60_000);
});

describe('V44: a ring drawn inside the box (1.4.11)', () => {
  it('fails a pale inset ring and keeps a strong one; both are visible indicators for 2.4.7', async () => {
    const list = await findings('b18-focus-inset.html');
    expect(failed(list, '1.4.11').map((x) => x.target), JSON.stringify(list.filter((x) => x.criterion === '1.4.11'))).toEqual(['#pale']);
    expect(failed(list, '2.4.7')).toEqual([]);
  }, 60_000);
});

describe('D8: kinds by look; stops a loop hid', () => {
  it('fails footer links whose reset is scoped to the footer, while navigation links of the same markup show a ring', async () => {
    const f = failed(await findings('b18-focus-scoped.html'), '2.4.7');
    expect(f.map((x) => x.target), JSON.stringify(f)).toEqual(['#foot-1']);
  }, 60_000);

  it('measures the stops a focus loop kept both walks from, and fails the launcher with no ring', async () => {
    const list = await findings('b18-focus-loop.html');
    expect(failed(list, '2.1.2').length).toBeGreaterThan(0);
    expect(failed(list, '2.4.7').map((x) => x.target), JSON.stringify(list.filter((x) => x.criterion === '2.4.7'))).toEqual(['#launcher']);
  }, 90_000);
});

describe('D9: a stop under content laid over it', () => {
  it('fails 2.4.7 and 2.4.11 for a button under an opaque panel laid over it', async () => {
    const list = await findings('cover-panel.html');
    expect(failed(list, '2.4.11').map((x) => x.target)).toEqual(['#copy']);
    expect(failed(list, '2.4.7').map((x) => x.target)).toEqual(['#copy']);
  }, 60_000);

  it('keeps 2.4.7 clean for a half-covered button', async () => {
    const list = await findings('cover-panel-half.html');
    expect(failed(list, '2.4.7')).toEqual([]);
  }, 60_000);
});
