// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Platform-specific fixes (Plan 7, W3a): one shared platform detector (generator meta, asset hosts,
// known paths), "Built on <platform>" in the report summary, short "On <platform>: ..." guidance on the
// issue cards, and a platform section in the fix-it prompts. Guidance names only steps the vendor's own
// help pages document (cited in src/platform.ts); otherwise "In <platform>'s editor, look for ...".
import { describe, expect, it } from 'vitest';
import { platformCollector } from '../../src/collect/platform.js';
import {
  PLATFORMS, decidePlatform, detectPlatforms, issueTypeOf, platformGuidance, reportPlatform, type PlatformId, type PlatformSignals,
} from '../../src/platform.js';
import { buildReport } from '../../src/report/build.js';
import { fixPrompt, platformHints } from '../../src/report/fixPrompt.js';
import { buildProblems } from '../../src/report/problems.js';
import type { PageAudit, SiteReport } from '../../src/types.js';

const top = (s: PlatformSignals) => decidePlatform({ site: 'https://e.org/', ...s })?.id ?? 'unknown';

describe('detectPlatforms', () => {
  const cases: [PlatformId, PlatformSignals][] = [
    ['finalsite', { assets: ['https://resources.finalsite.net/images/v1/abc/logo.png', 'https://resources.finalsite.net/images/v1/abc/b.png'] }],
    ['wordpress', { generator: ['WordPress 6.6.2'] }],
    ['wordpress', { assets: ['https://e.org/wp-content/themes/x/style.css', 'https://e.org/wp-includes/js/jquery.js'] }],
    ['apptegy', { assets: ['https://cmsv2-assets.apptegy.net/uploads/1/file/2/logo.png', 'https://cmsv2-assets.apptegy.net/uploads/1/file/3/b.png'] }],
    ['edlio', { assets: ['https://3.files.edl.io/abc/logo.png', 'https://3.files.edl.io/abc/b.png'] }],
    ['finalsite-wcm', { assets: ['https://e.org/cms/lib/OR01001234/Centricity/Template/GlobalAssets/images/logo.png', 'https://www.e.org/cms/lib/OR01001234/Centricity/Template/x.css'] }],
    ['schoolmessenger', { assets: ['https://e.org/UserFiles/Servers/Server_123/Image/logo.png', 'https://e.org/UserFiles/Servers/Server_123/Image/b.png'] }],
    ['drupal', { generator: ['Drupal 10 (https://www.drupal.org)'] }],
    ['drupal', { markers: ['drupal'] }],
    ['squarespace', { assets: ['https://static1.squarespace.com/static/abc/t/def/site.css', 'https://images.squarespace-cdn.com/a.png'] }],
    ['wix', { generator: ['Wix.com Website Builder'] }],
    ['wix', { assets: ['https://static.wixstatic.com/media/abc.png', 'https://static.parastorage.com/x.js'] }],
    ['google-sites', { assets: ['https://www.gstatic.com/_/atari/_/js/k=atari.vw.en.abc/m=view', 'https://www.gstatic.com/_/atari/_/ss/k=atari.vw.x'] }],
    ['joomla', { generator: ['Joomla! - Open Source Content Management'] }],
    ['joomla', { assets: ['https://e.org/media/jui/js/jquery.min.js', 'https://e.org/media/system/js/core.js'] }],
  ];
  for (const [id, signals] of cases) {
    it(`${id} from ${Object.keys(signals).join(', ')}`, () => expect(top(signals)).toBe(id));
  }

  it('the report names a platform only from a generator, a marker or two matching addresses', async () => {
    const { platformSummary } = await import('../../src/platform.js');
    expect(platformSummary({ site: 'https://e.org/', assets: ['https://e.org/wp-content/a.css'] }).id).toBe('unknown');
    expect(platformSummary({ markers: ['drupal'] }).id).toBe('drupal');
    expect(platformSummary({ site: 'https://e.org/', assets: ['https://e.org/wp-content/a.css', 'https://e.org/wp-content/b.js'] }).id).toBe('wordpress');
  });

  it('unknown when nothing matches', () => {
    expect(detectPlatforms({ site: 'https://e.org/', generator: ['Hand made'], assets: ['https://e.org/style.css'] })).toEqual([]);
    expect(top({})).toBe('unknown');
  });

  it('the generator outweighs a few asset hosts (a WordPress site with one Squarespace image is WordPress)', () => {
    expect(top({ generator: ['WordPress 6.5'], assets: ['https://static1.squarespace.com/a.png', 'https://static1.squarespace.com/b.png'] })).toBe('wordpress');
  });

  it('every platform has a name and its signs in plain words; the list covers the plan', () => {
    for (const id of ['finalsite', 'wordpress', 'apptegy', 'edlio', 'finalsite-wcm', 'schoolmessenger', 'drupal', 'squarespace', 'wix', 'google-sites', 'joomla'] as const) {
      const p = PLATFORMS.find((x) => x.id === id)!;
      expect(p.name.length).toBeGreaterThan(2);
      expect(p.sign.length).toBeGreaterThan(5);
    }
    expect(PLATFORMS.find((x) => x.id === 'apptegy')!.name).toBe('Apptegy (Thrillshare)');
    expect(PLATFORMS.find((x) => x.id === 'finalsite-wcm')!.name).toBe('Finalsite Web Community Manager (formerly Blackboard)');
    expect(PLATFORMS.find((x) => x.id === 'schoolmessenger')!.name).toBe('SchoolMessenger Presence');
  });
});

