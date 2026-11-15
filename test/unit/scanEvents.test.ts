// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Scan events (Plan 5, Task 5.9): the helpers behind the live scan screen's events. Grouping and
// counting, the wireframe's Node-side clean-up (the page's answer is never trusted), and discovery.
import { describe, expect, it } from 'vitest';
import { discoverPages } from '../../src/crawl.js';
import {
  WIREFRAME_LIMITS, emptyWireframe, failingTargets, ruleHits, safeEmit, sanitizeWireframe, viewportChecks, type WireTarget,
} from '../../src/events.js';
import type { AxeRuleLite, BrowserLike, ScanEvent } from '../../src/types.js';
import { fakeFetch } from '../helpers/fakeFetch.js';

const rule = (id: string, n: number, impact: AxeRuleLite['impact'] = null, target = (i: number) => `#${id}-${i}`): AxeRuleLite => ({
  id, impact, help: id, helpUrl: '', nodes: Array.from({ length: n }, (_, i) => ({ target: target(i), html: `<b id="${id}-${i}">` })),
});

describe('ruleHits', () => {
  it('groups by rule, counts nodes, uses the scoring impact and orders worst first', () => {
    // image-alt is critical, color-contrast serious, region moderate in the scoring table.
    const hits = ruleHits([rule('region', 4, 'critical'), rule('color-contrast', 2), rule('image-alt', 1), rule('color-contrast', 3)]);
    expect(hits).toEqual([
      { id: 'image-alt', impact: 'critical', count: 1 },
      { id: 'color-contrast', impact: 'serious', count: 5 },
      { id: 'region', impact: 'moderate', count: 4 },
    ]);
  });
  it('is empty for no violations and skips rules with no nodes', () => {
    expect(ruleHits([])).toEqual([]);
    expect(ruleHits([rule('image-alt', 0)])).toEqual([]);
  });
  it('orders equal impacts by count, then id', () => {
    expect(ruleHits([rule('label', 1), rule('button-name', 1), rule('image-alt', 3)]).map((h) => h.id)).toEqual(['image-alt', 'button-name', 'label']);
  });
});

describe('viewportChecks', () => {
  it('counts applicable rules: passes + violations + incomplete', () => {
    expect(viewportChecks({ violations: [rule('a', 1)], incomplete: [rule('b', 1), rule('c', 1)], passes: ['d', 'e', 'f'], inapplicable: ['g', 'h'] })).toBe(6);
    expect(viewportChecks({ violations: [], incomplete: [], passes: [], inapplicable: ['g'] })).toBe(0);
  });
});

describe('failingTargets', () => {
  it('takes up to 6 nodes per rule, the first target segment (frame or shadow host), with the scoring impact', () => {
    const t = failingTargets([rule('image-alt', 9), rule('link-name', 1, 'serious', () => 'iframe#x >>> a.y')]);
    expect(t.filter((x) => x.id === 'image-alt')).toHaveLength(WIREFRAME_LIMITS.perRule);
    expect(t.find((x) => x.id === 'link-name')).toEqual({ id: 'link-name', impact: 'serious', target: 'iframe#x' });
  });
  it('caps the total and drops oversized targets', () => {
    const many = Array.from({ length: 60 }, (_, i) => rule(`r${i}`, 6));
    expect(failingTargets(many)).toHaveLength(WIREFRAME_LIMITS.failing);
    expect(failingTargets([rule('x', 2, null, () => 'a'.repeat(WIREFRAME_LIMITS.maxTarget + 1))])).toEqual([]);
  });
});

