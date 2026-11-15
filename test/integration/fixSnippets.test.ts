// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Report v3 stage 2: the code changes in the copy library (copy/fixes.ts) really fix what they claim. Each
// axe rule's change is applied the way a developer would (the element's start tag replaced, a stylesheet
// rule added) to a page where axe fails that rule, in real Chromium: the rule must fail before and pass after.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeFor, type CodeFix, type FixInput } from '../../src/report/copy/fixes.js';
import { defaultAxeSource } from '../../src/scan.js';

let browser: Browser;
let axeSource: string;
beforeAll(async () => { browser = await chromium.launch(); axeSource = await defaultAxeSource(); }, 60_000);
afterAll(async () => { await browser?.close(); });

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
interface Page { html?: string; head?: string; body: string; css?: string }
const doc = (p: Page) => `<!doctype html>${p.html ?? '<html lang="en">'}<head><meta charset="utf-8"><title>Fix test</title>${p.head ?? ''}<style>body { font: 16px Arial; color: #111; background: #fff; } ${p.css ?? ''}</style></head><body><main><h1>Fix test</h1>${p.body}</main></body></html>`;

/** What axe says about `rule` on the page: it fails, passes, does not apply (nothing left for it to check) or needs review. */
async function outcome(html: string, rule: string): Promise<'fail' | 'pass' | 'inapplicable' | 'review'> {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    await page.addScriptTag({ content: axeSource });
    const r = await page.evaluate(async (id) => {
      const res = await (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: unknown[]; passes: unknown[]; incomplete: unknown[] }> } }).axe.run(document, { runOnly: { type: 'rule', values: [id] } });
      return { v: res.violations.length, p: res.passes.length, i: res.incomplete.length };
    }, rule);
    return r.v ? 'fail' : r.i ? 'review' : r.p ? 'pass' : 'inapplicable';
  } finally { await page.close(); }
}

/** The change applied: an HTML start tag replaced (or lines replaced), or a CSS rule added. */
function apply(page: Page, c: CodeFix): Page {
  if (c.language === 'css') return { ...page, css: `${page.css ?? ''}\n${c.after.join('\n')}` };
  const swap = (s: string | undefined) => s?.split(c.before.join('\n')).join(c.after.join('\n'));
  return { ...page, html: swap(page.html), head: swap(page.head), body: swap(page.body)! };
}

