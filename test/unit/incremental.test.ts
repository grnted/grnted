// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Incremental monitoring scans (Plan 7, W6; docs/monitoring.md): the per-page decision, cheapest
// first (sitemap lastmod, a conditional GET, the normalised HTML's hash plus the site's stylesheets and
// scripts), the safety nets, and the state a monitor keeps for its next scan. No browser here: the
// decisions are fetches and comparisons; the browser audit is the caller's (scan.ts).
import { describe, expect, it } from 'vitest';
import {
  assetIdentity, assetRefs, createIncrementalRun, findingsKey, incrementalIsFull, incrementalSummary, isThinHtml, lastmodSays, nextIncrementalState,
  normalizeHtml, NORMALIZE_VERSION, parseLastmod, type IncrementalPrevious, type PageRevision,
} from '../../src/incremental/index.js';
import { AXE_VERSION } from '../../src/ruleImpacts.js';
import { ENGINE_VERSION, SCORING_VERSION } from '../../src/version.js';
import { sitemapLastmods } from '../../src/sitemap.js';
import { WORKER_ACCEPT_LANGUAGE } from '../../src/incremental/index.js';
import { createPace } from '../../src/pace.js';
import type { PageAudit } from '../../src/types.js';
import { fakeFetch } from '../helpers/fakeFetch.js';

const SITE = 'https://e.org/';

describe('normalizeHtml', () => {
  const page = (inner: string) => `<!doctype html><html><head><title>T</title></head><body>${inner}</body></html>`;
  it('is deterministic and ignores whitespace and comments', () => {
    const a = normalizeHtml(page('<p>Hi   there</p>\n<!-- built 2026-11-03 10:00 by node-7 -->'), SITE);
    const b = normalizeHtml(page('<p>Hi there</p>'), SITE);
    expect(a).toBe(b);
    expect(normalizeHtml(page('<p>Hi</p>'), SITE)).toBe(normalizeHtml(page('<p>Hi</p>'), SITE));
  });
  it('strips nonces, CSRF and session tokens', () => {
    const one = page('<script nonce="abc123">x()</script><meta name="csrf-token" content="t-1"><form><input type="hidden" name="authenticity_token" value="aaa"><input type="hidden" name="_wpnonce" value="n1"><input name="q" value="kept"></form>');
    const two = page('<script nonce="zzz999">x()</script><meta name="csrf-token" content="t-2"><form><input type="hidden" name="authenticity_token" value="bbb"><input type="hidden" name="_wpnonce" value="n2"><input name="q" value="kept"></form>');
    expect(normalizeHtml(one, SITE)).toBe(normalizeHtml(two, SITE));
    // A visible field's value is content.
    expect(normalizeHtml(one, SITE)).not.toBe(normalizeHtml(one.replace('value="kept"', 'value="other"'), SITE));
  });
  it('r1-4: blanks date-times only in attributes and machine stamps; a visible time is content (the meeting-time edit is audited)', () => {
    // In attributes, <time datetime>, meta, hidden inputs and data-* stamps: blanked.
    expect(normalizeHtml(page('<p data-generated="2026-11-03T10:00:01Z"><time datetime="2026-11-03T10:00:01Z">Tuesday</time><meta name="date" content="2026-11-03T10:00:01Z"></p>'), SITE))
      .toBe(normalizeHtml(page('<p data-generated="2026-12-01T22:13:59Z"><time datetime="2026-12-01T22:13:59Z">Tuesday</time><meta name="date" content="2026-12-01T22:13:59Z"></p>'), SITE));
    // In the text people read: content.
    expect(normalizeHtml(page('<p>The meeting is at 2026-11-03T15:00:00Z</p>'), SITE)).not.toBe(normalizeHtml(page('<p>The meeting is at 2026-11-04T15:00:00Z</p>'), SITE));
    // A date on its own (an event's date) is content.
    expect(normalizeHtml(page('<p>Open house 2026-11-03</p>'), SITE)).not.toBe(normalizeHtml(page('<p>Open house 2026-11-04</p>'), SITE));
  });
  it('r1-10: lang, title and aria-label edits are content', () => {
    const base = '<main lang="en"><a href="/x" title="Read more" aria-label="Read the budget">Budget</a></main>';
    for (const edit of [base.replace('lang="en"', 'lang="es"'), base.replace('title="Read more"', 'title="More"'), base.replace('aria-label="Read the budget"', 'aria-label=""')]) {
      expect(normalizeHtml(page(edit), SITE)).not.toBe(normalizeHtml(page(base), SITE));
    }
    expect(normalizeHtml('<html lang="en"><title>A</title></html>', SITE)).not.toBe(normalizeHtml('<html lang="en"><title>B</title></html>', SITE));
  });
  it('strips cache-busting, tracking and session parameters from addresses', () => {
    const a = page('<link rel="stylesheet" href="/a.css?v=1"><a href="/news?utm_source=mail&amp;id=4">n</a><img src="/i.png?_=1699999999"><a href="/x;jsessionid=AB12">x</a>');
    const b = page('<link rel="stylesheet" href="/a.css?v=2"><a href="/news?utm_source=feed&amp;id=4">n</a><img src="/i.png?_=1700000000"><a href="/x;jsessionid=CD34">x</a>');
    expect(normalizeHtml(a, SITE)).toBe(normalizeHtml(b, SITE));
    // Other parameters are content.
    expect(normalizeHtml(a, SITE)).not.toBe(normalizeHtml(a.replace('id=4', 'id=5'), SITE));
  });
  it('sees a real content change', () => {
    expect(normalizeHtml(page('<p>Old</p>'), SITE)).not.toBe(normalizeHtml(page('<p>New</p>'), SITE));
    expect(normalizeHtml(page('<img src="/a.png" alt="A">'), SITE)).not.toBe(normalizeHtml(page('<img src="/a.png">'), SITE));
  });
});