describe('sanitizeWireframe (the page answer is untrusted)', () => {
  const targets: WireTarget[] = [{ id: 'image-alt', impact: 'critical', target: '#i' }];

  it('keeps a well-formed wireframe and rounds to ints', () => {
    const out = sanitizeWireframe({ W: 1280.4, H: 900.6, elements: 42, els: [{ t: 'h1', x: 10.4, y: 20.6, w: 100.2, h: 30, text: '  Hello   world ' }] }, targets);
    expect(out).toEqual({ elements: 42, wireframe: { W: 1280, H: 901, els: [{ t: 'h1', x: 10, y: 21, w: 100, h: 30, text: 'Hello world' }] } });
  });

  it('clips boxes to the page and drops boxes outside it', () => {
    const out = sanitizeWireframe({ W: 100, H: 100, els: [
      { t: 'p', x: -50, y: 10, w: 100, h: 10 },
      { t: 'p', x: 90, y: 95, w: 40, h: 40 },
      { t: 'p', x: -500, y: 10, w: 100, h: 10 },
      { t: 'p', x: 10, y: 200, w: 10, h: 10 },
    ] }, targets);
    expect(out.wireframe.els).toEqual([{ t: 'p', x: 0, y: 10, w: 50, h: 10 }, { t: 'p', x: 90, y: 95, w: 10, h: 5 }]);
  });

  it('caps the height, the width, the text and the counts', () => {
    const els = Array.from({ length: 400 }, (_, i) => ({ t: 'a', x: 0, y: i, w: 10, h: 1, text: 'x'.repeat(5000) }));
    const fails = Array.from({ length: 40 }, () => ({ t: 'img', x: 0, y: 0, w: 5, h: 5, rule: 'image-alt', impact: 'minor' }));
    const out = sanitizeWireframe({ W: 1e9, H: 1e9, elements: 1e12, els: [...els, ...fails] }, targets);
    expect(out.wireframe.W).toBe(WIREFRAME_LIMITS.maxWidth);
    expect(out.wireframe.H).toBe(WIREFRAME_LIMITS.maxHeight);
    expect(out.elements).toBe(WIREFRAME_LIMITS.maxElements);
    const layout = out.wireframe.els.filter((e) => !e.rule);
    const failing = out.wireframe.els.filter((e) => e.rule);
    expect(layout).toHaveLength(WIREFRAME_LIMITS.layout);
    expect(layout.every((e) => e.text!.length === WIREFRAME_LIMITS.text)).toBe(true);
    expect(failing).toHaveLength(WIREFRAME_LIMITS.perRule);
    // The impact is the engine's, not the page's.
    expect(failing.every((e) => e.impact === 'critical' && e.t === 'img')).toBe(true);
  });

  it('drops unknown types, rules the engine did not report, bad numbers and non-string text', () => {
    const out = sanitizeWireframe({ W: 100, H: 100, els: [
      { t: 'script', x: 0, y: 0, w: 10, h: 10 },
      { t: 'p', x: 0, y: 0, w: 10, h: 10, rule: 'made-up', impact: 'critical' },
      { t: 'p', x: Number.NaN, y: 0, w: 10, h: 10 },
      { t: 'p', x: 0, y: 0, w: Infinity, h: 10 },
      { t: 'a', x: 0, y: 0, w: 10, h: 10, text: { toString: () => 'secret' } },
      { t: 'p', x: 0, y: 0, w: 10, h: 10, text: 'paragraph text is never kept' },
      null, 'x', 7,
    ] }, targets);
    expect(out.wireframe.els).toEqual([{ t: 'a', x: 0, y: 0, w: 10, h: 10 }, { t: 'p', x: 0, y: 0, w: 10, h: 10 }]);
  });

  it('returns an empty wireframe for anything that is not one', () => {
    for (const raw of [null, undefined, 'x', 42, [], { W: 'a', H: 1, els: [] }, { W: 1, H: 1, els: 'nope' }]) {
      expect(sanitizeWireframe(raw, targets)).toEqual({ elements: 0, wireframe: emptyWireframe() });
    }
    expect(emptyWireframe()).toEqual({ W: 0, H: 0, els: [] });
  });

  it('drops text a hostile page puts on element types that never carry text', () => {
    const out = sanitizeWireframe({ W: 100, H: 100, els: [{ t: 'input', x: 0, y: 0, w: 10, h: 10, text: 'secret-typed' }] }, targets);
    expect(JSON.stringify(out)).not.toContain('secret');
  });
});

