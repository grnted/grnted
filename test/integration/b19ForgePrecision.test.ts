// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 19, precision lane: classes of false alarms reasoned from the methods' assumptions and the look-alikes WCAG
// allows (general fixtures written for this test; nothing read from a blind site).
// - 4.1.3: a status message the page announces through the accessibility API itself (`ariaNotify`, WCAG's technique
//   ARIA27; Understanding 4.1.3: "direct access to accessibility APIs that result in assistive technology
//   alerts/announcements") is told to screen readers: no failure. The same message in a plain paragraph still fails.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formsProbe } from '../../src/probes/forms.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer('b19-precision');
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const scan = (file: string): Promise<SiteReport> =>
  scanSite(`${server.origin}/${file}`, { browser: browser as unknown as BrowserLike, maxPages: 1, probes: [formsProbe], full: true, documents: false });
const findings = (r: SiteReport, c: string) => (r.probes?.runs ?? []).flatMap((x) => x.findings.filter((f) => f.criterion === c));

describe('4.1.3: a status announced through ariaNotify is told to screen readers', () => {
  it('the sent form says so in a plain paragraph and through document.ariaNotify: no failure', async () => {
    const r = await scan('status-arianotify.html');
    const f = findings(r, '4.1.3');
    expect(f.filter((x) => x.status === 'failed'), JSON.stringify(f)).toEqual([]);
    expect(f.some((x) => x.status === 'no_failures_found'), JSON.stringify(f)).toBe(true);
  }, 120_000);
  it('the same message in a plain paragraph only: failed', async () => {
    const r = await scan('status-plain.html');
    expect(findings(r, '4.1.3').filter((x) => x.status === 'failed'), JSON.stringify(findings(r, '4.1.3'))).toHaveLength(1);
  }, 120_000);
});