describe('assetRefs and assetIdentity', () => {
  it('r1-2a: lists every stylesheet and script the page uses, of any origin, once each, cache-busting removed from the identity', () => {
    const html = `<head><link rel="stylesheet" href="/assets/site.css?v=3"><link href="https://cdn.e.org/x.css" rel="preload stylesheet">
      <link rel="icon" href="/favicon.svg"><script src="/assets/site.js"></script><script src="https://other.example/t.js"></script>
      <link rel="modulepreload" href="/assets/chunk.js"><script>inline()</script><link rel=stylesheet href=/assets/site.css?v=3></head>`;
    expect(assetRefs(html, 'https://www.e.org/about', 'https://www.e.org/')).toEqual([
      { id: 'https://cdn.e.org/x.css', url: 'https://cdn.e.org/x.css' },
      { id: 'https://other.example/t.js', url: 'https://other.example/t.js' },
      { id: 'https://www.e.org/assets/chunk.js', url: 'https://www.e.org/assets/chunk.js' },
      { id: 'https://www.e.org/assets/site.css', url: 'https://www.e.org/assets/site.css?v=3' },
      { id: 'https://www.e.org/assets/site.js', url: 'https://www.e.org/assets/site.js' },
    ]);
  });
  it('honours <base href>', () => {
    expect(assetRefs('<base href="https://e.org/sub/"><script src="app.js"></script>', 'https://e.org/a', SITE).map((a) => a.id)).toEqual(['https://e.org/sub/app.js']);
  });
  it('identity drops the fragment and the cache-busting parameters, keeps the rest sorted', () => {
    expect(assetIdentity('https://e.org/a.js?ver=6.4&b=2&a=1#x')).toBe('https://e.org/a.js?a=1&b=2');
  });
});

describe('isThinHtml (client-rendered pages)', () => {
  it('is true for a shell with no text outside its scripts', () => {
    expect(isThinHtml('<html><body><div id="root"></div><script src="/app.js"></script><script>window.__DATA__={"a":"' + 'x'.repeat(500) + '"}</script></body></html>')).toBe(true);
  });
  it('is false for a page with content', () => {
    expect(isThinHtml(`<html><body><main><h1>Welcome to Fernwood</h1><p>${'Our district serves families across the valley. '.repeat(3)}</p></main></body></html>`)).toBe(false);
  });
});

describe('sitemap lastmod', () => {
  it('reads each url\'s lastmod', () => {
    const xml = `<urlset><url><loc>https://e.org/a</loc><lastmod>2026-10-01</lastmod></url><url><lastmod>2026-10-02T10:00:00+00:00</lastmod><loc>https://e.org/b</loc></url><url><loc>https://e.org/c</loc></url></urlset>`;
    expect(sitemapLastmods(xml)).toEqual({ 'https://e.org/a': '2026-10-01', 'https://e.org/b': '2026-10-02T10:00:00+00:00' });
  });
  it('parses W3C datetimes; a date alone counts to the end of that day anywhere on earth', () => {
    expect(parseLastmod('2026-10-02T10:00:00+00:00')).toBe(Date.UTC(2026, 9, 2, 10));
    expect(parseLastmod('2026-10-02T10:00Z')).toBe(Date.UTC(2026, 9, 2, 10));
    expect(parseLastmod('2026-10-02')).toBe(Date.UTC(2026, 9, 3, 14));
    expect(parseLastmod('yesterday')).toBeNull();
    expect(parseLastmod('2026-10-02T10:00:00')).toBeNull(); // a time without a zone is unsure
  });
  it('says unchanged only when strictly older than the previous scan', () => {
    const prev = '2026-10-15T00:00:00.000Z';
    expect(lastmodSays('2026-10-01', prev)).toBe('unchanged');
    expect(lastmodSays('2026-10-14', prev)).toBe('changed'); // the end of the 14th anywhere is after the scan began
    expect(lastmodSays('2026-10-15T00:00:00Z', prev)).toBe('changed');
    expect(lastmodSays(undefined, prev)).toBeUndefined();
    expect(lastmodSays('garbage', prev)).toBeUndefined();
  });
});

// ---- the decision ----

interface FakePage {
  body: string; etag?: string; lastModified?: string; status?: number; type?: string;
  /** The body by request headers (a site that varies by language or cookie). */
  vary?: (h: Record<string, string>) => string;
  /** The request fails (no answer). */
  throws?: boolean;
}
type Site = Record<string, FakePage>;

/** A site double: pages and files by full address or by path, honouring If-None-Match / If-Modified-Since. */
function fakeSite(pages: Site) {
  return fakeFetch((req) => {
    const u = new URL(req.url);
    const p = pages[u.href] ?? pages[u.pathname + u.search] ?? pages[u.pathname];
    if (!p) return new Response('nope', { status: 404 });
    if (p.throws) throw new TypeError('fetch failed');
    const h: Record<string, string> = { 'content-type': p.type ?? (/\.css$/.test(u.pathname) ? 'text/css' : /\.js$/.test(u.pathname) ? 'text/javascript' : 'text/html') };
    if (p.etag) h.etag = p.etag;
    if (p.lastModified) h['last-modified'] = p.lastModified;
    if (p.etag && req.headers['if-none-match'] === p.etag) return new Response(null, { status: 304, headers: h });
    if (!p.etag && p.lastModified && req.headers['if-modified-since'] === p.lastModified) return new Response(null, { status: 304, headers: h });
    return new Response(p.vary ? p.vary(req.headers) : p.body, { status: p.status ?? 200, headers: h });
  });
}

const html = (title: string, extra = '') => `<!doctype html><html lang="en"><head><title>${title}</title><link rel="stylesheet" href="/site.css"></head><body><main><h1>${title}</h1><p>${'Some words about this page for people to read. '.repeat(3)}</p>${extra}</main></body></html>`;

const audit = (url: string, rules: Record<string, 'pass' | 'fail'> = { 'image-alt': 'pass' }, shape = 'm1|h1'): PageAudit => ({
  url, status: 'ok', rules: rules as PageAudit['rules'], links: [],
  violations: Object.entries(rules).filter(([, o]) => o === 'fail').map(([id]) => ({ id, impact: 'serious', help: id, helpUrl: '', tags: [], nodes: [{ target: 'img', html: '<img>', viewports: ['desktop'] }] })) as unknown as PageAudit['violations'],
  incomplete: [], collected: { shape },
});

/** What the browser's own load of the page answered (the audit keeps it for the decision, `PageAudit.document`). */
function docOf(site: Site, url: string): PageAudit['document'] {
  const u = new URL(url);
  const p = site[u.href] ?? site[u.pathname];
  if (!p) return { status: 404, url };
  return { status: p.status ?? 200, url, ...(p.etag ? { etag: p.etag } : {}), ...(p.lastModified ? { lastModified: p.lastModified } : {}), html: p.body } as PageAudit['document'];
}

interface ScanIn {
  state: IncrementalPrevious | null; site: Site; list: string[]; audits: Map<string, PageAudit>; startedAt: string;
  full?: boolean; lastmods?: Record<string, string>; pace?: ReturnType<typeof createPace>;
  /** What the browser finds on a page this scan (default: what it found last time). */
  fresh?: (u: string) => PageAudit;
  /** The rendered DOM's text length and element count (default: as the HTML has them). */
  rendered?: (u: string) => { text: number; elements: number } | undefined;
  /** Run every page at once instead of one at a time. */
  parallel?: boolean;
  /** The HTML the browser's own load read (default: what the site serves); null: `response.text()` failed. */
  browserHtml?: (u: string) => string | null | undefined;
}

