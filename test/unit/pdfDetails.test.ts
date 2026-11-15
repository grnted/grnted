// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The document pipeline's side of the AI document review: checkPdfDetailed (figures, headings,
// fields, dates), the Last-Modified header on downloads, and the inventory's onDocument hook.
import { describe, expect, it } from 'vitest';
import { createDocumentInventory } from '../../src/documents/index.js';
import { downloadPdf, type RequestContext } from '../../src/documents/fetch.js';
import { PDF_DETAIL_LIMITS, checkPdf, checkPdfDetailed, parsePdfDate } from '../../src/documents/pdf.js';
import type { DocumentCheck, PageAudit, PdfDetails } from '../../src/types.js';
import { fakeFetch } from '../helpers/fakeFetch.js';
import { formPdf, structuredPdf, untaggedPdf, type TaggedElement } from '../helpers/pdfs.js';

/** pdf-lib's bytes typed as a fetch body. */
const body = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

const guide = () => structuredPdf({
  title: 'Family guide', lang: 'en-US', modified: new Date('2026-10-01T12:00:00Z'),
  pages: [
    [{ tag: 'H1', text: 'Family guide' }, { tag: 'P', text: 'Read this first.' }, { tag: 'Figure', alt: 'School logo' }, { tag: 'P', text: 'How to apply', size: 18 }],
    [{ tag: 'H2', text: 'Contacts' }, { tag: 'Figure' }, { tag: 'Figure', alt: '  ' }, { tag: 'P', text: 'Call the office.' }],
  ],
});

describe('checkPdfDetailed', () => {
  it('lists tagged figures (page, order, alt) and headings (tag, text) in tag order, plus title, language and dates', async () => {
    const bytes = await guide();
    const { checks, details } = await checkPdfDetailed(bytes);
    expect(details).toEqual({
      title: 'Family guide',
      lang: 'en-US',
      modified: '2026-10-01T12:00:00.000Z',
      pagesRead: 2,
      figures: [{ page: 1, orderOnPage: 1, alt: 'School logo' }, { page: 2, orderOnPage: 1 }, { page: 2, orderOnPage: 2 }],
      headings: [{ page: 1, tag: 'H1', text: 'Family guide' }, { page: 2, tag: 'H2', text: 'Contacts' }],
      fields: [],
      totals: { figures: 3, headings: 2, fields: 0 },
    } satisfies PdfDetails);
    // Same checks as checkPdf, and the caller's bytes stay usable.
    expect(checks).toEqual(await checkPdf(bytes));
    expect(checks).toMatchObject({ tagged: true, figuresWithoutAlt: 2 });
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
  });

  it('lists form fields once each with their tooltip and type', async () => {
    const { details } = await checkPdfDetailed(await formPdf());
    expect(details.fields).toEqual([
      { page: 1, name: 'student', tooltip: 'Student name', type: 'text' },
      { page: 1, name: 'grade', tooltip: '', type: 'text' },
      { page: 1, name: 'phone', tooltip: '', type: 'text' },
    ]);
    expect(details.totals.fields).toBe(3);
  });

  it('caps the lists but counts everything on the pages read', async () => {
    const many = (n: number, el: (i: number) => TaggedElement) => Array.from({ length: n }, (_, i) => el(i));
    const { details } = await checkPdfDetailed(await structuredPdf({
      pages: [many(45, () => ({ tag: 'Figure', alt: 'x' })), many(35, (i) => ({ tag: 'H2', text: `A${i}`, size: 4 })), many(35, (i) => ({ tag: 'H3', text: `B${i}`, size: 4 }))],
    }));
    expect(details.figures).toHaveLength(PDF_DETAIL_LIMITS.figures);
    expect(details.headings).toHaveLength(PDF_DETAIL_LIMITS.headings);
    expect(details.totals).toEqual({ figures: 45, headings: 70, fields: 0 });
    expect(details.headings.at(-1)).toEqual({ page: 3, tag: 'H3', text: 'B24' });
    expect(details).not.toHaveProperty('title');
    expect(details).not.toHaveProperty('modified');
  });

  it('reads structure for up to 30 pages while the quick checks still stop at maxPages', async () => {
    const { checks, details } = await checkPdfDetailed(await untaggedPdf(32), { maxPages: 20, timeoutMs: 10_000 });
    expect(checks).toMatchObject({ pages: 32, pagesChecked: 20, tagged: false });
    expect(details.pagesRead).toBe(30);
    expect(details.figures).toEqual([]);
  });
});

describe('parsePdfDate', () => {
  it('reads PDF dates with and without a time zone, and rejects anything else', () => {
    expect(parsePdfDate('D:20260901100000Z')).toBe('2026-09-01T10:00:00.000Z');
    expect(parsePdfDate("D:20240115103000-05'00'")).toBe('2024-01-15T15:30:00.000Z');
    expect(parsePdfDate("D:20240115103000+01'30")).toBe('2024-01-15T09:00:00.000Z');
    expect(parsePdfDate('D:2024')).toBe('2024-01-01T00:00:00.000Z');
    expect(parsePdfDate('20240115')).toBe('2024-01-15T00:00:00.000Z');
    expect(parsePdfDate('yesterday')).toBeUndefined();
    expect(parsePdfDate('D:20241345')).toBeUndefined();
    expect(parsePdfDate(undefined)).toBeUndefined();
  });
});

