// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The batched key press (one round trip per focus stop, Plan 2 H0) must measure the same stop as a press
// followed by its own measurement: a page whose keyup handler moves focus in setTimeout(0) has finished
// that work before the next call into the page, so the batched measurement must wait for it too.
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pressAndMeasure, startKit } from '../../src/probes/keyboard/traverse.js';
import { kitMeasureKeyed, type KeyCounts, type KeyedStop } from '../../src/probes/keyboard/page.js';
import type { ProbeContext } from '../../src/probes/types.js';
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

/**
 * Stops (button names, '-' when focus left the page) of `n` Tab presses then `n` Shift+Tab presses:
 * batched (after the first press), or settled: each press, a wait for the page's own work, then the
 * measurement (a press followed at once by a measurement races the page's timers on a busy machine).
 */
async function walk(mode: 'batched' | 'settled', n: number): Promise<string[]> {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  try {
    const page: Page = await context.newPage();
    await page.goto(`${server.origin}/keyup-moves.html`, { waitUntil: 'load' });
    const ctx = { page } as unknown as ProbeContext;
    await startKit(ctx);
    const stops: string[] = [];
    let keys: KeyCounts | null = null;
    for (const key of ['Tab', 'Shift+Tab'] as const) {
      for (let i = 0; i < n; i++) {
        let step: KeyedStop;
        if (mode === 'batched') {
          step = await pressAndMeasure(ctx, key, keys, false);
        } else {
          await page.keyboard.press(key);
          await page.waitForTimeout(150);
          step = await page.evaluate(kitMeasureKeyed, undefined);
        }
        keys = step.keys;
        stops.push(step.facts.id === 0 ? '-' : (step.facts.name ?? '?'));
      }
    }
    return stops;
  } finally {
    await context.close();
  }
}

describe('keyboard: batched press and measurement', () => {
  it('a keyup handler that moves focus in setTimeout(0): the batched walk stops where a press-then-measure walk does', async () => {
    const settled = await walk('settled', 4);
    // The fixture's handler moves focus Two -> Five (Tab) and Four -> One (Shift+Tab).
    expect(settled).toEqual(['One', 'Five', 'Six', '-', 'Six', 'Five', 'One', '-']);
    expect(await walk('batched', 4)).toEqual(settled);
  }, 60_000);
});
