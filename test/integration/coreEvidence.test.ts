// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Core-test evidence pictures (report follow-up to v2): every scored core-test failure that points at
// an element gets a picture taken while the probe has the page open, the element boxed (no label, so
// the report draws the problem's number) and the measurement in the caption; the start page's
// failures are outlined on "Homepage, as checked". Local fixtures only (test/fixtures/core-evidence/):
// each failing element has its own colour, and each picture is checked by its pixels.
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEvidenceRecorder } from '../../src/evidence/recorder.js';
import { formFieldsProbe } from '../../src/probes/forms.js';
import { headingsProbe } from '../../src/probes/headings.js';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import { linkColorProbe } from '../../src/probes/linkColor.js';
import { nonTextContrastProbe } from '../../src/probes/nonTextContrast.js';
import { decodePng } from '../../src/probes/pixels.js';
import { runProbes } from '../../src/probes/runner.js';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import { textSpacingProbe } from '../../src/probes/textSpacing.js';
import type { PageProbe } from '../../src/probes/types.js';
import { buildProblems } from '../../src/report/problems.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, EvidenceBox, EvidenceShot, Finding, ProbeRun, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer('core-evidence');
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

type ShotOpts = { type?: string; clip?: { x: number; y: number; width: number; height: number } };

/** The real browser; each JPEG screenshot is followed by a PNG of the same area (decodable here), kept by the JPEG's bytes. */
function spy() {
  const pngs: { jpeg: Uint8Array; png: Uint8Array }[] = [];
  const wrapped = {
    async newContext(o: Parameters<Browser['newContext']>[0]) {
      const context = await browser.newContext(o);
      const newPage = context.newPage.bind(context);
      return Object.assign(context, {
        async newPage() {
          const page = await newPage();
          const real = page.screenshot.bind(page);
          return Object.assign(page, {
            async screenshot(opts?: ShotOpts) {
              const out = await real(opts as Parameters<Page['screenshot']>[0]);
              if (opts?.type === 'jpeg') pngs.push({ jpeg: out, png: await real({ type: 'png', ...(opts.clip ? { clip: opts.clip } : {}) }) });
              return out;
            },
          });
        },
      });
    },
  };
  return { browser: wrapped as unknown as BrowserLike, pngFor: (jpeg: Uint8Array) => pngs.find((x) => Buffer.from(x.jpeg).equals(Buffer.from(jpeg)))?.png };
}

type Rgb = [number, number, number];
/** Share of the pixels inside `box` (shrunk by 2 px) that `is` accepts. */
async function shareIn(png: Uint8Array, box: EvidenceBox, is: (c: Rgb) => boolean): Promise<number> {
  const img = await decodePng(png);
  let yes = 0;
  let all = 0;
  for (let y = Math.ceil(box.y) + 2; y < Math.floor(box.y + box.height) - 2; y++) {
    for (let x = Math.ceil(box.x) + 2; x < Math.floor(box.x + box.width) - 2; x++) {
      const i = (y * img.width + x) * 4;
      all++;
      if (is([img.data[i]!, img.data[i + 1]!, img.data[i + 2]!])) yes++;
    }
  }
  return all ? yes / all : 0;
}
const magenta = ([r, g, b]: Rgb) => r > 220 && g < 60 && b > 220;
const pink = ([r, g, b]: Rgb) => r > 240 && g > 180 && g < 225 && b > 240;
/** The row behind the pale field (#ffe8ff). */
const rowPink = ([r, g, b]: Rgb) => r > 245 && g > 222 && g < 242 && b > 245;
const cyan = ([r, g, b]: Rgb) => r < 60 && g > 220 && b > 220;
const yellow = ([r, g, b]: Rgb) => r > 220 && g > 220 && b < 60;
const orange = ([r, g, b]: Rgb) => r > 230 && g > 110 && g < 160 && b < 50;
const white = ([r, g, b]: Rgb) => r > 245 && g > 245 && b > 245;
const reddish = ([r, g, b]: Rgb) => r - g > 40 && r - b > 40;

const undecided = (targets: string[]): Finding[] => [{
  id: 'color-contrast', help: 'Elements must meet minimum color contrast ratio thresholds', helpUrl: 'https://x/color-contrast',
  nodes: targets.map((target) => ({ target, html: '<p>', viewports: ['desktop'], failureSummary: "Element's background color could not be determined due to a background image" })),
}];

