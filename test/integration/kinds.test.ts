// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Element kinds in real Chromium (src/collect/kinds.ts): what makes two elements one kind, and what does not.
// A kind only decides where an element is measured next (src/probes/components.ts); it is never a result.
// Still, every "different kind" below is a look-alike that should not even be sent a check.
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kindsCollectorFor, kindsOfTargets, readKinds, targetsOfKinds, KINDS_LIMITS, ORIENT_LIMITS } from '../../src/collect/kinds.js';
import type { PageLike } from '../../src/types.js';

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
}, 30_000);
afterAll(async () => browser?.close());

const doc = (body: string, head = '') => `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body>${body}</body></html>`;
/** The kind of the element `selector` names in `body`. */
async function kindOf(body: string, selector: string, head = ''): Promise<string> {
  await page.setContent(doc(body, head));
  await page.evaluate(readKinds, { ...KINDS_LIMITS, stash: true });
  const k = (await page.evaluate(kindsOfTargets, [selector]))![0];
  expect(k, `${selector} has a kind`).toBeTruthy();
  return k!;
}
const footer = (link: string, more = '') => `<main><p>Text</p></main><footer class="site-footer">${more}<p>City Hall</p>${link}</footer>`;
const LINK = '<a class="to-top" href="#top">Back to top</a>';

describe('one kind', () => {
  it('whatever the element says and wherever it leads', async () => {
    const a = await kindOf(footer(LINK), '.to-top');
    expect(await kindOf(footer('<a class="to-top" href="/start">Return to the start of the page</a>'), '.to-top')).toBe(a);
    expect(await kindOf(footer('<a class="to-top" href="#top" title="Top" aria-label="Go up">Up</a>'), '.to-top')).not.toBe(a);
    // The attributes themselves count (a title, a name); their words do not.
    expect(await kindOf(footer('<a class="to-top" href="#top" title="Start" aria-label="Rise">Up</a>'), '.to-top'))
      .toBe(await kindOf(footer('<a class="to-top" href="#top" title="Top" aria-label="Go up">Up</a>'), '.to-top'));
  });

  it('a menu is the same kind whichever item is current, and a list whatever its length', async () => {
    const menu = (current: number, n = 4) => `<nav class="main"><ul>${Array.from({ length: n }, (_, i) => `<li${i === current ? ' class="current"' : ''}><a href="/p${i}"${i === current ? ' aria-current="page"' : ''}>Page ${i}</a></li>`).join('')}</ul></nav>`;
    const a = await kindOf(menu(0), 'nav');
    expect(await kindOf(menu(2), 'nav')).toBe(a);
    expect(await kindOf(menu(1, 7), 'nav')).toBe(a);
    // A page that is not in the menu has no current item: another kind of menu, the same kind of plain link.
    const none = await kindOf(menu(-1), 'nav');
    expect(none).not.toBe(a);
    expect(await kindOf(menu(-1), 'li:nth-child(2) > a')).toBe(await kindOf(menu(0), 'li:nth-child(2) > a'));
  });

  it('while a script moves it: the inline style properties of an animation do not count', async () => {
    const ticker = (style: string) => `<div id="ticker" class="ticker"><span style="${style}">News</span></div>`;
    const a = await kindOf(ticker('transform: translateX(-10px); opacity: 0.4; left: 3px'), '#ticker');
    expect(await kindOf(ticker('transform: translateX(-250px); opacity: 1; left: 90px'), '#ticker')).toBe(a);
    // Look-alike: what a style sets for good does count.
    expect(await kindOf(ticker('transform: translateX(-10px); animation: none'), '#ticker')).not.toBe(a);
  });

  it('whatever else the page holds beside it', async () => {
    const a = await kindOf(footer(LINK), '.to-top');
    expect(await kindOf(`<header><h1>Other</h1></header><main><table><tr><td>1</td></tr></table></main><footer class="site-footer"><p>City Hall</p>${LINK}</footer>`, '.to-top')).toBe(a);
  });
});