/** One monitoring scan as the engine runs it: decide, then audit in the browser what was not carried. */
async function scanOnce(o: ScanIn) {
  const f = fakeSite(o.site);
  const run = createIncrementalRun({
    options: { previous: o.state, full: o.full ?? false, carried: async (u) => o.audits.get(u) }, site: SITE, startedAt: o.startedAt, userAgent: 'ua',
    fetchFn: f.fn, lastmods: o.lastmods ?? {}, list: () => o.list, known: () => undefined, ...(o.pace ? { pace: o.pace } : {}),
  });
  const browser = (u: string): PageAudit => {
    const base = o.fresh?.(u) ?? o.audits.get(u) ?? audit(u);
    const doc = docOf(o.site, u)! as NonNullable<PageAudit['document']> & { html?: string };
    const bh = o.browserHtml?.(u);
    if (bh === null) delete doc.html;
    else if (bh !== undefined) doc.html = bh;
    const r = o.rendered?.(u);
    return { ...base, url: u, document: { ...doc, ...(r ? { rendered: r } : {}) } as PageAudit['document'] };
  };
  const one = async (i: number) => {
    const u = o.list[i]!;
    const d = await run.decide(i, u);
    return d.kind === 'carry' ? d.page : run.audited(i, browser(u), d);
  };
  const out: PageAudit[] = [];
  if (o.parallel) (await Promise.all(o.list.map((_, i) => one(i)))).forEach((p, i) => { out[i] = p; });
  else for (const i of o.list.keys()) out.push(await one(i));
  const state = nextIncrementalState(o.state, out, { startedAt: o.startedAt, full: !!o.full || !o.state });
  return { out, state, audits: new Map(out.map((p) => [p.url, p])), calls: f.calls, decided: out.map((p) => (p.revision as PageRevision).decided) };
}

const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-11-01T00:00:00.000Z';

/** A first scan of `paths` against `previousSite` (every page new), then `next` runs the scan under test. */
async function setup(o: { paths: string[]; site: Site; previousSite?: Site; previousAudits?: Map<string, PageAudit>; trust?: 'unproven' | 'trusted' | 'ignored' }) {
  const list = o.paths.map((p) => new URL(p, SITE).href);
  const audits = o.previousAudits ?? new Map(list.map((u) => [u, audit(u)]));
  const first = await scanOnce({ state: null, site: o.previousSite ?? o.site, list, audits, startedAt: T0 });
  let previous = first.state;
  if (o.trust) previous = { ...previous, lastmod: { trust: o.trust } };
  return {
    list, previous, first,
    next: (over: Partial<ScanIn> = {}) => scanOnce({ state: previous, site: o.site, list, audits: first.audits, startedAt: T1, ...over }),
  };
}

const stable = (n: number, extra: Site = {}): Site => ({
  '/site.css': { body: 'body{color:#111}', etag: '"css1"' },
  ...Object.fromEntries(Array.from({ length: n }, (_, i) => [i ? `/p${i}` : '/', { body: html(`Page ${i}`), etag: `"e${i}"`, lastModified: 'Wed, 01 Oct 2026 00:00:00 GMT' }])),
  ...extra,
});
const PATHS = (n: number) => Array.from({ length: n }, (_, i) => (i ? `/p${i}` : '/'));
const pagesFetched = (calls: { url: string }[]) => calls.map((c) => new URL(c.url).pathname).filter((p) => !/\.(css|js)$/.test(p));

