// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Live screenshots for the live scan view (ScanOptions.liveShots): one first-screen JPEG per loaded
// width, sent to the sink before that width's viewport-done, which then carries `shot`. Observation
// only: the report is the same with or without it. Never a shot of a page that failed or was refused.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditPage } from '../../src/audit.js';
import { LIVE_SHOT_LIMITS, captureLiveShot, jpegSize } from '../../src/liveShot.js';
import { defaultAxeSource, scanSite, type ScanOptions } from '../../src/scan.js';
import type { BrowserLike, PageLike, ScanEvent, SiteReport } from '../../src/types.js';
import { OTHER_SITE } from '../../src/landing.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let axeSource: string;
const NOW = () => new Date('2026-11-01T12:00:00.000Z');
type Done = Extract<ScanEvent, { type: 'viewport-done' }>;

const allowUrl = async (u: string) => !u.includes('refused');
const scan = (extra: Partial<ScanOptions> = {}) =>
  scanSite(`${server.origin}/`, { browser: browser as unknown as BrowserLike, maxPages: 10, probes: false, documents: false, now: NOW, allowUrl, ...extra });

let plain: SiteReport;
let withShots: SiteReport;
let events: ScanEvent[];
const sunk = new Map<string, Uint8Array>();
let sinkCalls = 0;

beforeAll(async () => {
  server = await startFixtureServer('liveshots', {
    // A page that redirects to an address the scan refuses: it must never be pictured.
    '/hop.html': { type: 'text/html', status: 302, headers: { location: '/refused.html' } },
    '/refused.html': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>Refused</title><h1>Refused</h1>' },
  });
  browser = await chromium.launch();
  axeSource = await defaultAxeSource();
  plain = await scan();
  events = [];
  withShots = await scan({
    onEvent: (e) => events.push(e),
    liveShots: { sink: (id, jpeg) => { sinkCalls++; sunk.set(id, jpeg.slice()); } },
  });
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const path = (u: string) => new URL(u).pathname;
const dones = () => events.filter((e): e is Done => e.type === 'viewport-done');

/** The colour of one image pixel, read in a real browser (no JPEG decoder in the engine). */
async function pixel(jpeg: Uint8Array, x: number, y: number): Promise<[number, number, number]> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ({ b64, x, y }) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(x, y, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!] as [number, number, number];
    }, { b64: Buffer.from(jpeg).toString('base64'), x: Math.round(x), y: Math.round(y) });
  } finally {
    await page.close();
  }
}

describe('live shots in a scan', () => {
  it('selects the pages: three load, one is missing, one redirects to a refused address', () => {
    expect(withShots.pages.map((p) => [path(p.url), p.status]).sort()).toEqual([
      ['/', 'ok'], ['/hop.html', 'failed'], ['/long.html', 'ok'], ['/missing.html', 'failed'], ['/smooth.html', 'ok'],
    ]);
  });

  it('the sink gets one JPEG per loaded width, and that width\'s viewport-done carries it', () => {
    const loaded = dones().filter((e) => e.checks > 0);
    expect(loaded).toHaveLength(6);
    expect(sinkCalls).toBe(6);
    const ids = loaded.map((e) => e.shot?.id);
    expect(new Set(ids).size).toBe(6);
    expect(new Set(sunk.keys())).toEqual(new Set(ids));
    for (const e of loaded) expect(e.shot!.id).toBe(`${e.index}-${e.viewport}`);
  });

  it('never a shot of a page that failed to load or was refused', () => {
    const failed = dones().filter((e) => ['/missing.html', '/hop.html'].includes(path(e.url)));
    expect(failed).toHaveLength(4);
    for (const e of failed) expect(e.shot).toBeUndefined();
    const failedIds = failed.map((e) => `${e.index}-${e.viewport}`);
    for (const id of failedIds) expect(sunk.has(id)).toBe(false);
  });

  it('first screen only, downscaled: 960 × 675 desktop, 390 × 844 phone, small JPEGs whose header matches', () => {
    for (const e of dones().filter((x) => x.shot)) {
      const jpeg = sunk.get(e.shot!.id)!;
      expect(jpeg[0]).toBe(0xff);
      expect(jpeg[1]).toBe(0xd8);
      expect(jpeg.byteLength).toBeLessThanOrEqual(LIVE_SHOT_LIMITS.maxBytes);
      expect(jpegSize(jpeg)).toEqual({ w: e.shot!.w, h: e.shot!.h });
      expect([e.shot!.w, e.shot!.h]).toEqual(e.viewport === 'desktop' ? [960, 675] : [390, 844]);
    }
  });

  it('the wireframe maps onto the shot: scale = shot.w / wireframe.W, from the top of the page', async () => {
    const home = dones().filter((e) => path(e.url) === '/');
    expect(home).toHaveLength(2);
    for (const e of home) {
      const { W } = e.wireframe;
      expect(W).toBe(e.viewport === 'desktop' ? 1280 : 390);
      const s = e.shot!.w / W;
      const red = e.wireframe.els.filter((el) => el.rule === 'image-alt' && el.w === 200);
      expect(red).toHaveLength(1);
      const r = red[0]!;
      // The failing image is red where the wireframe puts it, and white just right of it.
      const inside = await pixel(sunk.get(e.shot!.id)!, (r.x + r.w / 2) * s, (r.y + r.h / 2) * s);
      expect(inside[0]).toBeGreaterThan(180);
      expect(inside[1]).toBeLessThan(80);
      const beside = await pixel(sunk.get(e.shot!.id)!, Math.min(e.shot!.w - 1, (r.x + r.w + 30) * s), (r.y + r.h / 2) * s);
      expect(beside.every((c) => c > 200)).toBe(true);
    }
  });

  it('a page that scrolled itself down (smooth scrolling) is pictured from the top', async () => {
    const smooth = dones().find((e) => path(e.url) === '/smooth.html' && e.viewport === 'desktop')!;
    const h1 = smooth.wireframe.els.find((el) => el.t === 'h1')!;
    expect(h1.y).toBeLessThan(100);
    const s = smooth.shot!.w / smooth.wireframe.W;
    // The heading's text is dark on white: some pixel in its box is dark.
    const jpeg = sunk.get(smooth.shot!.id)!;
    let darkest = 255;
    for (let dx = 4; dx < Math.min(h1.w, 300); dx += 6) darkest = Math.min(darkest, ...(await pixel(jpeg, (h1.x + dx) * s, (h1.y + h1.h / 2) * s)));
    expect(darkest).toBeLessThan(120);
  });

  it('is observation only: the report is the same with or without shots', () => {
    expect(withShots).toEqual(plain);
  });
});

