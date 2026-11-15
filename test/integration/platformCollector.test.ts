// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// r2-1 (Grok r2): the real platform collector in a browser. Path-style signs (/wp-content/,
// /media/system/js/) count only on the site's own host; an off-host widget stylesheet or a CDN copy of
// Joomla's core.js names nothing. The page makes no network requests (all routed away).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectPlatformFacts } from '../../src/collect/platform.js';
import { platformSummary } from '../../src/platform.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 60_000);
afterAll(async () => browser?.close());

const SITE = 'https://district.example/';
async function factsFor(body: string) {
  const page = await browser.newPage();
  try {
    await page.route('**/*', (r) => (r.request().url() === SITE ? r.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html lang="en"><head><title>t</title>${body}</head><body><p>x</p></body></html>` }) : r.abort()));
    await page.goto(SITE);
    return await page.evaluate(collectPlatformFacts);
  } finally {
    await page.close();
  }
}

describe('r2-1: the real collector', () => {
  it('r2-1c: a Finalsite site with one off-host wp-content widget stylesheet is Finalsite (or unknown), never WordPress', async () => {
    const imgs = Array.from({ length: 12 }, (_, i) => `<img src="https://resources.finalsite.net/images/v1/x/${i}.jpg" alt="">`).join('');
    const f = await factsFor(`<link rel="stylesheet" href="https://cdn.widgets.example/?file=/wp-content/widget.css">${imgs}`);
    expect(f.markers).not.toContain('wordpress');
    expect(platformSummary({ site: SITE, ...f }).id).not.toBe('wordpress');
    expect(['finalsite', 'unknown']).toContain(platformSummary({ site: SITE, ...f }).id);
  }, 60_000);

  it('r2-1d: Joomla core.js from a CDN is not Joomla; on the site itself, with its stylesheet, it is', async () => {
    const cdn = await factsFor('<script src="https://cdn.example/lib/media/system/js/core.js"></script>');
    expect(cdn.markers).not.toContain('joomla');
    expect(platformSummary({ site: SITE, ...cdn }).id).toBe('unknown');
    const own = await factsFor('<script src="/media/system/js/core.js"></script><script src="/media/jui/js/jquery.min.js"></script>');
    expect(platformSummary({ site: SITE, ...own }).id).toBe('joomla');
  }, 60_000);

  it('b19: Astro scoped-style attributes on the page are the astro marker; a page without them has none', async () => {
    const page = await browser.newPage();
    try {
      const html = (body: string) => `<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`;
      await page.route('**/*', (r) => (r.request().url() === SITE ? r.fulfill({ status: 200, contentType: 'text/html', body: html('<header data-astro-cid-3ef6ksr2><a href="/" data-astro-cid-3ef6ksr2>Home</a></header><main><p>x</p></main>') }) : r.abort()));
      await page.goto(SITE);
      const f = await page.evaluate(collectPlatformFacts);
      expect(f.markers).toContain('astro');
      expect(platformSummary({ site: SITE, ...f }).id).toBe('astro');
      await page.unroute('**/*');
      await page.route('**/*', (r) => (r.request().url() === SITE ? r.fulfill({ status: 200, contentType: 'text/html', body: html('<header data-astro="x" class="astro-header"><a href="/">Home</a></header>') }) : r.abort()));
      await page.goto(SITE);
      const g = await page.evaluate(collectPlatformFacts);
      expect(g.markers).not.toContain('astro');
    } finally {
      await page.close();
    }
  }, 60_000);
});

