// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { beforeAll, describe, expect, it } from 'vitest';
import { createDocumentInventory, mergeInventory, type DocumentStore, type InventoryOptions, type StoredPdf } from '../../src/documents/index.js';
import { createPace } from '../../src/pace.js';
import type { DocumentLink, PageAudit } from '../../src/types.js';
import { fakeFetch, type Handler } from '../helpers/fakeFetch.js';
import { brokenDocx, brokenPptx, cleanXlsx, encryptedOffice, legacyDoc } from '../helpers/office.js';
import { untaggedPdf } from '../helpers/pdfs.js';

const SITE = 'https://e.org/';
let PDF: Uint8Array<ArrayBuffer>;
beforeAll(async () => { PDF = (await untaggedPdf()) as Uint8Array<ArrayBuffer>; });

const page = (url: string, links: (DocumentLink | string)[]): PageAudit => {
  const list = links.map((l) => (typeof l === 'string' ? { href: new URL(l, url).href, text: '' } : { ...l, href: new URL(l.href, url).href }));
  return { url, status: 'ok', rules: {}, violations: [], incomplete: [], links: list.map((l) => l.href), collected: { documentLinks: list } };
};

const FILES: Record<string, () => Uint8Array> = {
  '/minutes.docx': brokenDocx, '/deck.pptx': brokenPptx, '/budget.xlsx': cleanXlsx, '/locked.xlsx': encryptedOffice, '/download/old': legacyDoc,
};
const body = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;
const site: Handler = ({ url, method }) => {
  const path = new URL(url).pathname;
  if (path.endsWith('.pdf')) return new Response(method === 'HEAD' ? null : PDF, { headers: { 'content-type': 'application/pdf' } });
  const make = FILES[path];
  if (make) return new Response(method === 'HEAD' ? null : body(make()), { headers: { 'content-type': path === '/download/old' ? 'application/msword' : 'application/octet-stream' } });
  return new Response('<!doctype html><title>Page</title>', { headers: { 'content-type': 'text/html' } });
};

function inventory(over: Partial<InventoryOptions> = {}, handler: Handler = site) {
  const f = fakeFetch(handler);
  return { inv: createDocumentInventory({ site: SITE, userAgent: 'UA', fetchFn: f.fn, ...over }), calls: f.calls };
}
const byPath = <T extends { url: string }>(checks: T[]): Record<string, T> => Object.fromEntries(checks.map((c) => [new URL(c.url).pathname, c]));

describe('document inventory: Office files', () => {
  it('downloads and checks .docx, .xlsx and .pptx; legacy and OpenDocument files are listed without a download', async () => {
    const { inv, calls } = inventory();
    inv.addPage(0, page(SITE, ['/minutes.docx', '/deck.pptx', '/budget.xlsx', '/locked.xlsx', '/agenda.doc', '/rates.xls', '/talk.ppt', '/notes.odt', '/board.pdf']));
    const r = await inv.finish();
    const d = byPath(r.checks);
    expect(d['/minutes.docx']).toMatchObject({ type: 'word', officeChecks: { format: 'docx', hasTitle: false, imagesWithoutAlt: 2 } });
    expect(d['/deck.pptx']).toMatchObject({ type: 'powerpoint', officeChecks: { format: 'pptx', slidesWithoutTitle: 2 } });
    expect(d['/budget.xlsx']).toMatchObject({ type: 'excel', officeChecks: { format: 'xlsx', defaultSheetNames: 0 } });
    expect(d['/locked.xlsx']).toMatchObject({ officeChecks: { format: 'xlsx', passwordToOpen: true } });
    expect(d['/agenda.doc']).toMatchObject({ notChecked: 'Legacy binary format (.doc); save it as .docx to have it checked' });
    expect(d['/rates.xls']).toMatchObject({ notChecked: 'Legacy binary format (.xls); save it as .xlsx to have it checked' });
    expect(d['/talk.ppt']).toMatchObject({ notChecked: 'Legacy binary format (.ppt); save it as .pptx to have it checked' });
    expect(d['/notes.odt']).toMatchObject({ notChecked: 'Only PDF, Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) files are checked' });
    // An Office file never takes the place of a PDF, and the PDF keeps its own checks.
    expect(d['/board.pdf']).toMatchObject({ checks: { tagged: false } });
    for (const p of ['/minutes.docx', '/deck.pptx', '/budget.xlsx', '/locked.xlsx']) expect(d[p]).not.toHaveProperty('checks');
    const got = calls.map((c) => new URL(c.url).pathname);
    for (const p of ['/agenda.doc', '/rates.xls', '/talk.ppt', '/notes.odt']) expect(got).not.toContain(p);
    expect(r.stats).toMatchObject({ pdfsChecked: 1, officeChecked: 4 });
  });

  it('an extensionless legacy file is downloaded once, then listed as legacy', async () => {
    const { inv } = inventory();
    inv.addPage(0, page(SITE, [{ href: '/download/old', text: 'Download the agenda (Word)' }]));
    const r = await inv.finish();
    expect(byPath(r.checks)['/download/old']).toMatchObject({ type: 'word', notChecked: 'Legacy binary format (.doc); save it as .docx to have it checked' });
  });

  it('Office files have their own cap, and never use a PDF slot', async () => {
    const { inv } = inventory({ documents: { maxPdfs: 1, maxOfficeFiles: 1 } });
    inv.addPage(0, page(SITE, ['/minutes.docx', '/deck.pptx', '/board.pdf']));
    const r = await inv.finish();
    const d = byPath(r.checks);
    expect(d['/minutes.docx']).toHaveProperty('officeChecks');
    expect(d['/deck.pptx']).toMatchObject({ notChecked: 'Limit reached (1 Office files per scan)' });
    expect(d['/board.pdf']).toHaveProperty('checks');
  });

  it('robots.txt, a document service and document checks off are honoured', async () => {
    const off = inventory({ documents: false });
    off.inv.addPage(0, page(SITE, ['/minutes.docx']));
    expect(byPath((await off.inv.finish()).checks)['/minutes.docx']).toMatchObject({ notChecked: 'Document checks were turned off for this scan' });
    expect(off.calls).toHaveLength(0);
    const robots = inventory({ isAllowed: (u) => !u.includes('/minutes') });
    robots.inv.addPage(0, page(SITE, ['/minutes.docx']));
    expect(byPath((await robots.inv.finish()).checks)['/minutes.docx']).toMatchObject({ notChecked: 'Blocked by robots.txt' });
    expect(robots.calls).toHaveLength(0);
  });

  it('a link that opens a web page, a download error and a damaged file say so', async () => {
    const { inv } = inventory({}, ({ url }) => {
      const p = new URL(url).pathname;
      if (p === '/gone.docx') return new Response('no', { status: 404 });
      if (p === '/broken.pptx') return new Response(body(brokenPptx().slice(0, 300)), { headers: { 'content-type': 'application/octet-stream' } });
      return new Response('<!doctype html><title>Sign in</title>', { headers: { 'content-type': 'text/html' } });
    });
    inv.addPage(0, page(SITE, ['/signin.docx', '/gone.docx', '/broken.pptx']));
    const d = byPath((await inv.finish()).checks);
    expect(d['/signin.docx']).toMatchObject({ error: 'The link opens a web page, not a Word file (it may need a sign-in)' });
    expect(d['/gone.docx']).toMatchObject({ error: 'Could not download it (HTTP 404)' });
    expect(d['/broken.pptx']?.error).toMatch(/^Could not read the file/);
  });

  it('the time limit leaves unread files "Time limit reached", never an error', async () => {
    const { inv } = inventory({ documents: { tailMs: 50 } }, () => new Promise<Response>(() => {}));
    inv.addPage(0, page(SITE, ['/minutes.docx']));
    const d = byPath((await inv.finish()).checks);
    expect(d['/minutes.docx']).toMatchObject({ notChecked: 'Time limit reached' });
  });

  it('a download takes a turn of the pages at once, like a PDF: none starts while every page turn is taken', async () => {
    const pace = createPace({ concurrency: 1 });
    const slot = await pace.page();
    const { inv, calls } = inventory({ pace });
    inv.addPage(0, page(SITE, ['/minutes.docx']));
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.filter((c) => c.url.endsWith('.docx'))).toEqual([]);
    slot.release();
    const r = await inv.finish();
    expect(r.stats.officeChecked).toBe(1);
    pace.stop();
  });
});

