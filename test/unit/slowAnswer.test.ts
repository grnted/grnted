// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A slow answer is not a move (fix/b18-ai-nav). A real-site benchmark lost pages to "went to another page by itself"
// and "kept loading other pages by itself" on a starved host, with no navigation at all.
// - The final check (checkMark / markedStill): the page, or the scan process too busy to hear it, answered the mark's
//   read after PAGE_ANSWER_MS. A slow answer is now waited for (at most LANDING_MAX_MS more, never past the caller's
//   deadline); no answer is TOO_SLOW, never a move; a commit no response preceded makes the mark be read again.
// - The landing (settleLanding, scope cut after Sol r2): the 20 s cap binds every page as before; at the cap a page
//   provably still on its first document (no other main-frame commit of any kind, nothing in flight) is TOO_SLOW,
//   anything else KEEPS_NAVIGATING as before; the scan's deadline first is LANDING_OUT_OF_TIME.
// The look-alikes (a page that does go to another document, or is going to one, or keeps doing so) must still be
// caught, and quickly. General fake pages only; the real-browser cases are test/integration/selfNavigating.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditPage } from '../../src/audit.js';
import { KEEPS_NAVIGATING, LANDING_MAX_MS, LANDING_OUT_OF_TIME, MOVED_BY_ITSELF, TOO_SLOW, checkMark, markedStill, settleLanding, watchLanding, type DocumentFacts, type DocumentMark } from '../../src/landing.js';
import type { BrowserLike, PageLike } from '../../src/types.js';

const html = (url: string, status = 200) => ({ url: () => url, status: () => status, headers: () => ({ 'content-type': 'text/html' }) });

interface Slow {
  /** ms before the page answers the mark's read (`readMark`). */
  readMs?: number;
  /** ms before the page answers the mark being set (`pageFacts`). */
  markMs?: number;
  /** The read is answered at once, but the clock has moved this far by the time the scan hears it (fake timers). */
  heardLateMs?: number;
  /** The read is answered from the document it was asked of, `readMs` later, whatever the page shows by then. */
  stale?: boolean;
  /** After a `restore`, the time origin read never answers. */
  originHang?: boolean;
}

/** A page whose main-frame events the test sends; evaluate answers for the current document, as slowly as asked. */
function fakePage(slow: Slow = {}) {
  const handlers = new Map<string, ((x: unknown) => void)[]>();
  const main = { url: () => doc.url, parentFrame: () => null };
  let n = 0;
  let restored = false;
  const doc = { url: 'https://example.org/a', origin: 1000, marks: new Map<string, unknown>() };
  const emit = (ev: string, x: unknown) => { for (const h of handlers.get(ev) ?? []) h(x); };
  const request = (url: string) => ({ url: () => url, isNavigationRequest: () => true, frame: () => main, method: () => 'GET', resourceType: () => 'document' });
  const wait = (ms: number | undefined) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  const page = {
    on(ev: string, fn: (x: unknown) => void) { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); },
    mainFrame: () => main,
    isClosed: () => false,
    url: () => doc.url,
    async evaluate(fn: (a: unknown) => unknown, arg: unknown) {
      if (fn.name === 'timeOrigin') return slow.originHang && restored ? new Promise(() => {}) : doc.origin;
      if (fn.name === 'pageFacts') {
        const at = doc;
        await wait(slow.markMs);
        const a = arg as { name: string; token: string } | undefined;
        if (a) at.marks.set(a.name, a.token);
        const facts: DocumentFacts = { href: at.url, navUrl: at.url, status: 200, contentType: 'text/html', marked: !!a && at === doc };
        return facts;
      }
      if (fn.name === 'readMark') {
        const at = doc;
        await wait(slow.readMs);
        if (slow.heardLateMs) vi.advanceTimersByTime(slow.heardLateMs);
        return at === doc ? at.marks.get(arg as string) : undefined;
      }
      return 'complete';
    },
  } as unknown as PageLike;
  return {
    page,
    /** A navigation of the main frame: requested, answered, committed (a new document). */
    navigate(url: string) {
      const r = request(url);
      emit('request', r);
      emit('response', { ...html(url), request: () => r });
      doc.url = url;
      doc.origin = 1000 + ++n;
      doc.marks = new Map();
      emit('framenavigated', main);
    },
    /** A navigation requested and still in flight. */
    request(url: string) { emit('request', request(url)); },
    /** A navigation requested and answered whose commit event is missed: an answer no commit took (ambiguous). */
    missedCommit(url: string) {
      const r = request(url);
      emit('request', r);
      emit('response', { ...html(url), request: () => r });
    },
    /** A same-document change (pushState): a commit no response came before, same time origin. */
    pushState(url: string) { doc.url = url; emit('framenavigated', main); },
    /** A new document no response came before (a back-forward cache restore, an error page): no mark, a new time origin. */
    restore(url: string) {
      restored = true;
      doc.url = url;
      doc.origin = 1000 + ++n;
      doc.marks = new Map();
      emit('framenavigated', main);
    },
  };
}

