// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Probe evidence (report v2, Plan 5 Task 5.2) in real Chromium, on local fixtures built to fail
// (test/fixtures/probe-evidence/): each of the four captures is taken at the moment of failure, its
// boxes lie inside the right elements, pairs share a group, results are the same with and without
// evidence, and no evidence screenshot is taken without a recorder.
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEvidenceRecorder, type EvidenceRecorder } from '../../src/evidence/recorder.js';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import { reflowProbe } from '../../src/probes/reflow.js';
import { resizeTextProbe } from '../../src/probes/resizeText.js';
import { runProbes } from '../../src/probes/runner.js';
import type { PageProbe } from '../../src/probes/types.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, EvidenceBox, EvidenceShot, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer('probe-evidence');
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

type Shot = { type?: string; clip?: { x: number; y: number; width: number; height: number } };

/** The real browser, recording every JPEG screenshot's options (the evidence captures; the keyboard probe's own focus tests take PNGs). */
function counting(): { browser: BrowserLike; jpegs: Shot[] } {
  const jpegs: Shot[] = [];
  const wrapped = {
    async newContext(o: Parameters<Browser['newContext']>[0]) {
      const context = await browser.newContext(o);
      const newPage = context.newPage.bind(context);
      return Object.assign(context, {
        async newPage() {
          const page = await newPage();
          const real = page.screenshot.bind(page);
          return Object.assign(page, {
            screenshot(opts?: Shot) {
              if (opts?.type === 'jpeg') jpegs.push(opts);
              return real(opts as Parameters<Page['screenshot']>[0]);
            },
          });
        },
      });
    },
  };
  return { browser: wrapped as unknown as BrowserLike, jpegs };
}

interface Captured { runs: ProbeRun[]; shots: EvidenceShot[]; bytes: Map<string, Uint8Array>; jpegs: Shot[] }

async function capture(file: string, probe: PageProbe, withRecorder = true): Promise<Captured> {
  const bytes = new Map<string, Uint8Array>();
  const rec: EvidenceRecorder | undefined = withRecorder ? createEvidenceRecorder({ sink: (id, b) => { bytes.set(id, b); } }) : undefined;
  const c = counting();
  const runs = await runProbes(c.browser, [{ url: `${server.origin}/${file}`, index: 0 }], [probe], { userAgent: 'grnted-test', ...(rec ? { evidence: rec } : {}) });
  for (const r of runs) expect(r.status, `${file} ${r.probe}`).toBe('ok');
  return { runs, shots: rec?.shots() ?? [], bytes, jpegs: c.jpegs };
}

type Rect = { x: number; y: number; width: number; height: number };

/** Runs `fn` on the fixture in a fresh page of the given size (after `prepare`). */
async function measure<T>(file: string, viewport: { width: number; height: number }, fn: () => T): Promise<T> {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.goto(`${server.origin}/${file}`);
    return await page.evaluate(fn);
  } finally {
    await context.close();
  }
}

const TOL = 1.5;
function inside(box: EvidenceBox, r: Rect): void {
  expect(box.x, JSON.stringify({ box, r })).toBeGreaterThanOrEqual(r.x - TOL);
  expect(box.y, JSON.stringify({ box, r })).toBeGreaterThanOrEqual(r.y - TOL);
  expect(box.x + box.width, JSON.stringify({ box, r })).toBeLessThanOrEqual(r.x + r.width + TOL);
  expect(box.y + box.height, JSON.stringify({ box, r })).toBeLessThanOrEqual(r.y + r.height + TOL);
}
const overlapArea = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const isJpeg = (b: Uint8Array | undefined) => !!b && b[0] === 0xff && b[1] === 0xd8;
/** Plain words: no criterion numbers in alt text. */
const plain = (s: EvidenceShot) => expect(s.alt).not.toMatch(/\d\.\d+\.\d+/);
const sansTime = (runs: ProbeRun[]) => runs.map(({ ms: _ms, ...r }) => r);

