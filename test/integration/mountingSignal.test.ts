// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// fix/late-mount review r1: only the page's PRIMARY placeholder says it is still mounting (`stillMounting`).
// A busy widget, a hidden or tiny "Loading…", or an empty main beside the real content is a finished page:
// before, any of them kept every test waiting 3 s and gave axe a second run on every page.
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stillMounting } from '../../src/probes/mounting.js';

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const CHROME = '<header><p>Fernwood Valley School</p><nav aria-label="Main"><a href="/">Home</a> <a href="/a">About</a></nav></header>';
const FOOTER = '<footer><p>100 Orchard Lane</p></footer>';
const ARTICLE = '<h1>Hours</h1><p>The office is open Monday to Friday, 8 am to 4 pm. Call the office to make an appointment outside those hours.</p>';
const mounting = async (body: string) => {
  await page.setContent(`<!doctype html><html lang="en"><head><title>T</title></head><body>${body}</body></html>`);
  return page.evaluate(stillMounting, undefined);
};

describe('stillMounting: the primary placeholder only', () => {
  it('an app root still busy, an empty app root beside the chrome only, a busy body or main: mounting', async () => {
    expect(await mounting(`${CHROME}<main><h1>Events</h1><div id="app" aria-busy="true"><p>Loading…</p></div></main>${FOOTER}`)).toBe(true);
    expect(await mounting(`${CHROME}<main><div id="app"></div></main>${FOOTER}`)).toBe(true);
    expect(await mounting(`${CHROME}<main aria-busy="true">${ARTICLE}</main>`)).toBe(true);
    expect(await mounting(`<div id="root"></div>`)).toBe(true);
  });

  it('a shown "Loading…" on a page with little else: mounting', async () => {
    expect(await mounting(`${CHROME}<main><h1>Events</h1><p style="font-size:20px">Loading…</p></main>${FOOTER}`)).toBe(true);
  });

  it('an empty main beside the real content: not mounting', async () => {
    expect(await mounting(`${CHROME}<main></main><div>${ARTICLE}</div>${FOOTER}`)).toBe(false);
  });

  it('a 1×1, hidden, transparent, aria-hidden or off-screen "Loading…": not mounting', async () => {
    const tiny = '<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Loading…</span>';
    expect(await mounting(`${CHROME}<main><h1>Events</h1>${tiny}<p>Open house soon.</p></main>`)).toBe(false);
    expect(await mounting(`${CHROME}<main><h1>Events</h1><div style="opacity:0"><p>Loading…</p></div></main>`)).toBe(false);
    expect(await mounting(`${CHROME}<main><h1>Events</h1><div aria-hidden="true"><p>Loading…</p></div></main>`)).toBe(false);
    expect(await mounting(`${CHROME}<main><h1>Events</h1><p style="position:absolute;top:3000px">Loading…</p></main>`)).toBe(false);
  });

  it('a busy live region or widget on a finished page: not mounting', async () => {
    expect(await mounting(`${CHROME}<main>${ARTICLE}<div role="status" aria-busy="true">Loading…</div></main>`)).toBe(false);
    expect(await mounting(`${CHROME}<main>${ARTICLE}<section aria-live="polite" aria-busy="true"><p>Updating</p></section></main>`)).toBe(false);
    const lots = `${ARTICLE}${ARTICLE.replace('Hours', 'More hours')}${ARTICLE.replace('Hours', 'Even more')}`;
    expect(await mounting(`${CHROME}<main>${lots}<section><div aria-busy="true"><p>Loading…</p></div></section></main>`)).toBe(false);
  });

  it('Sol r2 7: a busy widget that is one of several children of main is not the app root: not mounting', async () => {
    expect(await mounting(`${CHROME}<main><h1>Hours</h1><article><p>The office is open Monday to Friday, 8 am to 4 pm.</p></article><section aria-busy="true">Updating weather</section></main>`)).toBe(false);
    // The only element child of main, or #app, is the app root.
    expect(await mounting(`${CHROME}<main><section aria-busy="true"><p>Updating</p></section></main>`)).toBe(true);
  });

  it('Sol r2 3: a skeleton whose only text or picture is invisible (hidden template text, a transparent image) is still mounting', async () => {
    expect(await mounting(`${CHROME}<main><div style="visibility:hidden"><p>Template text</p></div><div class="skeleton" style="height:200px;background:#eee"></div></main>`)).toBe(true);
    const img = '<img alt="" width="200" height="100" style="opacity:0" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
    expect(await mounting(`${CHROME}<main><div>${img}</div><div class="skeleton" style="height:200px;background:#eee"></div></main>`)).toBe(true);
    expect(await mounting(`${CHROME}<main><div style="opacity:0"><p>Template text</p></div></main>`)).toBe(true);
  });

  it('a "Loading…" button or label on a page with plenty of text: not mounting', async () => {
    const lots = `${ARTICLE}${ARTICLE.replace('Hours', 'More hours')}${ARTICLE.replace('Hours', 'Even more')}`;
    expect(await mounting(`${CHROME}<main>${lots}<button>Loading…</button></main>`)).toBe(false);
  });
});
