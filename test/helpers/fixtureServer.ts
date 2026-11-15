// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.txt': 'text/plain', '.xml': 'application/xml', '.css': 'text/css',
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.vtt': 'text/vtt', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

/**
 * Sends a body. Video and audio honour single `Range: bytes=a-b` requests (206), as real media
 * servers do: browsers cannot seek in media served without them.
 */
function send(req: IncomingMessage, res: ServerResponse, status: number, type: string, body: string | Uint8Array, headers: Record<string, string> = {}): void {
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (status === 200 && /^(video|audio)\//.test(type) && typeof body !== 'string') {
    if (range && (range[1] || range[2])) {
      const size = body.length;
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 })
        .end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { ...headers, 'content-type': type, 'accept-ranges': 'bytes', 'content-length': body.length }).end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  res.writeHead(status, { ...headers, 'content-type': type }).end(body);
}

/** Extra responses for paths that have no file, e.g. extensionless document downloads. */
export type FixtureRoutes = Record<string, { type: string; file?: string; body?: string | Uint8Array; status?: number; headers?: Record<string, string> }>;

/**
 * Serves `test/fixtures/<root>/` on a random local port. Each test suite can keep its own fixture
 * site in its own folder, so suites never change each other's page lists.
 */
export async function startFixtureServer(
  root = 'site',
  routes: FixtureRoutes = {},
  /**
   * `onRequest` sees every request, WebSocket upgrades included (those are then refused). `delayMs`
   * holds each response back (by path), like a real server's latency.
   */
  opts: {
    onRequest?: (req: IncomingMessage) => void;
    delayMs?: (path: string) => number;
    /**
     * Answers a request before routes and files (a rate limit, a firewall block): a status with
     * optional headers and body. `undefined` serves the request as usual.
     */
    respond?: (req: IncomingMessage, path: string) => { status: number; headers?: Record<string, string>; body?: string; type?: string; drop?: boolean } | undefined;
  } = {},
): Promise<{ origin: string; close: () => Promise<void> }> {
  const dir = fileURLToPath(new URL(`../fixtures/${root}/`, import.meta.url));
  const server: Server = createServer(async (req, res) => {
    opts.onRequest?.(req);
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const delay = opts.delayMs?.(path) ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const answer = opts.respond?.(req, path);
    if (answer?.drop) {
      // The connection is cut with no answer (a firewall dropping a throttled request).
      req.socket.destroy();
      return;
    }
    if (answer) {
      res.writeHead(answer.status, { 'content-type': answer.type ?? 'text/html; charset=utf-8', ...answer.headers }).end(req.method === 'HEAD' ? undefined : (answer.body ?? ''));
      return;
    }
    const route = routes[path];
    if (route) {
      const body = route.file ? await readFile(normalize(join(dir, route.file))) : (route.body ?? '');
      send(req, res, route.status ?? 200, route.type, body, route.headers);
      return;
    }
    const file = normalize(join(dir, path === '/' ? 'index.html' : path));
    if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      send(req, res, 200, TYPES[extname(file)] ?? 'application/octet-stream', body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><title>Not found</title>');
    }
  });
  server.on('upgrade', (req, socket) => {
    opts.onRequest?.(req);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}