describe('resize text (1.4.4): a pair at 100% and 200% browser zoom', () => {
  it('boxes the unenlarged text in both, labelled with its size on screen; same results without a recorder, and no evidence screenshot', async () => {
    const got = await capture('zoom.html', resizeTextProbe);
    expect(got.runs[0]!.findings.some((f) => f.status === 'failed' && /this text stays the same size on screen \(\d+ px → \d+ px\)/.test(f.detail))).toBe(true);
    const shots = got.shots.filter((s) => 'criterion' in s.for && s.for.criterion === '1.4.4');
    expect(shots.map((s) => s.groupLabel)).toEqual(['Browser zoom 100%', 'Browser zoom 200%']);
    expect(new Set(shots.map((s) => s.group)).size).toBe(1);
    expect(shots[0]!.group).toBe('resize-text:0:zoom');
    expect(shots.map((s) => [s.width, s.height])).toEqual([[1280, 900], [640, 450]]);
    expect(shots.map((s) => s.viewport)).toEqual([{ width: 1280, height: 900, deviceScaleFactor: 1 }, { width: 640, height: 450, deviceScaleFactor: 1 }]);
    const text = () => {
      const h = document.getElementById('vw-title')!;
      const range = document.createRange();
      range.selectNodeContents(h);
      const r = range.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height, fs: parseFloat(getComputedStyle(h).fontSize) };
    };
    const at100 = await measure('zoom.html', { width: 1280, height: 900 }, text);
    const at200 = await measure('zoom.html', { width: 640, height: 450 }, text);
    for (const [s, r, label] of [[shots[0]!, at100, `${Math.round(at100.fs)} px`], [shots[1]!, at200, `${Math.round(at200.fs * 2)} px`]] as const) {
      expect(s.boxes).toHaveLength(1);
      expect(s.boxes[0]).toMatchObject({ kind: 'fail', label });
      inside(s.boxes[0]!, r);
      expect(overlapArea(s.boxes[0]!, r)).toBeGreaterThan(0.8 * r.width * r.height);
      expect(isJpeg(got.bytes.get(s.id))).toBe(true);
      plain(s);
    }
    const none = await capture('zoom.html', resizeTextProbe, false);
    expect(none.jpegs).toEqual([]);
    expect(sansTime(none.runs)).toEqual(sansTime(got.runs));
  }, 60_000);
});

