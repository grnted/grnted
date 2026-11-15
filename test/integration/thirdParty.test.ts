// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Scoring v3: failures inside frames from another site (registrable domain) are listed as third-party
// content and never scored; same-site frames, srcdoc frames and frames inside them still
// count. The "other site" is a second local server addressed as localhost (registrable domain
// 'localhost', vs '127.0.0.1'); a server on another 127.0.0.1 port is the same site.
import { THIRD_PARTY_FACTOR, criterionScore, pageReportFor, reportCriterionChecks } from '../../src/criterionScore.js';
import { roundScore, ruleWeight } from '../../src/scoreCore.js';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let remote: Awaited<ReturnType<typeof startFixtureServer>>;
let sameSite: Awaited<ReturnType<typeof startFixtureServer>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let remoteOrigin: string;
let report: SiteReport;
const path = (u: string) => new URL(u).pathname;
const doc = (title: string, body: string) => ({
  type: 'text/html; charset=utf-8',
  body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>nav a { display: inline-block; padding: 4px 0; }</style></head>
<body><main><h1>${title}</h1>${body}</main></body></html>`,
});

beforeAll(async () => {
  remote = await startFixtureServer('thirdparty');
  remoteOrigin = remote.origin.replace('127.0.0.1', 'localhost');
  sameSite = await startFixtureServer('thirdparty');
  const player = `${remoteOrigin}/player.html`;
  server = await startFixtureServer('thirdparty', {
    '/': doc('Embeds home', `<nav aria-label="Main"><ul>
      <li><a href="/youtube.html">Video</a></li><li><a href="/same-site.html">Same site</a></li>
      <li><a href="/nested.html">Nested</a></li><li><a href="/srcdoc.html">Inline frame</a></li></ul></nav>`),
    // The page's only content is a third-party video player.
    '/youtube.html': doc('Video', `<iframe id="yt" title="Video" src="${player}" width="400" height="240"></iframe>`),
    // A frame from another port of the same host: the same site, so its failure counts.
    '/same-site.html': doc('Same site', `<iframe id="same" title="Same-site frame" src="${sameSite.origin}/bad.html" width="320" height="120"></iframe>`),
    // Same-site frame → third-party player (listed); third-party frame → a same-site page (still third-party content).
    '/nested.html': doc('Nested', `<iframe id="a" title="Same-site wrapper" src="${sameSite.origin}/wrap.html?src=${encodeURIComponent(player)}" width="420" height="300"></iframe>
<iframe id="b" title="Third-party wrapper" src="${remoteOrigin}/wrap.html?src=${encodeURIComponent(`${sameSite.origin}/bad.html`)}" width="420" height="300"></iframe>`),
    // A srcdoc frame is the page's own content.
    '/srcdoc.html': doc('Inline frame', `<iframe id="inline" title="Inline frame" srcdoc="<!doctype html><html lang='en'><head><title>Inline</title></head><body><img id='noalt' src='data:image/gif;base64,R0lGODlhAQABAAAAACw=' width='40' height='40'></body></html>" width="200" height="80"></iframe>`),
  });
  browser = await chromium.launch();
  report = await scanSite(`${server.origin}/`, { browser: browser as unknown as BrowserLike, maxPages: 10, documents: false, probes: false });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await Promise.all([server?.close(), sameSite?.close(), remote?.close()]);
});

const pageScore = (p: string) => report.pages.find((x) => path(x.url) === p)?.score;

describe('scoring v3: third-party frames', () => {
  it('is scoring v8', () => {
    expect(report.meta.scoring).toBe('v14');
  });

  it('a page whose only content is a third-party embed: since v8 the embed counts at 0.75 of the weight, on the site and on its page alike', async () => {
    const only = await scanSite(`${server.origin}/youtube.html`, { browser: browser as unknown as BrowserLike, maxPages: 1, documents: false, probes: false });
    expect(only.pages.map((p) => [path(p.url), p.score])).toEqual([['/youtube.html', only.score]]);
    expect(only.score!).toBeLessThan(100);
    const checks = reportCriterionChecks(only)!;
    expect(new Set(checks.map((c) => c.key))).toEqual(new Set(['third-party:aria-allowed-attr', 'third-party:image-alt', 'third-party:aria-prohibited-attr']));
    expect(checks.every((c) => c.weight === ruleWeight(c.key.slice('third-party:'.length), c.key.endsWith('prohibited-attr') ? 'serious' : 'critical') * THIRD_PARTY_FACTOR)).toBe(true);
    expect(only.score).toBe(roundScore(criterionScore(checks)));
    expect(only.rules).toEqual([]);
    // Listed, with the frame's origin.
    const listed = (only.thirdParty ?? []).map((r) => [r.origin, r.id, r.impact]);
    expect(listed).toEqual([
      [remoteOrigin, 'aria-allowed-attr', 'critical'],
      [remoteOrigin, 'image-alt', 'critical'],
      [remoteOrigin, 'aria-prohibited-attr', 'serious'],
    ]);
    const allowed = only.thirdParty!.find((r) => r.id === 'aria-allowed-attr')!;
    expect(allowed.examples).toEqual([{ page: `${server.origin}/youtube.html`, frame: `${remoteOrigin}/player.html`, target: 'a', html: expect.stringContaining('aria-checked') }]);
    // The srcdoc frame inside the player is third-party content too.
    expect(only.thirdParty!.find((r) => r.id === 'image-alt')!.examples[0]!.target).toBe('#captions >>> #noalt');
  }, 60_000);

  it('a same-site frame still counts: its critical failure costs points', () => {
    expect(pageScore('/same-site.html')).toBeLessThan(100);
    const img = report.rules.find((r) => r.id === 'image-alt')!;
    expect(img.pagesAffected.map(path)).toEqual(['/same-site.html', '/srcdoc.html']);
    expect(img.examples.map((e) => [path(e.page), e.target])).toEqual([['/same-site.html', '#same >>> #noalt'], ['/srcdoc.html', '#inline >>> #noalt']]);
    expect(report.score).toBeLessThan(100);
    expect(img.pointsLost).toBeGreaterThan(0);
  });

  it('nested frames: third-party content inside a same-site frame is listed; a same-site page inside a third-party frame is third-party content', () => {
    // Each page scores its own results (v8): the third-party failures on it cost it points, nothing else does.
    for (const p of ['/nested.html', '/youtube.html', '/']) {
      const url = report.pages.find((x) => path(x.url) === p)!.url;
      const keys = reportCriterionChecks(pageReportFor(report, url))!.map((c) => c.key);
      expect(keys.every((k) => k.startsWith('third-party:') || k.startsWith('consistency:')), `${p}: ${keys.join(', ')}`).toBe(true);
      expect(pageScore(p)).toBe(roundScore(criterionScore(reportCriterionChecks(pageReportFor(report, url))!)));
    }
    const nested = (report.thirdParty ?? []).flatMap((r) => r.examples.filter((e) => path(e.page) === '/nested.html').map((e) => [r.id, path(e.frame), e.target]));
    expect(nested.sort()).toEqual([
      ['aria-allowed-attr', '/player.html', 'a'],
      ['aria-prohibited-attr', '/player.html', '#movie_player'],
      ['image-alt', '/player.html', '#captions >>> #noalt'],
      ['image-alt', '/wrap.html', '#inner >>> #noalt'],
    ].sort());
    // Each third-party rule names its origin and every page it was found on.
    for (const r of report.thirdParty!) expect(r.origin).toBe(remoteOrigin);
    expect(report.thirdParty!.find((r) => r.id === 'aria-allowed-attr')!.pagesAffected.map(path)).toEqual(['/nested.html', '/youtube.html']);
  });
});
