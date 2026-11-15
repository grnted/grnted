// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A page-load pop-up on a page whose address looks like an action (src/probes/popupAside.ts, rule 8, and the coverage
// lane's guarantee F6: such an address is never loaded twice). A test that tries a dismissal asks the runner for a
// fresh page, and the runner loads a discarded page again for the next test: on an action address that second load
// is the one F6 forbids. The keyboard walk got the guard in 5ce62d40 (it asks for a fresh page only when the address
// does not look like an action); setting a pop-up aside takes the same guard. There the next test reuses the page, as
// it does after the keyboard walk. Look-alike: the same pop-up at an ordinary address still gets its fresh page (the
// address is loaded again for the next test). Fixture: test/fixtures/popup-aside/ (synthetic).
import type { IncomingMessage } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import type { PageProbe } from '../../src/probes/types.js';
import { defaultAxeSource } from '../../src/scan.js';
import type { BrowserLike, Finding } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const requests: string[] = [];
const OPTS: { userAgent: string; axeSource?: string } = { userAgent: 'grnted-test' };

beforeAll(async () => {
  server = await startFixtureServer('popup-aside', {}, { onRequest: (req: IncomingMessage) => requests.push(`${req.method} ${req.url}`) });
  browser = await chromium.launch();
  OPTS.axeSource = await defaultAxeSource();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** axe's undecided color-contrast results for the page's texts (the probe measures only these). */
const undecided: Finding[] = [{
  id: 'color-contrast', help: 'Elements must meet minimum color contrast ratio thresholds', helpUrl: 'https://x/color-contrast',
  nodes: ['#p1', '#band'].map((target) => ({ target, html: '<p>', viewports: ['desktop'], failureSummary: "Element's background color could not be determined because it's overlapped by another element" })),
}];
/** The test after text contrast (it waits for content too, so it keeps its place after it): it only says it ran. */
const after: PageProbe = { id: 'after', criteria: ['0.0.1'], kind: 'render', tier: 'core', timeoutMs: 5000, waitFor: { content: true }, async run() { return []; } };

async function loadsOf(path: string) {
  requests.length = 0;
  const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}${path}`, index: 0, incomplete: undecided }], [textContrastProbe, after], OPTS);
  const popup = (runs[0]!.data as { popup?: { setAside?: boolean } } | undefined)?.popup;
  return { gets: requests.filter((r) => r === `GET ${path}`).length, popup, order: runs.map((r) => `${r.probe} ${r.status}`) };
}

describe('setting a page-load pop-up aside on an action address (F6)', () => {
  it('never asks for the page to be loaded again: the address is fetched once, and the next test reuses the page', async () => {
    const r = await loadsOf('/?mode=button&lb=1&action=confirm');
    expect(r.popup?.setAside, JSON.stringify(r)).toBe(true);
    expect(r.order).toEqual(['text-contrast ok', 'after ok']);
    expect(r.gets, JSON.stringify(r)).toBe(1);
  }, 90_000);

  it('look-alike: at an ordinary address the next test still gets a fresh page (the address is loaded again)', async () => {
    const r = await loadsOf('/?mode=button&lb=1');
    expect(r.popup?.setAside, JSON.stringify(r)).toBe(true);
    expect(r.order).toEqual(['text-contrast ok', 'after ok']);
    expect(r.gets, JSON.stringify(r)).toBe(2);
  }, 90_000);
});
