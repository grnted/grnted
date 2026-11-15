// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The keyboard probe over a remote browser (Plan 2, H0): on Cloudflare's Browser Run every call into
// the browser is a network round trip, and the walk used to run out of its time budget after a few
// focus stops (not_testable "the page answered key presses too slowly"). Here every call into the
// browser waits 150 ms first, and an ordinary page of 42 focus stops must still get a clean result.
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeFinding } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer('keyboard');
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** Calls into the browser, by method, and the key presses among them. */
interface Stats { calls: Record<string, number>; presses: number }

/** Every call into the page (and its keyboard and mouse) waits `ms` before it is sent: a remote browser. */
function remote(ms: number, stats: Stats): BrowserLike {
  const wait = () => new Promise((r) => setTimeout(r, ms));
  const slow = (obj: Record<string, unknown>, names: string[], prefix: string) => {
    for (const name of names) {
      const real = obj[name];
      if (typeof real !== 'function') continue;
      const bound = (real as (...a: unknown[]) => unknown).bind(obj);
      obj[name] = async (...args: unknown[]) => {
        stats.calls[prefix + name] = (stats.calls[prefix + name] ?? 0) + 1;
        if (prefix === 'keyboard.' && name === 'press') stats.presses++;
        await wait();
        return bound(...args);
      };
    }
  };
  return {
    async newContext(o: Parameters<Browser['newContext']>[0]) {
      const context = await browser.newContext(o);
      const newPage = context.newPage.bind(context);
      const newCDPSession = context.newCDPSession.bind(context);
      return Object.assign(context, {
        // CDP calls cross the same link (the walk sends its Tab presses this way: one call each).
        async newCDPSession(page: Page) {
          const session = await newCDPSession(page);
          const send = session.send.bind(session) as (m: string, p?: Record<string, unknown>) => Promise<unknown>;
          return Object.assign(session, {
            async send(method: string, params?: Record<string, unknown>) {
              stats.calls[`cdp.${method}`] = (stats.calls[`cdp.${method}`] ?? 0) + 1;
              if (method === 'Input.dispatchKeyEvent' && params?.type === 'rawKeyDown' && params.key === 'Tab') stats.presses++;
              await wait();
              return send(method, params);
            },
          });
        },
        async newPage() {
          const page: Page = await newPage();
          // The same objects, changed in place: the request guard tells its page from popups by identity.
          slow(page as unknown as Record<string, unknown>, ['goto', 'evaluate', 'screenshot', 'addScriptTag', 'hover', 'focus', 'setViewportSize', 'emulateMedia', 'addInitScript'], '');
          slow(page.keyboard as unknown as Record<string, unknown>, ['press', 'down', 'up', 'type'], 'keyboard.');
          slow(page.mouse as unknown as Record<string, unknown>, ['move', 'click', 'down', 'up', 'wheel'], 'mouse.');
          return page;
        },
      });
    },
  } as unknown as BrowserLike;
}

const bad = (list: ProbeFinding[]) => list.filter((f) => f.status === 'failed' || f.status === 'not_testable');

describe('keyboard probe on a remote browser (150 ms per call)', () => {
  it('the same page in a local browser: clean (the control)', async () => {
    const stats: Stats = { calls: {}, presses: 0 };
    const [run] = await runProbes(remote(0, stats), [{ url: `${server.origin}/latency.html`, index: 0 }], [keyboardProbe], { userAgent: 'grnted-test' });
    const total = Object.values(stats.calls).reduce((a, b) => a + b, 0);
    // eslint-disable-next-line no-console
    console.log(`local keyboard walk: ${run!.ms} ms, ${stats.presses} key presses, ${total} calls: ${JSON.stringify(stats.calls)}`);
    expect(run!.status).toBe('ok');
    expect(bad(run!.findings), JSON.stringify(bad(run!.findings))).toEqual([]);
    expect(stats.presses).toBeGreaterThanOrEqual(82);
  }, 60_000);

  it('walks an ordinary page of 42 focus stops both ways within its time box, with a clean result', async () => {
    const stats: Stats = { calls: {}, presses: 0 };
    const [run] = await runProbes(remote(150, stats), [{ url: `${server.origin}/latency.html`, index: 0 }], [keyboardProbe], { userAgent: 'grnted-test' });
    const total = Object.values(stats.calls).reduce((a, b) => a + b, 0);
    // eslint-disable-next-line no-console
    console.log(`remote keyboard walk: ${run!.ms} ms, ${stats.presses} key presses, ${total} calls (${(total / Math.max(1, stats.presses)).toFixed(2)} per press, ${(run!.ms / 150 / Math.max(1, stats.presses)).toFixed(2)} round trips of wall time per press): ${JSON.stringify(stats.calls)}`);
    expect(run!.status).toBe('ok');
    expect(bad(run!.findings), JSON.stringify(bad(run!.findings))).toEqual([]);
    // Both walks reached every stop (42 forward, 40 backward: the core test's Shift+Tab cap).
    expect(stats.presses).toBeGreaterThanOrEqual(82);
  }, 60_000);
});
