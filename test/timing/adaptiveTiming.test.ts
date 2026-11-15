// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Timing run (not part of the normal suite: set GRNTED_TIMING=1): adaptive pages at once (src/pace.ts)
// against today's fixed 4, on local fixture servers with server latency like a real site (300 ms a
// page): the 25-page synthetic site (test/fixtures/timing/) and a generated site of GRNTED_TIMING_PAGES
// pages (default 250, ten sections). Prints a table; asserts only that the reports agree.
//   GRNTED_TIMING=1 [GRNTED_TIMING_PAGES=250] [GRNTED_TIMING_PROBES=1] npx vitest run test/timing/adaptiveTiming.test.ts
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PaceAdapt } from '../../src/pace.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike } from '../../src/types.js';
import { comparable } from '../helpers/comparable.js';
import { startFixtureServer, type FixtureRoutes } from '../helpers/fixtureServer.js';

const PAGES = Number(process.env.GRNTED_TIMING_PAGES ?? 250);
const delayMs = (path: string) => (path.endsWith('.html') || path.endsWith('/') ? 300 : 40);

/** A plain, accessible page of section `s`, number `i`, linking to its neighbours. */
function page(s: number, i: number, per: number): string {
  const links = [1, 2, 3].map((d) => `<li><a href="/section-${s}/page-${(i + d) % per}.html">Page ${(i + d) % per} of section ${s}</a></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Section ${s} page ${i}</title></head>
<body><header><nav aria-label="Main"><ul>${Array.from({ length: 10 }, (_, k) => `<li><a href="/section-${k}/page-0.html">Section ${k}</a></li>`).join('')}</ul></nav></header>
<main><h1>Section ${s}, page ${i}</h1>${Array.from({ length: 6 }, (_, p) => `<p>Paragraph ${p} of a page that reads like a real one, with enough text for the checks to have something to look at.</p>`).join('')}
<ul>${links}</ul></main><footer><p>Footer</p></footer></body></html>`;
}

function generated(n: number): FixtureRoutes {
  const sections = 10;
  const per = Math.ceil(n / sections);
  const routes: FixtureRoutes = {};
  const urls: string[] = [];
  for (let s = 0; s < sections; s++) {
    for (let i = 0; i < per && urls.length < n; i++) {
      const path = `/section-${s}/page-${i}.html`;
      routes[path] = { type: 'text/html; charset=utf-8', body: page(s, i, per) };
      urls.push(path);
    }
  }
  routes['/'] = { type: 'text/html; charset=utf-8', body: page(0, 0, per).replace('<h1>Section 0, page 0</h1>', '<h1>Home</h1>') };
  routes['/sitemap.xml'] = { type: 'application/xml', body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', ...urls].map((u) => `<url><loc>ORIGIN${u}</loc></url>`).join('')}</urlset>` };
  routes['/robots.txt'] = { type: 'text/plain', body: 'User-agent: *\nAllow: /\nSitemap: ORIGIN/sitemap.xml\n' };
  return routes;
}

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

describe.skipIf(!process.env.GRNTED_TIMING)('adaptive pages at once: timing', () => {
  it('25 pages and a generated site: fixed 4 against adaptive 4 to 8', async () => {
    const lines: string[] = [];
    const probes = process.env.GRNTED_TIMING_PROBES ? {} : { probes: false as const };
    const run = async (label: string, start: string, maxPages: number) => {
      const out: Record<string, unknown> = {};
      for (const [name, o] of [['fixed 4', { concurrency: 4 }], ['adaptive 4-8', { concurrency: 8, startConcurrency: 4 }]] as const) {
        const changes: PaceAdapt[] = [];
        const t0 = Date.now();
        const r = await scanSite(start, { browser: browser as unknown as BrowserLike, maxPages, documents: false, ...probes, ...o, onConcurrency: (e) => changes.push(e) });
        const ms = Date.now() - t0;
        out[name] = r;
        lines.push(`${label} ${name}: ${(ms / 1000).toFixed(1)} s, ${r.pages.length} pages, ${changes.map((c) => `${c.from}->${c.to} ${c.why}`).join(', ') || 'no change'}`);
      }
      expect(comparable(out['adaptive 4-8'])).toEqual(comparable(out['fixed 4']));
    };
    const small = await startFixtureServer('timing', {}, { delayMs });
    try {
      await run('25-page site', `${small.origin}/`, 25);
    } finally {
      await small.close();
    }
    // The generated site: its sitemap names the server's own origin.
    let origin = '';
    const routes = generated(PAGES);
    const big = await startFixtureServer('timing', new Proxy(routes, {
      get: (t, k: string) => {
        const r = t[k];
        return r && typeof r.body === 'string' ? { ...r, body: r.body.replaceAll('ORIGIN', origin) } : r;
      },
    }), { delayMs });
    origin = big.origin;
    try {
      await run(`${PAGES}-page site`, `${big.origin}/`, PAGES);
    } finally {
      await big.close();
    }
    console.log(lines.join('\n'));
  }, 3_600_000);
});