describe('createIncrementalRun: the layers', () => {
  it('a first scan (no previous state) audits every page and records what the browser\'s own load answered', async () => {
    const s = await setup({ paths: PATHS(3), site: stable(3) });
    expect(s.first.decided).toEqual(['new', 'new', 'new']);
    const st = s.previous.pages[1]!;
    expect(st).toMatchObject({ url: 'https://e.org/p1', etag: '"e1"', lastModified: 'Wed, 01 Oct 2026 00:00:00 GMT', assets: ['https://e.org/site.css'], shape: 'm1|h1', since: T0 });
    expect(st.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.previous.assets['https://e.org/site.css']).toMatchObject({ url: 'https://e.org/site.css', etag: '"css1"' });
    // r2-4: one plain worker GET per page (the stored hash is the worker's), then the browser load.
    expect(pagesFetched(s.first.calls).sort()).toEqual(['/', '/p1', '/p2']);
  });

  it('layer 2: a 304 to the conditional GET carries the page forward (the homepage is audited anyway)', async () => {
    const s = await setup({ paths: PATHS(8), site: stable(8) });
    const r = await s.next();
    // Every page has the same DOM shape, so the core-test template sample is the homepage alone.
    expect(r.decided).toEqual(['home', 'not-modified', 'not-modified', 'not-modified', 'not-modified', 'not-modified', 'not-modified', 'not-modified']);
    expect(r.out[3]!.unchangedSince).toBe(T0);
    expect(r.out[3]!.rules).toEqual({ 'image-alt': 'pass' });
    const req = r.calls.find((c) => c.url === 'https://e.org/p3')!;
    expect(req.headers['if-none-match']).toBe('"e3"');
    expect(req.headers['if-modified-since']).toBe('Wed, 01 Oct 2026 00:00:00 GMT');
  });

  it('layer 3: a 200 whose normalised HTML is the same carries the page forward; a real change is audited', async () => {
    const site = stable(6);
    const prev: Site = { ...site };
    const now: Site = { ...site };
    for (const p of ['/p2', '/p3', '/p4', '/p5']) {
      prev[p] = { body: site[p]!.body.replace('<main>', '<main><script nonce="r-1">1</script>'), lastModified: 'Wed, 01 Oct 2026 00:00:00 GMT' };
      now[p] = { body: site[p]!.body.replace('<main>', '<main><script nonce="r-2">1</script>'), lastModified: 'Sun, 01 Nov 2026 00:00:00 GMT' };
    }
    now['/p4'] = { ...now['/p4']!, body: now['/p4']!.body.replace('Page 4', 'Page 4 (updated)') };
    const s = await setup({ paths: PATHS(6), site: now, previousSite: prev });
    const r = await s.next();
    expect(r.decided.slice(2)).toEqual(['same-html', 'same-html', 'changed', 'same-html']);
    expect(r.out[4]!.unchangedSince).toBeUndefined();
  });

  it('layer 1: a trusted sitemap lastmod older than the previous scan carries the page with no request at all', async () => {
    const s = await setup({ paths: PATHS(5), site: stable(5), trust: 'trusted' });
    const r = await s.next({ lastmods: { 'e.org/p2': '2026-09-01', 'e.org/p3': '2026-10-20', 'e.org/p4': '2026-09-01' } });
    expect(r.decided).toEqual(['home', 'not-modified', 'lastmod', 'not-modified', 'lastmod']);
    // The homepage gets its worker GET (r2-4); /p2 and /p4 get no request at all.
    expect(pagesFetched(r.calls).sort()).toEqual(['/', '/p1', '/p3']);
  });

  it('layer 1 is not used before the sitemap proved reliable (unproven) or once it lied (ignored)', async () => {
    for (const trust of ['unproven', 'ignored'] as const) {
      const s = await setup({ paths: PATHS(4), site: stable(4), trust });
      expect((await s.next({ lastmods: { 'e.org/p2': '2026-09-01', 'e.org/p3': '2026-09-01' } })).decided.slice(2)).toEqual(['not-modified', 'not-modified']);
    }
  });

  it('new pages, pages that now fail and pages whose carried audit is gone are audited', async () => {
    const s = await setup({ paths: PATHS(4), site: { ...stable(4), '/p3': { body: 'gone', status: 404 } }, previousSite: stable(4) });
    s.list.push('https://e.org/new');
    const audits = new Map(s.first.audits);
    audits.delete('https://e.org/p2');
    expect((await s.next({ audits, site: { ...stable(4), '/p3': { body: 'gone', status: 404 }, '/new': { body: html('New') } } })).decided.slice(2)).toEqual(['no-previous-audit', 'changed', 'new']);
  });

  it('a full cycle audits every page and records state from the browser\'s loads', async () => {
    const s = await setup({ paths: PATHS(4), site: stable(4) });
    const r = await s.next({ full: true });
    expect(r.decided).toEqual(['full', 'full', 'full', 'full']);
    expect(r.out.every((p) => (p.revision as PageRevision).etag && (p.revision as PageRevision).hash)).toBe(true);
    expect(r.out.every((p) => p.document === undefined)).toBe(true); // the HTML is not kept in the audit
  });

  it('client-rendered: thin pages are always audited, and a site of identical shells is audited in full', async () => {
    const shell = '<!doctype html><html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>';
    const site: Site = { '/app.js': { body: 'render()', etag: '"js"' } };
    for (const p of PATHS(5)) site[p] = { body: shell, etag: '"same"' };
    const s = await setup({ paths: PATHS(5), site });
    expect(s.previous.shell).toBe(true);
    expect((await s.next()).decided).toEqual(['home', 'client-rendered', 'client-rendered', 'client-rendered', 'client-rendered']);
  });

  it('an unanswered asset is unsure: its pages are audited', async () => {
    const s = await setup({ paths: PATHS(4), site: { ...stable(4), '/site.css': { body: 'x', status: 500 } }, previousSite: stable(4) });
    expect((await s.next()).decided.slice(2)).toEqual(['unsure', 'unsure']);
  });

  it('r1-9: the core-test template sample is audited every scan (pages of different shapes)', async () => {
    const paths = ['/', '/news/a-b-c', '/news/d-e-f', '/staff/x1y2z3a4', '/staff/b5c6d7e8'];
    const list = paths.map((p) => new URL(p, SITE).href);
    const site: Site = { '/site.css': { body: 'a{}', etag: '"c"' }, ...Object.fromEntries(paths.map((p, i) => [p, { body: html(`P${i}`), etag: `"e${i}"` }])) };
    const audits = new Map(list.map((u) => [u, audit(u, undefined, u.includes('/news/') ? 'news' : u.includes('/staff/') ? 'staff' : 'home')]));
    const s = await setup({ paths, site, previousAudits: audits });
    expect((await s.next()).decided).toEqual(['home', 'sample', 'not-modified', 'sample', 'not-modified']);
  });

  it('r1-10: lang, title and aria-label edits are audited', async () => {
    const page = (lang: string, title: string, label: string) => `<!doctype html><html lang="${lang}"><head><title>${title}</title></head><body><main><h1>Budget</h1><p>${'Words for people to read on this page. '.repeat(3)}</p><a href="/b" aria-label="${label}">Budget</a></main></body></html>`;
    // Each page its own heading (identical pages would make a client-rendered site).
    const at = (p: string, h: string) => h.replace('<h1>Budget</h1>', `<h1>Budget ${p}</h1>`);
    const before: Site = Object.fromEntries(PATHS(4).map((p) => [p, { body: at(p, page('en', 'Budget', 'Read the budget')) }]));
    const after: Site = { ...before, '/p1': { body: at('/p1', page('es', 'Budget', 'Read the budget')) }, '/p2': { body: at('/p2', page('en', 'Old budget', 'Read the budget')) }, '/p3': { body: at('/p3', page('en', 'Budget', '')) } };
    const s = await setup({ paths: PATHS(4), site: after, previousSite: before });
    expect((await s.next()).decided).toEqual(['home', 'changed', 'changed', 'changed']);
  });

  it('r1-4: a visible meeting-time edit is audited', async () => {
    const before = stable(3, { '/p2': { body: html('Board', '<p>The meeting is at 2026-11-03T15:00:00Z</p>') } });
    const after = stable(3, { '/p2': { body: html('Board', '<p>The meeting is at 2026-11-04T15:00:00Z</p>') } });
    const s = await setup({ paths: PATHS(3), site: after, previousSite: before });
    expect((await s.next()).decided).toEqual(['home', 'not-modified', 'changed']);
  });
});