describe('another kind (look-alikes that must not be taken for the measured element)', () => {
  it('its own class, inline style, state or attribute value differs', async () => {
    const a = await kindOf(footer(LINK), '.to-top');
    for (const other of [
      '<a class="to-top visible-focus" href="#top">Back to top</a>',
      '<a class="to-top" href="#top" style="outline: 2px solid">Back to top</a>',
      '<a class="to-top" href="#top" tabindex="-1">Back to top</a>',
      '<a class="to-top" href="#top" data-focus="ring">Back to top</a>',
      '<a class="to-top" href="#top" hidden>Back to top</a>',
      '<a class="to-top" id="top-link" href="#top">Back to top</a>',
      '<a class="to-top">Back to top</a>',
      '<button class="to-top">Back to top</button>',
    ]) expect(await kindOf(footer(other), '.to-top'), other).not.toBe(a);
  });

  it('an ancestor differs: its class, id, inline style, role or hidden state', async () => {
    const a = await kindOf(footer(LINK), '.to-top');
    const inFooter = (open: string) => `<main><p>Text</p></main>${open}<p>City Hall</p>${LINK}</footer>`;
    for (const open of ['<footer class="site-footer dark">', '<footer class="site-footer" id="f">', '<footer class="site-footer" style="outline: 0">', '<footer class="site-footer" role="presentation">', '<footer class="site-footer" aria-hidden="true">', '<footer class="site-footer" inert>']) {
      expect(await kindOf(inFooter(open), '.to-top'), open).not.toBe(a);
    }
    expect(await kindOf(`<main><p>Text</p></main><div class="wrap"><footer class="site-footer"><p>City Hall</p>${LINK}</footer></div>`, '.to-top')).not.toBe(a);
  });

  it('what it holds differs: a child of another kind, another picture, another drawing', async () => {
    const btn = (inner: string) => `<button class="menu" aria-label="Menu">${inner}</button>`;
    const svg = (fill: string) => `<svg viewBox="0 0 10 10" width="16" height="16"><path d="M0 0h10v2H0z" fill="${fill}"/></svg>`;
    const a = await kindOf(btn(svg('#111')), 'button');
    expect(await kindOf(btn(svg('#111')), 'button')).toBe(a);
    expect(await kindOf(btn(svg('#ccc')), 'button')).not.toBe(a);
    expect(await kindOf(btn('<img src="/icons/menu.png" alt="">'), 'button')).not.toBe(await kindOf(btn('<img src="/icons/close.png" alt="">'), 'button'));
    // The same picture with another cache parameter is the same picture.
    expect(await kindOf(btn('<img src="/icons/menu.png?v=2" alt="">'), 'button')).toBe(await kindOf(btn('<img src="/icons/menu.png?v=3" alt="">'), 'button'));
    expect(await kindOf(btn(`${svg('#111')}<span class="badge">3</span>`), 'button')).not.toBe(a);
  });
});

