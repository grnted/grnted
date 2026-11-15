// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 1.3.1 (F2) through axe's p-as-heading: text that names something else is never an unmarked heading (the semantics
// lane's rule, review round 1, ruling 4: `installNamesSomething` in src/probes/namesSomething.ts, the one rule the
// headings test and the axe filter share). A group's or a region's label set exactly like the page's real h2s (tied
// to it by aria-labelledby, its first text, or a wrapper it is alone in that aria-labelledby names) is the group's
// label, not a section heading with no markup. Before this, axe failed every one of them (the simulation lab's
// headings/group-labels cases: 20 of 20, on the batch 15b base too). Look-alike that still fails: the same bold lines
// inside a group whose label is something else (its aria-label; its first text is a sentence), heading the group's
// own sections. Fixtures: test/fixtures/strict-4/axe-group-labels.html and axe-group-heading.html.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer('strict-4');
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('a group or region label is no heading (axe p-as-heading)', () => {
  it('labels of groups and regions set like the real h2s (tied, first text, a named wrapper) do not fail p-as-heading', async () => {
    const r = await scanSite(`${server.origin}/axe-group-labels.html`, { browser: browser as unknown as BrowserLike, maxPages: 1, probes: false, documents: false });
    expect(r.rules.filter((x) => x.id === 'p-as-heading').flatMap((x) => x.examples.map((e) => e.target))).toEqual([]);
    expect(r.score).toBe(100);
  }, 60_000);

  it('look-alike: bold lines that head the sections of a group labelled by something else are still flagged (listed for review since batch 17)', async () => {
    const r = await scanSite(`${server.origin}/axe-group-heading.html`, { browser: browser as unknown as BrowserLike, maxPages: 1, probes: false, documents: false });
    expect(r.needsReview.map((x) => x.id)).toContain('p-as-heading');
  }, 60_000);
});
