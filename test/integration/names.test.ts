// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The names test in real Chromium: text alternatives that are no alternative (1.1.1, failure F30: a file name
// or placeholder text as alt), and a form field whose accessible name leaves out its visible label (2.5.3).
// Every page here is written for this test.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NAMES_CONTROL_KEY, NAMES_KEY, NAMES_LIMITS, PLACEHOLDER_ALTS, labelNames, nameFindings, namesProbe, pictureControlNames, readNames } from '../../src/probes/names.js';
import type { ProbeContext, ProbeFinding } from '../../src/probes/types.js';
import { PROBES } from '../../src/probes/registry.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** The page's findings as the probe makes them: the page read, then each label candidate's name from the browser's accessibility tree. */
async function findingsOf(body: string): Promise<ProbeFinding[]> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><title>T</title><style>img{width:120px;height:80px} .vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}</style></head><body><main><h1>Spring clean-up</h1>${body}</main></body></html>`);
    const session = await page.context().newCDPSession(page);
    const ctx = { page, cdp: async () => session } as unknown as ProbeContext;
    const read = await page.evaluate(readNames, { ...NAMES_LIMITS, placeholders: [...PLACEHOLDER_ALTS], key: NAMES_KEY, controlKey: NAMES_CONTROL_KEY });
    return nameFindings(read, await labelNames(ctx, read), await pictureControlNames(ctx, read));
  } finally {
    await page.close();
  }
}
const failed = async (body: string): Promise<[string, string | undefined][]> => (await findingsOf(body)).filter((f) => f.status === 'failed').map((f) => [f.criterion, f.target]);
const undecided = async (body: string): Promise<[string, string | undefined][]> => (await findingsOf(body)).filter((f) => f.status === 'not_testable').map((f) => [f.criterion, f.target]);

describe('1.1.1 F30: a text alternative that is a file name of no meaning or placeholder text', () => {
  it('fails a camera, serial or random file name, and an alt that only says it is an image', async () => {
    // (Five of a kind are listed on a page; the last one counts the rest.)
    expect(await failed(`<img id="a" src="${PX}" alt="IMG_2041.JPG"><img id="b" src="${PX}" alt="DSC00412.png"><img id="c" src="${PX}" alt="image1.jpg"><img id="d" src="${PX}" alt="a8f3k2l9x0q1.png">`))
      .toEqual([['1.1.1', '#a'], ['1.1.1', '#b'], ['1.1.1', '#c'], ['1.1.1', '#d']]);
    expect(await failed(`<img id="e" src="${PX}" alt="photo.jpg"><img id="f" src="${PX}" alt="Screen Shot 2026-01-02 at 10.11.12.png"><img id="g" src="${PX}" alt="7c9e6679-7425-40de-944b-e07fc1f90ae7.webp"><img id="h" src="${PX}" alt="2026.jpg">`))
      .toEqual([['1.1.1', '#e'], ['1.1.1', '#f'], ['1.1.1', '#g'], ['1.1.1', '#h']]);
    expect(await failed(`<img id="c" src="${PX}" alt="image"><img id="d" src="${PX}" alt="Photo"><img id="e" src="${PX}" alt=" Picture. "><img id="f" src="${PX}" alt="spacer"><img id="g" src="${PX}" alt="IMG_2041"><img id="h" src="${PX}" alt="Photo 3">`))
      .toEqual([['1.1.1', '#g'], ['1.1.1', '#h'], ['1.1.1', '#c'], ['1.1.1', '#d'], ['1.1.1', '#e'], ['1.1.1', '#f']]);
    // An image button whose name is a camera file, and an image made with role="img".
    expect(await failed(`<input id="a" type="image" src="${PX}" alt="IMG_0042.gif"><div id="b" role="img" aria-label="image" style="width:80px;height:80px;background:#ccc"></div>`)).toEqual([['1.1.1', '#a'], ['1.1.1', '#b']]);
  });

  it('an export\'s own words beside a version or serial number say nothing; alone, or beside a word, they are words (batch 17)', async () => {
    expect(await failed(`<img id="a" src="${PX}" alt="export-final-v3.svg"><img id="b" src="${PX}" alt="IMG_2041-edited-final.jpg"><img id="c" src="${PX}" alt="scan0001_cropped_resized.png"><img id="d" src="${PX}" alt="draft-copy-2.png">`))
      .toEqual([['1.1.1', '#a'], ['1.1.1', '#b'], ['1.1.1', '#c'], ['1.1.1', '#d']]);
    expect(await failed(`<img src="${PX}" alt="final.jpg"><img src="${PX}" alt="draft.png"><img src="${PX}" alt="budget-final-v3.png"><img src="${PX}" alt="cup-final-2026.jpg"><img src="${PX}" alt="final-draft.png">`)).toEqual([]);
  });

  it('a file name that describes the picture is judged as ordinary alt text: not failed here', async () => {
    expect(await failed(`<img src="${PX}" alt="Mayor-Smith-cutting-ribbon-at-City-Hall.jpg"><img src="${PX}" alt="route-map-final-v3.png"><img src="${PX}" alt="spring_cleanup_volunteers.jpeg">
      <img src="${PX}" alt="logo.png"><img src="${PX}" alt="Budget chart 2026.png"><input type="image" src="${PX}" alt="search-button.gif">`)).toEqual([]);
  });

  it('a word that names the control the image is in ("Photo" on a category button) is not a placeholder', async () => {
    expect(await findingsOf(`<button type="button"><img src="${PX}" alt="Photo"></button> <a href="/gallery"><img src="${PX}" alt="Image"></a>
      <div role="tab" tabindex="0"><img src="${PX}" alt="Picture"></div> <input type="image" src="${PX}" alt="Photo">
      <button type="button"><span role="img" aria-label="Photo" style="display:inline-block;width:20px;height:20px"></span></button>`)).toEqual([]);
  });

  it('a word that can name what the picture shows is no placeholder, and a file name made of a word is a word', async () => {
    // The Alt key, an empty-set sign, a thermometer; "facade" is spelled with the letters a hash uses.
    expect(await failed(`<img src="${PX}" alt="Alt"><img src="${PX}" alt="None"><img src="${PX}" alt="Blank"><img src="${PX}" alt="Temp"><img src="${PX}" alt="To do">
      <img src="${PX}" alt="facade.jpg"><img src="${PX}" alt="decade-faded.png">`)).toEqual([]);
    // An artwork can be called "Untitled", and a two-letter word is a word ("US.png", "NY.gif").
    expect(await failed(`<img src="${PX}" alt="Untitled"><img src="${PX}" alt="US.png"><img src="${PX}" alt="NY-skyline.gif">`)).toEqual([]);
    // Look-alikes that still fail: words that only say it is an image, and a name of letters and digits.
    expect(await failed(`<img id="a" src="${PX}" alt="alt text"><img id="b" src="${PX}" alt="untitled image"><img id="c" src="${PX}" alt="fa3ade91.jpg">`)).toEqual([['1.1.1', '#c'], ['1.1.1', '#a'], ['1.1.1', '#b']]);
  });

  it('look-alikes: an alt that says what the picture shows, an empty alt, a word that names the picture, a link to the file itself', async () => {
    expect(await findingsOf(`
      <img src="${PX}" alt="Volunteers loading branches into the city truck on Mill Road">
      <img src="${PX}" alt="">
      <img src="${PX}" alt="Map"><img src="${PX}" alt="Logo"><img src="${PX}" alt="Photo of the new bridge"><img src="${PX}" alt="Image gallery"><img src="${PX}" alt="Figure 2"><img src="${PX}" alt="2026">
      <img src="${PX}" alt="The file route.png could not be shown">
      <a href="/files/IMG_2041.png" download>Download <img src="/files/IMG_2041.png" alt="IMG_2041.png"></a>
      <img src="${PX}" alt="image" aria-hidden="true"><img src="${PX}" alt="photo" style="display:none">`)).toEqual([]);
  });
});

describe('2.5.3: a field whose accessible name leaves out its visible label', () => {
  it('fails a labelled field whose aria-label or aria-labelledby gives it another name', async () => {
    expect(await failed(`<label for="q">Search the catalog</label> <input id="q" type="search" aria-label="Discovery query">
      <span id="other">Account lookup value</span><label for="n">Library card number</label> <input id="n" aria-labelledby="other">
      <label>Pickup branch <select id="s" aria-label="Location selector"><option>Main</option></select></label>`)).toEqual([['2.5.3', '#q'], ['2.5.3', '#n'], ['2.5.3', '#s']]);
  });

  it('a name that is shorter than the label leaves label words out: it fails too', async () => {
    expect(await failed(`<label for="b">Search the catalog</label> <input id="b" type="search" aria-label="Search">`)).toEqual([['2.5.3', '#b']]);
  });

  it('only the label text that is shown counts: hidden text inside the label is not part of it', async () => {
    expect(await findingsOf(`<label for="e">Email<span hidden>Internal routing code</span></label> <input id="e" aria-label="Email address for receipts">
      <label for="f">Phone<span style="display:none"> (office use: field 7)</span> <span class="vh">number for the front desk</span></label> <input id="f" aria-label="Phone">`)).toEqual([]);
  });

  it('the label\'s words must be in the name in order and together: words in order with others between them are undecided', async () => {
    expect(await findingsOf(`<label for="a">Search catalog</label> <input id="a" type="search" aria-label="Search the whole catalog">`))
      .toEqual([expect.objectContaining({ criterion: '2.5.3', status: 'not_testable', target: '#a' })]);
    // A long label may hold a hint that is no part of the label: a name without all of it is undecided, not failed.
    expect(await undecided(`<label for="p">Password <small>At least twelve characters, with a number and a symbol.</small></label> <input id="p" type="text" aria-label="Password">`)).toEqual([['2.5.3', '#p']]);
  });

  it('the same word written another way ("E-mail", "Email") is undecided, never failed', async () => {
    const f = await findingsOf(`<label for="m">E-mail</label> <input id="m" type="email" aria-label="Email address">
      <label for="z">Zip-code</label> <input id="z" aria-label="Zipcode of your home">`);
    expect(f.filter((x) => x.status === 'failed')).toEqual([]);
    expect(f.map((x) => [x.status, x.target])).toEqual([['not_testable', '#m'], ['not_testable', '#z']]);
  });

  it('a name that holds the label\'s own first words, where the rest of the label is in an element of its own (a hint), is undecided', async () => {
    expect(await failed(`<label for="p">Password <span>at least 8 characters</span></label> <input id="p" type="text" aria-label="Password">`)).toEqual([]);
    expect(await undecided(`<label for="p">Password <span>at least 8 characters</span></label> <input id="p" type="text" aria-label="Password">`)).toEqual([['2.5.3', '#p']]);
    // Look-alike that still fails: the name leaves out a word of the label's own first text.
    expect(await failed(`<label for="q">Home address <span>with the unit number</span></label> <input id="q" aria-label="Address line">`)).toEqual([['2.5.3', '#q']]);
  });

  it('label words moved off the screen or pushed out of their box are not shown, so they are no part of the label', async () => {
    expect(await findingsOf(`<label for="s">Search <span style="position:absolute;left:-9999px">the whole site and its documents</span></label> <input id="s" type="search" aria-label="Search">
      <label for="t">Phone <span style="display:inline-block;width:20px;height:20px;overflow:hidden;text-indent:-9999px;background:#ccc">Help about this field</span></label> <input id="t" aria-label="Phone">
      <label for="u">Fax <span style="font-size:0">number for the records office</span></label> <input id="u" aria-label="Fax">`)).toEqual([]);
  });

  it('look-alikes: a name that holds the label, markers and case, a label named with others, a hidden label, no visible label at all', async () => {
    expect(await findingsOf(`
      <label for="a">Email</label> <input id="a" type="email" aria-label="Email address for your receipt">
      <label for="c">Phone number *</label> <input id="c" aria-label="phone number"> <label for="d">ZIP code (required):</label> <input id="d" aria-label="Zip Code">
      <label for="e" id="le">Card number</label> <span id="hint">16 digits</span> <input id="e" aria-labelledby="le hint">
      <label for="f" class="vh">Keyword</label> <input id="f" aria-label="Search terms">
      <input id="g" aria-label="Search terms" placeholder="Keyword">
      <label for="h">Email</label> <input id="h" type="email">`)).toEqual([]);
  });
});

describe('review round 2, finding 5: a name the browser did not give is never taken from the page instead', () => {
  it('visible label "Email", a name of its own "Email address", and no answer from the accessibility tree: undecided, not silently passed', () => {
    const read = { problems: [], labels: [{ target: '#e', label: 'Email', words: 'email', own: 'Email address', simple: true, lead: 'email', what: 'field' }], truncated: false };
    const f = nameFindings(read, [undefined]);
    expect(f.map((x) => [x.criterion, x.status, x.target])).toEqual([['2.5.3', 'not_testable', '#e']]);
    expect(f[0]!.detail).toContain('gave no accessible name');
    // The same with no answers at all (the budget ran out before any was asked).
    expect(nameFindings(read).map((x) => x.status)).toEqual(['not_testable']);
    // Look-alike: with the browser's answer it is decided: a name that holds the label passes, one that does not fails.
    expect(nameFindings(read, ['Email address'])).toEqual([]);
    expect(nameFindings(read, ['Contact']).map((x) => x.status)).toEqual(['failed']);
  });
});

describe('the names test: asking the browser for names is bounded', () => {
  it('a browser that never answers costs the test its name budget once, not once a field: every field is then undecided, never failed', async () => {
    const labels = Array.from({ length: 40 }, (_, i) => ({ target: `#f${i}`, label: 'Search the catalog', words: 'search the catalog', own: 'Discovery query', simple: true, lead: 'search the catalog', what: 'field' }));
    const read = { problems: [], labels, truncated: false };
    let asked = 0;
    const silent = { page: { evaluate: async () => undefined }, cdp: async () => ({ send: () => { asked++; return new Promise(() => {}); } }) } as unknown as ProbeContext;
    const t0 = Date.now();
    const names = await labelNames(silent, read);
    expect(Date.now() - t0).toBeLessThan(NAMES_LIMITS.namesMs + 1_500);
    expect(names).toHaveLength(40);
    expect(names.every((n) => n === undefined)).toBe(true);
    expect(asked).toBeLessThan(40);
    const f = nameFindings(read, names);
    expect(f.filter((x) => x.status === 'failed')).toEqual([]);
    expect(f.every((x) => x.status === 'not_testable')).toBe(true);
  }, 30_000);
});

