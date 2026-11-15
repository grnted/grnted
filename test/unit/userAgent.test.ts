// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The User-Agent a scan sends (src/userAgent.ts): the browser's own, read from the browser, with Granted's
// token always at its end; each session's contexts get their own browser's (a replacement included).
import { describe, expect, it } from 'vitest';
import { reconnectingBrowser, type BrowserHandle } from '../../src/reconnect.js';
import { presentHeadlessAsChrome, browserUserAgent, isGrntedAgent, scanUserAgent, matchedContextOptions, ownUserAgent, UA_TOKEN, userAgentMatching, withToken } from '../../src/userAgent.js';
import { DEFAULT_USER_AGENT, ENGINE_VERSION } from '../../src/version.js';

const UA = (major: number, os = 'X11; Linux x86_64') => `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/${major}.0.7827.55 Safari/537.36`;
const never = <T>() => new Promise<T>(() => {});

/** A fake browser: its CDP `Browser.getVersion` answers `cdp` (or never, or fails; 'none': no CDP). */
function fakeBrowser(o: { cdp?: string | 'hang' | 'fail' | 'none' }) {
  const calls = { detached: 0, contexts: [] as unknown[] };
  const browser = {
    ...(o.cdp === 'none' || o.cdp === undefined ? {} : {
      async newBrowserCDPSession() {
        if (o.cdp === 'fail') throw new Error('no CDP');
        return {
          send: async (m: string) => (m === 'Browser.getVersion' ? (o.cdp === 'hang' ? never() : { userAgent: o.cdp }) : {}),
          on() {},
          async detach() { calls.detached++; },
        };
      },
    }),
    async newContext(opts: unknown) {
      calls.contexts.push(opts);
      return {};
    },
  };
  return { browser, calls };
}

describe('withToken: Granted always names itself at the end of the User-Agent', () => {
  it('appends the token once, to any user agent, and gives the fallback for an empty one', () => {
    // Paul 2026-11-07: no "bot" and no "(+https://…)" crawler link (Akamai Bot Manager refuses both on sight).
    expect(UA_TOKEN).toBe(`grnted/${ENGINE_VERSION} (grnted.co)`);
    expect(UA_TOKEN).not.toMatch(/bot|https?:/i);
    for (const ua of [UA(149), `${UA(149)} ${UA_TOKEN}`, `  ${UA(150)}  `, '', '   ', 'curl/8', DEFAULT_USER_AGENT]) {
      const out = withToken(ua);
      expect(out.endsWith(` ${UA_TOKEN}`)).toBe(true);
      expect(out.split(UA_TOKEN)).toHaveLength(2);
      expect(isGrntedAgent(out)).toBe(true);
    }
    expect(withToken('')).toBe(DEFAULT_USER_AGENT);
    expect(withToken(UA(149))).toBe(`${UA(149)} ${UA_TOKEN}`);
    expect(isGrntedAgent('grnted-test')).toBe(false);
    expect(isGrntedAgent(undefined)).toBe(false);
  });

  it('replaces the old name (grnted/<v> (+https://grnted.co/bot)) stored on a scan with the current one', () => {
    const old = `${UA(149)} grnted/${ENGINE_VERSION} (+https://grnted.co/bot)`;
    expect(isGrntedAgent(old)).toBe(true);
    expect(withToken(old)).toBe(`${UA(149)} ${UA_TOKEN}`);
  });

  it('keeps the browser\'s own HeadlessChrome unless told its client hints say Chromium (the hosted browser)', () => {
    expect(withToken(UA(152))).toContain('HeadlessChrome/152');
    presentHeadlessAsChrome();
    try {
      expect(withToken(UA(152))).toBe(`${UA(152).replace('HeadlessChrome/', 'Chrome/')} ${UA_TOKEN}`);
      expect(withToken(`${UA(152)} grnted/${ENGINE_VERSION} (+https://grnted.co/bot)`)).not.toMatch(/HeadlessChrome|bot/);
    } finally {
      presentHeadlessAsChrome(false);
    }
  });
});

