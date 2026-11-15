// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { createServer } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installGuard } from '../../src/probes/guard.js';
import { listenerHookScript, readHooks } from '../../src/probes/listeners.js';
import { formsProbe } from '../../src/probes/forms.js';
import { DOCUMENT_CHANGED, runProbes } from '../../src/probes/runner.js';
import type { PageProbe } from '../../src/probes/types.js';
import { isTimeWarning, timingProbe, timingWatchProbe } from '../../src/probes/timing.js';
import type { BrowserLike, ContextLike, PageLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const requests: string[] = [];
const form = '<form action="/quiz"><input name="answer" value="42"><button>Submit</button></form>';
beforeAll(async () => {
  server = await startFixtureServer('probes', {
    '/quiz': { type: 'text/html', body: '<!doctype html><title>Quiz</title>' + form },
    '/shadow': { type: 'text/html', body: '<!doctype html><title>Quiz</title><div data-shadow><template shadowrootmode="open">' + form.replace('/quiz', '/shadow') + '</template></div>' },
    '/delegated': { type: 'text/html', body: `<!doctype html><title>Preferences</title>
      <form method="post" action="/preferences"><label>Language <select><option>English</option><option>French</option></select></label><button>Save</button></form>
      <p id="status"></p><script>
      document.querySelector('select').onchange = () => document.querySelector('button').click();
      document.addEventListener('submit', e => { if (e.defaultPrevented) return; e.preventDefault(); document.querySelector('#status').textContent = 'Saved'; });
      </script>` },
    '/reentrant': { type: 'text/html', body: `<!doctype html><title>Preferences</title>
      <form id="outer" method="post" action="/preferences"><label>Language <select><option>English</option><option>French</option></select></label><button>Save</button></form>
      <form id="other"></form><p id="status"></p><script>
      document.querySelector('select').onchange = () => document.querySelector('button').click();
      document.querySelector('#outer').onsubmit = () => document.querySelector('#other').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      document.addEventListener('submit', e => { if (e.target.id !== 'outer' || e.defaultPrevented) return; e.preventDefault(); document.querySelector('#status').textContent = 'Saved'; });
      </script>` },
    '/frames': { type: 'text/html', body: '<!doctype html><title>Frames</title><iframe src="about:blank"></iframe>' },
  }, { onRequest: (r) => requests.push(`${r.method} ${r.url}`) });
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

describe('round 4 safety backstop and submit dispatch', () => {
  it.each(['/quiz', '/shadow'])('stopped cancellation on %s during a non-strict resize sends no named-control GET', async (path) => {
    const context = await browser.newContext();
    await context.addInitScript({ content: listenerHookScript() });
    const page = await context.newPage();
    const guard = (await installGuard(context as unknown as ContextLike, page as unknown as PageLike, `${server.origin}${path}`, { sandbox: 'off' }))!;
    try {
      await page.goto(`${server.origin}${path}`);
      await guard.setPhase({ probe: 'orientation' });
      requests.length = 0;
      await page.evaluate(() => {
        const root = document.querySelector('[data-shadow]')?.shadowRoot ?? document;
        root.querySelector('form')!.addEventListener('submit', (e) => e.stopImmediatePropagation());
        window.onresize = () => (root.querySelector('button') as HTMLButtonElement).click();
      });
      await page.setViewportSize({ width: 900, height: 700 });
      await expect.poll(() => guard.log.events.some((e) => e.url?.includes('answer=42'))).toBe(true);
      expect(requests).toEqual([]);
    } finally { await context.close(); }
  });

  it.each(['parser-created', 'existing before hook', 'inserted later'])('the %s declarative shadow root gets the canceller', async (when) => {
    const context = await browser.newContext();
    if (when !== 'existing before hook') await context.addInitScript({ content: listenerHookScript() });
    const page = await context.newPage();
    try {
      await page.goto(`${server.origin}${when === 'inserted later' ? '/quiz' : '/shadow'}`);
      if (when === 'existing before hook') await page.addScriptTag({ content: listenerHookScript() });
      if (when === 'inserted later') {
        await page.evaluate((html) => {
          const parsed = Document.parseHTMLUnsafe('<div data-shadow><template shadowrootmode="open">' + html + '</template></div>');
          document.body.append(document.adoptNode(parsed.querySelector('[data-shadow]')!));
        }, form);
      }
      requests.length = 0;
      const cancelled = await page.evaluate(async () => {
        const root = document.querySelector('[data-shadow]')!.shadowRoot!;
        let event: Event | undefined;
        root.querySelector('form')!.addEventListener('submit', (e) => { event = e; });
        (root.querySelector('button') as HTMLButtonElement).click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        return event?.defaultPrevented;
      });
      expect(cancelled).toBe(true);
      expect(requests).toEqual([]);
    } finally { await context.close(); }
  });

  it('a delegated document handler cancels after select input: no false 3.2.2 and no request', async () => {
    requests.length = 0;
    const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/delegated`, index: 0 }], [formsProbe], { userAgent: 'test', settleMs: 0, full: true });
    expect(runs[0]!.findings.filter((f) => f.criterion === '3.2.2' && f.status === 'failed')).toEqual([]);
    expect(runs[0]!.status).toBe('ok');
    expect(runs[0]!.findings).toContainEqual(expect.objectContaining({ criterion: '3.2.2', status: 'no_failures_found' }));
    expect(requests.filter((r) => !r.startsWith('GET /delegated'))).toEqual([]);
  });

  it('an unrelated nested submit neither cancels the outer event nor consumes its finalizer: no false 3.2.2', async () => {
    requests.length = 0;
    const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/reentrant`, index: 0 }], [formsProbe], { userAgent: 'test', settleMs: 0, full: true });
    expect(runs[0]!.status).toBe('ok');
    expect(runs[0]!.findings.filter((f) => f.criterion === '3.2.2' && f.status === 'failed')).toEqual([]);
    expect(runs[0]!.findings).toContainEqual(expect.objectContaining({ criterion: '3.2.2', status: 'no_failures_found' }));
    expect(requests.filter((r) => !r.startsWith('GET /reentrant'))).toEqual([]);
  });

  it('the finalizer still cancels its own submit after ignoring an unrelated nested event', async () => {
    const context = await browser.newContext();
    await context.addInitScript({ content: listenerHookScript() });
    const page = await context.newPage();
    try {
      await page.goto(`${server.origin}/quiz`);
      requests.length = 0;
      const cancelled = await page.evaluate(() => {
        const other = document.createElement('form');
        document.body.append(other);
        let outer: Event | undefined;
        document.querySelector('form')!.addEventListener('submit', (e) => {
          outer = e;
          other.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        document.querySelector('button')!.click();
        return outer?.defaultPrevented;
      });
      expect(cancelled).toBe(true);
      expect(requests).toEqual([]);
    } finally { await context.close(); }
  });

  it('a deferred snapshot evaluation cannot authorize a frame address assigned after load', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const guard = (await installGuard(context as unknown as ContextLike, page as unknown as PageLike, `${server.origin}/frames`, { sandbox: 'off' }))!;
    try {
      await page.goto(`${server.origin}/frames`);
      const owner = page.mainFrame();
      const evaluate = owner.evaluate.bind(owner);
      let release!: () => void;
      const deferred = new Promise<void>((resolve) => { release = resolve; });
      owner.evaluate = (async (...args: Parameters<typeof owner.evaluate>) => {
        await deferred;
        return evaluate(...args);
      }) as typeof owner.evaluate;
      const phase = guard.setPhase({ probe: 'orientation' });
      requests.length = 0;
      const decided = page.waitForEvent('requestfailed', { predicate: (r) => r.url().includes('/record?answer=42'), timeout: 3000 });
      await evaluate(() => { document.querySelector('iframe')!.src = '/record?answer=42'; });
      release();
      await phase;
      await decided;
      expect(requests).toEqual([]);
      expect(guard.log.events).toContainEqual(expect.objectContaining({ kind: 'frame', url: `${server.origin}/record?answer=42` }));
    } finally { await context.close(); }
  });
});

describe('round 4 warning words', () => {
  it.each(['noon', '5 pm', '17:00'])('keeps the expiry clause at %s beside a browser-close cookie clause', (time) => {
    const at = time === '17:00' ? 'by' : 'at';
    expect(isTimeWarning(`Your session expires ${at} ${time}; session cookies expire when you close the browser.`)).toBe(true);
    expect(isTimeWarning(`Session cookies expire ${at} ${time} when you close the browser.`)).toBe(true);
    expect(isTimeWarning('Session cookies expire when you close the browser.')).toBe(false);
  });

  it.each(['aria-hidden', 'inert', 'hidden-ancestor', 'html-reveal', 'cookie-clause'])('%s is judged by exposure and clause boundaries', async (shape) => {
    const context = await browser.newContext();
    await context.addInitScript({ content: listenerHookScript() });
    const page = await context.newPage();
    try {
      await page.goto(`${server.origin}/quiz`);
      await page.evaluate((shape) => {
        setTimeout(() => {
          const p = document.createElement('p');
          p.textContent = 'Your session has expired.';
          p.setAttribute('aria-live', 'polite');
          p.style.opacity = '0';
          if (shape === 'aria-hidden') p.setAttribute('aria-hidden', 'true');
          if (shape === 'inert') p.inert = true;
          if (shape === 'hidden-ancestor') { document.querySelector('form')!.setAttribute('aria-hidden', 'true'); document.querySelector('form')!.append(p); }
          else document.body.append(p);
          if (shape === 'html-reveal') {
            p.removeAttribute('aria-live'); p.style.opacity = '1';
            document.documentElement.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000, delay: 1000, fill: 'both' });
            document.querySelectorAll('input,button').forEach((e) => (e as HTMLInputElement).disabled = true);
          }
          if (shape === 'cookie-clause') { p.style.opacity = '1'; p.textContent = 'Your session expires at noon; session cookies expire when you close the browser.'; }
        }, 15000);
      }, shape);
      // Exercise production collect with the normal kit and timing probe, before closing this page.
      const findings = await timingProbe.run({ page, url: page.url(), viewport: { width: 1280, height: 900 }, signal: new AbortController().signal,
        guard: { events: [], mark: () => 0, since: () => [] }, listeners: async () => [], hooks: async () => (await page.evaluate(readHooks))!, deadline: Date.now() + 10000 } as unknown as Parameters<typeof timingProbe.run>[0]);
      // Exposed (and not only a browser-close cookie clause): the warning is found, and named in the finding. (Batch 17's
      // 2.2.1 audit: on this page, titled "Quiz", or as a warning that a session will end, it is no failure by itself.)
      expect(findings.some((f) => f.status !== 'no_failures_found' && /a warning appears/.test(f.detail))).toBe(['html-reveal', 'cookie-clause'].includes(shape));
      expect(findings.some((f) => f.status === 'failed')).toBe(false);
    } finally { await context.close(); }
  });
});

