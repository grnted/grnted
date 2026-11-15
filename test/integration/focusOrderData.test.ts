// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The keyboard test's Tab order as evidence for the AI focus-order review (2.4.3), in real Chromium:
// each stop's role, name, box, landmark and section heading, in the order Tab reached them. The
// evidence changes no finding.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import { focusOrderFromData } from '../../src/probes/keyboard/orderData.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer('keyboard');
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('keyboard test: the focus order evidence', () => {
  it('records the Tab order with role, name, landmark and section; the reordered Pay button comes first in the form', async () => {
    const [run] = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/focus-order.html`, index: 0 }], [keyboardProbe], { userAgent: 'grnted-test' });
    expect(run!.status).toBe('ok');
    const order = focusOrderFromData(run!.data);
    expect(order, JSON.stringify(run!.data)).toBeDefined();
    expect(order!.stops.map((s) => [s.what, s.name, s.region ?? null, s.section ?? null])).toEqual([
      ['link', 'Riverside School', 'header', null],
      ['link', 'About', 'navigation', null],
      ['link', 'Contact', 'navigation', null],
      ['button', 'Pay now', 'form', 'Pay school fees'],
      ['input text', 'Card number', 'form', 'Pay school fees'],
      ['input checkbox', 'I agree to the terms', 'form', 'Pay school fees'],
      ['link', 'Fees help', 'main', 'Questions'],
      ['link', 'Privacy', 'footer', 'Questions'],
    ]);
    // Drawn below the fields although Tab reaches it first: the positions show it.
    const pay = order!.stops[3]!;
    const card = order!.stops[4]!;
    expect(pay.y).toBeGreaterThan(card.y);
    expect(order!.stops.some((s) => s.known)).toBe(false);
    expect(order!.partial).toBe(false);
    // The order is evidence: CSS order showing Pay now under the fields although Tab reaches it first is a
    // recommendation, never a 2.4.3 failure (lead's ruling 2, Sol round 1: WCAG allows focus order to differ from layout).
    expect(run!.findings.filter((f) => f.criterion === '2.4.3' && f.status === 'failed')).toEqual([]);
    expect(run!.findings.filter((f) => f.criterion === '2.4.3' && f.advice).map((f) => f.detail)).toEqual([expect.stringMatching(/^Tab moves focus from "Pay now".*"Card number".*which CSS shows before it/)]);
  }, 60_000);

  it('a positive tabindex: its stop and the next are marked known (the rules report it)', async () => {
    const [run] = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/tabindex.html`, index: 0 }], [keyboardProbe], { userAgent: 'grnted-test' });
    const order = focusOrderFromData(run!.data)!;
    expect(order.stops[0]!.tabindex).toBeGreaterThan(0);
    expect(order.stops.slice(0, 2).every((s) => s.known)).toBe(true);
    expect(run!.findings.some((f) => f.criterion === '2.4.3' && f.status === 'failed')).toBe(true);
  }, 60_000);
});
