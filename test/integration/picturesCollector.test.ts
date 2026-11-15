// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The picture inventory collector (batch 18, lane images, docs/atlas/images.md G1-G13) in real Chromium: every
// technique on one page, with the browser's names, the context around each picture and the crops. Neutral data only.
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTORS, DEFAULT_COLLECTORS } from '../../src/collect/index.js';
import { cropPlan, PICTURES_LIMITS, picturesCollector, zoomScaleFor, type PictureFact, type PicturesFacts } from '../../src/collect/pictures.js';
import type { PageLike } from '../../src/types.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#0b4f6c"/></svg>';

const BODY = `
<style>.ic{display:inline-block;width:24px;height:24px} .hero{width:600px;height:200px;background:url(/img/hero.jpg) center / cover} .glyph::before{content:"\\f095"} .pdf::before{content:url(/img/pdf.png)} .tab[hidden]{display:none}</style>
<h2>Fall festival</h2>
<figure><img id="flyer" src="/img/flyer.png" srcset="/img/flyer.png 1x, /img/flyer@2x.png 2x" alt="" width="300" height="400"><figcaption>Fall festival flyer</figcaption></figure>
<picture><source media="(max-width: 640px)" srcset="/img/notice-mobile.png"><img id="art" src="/img/photo.png" alt="Students at the fair" width="200" height="120"></picture>
<div id="hero" class="hero"><h3>Welcome back, families</h3></div>
<p>Before the map. <a href="/directions">Directions</a></p>
<img id="map" src="/img/map.svg" alt="Map" width="200" height="200" aria-describedby="mapdesc"><p id="mapdesc">Enter by the west gate.</p>
<a id="fb" href="https://social.example/district"><svg width="20" height="20"><path d="M0 0h20v20H0z"/></svg></a>
<button id="menu" type="button" aria-label="Open the menu"><span class="ic" style="-webkit-mask:url(/img/menu.svg) center / contain;mask:url(/img/menu.svg) center / contain;background:#000"></span></button>
<a class="glyph" id="tel" href="tel:5415550100"></a>
<a class="pdf" id="pdf" href="/files/report.pdf"></a>
<canvas id="chart" width="300" height="150">Enrollment rose from 410 to 455.</canvas>
<object id="obj" data="/img/notice.svg" type="image/svg+xml" width="100" height="60">Notice</object>
<img src="/img/campus.png" usemap="#m" width="200" height="100" alt="Campus"><map name="m"><area id="gym" shape="rect" coords="0,0,100,100" href="/gym" alt="Gym"></map>
<form action="/contact"><label for="cap">Type the letters</label><img id="captcha" src="/img/captcha.png" alt="Security check" width="120" height="40"><input id="cap" name="cap"><button type="submit">Send</button><input type="image" id="go" src="/img/go.png" alt="Go"></form>
<img id="hidden" src="/img/routes.png" alt="Evacuation routes" aria-hidden="true" width="100" height="100">
<div class="tab" hidden><img id="later" src="/img/slide3.png" alt="banner"></div>
<span id="star" role="img" aria-label="4 out of 5 stars">★★★★☆</span>
<div id="host"></div>
<iframe id="frame" srcdoc="<!doctype html><img id='inner' src='/img/inner.png' alt='' width='50' height='50'>" width="100" height="80"></iframe>
<p><a href="/files/Fall-Flyer.jpg">Fall flyer</a></p>
<svg style="display:none"><symbol id="s1"><path d="M0 0h1v1H0z"/></symbol></svg>
<script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<img id="shadowed" src="/img/closure.png" alt="" width="80" height="60">';</script>
`;

async function collect(): Promise<{ facts: PicturesFacts; page: Page }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('https://school.test/**', async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/news/') await r.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><title>News</title></head><body><main><h1>News</h1>${BODY}</main></body></html>` });
    else if (u.pathname.endsWith('.svg')) await r.fulfill({ contentType: 'image/svg+xml', body: SVG });
    else await r.fulfill({ contentType: 'image/png', body: PNG });
  });
  await page.goto('https://school.test/news/');
  await page.waitForTimeout(200);
  const session = await page.context().newCDPSession(page);
  const facts = await picturesCollector.collect(page as unknown as PageLike, { url: page.url(), viewport: 'desktop', cdp: async () => session as never });
  return { facts, page };
}

const by = (facts: PicturesFacts, pred: (p: PictureFact) => boolean) => facts.pictures.filter(pred);
const one = (facts: PicturesFacts, target: string) => { const f = facts.pictures.find((p) => p.target === target || p.target.endsWith(` ${target}`) || p.target.endsWith(target)); expect(f, target).toBeTruthy(); return f!; };

