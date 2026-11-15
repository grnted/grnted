// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 17, lead's ruling (d): axe's p-as-heading is a trigger only. A paragraph set bolder or larger than the one
// after it may be a sentence, a date or a figure as well as a section title (the structure lane's labs: 37 look-alike
// pages failed 1.3.1 through it, none through the headings test). Its nodes are listed for review ("undecided by the
// rules"), and a styled paragraph fails 1.3.1 only through the headings test's proofs (twin, peer, repeated, site
// twin). Fixtures: test/fixtures/p-as-heading/ (written for this test).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headingsProbe } from '../../src/probes/headings.js';
import { RULE_CRITERION } from '../../src/ruleCriteria.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer('p-as-heading');
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const scan = (page: string) => scanSite(`${server.origin}/${page}`, { browser: browser as unknown as BrowserLike, maxPages: 1, probes: [headingsProbe], documents: false });
/** What fails 1.3.1 on the page: axe rules of 1.3.1 and the probe findings (the probe and its target). */
const fails131 = (r: SiteReport) => [
  ...r.rules.filter((x) => RULE_CRITERION[x.id] === '1.3.1').map((x) => [`axe:${x.id}`, x.examples[0]?.target ?? '']),
  ...(r.probes?.runs ?? []).flatMap((x) => x.findings.filter((f) => f.criterion === '1.3.1' && f.status === 'failed').map((f) => [x.probe, f.target ?? ''])),
];

describe('axe p-as-heading is a trigger only (lead\'s ruling d)', () => {
  it.each(['sentence', 'date', 'figure'])('a bold, larger %s over body text is listed for review, and 1.3.1 is not failed', async (kind) => {
    const r = await scan(`${kind}.html`);
    expect(r.rules.map((x) => x.id)).not.toContain('p-as-heading');
    // The rule still looks: what it flags is listed for review, for a person or the headings test to decide.
    expect(r.needsReview.map((x) => x.id)).toContain('p-as-heading');
    expect(fails131(r)).toEqual([]);
    expect(r.score).toBe(100);
  }, 60_000);

  it('a real styled heading still fails 1.3.1, through the headings test\'s proof (a named box title set larger than the real heading beside it)', async () => {
    const r = await scan('box-title.html');
    expect(r.rules.map((x) => x.id)).not.toContain('p-as-heading');
    expect(fails131(r)).toEqual([['headings', 'html > body > div > aside > section:nth-of-type(1) > p']]);
    expect(r.score!).toBeLessThan(100);
  }, 60_000);
});
