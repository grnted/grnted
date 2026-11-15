// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.5.3 Label in Name (batch 19, precision lane; the lead's ruling): axe's label-content-name-mismatch fails a link or
// button whose visible text is not all in its name. SC 2.5.3 asks that the name CONTAIN the text shown; where it is in
// the name is best practice. A name that holds only part of the words shown (words dropped), holds them abbreviated, or
// holds the component's first block of text whole and leaves out only other text set apart in blocks of its own (a
// logo's tagline, a card's description), is listed for review (Needs review), never a failure and never in the score.
// A name with words of its own and no whole block of the text shown stays a failure.
// Fixtures: test/fixtures/label-in-name/ (written for this test).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { namesProbe } from '../../src/probes/names.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer('label-in-name');
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const RULE = 'label-content-name-mismatch';
const scan = (file: string): Promise<SiteReport> =>
  scanSite(`${server.origin}/${file}`, { browser: browser as unknown as BrowserLike, maxPages: 1, probes: [namesProbe], documents: false });
const criterion = (r: SiteReport) => r.criteria?.find((c) => c.criterion === '2.5.3');

describe('2.5.3: a name that holds only part of the words shown, or holds them abbreviated, is Needs review', () => {
  const LOOK_ALIKES = [
    ['lead-logo.html', 'a logo link whose name starts with the agency name and leaves out its tagline'],
    ['lead-card.html', 'card links named by their title, leaving out the description under it'],
    ['lead-button-subline.html', 'a button named by its first line (and more), leaving out the smaller line under it'],
    ['lead-flex.html', 'a flex column link named by its title, leaving out the status line'],
    ['lead-br.html', 'a link whose second line, after a line break, is small print'],
    ['lead-mid-name.html', 'a logo link whose name holds the agency name after other words ("Home: ..."), leaving out its tagline'],
    ['fail-partial.html', '"The full label" named "the full" (a dropped word)'],
    ['fail-inline.html', '"Download printable form" named "Download form" (a dropped word)'],
    ['partial-abbreviation.html', '"Dept. of Water" named "Department of Water" (an abbreviation spelled out)'],
  ] as const;
  for (const [file, what] of LOOK_ALIKES) {
    it(`${what}: listed for review, 2.5.3 Needs review, not failed, 100`, async () => {
      const r = await scan(file);
      expect(r.rules.map((x) => x.id), JSON.stringify(r.rules.map((x) => x.id))).not.toContain(RULE);
      const listed = r.needsReview.find((x) => x.id === RULE);
      expect(listed, JSON.stringify(r.needsReview.map((x) => x.id))).toBeDefined();
      expect(listed!.pointsLost).toBe(0);
      const c = criterion(r);
      expect(c?.status, JSON.stringify(c?.methods)).toBe('flagged');
      const axe = c?.methods.find((m) => m.id === 'axe');
      expect(axe?.status).toBe('flagged');
      expect(axe?.note ?? '').toMatch(/hold only part of the words shown, or hold them abbreviated/);
      expect(r.score).toBe(100);
    }, 90_000);
  }
});

describe('2.5.3: true mismatches stay failed', () => {
  const FAILURES = [
    ['fail-other-words.html', '"Read more" named "Learn about the parks" (no word in common)'],
    ['fail-view-member.html', '"View member" named "View Kim Ortega" (one line; the name keeps only its first word)'],
    ['fail-address.html', 'an address shown, named "District office address, open in the map"'],
    ['fail-same-style.html', '"View" and "member" on two lines set alike, named "View Kim Ortega"'],
    ['fail-not-start.html', 'a logo lockup named "Home page" (the name does not start with the words shown)'],
    ['fail-interspersed.html', 'a first line "Pay online" named "Pay your bill online" (words put between)'],
  ] as const;
  for (const [file, what] of FAILURES) {
    it(`${what}: failed`, async () => {
      const r = await scan(file);
      expect(r.rules.map((x) => x.id), JSON.stringify(r.needsReview.map((x) => x.id))).toContain(RULE);
      expect(criterion(r)?.status).toBe('failed');
      expect(r.score!).toBeLessThan(100);
    }, 90_000);
  }
});
