// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The core tests on a browser behind a network link (80 ms round trip), as the hosted checker runs
// them on Browser Rendering: what they find must not depend on how far away or how fast the browser
// is. Fixtures: test/fixtures/contrast/ (synthetic).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { overlaysProbe } from '../../src/probes/overlays.js';
import { runProbes } from '../../src/probes/runner.js';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import type { BrowserLike, Finding, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';
import { remoteBrowser, type RemoteBrowser } from '../helpers/remoteBrowser.js';

/** Each way: an 80 ms round trip, about what a Worker sees to its Browser Rendering session. */
const DELAY_MS = 40;

let remote: RemoteBrowser;
let contrast: Awaited<ReturnType<typeof startFixtureServer>>;
let overlays: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  contrast = await startFixtureServer('contrast');
  overlays = await startFixtureServer('overlays');
  remote = await remoteBrowser(DELAY_MS);
}, 60_000);

afterAll(async () => {
  await remote?.close();
  await contrast?.close();
  await overlays?.close();
});

const B = () => remote.browser as unknown as BrowserLike;
const undecided = (targets: string[]): Finding[] => [{
  id: 'color-contrast', help: 'Elements must meet minimum color contrast ratio thresholds', helpUrl: 'https://x/color-contrast',
  nodes: targets.map((target) => ({ target, html: '<p>', viewports: ['desktop'], failureSummary: "Element's background color could not be determined due to a background gradient" })),
}];
const results = (r: ProbeRun) => (r.data as { items: { target: string; result: string }[] } | undefined)?.items.map((i) => `${i.target} ${i.result.split(' ')[0]}`);

describe('text contrast on a remote browser (1.4.3)', () => {
  // 24 texts on gradients down a page six screens long, with three frames of its own: six places to measure.
  const targets = Array.from({ length: 24 }, (_, i) => `#h${i + 1}`);

  it('measures a long page well inside its time box, with the same findings every run', async () => {
    const runs: ProbeRun[] = [];
    for (let i = 0; i < 2; i++) {
      const [r] = await runProbes(B(), [{ url: `${contrast.origin}/text-heavy.html`, index: 0, incomplete: undecided(targets) }], [textContrastProbe], { userAgent: 'grnted-test' });
      runs.push(r!);
    }
    for (const r of runs) {
      expect(r.status).toBe('ok');
      expect(r.findings.map((f) => [f.status, f.target])).toEqual([['failed', '#h7'], ['failed', '#h24']]);
      // Before screenshots went through one CDP call each, this page took over 15 s here (its old time box).
      expect(r.ms).toBeLessThan(10_000);
    }
    expect(results(runs[1]!)).toEqual(results(runs[0]!));
  }, 120_000);
});

describe('floating boxes on a remote browser (1.4.10, 2.4.11)', () => {
  it('tabs through all 40 stops at both widths, so a control hidden at stop 35 is found as it is on a fast machine', async () => {
    // Before, each width's tab walk had 7 s: about 25 stops here, so 2.4.11 came out clean.
    const [r] = await runProbes(B(), [{ url: `${overlays.origin}/tab-late.html`, index: 1 }], [overlaysProbe], { userAgent: 'grnted-test' });
    expect(r!.status, JSON.stringify(r!.findings)).toBe('ok');
    expect(r!.findings.filter((f) => f.criterion === '2.4.11').map((f) => [f.status, f.target])).toEqual([['failed', '#l35']]);
    expect((r!.data as { stops: { stops: number }[] }).stops.map((s) => s.stops)).toEqual([40, 40]);
    expect(r!.ms).toBeLessThan(overlaysProbe.timeoutMs * 0.75);
  }, 120_000);
});