describe('live shots are bounded and never break the scan', () => {
  it('no listener: no shot is taken', async () => {
    let calls = 0;
    const r = await scan({ liveShots: { sink: () => { calls++; } } });
    expect(calls).toBe(0);
    expect(r).toEqual(plain);
  });

  it('a sink that throws or rejects: viewport-done without shot, the same report', async () => {
    for (const sink of [() => { throw new Error('put failed'); }, async () => { throw new Error('put failed'); }]) {
      const seen: ScanEvent[] = [];
      const r = await scan({ onEvent: (e) => seen.push(e), liveShots: { sink } });
      expect(r).toEqual(plain);
      const vd = seen.filter((e): e is Done => e.type === 'viewport-done');
      expect(vd.length).toBe(10);
      expect(vd.every((e) => e.shot === undefined)).toBe(true);
    }
  }, 120_000);

  it('a sink that never answers: the width carries on without its shot after the sink time', async () => {
    const seen: Done[] = [];
    const started = Date.now();
    await auditPage(browser as unknown as BrowserLike, `${server.origin}/long.html`, {
      userAgent: 'grnted-test', axeSource, onEvent: (e) => { if (e.type === 'viewport-done') seen.push(e); },
      liveShots: { sink: () => new Promise<void>(() => {}), sinkTimeoutMs: 300 },
    });
    expect(seen).toHaveLength(2);
    expect(seen.every((e) => e.checks > 0 && e.shot === undefined)).toBe(true);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it('a JPEG over the byte cap (after one lower-quality try) is dropped', async () => {
    const got: string[] = [];
    const seen: Done[] = [];
    await auditPage(browser as unknown as BrowserLike, `${server.origin}/noise.html`, {
      userAgent: 'grnted-test', axeSource, onEvent: (e) => { if (e.type === 'viewport-done') seen.push(e); },
      liveShots: { sink: (id) => { got.push(id); }, maxBytes: 4000 },
    });
    expect(got).toEqual([]);
    expect(seen.every((e) => e.checks > 0 && e.shot === undefined)).toBe(true);
  }, 60_000);

  it('captureLiveShot: a page that never answers gives no shot, within its time box', async () => {
    const hung = { evaluate: () => new Promise(() => {}), screenshot: () => new Promise(() => {}) } as unknown as PageLike;
    const started = Date.now();
    expect(await captureLiveShot(hung, undefined, 'desktop', { timeoutMs: 200 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('captureLiveShot: a screenshot that fails or returns something other than a JPEG gives no shot', async () => {
    const measured = { evaluate: async () => ({ w: 1280, h: 900, x: 0, y: 0 }) };
    const failing = { ...measured, screenshot: () => Promise.reject(new Error('Target closed')) } as unknown as PageLike;
    expect(await captureLiveShot(failing, undefined, 'desktop')).toBeNull();
    const png = { ...measured, screenshot: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) } as unknown as PageLike;
    expect(await captureLiveShot(png, undefined, 'desktop')).toBeNull();
  });

  it('captureLiveShot: a page that stays scrolled down gives no shot (its boxes would not line up)', async () => {
    const stuck = { evaluate: async () => ({ w: 1280, h: 900, x: 0, y: 400 }), screenshot: async () => new Uint8Array() } as unknown as PageLike;
    expect(await captureLiveShot(stuck, undefined, 'desktop')).toBeNull();
  });
});

// A page that replaces itself is audited where it lands, as a visitor sees it (src/landing.ts): the shot is
// always of the document the audit measured, never of another.
describe('never a shot of a document other than the one audited', () => {
  let other: Awaited<ReturnType<typeof startFixtureServer>>;
  let site: Awaited<ReturnType<typeof startFixtureServer>>;
  beforeAll(async () => {
    other = await startFixtureServer('liveshots');
    const otherHost = other.origin.replace('127.0.0.1', 'localhost');
    const html = (head: string, body = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Moving page</title>${head}</head><body><main><h1>This page moves</h1><p><a href="/moving-only.html">Only on the moving page</a></p>${body}</main></body></html>`;
    site = await startFixtureServer('liveshots', {
      // 200, then a refresh onto a 404 page 1 s after load, while the page settles: it lands on the 404.
      '/refresh.html': { type: 'text/html; charset=utf-8', body: html('<meta http-equiv="refresh" content="1;url=/missing.html">') },
      // 200, then a script sends the page to another (public) host 300 ms after it starts.
      '/away.html': { type: 'text/html; charset=utf-8', body: html('', `<script>setTimeout(() => { location.href = '${otherHost}/long.html'; }, 300);</script>`) },
      // 200, then a redirect by script 600 ms after load to a page that takes 1.5 s to answer.
      '/away-slow.html': { type: 'text/html; charset=utf-8', body: html('', `<script>addEventListener('load', () => setTimeout(() => { location.href = '/slow-landing.html'; }, 600));</script>`) },
      '/slow-landing.html': { type: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Landed late</title></head><body><main><h1>Landed late</h1></main></body></html>' },
    }, { delayMs: (path) => (path === '/slow-landing.html' ? 1500 : 0) });
  });
  afterAll(async () => {
    await site?.close();
    await other?.close();
  });

  const audited = async (path: string) => {
    const got: string[] = [];
    const seen: Done[] = [];
    const page = await auditPage(browser as unknown as BrowserLike, `${site.origin}${path}`, {
      userAgent: 'grnted-test', axeSource, onEvent: (e) => { if (e.type === 'viewport-done') seen.push(e); },
      liveShots: { sink: (id) => { got.push(id); } },
    });
    return { page, got, seen };
  };

  it('/refresh.html: it lands on a 404, so the page did not load, and no shot is taken', async () => {
    const { page, got, seen } = await audited('/refresh.html');
    expect([page.status, page.reason]).toEqual(['failed', 'HTTP 404']);
    expect(seen).toHaveLength(2);
    expect(seen.every((e) => e.shot === undefined)).toBe(true);
    expect(got).toEqual([]);
  }, 60_000);

  it('/away.html: it goes to another site (another host), so the page did not load, and no shot is taken', async () => {
    const { page, got, seen } = await audited('/away.html');
    expect([page.status, page.reason]).toEqual(['failed', OTHER_SITE]);
    expect(seen.every((e) => e.shot === undefined)).toBe(true);
    expect(got).toEqual([]);
  }, 60_000);

  it('/away-slow.html: audited where it landed on the same site, and any shot is of that page', async () => {
    const { page, got, seen } = await audited('/away-slow.html');
    expect(page.status).toBe('ok');
    // The landing page has no links: the moving page's link is not in the audit.
    expect(page.links).toEqual([]);
    expect(seen).toHaveLength(2);
    expect(got.length).toBe(seen.filter((e) => e.shot).length);
  }, 60_000);
});

describe('jpegSize', () => {
  it('reads a baseline or progressive JPEG header and refuses anything else', () => {
    const sof = (marker: number, h: number, w: number) => new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, marker, 0x00, 0x0b, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x01, 0x01, 0x11, 0x00,
    ]);
    expect(jpegSize(sof(0xc0, 450, 640))).toEqual({ w: 640, h: 450 });
    expect(jpegSize(sof(0xc2, 844, 390))).toEqual({ w: 390, h: 844 });
    expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(jpegSize(sof(0xc0, 0, 640))).toBeNull();
  });
});