interface Case { rule: string; page: Page; input: FixInput; key?: string }
const CASES: Case[] = [
  { rule: 'image-alt', page: { body: `<img id="hero" src="${PNG}" width="48" height="24">` }, input: { html: `<img id="hero" src="${PNG}" width="48" height="24">` } },
  { rule: 'input-image-alt', page: { body: `<form><input type="image" src="${PNG}" width="20" height="20"></form>` }, input: { html: `<input type="image" src="${PNG}" width="20" height="20">` } },
  { rule: 'input-button-name', page: { body: '<form><input type="button" id="go"></form>' }, input: { html: '<input type="button" id="go">' } },
  { rule: 'area-alt', page: { body: `<img src="${PNG}" usemap="#m" alt="Map" width="20" height="20"><map name="m"><area shape="rect" coords="0,0,10,10" href="/a"></map>` }, input: { html: '<area shape="rect" coords="0,0,10,10" href="/a">' } },
  { rule: 'link-name', page: { body: '<p><a href="/documents" style="display:inline-block;width:32px;height:32px;background:#0b4fb3"></a></p>' }, input: { html: '<a href="/documents" style="display:inline-block;width:32px;height:32px;background:#0b4fb3"></a>' } },
  { rule: 'button-name', page: { body: '<button type="submit"><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6"></circle></svg></button>' }, input: { html: '<button type="submit"><svg width="16" height="16" aria-hidden="true">' } },
  { rule: 'frame-title', page: { body: '<iframe class="map" src="about:blank"></iframe>' }, input: { html: '<iframe class="map" src="about:blank"></iframe>' } },
  { rule: 'label', page: { body: '<form><input id="q" type="search"></form>' }, input: { html: '<input id="q" type="search">' } },
  { rule: 'label', page: { body: '<form><input type="text" name="q"></form>' }, input: { html: '<input type="text" name="q">' } },
  { rule: 'select-name', page: { body: '<form><select id="pick"><option>One</option></select></form>' }, input: { html: '<select id="pick">' } },
  { rule: 'aria-command-name', page: { body: '<div role="button" tabindex="0"></div>' }, input: { html: '<div role="button" tabindex="0">' } },
  { rule: 'aria-input-field-name', page: { body: '<div role="textbox" contenteditable="true"></div>' }, input: { html: '<div role="textbox" contenteditable="true">' } },
  { rule: 'aria-toggle-field-name', page: { body: '<div role="checkbox" aria-checked="false" tabindex="0"></div>' }, input: { html: '<div role="checkbox" aria-checked="false" tabindex="0">' } },
  { rule: 'aria-meter-name', page: { body: '<div role="meter" aria-valuenow="5" aria-valuemin="0" aria-valuemax="10"></div>' }, input: { html: '<div role="meter" aria-valuenow="5" aria-valuemin="0" aria-valuemax="10">' } },
  { rule: 'aria-progressbar-name', page: { body: '<div role="progressbar" aria-valuenow="5" aria-valuemin="0" aria-valuemax="10"></div>' }, input: { html: '<div role="progressbar" aria-valuenow="5" aria-valuemin="0" aria-valuemax="10">' } },
  { rule: 'aria-tooltip-name', page: { body: '<button aria-describedby="tip">Help</button><div role="tooltip" id="tip"></div>' }, input: { html: '<div role="tooltip" id="tip">' } },
  { rule: 'role-img-alt', page: { body: '<div role="img" style="width:20px;height:20px;background:#333"></div>' }, input: { html: '<div role="img" style="width:20px;height:20px;background:#333">' } },
  { rule: 'svg-img-alt', page: { body: '<svg role="img" width="20" height="20"><circle cx="10" cy="10" r="8"></circle></svg>' }, input: { html: '<svg role="img" width="20" height="20">' } },
  { rule: 'html-has-lang', page: { html: '<html class="no-js">', body: '<p>Text.</p>' }, input: { html: '<html class="no-js">' } },
  { rule: 'valid-lang', page: { body: '<p lang="spanish">Bienvenidos a la escuela.</p>' }, input: { html: '<p lang="spanish">Bienvenidos a la escuela.</p>' } },
  { rule: 'html-xml-lang-mismatch', page: { html: '<html lang="en" xml:lang="fr">', body: '<p>Text.</p>' }, input: { html: '<html lang="en" xml:lang="fr">' } },
  { rule: 'meta-viewport', page: { head: '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">', body: '<p>Text.</p>' }, input: { html: '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">' } },
  { rule: 'meta-refresh', page: { head: '<meta http-equiv="refresh" content="5;url=/next">', body: '<p>Text.</p>' }, input: { html: '<meta http-equiv="refresh" content="5;url=/next">' } },
  { rule: 'avoid-inline-spacing', page: { body: '<p style="letter-spacing:0.05em !important">Our office is open on school days.</p>' }, input: { html: '<p style="letter-spacing:0.05em !important">Our office is open on school days.</p>' } },
  { rule: 'scrollable-region-focusable', page: { body: `<div style="height:3em;overflow:auto">${'<p>Line of text that scrolls.</p>'.repeat(8)}</div>` }, input: { html: '<div style="height:3em;overflow:auto">' } },
  { rule: 'label-content-name-mismatch', page: { body: '<p><a href="/news" aria-label="Go">Read the latest news</a></p>' }, input: { html: '<a href="/news" aria-label="Go">Read the latest news</a>' } },
  { rule: 'marquee', page: { body: '<marquee>School closes early today</marquee>' }, input: { html: '<marquee>School closes early today</marquee>' } },
  { rule: 'color-contrast', page: { body: '<p id="faint">Upcoming events for families.</p>', css: '#faint { color: #aaaaaa; }' }, input: { target: '#faint', detail: 'Element has insufficient color contrast of 2.32 (foreground color: #aaaaaa, background color: #ffffff, font size: 12.0pt (16px), font weight: normal). Expected contrast ratio of 4.5:1' } },
  { rule: 'link-in-text-block', page: { body: '<p>Ask at the office or read <a href="/contact">the contact page</a> for details about parking.</p>', css: 'a { color: #2a2a2a; text-decoration: none; }' }, input: { html: '<a href="/contact">the contact page</a>' } },
  { rule: 'target-size', page: { body: ['News', 'Events', 'Photo'].map((n) => `<a href="/${n}" aria-label="${n} feed" style="display:inline-block;width:14px;height:14px;min-height:0;padding:0;margin-right:2px;background:#0b4fb3"></a>`).join('') }, input: { html: '<a href="/News" aria-label="News feed" style="display:inline-block;width:14px;height:14px;min-height:0;padding:0;margin-right:2px;background:#0b4fb3"></a>' } },
  { rule: 'list', page: { body: '<ul>\n  <div>…</div>\n  <li>…</li>\n</ul>' }, input: {} },
  { rule: 'td-has-header', page: { body: `<table><tr><td>Date</td><td>Event</td><td>Time</td></tr>${'<tr><td>April 9</td><td>Open house</td><td>5 pm</td></tr>'.repeat(3)}</table>` }, input: {} },
];