describe('safeEmit', () => {
  it('is undefined without a listener (no cost)', () => {
    expect(safeEmit(undefined)).toBeUndefined();
  });
  it('swallows a throwing listener and a rejecting async listener', async () => {
    const seen: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const a = safeEmit((e) => { seen.push(e.type); throw new Error('boom'); })!;
      expect(() => a({ type: 'scoring', step: 'writing', detail: 'x' })).not.toThrow();
      const b = safeEmit((async () => { throw new Error('async boom'); }) as (e: ScanEvent) => void)!;
      expect(() => b({ type: 'scoring', step: 'writing', detail: 'x' })).not.toThrow();
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual(['scoring']);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('discoverPages events', () => {
  const ORIGIN = 'https://www.e.org';
  const noBrowser = { newContext: () => { throw new Error('not opened'); } } as unknown as BrowserLike;
  const files: Record<string, string> = {
    '/robots.txt': `User-agent: *\nDisallow: /private\nSitemap: ${ORIGIN}/sitemap.xml`,
    '/sitemap.xml': `<urlset>${['/about', '/news', '/private/x', '/board.pdf'].map((p) => `<url><loc>${ORIGIN}${p}</loc></url>`).join('')}</urlset>`,
  };
  const fetchFn = () => fakeFetch((req) => {
    const body = files[new URL(req.url).pathname];
    return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
  }).fn;

  it('emits each discovery step, then the selection', async () => {
    const events: ScanEvent[] = [];
    const r = await discoverPages(`${ORIGIN}/`, { browser: noBrowser, maxPages: 5, userAgent: 'UA', fetchFn: fetchFn(), onEvent: (e) => events.push(e) });
    // 'home': the sitemap's 3 pages do not fill the scan (5), so the pages found are read for more links (crawl.ts `deepen`).
    expect(events.map((e) => (e.type === 'discover' ? e.step : e.type))).toEqual(['start', 'robots', 'sitemap', 'home', 'normalize', 'select', 'documents', 'selected']);
    const byStep = Object.fromEntries(events.filter((e) => e.type === 'discover').map((e) => [e.step, e]));
    expect(byStep.robots!.count).toBe(1);
    expect(byStep.sitemap!.count).toBe(3);
    expect(byStep.select!.count).toBe(3);
    const selected = events.at(-1)!;
    expect(selected).toEqual({ type: 'selected', pages: r.pages, documents: r.documents, skipped: r.skipped });
    for (const e of events) if (e.type === 'discover') expect(typeof e.detail).toBe('string');
  });

  it('hands the listener copies: mutating an event never changes the selection', async () => {
    const r = await discoverPages(`${ORIGIN}/`, {
      browser: noBrowser, maxPages: 5, userAgent: 'UA', fetchFn: fetchFn(),
      onEvent: (e) => { if (e.type === 'selected') { e.pages.length = 0; e.skipped.push({ url: 'x', reason: 'y' }); e.documents.push('z'); } },
    });
    expect(r.pages.map((u) => new URL(u).pathname)).toEqual(['/', '/about', '/news']);
    expect(r.skipped.map((s) => new URL(s.url).pathname)).toEqual(['/private/x']);
    // The sitemap path keeps pages only, so there are no documents here: the listener's push must not add one.
    expect(r.documents).toEqual([]);
  });

  it('a throwing listener does not break discovery', async () => {
    const r = await discoverPages(`${ORIGIN}/`, { browser: noBrowser, maxPages: 5, userAgent: 'UA', fetchFn: fetchFn(), onEvent: () => { throw new Error('boom'); } });
    expect(r.pages).toHaveLength(3);
  });
});
