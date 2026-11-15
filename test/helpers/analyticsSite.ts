// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A fixture site whose pages carry real-world analytics tags, and a fake collector that counts what
// they send. The tags load from the services' own host names (www.googletagmanager.com,
// us-assets.i.posthog.com, connect.facebook.net), which the test browser maps to the local collector
// (`ANALYTICS_HOST_RULES`, Chromium's --host-resolver-rules), so the engine sees the addresses a real
// site's tags use. Nothing leaves the machine. Used by the engine's and the Worker's tests.
import { createServer, type Server } from 'node:http';
import { startFixtureServer } from './fixtureServer.js';

/** The analytics hosts the fixture's tags use, all answered by the local collector. */
export const ANALYTICS_FIXTURE_HOSTS = [
  'www.googletagmanager.com', 'region1.google-analytics.com', 'www.google-analytics.com',
  'us-assets.i.posthog.com', 'us.i.posthog.com', 'connect.facebook.net', 'www.facebook.com',
] as const;

/** Chromium launch arguments that send the fixture's analytics hosts to the local collector. */
export const ANALYTICS_HOST_RULES = `--host-resolver-rules=${ANALYTICS_FIXTURE_HOSTS.map((h) => `MAP ${h} 127.0.0.1`).join(', ')}`;

/** What a tag sent: a hit records a visit; a script load is the tag itself (it must still load). */
export interface CollectorRequest {
  method: string;
  host: string;
  path: string;
  /** The screen size the page reported (`sr`), when it sent one. */
  sr?: string;
  kind: 'hit' | 'script';
}

/**
 * gtag-like: reads the screen as gtag does, then records the page view three ways (sendBeacon POST,
 * fetch POST, image GET), a Universal Analytics hit, and later events (a second event after a moment,
 * and one whenever the screen it reads changes, as gtag sends with every event). It also changes the
 * page: a visible line saying the tag ran, which a page whose UI depends on its analytics has.
 */
const gtag = (port: number) => `(function () {
  var C = 'http://region1.google-analytics.com:${port}', G = 'http://www.google-analytics.com:${port}';
  function sr() { return screen.width + 'x' + screen.height; }
  function q(en) { return 'v=2&tid=G-FIXTURE1&en=' + en + '&sr=' + sr() + '&dl=' + encodeURIComponent(location.href); }
  navigator.sendBeacon(C + '/g/collect?' + q('page_view'), '');
  fetch(C + '/g/collect?' + q('page_view_fetch'), { method: 'POST', mode: 'no-cors', keepalive: true, body: 'x' }).catch(function () {});
  new Image().src = G + '/g/collect?' + q('page_view_img');
  new Image().src = G + '/collect?v=1&tid=UA-1-1&t=pageview&sr=' + sr();
  var seen = sr();
  setInterval(function () { if (sr() !== seen) { seen = sr(); new Image().src = G + '/g/collect?' + q('screen_change'); } }, 100);
  setTimeout(function () { new Image().src = G + '/g/collect?' + q('user_engagement'); }, 1200);
  var el = document.getElementById('tag-status');
  if (el) { el.textContent = 'Analytics ready'; el.className = 'ready'; }
})();`;

/** posthog.js-like: posts the page view and asks for its flags, then shows a banner. */
const posthog = (port: number) => `(function () {
  var P = 'http://us.i.posthog.com:${port}';
  fetch(P + '/e/?sr=' + screen.width + 'x' + screen.height, { method: 'POST', mode: 'no-cors', body: '{"event":"$pageview"}' }).catch(function () {});
  fetch(P + '/batch/', { method: 'POST', mode: 'no-cors', body: '[]' }).catch(function () {});
  fetch(P + '/decide/?v=3', { method: 'POST', mode: 'no-cors', body: '{}' }).catch(function () {});
  var b = document.createElement('p'); b.id = 'ph-banner'; b.textContent = 'Welcome back'; document.querySelector('main').appendChild(b);
})();`;

