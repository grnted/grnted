// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The document inventory: PDF and Office files linked from the scanned pages, found by
// `detect.ts`, confirmed by polite probes (`fetch.ts`) and quickly checked: PDFs (`pdf.ts`, scored
// since scoring v7) and Word, Excel and PowerPoint files (`office.ts`, never scored). Office files have
// their own cap and their own one-at-a-time lane, so they never take a PDF's place. Engine core: no
// Node-only imports.
//
// Work starts as each page's audit finishes, so probes and PDF checks overlap the rest of the scan.
// Pages are handled in audit order (not finish order) and PDFs get check slots in that order, so
// which links are probed and which PDFs are checked never depends on timing.
//
// One PDF at a time (its download and its read), each download polite like a page: it takes a turn of
// the scan's pages at once and keeps the site's Crawl-delay. A long scan's host keeps each PDF's outcome
// (`store`): a later run of the same scan takes it from there instead of reading the PDF again, so PDFs
// are checked across runs and each one counts once.
import { collectedValue } from '../collect/index.js';
import { documentLinksCollector } from '../collect/documentLinks.js';
import type { DocumentCheck, DocumentDetectedBy, DocumentLink, DocumentType, OfficeChecks, OfficeFormat, PageAudit, PdfChecks, PdfDetails } from '../types.js';
import { ACTION_SKIP_REASON, isActionLikeUrl, normalizeUrl, sameSite } from '../url.js';
import { accessibleAlternatives } from './alternatives.js';
import { classifyLink } from './detect.js';
import { KeyedLimiter, downloadOffice, downloadPdf, hostOf, probeUrl, type Download, type ProbeResult, type RequestContext } from './fetch.js';
import { asOfficeError, checkOffice, legacyNote, officeFormat } from './office.js';
import { PdfCheckError, TIME_LIMIT_REACHED, readPdfChecks, type PdfReader } from './pdf.js';
import { isPaceReason, politeFetch, type Pace } from '../pace.js';

export interface DocumentOptions {
  /** Probes (HEAD, then a ranged GET if needed) for links that only might be documents. Default 60. */
  maxProbes?: number;
  /** PDFs downloaded and checked per scan. Default 10 (the hosted checker: the plan's page cap). */
  maxPdfs?: number;
  /** Largest PDF downloaded, in bytes. Default 10 MB. */
  maxPdfBytes?: number;
  /** Pages of each PDF read for the per-page checks. Default 20. */
  maxPdfPages?: number;
  /** Time box for reading one PDF. Default 5000 ms. */
  pdfTimeoutMs?: number;
  /** Time box for one request. Default 10000 ms. */
  requestTimeoutMs?: number;
  /** Requests at once to one host (probes and downloads together). Default 2. */
  perHost?: number;
  /** Redirects followed per request. Default 5. */
  maxRedirects?: number;
  /** After the last page audit, how long document work may continue. Default 20000 ms. */
  tailMs?: number;
  /** Word, Excel and PowerPoint files downloaded and checked per scan (apart from the PDFs). Default 10. */
  maxOfficeFiles?: number;
  /** Largest Office file downloaded, in bytes. Default 10 MB. */
  maxOfficeBytes?: number;
  /** Time box for reading one Office file. Default 5000 ms. */
  officeTimeoutMs?: number;
}

/** A document check with an outcome (its quick checks, or why they could not run). */
const hasOutcome = (c: DocumentCheck) => !!c.checks || !!c.officeChecks || !!c.error;

/**
 * One run's inventory merged with the documents an earlier run listed (a long scan's documents segments):
 * every document of either, and for each the entry with an outcome, this run's first; one with no outcome
 * on either side keeps this run's entry (or the earlier one's when this run never saw it). A stored PDF's
 * outcome is never lost to "Time limit reached" or "Limit reached" here. The selected pages that are
 * documents are the union of both.
 */
