// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// PDFs at the plan's page cap (Paul, 2026-11-05): a long scan checks them in its own document runs,
// bounded in time, keeping each outcome so that a later run or a restart never reads a PDF twice; one PDF
// at a time; each download polite like a page; a decompression bomb refused before pdf.js reads it.
import { deflateSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { AI_REFETCH_DEFAULT, createDocumentInventory, PDF_STOPPED_READ, type DocumentStore, type StoredPdf, type StoredProbe } from '../../src/documents/index.js';
import { TIME_LIMIT_REACHED } from '../../src/documents/pdf.js';
import type { PageProbe } from '../../src/probes/types.js';
import { scanSite, type ScanResume } from '../../src/scan.js';
import { fakeProbeBrowser } from '../helpers/probes.js';
import { PdfCheckError, type PdfReader } from '../../src/documents/pdf.js';
import type { DocumentCheck, PdfDetails } from '../../src/types.js';
import { checkDocuments } from '../../src/documents/run.js';
import { checkPdf } from '../../src/documents/pdf.js';
import { decodedSizeWithin, lzwDecodedSize } from '../../src/documents/pdfGuard.js';
import { createPace } from '../../src/pace.js';
import type { PageAudit } from '../../src/types.js';
import { fakeFetch, type Handler } from '../helpers/fakeFetch.js';
import { untaggedPdf } from '../helpers/pdfs.js';

const SITE = 'https://e.org/';
let PDF: Uint8Array<ArrayBuffer>;
beforeAll(async () => { PDF = (await untaggedPdf()) as Uint8Array<ArrayBuffer>; });

const pdfUrl = (i: number) => `${SITE}files/doc-${String(i).padStart(4, '0')}.pdf`;
/** `n` pages, page i linking PDFs [i*per, (i+1)*per). */
const pagesLinking = (n: number, per: number): PageAudit[] => Array.from({ length: n }, (_, i) => {
  const url = i === 0 ? SITE : `${SITE}p${i}`;
  const hrefs = Array.from({ length: per }, (_, k) => pdfUrl(i * per + k));
  return { url, status: 'ok', rules: {}, violations: [], incomplete: [], links: hrefs, collected: { documentLinks: hrefs.map((href) => ({ href, text: '' })) } };
});

/** Serves robots.txt (optionally with a Crawl-delay), a PDF for every .pdf path, `bytes` for `bomb`. */
const site = (o: { crawlDelay?: number; delayMs?: number; bomb?: { path: string; bytes: Uint8Array } } = {}): Handler => async ({ url }) => {
  const path = new URL(url).pathname;
  if (path === '/robots.txt') return new Response(`User-agent: *\nAllow: /\n${o.crawlDelay ? `Crawl-delay: ${o.crawlDelay}\n` : ''}`, { headers: { 'content-type': 'text/plain' } });
  if (o.bomb && path === o.bomb.path) return new Response(o.bomb.bytes as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'application/pdf' } });
  if (path.endsWith('.pdf')) {
    if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    return new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
  }
  return new Response('<!doctype html><title>x</title>', { headers: { 'content-type': 'text/html' } });
};

/** A store like the host's (a Map), counting begins. */
function memoryStore(seed: Record<string, { n?: number; r?: StoredPdf }> = {}): DocumentStore & { map: Map<string, { n?: number; r?: StoredPdf }>; probes: Map<string, StoredProbe> } {
  const map = new Map(Object.entries(seed));
  const probes = new Map<string, StoredProbe>();
  return {
    map,
    probes,
    get: (u) => map.get(u)?.r,
    put: (u, r) => { map.set(u, { r }); },
    begin: (u) => { const n = map.get(u)?.n ?? 0; map.set(u, { n: n + 1 }); return n; },
    probe: (u) => probes.get(u),
    putProbe: (u, r) => { probes.set(u, r); },
  };
}

const pdfGets = (calls: { url: string; method: string }[]) => calls.filter((c) => c.method === 'GET' && c.url.endsWith('.pdf')).map((c) => c.url);

