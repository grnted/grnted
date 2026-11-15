// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Staging 2026-11-03 (trademe.co.nz answers 406 to every automated request): a site that refuses its
// start page and gives no other page address ends at once, from the one load discovery made: the start
// page is not loaded again for the audit, nothing else is tried, and the report says why (HTTP 406).
// Discovery also says what it is doing before each step, so the live view is never silent.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, ScanEvent } from '../../src/types.js';

let browser: Browser;
let server: Server;
let origin = '';
let status = 406;
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    // Browser loads only (Chromium's document requests): the start page's first-byte check
    // (siteSpeed.ts measureStart) is a plain request, not a load.
    if (req.headers['sec-fetch-dest'] === 'document') hits.push(req.url ?? '/');
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="en"><head><title>Not Acceptable</title></head><body><h1>Not Acceptable</h1></body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('a site that refuses its start page', () => {
  for (const s of [406, 403, 202]) {
    it(`HTTP ${s} everywhere: ends from discovery's one load of the start page, with the reason`, async () => {
      status = s;
      hits.length = 0;
      const events: ScanEvent[] = [];
      const t = Date.now();
      const report = await scanSite(`${origin}/`, { browser: browser as unknown as BrowserLike, maxPages: 25, documents: false, onEvent: (e) => events.push(e) });
      expect(Date.now() - t).toBeLessThan(10_000);
      expect(report.status).toBe('incomplete');
      expect(report.pages).toHaveLength(1);
      expect(report.pages[0]!.status).toBe('failed');
      expect(report.pages[0]!.reason).toMatch(new RegExp(`HTTP ${s}`));
      // The start page was loaded once (by discovery), never again by the audit.
      expect(hits.filter((h) => h === '/')).toHaveLength(1);
      // Discovery said what it was doing first.
      const said = events.filter((e) => e.type === 'discover').map((e) => (e as { detail: string }).detail);
      expect(said[0]).toBe('Reading the site’s robots.txt');
      expect(said).toContain('Loading the homepage');
    }, 60_000);
  }

  it('a 404 start page is audited as usual (not a refusal)', async () => {
    status = 404;
    hits.length = 0;
    const report = await scanSite(`${origin}/`, { browser: browser as unknown as BrowserLike, maxPages: 25, documents: false });
    expect(report.pages[0]!.reason).toBe('HTTP 404');
    expect(hits.filter((h) => h === '/').length).toBeGreaterThan(1);
  }, 60_000);
});
