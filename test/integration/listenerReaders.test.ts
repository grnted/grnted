// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Chart fix round 4, S4 (the cut ruling): handlers written on elements in open shadow roots feed the keyboard test's
// 2.1.1 rule only. The names test (F59: an element that works as a control with no role) and the controls test read
// the listener hook exactly as at ab252945, so their findings on every page of the S7 widening are what they were
// there (recorded below from ab252945's engine on these fixtures, 2026-11-12). The keyboard test's are not (S7).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ariaStatesProbe } from '../../src/probes/ariaStates.js';
import { controlsProbe } from '../../src/probes/controls/index.js';
import { namesProbe } from '../../src/probes/names.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer('listener-alone');
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** The names, ARIA-state and controls tests' findings on a page: criterion, status and target, in order. */
async function others(file: string): Promise<string[]> {
  const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/${file}`, index: 0 }], [namesProbe, ariaStatesProbe, controlsProbe], { userAgent: 'grnted-test', full: true });
  return runs.flatMap((r) => r.findings.map((f) => `${r.probe} ${f.criterion} ${f.status} ${f.target ?? ''}`.trim()));
}

const S7_PAGES = ['shadow-inline-canvas.html', 'shadow-inline-control.html', 'shadow-inline-in-button.html'] as const;
/**
 * Recorded with ab252945's engine (its src checked out under these tests, 2026-11-12; out/hotfix/r4-readers-ab252945.log).
 * 7b2abfe1 added "names 4.1.2 failed #hours-btn >>> span" on the last page (out/hotfix/r4-readers-7b2abfe1.log).
 */
const AT_AB252945: Record<(typeof S7_PAGES)[number], string[]> = {
  'shadow-inline-canvas.html': ["controls 2.1.1 not_applicable", "controls 4.1.3 not_applicable", "controls 2.4.3 not_applicable", "controls 2.4.11 not_applicable", "controls 2.1.2 not_applicable"],
  'shadow-inline-control.html': ["controls 2.1.1 not_applicable", "controls 4.1.3 not_applicable", "controls 2.4.3 not_applicable", "controls 2.4.11 not_applicable", "controls 2.1.2 not_applicable"],
  'shadow-inline-in-button.html': ["controls 2.1.1 no_failures_found", "controls 4.1.3 not_applicable", "controls 2.4.3 not_applicable", "controls 2.4.11 no_failures_found", "controls 2.1.2 not_applicable"],
};

describe('round 4, S4: the names, ARIA-state and controls tests read the listener hook as at ab252945', () => {
  for (const page of S7_PAGES) {
    it(`${page}: the same findings as ab252945's engine`, async () => {
      const got = await others(page);
      expect(got).toEqual(AT_AB252945[page]);
    }, 90_000);
  }

  it('a keyboard-operable button element whose shadow root has a span with onclick="void 0": no 4.1.2 failure (Sol r3 S4)', async () => {
    const got = await others('shadow-inline-in-button.html');
    expect(got.filter((x) => / failed /.test(x)), JSON.stringify(got)).toEqual([]);
  }, 90_000);
});