/** A one-page PDF whose content stream is `content` (FlateDecode, with no /Subtype). */
function pdfWithStream(content: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (b: Uint8Array | string) => { const x = typeof b === 'string' ? enc.encode(b) : b; parts.push(x); size += x.length; };
  push('%PDF-1.4\n');
  const obj = (n: number, body: string) => { offsets[n] = size; push(`${n} 0 obj\n${body}\nendobj\n`); };
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>');
  offsets[4] = size;
  push(`4 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`);
  push(content);
  push('\nendstream\nendobj\n');
  const xref = size;
  push(`xref\n0 5\n0000000000 65535 f \n${[1, 2, 3, 4].map((n) => `${String(offsets[n]).padStart(10, '0')} 00000 n \n`).join('')}`);
  push(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** A PDF whose page content inflates to `mb` MB of spaces (a decompression bomb). */
const bombPdf = (mb: number) => pdfWithStream(new Uint8Array(deflateSync(Buffer.alloc(mb * 1024 * 1024, 0x20), { level: 9 })));

/** LZW-encodes `data` the way PDF's LZWDecode reads it (9 to 12-bit codes, MSB first, early change). */
function lzwEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  let width = 9;
  const emit = (code: number) => {
    buf = (buf << width) | code;
    bits += width;
    while (bits >= 8) { out.push((buf >>> (bits - 8)) & 0xff); bits -= 8; }
    buf &= (1 << bits) - 1;
  };
  let dict = new Map<string, number>();
  let next = 258;
  emit(256);
  let w = '';
  for (const byte of data) {
    const c = String.fromCharCode(byte);
    const wc = w + c;
    if (w === '' || dict.has(wc) || wc.length === 1) { w = wc; continue; }
    emit(w.length === 1 ? w.charCodeAt(0) : dict.get(w)!);
    if (next < 4096) dict.set(wc, next++);
    if (next + 1 > (1 << width) && width < 12) width++;
    if (next >= 4095) { emit(256); dict = new Map(); next = 258; width = 9; }
    w = c;
  }
  if (w) emit(w.length === 1 ? w.charCodeAt(0) : dict.get(w)!);
  emit(257);
  if (bits > 0) out.push((buf << (8 - bits)) & 0xff);
  return new Uint8Array(out);
}

describe('PDFs across a long scan’s document runs', () => {
  it('a 250-page scan with 300 linked PDFs checks 250, over two runs that stop and go on, each PDF downloaded once', async () => {
    const pages = pagesLinking(250, 1).concat(pagesLinking(50, 1).map((p, i) => ({ ...p, url: `${SITE}q${i}`, links: [pdfUrl(250 + i)], collected: { documentLinks: [{ href: pdfUrl(250 + i), text: '' }] } })));
    const f = fakeFetch(site({ delayMs: 2 }));
    const store = memoryStore();
    const base = { fetchFn: f.fn, pages: pages.length, page: (i: number) => pages[i], documents: [], limits: { maxPdfs: 250 }, store, concurrency: 4 };
    // The first run's time runs out partway (a segment's end, or a restart).
    const first = await checkDocuments(SITE, { ...base, by: Date.now() + 250 });
    expect(first.pdfs).toBe(250);
    expect(first.left).toBeGreaterThan(0);
    expect(first.left).toBeLessThan(250);
    const second = await checkDocuments(SITE, { ...base, by: Date.now() + 60_000 });
    expect(second).toMatchObject({ pdfs: 250, left: 0 });
    const gets = pdfGets(f.calls);
    // Each of the first 250 PDFs was downloaded once over both runs (only the one whose download the first
    // run's end cut off is downloaded again: a cut-off download is no outcome); none past the cap.
    const counts = new Map<string, number>();
    for (const u of gets) counts.set(u, (counts.get(u) ?? 0) + 1);
    expect([...counts.values()].filter((n) => n > 2)).toEqual([]);
    expect([...counts.values()].filter((n) => n === 2).length).toBeLessThanOrEqual(1);
    expect(counts.size).toBe(250);
    expect(gets.some((u) => u === pdfUrl(250))).toBe(false);

    // The report's run (the scan's inventory with the same store): every outcome from the store, no download.
    const g = fakeFetch(site());
    const inv = createDocumentInventory({ site: SITE, userAgent: 'UA', fetchFn: g.fn, store, documents: { maxPdfs: 250 } });
    pages.forEach((p, i) => inv.addPage(i, p));
    const r = await inv.finish();
    expect(pdfGets(g.calls)).toEqual([]);
    expect(r.checks.filter((c) => c.checks)).toHaveLength(250);
    expect(r.checks.filter((c) => c.notChecked === 'Limit reached (250 PDFs per scan)')).toHaveLength(50);
    expect(r.stats.pdfsChecked).toBe(250);
  }, 60_000);

  it('a restart while a PDF was being read: read once more; a PDF that stopped the reader twice is left out, never read again', async () => {
    const pages = pagesLinking(3, 1);
    const f = fakeFetch(site());
    const store = memoryStore({ [pdfUrl(0)]: { n: 1 }, [pdfUrl(1)]: { n: 2 } });
    const r = await checkDocuments(SITE, { fetchFn: f.fn, pages: 3, page: (i) => pages[i], documents: [], limits: { maxPdfs: 25 }, store, by: Date.now() + 30_000 });
    expect(r).toMatchObject({ pdfs: 3, left: 0 });
    expect(store.get(pdfUrl(0))?.checks?.tagged).toBe(false);
    expect(store.get(pdfUrl(1))).toEqual({ error: PDF_STOPPED_READ });
    expect(store.get(pdfUrl(2))?.checks?.tagged).toBe(false);
  });

  it('one PDF at a time: never two PDF downloads at once', async () => {
    let active = 0;
    let peak = 0;
    const handler = site();
    const f = fakeFetch(async (req) => {
      if (!req.url.endsWith('.pdf')) return handler(req);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return handler(req);
    });
    const inv = createDocumentInventory({ site: SITE, userAgent: 'UA', fetchFn: f.fn, documents: { maxPdfs: 25 } });
    pagesLinking(8, 1).forEach((p, i) => inv.addPage(i, p));
    const r = await inv.finish();
    expect(r.stats.pdfsChecked).toBe(8);
    expect(peak).toBe(1);
  });
});

describe('PDF downloads are polite like pages', () => {
  it('they keep the site’s Crawl-delay', async () => {
    const pages = pagesLinking(3, 1);
    const starts: number[] = [];
    const handler = site({ crawlDelay: 1 });
    const f = fakeFetch((req) => {
      if (req.url.endsWith('.pdf')) starts.push(Date.now());
      return handler(req);
    });
    const r = await checkDocuments(SITE, { fetchFn: f.fn, pages: 3, page: (i) => pages[i], documents: [], limits: { maxPdfs: 25 }, store: memoryStore(), by: Date.now() + 30_000 });
    expect(r.left).toBe(0);
    expect(starts).toHaveLength(3);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(950);
  }, 20_000);

  it('a download takes a turn of the pages at once: none starts while every page turn is taken', async () => {
    const pace = createPace({ concurrency: 1 });
    const slot = await pace.page();
    const f = fakeFetch(site());
    const inv = createDocumentInventory({ site: SITE, userAgent: 'UA', fetchFn: f.fn, pace, documents: { maxPdfs: 25 } });
    inv.addPage(0, pagesLinking(1, 1)[0]!);
    await new Promise((r) => setTimeout(r, 100));
    expect(pdfGets(f.calls)).toEqual([]);
    slot.release();
    const r = await inv.finish();
    expect(r.stats.pdfsChecked).toBe(1);
    pace.stop();
  });
});

describe('a hostile PDF', () => {
  it('a decompression bomb is refused before pdf.js reads it, in well under the time box', async () => {
    const bomb = bombPdf(256);
    expect(bomb.length).toBeLessThan(10 * 1024 * 1024);
    const t = Date.now();
    await expect(checkPdf(bomb, { maxPages: 20, timeoutMs: 5000 })).rejects.toThrow('Too large to read: it decompresses to more than 64 MB');
    expect(Date.now() - t).toBeLessThan(4000);
  }, 20_000);

  it('a normal PDF and a small compressed stream pass the guard', async () => {
    expect(await decodedSizeWithin(PDF)).toBe('ok');
    expect(await decodedSizeWithin(pdfWithStream(new Uint8Array(deflateSync(Buffer.from('BT /F1 12 Tf (Hello) Tj ET')))))).toBe('ok');
  });

  it('an LZW stream is measured from its codes alone', () => {
    const plain = new Uint8Array(200_000).fill(65);
    const enc = lzwEncode(plain);
    expect(enc.length).toBeLessThan(plain.length / 10);
    expect(lzwDecodedSize(enc, 1e9)).toBe(plain.length);
    expect(lzwDecodedSize(enc, 1000)).toBeGreaterThan(1000);
    const text = new TextEncoder().encode('the board met on tuesday; the board met on wednesday; the board met again');
    expect(lzwDecodedSize(lzwEncode(text), 1e9)).toBe(text.length);
  });

  it('the scan’s document run ends with the bomb marked, and the other PDFs checked', async () => {
    const pages = pagesLinking(3, 1);
    const f = fakeFetch(site({ bomb: { path: new URL(pdfUrl(1)).pathname, bytes: bombPdf(256) } }));
    const store = memoryStore();
    const t = Date.now();
    const r = await checkDocuments(SITE, { fetchFn: f.fn, pages: 3, page: (i) => pages[i], documents: [], limits: { maxPdfs: 25 }, store, by: Date.now() + 30_000 });
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(r).toMatchObject({ pdfs: 3, left: 0 });
    expect(store.get(pdfUrl(1))).toEqual({ error: 'Too large to read: it decompresses to more than 64 MB' });
    expect(store.get(pdfUrl(0))?.checks).toBeDefined();
    expect(store.get(pdfUrl(2))?.checks).toBeDefined();
  }, 30_000);
});

describe('the report at the top plan’s PDF count', () => {
  // (The hosted report's Documents section at this count is tested with that report.)
  it('3,500 checked PDFs keep report.json small, and the limit line names the cap', async () => {
    const { buildReport } = await import('../../src/report/build.js');
    const n = 3500;
    const checks = Array.from({ length: n }, (_, i) => ({
      url: pdfUrl(i), type: 'pdf' as const, detectedBy: 'extension' as const, linkedFrom: [SITE],
      checks: { pages: 2, pagesChecked: 2, tagged: i % 2 === 0, hasLanguage: true, hasTitle: true, showsTitle: true, imageOnly: false, figuresWithoutAlt: 0, formFields: 0, untitledFormFields: 0, xfa: false, blocksAssistiveTech: false },
    }));
    const report = buildReport({ site: SITE, pages: [{ url: SITE, status: 'ok', rules: {}, violations: [], incomplete: [], links: [] }], documents: checks.map((c) => c.url), documentChecks: checks, skipped: [], startedAt: '2026-11-05T00:00:00.000Z', finishedAt: '2026-11-05T01:00:00.000Z', userAgent: 'UA' });
    // Each checked PDF adds its quick checks to report.json: a few hundred bytes, never its bytes or text.
    const perPdf = JSON.stringify(report.documentChecks).length / n;
    expect(perPdf).toBeLessThan(600);

    const inv = createDocumentInventory({ site: SITE, userAgent: 'UA', fetchFn: fakeFetch(site()).fn, documents: { maxPdfs: 3500 }, store: memoryStore(Object.fromEntries(Array.from({ length: 3501 }, (_, i) => [pdfUrl(i), { r: { checks: checks[0]!.checks } }]))) });
    inv.addPage(0, pagesLinking(1, 3501)[0]!);
    const r = await inv.finish();
    expect(r.checks.find((c) => c.url === pdfUrl(3500))!.notChecked).toBe('Limit reached (3,500 PDFs per scan)');
  });
});

describe('a PDF the time or the site’s pace left unread', () => {
  it('a Crawl-delay wait past the run’s end leaves the PDF for the next run: never kept as a failed download', async () => {
    const pages = pagesLinking(3, 1);
    const f = fakeFetch(site({ crawlDelay: 1 }));
    const store = memoryStore();
    const r = await checkDocuments(SITE, { fetchFn: f.fn, pages: 3, page: (i) => pages[i], documents: [], limits: { maxPdfs: 25 }, store, by: Date.now() + 1500 });
    expect(r.pdfs).toBe(3);
    expect(r.left).toBe(1);
    expect(store.get(pdfUrl(0))?.checks).toBeDefined();
    expect(store.get(pdfUrl(1))?.checks).toBeDefined();
    expect(store.get(pdfUrl(2))).toBeUndefined();
  }, 20_000);

  it('a PDF the site keeps refusing (429) says so in the report and is not kept: the report’s run tries it once more', async () => {
    const pages = pagesLinking(2, 1);
    const handler = site();
    const f = fakeFetch((req) => (req.url === pdfUrl(1) ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }) : handler(req)));
    const store = memoryStore();
    const inv = createDocumentInventory({ site: SITE, userAgent: 'UA', fetchFn: f.fn, pace: createPace({ concurrency: 2 }), store, documents: { maxPdfs: 25 } });
    pages.forEach((p, i) => inv.addPage(i, p));
    const r = await inv.finish();
    expect(r.checks.find((c) => c.url === pdfUrl(1))!.error).toBe('Could not download it (HTTP 429)');
    expect(store.get(pdfUrl(1))).toBeUndefined();
    expect(store.get(pdfUrl(0))?.checks).toBeDefined();
  }, 20_000);
});