/** A store like the long scan's host keeps (a Map). */
function memoryStore(): DocumentStore & { map: Map<string, StoredPdf> } {
  const map = new Map<string, StoredPdf>();
  return { map, get: (u) => map.get(u), put: (u, r) => { map.set(u, r); }, begin: () => 0 };
}

describe('document inventory: Office files across a long scan\'s runs', () => {
  it('each Office outcome is kept; a later run takes it from the store with no download, and the merge keeps it', async () => {
    const store = memoryStore();
    const first = inventory({ store });
    first.inv.addPage(0, page(SITE, ['/minutes.docx', '/download/old']));
    const r1 = await first.inv.finish();
    expect(store.map.get('https://e.org/minutes.docx')?.officeChecks).toMatchObject({ format: 'docx', imagesWithoutAlt: 2 });
    // A legacy file found only from its bytes is kept as "not checked", with the suggestion.
    expect(store.map.get('https://e.org/download/old')).toEqual({ notChecked: 'Legacy binary format (.doc); save it as .docx to have it checked' });

    const again = inventory({ store });
    again.inv.addPage(0, page(SITE, ['/minutes.docx']));
    const r2 = await again.inv.finish();
    expect(again.calls.filter((c) => c.url.endsWith('.docx'))).toEqual([]);
    expect(r2.checks.find((c) => c.url.endsWith('minutes.docx'))?.officeChecks).toEqual(r1.checks.find((c) => c.url.endsWith('minutes.docx'))?.officeChecks);

    // An earlier run's outcome survives a run that ran out of time.
    const cut = { ...r2, checks: r2.checks.map((c) => ({ url: c.url, type: c.type, detectedBy: c.detectedBy, linkedFrom: c.linkedFrom, notChecked: 'Time limit reached' })) };
    const merged = mergeInventory(cut, r1);
    expect(merged.checks.find((c) => c.url.endsWith('minutes.docx'))?.officeChecks).toBeDefined();
    expect(merged.stats.officeChecked).toBe(1);
  });

  it('a snapshot taken mid-run lists an Office file still being read as "Time limit reached", and a stored one with its checks', async () => {
    const store = memoryStore();
    store.put('https://e.org/deck.pptx', { officeChecks: { format: 'pptx', slides: 1, slidesWithoutTitle: 1 } });
    const { inv } = inventory({ store }, () => new Promise<Response>(() => {}));
    inv.addPage(0, page(SITE, ['/minutes.docx', '/deck.pptx']));
    await new Promise((r) => setTimeout(r, 50));
    const snap = byPath(inv.snapshot().checks);
    expect(snap['/minutes.docx']).toMatchObject({ notChecked: 'Time limit reached' });
    expect(snap['/deck.pptx']).toMatchObject({ officeChecks: { slidesWithoutTitle: 1 } });
  });
});
