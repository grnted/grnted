// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The picture test in real Chromium (src/probes/pictures.ts): the words an SVG picture draws are read from the file
// and shown to be drawn, a block of text is failed for 1.4.5, and words the page gives nowhere for 1.1.1. Every page
// and picture here is written for this test and served by a server of its own on this machine; any other address
// is answered by the test, so nothing leaves it. The cases marked S1 to S9 are the review's (Sol r1).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drawnOf } from '../../src/probes/pictureJudge.js';
import { measureSvgPictures, PICTURE_LIMITS, readPictures } from '../../src/probes/pictureText.js';
import { decodedCopy, picturesProbe } from '../../src/probes/pictures.js';
import { watchPictureFiles } from '../../src/probes/pictureFiles.js';
import { PROBES, SCORED_PROBES } from '../../src/probes/registry.js';
import type { ProbeContext, ProbeFinding } from '../../src/probes/types.js';

interface Site { html: string; files?: Record<string, { body: string; type?: string; headers?: Record<string, string> }>; headers?: Record<string, string> }
let browser: Browser;
let server: Server;
let ORIGIN = '';
/** The site the server answers with now (tests in a file run one after the other). */
let site: Site = { html: '' };
/** Every address the browser asked for, and the paths that reached the server. */
const asked: string[] = [];
const served: string[] = [];
beforeAll(async () => {
  browser = await chromium.launch();
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    served.push(path);
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...(site.headers ?? {}) }).end(`<!doctype html><html lang="en"><head><title>Pictures</title></head><body><main><h1>Family information</h1>${site.html}</main></body></html>`);
      return;
    }
    const f = site.files?.[path];
    if (!f) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': f.type ?? 'image/svg+xml', 'cache-control': 'max-age=600', ...(f.headers ?? {}) }).end(f.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);
afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
});

