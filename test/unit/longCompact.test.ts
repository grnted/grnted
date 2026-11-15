// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Long scans keep each page's audit small once the crawl and the document checks have read it, so
// thousands of pages fit in a Worker's memory; cross-page consistency compares the first 100 pages.
import { describe, expect, it } from 'vitest';
import { buildReport } from '../../src/report/build.js';
import { TEXT_CONTRAST_LIMITS, undecidedTexts } from '../../src/probes/textContrast.js';
import { AI_PAGES_LONG, CONSISTENCY_PAGES_LONG, compactLong, KINDS_PAGES_LONG, LONG_NODES_PER_RULE, scanSite, storableLong } from '../../src/scan.js';
import { COVERAGE_PAGES_LONG } from '../../src/probes/sample.js';
import type { AiScanPlan, BrowserLike } from '../../src/types.js';
import type { PageAudit } from '../../src/types.js';

const page = (i: number): PageAudit => ({
  url: `https://e.org/p${i}`, status: 'ok', rules: { 'target-size': 'fail' },
  violations: [{ id: 'target-size', help: 'h', helpUrl: 'https://dequeuniversity.com/rules/axe/4.14/target-size', nodes: Array.from({ length: 50 }, (_, n) => ({ target: `#a${n}`, html: `<a id="a${n}">x</a>`, viewports: ['desktop'] as ('desktop' | 'mobile')[] })) }],
  incomplete: [{ id: 'color-contrast', help: 'h', helpUrl: 'https://dequeuniversity.com/rules/axe/4.14/color-contrast', nodes: [{ target: '#c', html: '<p id="c">x</p>', viewports: ['desktop'] }] }], links: Array.from({ length: 300 }, (_, n) => `https://e.org/x${n}`),
  collected: { documentLinks: [{ href: 'https://e.org/a.pdf', text: 'A' }], consistency: { lang: 'en', regions: [], help: [], search: [], contentLinks: [], sitemapLinks: [], tocLinks: [], step: false, truncated: false }, media: { elements: [], frames: [], links: [] }, shape: 'abc' },
});

describe('long scans: compact page audits', () => {
  it('drops the links and document links (already read), caps failing elements per rule, keeps consistency facts for the first pages only', () => {
    expect(LONG_NODES_PER_RULE).toBe(5);
    expect(CONSISTENCY_PAGES_LONG).toBe(100);
    const early = compactLong(page(3), 3);
    expect(early.links).toEqual([]);
    expect(early.violations[0]!.nodes).toHaveLength(5);
    expect(Object.keys(early.collected!).sort()).toEqual(['consistency', 'media', 'shape']);
    expect(early.incomplete).toHaveLength(1);
    const late = compactLong(page(150), 150);
    // Past the first 100 pages the undecided elements (not scored) go too.
    expect(late.incomplete).toEqual([]);
    expect(late.collected).toEqual({ media: { elements: [], frames: [], links: [] }, shape: 'abc' });
    expect(JSON.stringify(late).length).toBeLessThan(JSON.stringify(page(150)).length / 5);
  });

  it('keeps a page\'s element kinds on the pages the wider coverage reaches only (the first 250: the slow tests and the checks can be sent to them), and what a resume stores has them', () => {
    expect(KINDS_PAGES_LONG).toBe(COVERAGE_PAGES_LONG);
    expect(KINDS_PAGES_LONG).toBe(250);
    const kinds = { k: ['a', 'b'], env: ['c:site'], f: { focus: ['x'], form: [], motion: [], fixed: [], ids: [], struct: [], orient: [], reorder: [] } };
    const withKinds = (i: number): PageAudit => ({ ...page(i), collected: { ...page(i).collected, kinds } });
    expect(compactLong(withKinds(60), 60).collected!.kinds).toEqual(kinds);
    expect(storableLong(withKinds(60), 60).collected!.kinds).toEqual(kinds);
    // Past the scored every-page tests' first 100 pages, still within the coverage's reach.
    expect(compactLong(withKinds(180), 180).collected!.kinds).toEqual(kinds);
    // Past them a page keeps none: what a long scan holds does not grow with it.
    expect(compactLong(withKinds(250), 250).collected!.kinds).toBeUndefined();
    expect(storableLong(withKinds(3400), 3400).collected!.kinds).toBeUndefined();
  });

  it('buildReport compares consistency on the first pages when asked', () => {
    const pages = Array.from({ length: 5 }, (_, i) => page(i));
    const all = buildReport({ site: 'https://e.org/p0', pages, documents: [], skipped: [], startedAt: '', finishedAt: '', userAgent: 'UA' });
    const one = buildReport({ site: 'https://e.org/p0', pages, documents: [], skipped: [], startedAt: '', finishedAt: '', userAgent: 'UA', consistencyPages: 1 });
    // One page cannot be compared with another: every consistency criterion says so.
    expect(JSON.stringify(one.consistency)).toContain('page');
    expect(JSON.stringify(one.consistency)).not.toBe(JSON.stringify(all.consistency));
    // Consistency is not scored: the score and the rules are the same.
    expect(one.score).toBe(all.score);
    expect(one.rules).toEqual(all.rules);
  });
});