describe('what the collector leaves', () => {
  it('kinds are unique, the environment names stylesheets, scripts and body classes, never JSON data blocks', async () => {
    await page.setContent(doc('<main><p>a</p><p>b</p></main>', '<style>p{margin:0}</style><script type="application/ld+json">{"a":1}</script><script>window.x = 1;</script>'));
    await page.evaluate(() => { document.body.className = 'home page-id-7'; });
    const k = await page.evaluate(readKinds, { ...KINDS_LIMITS });
    expect(new Set(k.k).size).toBe(k.k.length);
    // Two paragraphs of one kind, and main.
    expect(k.k).toHaveLength(2);
    expect(k.env.filter((t) => t.startsWith('c:'))).toHaveLength(1);
    expect(k.env.filter((t) => t.startsWith('j:'))).toHaveLength(1);
    expect(k.env.filter((t) => t.startsWith('b:'))).toHaveLength(2);
  });

  it('features: ids and classes that differ only by a number are one loose kind; what is not interactive is not in focus', async () => {
    await page.setContent(doc(`<a id="story-12" class="card" href="/a">A</a><a id="story-13" class="card" href="/b">B</a><div id="note">Note</div>
<div role="button" tabindex="0" id="picker">Pick</div><input id="q" name="q"><marquee>Moving</marquee><div style="position:sticky;top:0">Bar</div><table><tr><td>1</td></tr></table>`));
    const k = await page.evaluate(readKinds, { ...KINDS_LIMITS });
    expect(k.f.focus).toHaveLength(3);
    expect(k.f.form).toHaveLength(1);
    expect(k.f.motion).toHaveLength(1);
    expect(k.f.fixed).toHaveLength(1);
    expect(k.f.struct).toHaveLength(1);
    // story-N, note, picker, q.
    expect(k.f.ids).toHaveLength(4);
  });

  it('press: what a press acts on that is neither a link nor a form field (act-watch lane, 2026-11-11)', async () => {
    await page.setContent(doc(`<a href="/a" onclick="go()">Link with a handler</a><a class="card" href="/b">Card</a><button id="save-page">Save</button>
<button class="tool">Print</button><button class="tool">Share</button><details><summary>More</summary><p>x</p></details><div role="tab" tabindex="0">Tab</div>
<span onclick="x()">Clickable</span><input type="submit" value="Send"><input id="q" name="q"><select><option>1</option></select>`));
    const k = await page.evaluate(readKinds, { ...KINDS_LIMITS });
    // #save, button.tool (one loose kind for both), summary, the tab, the clickable span and the submit button;
    // never a link (with or without a handler), the text field or the list.
    expect(k.f.press).toHaveLength(6);
    // Look-alike: a page of links and fields only has nothing to press.
    await page.setContent(doc('<a href="/a">A</a><a href="/b" onclick="go()">B</a><input name="q"><textarea></textarea>'));
    expect((await page.evaluate(readKinds, { ...KINDS_LIMITS })).f.press).toEqual([]);
  });

  it('orient: the elements a stylesheet styles by orientation, and only those', async () => {
    const css = '@media (orientation: portrait) { .visit .details { display: none } .visit .turn { display: block } } @media (min-width: 600px) { .wide { color: red } } @supports (display: grid) { @media screen and (orientation: landscape) { #map { height: 50vh } } }';
    await page.setContent(doc('<div class="visit"><p class="details">Hours</p><p class="turn">Turn your device</p></div><p class="wide">Wide</p><div id="map">Map</div><p>Plain</p>', `<style>${css}</style>`));
    const k = await page.evaluate(readKinds, { ...KINDS_LIMITS });
    // .details, .turn and #map; never the element of a width query or a plain one.
    expect(k.f.orient).toHaveLength(3);
    // Look-alike: the same page without the orientation queries has none.
    await page.setContent(doc('<div class="visit"><p class="details">Hours</p><p class="turn">Turn your device</p></div><p class="wide">Wide</p><div id="map">Map</div>', '<style>@media (min-width: 600px) { .wide { color: red } }</style>'));
    expect((await page.evaluate(readKinds, { ...KINDS_LIMITS })).f.orient).toEqual([]);
  });

  it('batch 18: an aspect-ratio query is an orientation query; a rule that hides or turns content is a lock, a restyle is not', async () => {
    const css = '@media (max-aspect-ratio: 1/1) { .visit .details { visibility: hidden } } @media (orientation: landscape) { .hero { height: 40vh } } @media (orientation: portrait) { body.app { transform: rotate(90deg) } }';
    await page.setContent(doc('<div class="visit"><p class="details">Hours</p></div><div class="hero">Hero</div><p>Plain</p>', `<style>${css}</style>`));
    await page.evaluate(() => document.body.classList.add('app'));
    const k = await page.evaluate(readKinds, { ...KINDS_LIMITS });
    // .details (aspect ratio, hidden), .hero (a restyle) and the turned body are styled by orientation; two are locks.
    expect(k.f.orient).toHaveLength(3);
    expect(k.f.orientLock).toHaveLength(2);
    // Look-alike: only restyles by orientation: no lock.
    await page.setContent(doc('<div class="hero">Hero</div><header class="top">Top</header>', '<style>@media (orientation: landscape) and (max-height: 500px) { header.top { position: static } } @media (orientation: portrait) { .hero { height: 30vh } }</style>'));
    expect((await page.evaluate(readKinds, { ...KINDS_LIMITS })).f.orientLock).toEqual([]);
    // A page script that compares the window's height and width is a lock candidate (its body).
    await page.setContent(doc('<main>Content</main><script>if (window.innerHeight > window.innerWidth) document.body.classList.add("turn")</script>'));
    expect((await page.evaluate(readKinds, { ...KINDS_LIMITS })).f.orientLock).toHaveLength(1);
    // A rotate wall's own words, hidden until a script from another file shows it, are a lock candidate too.
    await page.setContent(doc('<main><div class="wall" hidden>Rotate your device to landscape to use the planner.</div><p>Plan your visit.</p></main><script src="/planner.js"></script>'));
    expect((await page.evaluate(readKinds, { ...KINDS_LIMITS })).f.orientLock).toHaveLength(1);
    // Look-alike: a page that only talks about turning the page of a book.
    await page.setContent(doc('<main><p>Turn the page to see the map of the branch.</p></main>'));
    expect((await page.evaluate(readKinds, { ...KINDS_LIMITS })).f.orientLock).toEqual([]);
  });

  it('batch 18: fields in a same-origin frame, an open shadow root, or a frame whose address says form count as form fields', async () => {
    await page.setContent(doc('<main><p>Embedded form</p><iframe srcdoc="<label>Route<input name=r></label>"></iframe></main>'));
    await page.waitForFunction(() => !!document.querySelector('iframe')?.contentDocument?.querySelector('input'));
    expect((await page.evaluate(readKinds, { ...KINDS_LIMITS })).f.form).toHaveLength(1);
    await page.setContent(doc('<main><x-field></x-field></main><script>customElements.define("x-field", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<input placeholder=Email>"; } })</script>'));
    expect((await page.evaluate(readKinds, { ...KINDS_LIMITS })).f.form).toHaveLength(1);
    await page.setContent(doc('<main><iframe src="https://forms.example.invalid/f/123" width="600" height="400"></iframe></main>'));
    expect((await page.evaluate(readKinds, { ...KINDS_LIMITS })).f.form).toHaveLength(1);
    // Look-alikes: a video frame from another site, a same-origin frame of text, and a custom element without fields.
    await page.setContent(doc('<main><iframe src="https://video.example.invalid/embed/abc" width="600" height="400"></iframe><iframe srcdoc="<p>Notice</p>"></iframe><x-card></x-card></main><script>customElements.define("x-card", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<p>Card</p>"; } })</script>'));
    expect((await page.evaluate(readKinds, { ...KINDS_LIMITS })).f.form).toEqual([]);
  });

  it('reorder: what CSS shows in another order than the page\'s own, and only that', async () => {
    await page.setContent(doc(`<div id="steps" style="display:flex;flex-direction:column-reverse"><p>Third</p><p>Second</p><p>First</p></div>
<ul style="display:flex"><li style="order:2">B</li><li>A</li></ul><div style="display:flex;flex-direction:column"><p>One</p><p>Two</p></div>`));
    const k = await page.evaluate(readKinds, { ...KINDS_LIMITS });
    // The reversed list and the item with an order; never the plain column.
    expect(k.f.reorder).toHaveLength(2);
  });

  it('operable (the keyboard-op lane\'s press): what a script, not the browser, makes operable, once per pointer subtree', async () => {
    const css = '<style>.faux-button, .card, .drag-hint { cursor: pointer } .grabber { cursor: grab } .note { cursor: help }</style>';
    await page.setContent(doc(`<main id="main" tabindex="-1"><div id="service-expand" class="faux-button">Show Saturday depot hours <span>›</span></div>
<div class="card"><h3>Pool</h3><p>Hours</p></div><span class="grabber">⠿</span><ol><li draggable="true">First</li><li draggable="true">Second</li></ol>
<a class="drag-hint" href="/a"><span>Link</span></a><button class="faux-button">Native</button><div role="button" tabindex="0" class="faux-button">ARIA</div>
<label class="faux-button"><input type="checkbox"> Remember</label><p class="note">A note</p><section tabindex="0">A scrolling region</section><p>Plain</p></main>`, css));
    const k = await page.evaluate(readKinds, { ...KINDS_LIMITS });
    // The faux button, the card and the grabber (not their children, which inherit the cursor), one loose kind for the
    // two draggable items, and the custom ARIA button. Never a link, a native button, a label, a help cursor, plain text,
    // the skip target (tabindex -1) or a region made focusable.
    expect(k.f.operable).toHaveLength(5);
    // Look-alike: the same page without the cursors, the draggable items and the custom button has none.
    await page.setContent(doc('<main id="main" tabindex="-1"><div id="service-expand" class="faux-button">Show Saturday depot hours</div><div class="card"><h3>Pool</h3></div><ol><li>First</li></ol><button>Native</button></main>'));
    expect((await page.evaluate(readKinds, { ...KINDS_LIMITS })).f.operable).toEqual([]);
  });

  it('operable: the same custom control with another label is another key; with the same label (a number aside) the same key', async () => {
    const one = async (label: string) => {
      await page.setContent(doc(`<div id="background-case" class="fake-control" role="button" tabindex="0" aria-expanded="false">${label}</div>`));
      return (await page.evaluate(readKinds, { ...KINDS_LIMITS })).f.operable;
    };
    const a = await one('Show board briefing');
    expect(a).toHaveLength(1);
    expect(await one('Show support-period clubs')).not.toEqual(a);
    expect(await one('Show board briefing')).toEqual(a);
    expect(await one('Show 3 alerts')).toEqual(await one('Show 12 alerts'));
  });

  it('a selector that names nothing, or is not a selector, has no kind; a document without kept kinds says so', async () => {
    // A new document (a page the test loaded again): nothing kept yet.
    const fresh = await browser.newPage();
    try {
      await fresh.setContent(doc('<p id="a">a</p>'));
      expect(await fresh.evaluate(kindsOfTargets, ['#a'])).toBeNull();
      await fresh.evaluate(readKinds, { ...KINDS_LIMITS, stash: true });
      expect(await fresh.evaluate(kindsOfTargets, ['#a', '#missing', 'Back to top (link)', '!!'])).toEqual([expect.any(String), null, null, null]);
      // An element the page added after its kinds were read has none (it is never matched to another page).
      await fresh.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<p id="late">late</p>'); });
      expect(await fresh.evaluate(kindsOfTargets, ['#late'])).toEqual([null]);
    } finally {
      await fresh.close();
    }
  });
});