const svg = (w: number, h: number, inner: string, more = '') => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${more}>${inner}</svg>`;
const FONT = 'font-family="Arial, Helvetica, sans-serif" fill="#1a1a1a"';
/** A notice: four lines of words on a plain card. */
const NOTICE = svg(640, 220, `<rect width="640" height="220" fill="#f4efe2"/><rect x="12" y="12" width="616" height="196" fill="none" stroke="#2f4f3a" stroke-width="3"/>
  <g ${FONT}><text x="36" y="60" font-size="28" font-weight="700">Family packet pickup</text><text x="36" y="104" font-size="22">Friday, November 13 · 1–3 p.m.</text>
  <text x="36" y="142" font-size="22">Alder Draw office, room 4</text><text x="36" y="180" font-size="22">Use the west garden gate.</text></g>`);
const NOTICE_ALT = 'Family packet pickup: Friday, November 13, 1 to 3 p.m., Alder Draw office, room 4. Use the west garden gate.';
/** A map: a drawing with labels and one instruction. */
const MAP = svg(640, 240, `<rect width="640" height="240" fill="#eff3e9"/><rect x="52" y="52" width="525" height="140" fill="#d4e1d2" stroke="#305f53" stroke-width="3"/>
  <path d="M5 150 H300 V125 H425" fill="none" stroke="#175a53" stroke-width="6"/><rect x="431" y="129" width="97" height="52" fill="#edce82" stroke="#305f53" stroke-width="2"/>
  <g ${FONT}><text x="68" y="84" font-size="16" font-weight="700">WEST ENTRANCE</text><text x="446" y="160" font-size="16" font-weight="700">HOLDS</text>
  <text x="76" y="221" font-size="17">Enter west door. Turn right at the desk to reach the hold shelf.</text></g>`);
/** A bar chart: bars, an axis and short labels. */
const CHART = svg(720, 380, `<rect width="720" height="380" fill="#fff"/><g fill="#2c6e8f"><rect x="120" y="200" width="90" height="120"/><rect x="300" y="150" width="90" height="170"/><rect x="480" y="90" width="90" height="230"/></g>
  <path d="M80 320 H640" stroke="#333" stroke-width="2"/><g ${FONT} font-size="16"><text x="360" y="40" text-anchor="middle">Breakfast participation, fall 2026</text><text x="165" y="345" text-anchor="middle">September</text>
  <text x="345" y="345" text-anchor="middle">October</text><text x="525" y="345" text-anchor="middle">November</text><text x="165" y="190" text-anchor="middle">900</text><text x="345" y="140" text-anchor="middle">1,100</text><text x="525" y="80" text-anchor="middle">1,300</text></g>`);
/** A wordmark: a name in a few words. */
const WORDMARK = svg(320, 80, `<rect width="320" height="80" fill="#12395b"/><text x="20" y="50" font-family="Georgia, serif" font-size="28" fill="#fff">Birch Valley Water</text>`);

/**
 * A page of this test's server. As in a scan, every request is watched (which turns the browser's HTTP cache off,
 * as there): this server is reached, any other address is answered here with "not found".
 */
async function open(s: Site): Promise<Page> {
  site = s;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    asked.push(url);
    if (url.startsWith(ORIGIN)) await route.continue(); else await route.fulfill({ status: 404, body: 'not found' });
  });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  return page;
}

/** The probe's context on a page: with the browser's debugging session (as in a scan) unless told otherwise. */
async function contextOf(page: Page, withCdp = true): Promise<ProbeContext> {
  const session = withCdp ? await page.context().newCDPSession(page) : undefined;
  return { page, url: page.url(), pageIndex: 0, viewport: { width: 1280, height: 900 }, signal: new AbortController().signal, deadline: Date.now() + 15_000, cdp: async () => session } as unknown as ProbeContext;
}

async function findingsOf(s: Site, withCdp = true): Promise<ProbeFinding[]> {
  const page = await open(s);
  try {
    return await picturesProbe.run(await contextOf(page, withCdp));
  } finally {
    await page.context().close();
  }
}
const failed = async (s: Site): Promise<[string, string | undefined][]> => (await findingsOf(s)).filter((f) => f.status === 'flagged').map((f) => [f.criterion, f.target]);
const statuses = async (s: Site, withCdp = true): Promise<[string, string][]> => (await findingsOf(s, withCdp)).map((f) => [f.criterion, f.status]);
const one = (file: string, body: string, attrs = '') => ({ html: `<img id="pic" src="${file}" ${attrs}>`, files: { [file]: { body } } });
const MEASURING: { fileBytes: number; texts: number; words: number; minSide: number; maxSide: number; budgetMs: number; drawMs: number } = { fileBytes: PICTURE_LIMITS.fileBytes, texts: PICTURE_LIMITS.texts, words: PICTURE_LIMITS.words, minSide: PICTURE_LIMITS.minSide, maxSide: PICTURE_LIMITS.maxSide, budgetMs: PICTURE_LIMITS.budgetMs, drawMs: PICTURE_LIMITS.drawMs };
const READING = { pictures: PICTURE_LIMITS.pictures, elements: PICTURE_LIMITS.elements, blocks: PICTURE_LIMITS.blocks, blockChars: PICTURE_LIMITS.blockChars, pageChars: PICTURE_LIMITS.pageChars, sourceChars: PICTURE_LIMITS.sourceChars };

async function measureOf(source: string, limits: Partial<typeof MEASURING> = {}) {
  const page = await open({ html: '<p>Nothing here.</p>' });
  try {
    const [got] = await page.evaluate(measureSvgPictures, { files: [{ src: 'memory:', source }], limits: { ...MEASURING, ...limits } });
    return got!;
  } finally {
    await page.context().close();
  }
}

describe('the picture test is registered as a listed, every-page test', () => {
  it('runs on every page, reads only, and is not scored', () => {
    expect(PROBES.find((p) => p.id === 'picture-text')).toMatchObject({ criteria: ['1.1.1', '1.4.5'], everyPage: true, scored: false, tier: 'core', kind: 'render', onlyNavigationVoids: true });
    expect(SCORED_PROBES.has('picture-text')).toBe(false);
  });
});

describe('measuring what an SVG file draws', () => {
  it('reads each text element and the ink of its words; the ground under them holds all of it', async () => {
    const m = (await measureOf(NOTICE)).measure!;
    expect(m.texts.map((t) => t.text)).toEqual(['Family packet pickup', 'Friday, November 13 · 1–3 p.m.', 'Alder Draw office, room 4', 'Use the west garden gate.']);
    for (const t of m.texts) { expect(t.ink, t.text).toBeGreaterThan(300); expect(t.bands, t.text).toHaveLength(1); }
    expect(m.natural).toEqual([640, 220]);
    expect(m.regions[0]!.text).toBe(m.textInk);
    expect(drawnOf(m)).toMatchObject({ block: true, aligned: 'left', words: 18 });
  });

  it('a text element that is not drawn has no ink: hidden, clear, the ground’s colour, off the canvas, covered, in unused defs', async () => {
    const hidden = [
      '<text x="36" y="60" font-size="24" display="none">Meet at the north gate</text>',
      '<text x="36" y="60" font-size="24" visibility="hidden">Meet at the north gate</text>',
      '<text x="36" y="60" font-size="24" opacity="0">Meet at the north gate</text>',
      '<text x="36" y="60" font-size="24" fill="#f4efe2">Meet at the north gate</text>',
      '<text x="36" y="60" font-size="24" fill="#f3eee1">Meet at the north gate</text>',
      '<text x="900" y="60" font-size="24">Meet at the north gate</text>',
      '<text x="36" y="60" font-size="0">Meet at the north gate</text>',
      '<defs><text id="t" x="36" y="60" font-size="24">Meet at the north gate</text></defs>',
      '<text x="36" y="60" font-size="24">Meet at the north gate</text><rect x="20" y="30" width="400" height="50" fill="#f4efe2"/>',
      '<clipPath id="c"><rect x="0" y="100" width="10" height="10"/></clipPath><text x="36" y="60" font-size="24" clip-path="url(#c)">Meet at the north gate</text>',
    ];
    for (const h of hidden) {
      const m = (await measureOf(svg(640, 220, `<rect width="640" height="220" fill="#f4efe2"/>${h}<text x="36" y="180" font-size="20" fill="#1a1a1a">Lodge</text>`))).measure!;
      const d = drawnOf(m);
      expect(d.lines.map((l) => l.text), h).toEqual(['Lodge']);
      expect(d.hiddenWords, h).toBe(5);
    }
    // The same words in defs, drawn through a use element, are drawn.
    const used = (await measureOf(svg(640, 220, '<rect width="640" height="220" fill="#f4efe2"/><defs><text id="t" x="36" y="60" font-size="24">Meet at the north gate</text></defs><use href="#t"/>'))).measure!;
    expect(drawnOf(used).lines.map((l) => l.text)).toEqual(['Meet at the north gate']);
  });

  it('a file with no text element, one that is not SVG, and one that declares entities are not measured', async () => {
    expect((await measureOf(svg(24, 24, '<circle cx="12" cy="12" r="10"/>'))).measure).toMatchObject({ texts: [], textInk: 0 });
    expect(await measureOf('<html><body><text>Not a picture</text></body></html>')).toMatchObject({ error: 'not-svg' });
    expect(await measureOf(`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>${svg(100, 40, '<text x="2" y="20">&b;</text>')}`)).toMatchObject({ error: 'unsafe', hasText: true });
    // A plain doctype (what drawing programs write) declares nothing: the file is measured.
    const plain = await measureOf(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">${NOTICE}`);
    expect(plain.measure?.texts).toHaveLength(4);
  });

  it('draws nothing but the file: its script never runs and its outside image, style and font are never asked for', async () => {
    const before = asked.length;
    const file = (image: string) => svg(640, 220, `<script>fetch('http://site.test/ran-script')</script><style>@import url("http://site.test/import.css"); text { font-family: x; } @font-face { font-family: x; src: url("http://site.test/font.woff2"); }</style>
      ${image}<rect width="640" height="220" fill="#fff" onload="fetch('http://site.test/ran-onload')"/><text x="20" y="60" font-size="24">Closed Saturday, December 5 all day</text>`);
    const m = await measureOf(file(''));
    expect(m.measure?.texts[0]?.ink).toBeGreaterThan(300);
    // A file with words and an embedded or linked picture is not decoded at all (cut round, S7).
    expect(await measureOf(file('<image href="http://site.test/outside.png" width="50" height="50"/>'))).toMatchObject({ error: 'heavy', hasText: true });
    expect(asked.slice(before).filter((u) => /ran-|import\.css|font\.woff2|outside\.png/.test(u))).toEqual([]);
  });

  it('more text elements than are measured one by one: listed, not measured each, never a block', async () => {
    const many = Array.from({ length: 45 }, (_, i) => `<text x="${20 + (i % 5) * 120}" y="${20 + Math.floor(i / 5) * 22}" font-size="12">Stop ${i + 1}</text>`).join('');
    const m = (await measureOf(svg(640, 220, `<rect width="640" height="220" fill="#fff"/>${many}`))).measure!;
    expect(m.texts).toHaveLength(45);
    expect(m.texts.every((t) => t.ink === -1)).toBe(true);
    expect(drawnOf(m).block).toBe(false);
  });

  // S2: some ink of a text element does not show that all its words are there.
  it('S2: each word is shown by itself: a part of a text element kept out of sight, moved off the canvas, covered or drawn at no size is not among its words', async () => {
    const parts = [
      '<text x="36" y="70" font-size="26">Open<tspan display="none"> Meet at the north entrance by nine.</tspan></text>',
      '<text x="36" y="70" font-size="26">Open<tspan visibility="hidden"> Meet at the north entrance by nine.</tspan></text>',
      '<text x="36" y="70" font-size="26">Open<tspan fill-opacity="0"> Meet at the north entrance by nine.</tspan></text>',
      '<text x="36" y="70" font-size="26">Open<tspan font-size="0"> Meet at the north entrance by nine.</tspan></text>',
      '<text x="36" y="70" font-size="26">Open<tspan x="2000"> Meet at the north entrance by nine.</tspan></text>',
      '<text x="36" y="70" font-size="26">Open<tspan fill="#f4efe2"> Meet at the north entrance by nine.</tspan></text>',
      '<text x="36" y="70" font-size="26">Open<tspan> Meet at the north entrance by nine.</tspan></text><rect x="103" y="40" width="530" height="44" fill="#f4efe2"/>',
    ];
    for (const part of parts) {
      const m = (await measureOf(svg(640, 120, `<rect width="640" height="120" fill="#f4efe2"/><g ${FONT}>${part}</g>`))).measure!;
      expect(m.texts.map((t) => [t.text, t.unseen]), part).toEqual([['Open', 7]]);
      expect(drawnOf(m), part).toMatchObject({ words: 1, hiddenWords: 7, block: false });
    }
    // The same words all shown: seven more words, and a block of text.
    const whole = (await measureOf(svg(640, 120, `<rect width="640" height="120" fill="#f4efe2"/><g ${FONT}><text x="36" y="70" font-size="26">Open<tspan> Meet at the north entrance by nine.</tspan></text></g>`))).measure!;
    expect(whole.texts.map((t) => [t.text, t.unseen])).toEqual([['Open Meet at the north entrance by nine.', 0]]);
    expect(whole.seen).toBeGreaterThan(0.99);
    expect(drawnOf(whole)).toMatchObject({ words: 8, hiddenWords: 0, block: true });
  });

  it('S2: a shape over part of a word, or a clip path that cuts through the words, leaves less than all of their glyphs showing', async () => {
    // A ground-coloured band over the lower half of the second line: every word of it still has ink, none shows whole.
    const over = (await measureOf(NOTICE.replace('</g></svg>', '</g><rect x="20" y="97" width="600" height="14" fill="#f4efe2"/></svg>'))).measure!;
    expect(over.texts.map((t) => t.unseen)).toEqual([0, 0, 0, 0]);
    expect(over.seen).toBeGreaterThan(0);
    expect(over.seen).toBeLessThan(0.98);
    const cut = (await measureOf(svg(640, 220, `<rect width="640" height="220" fill="#f4efe2"/><clipPath id="c"><rect x="0" y="0" width="640" height="131"/></clipPath><g ${FONT} clip-path="url(#c)">
      <text x="36" y="60" font-size="28">Family packet pickup</text><text x="36" y="104" font-size="22">Friday, November 13 · 1–3 p.m.</text><text x="36" y="142" font-size="22">Alder Draw office, room 4</text></g>`))).measure!;
    expect(cut.seen).toBeLessThan(0.98);
    // Look-alikes: all the words showing, and words with a halo around them (the letters show whole).
    expect((await measureOf(NOTICE)).measure!.seen).toBeGreaterThan(0.99);
    const halo = (await measureOf(svg(640, 100, '<rect width="640" height="100" fill="#eef3f0"/><text x="25" y="59" fill="#203b40" paint-order="stroke" stroke="#fff" stroke-width="6" font-family="Arial,sans-serif" font-size="24">Keep your permit card visible from the street.</text>'))).measure!;
    expect(halo.seen).toBeGreaterThan(0.99);
    expect(drawnOf(halo).block).toBe(true);
  });

  it('S2: words that run past the edge of the file’s own drawing are not shown whole (red: the glyphs drawn alone were cut at the same edge)', async () => {
    // The line is longer than the picture is wide: its last words are cut off at the right edge, in the file and on the page.
    const past = (await measureOf(svg(640, 120, `<rect width="640" height="120" fill="#f4efe2"/><text x="36" y="70" font-size="26" ${FONT}>Meet at the north entrance of the old county courthouse by nine.</text>`))).measure!;
    expect(past.seen).toBe(0);
    const above = (await measureOf(svg(640, 120, `<rect width="640" height="120" fill="#f4efe2"/><text x="36" y="10" font-size="26" ${FONT}>Meet at the north gate by nine.</text>`))).measure!;
    expect(above.seen).toBe(0);
    // Look-alike: the same words inside the picture, a margin away from its edges.
    const inside = (await measureOf(svg(900, 120, `<rect width="900" height="120" fill="#f4efe2"/><text x="36" y="70" font-size="26" ${FONT}>Meet at the north entrance of the old county courthouse by nine.</text>`))).measure!;
    expect(inside.seen).toBeGreaterThan(0.99);
  });

  // S6: what is measured must be what the page shows.
  it('S6: a file that changes by itself, draws HTML or lays itself out by the size it is shown at is not measured', async () => {
    const text = `<text x="36" y="60" font-size="24" ${FONT}>Family packet pickup on Friday at one</text>`;
    const ground = '<rect width="640" height="120" fill="#f4efe2"/>';
    for (const inner of [
      `${ground}<g><set attributeName="opacity" to="0" begin="0s"/>${text}</g>`,
      `${ground}<g><animate attributeName="opacity" from="1" to="0" dur="1s" fill="freeze"/>${text}</g>`,
      `${ground}<g><animateTransform attributeName="transform" type="translate" from="0 0" to="900 0" dur="1s" fill="freeze"/>${text}</g>`,
      `${ground}${text}<foreignObject x="0" y="0" width="640" height="120"><div xmlns="http://www.w3.org/1999/xhtml" style="background:#f4efe2;height:120px"></div></foreignObject>`,
      `<style>@media (max-width: 400px) { text { display: none } }</style>${ground}${text}`,
      `<style>text { animation: gone 1s forwards } @keyframes gone { to { opacity: 0 } }</style>${ground}${text}`,
      `${ground}<g style="transition: opacity 1s">${text}</g>`,
    ]) {
      expect(await measureOf(svg(640, 120, inner)), inner).toEqual({ src: 'memory:', error: 'unsupported', hasText: true });
    }
    // No viewBox and no size of its own: what shows depends on the size it is given.
    expect(await measureOf(`<svg xmlns="http://www.w3.org/2000/svg">${ground}${text}</svg>`)).toMatchObject({ error: 'unsupported' });
    // Look-alikes: a script (it never runs in a picture and draws nothing) and an outside style sheet's import are measured.
    expect((await measureOf(svg(640, 120, `<script>document.title = 'x'</script>${ground}${text}`))).measure?.texts).toHaveLength(1);
  });

  it('S6: the review’s hidden notice, confirmed: the browser shows nothing of it as a picture, and the test says "not testable", never a failure', async () => {
    const hidden = NOTICE.replace(`<g ${FONT}>`, `<g ${FONT}><set attributeName="opacity" to="0" begin="0s"/>`);
    const site = { html: `<img id="pic" src="/hidden.svg" alt="" width="640" height="220"><img id="shown" src="/notice.svg" alt="${NOTICE_ALT}" width="640" height="220">`, files: { '/hidden.svg': { body: hidden }, '/notice.svg': { body: NOTICE } } };
    const page = await open(site);
    try {
      // Dark pixels of each picture as the browser draws it: the words of the plain notice, none of the hidden one.
      const dark = await page.evaluate(() => ['pic', 'shown'].map((id) => {
        const c = document.createElement('canvas');
        c.width = 640; c.height = 220;
        const g = c.getContext('2d')!;
        g.drawImage(document.getElementById(id) as HTMLImageElement, 0, 0, 640, 220);
        const d = g.getImageData(40, 40, 560, 150).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i]! < 90 && d[i + 1]! < 90 && d[i + 2]! < 90) n++;
        return n;
      }));
      expect(dark[0]).toBe(0);
      expect(dark[1]).toBeGreaterThan(1000);
      const got = await picturesProbe.run(await contextOf(page));
      expect(got.map((f) => [f.criterion, f.status, f.target])).toEqual([['1.1.1', 'not_testable', '#pic'], ['1.4.5', 'flagged', '#shown']]);
    } finally {
      await page.context().close();
    }
  });

  // S9: a measurement that was not finished is said, never passed over.
  it('S9: more words than are measured one by one, and a text element too long to be a line: not measured', async () => {
    const long = Array.from({ length: 30 }, (_, i) => `<text x="20" y="${20 + i * 7}" font-size="6">one two three four five six ${i}</text>`).join('');
    const m = (await measureOf(svg(640, 220, `<rect width="640" height="220" fill="#fff"/>${long}`), { words: 60 })).measure!;
    expect(m.texts.every((t) => t.ink === -1)).toBe(true);
    expect(await measureOf(svg(640, 220, `<rect width="640" height="220" fill="#fff"/><text x="20" y="60" font-size="12">${'word '.repeat(500)}</text>`))).toMatchObject({ error: 'too-large', hasText: true });
  });

  it('what the file says of its size: a size of its own, a shape only, or units that are not converted', async () => {
    const t = '<text x="10" y="40" font-size="20">Closed Saturday all day long</text>';
    const of = async (root: string) => { const m = (await measureOf(`<svg xmlns="http://www.w3.org/2000/svg" ${root}>${t}</svg>`)).measure!; return [m.intrinsic, m.natural, m.aspect]; };
    expect(await of('width="640" height="120" viewBox="0 0 640 120"')).toEqual(['size', [640, 120], '']);
    expect(await of('viewBox="0 0 640 120"')).toEqual(['ratio', [640, 120], '']);
    expect(await of('width="100%" height="100%" viewBox="0 0 640 120" preserveAspectRatio="xMidYMid slice"')).toEqual(['ratio', [640, 120], 'xMidYMid slice']);
    expect(await of('width="320" viewBox="0 0 640 120"')).toEqual(['size', [320, 60], '']);
    expect(await of('width="40em" height="8em" viewBox="0 0 640 120"')).toEqual(['unknown', [640, 120], '']);
    expect(await of('width="640" height="120"')).toEqual(['size', [640, 120], 'none']);
  });
});

