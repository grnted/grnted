// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { beforeAll, describe, expect, it } from 'vitest';
import { createDocumentInventory, type InventoryOptions } from '../../src/documents/index.js';
import { selectPages } from '../../src/select.js';
import { ACTION_SKIP_REASON } from '../../src/url.js';
import type { DocumentLink, PageAudit } from '../../src/types.js';
import { fakeFetch, type Handler } from '../helpers/fakeFetch.js';
import { untaggedPdf } from '../helpers/pdfs.js';

const SITE = 'https://e.org/';
let PDF: Uint8Array<ArrayBuffer>;
beforeAll(async () => { PDF = (await untaggedPdf()) as Uint8Array<ArrayBuffer>; });

const page = (url: string, links: (DocumentLink | string)[], over: Partial<PageAudit> = {}): PageAudit => {
  const list = links.map((l) => (typeof l === 'string' ? { href: new URL(l, url).href, text: '' } : { ...l, href: new URL(l.href, url).href }));
  return { url, status: 'ok', rules: {}, violations: [], incomplete: [], links: list.map((l) => l.href), collected: { documentLinks: list }, ...over };
};

const pdfResponse = (method: string) => new Response(method === 'HEAD' ? null : PDF, { headers: { 'content-type': 'application/pdf' } });
const htmlResponse = () => new Response('<!doctype html><title>Page</title>', { headers: { 'content-type': 'text/html' } });

