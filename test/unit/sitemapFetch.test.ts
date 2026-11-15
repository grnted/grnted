// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Sitemap and robots.txt fetches (Grok r1 #2): bodies are read as a stream with a hard byte cap (the
// reader is cancelled at the cap, nothing is buffered first), and sitemap files are fetched only from
// the scanned host and the hosts under its domain (cdn., www.), never from another site.
import { describe, expect, it } from 'vitest';
import { discoverPages, MAX_BODY_BYTES, sitemapHostAllowed } from '../../src/crawl.js';
import type { BrowserLike } from '../../src/types.js';
import { fakeFetch } from '../helpers/fakeFetch.js';

const ORIGIN = 'https://www.e.org';
const noBrowser = { newContext: () => { throw new Error('no page is opened'); } } as unknown as BrowserLike;

describe('sitemap fetches', () => {
  it('a body past the cap is cut off as it streams: the reader is cancelled, the rest never pulled', async () => {
    expect(MAX_BODY_BYTES).toBe(5 * 1024 * 1024);
    let pulled = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode(`<url><loc>${ORIGIN}/p</loc></url>`.repeat(2000));
    const f = fakeFetch((req) => {
      if (new URL(req.url).pathname !== '/sitemap.xml') return new Response('', { status: 404 });
      // An endless body: a server that never stops sending.
      return new Response(new ReadableStream({
        pull(c) { pulled += chunk.byteLength; c.enqueue(chunk); },
        cancel() { cancelled = true; },
      }), { status: 200 });
    });
    await discoverPages(`${ORIGIN}/`, { browser: noBrowser, maxPages: 5, userAgent: 'UA', fetchFn: f.fn });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(MAX_BODY_BYTES + 2 * chunk.byteLength);
  });

  it('robots.txt sitemaps on another site are not fetched; the site\'s own and its subdomains\' are', async () => {
    const skipped: number[] = [];
    const f = fakeFetch((req) => {
      const u = new URL(req.url);
      if (u.pathname === '/robots.txt') return new Response(`Sitemap: https://attacker.example/huge.xml\nSitemap: https://cdn.e.org/s.xml\nSitemap: ${ORIGIN}/own.xml\nSitemap: https://e.org.attacker.example/x.xml`);
      return new Response(`<urlset><url><loc>${ORIGIN}/about</loc></url></urlset>`);
    });
    await discoverPages(`${ORIGIN}/`, { browser: noBrowser, maxPages: 5, userAgent: 'UA', fetchFn: f.fn, onSitemapsSkipped: (n) => skipped.push(n) });
    const hosts = f.calls.map((c) => new URL(c.url).host);
    expect(hosts).not.toContain('attacker.example');
    expect(hosts).not.toContain('e.org.attacker.example');
    expect(hosts).toContain('cdn.e.org');
    expect(f.calls.map((c) => c.url)).toContain(`${ORIGIN}/own.xml`);
    expect(skipped).toEqual([2]);
  });

  it('the host rule', () => {
    expect(sitemapHostAllowed('https://www.e.org/s.xml', 'https://www.e.org/')).toBe(true);
    expect(sitemapHostAllowed('https://cdn.e.org/s.xml', 'https://www.e.org/')).toBe(true);
    expect(sitemapHostAllowed('https://e.org/s.xml', 'https://www.e.org/')).toBe(true);
    expect(sitemapHostAllowed('https://cdn.e.org/s.xml', 'https://e.org/')).toBe(true);
    expect(sitemapHostAllowed('https://other.org/s.xml', 'https://e.org/')).toBe(false);
    expect(sitemapHostAllowed('https://e.org.evil.example/s.xml', 'https://e.org/')).toBe(false);
    expect(sitemapHostAllowed('https://news.e.org/s.xml', 'https://schools.e.org/')).toBe(false);
  });

  /**
   * A body streamed in 64 KB chunks: `head`, then padding to `total` bytes. Its reader behaves as the
   * Workers runtime's does: cancel() releases the lock, so a later releaseLock() throws.
   */
  const streamed = (head: string, total: number, pad = ' ') => {
    const enc = new TextEncoder();
    let sent = 0;
    const first = enc.encode(head);
    const filler = enc.encode(pad.repeat(64 * 1024));
    const res = new Response('', { status: 200 });
    let cancelled = false;
    const reader = {
      async read(): Promise<{ done: boolean; value?: Uint8Array }> {
        if (cancelled || sent >= total) return { done: true };
        const chunk = sent === 0 ? first : filler;
        sent += chunk.byteLength;
        return { done: false, value: chunk };
      },
      async cancel() { cancelled = true; },
      releaseLock() { if (cancelled) throw new TypeError('This reader was released by cancel()'); },
    };
    Object.defineProperty(res, 'body', { value: { getReader: () => reader, cancel: async () => { cancelled = true; } } });
    return res;
  };

  it('r2-1: a 6 MB sitemap whose first 100 KB is a valid urlset gives those URLs', async () => {
    const head = `<urlset>${Array.from({ length: 1500 }, (_, i) => `<url><loc>${ORIGIN}/s${i % 20}/p${i}</loc></url>`).join('')}`;
    expect(head.length).toBeGreaterThan(50_000);
    const f = fakeFetch((req) => (new URL(req.url).pathname === '/sitemap.xml' ? streamed(head, 6 * 1024 * 1024) : new Response('', { status: 404 })));
    const r = await discoverPages(`${ORIGIN}/`, { browser: noBrowser, maxPages: 200, userAgent: 'UA', fetchFn: f.fn });
    expect(r.pages).toHaveLength(200);
    expect(r.pages).toContain(`${ORIGIN}/s0/p0`);
  });

  it('r2-1: a robots.txt over 5 MB keeps its Disallow rules', async () => {
    const robots = `User-agent: *\nDisallow: /private\n`;
    const f = fakeFetch((req) => {
      const p = new URL(req.url).pathname;
      if (p === '/robots.txt') return streamed(robots, 6 * 1024 * 1024, '#');
      if (p === '/sitemap.xml') return new Response(`<urlset><url><loc>${ORIGIN}/private/x</loc></url><url><loc>${ORIGIN}/ok</loc></url></urlset>`);
      return new Response('', { status: 404 });
    });
    const r = await discoverPages(`${ORIGIN}/`, { browser: noBrowser, maxPages: 5, userAgent: 'UA', fetchFn: f.fn });
    expect(r.pages).toEqual([`${ORIGIN}/`, `${ORIGIN}/ok`]);
    expect(r.skipped).toEqual([{ url: `${ORIGIN}/private/x`, reason: 'Blocked by robots.txt' }]);
  });

  it('r2-2: an allowed sitemap address that redirects to another site is not followed', async () => {
    const f = fakeFetch((req) => {
      const u = new URL(req.url);
      if (u.pathname === '/robots.txt') return new Response('Sitemap: https://cdn.e.org/map.xml');
      if (u.host === 'cdn.e.org') return new Response('', { status: 302, headers: { location: 'https://attacker.example/huge.xml' } });
      if (u.host === 'attacker.example') return new Response(`<urlset><url><loc>${ORIGIN}/from-attacker</loc></url></urlset>`);
      return new Response(`<urlset><url><loc>${ORIGIN}/about</loc></url></urlset>`);
    });
    const r = await discoverPages(`${ORIGIN}/`, { browser: noBrowser, maxPages: 5, userAgent: 'UA', fetchFn: f.fn }).catch(() => null);
    expect(f.calls.map((c) => new URL(c.url).host)).not.toContain('attacker.example');
    void r;
  });

  it('r2-2: robots.txt that redirects to another host is followed (RFC 9309 2.3.1.2): its Disallow rules apply', async () => {
    const f = fakeFetch((req) => {
      const u = new URL(req.url);
      if (u.pathname === '/robots.txt' && u.host === 'www.e.org') return new Response('', { status: 302, headers: { location: 'https://robots-host.example/robots.txt' } });
      if (u.host === 'robots-host.example') return new Response('User-agent: *\nDisallow: /private/');
      return new Response(`<urlset><url><loc>${ORIGIN}/private/x</loc></url><url><loc>${ORIGIN}/ok</loc></url></urlset>`);
    });
    const r = await discoverPages(`${ORIGIN}/`, { browser: noBrowser, maxPages: 5, userAgent: 'UA', fetchFn: f.fn });
    expect(f.calls.map((c) => new URL(c.url).host)).toContain('robots-host.example');
    expect(r.pages).toEqual([`${ORIGIN}/`, `${ORIGIN}/ok`]);
    expect(r.skipped).toEqual([{ url: `${ORIGIN}/private/x`, reason: 'Blocked by robots.txt' }]);
  });

  it('every robots.txt redirect hop still passes allowUrl (a refused hop is never requested)', async () => {
    const asked: string[] = [];
    const f = fakeFetch((req) => {
      const u = new URL(req.url);
      const m = /^\/r(\d+)$/.exec(u.pathname);
      if (u.pathname === '/robots.txt' || m) return new Response('', { status: 302, headers: { location: `https://hop${m ? Number(m[1]) + 1 : 1}.example/r${m ? Number(m[1]) + 1 : 1}` } });
      return new Response(`<urlset><url><loc>${ORIGIN}/ok</loc></url></urlset>`);
    });
    await discoverPages(`${ORIGIN}/`, { browser: noBrowser, maxPages: 5, userAgent: 'UA', fetchFn: f.fn, allowUrl: async (u) => { asked.push(u); return !u.includes('hop3'); } });
    const hops = f.calls.map((c) => new URL(c.url).host).filter((h) => h.startsWith('hop'));
    expect(hops).toEqual(['hop1.example', 'hop2.example']);
    expect(asked.some((u) => u.includes('hop3'))).toBe(true);
  });

  it('robots.txt follows at most 5 redirects', async () => {
    const f = fakeFetch((req) => {
      const u = new URL(req.url);
      const m = /^\/r(\d+)$/.exec(u.pathname);
      if (u.pathname === '/robots.txt' || m) return new Response('', { status: 302, headers: { location: `https://hop${m ? Number(m[1]) + 1 : 1}.example/r${m ? Number(m[1]) + 1 : 1}` } });
      return new Response(`<urlset><url><loc>${ORIGIN}/ok</loc></url></urlset>`);
    });
    await discoverPages(`${ORIGIN}/`, { browser: noBrowser, maxPages: 5, userAgent: 'UA', fetchFn: f.fn });
    expect(f.calls.map((c) => new URL(c.url).host).filter((h) => h.startsWith('hop'))).toEqual(['hop1.example', 'hop2.example', 'hop3.example', 'hop4.example', 'hop5.example']);
  });
});