describe('keyboard: 2.4.11 at the stop itself, and 2.4.7', () => {
  it('2.4.11: the focused link (ghost) under the sticky header (fail), then the link in view (expected); coverHeight on the finding', async () => {
    const got = await capture('obscured.html', keyboardProbe);
    const finding = got.runs[0]!.findings.find((f) => f.criterion === '2.4.11' && f.status === 'failed');
    expect(finding, JSON.stringify(got.runs[0]!.findings)).toBeDefined();
    expect(finding!.data).toEqual({ coverHeight: 92 });
    expect(got.runs[0]!.data).toEqual({ focusObscured: [{ cover: expect.stringContaining('header'), coverHeight: 92 }], focusOrder: expect.objectContaining({ v: 1 }) });
    const shots = got.shots.filter((s) => 'criterion' in s.for && s.for.criterion === '2.4.11');
    expect(shots.map((s) => s.groupLabel)).toEqual(['Found: focus hidden', 'Expected: focus in view']);
    expect(shots.map((s) => s.group)).toEqual(['keyboard:0:focus-obscured', 'keyboard:0:focus-obscured']);
    const [found, expected] = shots as [EvidenceShot, EvidenceShot];
    expect(found.alt).toMatch(/Shift\+Tab/);
    expect(found.alt).toMatch(/header/);
    plain(found);
    plain(expected);
    const ghost = found.boxes.find((b) => b.kind === 'ghost')!;
    const fail = found.boxes.find((b) => b.kind === 'fail')!;
    expect(ghost).toBeDefined();
    expect(fail).toBeDefined();
    // The sticky header, as it sits at the top of the viewport once the page has scrolled.
    const header = await measure('obscured.html', { width: 1280, height: 900 }, () => {
      window.scrollTo(0, 600);
      const r = document.querySelector('header')!.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    // Cropped around the hidden link (± 300 px, the header's height), not the full-width union with
    // the header (Task 5.10), so the pair reads at phone width: a short strip at the top of the viewport.
    expect(found.height).toBe(240);
    expect(found.width).toBeLessThan(1280);
    expect(found.width).toBeLessThanOrEqual(Math.ceil(ghost.width) + 600 + 2);
    expect(ghost.x).toBeLessThanOrEqual(300 + TOL);
    expect(found.viewport).toEqual({ width: 1280, height: 900, deviceScaleFactor: 1 });
    inside(fail, header);
    expect(fail.height).toBeCloseTo(92, 0);
    // The hidden link lies under the header.
    expect(overlapArea(ghost, header)).toBeGreaterThan(0.9 * ghost.width * ghost.height);
    expect(ghost.height).toBeCloseTo(24, 0);
    // Only the cover carries a tag; the ghost has none to collide with it.
    expect(fail.label).toBe('92 px');
    expect(ghost.label).toBeUndefined();
    const exp = expected.boxes.find((b) => b.kind === 'expected')!;
    expect(exp).toBeDefined();
    expect(exp.height).toBeCloseTo(24, 0);
    // The expected shot is cropped too, as wide as the found one so the pair lines up.
    expect(expected.width).toBe(found.width);
    expect(expected.height).toBeLessThan(900);
    expect(expected.height).toBeGreaterThanOrEqual(240);
    for (const s of shots) {
      expect(s.width * s.height).toBeLessThan(1280 * 900);
      for (const b of s.boxes) inside(b, { x: 0, y: 0, width: s.width, height: s.height });
    }
    // The expected link is in the middle of its crop (48 px padding at least), clear of the edges.
    expect(exp.y).toBeGreaterThanOrEqual(48 - TOL);
    expect(exp.y + exp.height).toBeLessThanOrEqual(expected.height - 48 + TOL);
    for (const s of shots) expect(isJpeg(got.bytes.get(s.id))).toBe(true);

    const none = await capture('obscured.html', keyboardProbe, false);
    expect(none.jpegs).toEqual([]);
    expect(sansTime(none.runs)).toEqual(sansTime(got.runs));
  }, 60_000);

  it('2.4.7: one shot with the focused link boxed', async () => {
    const got = await capture('outline.html', keyboardProbe);
    expect(got.runs[0]!.findings.filter((f) => f.criterion === '2.4.7' && f.status === 'failed').map((f) => f.target)).toEqual(['#bare']);
    const shots = got.shots.filter((s) => 'criterion' in s.for && s.for.criterion === '2.4.7');
    expect(shots).toHaveLength(1);
    const s = shots[0]!;
    expect(s.boxes).toHaveLength(1);
    expect(s.boxes[0]!.kind).toBe('fail');
    plain(s);
    // The capture is a clip around the link: map the box back to the viewport with the clip used.
    const clip = got.jpegs[0]!.clip!;
    expect(clip).toBeDefined();
    expect([s.width, s.height]).toEqual([clip.width, clip.height]);
    const link = await measure('outline.html', { width: 1280, height: 900 }, () => {
      const r = document.getElementById('bare')!.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    const box = { ...s.boxes[0]!, x: s.boxes[0]!.x + clip.x, y: s.boxes[0]!.y + clip.y };
    inside(box, link);
    expect(overlapArea(box, link)).toBeGreaterThan(0.9 * link.width * link.height);
    expect(isJpeg(got.bytes.get(s.id))).toBe(true);
    const none = await capture('outline.html', keyboardProbe, false);
    expect(none.jpegs).toEqual([]);
  }, 60_000);
});

describe('reflow (1.4.10)', () => {
  it('the page at 320 CSS px wide with the too-wide container boxed', async () => {
    const got = await capture('reflow.html', reflowProbe);
    expect(got.runs[0]!.findings.map((f) => [f.status, f.target])).toEqual([['failed', '#fixed-box']]);
    expect(got.shots).toHaveLength(1);
    const s = got.shots[0]!;
    expect(s).toMatchObject({ width: 320, height: 256, viewport: { width: 320, height: 256, deviceScaleFactor: 1 }, for: { criterion: '1.4.10', probe: 'reflow' } });
    expect(s.boxes.length).toBeGreaterThanOrEqual(1);
    expect(s.boxes.length).toBeLessThanOrEqual(3);
    // The container, scrolled up to the top of the narrow window the same way.
    const box = await measure('reflow.html', { width: 320, height: 256 }, () => {
      const el = document.getElementById('fixed-box')!;
      window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 8);
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    expect(s.boxes[0]).toMatchObject({ kind: 'fail', label: '1000 px wide' });
    inside(s.boxes[0]!, box);
    // Clamped at the right edge of the image: it runs past it.
    expect(s.boxes[0]!.x + s.boxes[0]!.width).toBeCloseTo(320, 0);
    expect(s.boxes[0]!.y).toBeCloseTo(box.y, 0);
    expect(isJpeg(got.bytes.get(s.id))).toBe(true);
    plain(s);
    const none = await capture('reflow.html', reflowProbe, false);
    expect(none.jpegs).toEqual([]);
    expect(sansTime(none.runs)).toEqual(sansTime(got.runs));
  }, 60_000);
});

describe('scanSite', () => {
  it('routes probe shots into the scan\'s evidence sink', async () => {
    const sunk: [string, Uint8Array][] = [];
    await scanSite(`${server.origin}/obscured.html`, {
      browser: browser as unknown as BrowserLike, maxPages: 1, probes: [keyboardProbe], documents: false,
      evidence: { sink: (id, b) => { sunk.push([id, b]); } },
    });
    expect(sunk.length).toBeGreaterThanOrEqual(1);
    for (const [id, b] of sunk) {
      expect(id).toMatch(/^e\d+$/);
      expect(isJpeg(b)).toBe(true);
    }
  }, 90_000);
});
