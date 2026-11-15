// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Timing run (not part of the normal suite: set GRNTED_TIMING=1): a 25-page scan of the synthetic site
// in test/fixtures/timing/ with and without the core probes, with server latency like a real site,
// and where each probe page group's time went. Prints a table; asserts nothing about speed.
//   GRNTED_TIMING=1 [GRNTED_TIMING_RUNS=3] npx vitest run test/timing
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { PROBE_DEFAULTS, type ProbeGroupTiming } from '../../src/probes/runner.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

const RUNS = Number(process.env.GRNTED_TIMING_RUNS ?? 2);
/** Server latency: pages 300 ms, everything else 40 ms. */
const delayMs = (path: string) => (path.endsWith('.html') || path.endsWith('/') ? 300 : 40);

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer('timing', {}, { delayMs });
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const s = (ms: number) => (ms / 1000).toFixed(1);

describe.skipIf(!process.env.GRNTED_TIMING)('probe timing on a 25-page synthetic site', () => {
  it('measures --no-probes against core probes', async () => {
    const lines: string[] = [];
    // Experiments only: GRNTED_TIMING_SLOTS overrides the runner's default slot count.
    if (process.env.GRNTED_TIMING_SLOTS) (PROBE_DEFAULTS as { concurrency: number }).concurrency = Number(process.env.GRNTED_TIMING_SLOTS);
    for (let run = 0; run < RUNS; run++) {
      for (const probes of [false, true]) {
        const groups: ProbeGroupTiming[] = [];
        let auditEnd = 0;
        const t0 = Date.now();
        const report = await scanSite(`${server.origin}/`, {
          browser: browser as unknown as BrowserLike, maxPages: 25, documents: false,
          ...(probes ? { onProbeGroup: (g: ProbeGroupTiming) => groups.push(g) } : { probes: false as const }),
          onProgress: (p) => { if (p.phase === 'documents') auditEnd = Date.now(); },
        });
        const total = Date.now() - t0;
        lines.push(`run ${run} ${probes ? 'core probes' : 'no probes  '}: ${s(total)} s (${report.pages.length} pages, audits done at ${s(auditEnd - t0)} s)`);
        for (const g of groups.sort((a, b) => a.startedAt - b.startedAt)) {
          const probeSum = Object.values(g.probeMs).reduce((a, b) => a + b, 0);
          lines.push(`  p${String(g.index).padEnd(2)} ${g.probes[0]!.padEnd(13)} queued ${s(g.queuedAt - t0).padStart(5)} wait ${s(g.startedAt - g.queuedAt).padStart(4)}`
            + ` open ${s(g.openMs)} load ${s(g.loadMs)} settle ${s(g.settleMs)} (x${g.loads}) probes ${s(probeSum)} end ${s(g.endedAt - t0).padStart(5)}`
            + `  ${Object.entries(g.probeMs).map(([k, v]) => `${k}=${v}`).join(' ')}`);
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  }, 600_000);
});
