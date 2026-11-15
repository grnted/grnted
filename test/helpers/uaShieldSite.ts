// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A small site behind a bot shield like Automattic's (WordPress.com hosting, 2026-11-06): a request whose
// User-Agent disagrees with the browser's own client hints (Sec-CH-UA) is refused with 403. It compares
// the Chrome major version in the User-Agent with the Chromium version in Sec-CH-UA, and the product
// (HeadlessChrome or Chrome) with the brands. A request without client hints (a plain fetch, curl) is
// served. Every request is recorded, so a test can see the one identity a scan presented.
import { createServer } from 'node:http';

export interface ShieldHit {
  path: string;
  ua: string;
  /** Sec-CH-UA as sent (absent on plain fetches). */
  hints?: string;
  status: number;
}

export interface UaShieldSite {
  origin: string;
  hits(): ShieldHit[];
  close(): Promise<void>;
}

/** The product and major version a User-Agent claims (`HeadlessChrome/149.0…` → HeadlessChrome, 149). */
export function claimedChrome(ua: string): { product: string; major: number } | null {
  const m = /\b(HeadlessChrome|Chrome)\/(\d+)/.exec(ua);
  return m ? { product: m[1]!, major: Number(m[2]) } : null;
}

/** Why the shield refuses this request, or null when it is served. */
export function shieldVerdict(ua: string, hints: string | undefined): string | null {
  if (!hints) return null;
  const brands = [...hints.matchAll(/"([^"]+)";v="(\d+)"/g)].map((m) => ({ brand: m[1]!, major: Number(m[2]) }));
  const chromium = brands.find((b) => b.brand === 'Chromium');
  const claim = claimedChrome(ua);
  if (!chromium || !claim) return 'no Chrome in the user agent or no Chromium in the client hints';
  if (claim.major !== chromium.major) return `user agent says ${claim.product}/${claim.major}, client hints say Chromium ${chromium.major}`;
  const headlessHint = brands.some((b) => b.brand === 'HeadlessChrome');
  if (headlessHint !== (claim.product === 'HeadlessChrome')) return `user agent says ${claim.product}, client hints ${headlessHint ? 'say' : 'do not say'} HeadlessChrome`;
  return null;
}

const PAGE = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><header><nav aria-label="Main"><a href="/">Home</a> <a href="/about.html">About</a></nav></header><main><h1>${title}</h1>${body}</main></body></html>`;

/** `refuse`: that page answers 429 to a request without that header (a page only the late retry gets). */
export async function startUaShieldSite(o: { refuse?: { path: string; unlessHeader: string } } = {}): Promise<UaShieldSite> {
  const hits: ShieldHit[] = [];
  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host}`;
    const path = (req.url ?? '/').split('?')[0]!;
    const ua = String(req.headers['user-agent'] ?? '');
    const hints = req.headers['sec-ch-ua'] as string | undefined;
    const refused = shieldVerdict(ua, hints);
    const hit: ShieldHit = { path, ua, ...(hints ? { hints } : {}), status: 0 };
    hits.push(hit);
    const reply = (status: number, type: string, body: string) => {
      hit.status = status;
      res.writeHead(status, { 'content-type': type }).end(body);
    };
    if (refused) return reply(403, 'text/html; charset=utf-8', PAGE('Forbidden', `<p>${refused}</p>`));
    if (o.refuse && path === o.refuse.path && !req.headers[o.refuse.unlessHeader]) return reply(429, 'text/html; charset=utf-8', PAGE('Busy', '<p>Try later.</p>'));
    if (path === '/robots.txt') return reply(200, 'text/plain', `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
    if (path === '/sitemap.xml') {
      return reply(200, 'application/xml', `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url><url><loc>${origin}/about.html</loc></url></urlset>`);
    }
    if (path === '/') return reply(200, 'text/html; charset=utf-8', PAGE('Maple Bakery', '<p>Fresh bread every morning.</p>'));
    if (path === '/about.html') return reply(200, 'text/html; charset=utf-8', PAGE('About the bakery', '<p>Baking since 1990.</p>'));
    return reply(404, 'text/html; charset=utf-8', PAGE('Not found', '<p>No such page.</p>'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    hits: () => hits.map((h) => ({ ...h })),
    close: () => new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}