describe('review r1: what the collector reads is bounded, and stylesheets differ by their query (findings 2 and 12)', () => {
  it('a stylesheet or script with another query is another one; an element\'s own picture is the same file whatever its query', async () => {
    const env = async (head: string) => {
      await page.setContent(doc('<p>a</p>', head));
      return (await page.evaluate(readKinds, { ...KINDS_LIMITS })).env;
    };
    const broken = await env('<link rel="stylesheet" href="https://e.invalid/theme.css?variant=broken"><script src="https://e.invalid/app.js?v=1"></script>');
    const accessible = await env('<link rel="stylesheet" href="https://e.invalid/theme.css?variant=accessible"><script src="https://e.invalid/app.js?v=1"></script>');
    expect(accessible.filter((t) => t.startsWith('c:'))).not.toEqual(broken.filter((t) => t.startsWith('c:')));
    expect(accessible.filter((t) => t.startsWith('j:'))).toEqual(broken.filter((t) => t.startsWith('j:')));
    expect(await env('<script src="https://e.invalid/app.js?v=2"></script>')).not.toEqual(await env('<script src="https://e.invalid/app.js?v=1"></script>'));
    // Look-alike: the fragment is not part of the file.
    expect(await env('<link rel="stylesheet" href="https://e.invalid/theme.css?variant=broken#x">')).toEqual(await env('<link rel="stylesheet" href="https://e.invalid/theme.css?variant=broken">'));
    expect(await kindOf('<img class="logo" src="/logo.png?v=1" alt="City">', '.logo')).toBe(await kindOf('<img class="logo" src="/logo.png?v=2" alt="City">', '.logo'));
  });

  it('no element past the limit is looked at: not for kinds, not for features', async () => {
    // 400 elements with an id, each of another shape; the limit is 25.
    const letters = (i: number) => String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + (Math.floor(i / 26) % 26));
    await page.setContent(doc(Array.from({ length: 400 }, (_, i) => `<a id="x-${letters(i)}" class="c-${letters(i)}" href="/p">Link</a>`).join('')));
    const k = await page.evaluate(readKinds, { ...KINDS_LIMITS, elements: 25 });
    expect(k.cut).toBe(true);
    expect(k.k.length).toBeLessThanOrEqual(25);
    expect(k.f.ids).toHaveLength(25);
    expect(k.f.focus).toHaveLength(25);
    // Look-alike: within the limit every one of them is read.
    const whole = await page.evaluate(readKinds, { ...KINDS_LIMITS, feature: 1000 });
    expect(whole.cut).toBeUndefined();
    expect(whole.f.ids).toHaveLength(400);
  });

  it('a page with 60,000 elements is read within the limit, in well under the collector\'s time box', async () => {
    await page.setContent(doc(`<ul>${'<li><a href="/p">Link</a></li>'.repeat(30_000)}</ul>`));
    const t0 = Date.now();
    const k = await page.evaluate(readKinds, { ...KINDS_LIMITS });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(k.cut).toBe(true);
    expect(k.k.length).toBeLessThanOrEqual(KINDS_LIMITS.kinds);
  });

  it('a long scan reads kinds on the pages it keeps them for, and on no page past them', async () => {
    let calls = 0;
    const fake = { evaluate: async () => { calls++; return { k: [], env: [], f: {} }; } } as unknown as PageLike;
    const collector = kindsCollectorFor(100);
    expect(collector.id).toBe('kinds');
    await collector.collect(fake, { url: 'https://e.org/a', viewport: 'desktop', index: 99 });
    expect(calls).toBe(1);
    expect(await collector.collect(fake, { url: 'https://e.org/b', viewport: 'desktop', index: 100 })).toBeNull();
    expect(await collector.collect(fake, { url: 'https://e.org/c', viewport: 'desktop', index: 3400 })).toBeNull();
    expect(calls).toBe(1);
  });

  it('what is inside a shadow root or a frame has no kind (it triggers nothing; no result depends on it)', async () => {
    await page.setContent(doc('<div id="host"></div><iframe id="frame" srcdoc="<button id=inner>In a frame</button>"></iframe><button id="light">Light</button>'));
    await page.evaluate(() => { document.getElementById('host')!.attachShadow({ mode: 'open' }).innerHTML = '<button id="shadowed">In a shadow root</button>'; });
    await page.evaluate(readKinds, { ...KINDS_LIMITS, stash: true });
    expect(await page.evaluate(kindsOfTargets, ['#light', '#shadowed', '#inner'])).toEqual([expect.any(String), null, null]);
  });
});

