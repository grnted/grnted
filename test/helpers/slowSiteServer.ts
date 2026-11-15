// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A local site in the pattern of fedex.com on 2026-11-03 (bot protection that slows automated visitors):
//   - the apex host answers 301 to www at once;
//   - every HTML answer on www comes after `firstByteMs` (FedEx: ~8 s);
//   - www's `/` answers 302 to a slow country chooser (`/global/choose-location.html`, FedEx: 19.5 s in all)
//     whose links are the country home pages;
//   - robots.txt answers at once and lists two sitemaps (one an index); `/sitemap.xml` is a slow 404;
//   - every sitemap file answers after `sitemapMs`;
//   - every page loads an image that answers after `assetMs` (or never): it holds the page's load event.
// Hosts: `localhost` is the apex and `www.localhost` the site (both loopback in Chromium and in Node).
// Node only: tests and the dev runner at the end of this file, never the engine.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SlowSiteOptions {
  firstByteMs: number;
  /** Extra time the chooser page takes on top of `firstByteMs`. */
  locationMs: number;
  sitemapMs: number;
  /** The image every page waits on before its load event; 'never' answers only when the server closes. */
  assetMs: number | 'never';
  /** Pages per sitemap file. */
  pagesPerSitemap?: number;
  /** Every HTML answer is a 403 with Cloudflare's challenge header (cf-mitigated: challenge). */
  challenge?: boolean;
}

export interface SlowSite {
  apex: string;
  www: string;
  /** Page (document) requests the browser made, and the most that were open at once. */
  /** `plain`: requests for a page that were not a browser load (the start page's first-byte check). */
  stats: { documents: number; maxDocumentsAtOnce: number; requests: string[]; plain: string[] };
  close(): Promise<void>;
}

const LOCALES = ['en-us', 'en-gb', 'de-de', 'fr-fr', 'es-es', 'ja-jp', 'pt-br', 'it-it'];
const GIF = Buffer.from('R0lGODlhAQABAAAAACwAAAAAAQABAAA=', 'base64');

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}<img src="/asset/hold.gif" alt="FedEx-style banner"></main></body></html>`;

export async function startSlowSite(o: SlowSiteOptions): Promise<SlowSite> {
  const stats = { documents: 0, maxDocumentsAtOnce: 0, requests: [] as string[], plain: [] as string[] };
  let open = 0;
  const held: ServerResponse[] = [];
  const per = o.pagesPerSitemap ?? 20;
  let port = 0;
  const www = () => `http://www.localhost:${port}`;
  const urlset = (locale: string) =>
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from({ length: per }, (_, i) => `<url><loc>${www()}/${locale}/page-${i}.html</loc></url>`).join('')}</urlset>`;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const host = (req.headers.host ?? '').split(':')[0]!;
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    stats.requests.push(`${host}${path}`);
    const html = !path.endsWith('.xml') && !path.endsWith('.txt') && !path.startsWith('/asset/');
    if (html && req.headers['sec-fetch-dest'] !== 'document') stats.plain.push(`${host}${path}`);
    if (host !== 'www.localhost') {
      res.writeHead(301, { location: `${www()}${req.url ?? '/'}` }).end();
      return;
    }
    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`User-agent: *\nAllow: /\nSitemap: ${www()}/en-us/sitemap.xml\nSitemap: ${www()}/global/sitemap_index.xml\n`);
      return;
    }
    if (path === '/asset/hold.gif') {
      if (o.assetMs === 'never') { held.push(res); return; }
      await wait(o.assetMs);
      res.writeHead(200, { 'content-type': 'image/gif' }).end(GIF);
      return;
    }
    if (path.endsWith('.xml')) {
      await wait(o.sitemapMs);
      if (path === '/en-us/sitemap.xml') { res.writeHead(200, { 'content-type': 'application/xml' }).end(urlset('en-us')); return; }
      if (path === '/global/sitemap_index.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' }).end(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${LOCALES.slice(1).map((l) => `<sitemap><loc>${www()}/${l}/sitemap.xml</loc></sitemap>`).join('')}</sitemapindex>`);
        return;
      }
      const m = /^\/([a-z]{2}-[a-z]{2})\/sitemap\.xml$/.exec(path);
      if (m && LOCALES.includes(m[1]!)) { res.writeHead(200, { 'content-type': 'application/xml' }).end(urlset(m[1]!)); return; }
      res.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><title>Not found</title>');
      return;
    }
    // HTML: the protection pattern (every answer slow).
    const doc = req.headers['sec-fetch-dest'] === 'document';
    if (doc) {
      stats.documents++;
      stats.maxDocumentsAtOnce = Math.max(stats.maxDocumentsAtOnce, ++open);
    }
    try {
      await wait(o.firstByteMs);
      if (o.challenge) {
        res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }).end(page('Just a moment...', '<p>Checking your browser.</p>'));
        return;
      }
      if (path === '/') { res.writeHead(302, { location: '/global/choose-location.html' }).end(); return; }
      if (path === '/global/choose-location.html') {
        await wait(o.locationMs);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Choose your location', `<ul>${LOCALES.map((l) => `<li><a href="/${l}/home.html">${l}</a></li>`).join('')}</ul>`));
        return;
      }
      if (/^\/[a-z]{2}-[a-z]{2}\/[a-z0-9-]+\.html$/.test(path)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(`Page ${path}`, '<p>Shipping, tracking and support.</p>'));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><title>Not found</title>');
    } finally {
      if (doc) open--;
    }
  });
  // Both loopback families: Chromium may use 127.0.0.1 and Node ::1 for *.localhost.
  await new Promise<void>((r) => server.listen({ port: 0, host: '::', ipv6Only: false }, r));
  port = (server.address() as AddressInfo).port;
  return {
    apex: `http://localhost:${port}`,
    www: www(),
    stats,
    close: () => new Promise<void>((r) => {
      for (const h of held.splice(0)) h.destroy();
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

// Dev runner at real scale, for the CLI (FedEx's measured timings):
//   node packages/engine/test/helpers/slowSiteServer.ts [never]
//   node packages/engine/dist/cli.js http://localhost:<port>/ --max 25 --json out/...
// With `never`, the image every page waits on never answers (no page ever fires load).
if (import.meta.url === `file://${process.argv[1]}`) {
  const site = await startSlowSite({
    firstByteMs: 8_200, locationMs: 11_300, sitemapMs: 12_000,
    assetMs: process.argv[2] === 'never' ? 'never' : 50_000,
  });
  process.stdout.write(`apex ${site.apex}/  www ${site.www}/\n`);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void site.close().then(() => process.exit(0)); });
}