describe('the names probe', () => {
  it('is a core, every-page, render test for 1.1.1, 2.5.3 and 4.1.2 (controls with no role) that is listed and not scored', () => {
    expect(namesProbe).toMatchObject({ id: 'names', criteria: ['1.1.1', '2.5.3', '4.1.2'], kind: 'render', tier: 'core', everyPage: true, scored: false });
    expect(PROBES).toContain(namesProbe);
  });
});

// ---- Batch 18 (lane images): the lead's rulings 1 and 2 ---------------------------------------------------------

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

/** A page on a real address (https://pictures.test/news/), every file under it answered with a small picture. */
async function findingsAt(body: string): Promise<ProbeFinding[]> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    const html = `<!doctype html><html lang="en"><head><title>T</title><style>img{width:120px;height:80px} .vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)} .ic{display:inline-block;width:24px;height:24px}</style></head><body><main><h1>News</h1>${body}</main></body></html>`;
    await page.route('https://pictures.test/**', async (r) => {
      if (r.request().resourceType() === 'document') await r.fulfill({ contentType: 'text/html', body: html });
      else await r.fulfill({ contentType: 'image/png', body: Buffer.from(PNG) });
    });
    await page.goto('https://pictures.test/news/');
    const session = await page.context().newCDPSession(page);
    const ctx = { page, cdp: async () => session } as unknown as ProbeContext;
    const read = await page.evaluate(readNames, { ...NAMES_LIMITS, placeholders: [...PLACEHOLDER_ALTS], key: NAMES_KEY, controlKey: NAMES_CONTROL_KEY });
    return nameFindings(read, await labelNames(ctx, read), await pictureControlNames(ctx, read));
  } finally {
    await page.close();
  }
}
const failedAt = async (body: string): Promise<[string, string | undefined][]> => (await findingsAt(body)).filter((f) => f.status === 'failed').map((f) => [f.criterion, f.target]);