describe('browserUserAgent: the browser\'s own, read from it, never a hard-coded version', () => {
  it('reads it from CDP Browser.getVersion and ends the CDP session; opens no page', async () => {
    const { browser, calls } = fakeBrowser({ cdp: UA(149) });
    expect(await browserUserAgent(browser)).toBe(`${UA(149)} ${UA_TOKEN}`);
    expect(calls.detached).toBe(1);
    expect(calls.contexts).toEqual([]);
  });

  it('without CDP (or when it fails or never answers, bounded): the fallback, still ending with the token; opens no context', async () => {
    for (const cdp of ['none', 'fail', 'hang'] as const) {
      const { browser, calls } = fakeBrowser({ cdp });
      const t0 = Date.now();
      const ua = await browserUserAgent(browser, 50);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(ua.endsWith(` ${UA_TOKEN}`)).toBe(true);
      expect(calls.contexts).toEqual([]);
    }
  });

  it('scanSite\'s: a browser that does not pass its CDP session on is read from a blank page (no override), its context closed', async () => {
    const own = UA(150, 'Macintosh; Intel Mac OS X 10_15_7');
    const contexts: unknown[] = [];
    let closed = 0;
    const wrapper = {
      async newContext(o: unknown) {
        contexts.push(o);
        return { newPage: async () => ({ evaluate: async () => own }), close: async () => { closed++; } };
      },
    };
    expect(await scanUserAgent(wrapper)).toBe(`${own} ${UA_TOKEN}`);
    expect(contexts).toEqual([{ viewport: { width: 100, height: 100 } }]);
    expect(closed).toBe(1);
    // A blank page that never answers: bounded, still with the token.
    const hung = { newContext: async () => ({ newPage: async () => ({ evaluate: () => never() }), close: async () => {} }) };
    const t0 = Date.now();
    expect((await scanUserAgent(hung, 50)).endsWith(` ${UA_TOKEN}`)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    // With CDP: read there, no context opened.
    const { browser, calls } = fakeBrowser({ cdp: UA(151) });
    expect(await scanUserAgent(browser)).toBe(`${UA(151)} ${UA_TOKEN}`);
    expect(calls.contexts).toEqual([]);
  });

  it('a garbage answer is not taken for a user agent', async () => {
    const odd = fakeBrowser({ cdp: 'not a user agent' });
    expect(await ownUserAgent(odd.browser, 50)).toBeUndefined();
    expect((await browserUserAgent(odd.browser, 50)).endsWith(` ${UA_TOKEN}`)).toBe(true);
  });

  it('is read once per browser (concurrent callers share the read)', async () => {
    let reads = 0;
    const browser = { async newBrowserCDPSession() { reads++; return { send: async () => ({ userAgent: UA(149) }), on() {} }; } };
    const all = await Promise.all([browserUserAgent(browser), browserUserAgent(browser), browserUserAgent(browser)]);
    expect(new Set(all).size).toBe(1);
    expect(reads).toBe(1);
  });
});

describe('each session\'s contexts get their own browser\'s User-Agent', () => {
  it('matchedContextOptions replaces a Granted User-Agent with the browser\'s own (+ token) and leaves any other as it is', async () => {
    const { browser } = fakeBrowser({ cdp: UA(151) });
    const vp = { width: 1280, height: 900 };
    expect(await matchedContextOptions(browser, { viewport: vp, userAgent: `${UA(149)} ${UA_TOKEN}` })).toEqual({ viewport: vp, userAgent: `${UA(151)} ${UA_TOKEN}` });
    expect(await matchedContextOptions(browser, { viewport: vp, userAgent: DEFAULT_USER_AGENT })).toEqual({ viewport: vp, userAgent: `${UA(151)} ${UA_TOKEN}` });
    expect(await matchedContextOptions(browser, { viewport: vp, userAgent: 'grnted-test' })).toEqual({ viewport: vp, userAgent: 'grnted-test' });
    expect(await matchedContextOptions(browser, { viewport: vp })).toEqual({ viewport: vp });
    // Unreadable: the caller's User-Agent stays.
    const { browser: mute } = fakeBrowser({ cdp: 'fail' });
    expect(await matchedContextOptions(mute, { viewport: vp, userAgent: `${UA(149)} ${UA_TOKEN}` })).toEqual({ viewport: vp, userAgent: `${UA(149)} ${UA_TOKEN}` });
  });

  it('a reconnecting browser: after a swap to a browser of another version, its contexts send that one\'s own', async () => {
    const seen: string[] = [];
    const handle = (major: number): BrowserHandle => ({
      browser: {
        async newContext(o: { userAgent?: string }) { seen.push(o.userAgent ?? ''); return {}; },
        async newBrowserCDPSession() { return { send: async () => ({ userAgent: UA(major) }), on() {} }; },
        isConnected: () => true,
      },
      async close() {},
    });
    const r = reconnectingBrowser(handle(149), async () => handle(150));
    const scanUa = `${UA(149)} ${UA_TOKEN}`;
    await r.browser.newContext({ viewport: { width: 1, height: 1 }, userAgent: scanUa } as never);
    expect(await r.swap()).toBe(true);
    await r.browser.newContext({ viewport: { width: 1, height: 1 }, userAgent: scanUa } as never);
    expect(seen).toEqual([`${UA(149)} ${UA_TOKEN}`, `${UA(150)} ${UA_TOKEN}`]);
  });

  it('userAgentMatching (a session used on its own, like the hosted late retry) does the same and forwards the rest', async () => {
    const seen: unknown[] = [];
    const raw = {
      async newContext(o: unknown) { seen.push(o); return { newPage: async () => ({}) as never, close: async () => {} }; },
      async newBrowserCDPSession() { return { send: async () => ({ userAgent: UA(152) }), on() {} }; },
    };
    const b = userAgentMatching(raw);
    await b.newContext({ viewport: { width: 2, height: 2 }, userAgent: DEFAULT_USER_AGENT });
    expect(seen).toEqual([{ viewport: { width: 2, height: 2 }, userAgent: `${UA(152)} ${UA_TOKEN}` }]);
    expect(typeof (b as typeof raw).newBrowserCDPSession).toBe('function');
  });
});
