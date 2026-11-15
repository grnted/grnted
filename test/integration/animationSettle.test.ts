// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Run-to-run determinism: a call to action that fades in (an entrance animation, or a script's fade)
// is 7:1 at rest. axe measuring it mid-fade gave one scan a contrast failure and the next none. The
// audit waits for entrance animations to finish (bounded) and checks a fading element again at rest.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
beforeAll(async () => {
  browser = await chromium.launch();
  server = await startFixtureServer('animated');
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('entrance animations settle before axe', () => {
  it('the same page scanned three times: the same score, and no contrast failure on the faded-in call to action', async () => {
    const scores: (number | null)[] = [];
    for (let k = 0; k < 3; k++) {
      const r = await scanSite(`${server.origin}/`, { browser: browser as unknown as BrowserLike, maxPages: 2, probes: false, documents: false });
      expect(r.rules.find((x) => x.id === 'color-contrast'), `scan ${k}`).toBeUndefined();
      expect(r.pages.every((p) => !p.animationsUnsettled)).toBe(true);
      scores.push(r.score);
    }
    expect(new Set(scores).size).toBe(1);
    expect(scores[0]).toBe(100);
  }, 180_000);
});