describe('code changes fix the axe rule they are for (real Chromium)', () => {
  it.each(CASES.map((c, i) => [`${c.rule} #${i}`, c] as const))('%s', async (_, c) => {
    const code = codeFor(c.key ?? `rule:${c.rule}`, c.input);
    expect(code).toBeDefined();
    const page = c.page;
    expect(await outcome(doc(page), c.rule), 'before').toBe('fail');
    // The same change on every copy of the element (as from one template), then axe again.
    let fixed = apply(page, code!);
    if (c.rule === 'target-size') for (const n of ['Events', 'Photo']) fixed = apply(fixed, codeFor('rule:target-size', { html: c.input.html!.replaceAll('News', n) })!);
    expect(fixed, 'the change applies to the page').not.toEqual(page);
    // Fixed: axe passes it, or (a change that removes what the rule looks at: the meta refresh, the marquee, the
    // mismatched aria-label) the rule has nothing left to check. Never a failure, never "needs review".
    expect(['pass', 'inapplicable'], 'after').toContain(await outcome(doc(fixed), c.rule));
  }, 30_000);
});

/** Runs `check` in the page after loading `html`. */
async function inPage<T>(html: string, check: () => T): Promise<T> {
  const page = await browser.newPage();
  try { await page.setContent(html); return await page.evaluate(check); } finally { await page.close(); }
}

