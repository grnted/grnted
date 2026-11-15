// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { parseSitemap } from '../../src/sitemap.js';

describe('parseSitemap', () => {
  it('reads a urlset', () => {
    const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://e.org/</loc></url>
      <url><loc> https://e.org/a?x=1&amp;y=2 </loc></url>
      <url><loc><![CDATA[https://e.org/b]]></loc></url></urlset>`;
    expect(parseSitemap(xml)).toEqual({ urls: ['https://e.org/', 'https://e.org/a?x=1&y=2', 'https://e.org/b'], sitemaps: [] });
  });
  it('reads a sitemap index', () => {
    const xml = `<sitemapindex><sitemap><loc>https://e.org/s1.xml</loc></sitemap><sitemap><loc>https://e.org/s2.xml</loc></sitemap></sitemapindex>`;
    expect(parseSitemap(xml)).toEqual({ urls: [], sitemaps: ['https://e.org/s1.xml', 'https://e.org/s2.xml'] });
  });
  it('returns empty lists for non-sitemap content', () => {
    expect(parseSitemap('<html><body>404</body></html>')).toEqual({ urls: [], sitemaps: [] });
  });
});