/** Serves a PDF for paths matching `pdf`, HTML for everything else. */
const site = (pdf: RegExp = /\.pdf$|\/download\//): Handler => ({ url, method }) => (pdf.test(new URL(url).pathname) ? pdfResponse(method) : htmlResponse());

function inventory(handler: Handler, over: Partial<InventoryOptions> = {}) {
  const f = fakeFetch(handler);
  return { inv: createDocumentInventory({ site: SITE, userAgent: 'UA', fetchFn: f.fn, ...over }), calls: f.calls };
}

describe('document inventory', () => {
  it('lists documents by every rule, probes only same-site "maybe" links, and checks PDFs', async () => {
    const { inv, calls } = inventory(site());
    inv.addPage(0, page(SITE, [
      '/board.pdf',
      { href: '/download/0a1b', text: 'Download original document — English' },
      { href: '/download/app', text: 'Download our app' },
      { href: 'https://cdn.other.org/download/zz', text: 'Download' },
      '/minutes.docx',
      { href: 'https://docs.google.com/document/d/abc/edit', text: 'Shared plan' },
      '/about',
    ]));
    const r = await inv.finish();
    // In this double every /download/ path answers with a PDF, so /download/app is one too.
    expect(r.documents).toEqual([
      'https://docs.google.com/document/d/abc/edit', 'https://e.org/board.pdf', 'https://e.org/download/0a1b', 'https://e.org/download/app', 'https://e.org/minutes.docx',
    ]);
    const byUrl = Object.fromEntries(r.checks.map((c) => [new URL(c.url).pathname, c]));
    expect(byUrl['/board.pdf']).toMatchObject({ type: 'pdf', detectedBy: 'extension', linkedFrom: [SITE], checks: { tagged: false } });
    expect(byUrl['/download/0a1b']).toMatchObject({ type: 'pdf', detectedBy: 'probe', checks: { hasTitle: false } });
    // Office files are downloaded and checked too (here the double answers with a web page).
    expect(byUrl['/minutes.docx']).toMatchObject({ type: 'word', error: 'The link opens a web page, not a Word file (it may need a sign-in)' });
    expect(byUrl['/document/d/abc/edit']).toMatchObject({ type: 'word', detectedBy: 'host', notChecked: 'Kept on a document service, so it was not downloaded' });
    expect(calls.some((c) => c.url.includes('other.org') || c.url.includes('google'))).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/about'))).toBe(false);
    expect(calls.filter((c) => c.method === 'HEAD').map((c) => new URL(c.url).pathname).sort()).toEqual(['/download/0a1b', '/download/app']);
    expect(r.stats).toEqual({ probes: 2, pdfsChecked: 3, officeChecked: 0 });
  });

  it('a probe that finds a web page drops the link; a text-only "PDF" guess that is a web page is dropped too', async () => {
    const { inv } = inventory(site(/\.pdf$/));
    inv.addPage(0, page(SITE, [
      { href: '/download/app', text: 'Download our app' },
      { href: '/docs/pdf-help', text: 'How to open a PDF' },
    ]));
    const r = await inv.finish();
    expect(r.documents).toEqual([]);
  });

  it('respects robots.txt and allowUrl', async () => {
    const { inv, calls } = inventory(site(), {
      isAllowed: (u) => !new URL(u).pathname.startsWith('/private/'),
      allowUrl: async (u) => !u.includes('/blocked/'),
    });
    inv.addPage(0, page(SITE, ['/private/a.pdf', { href: '/private/download/x', text: 'Download' }, '/blocked/b.pdf', { href: '/blocked/download/y', text: 'Download' }]));
    const r = await inv.finish();
    expect(calls.some((c) => c.url.includes('/private/'))).toBe(false);
    expect(r.checks.map((c) => [new URL(c.url).pathname, c.notChecked ?? c.error])).toEqual([
      ['/blocked/b.pdf', 'The address is not allowed'],
      ['/private/a.pdf', 'Blocked by robots.txt'],
    ]);
  });

  it('caps probes at 60 and PDF checks at 10 per scan, in link order', async () => {
    const { inv, calls } = inventory(site());
    inv.addPage(0, page(SITE, Array.from({ length: 70 }, (_, i) => ({ href: `/download/${String(i).padStart(2, '0')}`, text: 'Download' }))));
    const r = await inv.finish();
    expect(calls.filter((c) => c.method === 'HEAD')).toHaveLength(60);
    expect(r.documents).toHaveLength(60);
    const checked = r.checks.filter((c) => c.checks).map((c) => new URL(c.url).pathname);
    expect(checked).toEqual(Array.from({ length: 10 }, (_, i) => `/download/0${i}`));
    expect(r.checks.filter((c) => c.notChecked === 'Limit reached (10 PDFs per scan)')).toHaveLength(50);
    expect(calls.filter((c) => c.method === 'GET' && !c.headers.range)).toHaveLength(10);
  });

  it('sends at most 2 requests at once to one host', async () => {
    let active = 0;
    let peak = 0;
    const { inv } = inventory(async (req) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 3));
      active--;
      return site()(req);
    });
    inv.addPage(0, page(SITE, [...Array.from({ length: 8 }, (_, i) => ({ href: `/download/${i}`, text: 'Download' })), '/a.pdf', '/b.pdf']));
    await inv.finish();
    expect(peak).toBe(2);
  });

  it('gives the same result whatever order the pages finish in', async () => {
    const pages = [
      page(SITE, ['/one.pdf', { href: '/download/1', text: 'Download' }]),
      page('https://e.org/b', ['/two.pdf', '/one.pdf']),
      page('https://e.org/c', [{ href: '/download/3', text: 'Download' }, '/two.pdf']),
    ];
    const run = async (order: number[]) => {
      const { inv } = inventory(site(), { documents: { maxPdfs: 2 } });
      for (const i of order) inv.addPage(i, pages[i]!);
      return inv.finish();
    };
    const a = await run([0, 1, 2]);
    const b = await run([2, 0, 1]);
    expect(b).toEqual(a);
    expect(a.checks.find((c) => c.url.endsWith('/one.pdf'))!.linkedFrom).toEqual([SITE, 'https://e.org/b']);
    expect(a.checks.filter((c) => c.checks).map((c) => new URL(c.url).pathname)).toEqual(['/download/1', '/one.pdf']);
  });

  it('moves a selected page that is really a document out of the pages', async () => {
    const { inv, calls } = inventory(({ url, method }) => {
      const path = new URL(url).pathname;
      if (path === '/download/abc') return pdfResponse(method);
      if (path === '/slow') return htmlResponse();
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'content-type': 'image/png' } });
    });
    inv.addPage(0, page(SITE, []));
    inv.addPage(1, page('https://e.org/download/abc', [], { status: 'failed', reason: 'Not an HTML page', links: [], collected: undefined }));
    inv.addPage(2, page('https://e.org/slow', [], { status: 'failed', reason: 'Timeout 45000ms exceeded.', links: [], collected: undefined }));
    inv.addPage(3, page('https://e.org/logo', [], { status: 'failed', reason: 'Not an HTML page', links: [], collected: undefined }));
    inv.addPage(4, page('https://e.org/gone', [], { status: 'failed', reason: 'HTTP 404', httpStatus: 404, links: [], collected: undefined }));
    const r = await inv.finish();
    expect(r.notPages).toEqual([
      { url: 'https://e.org/download/abc', reason: 'Not a web page: a PDF file, listed under Documents' },
      { url: 'https://e.org/logo', reason: 'Not a web page' },
    ]);
    expect(r.checks).toEqual([expect.objectContaining({ url: 'https://e.org/download/abc', type: 'pdf', detectedBy: 'probe', linkedFrom: [], checks: expect.objectContaining({ tagged: false }) })]);
    expect(calls.some((c) => c.url.endsWith('/gone'))).toBe(false);
    // Page probes double-check an HTML answer to HEAD.
    expect(calls.filter((c) => c.url.endsWith('/slow')).map((c) => c.method)).toEqual(['HEAD', 'GET']);
  });

  it('with documents: false, lists what links show; only a failed page is still asked about', async () => {
    const { inv, calls } = inventory(site(), { documents: false });
    inv.addPage(0, page(SITE, ['/a.pdf', { href: '/download/x', text: 'Download' }]));
    inv.addPage(1, page('https://e.org/download/y', [], { status: 'failed', reason: 'Not an HTML page', collected: undefined, links: [] }));
    const r = await inv.finish();
    expect(calls.map((c) => [c.method, c.url])).toEqual([['HEAD', 'https://e.org/download/y']]);
    expect(r.checks.map((c) => [c.url, c.detectedBy, c.notChecked])).toEqual([
      ['https://e.org/a.pdf', 'extension', 'Document checks were turned off for this scan'],
      ['https://e.org/download/y', 'probe', 'Document checks were turned off for this scan'],
    ]);
    expect(r.notPages).toEqual([{ url: 'https://e.org/download/y', reason: 'Not a web page: a PDF file, listed under Documents' }]);
  });

  it('gives sitemap documents the check slots left after linked ones', async () => {
    const { inv } = inventory(site(), { documents: { maxPdfs: 1 } });
    inv.addPage(0, page(SITE, ['/linked.pdf']));
    const r = await inv.finish({ documents: ['https://e.org/from-sitemap.pdf', 'https://e.org/linked.pdf'] });
    expect(r.checks.map((c) => [new URL(c.url).pathname, c.linkedFrom.length, Boolean(c.checks), c.notChecked])).toEqual([
      ['/from-sitemap.pdf', 0, false, 'Limit reached (1 PDFs per scan)'],
      ['/linked.pdf', 1, true, undefined],
    ]);
  });

  it('stops slow document work at the time limit', async () => {
    const { inv } = inventory(({ url }) => (url.endsWith('/slow.pdf') ? new Promise<Response>(() => {}) : site()({ url, method: 'GET', headers: {} })), {
      documents: { tailMs: 50 },
    });
    // One PDF at a time: the PDF after a download that never ends waits for it, and the time limit ends both.
    inv.addPage(0, page(SITE, ['/fine.pdf', '/slow.pdf', '/after.pdf']));
    const started = Date.now();
    const r = await inv.finish();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.checks.map((c) => [new URL(c.url).pathname, c.notChecked ?? (c.checks ? 'checked' : c.error)])).toEqual([
      ['/after.pdf', 'Time limit reached'],
      ['/fine.pdf', 'checked'],
      ['/slow.pdf', 'Time limit reached'],
    ]);
  });

  it('falls back to plain links when the collector failed, and never throws', async () => {
    const { inv } = inventory(site());
    inv.addPage(0, { ...page(SITE, ['/a.pdf']), collected: { documentLinks: { error: 'Collector timed out after 3000 ms' } } });
    inv.addPage(1, { url: 'not a url', status: 'ok', rules: {}, violations: [], incomplete: [], links: ['::::'] });
    const r = await inv.finish();
    expect(r.documents).toEqual(['https://e.org/a.pdf']);
  });
});

