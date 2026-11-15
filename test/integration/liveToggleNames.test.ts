// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The live test's toggles: names come from the browser's accessibility tree (aria-labelledby, title), a name
// that changes with the state says the state (the button pattern's other way), every press lands on the button
// found first (never on what has focus by then), and a toggle is activated at most twice.
// Fixtures: test/fixtures/live-toggles/names.html and presses.html (written for this test).
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { screenReaderLiveProbe } from '../../src/probes/screenReader/index.js';
import type { ProbeFinding } from '../../src/probes/types.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let site: Awaited<ReturnType<typeof startFixtureServer>>;
const findings: Record<string, ProbeFinding[]> = {};
/** `act:<id>:<n>` lines the fixtures log on every activation of a button. */
const acts: string[] = [];

beforeAll(async () => {
  site = await startFixtureServer('live-toggles');
  browser = await chromium.launch();
  const watched = new Proxy(browser, {
    get(target, prop, receiver) {
      if (prop === 'newContext') {
        return async (opts: object) => {
          const ctx: BrowserContext = await target.newContext(opts);
          ctx.on('page', (page) => page.on('console', (m) => { if (m.text().startsWith('act:')) acts.push(m.text()); }));
          return ctx;
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const runs = await runProbes(watched as unknown as BrowserLike, ['names.html', 'presses.html'].map((p, index) => ({ url: `${site.origin}/${p}`, index })), [screenReaderLiveProbe], { userAgent: 'grnted-test', settleMs: 200, concurrency: 1 });
  for (const r of runs) findings[new URL(r.page).pathname.slice(1)] = r.findings.filter((f) => f.criterion === '4.1.2');
  // The same page in a browser that gives no accessibility tree (its contexts open no CDP session).
  const nameless = new Proxy(browser, {
    get(target, prop, receiver) {
      if (prop === 'newContext') {
        return async (opts: object) => {
          const ctx: BrowserContext = await target.newContext(opts);
          return new Proxy(ctx, {
            get(t, p, r) {
              if (p === 'newCDPSession') return undefined;
              const v = Reflect.get(t, p, r) as unknown;
              return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
            },
          });
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const blind = await runProbes(nameless as unknown as BrowserLike, [{ url: `${site.origin}/names.html`, index: 0 }], [screenReaderLiveProbe], { userAgent: 'grnted-test', settleMs: 200, concurrency: 1 });
  findings.blind = blind[0]!.findings.filter((f) => f.criterion === '4.1.2');
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
});

const most = (id: string) => Math.max(0, ...acts.filter((a) => a.startsWith(`act:${id}:`)).map((a) => Number(a.split(':')[2])));

describe('4.1.2 live toggles: the name is the one the browser computes', () => {
  it('a name that changes with the state, given through aria-labelledby or title, says the state: not failed', () => {
    const failed = findings['names.html']!.filter((f) => f.status === 'failed').map((f) => f.target);
    expect(failed).not.toContain('#mute');
    expect(failed).not.toContain('#legend');
  });

  it('look-alike: a name through aria-labelledby that stays the same while the block shows and hides still fails, and is quoted', () => {
    const f = findings['names.html']!.find((x) => x.target === '#hours');
    expect(f).toMatchObject({ status: 'failed', detail: expect.stringContaining('“Holiday hours”') });
  });
});

describe('4.1.2 live toggles: a name the browser did not give is said, never clean', () => {
  it('with no accessibility tree to ask, the toggle that would fail is not testable: not failed, and not passed over', () => {
    expect(findings.blind!.filter((f) => f.status === 'failed')).toEqual([]);
    const f = findings.blind!.find((x) => x.target === '#hours');
    expect(f).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('gave no accessible name') });
  });
});

describe('safety: presses land on the button found, and are counted', () => {
  it('the second press lands on the button pressed first, never on what took focus', () => {
    expect(most('opts')).toBe(2);
    expect(most('apply')).toBe(0);
  });

  it('a toggle is activated at most twice; one whose press changes nothing the test can see, once', () => {
    expect(most('pin')).toBe(1);
    expect(most('more')).toBe(2);
    for (const id of ['opts', 'pin', 'more']) expect(most(id), id).toBeLessThanOrEqual(2);
  });
});