describe('round 2: the reader, the probes and the AI sample across runs', () => {
  it('PDFs are read by the reader it is given (the hosted checker’s Worker), never in this thread', async () => {
    const reads: number[] = [];
    const readPdf: PdfReader = async (bytes) => { reads.push(bytes.length); return { checks: { pages: 7, pagesChecked: 7, tagged: true } }; };
    const inv = createDocumentInventory({ site: SITE, userAgent: 'UA', fetchFn: fakeFetch(site()).fn, readPdf, documents: { maxPdfs: 25 } });
    inv.addPage(0, pagesLinking(1, 2)[0]!);
    const r = await inv.finish();
    expect(reads).toEqual([PDF.length, PDF.length]);
    expect(r.checks.map((c) => c.checks?.pages)).toEqual([7, 7]);
  });

  it('a reader that crashed (no answer about the PDF) after its retry: the PDF says the checker could not read it, is kept, and the run goes on', async () => {
    let calls = 0;
    const readPdf: PdfReader = async () => {
      if (calls++ === 0) throw new PdfCheckError('The checker could not read it');
      return { checks: { pages: 1, pagesChecked: 1, tagged: false } };
    };
    const store = memoryStore();
    const pages = pagesLinking(3, 1);
    const r = await checkDocuments(SITE, { fetchFn: fakeFetch(site()).fn, pages: 3, page: (i) => pages[i], documents: [], limits: { maxPdfs: 25 }, store, readPdf, by: Date.now() + 30_000 });
    expect(r).toMatchObject({ pdfs: 3, left: 0 });
    expect(store.get(pdfUrl(0))).toEqual({ error: 'The checker could not read it' });
    expect(store.get(pdfUrl(1))?.checks).toBeDefined();
    expect(store.get(pdfUrl(2))?.checks).toBeDefined();
  });

  it('a reader that is not reachable at all: said for this run, never kept (a later run reads the PDF)', async () => {
    const readPdf: PdfReader = async () => { throw new PdfCheckError('The PDF checker is not available', false, true); };
    const store = memoryStore();
    const pages = pagesLinking(1, 1);
    const r = await checkDocuments(SITE, { fetchFn: fakeFetch(site()).fn, pages: 1, page: (i) => pages[i], documents: [], limits: { maxPdfs: 25 }, store, readPdf, by: Date.now() + 30_000 });
    expect(r.inventory.checks[0]!.error).toBe('The PDF checker is not available');
    expect(store.get(pdfUrl(0))).toBeUndefined();
  });

  it('a selected page that is a PDF takes the same slot in the document runs and the report’s run: no stored PDF is pushed past the cap', async () => {
    const handler = site();
    // Page 0 is an extensionless download that failed to load as HTML; the probe finds a PDF.
    const f = fakeFetch((req) => (req.url.endsWith('/download/abc') ? new Response(req.method === 'HEAD' ? null : PDF, { headers: { 'content-type': 'application/pdf' } }) : handler(req)));
    const failed: PageAudit = { url: `${SITE}download/abc`, status: 'failed', reason: 'Not an HTML page', rules: {}, violations: [], incomplete: [], links: [] };
    const pages = [failed, ...pagesLinking(1, 3)];
    const store = memoryStore();
    await checkDocuments(SITE, { fetchFn: f.fn, pages: pages.length, page: (i) => pages[i], documents: [], limits: { maxPdfs: 3 }, store, by: Date.now() + 30_000 });
    const stored = [...store.map.entries()].filter(([, v]) => v.r?.checks).map(([u]) => u).sort();
    // The report's run, with the same store: the same 3 PDFs checked, nothing read again, nothing probed again.
    const g = fakeFetch(handler);
    const inv = createDocumentInventory({ site: SITE, userAgent: 'UA', fetchFn: g.fn, store, documents: { maxPdfs: 3 } });
    pages.forEach((p, i) => inv.addPage(i, p));
    const r = await inv.finish();
    expect(r.checks.filter((c) => c.checks).map((c) => c.url).sort()).toEqual(stored);
    expect(stored).toContain(`${SITE}download/abc`);
    for (const u of stored) expect(r.checks.find((c) => c.url === u)!.notChecked).toBeUndefined();
    expect(g.calls).toEqual([]);
    expect(r.notPages.map((p) => p.url)).toEqual([`${SITE}download/abc`]);
  });

  it('the report’s run hands stored PDFs to the AI document review: the best of them in its order, read again', async () => {
    const store = memoryStore();
    const date = (d: number) => `2026-0${d}-01T00:00:00.000Z`;
    // 6 stored PDFs: #4 is a form (first), then by date: #2 (June), #5 (May), #0 (Jan), the rest undated.
    const meta: StoredPdf[] = [
      { checks: { pages: 2, pagesChecked: 2, formFields: 0 }, modified: date(1) },
      { checks: { pages: 2, pagesChecked: 2, formFields: 0 } },
      { checks: { pages: 2, pagesChecked: 2, formFields: 0 }, modified: date(6) },
      { checks: { pages: 2, pagesChecked: 2, formFields: 0 } },
      { checks: { pages: 2, pagesChecked: 2, formFields: 3 }, modified: date(1) },
      { checks: { pages: 2, pagesChecked: 2, formFields: 0 }, modified: date(5) },
    ];
    meta.forEach((m, i) => store.put(pdfUrl(i), m));
    const handed: { doc: DocumentCheck; size: number; details: PdfDetails }[] = [];
    const f = fakeFetch(site());
    const inv = createDocumentInventory({
      site: SITE, userAgent: 'UA', fetchFn: f.fn, store, documents: { maxPdfs: 25 }, aiRefetch: { sample: 3, maxPages: 30, maxBytes: 10 * 1024 * 1024 },
      onDocument: (doc, bytes, details) => handed.push({ doc, size: bytes.length, details }),
    });
    inv.addPage(0, pagesLinking(1, 6)[0]!);
    await inv.finish();
    expect(handed.map((h) => h.doc.url)).toEqual([pdfUrl(4), pdfUrl(2), pdfUrl(5)]);
    expect(handed[0]!.size).toBe(PDF.length);
    expect(handed[0]!.doc.checks).toEqual(meta[4]!.checks);
    expect(pdfGets(f.calls)).toEqual([pdfUrl(4), pdfUrl(2), pdfUrl(5)]);
  });
});