describe('long scans: the text-contrast test reads the same undecided text as on a short scan', () => {
  // WCAG 1.4.3 (Understanding: text over a gradient or picture, F83): axe leaves such text undecided and the
  // text-contrast test measures it from screenshots. A long scan handed the test the first 5 undecided
  // elements of a page only (the report's cap), so the heading over a photo that axe lists ninth was never measured.
  type Node = PageAudit['incomplete'][number]['nodes'][number];
  const node = (n: number, viewports: Node['viewports'] = ['desktop']): Node => ({ target: `#t${n}`, html: `<p id="t${n}">x</p>`, failureSummary: 'background image', viewports });
  const undecided = (nodes: Node[], more: PageAudit['incomplete'] = []): PageAudit => ({
    ...page(0), incomplete: [{ id: 'color-contrast', help: 'h', helpUrl: 'https://dequeuniversity.com/rules/axe/4.14/color-contrast', nodes }, ...more],
  });

  it('keeps every undecided text element the test would measure (13 of 13), not the first 5', () => {
    const p = undecided(Array.from({ length: 13 }, (_, n) => node(n)));
    const kept = compactLong(p, 3);
    expect(undecidedTexts(kept.incomplete).map((t) => t.target)).toEqual(undecidedTexts(p.incomplete).map((t) => t.target));
    expect(undecidedTexts(kept.incomplete)).toHaveLength(13);
    // What a later segment of the scan reads back from the store is the same list.
    expect(undecidedTexts(compactLong(storableLong(p, 3), 3).incomplete)).toHaveLength(13);
  });

  it('keeps exactly the elements the test takes when a page has more than it measures: desktop first, then phone-only', () => {
    // 50 nodes as axe lists them (the audit's cap per rule), the first 25 seen at the phone width only.
    const nodes = Array.from({ length: 50 }, (_, n) => node(n, n < 25 ? ['mobile'] : ['desktop', 'mobile']));
    const p = undecided(nodes);
    const want = undecidedTexts(p.incomplete).slice(0, TEXT_CONTRAST_LIMITS.elements).map((t) => t.target);
    const kept = compactLong(p, 3);
    expect(kept.incomplete[0]!.nodes).toHaveLength(TEXT_CONTRAST_LIMITS.elements);
    expect(undecidedTexts(kept.incomplete).slice(0, TEXT_CONTRAST_LIMITS.elements).map((t) => t.target)).toEqual(want);
  });

  it('look-alike: other undecided rules, and failing elements, keep the report cap of 5; past the first 100 pages nothing undecided is kept', () => {
    const other = { id: 'label-content-name-mismatch', help: 'h', helpUrl: 'https://dequeuniversity.com/rules/axe/4.14/label-content-name-mismatch', nodes: Array.from({ length: 12 }, (_, n) => node(100 + n)) };
    const p = undecided(Array.from({ length: 13 }, (_, n) => node(n)), [other]);
    const kept = compactLong(p, 3);
    expect(kept.incomplete.find((f) => f.id === 'label-content-name-mismatch')!.nodes).toHaveLength(LONG_NODES_PER_RULE);
    expect(kept.violations[0]!.nodes).toHaveLength(LONG_NODES_PER_RULE);
    expect(compactLong(p, CONSISTENCY_PAGES_LONG).incomplete).toEqual([]);
  });
});

describe('long scans: the AI review stays bounded', () => {
  const withAi = (i: number): PageAudit => ({ ...page(i), collected: { ...page(i).collected, images: [{ src: 'x' }], pageText: { title: 't' }, vision: { shape: 's' } } });

  it('past the first pages a compact audit keeps only what the engine needs (media, shape): no AI review data', () => {
    expect(AI_PAGES_LONG).toBe(25);
    expect(Object.keys(compactLong(withAi(3), 3).collected!).sort()).toEqual(['consistency', 'images', 'media', 'pageText', 'shape', 'vision']);
    expect(Object.keys(compactLong(withAi(150), 150).collected!).sort()).toEqual(['media', 'shape']);
    // Between the AI pages and the consistency pages: consistency only.
    expect(Object.keys(compactLong(withAi(50), 50).collected!).sort()).toEqual(['consistency', 'media', 'shape']);
  });

  it('the stored audit keeps what a resume reads again (links, document links, images) and drops the rest past the first pages', () => {
    const st = storableLong(withAi(150), 150);
    expect(st.links).toHaveLength(300);
    expect(Object.keys(st.collected!).sort()).toEqual(['documentLinks', 'images', 'media', 'shape']);
    expect(compactLong(st, 150)).toEqual(compactLong(withAi(150), 150));
    expect(storableLong(withAi(3), 3).collected).toEqual(withAi(3).collected);
  });

  it('the AI review (its unbounded checks) hears about the first 25 pages only, however many the scan has', async () => {
    const n = 140;
    const pages = Array.from({ length: n }, (_, i) => (i ? `https://e.org/p${i}` : 'https://e.org/'));
    const heard: number[] = [];
    const ai: AiScanPlan = {
      collectors: [], reviews: false,
      onPageAudited: (_p, c) => { heard.push(c.index); },
      finish: async () => undefined as never,
    };
    const browser = { newContext: async () => { throw new Error('nothing is loaded'); } } as unknown as BrowserLike;
    const report = await scanSite('https://e.org/', {
      browser, maxPages: n, probes: false, documents: false, ai, fetchFn: async () => new Response('', { status: 404 }),
      resume: { pages, documents: [], skipped: [], audit: (i) => (i < n ? { ...withAi(i), url: pages[i]! } : undefined) },
    });
    expect(report.pages).toHaveLength(n);
    expect(heard).toEqual(Array.from({ length: AI_PAGES_LONG }, (_, i) => i));
    expect(AI_PAGES_LONG).toBeLessThan(n);
  });
});