describe('the platform collector', () => {
  it('is cheap: desktop only, the first pages only', () => {
    expect(platformCollector.id).toBe('platform');
    expect(platformCollector.viewport).toBe('desktop');
  });
  it('skips pages after the first three without touching the page', async () => {
    let evaluated = 0;
    const page = { evaluate: async () => { evaluated++; return { generator: [], assets: [], markers: [] }; } } as never;
    expect(await platformCollector.collect(page, { url: 'https://e.org/x', viewport: 'desktop', index: 5 })).toBeNull();
    expect(evaluated).toBe(0);
    expect(await platformCollector.collect(page, { url: 'https://e.org/', viewport: 'desktop', index: 0 })).toEqual({ generator: [], assets: [], markers: [] });
    expect(evaluated).toBe(1);
  });
});

const page = (url: string, extra: Partial<PageAudit> = {}): PageAudit => ({
  url, status: 'ok', rules: { 'image-alt': 'fail', 'color-contrast': 'fail' }, links: [], incomplete: [],
  violations: [
    { id: 'image-alt', help: 'Images must have alternative text', helpUrl: 'x', nodes: [{ target: 'img', html: '<img src="/a.png">', viewports: ['desktop'] }] },
    { id: 'color-contrast', help: 'Contrast', helpUrl: 'x', nodes: [{ target: 'p', html: '<p>x</p>', viewports: ['desktop'] }] },
  ],
  ...extra,
});
const report = (pages: PageAudit[], extra: Partial<Parameters<typeof buildReport>[0]> = {}): SiteReport => buildReport({
  site: pages[0]!.url, pages, documents: [], skipped: [], startedAt: 't', finishedAt: '2026-11-03T00:00:00Z', userAgent: 'ua', ...extra,
});
const squarespace = () => report([
  page('https://e.org/', { collected: { platform: { generator: [], assets: ['https://static1.squarespace.com/static/x/site.css', 'https://static1.squarespace.com/static/x/logo.png'], markers: [] } } }),
  page('https://e.org/b'),
]);

describe('the report', () => {
  it('records the platform the collector saw (report.platform)', () => {
    expect(squarespace().platform).toEqual({ id: 'squarespace', name: 'Squarespace', signs: ['files served from squarespace.com'] });
    expect(report([page('https://e.org/')]).platform).toEqual({ id: 'unknown', name: 'Unknown', signs: [] });
  });

  it('copy rules: no hedging, never "need to"', () => {
    for (const p of PLATFORMS) {
      for (const t of ['alt', 'links', 'headings', 'colors', 'forms', 'documents', 'captions', 'menus'] as const) {
        const g = platformGuidance(p.id, t);
        if (!g) continue;
        expect(g).not.toMatch(/\bneed(s)? to\b|\bmight\b|\bperhaps\b|\bprobably\b|\bmay want\b/i);
        expect(g).toMatch(/^(On |In )/);
        expect(g.endsWith('.')).toBe(true);
      }
    }
  });
});