// Grok r2 (feat/pdf-cap-by-tier, ed7353c1): the finish plan's document deadline published an empty inventory;
// the AI refetch stopped at six; documents segments read other page records than the finish resume.
describe('Grok r2 #1: the documents deadline never publishes an empty inventory', () => {
  const quickCore: PageProbe = {
    id: 'text-spacing', criteria: ['1.4.12'], kind: 'render', tier: 'core', timeoutMs: 20_000,
    run: async () => [{ criterion: '1.4.12', status: 'no_failures_found', detail: 'ok' }],
  };
  const timing = { reportMs: 200, aiMs: 400, aiPicturesMs: 100, minTestsMs: 300, deepMarginMs: 300, graceMs: 300 };
  /** A reader that answers at once for the first `quick` PDFs, then never: honouring the stop signal or not. */
  const stuckReader = (quick: number, honours: boolean): PdfReader & { calls: () => number } => {
    let n = 0;
    const r = (async (_bytes: Uint8Array, o: { signal?: AbortSignal }) => {
      if (n++ < quick) return { checks: { pages: 1, pagesChecked: 1, tagged: false } };
      return new Promise<never>((_, reject) => {
        if (honours) o.signal?.addEventListener('abort', () => reject(new PdfCheckError('The read was stopped', false, true)), { once: true });
      });
    }) as unknown as PdfReader & { calls: () => number };
    r.calls = () => n;
    return r;
  };
  const scanWith = async (o: { readPdf: PdfReader; pdfs: number; resume?: ScanResume; maxPages?: number; documentStore?: DocumentStore; documentBase?: { checks: DocumentCheck[]; notPages: [] } }) => {
    const hrefs = Array.from({ length: o.pdfs }, (_, i) => pdfUrl(i));
    const browser = fakeProbeBrowser({ delayFor: () => 1, evaluate: (name) => (name === '' || name === 'collectLinks' ? hrefs : undefined) }).browser;
    const t0 = Date.now();
    const finishBy = t0 + 2500;
    const report = await scanSite(SITE, {
      browser, fetchFn: fakeFetch(site()).fn, axeSource: '', concurrency: 2, probes: [quickCore], finishBy, finishTiming: timing,
      readPdf: o.readPdf, documents: { maxPdfs: o.pdfs, tailMs: 60_000 },
      ...(o.resume ? { resume: o.resume, maxPages: o.maxPages } : { maxPages: 1 }),
      ...(o.documentStore ? { documentStore: o.documentStore } : {}), ...(o.documentBase ? { documentBase: o.documentBase } : {}),
    });
    return { report, ended: Date.now(), finishBy };
  };

  it('a 25-page scan with a read in flight at the deadline: the reader is stopped, the PDFs it checked count', async () => {
    const readPdf = stuckReader(2, true);
    const { report, ended, finishBy } = await scanWith({ readPdf, pdfs: 3 });
    expect(ended).toBeLessThanOrEqual(finishBy);
    expect(report.documentChecks!.filter((c) => c.checks)).toHaveLength(2);
    expect(report.documentChecks!.filter((c) => c.notChecked === TIME_LIMIT_REACHED)).toHaveLength(1);
    expect(report.documentScore).toMatchObject({ scored: true, checked: 2, failed: 2 });
    expect(report.notChecked).toContainEqual({ stage: 'documents', detail: 'Not finished: the document checks (the scan ran out of time; what ran counts)' });
  }, 20_000);

  it('a 25-page scan whose read ignores the stop: past the grace, the inventory as it stands, never an empty one', async () => {
    const readPdf = stuckReader(2, false);
    const { report, ended, finishBy } = await scanWith({ readPdf, pdfs: 3 });
    // The stage's grace past its time, then the report (this test's grace is longer than its report time).
    expect(ended).toBeLessThanOrEqual(finishBy + timing.graceMs);
    expect(report.documentChecks!.filter((c) => c.checks)).toHaveLength(2);
    expect(report.documentScore).toMatchObject({ checked: 2, failed: 2 });
  }, 20_000);

  it('a 250-page scan: 200 PDFs stored and listed, 50 left, one read in flight at the deadline: the report scores the 200', async () => {
    const pages = pagesLinking(5, 50);
    const store = memoryStore();
    const failing = { pages: 1, pagesChecked: 1, tagged: false };
    for (let i = 0; i < 200; i++) store.put(pdfUrl(i), { checks: failing });
    const base: DocumentCheck[] = Array.from({ length: 250 }, (_, i) => ({ url: pdfUrl(i), type: 'pdf', detectedBy: 'extension', linkedFrom: [pages[Math.floor(i / 50)]!.url], ...(i < 200 ? { checks: failing } : { notChecked: TIME_LIMIT_REACHED }) }));
    const resume: ScanResume = { pages: pages.map((p) => p.url), documents: [], skipped: [], audit: (i) => pages[i] };
    const readPdf = stuckReader(0, false);
    const { report } = await scanWith({ readPdf, pdfs: 250, resume, maxPages: 250, documentStore: store, documentBase: { checks: base, notPages: [] } });
    expect(readPdf.calls()).toBeGreaterThanOrEqual(1); // a read was in flight when the time ended
    expect(report.documentChecks!.filter((c) => c.checks)).toHaveLength(200);
    expect(report.documentScore).toMatchObject({ scored: true, checked: 200, failed: 200 });
    expect(report.notChecked).toContainEqual({ stage: 'documents', detail: 'Not finished: the document checks (the scan ran out of time; what ran counts)' });
  }, 30_000);
});