describe('1.4.5: a picture that is a block of text and nothing else', () => {
  it('fails a notice drawn as an SVG picture, whatever its alt text says', async () => {
    expect(await failed(one('/notice.svg', NOTICE, `alt="${NOTICE_ALT}" width="640" height="220"`))).toEqual([['1.4.5', '#pic']]);
    const f = (await findingsOf(one('/notice.svg', NOTICE, `alt="${NOTICE_ALT}" width="640" height="220"`))).find((x) => x.criterion === '1.4.5')!;
    expect(f.detail).toContain('draws 4 lines of words on a plain ground');
    expect(f.detail).toContain('“Family packet pickup · Friday, November 13 · 1–3 p.m. · Alder Draw office, room 4 · Use the west garden gate.”');
  });

  it('reads the file from a data: address (base64 and plain), a picture element and an image button', async () => {
    const b64 = `data:image/svg+xml;base64,${Buffer.from(NOTICE).toString('base64')}`;
    expect(await failed({ html: `<img id="pic" alt="${NOTICE_ALT}" src="${b64}">` })).toEqual([['1.4.5', '#pic']]);
    expect(await failed({ html: `<img id="pic" alt="${NOTICE_ALT}" src="data:image/svg+xml;utf8,${encodeURIComponent(NOTICE)}">` })).toEqual([['1.4.5', '#pic']]);
    expect(await failed({ html: `<picture><source srcset="/notice.svg" type="image/svg+xml"><img id="pic" alt="${NOTICE_ALT}" src="/fallback.png"></picture>`, files: { '/notice.svg': { body: NOTICE } } })).toEqual([['1.4.5', '#pic']]);
    expect(await failed({ html: `<form action="/go"><input id="pic" type="image" alt="${NOTICE_ALT}" src="/notice.svg"></form>`, files: { '/notice.svg': { body: NOTICE } } })).toEqual([['1.4.5', '#pic']]);
  });

  it('look-alikes that stay clean: a map, a chart, a wordmark, a short banner, real text in an inline SVG, a logo by its place', async () => {
    expect(await failed(one('/map.svg', MAP, 'alt="Pickup map: enter by the west door and turn right at the desk to reach the hold shelf. West entrance, holds." width="640" height="240"'))).toEqual([]);
    expect(await failed(one('/chart.svg', CHART, 'alt="Bar chart: breakfast participation rose from 900 in September to 1,100 in October and 1,300 in November, fall 2026." width="720" height="380"'))).toEqual([]);
    expect(await failed(one('/mark.svg', WORDMARK, 'alt="Birch Valley Water" width="320" height="80"'))).toEqual([]);
    expect(await failed(one('/banner.svg', svg(640, 120, '<rect width="640" height="120" fill="#123"/><text x="30" y="70" font-size="34" fill="#fff">County meeting notice</text>'), 'alt="County meeting notice" width="640" height="120"'))).toEqual([]);
    expect(await statuses({ html: `<svg role="img" aria-label="Notice" width="640" height="220" viewBox="0 0 640 220"><text x="20" y="60" font-size="24">Closed Saturday, December 5 all day</text></svg>` }))
      .toEqual([['1.1.1', 'not_applicable'], ['1.4.5', 'not_applicable']]);
    // A name with a tag line in the page header's home link: a logo, whatever its words.
    const tagline = svg(480, 90, '<rect width="480" height="90" fill="#12395b"/><text x="20" y="40" font-size="26" fill="#fff">Birch Valley Water District</text><text x="20" y="70" font-size="16" fill="#fff">Clean water for the valley since 1952</text>');
    expect(await failed({ html: `<header><a href="/"><img id="pic" src="/logo.svg" alt="Birch Valley Water District" width="480" height="90"></a></header>`, files: { '/logo.svg': { body: tagline } } })).toEqual([]);
    expect(await failed({ html: `<img id="pic" class="site-logo" src="/mark.svg" alt="Birch Valley Water District" width="480" height="90">`, files: { '/mark.svg': { body: tagline } } })).toEqual([]);
  });

  it('a logo is told by its place, its class, its file name or the word "logo" in its alt text, never by a word of the notice', async () => {
    // "badge" and "seal" are ordinary words in a notice and its alt text, and a data: address has no file name.
    const badge = NOTICE.replace('Use the west garden gate.', 'Show your district badge and seal.');
    const alt = 'Family packet pickup: Friday, November 13, 1 to 3 p.m., Alder Draw office, room 4. Show your district badge and seal.';
    expect(await failed(one('/notice.svg', badge, `alt="${alt}" width="640" height="220"`))).toEqual([['1.4.5', '#pic']]);
    expect(await failed({ html: `<img id="pic" alt="${alt}" src="data:image/svg+xml;utf8,${encodeURIComponent(badge)}">` })).toEqual([['1.4.5', '#pic']]);
    expect(await failed(one('/district-seal.svg', badge, `alt="${alt}" width="640" height="220"`))).toEqual([]);
  });

  it('a picture said to show how something looks (a sample, a specimen) is never judged: said by its alt text, its caption, or the heading it comes right under', async () => {
    // Three lines of a typeface, as a block of text: its look is the point (1.4.5's "essential").
    const specimen = svg(640, 220, `<rect width="640" height="220" fill="#f4efe2"/><g ${FONT}><text x="36" y="60" font-size="28">Aa Bb Cc Dd Ee Ff Gg Hh Ii Jj</text>
      <text x="36" y="110" font-size="22">The quick brown fox jumps over the lazy dog.</text><text x="36" y="160" font-size="22">0 1 2 3 4 5 6 7 8 9 and a full stop.</text></g>`);
    const letters = 'Aa Bb Cc Dd Ee Ff Gg Hh Ii Jj. The quick brown fox jumps over the lazy dog. 0 1 2 3 4 5 6 7 8 9 and a full stop.';
    const img = `<img id="pic" src="/letters.svg" alt="${letters}" width="640" height="220">`;
    const files = { '/letters.svg': { body: specimen } };
    // Nothing says it is a sample: an image of text.
    expect(await failed({ html: `<h2>Signs in our buildings</h2>${img}`, files })).toEqual([['1.4.5', '#pic']]);
    // The alt text, the figure's caption, the name it is labelled by, or the heading right before it says so.
    expect(await failed({ html: `<img id="pic" src="/letters.svg" alt="Specimen of the district typeface: ${letters}" width="640" height="220">`, files })).toEqual([]);
    expect(await failed({ html: `<figure>${img}<figcaption>A sample of the lettering on our signs</figcaption></figure>`, files })).toEqual([]);
    expect(await failed({ html: `<p id="cap">Typeface sample</p><div><img id="pic" src="/letters.svg" alt="${letters}" aria-labelledby="cap" width="640" height="220"></div><p>More.</p>`, files })).toEqual([]);
    expect(await failed({ html: `<h2>Typeface sample</h2>${img}`, files })).toEqual([]);
    expect(await failed({ html: `<h2>Typeface sample</h2><p>Our signs use one family of letters.</p><p>${img}</p>`, files })).toEqual([]);
    expect(await failed({ html: `<h2>Typeface sample</h2><figure><picture><source srcset="/letters.svg" type="image/svg+xml">${img}</picture><figcaption>Hollis Sans</figcaption></figure>`, files })).toEqual([]);
    expect(await failed({ html: `<div role="heading" aria-level="3">Handwriting example</div><a href="/styles">${img}</a>`, files })).toEqual([]);
    // A heading further up, with other content between, is not the picture's caption; nor is a heading after it.
    expect(await failed({ html: `<h2>Typeface sample</h2><ul><li>One</li><li>Two</li></ul>${img}`, files })).toEqual([['1.4.5', '#pic']]);
    expect(await failed({ html: `<h2>Typeface sample</h2><p>Our signs use one family of letters.</p><p>They are set in two sizes.</p>${img}`, files })).toEqual([['1.4.5', '#pic']]);
    expect(await failed({ html: `<h2>Typeface sample</h2><section>${img}</section>`, files })).toEqual([['1.4.5', '#pic']]);
    expect(await failed({ html: `<div>${img} <span>Seen on every door.</span></div><h2>Typeface sample</h2>`, files })).toEqual([['1.4.5', '#pic']]);
    expect(await failed({ html: `<h2>Typeface sample</h2><div><p>Seen on every door.</p>${img}</div>`.replace('<div><p>', '<div><p>Long: ' + 'the letters are cut from steel and painted. '.repeat(8)), files })).toEqual([['1.4.5', '#pic']]);
  });

  it('a picture shown too small to read, and the address of one view of a sprite, are not judged', async () => {
    expect(await failed(one('/notice.svg', NOTICE, `alt="${NOTICE_ALT}" width="96" height="33"`))).toEqual([]);
    expect(await statuses({ html: `<img id="pic" src="/sheet.svg#notice" alt="Notice" width="640" height="220">`, files: { '/sheet.svg': { body: NOTICE } } })).toEqual([['1.1.1', 'not_applicable'], ['1.4.5', 'not_applicable']]);
  });

  it('a CSS background that shows the whole notice fails; one that is cut off, or repeats a pattern of no words, does not', async () => {
    const bg = (style: string) => ({ html: `<div id="pic" style="${style}"></div>`, files: { '/notice.svg': { body: NOTICE }, '/dots.svg': { body: svg(20, 20, '<circle cx="10" cy="10" r="3" fill="#999"/>') } } });
    expect(await failed(bg('height:220px;background:center/contain no-repeat url(/notice.svg)'))).toEqual([['1.1.1', '#pic'], ['1.4.5', '#pic']]);
    expect(await failed(bg('width:640px;height:220px;background-image:url(/notice.svg);background-repeat:no-repeat'))).toEqual([['1.1.1', '#pic'], ['1.4.5', '#pic']]);
    expect(await failed(bg('height:90px;background:center/cover no-repeat url(/notice.svg)'))).toEqual([]);
    expect(await statuses(bg('height:220px;background:url(/dots.svg)'))).toEqual([['1.1.1', 'not_applicable'], ['1.4.5', 'not_applicable']]);
  });
});

