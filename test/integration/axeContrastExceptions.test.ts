// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.3 exceptions axe's color-contrast rule does not know, re-checked in the page after axe
// (src/axeRun.ts, keepNode), in real Chromium:
// - Logotypes: "Text that is part of a logo or brand name has no contrast requirement" (SC 1.4.3).
// - Text that expresses nothing in human language (a row of tildes, a line of dots): ACT rule afw4f7
//   "Text has minimum contrast" leaves it out ("purely decorative or does not express anything in human
//   language"); WCAG's "pure decoration" (Incidental).
// Each exemption has its look-alike: real words in the same faint colour still fail.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAxe } from '../../src/axeRun.js';
import { defaultAxeSource } from '../../src/scan.js';
import type { AxeRun, PageLike } from '../../src/types.js';

let browser: Browser;
let axeSource: string;

beforeAll(async () => {
  browser = await chromium.launch();
  axeSource = await defaultAxeSource();
}, 60_000);
afterAll(async () => { await browser?.close(); });

// #c4d0cc on white is 1.6:1.
const CSS = 'body { font: 16px Arial; background: #fff; color: #1b1b1b; } .faint { color: #c4d0cc; }';
const doc = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test page</title><style>${CSS}</style></head><body><main><h1>Test page</h1>${body}</main></body></html>`;

async function axeOn(html: string): Promise<AxeRun> {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return (await runAxe(page as unknown as PageLike, axeSource)).run;
  } finally {
    await page.close();
  }
}

const failing = (run: AxeRun) => run.violations.find((v) => v.id === 'color-contrast')?.nodes.map((n) => n.target) ?? [];
const undecided = (run: AxeRun) => run.incomplete.find((v) => v.id === 'color-contrast')?.nodes.map((n) => n.target) ?? [];

describe('color-contrast (1.4.3): a logotype has no contrast requirement', () => {
  it('passes a faint text logo exposed as an image and named a wordmark, its small second line too', async () => {
    const run = await axeOn(doc('<div id="mark" class="wordmark faint" role="img" aria-label="Riverton wordmark">RIVERTON<span id="est">since 1901</span></div><p>Offices open at nine.</p>'));
    expect(failing(run)).toEqual([]);
    expect(undecided(run)).toEqual([]);
    expect(run.passes).toContain('color-contrast');
  });

  it('passes a faint text logo marked by its class or id (logo, logotype, wordmark, navbar-brand), also as a link', async () => {
    const run = await axeOn(doc(`<a id="a" class="site-logo faint" href="/">Riverton</a>
<p id="b" class="faint"><span id="logo">Riverton Water</span></p>
<a id="c" class="navbar-brand faint" href="/">Riverton</a>
<div id="d" class="footer__logotype faint">Riverton District</div>`));
    expect(failing(run)).toEqual([]);
  });

  it('look-alike: faint words that are not a logo still fail, whatever their class sounds like', async () => {
    const run = await axeOn(doc(`<p id="lede" class="faint">Pay your water bill by the tenth of the month.</p>
<a id="out" class="logout-link faint" href="/out">Sign out of your account</a>
<button id="buy" class="btn-brand faint" style="background:#fff;border:1px solid #333">Start a service request</button>
<p id="img" class="faint" role="img" aria-label="Opening hours">Open nine to five on weekdays</p>`));
    expect(failing(run).sort()).toEqual(['#buy', '#img', '#lede', '#out']);
  });

  it('look-alike: a whole section that happens to be named for the logo is not a logotype (more text than a logo holds)', async () => {
    const run = await axeOn(doc('<div class="logo-panel"><p id="long" class="faint">Riverton Water District serves eleven thousand homes across the valley and reads meters in the first week of every month.</p></div>'));
    expect(failing(run)).toEqual(['#long']);
  });
});

describe('color-contrast (1.4.3): text that expresses nothing in human language', () => {
  it('passes faint rows of symbols with no letter or digit (decoration), hidden from assistive technology or not', async () => {
    const run = await axeOn(doc(`<div id="waves" class="faint" aria-hidden="true">~ ~ ~</div>
<p id="stars" class="faint">* * *</p>
<p id="rule" class="faint">— · — · —</p>
<p>Offices open at nine.</p>`));
    expect(failing(run)).toEqual([]);
    expect(run.passes).toContain('color-contrast');
  });

  it('look-alike: the same faint colour on words, on digits, and on symbols around a word still fails', async () => {
    const run = await axeOn(doc(`<p id="word" class="faint">~ Sale ~</p>
<p id="sum" class="faint">2 + 2</p>
<p id="cjk" class="faint">营业时间</p>
<p id="plain" class="faint">Closed on public holidays</p>`));
    expect(failing(run).sort()).toEqual(['#cjk', '#plain', '#sum', '#word']);
  });
});

// Batch 18, visual lane, D18 (docs/atlas/visual.md): a decorative watermark that repeats the heading beside it.
describe('color-contrast (1.4.3): a decorative watermark that repeats visible text is pure decoration', () => {
  it('passes a huge faint hidden word that repeats the heading beside it; still fails one that says something new, or is not hidden', async () => {
    const water = (attrs: string, word: string) => doc(`<section><span id="w" class="faint" ${attrs} style="font-size:72px;display:block">${word}</span><h2 style="font-size:24px">Events</h2><p>Concerts and talks every week.</p></section>`);
    expect(failing(await axeOn(water('aria-hidden="true"', 'Events')))).toEqual([]);
    expect(failing(await axeOn(water('aria-hidden="true"', 'Closed Monday')))).toEqual(['#w']);
    expect(failing(await axeOn(water('', 'Events')))).toEqual(['#w']);
  }, 60_000);
});