describe('issue types', () => {
  it('maps problems to the guidance they get', () => {
    expect(issueTypeOf('rule:image-alt')).toBe('alt');
    expect(issueTypeOf('ai:1.1.1')).toBe('alt');
    expect(issueTypeOf('rule:link-name')).toBe('links');
    expect(issueTypeOf('rule:heading-order')).toBe('headings');
    expect(issueTypeOf('criterion:2.4.6')).toBe('headings');
    expect(issueTypeOf('rule:color-contrast')).toBe('colors');
    expect(issueTypeOf('criterion:1.4.11')).toBe('colors');
    expect(issueTypeOf('rule:label')).toBe('forms');
    expect(issueTypeOf('documents')).toBe('documents');
    expect(issueTypeOf('rule:video-caption')).toBe('captions');
    expect(issueTypeOf('criterion:2.4.11')).toBe('menus');
    expect(issueTypeOf('rule:aria-allowed-attr')).toBeNull();
  });
});

describe('the fix-it prompts', () => {
  it('have a platform section with the guidance for the problems in the prompt', () => {
    const t = fixPrompt(squarespace(), { audience: 'content' });
    expect(t).toContain('## Platform: Squarespace');
    expect(t).toContain('On Squarespace: edit the page, click the image block’s pencil icon');
    expect(t).toMatch(/Granted detected Squarespace \(files served from squarespace\.com\)/);
  });
  it('keep asking for the platform when none was detected', () => {
    const t = fixPrompt(report([page('https://e.org/')]), { audience: 'content' });
    expect(t).not.toContain('## Platform');
    expect(t).toContain('The report does not show which platform');
  });
  it('platformHints reads the report platform first', () => {
    expect(platformHints(squarespace())).toEqual([{ name: 'Squarespace', sign: 'files served from squarespace.com' }]);
  });
  it('problems still build (guidance never changes the problem list)', () => {
    expect(buildProblems(squarespace()).map((p) => p.key)).toEqual(['rule:image-alt', 'rule:color-contrast']);
  });
});

// Grok r1 finding 1: only the collector's signals (generator, markers, the page's own loaded assets)
// decide the platform, matched on the host (or the site's own host plus a path prefix); ambiguity is unknown.
describe('r1: platform detection uses only what the page loaded, and ambiguity is unknown', () => {
  const failing = (html: string[], id = 'color-contrast'): PageAudit => ({
    url: 'https://district.example/', status: 'ok', rules: { [id]: 'fail' }, links: [], incomplete: [],
    violations: [{ id, help: id, helpUrl: 'x', nodes: html.map((h, i) => ({ target: `#n${i}`, html: h, viewports: ['desktop'] as ('desktop' | 'mobile')[] })) }],
  });

  it('r1-1b: two links to wix.com are no sign', () => {
    const r = report([failing(['<a href="https://www.wix.com/"></a>', '<a href="https://www.wix.com/blog"></a>'], 'link-name')]);
    expect(r.platform?.id).toBe('unknown');
    expect(fixPrompt(r, { audience: 'content' })).not.toContain('## Platform');
  });

  it('r1-1c: page addresses like /apps/news/ are no sign', () => {
    const r = report([page('https://district.example/apps/news/open-house'), page('https://district.example/apps/events/board')]);
    expect(r.platform?.id).toBe('unknown');
  });

  it('r1-1d: a WordPress marker and wp-content CSS beat 12 Finalsite images (no generator): never Finalsite', () => {
    const assets = [
      'https://district.example/wp-content/themes/d/style.css', 'https://district.example/wp-content/plugins/x/a.css',
      ...Array.from({ length: 12 }, (_, i) => `https://resources.finalsite.net/images/v1/x/${i}.jpg`),
    ];
    const r = report([page('https://district.example/', { collected: { platform: { generator: [], assets, markers: ['wordpress'] } } })]);
    expect(r.platform?.id).not.toBe('finalsite');
    expect(['wordpress', 'unknown']).toContain(r.platform?.id);
  });

  it('r1-1e: two platforms each with enough asset hits and nothing else deciding: unknown, not the first in the list', () => {
    expect(decidePlatform({ site: 'https://district.example/', assets: [
      'https://resources.finalsite.net/a.png', 'https://resources.finalsite.net/b.png', 'https://static1.squarespace.com/a.css', 'https://static1.squarespace.com/b.css',
    ] })).toBeNull();
  });

  it('r1-1f: matches are anchored: a vendor name in another host or a path on another site is no sign', () => {
    const site = 'https://district.example/';
    expect(decidePlatform({ site, assets: ['https://notwixstatic.com.evil.example/a.png', 'https://cdn.example/wixstatic.com/b.png'] })).toBeNull();
    // /wp-content/ counts on the site's own host only.
    expect(decidePlatform({ site, assets: ['https://partner.example/wp-content/a.png', 'https://partner.example/wp-content/b.png'] })).toBeNull();
    expect(decidePlatform({ site, assets: ['https://district.example/wp-content/a.css', 'https://www.district.example/wp-includes/b.js'] })?.id).toBe('wordpress');
  });

  it('r1-1g: a generator outranks any number of asset hits (r2: a marker no longer decides, see r2-1b)', () => {
    const site = 'https://district.example/';
    const many = Array.from({ length: 20 }, (_, i) => `https://static1.squarespace.com/${i}.png`);
    expect(decidePlatform({ site, generator: ['WordPress 6.5'], assets: many })?.id).toBe('wordpress');
  });

  it('r1-1h: a report without a recorded platform reads nothing from its text', () => {
    const r = report([page('https://e.org/')], { documents: ['https://e.org/UserFiles/Servers/Server_9/File/a.pdf', 'https://e.org/UserFiles/Servers/Server_9/File/b.pdf'] });
    const { platform: _p, ...old } = r;
    expect(reportPlatform(old as SiteReport)).toBeNull();
    expect(r.platform?.id).toBe('unknown');
  });
});