describe('1.1.1: words a picture draws that the page gives nowhere', () => {
  it('fails a block of text whose alternative gives none of its words, and passes it when the alternative or the page does', async () => {
    expect(await failed(one('/notice.svg', NOTICE, 'alt="Flyer" width="640" height="220"'))).toEqual([['1.1.1', '#pic'], ['1.4.5', '#pic']]);
    // A short alternative that is no kind word may say the picture briefly: for a person to check (cut round, S1).
    expect(await statuses(one('/notice.svg', NOTICE, 'alt="Students reading in the school library." width="640" height="220"'))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'flagged']]);
    const page = { ...one('/notice.svg', NOTICE, 'alt="Notice" width="640" height="220"') };
    page.html += '<p>Family packet pickup is Friday, November 13, from 1 to 3 p.m.</p><p>Come to the Alder Draw office, room 4, and use the west garden gate.</p>';
    expect(await failed(page)).toEqual([['1.4.5', '#pic']]);
  });

  it('fails a picture kept from screen readers that draws an instruction, and passes it when the text beside it says the same', async () => {
    expect(await failed(one('/map.svg', MAP, 'alt="" width="640" height="240"'))).toEqual([['1.1.1', '#pic']]);
    expect(await failed(one('/map.svg', MAP, 'alt="Pickup map" aria-hidden="true" width="640" height="240"'))).toEqual([['1.1.1', '#pic']]);
    const said = one('/map.svg', MAP, 'alt="" width="640" height="240"');
    said.html = `<figure>${said.html}<figcaption>Holds are past the west entrance: enter by the west door and turn right at the desk to reach the hold shelf.</figcaption></figure>`;
    expect(await failed(said)).toEqual([]);
  });

  it('a region closed off further up (the page behind an open dialog) is not read as hiding its pictures; a close wrapper is', async () => {
    const pic = '<img id="pic" src="/map.svg" alt="Pickup map: enter by the west door and turn right at the desk to reach the hold shelf. West entrance, holds." width="640" height="240">';
    const files = { '/map.svg': { body: MAP } };
    // A page whose content is hidden from assistive technology while a dialog is open over it.
    expect(await failed({ html: `<div id="page" aria-hidden="true"><section><div class="row"><div class="col"><p>${pic}</p></div></div></section></div><div role="dialog" aria-modal="true" aria-label="News"><p>School is closed Friday.</p><button type="button">Close</button></div>`, files })).toEqual([]);
    expect(await failed({ html: `<div class="slide" aria-hidden="true">${pic}</div>`, files })).toEqual([['1.1.1', '#pic']]);
  });

  it('fails an alternative that only names the kind of picture, or is a file name, when the picture draws an instruction', async () => {
    expect(await failed(one('/map.svg', MAP, 'alt="Map" width="640" height="240"'))).toEqual([['1.1.1', '#pic']]);
    expect(await failed(one('/map.svg', MAP, 'alt="map.svg" width="640" height="240"'))).toEqual([['1.1.1', '#pic']]);
    const f = (await findingsOf(one('/map.svg', MAP, 'alt="Map" width="640" height="240"'))).find((x) => x.status === 'flagged')!;
    expect(f.detail).toBe('For a person to check: The picture\'s text alternative (“Map”) only says what kind of picture it is, and the picture draws words that neither it nor the page\'s text gives: “WEST ENTRANCE · HOLDS · Enter west door. Turn right at the desk to reach the hold shelf.”');
  });

  it('what counts as given: a description by reference, text behind a toggle, a list of terms, text in a web component', async () => {
    const base = one('/map.svg', MAP, 'alt="Map" width="640" height="240" aria-describedby="d"');
    expect(await failed({ ...base, html: `${base.html}<p id="d" hidden>West entrance and holds: enter the west door and turn right at the desk to reach the hold shelf.</p>` })).toEqual([]);
    const plain = one('/map.svg', MAP, 'alt="Map" width="640" height="240"');
    expect(await failed({ ...plain, html: `${plain.html}<details><summary>Directions</summary><p>From the west entrance, enter the west door and turn right at the desk to reach the hold shelf.</p></details>` })).toEqual([]);
    expect(await failed({ ...plain, html: `${plain.html}<dl><dt>West entrance</dt><dd>Enter the west door.</dd><dd>Turn right at the desk to reach the hold shelf.</dd></dl>` })).toEqual([]);
    expect(await failed({ ...plain, html: `${plain.html}<pickup-note></pickup-note><script>customElements.define('pickup-note', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<p>West entrance: enter the west door, then turn right at the desk to reach the hold shelf.</p>'; } });</script>` })).toEqual([]);
  });

  it('is not failed inside a link or a button, next to a link to its text version, or with no alt attribute at all', async () => {
    const f = { '/notice.svg': { body: NOTICE } };
    expect(await failed({ html: '<a href="/packet"><img id="pic" src="/notice.svg" alt="Packet pickup" width="640" height="220"></a>', files: f })).toEqual([['1.4.5', '#pic']]);
    expect(await failed({ html: '<img id="pic" src="/notice.svg" alt="Notice" width="640" height="220"> <a href="/packet-text">Text version of the notice</a>', files: f })).toEqual([['1.4.5', '#pic']]);
    expect(await failed({ html: '<img id="pic" src="/notice.svg" width="640" height="220">', files: f })).toEqual([['1.4.5', '#pic']]);
  });
});