describe('r1-1: a 304 is never evidence, validators that lie are dropped, full cycles check lastmod', () => {
  it('r1-1a: pages that answer 304 never prove the sitemap', async () => {
    const s = await setup({ paths: PATHS(6), site: stable(6) });
    const r = await s.next({ lastmods: Object.fromEntries(PATHS(6).map((p) => [`e.org${p === '/' ? '/' : p}`, '2026-09-01'])) });
    expect(r.decided.filter((d) => d === 'not-modified').length).toBe(5);
    expect(r.state.lastmod.trust).toBe('unproven');
  });

  it('r1-1b: Grok\'s /privacy: a sticky ETag and lastmod 2020-01-01 lose their trust at the full cycle, and the next edit is audited', async () => {
    const paths = ['/', '/about', '/contact', '/privacy'];
    const lastmods = Object.fromEntries(paths.map((p) => [`e.org${p}`, '2020-01-01']));
    const site = (privacy: string): Site => ({ '/site.css': { body: 'a{}', etag: '"c"' }, ...Object.fromEntries(paths.map((p) => [p, { body: html(p === '/privacy' ? privacy : p), etag: '"sticky"' }])) });
    const list = paths.map((p) => new URL(p, SITE).href);
    const s0 = await scanOnce({ state: null, site: site('Privacy v1'), list, audits: new Map(list.map((u) => [u, audit(u)])), startedAt: '2026-08-01T00:00:00.000Z', lastmods });
    // A full cycle with nothing changed: every lastmod agrees with a real body: trusted.
    const s1 = await scanOnce({ state: s0.state, site: site('Privacy v1'), list, audits: s0.audits, startedAt: '2026-09-01T00:00:00.000Z', lastmods, full: true });
    expect(s1.state.lastmod.trust).toBe('trusted');
    // /privacy changes; the server keeps its ETag. Carried from the trusted lastmod (bounded by the full cycle).
    const s2 = await scanOnce({ state: s1.state, site: site('Privacy v2'), list, audits: s1.audits, startedAt: '2026-10-01T00:00:00.000Z', lastmods });
    expect(s2.decided[3]).toBe('lastmod');
    // The full cycle reads the real body (no conditional headers): the lastmod and the ETag both lied.
    const s3 = await scanOnce({ state: s2.state, site: site('Privacy v2'), list, audits: s2.audits, startedAt: '2026-11-01T00:00:00.000Z', lastmods, full: true, fresh: (u) => (u.endsWith('/privacy') ? audit(u, { 'link-name': 'fail' }) : audit(u)) });
    // The full cycle: one plain worker GET per page, no conditional header (r1-1, r2-4).
    expect(pagesFetched(s3.calls).sort()).toEqual([...paths].sort());
    expect(s3.calls.some((c) => c.headers['if-none-match'] || c.headers['if-modified-since'])).toBe(false);
    expect(s3.state.lastmod.trust).toBe('ignored');
    expect(s3.state.validators?.trust).toBe('ignored');
    // From now on: no lastmod skip and no conditional GET for this site; an unchanged page compares its body.
    const s4 = await scanOnce({ state: s3.state, site: site('Privacy v2'), list, audits: s3.audits, startedAt: '2026-12-01T00:00:00.000Z', lastmods });
    expect(s4.decided[3]).toBe('same-html');
    expect(s4.calls.filter((c) => c.url.endsWith('/privacy')).every((c) => !c.headers['if-none-match'] && !c.headers['if-modified-since'])).toBe(true);
    const s5 = await scanOnce({ state: s4.state, site: site('Privacy v3'), list, audits: s4.audits, startedAt: '2027-01-01T00:00:00.000Z', lastmods });
    expect(s5.decided[3]).toBe('changed');
  });

  it('r1-1c: on a full cycle, a page whose lastmod said unchanged but whose audit changed revokes the trust', async () => {
    const s = await setup({ paths: PATHS(5), site: stable(5), trust: 'trusted' });
    const lastmods = Object.fromEntries(PATHS(5).map((p) => [`e.org${p}`, '2026-09-01']));
    const r = await s.next({ full: true, lastmods, fresh: (u) => (u.endsWith('/p3') ? audit(u, { 'color-contrast': 'fail' }) : audit(u)) });
    expect(r.state.lastmod.trust).toBe('ignored');
  });
});

describe('r1-2: what the HTML does not show', () => {
  it('r1-2a: Grok\'s cdn app.js: a cross-origin script that changes re-audits the pages that use it', async () => {
    const withApp = (js: string) => stable(4, Object.fromEntries([
      ...PATHS(4).map((p, i) => [p, { body: html(`Page ${i}`, '<script src="https://cdn.example/app.js"></script>'), etag: `"e${i}"` }]),
      ['https://cdn.example/app.js', { body: js, etag: `"${js.length}"` }],
    ]));
    const s = await setup({ paths: PATHS(4), site: withApp('/* v1 */'), previousSite: withApp('/* v1 */') });
    expect((await s.next()).decided).toEqual(['home', 'not-modified', 'not-modified', 'not-modified']);
    const r = await s.next({ site: withApp('document.body.append(Object.assign(document.createElement("img"),{src:"chart.png"}))') });
    expect(r.decided).toEqual(['home', 'asset-changed', 'asset-changed', 'asset-changed']);
    expect(r.calls.some((c) => c.url === 'https://cdn.example/app.js')).toBe(true);
  });

  it('r1-2a: a same-site @import target is part of its stylesheet', async () => {
    const site = (theme: string) => stable(3, { '/site.css': { body: '@import url("/theme.css");\nbody{color:#111}', etag: '"css1"' }, '/theme.css': { body: theme, etag: `"t${theme.length}"` } });
    const s = await setup({ paths: PATHS(3), site: site('a{outline:2px solid}'), previousSite: site('a{outline:2px solid}') });
    expect((await s.next()).decided).toEqual(['home', 'not-modified', 'not-modified']);
    expect((await s.next({ site: site('a{outline:none}') })).decided).toEqual(['home', 'asset-changed', 'asset-changed']);
  });

  it('r1-2b: a page whose rendered DOM differs materially from its HTML is client-rendered: always audited', async () => {
    const list = PATHS(4).map((p) => new URL(p, SITE).href);
    const first = await scanOnce({
      state: null, site: stable(4), list, audits: new Map(list.map((u) => [u, audit(u)])), startedAt: T0,
      // /p2's scripts build most of what people see (a list from a JSON API): 400 elements, not ~12.
      rendered: (u) => (u.endsWith('/p2') ? { text: 4000, elements: 400 } : undefined),
    });
    const r = await scanOnce({ state: first.state, site: stable(4), list, audits: first.audits, startedAt: T1 });
    expect(r.decided).toEqual(['home', 'not-modified', 'client-rendered', 'not-modified']);
  });
});