/** fbevents.js-like: the Meta pixel's page view, an image GET to /tr. */
const fbevents = (port: number) => `new Image().src = 'http://www.facebook.com:${port}/tr?id=1&ev=PageView&sr=' + screen.width + 'x' + screen.height;`;

const page = (port: number, title: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Analytics fixture</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#111;background:#fff}header,main,footer{padding:16px 24px}
#tag-status{color:#444}#tag-status.ready{color:#0a5a2a;font-weight:600}.tall{min-height:1400px}</style>
<script async src="http://www.googletagmanager.com:${port}/gtag/js?id=G-FIXTURE1"></script>
<script async src="http://us-assets.i.posthog.com:${port}/static/array.js"></script>
<script async src="http://connect.facebook.net:${port}/en_US/fbevents.js"></script>
</head><body>
<header><nav aria-label="Main"><a href="/">Home</a> · <a href="/about.html">About</a> · <a href="/visit.html">Visit</a></nav></header>
<main><h1>${title}</h1>
<p id="tag-status">Analytics loading</p>
<p>A page of the fixture site. Its analytics tags record a visit, as a real site's do.</p>
<p><a href="/files/board.pdf">The board minutes (PDF)</a></p>
<button type="button" onclick="this.textContent='Pressed'">Press me</button>
<div class="tall"><p>More of the page, below the first screen.</p></div>
</main><footer><p>Fixture footer</p></footer></body></html>`;

export interface AnalyticsSite {
  /** The site (http://127.0.0.1:port). */
  origin: string;
  /** Everything the collector got, in order. */
  requests: CollectorRequest[];
  hits(): CollectorRequest[];
  scripts(): CollectorRequest[];
  /** Forget what the collector got so far. */
  reset(): void;
  close(): Promise<void>;
}

/**
 * Starts the collector and the site. `refuse`: that page answers 429 to every request without the
 * `unlessHeader` header (a site turning the scan away until a fresh session, the late retry, asks).
 */
export async function startAnalyticsSite(opts: { refuse?: { path: string; unlessHeader: string } } = {}): Promise<AnalyticsSite> {
  const requests: CollectorRequest[] = [];
  let port = 0;
  const collector: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const host = (req.headers.host ?? '').split(':')[0]!;
    const script = req.method === 'GET' && /^\/(?:gtag\/js|static\/array\.js|en_US\/fbevents\.js)$/.test(u.pathname);
    requests.push({ method: req.method ?? 'GET', host, path: u.pathname, ...(u.searchParams.get('sr') ? { sr: u.searchParams.get('sr')! } : {}), kind: script ? 'script' : 'hit' });
    if (script) {
      const body = u.pathname === '/gtag/js' ? gtag(port) : u.pathname === '/static/array.js' ? posthog(port) : fbevents(port);
      res.writeHead(200, { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' }).end(body);
      return;
    }
    res.writeHead(204, { 'access-control-allow-origin': '*' }).end();
  });
  await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
  port = (collector.address() as { port: number }).port;
  const html = { type: 'text/html; charset=utf-8' };
  const site = await startFixtureServer('site', {
    '/': { ...html, body: page(port, 'Home') },
    '/about.html': { ...html, body: page(port, 'About') },
    '/visit.html': { ...html, body: page(port, 'Visit') },
    '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' },
    '/files/board.pdf': { type: 'application/pdf', file: 'board.pdf' },
  }, {
    respond: (req, path) => {
      if (!opts.refuse || path !== opts.refuse.path || req.headers[opts.refuse.unlessHeader]) return undefined;
      return { status: 429, headers: { 'retry-after': '1' }, body: 'Too many requests' };
    },
  });
  return {
    origin: site.origin,
    requests,
    hits: () => requests.filter((r) => r.kind === 'hit'),
    scripts: () => requests.filter((r) => r.kind === 'script'),
    reset: () => { requests.length = 0; },
    close: async () => {
      await site.close();
      collector.closeAllConnections();
      await new Promise<void>((r) => collector.close(() => r()));
    },
  };
}
