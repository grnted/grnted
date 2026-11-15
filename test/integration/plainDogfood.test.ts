// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Dogfood for the open engine's plain HTML report (src/report/plain.ts, `grnted --html`): the fully populated
// fixture report (every section, hostile strings in every field) and a large one must score 100 on Granted
// itself, light and dark, and never scroll sideways at 320 px (CLAUDE.md: the report scores 100 on Granted).
import { createServer } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderPlainHtml } from '../../src/report/plain.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike } from '../../src/types.js';
import { bigReport } from '../helpers/bigReportFixture.js';
import { DOGFOOD_SCAN } from '../helpers/dogfood.js';
import { fullReport } from '../helpers/reportFixture.js';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => browser?.close());

async function serve<T>(doc: string, fn: (url: string) => Promise<T>): Promise<T> {
  const srv = createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(doc));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as { port: number };
  try {
    return await fn(`http://127.0.0.1:${port}/`);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

const scheme = (colorScheme: 'light' | 'dark'): BrowserLike => ({
  newContext: ((opts: Parameters<typeof browser.newContext>[0]) => browser.newContext({ ...opts, colorScheme })) as unknown as BrowserLike['newContext'],
});

describe('the plain HTML report on Granted itself', () => {
  for (const [name, make] of [['fully populated', fullReport], ['large', bigReport]] as const) {
    it(`dogfood: the ${name} report scores 100 in light and dark, with no rule or test issue`, async () => {
      await serve(renderPlainHtml(make()), async (url) => {
        for (const colorScheme of ['light', 'dark'] as const) {
          const self = await scanSite(url, { browser: scheme(colorScheme), ...DOGFOOD_SCAN });
          expect(self.rules, colorScheme).toEqual([]);
          expect(self.testIssues ?? [], colorScheme).toEqual([]);
          expect(self.score, colorScheme).toBe(100);
        }
      });
    }, 180_000);
  }

  it('never scrolls sideways at 320 px', async () => {
    await serve(renderPlainHtml(fullReport()), async (url) => {
      const ctx = await browser.newContext({ viewport: { width: 320, height: 800 } });
      try {
        const page = await ctx.newPage();
        await page.goto(url);
        const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
        expect(scroll).toBeLessThanOrEqual(inner!);
      } finally {
        await ctx.close();
      }
    });
  }, 60_000);
});