describe('targetsOfKinds: this page\'s own element of a kind', () => {
  it('names the first element of the kind on this page by a selector of its own; a kind the page does not hold is left out', async () => {
    const withFooter = (before: string) => `${before}<main><p>Text</p></main><footer class="site-footer"><p>City Hall</p>${LINK}</footer>`;
    const kind = await kindOf(withFooter(''), '.to-top');
    // Another page: the same footer after other content, so the element sits elsewhere in the document.
    await page.setContent(doc(withFooter('<header><a href="/">Home</a></header><div class="notice"><a href="/n">Notice</a></div>')));
    // (The kinds kept from the document before name elements that are gone: none of them is offered.)
    expect(await page.evaluate(targetsOfKinds, [kind])).toEqual([]);
    const fresh = await browser.newPage();
    try {
      // A document whose kinds were never read says so: the caller reads them, then asks again.
      expect(await fresh.evaluate(targetsOfKinds, [kind])).toBeNull();
    } finally {
      await fresh.close();
    }
    await page.evaluate(readKinds, { ...KINDS_LIMITS, stash: true });
    const found = await page.evaluate(targetsOfKinds, [kind, 'no-such-kind']);
    expect(found).toHaveLength(1);
    expect(found![0]!.kind).toBe(kind);
    expect(await page.locator(found![0]!.selector).evaluate((el) => el.className)).toBe('to-top');
    expect(await page.locator(found![0]!.selector).count()).toBe(1);
    // An id that is unique on the page anchors the selector; one that is not does not.
    await page.setContent(doc('<div id="tools"><button class="go">Go</button></div><div id="dup"><i>a</i></div><div id="dup"><b class="x">b</b></div>'));
    await page.evaluate(readKinds, { ...KINDS_LIMITS, stash: true });
    const kinds = (await page.evaluate(kindsOfTargets, ['.go', '.x'])) as string[];
    const sel = (await page.evaluate(targetsOfKinds, kinds))!.map((t) => t.selector);
    expect(sel[0]).toBe('#tools > button:nth-of-type(1)');
    expect(sel[1]).toMatch(/^body > div:nth-of-type\(3\) > b/);
    expect(await page.locator(sel[1]!).evaluate((el) => el.className)).toBe('x');
  });
});