// Round-2 review of the coverage lane (2026-11-10, finding 1; the lead's decision): the action-URL filter comes
// BEFORE an address is accepted as a document. The reviewer's input: `/delete/report.pdf?token=abc` was put in the
// selection's documents with no skip recorded, and the inventory then sent a GET for it.
describe('a document address that looks like an action is never requested', () => {
  const ACTION = `${SITE}delete/report.pdf?token=abc`;

  it('from the selection: it is not a document of the scan, the skip is recorded, and no request is sent', async () => {
    const selection = selectPages(SITE, [ACTION, `${SITE}docs/report.pdf`, `${SITE}about`], 25);
    expect(selection.documents).toEqual([`${SITE}docs/report.pdf`]);
    expect(selection.skipped).toEqual([{ url: ACTION, reason: ACTION_SKIP_REASON }]);
    const { inv, calls } = inventory(site());
    const r = await inv.finish({ documents: selection.documents });
    expect(calls.filter((c) => c.url.includes('/delete/'))).toEqual([]);
    // Look-alike: the ordinary PDF beside it is downloaded and checked.
    expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/docs/report.pdf'))).toBe(true);
    expect(r.checks.map((c) => [new URL(c.url).pathname, !!c.checks])).toEqual([['/docs/report.pdf', true]]);
  });

  it('handed to the inventory all the same (a host\'s own list): listed, not downloaded, and it says why', async () => {
    const { inv, calls } = inventory(site());
    const r = await inv.finish({ documents: [ACTION, `${SITE}docs/report.pdf`] });
    expect(calls.filter((c) => c.url.includes('/delete/'))).toEqual([]);
    const byPath = Object.fromEntries(r.checks.map((c) => [new URL(c.url).pathname, c]));
    expect(byPath['/delete/report.pdf']).toMatchObject({ type: 'pdf', notChecked: ACTION_SKIP_REASON });
    expect(byPath['/delete/report.pdf']!.checks).toBeUndefined();
    expect(byPath['/docs/report.pdf']!.checks).toBeDefined();
  });

  it('linked from a page: by its extension, as an Office file, or as a link that only might be a document, never a request', async () => {
    const { inv, calls } = inventory(site());
    inv.addPage(0, page(SITE, [
      '/delete/report.pdf?token=abc',
      '/account/remove/minutes.docx',
      // A link the inventory would ask the server about (its text says PDF): the question itself is a request.
      { href: '/unsubscribe?token=abc', text: 'Newsletter archive (PDF)' },
      { href: '/download/logout', text: 'Download original document' },
      // Look-alikes: documents whose addresses only hold such a word, and an ordinary download.
      '/news/vote-by-mail-guide.pdf',
      '/forms/cancellation-request.pdf',
      { href: '/download/0a1b', text: 'Download original document' },
    ]));
    const r = await inv.finish();
    const asked = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(asked.filter((a) => /delete|remove|unsubscribe|logout/.test(a))).toEqual([]);
    expect(asked).toEqual(expect.arrayContaining(['GET /news/vote-by-mail-guide.pdf', 'GET /forms/cancellation-request.pdf', 'HEAD /download/0a1b']));
    const byPath = Object.fromEntries(r.checks.map((c) => [new URL(c.url).pathname, c]));
    expect(byPath['/delete/report.pdf']).toMatchObject({ notChecked: ACTION_SKIP_REASON, linkedFrom: [SITE] });
    expect(byPath['/account/remove/minutes.docx']).toMatchObject({ type: 'word', notChecked: ACTION_SKIP_REASON });
    // Never asked, so never known to be documents: not listed.
    expect(byPath['/unsubscribe']).toBeUndefined();
    expect(byPath['/download/logout']).toBeUndefined();
    expect(byPath['/news/vote-by-mail-guide.pdf']!.checks).toBeDefined();
    // The snapshot (a scan past its time) says the same without waiting.
    const again = inventory(site());
    again.inv.addPage(0, page(SITE, ['/delete/report.pdf?token=abc']));
    expect(again.inv.snapshot().checks.map((c) => c.notChecked)).toEqual([ACTION_SKIP_REASON]);
    expect(again.calls).toEqual([]);
  });
});