describe('r1-3: a shared stylesheet or script changed', () => {
  // Grok's /site.css: focus outlines dropped only on a long news article; the other pages look the same.
  const PATHS2 = ['/', '/news/short', '/staff/ada', '/news/long-article', '/news/other-story-here', '/staff/x1y2z3a4'];
  const siteV = (css: string): Site => ({
    '/site.css': { body: css, etag: `"${css}"` },
    ...Object.fromEntries(PATHS2.map((p, i) => [p, { body: html(`Page ${i}`), etag: `"e${i}"` }])),
  });
  const shapes = () => new Map(PATHS2.map((p) => {
    const u = new URL(p, SITE).href;
    return [u, audit(u, undefined, 'same')];
  }));

  it('r1-3: every page that uses it is audited, none carried on a sample\'s word', async () => {
    const s = await setup({ paths: PATHS2, site: siteV('a:focus{outline:none}'), previousSite: siteV('a:focus{outline:2px solid}'), previousAudits: shapes() });
    const r = await s.next({ fresh: (u) => (u.endsWith('/news/long-article') ? audit(u, { 'focus-visible': 'fail' }, 'same') : audit(u, undefined, 'same')) });
    expect(r.decided).toEqual(['home', 'asset-changed', 'asset-changed', 'asset-changed', 'asset-changed', 'asset-changed']);
    expect(r.out[3]!.rules).toEqual({ 'focus-visible': 'fail' });
  });

  it('pages that do not use the changed file are still carried', async () => {
    const site = (css: string): Site => ({ ...siteV(css), '/staff/ada': { body: html('Staff').replace('<link rel="stylesheet" href="/site.css">', ''), etag: '"ada"' } });
    const s = await setup({ paths: PATHS2, site: site('b{}'), previousSite: site('a{}'), previousAudits: shapes() });
    expect((await s.next()).decided[2]).toBe('not-modified');
  });
});

describe('r1-5: a stylesheet or script over 5 MB is unsure', () => {
  it('r1-5: its pages are audited every scan', async () => {
    const big = 'a{color:red}\n'.repeat(Math.ceil((5 * 1024 * 1024 + 10) / 13));
    const s = await setup({ paths: PATHS(3), site: stable(3, { '/site.css': { body: big, etag: '"big"' } }) });
    const r = await s.next({ site: stable(3, { '/site.css': { body: big, etag: '"big2"' } }) });
    expect(r.decided).toEqual(['home', 'unsure', 'unsure']);
  });
});

describe('r1-6: carried results from another engine, axe, scoring or normalisation version', () => {
  it('r1-6: any version difference makes the scan a full one (lastmod skips included)', async () => {
    const s = await setup({ paths: PATHS(4), site: stable(4), trust: 'trusted' });
    expect(s.previous.versions).toEqual({ engine: ENGINE_VERSION, axe: AXE_VERSION, scoring: SCORING_VERSION, normalize: NORMALIZE_VERSION });
    const lastmods = Object.fromEntries(PATHS(4).map((p) => [`e.org${p}`, '2026-09-01']));
    for (const k of ['engine', 'axe', 'scoring', 'normalize'] as const) {
      const r = await scanOnce({ state: { ...s.previous, versions: { ...s.previous.versions!, [k]: 'old' } }, site: stable(4), list: s.list, audits: s.first.audits, startedAt: T1, lastmods });
      expect(r.decided, k).toEqual(['full', 'full', 'full', 'full']);
    }
    const { versions: _v, ...legacy } = s.previous;
    expect((await scanOnce({ state: legacy, site: stable(4), list: s.list, audits: s.first.audits, startedAt: T1, lastmods })).decided).toEqual(['full', 'full', 'full', 'full']);
    expect(incrementalIsFull({ previous: legacy })).toBe(true);
  });
});

describe('r2-4: the stored hash is always the worker\'s own GET (supersedes r1-8a)', () => {
  it('r2-4: cost: every page that goes to the browser gets one plain GET first (a full cycle: one per page, none conditional)', async () => {
    const s = await setup({ paths: PATHS(5), site: stable(5) });
    expect(pagesFetched(s.first.calls).sort()).toEqual(['/', '/p1', '/p2', '/p3', '/p4']);
    const full = await s.next({ full: true });
    expect(pagesFetched(full.calls).sort()).toEqual(['/', '/p1', '/p2', '/p3', '/p4']);
    expect(full.calls.some((c) => c.headers['if-none-match'] || c.headers['if-modified-since'])).toBe(false);
    // Every worker GET sends the same headers: the user agent, Accept, Accept-Language, never a cookie.
    for (const c of full.calls) {
      expect(c.headers['user-agent']).toBe('ua');
      expect(c.headers['accept-language']).toBe(WORKER_ACCEPT_LANGUAGE);
      expect(c.headers.cookie).toBeUndefined();
    }
    // A non-full cycle: one GET per page (the homepage's plain, the others conditional).
    // (The homepage goes to the browser, so its GET is a plain one: its body is evidence.)
    expect(pagesFetched((await s.next()).calls).sort()).toEqual(['/', '/p1', '/p2', '/p3', '/p4']);
  });

  it('r2-4: Grok\'s /about: the browser gets another body (Accept-Language, a cookie) than the worker; it is not re-audited every cycle', async () => {
    const about: FakePage = { body: '', vary: (h) => html(h.cookie ? 'About us' : 'Über uns') };
    const site = stable(3, { '/p2': about });
    const list = PATHS(3).map((p) => new URL(p, SITE).href);
    const english = (u: string) => (u.endsWith('/p2') ? html('About us') : undefined);
    const s0 = await scanOnce({ state: null, site, list, audits: new Map(list.map((u) => [u, audit(u)])), startedAt: T0, browserHtml: english });
    const s1 = await scanOnce({ state: s0.state, site, list, audits: s0.audits, startedAt: T1, full: true, browserHtml: english });
    const s2 = await scanOnce({ state: s1.state, site, list, audits: s1.audits, startedAt: '2026-12-01T00:00:00.000Z', browserHtml: english });
    const s3 = await scanOnce({ state: s2.state, site, list, audits: s2.audits, startedAt: '2027-01-01T00:00:00.000Z', browserHtml: english });
    expect([s2.decided[2], s3.decided[2]]).toEqual(['same-html', 'same-html']);
  });
});