describe('reading the file', () => {
  /** Two servers (two origins): `cdn` serves the picture with no sharing header, `own` the page that shows it. */
  async function twoSites(file: () => { body: string; headers?: Record<string, string> }, page: (cdn: string) => string) {
    const hits = { cdn: 0 };
    const cdn = createServer((_req, res) => { hits.cdn++; const f = file(); res.writeHead(200, { 'content-type': 'image/svg+xml', ...(f.headers ?? {}) }).end(f.body); });
    await new Promise<void>((r) => cdn.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}`;
    const own = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en"><head><title>Pictures</title></head><body><main><h1>Family information</h1>${page(origin)}</main></body></html>`); });
    await new Promise<void>((r) => own.listen(0, '127.0.0.1', () => r()));
    const run = async (withCdp: boolean, watch?: (method: string, params: unknown) => void) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      // The scan's request guard watches every request and lets these through.
      await context.route('**/*', (route) => route.continue());
      const p = await context.newPage();
      try {
        await p.goto(`http://127.0.0.1:${(own.address() as AddressInfo).port}/`, { waitUntil: 'load' });
        const ctx = await contextOf(p, withCdp);
        if (watch) {
          const session = (await ctx.cdp!())!;
          const send = session.send.bind(session);
          (session as unknown as { send: unknown }).send = (method: string, params?: unknown) => { watch(method, params); return (send as (m: string, q?: unknown) => Promise<unknown>)(method, params); };
        }
        return await picturesProbe.run(ctx);
      } finally {
        await context.close();
      }
    };
    const close = async () => { await new Promise((r) => cdn.close(r)); await new Promise((r) => own.close(r)); };
    return { hits, run, close };
  }
  const brief = (fs: ProbeFinding[]) => fs.map((f) => [f.criterion, f.status, f.target]);

  it('reads the browser’s own copy of the file the page loaded: another site’s with no sharing header, a file that is not stored; nothing is asked for again', async () => {
    const t = await twoSites(() => ({ body: NOTICE, headers: { 'cache-control': 'no-store' } }), (cdn) => `<img id="pic" src="${cdn}/notice.svg" alt="${NOTICE_ALT}" width="640" height="220">`);
    try {
      expect(brief(await t.run(true))).toEqual([['1.4.5', 'flagged', '#pic']]);
      // The picture loaded once: reading the browser's copy of it asked the other site nothing.
      expect(t.hits.cdn).toBe(1);
    } finally {
      await t.close();
    }
  });

  // The read that raced (training site 01, /permits/building.html: 1.1.1 not testable in 1 run of 4): the browser's
  // record of the file has no size yet, so it is not asked, and the page's stored copy is not there (a file not
  // stored, or a cache write not done yet). The file kept as its response arrived is read instead: no request.
  it('the race: with no size on the browser\'s record and no stored copy, the file kept as its response arrived is read; without it, "not testable"', async () => {
    const own = createServer((req, res) => {
      if (req.url === '/notice.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' }).end(NOTICE); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en"><head><title>Permits</title></head><body><main><h1>Building permits</h1><img id="pic" src="/notice.svg" alt="${NOTICE_ALT}" width="640" height="220"></main></body></html>`);
    });
    await new Promise<void>((r) => own.listen(0, '127.0.0.1', () => r()));
    const run = async (kept: boolean) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.route('**/*', (route) => route.continue());
      const p = await context.newPage();
      const store = kept ? watchPictureFiles(p as never) : undefined;
      let requests = 0;
      try {
        await p.goto(`http://127.0.0.1:${(own.address() as AddressInfo).port}/`, { waitUntil: 'load' });
        p.on('request', () => { requests++; });
        const ctx = await contextOf(p, true);
        // The browser's record as it was in the run that missed: no size on it.
        const session = (await ctx.cdp!())!;
        const send = session.send.bind(session) as (m: string, q?: unknown) => Promise<unknown>;
        const strip = (t: { resources?: { contentSize?: number }[]; childFrames?: unknown[] } | undefined): void => { for (const r of t?.resources ?? []) delete r.contentSize; for (const c of t?.childFrames ?? []) strip(c as never); };
        (session as unknown as { send: unknown }).send = async (method: string, params?: unknown) => { const got = await send(method, params); if (method === 'Page.getResourceTree') strip((got as { frameTree?: never }).frameTree); return got; };
        let data: unknown;
        const findings = await picturesProbe.run({ ...ctx, ...(store ? { pictureFile: (u: string) => store.get(u) } : {}), setData: (d: unknown) => { data = d; } } as ProbeContext);
        return { findings, data, requests };
      } finally {
        await context.close();
      }
    };
    try {
      const missed = await run(false);
      expect(brief(missed.findings)).toEqual([['1.1.1', 'not_testable', '#pic'], ['1.4.5', 'not_testable', '#pic']]);
      expect(missed.findings[0]!.detail).toContain('could not be read');
      expect(missed.data).toEqual({ fileReads: [{ file: expect.stringMatching(/\/notice\.svg$/), via: 'page', error: 'unread' }] });
      const read = await run(true);
      expect(brief(read.findings)).toEqual([['1.4.5', 'flagged', '#pic']]);
      expect(read.data).toEqual({ fileReads: [{ file: expect.stringMatching(/\/notice\.svg$/), via: 'response' }] });
      expect(read.requests).toBe(0);
    } finally {
      await new Promise((r) => own.close(r));
    }
  });

  // A picture whose address the page loads twice (a style that comes and goes, a second picture of the same file): the
  // file is known only when every load was kept as it arrived and they were all the same file.
  it('loaded twice: the same file both times is read from the kept responses; two different files are never read', async () => {
    let n = 0;
    let differ = false;
    const own = createServer((req, res) => {
      if (req.url === '/notice.svg') { const body = differ && n++ > 0 ? NOTICE.replace('Use the west garden gate.', 'Bring a signed permission slip.') : NOTICE; res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' }).end(body); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en"><head><title>Twice</title></head><body><main><h1>Family information</h1><img id="pic" src="/notice.svg" alt="${NOTICE_ALT}" width="640" height="220"><script>addEventListener('load', () => { const again = new Image(); again.id = 'late'; again.alt = ''; again.width = 640; again.height = 220; again.src = '/notice.svg?'.slice(0, -1); document.querySelector('main').append(again); });</script></main></body></html>`);
    });
    await new Promise<void>((r) => own.listen(0, '127.0.0.1', () => r()));
    const run = async (kept: boolean) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.route('**/*', (route) => route.continue());
      const p = await context.newPage();
      const store = kept ? watchPictureFiles(p as never) : undefined;
      try {
        await p.goto(`http://127.0.0.1:${(own.address() as AddressInfo).port}/`, { waitUntil: 'load' });
        await p.waitForTimeout(300);
        const ctx = await contextOf(p, true);
        let data: unknown;
        const findings = await picturesProbe.run({ ...ctx, ...(store ? { pictureFile: (u: string) => store.get(u) } : {}), setData: (d: unknown) => { data = d; } } as ProbeContext);
        return { findings, data, loads: n };
      } finally {
        await context.close();
      }
    };
    try {
      const plain = await run(false);
      // Without the kept responses, an address loaded twice is not read (S5).
      if (plain.findings.some((f) => f.status === 'not_testable')) expect(plain.findings[0]!.detail).toContain('could not be read');
      const same = await run(true);
      expect(brief(same.findings), `loads ${same.loads}`).toEqual(expect.arrayContaining([['1.4.5', 'flagged', '#pic']]));
      expect(same.findings.filter((f) => f.status === 'not_testable'), `loads ${same.loads}`).toEqual([]);
      differ = true; n = 0;
      const two = await run(true);
      expect(two.findings.filter((f) => f.status === 'flagged' && /permission slip/.test(f.detail ?? ''))).toEqual([]);
      // Asked twice and given two files: neither is read. (A browser that shows both from its one copy asks once.)
      if (two.loads > 1) expect(two.findings.filter((f) => f.status === 'flagged' && f.criterion === '1.4.5')).toEqual([]);
    } finally {
      await new Promise((r) => own.close(r));
    }
  });

  // S7: the words read must be the ones of the file the picture shows.
  it('S7: with no way to ask the browser for its copy, another site’s file and a file that is not stored are not read at all (the network is never asked): "not testable"', async () => {
    const t = await twoSites(() => ({ body: NOTICE }), (cdn) => `<img id="pic" src="${cdn}/notice.svg" alt="${NOTICE_ALT}" width="640" height="220">`);
    try {
      expect(brief(await t.run(false))).toEqual([['1.1.1', 'not_testable', '#pic'], ['1.4.5', 'not_testable', '#pic']]);
      expect(t.hits.cdn).toBe(1);
    } finally {
      await t.close();
    }
    // The page's own file, not stored (the watched requests of a scan turn the browser's cache off): the same.
    const before = served.filter((x) => x === '/notice.svg').length;
    expect(await statuses(one('/notice.svg', NOTICE, `alt="${NOTICE_ALT}" width="640" height="220"`), false)).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    expect(served.filter((x) => x === '/notice.svg').length).toBe(before + 1);
  });

  it('S7: the review’s changing file: an address that answers with other words each time is judged by the words the picture shows, or not at all', async () => {
    let n = 0;
    const version = () => NOTICE.replace('Use the west garden gate.', n++ === 0 ? 'Use the west garden gate.' : 'Bring a signed permission slip.');
    const t = await twoSites(() => ({ body: version(), headers: { 'cache-control': 'no-store' } }), (cdn) => `<img id="pic" src="${cdn}/notice.svg" alt="${NOTICE_ALT}" width="640" height="220">`);
    try {
      const got = await t.run(true);
      expect(brief(got)).toEqual([['1.4.5', 'flagged', '#pic']]);
      expect(got[0]!.detail).toContain('Use the west garden gate.');
      expect(got[0]!.detail).not.toContain('permission slip');
      expect(t.hits.cdn).toBe(1);
    } finally {
      await t.close();
    }
    // The page loads the same address again for another picture, and is given other words: which file a picture
    // shows cannot be told from the address, so neither is read.
    n = 0;
    const twice = await twoSites(() => ({ body: version(), headers: { 'cache-control': 'no-store' } }), (cdn) => `<img id="pic" src="${cdn}/notice.svg" alt="${NOTICE_ALT}" width="640" height="220">
      <script>addEventListener('load', () => { const again = new Image(); again.id = 'late'; again.alt = ''; again.width = 640; again.height = 220; again.src = '${cdn}/notice.svg'; again.onload = () => { document.title = 'loaded twice'; }; document.querySelector('main').append(again); });</script>`);
    try {
      const got = await twice.run(true);
      // Loaded twice: nothing is failed. (A browser that shows both pictures from its one copy asks once, and is judged as above.)
      if (twice.hits.cdn > 1) expect(got.filter((f) => f.status === 'flagged')).toEqual([]);
      expect(got.filter((f) => f.status === 'flagged' && f.target === '#pic' && /permission slip/.test(f.detail ?? ''))).toEqual([]);
    } finally {
      await twice.close();
    }
  });

  it('S7: a text alternative that arrives while the picture is measured takes the failure with it: the page is read again afterwards', async () => {
    // The page puts the alt text in when the first picture object is made after it loaded: during the measuring.
    const late = `<img id="pic" src="/notice.svg" alt="" width="640" height="220"><script>addEventListener('load', () => { const Real = window.Image; window.Image = function (...a) { document.getElementById('pic').alt = ${JSON.stringify(NOTICE_ALT)}; window.Image = Real; return new Real(...a); }; });</script>`;
    const got = await findingsOf({ html: late, files: { '/notice.svg': { body: NOTICE } } });
    expect(got.map((f) => [f.criterion, f.status])).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'flagged']]);
    expect(got[0]!.detail).toMatch(/^the page changed while its pictures were measured/);
    // The same page with the alt text never arriving: the failure stands.
    expect(await failed(one('/notice.svg', NOTICE, 'alt="" width="640" height="220"'))).toEqual([['1.1.1', '#pic'], ['1.4.5', '#pic']]);
  });

  // S8: the limit on a file's size is applied before anything of it is held.
  it('S8: a file over the limit is never asked for: the browser’s record of its size is read first', async () => {
    const big = NOTICE.replace('<rect', `<!-- ${'x'.repeat(PICTURE_LIMITS.fileBytes + 10)} --><rect`);
    const methods: string[] = [];
    const t = await twoSites(() => ({ body: big }), (cdn) => `<img id="pic" src="${cdn}/notice.svg" alt="${NOTICE_ALT}" width="640" height="220">`);
    try {
      const got = await t.run(true, (method) => methods.push(method));
      expect(brief(got)).toEqual([['1.1.1', 'not_testable', '#pic'], ['1.4.5', 'not_testable', '#pic']]);
      expect(got[0]!.detail).toContain('its file is larger than is read');
      expect(methods).toContain('Page.getResourceTree');
      expect(methods).not.toContain('Page.getResourceContent');
    } finally {
      await t.close();
    }
    // The same file under the limit is asked for and measured.
    const small: string[] = [];
    const u = await twoSites(() => ({ body: NOTICE }), (cdn) => `<img id="pic" src="${cdn}/notice.svg" alt="${NOTICE_ALT}" width="640" height="220">`);
    try {
      expect(brief(await u.run(true, (method) => small.push(method)))).toEqual([['1.4.5', 'flagged', '#pic']]);
      expect(small).toContain('Page.getResourceContent');
    } finally {
      await u.close();
    }
  });

  it('S8: what the browser hands over is checked for length before it is decoded; the page’s own read stops at the limit', async () => {
    expect(decodedCopy('x'.repeat(2001), false, 2000)).toEqual({ error: 'too-large' });
    expect(decodedCopy(Buffer.from('y'.repeat(3000)).toString('base64'), true, 2000)).toEqual({ error: 'too-large' });
    expect(decodedCopy(Buffer.from('<svg>é</svg>').toString('base64'), true, 2000)).toEqual({ source: '<svg>é</svg>' });
    expect(decodedCopy('<svg/>', false, 2000)).toEqual({ source: '<svg/>' });
    // A stored file sent in pieces with no length stated, read by the page itself (no request watching here, so the
    // browser's cache is on): the read stops when the limit is passed, and a file within it is measured.
    const pieces = createServer((req, res) => {
      if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html lang="en"><head><title>P</title></head><body><img src="/big.svg" width="640" height="220" alt=""><img src="/small.svg" width="640" height="220" alt=""></body></html>'); return; }
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=600', 'transfer-encoding': 'chunked' });
      const body = req.url === '/big.svg' ? NOTICE.replace('<rect', `<!-- ${'x'.repeat(40_000)} --><rect`) : NOTICE;
      for (let at = 0; at < body.length; at += 4096) res.write(body.slice(at, at + 4096));
      res.end();
    });
    await new Promise<void>((r) => pieces.listen(0, '127.0.0.1', () => r()));
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const p = await context.newPage();
      const base = `http://127.0.0.1:${(pieces.address() as AddressInfo).port}`;
      await p.goto(`${base}/`, { waitUntil: 'load' });
      const got = await p.evaluate(measureSvgPictures, { files: [{ src: `${base}/big.svg` }, { src: `${base}/small.svg` }, { src: `${base}/never-loaded.svg` }], limits: { ...MEASURING, fileBytes: 20_000 } });
      expect(got.map((g) => [g.src.split('/').pop(), g.error ?? 'measured'])).toEqual([['big.svg', 'too-large'], ['small.svg', 'measured'], ['never-loaded.svg', 'unread']]);
    } finally {
      await context.close();
      await new Promise((r) => pieces.close(r));
    }
  });

  it('a page whose policy forbids data: and blob: pictures: the words cannot be drawn, so it is "not testable"; with blob: allowed it is measured', async () => {
    const strict = { ...one('/notice.svg', NOTICE, `alt="${NOTICE_ALT}" width="640" height="220"`), headers: { 'content-security-policy': "img-src 'self'" } };
    expect(await statuses(strict)).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    const blob = { ...strict, headers: { 'content-security-policy': "img-src 'self' blob:" } };
    expect(await failed(blob)).toEqual([['1.4.5', '#pic']]);
  });

  it('leaves the page as it was: no canvas, no picture and no global is added', async () => {
    const page = await open(one('/notice.svg', NOTICE, `alt="${NOTICE_ALT}" width="640" height="220"`));
    try {
      const count = () => page.evaluate(() => [document.querySelectorAll('*').length, document.querySelectorAll('canvas').length, document.images.length, Object.keys(window).length]);
      const before = await count();
      expect((await picturesProbe.run(await contextOf(page))).filter((f) => f.status === 'flagged')).toHaveLength(1);
      expect(await count()).toEqual(before);
    } finally {
      await page.context().close();
    }
  });

  it('reads the page’s pictures and text without the files: what readPictures returns', async () => {
    const page = await open({ html: `<header><a href="/"><img src="/logo.svg" alt="Birch Valley" width="200" height="50"></a></header><img id="pic" src="/notice.svg" alt="Notice" width="640" height="220"><img src="/photo.png" alt="A photo" width="300" height="200"><p>Office hours are <b>8 to 5</b> on weekdays.</p>`,
      files: { '/notice.svg': { body: NOTICE }, '/logo.svg': { body: WORDMARK }, '/photo.png': { body: '', type: 'image/png' } } });
    try {
      const read = await page.evaluate(readPictures, READING);
      expect(read.pictures.map((p) => [p.target, p.svg, p.logo, p.control])).toEqual([['html > body > main > header > a > img', true, true, 'only'], ['#pic', true, false, ''], ['html > body > main > img:nth-of-type(2)', false, false, '']]);
      // The page's text in document order, with the text alternatives its elements carry.
      expect(read.blocks).toEqual(['Family information', 'Birch Valley', 'Notice', 'A photo', 'Office hours are 8 to 5 on weekdays.']);
      // Each picture's place: the first block after it (its own alt text stands there).
      expect(read.pictures.map((p) => [p.at, p.showing, p.loads, p.cut, p.fit])).toEqual([[1, 1, 1, false, 'fill'], [2, 1, 1, false, 'fill'], [3, 1, 1, false, 'fill']]);
      expect(read.pictures.map((p) => p.decoded)).toEqual([[320, 80], [640, 220], undefined]);
      expect(read.truncated || read.blocksTruncated).toBe(false);
      // A header inside the main content is content; the page's heading is a heading.
      expect(read.regions).toEqual([0, 0, 0, 0, 0]);
      expect(read.heads).toEqual([true, false, false, false, false]);
    } finally {
      await page.context().close();
    }
  });

  it('reads which text is set apart from the content (a navigation, the site’s footer) and which blocks are headings', async () => {
    const page = await open({ html: `<nav aria-label="Pages"><a href="/a">About the district office</a></nav>
      <article><header><h2>Posting <img src="/logo.svg" alt="New" width="40" height="10"></h2><p>Lead text here.</p></header><img id="pic" src="/notice.svg" alt="Notice" width="640" height="220"><footer><p>Posted by staff.</p></footer></article>
      <aside><p>Related pages follow.</p></aside><div role="contentinfo"><p>Contact the office.</p><div role="heading" aria-level="2">Hours</div></div>`,
      files: { '/notice.svg': { body: NOTICE }, '/logo.svg': { body: WORDMARK } } });
    try {
      const read = await page.evaluate(readPictures, READING);
      expect(read.blocks).toEqual(['Family information', 'Pages', 'About the district office', 'Posting', 'New', 'Lead text here.', 'Notice', 'Posted by staff.', 'Related pages follow.', 'Contact the office.', 'Hours']);
      // The navigation and the footer are set apart (each its own number); an article's header and footer, and an aside, are content.
      expect(read.regions).toEqual([0, 1, 1, 0, 0, 0, 0, 0, 0, 2, 2]);
      expect(read.heads).toEqual([true, false, false, true, true, false, false, false, false, false, true]);
      expect(read.pictures.find((p) => p.target === '#pic')).toMatchObject({ region: 0, at: 6 });
    } finally {
      await page.context().close();
    }
  });

  // S3: what the page gives is read whole, or said not to be.
  it('S3: a long paragraph is read whole, in pieces; an alt text and a description are read whole; what is longer than is read is marked', async () => {
    const filler = 'This paragraph goes on about other things for a long while. '.repeat(14);
    const long = `${filler}Family packet pickup is on Friday, November 13 from 1–3 p.m. at the Alder Draw office, room 4. Use the west garden gate.`;
    const page = await open({ html: `<img id="pic" src="/notice.svg" alt="${'Notice of an event. '.repeat(40)}" aria-describedby="d" width="640" height="220"><p id="d">${long}</p><img id="cut" src="/notice.svg" alt="${'word '.repeat(900)}" width="640" height="220">`, files: { '/notice.svg': { body: NOTICE } } });
    try {
      const read = await page.evaluate(readPictures, READING);
      expect(read.blocksTruncated).toBe(false);
      expect(read.blocks.every((b) => b.length <= PICTURE_LIMITS.blockChars)).toBe(true);
      expect(read.blocks.join(' ')).toContain('Use the west garden gate.');
      expect(read.blocks.join(' ').split('This paragraph goes on').length - 1).toBe(14);
      const [pic, cut] = read.pictures;
      expect([pic!.alt!.length, pic!.cut, pic!.described.endsWith('Use the west garden gate.')]).toEqual([799, false, true]);
      expect([cut!.alt!.length, cut!.cut]).toEqual([PICTURE_LIMITS.sourceChars, true]);
      // A page with more text than is compared says so.
      const small = await page.evaluate(readPictures, { ...READING, pageChars: 500 });
      expect(small.blocksTruncated).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  it('cut-round review S4: a reload at the same address with the page\'s resource timings cleared is never failed (red: it was failed against the replaced file)', async () => {
    let n = 0;
    const DRAWING = svg(640, 220, '<rect width="640" height="220" fill="#dfe9f2"/><circle cx="320" cy="110" r="80" fill="#7a9e7e"/>');
    const t = await twoSites(() => ({ body: n++ === 0 ? NOTICE : DRAWING, headers: { 'cache-control': 'no-store' } }), (cdn) => `<img id="pic" src="${cdn}/notice.svg" alt="" width="640" height="220">
      <script>addEventListener('load', () => { const Real = window.Image; window.Image = function (...a) { window.Image = Real; performance.clearResourceTimings(); const pic = document.getElementById('pic'); pic.src = pic.src; return new Real(...a); }; });</script>`);
    try {
      const got = await t.run(true);
      expect(got.filter((f) => f.status === 'failed')).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it('S5 (full-tree review): a file loaded again at the same address while it is measured is not judged (red: the second reading kept the first file)', async () => {
    // The address answers with the notice, then with a drawing of the same size and no words. The page loads the
    // picture again when the measuring starts (the first picture object made after it loaded).
    let n = 0;
    const DRAWING = svg(640, 220, '<rect width="640" height="220" fill="#dfe9f2"/><circle cx="320" cy="110" r="80" fill="#7a9e7e"/>');
    const t = await twoSites(() => ({ body: n++ === 0 ? NOTICE : DRAWING, headers: { 'cache-control': 'no-store' } }), (cdn) => `<img id="pic" src="${cdn}/notice.svg" alt="" width="640" height="220">
      <script>addEventListener('load', () => { const Real = window.Image; window.Image = function (...a) { window.Image = Real; const pic = document.getElementById('pic'); pic.src = pic.src; return new Real(...a); }; });</script>`);
    try {
      const got = await t.run(true);
      expect(t.hits.cdn).toBe(2);
      expect(got.filter((f) => f.status === 'flagged')).toEqual([]);
      expect(got.map((f) => [f.criterion, f.status])).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
      expect(got[0]!.detail).toMatch(/loaded its file again while it was measured/);
    } finally {
      await t.close();
    }
    // Look-alike: the same page with no second load is judged.
    n = 0;
    const once = await twoSites(() => ({ body: n++ === 0 ? NOTICE : DRAWING, headers: { 'cache-control': 'no-store' } }), (cdn) => `<img id="pic" src="${cdn}/notice.svg" alt="" width="640" height="220">`);
    try {
      expect((await once.run(true)).filter((f) => f.status === 'flagged').map((f) => f.criterion)).toEqual(['1.1.1', '1.4.5']);
    } finally {
      await once.close();
    }
  });
});

// The review's cases as whole pages (Sol r1): each must not fail, beside the look-alike that still must.
describe('the review’s cases on a page', () => {
  const f = { '/notice.svg': { body: NOTICE } };
  const sign = svg(640, 120, `<rect width="640" height="120" fill="#f4efe2"/><text x="36" y="70" font-size="30" ${FONT}>Parking costs nothing on Saturdays.</text>`);

  it('S1: an alternative that says the same in other words, with the date written another way, or in another language is never failed for 1.1.1', async () => {
    expect(await statuses(one('/sign.svg', sign, 'alt="Free parking on Saturdays." width="640" height="120"'))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'flagged']]);
    expect(await statuses(one('/notice.svg', NOTICE, 'alt="Packet pick-up for families on Fri 11/13 from 13:00 to 15:00 in room four of the Alder Draw office; enter by the garden gate on the west side." width="640" height="220"'))).toEqual([['1.4.5', 'flagged']]);
    // A translation that keeps the date, the time and the names gives those lines; one with nothing to match is left open.
    expect(await statuses(one('/notice.svg', NOTICE, 'alt="Recogida de paquetes para familias: viernes 13 de noviembre, de 1 a 3 de la tarde, oficina de Alder Draw, sala 4. Use la puerta oeste del jardín." width="640" height="220"'))).toEqual([['1.4.5', 'flagged']]);
    expect(await statuses(one('/sign.svg', sign, 'alt="El estacionamiento no cuesta nada los fines de semana." width="640" height="120"'))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'flagged']]);
    // The same in a caption, and in the text next to a picture kept from screen readers.
    expect(await statuses({ html: `<figure><img id="pic" src="/sign.svg" alt="" width="640" height="120"><figcaption>There is no charge to park here at weekends.</figcaption></figure>`, files: { '/sign.svg': { body: sign } } })).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'flagged']]);
    expect(await statuses({ html: `<img id="pic" src="/sign.svg" alt="" width="640" height="120"><p>Free parking on Saturdays.</p>`, files: { '/sign.svg': { body: sign } } })).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'flagged']]);
    // A sentence right beside the picture may say it in words that share nothing with it: never failed either.
    expect(await statuses({ html: `<img id="pic" src="/sign.svg" alt="" width="640" height="120"><p>Vehicles may be left here at no charge every weekend.</p>`, files: { '/sign.svg': { body: sign } } })).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'flagged']]);
    expect(await statuses({ html: `<p>Vehicles may be left here at no charge every weekend.</p><img id="pic" src="/sign.svg" alt="Sign" width="640" height="120">`, files: { '/sign.svg': { body: sign } } })).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'flagged']]);
    // A caption, a wrapper or a heading between the picture and the sentence does not part them (red: only the block
    // next to the picture, in its own landmark or section, was read): a figure with a credit, a media article, a
    // carousel with a name, the sentence under a heading of its own right after the picture, and in the next section.
    const SAID = '<p>Vehicles may be left here at no charge every weekend.</p>';
    const img = (alt: string) => `<img id="pic" src="/sign.svg" alt="${alt}" width="640" height="120">`;
    for (const html of [
      `<figure>${img('')}<figcaption>Photo: staff</figcaption></figure>${SAID}`,
      `<article class="media media--type-image"><div class="field__item">${img('')}</div></article>${SAID}`,
      `${SAID}<div class="slideshow" aria-label="Announcements"><div class="slide">${img('Sign')}</div><button type="button">Next</button></div>`,
      `${img('')}<h2>What the sign says</h2>${SAID}`,
      `<section><h2>Notices</h2>${img('Sign')}</section><section>${SAID}</section>`,
    ]) expect(await statuses({ html, files: { '/sign.svg': { body: sign } } }), html).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'flagged']]);
    // Look-alikes that still fail: the sentence under the heading before the picture's own, and in a part of the
    // page set apart from its content (the site's footer, a navigation).
    for (const html of [
      `${SAID}<h2>Notices</h2>${img('')}`,
      `<h2>Notices</h2>${img('Sign')}<div role="contentinfo">${SAID}</div>`,
      `<nav aria-label="Pages">${SAID}</nav><h2>Notices</h2>${img('')}`,
    ]) expect(await failed({ html, files: { '/sign.svg': { body: sign } } }), html).toEqual([['1.1.1', '#pic'], ['1.4.5', '#pic']]);
    // Look-alikes that still fail: no alternative, the name of a kind and a file name, with no sentence beside the
    // picture (the page's heading only). A short label (on a notice) may say it briefly: since the cut round (the
    // full-tree review's S1) it is for a person to check, never failed.
    for (const alt of ['', 'Sign', 'sign-final.svg']) {
      expect(await failed({ html: `<img id="pic" src="/sign.svg" alt="${alt}" width="640" height="120">`, files: { '/sign.svg': { body: sign } } }), alt).toEqual([['1.1.1', '#pic'], ['1.4.5', '#pic']]);
    }
    expect(await statuses(one('/notice.svg', NOTICE, 'alt="Town hall" width="640" height="220"'))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'flagged']]);
  });

  it('S2: words kept out of sight in a shown text element are not quoted or judged; words partly covered leave the picture undecided', async () => {
    const part = svg(640, 120, `<rect width="640" height="120" fill="#f4efe2"/><text x="36" y="70" font-size="26" ${FONT}>Open<tspan display="none"> Meet at the north entrance by nine.</tspan></text>`);
    expect(await statuses(one('/open.svg', part, 'alt="Open" width="640" height="120"'))).toEqual([]);
    const half = NOTICE.replace('</g></svg>', '</g><rect x="20" y="97" width="600" height="14" fill="#f4efe2"/></svg>');
    expect(await statuses(one('/half.svg', half, 'alt="" width="640" height="220"'))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    // Words that run past the picture's own edge: some are cut off, and the picture is undecided too.
    const past = svg(640, 120, `<rect width="640" height="120" fill="#f4efe2"/><text x="36" y="70" font-size="26" ${FONT}>Meet at the north entrance of the old county courthouse by nine.</text>`);
    expect(await statuses(one('/past.svg', past, 'alt="" width="640" height="120"'))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
  });

  it('S3: the equivalent of a picture after character 600 of a paragraph, or in a long alt text, is found', async () => {
    const filler = 'This paragraph goes on about other things for a long while. '.repeat(14);
    expect(await failed({ html: `<img id="pic" src="/notice.svg" alt="" width="640" height="220"><p>${filler}Family packet pickup is on Friday, November 13 from 1–3 p.m. at the Alder Draw office, room 4. Use the west garden gate.</p>`, files: f })).toEqual([['1.4.5', '#pic']]);
    expect(await failed(one('/notice.svg', NOTICE, `alt="${'Notice of an event. '.repeat(30)}${NOTICE_ALT}" width="640" height="220"`))).toEqual([['1.4.5', '#pic']]);
    // An alt text longer than is read: nothing is said of what it gives.
    expect(await statuses(one('/notice.svg', NOTICE, `alt="${'word '.repeat(900)}" width="640" height="220"`))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'flagged']]);
  });

  it('S4: the review’s chart, a title over two bars of different lengths with their labels inside, is not an image of text; the same words on a card are', async () => {
    const words = (inner: string) => svg(640, 240, `<rect width="640" height="240" fill="#ffffff"/>${inner}<g ${FONT}><text x="40" y="50" font-size="24">Library visits this spring</text><text x="40" y="115" font-size="20">Alder Draw branch: 1,300 visits</text><text x="40" y="191" font-size="20">Willow Quay branch: 700</text></g>`);
    const bars = words('<rect x="30" y="80" width="520" height="56" fill="#cfe3f1"/><rect x="30" y="156" width="300" height="56" fill="#cfe3f1"/>');
    expect(await statuses(one('/visits.svg', bars, 'alt="Library visits this spring: Alder Draw branch 1,300, Willow Quay branch 700." width="640" height="240"'))).toEqual([]);
    expect(await failed(one('/visits.svg', words(''), 'alt="Library visits this spring: Alder Draw branch 1,300, Willow Quay branch 700." width="640" height="240"'))).toEqual([['1.4.5', '#pic']]);
    // Bars of one length set apart are a drawing too; a title band right over a body is a notice.
    const apart = words('<rect x="30" y="80" width="520" height="56" fill="#cfe3f1"/><rect x="30" y="156" width="520" height="56" fill="#cfe3f1"/>');
    expect(await statuses(one('/visits.svg', apart, 'alt="Library visits this spring: Alder Draw branch 1,300, Willow Quay branch 700." width="640" height="240"'))).toEqual([]);
    const band = svg(640, 220, `<rect width="640" height="220" fill="#f4efe2"/><rect width="640" height="56" fill="#12395b"/><g ${FONT}><text x="36" y="38" font-size="26" fill="#ffffff">Family packet pickup</text><text x="36" y="104" font-size="22">Friday, November 13 · 1–3 p.m.</text><text x="36" y="142" font-size="22">Alder Draw office, room 4</text><text x="36" y="180" font-size="22">Use the west garden gate.</text></g>`);
    // Since the cut round (the full-tree review's S3) a title band over a body is left open: two grounds that each
    // hold words, one right under the other, cannot be told from a stacked bar.
    expect(await statuses(one('/band.svg', band, `alt="${NOTICE_ALT}" width="640" height="220"`))).toEqual([['1.4.5', 'not_testable']]);
  });

  it('S5: a background is judged where it is painted: outside its box it shows nothing, at 16 px it is not legible, under another layer or cut off it is left open', async () => {
    const bg = (style: string, inner = '') => ({ html: `<div id="pic" style="${style}">${inner}</div>`, files: f });
    expect(await statuses(bg('width:640px;height:220px;background:url(/notice.svg) no-repeat 700px 0'))).toEqual([]);
    expect(await statuses(bg('width:640px;height:220px;background:url(/notice.svg) no-repeat 0 0 / 16px auto'))).toEqual([]);
    expect(await statuses(bg('width:640px;height:220px;background:linear-gradient(#f4efe2, #f4efe2), url(/notice.svg) no-repeat'))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    expect(await statuses(bg('width:640px;height:220px;background:url(/notice.svg) no-repeat 0 -100px'))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    expect(await statuses(bg('width:640px;height:220px;background:url(/notice.svg) no-repeat fixed'))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    expect(await statuses(bg('width:640px;height:220px;background:url(/notice.svg) no-repeat', '<div style="width:640px;height:220px;background:#f4efe2"></div>'))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    // Look-alikes that still fail: shown whole at its own size, fitted whole in a larger box with a border and padding, on top of another layer.
    expect(await failed(bg('width:640px;height:220px;background:url(/notice.svg) no-repeat'))).toEqual([['1.1.1', '#pic'], ['1.4.5', '#pic']]);
    expect(await failed(bg('width:700px;height:260px;padding:10px;border:2px solid #333;background:url(/notice.svg) no-repeat center / contain content-box'))).toEqual([['1.1.1', '#pic'], ['1.4.5', '#pic']]);
    expect(await failed(bg('width:640px;height:220px;background:url(/notice.svg) no-repeat, linear-gradient(#f4efe2, #f4efe2)'))).toEqual([['1.1.1', '#pic'], ['1.4.5', '#pic']]);
  });

  it('S5: an image cropped by object-fit, or cut off by its container, is left open; one fitted whole is judged', async () => {
    expect(await statuses({ html: `<img id="pic" src="/notice.svg" alt="${NOTICE_ALT}" style="width:200px;height:200px;object-fit:cover">`, files: f })).toEqual([['1.4.5', 'not_testable']]);
    expect(await statuses({ html: `<div style="width:300px;height:220px;overflow:hidden"><img id="pic" src="/notice.svg" alt="${NOTICE_ALT}" width="640" height="220"></div>`, files: f })).toEqual([['1.4.5', 'not_testable']]);
    expect(await failed({ html: `<img id="pic" src="/notice.svg" alt="${NOTICE_ALT}" style="width:700px;height:300px;object-fit:contain">`, files: f })).toEqual([['1.4.5', '#pic']]);
    // A filter, a clip path or a low opacity on the picture or a container: how it is painted is not what the file draws.
    expect(await statuses({ html: `<img id="pic" src="/notice.svg" alt="${NOTICE_ALT}" width="640" height="220" style="filter:opacity(0)">`, files: f })).toEqual([['1.4.5', 'not_testable']]);
    expect(await statuses({ html: `<div style="filter:brightness(0)"><img id="pic" src="/notice.svg" alt="${NOTICE_ALT}" width="640" height="220"></div>`, files: f })).toEqual([['1.4.5', 'not_testable']]);
    expect(await statuses({ html: `<img id="pic" src="/notice.svg" alt="${NOTICE_ALT}" width="640" height="220" style="clip-path:inset(0 0 60% 0)">`, files: f })).toEqual([['1.4.5', 'not_testable']]);
    expect(await statuses({ html: `<div style="opacity:.2"><img id="pic" src="/notice.svg" alt="${NOTICE_ALT}" width="640" height="220"></div>`, files: f })).toEqual([['1.4.5', 'not_testable']]);
    // A clip path or a mask on a container, and paint containment that cuts the picture off, as overflow does (red:
    // only the picture's own clip path and mask, and its containers' overflow, were read).
    expect(await statuses({ html: `<div style="clip-path:inset(0 0 60% 0)"><img id="pic" src="/notice.svg" alt="${NOTICE_ALT}" width="640" height="220"></div>`, files: f })).toEqual([['1.4.5', 'not_testable']]);
    expect(await statuses({ html: `<div style="-webkit-mask-image:linear-gradient(#000 40%, transparent 60%);mask-image:linear-gradient(#000 40%, transparent 60%)"><img id="pic" src="/notice.svg" alt="${NOTICE_ALT}" width="640" height="220"></div>`, files: f })).toEqual([['1.4.5', 'not_testable']]);
    expect(await statuses({ html: `<div style="width:300px;height:220px;contain:paint"><img id="pic" src="/notice.svg" alt="${NOTICE_ALT}" width="640" height="220"></div>`, files: f })).toEqual([['1.4.5', 'not_testable']]);
    expect(await statuses({ html: `<div style="clip-path:inset(0 0 60% 0)"><div id="pic" style="width:640px;height:220px;background:url(/notice.svg) no-repeat"></div></div>`, files: f })).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    // Look-alike that still fails: paint containment around the whole picture cuts nothing off.
    expect(await failed({ html: `<div style="contain:paint"><img id="pic" src="/notice.svg" alt="${NOTICE_ALT}" width="640" height="220"></div>`, files: f })).toEqual([['1.4.5', '#pic']]);
    // A picture inside a scrolling box can be scrolled to: it is judged.
    expect(await failed({ html: `<div style="width:300px;height:240px;overflow:auto"><img id="pic" src="/notice.svg" alt="${NOTICE_ALT}" width="640" height="220"></div>`, files: f })).toEqual([['1.4.5', '#pic']]);
  });

  it('S5: the containers a picture is drawn in are those of the rendered page: through a slot, out of a shadow root to its host', async () => {
    const IMG = `<img id="pic" src="/notice.svg" alt="${NOTICE_ALT}" width="640" height="220">`;
    const card = (shadow: string) => `<script>customElements.define('notice-card', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(shadow)}; } });</script>`;
    // Red: the walk up stopped at the shadow root (a clip path on the host's container was not seen), and followed
    // the light tree past the slot (the shadow tree's box that cuts the picture off was not seen).
    expect(await statuses({ html: `<div style="clip-path:inset(0 0 60% 0)"><notice-card></notice-card></div>${card(IMG)}`, files: f })).toEqual([['1.4.5', 'not_testable']]);
    expect(await statuses({ html: `<notice-card>${IMG}</notice-card>${card('<div style="width:300px;height:220px;overflow:hidden"><slot></slot></div>')}`, files: f })).toEqual([['1.4.5', 'not_testable']]);
    expect(await statuses({ html: `<div style="opacity:.2"><notice-card></notice-card></div>${card(IMG)}`, files: f })).toEqual([['1.4.5', 'not_testable']]);
    // `content-visibility: auto` brings paint containment: a box narrower than the picture cuts it off.
    expect(await statuses({ html: `<div style="width:300px;content-visibility:auto">${IMG}</div>`, files: f })).toEqual([['1.4.5', 'not_testable']]);
    // Look-alikes that still fail: the picture whole in a shadow root and through a slot; a box with no box of its
    // own (`display: contents`) and an inline link with `overflow: hidden` cut nothing off.
    expect(await statuses({ html: `<notice-card></notice-card>${card(IMG)}`, files: f })).toEqual([['1.4.5', 'flagged']]);
    expect(await statuses({ html: `<notice-card>${IMG}</notice-card>${card('<div style="width:700px"><slot></slot></div>')}`, files: f })).toEqual([['1.4.5', 'flagged']]);
    expect(await failed({ html: `<div style="display:contents;overflow:hidden">${IMG}</div>`, files: f })).toEqual([['1.4.5', '#pic']]);
    expect(await failed({ html: `<p><a href="/notices" style="overflow:hidden">${IMG}</a></p>`, files: f })).toEqual([['1.4.5', '#pic']]);
  });

  it('S9: a file that could not be measured is "not testable" on its page, never "not applicable"', async () => {
    const many = svg(640, 400, `<rect width="640" height="400" fill="#fff"/>${Array.from({ length: 45 }, (_, i) => `<text x="${20 + (i % 3) * 200}" y="${30 + Math.floor(i / 3) * 24}" font-size="12" ${FONT}>Label ${i}</text>`).join('')}`);
    expect(await statuses(one('/many.svg', many, 'alt="" width="640" height="400"'))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    expect(await statuses(one('/broken.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="220"><text x="10" y="40">Closed Saturday all day long', 'alt="" width="640" height="220"'))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    // A picture with no text element at all was read whole: nothing to say.
    expect(await statuses(one('/dots.svg', svg(640, 220, '<circle cx="320" cy="110" r="60" fill="#999"/>'), 'alt="" width="640" height="220"'))).toEqual([['1.1.1', 'not_applicable'], ['1.4.5', 'not_applicable']]);
  });
});

describe('the full-tree review’s cases on a page (cut round)', () => {
  const f = { '/notice.svg': { body: NOTICE } };
  const IMG = `<img id="pic" src="/notice.svg" alt="${NOTICE_ALT}" width="640" height="220"`;

  it('S1: a short alternative that may say the picture briefly is never failed for 1.1.1; it is left for a person to check (red: a third of the words or fewer was failed as a label)', async () => {
    const VERBOSE = svg(1000, 200, `<rect width="1000" height="200" fill="#f4efe2"/><g ${FONT}>
      <text x="30" y="50" font-size="18">The service counter at the front of the building is not open to the public on Saturday.</text>
      <text x="30" y="100" font-size="18">The service counter at the front of the building is not open to the public on Sunday.</text>
      <text x="30" y="150" font-size="18">The service counter opens again for all visitors on Monday morning at the usual time.</text></g>`);
    const got = await findingsOf(one('/hours.svg', VERBOSE, 'alt="Counter closed weekends; reopens Monday." width="1000" height="200"'));
    expect(got.map((x) => [x.criterion, x.status])).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'flagged']]);
    expect(got[0]!.detail).toMatch(/shorter than the words it draws and may still say what they say: a person should check it/);
    // The same, said briefly by the caption of a picture marked decorative.
    const caption = await findingsOf({ html: '<figure><img id="pic" src="/hours.svg" alt="" width="1000" height="200"><figcaption>Counter closed weekends; reopens Monday.</figcaption></figure>', files: { '/hours.svg': { body: VERBOSE } } });
    expect(caption.map((x) => [x.criterion, x.status])).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'flagged']]);
    // Look-alike that still fails: an alternative that only names the kind of picture says nothing of it.
    expect(await failed(one('/hours.svg', VERBOSE, 'alt="Flyer" width="1000" height="200"'))).toEqual([['1.1.1', '#pic'], ['1.4.5', '#pic']]);
  });

  it('S2: the logo, control and caption guards read where a picture is drawn: a brand mark in a component inside a home link is a logo (red: the walk stopped at the shadow root)', async () => {
    const BRAND = svg(480, 130, `<rect width="480" height="130" fill="#12395b"/><g font-family="Georgia, serif" fill="#ffffff"><text x="20" y="40" font-size="26">Birch Valley Water District</text>
      <text x="20" y="75" font-size="16">Clean water for the whole valley since 1952</text><text x="20" y="105" font-size="14">Serving Alder Draw, Fern Lane and Willow Quay</text></g>`);
    const files = { '/assets/identity.svg': { body: BRAND } };
    const mark = `<script>customElements.define('site-identity', class extends HTMLElement { connectedCallback() { if (!this.shadowRoot) this.attachShadow({ mode: 'open' }).innerHTML = '<img id="pic" src="/assets/identity.svg" alt="Birch Valley Water District" width="480" height="130">'; } });</script>`;
    expect(await statuses({ html: `<a href="/"><site-identity></site-identity></a>${mark}`, files })).toEqual([]);
    // In a figure across the shadow boundary, its caption is the figure's.
    const captioned = `<figure><site-card></site-card><figcaption>Notice sample</figcaption></figure><script>customElements.define('site-card', class extends HTMLElement { connectedCallback() { if (!this.shadowRoot) this.attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(`<img id="pic" src="/notice.svg" alt="${NOTICE_ALT}" width="640" height="220">`)}; } });</script>`;
    expect(await statuses({ html: captioned, files: f })).toEqual([]);
    // Look-alike that still fails: the same brand mark in a component outside any link is a picture of its words
    // (its alternative, the name alone, is shorter than its words: for a person to check under 1.1.1).
    expect(await statuses({ html: `<site-identity></site-identity>${mark}`, files })).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'flagged']]);
  });

  it('S3: words on two grounds one right under the other are left open: a title band cannot be told from a stacked bar (red: the stacked bar was failed as text and nothing else)', async () => {
    const STACKED = svg(640, 260, `<rect width="640" height="260" fill="#ffffff"/><rect x="40" y="20" width="420" height="132" fill="#cfe3f1"/><rect x="40" y="152" width="420" height="88" fill="#f6d7a7"/>
      <g ${FONT}><text x="56" y="92" font-size="22">Renewable sources 60 percent</text><text x="56" y="202" font-size="22">Fossil fuels 40 percent</text></g>`);
    // The review's case: a short chart alternative, and a table that gives the numbers.
    const table = '<table><tr><td>Renewable sources</td><td>60 percent</td></tr><tr><td>Fossil fuels</td><td>40 percent</td></tr></table>';
    const got = await findingsOf({ html: `<img id="pic" src="/energy.svg" alt="Energy mix" width="640" height="260">${table}`, files: { '/energy.svg': { body: STACKED } } });
    expect(got.map((x) => [x.criterion, x.status])).toEqual([['1.4.5', 'not_testable']]);
    expect(got[0]!.detail).toMatch(/cannot be told from the segments of a stacked bar/);
    // Look-alike that still fails: the notice on one card.
    expect(await failed({ html: `${IMG}>`, files: f })).toEqual([['1.4.5', '#pic']]);
  });

  it('S4: padding, a border, a legacy clip or rounded corners on a picture or a container that cuts it off leave where it is painted unresolved (red: the outer box was taken as the painted area)', async () => {
    expect(await statuses({ html: `${IMG} style="box-sizing:border-box;padding:110px 320px">`, files: f })).toEqual([['1.4.5', 'not_testable']]);
    expect(await statuses({ html: `<div style="position:relative;height:240px">${IMG} style="position:absolute;clip:rect(0px,640px,60px,0px)"></div>`, files: f })).toEqual([['1.4.5', 'not_testable']]);
    expect(await statuses({ html: `<div style="width:640px;border-radius:110px;overflow:hidden">${IMG}></div>`, files: f })).toEqual([['1.4.5', 'not_testable']]);
    expect(await statuses({ html: `${IMG} style="border-radius:50%">`, files: f })).toEqual([['1.4.5', 'not_testable']]);
    const detail = (await findingsOf({ html: `${IMG} style="border:4px solid #333">`, files: f })).find((x) => x.criterion === '1.4.5')!;
    expect([detail.status, detail.detail]).toEqual(['not_testable', expect.stringMatching(/how much of it the page paints is not worked out \(padding or a border on it\)/)]);
    // Look-alikes that still fail: a container that cuts off its overflow with square corners, and rounded corners
    // on a container that cuts nothing off.
    expect(await failed({ html: `<div style="overflow:hidden">${IMG}></div>`, files: f })).toEqual([['1.4.5', '#pic']]);
    expect(await failed({ html: `<div style="border-radius:24px;background:#eee;padding:8px">${IMG}></div>`, files: f })).toEqual([['1.4.5', '#pic']]);
  });

  it('S6: a frame that could not be read leaves "nowhere in the page\'s text" open (red: another site\'s frame and a deep frame were read as giving nothing)', async () => {
    const files = { '/map.svg': { body: MAP } };
    const pic = '<img id="pic" src="/map.svg" alt="" width="640" height="240">';
    const foreign = ORIGIN.replace('127.0.0.1', 'localhost');
    const cross = await findingsOf({ html: `${pic}<iframe title="Directions" src="${foreign}/directions.html"></iframe>`, files });
    expect(cross.map((x) => [x.criterion, x.status])).toEqual([['1.1.1', 'not_testable']]);
    expect(cross[0]!.detail).toMatch(/a frame on the page could not be read/);
    const attr = (h: string) => h.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const deep = `<iframe srcdoc="${attr(`<iframe srcdoc="${attr(`<iframe srcdoc="${attr('<p>Enter by the west door and turn right at the desk for the hold shelf.</p>')}"></iframe>`)}"></iframe>`)}"></iframe>`;
    expect(await statuses({ html: `${pic}${deep}`, files })).toEqual([['1.1.1', 'not_testable']]);
    // Look-alike that still fails: a frame of the page's own, read, that says something else.
    // (The frame stands in the section before the picture's: text beside a picture is never judged by its words.)
    expect(await failed({ html: `<iframe srcdoc="${attr('<p>Our newsletter comes out every fortnight.</p>')}"></iframe><h2>Drop-off</h2>${pic}`, files })).toEqual([['1.1.1', '#pic']]);
  });

  it('S7: a file with words that embeds a picture or holds a long chain of filter steps is not decoded (red: it was drawn)', async () => {
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const embedded = NOTICE.replace('</svg>', `<image href="${PNG}" x="600" y="190" width="10" height="10"/></svg>`);
    const got = await findingsOf(one('/embedded.svg', embedded, `alt="${NOTICE_ALT}" width="640" height="220"`));
    expect(got.map((x) => [x.criterion, x.status])).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    expect(got[0]!.detail).toMatch(/embeds pictures or applies a filter, which are never decoded here/);
    // Any filter (cut round's check, S5: no timer can stop its painting once it starts) is not decoded either.
    const chain = (n: number) => NOTICE.replace('</svg>', `<defs><filter id="f">${Array.from({ length: n }, (_, i) => `<feOffset dx="${i % 2}" dy="0"/>`).join('')}</filter></defs></svg>`);
    expect(await statuses(one('/chain.svg', chain(20), `alt="${NOTICE_ALT}" width="640" height="220"`))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    expect(await statuses(one('/short-chain.svg', chain(1), `alt="${NOTICE_ALT}" width="640" height="220"`))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    // Look-alike that is still judged (flagged for review): the same file with no filter.
    expect(await failed(one('/plain.svg', NOTICE, `alt="${NOTICE_ALT}" width="640" height="220"`))).toEqual([['1.4.5', '#pic']]);
  });

  it('S7: a drawing that runs out of time is stopped, and no second drawing is started for it (red: the blob: drawing was started after the time ran out)', async () => {
    // Pictures the page makes never finish loading here: each drawing runs out of time.
    const stuck = `${IMG}><script>addEventListener('load', () => { window.__urls = 0; const make = URL.createObjectURL; URL.createObjectURL = (b) => { window.__urls++; return make(b); }; window.__imgs = []; const Real = window.Image; window.Image = function () { const i = new Real(); let v = ''; Object.defineProperty(i, 'src', { get: () => v, set: (x) => { v = String(x); } }); window.__imgs.push(i); return i; }; });</script>`;
    const page = await open({ html: stuck, files: f });
    try {
      const got = await picturesProbe.run(await contextOf(page));
      const state = await page.evaluate(() => { const w = window as unknown as { __urls: number; __imgs: HTMLImageElement[] }; return { urls: w.__urls, made: w.__imgs.length, srcs: w.__imgs.map((i) => i.src) }; });
      expect(state.made).toBeGreaterThan(0);
      expect(state.urls).toBe(0);
      expect(state.srcs.every((x) => x === '')).toBe(true);
      expect(got.map((x) => [x.criterion, x.status])).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    } finally {
      await page.context().close();
    }
  });
});

