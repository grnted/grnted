// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Grok's round-2 review of fix/strict-tests (2026-11-07, @ 8cb45f8e): each input it gave, as a fixture in
// test/fixtures/grok-r2/. Every one of these passed (wrongly) on 8cb45f8e; each must fail now. The proveDismiss
// inputs are in dismiss.test.ts, the 210-character title with a period (F43) in test/unit/headings.test.ts.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formFieldsProbe } from '../../src/probes/forms.js';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import { overlaysProbe } from '../../src/probes/overlays.js';
import { runProbes } from '../../src/probes/runner.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike, ProbeFinding } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer('grok-r2');
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function failed(file: string, probe: PageProbe, criterion: string): Promise<ProbeFinding[]> {
  const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/${file}.html`, index: 0 }], [probe], { userAgent: 'grnted-test', full: true });
  for (const r of runs) expect(r.status, `${file} ${r.probe}`).toBe('ok');
  const all = runs.flatMap((r) => r.findings);
  if (process.env.GROK_DEBUG) console.log(file, JSON.stringify(all.filter((f) => f.criterion === criterion).map((f) => [f.status, f.target, f.detail.slice(0, 160)])), process.env.GROK_DEBUG === 'data' ? JSON.stringify(runs.map((r) => r.data)).slice(0, 1500) : '');
  return all.filter((f) => f.criterion === criterion && f.status === 'failed');
}

describe('3.3.2 (form-fields)', () => {
  it('a GET form with a field named q and an email field, button "Send": both fields are judged', async () => {
    expect((await failed('forms-get-q-email', formFieldsProbe, '3.3.2')).map((f) => f.target)).toEqual(['Question (text field)', 'Email (text field)']);
  }, 30_000);
  it('a placeholder "Search" with a button "Go" fails', async () => {
    expect((await failed('forms-search-go', formFieldsProbe, '3.3.2')).map((f) => f.target)).toEqual(['Search (text field)']);
  }, 30_000);
  it('a language list in a form with other fields still needs a label', async () => {
    expect((await failed('forms-language-in-form', formFieldsProbe, '3.3.2')).map((f) => f.target)).toEqual(['lang (drop-down list)']);
  }, 30_000);
});

describe('2.4.1, 2.1.1, 2.1.2, 2.4.3 (keyboard)', () => {
  it('a skip link to an empty end box with no content paragraph bypasses nothing (plain or tabindex=-1)', async () => {
    for (const page of ['kb-skip-end-nopara', 'kb-skip-end-tabindex']) expect(await failed(page, keyboardProbe, '2.4.1'), page).toHaveLength(1);
  }, 60_000);
  it('"Show menu" controlling an empty region beside a full navigation is no bypass', async () => {
    expect(await failed('kb-show-menu-controls', keyboardProbe, '2.4.1')).toHaveLength(1);
  }, 30_000);
  it('a click listener on an element inside a carousel slide fails 2.1.1', async () => {
    expect(await failed('kb-carousel-child', keyboardProbe, '2.1.1')).toEqual([expect.objectContaining({ target: '#buy' })]);
  }, 30_000);
  it('an interval that takes focus back, on a page with no focus or key listener, is a trap', async () => {
    expect(await failed('kb-interval-trap', keyboardProbe, '2.1.2')).toEqual([expect.objectContaining({ target: '#trap' })]);
  }, 60_000);
  // Batch 19, the lead's ruling: a focus stop hidden when focused (off screen, transparent, clipped to nothing) fails
  // 2.4.7 (no focus indicator can be seen), not 2.4.3.
  it('focus moved to a 1 px target of an ordinary in-page link fails 2.4.7', async () => {
    expect(await failed('kb-fragment-1px', keyboardProbe, '2.4.7')).toEqual([expect.objectContaining({ target: '#note1' })]);
    expect(await failed('kb-fragment-1px', keyboardProbe, '2.4.3')).toEqual([]);
  }, 60_000);
});

describe('1.4.10 (overlays)', () => {
  it('a fixed 35% bottom panel (Grok: 39vh, which the 16x12 grid already measures over 40%) over the end of a long article fails', async () => {
    expect(await failed('ov-long-39', overlaysProbe, '1.4.10')).toEqual([expect.objectContaining({ detail: expect.stringContaining('stays under it wherever the page is scrolled') })]);
  }, 60_000);
});