describe('r2-1: sticky stylesheet and script validators', () => {
  const siteWith = (css: string, etag = '"v1"') => stable(4, { '/site.css': { body: css, etag } });

  it('r2-1: Grok\'s /site.css with its ETag stuck at "v1": caught on the full cycle, never written back as the old fingerprint', async () => {
    const list = PATHS(4).map((p) => new URL(p, SITE).href);
    const s0 = await scanOnce({ state: null, site: siteWith('a:focus{outline:2px solid}'), list, audits: new Map(list.map((u) => [u, audit(u)])), startedAt: T0 });
    const oldFingerprint = s0.state.assets['https://e.org/site.css']!.v;
    // The file changes; the server keeps answering 304 to "v1": carried until the full cycle (accepted).
    const s1 = await scanOnce({ state: s0.state, site: siteWith('a:focus{outline:none}'), list, audits: s0.audits, startedAt: T1 });
    expect(s1.decided.slice(1)).toEqual(['not-modified', 'not-modified', 'not-modified']);
    // The full cycle reads every file with no conditional headers.
    const s2 = await scanOnce({ state: s1.state, site: siteWith('a:focus{outline:none}'), list, audits: s1.audits, startedAt: '2026-12-01T00:00:00.000Z', full: true });
    const cssReqs = s2.calls.filter((c) => c.url.endsWith('/site.css'));
    expect(cssReqs.length).toBe(1);
    expect(cssReqs[0]!.headers['if-none-match']).toBeUndefined();
    expect(s2.state.assets['https://e.org/site.css']!.v).not.toBe(oldFingerprint);
    // Its validators lied: conditional GETs stop for this monitor, files included.
    expect(s2.state.validators?.trust).toBe('ignored');
    const s3 = await scanOnce({ state: s2.state, site: siteWith('a:focus{outline:none}'), list, audits: s2.audits, startedAt: '2027-01-01T00:00:00.000Z' });
    expect(s3.calls.filter((c) => c.url.endsWith('/site.css')).every((c) => !c.headers['if-none-match'] && !c.headers['if-modified-since'])).toBe(true);
    expect(s3.decided.slice(1)).toEqual(['same-html', 'same-html', 'same-html']);
    // The next change, ETag still "v1", is caught at once.
    const s4 = await scanOnce({ state: s3.state, site: siteWith('a:focus{outline:1px dotted}'), list, audits: s3.audits, startedAt: '2027-02-01T00:00:00.000Z' });
    expect(s4.decided.slice(1)).toEqual(['asset-changed', 'asset-changed', 'asset-changed']);
  });

  it('r2-1: once the validators are ignored, file GETs are plain too', async () => {
    const s = await setup({ paths: PATHS(3), site: siteWith('a{}') });
    const r = await s.next({ state: { ...s.previous, validators: { trust: 'ignored' } } });
    const css = r.calls.filter((c) => c.url.endsWith('/site.css'));
    expect(css.length).toBe(1);
    expect(css[0]!.headers['if-none-match']).toBeUndefined();
    expect(css[0]!.headers['if-modified-since']).toBeUndefined();
  });
});

describe('r2-2: @import chains, the same at any concurrency', () => {
  // Grok: /news uses a.css → b.css → c.css → d.css; /staff links d.css directly, which imports theme.css.
  const files = (theme: string): Site => ({
    '/a.css': { body: '@import "/b.css";', etag: '"a"' }, '/b.css': { body: '@import "/c.css";', etag: '"b"' },
    '/c.css': { body: '@import "/d.css";', etag: '"c"' }, '/d.css': { body: '@import url(/theme.css);', etag: '"d"' },
    '/theme.css': { body: theme, etag: `"t-${theme.length}"` },
  });
  const site = (theme: string): Site => ({
    ...files(theme),
    '/': { body: html('Home').replace('/site.css', '/a.css'), etag: '"h"' },
    '/news/x': { body: html('News').replace('/site.css', '/a.css'), etag: '"n"' },
    '/staff/y': { body: html('Staff').replace('/site.css', '/d.css'), etag: '"s"' },
  });
  const list = ['/', '/news/x', '/staff/y'].map((p) => new URL(p, SITE).href);

  for (const parallel of [false, true]) {
    it(`r2-2: a theme change reaches /staff through d.css (${parallel ? 'every page at once' : 'one page at a time'})`, async () => {
      const audits = new Map(list.map((u) => [u, audit(u, undefined, 'same')]));
      const s0 = await scanOnce({ state: null, site: site('a{outline:2px solid}'), list, audits, startedAt: T0, parallel });
      const s1 = await scanOnce({ state: s0.state, site: site('a{outline:2px solid}'), list, audits: s0.audits, startedAt: T1, parallel });
      expect(s1.decided).toEqual(['home', 'not-modified', 'not-modified']);
      const s2 = await scanOnce({ state: s1.state, site: site('a{outline:none}'), list, audits: s1.audits, startedAt: '2026-12-01T00:00:00.000Z', parallel });
      expect(s2.decided).toEqual(['home', 'asset-changed', 'asset-changed']);
    });
  }
});

describe('r2-3: the browser\'s body is not needed for the evidence', () => {
  const paths = ['/', '/about', '/contact', '/privacy'];
  const lastmods = Object.fromEntries(paths.map((p) => [`e.org${p}`, '2020-01-01']));
  const list = paths.map((p) => new URL(p, SITE).href);
  const site = (privacy: string, extra: Partial<FakePage> = {}): Site => ({ '/site.css': { body: 'a{}', etag: '"c"' }, ...Object.fromEntries(paths.map((p) => [p, { body: html(p === '/privacy' ? privacy : p), etag: '"sticky"', ...(p === '/privacy' ? extra : {}) }])) });
  const trusted = async () => {
    const s0 = await scanOnce({ state: null, site: site('Privacy v1'), list, audits: new Map(list.map((u) => [u, audit(u)])), startedAt: '2026-08-01T00:00:00.000Z', lastmods });
    const s1 = await scanOnce({ state: s0.state, site: site('Privacy v1'), list, audits: s0.audits, startedAt: '2026-09-01T00:00:00.000Z', lastmods, full: true });
    expect(s1.state.lastmod.trust).toBe('trusted');
    return s1;
  };

  it('r2-3: response.text() throws on the full cycle (Grok\'s /privacy): the change is still caught from the worker\'s GET', async () => {
    const s1 = await trusted();
    const s2 = await scanOnce({ state: s1.state, site: site('Privacy v2'), list, audits: s1.audits, startedAt: '2026-10-01T00:00:00.000Z', lastmods, full: true, browserHtml: () => null });
    expect(s2.state.lastmod.trust).toBe('ignored');
  });

  it('r2-3: if the worker\'s GET fails too, the evidence is unknown: the sitemap is no longer trusted', async () => {
    const s1 = await trusted();
    const s2 = await scanOnce({ state: s1.state, site: site('Privacy v2', { throws: true }), list, audits: s1.audits, startedAt: '2026-10-01T00:00:00.000Z', lastmods, full: true, browserHtml: () => null });
    expect(s2.state.lastmod.trust).toBe('unproven');
  });
});