const noSettle = async () => {};

/** A page loaded and landed (marked at once, real timers); the test then makes its answers slow (`wrapSlow`). */
async function landed() {
  const f = fakePage();
  const w = watchLanding(f.page)!;
  w.begin();
  f.navigate('https://example.org/a');
  const l = await settleLanding(f.page, w, { quietMs: 0, maxMs: 1000, settle: noSettle });
  if (!('mark' in l)) throw new Error(`no landing: ${JSON.stringify(l)}`);
  return { f, w, mark: l.mark, slowPage: f.page };
}

function wrapSlow(page: PageLike, slow: Slow): PageLike['evaluate'] {
  const evaluate = page.evaluate.bind(page);
  return (async (fn: (a: unknown) => unknown, arg: unknown) => {
    if (fn.name === 'readMark') {
      if (slow.stale) {
        const v = await evaluate(fn as never, arg as never);
        await new Promise((r) => setTimeout(r, slow.readMs ?? 0));
        return v;
      }
      if (slow.readMs) await new Promise((r) => setTimeout(r, slow.readMs));
      const v = await evaluate(fn as never, arg as never);
      if (slow.heardLateMs) vi.advanceTimersByTime(slow.heardLateMs);
      return v;
    }
    return evaluate(fn as never, arg as never);
  }) as PageLike['evaluate'];
}

afterEach(() => { vi.useRealTimers(); });

