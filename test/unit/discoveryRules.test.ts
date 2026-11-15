// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Discovery rules from review r1 of the coverage lane (2026-11-10; the lead's rulings 3, 8 and 9):
// - an address that looks like an action is never requested, whether it came from a link or from navigation
//   written as script, and is listed as not visited;
// - reading on past the home page is bounded end to end (a page that never answers cannot hold the scan), and
//   a page's links are capped where they are collected;
// - a directory and its index file are one page only when the server shows it (one leads to the other).
import { describe, expect, it } from 'vitest';
import { DEEPEN, discoverPages, loadWaitBound, PAGE_READ_MS, selectWide } from '../../src/crawl.js';
import { MAX_PAGE_LINKS } from '../../src/pageLinks.js';
import { selectPages } from '../../src/select.js';
import { ACTION_SKIP_REASON, isActionLikeUrl } from '../../src/url.js';
import { actionSkips, MAX_ACTION_SKIPPED, wideFilter } from '../../src/wide.js';
import type { BrowserLike } from '../../src/types.js';
import { fakeFetch } from '../helpers/fakeFetch.js';

const SITE = 'https://www.e.org';
const paths = (r: { pages: string[] }) => r.pages.map((u) => `${new URL(u).pathname}${new URL(u).search}`);
const none = () => fakeFetch(() => new Response('', { status: 404 }));

/** A browser whose pages answer with the links given for their path; every load is logged. */
function linkBrowser(links: Record<string, string[]>, loads: string[] = [], o: { evaluate?: (path: string, arg: unknown) => Promise<unknown> | undefined; close?: () => Promise<void> } = {}): BrowserLike {
  return {
    newContext: async () => {
      let at = '';
      return {
        newPage: async () => ({
          goto: async (url: string) => {
            at = `${new URL(url).pathname}${new URL(url).search}`;
            loads.push(at);
            return { status: () => 200, url: () => url, headers: () => ({ 'content-type': 'text/html' }) };
          },
          evaluate: async (_fn: unknown, arg: unknown) => {
            const custom = o.evaluate?.(at, arg);
            if (custom) return custom;
            return typeof arg === 'number' ? undefined : (links[at] ?? []).map((p) => (p.startsWith('http') ? p : `${SITE}${p}`));
          },
          close: async () => {},
        }),
        close: o.close ?? (async () => {}),
      };
    },
  } as unknown as BrowserLike;
}

