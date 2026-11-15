// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { spreadOrder } from '../../src/select.js';
import { mergeThirdPartyRuns, mergeViewportRuns } from '../../src/axeMerge.js';
import type { AxeRun, AxeRuleLite, Viewport } from '../../src/types.js';
import { expectLinear, msOnce } from '../helpers/linear.js';
import { rng } from '../helpers/fuzz.js';

// spreadOrder and mergeFindings as of 82b90661, kept only as oracles.
type Item = { href: string; depth: number; key: string };
const byDepthThenPath = (a: Item, b: Item) => a.depth - b.depth || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
function oldSpreadOrder(urls: readonly string[]): string[] {
  const sections = new Map<string, Item[]>();
  for (const href of urls) {
    const u = new URL(href);
    const segs = u.pathname.split('/').filter(Boolean);
    let list = sections.get(segs[0] ?? '');
    if (!list) sections.set(segs[0] ?? '', (list = []));
    list.push({ href, depth: segs.length, key: `${u.pathname}${u.search}` });
  }
  const lists = [...sections.values()].map((l) => l.sort(byDepthThenPath));
  const out: string[] = [];
  for (let round = 0; out.length < urls.length; round++) {
    const picks = lists.filter((l) => round < l.length).map((l) => l[round]!).sort(byDepthThenPath);
    if (!picks.length) break;
    for (const p of picks) out.push(p.href);
  }
  return out;
}

function randomUrls(r: () => number, n: number): string[] {
  const hosts = ['https://e.org', 'http://e.org', 'https://www.e.org'];
  const segs = ['', 'a', 'b', 'news', 'News', 'x y', '%C3%A9', '1'];
  return Array.from({ length: n }, () => {
    const depth = Math.floor(r() * 4);
    const path = Array.from({ length: depth }, () => segs[Math.floor(r() * segs.length)]).join('/');
    return `${hosts[Math.floor(r() * hosts.length)]}/${path}${r() < 0.3 ? `?p=${Math.floor(r() * 3)}` : ''}`;
  });
}

describe('spreadOrder orders every list as before', () => {
  it('5,000 random lists, duplicates and ties included', () => {
    const r = rng(0x5e1);
    for (let i = 0; i < 5000; i++) {
      const urls = randomUrls(r, Math.floor(r() * 40));
      expect(spreadOrder(urls)).toEqual(oldSpreadOrder(urls));
    }
  });
});

const vp = (i: number): Viewport['name'] => (i % 2 ? 'mobile' : 'desktop');
const rule = (id: string, targets: string[]): AxeRuleLite => ({
  id, impact: 'serious', help: `${id} help`, helpUrl: `https://e.org/${id}`, nodes: targets.map((t) => ({ target: t, html: `<x ${t}>` })),
});
const run = (violations: AxeRuleLite[], incomplete: AxeRuleLite[] = []): AxeRun => ({ violations, incomplete, passes: [], inapplicable: [] });

describe('merged findings are the same as before', () => {
  it('2,000 random runs across widths: same nodes, order and widths', async () => {
    // The old merge, through the module as of 82b90661 (a local copy of mergeFindings' node loop).
    const oldMerge = (lists: { viewport: Viewport['name']; rules: AxeRuleLite[] }[]) => {
      const byId = new Map<string, { id: string; help: string; helpUrl: string; nodes: (AxeRuleLite['nodes'][number] & { viewports: Viewport['name'][] })[] }>();
      for (const { viewport, rules } of lists) {
        for (const ru of rules) {
          let f = byId.get(ru.id);
          if (!f) byId.set(ru.id, (f = { id: ru.id, help: ru.help, helpUrl: ru.helpUrl, nodes: [] }));
          for (const node of ru.nodes) {
            const existing = f.nodes.find((n) => n.target === node.target);
            if (existing) {
              if (!existing.viewports.includes(viewport)) existing.viewports.push(viewport);
            } else f.nodes.push({ ...node, viewports: [viewport] });
          }
        }
      }
      return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    };
    const r = rng(0xa8e);
    const ids = ['image-alt', 'label', 'color-contrast', 'link-name'];
    const targets = ['#a', '#b', '#c', 'iframe >>> #d', '#a ', ''];
    for (let i = 0; i < 2000; i++) {
      const runs = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, w) => ({
        viewport: vp(w + Math.floor(r() * 2)),
        run: run(
          Array.from({ length: Math.floor(r() * 4) }, () => rule(ids[Math.floor(r() * ids.length)]!, Array.from({ length: Math.floor(r() * 5) }, () => targets[Math.floor(r() * targets.length)]!))),
          Array.from({ length: Math.floor(r() * 2) }, () => rule(ids[Math.floor(r() * ids.length)]!, [targets[Math.floor(r() * targets.length)]!])),
        ),
      }));
      const merged = mergeViewportRuns(runs);
      expect(merged.violations).toEqual(oldMerge(runs.map((x) => ({ viewport: x.viewport, rules: x.run.violations }))));
      expect(merged.incomplete).toEqual(oldMerge(runs.map((x) => ({ viewport: x.viewport, rules: x.run.incomplete }))));
      const third = mergeThirdPartyRuns(runs.map((x, k) => ({ viewport: x.viewport, thirdParty: [{ url: `https://f${k % 2}.org/`, run: x.run }] })));
      expect(third.map((t) => t.violations)).toEqual(
        [...new Set(runs.map((_, k) => k % 2))].map((k) => oldMerge(runs.filter((_, j) => j % 2 === k).map((x) => ({ viewport: x.viewport, rules: x.run.violations })))).filter((v) => v.length),
      );
    }
  });
});

describe('ordering and merging cost near-linear time', () => {
  it('spreadOrder: one deep section beside many one-page sections scales near-linearly', () => {
    expectLinear((n) => {
      const urls = [...Array.from({ length: n }, (_, i) => `https://e.org/s${i}`), ...Array.from({ length: n }, (_, i) => `https://e.org/deep/${i}`)];
      return () => spreadOrder(urls);
    }, 1000);
  });
  it('mergeViewportRuns: thousands of distinct targets scale near-linearly', () => {
    expectLinear((n) => {
      const targets = Array.from({ length: n }, (_, i) => `#t${i}`);
      const runs = [{ viewport: 'desktop' as const, run: run([rule('image-alt', targets)]) }, { viewport: 'mobile' as const, run: run([rule('image-alt', targets)]) }];
      return () => mergeViewportRuns(runs);
    }, 2000);
  });
  it('a 20,000-address sitemap list and a 50,000-target run take well under a second', () => {
    const urls = [...Array.from({ length: 10_000 }, (_, i) => `https://e.org/s${i}`), ...Array.from({ length: 10_000 }, (_, i) => `https://e.org/deep/${i}`)];
    expect(msOnce(() => spreadOrder(urls), 1)).toBeLessThan(1000);
    const targets = Array.from({ length: 50_000 }, (_, i) => `#t${i}`);
    const runs = [{ viewport: 'desktop' as const, run: run([rule('image-alt', targets)]) }, { viewport: 'mobile' as const, run: run([rule('image-alt', targets)]) }];
    expect(msOnce(() => mergeViewportRuns(runs), 1)).toBeLessThan(1000);
  }, 60_000);
});