export function mergeInventory(fresh: InventoryResult, base: { checks: DocumentCheck[]; notPages: InventoryResult['notPages'] }): InventoryResult {
  const byUrl = new Map<string, DocumentCheck>();
  for (const c of fresh.checks) byUrl.set(c.url, c);
  for (const b of base.checks) {
    const f = byUrl.get(b.url);
    if (!f || (!hasOutcome(f) && hasOutcome(b))) byUrl.set(b.url, b);
  }
  const checks = [...byUrl.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const notPages = [...fresh.notPages];
  const seen = new Set(notPages.map((p) => p.url));
  for (const p of base.notPages) if (!seen.has(p.url)) { seen.add(p.url); notPages.push(p); }
  return { documents: checks.map((c) => c.url), checks, notPages, stats: { probes: fresh.stats.probes, pdfsChecked: checks.filter((c) => c.checks && !c.error).length, officeChecked: checks.filter((c) => c.officeChecks && !c.error).length } };
}

export const DOCUMENT_LIMITS: Readonly<Required<DocumentOptions>> = {
  maxProbes: 60, maxPdfs: 10, maxPdfBytes: 10 * 1024 * 1024, maxPdfPages: 20, pdfTimeoutMs: 5000,
  requestTimeoutMs: 10_000, perHost: 2, maxRedirects: 5, tailMs: 20_000,
  maxOfficeFiles: 10, maxOfficeBytes: 10 * 1024 * 1024, officeTimeoutMs: 5000,
};

/** A document type that is listed but has no quick checks (OpenDocument, RTF, other files). */
export const NO_QUICK_CHECKS = 'Only PDF, Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) files are checked';
/** Office binary formats by extension: listed as legacy, never downloaded. */
const LEGACY_EXTENSIONS: Readonly<Record<string, OfficeFormat>> = { doc: 'docx', xls: 'xlsx', ppt: 'pptx', pps: 'pptx' };
/** Office types the quick checks never read (by extension), whatever the link says. */
const UNCHECKED_EXTENSIONS = new Set(['odt', 'ods', 'odp', 'rtf']);

/** A document's outcome as a host keeps it between runs of one scan (`DocumentStore`): a PDF's or an Office file's. */
export interface StoredPdf {
  checks?: PdfChecks;
  /** An Office file's quick checks (never scored). */
  officeChecks?: OfficeChecks;
  /** An Office file listed without checks after its download (a legacy binary file). */
  notChecked?: string;
  error?: string;
  /** Only the link text said PDF, and the server answered with a web page: not a document. */
  notDocument?: true;
  /** The PDF's modification date (ModDate, else Last-Modified): the AI document review's sample order. */
  modified?: string;
  /** Its size in bytes (the AI document review's size cap). */
  size?: number;
  /** Batch 19: the file name the server gave it (Content-Disposition). */
  fileName?: string;
}

/** A probe's answer as a host keeps it (an error is never kept: a later run asks again). */
export type StoredProbe = Exclude<ProbeResult, { kind: 'error' }>;

/**
 * Where a long scan keeps its document outcomes between runs (segments, restarts, the report built from
 * storage): each PDF's, and each probe's. A PDF with an outcome is not downloaded or read again, and a
 * link with a kept answer is not probed again, so every run of the scan gives the same PDFs the same check
 * slots. Calls are synchronous; one that throws only means the outcome is not kept.
 */
export interface DocumentStore {
  get(url: string): StoredPdf | undefined;
  put(url: string, result: StoredPdf): void;
  /**
   * A read of the PDF is about to start; returns how many reads of it started before without an outcome
   * (a run that died while reading it leaves one).
   */
  begin(url: string): number;
  probe?(url: string): StoredProbe | undefined;
  putProbe?(url: string, result: StoredProbe): void;
}

/**
 * What the AI document review samples (src/ai/checks/document.ts: its sample size and the caps a PDF must
 * fit to take a place). A run that writes the report from stored PDFs reads again, in the review's own
 * order, the stored PDFs that fit those caps until `sample` of them are handed over, so the review chooses
 * from the same PDFs as it would have on one uninterrupted run.
 */
export interface AiRefetch {
  sample: number;
  maxPages: number;
  maxBytes: number;
}

/** The review's defaults (DOCUMENT_SAMPLE_SIZE, DOCUMENT_MAX_PAGES, DOCUMENT_MAX_BYTES). */
export const AI_REFETCH_DEFAULT: AiRefetch = { sample: 3, maxPages: 30, maxBytes: 10 * 1024 * 1024 };

/**
 * Reads of one PDF that may start without an outcome: a PDF whose read stopped the run this many times
 * (the isolate ran out of time or memory in pdf.js) is not read again.
 */
export const MAX_PDF_READ_STARTS = 2;
export const PDF_STOPPED_READ = 'Reading it stopped the checker, so it was left out';

export interface InventoryOptions {
  /** The scan's start URL; probes go only to this site's host. */
  site: string;
  userAgent: string;
  fetchFn?: typeof fetch;
  /** Hosted safety: every request and redirect target must pass. */
  allowUrl?: (url: string) => Promise<boolean>;
  /** robots.txt rules for the site's own host (other hosts are not crawled, only linked files fetched). */
  isAllowed?: (url: string) => boolean;
  /**
   * `false`: no probes of links and no PDF checks; documents are listed from what the links show.
   * A selected page that failed to load as HTML is still checked once (it may be a document).
   */
  documents?: DocumentOptions | false;
  /**
   * Called once for each PDF whose quick checks succeeded, with its bytes and the extra facts the
   * AI document review uses (`AiScanPlan.onDocument`). When set, PDFs are read with
   * `checkPdfDetailed` (same checks). It must return at once; a throw is ignored.
   */
  onDocument?: (doc: DocumentCheck, bytes: Uint8Array, details: PdfDetails) => void;
  /**
   * Called each time a PDF check ends (checked, failed or out of time), with the PDF checks ended so
   * far and started so far, for a live view. A throw is ignored.
   */
  onPdfDone?: (counts: { done: number; started: number }) => void;
  /**
   * The scan's politeness controller (`src/pace.ts`): requests wait out a host's pause and its
   * one-at-a-time limit, a 429 or 503 slows that host down for the pages too, and is tried once more.
   */
  pace?: Pace;
  /** A long scan's PDF outcomes from its earlier runs, and where new ones are kept. */
  store?: DocumentStore;
  /**
   * Reads one PDF (src/documents/pdf.ts `PdfReader`). Default: in this thread (`readPdfChecks`). The hosted
   * checker reads in its PDF reader Worker, so a hostile PDF never takes the scan's isolate down.
   */
  readPdf?: PdfReader;
  /** With `onDocument` and `store`: the review's sample and caps, for the stored PDFs read again (AI_REFETCH_DEFAULT). */
  aiRefetch?: AiRefetch;
}

export interface InventoryResult {
  /** Every document URL, sorted. */
  documents: string[];
  /** One entry per document, sorted by URL. */
  checks: DocumentCheck[];
  /** Selected pages that turned out not to be web pages (documents and other files), in audit order. */
  notPages: { url: string; reason: string }[];
  stats: { probes: number; pdfsChecked: number; /** Office files checked (absent from hosts that only count PDFs). */ officeChecked?: number };
}

export interface DocumentInventory {
  /**
   * The inventory as it stands, at once and never waiting (the scan's time for documents ran out while
   * `finish` was still at work): every outcome so far, the PDFs still running or never started as "Time
   * limit reached", stored outcomes for PDFs not reached yet, and the selected pages known to be documents.
   */
  snapshot(): InventoryResult;
  /** PDF checks ended so far and started so far. */
  pdfs(): { done: number; started: number };
  /** Documents found so far (links judged documents; a link still being probed counts once it is one). */
  found(): number;
  /** A page's audit finished. Never throws. Pages may arrive in any order. */
  addPage(index: number, page: PageAudit): void;
  /**
   * Waits for outstanding work (bounded by `tailMs`, and by `by` (epoch ms) when given: the scan's
   * finish plan) and returns the inventory; PDFs not checked by then say "Time limit reached".
   */
  finish(extra?: { documents?: string[]; by?: number }): Promise<InventoryResult>;
}

interface Entry {
  url: string;
  verdict: 'document' | 'maybe' | 'no';
  type: DocumentType;
  detectedBy: DocumentDetectedBy;
  linkedFrom: string[];
  /** Batch 18 (neutral, for the AI review only): the first link to it, its accessible name and the text of its block. */
  link?: { text: string; nearby?: string };
  /** Resolves when the verdict is final (after a probe, if any). */
  settled: Promise<void>;
  probe?: Promise<ProbeResult>;
  allocated?: boolean;
  checks?: PdfChecks;
  officeChecks?: OfficeChecks;
  error?: string;
  notChecked?: string;
  accessibleAlternative?: string;
  /** Its outcome came from the store (an earlier run of the scan). */
  reused?: boolean;
  /** Batch 19: the file name the server gave it (Content-Disposition). */
  fileName?: string;
  /** The stored modification date (the AI review's sample order). */
  modified?: string;
  /** The stored size in bytes (the AI review's size cap). */
  size?: number;
}

/** The AI document review's order (src/ai/checks/document.ts compareDocuments): fillable forms first. */
const reviewOrder = (e: Entry) => ((e.checks?.formFields ?? 0) > 0 ? 0 : 1);
/** Then the most recently changed first; an unknown date last. */
function dateDesc(a: Entry, b: Entry): number {
  const t = (e: Entry) => { const x = Date.parse(e.modified ?? ''); return Number.isFinite(x) ? x : Number.NEGATIVE_INFINITY; };
  const da = t(a);
  const db = t(b);
  return da === db ? 0 : da > db ? -1 : 1;
}

const TYPE_NAMES: Record<DocumentType, string> = { pdf: 'PDF', word: 'Word', excel: 'Excel', powerpoint: 'PowerPoint', other: 'document' };
const MAX_LINKED_FROM = 20;

export function createDocumentInventory(opts: InventoryOptions): DocumentInventory {
  const enabled = opts.documents !== false;
  const lim: Required<DocumentOptions> = { ...DOCUMENT_LIMITS, ...(opts.documents || {}) };
  const abort = new AbortController();
  const baseFetch: typeof fetch = opts.fetchFn ?? ((input, init) => fetch(input, init));
  const ctx: RequestContext = {
    fetchFn: opts.pace ? politeFetch(opts.pace, baseFetch) : baseFetch,
    userAgent: opts.userAgent,
    allowUrl: opts.allowUrl,
    timeoutMs: lim.requestTimeoutMs,
    maxRedirects: lim.maxRedirects,
    signal: abort.signal,
  };
  // Downloads keep the site's Crawl-delay like a page load (no 403 rule: a private PDF is not a refusal).
  const download: RequestContext = { ...ctx, fetchFn: opts.pace ? politeFetch(opts.pace, baseFetch, { crawl: true }) : baseFetch };
  const hosts = new KeyedLimiter(lim.perHost);
  // One PDF at a time, download and read together: never more than one file's bytes held (pdf.js
  // parses on this thread).
  const parser = new KeyedLimiter(1);
  const store = opts.store;
  /** Resolves when the time for documents ends (`abort`). */
  const stopped = new Promise<'stopped'>((resolve) => abort.signal.addEventListener('abort', () => resolve('stopped'), { once: true }));
  /** The page probes' answers as they come (the snapshot's selected pages that are documents). */
  const pageAnswers = new Map<string, ProbeResult>();
  const reader: PdfReader = opts.readPdf ?? readPdfChecks;
  const pdfLimits = { maxPages: lim.maxPdfPages, timeoutMs: lim.pdfTimeoutMs };
  /** A store call: one that throws only means the outcome is not kept. */
  const kept = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  const entries = new Map<string, Entry>();
  const queue: Entry[] = [];
  const pageProbes: { url: string; result: Promise<ProbeResult> }[] = [];
  const running: Promise<void>[] = [];
  const buffered = new Map<number, PageAudit>();
  let nextIndex = 0;
  let probes = 0;
  let pdfsStarted = 0;
  let pdfsDone = 0;
  let officeStarted = 0;
  let closed = false;
  let wake: (() => void) | undefined;

  const robotsOk = (url: string) => !opts.isAllowed || !sameSite(url, opts.site) || opts.isAllowed(url);
  /**
   * An address that looks like an action (`isActionLikeUrl`, the page list's own filter) is never requested by
   * the document checks either, on any host: not asked about (a link that only might be a document), not
   * downloaded (one that is a document by its extension: it stays listed, with this as the reason).
   */
  const actionLike = (url: string) => isActionLikeUrl(url, opts.site);
  /** A link's probe: the answer an earlier run of the scan kept, else asked now (and kept). */
  const probe = (url: string, confirmHtml: boolean): Promise<ProbeResult> => {
    const known = store?.probe ? kept(() => store.probe!(url)) : undefined;
    if (known) return Promise.resolve(known);
    return hosts.run(hostOf(url), () => probeUrl(url, ctx, { confirmHtml })).then((r) => {
      if (r.kind !== 'error' && store?.putProbe) kept(() => store.putProbe!(url, r));
      return r;
    });
  };

  function enqueue(e: Entry): void {
    queue.push(e);
    const w = wake;
    wake = undefined;
    w?.();
  }

  function applyProbe(e: Entry, r: ProbeResult): void {
    if (r.kind === 'document') {
      if (e.verdict !== 'document') e.detectedBy = 'probe';
      e.verdict = 'document';
      e.type = r.type;
    } else if (r.kind === 'html' || r.kind === 'other') {
      e.verdict = 'no'; // the server's answer beats a guess from the link text
    } else if (e.verdict === 'maybe') {
      e.verdict = 'no';
    }
  }

  function addLink(link: DocumentLink, from: string, alternative?: string): void {
    const c = classifyLink(link, from);
    if (c.verdict === 'no' || !c.url) return;
    const known = entries.get(c.url);
    if (known) {
      if (!known.linkedFrom.includes(from) && known.linkedFrom.length < MAX_LINKED_FROM) known.linkedFrom.push(from);
      if (alternative && !known.accessibleAlternative) known.accessibleAlternative = alternative;
      // Stronger evidence settles a link that was never probed (another host, or over the cap).
      if (known.verdict === 'maybe' && !known.probe && c.verdict === 'document') {
        Object.assign(known, { verdict: 'document', type: c.type, detectedBy: c.detectedBy });
        enqueue(known);
      }
      return;
    }
    const e: Entry = {
      url: c.url, verdict: c.verdict, type: c.type, detectedBy: c.detectedBy ?? 'text', linkedFrom: [from], settled: Promise.resolve(),
      link: { text: link.text, ...(link.nearby ? { nearby: link.nearby } : {}) },
      ...(alternative ? { accessibleAlternative: alternative } : {}),
    };
    if (c.verdict === 'maybe' && enabled && probes < lim.maxProbes && sameSite(c.url, opts.site) && robotsOk(c.url) && !actionLike(c.url)) {
      probes++;
      e.probe = probe(c.url, c.addressHint === true);
      e.settled = e.probe.then((r) => applyProbe(e, r));
    }
    entries.set(c.url, e);
    enqueue(e);
  }

  /**
   * A selected page that did not load as HTML (no HTTP error) may be a document, e.g. an
   * extensionless `/download/<token>`. Ask the server once; the scan then moves it out of the
   * pages. Not counted against `maxProbes` (at most one per selected page).
   */
  function checkFailedPage(url: string): void {
    let e = entries.get(url);
    const result = e?.probe ?? probe(url, true);
    result.then((r) => { pageAnswers.set(url, r); }, () => {});
    pageProbes.push({ url, result });
    if (!e) {
      e = { url, verdict: 'maybe', type: 'other', detectedBy: 'probe', linkedFrom: [], settled: Promise.resolve() };
      entries.set(url, e);
      enqueue(e);
    }
    const entry = e;
    entry.probe = result;
    entry.settled = Promise.all([entry.settled, result]).then(([, r]) => applyProbe(entry, r));
  }

  function processPage(page: PageAudit): void {
    // Page scoring depends on this, so it runs even when document checks are off.
    // Not a page the site asked us to slow down on: asking it again would only add to the load.
    if (page.status === 'failed' && page.httpStatus === undefined && !isPaceReason(page.reason)) checkFailedPage(page.url);
    const links = collectedValue(page, documentLinksCollector) ?? page.links.map((href) => ({ href, text: '' }));
    // Pages are processed in audit order, so the first page that pairs a document wins on every scan.
    const alternatives = accessibleAlternatives(links, page.url);
    for (const link of links) addLink(link, page.url, alternatives.get(normalizeUrl(link.href, page.url) ?? ''));
  }

  function allocate(e: Entry): void {
    if (e.allocated || e.verdict !== 'document') return;
    e.allocated = true;
    if (!enabled) e.notChecked = 'Document checks were turned off for this scan';
    else if (e.detectedBy === 'host') e.notChecked = 'Kept on a document service, so it was not downloaded';
    else if (actionLike(e.url)) e.notChecked = ACTION_SKIP_REASON;
    else if (e.type !== 'pdf') allocateOffice(e);
    else if (!robotsOk(e.url)) e.notChecked = 'Blocked by robots.txt';
    else if (pdfsStarted >= lim.maxPdfs) e.notChecked = `Limit reached (${lim.maxPdfs.toLocaleString('en-US')} PDFs per scan)`;
    else {
      pdfsStarted++;
      // Checked by an earlier run of this scan: its outcome, with no download.
      const known = store ? kept(() => store.get(e.url)) : undefined;
      if (known) e.reused = true;
      running.push((known ? Promise.resolve(apply(e, known)) : parser.run('pdf', () => runCheck(e))).finally(() => {
        pdfsDone++;
        try {
          opts.onPdfDone?.({ done: pdfsDone, started: pdfsStarted });
        } catch {
          // A live view's listener never breaks the inventory.
        }
      }));
    }
  }

  /**
   * Why an Office file gets no check slot, before any download (legacy and unchecked formats by their
   * extension, robots.txt, the cap with `started` slots taken); undefined when it takes one.
   */
  function officeRefusal(e: Entry, started: number): string | undefined {
    const ext = extensionOf(e.url);
    if (ext && LEGACY_EXTENSIONS[ext]) return legacyNote(LEGACY_EXTENSIONS[ext]);
    if (!officeFormat(e.type) || (ext && UNCHECKED_EXTENSIONS.has(ext))) return NO_QUICK_CHECKS;
    if (!robotsOk(e.url)) return 'Blocked by robots.txt';
    if (started >= lim.maxOfficeFiles) return `Limit reached (${lim.maxOfficeFiles.toLocaleString('en-US')} Office files per scan)`;
    return undefined;
  }

  /** An Office file's turn: its own cap and its own lane (one at a time), never a PDF's slot. */
  function allocateOffice(e: Entry): void {
    const refused = officeRefusal(e, officeStarted);
    if (refused) {
      e.notChecked = refused;
      return;
    }
    officeStarted++;
    const known = store ? kept(() => store.get(e.url)) : undefined;
    if (known) e.reused = true;
    running.push(known ? Promise.resolve(apply(e, known)) : parser.run('office', () => runOfficeCheck(e, officeFormat(e.type)!)));
  }

  async function runOfficeCheck(e: Entry, format: OfficeFormat): Promise<void> {
    if (abort.signal.aborted) {
      e.notChecked = TIME_LIMIT_REACHED;
      return;
    }
    const got = await politeDownload(e.url, (url) => downloadOffice(url, download, lim.maxOfficeBytes));
    if (!got) {
      e.notChecked = TIME_LIMIT_REACHED;
      return;
    }
    if ('error' in got) {
      if (abort.signal.aborted || got.error === TIME_LIMIT_REACHED) e.notChecked = TIME_LIMIT_REACHED;
      else if (got.again) e.error = got.error;
      else keep(e, { error: got.error });
      return;
    }
    if ('html' in got) {
      if (e.detectedBy === 'text') keep(e, { notDocument: true });
      else keep(e, { error: `The link opens a web page, not a ${TYPE_NAMES[e.type]} file (it may need a sign-in)` });
      return;
    }
    if (abort.signal.aborted) {
      e.notChecked = TIME_LIMIT_REACHED;
      return;
    }
    try {
      keep(e, { officeChecks: await checkOffice(got.bytes, format, { timeoutMs: lim.officeTimeoutMs }), ...(got.fileName ? { fileName: got.fileName } : {}) });
    } catch (err) {
      const x = asOfficeError(err);
      keep(e, x.kind === 'legacy' ? { notChecked: x.message } : { error: x.message });
    }
  }

  function apply(e: Entry, r: StoredPdf): void {
    if (r.notDocument) e.verdict = 'no';
    if (r.checks) e.checks = r.checks;
    if (r.officeChecks) e.officeChecks = r.officeChecks;
    if (r.notChecked) e.notChecked = r.notChecked;
    if (r.error) e.error = r.error;
    if (r.modified) e.modified = r.modified;
    if (typeof r.size === 'number') e.size = r.size;
    if (r.fileName) e.fileName = r.fileName;
  }

  /** An outcome a later run reuses (never "Time limit reached": that PDF is tried again). */
  function keep(e: Entry, r: StoredPdf): void {
    apply(e, r);
    if (store) kept(() => store.put(e.url, r));
  }

  /** One PDF's download with a turn of the pages at once, like a page load; null once the pace stopped. */
  function fetchPdf(url: string): Promise<Download | null> {
    return politeDownload(url, (u) => downloadPdf(u, download, lim.maxPdfBytes));
  }

  /** A document download with a turn of the pages at once, like a page load; null once the pace stopped. */
  async function politeDownload(url: string, get: (url: string) => Promise<Download>): Promise<Download | null> {
    let slot: { release(): void } | undefined;
    if (opts.pace) {
      // The turn is waited for only until the scan's time for documents ends; one that comes later is given back.
      const turn = opts.pace.page();
      const got = await Promise.race([turn.then((t) => ({ t }), () => null), stopped]);
      if (!got || got === 'stopped') {
        turn.then((t) => t.release(), () => {});
        return null;
      }
      slot = got.t;
    }
    try {
      return await hosts.run(hostOf(url), () => get(url));
    } finally {
      slot?.release();
    }
  }

  async function runCheck(e: Entry): Promise<void> {
    if (abort.signal.aborted) {
      e.notChecked = TIME_LIMIT_REACHED; // the time limit passed while it waited for its turn
      return;
    }
    const got = await fetchPdf(e.url);
    if (!got) {
      e.notChecked = TIME_LIMIT_REACHED; // the scan's pace stopped: the scan is over
      return;
    }
    if ('error' in got) {
      if (abort.signal.aborted || got.error === TIME_LIMIT_REACHED) e.notChecked = TIME_LIMIT_REACHED;
      // The site asked us to slow down: said, not kept (the report's run asks once more).
      else if (got.again) e.error = got.error;
      else keep(e, { error: got.error });
      return;
    }
    if ('html' in got) {
      // Only the link text said PDF; the server says otherwise.
      if (e.detectedBy === 'text') keep(e, { notDocument: true });
      else keep(e, { error: 'The link opens a web page, not a PDF (it may need a sign-in)' });
      return;
    }
    if (abort.signal.aborted) {
      e.notChecked = TIME_LIMIT_REACHED;
      return;
    }
    // A PDF whose read stopped earlier runs of this scan (the isolate died in pdf.js) is not read again.
    const starts = store ? kept(() => store.begin(e.url)) ?? 0 : 0;
    if (starts >= MAX_PDF_READ_STARTS) {
      keep(e, { error: PDF_STOPPED_READ });
      return;
    }
    try {
      // The read stops with the time for documents (the reader honours the signal): finish() is never
      // held past it by a read in flight.
      const read = await reader(got.bytes, { limits: pdfLimits, details: !!opts.onDocument, signal: abort.signal });
      const modified = read.modified ?? got.lastModified;
      keep(e, { checks: read.checks, ...(modified ? { modified } : {}), size: got.bytes.length, ...(got.fileName ? { fileName: got.fileName } : {}) });
      if (read.details) notifyDocument(e, read.checks, got.bytes, { ...read.details, ...(got.lastModified ? { lastModified: got.lastModified } : {}) });
    } catch (err) {
      if (abort.signal.aborted) {
        e.notChecked = TIME_LIMIT_REACHED; // stopped with the time for documents: nothing known, nothing kept
        return;
      }
      const x = err instanceof PdfCheckError ? err : new PdfCheckError('Could not read the PDF');
      // A reader that could not answer at all (not set up): said, not kept; a later run asks again.
      if (x.again) e.error = x.message;
      else keep(e, { error: x.message, ...(x.blocksAssistiveTech ? { checks: { pages: 0, pagesChecked: 0, blocksAssistiveTech: true } } : {}) });
    }
  }

  /**
   * The AI document review on a run that took PDFs from the store (`onDocument`): their bytes were not
   * kept, so the stored PDFs are walked in the review's own order (fillable forms, then the most recently
   * changed, then the address), and each that fits the review's caps (`aiRefetch`: pages, bytes) is
   * downloaded and read again, one at a time, until `sample` of them are handed over or the time ends.
   * A PDF over a cap takes no place in the review's sample, so the walk goes on past it, as the review
   * would: the review then chooses from the same PDFs as on one uninterrupted run.
   */
  async function refetchForReview(): Promise<void> {
    if (!opts.onDocument) return;
    const want = opts.aiRefetch ?? AI_REFETCH_DEFAULT;
    const fromStore = [...entries.values()].filter((e) => e.reused && e.checks && !e.error && e.type === 'pdf' && (e.checks.pages ?? 0) > 0);
    fromStore.sort((a, b) => reviewOrder(a) - reviewOrder(b) || dateDesc(a, b) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
    let handed = 0;
    for (const e of fromStore) {
      if (handed >= Math.max(0, want.sample) || abort.signal.aborted) return;
      if ((e.checks!.pages ?? 0) > want.maxPages || (e.size ?? 0) > want.maxBytes) continue;
      await parser.run('pdf', async () => {
        const got = await fetchPdf(e.url);
        if (!got || !('bytes' in got) || abort.signal.aborted || got.bytes.length > want.maxBytes) return;
        try {
          const read = await reader(got.bytes, { limits: pdfLimits, details: true, signal: abort.signal });
          if (read.details) {
            notifyDocument(e, e.checks!, got.bytes, { ...read.details, ...(got.lastModified ? { lastModified: got.lastModified } : {}) });
            handed++;
          }
        } catch {
          // Not read this time: the review goes on without it, and the walk to the next one.
        }
      });
    }
  }

  /** Hands a checked PDF to the AI review hook. A snapshot, so later link updates never race it. */
  function notifyDocument(e: Entry, checks: PdfChecks, bytes: Uint8Array, details: PdfDetails): void {
    try {
      // Batch 18: the link's words and an accessible version found beside it go to the AI review only (never the report).
      opts.onDocument?.({
        url: e.url, type: e.type, detectedBy: e.detectedBy, linkedFrom: [...e.linkedFrom], checks,
        ...(e.link ? { linkText: e.link.text, ...(e.link.nearby ? { linkNearby: e.link.nearby } : {}) } : {}),
        ...(e.accessibleAlternative ? { accessibleAlternative: e.accessibleAlternative } : {}),
      }, bytes, details);
    } catch {
      // The AI review is an extra; it never breaks the inventory.
    }
  }

  async function allocator(): Promise<void> {
    for (let i = 0; ; ) {
      if (i < queue.length) {
        const e = queue[i++]!;
        await e.settled;
        allocate(e);
      } else if (closed) {
        return;
      } else {
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    }
  }
  const allocating = allocator().catch(() => {});

  return {
    pdfs: () => ({ done: pdfsDone, started: pdfsStarted }),
    found: () => {
      let n = 0;
      for (const e of entries.values()) if (e.verdict === 'document') n++;
      return n;
    },
    addPage(index, page) {
      try {
        buffered.set(index, page);
        while (buffered.has(nextIndex)) {
          const p = buffered.get(nextIndex)!;
          buffered.delete(nextIndex++);
          processPage(p);
        }
      } catch {
        // The inventory is an extra; it never breaks the page audits.
      }
    },

    async finish(extra = {}) {
      for (const i of [...buffered.keys()].sort((a, b) => a - b)) processPage(buffered.get(i)!);
      buffered.clear();
      // Sitemap documents come last, so linked documents get the PDF check slots first.
      for (const url of extra.documents ?? []) {
        const c = classifyLink({ href: url, text: '' });
        if (c.verdict === 'document' && !entries.has(c.url)) {
          const e: Entry = { url: c.url, verdict: 'document', type: c.type, detectedBy: c.detectedBy!, linkedFrom: [], settled: Promise.resolve() };
          entries.set(c.url, e);
          enqueue(e);
        }
      }
      closed = true;
      wake?.();
      const timer = setTimeout(() => abort.abort(), Math.max(0, Math.min(lim.tailMs, extra.by === undefined ? Infinity : extra.by - Date.now())));
      try {
        await allocating;
        // Verdicts that changed after their turn (a failed page that is a document) get a late slot.
        await Promise.all([...entries.values()].map((e) => e.settled));
        for (const e of entries.values()) allocate(e);
        await Promise.all(running);
        await refetchForReview();
      } finally {
        clearTimeout(timer);
      }

      for (const { url, result: answer } of pageProbes) pageAnswers.set(url, await answer);
      return result(new Map());
    },

    snapshot() {
      // Nothing here waits or changes the inventory: the outcomes so far, and what each other document
      // would have been given, from the store when it has the PDF's outcome.
      const view = new Map<Entry, Partial<Entry>>();
      let started = pdfsStarted;
      let officeNow = officeStarted;
      const seen = new Set<Entry>();
      for (const e of queue) {
        if (seen.has(e)) continue;
        seen.add(e);
        if (e.verdict !== 'document') continue;
        if (e.allocated) {
          if (!e.checks && !e.officeChecks && !e.error && !e.notChecked) view.set(e, { notChecked: TIME_LIMIT_REACHED }); // still running
          continue;
        }
        if (!enabled || e.detectedBy === 'host') {
          view.set(e, { notChecked: !enabled ? 'Document checks were turned off for this scan' : 'Kept on a document service, so it was not downloaded' });
          continue;
        }
        if (actionLike(e.url)) {
          view.set(e, { notChecked: ACTION_SKIP_REASON });
          continue;
        }
        if (e.type !== 'pdf') {
          // An Office file: what its turn would have given it (its own cap), from the store when it has one.
          const refused = officeRefusal(e, officeNow);
          if (refused) {
            view.set(e, { notChecked: refused });
            continue;
          }
          officeNow++;
          const known = store ? kept(() => store.get(e.url)) : undefined;
          if (known?.notDocument) view.set(e, { verdict: 'no' });
          else if (known) view.set(e, { ...(known.officeChecks ? { officeChecks: known.officeChecks } : {}), ...(known.error ? { error: known.error } : {}), ...(known.notChecked ? { notChecked: known.notChecked } : {}) });
          else view.set(e, { notChecked: TIME_LIMIT_REACHED });
          continue;
        }
        if (!robotsOk(e.url)) {
          view.set(e, { notChecked: 'Blocked by robots.txt' });
          continue;
        }
        if (started >= lim.maxPdfs) {
          view.set(e, { notChecked: `Limit reached (${lim.maxPdfs.toLocaleString('en-US')} PDFs per scan)` });
          continue;
        }
        started++;
        const known = store ? kept(() => store.get(e.url)) : undefined;
        if (known?.notDocument) view.set(e, { verdict: 'no' });
        else if (known) view.set(e, { ...(known.checks ? { checks: known.checks } : {}), ...(known.error ? { error: known.error } : {}) });
        else view.set(e, { notChecked: TIME_LIMIT_REACHED });
      }
      return result(view);
    },
  };

  /** The inventory from the entries (with `view`'s overrides) and the page probes answered so far. */
  function result(view: Map<Entry, Partial<Entry>>): InventoryResult {
    const notPages: InventoryResult['notPages'] = [];
    for (const { url } of pageProbes) {
      const r = pageAnswers.get(url);
      if (r?.kind === 'document') notPages.push({ url, reason: `Not a web page: a ${TYPE_NAMES[r.type]} file, listed under Documents` });
      else if (r?.kind === 'other') notPages.push({ url, reason: 'Not a web page' });
    }
    const docs = [...entries.values()].map((e) => ({ ...e, ...view.get(e) } as Entry)).filter((e) => e.verdict === 'document')
      .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
    return {
      documents: docs.map((e) => e.url),
      checks: docs.map((e) => ({
        url: e.url, type: e.type, detectedBy: e.detectedBy, linkedFrom: [...e.linkedFrom],
        ...(e.checks ? { checks: e.checks } : {}),
        ...(e.officeChecks ? { officeChecks: e.officeChecks } : {}),
        ...(e.error ? { error: e.error } : {}),
        ...(e.notChecked ? { notChecked: e.notChecked } : {}),
        ...(e.accessibleAlternative ? { accessibleAlternative: e.accessibleAlternative } : {}),
        // Batch 19: the words people know it by (a /download/<token> address says nothing).
        ...(e.link?.text ? { linkText: e.link.text.replace(/\s+/g, ' ').trim().slice(0, 160) } : {}),
        ...(e.fileName ? { fileName: e.fileName } : {}),
      })),
      notPages,
      stats: { probes, pdfsChecked: docs.filter((e) => e.checks && !e.error).length, officeChecked: docs.filter((e) => e.officeChecks && !e.error).length },
    };
  }
}

/** The address's file extension, lower case ('' when none). */
function extensionOf(url: string): string {
  try {
    return /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? '';
  } catch {
    return '';
  }
}