describe('Sol review r1: the changes do what they say in a real page', () => {
  it('#2 captions: the track lands inside the existing video, after its source, and the source stays', async () => {
    const html = '<video controls><source src="/movie.webm"></video>';
    const code = codeFor('rule:video-caption', { html })!;
    const fixed = apply({ body: html }, code);
    const shape = await inPage(doc(fixed), () => {
      const v = document.querySelector('video')!;
      return { children: [...v.children].map((c) => c.localName), track: v.querySelector('track')?.getAttribute('kind') ?? null };
    });
    expect(shape).toEqual({ children: ['source', 'track'], track: 'captions' });
    const withSrc = '<video src="/media/welcome.webm" controls></video>';
    const s = apply({ body: withSrc }, codeFor('media:no-captions-track', { html: '<video src="/media/welcome.webm" controls>', asset: 'https://e.org/media/welcome.webm' })!);
    expect(await inPage(doc(s), () => [...document.querySelector('video')!.children].map((c) => c.localName))).toEqual(['track']);
  }, 30_000);

  it('#5 language: the page gets a lang (axe html-has-lang passes) without claiming English', async () => {
    const page: Page = { html: '<html>', body: '<p>Hola a todos.</p>' };
    const code = codeFor('rule:html-has-lang', { html: '<html>' })!;
    expect(code.after.join(' ')).not.toContain('lang="en"');
    expect(await outcome(doc(page), 'html-has-lang')).toBe('fail');
    expect(await outcome(doc(apply(page, code)), 'html-has-lang')).toBe('pass');
  }, 30_000);

  it('#8 state: the example matches what is on screen (open details, hidden panel)', async () => {
    const detail = 'The button “Menu” is open, but aria-expanded="false" tells screen readers it is not';
    const body = '<details open><summary aria-expanded="false">Menu</summary><p>Home, News</p></details>';
    const code = codeFor('probe:aria-states:4.1.2', { detail })!;
    const fixed = apply({ body }, code);
    expect(fixed.body).not.toBe(body);
    expect(await inPage(doc(fixed), () => ({ open: document.querySelector('details')!.open, state: document.querySelector('summary')!.getAttribute('aria-expanded') })))
      .toEqual({ open: true, state: null }); // the browser reports the open state itself
    const hidden = '<button type="button" aria-expanded="true">Allergy information</button><div hidden>Peanuts</div>';
    const fixed2 = apply({ body: hidden }, codeFor('probe:aria-states:4.1.2', { detail: 'The button “Allergy information” tells screen readers it is expanded, but what it opens is hidden' })!);
    expect(await inPage(doc(fixed2), () => document.querySelector('button')!.getAttribute('aria-expanded'))).toBe('false');
  }, 30_000);

  it('#9 target size: an inline link really becomes 24 by 24 pixels', async () => {
    const html = '<a href="/x" style="display:inline;width:14px;height:14px"></a>';
    const size = () => { const r = document.querySelector('main a')!.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
    const before = await inPage(doc({ body: `<p>${html}</p>` }), size);
    expect(before[0]).toBeLessThan(24);
    const fixed = apply({ body: `<p>${html}</p>` }, codeFor('rule:target-size', { html })!);
    const after = await inPage(doc(fixed), size);
    expect(after[0]).toBeGreaterThanOrEqual(24);
    expect(after[1]).toBeGreaterThanOrEqual(24);
  }, 30_000);
});

describe('Sol review r2: the changes do what they say in a real page', () => {
  it('#1 captions: a source inside an HTML comment is not a source; the track lands after the real one', async () => {
    const html = '<video controls><source src="/movie.webm"><!-- <source src="/old.webm"> --></video>';
    const code = codeFor('rule:video-caption', { html });
    // Either no code at all, or a change whose track is a real element of the video, after its real source.
    if (code) {
      const fixed = apply({ body: html }, code);
      expect(fixed.body).not.toBe(html);
      expect(await inPage(doc(fixed), () => [...document.querySelector('video')!.children].map((c) => c.localName))).toEqual(['source', 'track']);
    }
  }, 30_000);

  it('#2 captions: the captions file is named from the video’s pathname, never added to its query', async () => {
    const html = '<video controls><source src="/movie.webm?version=2"></video>';
    const code = codeFor('rule:video-caption', { html })!;
    const fixed = apply({ body: html }, code);
    const src = await inPage(doc(fixed), () => document.querySelector('video track')?.getAttribute('src') ?? null);
    expect(src).not.toBeNull();
    expect(src).not.toContain('?');
    expect(src).not.toMatch(/\.webm/);
    expect(src).toMatch(/^\/movie\.vtt$|\[captions file\]\.vtt/);
    const own = codeFor('rule:video-caption', { html: '<video src="/movie.webm?version=2" controls>' })!;
    expect(own.after.join('\n')).not.toMatch(/\?version=2\.vtt|webm\?[^"]*\.vtt/);
  }, 30_000);

  it('#3 target size: a display:inline!important the stylesheet repeats keeps its priority, so the box really grows', async () => {
    const html = '<a href="/x" style="display:inline!important;width:14px;height:14px"></a>';
    const css = 'main a { display: inline !important; }';
    const size = () => { const r = document.querySelector('main a')!.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
    const fixed = apply({ body: `<p>${html}</p>`, css }, codeFor('rule:target-size', { html })!);
    expect(fixed.body).toContain('inline-block!important');
    const after = await inPage(doc(fixed), size);
    expect(after[0]).toBeGreaterThanOrEqual(24);
    expect(after[1]).toBeGreaterThanOrEqual(24);
  }, 30_000);
});
