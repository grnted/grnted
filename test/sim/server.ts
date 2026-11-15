// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Serves one case's site from memory on a random local port: its files, its routes (a late font, a
// form endpoint that answers 500), robots.txt and a one-page sitemap. Test infrastructure only.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { SimSite } from './types.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.webm': 'video/webm', '.mp4': 'video/mp4', '.txt': 'text/plain',
};

export interface SimServer {
  origin: string;
  /** Requests received ("METHOD /path"), in order. */
  requests: string[];
  close(): Promise<void>;
}

const typeOf = (path: string) => TYPES[/\.[a-z0-9]+$/i.exec(path)?.[0]?.toLowerCase() ?? ''] ?? 'text/html; charset=utf-8';

async function body(req: IncomingMessage): Promise<void> {
  for await (const _ of req) { /* drain */ }
}

export async function startSimServer(site: SimSite): Promise<SimServer> {
  const requests: string[] = [];
  let origin = '';
  const server: Server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const method = req.method ?? 'GET';
    requests.push(`${method} ${path}`);
    await body(req).catch(() => {});
    const route = site.routes?.[`${method} ${path}`] ?? site.routes?.[path];
    if (route) {
      if (route.delayMs) await new Promise((r) => setTimeout(r, route.delayMs));
      if (res.destroyed) return;
      const b = route.body ?? '';
      res.writeHead(route.status ?? 200, { 'content-type': route.type ?? typeOf(path), 'cache-control': 'no-store', ...route.headers });
      res.end(method === 'HEAD' ? undefined : b);
      return;
    }
    if (path === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
    if (path === '/sitemap.xml') {
      return void res.writeHead(200, { 'content-type': 'application/xml' })
        .end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url></urlset>`);
    }
    const file = site.files[path];
    if (file === undefined) return void res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="en"><title>Not found</title><h1>Not found</h1></html>');
    const type = typeOf(path === '/' ? '/index.html' : path);
    if (typeof file !== 'string' && /^(video|audio)\//.test(type)) {
      // Browsers seek in media only with byte ranges.
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      if (m && (m[1] || m[2])) {
        const size = file.length;
        const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
        const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 }).end(file.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': file.length }).end(method === 'HEAD' ? undefined : file);
      return;
    }
    res.writeHead(200, { 'content-type': type }).end(method === 'HEAD' ? undefined : file);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin,
    requests,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}