describe('Grok r2 #2: the AI refetch walks the review’s order until its sample fits', () => {
  it('six 80-page packets first, then three short PDFs: the three short ones are read again and the review samples them', async () => {
    const store = memoryStore();
    const month = (m: number) => `2026-${String(m).padStart(2, '0')}-01T00:00:00.000Z`;
    // Newest first: 6 packets (Dec..Jul), then 3 short PDFs (Jun..Apr), then 3 older short ones (Mar..Jan).
    const order = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    order.forEach((m, i) => store.put(pdfUrl(i), { checks: { pages: i < 6 ? 80 : 10, pagesChecked: 20, formFields: 0 }, modified: month(m), size: 50_000 }));
    const handed: { doc: DocumentCheck; size: number }[] = [];
    const f = fakeFetch(site());
    const inv = createDocumentInventory({
      site: SITE, userAgent: 'UA', fetchFn: f.fn, store, documents: { maxPdfs: 25 },
      aiRefetch: AI_REFETCH_DEFAULT,
      onDocument: (doc, bytes) => handed.push({ doc, size: bytes.length }),
    });
    inv.addPage(0, pagesLinking(1, 12)[0]!);
    await inv.finish();
    expect(handed.map((h) => h.doc.url)).toEqual([pdfUrl(6), pdfUrl(7), pdfUrl(8)]);
    // The packets were never downloaded again (they take no place in the review's sample).
    expect(pdfGets(f.calls)).toEqual([pdfUrl(6), pdfUrl(7), pdfUrl(8)]);
  });

  // That the hosted default (AI_REFETCH_DEFAULT) is the AI document review's own sample and caps is checked with the AI
  // code (closed AI package, documentRefetch.test.ts).
});