describe('downloadPdf', () => {
  const ctx = (fetchFn: typeof fetch): RequestContext => ({ fetchFn, userAgent: 'UA', timeoutMs: 5000, maxRedirects: 2 });
  it('keeps a valid Last-Modified header as an ISO date', async () => {
    const pdf = await untaggedPdf();
    const dated = fakeFetch(() => new Response(body(pdf), { headers: { 'content-type': 'application/pdf', 'last-modified': 'Tue, 15 Sep 2026 08:00:00 GMT' } }));
    expect(await downloadPdf('https://e.org/a.pdf', ctx(dated.fn), 1e6)).toMatchObject({ lastModified: '2026-09-15T08:00:00.000Z' });
    const bad = fakeFetch(() => new Response(body(pdf), { headers: { 'content-type': 'application/pdf', 'last-modified': 'soon' } }));
    expect(await downloadPdf('https://e.org/a.pdf', ctx(bad.fn), 1e6)).not.toHaveProperty('lastModified');
  });
});

describe('document inventory: onDocument', () => {
  const SITE = 'https://e.org/';
  const page = (hrefs: string[]): PageAudit => ({
    url: SITE, status: 'ok', rules: {}, violations: [], incomplete: [], links: hrefs.map((h) => new URL(h, SITE).href),
    collected: { documentLinks: hrefs.map((h) => ({ href: new URL(h, SITE).href, text: '' })) },
  });

  it('hands over each checked PDF once, with its bytes and details, and never the failed ones', async () => {
    const [pdf, tagged] = [await untaggedPdf(), await guide()];
    const f = fakeFetch(({ url }) => {
      const path = new URL(url).pathname;
      if (path === '/guide.pdf') return new Response(body(tagged), { headers: { 'content-type': 'application/pdf', 'last-modified': 'Tue, 15 Sep 2026 08:00:00 GMT' } });
      if (path === '/broken.pdf') return new Response('%PDF-1.4\n%%EOF\n', { headers: { 'content-type': 'application/pdf' } });
      if (path === '/gone.pdf') return new Response('', { status: 404 });
      return new Response(body(pdf), { headers: { 'content-type': 'application/pdf' } });
    });
    const got: { doc: DocumentCheck; size: number; details: PdfDetails }[] = [];
    const inv = createDocumentInventory({
      site: SITE, userAgent: 'UA', fetchFn: f.fn,
      onDocument: (doc, bytes, details) => got.push({ doc, size: bytes.length, details }),
    });
    inv.addPage(0, page(['/a.pdf', '/guide.pdf', '/broken.pdf', '/gone.pdf', '/a.pdf', '/notes.docx']));
    const r = await inv.finish();
    expect(got.map((g) => new URL(g.doc.url).pathname).sort()).toEqual(['/a.pdf', '/guide.pdf']);
    const g = got.find((x) => x.doc.url.endsWith('/guide.pdf'))!;
    // The snapshot handed to the AI plan carries the link's words (document@3, AI only); the report's check never does.
    const { linkText: _linkText, linkNearby: _linkNearby, ...asReported } = g.doc as typeof g.doc & { linkText?: string; linkNearby?: string };
    expect(asReported).toEqual(r.checks.find((c) => c.url === g.doc.url));
    expect(typeof (g.doc as { linkText?: unknown }).linkText).toBe('string');
    expect(g.size).toBe(tagged.length);
    expect(g.details).toMatchObject({ title: 'Family guide', modified: '2026-10-01T12:00:00.000Z', lastModified: '2026-09-15T08:00:00.000Z' });
    expect(g.details.figures).toHaveLength(3);
    expect(got.find((x) => x.doc.url.endsWith('/a.pdf'))!.details).not.toHaveProperty('lastModified');
  });

  it('a hook that throws changes nothing, and without a hook the checks are the same', async () => {
    const pdf = await guide();
    const serve = () => fakeFetch(() => new Response(body(pdf), { headers: { 'content-type': 'application/pdf' } })).fn;
    const plain = createDocumentInventory({ site: SITE, userAgent: 'UA', fetchFn: serve() });
    const hooked = createDocumentInventory({ site: SITE, userAgent: 'UA', fetchFn: serve(), onDocument: () => { throw new Error('bug'); } });
    for (const inv of [plain, hooked]) inv.addPage(0, page(['/a.pdf', '/b.pdf']));
    const [a, b] = await Promise.all([plain.finish(), hooked.finish()]);
    expect(b).toEqual(a);
    expect(a.checks.every((c) => c.checks?.tagged)).toBe(true);
  });

  it('is not called when document checks are off', async () => {
    let calls = 0;
    const f = fakeFetch(() => new Response(''));
    const inv = createDocumentInventory({ site: SITE, userAgent: 'UA', fetchFn: f.fn, documents: false, onDocument: () => { calls++; } });
    inv.addPage(0, page(['/a.pdf']));
    await inv.finish();
    expect(calls).toBe(0);
    expect(f.calls).toEqual([]);
  });
});
