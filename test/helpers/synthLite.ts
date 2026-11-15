// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A small local copy of the behaviour of grnted-synth (tools/synthetic-site on feat/capacity-site, which
// W6 must never load-test): a deterministic site with stable ETag and Last-Modified on every page and
// asset, 304 answers to If-None-Match / If-Modified-Since, sitemap <lastmod> equal to Last-Modified,
// `version` changing a deterministic share of pages (content, ETag, Last-Modified and lastmod), and
// `assets` changing only the shared /assets/site.css and /assets/site.js. Every request is logged.
import { createServer, type Server } from 'node:http';

export interface SynthLog { path: string; method: string; at: number; status: number; ua: string; conditional: boolean; accept: string; acceptLanguage: string; cookie: boolean }

export interface SynthLite {
  origin: string;
  /**
   * "1" is the baseline; any other value changes the pages `changed(version, path)` picks. A changed page's
   * Last-Modified and lastmod are the moment `version` was set (an honest site), never a fixed date.
   */
  version: string;
  /** "1": the baseline stylesheet; "2": a cosmetic change; "low-contrast": news text fails contrast. */
  assets: string;
  /** robots.txt Crawl-delay (seconds), 0 for none. */
  crawlDelay: number;
  /** Lastmod as the sitemap writes it: honest (the default) or "now" on every page. */
  lastmod: 'honest' | 'now';
  log: SynthLog[];
  paths: string[];
  changed(version: string, path: string): boolean;
  close(): Promise<void>;
}

const hash32 = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
};

/** Per thousand of the pages a non-baseline version changes (the real site: 5%; this one is small, so more). */
export const CHANGE_PER_MILLE = 150;

const NEWS = ['spring-open-house-this-year', 'new-library-hours-start', 'board-approves-the-budget', 'robotics-team-wins-state', 'lunch-menu-changes-for-fall', 'school-bus-routes-updated', 'volunteer-day-at-the-park', 'art-show-in-the-main-hall'];
const STAFF = ['ada-lovelace-4f2a9c1e', 'alan-turing-7b3d2e8f', 'grace-hopper-1c9e4a7b', 'edsger-dijkstra-5a8f3b2c', 'barbara-liskov-9e2c7d4a', 'donald-knuth-3b6a1f9e'];
const EVENTS = ['2026-10-04-fall-festival-day', '2026-10-11-parent-teacher-night', '2026-10-18-science-fair-finals', '2026-10-25-community-cleanup-day', '2026-11-01-band-concert-evening', '2026-11-08-veterans-day-assembly'];

export const SYNTH_PATHS = ['/', '/about', '/contact', ...NEWS.map((s) => `/news/${s}`), ...STAFF.map((s) => `/staff/${s}`), ...EVENTS.map((s) => `/events/${s}`)];

const BASE_MOD = Date.UTC(2026, 8, 15);

function css(assets: string): string {
  const muted = assets === 'low-contrast' ? '#c8c8c8' : '#333333';
  return `body{font-family:system-ui,sans-serif;color:#111;background:#fff;margin:0}main{padding:16px${assets === '2' ? ' 24px' : ''}}.muted{color:${muted}}a{color:#0b4fb3}nav a{margin-right:8px}`;
}
const js = (assets: string) => `document.documentElement.dataset.v=${JSON.stringify(assets)};`;