// Sol's check of the cut round (out/reviews/images-cut-sol-r1.md) found five more ways a picture could be failed
// without being shown. The lead's ruling for batch 17: the picture test's failures are reported for a person to
// check (flagged), never failed. Each scenario must not fail (it may be flagged); each failed on `1e3e7efb`.
describe('the cut round’s review: no picture is ever failed by the picture test (batch 17)', () => {
  const f = { '/notice.svg': { body: NOTICE } };
  const notFailed = async (s: Site) => (await findingsOf(s)).filter((x) => x.status === 'failed').map((x) => [x.criterion, x.target]);
  const define = (tag: string, shadow: string) => `<script>customElements.define('${tag}', class extends HTMLElement { connectedCallback() { if (!this.shadowRoot) this.attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(shadow)}; } });</script>`;
  it('S1: a brand mark slotted into a component inside a "brand" wrapper (the logo marks lay beyond four hops)', async () => {
    const BRAND = svg(480, 130, `<rect width="480" height="130" fill="#12395b"/><g font-family="Georgia, serif" fill="#ffffff"><text x="20" y="40" font-size="26">Birch Valley Water District</text>
      <text x="20" y="75" font-size="16">Clean water for the whole valley since 1952</text><text x="20" y="105" font-size="14">Serving Alder Draw, Fern Lane and Willow Quay</text></g>`);
    expect(await notFailed({ html: `<div class="brand"><site-card><img id="pic" src="/assets/identity.svg" alt="Birch Valley Water District" width="480" height="130"></site-card></div>${define('site-card', '<div><slot></slot></div>')}`, files: { '/assets/identity.svg': { body: BRAND } } })).toEqual([]);
  });
  it('S2: a heading before a slot ("Typeface specimen"), and a figure caption distributed through a slot ("Notice sample")', async () => {
    expect(await notFailed({ html: `<specimen-card><img id="pic" src="/notice.svg" alt="${NOTICE_ALT}" width="640" height="220"></specimen-card>${define('specimen-card', '<h2>Typeface specimen</h2><slot></slot>')}`, files: f })).toEqual([]);
    expect(await notFailed({ html: `<sample-figure><img id="pic" src="/notice.svg" alt="${NOTICE_ALT}" width="640" height="220"><span slot="caption">Notice sample</span></sample-figure>${define('sample-figure', '<figure><slot></slot><figcaption><slot name="caption"></slot></figcaption></figure>')}`, files: f })).toEqual([]);
  });
  it('S3: rounded clipping beyond a scrolling wrapper', async () => {
    expect(await notFailed({ html: `<div style="width:640px;height:220px;overflow:hidden;border-radius:50%"><div style="width:640px;height:220px;overflow:auto"><img id="pic" src="/notice.svg" alt="${NOTICE_ALT}" width="640" height="220" style="display:block"></div></div>`, files: f })).toEqual([]);
  });
  it('S5: a notice whose file applies a filter is not decoded (no timer can stop its painting)', async () => {
    const blurred = NOTICE.replace('<g ', '<defs><filter id="soft"><feGaussianBlur stdDeviation="0.3"/></filter></defs><g filter="url(#soft)" ');
    expect(await notFailed(one('/blurred.svg', blurred, `alt="" width="640" height="220"`))).toEqual([]);
    expect(await statuses(one('/blurred.svg', blurred, `alt="" width="640" height="220"`))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
  });
  it('the would-be failures are listed for a person to check, with their evidence: the element and the words', async () => {
    const got = await findingsOf(one('/notice.svg', NOTICE, 'alt="" width="640" height="220"'));
    expect(got.map((x) => [x.criterion, x.status, x.target])).toEqual([['1.1.1', 'flagged', '#pic'], ['1.4.5', 'flagged', '#pic']]);
    expect(got[1]!.detail).toMatch(/^For a person to check: The picture is text and nothing else: .*Family packet pickup/);
  });
});
