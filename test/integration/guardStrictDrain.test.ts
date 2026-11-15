// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { createServer, type ServerResponse } from 'node:http';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike } from '../../src/types.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

describe('typing probes drain earlier requests (real browser)', () => {
  it.each(['redirect', 'split-hop', 'body', 'hung'])('a pending fetch (%s) cannot send a cookie copied from scanner input', async (mode) => {
    const requests: { url: string; cookie: string }[] = [];
    let pending: ServerResponse | undefined;
    let release: ReturnType<typeof setTimeout> | undefined;
    const reports: ReturnType<typeof setTimeout>[] = [];
    let typed = false;
    let doneBeforeTyping = false;
    const server = createServer((req, res) => {
      requests.push({ url: req.url!, cookie: req.headers.cookie ?? '' });
      if (req.url === '/config') {
        pending = res;
        if (mode === 'body') res.writeHead(200, { 'content-type': 'text/plain' }).write('loading');
      } else if (req.url === '/config-pending') {
        // The earlier redirect chain can still attach a cookie without another route callback.
        release = setTimeout(() => res.writeHead(302, { location: '/config-result' }).end(), 300);
      } else if (req.url === '/config-result') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ready');
      } else {
        res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Form</title>
          <form><input name="answer" oninput="document.cookie = 'answer=' + this.value + '; path=/'"></form>`);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const url = `http://127.0.0.1:${port}/quiz`;
    const first: PageProbe = {
      id: 'pending', criteria: [], kind: 'interaction', tier: 'core', timeoutMs: 5000,
      async run(ctx) {
        await ctx.page.evaluate(() => {
          const w = window as unknown as { pending: Promise<void>; done: boolean };
          w.pending = fetch('/config').then((r) => r.text()).then(() => { w.done = true; });
        }, undefined);
        await expect.poll(() => !!pending).toBe(true);
        return [];
      },
    };
    const strict: PageProbe = {
      id: 'typing', criteria: ['3.2.2'], kind: 'interaction', tier: 'core', timeoutMs: mode === 'hung' ? 300 : 5000, sendsNothing: true,
      async run(ctx) {
        typed = true;
        doneBeforeTyping = await ctx.page.evaluate(() => (window as unknown as { done: boolean }).done === true, undefined);
        await (ctx.page as unknown as Page).fill('input', 'scanner-value');
        await ctx.page.evaluate(() => (window as unknown as { pending: Promise<void> }).pending, undefined);
        return [];
      },
    };
    // Split transport delivery: the first hop ends before the request report for the next arrives.
    const transport = { async newContext(o: Parameters<Browser['newContext']>[0]) {
      const context = await browser.newContext(o);
      if (mode === 'split-hop') {
        const on = context.on.bind(context);
        context.on = ((event: string, fn: (r: { url(): string }) => void) => on(event as 'request', (r) => {
          if (event === 'request' && r.url().endsWith('/config-pending')) reports.push(setTimeout(() => fn(r), 100));
          else fn(r);
        })) as typeof context.on;
      }
      return context;
    } } as unknown as BrowserLike;
    try {
      const runs = await runProbes(transport, [{ url, index: 0 }], [first, strict], {
        userAgent: 'test', settleMs: 0,
        onStart(run) {
          if (run.probe === 'typing' && mode !== 'hung') release = setTimeout(() => {
            if (mode === 'redirect' || mode === 'split-hop') pending!.writeHead(302, { location: mode === 'split-hop' ? '/config-pending' : '/config-result' });
            pending!.end('ready');
          }, 500);
        },
      });
      const run = runs.find((r) => r.probe === 'typing')!;
      expect(requests.filter((r) => r.cookie.includes('scanner-value'))).toEqual([]);
      if (mode === 'hung') {
        expect(typed).toBe(false);
        expect(run.findings).toEqual([{ criterion: '3.2.2', status: 'not_testable', detail: 'the page was still loading when the test would have typed' }]);
        expect(run.ms).toBeLessThan(1000);
      } else {
        expect(typed).toBe(true);
        expect(doneBeforeTyping).toBe(true);
        expect(run.status).toBe('ok');
        expect(run.findings).toEqual([]);
        if (mode === 'redirect' || mode === 'split-hop') expect(requests.some((r) => r.url === '/config-result')).toBe(true);
      }
    } finally {
      clearTimeout(release);
      reports.forEach(clearTimeout);
      pending?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20000);
});