// Round-2 review (2026-11-10, finding 4; the lead's decision): the collection itself is capped where it reads the
// page, and the work done is counted. The reviewer's inputs: 300,000 script elements, and a rule
// `@media (orientation: portrait) { * { … } }` on a large page; with `elements: 1, env: 2` the unfixed reader
// still read one address per script element.
describe('round-2 review, finding 4: what the reader looks at is bounded, counted in the page', () => {
  /** Counts, inside the page, what the reader does to it: list queries and their sizes, addresses and texts read, selector matches. */
  async function instrument(p: Page): Promise<void> {
    await p.evaluate(() => {
      const work = { lists: 0, largestList: 0, scriptSrc: 0, linkHref: 0, texts: 0, matches: 0, animationLists: 0 };
      (window as unknown as { __work: typeof work }).__work = work;
      for (const proto of [Document.prototype, Element.prototype] as { querySelectorAll: (s: string) => NodeListOf<Element> }[]) {
        const all = proto.querySelectorAll;
        proto.querySelectorAll = function (this: Document | Element, sel: string) {
          const r = all.call(this, sel);
          work.lists++;
          work.largestList = Math.max(work.largestList, r.length);
          return r;
        };
      }
      const count = (proto: object, name: string, key: 'scriptSrc' | 'linkHref') => {
        const d = Object.getOwnPropertyDescriptor(proto, name)!;
        Object.defineProperty(proto, name, { configurable: true, get(this: unknown) { work[key]++; return d.get!.call(this); }, set: d.set });
      };
      count(HTMLScriptElement.prototype, 'src', 'scriptSrc');
      count(HTMLLinkElement.prototype, 'href', 'linkHref');
      const text = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')!;
      Object.defineProperty(Node.prototype, 'textContent', {
        configurable: true, set: text.set,
        get(this: Node) { if (this instanceof HTMLScriptElement || this instanceof HTMLStyleElement) work.texts++; return text.get!.call(this); },
      });
      const matches = Element.prototype.matches;
      Element.prototype.matches = function (this: Element, sel: string) { work.matches++; return matches.call(this, sel); };
    });
  }
  const work = (p: Page) => p.evaluate(() => (window as unknown as { __work: Record<string, number> }).__work);

  it('300,000 script elements: with room for 2 tokens the reader reads a handful of addresses, not one per element', async () => {
    const p = await browser.newPage();
    try {
      await p.setContent(doc('<main><p>a</p></main>'));
      // Scripts put in as markup are not run and not fetched.
      await p.evaluate(() => { document.head.insertAdjacentHTML('beforeend', '<script src="https://e.invalid/app.js"></script>'.repeat(300_000)); });
      await instrument(p);
      const t0 = Date.now();
      const k = await p.evaluate(readKinds, { ...KINDS_LIMITS, elements: 1, env: 2 });
      expect(Date.now() - t0).toBeLessThan(1500);
      const w = await work(p);
      // One address is all these scripts have, so the two tokens never fill: the reader stops at its own cap.
      expect(k.env.filter((t) => t.startsWith('j:'))).toHaveLength(1);
      expect(w.scriptSrc).toBeLessThanOrEqual(10);
      expect(w.largestList).toBeLessThanOrEqual(10);
    } finally {
      await p.close();
    }
  }, 120_000);

  it('300,000 style elements and stylesheet links: the same', async () => {
    const p = await browser.newPage();
    try {
      await p.setContent(doc('<main><p>a</p></main>'));
      await p.evaluate(() => {
        document.head.insertAdjacentHTML('beforeend', '<style>p{margin:0}</style>'.repeat(150_000));
        // rel="alternate stylesheet" with a title: counted as a stylesheet link, never fetched or applied.
        document.head.insertAdjacentHTML('beforeend', '<link rel="alternate stylesheet" title="t" href="https://e.invalid/site.css">'.repeat(150_000));
      });
      await instrument(p);
      await p.evaluate(readKinds, { ...KINDS_LIMITS, elements: 1, env: 2 });
      const w = await work(p);
      expect(w.texts).toBeLessThanOrEqual(10);
      expect(w.linkHref).toBeLessThanOrEqual(10);
      expect(w.largestList).toBeLessThanOrEqual(10);
    } finally {
      await p.close();
    }
  }, 120_000);

  it('`@media (orientation: portrait) { * { … } }` on a page of 60,000 elements: no list of every element is ever made', async () => {
    const p = await browser.newPage();
    try {
      await p.setContent(doc(`<ul>${'<li><a href="/p">Link</a></li>'.repeat(30_000)}</ul>`, '<style>@media (orientation: portrait) { * { outline-color: red } }</style>'));
      await instrument(p);
      const k = await p.evaluate(readKinds, { ...KINDS_LIMITS });
      const w = await work(p);
      expect(w.largestList).toBeLessThanOrEqual(10);
      // The elements the rule styles are still found, among those the reader walks: at most its element cap
      // of checks for the one selector, beside the five feature checks an element gets (press since 2026-11-11).
      expect(k.f.orient.length).toBeGreaterThan(0);
      expect(w.matches).toBeLessThanOrEqual(6 * KINDS_LIMITS.elements + 10);
    } finally {
      await p.close();
    }
  }, 120_000);

  it('a stylesheet with thousands of orientation rules: a bounded number of selectors, and of checks', async () => {
    const p = await browser.newPage();
    try {
      const rules = Array.from({ length: 5000 }, (_, i) => `.c${i} { color: red }`).join(' ');
      await p.setContent(doc(`<ul>${'<li class="c1"><a class="c2" href="/p">Link</a></li>'.repeat(3000)}</ul>`, `<style>@media (orientation: landscape) { ${rules} }</style>`));
      await instrument(p);
      const k = await p.evaluate(readKinds, { ...KINDS_LIMITS });
      const w = await work(p);
      expect(k.f.orient.length).toBeGreaterThan(0);
      expect(w.matches).toBeLessThanOrEqual(4 * KINDS_LIMITS.elements + ORIENT_LIMITS.checks + 10);
      expect(ORIENT_LIMITS).toEqual({ selectors: 30, checks: 60_000 });
    } finally {
      await p.close();
    }
  }, 120_000);

  it('look-alike: an ordinary page reads the same environment and the same orientation elements as before', async () => {
    const css = '@media (orientation: portrait) { .visit .details { display: none } body { margin: 0 } }';
    await page.setContent(doc('<div class="visit"><p class="details">Hours</p></div><p>Plain</p><script>window.a = 1;</script>',
      `<style>${css}</style><link rel="stylesheet" href="data:text/css,p{margin:0}"><link rel="icon" href="data:,"><script type="application/ld+json">{"a":1}</script>`));
    const k = await page.evaluate(readKinds, { ...KINDS_LIMITS });
    // The style block and the stylesheet link (never the icon); the inline script (never the data block).
    expect(k.env.filter((t) => t.startsWith('c:'))).toHaveLength(2);
    expect(k.env.filter((t) => t.startsWith('j:'))).toHaveLength(1);
    // .details, and body itself.
    expect(k.f.orient).toHaveLength(2);
  });
});