describe('the picture inventory collector', () => {
  it('is asked for by an AI plan only: never one of the collectors every scan runs', () => {
    expect(COLLECTORS.pictures).toBe(picturesCollector);
    expect(DEFAULT_COLLECTORS).not.toContain(picturesCollector);
  });

  it('lists every technique, with the alternative as written and the browser\'s name, role and description', async () => {
    const { facts, page } = await collect();
    try {
      const flyer = one(facts, '#flyer');
      expect(flyer).toMatchObject({ technique: 'img', alt: '', caption: 'Fall festival flyer', shown: true, nameVerified: true, name: '', sectionHeading: 'Fall festival' });
      expect(flyer.sources?.map((s) => s.descriptor)).toEqual(['1x', '2x', undefined]);
      const art = one(facts, '#art');
      expect(art.sources?.[0]).toMatchObject({ url: 'https://school.test/img/notice-mobile.png', media: '(max-width: 640px)' });
      expect(one(facts, '#map')).toMatchObject({ technique: 'img', alt: 'Map', name: 'Map', description: 'Enter by the west gate.', describedBy: 'Enter by the west gate.' });
      expect(one(facts, '#map').linksNear?.[0]).toMatchObject({ text: 'Directions', href: 'https://school.test/directions', where: 'before' });
      const hero = one(facts, '#hero');
      expect(hero).toMatchObject({ technique: 'background', file: 'https://school.test/img/hero.jpg', ownText: 'Welcome back, families' });
      expect(hero.textOver).toContain('Welcome back, families');
      expect(one(facts, '#fb > svg')).toMatchObject({ technique: 'svg', controlName: '' });
      expect(one(facts, '#fb > svg').control).toMatchObject({ role: 'link', href: 'https://social.example/district' });
      const mask = by(facts, (p) => p.technique === 'mask')[0]!;
      expect(mask).toMatchObject({ file: 'https://school.test/img/menu.svg', control: { role: 'button' }, controlName: 'Open the menu' });
      expect(one(facts, '#tel')).toMatchObject({ technique: 'icon-glyph', glyph: 'U+F095' });
      expect(one(facts, '#pdf')).toMatchObject({ technique: 'pseudo', file: 'https://school.test/img/pdf.png' });
      expect(one(facts, '#chart')).toMatchObject({ technique: 'canvas', fallback: 'Enrollment rose from 410 to 455.' });
      expect(one(facts, '#obj')).toMatchObject({ technique: 'object', file: 'https://school.test/img/notice.svg', fallback: 'Notice' });
      expect(one(facts, '#gym')).toMatchObject({ technique: 'area', alt: 'Gym', shown: false });
      // The map's picture carries its areas (what each names and where it goes): it is reviewed through them.
      expect(by(facts, (p) => p.alt === 'Campus')[0]!.mapAreas).toEqual([{ alt: 'Gym', href: 'https://school.test/gym' }]);
      expect(one(facts, '#go')).toMatchObject({ technique: 'input-image', alt: 'Go' });
      expect(one(facts, '#star')).toMatchObject({ technique: 'role-img', ariaLabel: '4 out of 5 stars', name: '4 out of 5 stars' });
    } finally {
      await page.close();
    }
  }, 60_000);

  it('includes what is hidden from assistive technology or not shown, the shadow root and the same-origin frame, and the form around a picture', async () => {
    const { facts, page } = await collect();
    try {
      expect(one(facts, '#hidden')).toMatchObject({ hidden: 'aria-hidden', shown: true, name: '' });
      expect(one(facts, '#later')).toMatchObject({ shown: false, alt: 'banner', file: 'https://school.test/img/slide3.png' });
      expect(facts.pictures.find((p) => p.target.includes(' >>> ') && p.target.endsWith('#shadowed'))).toMatchObject({ technique: 'img', alt: '' });
      expect(facts.pictures.find((p) => p.target.includes(' |frame| '))).toMatchObject({ technique: 'img', file: 'https://school.test/img/inner.png' });
      const captcha = one(facts, '#captcha');
      expect(captcha.form?.controls.map((c) => c.role)).toEqual(expect.arrayContaining(['input text', 'button', 'input image']));
      expect(facts.imageDocuments).toEqual([expect.objectContaining({ href: 'https://school.test/files/Fall-Flyer.jpg', text: 'Fall flyer' })]);
      // A sprite sheet draws nothing of its own.
      expect(by(facts, (p) => p.technique === 'svg' && !p.shown)).toEqual([]);
      // Shown pictures come first.
      const firstHidden = facts.pictures.findIndex((p) => !p.shown);
      expect(facts.pictures.slice(firstHidden).every((p) => !p.shown)).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('crops the shown pictures as painted, the largest first, once per file and size', async () => {
    const { facts, page } = await collect();
    try {
      const cropped = facts.pictures.filter((p) => p.crop);
      expect(cropped.length).toBeGreaterThan(5);
      for (const p of cropped) expect([...p.crop!.slice(0, 2)]).toEqual([0xff, 0xd8]);
      expect(one(facts, '#later').crop).toBeUndefined();
    } finally {
      await page.close();
    }
  }, 60_000);

  it('cropPlan is pure: shown, big enough, largest first, one per file and size, capped', () => {
    const p = (n: number, w: number, h: number, file?: string, shown = true) => ({ n, shown, box: [0, 0, w, h] as [number, number, number, number], ...(file ? { file } : {}) });
    expect(cropPlan([p(0, 10, 10), p(1, 100, 50, 'a'), p(2, 100, 50, 'a'), p(3, 300, 300, 'b'), p(4, 400, 400, 'c', false)])).toEqual([3, 1]);
    expect(cropPlan(Array.from({ length: 40 }, (_, i) => p(i, 50 + i, 50, `f${i}`))).length).toBe(24);
  });
  it('zoomScaleFor is pure: a bitmap up to its own pixels, a drawing to the cap, an untold size to the cap, a large region not at all', () => {
    const box = (w: number, h: number): [number, number, number, number] => [0, 0, w, h];
    // A 600x800 flyer shown at 140x187: zooming finds up to 4.3 times the detail; the cap is 3.
    expect(zoomScaleFor({ technique: 'img', file: 'https://s.test/f.png', natural: [600, 800], box: box(140, 187) })).toEqual({ scale: 3 });
    // A 300x200 file shown at 200x100: the larger ratio (2) so neither axis loses detail.
    expect(zoomScaleFor({ technique: 'img', file: 'https://s.test/f.jpg', natural: [300, 200], box: box(200, 100) })).toEqual({ scale: 2 });
    // Shown at (or near) its own size: nothing finer to find.
    expect(zoomScaleFor({ technique: 'img', file: 'https://s.test/f.png', natural: [400, 300], box: box(400, 300) })).toEqual({ none: 'not finer' });
    expect(zoomScaleFor({ technique: 'img', file: 'https://s.test/f.png', natural: [440, 330], box: box(400, 300) })).toEqual({ none: 'not finer' });
    expect(zoomScaleFor({ technique: 'canvas', natural: [300, 150], box: box(300, 150) })).toEqual({ none: 'not finer' });
    // A drawing is sharp at any size: an SVG file (whatever its own size), inline svg, an icon glyph.
    expect(zoomScaleFor({ technique: 'img', file: 'https://s.test/map.svg?v=2', natural: [40, 40], box: box(400, 400) })).toEqual({ scale: 3 });
    expect(zoomScaleFor({ technique: 'img', file: 'data:image/svg+xml;utf8,<svg/>', natural: [10, 10], box: box(100, 100) })).toEqual({ scale: 3 });
    expect(zoomScaleFor({ technique: 'svg', box: box(24, 24) })).toEqual({ scale: 3 });
    expect(zoomScaleFor({ technique: 'icon-glyph', box: box(20, 20) })).toEqual({ scale: 3 });
    // A background whose file size the page does not tell: the cap.
    expect(zoomScaleFor({ technique: 'background', file: 'https://s.test/hero.jpg', box: box(300, 120) })).toEqual({ scale: 3 });
    // The longer side of the view stays within zoomPx (the crop's region: each side capped at cropMax).
    expect(zoomScaleFor({ technique: 'background', file: 'https://s.test/hero.jpg', box: box(1280, 400) })).toEqual({ scale: 1.6 });
    expect(zoomScaleFor({ technique: 'img', file: 'https://s.test/big.png', natural: [3600, 1000], box: box(1800, 500) })).toEqual({ none: 'large' });
    expect(zoomScaleFor({ technique: 'img', file: 'https://s.test/tall.png', natural: [600, 9000], box: box(300, 4500) })).toEqual({ none: 'large' });
    expect(PICTURES_LIMITS.zoomMax).toBe(3);
  });
});

/** Pixel statistics of a JPEG, read by the browser: size, mean channels, and the share of pixels near black or white. */
async function pixels(bytes: Uint8Array): Promise<{ w: number; h: number; r: number; g: number; b: number; extreme: number }> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async (b64: string) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d')!;
      x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      let r = 0; let g = 0; let b = 0; let extreme = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i]!; g += d[i + 1]!; b += d[i + 2]!;
        const l = (d[i]! + d[i + 1]! + d[i + 2]!) / 3;
        if (l < 60 || l > 195) extreme++;
      }
      return { w: c.width, h: c.height, r: r / n, g: g / n, b: b / n, extreme: extreme / n };
    }, Buffer.from(bytes).toString('base64'));
  } finally {
    await page.close();
  }
}

