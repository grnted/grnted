// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { pageReportFor, reportCriterionChecks } from '../../src/criterionScore.js';
// axe in every frame (scoring v2): nested, sibling, hidden, broken and cross-site frames, the rules
// axe skips by default (target-size, css-orientation-lock), frame limits and the no-frames fallback.
// Scoring v3: the cross-site frame's failures are listed as third-party content, not scored
// (test/integration/thirdParty.test.ts covers that in depth).
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FRAME_LIMITS, runAxe } from '../../src/axeRun.js';
import { AXE_ENABLED_RULES, RULE_IMPACTS } from '../../src/ruleImpacts.js';
import { defaultAxeSource, scanSite } from '../../src/scan.js';
import type { AxeRun, BrowserLike, PageLike, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let remote: Awaited<ReturnType<typeof startFixtureServer>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let report: SiteReport;
let axeSource: string;
const path = (u: string) => new URL(u).pathname;

beforeAll(async () => {
  // The same fixture folder on a second server, addressed as localhost: a different site from
  // 127.0.0.1, so Chromium loads the frame out of process, as it does for third-party embeds.
  remote = await startFixtureServer('frames');
  const remoteOrigin = remote.origin.replace('127.0.0.1', 'localhost');
  server = await startFixtureServer('frames', {
    '/cross.html': {
      type: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page with a frame from another site</title></head>
<body><main><h1>Page with a frame from another site</h1>
<iframe id="remote" title="Frame from another site" src="${remoteOrigin}/inner.html" width="320" height="120"></iframe></main></body></html>`,
    },
    // A strict Content-Security-Policy on the page and its frame: no script may run but the page's own.
    '/csp.html': {
      type: 'text/html; charset=utf-8', headers: { 'content-security-policy': "script-src 'none'" },
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Locked page</title></head>
<body><main><h1>Locked page</h1><iframe id="locked" title="Locked frame" src="/csp-frame.html" width="320" height="120"></iframe></main></body></html>`,
    },
    '/csp-frame.html': { type: 'text/html; charset=utf-8', headers: { 'content-security-policy': "script-src 'none'" }, file: 'inner.html' },
  });
  browser = await chromium.launch();
  axeSource = await defaultAxeSource();
  report = await scanSite(`${server.origin}/`, { browser: browser as unknown as BrowserLike, maxPages: 10, documents: false });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await remote?.close();
});

async function onPage<T>(file: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.origin}/${file}`);
    return await fn(page);
  } finally {
    await page.close();
  }
}

const ruleIds = (run: AxeRun) => [...run.violations.map((r) => r.id), ...run.incomplete.map((r) => r.id), ...run.passes, ...run.inapplicable];

describe('scanSite tests every frame (fixture site)', () => {
  it('scans the linked pages and scores the clean page 100', () => {
    expect(report.pages.map((p) => path(p.url))).toEqual(['/', '/cross.html', '/framed.html', '/pointer.html']);
    expect(report.pages[0]!.score).toBe(100);
    expect(report.meta.scoring).toBe('v14');
  });
  it('finds the image without alt text inside nested and sibling frames, on the page that embeds them', () => {
    const img = report.rules.find((r) => r.id === 'image-alt')!;
    expect(img.pagesAffected.map(path)).toEqual(['/framed.html']);
    // The hidden frame is skipped by axe (not exposed to assistive technology): 2 elements, not 3.
    expect(img.elements).toBe(2);
    expect(img.examples.map((e) => [path(e.page), e.target])).toEqual([
      ['/framed.html', '#first >>> #nested >>> #noalt'],
      ['/framed.html', '#second >>> #noalt'],
    ]);
  });
  it('lists the image inside the cross-site frame as third-party content; since v8 it costs that page points (0.75 of the weight)', () => {
    expect(report.thirdParty?.map((r) => [r.id, r.pagesAffected.map(path), r.examples.map((e) => [path(e.frame), e.target])])).toEqual([
      ['image-alt', ['/cross.html'], [['/inner.html', '#noalt']]],
    ]);
    // Page scores follow the site's rules (v8): the embedded failure costs its page too.
    const cross = report.pages.find((p) => path(p.url) === '/cross.html')!;
    expect(cross.score!).toBeLessThan(100);
    expect(reportCriterionChecks(pageReportFor(report, cross.url))!.map((c) => c.key).filter((k) => !k.startsWith('consistency:'))).toEqual(['third-party:image-alt']);
  });
  it('tests the cross-site frame (no untested frames on that page)', () => {
    const cross = report.pages.find((p) => path(p.url) === '/cross.html')!;
    expect(cross.untestedFrames).toBeUndefined();
  });
  it('records the frame that failed to load, with the address it asked for', () => {
    const framed = report.pages.find((p) => path(p.url) === '/framed.html')!;
    expect(framed.untestedFrames).toEqual([
      { url: 'http://127.0.0.1:9/', reason: 'The frame did not load (it failed, was blocked, or never started).' },
    ]);
    expect(report.pages.filter((p) => p.untestedFrames)).toHaveLength(1);
  });
  it('runs the rules axe leaves off by default: target-size (2.5.8) and css-orientation-lock (1.3.4)', () => {
    const byId = Object.fromEntries(report.rules.map((r) => [r.id, r.pagesAffected.map(path)]));
    expect(byId['target-size']).toEqual(['/pointer.html']);
    expect(byId['css-orientation-lock']).toEqual(['/pointer.html']);
    // Batch 19: the examples are one per pattern (the two buttons are two patterns), in the patterns' order.
    expect(report.rules.find((r) => r.id === 'target-size')!.examples.map((e) => e.target).sort())
      .toEqual(['button[aria-label="Next"]', 'button[aria-label="Previous"]']);
    expect(report.meta.enabledRules).toEqual([...AXE_ENABLED_RULES]);
    expect(report.meta.tags).toContain('wcag22aa');
  });
});

describe('runAxe', () => {
  it('runs exactly the generated rule set, in the page and in its frames', async () => {
    const { run } = await onPage('framed.html', (page) => runAxe(page as unknown as PageLike, axeSource));
    expect(new Set(ruleIds(run))).toEqual(new Set(Object.keys(RULE_IMPACTS)));
  });
  it('tests a page and a frame whose Content-Security-Policy blocks script tags', async () => {
    const { run, untestedFrames } = await onPage('csp.html', (page) => runAxe(page as unknown as PageLike, axeSource));
    expect(untestedFrames).toEqual([]);
    expect(run.violations.find((r) => r.id === 'image-alt')?.nodes.map((n) => n.target)).toEqual(['#locked >>> #noalt']);
  });
  it('caps the frames tested per page and lists the rest', async () => {
    const { run, untestedFrames } = await onPage('framed.html', (page) =>
      runAxe(page as unknown as PageLike, axeSource, { ...FRAME_LIMITS, maxFrames: 1 }));
    // Only #first (outer.html) is tested: its nested frame and the sibling are over the limit.
    expect(run.violations.map((r) => r.id)).not.toContain('image-alt');
    expect(untestedFrames.map((f) => [path(f.url), f.reason])).toEqual([
      ['/inner.html', 'Only the first 1 frames of a page are tested.'],
      ['/inner.html', 'Only the first 1 frames of a page are tested.'],
      ['/', 'The frame did not load (it failed, was blocked, or never started).'],
    ]);
  });
  it('gives up on a frame after its time box and says so', async () => {
    const { untestedFrames } = await onPage('framed.html', (page) =>
      runAxe(page as unknown as PageLike, axeSource, { ...FRAME_LIMITS, frameTimeoutMs: 1 }));
    expect(untestedFrames.map((f) => f.reason)).toEqual([
      'The test inside the frame timed out.',
      'The test inside the frame timed out.',
      'The frame did not load (it failed, was blocked, or never started).',
    ]);
  });
  it('without frame access, runs the main frame only and lists every visible frame as not tested', async () => {
    const { run, untestedFrames } = await onPage('framed.html', (page) => {
      const full = page as unknown as PageLike;
      // Like a minimal BrowserLike page: the same page, without `frames`.
      const mainOnly = { addScriptTag: full.addScriptTag.bind(full), evaluate: full.evaluate.bind(full) } as unknown as PageLike;
      return runAxe(mainOnly, axeSource);
    });
    expect(run.violations.map((r) => r.id)).not.toContain('image-alt');
    expect(untestedFrames.map((f) => [f.url.replace(server.origin, ''), f.reason])).toEqual([
      ['/outer.html', 'This browser connection cannot run tests inside frames.'],
      ['/inner.html', 'This browser connection cannot run tests inside frames.'],
      ['http://127.0.0.1:9/', 'This browser connection cannot run tests inside frames.'],
    ]);
  });
});