describe('markedStill: a slow answer is not a move (fix/b18-ai-nav)', () => {
  it('the page answers the mark\'s read after 6 s (longer than a call may take), nothing navigated: still the page', async () => {
    const { w, mark, slowPage } = await landed();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    Object.assign(slowPage, { evaluate: wrapSlow(slowPage, { readMs: 6000 }) });
    const still = markedStill(slowPage, w, mark, Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(6500);
    expect(await still).toBe(true);
  });

  it('…and so is one the page answered at once but the scan heard 6 s late (its process was busy)', async () => {
    const { w, mark, slowPage } = await landed();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    Object.assign(slowPage, { evaluate: wrapSlow(slowPage, { heardLateMs: 6000 }) });
    const still = markedStill(slowPage, w, mark, Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(await still).toBe(true);
  });

  it('…and a same-document change (pushState) while the read is slow is not a move either', async () => {
    const { f, w, mark, slowPage } = await landed();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    Object.assign(slowPage, { evaluate: wrapSlow(slowPage, { readMs: 6000 }) });
    const still = markedStill(slowPage, w, mark, Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(2000);
    f.pushState('https://example.org/a#tab');
    // The mark is read again after a commit no response preceded (Sol r1 P1): that read is slow too (6 s more).
    await vi.advanceTimersByTimeAsync(6500);
    expect(await still).toBe(true);
  });

  it('a page that never answers: not the page after LANDING_MAX_MS more, and unanswered (not moved)', async () => {
    const { w, mark, slowPage } = await landed();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    Object.assign(slowPage, { evaluate: (async () => new Promise(() => {})) as PageLike['evaluate'] });
    let done = false;
    const check = checkMark(slowPage, w, mark, Date.now() + 60_000).finally(() => { done = true; });
    await vi.advanceTimersByTimeAsync(LANDING_MAX_MS - 1000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await check).toBe('unanswered');
  });

  it('…bounded without any deadline too (never a hang)', async () => {
    const { w, mark, slowPage } = await landed();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    Object.assign(slowPage, { evaluate: (async () => new Promise(() => {})) as PageLike['evaluate'] });
    const still = markedStill(slowPage, w, mark, Infinity);
    await vi.advanceTimersByTimeAsync(LANDING_MAX_MS + 1000);
    expect(await still).toBe(false);
  });

  it('…and at the caller\'s deadline when that comes sooner: unanswered', async () => {
    const { w, mark, slowPage } = await landed();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    Object.assign(slowPage, { evaluate: (async () => new Promise(() => {})) as PageLike['evaluate'] });
    let done = false;
    const check = checkMark(slowPage, w, mark, Date.now() + 7000).finally(() => { done = true; });
    await vi.advanceTimersByTimeAsync(6500);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(await check).toBe('unanswered');
  });

  // Look-alikes: the page does go, or is going, to another document while the read is slow.
  it('look-alike: a new document commits while the read is slow: not the page, long before the read would end', async () => {
    const { f, w, mark, slowPage } = await landed();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    Object.assign(slowPage, { evaluate: wrapSlow(slowPage, { readMs: 20_000 }) });
    let done = false;
    const still = markedStill(slowPage, w, mark, Date.now() + 60_000).finally(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1000);
    f.navigate('https://example.org/elsewhere');
    await vi.advanceTimersByTimeAsync(5100);
    expect(done).toBe(true);
    expect(await still).toBe(false);
  });

  it('Sol r1 P1: a new document no response came before (a cache restore) during a slow read: the old document\'s late answer is not taken', async () => {
    const { f, w, mark, slowPage } = await landed();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    Object.assign(slowPage, { evaluate: wrapSlow(slowPage, { readMs: 7000, stale: true }) });
    const check = checkMark(slowPage, w, mark, Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(6000);
    f.restore('https://example.org/restored');
    await vi.advanceTimersByTimeAsync(9000);
    expect(await check).toBe('moved');
  });

  it('…while a same-document change (pushState) during the same slow read is still the page (its mark is read again)', async () => {
    const { f, w, mark, slowPage } = await landed();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    Object.assign(slowPage, { evaluate: wrapSlow(slowPage, { readMs: 7000, stale: true }) });
    const check = checkMark(slowPage, w, mark, Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(6000);
    f.pushState('https://example.org/a#tab');
    await vi.advanceTimersByTimeAsync(9000);
    expect(await check).toBe('same');
  });

  it('look-alike: checkMark calls a commit during a slow read a move, not unanswered', async () => {
    const { f, w, mark, slowPage } = await landed();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    Object.assign(slowPage, { evaluate: wrapSlow(slowPage, { readMs: 20_000 }) });
    const check = checkMark(slowPage, w, mark, Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(1000);
    f.navigate('https://example.org/elsewhere');
    await vi.advanceTimersByTimeAsync(10);
    expect(await check).toBe('moved');
  });

  it('look-alike: a navigation requested while the read is slow (still in flight): not the page, long before the read would end', async () => {
    const { f, w, mark, slowPage } = await landed();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    Object.assign(slowPage, { evaluate: wrapSlow(slowPage, { readMs: 20_000 }) });
    let done = false;
    const still = markedStill(slowPage, w, mark, Date.now() + 60_000).finally(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1000);
    f.request('https://example.org/slow-destination');
    await vi.advanceTimersByTimeAsync(5100);
    expect(done).toBe(true);
    expect(await still).toBe(false);
  });

  it('look-alike: a slow answer that comes from another document (the mark is not there): not the page', async () => {
    const { mark, slowPage } = await landed();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const other: DocumentMark = { ...mark, name: `${mark.name}x` };
    Object.assign(slowPage, { evaluate: wrapSlow(slowPage, { readMs: 6000 }) });
    // No events (a browser that reports none): only the mark can tell, and it is missing.
    const still = markedStill(slowPage, undefined, other, Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(6500);
    expect(await still).toBe(false);
  });
});

describe('settleLanding: the cap binds every page; at the cap, TOO_SLOW only for a page provably on its first document (fix/b18-ai-nav)', () => {
  const start = (slow: Slow = {}) => {
    const f = fakePage(slow);
    const w = watchLanding(f.page)!;
    w.begin();
    f.navigate('https://example.org/a');
    return { f, w };
  };

  it('the load\'s own document only (no other commit, nothing in flight), its mark slower than the cap: TOO_SLOW at the cap', async () => {
    const { f, w } = start({ markMs: 1000 });
    const t0 = Date.now();
    const l = await settleLanding(f.page, w, { quietMs: 0, maxMs: 80, scanDeadline: t0 + 5000, settle: noSettle });
    expect(l).toEqual({ stop: TOO_SLOW });
    expect(Date.now() - t0).toBeLessThan(600);
  });

  it('…its settle running past the cap: TOO_SLOW at the cap', async () => {
    const { f, w } = start();
    const t0 = Date.now();
    const l = await settleLanding(f.page, w, { quietMs: 0, maxMs: 80, scanDeadline: t0 + 5000, settle: () => new Promise((r) => setTimeout(r, 3000)) });
    expect(l).toEqual({ stop: TOO_SLOW });
    expect(Date.now() - t0).toBeLessThan(600);
  });

  it('…and the same without a scan deadline', async () => {
    const { f, w } = start({ markMs: 1000 });
    const t0 = Date.now();
    const l = await settleLanding(f.page, w, { quietMs: 0, maxMs: 80, settle: noSettle });
    expect(l).toEqual({ stop: TOO_SLOW });
    expect(Date.now() - t0).toBeLessThan(600);
  });

  it('the scan\'s deadline before the cap: out of time (never "kept loading other pages")', async () => {
    const { f, w } = start({ markMs: 1000 });
    const t0 = Date.now();
    const l = await settleLanding(f.page, w, { quietMs: 0, maxMs: 400, scanDeadline: t0 + 150, settle: noSettle });
    expect(l).toEqual({ stop: LANDING_OUT_OF_TIME });
    expect(Date.now() - t0).toBeLessThan(600);
  });

  // Anything else at the cap is a page that kept navigating, as on the release code.
  it('look-alike: a same-document change (pushState) since the load, then slow: KEEPS_NAVIGATING at the cap (any commit counts)', async () => {
    const { f, w } = start({ markMs: 1000 });
    setTimeout(() => f.pushState('https://example.org/a?tab=1'), 10);
    const t0 = Date.now();
    const l = await settleLanding(f.page, w, { quietMs: 0, maxMs: 80, scanDeadline: t0 + 5000, settle: () => new Promise((r) => setTimeout(r, 30)) });
    expect(l).toEqual({ stop: KEEPS_NAVIGATING });
    expect(Date.now() - t0).toBeLessThan(600);
  });

  it('Sol r1 P2: a replacement no response came before, during a settle that runs past the cap: KEEPS_NAVIGATING at the cap', async () => {
    const { f, w } = start();
    const t0 = Date.now();
    setTimeout(() => f.restore('https://example.org/elsewhere'), 40);
    const l = await settleLanding(f.page, w, { quietMs: 0, maxMs: 80, scanDeadline: t0 + 5000, settle: () => new Promise((r) => setTimeout(r, 3000)) });
    expect(l).toEqual({ stop: KEEPS_NAVIGATING });
    expect(Date.now() - t0).toBeLessThan(150);
  });

  it('Sol r2: a replacement no response came before at 40 ms, the settle ending at 60 ms, its time origin never answering: KEEPS_NAVIGATING at the cap, not later', async () => {
    const { f, w } = start({ originHang: true });
    const t0 = Date.now();
    setTimeout(() => f.restore('https://example.org/elsewhere'), 40);
    const l = await settleLanding(f.page, w, { quietMs: 0, maxMs: 80, scanDeadline: t0 + 5000, settle: () => new Promise((r) => setTimeout(r, 60)) });
    expect(l).toEqual({ stop: KEEPS_NAVIGATING });
    expect(Date.now() - t0).toBeLessThan(150);
  });

  it('look-alike (Sol r3): an answer no commit took (ambiguous), then slow: KEEPS_NAVIGATING at the cap', async () => {
    const { f, w } = start({ markMs: 1000 });
    f.missedCommit('https://example.org/elsewhere');
    expect(w.ambiguous()).toBe(true);
    const t0 = Date.now();
    const l = await settleLanding(f.page, w, { quietMs: 0, maxMs: 80, scanDeadline: t0 + 5000, settle: noSettle });
    expect(l).toEqual({ stop: KEEPS_NAVIGATING });
    expect(Date.now() - t0).toBeLessThan(600);
  });

  it('look-alike (Sol r3): no page events at all (no watch), slow: KEEPS_NAVIGATING at the cap (nothing can prove the first document)', async () => {
    const { f } = start({ markMs: 1000 });
    const t0 = Date.now();
    const l = await settleLanding(f.page, undefined, { quietMs: 0, maxMs: 80, scanDeadline: t0 + 5000, settle: noSettle });
    expect(l).toEqual({ stop: KEEPS_NAVIGATING });
    expect(Date.now() - t0).toBeLessThan(600);
  });

  it('look-alike: a page that went to another document, then answers slowly: KEEPS_NAVIGATING at the cap', async () => {
    const { f, w } = start({ markMs: 400 });
    f.navigate('https://example.org/b');
    const t0 = Date.now();
    const l = await settleLanding(f.page, w, { quietMs: 0, maxMs: 80, scanDeadline: t0 + 5000, settle: noSettle });
    expect(l).toEqual({ stop: KEEPS_NAVIGATING });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('look-alike: a navigation that never answers: KEEPS_NAVIGATING at the cap, the scan\'s deadline far away', async () => {
    const { f, w } = start();
    f.request('https://example.org/never');
    const t0 = Date.now();
    const l = await settleLanding(f.page, w, { quietMs: 0, maxMs: 120, scanDeadline: t0 + 5000, settle: noSettle });
    expect(l).toEqual({ stop: KEEPS_NAVIGATING });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('look-alike: a page that keeps replacing itself, slowly: "kept loading other pages" after 5 more documents', async () => {
    const { f, w } = start({ markMs: 30 });
    let k = 0;
    const t = setInterval(() => f.navigate(`https://example.org/loop-${++k}`), 15);
    const l = await settleLanding(f.page, w, { quietMs: 40, maxMs: 2000, scanDeadline: Date.now() + 5000, settle: noSettle });
    clearInterval(t);
    expect(l).toEqual({ stop: KEEPS_NAVIGATING });
  });
});

describe('auditPage: a page that answers its final check slowly gets its checks (fix/b18-ai-nav)', () => {
  /** A browser whose pages never move; `readMark` answers after `readMs`, from a document that has the mark or not. */
  function slowBrowser(readMs: number, markKept = true): BrowserLike {
    return {
      async newContext() {
        return {
          async newPage() {
            const marks = new Map<string, unknown>();
            let at = '';
            return {
              async goto(u: string) { at = u; return html(u); },
              async evaluate(fn: unknown, arg?: unknown) {
                const name = (fn as { name?: string }).name ?? '';
                if (name === 'pageFacts') {
                  const a = arg as { name: string; token: string } | undefined;
                  if (a) marks.set(a.name, a.token);
                  return { href: at, navUrl: at, status: 200, contentType: 'text/html', marked: !!a } satisfies DocumentFacts;
                }
                if (name === 'readMark') {
                  await new Promise((r) => setTimeout(r, readMs));
                  return markKept ? marks.get(arg as string) : undefined;
                }
                if (name === 'runAxeInPage') return { violations: [], incomplete: [], passes: ['image-alt'], inapplicable: [] };
                return [];
              },
              async addScriptTag() {},
              async waitForTimeout() {},
              async close() {},
            };
          },
          async close() {},
        };
      },
    } as unknown as BrowserLike;
  }

  it('the final check answered after 6 s, the page never moved: checked', async () => {
    const p = await auditPage(slowBrowser(6000), 'https://example.org/', { userAgent: 'UA', axeSource: '' });
    expect([p.status, p.reason]).toEqual(['ok', undefined]);
  }, 20_000);

  it('a final check that does not answer before the scan\'s deadline: out of time, never "went to another page by itself"', async () => {
    const t0 = Date.now();
    const p = await auditPage(slowBrowser(60_000), 'https://example.org/', { userAgent: 'UA', axeSource: '', deadline: t0 + 3000 });
    expect([p.status, p.reason]).toEqual(['failed', LANDING_OUT_OF_TIME]);
    expect(Date.now() - t0).toBeLessThan(6000);
  }, 20_000);

  it('look-alike: the slow final check finds another document (the mark is gone): "went to another page by itself"', async () => {
    const p = await auditPage(slowBrowser(6000, false), 'https://example.org/', { userAgent: 'UA', axeSource: '' });
    expect([p.status, p.reason]).toEqual(['failed', MOVED_BY_ITSELF]);
  }, 20_000);
});