describe('finding 3: an address that looks like an action', () => {
  it('is one whose path has a whole segment, or whose query has a name or a whole value, that names an action', () => {
    for (const u of [
      '/logout', '/delete?id=7', '/unsubscribe?token=abc', '/log-out', '/sign_out', '/account/delete', '/posts/7/remove', '/opt-out',
      '/logout.php', '/Confirm.aspx', '/newsletter/unsubscribe/abc123', '/vote', '/like', '/subscribe', '/reset', '/approve', '/reject', '/purge', '/destroy', '/cancel',
      '/account?action=close', '/index.php?do=login', '/page?cmd=x', '/page?op=x', '/item?mode=delete', '/session?logout', '/session?logout=1',
      '/download?token=abc', '/form?_csrf=1', '/form?csrf_token=1', '/link?_wpnonce=9', '/file?signature=abc', '/file?sig=abc', '/x?access_token=1',
    ]) expect(isActionLikeUrl(`${SITE}${u}`), u).toBe(true);
  });

  it('look-alikes are content: the word inside a longer segment, a word of a search, an ordinary parameter', () => {
    for (const u of [
      '/events/cancelled-meetings-2025', '/news/vote-by-mail-guide', '/reset-password', '/how-to-unsubscribe', '/services/remove-a-tree',
      '/about/like-minded-partners', '/delete-my-data-request-form', '/blog/confirming-your-appointment', '/voting', '/likes', '/cancellation-policy',
      '/search?q=delete+account', '/search?q=how+to+unsubscribe', '/news?page=2', '/list?sort=votes', '/item?id=7', '/designs?signed=1', '/doc?version=1.2',
      '/', '/about', '/contact.html',
    ]) expect(isActionLikeUrl(`${SITE}${u}`), u).toBe(false);
  });

  it('a word the start address itself carries is the site\'s own naming: a scan started under /vote/ visits its pages', () => {
    expect(isActionLikeUrl(`${SITE}/vote/polling-places`, `${SITE}/vote/`)).toBe(false);
    expect(isActionLikeUrl(`${SITE}/vote/polling-places`, `${SITE}/`)).toBe(true);
    expect(isActionLikeUrl(`${SITE}/vote/delete`, `${SITE}/vote/`)).toBe(true);
  });

  it('is never selected, from a link or from script-written navigation alike, and is listed as not visited', () => {
    const r = selectPages(`${SITE}/`, [`${SITE}/logout`, `${SITE}/delete?id=7`, `${SITE}/unsubscribe?token=abc`, `${SITE}/about`, `${SITE}/events/cancelled-meetings-2025`, `${SITE}/logout`], 25);
    expect(paths(r)).toEqual(['/', '/about', '/events/cancelled-meetings-2025']);
    expect(r.skipped).toEqual([
      { url: `${SITE}/delete?id=7`, reason: ACTION_SKIP_REASON },
      { url: `${SITE}/logout`, reason: ACTION_SKIP_REASON },
      { url: `${SITE}/unsubscribe?token=abc`, reason: ACTION_SKIP_REASON },
    ]);
    expect(ACTION_SKIP_REASON).toBe('Not visited (looks like an action)');
  });

  it('the start address is always visited, whatever it is called', () => {
    expect(paths(selectPages(`${SITE}/subscribe`, [`${SITE}/about`], 25))).toEqual(['/subscribe', '/about']);
  });

  it('is never opened while discovery reads on, and what it would have led to is not found through it', async () => {
    const loads: string[] = [];
    const browser = linkBrowser({
      '/': ['/logout', '/delete?id=7', '/unsubscribe?token=abc', '/about'],
      '/logout': ['/behind-logout'],
      '/delete?id=7': ['/behind-delete'],
      '/about': ['/about/staff'],
    }, loads);
    const r = await discoverPages(`${SITE}/`, { browser, maxPages: 25, userAgent: 'UA', fetchFn: none().fn });
    expect(loads.filter((p) => /logout|delete|unsubscribe/.test(p))).toEqual([]);
    expect(new Set(paths(r))).toEqual(new Set(['/', '/about', '/about/staff']));
    expect(r.skipped.map((s) => s.reason)).toEqual([ACTION_SKIP_REASON, ACTION_SKIP_REASON, ACTION_SKIP_REASON]);
  });

  it('long scans: neither the first list nor the crawl takes one, and the list of them is bounded', async () => {
    const f = fakeFetch((req) => (new URL(req.url).pathname === '/sitemap.xml'
      ? new Response(`<urlset>${['/a', '/logout', '/account?action=close'].map((p) => `<url><loc>${SITE}${p.replace('&', '&amp;')}</loc></url>`).join('')}</urlset>`)
      : new Response('', { status: 404 })));
    const r = await discoverPages(`${SITE}/`, { browser: linkBrowser({}), maxPages: 60, userAgent: 'UA', fetchFn: f.fn });
    expect(paths(r)).toEqual(['/', '/a']);
    expect(r.skipped.map((s) => [new URL(s.url).pathname, s.reason])).toEqual([['/account', ACTION_SKIP_REASON], ['/logout', ACTION_SKIP_REASON]]);
    // Thousands of them (a wiki's edit links): the first MAX_ACTION_SKIPPED are listed, the rest counted in one record.
    const many = Array.from({ length: MAX_ACTION_SKIPPED + 40 }, (_, i) => `${SITE}/wiki/p${i}?action=edit`);
    const big = selectPages(`${SITE}/`, many, 25);
    expect(big.pages).toEqual([`${SITE}/`]);
    expect(big.skipped.filter((s) => s.reason === ACTION_SKIP_REASON)).toHaveLength(MAX_ACTION_SKIPPED);
    expect(big.skipped.filter((s) => s.reason !== ACTION_SKIP_REASON).map((s) => s.reason)).toEqual([`${ACTION_SKIP_REASON}: 40 more addresses are not listed (the list stops at ${MAX_ACTION_SKIPPED})`]);
  });
});

