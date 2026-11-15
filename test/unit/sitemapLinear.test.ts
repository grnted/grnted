// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { parseSitemap, sitemapLastmods } from '../../src/sitemap.js';
import { MAX_BODY_BYTES } from '../../src/crawl.js';
import { expectLinear, msOnce } from '../helpers/linear.js';
import { corpus, rng } from '../helpers/fuzz.js';

// The regexes parseSitemap/sitemapLastmods used before the linear scanner (82b90661). Kept here only as the
// oracle: every input below must read the same with both.
const OLD_LOC = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi;
const OLD_URL_BLOCK = /<url[\s>][\s\S]*?<\/url>/gi;
const OLD_LASTMOD = /<lastmod>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/lastmod>/i;
const OLD_ONE_LOC = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/i;
const dec = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function oldParse(xml: string) {
  const locs = [...xml.matchAll(OLD_LOC)].map((m) => dec((m[1] ?? '').trim())).filter(Boolean);
  return /<sitemapindex[\s>]/i.test(xml) ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
}
function oldLastmods(xml: string) {
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(OLD_URL_BLOCK)) {
    const loc = OLD_ONE_LOC.exec(m[0])?.[1];
    const mod = OLD_LASTMOD.exec(m[0])?.[1];
    if (!loc || !mod) continue;
    const url = dec(loc.trim());
    if (url && !(url in out)) out[url] = mod.trim().slice(0, 64);
  }
  return out;
}