describe('r2-5: every response body is ended', () => {
  /** A response whose body records that it was cancelled. */
  const tracked = (status: number, headers: Record<string, string> = {}) => {
    const r = { status, headers: new Headers(headers), cancelled: false, body: null as unknown };
    r.body = { cancel: async () => { r.cancelled = true; }, getReader: () => { throw new Error('not read'); } };
    return r;
  };

  it('r2-5: a file\'s 304 and a refused answer are cancelled', async () => {
    const s = await setup({ paths: PATHS(3), site: stable(3) });
    const made: ReturnType<typeof tracked>[] = [];
    const fetchFn = (async (input: string | URL) => {
      const u = String(input);
      const r = u.endsWith('/site.css') ? tracked(304, { etag: '"css1"' }) : u.endsWith('/p2') ? tracked(429, { 'retry-after': '0' }) : tracked(304);
      made.push(r);
      return r as unknown as Response;
    }) as typeof fetch;
    const pace = createPace({ concurrency: 4, retries: 1, backoffMs: 1, maxWaitMs: 5 });
    const run = createIncrementalRun({ options: { previous: s.previous, carried: async (u) => s.first.audits.get(u) }, site: SITE, startedAt: T1, userAgent: 'ua', fetchFn, pace, lastmods: {}, list: () => s.list, known: () => undefined });
    for (const [i, u] of s.list.entries()) await run.decide(i, u);
    expect(made.length).toBeGreaterThan(3);
    expect(made.filter((r) => !r.cancelled).map((r) => r.status)).toEqual([]);
  });
});

describe('determinism', () => {
  it('the same site and the same previous state give the same decisions, in any page order', async () => {
    const site = { ...stable(10), '/p4': { body: html('Page 4 new'), etag: '"e4b"' } };
    const a = await setup({ paths: PATHS(10), site, previousSite: stable(10) });
    const first = (await a.next()).decided;
    const second = (await a.next({ parallel: true })).decided;
    expect(second).toEqual(first);
    expect(first[4]).toBe('changed');
  });
});

describe('politeness', () => {
  it('conditional requests are page loads for the Crawl-delay', async () => {
    const s = await setup({ paths: PATHS(4), site: stable(4) });
    const pace = createPace({ concurrency: 4 });
    pace.setCrawlDelay('e.org', 1);
    const t0 = Date.now();
    await s.next({ pace });
    // Three page requests (/p1-/p3), one second apart; the homepage goes straight to the browser.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
  }, 15_000);
});

describe('nextIncrementalState: the sitemap lastmod trust', () => {
  const rev = (r: Partial<PageRevision>): PageRevision => ({ decided: 'not-modified', carried: true, assets: [], since: T0, ...r });
  const pages = (revs: Partial<PageRevision>[]) => revs.map((r, i) => ({ ...audit(`https://e.org/p${i}`), revision: rev(r) }));
  const prev = (trust: 'unproven' | 'trusted' | 'ignored'): IncrementalPrevious => ({ startedAt: T0, pages: [], assets: {}, lastmod: { trust } });
  const scan = { startedAt: T1, full: false };

  it('is proven by one scan where every lastmod agreed with a real body', () => {
    const p = pages([{ lastmod: '2026-09-01', lastmodSaid: 'unchanged', htmlSaid: 'unchanged' }, { lastmod: '2026-10-20', lastmodSaid: 'changed', htmlSaid: 'changed' }, { lastmod: '2026-09-02', lastmodSaid: 'unchanged', htmlSaid: 'unchanged' }]);
    expect(nextIncrementalState(prev('unproven'), p, scan).lastmod.trust).toBe('trusted');
  });
  it('is ignored for good once a lastmod said unchanged and the page had changed', () => {
    const p = pages([{ lastmod: '2026-09-01', lastmodSaid: 'unchanged', htmlSaid: 'changed' }, { lastmod: '2026-09-02', lastmodSaid: 'unchanged', htmlSaid: 'unchanged' }, { lastmod: '2026-09-02', lastmodSaid: 'unchanged', htmlSaid: 'unchanged' }]);
    expect(nextIncrementalState(prev('trusted'), p, scan).lastmod).toMatchObject({ trust: 'ignored' });
    expect(nextIncrementalState(prev('ignored'), pages([{ lastmod: '2026-09-01', lastmodSaid: 'unchanged', htmlSaid: 'unchanged' }]), scan).lastmod.trust).toBe('ignored');
  });
  it('is ignored when the sitemap stamps every page "now" (they say changed, the pages did not)', () => {
    const p = pages(Array.from({ length: 6 }, () => ({ lastmod: '2026-11-01T00:00:00Z', lastmodSaid: 'changed' as const, htmlSaid: 'unchanged' as const })));
    expect(nextIncrementalState(prev('unproven'), p, scan).lastmod).toMatchObject({ trust: 'ignored' });
  });
  it('stays unproven with too little evidence', () => {
    expect(nextIncrementalState(prev('unproven'), pages([{ lastmod: '2026-09-01', lastmodSaid: 'unchanged', htmlSaid: 'unchanged' }]), scan).lastmod.trust).toBe('unproven');
  });
  it('drops failed pages from the state (they are audited next time)', () => {
    const p = [{ ...audit('https://e.org/a'), status: 'failed' as const, revision: rev({ decided: 'changed', carried: false }) }];
    expect(nextIncrementalState(null, p, scan).pages).toEqual([]);
  });
  it('one date-time on every page is a generated stamp: ignored; one date alone is plausible', () => {
    const same = (lastmod: string) => Array.from({ length: 6 }, (_, i) => ({ ...audit(`https://e.org/p${i}`), revision: rev({ decided: 'new', carried: false, lastmod }) }));
    expect(nextIncrementalState(null, same('2026-11-01T03:00:00Z'), { startedAt: T1, full: true }).lastmod.trust).toBe('ignored');
    expect(nextIncrementalState(null, same('2026-09-15'), { startedAt: T1, full: true }).lastmod.trust).toBe('unproven');
  });
});

describe('incrementalSummary and findingsKey', () => {
  it('counts pages re-checked and unchanged, by layer', () => {
    const r = (decided: PageRevision['decided'], carried: boolean) => ({ ...audit('https://e.org/x'), revision: { decided, carried, assets: [], since: '' } });
    expect(incrementalSummary([r('home', false), r('lastmod', true), r('not-modified', true), r('not-modified', true), r('same-html', true), r('asset-changed', false), r('changed', false)], false)).toEqual({
      full: false, pages: 7, checked: 3, unchanged: 4, skipped: { lastmod: 1, notModified: 2, sameHtml: 1 },
    });
  });
  it('findingsKey ignores what storage trims (element snippets) and sees outcomes and targets', () => {
    const a = audit('https://e.org/a', { 'color-contrast': 'fail' });
    expect(findingsKey(a)).toBe(findingsKey({ ...a, violations: a.violations.map((v) => ({ ...v, nodes: v.nodes.map((n) => ({ ...n, html: '' })) })) }));
    expect(findingsKey(a)).not.toBe(findingsKey(audit('https://e.org/a', { 'color-contrast': 'pass' })));
  });
});
