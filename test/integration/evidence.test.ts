// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The evidence pass (report v2, spec §3.2) on local fixture pages only.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureEvidence, captureEvidenceResults } from '../../src/evidence/capture.js';
import { createPace } from '../../src/pace.js';
import { jpegSize } from '../../src/probes/evidence.js';
import { decodePng } from '../../src/probes/pixels.js';
import { scanSite } from '../../src/scan.js';
import type { AiReport, AiScanPlan, BrowserLike, ContextLike, EvidenceShot, PageLike, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer('evidence');
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

type ShotCall = { type?: string; clip?: { x: number; y: number; width: number; height: number } };
/**
 * The real browser, counting every screenshot. With `withPng`, each clipped JPEG is followed by a PNG
 * of the same clip (decodable here), kept by the JPEG's bytes.
 */
function spy(b: Browser, opts: { withPng?: boolean } = {}) {
  const calls: ShotCall[] = [];
  const pngs: { jpeg: Uint8Array; png: Uint8Array }[] = [];
  const wrapPage = (p: PageLike): PageLike => new Proxy(p, {
    get(target, key) {
      if (key === 'screenshot') {
        return async (o: ShotCall & Record<string, unknown> = {}) => {
          calls.push(o);
          const jpeg = await target.screenshot(o as never);
          if (opts.withPng && o.clip) pngs.push({ jpeg, png: await target.screenshot({ type: 'png', clip: o.clip }) });
          return jpeg;
        };
      }
      const v = Reflect.get(target, key) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const wrapCtx = (c: ContextLike): ContextLike => new Proxy(c, {
    get(target, key) {
      if (key === 'newPage') return async () => wrapPage(await target.newPage());
      const v = Reflect.get(target, key) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const real = b as unknown as BrowserLike;
  const wrapped: BrowserLike = { newContext: async (o) => wrapCtx(await real.newContext(o)) };
  return { browser: wrapped, calls, pngFor: (jpeg: Uint8Array) => pngs.find((x) => Buffer.from(x.jpeg).equals(Buffer.from(jpeg)))?.png };
}

const memorySink = () => {
  const images = new Map<string, Uint8Array>();
  return { images, sink: (id: string, jpeg: Uint8Array) => { images.set(id, jpeg); } };
};
const path = (u: string) => new URL(u).pathname;
/** The planted element's box: 160x70 at 24 px padding, give or take the sub-pixel rounding (inwards). */
function expectPlantedBox(b: { x: number; y: number; width: number; height: number; kind: string } | undefined): void {
  expect(b?.kind).toBe('fail');
  for (const [v, want] of [[b!.x, 24], [b!.y, 24], [b!.width, 160], [b!.height, 70]] as const) expect(Math.abs(v - want)).toBeLessThanOrEqual(1);
}

describe('evidence pass in scanSite', () => {
  let report: SiteReport;
  let mem: ReturnType<typeof memorySink>;
  let s: ReturnType<typeof spy>;

  beforeAll(async () => {
    mem = memorySink();
    s = spy(browser, { withPng: true });
    // A stand-in AI review that flags the second page's image (no model involved).
    const ai: AiScanPlan = {
      collectors: [],
      onPageAudited: () => undefined,
      finish: async ({ site }): Promise<AiReport> => ({
        disclaimer: '',
        runs: [{
          check: 'altText', title: 'Alt text', summary: '', model: 'stub', promptVersion: 'x', tier: 'core', inputs: 1, reviewed: 1, cached: 0, notReviewed: 0,
          findings: [{
            check: 'altText', criterion: '1.1.1', page: new URL('/two.html', site).href, target: new URL('/pic.svg', site).href, verdict: 'missing_description',
            label: 'Missing description', flagged: true, confidence: 'high', observed: 'A grey square with a dark border.', issue: '', suggestion: '', source: 'ai',
          }],
        }],
      }),
    };
    report = await scanSite(`${server.origin}/`, { browser: s.browser, maxPages: 5, probes: false, documents: false, ai, evidence: { sink: mem.sink } });
  }, 120_000);

  it('records the start page first, then each failing rule once, then the AI thumbnail', () => {
    const shots = report.evidence!;
    expect(shots.map((x) => x.id)).toEqual(shots.map((_, i) => `e${i + 1}`));
    // The start page at desktop (the whole 1280×900 viewport) and on a phone (390×844 at 2×), Task 5.10.
    expect(shots[0]).toMatchObject({ for: { rule: '$start' }, width: 1280, height: 900, viewport: { width: 1280, height: 900, deviceScaleFactor: 1 } });
    expect(shots[1]).toMatchObject({ for: { rule: '$start' }, width: 390, height: 844, viewport: { width: 390, height: 844, deviceScaleFactor: 2 } });
    expect(path(shots[0]!.page)).toBe('/');
    expect(path(shots[1]!.page)).toBe('/');
    const rules = shots.filter((x) => 'rule' in x.for && x.for.rule !== '$start').map((x) => (x.for as { rule: string }).rule);
    expect(new Set(rules).size).toBe(rules.length);
    expect(rules).toEqual(expect.arrayContaining(['link-name', 'image-alt']));
    const last = shots[shots.length - 1]!;
    expect(last.for).toEqual({ ai: `${server.origin}/pic.svg` });
    expect([path(last.page), last.width, last.height, last.boxes]).toEqual(['/two.html', 120, 90, []]);
    // Alt text from the AI's description (the image has none of its own), never the file name.
    expect(last.alt).toBe('Page /two.html: an image the AI review flagged; the AI describes it as “A grey square with a dark border”');
    expect(last.alt).not.toMatch(/pic|svg|http/);
    // The sink got every image under its id; the JSON has metadata only.
    expect([...mem.images.keys()]).toEqual(shots.map((x) => x.id));
    for (const bytes of mem.images.values()) expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    expect(JSON.stringify(report)).not.toContain('base64');
    // Before `meta` in the JSON.
    const keys = Object.keys(report);
    expect(keys.indexOf('evidence')).toBeLessThan(keys.indexOf('meta'));
  });

  it('boxes the failing element far down the page: the box lies inside its painted area', async () => {
    const shot = report.evidence!.find((x) => 'rule' in x.for && x.for.rule === 'link-name')!;
    expect(path(shot.page)).toBe('/far.html');
    expect(shot.boxes).toHaveLength(1);
    const box = shot.boxes[0]!;
    expectPlantedBox(box);
    expect(box.label).toBeUndefined();
    // The element the box outlines, as the scan looked it up (report v3 pins a box to its cause).
    const rule = report.rules.find((r) => r.id === 'link-name')!;
    expect(rule.examples.map((e) => e.target)).toContain(box.target);
    // 24 px padding on every side: the element sits away from the page's edges.
    expect(Math.abs(shot.width - 208)).toBeLessThanOrEqual(1);
    expect(Math.abs(shot.height - 118)).toBeLessThanOrEqual(1);
    expect(shot.alt).toMatch(/^Page \/far\.html: 1 element outlined that fails “.+”$/);
    // Where the picture sits on the page (document px), for a rescan's before and after: 3000 px down, 300 px in, less the padding.
    expect(shot.area).toBeDefined();
    expect(Math.abs(shot.area!.x - 276)).toBeLessThanOrEqual(2);
    expect(shot.area!.y).toBeGreaterThan(3000);
    expect(shot.area!.y).toBeLessThan(3150);
    expect([shot.area!.width, shot.area!.height]).toEqual([shot.width, shot.height]);
    expect(report.evidence![0]!.area).toEqual({ x: 0, y: 0, width: 1280, height: 900 });
    expect(shot.alt).not.toContain('link-name');
    const png = await decodePng(s.pngFor(mem.images.get(shot.id)!)!);
    expect([png.width, png.height]).toEqual([shot.width, shot.height]);
    let magenta = 0;
    let total = 0;
    for (let y = box.y + 2; y < box.y + box.height - 2; y++) {
      for (let x = box.x + 2; x < box.x + box.width - 2; x++) {
        const i = (y * png.width + x) * 4;
        total++;
        if (png.data[i]! > 230 && png.data[i + 1]! < 30 && png.data[i + 2]! > 230) magenta++;
      }
    }
    expect(magenta / total).toBeGreaterThan(0.98);
    // And the padding outside the box is page background, not magenta.
    const i = (2 * png.width + 2) * 4;
    expect(png.data[i + 1]).toBeGreaterThan(200);
  });

  it('takes JPEGs at quality 72, never larger than 1280x900', () => {
    const jpegCalls = s.calls.filter((c) => c.type === 'jpeg');
    expect(jpegCalls.length).toBe(report.evidence!.length);
    for (const c of jpegCalls) {
      expect(c).toMatchObject({ type: 'jpeg', quality: 72 });
      // The start shots take the whole viewport (no clip): 1280×900 or 390×844.
      if (!c.clip) continue;
      expect(c.clip.width).toBeLessThanOrEqual(1280);
      expect(c.clip.height).toBeLessThanOrEqual(900);
    }
    expect(jpegCalls.filter((c) => !c.clip)).toHaveLength(2);
  });
});

describe('evidence pass limits and failures', () => {
  it('takes no screenshot at all without a sink', async () => {
    const s = spy(browser);
    const report = await scanSite(`${server.origin}/`, { browser: s.browser, maxPages: 5, probes: false, documents: false });
    expect(s.calls).toHaveLength(0);
    expect(report.evidence).toBeUndefined();
  }, 60_000);

  it('holds the cap', async () => {
    const mem = memorySink();
    const report = await scanSite(`${server.origin}/`, { browser: browser as unknown as BrowserLike, maxPages: 5, probes: false, documents: false, evidence: { sink: mem.sink, maxImages: 3 } });
    // The two start shots count toward the cap.
    expect(report.evidence!.map((x) => [x.for, x.viewport.width])).toEqual([[{ rule: '$start' }, 1280], [{ rule: '$start' }, 390], [{ rule: report.rules[0]!.id }, 1280]]);
    expect(mem.images.size).toBe(3);
  }, 60_000);

  it('skips hostile, missing and zero-size targets without an error, and boxes the rest', async () => {
    const hostile = 'a[href="x"]\'),alert(1)//';
    const page = `${server.origin}/far.html`;
    const shots = await captureEvidence(browser as unknown as BrowserLike, [
      { kind: 'rule', page, rule: 'link-name', help: 'Links must have discernible text', targets: [hostile, '#nope', '#zero', '#hit', '<>{}'] },
      { kind: 'rule', page, rule: 'x', help: 'x', targets: [hostile, '#zero', 'iframe >>> a'] },
      { kind: 'ai', page, check: 'altText', target: `${server.origin}/nowhere.png` },
    ], { userAgent: 'test' });
    expect(shots[0]?.shot.boxes).toHaveLength(1);
    expectPlantedBox(shots[0]?.shot.boxes[0]);
    expect(shots[1]).toBeNull();
    expect(shots[2]).toBeNull();
  }, 60_000);

  it('a reload under the site\'s crawl delay, while other loads keep the gap busy, still gets its picture', async () => {
    // As on a site with robots.txt Crawl-delay while the probes load pages: four loaders that always
    // wait for the next gap. The picture's reload has half its page time (here 1.5 s) to get a turn.
    const pace = createPace({ concurrency: 6 });
    pace.setCrawlDelay(new URL(server.origin).host, 0.4);
    let stop = false;
    const busy = async () => { while (!stop) await pace.load(`${server.origin}/two.html`, async () => ({ status: 200 }), (a) => a); };
    const loaders = [busy(), busy(), busy(), busy()];
    await new Promise((r) => setTimeout(r, 50));
    try {
      const [r] = await captureEvidenceResults(browser as unknown as BrowserLike, [
        { kind: 'rule', page: `${server.origin}/far.html`, rule: 'link-name', help: 'Links must have discernible text', targets: ['#hit'] },
      ], { userAgent: 'test', pace, timeouts: { pageBudgetMs: 3000 } });
      expect(r!.missed).toBeUndefined();
      expect(r!.shot?.shot.boxes).toHaveLength(1);
    } finally {
      stop = true;
      await Promise.all(loaders);
    }
  }, 60_000);

  it('a reload the site refuses says why there is no picture', async () => {
    const pace = createPace({ concurrency: 6, deadline: Date.now() + 200 });
    pace.setCrawlDelay(new URL(server.origin).host, 5);
    await pace.load(`${server.origin}/two.html`, async () => ({ status: 200 }), (a) => a);
    const [r] = await captureEvidenceResults(browser as unknown as BrowserLike, [
      { kind: 'rule', page: `${server.origin}/far.html`, rule: 'link-name', help: 'x', targets: ['#hit'] },
    ], { userAgent: 'test', pace });
    expect(r!.shot).toBeNull();
    expect(r!.missed).toBe('the page could not be loaded again for its picture (the site’s robots.txt asks for a pause between pages, and there was no time left in the scan for it)');
  }, 60_000);

  it('an AI thumbnail of an image with alt text uses that alt text, never the file name', async () => {
    const [got] = await captureEvidence(browser as unknown as BrowserLike, [
      { kind: 'ai', page: `${server.origin}/two.html`, check: 'altText', target: `${server.origin}/pic.svg?named`, observed: 'A grey square.' },
    ], { userAgent: 'test' });
    expect(got!.shot.alt).toBe('Page /two.html: the image with the alt text “Grey square, the site\'s logo”, which the AI review flagged');
    expect([got!.shot.width, got!.shot.height]).toEqual([60, 45]);
  }, 60_000);

  it('a scored AI image (scoring v5) is pictured with room around it and a box on it; an unscored one is not boxed', async () => {
    const item = { kind: 'ai' as const, page: `${server.origin}/two.html`, check: 'altText', target: `${server.origin}/pic.svg?named`, observed: 'A grey square.' };
    const [plain, scored] = await captureEvidence(browser as unknown as BrowserLike, [item, { ...item, scored: true }], { userAgent: 'test' });
    expect(plain!.shot.boxes).toEqual([]);
    const shot = scored!.shot;
    expect(shot.for).toEqual({ ai: item.target });
    expect(shot.boxes).toHaveLength(1);
    const b = shot.boxes[0]!;
    expect(Math.abs(b.width - 60)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.height - 45)).toBeLessThanOrEqual(1);
    expect(b.x).toBeGreaterThan(0);
    expect(shot.width).toBeGreaterThan(60);
    expect(b.x + b.width).toBeLessThanOrEqual(shot.width);
    expect(b.y + b.height).toBeLessThanOrEqual(shot.height);
  }, 60_000);

  it('a small target at the top and two big ones far down: the image boxes the two big ones', async () => {
    const page = `${server.origin}/cards.html`;
    const [got] = await captureEvidence(browser as unknown as BrowserLike, [
      { kind: 'rule', page, rule: 'label-content-name-mismatch', help: 'Name must contain the visible text', targets: ['#logo', '#card1', '#card2'] },
    ], { userAgent: 'test' });
    const shot = got!.shot;
    expect(shot.boxes).toHaveLength(2);
    expect(shot.alt).toMatch(/^Page \/cards\.html: 2 elements outlined that fail/);
    for (const b of shot.boxes) {
      expect(Math.abs(b.width - 380)).toBeLessThanOrEqual(1);
      expect(Math.abs(b.height - 500)).toBeLessThanOrEqual(1);
      expect(b.x + b.width).toBeLessThanOrEqual(shot.width);
      expect(b.y + b.height).toBeLessThanOrEqual(shot.height);
    }
    // Side by side, 40 px apart, with 24 px padding around them.
    expect(Math.abs(shot.boxes[1]!.x - shot.boxes[0]!.x - 420)).toBeLessThanOrEqual(1);
    expect(shot.width).toBeLessThanOrEqual(1280);
    expect(shot.height).toBeLessThanOrEqual(900);
    expect(Math.abs(shot.width - 848)).toBeLessThanOrEqual(1);
    expect(Math.abs(shot.height - 548)).toBeLessThanOrEqual(1);
  }, 60_000);
});

describe('phone pictures (Task 5.10)', () => {
  let phone: Awaited<ReturnType<typeof startFixtureServer>>;
  let report: SiteReport;
  let mem: ReturnType<typeof memorySink>;
  beforeAll(async () => {
    phone = await startFixtureServer('phone');
    mem = memorySink();
    report = await scanSite(`${phone.origin}/`, { browser: browser as unknown as BrowserLike, maxPages: 1, probes: false, documents: false, evidence: { sink: mem.sink } });
  }, 120_000);
  afterAll(async () => phone?.close());

  const start = (width: number) => report.evidence!.find((x) => 'rule' in x.for && x.for.rule === '$start' && x.viewport.width === width)!;
  const problems = (shot: EvidenceShot) => [...new Set(shot.boxes.map((b) => b.problem))].sort();

  it('the audit found the three planted problems', () => {
    expect(report.rules.map((r) => r.id)).toEqual(expect.arrayContaining(['image-alt', 'link-name', 'button-name']));
  });

  it('takes the phone start shot at 390×844, 2× pixels: a JPEG of 780×1688', () => {
    const shot = start(390);
    expect(shot).toMatchObject({ width: 390, height: 844, viewport: { width: 390, height: 844, deviceScaleFactor: 2 } });
    expect(shot.alt).toBe('Home page as it first appears on a phone screen, with 2 problems outlined');
    expect(jpegSize(mem.images.get(shot.id)!)).toEqual({ width: 780, height: 1688 });
  });

  it('boxes each start page failure at the width it fails at, keyed by problem, inside the image and on the element', () => {
    const desk = start(1280);
    const mob = start(390);
    expect([desk.width, desk.height]).toEqual([1280, 900]);
    expect(problems(desk)).toEqual(['rule:image-alt', 'rule:link-name']);
    expect(problems(mob)).toEqual(['rule:button-name', 'rule:image-alt']);
    for (const shot of [desk, mob]) {
      for (const b of shot.boxes) {
        expect(b.kind).toBe('fail');
        expect(b.label).toBeUndefined();
        expect(b.target, 'the element the box outlines').toEqual(expect.any(String));
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width).toBeLessThanOrEqual(shot.width);
        expect(b.y + b.height).toBeLessThanOrEqual(shot.height);
      }
    }
    const size = (shot: EvidenceShot, key: string) => {
      const b = shot.boxes.find((x) => x.problem === key)!;
      return [Math.round(b.width), Math.round(b.height)];
    };
    // The planted elements' sizes, give or take the sub-pixel rounding (inwards).
    const near = (got: number[], want: number[]) => got.forEach((v, i) => expect(Math.abs(v - want[i]!)).toBeLessThanOrEqual(1));
    near(size(desk, 'rule:image-alt'), [120, 90]);
    near(size(desk, 'rule:link-name'), [200, 60]);
    near(size(mob, 'rule:image-alt'), [120, 90]);
    near(size(mob, 'rule:button-name'), [160, 50]);
  });

  it('pictures a rule that fails only on a phone at 390 px, and the others at desktop width', () => {
    const pic = (id: string) => report.evidence!.find((x) => 'rule' in x.for && x.for.rule === id)!;
    expect(pic('button-name').viewport).toEqual({ width: 390, height: 844, deviceScaleFactor: 2 });
    expect(pic('button-name').width).toBeLessThanOrEqual(390);
    expect(pic('button-name').boxes).toHaveLength(1);
    expect(pic('link-name').viewport.width).toBe(1280);
    expect(pic('image-alt').viewport.width).toBe(1280);
  });
});

describe('evidence pass timing', () => {
  // Paul's decision 15 (2026-11-09): the evidence pass budget is 2 s (speed it up later).
  // What is measured is what the pass adds: each round scans with and without it back to back, in
  // alternating order, and the median of the rounds' differences is held to
  // the budget. Scans alone vary by about a second on a shared runner (9.4/10.5/9.4 s off on the CI runner, 2026-11-09),
  // so the old difference of medians from unpaired runs swung with that noise rather than with the pass.
  it('adds at most 2 s to a scan of the fixture site (median of 5 paired rounds, order alternating)', async () => {
    const times: Record<'off' | 'on', number[]> = { off: [], on: [] };
    for (let round = 0; round < 5; round++) {
      for (const mode of round % 2 ? (['on', 'off'] as const) : (['off', 'on'] as const)) {
        const t0 = performance.now();
        const report = await scanSite(`${server.origin}/`, {
          browser: browser as unknown as BrowserLike, maxPages: 5, documents: false,
          ...(mode === 'on' ? { evidence: { sink: () => undefined } } : {}),
        });
        times[mode].push(performance.now() - t0);
        if (mode === 'on') expect(report.evidence!.length).toBeGreaterThan(1);
      }
    }
    const added = times.on.map((t, i) => t - times.off[i]!).sort((a, b) => a - b);
    const median = added[Math.floor(added.length / 2)]!;
    // eslint-disable-next-line no-console
    console.log(`evidence timing: off ${times.off.map((t) => Math.round(t)).join('/')} ms, on ${times.on.map((t) => Math.round(t)).join('/')} ms, added ${added.map((t) => Math.round(t)).join('/')} ms`);
    expect(median).toBeLessThanOrEqual(2000);
  }, 360_000);
});