const TOKENS = [
  '<loc>', '</loc>', '<LOC>', '</Loc>', '<loc >', '<![CDATA[', '<![cdata[', ']]>', ']]', ']', '<', '>', ' ', '  ', '\n', '\t',
  '\r', ' ', ' ', '﻿', 'a', 'https://e.org/x', 'https://e.org/a?b=1&amp;c=2', '&lt;', '<url>', '<url ', '<URL>',
  '<url\n', '</url>', '</URL>', '<urlset>', '</urlset>', '<lastmod>', '</lastmod>', '<LASTMOD>', '2026-01-02', '<sitemapindex>',
  '<sitemapindex ', '<sitemap>', '</sitemap>', '<!-- x -->', '/', '<loc', 'loc>',
];
const REAL = [
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://e.org/</loc><lastmod>2026-10-01</lastmod></url>
      <url><loc> https://e.org/a?x=1&amp;y=2 </loc><lastmod> 2026-10-02T10:00:00+00:00 </lastmod></url>
      <url><loc><![CDATA[https://e.org/b]]></loc><lastmod><![CDATA[2026-10-03]]></lastmod></url>
      <url>\n  <loc>\n    https://e.org/c\n  </loc>\n</url></urlset>`,
  `<sitemapindex><sitemap><loc>https://e.org/s1.xml</loc></sitemap><sitemap><LOC>https://e.org/s2.xml</LOC></sitemap></sitemapindex>`,
  `<urlset><url><loc>https://e.org/1</loc><lastmod>${'9'.repeat(100)}</lastmod></url><url><loc>https://e.org/1</loc><lastmod>2</lastmod></url></urlset>`,
  '<html><body>404</body></html>',
  '',
];

/** Near-valid sitemaps: whole elements with random spacing, CDATA, values and broken parts, plus noise. */
function* structured(count: number, seed: number): Generator<string> {
  const r = rng(seed);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(r() * a.length)]!;
  const WS = ['', '', ' ', '\n  ', '\t', '\u00a0', '\u2028', '\r\n'];
  const VALUES = ['https://e.org/p', 'https://e.org/a?x=1&amp;y=2', ' ', '', 'a b', '2026-10-01', 'x>y', 'a]b', 'a<b', '&lt;x&gt;', 'é'];
  const el = (tag: string) => {
    const open = pick([`<${tag}>`, `<${tag.toUpperCase()}>`, `<${tag}>`, `<${tag} >`]);
    const close = pick([`</${tag}>`, `</${tag}>`, `</${tag.toUpperCase()}>`, '', `</${tag}`, '<']);
    const cdata = r() < 0.3;
    return open + pick(WS) + (cdata ? pick(['<![CDATA[', '<![cdata[']) : '') + pick(WS) + pick(VALUES) + pick(WS) +
      (cdata || r() < 0.1 ? pick([']]>', ']]>', ']]', ']']) : '') + pick(WS) + close;
  };
  for (let i = 0; i < count; i++) {
    let s = pick(['', '<urlset>', '<sitemapindex>', '<?xml version="1.0"?>']);
    const entries = Math.floor(r() * 5);
    for (let e = 0; e < entries; e++) {
      const parts: string[] = [];
      for (let k = Math.floor(r() * 4); k > 0; k--) parts.push(el(pick(['loc', 'loc', 'lastmod'])));
      if (r() < 0.2) parts.push(pick(TOKENS));
      s += pick(['<url>', '<url>', '<URL>', '<url ', '<url\n', '<sitemap>', '']) + pick(WS) + parts.join(pick(WS)) + pick(WS) +
        pick(['</url>', '</url>', '</URL>', '</sitemap>', '']);
    }
    yield s;
  }
}

describe('sitemap parsing reads every input as the old regexes did', () => {
  it('real-looking sitemaps and edge cases', () => {
    for (const xml of REAL) {
      expect(parseSitemap(xml), xml).toEqual(oldParse(xml));
      expect(Object.entries(sitemapLastmods(xml)), xml).toEqual(Object.entries(oldLastmods(xml)));
    }
  });
  it('50,000 random token mixes and near-valid sitemaps', () => {
    let urls = 0;
    let mods = 0;
    for (const xml of [...corpus(TOKENS, 25_000, 24, 0x5173), ...structured(25_000, 0x1a57)]) {
      const want = oldParse(xml);
      expect(parseSitemap(xml), JSON.stringify(xml)).toEqual(want);
      const wantMods = Object.entries(oldLastmods(xml));
      expect(Object.entries(sitemapLastmods(xml)), JSON.stringify(xml)).toEqual(wantMods);
      if (want.urls.length + want.sitemaps.length) urls++;
      if (wantMods.length) mods++;
    }
    // The corpus reaches both readers' match paths, not only their misses.
    expect(urls).toBeGreaterThan(5_000);
    expect(mods).toBeGreaterThan(500);
  });
});

describe('hostile sitemaps cost linear time', () => {
  // The old LOC regex took about n^5 here (n = 120: 462 ms).
  it('an unclosed <loc> before a whitespace run scales linearly', () => {
    expectLinear((n) => () => parseSitemap('<loc>' + ' '.repeat(n) + '<'), 40);
    expectLinear((n) => () => sitemapLastmods('<url><lastmod>' + ' '.repeat(n) + '<'), 40);
  });
  it('a 1 KB hostile sitemap is read in under 100 ms', () => {
    const shapes = [
      '<loc>' + ' '.repeat(1019) + '<',
      '<loc><![CDATA[' + ' '.repeat(1000) + ']]',
      '<url><loc>' + ' '.repeat(1000) + '<',
      '<url><lastmod>' + ' '.repeat(1000) + '<',
      '<url '.repeat(205),
    ];
    for (const xml of shapes) {
      expect(msOnce(() => parseSitemap(xml)), xml.slice(0, 20)).toBeLessThan(100);
      expect(msOnce(() => sitemapLastmods(xml)), xml.slice(0, 20)).toBeLessThan(100);
    }
  });
  it('a sitemap at the 5 MB body cap is read in well under a second', () => {
    const n = MAX_BODY_BYTES;
    const shapes = [
      '<loc>' + ' '.repeat(n - 6) + '<',
      '<loc>'.repeat(n / 5),
      '<loc> '.repeat(n / 6),
      '<loc><![CDATA[ a '.repeat(n / 17),
      '<url '.repeat(n / 5),
      '<url><loc>a</loc><lastmod> '.repeat(n / 27),
    ];
    for (const xml of shapes) {
      expect(msOnce(() => parseSitemap(xml), 1), xml.slice(0, 20)).toBeLessThan(1500);
      expect(msOnce(() => sitemapLastmods(xml), 1), xml.slice(0, 20)).toBeLessThan(1500);
    }
  });
  it('many unclosed <url openers scale linearly', () => {
    expectLinear((n) => () => sitemapLastmods('<url '.repeat(n)), 2000);
  });
});