interface Got { runs: ProbeRun[]; shots: EvidenceShot[]; bytes: Map<string, Uint8Array>; png: (s: EvidenceShot) => Uint8Array }
async function capture(path: string, probe: PageProbe, incomplete?: Finding[]): Promise<Got> {
  const bytes = new Map<string, Uint8Array>();
  const rec = createEvidenceRecorder({ sink: (id, b) => { bytes.set(id, b); } });
  const s = spy();
  const runs = await runProbes(s.browser, [{ url: `${server.origin}${path}`, index: 3, ...(incomplete ? { incomplete } : {}) }], [probe], { userAgent: 'grnted-test', evidence: rec });
  return { runs, shots: rec.shots(), bytes, png: (shot) => s.pngFor(bytes.get(shot.id)!)! };
}
const forCriterion = (g: Got, c: string) => g.shots.filter((s) => 'criterion' in s.for && s.for.criterion === c);

/** One picture, one unlabelled fail box (the report puts the problem's number on it) with the element's colour inside, and a plain caption. */
async function boxed(g: Got, criterion: string, colour: (c: Rgb) => boolean, caption: RegExp): Promise<EvidenceShot> {
  const shots = forCriterion(g, criterion);
  expect(shots, JSON.stringify(g.runs.map((r) => r.findings))).toHaveLength(1);
  const s = shots[0]!;
  expect(s.boxes).toHaveLength(1);
  expect(s.boxes[0]).toMatchObject({ kind: 'fail' });
  expect(s.boxes[0]!.label).toBeUndefined();
  expect(await shareIn(g.png(s), s.boxes[0]!, colour)).toBeGreaterThan(0.5);
  expect(s.caption).toMatch(caption);
  expect(s.alt).not.toMatch(/\d\.\d+\.\d+/);
  return s;
}