describe('1.1.1 F30 (batch 18, ruling 2): the alternative is the picture\'s own file name or address', () => {
  it('fails the file name with its extension, whatever its words, in any case, as written or decoded, and the address in full or as written', async () => {
    expect(await failedAt(`<img id="a" src="/assets/gate-map.svg" alt="gate-map.svg"><img id="b" src="/assets/Gate-Map.SVG" alt="gate-map.svg"><img id="c" src="/files/Fall%20Flyer.jpg" alt="Fall Flyer.jpg">
      <img id="d" src="/files/Fall%20Flyer.jpg" alt="Fall%20Flyer.jpg"><img id="e" src="/img/map.png?v=3" alt="map.png">`))
      .toEqual([['1.1.1', '#a'], ['1.1.1', '#b'], ['1.1.1', '#c'], ['1.1.1', '#d'], ['1.1.1', '#e']]);
    expect(await failedAt(`<img id="a" src="/assets/harvest-festival.jpg" alt="https://pictures.test/assets/harvest-festival.jpg"><img id="b" src="/assets/harvest-festival.jpg" alt="/assets/harvest-festival.jpg">
      <input id="c" type="image" src="/buttons/search-go.gif" alt="search-go.gif"><img id="d" src="/a/harvest.jpg" alt="Harvest" aria-label="harvest.jpg">
      <a href="/news/harvest"><img id="e" src="/a/harvest-night.webp" alt="harvest-night.webp"></a>`))
      .toEqual([['1.1.1', '#a'], ['1.1.1', '#b'], ['1.1.1', '#c'], ['1.1.1', '#d'], ['1.1.1', '#e']]);
  });

  it('look-alikes: a name that only resembles the file, another file\'s name, a link to the file itself, a download, a hidden picture', async () => {
    expect(await failedAt(`<img src="/assets/gate-map.svg" alt="gate-map"><img src="/assets/city-hall.jpg" alt="city-hall"><img src="/assets/gate-map.svg" alt="Gate map">
      <img src="/assets/harvest-festival.jpg" alt="Harvest festival.jpg"><img src="/assets/seal.png" alt="logo.png"><img src="/files/report" alt="report">
      <a href="/assets/flyer.jpg"><img src="/assets/flyer.jpg" alt="flyer.jpg"></a><a href="/x" download><img src="/assets/poster.png" alt="poster.png"></a>
      <img src="/assets/leaf.png" alt="leaf.png" aria-hidden="true"><img src="/assets/rule.png" alt="rule.png" role="presentation"><img src="${PX}" alt="drawing.png">`)).toEqual([]);
  });

  it('a camera\'s name that is also the file\'s own is reported once, as before', async () => {
    const f = await findingsAt(`<img id="a" src="/p/IMG_2041.JPG" alt="IMG_2041.JPG">`);
    expect(f.map((x) => [x.criterion, x.status, x.target])).toEqual([['1.1.1', 'failed', '#a']]);
    expect(f[0]!.detail).toMatch(/file name .* says nothing/);
  });
});

