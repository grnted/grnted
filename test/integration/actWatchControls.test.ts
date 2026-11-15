// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Act and watch, controls (act-watch lane, 2026-11-11; src/probes/controls/index.ts step 2b, the kit's `choose`):
// a filter's "Update" button that changes nothing while its list keeps its first choice. The test makes another
// choice beside it and presses again; the status the press then shows is judged (4.1.3). In real Chromium on
// synthetic fixtures (test/fixtures/act-watch/filter-*.html), with look-alikes that must stay clean.
import type { IncomingMessage } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { controlsProbe } from '../../src/probes/controls/index.js';
import { STATUS_TEXT, statusFinding } from '../../src/probes/controls/rules.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const requests: string[] = [];
const OPTS = { userAgent: 'grnted-test', settleMs: 200, full: true };

async function run(page: string): Promise<ProbeRun> {
  const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/${page}.html`, index: 0 }], [controlsProbe], OPTS);
  return r!;
}
const failed = (r: ProbeRun, c: string) => r.findings.filter((f) => f.criterion === c && f.status === 'failed');

beforeAll(async () => {
  server = await startFixtureServer('act-watch', {}, { onRequest: (req: IncomingMessage) => { requests.push(req.url ?? ''); } });
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('a filter button that acts on the choice beside it', () => {
  it('RED: after another month is chosen, "Update list" shows "Four events in May." in a plain paragraph: 4.1.3 fails, saying the choice', async () => {
    const r = await run('filter-quiet');
    expect(failed(r, '4.1.3').map((f) => [f.target, f.detail])).toEqual([[
      '#result',
      'After choosing “May in Month”, pressing “Update list” shows “Four events in May.”, but screen readers are not told: the message is not in a live region (role="status", role="alert" or aria-live), and focus stays where it was.',
    ]]);
    // The press works with the keyboard: nothing for 2.1.1.
    expect(failed(r, '2.1.1')).toEqual([]);
  }, 60_000);

  it('RED: the same with a radio group for the month', async () => {
    const r = await run('filter-radios-quiet');
    expect(failed(r, '4.1.3').map((f) => f.target)).toEqual(['#result']);
    expect(failed(r, '4.1.3')[0]!.detail).toContain('After choosing “May”');
  }, 60_000);

  it('look-alikes: the result in a role=status region; a list that loads another page when changed; a button that does nothing whatever is chosen', async () => {
    for (const page of ['filter-status', 'filter-navigates', 'filter-unrelated']) {
      const r = await run(page);
      expect(failed(r, '4.1.3'), page).toEqual([]);
      expect(r.findings.filter((f) => f.status === 'failed'), page).toEqual([]);
    }
    // The list that loads a page on change: the navigation was held, never made.
    expect(requests.filter((u) => u.startsWith('/calendar-'))).toEqual([]);
  }, 120_000);
});

describe('the status words', () => {
  it('a count written as a word reads as a result ("Four events in May", "One result"); a sentence about options does not need a count', () => {
    const re = new RegExp(STATUS_TEXT, 'i');
    for (const t of ['Four events in May.', 'One result for “bridge”', 'Twelve documents found', '3 results', 'No matches']) expect(re.test(t), t).toBe(true);
    for (const t of ['Choose a month to see events.', 'The calendar lists every event.']) expect(re.test(t), t).toBe(false);
  });

  it('a finding says the choice it was made after', () => {
    const m = { id: 0, path: '#r', text: 'Four events in May.', live: false, focus: false, appeared: false, status: true, ofOpened: false };
    expect(statusFinding({ name: 'Update', path: '#go' }, m, false, 'May in Month').detail).toMatch(/^After choosing “May in Month”, pressing “Update” shows/);
    expect(statusFinding({ name: 'Update', path: '#go' }, m).detail).toMatch(/^Pressing “Update” shows/);
  });
});