export async function startSynthLite(o: Partial<Pick<SynthLite, 'version' | 'assets' | 'crawlDelay' | 'lastmod'>> = {}): Promise<SynthLite> {
  // When the version last changed: a changed page was modified then (a fixed date turned stale once the
  // clock passed it, and its lastmod then said "unchanged since before the previous scan").
  let version = o.version ?? '1';
  let changeMod = Date.now();
  const s: SynthLite = {
    origin: '', version, assets: o.assets ?? '1', crawlDelay: o.crawlDelay ?? 0, lastmod: o.lastmod ?? 'honest', log: [],
    paths: SYNTH_PATHS,
    changed: (version, path) => version !== '1' && hash32(`v|${version}|${path}`) % 1000 < CHANGE_PER_MILLE,
    close: async () => {},
  };
  Object.defineProperty(s, 'version', {
    enumerable: true,
    get: () => version,
    set: (v: string) => { if (v !== version) { version = v; changeMod = Date.now(); } },
  });
  const pageOf = (path: string) => {
    const rev = s.changed(s.version, path) ? `v${s.version}` : 'base';
    const mod = rev === 'base' ? BASE_MOD + (hash32(path) % 86_400) * 1000 : changeMod;
    const nav = '<nav aria-label="Main"><a href="/">Home</a><a href="/about">About</a><a href="/contact">Contact</a></nav>';
    const kind = path.split('/')[1] || 'home';
    const links = kind === 'home' ? SYNTH_PATHS.slice(1).map((p) => `<li><a href="${p}">${p}</a></li>`).join('') : '';
    const muted = kind === 'news' ? `<p class="muted">Posted in News. ${'This story tells families what is happening at school this month. '.repeat(2)}</p>` : '';
    const table = kind === 'events' ? '<table><caption>When</caption><tr><th scope="col">Day</th><th scope="col">Time</th></tr><tr><td>Saturday</td><td>10 am</td></tr></table>' : '';
    const form = kind === 'contact' ? '<form><label for="n">Name</label><input id="n" name="n"><input type="hidden" name="csrf_token" value="' + hash32(String(Date.now())) + '"><button>Send</button></form>' : '';
    const badImg = hash32(`img|${path}`) % 4 === 0 ? '<img src="/img/1.png" width="40" height="40">' : '';
    const update = rev === 'base' ? '' : `<section><h2>Update, November 4, 2026</h2><p>${'New information was added to this page for families. '.repeat(2)}</p></section>`;
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fernwood ${path}</title><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/site.css"><script src="/assets/site.js" defer></script></head><body><header>${nav}</header><main><h1>Fernwood: ${path}</h1><p>${'Fernwood Community serves families across the valley with schools, parks and services. '.repeat(2)}</p>${muted}${table}${form}${badImg}${update}<ul>${links}</ul></main><footer><p>Fernwood Community</p></footer></body></html>`;
    return { body, etag: `"${hash32(`${path}|${rev}`).toString(16)}"`, mod };
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const conditional = !!(req.headers['if-none-match'] || req.headers['if-modified-since']);
    const log = (status: number) => s.log.push({ path, method: req.method ?? 'GET', at: Date.now(), status, ua: String(req.headers['user-agent'] ?? ''), conditional, accept: String(req.headers.accept ?? ''), acceptLanguage: String(req.headers['accept-language'] ?? ''), cookie: !!req.headers.cookie });
    const send = (status: number, type: string, body: string, etag?: string, mod?: number) => {
      const h: Record<string, string> = { 'content-type': type, 'cache-control': 'no-cache' };
      if (etag) h.etag = etag;
      if (mod !== undefined) h['last-modified'] = new Date(mod).toUTCString();
      const inm = req.headers['if-none-match'];
      const ims = req.headers['if-modified-since'];
      if (status === 200 && ((inm && etag && inm === etag) || (!inm && ims && mod !== undefined && Math.floor(mod / 1000) * 1000 <= Date.parse(ims)))) {
        log(304);
        delete h['content-type'];
        return void res.writeHead(304, h).end();
      }
      log(status);
      res.writeHead(status, h).end(req.method === 'HEAD' ? undefined : body);
    };
    if (path === '/robots.txt') return send(200, 'text/plain', `User-agent: *\nAllow: /\n${s.crawlDelay ? `Crawl-delay: ${s.crawlDelay}\n` : ''}Sitemap: ${s.origin}/sitemap.xml\n`);
    if (path === '/sitemap.xml') {
      const now = new Date().toISOString();
      const urls = SYNTH_PATHS.map((p) => `<url><loc>${s.origin}${p}</loc><lastmod>${s.lastmod === 'now' ? now : new Date(pageOf(p).mod).toISOString().slice(0, 10)}</lastmod></url>`).join('');
      return send(200, 'application/xml', `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
    }
    if (path === '/assets/site.css') return send(200, 'text/css', css(s.assets), `"css-${hash32(css(s.assets)).toString(16)}"`, Date.UTC(2026, 8, 1));
    if (path === '/assets/site.js') return send(200, 'text/javascript', js(s.assets), `"js-${hash32(js(s.assets)).toString(16)}"`, Date.UTC(2026, 8, 1));
    if (path === '/img/1.png') {
      log(200);
      // A 1x1 grey PNG.
      return void res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABc3UBGAAAAABJRU5ErkJggg==', 'base64'));
    }
    if (SYNTH_PATHS.includes(path)) {
      const p = pageOf(path);
      return send(200, 'text/html; charset=utf-8', p.body, p.etag, p.mod);
    }
    send(404, 'text/html', '<!doctype html><html lang="en"><title>Not found</title><h1>Not found</h1></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  s.origin = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  s.close = () => new Promise((r) => server.close(() => r()));
  return s;
}