describe('the zoomed view (the lead\'s ruling, 2026-11-13: what zooming can reveal, never what the page crops away)', () => {
  /** PNG bytes drawn by the browser: 2-px black and white stripes, or two colour halves. */
  async function png(kind: 'stripes' | 'halves', w: number, h: number): Promise<Buffer> {
    const page = await browser.newPage();
    try {
      const url = await page.evaluate(([k, ww, hh]) => {
        const c = document.createElement('canvas');
        c.width = ww as number; c.height = hh as number;
        const x = c.getContext('2d')!;
        if (k === 'stripes') {
          x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#000';
          for (let i = 0; i < c.width; i += 4) x.fillRect(i, 0, 2, c.height);
        } else {
          x.fillStyle = '#0000ff'; x.fillRect(0, 0, c.width / 2, c.height);
          x.fillStyle = '#ff0000'; x.fillRect(c.width / 2, 0, c.width / 2, c.height);
        }
        return c.toDataURL('image/png');
      }, [kind, w, h] as const);
      return Buffer.from(url.split(',')[1]!, 'base64');
    } finally {
      await page.close();
    }
  }

  it('draws the shown region again from the file: finer detail where the file has it, nothing cropped away, no request', async () => {
    const stripes = await png('stripes', 300, 300);
    const halves = await png('halves', 400, 200);
    const plain = await png('halves', 60, 60);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const requests: string[] = [];
    try {
      await page.route('https://zoom.test/**', async (r) => {
        const u = new URL(r.request().url());
        if (u.pathname === '/') await r.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><title>Zoom</title></head><body style="margin:0">
<img id="fine" src="/stripes.png" alt="" style="display:block;width:100px;height:100px">
<img id="exact" src="/plain.png" alt="" style="display:block;width:60px;height:60px">
<svg id="vec" width="40" height="40" style="display:block"><rect width="40" height="40" fill="#0b4f6c"/></svg>
<div style="height:1600px"></div>
<img id="covered" src="/halves.png" alt="" style="display:block;width:100px;height:100px;object-fit:cover;object-position:left center">
</body></html>` });
        else await r.fulfill({ contentType: 'image/png', body: u.pathname === '/stripes.png' ? stripes : u.pathname === '/halves.png' ? halves : plain });
      });
      await page.goto('https://zoom.test/');
      await page.waitForTimeout(200);
      page.on('request', (r) => requests.push(r.url()));
      const session = await page.context().newCDPSession(page);
      const facts = await picturesCollector.collect(page as unknown as PageLike, { url: page.url(), viewport: 'desktop', cdp: async () => session as never });
      expect(requests).toEqual([]);

      // 2-px stripes shown at a third of their size: the crop is a grey blur, the zoom (3x) shows the stripes.
      const fine = one(facts, '#fine');
      expect(fine).toMatchObject({ natural: [300, 300], zoomScale: 3 });
      const crop = await pixels(fine.crop!);
      const zoom = await pixels(fine.zoom!);
      expect([crop.w, zoom.w]).toEqual([100, 300]);
      expect(zoom.extreme).toBeGreaterThan(0.6);
      expect(crop.extreme).toBeLessThan(0.3);

      // object-fit: cover keeps the left (blue) half; the zoom is that region only, never the red half the page crops away.
      const covered = one(facts, '#covered');
      expect(covered.zoomScale).toBe(3);
      const cz = await pixels(covered.zoom!);
      expect(cz.w).toBe(300);
      expect(cz.b).toBeGreaterThan(200);
      expect(cz.r).toBeLessThan(40);

      // Shown at its own size: no zoom, and why.
      const exact = one(facts, '#exact');
      expect(exact.crop).toBeTruthy();
      expect(exact.zoom).toBeUndefined();
      expect(exact.zoomNote).toBe('not finer');
      // A drawing: sharp at the cap.
      const vec = one(facts, '#vec');
      expect(vec.zoomScale).toBe(3);
      expect((await pixels(vec.zoom!)).w).toBe(120);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('without a browser session the crops stay and every zoom says why it is missing', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent('<!doctype html><html lang="en"><head><title>x</title></head><body><svg id="vec" width="40" height="40"><rect width="40" height="40" fill="#0b4f6c"/></svg></body></html>');
      const facts = await picturesCollector.collect(page as unknown as PageLike, { url: 'https://x.test/', viewport: 'desktop' });
      const vec = facts.pictures.find((p) => p.technique === 'svg')!;
      expect(vec.crop).toBeTruthy();
      expect(vec).toMatchObject({ zoomNote: 'no session' });
      expect(vec.zoom).toBeUndefined();
    } finally {
      await page.close();
    }
  }, 60_000);
});
