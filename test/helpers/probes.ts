// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Test-only probes and a fake browser for the probe runner.
import { fakeMark } from './marks.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike, RouteLike } from '../../src/types.js';

/**
 * A tiny probe for tests and timing runs: reads the recorded listeners and presses Tab three times.
 * Its criterion '0.0.1' is not a WCAG criterion on purpose.
 */
export const exampleProbe: PageProbe = {
  id: 'example',
  criteria: ['0.0.1'],
  kind: 'interaction',
  tier: 'core',
  timeoutMs: 5000,
  async run(ctx) {
    const listeners = await ctx.listeners();
    for (let i = 0; i < 3; i++) await ctx.page.keyboard?.press('Tab');
    return [{ criterion: '0.0.1', status: 'no_failures_found', detail: `${listeners.length} listener groups recorded` }];
  },
};

export interface FakeEvent {
  type: 'newContext' | 'closeContext' | 'goto' | 'probe';
  context: number;
  url?: string;
  at: number;
}

export interface FakeBrowserOptions {
  /** No CDP session (the guard's popup sandbox is unavailable). */
  noCdp?: boolean;
  /** Delay of `goto` per path (ms). */
  delayFor?: (path: string) => number;
  /** HTTP status per path. */
  statusFor?: (path: string) => number;
  /** `goto` answers with no response (as Playwright's can): per path and load number (1 = first). */
  noResponse?: (path: string, load: number) => boolean;
  /** In-page function results by function name (`runAxeInPage`, `pageShape`, `collectLinks`…). */
  evaluate?: (name: string, path: string, arg?: unknown) => unknown;
  /** Leave out `route` (no request guard possible). */
  noRoute?: boolean;
  /** Leave out `addInitScript` (no listener hook). */
  noInitScript?: boolean;
  /** What `page.screenshot` returns (default: an empty array). Every call is recorded in `screenshots`. */
  screenshot?: (opts: Record<string, unknown> | undefined) => Uint8Array | Promise<Uint8Array>;
}

/**
 * A fake browser that records contexts, page loads and context options. Pages answer `evaluate` by
 * the function's name; `readListeners` returns [] when the init script was added.
 */
export function fakeProbeBrowser(o: FakeBrowserOptions = {}) {
  const events: FakeEvent[] = [];
  const options: Record<string, unknown>[] = [];
  const screenshots: (Record<string, unknown> | undefined)[] = [];
  let contexts = 0;
  let open = 0;
  const loads = new Map<string, number>();
  let maxOpen = 0;
  const t0 = Date.now();
  const browser = {
    async newContext(opts: Record<string, unknown>) {
      const id = contexts++;
      options.push(opts);
      open++;
      maxOpen = Math.max(maxOpen, open);
      events.push({ type: 'newContext', context: id, at: Date.now() - t0 });
      let initScript = false;
      let routed = false;
      let closed = false;
      const ctx = {
        id,
        async newPage() {
          let url = 'about:blank';
          return {
            contextId: id,
            async goto(u: string) {
              const path = new URL(u).pathname;
              events.push({ type: 'goto', context: id, url: u, at: Date.now() - t0 });
              await new Promise((r) => setTimeout(r, o.delayFor?.(path) ?? 0));
              if (closed) throw new Error('Target page, context or browser has been closed');
              url = u;
              const n = (loads.get(path) ?? 0) + 1;
              loads.set(path, n);
              if (o.noResponse?.(path, n)) return null;
              const status = o.statusFor?.(path) ?? 200;
              return { status: () => status, url: () => u, headers: () => ({ 'content-type': 'text/html' }) };
            },
            async evaluate(fn: unknown, arg?: unknown) {
              if (closed) throw new Error('Target page, context or browser has been closed');
              const name = (fn as { name?: string }).name ?? '';
              const path = url.startsWith('http') ? new URL(url).pathname : url;
              const custom = o.evaluate?.(name, path, arg);
              if (custom !== undefined) return custom;
              if (name === 'pageFacts' || name === 'readMark') return fakeMark(name, arg, url);
              if (name === 'runAxeInPage') return { violations: [], incomplete: [], passes: [], inapplicable: [] };
              if (name === 'readListeners') return initScript ? [] : null;
              if (name === 'readHooks') return initScript ? { listeners: [], timers: [], calls: [], audio: { created: 0, running: 0 } } : null;
              if (name === 'collectLinks') return [];
              // An ordinary page that is not mounting anything: the content wait's look (`mounting.ts`) gets its answer.
              // (No answer would mean the look failed, and a test that waited then leaves its criteria not testable.)
              if (name === 'stillMounting') return false;
              return undefined;
            },
            async addScriptTag() {},
            async waitForTimeout(ms: number) { await new Promise((r) => setTimeout(r, Math.min(ms, 5))); },
            async screenshot(opts?: Record<string, unknown>) {
              screenshots.push(opts);
              return o.screenshot ? o.screenshot(opts) : new Uint8Array();
            },
            async close() {},
            url: () => url,
            isClosed: () => closed,
            on() {},
          };
        },
        async close() {
          if (closed) return;
          closed = true;
          open--;
          events.push({ type: 'closeContext', context: id, at: Date.now() - t0 });
        },
        ...(o.noInitScript ? {} : { async addInitScript() { initScript = true; } }),
        ...(o.noRoute ? {} : { async route(_url: unknown, _handler: (r: RouteLike) => unknown) { routed = true; } }),
        // A CDP session that accepts everything: the guard's popup sandbox is on.
        ...(o.noCdp ? {} : {
          async newCDPSession() {
            return { async send(method: string) { return method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main' } } } : {}; }, on() {} };
          },
        }),
        get routed() { return routed; },
      };
      return ctx;
    },
  };
  return {
    browser: browser as unknown as BrowserLike,
    events,
    options,
    /** Options of every `page.screenshot` call, in order. */
    screenshots,
    get contexts() { return contexts; },
    get open() { return open; },
    get maxOpen() { return maxOpen; },
    /** Lets a probe record which context it ran in. */
    contextOf: (page: unknown) => (page as { contextId: number }).contextId,
    note: (e: Omit<FakeEvent, 'at'>) => events.push({ ...e, at: Date.now() - t0 }),
  };
}

/** A minimal JPEG header (SOI + SOF0) for `width`×`height` pixels: enough for `jpegSize`. */
export function fakeJpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xd9,
  ]);
}