describe('finding 8: reading on past the home page is bounded end to end', () => {
  it('a page whose script never answers ends at the time box: the scan goes on with what it has', async () => {
    const loads: string[] = [];
    // /site-map loads, then every call into it hangs for good (its thread is blocked).
    const browser = linkBrowser({ '/': ['/site-map', '/about'] }, loads, { evaluate: (path) => (path === '/site-map' ? new Promise(() => {}) : undefined) });
    const t0 = Date.now();
    const r = await discoverPages(`${SITE}/`, { browser, maxPages: 25, userAgent: 'UA', fetchFn: none().fn, deadline: Date.now() + 1200 });
    // A quarter of the time left is the reading's time box (300 ms here); never the page's own pleasure.
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(new Set(paths(r))).toEqual(new Set(['/', '/site-map', '/about']));
  });

  it('a context that never closes does not hold the reading either', async () => {
    const loads: string[] = [];
    let closes = 0;
    const browser = linkBrowser({ '/': ['/a', '/b'], '/a': ['/c'] }, loads, { close: () => (++closes > 1 ? new Promise(() => {}) : Promise.resolve()) });
    const t0 = Date.now();
    const r = await discoverPages(`${SITE}/`, { browser, maxPages: 25, userAgent: 'UA', fetchFn: none().fn, deadline: Date.now() + 1200 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(paths(r)).toContain('/a');
  });

  it('a page with 300,000 links gives its first few thousand, whatever the browser hands back', async () => {
    const loads: string[] = [];
    const flood = Array.from({ length: 300_000 }, (_, i) => `/t/item-${i}`);
    const r = await discoverPages(`${SITE}/`, { browser: linkBrowser({ '/': ['/site-map'], '/site-map': flood }, loads), maxPages: 50, userAgent: 'UA', fetchFn: none().fn });
    expect(MAX_PAGE_LINKS).toBe(5000);
    expect(r.pages).toHaveLength(50);
    // Nothing past the cap was kept as a candidate: the last address of the flood is not in the selection's pool.
    const again = await discoverPages(`${SITE}/`, { browser: linkBrowser({ '/': ['/site-map'], '/site-map': [...flood.slice(0, MAX_PAGE_LINKS).map(() => '/dup'), '/past-the-cap'] }, []), maxPages: 50, userAgent: 'UA', fetchFn: none().fn });
    expect(paths(again)).not.toContain('/past-the-cap');
    expect(DEEPEN.maxLoads).toBe(8);
  });
});

describe('finding 9: a directory and its index file', () => {
  /** A site whose server answers each path with a status and, for a redirect, where to. */
  const server = (answers: Record<string, number | string>) => fakeFetch((req) => {
    const a = answers[new URL(req.url).pathname];
    if (typeof a === 'string') return new Response('', { status: 301, headers: { location: a } });
    return new Response(a === 200 ? '<!doctype html><title>x</title>' : '', { status: a ?? 404, headers: { 'content-type': 'text/html' } });
  });
  const home = (links: string[]) => linkBrowser({ '/': links });

  it('are two pages when the server answers both: nothing but their names says they are one', async () => {
    // Different content at /a and /a/index.html is a real site; so is /a/INDEX.HTML.
    const f = server({ '/a': 200, '/a/index.html': 200, '/b/INDEX.HTML': 200, '/b': 200 });
    const r = await discoverPages(`${SITE}/`, { browser: home(['/a', '/a/index.html', '/b', '/b/INDEX.HTML', '/index.html']), maxPages: 25, userAgent: 'UA', fetchFn: f.fn });
    expect(new Set(paths(r))).toEqual(new Set(['/', '/index.html', '/a', '/a/index.html', '/b', '/b/INDEX.HTML']));
  });

  it('are one page when one of them redirects to the other, whichever way round', async () => {
    const f = server({ '/a': 200, '/a/index.html': '/a/', '/a/': 200, '/b': '/b/index.html', '/b/index.html': 200, '/index.html': '/' , '/': 200 });
    const r = await discoverPages(`${SITE}/`, { browser: home(['/a', '/a/index.html', '/b', '/b/index.html', '/index.html', '/c']), maxPages: 25, userAgent: 'UA', fetchFn: f.fn });
    // The address the server ends at is the page; the start address is always kept.
    expect(new Set(paths(r))).toEqual(new Set(['/', '/a', '/b/index.html', '/c']));
  });

  it('look-alikes: an index file whose directory is not a candidate is not asked about; one with a query never is', async () => {
    const f = server({ '/a/index.html': '/a/' });
    const r = await discoverPages(`${SITE}/`, { browser: home(['/a/index.html', '/d/index.html?page=2', '/d']), maxPages: 25, userAgent: 'UA', fetchFn: f.fn });
    expect(new Set(paths(r))).toEqual(new Set(['/', '/a/index.html', '/d/index.html?page=2', '/d']));
    expect(f.calls.map((c) => new URL(c.url).pathname).filter((p) => p.startsWith('/a') || p.startsWith('/d'))).toEqual([]);
  });

  it('selection itself never folds an index file into its directory, or case', () => {
    const r = selectPages(`${SITE}/`, [`${SITE}/index.html`, `${SITE}/a/`, `${SITE}/a/index.html`, `${SITE}/a/INDEX.HTML`], 25);
    expect(paths(r)).toEqual(['/', '/a', '/index.html', '/a/INDEX.HTML', '/a/index.html']);
    const filter = wideFilter();
    filter.seen(`${SITE}/`);
    expect(filter.admit(`${SITE}/index.html`)).toBe('ok');
    expect(filter.admit(`${SITE}/news/`)).toBe('ok');
    expect(filter.admit(`${SITE}/news/index.html`)).toBe('ok');
    expect(filter.admit(`${SITE}/news/index.html`)).toBe('duplicate');
  });
});

// A second review of the round-2 discovery code (2026-11-10) found these by reading it.
describe('second review: discovery', () => {
  it('an action\'s name with path parameters or another page extension is still an action; pagination tokens are not secrets', () => {
    for (const u of ['/logout;jsessionid=ABC', '/logout.do;jsessionid=ABC', '/logout.xhtml', '/account/delete.jsf', '/unsubscribe.ashx', '/a;x=1/delete']) expect(isActionLikeUrl(`${SITE}${u}`), u).toBe(true);
    for (const u of ['/news?pageToken=abc', '/news?nextPageToken=abc', '/list?continuationToken=x', '/list?cursor_token=x', '/news;jsessionid=ABC', '/reports/annual.2024.html']) expect(isActionLikeUrl(`${SITE}${u}`), u).toBe(false);
    // A secret is still one.
    for (const u of ['/x?accessToken=1', '/x?reset_token=1', '/x?token=1']) expect(isActionLikeUrl(`${SITE}${u}`), u).toBe(true);
  });

  it('the count of action-like addresses past the list is kept when the crawl adds its own', () => {
    const skipped: { url: string; reason: string }[] = [];
    const first = actionSkips(skipped, `${SITE}/`);
    for (let i = 0; i < MAX_ACTION_SKIPPED + 40; i++) first.add(`${SITE}/wiki/p${i}?action=edit`);
    first.end();
    expect(skipped.at(-1)!.reason).toContain('40 more addresses');
    // The crawl: a second counter over the same list.
    const crawl = actionSkips(skipped, `${SITE}/`);
    for (let i = 0; i < 5; i++) crawl.add(`${SITE}/wiki/q${i}?action=edit`);
    crawl.end();
    expect(skipped.filter((x) => x.reason !== ACTION_SKIP_REASON).map((x) => x.reason)).toEqual([`${ACTION_SKIP_REASON}: 45 more addresses are not listed (the list stops at ${MAX_ACTION_SKIPPED})`]);
    // Look-alike: a counter that adds nothing leaves the count as it was.
    actionSkips(skipped, `${SITE}/`).end();
    expect(skipped.at(-1)!.reason).toContain('45 more addresses');
  });

  describe('asking the server about an index file', () => {
    const answers = (map: Record<string, number | string>) => fakeFetch((req) => {
      const u = new URL(req.url);
      const a = map[`${u.pathname}${u.search}`] ?? map[u.pathname];
      if (typeof a === 'string') return new Response('', { status: 301, headers: { location: a } });
      return new Response(a === 200 ? '<!doctype html><title>x</title>' : '', { status: a ?? 404, headers: { 'content-type': 'text/html' } });
    });
    const asked = (f: ReturnType<typeof fakeFetch>) => f.calls.map((c) => new URL(c.url)).filter((u) => u.pathname !== '/robots.txt' && !u.pathname.includes('sitemap')).map((u) => `${u.host}${u.pathname}${u.search}`);

    it('never asks for an address robots.txt blocks', async () => {
      const f = fakeFetch((req) => (new URL(req.url).pathname === '/robots.txt' ? new Response('User-agent: *\nDisallow: /private') : new Response('', { status: 404 })));
      await discoverPages(`${SITE}/`, { browser: linkBrowser({ '/': ['/private/', '/private/index.html', '/open'] }), maxPages: 25, userAgent: 'UA', fetchFn: f.fn });
      expect(asked(f).filter((p) => p.includes('/private'))).toEqual([]);
    });

    it('never follows a redirect to an action-like address or to another host', async () => {
      const f = answers({ '/a/index.html': '/logout', '/b/index.html': 'https://cdn.e.org/b/', '/logout': 200 });
      const r = await discoverPages(`${SITE}/`, { browser: linkBrowser({ '/': ['/a/', '/a/index.html', '/b/', '/b/index.html'] }), maxPages: 25, userAgent: 'UA', fetchFn: f.fn });
      expect(asked(f).filter((p) => p.includes('logout') || p.startsWith('cdn.'))).toEqual([]);
      // Nothing was shown: all four stay pages.
      expect(new Set(paths(r))).toEqual(new Set(['/', '/a', '/a/index.html', '/b', '/b/index.html']));
    });

    it('a one-page scan asks nothing', async () => {
      const f = answers({ '/index.html': '/' });
      const r = await discoverPages(`${SITE}/`, { browser: linkBrowser({ '/': ['/index.html', '/about'] }), maxPages: 1, userAgent: 'UA', fetchFn: f.fn });
      expect(paths(r)).toEqual(['/']);
      expect(asked(f)).toEqual([]);
    });
  });

  it('the start page still gets its whole wait for links a script adds while it loads; a page read on gets 5 s a call', () => {
    // The wait for `load` ends by itself inside the page after `wait` ms; the bound only guards a blocked thread.
    expect(loadWaitBound(15_000, undefined, 45_000)).toBe(16_000);
    expect(loadWaitBound(15_000, Date.now() + 30_000, 30_000)).toBe(PAGE_READ_MS);
    expect(loadWaitBound(15_000, Date.now() + 2_000, 2_000)).toBe(2_000);
    expect(loadWaitBound(1_000, Date.now() + 30_000, 30_000)).toBe(2_000);
    expect(PAGE_READ_MS).toBe(5000);
  });
});

// Round-2 review (2026-11-10, finding 1): the action filter comes before an address is accepted as a document.
describe('round-2 review, finding 1: a document address that looks like an action', () => {
  const ACTION = `${SITE}/delete/report.pdf?token=abc`;

  it('selectPages: not a document of the scan, and the skip is recorded', () => {
    const r = selectPages(`${SITE}/`, [ACTION, `${SITE}/docs/report.pdf`, `${SITE}/account/remove/minutes.docx`, 'https://cdn.other.org/files/delete/guide.pdf'], 25);
    expect(r.documents).toEqual([`${SITE}/docs/report.pdf`]);
    expect(r.skipped.map((x) => [x.url, x.reason])).toEqual([
      ['https://cdn.other.org/files/delete/guide.pdf', ACTION_SKIP_REASON],
      [`${SITE}/account/remove/minutes.docx`, ACTION_SKIP_REASON],
      [ACTION, ACTION_SKIP_REASON],
    ]);
  });

  it('long scans (the first list): the same', () => {
    const r = selectWide(`${SITE}/`, [`${SITE}/a`, ACTION, `${SITE}/docs/report.pdf`], 60, () => true);
    expect(r.pages.map((u) => new URL(u).pathname)).toEqual(['/', '/a']);
    expect(r.documents).toEqual([`${SITE}/docs/report.pdf`]);
    expect(r.skipped).toEqual([{ url: ACTION, reason: ACTION_SKIP_REASON }]);
  });

  it('look-alikes: documents whose addresses only hold such a word are documents of the scan', () => {
    const docs = [`${SITE}/news/vote-by-mail-guide.pdf`, `${SITE}/forms/cancellation-request.pdf`, `${SITE}/files/reset-instructions.docx`, `${SITE}/docs/report.pdf?version=2`];
    const r = selectPages(`${SITE}/`, docs, 25);
    expect(r.documents).toEqual([...docs].sort());
    expect(r.skipped).toEqual([]);
  });
});


// Round-2 review (2026-11-10, finding 3; the lead's decision): opening the context and the page are inside the
// reading's time box too. The reviewer's input: `/` links to `/site-map`, the second context creation never
// resolves, the scan's deadline is 1.2 s away, and discovery was still pending after 1.62 s.
describe('round-2 review, finding 3: opening a page to read on is inside the time box', () => {
  /** A browser like `linkBrowser`, whose n-th context (or the page of it) never opens, or opens after `lateMs`. */
  function stallingBrowser(links: Record<string, string[]>, stall: { context?: number; page?: number; lateMs?: number }, closed: number[] = []): BrowserLike {
    let contexts = 0;
    const later = <T>(v: T): Promise<T> => (stall.lateMs === undefined ? new Promise<T>(() => {}) : new Promise<T>((r) => setTimeout(() => r(v), stall.lateMs)));
    return {
      newContext: () => {
        const n = ++contexts;
        let at = '';
        const page = {
          goto: async (url: string) => { at = new URL(url).pathname; return { status: () => 200, url: () => url, headers: () => ({ 'content-type': 'text/html' }) }; },
          evaluate: async (_fn: unknown, arg: unknown) => (typeof arg === 'number' ? undefined : (links[at] ?? []).map((p) => `${SITE}${p}`)),
          close: async () => {},
        };
        const context = { newPage: () => (n === stall.page ? later(page) : Promise.resolve(page)), close: async () => { closed.push(n); } };
        return n === stall.context ? later(context) : Promise.resolve(context);
      },
    } as unknown as BrowserLike;
  }
  const LINKS = { '/': ['/site-map', '/about'], '/site-map': ['/deep/a', '/deep/b'], '/about': ['/about/staff'] };

  it('a context that never opens: discovery ends with the time box, and the scan goes on with what it has', async () => {
    const t0 = Date.now();
    // The reading's time box is a quarter of the time left: 300 ms.
    const r = await discoverPages(`${SITE}/`, { browser: stallingBrowser(LINKS, { context: 2 }), maxPages: 25, userAgent: 'UA', fetchFn: none().fn, deadline: Date.now() + 1200 });
    expect(Date.now() - t0).toBeLessThan(900);
    expect(new Set(paths(r))).toEqual(new Set(['/', '/site-map', '/about']));
  });

  it('a page that never opens in its context: the same, and the context is closed', async () => {
    const closed: number[] = [];
    const t0 = Date.now();
    const r = await discoverPages(`${SITE}/`, { browser: stallingBrowser(LINKS, { page: 2 }, closed), maxPages: 25, userAgent: 'UA', fetchFn: none().fn, deadline: Date.now() + 1200 });
    expect(Date.now() - t0).toBeLessThan(900);
    expect(new Set(paths(r))).toEqual(new Set(['/', '/site-map', '/about']));
    expect(closed).toContain(2);
  });

  it('a context that opens after the time box is closed when it comes, and never used', async () => {
    const closed: number[] = [];
    const loads: string[] = [];
    const browser = stallingBrowser(LINKS, { context: 2, lateMs: 500 }, closed);
    const r = await discoverPages(`${SITE}/`, { browser, maxPages: 25, userAgent: 'UA', fetchFn: none().fn, deadline: Date.now() + 1200 });
    expect(paths(r)).not.toContain('/deep/a');
    await new Promise((res) => setTimeout(res, 400));
    expect(closed).toContain(2);
    void loads;
  });

  it('look-alike: contexts that open at once are read as before, each page once', async () => {
    const r = await discoverPages(`${SITE}/`, { browser: stallingBrowser(LINKS, {}), maxPages: 25, userAgent: 'UA', fetchFn: none().fn, deadline: Date.now() + 20_000 });
    expect(new Set(paths(r))).toEqual(new Set(['/', '/site-map', '/about', '/deep/a', '/deep/b', '/about/staff']));
  });
});
