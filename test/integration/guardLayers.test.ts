// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The request guard's structural layers in real Chromium (Plan 2, H0), checked against the fixture
// server's own request log:
// - speculative loads: a page can ask the browser to load other pages ahead of time (speculation
//   rules, prefetch and prerender links, the Speculation-Rules and Link headers). Speculation-rule
//   prefetches never reach `context.route` or CDP Fetch interception, so the guard must stop what it
//   can before the browser acts and detect what still goes out;
// - an outer guard: the hosted Worker routes the context itself (its target safety) before the
//   probes' guard is installed. What the probes' guard lets through must still reach that handler;
// - requests that end before the guard decides them (docs/triage/guard-prefetch-race.md): one the
//   page cancelled before the route saw it, or one the browser refused itself (a Content Security
//   Policy), never reached the network, so it does not stop the tests. One that may have reached it
//   still does.
import type { IncomingMessage } from 'node:http';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installGuard, type SandboxMode } from '../../src/probes/guard.js';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import { runProbes } from '../../src/probes/runner.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike, ContextLike, PageLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
/** Every request the fixture server got: method, path, Sec-Purpose. */
const requests: string[] = [];
const spec = () => requests.filter((r) => / \/pf\//.test(r));
/**
 * What the server itself saw that it must never see: an address only a speculative load asks for
 * (under /pf/), or any request that says it is one (Sec-Purpose: prefetch or prerender).
 */
const speculativeSeen = () => requests.filter((r) => {
  const [, path = '', ...purpose] = r.split(' ');
  return path.startsWith('/pf/') || /\b(prefetch|prerender)\b/i.test(purpose.join(' '));
});

/** A probe that only checks it ran: the page loaded and was checked. */
const ran: PageProbe = {
  id: 'ran', criteria: ['0.0.1'], kind: 'interaction', tier: 'core', timeoutMs: 15_000,
  async run() {
    return [{ criterion: '0.0.1', status: 'no_failures_found', detail: 'ran' }];
  },
};

/**
 * The page cancels prefetch links in the task that made them: for each, it inserts a link, makes it
 * a prefetch (the browser starts the request and reports it) and removes it (the browser cancels it,
 * net::ERR_ABORTED). The listener hook defuses a prefetch link on insertion and on a later rel change,
 * but only after this task. Each cancellation races Chromium's request-stage pause: one that wins is
 * reported and ends with no route at all (Playwright never had one to give), as the HTML prefetch
 * link did on a loaded Linux box. With thirty, some win: the base build failed the load check 5 of
 * 5 times on a Mac with sandbox off. None is ever sent.
 */
const CANCEL_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Cancelled prefetches</title>
<script>
  for (var i = 0; i < 30; i++) {
    var l = document.createElement('link'); l.href = '/pf/cancelled-' + i; document.head.appendChild(l);
    l.rel = 'prefetch'; l.remove();
  }
</script>
</head><body><main><h1>Cancelled prefetches</h1><p>A page.</p></main></body></html>`;

/**
 * Speculative loads on demand: a speculation rule for an address the server holds (`addHeld`), and prefetch
 * links the page makes and removes in one task (`cancelLinks`). With no listener hook (the guard alone), such a
 * link is reported, never routed, and fails net::ERR_ABORTED (checked in Chromium 149: 16 of 16): the
 * cancellation the guard judges, for an address of the test's choosing.
 */
const SAME_ADDRESS_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Same address</title></head>
<body><main><h1>Same address</h1></main><script>
  // n addresses each: prefix + 0 .. prefix + n-1 (the browser makes one request for identical links in one task).
  window.addHeld = function (prefix, n) {
    var urls = []; for (var i = 0; i < n; i++) urls.push(prefix + i);
    var s = document.createElement('script'); s.type = 'speculationrules';
    s.textContent = JSON.stringify({ prefetch: [{ source: 'list', urls: urls }] }); document.head.append(s);
  };
  window.cancelLinks = function (prefix, n) {
    for (var i = 0; i < n; i++) { var l = document.createElement('link'); l.href = prefix + i; document.head.appendChild(l); l.rel = 'prefetch'; l.remove(); }
  };
</script></body></html>`;

/** The page's own Content Security Policy refuses its image: the browser never sends it. */
const CSP_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Refused image</title></head>
<body><main><h1>Refused image</h1><p><img src="/csp/refused.png" alt="A refused picture"></p></main></body></html>`;

const PF_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Speculative loads</title>
<script type="speculationrules">{"prefetch":[{"source":"list","urls":["/pf/sr-inline"]},{"source":"document","where":{"href_matches":"/pf/doc-*"},"eagerness":"immediate"}]}</script>
<link rel="prefetch" href="/pf/link-html">
<link rel="prerender" href="/pf/link-prerender">
</head><body>
<main><h1>Speculative loads</h1><p><a href="/pf/doc-1">A page the rules prefetch</a></p></main>
<script>
  // What a page adds later: speculation rules and prefetch links (a probe calls these).
  window.addLinks = function () {
    var l = document.createElement('link'); l.rel = 'prefetch'; l.href = '/pf/link-script'; document.head.appendChild(l);
    var p = document.createElement('link'); p.rel = 'prerender'; p.href = '/pf/link-script-prerender'; document.head.appendChild(p);
  };
  window.addRules = function () {
    var s = document.createElement('script'); s.type = 'speculationrules';
    s.textContent = JSON.stringify({ prefetch: [{ source: 'list', urls: ['/pf/sr-script'] }] });
    document.head.append(s);
  };
</script>
</body></html>`;

beforeAll(async () => {
  server = await startFixtureServer('probes', {
    '/pf-page.html': {
      type: 'text/html; charset=utf-8', body: PF_PAGE,
      headers: { 'speculation-rules': '"/pf-rules.json"', link: '</pf/link-header>; rel=prefetch, </pf-style.css>; rel=preload; as=style' },
    },
    '/pf-rules.json': { type: 'application/speculationrules+json', body: '{"prefetch":[{"source":"list","urls":["/pf/sr-header"]}]}' },
    '/frames-page.html': {
      type: 'text/html; charset=utf-8',
      body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Frames</title></head><body><main><h1>Frames</h1>'
        + '<form id="quiz" action="/fr/result.html" target="results"><input name="answer" value="42"></form>'
        + '<iframe name="results" title="Results" src="about:blank"></iframe>'
        + '<iframe id="a" name="a" title="A" src="/fr/a.html"></iframe></main></body></html>',
    },
    '/fr/a.html': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>A</title><p>A</p>' },
    '/fr/late.html': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>Late</title><p>Late</p>' },
    '/fr/b.html': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>B</title><p>B</p>' },
    '/outer.html': { type: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en"><title>Outer guard</title><main><h1>Outer guard</h1><p><a href="/a.html">A link</a></p></main></html>' },
    '/cancel-page.html': { type: 'text/html; charset=utf-8', body: CANCEL_PAGE },
    '/csp-page.html': { type: 'text/html; charset=utf-8', body: CSP_PAGE, headers: { 'content-security-policy': "img-src 'none'" } },
    '/same-address.html': { type: 'text/html; charset=utf-8', body: SAME_ADDRESS_PAGE },
  }, {
    onRequest: (req: IncomingMessage) => requests.push(`${req.method} ${req.url} ${req.headers['sec-purpose'] ?? ''}`.trim()),
    // Held: the server has these and never answers in time (the browser gives up on a prefetch after 10 s).
    delayMs: (path) => (path.startsWith('/pf/held-timeout') ? 11_000 : path.startsWith('/pf/held-same') ? 8_000 : 0),
  });
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** The guard alone (no listener hook), as `sandbox` sets it, on a fresh context. */
async function guardOnly(sandbox: SandboxMode, url: string) {
  const context: BrowserContext = await browser.newContext();
  const page = await context.newPage();
  const guard = (await installGuard(context as unknown as ContextLike, page as unknown as PageLike, url, { sandbox }))!;
  return { context, page, guard };
}

describe('speculative loads with the listener hook OFF (the guard\'s own layers)', () => {
  for (const sandbox of ['auto', 'always'] as const) {
    it(`prefetch and prerender links (in the HTML, by Link header, added by script) and Speculation-Rules header rules are never requested (sandbox ${sandbox})`, async () => {
      requests.length = 0;
      const url = `${server.origin}/pf-page.html`;
      const t = await guardOnly(sandbox, url);
      try {
        expect(t.guard.popupSandbox).toBe('on');
        await t.page.goto(url);
        t.guard.setPageUrl(t.page.url());
        t.guard.setPhase({ probe: 'spec' });
        await t.page.evaluate(() => (window as unknown as { addLinks(): void }).addLinks());
        await t.page.waitForTimeout(1200);
        const got = spec().map((r) => r.split(' ')[1]);
        for (const p of ['/pf/link-html', '/pf/link-prerender', '/pf/link-header', '/pf/link-script', '/pf/link-script-prerender', '/pf/sr-header']) expect(got, p).not.toContain(p);
        // An ordinary preload the Link header asks for is not speculative: it is a load of the page.
        expect(requests.some((r) => r.startsWith('GET /pf-style.css'))).toBe(true);
      } finally {
        await t.context.close();
      }
    }, 30_000);
  }

  it('with no CDP session (sandbox off: context.route alone), prefetch links are still never requested', async () => {
    requests.length = 0;
    const url = `${server.origin}/pf-page.html`;
    const t = await guardOnly('off', url);
    try {
      await t.page.goto(url);
      t.guard.setPhase({ probe: 'spec' });
      await t.page.evaluate(() => (window as unknown as { addLinks(): void }).addLinks());
      await t.page.waitForTimeout(1200);
      const got = spec().map((r) => r.split(' ')[1]);
      for (const p of ['/pf/link-html', '/pf/link-header', '/pf/link-script']) expect(got, p).not.toContain(p);
    } finally {
      await t.context.close();
    }
  }, 30_000);

  it('a speculation-rules prefetch no interception can stop is detected: the probe\'s requests are not settled', async () => {
    requests.length = 0;
    const url = `${server.origin}/pf-page.html`;
    const t = await guardOnly('auto', url);
    try {
      await t.page.goto(url);
      t.guard.setPageUrl(t.page.url());
      // The rules in its HTML went out as it loaded (no hook here): unchecked, but not under the probe.
      expect(await t.guard.log.settled!(2000, 'spec'), 'nothing unchecked under the probe before it ran').toBe(true);
      t.guard.setPhase({ probe: 'spec' });
      await t.page.evaluate(() => (window as unknown as { addRules(): void }).addRules());
      await expect.poll(() => spec().map((r) => r.split(' ')[1]), { timeout: 3000 }).toContain('/pf/sr-script');
      // The browser made it by itself, outside the guard: what the probe saw cannot be trusted.
      expect(await t.guard.log.settled!(2000, 'spec')).toBe(false);
    } finally {
      await t.context.close();
    }
  }, 30_000);
});

describe('speculative loads with both layers (the probe runner)', () => {
  for (const popupSandbox of ['auto', 'always'] as const) {
    it(`nothing speculative is ever requested while the keyboard probe and a page that adds rules run (sandbox ${popupSandbox})`, async () => {
      requests.length = 0;
      const adds: PageProbe = {
        id: 'adds', criteria: ['0.0.1'], kind: 'interaction', tier: 'core', timeoutMs: 15_000,
        async run(ctx) {
          await ctx.page.evaluate(() => { const w = window as unknown as { addLinks(): void; addRules(): void }; w.addLinks(); w.addRules(); }, undefined);
          await ctx.page.waitForTimeout(1000);
          return [{ criterion: '0.0.1', status: 'no_failures_found', detail: 'ran' }];
        },
      };
      const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/pf-page.html`, index: 0 }], [keyboardProbe, adds], { userAgent: 'grnted-test', popupSandbox });
      // Safety first, from the server's own log: whatever the runs say, nothing speculative reached it.
      expect(speculativeSeen(), 'the server never saw a speculative request').toEqual([]);
      expect(runs.map((r) => r.status)).toEqual(['ok', 'ok']);
      expect(runs[1]!.findings).toEqual([{ criterion: '0.0.1', status: 'no_failures_found', detail: 'ran' }]);
      expect(spec()).toEqual([]);
    }, 60_000);
  }
});

describe('a request that ends before the guard decides it', () => {
  for (const popupSandbox of ['auto', 'always'] as const) {
    it(`prefetches the page cancelled before the route saw them were never sent: the page is tested (sandbox ${popupSandbox})`, async () => {
      requests.length = 0;
      const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/cancel-page.html`, index: 0 }], [ran], { userAgent: 'grnted-test', popupSandbox });
      expect(speculativeSeen(), 'the server never saw a cancelled prefetch').toEqual([]);
      expect(requests.some((r) => r.startsWith('GET /cancel-page.html'))).toBe(true);
      expect(runs.map((r) => r.status)).toEqual(['ok']);
      expect(runs[0]!.findings).toEqual([{ criterion: '0.0.1', status: 'no_failures_found', detail: 'ran' }]);
    }, 60_000);
  }

  for (const popupSandbox of ['auto', 'always', 'off'] as const) {
    it(`an image the page's own Content Security Policy refused was never sent: the page is tested (sandbox ${popupSandbox})`, async () => {
      requests.length = 0;
      const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/csp-page.html`, index: 0 }], [ran], { userAgent: 'grnted-test', popupSandbox });
      expect(requests.filter((r) => r.includes('/csp/')), 'the server never saw the refused image').toEqual([]);
      expect(runs.map((r) => r.status)).toEqual(['ok']);
    }, 60_000);
  }

  /** Failures the context reports for addresses under `prefix`, as they come (the guard's own listener runs first). */
  function failuresOf(context: BrowserContext, prefix: string): string[] {
    const out: string[] = [];
    context.on('requestfailed', (r) => { if (new URL(r.url()).pathname.startsWith(prefix)) out.push(r.failure()?.errorText ?? ''); });
    return out;
  }
  type Speculative = { addHeld(prefix: string, n: number): void; cancelLinks(prefix: string, n: number): void };

  for (const sandbox of ['auto', 'always'] as const) {
    it(`a prefetch link cancelled before the route saw it (a real route-less net::ERR_ABORTED) is proven never sent (sandbox ${sandbox})`, async () => {
      requests.length = 0;
      const url = `${server.origin}/same-address.html`;
      const t = await guardOnly(sandbox, url);
      try {
        await t.page.goto(url);
        t.guard.setPageUrl(t.page.url());
        t.guard.setPhase({ probe: 'b' });
        const failed = failuresOf(t.context, '/pf/cancel-control-');
        await t.page.evaluate(() => (window as unknown as Speculative).cancelLinks('/pf/cancel-control-', 10));
        await expect.poll(() => failed.length, { timeout: 5000 }).toBe(10);
        expect(failed, 'some cancellations reached the guard with no route').toContain('net::ERR_ABORTED');
        expect(await t.guard.log.settled!(2000, 'b')).toBe(true);
        expect(speculativeSeen()).toEqual([]);
      } finally {
        await t.context.close();
      }
    }, 30_000);
  }

  it('the look-alike, same address: real route-less net::ERR_ABORTED cancellations of an address the browser\'s own prefetch took to the server are never proven never sent', async () => {
    requests.length = 0;
    const url = `${server.origin}/same-address.html`;
    const t = await guardOnly('auto', url);
    try {
      await t.page.goto(url);
      t.guard.setPageUrl(t.page.url());
      t.guard.setPhase({ probe: 'a' });
      await t.page.evaluate(() => (window as unknown as Speculative).addHeld('/pf/held-same-', 1));
      // The server has it: it reached the network (and is not answered while the test runs).
      await expect.poll(() => spec().map((r) => r.split(' ')[1]), { timeout: 5000 }).toContain('/pf/held-same-0');
      // Probe a stays on until the guard has the browser's report of that prefetch (its speculation-rules check
      // charges the probe running when the report comes; on a busy box it can come after the server's copy).
      // So nothing of it can unsettle probe b, whatever the order.
      await expect.poll(() => t.guard.log.settled!(100, 'a'), { timeout: 10_000 }).toBe(false);
      t.guard.setPhase('between');
      t.guard.setPhase({ probe: 'b' });
      // Five cancelled links for that same address, one task each (in one task the browser makes one request).
      const failed = failuresOf(t.context, '/pf/held-same-');
      for (let i = 1; i <= 5; i++) {
        await t.page.evaluate(() => (window as unknown as Speculative).cancelLinks('/pf/held-same-', 1));
        await expect.poll(() => failed.length, { timeout: 5000 }).toBe(i);
      }
      expect(failed, 'the exemption was offered real route-less cancellations').toContain('net::ERR_ABORTED');
      // Probe b ran none of the speculation rules, and their report was charged to probe a before b began:
      // only the guard's judgment of b's cancellations can unsettle it.
      expect(await t.guard.log.settled!(2000, 'b')).toBe(false);
    } finally {
      await t.context.close();
    }
  }, 30_000);

  for (const sandbox of ['auto', 'off'] as const) {
    it(`the look-alike in time: a speculation-rules prefetch the server got and never answered, which the browser gives up on (no route, no response, net::ERR_TIMED_OUT), still leaves the probe's requests unsettled (sandbox ${sandbox})`, async () => {
      requests.length = 0;
      const url = `${server.origin}/same-address.html`;
      const t = await guardOnly(sandbox, url);
      try {
        await t.page.goto(url);
        t.guard.setPageUrl(t.page.url());
        expect(await t.guard.log.settled!(2000, 'spec'), 'nothing unchecked under the probe before it ran').toBe(true);
        t.guard.setPhase({ probe: 'spec' });
        const failed = failuresOf(t.context, '/pf/held-timeout-');
        await t.page.evaluate(() => (window as unknown as Speculative).addHeld('/pf/held-timeout-', 1));
        await expect.poll(() => spec().map((r) => r.split(' ')[1]), { timeout: 5000 }).toContain('/pf/held-timeout-0');
        // Playwright reports it only when it fails (it never had a route for it).
        await expect.poll(() => failed, { timeout: 15_000 }).toEqual(['net::ERR_TIMED_OUT']);
        expect(await t.guard.log.settled!(2000, 'spec')).toBe(false);
      } finally {
        await t.context.close();
      }
    }, 40_000);
  }
});

describe('an outer guard on the context (the hosted Worker\'s target safety)', () => {
  /** The real browser, with a context route installed before the probes' guard that refuses `refuse`. */
  function outer(refuse: (url: URL) => boolean, refused: string[]): BrowserLike {
    return {
      async newContext(o: Parameters<Browser['newContext']>[0]) {
        const context = await browser.newContext(o);
        await context.route(/.*/, async (route) => {
          const u = new URL(route.request().url());
          if (refuse(u)) {
            refused.push(`${u.host}${u.pathname}`);
            await route.abort('blockedbyclient');
          } else {
            await route.fallback();
          }
        });
        return context;
      },
    } as unknown as BrowserLike;
  }

  it('what the probes\' guard allows still goes through the outer handler: a probe cannot reach a host it refuses', async () => {
    requests.length = 0;
    const refused: string[] = [];
    const other = server.origin.replace('127.0.0.1', 'localhost');
    const reach: PageProbe = {
      id: 'reach', criteria: ['0.0.1'], kind: 'interaction', tier: 'core', timeoutMs: 15_000,
      async run(ctx) {
        const out = await ctx.page.evaluate(async (o: string) => {
          const tries = [`${o}/outer-secret.json`, '/outer-blocked/data.json'];
          const r: string[] = [];
          for (const u of tries) r.push(await fetch(u).then((x) => `ok ${x.status}`, () => 'failed'));
          const img = new Image();
          img.src = `${o}/outer-secret.png`;
          await new Promise((res) => { img.onload = img.onerror = res; setTimeout(res, 1000); });
          return r;
        }, other);
        return [{ criterion: '0.0.1', status: 'no_failures_found', detail: out.join(', ') }];
      },
    };
    const refuse = (u: URL) => u.hostname === 'localhost' || u.pathname.startsWith('/outer-blocked/');
    const runs = await runProbes(outer(refuse, refused), [{ url: `${server.origin}/outer.html`, index: 0 }], [reach, keyboardProbe], { userAgent: 'grnted-test' });
    expect(runs.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(runs[0]!.findings[0]!.detail).toBe('failed, failed');
    expect(requests.filter((r) => /outer-secret|outer-blocked/.test(r))).toEqual([]);
    expect(refused.length).toBeGreaterThanOrEqual(3);
    // The outer handler did not get in the way of the page itself.
    expect(runs[1]!.findings.filter((f) => f.status === 'failed')).toEqual([]);
  }, 60_000);
});

describe('frames after the load phase: only the recorded load-time address can load again', () => {
  it('a form submitted into a named frame, and a script sending a frame elsewhere, are never requested; the frames keep their documents; only the recorded load-time address can load again', async () => {
    requests.length = 0;
    const url = `${server.origin}/frames-page.html`;
    const t = await guardOnly('off', url);
    try {
      await t.page.goto(url);
      // Frames load as the page has them while it loads.
      await expect.poll(() => requests.some((r) => r.startsWith('GET /fr/a.html'))).toBe(true);
      t.guard.setPageUrl(t.page.url());
      await t.guard.setPhase({ probe: 'frames' });
      // The native submit (no listener hook here: the guard alone), a default-GET form into "results".
      await t.page.evaluate(() => HTMLFormElement.prototype.submit.call(document.getElementById('quiz') as HTMLFormElement));
      await t.page.evaluate(() => { (window.frames as unknown as Record<string, Window>)['a']!.location.href = '/fr/elsewhere.html'; });
      await t.page.waitForTimeout(800);
      // Neither a later src nor a form aimed at that later src is a load-time request.
      await t.page.evaluate(() => {
        const f = document.createElement('iframe'); f.title = 'Late'; f.src = '/fr/late.html'; document.querySelector('main')!.append(f);
        (document.getElementById('a') as HTMLIFrameElement).src = '/fr/b.html';
        (document.querySelector('iframe[name="results"]') as HTMLIFrameElement).src = '/fr/result.html?answer=42';
      });
      await t.page.waitForTimeout(800);
      expect(requests.filter((r) => /\/fr\/(late|b|result)\.html/.test(r))).toEqual([]);
      // Retained native submission to precisely the src set above still cannot send the field.
      await t.page.evaluate(() => HTMLFormElement.prototype.submit.call(document.getElementById('quiz') as HTMLFormElement));
      await t.page.waitForTimeout(300);
      expect(requests.filter((r) => r.includes('/fr/result.html'))).toEqual([]);
      // An identical load-time src is visitor-equivalent and can load again.
      await t.page.evaluate(() => { (document.getElementById('a') as HTMLIFrameElement).src = '/fr/a.html'; });
      await expect.poll(() => requests.filter((r) => r.startsWith('GET /fr/a.html')).length).toBe(2);
      expect(requests.filter((r) => r.includes('/fr/result.html') || r.includes('/fr/elsewhere.html'))).toEqual([]);
      const results = t.page.frames().find((f) => f.name() === 'results')!;
      expect(results.url()).toBe('about:blank');
      const kept = t.guard.log.events.filter((e) => e.kind === 'frame').map((e) => new URL(e.url!).pathname);
      expect(kept).toEqual(expect.arrayContaining(['/fr/result.html', '/fr/elsewhere.html']));
    } finally {
      await t.context.close();
    }
  }, 30_000);
});
