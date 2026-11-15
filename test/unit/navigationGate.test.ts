// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The navigation gate's decisions over a fake CDP session (Plan 2, H0): allowUrl at the request stage
// for every document and redirect hop, the server address at the response stage (Chromium's class of
// it before the body, the exact address once the response is handed on), speculative headers removed.
import { describe, expect, it } from 'vitest';
import { GATE_UNARMED, NOT_ALLOWED, REFUSED_ADDRESS, documentGate, documentRefused, gateDocuments, gateFailure, gatedBrowser, isGateUnarmed } from '../../src/navigationGate.js';
// A session that closed is lost work (the scan does it again, or gives no score), never the site refusing the page.
import { GATE_LOST, isBrowserGone } from '../../src/reconnect.js';
import type { BrowserLike, ContextLike, PageLike } from '../../src/types.js';

function session() {
  const sent: [string, Record<string, unknown>][] = [];
  const on: Record<string, (ev: Record<string, unknown>) => void> = {};
  const cdp = {
    async send(method: string, params: Record<string, unknown> = {}) { sent.push([method, params]); return {}; },
    on(event: string, fn: (ev: Record<string, unknown>) => void) { on[event] = fn; },
  };
  return { sent, on, cdp };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

async function gated(allowUrl: (u: string) => Promise<boolean>, allowIp?: (ip: string) => boolean) {
  const s = session();
  const page = {} as PageLike;
  const context = { async newCDPSession() { return s.cdp; } } as unknown as ContextLike;
  const state = await gateDocuments(context, page, allowUrl, allowIp ? { allowIp } : {});
  const pause = async (ev: Record<string, unknown>) => {
    const n = s.sent.length;
    s.on['Fetch.requestPaused']!({ requestId: 'r1', ...ev });
    await new Promise((r) => setTimeout(r, 150));
    return s.sent.slice(n);
  };
  return { ...s, page, state, pause };
}

describe('gateDocuments', () => {
  it('pauses documents only, at the request and response stages', async () => {
    const t = await gated(async () => true);
    expect(t.state).toBe('on');
    expect(documentGate(t.page)).toBe('on');
    expect(t.sent).toEqual([['Fetch.enable', { patterns: [
      { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
      { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' },
    ] }]]);
  });

  it('request stage: allowUrl decides each document and each redirect hop; a check that throws refuses; no network, no check', async () => {
    const asked: string[] = [];
    const t = await gated(async (u) => { asked.push(u); if (u.includes('boom')) throw new Error('x'); return !u.includes('169.254'); });
    expect(await t.pause({ request: { url: 'https://e.org/' } })).toEqual([['Fetch.continueRequest', { requestId: 'r1' }]]);
    expect(await t.pause({ request: { url: 'http://169.254.169.254/latest' } })).toEqual([['Fetch.failRequest', { requestId: 'r1', errorReason: 'BlockedByClient' }]]);
    expect(await t.pause({ request: { url: 'https://boom.example/' } })).toEqual([['Fetch.failRequest', { requestId: 'r1', errorReason: 'BlockedByClient' }]]);
    // Not http(s) (a redirect to data:, a blob:, file:): refused like an address allowUrl refuses, never asked.
    expect(await t.pause({ request: { url: 'data:text/html,hi' } })).toEqual([['Fetch.failRequest', { requestId: 'r1', errorReason: 'BlockedByClient' }]]);
    expect(await t.pause({ request: { url: 'blob:https://e.org/1' } })).toEqual([['Fetch.failRequest', { requestId: 'r1', errorReason: 'BlockedByClient' }]]);
    // The initial empty page loads nothing.
    expect(await t.pause({ request: { url: 'about:blank' } })).toEqual([['Fetch.continueRequest', { requestId: 'r1' }]]);
    expect(asked.some((u) => !/^https?:/.test(u))).toBe(false);
    // Asked again for the same address: nothing is remembered between requests.
    await t.pause({ request: { url: 'https://e.org/' } });
    expect(asked.filter((u) => u === 'https://e.org/').length).toBe(2);
  });

  it('response stage: speculative headers are dropped (status kept); other responses go on unchanged', async () => {
    const t = await gated(async () => true);
    expect(await t.pause({ request: { url: 'https://e.org/' }, responseStatusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }] }))
      .toEqual([['Fetch.continueResponse', { requestId: 'r1' }]]);
    expect(await t.pause({ request: { url: 'https://e.org/' }, responseStatusCode: 200, responseStatusText: 'OK', responseHeaders: [{ name: 'Content-Type', value: 'text/html' }, { name: 'Speculation-Rules', value: '"/r.json"' }] }))
      .toEqual([['Fetch.continueResponse', { requestId: 'r1', responseCode: 200, responsePhrase: 'OK', responseHeaders: [{ name: 'Content-Type', value: 'text/html' }] }]]);
  });

  it('allowIp: a refused address class fails the document before its body; unknown is allowed (and counted); the exact address is judged on the response', async () => {
    const allowIp = (ip: string) => !(ip.startsWith('127.') || ip === '::1' || ip.startsWith('10.') || ip.startsWith('169.254.'));
    const t = await gated(async () => true, allowIp);
    expect(t.sent[0]).toEqual(['Network.enable', {}]);
    t.on['Network.responseReceivedExtraInfo']!({ requestId: 'n1', resourceIPAddressSpace: 'Loopback' });
    expect(await t.pause({ networkId: 'n1', request: { url: 'https://rebind.example/' }, responseStatusCode: 200 })).toEqual([['Fetch.failRequest', { requestId: 'r1', errorReason: 'BlockedByClient' }]]);
    t.on['Network.responseReceivedExtraInfo']!({ requestId: 'n2', resourceIPAddressSpace: 'Local' });
    expect((await t.pause({ networkId: 'n2', request: { url: 'https://rebind.example/' }, responseStatusCode: 302 }))[0]![0]).toBe('Fetch.failRequest');
    t.on['Network.responseReceivedExtraInfo']!({ requestId: 'n3', resourceIPAddressSpace: 'Public' });
    expect(await t.pause({ networkId: 'n3', request: { url: 'https://e.org/' }, responseStatusCode: 200 })).toEqual([['Fetch.continueResponse', { requestId: 'r1' }]]);
    // Private (the RFC 1918 class in newer Chromium) and any class this does not know: refused.
    t.on['Network.responseReceivedExtraInfo']!({ requestId: 'n5', resourceIPAddressSpace: 'Private' });
    expect(await t.pause({ networkId: 'n5', request: { url: 'https://rebind.example/' }, responseStatusCode: 200 })).toEqual([['Fetch.failRequest', { requestId: 'r1', errorReason: 'BlockedByClient' }]]);
    t.on['Network.responseReceivedExtraInfo']!({ requestId: 'n6', resourceIPAddressSpace: 'SomethingNew' });
    expect(await t.pause({ networkId: 'n6', request: { url: 'https://rebind.example/' }, responseStatusCode: 200 })).toEqual([['Fetch.failRequest', { requestId: 'r1', errorReason: 'BlockedByClient' }]]);
    // Never reported (waited for briefly): refused, since nothing says where it came from.
    expect(await t.pause({ networkId: 'n4', request: { url: 'https://e.org/' }, responseStatusCode: 200 })).toEqual([['Fetch.failRequest', { requestId: 'r1', errorReason: 'BlockedByClient' }]]);
    // Reported as 'Unknown': allowed.
    t.on['Network.responseReceivedExtraInfo']!({ requestId: 'n7', resourceIPAddressSpace: 'Unknown' });
    expect(await t.pause({ networkId: 'n7', request: { url: 'https://e.org/' }, responseStatusCode: 200 })).toEqual([['Fetch.continueResponse', { requestId: 'r1' }]]);
    expect(documentRefused(t.page)).toBeUndefined();
    // A public class, but an exact address allowIp refuses: the page's results do not stand.
    t.on['Network.responseReceived']!({ type: 'Image', response: { url: 'https://e.org/a.png', remoteIPAddress: '10.0.0.5' } });
    expect(documentRefused(t.page)).toBeUndefined();
    t.on['Network.responseReceived']!({ type: 'Document', response: { url: 'https://e.org/', remoteIPAddress: '[::1]' } });
    expect(documentRefused(t.page)).toBe('[::1] https://e.org/');
  });

  it('allowIp: a class that arrives after the wait does not let the body through; a refused class that arrives after a continue makes the page not stand', async () => {
    const t = await gated(async () => true, (ip) => !ip.startsWith('10.'));
    // Private, delivered 120 ms after the response-stage pause (no remoteIPAddress ever): failed.
    const n = t.sent.length;
    t.on['Fetch.requestPaused']!({ requestId: 'r-late', networkId: 'n-late', request: { url: 'https://rebind.example/' }, responseStatusCode: 200 });
    await new Promise((r) => setTimeout(r, 120));
    t.on['Network.responseReceivedExtraInfo']!({ requestId: 'n-late', resourceIPAddressSpace: 'Private' });
    await tick();
    expect(t.sent.slice(n)).toEqual([['Fetch.failRequest', { requestId: 'r-late', errorReason: 'BlockedByClient' }]]);
    expect(documentRefused(t.page)).toBeUndefined();
    // Public, continued; then a refused class for that same document: the page does not stand.
    t.on['Network.responseReceivedExtraInfo']!({ requestId: 'n-pub', resourceIPAddressSpace: 'Public' });
    expect(await t.pause({ networkId: 'n-pub', request: { url: 'https://e.org/' }, responseStatusCode: 200 })).toEqual([['Fetch.continueResponse', { requestId: 'r1' }]]);
    t.on['Network.responseReceivedExtraInfo']!({ requestId: 'n-pub', resourceIPAddressSpace: 'Private' });
    expect(documentRefused(t.page)).toBe('Private https://e.org/');
    expect(gateFailure(t.page)).toBe(REFUSED_ADDRESS);
  });

  it('allowIp: the next redirect hop of a continued document is judged at its own response stage, not taken as a late class', async () => {
    const t = await gated(async () => true, (ip) => !ip.startsWith('10.'));
    t.on['Network.responseReceivedExtraInfo']!({ requestId: 'n1', resourceIPAddressSpace: 'Public' });
    expect(await t.pause({ networkId: 'n1', request: { url: 'https://e.org/go' }, responseStatusCode: 302 })).toEqual([['Fetch.continueResponse', { requestId: 'r1' }]]);
    // The redirect hop: paused at the request stage (same network id), then its class, then its response stage.
    expect(await t.pause({ networkId: 'n1', request: { url: 'https://rebind.example/' } })).toEqual([['Fetch.continueRequest', { requestId: 'r1' }]]);
    t.on['Network.responseReceivedExtraInfo']!({ requestId: 'n1', resourceIPAddressSpace: 'Private' });
    expect(documentRefused(t.page)).toBeUndefined();
    expect(await t.pause({ networkId: 'n1', request: { url: 'https://rebind.example/' }, responseStatusCode: 200 })).toEqual([['Fetch.failRequest', { requestId: 'r1', errorReason: 'BlockedByClient' }]]);
  });

  it('a response the handler cannot read (a header with no name) is failed, not left paused', async () => {
    const t = await gated(async () => true);
    expect(await t.pause({ request: { url: 'https://e.org/' }, responseStatusCode: 200, responseHeaders: [{ value: 'x' }] }))
      .toEqual([['Fetch.failRequest', { requestId: 'r1', errorReason: 'BlockedByClient' }]]);
  });

  it('a class allowIp allows in full is let through', async () => {
    const t = await gated(async () => true, () => true);
    for (const [n, space] of [['n1', 'Loopback'], ['n2', 'Local'], ['n3', 'Private']] as const) {
      t.on['Network.responseReceivedExtraInfo']!({ requestId: n, resourceIPAddressSpace: space });
      expect(await t.pause({ networkId: n, request: { url: 'http://localhost/' }, responseStatusCode: 200 })).toEqual([['Fetch.continueResponse', { requestId: 'r1' }]]);
    }
  });

  it('a private address refused, loopback allowed: Private and Local (named differently across Chromium versions) are refused', async () => {
    const t = await gated(async () => true, (ip) => !ip.startsWith('10.'));
    t.on['Network.responseReceivedExtraInfo']!({ requestId: 'n1', resourceIPAddressSpace: 'Private' });
    expect((await t.pause({ networkId: 'n1', request: { url: 'https://rebind.example/' }, responseStatusCode: 200 }))[0]![0]).toBe('Fetch.failRequest');
    t.on['Network.responseReceivedExtraInfo']!({ requestId: 'n2', resourceIPAddressSpace: 'Local' });
    expect((await t.pause({ networkId: 'n2', request: { url: 'https://rebind.example/' }, responseStatusCode: 200 }))[0]![0]).toBe('Fetch.failRequest');
  });

  it('a session that closes while allowUrl decides: the paused request is not let through, and the page does not stand', async () => {
    let release!: (v: boolean) => void;
    const t = await gated(() => new Promise<boolean>((r) => { release = r; }));
    const n = t.sent.length;
    t.on['Fetch.requestPaused']!({ requestId: 'r9', request: { url: 'http://169.254.169.254/latest/' } });
    await tick();
    t.on.close!({});
    release(true);
    await tick();
    expect(t.sent.slice(n).map(([m]) => m)).not.toContain('Fetch.continueRequest');
    expect(gateFailure(t.page)).toBe(GATE_LOST);
  });

  it('no CDP session: unavailable; a session that closes: lost; either way the page does not stand', async () => {
    const none = {} as PageLike;
    expect(await gateDocuments({} as ContextLike, none, async () => true)).toBe('unavailable');
    expect(gateFailure(none)).toBe(NOT_ALLOWED);
    const throws = {} as PageLike;
    expect(await gateDocuments({ async newCDPSession() { throw new Error('no CDP here'); } } as unknown as ContextLike, throws, async () => true)).toBe('unavailable');
    expect(gateFailure(throws)).toBe(NOT_ALLOWED);
    const t = await gated(async () => true);
    expect(gateFailure(t.page)).toBeUndefined();
    t.on.close!({});
    expect(documentGate(t.page)).toBe('lost');
    expect(gateFailure(t.page)).toBe(GATE_LOST);
    // A page without a gate (no allowUrl): nothing to say.
    expect(gateFailure({} as PageLike)).toBeUndefined();
  });

  it('a session that refuses one of its setup commands: unavailable, and a document it pauses anyway is failed, never let through', async () => {
    for (const refused of ['Network.enable', 'Fetch.enable']) {
      const s = session();
      const send = s.cdp.send.bind(s.cdp);
      s.cdp.send = async (method: string, params: Record<string, unknown> = {}) => {
        if (method === refused) { s.sent.push([method, params]); throw new Error('refused'); }
        return send(method, params);
      };
      const page = {} as PageLike;
      const state = await gateDocuments({ async newCDPSession() { return s.cdp; } } as unknown as ContextLike, page, async () => true, { allowIp: () => true });
      expect([refused, state, gateFailure(page)]).toEqual([refused, 'unavailable', NOT_ALLOWED]);
      const n = s.sent.length;
      s.on['Fetch.requestPaused']!({ requestId: 'r1', request: { url: 'https://e.org/' }, resourceType: 'Document', frameId: 'f' });
      await new Promise((r) => setTimeout(r, 150));
      expect(s.sent.slice(n).map(([m]) => m)).toEqual(['Fetch.failRequest']);
    }
  });

  it('gateFailure: a refused server address, then a page that is not http(s) any more', async () => {
    const t = await gated(async () => true, () => false);
    t.on['Network.responseReceived']!({ type: 'Document', response: { url: 'https://e.org/', remoteIPAddress: '10.0.0.5' } });
    expect(gateFailure(t.page)).toBe(REFUSED_ADDRESS);
    const u = await gated(async () => true);
    (u.page as { url?: () => string }).url = () => 'data:text/html,<h1>injected</h1>';
    expect(gateFailure(u.page)).toBe(NOT_ALLOWED);
    (u.page as { url?: () => string }).url = () => 'https://e.org/';
    expect(gateFailure(u.page)).toBeUndefined();
  });
});

/** A fake browser: one page session per page (its target info) and a browser session that holds new targets. */
function fakeBrowser(opts: { browserSession?: boolean; popupDuringNewPage?: boolean } = {}) {
  const scripts: string[] = [];
  const closed: string[] = [];
  const sentBrowser: [string, Record<string, unknown>][] = [];
  const browserOn: Record<string, (ev: Record<string, unknown>) => void> = {};
  const browserTargets = new Map<string, Record<string, unknown>>();
  let detached = 0;
  let lookup: ((id: string) => Promise<unknown>) | undefined;
  let onPage: ((p: PageLike) => void) | undefined;
  const mk = (name: string) => ({ name, close: async () => { closed.push(name); } }) as unknown as PageLike;
  const pageSession = () => {
    const s = session();
    return { ...s.cdp, async send(method: string, params: Record<string, unknown> = {}) {
      await s.cdp.send(method, params);
      return method === 'Target.getTargetInfo' ? { targetInfo: { targetId: 'T-main', browserContextId: 'C1', type: 'page' } } : {};
    } };
  };
  let contextClosed = 0;
  const context = {
    async addInitScript(x: { content: string }) { scripts.push(x.content); },
    on(event: string, fn: (p: PageLike) => void) { if (event === 'page') onPage = fn; },
    async newPage() {
      const p = mk('main');
      // The page's own event, and (race) a popup's while newPage is still opening.
      if (opts.popupDuringNewPage) onPage!(mk('popup'));
      onPage!(p);
      await tick();
      return p;
    },
    async newCDPSession() { return pageSession(); },
    async close() { contextClosed++; },
  } as unknown as ContextLike;
  const base = {
    async newContext() { return context; },
    ...(opts.browserSession === false ? {} : {
      async newBrowserCDPSession() {
        return {
          async send(method: string, params: Record<string, unknown> = {}) {
            sentBrowser.push([method, params]);
            if (method !== 'Target.getTargetInfo') return {};
            if (lookup) return lookup(String(params.targetId));
            const targetInfo = browserTargets.get(String(params.targetId));
            if (!targetInfo) throw new Error('No target with given id found');
            return { targetInfo };
          },
          on(event: string, fn: (ev: Record<string, unknown>) => void) { browserOn[event] = fn; },
          async detach() { detached++; },
        };
      },
    }),
  } as unknown as BrowserLike;
  return { base, scripts, closed, sentBrowser, browserOn, browserTargets, mk, onPage: (p: PageLike) => onPage!(p), detached: () => detached, contextClosed: () => contextClosed, setLookup: (fn: (id: string) => Promise<unknown>) => { lookup = fn; } };
}

describe('gatedBrowser', () => {
  it('gates each page before returning it, adds the speculation block, closes windows the page opens, and wraps once', async () => {
    const f = fakeBrowser();
    const b = gatedBrowser(f.base, async () => true);
    expect(gatedBrowser(b, async () => true)).toBe(b);
    const c = await b.newContext({ viewport: { width: 1, height: 1 } });
    const page = await c.newPage();
    expect(documentGate(page)).toBe('on');
    expect(f.scripts.length).toBe(1);
    expect(f.scripts[0]).toContain('speculationrules');
    f.onPage(f.mk('popup'));
    await tick();
    expect(f.closed).toEqual(['popup']);
  });

  it('a popup the context reports while newPage is still opening is closed, not taken for the page', async () => {
    const f = fakeBrowser({ popupDuringNewPage: true });
    const c = await gatedBrowser(f.base, async () => true).newContext({ viewport: { width: 1, height: 1 } });
    const page = await c.newPage();
    await tick();
    expect((page as unknown as { name: string }).name).toBe('main');
    expect(f.closed).toEqual(['popup']);
  });

  it('windows a gated page opens load no document: the browser-level session fails their documents and closes them; every other document goes on', async () => {
    const f = fakeBrowser();
    const c = await gatedBrowser(f.base, async () => true).newContext({ viewport: { width: 1, height: 1 } });
    expect(f.sentBrowser).toEqual([
      ['Target.setDiscoverTargets', { discover: true }],
      ['Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }],
    ]);
    await c.newPage();
    f.sentBrowser.length = 0;
    const created = (targetInfo: Record<string, unknown>) => f.browserOn['Target.targetCreated']!({ targetInfo });
    created({ targetId: 'T-main', type: 'page', browserContextId: 'C1' });
    created({ targetId: 'T-other', type: 'page', browserContextId: 'C2' });
    created({ targetId: 'T-pop', type: 'page', browserContextId: 'C1', openerId: 'T-main' });
    created({ targetId: 'T-tab', type: 'page', browserContextId: 'C1' });
    const paused = (requestId: string, frameId: string) => f.browserOn['Fetch.requestPaused']!({ requestId, frameId, request: { url: 'http://169.254.169.254/' } });
    paused('r-main', 'T-main'); // the gated page itself: its own gate decides
    paused('r-frame', 'F-inner'); // a frame of it (not a page target): its page gate decides
    paused('r-other', 'T-other'); // another context's page
    paused('r-pop', 'T-pop'); // window.open from the gated page
    paused('r-tab', 'T-tab'); // a new tab in the gated context, opener not named
    await new Promise((r) => setTimeout(r, 300));
    expect(f.sentBrowser).toEqual([
      ['Target.getTargetInfo', { targetId: 'F-inner' }],
      ['Fetch.continueRequest', { requestId: 'r-main' }],
      ['Fetch.continueRequest', { requestId: 'r-other' }],
      ['Fetch.failRequest', { requestId: 'r-pop', errorReason: 'BlockedByClient' }],
      ['Fetch.failRequest', { requestId: 'r-tab', errorReason: 'BlockedByClient' }],
      ['Target.closeTarget', { targetId: 'T-pop' }],
      ['Target.closeTarget', { targetId: 'T-tab' }],
      // No target, asked again after the wait: still none, so a same-process frame.
      ['Target.getTargetInfo', { targetId: 'F-inner' }],
      ['Fetch.continueRequest', { requestId: 'r-frame' }],
    ]);
    // A window this session was not told about yet: looked up by its frame id, and failed.
    f.sentBrowser.length = 0;
    f.browserTargets.set('T-late', { targetId: 'T-late', type: 'page', browserContextId: 'C1', openerId: 'T-main' });
    paused('r-late', 'T-late');
    await tick();
    expect(f.sentBrowser).toEqual([
      ['Target.getTargetInfo', { targetId: 'T-late' }],
      ['Fetch.failRequest', { requestId: 'r-late', errorReason: 'BlockedByClient' }],
      ['Target.closeTarget', { targetId: 'T-late' }],
    ]);
  });

  it('a window document the session cannot tie to a target is failed: no frame id, a lookup that errors, a lookup the session lost meanwhile', async () => {
    const f = fakeBrowser();
    const c = await gatedBrowser(f.base, async () => true).newContext({ viewport: { width: 1, height: 1 } });
    await c.newPage();
    const fail = (requestId: string) => ['Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }];
    f.sentBrowser.length = 0;
    // No frame id at all.
    f.browserOn['Fetch.requestPaused']!({ requestId: 'r-noframe', request: { url: 'http://169.254.169.254/latest/meta-data/' } });
    await tick();
    expect(f.sentBrowser).toEqual([fail('r-noframe')]);
    // getTargetInfo fails for a reason other than "no such target".
    f.sentBrowser.length = 0;
    f.setLookup(async () => { throw new Error('Internal error'); });
    f.browserOn['Fetch.requestPaused']!({ requestId: 'r-err', frameId: 'T-x', request: { url: 'http://169.254.169.254/' } });
    await tick();
    expect(f.sentBrowser.filter(([m]) => m.startsWith('Fetch.'))).toEqual([fail('r-err')]);
  });

  it('a frame id the session does not know yet: a window reported within the wait is failed; one confirmed twice as no target goes on (its page gate decides)', async () => {
    const f = fakeBrowser();
    const c = await gatedBrowser(f.base, async () => true).newContext({ viewport: { width: 1, height: 1 } });
    await c.newPage();
    f.sentBrowser.length = 0;
    f.browserOn['Fetch.requestPaused']!({ requestId: 'r-prov', frameId: 'T-prov', request: { url: 'http://169.254.169.254/' } });
    await tick();
    expect(f.sentBrowser.filter(([m]) => m.startsWith('Fetch.'))).toEqual([]);
    f.browserOn['Target.targetCreated']!({ targetInfo: { targetId: 'T-prov', type: 'page', browserContextId: 'C1', openerId: 'T-main' } });
    await tick();
    expect(f.sentBrowser.filter(([m]) => m !== 'Target.getTargetInfo')).toEqual([
      ['Fetch.failRequest', { requestId: 'r-prov', errorReason: 'BlockedByClient' }],
      ['Target.closeTarget', { targetId: 'T-prov' }],
    ]);
    f.sentBrowser.length = 0;
    f.browserOn['Fetch.requestPaused']!({ requestId: 'r-frame', frameId: 'F-inner', request: { url: 'https://e.org/frame' } });
    await new Promise((r) => setTimeout(r, 300));
    expect(f.sentBrowser).toEqual([
      ['Target.getTargetInfo', { targetId: 'F-inner' }],
      ['Target.getTargetInfo', { targetId: 'F-inner' }],
      ['Fetch.continueRequest', { requestId: 'r-frame' }],
    ]);
  });

  it('the browser session lost: a pause inside its lookup is failed, not continued, and the gated pages are closed (no later window.open can load)', async () => {
    const f = fakeBrowser();
    const c = await gatedBrowser(f.base, async () => true).newContext({ viewport: { width: 1, height: 1 } });
    const page = await c.newPage();
    f.sentBrowser.length = 0;
    let answer!: (v: unknown) => void;
    f.setLookup(() => new Promise((r) => { answer = r; }));
    f.browserOn['Fetch.requestPaused']!({ requestId: 'r-pop', frameId: 'T-pop', request: { url: 'http://169.254.169.254/' } });
    await tick();
    f.browserOn.close!({});
    answer({ targetInfo: { targetId: 'T-pop', type: 'iframe', browserContextId: 'C1' } });
    await tick();
    expect(f.sentBrowser.filter(([m]) => m.startsWith('Fetch.'))).toEqual([['Fetch.failRequest', { requestId: 'r-pop', errorReason: 'BlockedByClient' }]]);
    expect(f.closed).toContain('main');
    expect(gateFailure(page)).toBe(GATE_LOST);
  });

  it('a window hold that fails to arm is armed once more before the context opens', async () => {
    const f = fakeBrowser();
    const raw = f.base as BrowserLike & { newBrowserCDPSession: () => Promise<unknown> };
    const real = raw.newBrowserCDPSession.bind(raw);
    let calls = 0;
    raw.newBrowserCDPSession = async () => {
      if (++calls === 1) throw new Error('Target.attachToBrowserTarget: busy');
      return real();
    };
    const p = await (await gatedBrowser(raw, async () => true).newContext({ viewport: { width: 1, height: 1 } })).newPage();
    expect(calls).toBe(2);
    expect(documentGate(p)).toBe('on');
  });

  it('a session whose window hold cannot be armed (unarmed: "lost"): no context opens there, with an error read as lost work', async () => {
    const none = fakeBrowser({ browserSession: false });
    const b = gatedBrowser(none.base, async () => true, { unarmed: 'lost' });
    const err = await b.newContext({ viewport: { width: 1, height: 1 } }).then(() => null, (e: unknown) => e);
    expect(String((err as Error)?.message)).toBe(GATE_UNARMED);
    expect(isGateUnarmed(err)).toBe(true);
    expect(isBrowserGone(err)).toBe(true);
    // Every later context too: the session stays unusable.
    await expect(b.newContext({ viewport: { width: 1, height: 1 } })).rejects.toThrow(GATE_UNARMED);
    expect(none.contextClosed()).toBe(0);
  });

  it('a browser that is gone while the hold opens is a lost browser (its error), not a hold that cannot arm; the next context tries again', async () => {
    const f = fakeBrowser();
    const raw = f.base as BrowserLike & { newBrowserCDPSession: () => Promise<unknown> };
    const real = raw.newBrowserCDPSession.bind(raw);
    let gone = true;
    raw.newBrowserCDPSession = async () => {
      if (gone) throw new Error('Target page, context or browser has been closed');
      return real();
    };
    const b = gatedBrowser(raw, async () => true, { unarmed: 'lost' });
    const err = await b.newContext({ viewport: { width: 1, height: 1 } }).then(() => null, (e: unknown) => e);
    expect(isBrowserGone(err)).toBe(true);
    expect(isGateUnarmed(err)).toBe(false);
    gone = false;
    const p = await (await b.newContext({ viewport: { width: 1, height: 1 } })).newPage();
    expect(documentGate(p)).toBe('on');
  });

  it('without a browser session to hold new windows, pages are not gated ("unavailable"); the hold is let go when the last context closes', async () => {
    const none = fakeBrowser({ browserSession: false });
    const p = await (await gatedBrowser(none.base, async () => true).newContext({ viewport: { width: 1, height: 1 } })).newPage();
    expect(documentGate(p)).toBe('unavailable');
    expect(gateFailure(p)).toBe(NOT_ALLOWED);
    const f = fakeBrowser();
    const c = await gatedBrowser(f.base, async () => true).newContext({ viewport: { width: 1, height: 1 } });
    const q = await c.newPage();
    // A hold that is lost: windows are no longer held, so the page does not stand.
    f.browserOn.close?.({});
    expect(documentGate(q)).toBe('lost');
    await c.close();
    expect(f.contextClosed()).toBe(1);
    expect(f.detached()).toBe(1);
  });
});
