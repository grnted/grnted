// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 19, precision lane: classes of false alarms the real-site dev split showed (general fixtures written for this
// test; no site's data). Each look-alike beside the failure that must stay failed.
// - 1.4.1 (axe link-in-text-block): a link told apart only by colour in a breadcrumb trail inside a navigation landmark is
//   not in running text (F73 is about links in a block of text): Needs review. The same link in a paragraph still fails.
// - 1.4.4 (the resize-text test): text zoom does not enlarge because the layout at the zoomed width sets a smaller size (a
//   breakpoint's type scale) is Needs review; text sized in viewport units (F94) still fails.
// - 2.4.1 (the keyboard test's skip link): a page script that scrolls to the content in a 300 ms animation and moves focus
//   at its end is a working skip link (read only 150 ms after Enter, it was failed). A link to nowhere still fails.
// - 3.3.2 (the form-fields test): the one field of a site search whose only label is its placeholder: Needs review
//   (auditors differ). A form field with only a placeholder in a contact form still fails.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formFieldsProbe } from '../../src/probes/forms.js';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import { resizeTextProbe } from '../../src/probes/resizeText.js';
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

const scan = (file: string, probes = [formFieldsProbe]): Promise<SiteReport> =>
  scanSite(`${server.origin}/${file}`, { browser: browser as unknown as BrowserLike, maxPages: 1, probes, documents: false });
const row = (r: SiteReport, c: string) => r.criteria?.find((x) => x.criterion === c);

describe('1.4.1: a colour-only link in a breadcrumb trail is Needs review, in running text it fails', () => {
  it('breadcrumb trail in a navigation landmark: listed for review, 1.4.1 Needs review, not in the score', async () => {
    const r = await scan('breadcrumb-nav.html', []);
    expect(r.rules.map((x) => x.id), JSON.stringify(r.rules.map((x) => x.id))).not.toContain('link-in-text-block');
    expect(r.needsReview.map((x) => x.id)).toContain('link-in-text-block');
    expect(row(r, '1.4.1')?.status).toBe('flagged');
    expect(row(r, '1.4.1')?.methods.find((m) => m.id === 'axe')?.note ?? '').toMatch(/breadcrumb/);
  }, 90_000);
  it('the same colours in a paragraph: failed', async () => {
    const r = await scan('link-in-paragraph.html', []);
    expect(r.rules.map((x) => x.id)).toContain('link-in-text-block');
    expect(row(r, '1.4.1')?.status).toBe('failed');
  }, 90_000);
});

describe('3.3.2: a site search with only a placeholder is Needs review; another field with only a placeholder fails', () => {
  it('site search field labelled only by its placeholder: Needs review', async () => {
    const r = await scan('search-placeholder.html');
    const c = row(r, '3.3.2');
    expect(c?.status, JSON.stringify(c?.methods)).toBe('flagged');
    expect(JSON.stringify(c?.evidence)).toMatch(/site search field/);
  }, 90_000);
  it('a contact form field labelled only by its placeholder: failed', async () => {
    const r = await scan('contact-placeholder.html');
    expect(row(r, '3.3.2')?.status).toBe('failed');
  }, 90_000);
  // Narrowed after the gold run (the gold's own Grok round 2 failures, the lead's ruling): Needs review only for the one
  // text field of a search landmark (the fixture above); a field beside a button is judged by the button's words
  // (batch 18, ruling Q2: "Search" names an action, not what to enter).
  it('the one field of a search form beside a Search button, no landmark: not this rule (never Needs review here)', async () => {
    const r = await scan('search-placeholder-button.html');
    const c = row(r, '3.3.2');
    expect(c?.status, JSON.stringify(c?.methods)).not.toBe('flagged');
    expect(c?.status, JSON.stringify(c?.methods)).not.toBe('no_failures_found');
    expect(JSON.stringify(c?.evidence ?? [])).not.toMatch(/site search field/);
  }, 90_000);
  it('a placeholder "Search" with a button "Go" (nothing lasting names the field): failed', async () => {
    const r = await scan('search-placeholder-go.html');
    expect(row(r, '3.3.2')?.status, JSON.stringify(row(r, '3.3.2')?.evidence)).toBe('failed');
  }, 90_000);
  it('a GET form with a question field named q and an email field: failed', async () => {
    const r = await scan('search-q-and-email.html');
    expect(row(r, '3.3.2')?.status, JSON.stringify(row(r, '3.3.2')?.evidence)).toBe('failed');
  }, 90_000);
});

describe('1.4.4: a breakpoint size under zoom is Needs review; viewport units (F94) fail', () => {
  it('a heading the small-screen type scale sets smaller at the zoomed width: Needs review', async () => {
    const r = await scan('zoom-breakpoint.html', [resizeTextProbe]);
    const c = row(r, '1.4.4');
    expect(c?.status, JSON.stringify(c?.evidence)).toBe('flagged');
    expect(JSON.stringify(c?.evidence)).toMatch(/not from viewport units/);
  }, 90_000);
  it('text sized in viewport units: failed', async () => {
    const r = await scan('zoom-viewport-units.html', [resizeTextProbe]);
    expect(row(r, '1.4.4')?.status, JSON.stringify(row(r, '1.4.4')?.evidence)).toBe('failed');
  }, 90_000);
});

describe('2.4.1: a skip link whose script moves focus after a scroll animation works; one to nowhere fails', () => {
  it('focus moved at the end of a 300 ms scroll animation: no failure', async () => {
    const r = await scan('skip-animated.html', [keyboardProbe]);
    const c = row(r, '2.4.1');
    expect(c?.status, JSON.stringify(c?.evidence)).toBe('no_failures_found');
  }, 120_000);
  it('a skip link to a target that does not exist, no main landmark, no headings: failed', async () => {
    const r = await scan('skip-missing.html', [keyboardProbe]);
    expect(row(r, '2.4.1')?.status, JSON.stringify(row(r, '2.4.1')?.evidence)).toBe('failed');
  }, 120_000);
});