describe('1.1.1 (batch 18, ruling 1): a control whose only content is a picture with no text alternative, and no name', () => {
  it('fails a button or link holding only an svg with no name source, an img with no alt, or a CSS background or mask picture', async () => {
    expect(await failedAt(`<button id="a" type="button"><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6"/></svg></button>
      <a id="b" href="/x"><svg width="20" height="20" viewBox="0 0 20 20"><path d="M2 2h16v16H2z"/></svg></a>
      <a id="c" href="/y"><img src="/i/facebook.png"></a>
      <button id="d" type="button" class="ic" style="background:url(/i/search.png) center / 18px no-repeat"></button>
      <a id="e" href="/z" class="ic" style="background:#123;-webkit-mask:url(/i/cal.svg) center / contain no-repeat;mask:url(/i/cal.svg) center / contain no-repeat"></a>`))
      .toEqual([['1.1.1', '#a'], ['1.1.1', '#b'], ['1.1.1', '#c'], ['1.1.1', '#d'], ['1.1.1', '#e']]);
    expect(await failedAt(`<div id="a" role="button" tabindex="0"><span class="ic" style="background-image:url(/i/menu.png)"></span></div>
      <button id="b" type="button"><span><span><svg width="16" height="16" aria-hidden="true"><path d="M0 0h16v16H0z"/></svg></span></span></button>
      <svg style="display:none"><symbol id="ic-fb" viewBox="0 0 20 20"><path d="M0 0h20v20H0z"/></symbol></svg><a id="c" href="https://facebook.com/district"><svg width="20" height="20"><use href="#ic-fb"/></svg></a>
      <a id="d" href="/gallery"><picture><source srcset="/i/g.webp" type="image/webp"><img src="/i/g.png"></picture></a>`))
      .toEqual([['1.1.1', '#a'], ['1.1.1', '#b'], ['1.1.1', '#c'], ['1.1.1', '#d']]);
  });

  it('look-alikes: a name from aria-label, aria-labelledby, title or text; an svg title; an img alt (even ""); an icon font; nothing shown; no picture', async () => {
    expect(await failedAt(`<button type="button" aria-label="Search"><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6"/></svg></button>
      <span id="lb">Calendar</span><a href="/cal" aria-labelledby="lb"><svg width="16" height="16"><path d="M0 0h16v16H0z"/></svg></a>
      <a href="/print" title="Print this page"><img src="/i/print.png"></a>
      <button type="button"><svg width="16" height="16" aria-hidden="true"><path d="M0 0h16v16H0z"/></svg><span class="vh">Close</span></button>
      <a href="/contact"><svg width="16" height="16" aria-hidden="true"><path d="M0 0h16v16H0z"/></svg> Contact us</a>
      <button type="button"><svg width="16" height="16"><title>Open the menu</title><path d="M0 0h16v16H0z"/></svg></button>
      <a href="/news"><img src="/i/news.png" alt="News"></a><a href="/levy"><img src="/i/levy.png" alt=""></a>
      <style>.fa-phone::before{content:"\\f095";font-family:sans-serif}</style><a href="tel:5415550100"><i class="fa-phone"></i></a>
      <button type="button" style="display:none"><svg width="16" height="16"><path d="M0 0h16v16H0z"/></svg></button>
      <a href="/docs" style="display:inline-block;width:32px;height:32px;background:#0b4fb3"></a>
      <div aria-hidden="true"><a href="/x" tabindex="-1"><svg width="16" height="16"><path d="M0 0h16v16H0z"/></svg></a></div>
      <button type="button"><canvas width="16" height="16"></canvas></button>`)).toEqual([]);
  });

  it('a candidate the browser gave no name for is undecided, never failed', () => {
    const read = { problems: [], pictureControls: [{ target: '#a', what: 'button', pictures: 'svg' }], truncated: false };
    expect(nameFindings(read, [], [undefined]).map((x) => [x.criterion, x.status])).toEqual([['1.1.1', 'not_testable']]);
    expect(nameFindings(read, [], ['Search'])).toEqual([]);
    expect(nameFindings(read, [], ['']).map((x) => [x.criterion, x.status, x.target])).toEqual([['1.1.1', 'failed', '#a']]);
  });
});