it('timing-watch discards the failure measured after an exact-address reload redirects to another document', async () => {
  let loads = 0;
  const site = createServer((req, res) => {
    if (req.url === '/quiz' && ++loads === 1) {
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Quiz</title>
        <meta http-equiv="refresh" content="2">
        <button onclick="document.querySelector('meta').remove()">Turn off automatic sign-out</button>
        <script>navigation.addEventListener('navigate', e => e.stopImmediatePropagation());</script>`);
    } else if (req.url === '/quiz') res.writeHead(302, { location: '/expired' }).end();
    else res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Expired</title><p>Signed out</p>');
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const { port } = site.address() as { port: number };
  try {
    const [run] = await runProbes(browser as unknown as BrowserLike, [{ url: `http://127.0.0.1:${port}/quiz`, index: 0 }], [timingWatchProbe], { userAgent: 'test', settleMs: 0, full: true });
    expect(loads).toBe(2);
    expect(run!.findings).toEqual([expect.objectContaining({ criterion: '2.2.1', status: 'not_testable' })]);
  } finally { await new Promise<void>((resolve) => site.close(() => resolve())); }
}, 30000);

it.each([false, true].flatMap((boxed) => ['redirected-reload', 'same-address-reload', 'owned-redirect', 'owned-redirect-back'].map((shape) => ({ boxed, shape }))))('round 9: $shape during an owned load (boxed: $boxed)', async ({ boxed, shape }) => {
  let loads = 0;
  const site = createServer((req, res) => {
    if (req.url === '/quiz') loads++;
    if (req.url === '/quiz' && (shape === 'redirected-reload' && loads === 3 || shape === 'owned-redirect' && loads === 2)) res.writeHead(302, { location: '/expired' }).end();
    else if (req.url === '/quiz' && shape === 'owned-redirect-back' && loads === 2) res.writeHead(302, { location: '/return' }).end();
    else if (req.url === '/return') res.writeHead(302, { location: '/quiz#loaded' }).end();
    else res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Quiz</title><p>Quiz</p>');
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const { port } = site.address() as { port: number };
  const url = `http://127.0.0.1:${port}/quiz`;
  const controlled = { async newContext(options: Parameters<Browser['newContext']>[0]) {
    const context = await browser.newContext(options);
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      const goto = page.goto.bind(page), evaluate = page.evaluate.bind(page);
      let calls = 0, replace = false;
      page.goto = async (...args) => {
        const response = await goto(...args);
        replace = ++calls === 2 && shape.endsWith('reload');
        return response;
      };
      page.evaluate = (async (...args: Parameters<typeof page.evaluate>) => {
        if (typeof args[0] === 'function' && args[0].name === 'documentId' && replace) {
          replace = false;
          const loaded = page.waitForEvent('load');
          await evaluate(() => { location.reload(); });
          await loaded;
        }
        return evaluate(...args);
      }) as typeof page.evaluate;
      return page;
    };
    return context;
  } } as unknown as BrowserLike;
  const reloading: PageProbe = {
    id: 'reloading', criteria: ['2.1.1'], kind: 'interaction', tier: 'core', timeoutMs: 10000, ...(boxed ? { freshAfterFiredTimers: true } : {}),
    async run(ctx) {
      await ctx.page.goto(ctx.url, { waitUntil: 'load' });
      return [{ criterion: '2.1.1', status: 'failed', detail: `measured on ${ctx.page.url!()}` }];
    },
  };
  try {
    const [run] = await runProbes(controlled, [{ url, index: 0 }], [reloading], { userAgent: 'test', settleMs: 0 });
    expect(loads).toBe(shape === 'owned-redirect' ? 2 : 3);
    expect(run!.findings).toEqual(shape === 'owned-redirect-back'
      ? [{ criterion: '2.1.1', status: 'failed', detail: `measured on ${url}#loaded` }]
      : [{ criterion: '2.1.1', status: 'not_testable', detail: DOCUMENT_CHANGED }]);
  } finally { await new Promise<void>((resolve) => site.close(() => resolve())); }
}, 30000);