// Grok r2: a marker is 2 hits, not a decision; distinct addresses only; anchored generators.
describe('r2: no single loose signal names a platform', () => {
  const site = 'https://district.example/';
  const finalsite12 = Array.from({ length: 12 }, (_, i) => `https://resources.finalsite.net/images/v1/x/${i}.jpg`);

  it('r2-1a: a marker is two hits for its platform, not a decision: 12 Finalsite files beat a WordPress marker (Finalsite or unknown, never WordPress)', () => {
    const d = decidePlatform({ site, assets: finalsite12, markers: ['wordpress'] });
    expect(d?.id).not.toBe('wordpress');
    // A marker alone still names its platform (two hits).
    expect(decidePlatform({ site, markers: ['drupal'] })?.id).toBe('drupal');
  });

  it('r2-1b: only an anchored generator decides alone; two generators that disagree are unknown', () => {
    const many = Array.from({ length: 20 }, (_, i) => `https://static1.squarespace.com/${i}.png`);
    expect(decidePlatform({ site, generator: ['WordPress 6.5'], assets: many })?.id).toBe('wordpress');
    expect(decidePlatform({ site, generator: ['WordPress 6.5'], markers: ['drupal'] })?.id).toBe('wordpress');
    expect(decidePlatform({ site, generator: ['WordPress 6.5', 'Drupal 10'] })).toBeNull();
  });

  it('r2-2: one widget address repeated on several pages is one address: unknown', () => {
    expect(decidePlatform({ site, assets: ['https://resources.finalsite.net/widget.js', 'https://resources.finalsite.net/widget.js', 'https://resources.finalsite.net/widget.js'] })).toBeNull();
    const r = report([
      page('https://district.example/', { collected: { platform: { generator: [], markers: [], assets: ['https://resources.finalsite.net/widget.js'] } } }),
      page('https://district.example/b', { collected: { platform: { generator: [], markers: [], assets: ['https://resources.finalsite.net/widget.js'] } } }),
    ]);
    expect(r.platform?.id).toBe('unknown');
  });

  it('r2-5: generators are anchored on the product name: "District CMS. We left finalsite in 2019." is not Finalsite', () => {
    expect(decidePlatform({ site, generator: ['District CMS. We left finalsite in 2019.'] })).toBeNull();
    for (const g of ['District CMS (not wix.com)', 'Built without squarespace', 'Our own; was edlio', 'Replaced sharpschool', 'No webflow here', 'ex-Apptegy', 'Hand made, not Google Sites']) {
      expect(decidePlatform({ site, generator: [g] }), g).toBeNull();
    }
    expect(decidePlatform({ site, generator: ['Finalsite'] })?.id).toBe('finalsite');
    expect(decidePlatform({ site, generator: ['Wix.com Website Builder'] })?.id).toBe('wix');
    expect(decidePlatform({ site, generator: ['Joomla! - Open Source Content Management'] })?.id).toBe('joomla');
  });
});