describe('core-test pictures, taken while the probe has the page open', () => {
  // Batch 19, the lead's ruling: an empty heading is Needs review, so it is no problem with a picture.
  it('headings: an empty heading far down the page is Needs review, with no picture', async () => {
    const g = await capture('/headings.html', headingsProbe);
    expect(forCriterion(g, '1.3.1')).toHaveLength(0);
    expect(g.runs[0]!.findings.find((f) => f.criterion === '1.3.1')?.status).toBe('flagged');
  }, 60_000);

  it('headings: a paragraph marked up as a heading far down the page is scrolled to and boxed', async () => {
    const g = await capture('/headings-paragraph.html', headingsProbe);
    await boxed(g, '1.3.1', magenta, /^A paragraph marked up as a heading$/);
  }, 60_000);

  // 2026-11-07: no level-1 heading is a recommendation (WCAG requires none): no failure, so no picture.
  it('headings: a page with no level-1 heading gets a recommendation and no picture', async () => {
    const g = await capture('/noh1.html', headingsProbe);
    expect(forCriterion(g, '2.4.6')).toEqual([]);
    expect(g.runs[0]!.findings).toEqual([expect.objectContaining({ criterion: '2.4.6', status: 'no_failures_found', advice: true })]);
  }, 60_000);

  it('text contrast: the text is boxed while the page is held still, with the measured ratio and the threshold in the caption', async () => {
    const g = await capture('/contrast.html', textContrastProbe, undecided(['#far-low']));
    expect(g.runs[0]!.findings.map((f) => f.status)).toEqual(['failed']);
    await boxed(g, '1.4.3', pink, /^Contrast 1\.\d:1; text this size needs at least 4\.5:1$/);
  }, 60_000);

  it('form fields: the field with only a placeholder is boxed', async () => {
    const g = await capture('/form.html', formFieldsProbe);
    await boxed(g, '3.3.2', cyan, /placeholder/i);
  }, 60_000);

  it('form fields: hidden trap fields are not pictured or reported; the picture boxes the field its finding names', async () => {
    const g = await capture('/decoy-form.html', formFieldsProbe);
    const failed = g.runs[0]!.findings.filter((f) => f.criterion === '3.3.2' && f.status === 'failed');
    expect(failed.map((f) => f.target)).toEqual(['list_email (email field)']);
    const s = await boxed(g, '3.3.2', cyan, /no visible label/i);
    // The picture names the element it boxes, so the report can show the matching finding with it.
    expect(s.for).toEqual({ criterion: '3.3.2', probe: 'form-fields', target: 'list_email (email field)' });
  }, 60_000);

  it('text spacing: pictured with the spacing applied (the cut-off box), and the page left as it was', async () => {
    // A probe after it on the same page: no spacing sheet left, and the box at its own height.
    const after: PageProbe = {
      id: 'after', criteria: ['0.0.1'], kind: 'render', tier: 'core', timeoutMs: 5000,
      async run(ctx) {
        const left = await ctx.page.evaluate(() => ({ sheets: document.adoptedStyleSheets.length, kept: '__grntedSpacing' in window, lh: getComputedStyle(document.getElementById('clip-box')!).lineHeight }), undefined);
        return [{ criterion: '0.0.1', status: 'no_failures_found', detail: JSON.stringify(left) }];
      },
    };
    const bytes = new Map<string, Uint8Array>();
    const rec = createEvidenceRecorder({ sink: (id, b) => { bytes.set(id, b); } });
    const s = spy();
    const runs = await runProbes(s.browser, [{ url: `${server.origin}/spacing.html`, index: 3 }], [textSpacingProbe, after], { userAgent: 'grnted-test', evidence: rec });
    expect(JSON.parse(runs[1]!.findings[0]!.detail)).toEqual({ sheets: 0, kept: false, lh: '20px' });
    const g: Got = { runs, shots: rec.shots(), bytes, png: (shot) => s.pngFor(bytes.get(shot.id)!)! };
    await boxed(g, '1.4.12', yellow, /text spacing/i);
    // The same results without pictures.
    const plain = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/spacing.html`, index: 3 }], [textSpacingProbe, after], { userAgent: 'grnted-test' });
    expect(plain.map((r) => r.findings)).toEqual(runs.map((r) => r.findings));
  }, 60_000);

  it('keyboard: the element whose positive tabindex breaks the focus order is boxed', async () => {
    const g = await capture('/taborder.html', keyboardProbe);
    await boxed(g, '2.4.3', orange, /tabindex="1"/);
  }, 60_000);

  it('non-text contrast: the pale field is boxed (white inside, the pink row around it), with its ratio', async () => {
    const g = await capture('/controls.html', nonTextContrastProbe);
    const s = await boxed(g, '1.4.11', white, /^Contrast 1\.\d:1; at least 3:1 is needed$/);
    const b = s.boxes[0]!;
    // The row's pink just above the box.
    expect(await shareIn(g.png(s), { ...b, y: b.y - 16, height: 12 }, rowPink), JSON.stringify(b)).toBeGreaterThan(0.5);
  }, 60_000);

  it('link colour: the link told apart only by colour is boxed, not its paragraph', async () => {
    const g = await capture('/links.html', linkColorProbe);
    const s = await boxed(g, '1.4.1', () => true, /only by (its )?colou?r/i);
    const b = s.boxes[0]!;
    expect(b.width).toBeLessThan(200);
    expect(await shareIn(g.png(s), b, reddish)).toBeGreaterThan(0.03);
  }, 60_000);
});

describe('a scan: core-test problems get pictures, and the start page shows their numbers', () => {
  let report: SiteReport;
  const images = new Map<string, Uint8Array>();
  beforeAll(async () => {
    report = await scanSite(`${server.origin}/`, {
      browser: browser as unknown as BrowserLike, maxPages: 4, documents: false, concurrency: 2,
      evidence: { sink: (id, b) => { images.set(id, b); } },
    });
  }, 240_000);

  it('every scored core-test problem that names an element has a picture; the same main heading is boxed on another page', () => {
    const problems = buildProblems(report);
    const core = problems.filter((p) => p.key.startsWith('criterion:') && p.scored);
    // Batch 19, the lead's ruling: the start page's empty heading is Needs review, so 1.3.1 is no scored problem here.
    expect(core.map((p) => p.key)).toEqual(expect.arrayContaining(['criterion:2.4.6', 'criterion:1.4.3']));
    expect(core.map((p) => p.key)).not.toContain('criterion:1.3.1');
    for (const p of core) expect(p.evidence.length, p.key).toBeGreaterThan(0);
    const h1 = problems.find((p) => p.key === 'criterion:2.4.6')!;
    expect(h1.evidence[0]!.page).not.toBe(`${server.origin}/`);
    expect(h1.evidence[0]!.caption).toMatch(/same on nearly every page/);
    for (const s of report.evidence!) expect(images.has(s.id)).toBe(true);
  });

  it('"Homepage, as checked" outlines the start page’s pale text under its problem; the empty heading (Needs review) is not outlined', () => {
    const start = report.evidence!.find((s) => 'rule' in s.for && s.for.rule === '$start' && s.viewport.width === 1280)!;
    const problems = new Set(start.boxes.map((b) => b.problem));
    // Batch 19, the lead's ruling: an empty heading is Needs review, never a scored problem, so it gets no box here.
    expect(problems.has('criterion:1.3.1')).toBe(false);
    expect(problems.has('criterion:1.4.3')).toBe(true);
    const low = start.boxes.find((b) => b.problem === 'criterion:1.4.3')!;
    // The pale band is 552 px wide (520 + padding) near the top of the page.
    expect(low.y).toBeLessThan(300);
  });
});
