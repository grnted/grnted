// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The document checks on their own, for a long scan's host (hosted 250-page and whole-site tiers): once
// every page is audited and stored, the PDFs its pages link to are checked in their own runs, bounded in
// time, before the run that writes the report. No browser: the inventory reads the stored pages' links,
// as the scan would, in page order, so the same PDFs get the same check slots. Each PDF's outcome goes
// to the host's store as it ends; the next run (and the report's) takes it from there, so a run that
// stops, or an isolate that restarts, never checks a PDF twice. Polite like the scan: robots.txt (its
// rules and Crawl-delay), the site's pace, one PDF at a time. Engine core: no Node-only imports.
import { readRobots } from '../crawl.js';
import { lastBrowserUserAgent } from '../userAgent.js';
import { createPace } from '../pace.js';
import type { PageAudit } from '../types.js';
import { normalizeUrl } from '../url.js';
import { createDocumentInventory, type DocumentOptions, type DocumentStore, type InventoryResult } from './index.js';
import { TIME_LIMIT_REACHED, type PdfReader } from './pdf.js';

export interface DocumentRunOptions {
  userAgent?: string;
  fetchFn?: typeof fetch;
  /** Hosted safety: every request and redirect target must pass. */
  allowUrl?: (url: string) => Promise<boolean>;
  /** The scan's page list length; `page(i)` is page i's stored audit (undefined: none). */
  pages: number;
  page(index: number): PageAudit | undefined;
  /** Documents the sitemaps listed (they get check slots after the linked ones, as in the scan). */
  documents: readonly string[];
  /** The scan's document limits (`maxPdfs`: the plan's). */
  limits?: Omit<DocumentOptions, 'tailMs'>;
  store: DocumentStore;
  /** Reads one PDF (default: in this thread). The hosted checker reads in its PDF reader Worker. */
  readPdf?: PdfReader;
  /** Epoch ms: no new PDF starts after this, and the run ends by it. */
  by: number;
  /** Pages at once, as for the scan's pages (the pace's ceiling and where it starts). */
  concurrency?: number;
  startConcurrency?: number;
  /** The site slowed the scan down (a limit of this many at once stays). */
  hold?: number;
  /** Each PDF check ended (checked, failed or out of time): ended so far and started so far. */
  onPdfDone?: (counts: { done: number; started: number }) => void;
}

export interface DocumentRunResult {
  /** PDFs given a check slot (within `maxPdfs`), from earlier runs and this one. */
  pdfs: number;
  /** Of those, the ones with no outcome yet: the time ran out before them. */
  left: number;
  /**
   * The inventory as the report would list it now (documents, each one's checks or why not, the selected
   * pages that are documents): a host keeps it, so a report built from storage has the same documents.
   */
  inventory: InventoryResult;
}

/** Checks the PDFs of a long scan's stored pages until they are all done or `by` comes. */
export async function checkDocuments(site: string, o: DocumentRunOptions): Promise<DocumentRunResult> {
  const start = normalizeUrl(site);
  if (!start) throw new Error(`Invalid URL: ${site}`);
  // Fetch-only (no browser here): the last browser's own User-Agent with the token, never a made-up version.
  const userAgent = o.userAgent ?? lastBrowserUserAgent();
  const concurrency = Math.min(Math.max(Math.floor(o.concurrency ?? 4), 1), 16);
  const pace = createPace({ concurrency, start: Math.min(concurrency, Math.max(1, Math.floor(o.startConcurrency ?? concurrency))), deadline: o.by });
  try {
    if (o.hold !== undefined && o.hold >= 1) pace.hold(Math.floor(o.hold));
    // robots.txt again for its rules and its Crawl-delay (given to the pace), as a resumed scan does.
    const robots = await readRobots(new URL(start).origin, { userAgent, fetchFn: o.fetchFn, allowUrl: o.allowUrl, pace });
    const inv = createDocumentInventory({
      site: start, userAgent, fetchFn: o.fetchFn, allowUrl: o.allowUrl, isAllowed: robots.isAllowed, pace, store: o.store,
      documents: { ...o.limits, tailMs: Math.max(0, o.by - Date.now()) },
      ...(o.readPdf ? { readPdf: o.readPdf } : {}),
      ...(o.onPdfDone ? { onPdfDone: o.onPdfDone } : {}),
    });
    // One stored page at a time, in page order: only its document links stay in memory (a page with no
    // stored audit takes its place empty, so the pages after it are not held back).
    for (let i = 0; i < o.pages; i++) inv.addPage(i, o.page(i) ?? { url: '', status: 'failed', rules: {}, violations: [], incomplete: [], links: [] });
    const r = await inv.finish({ documents: [...o.documents], by: o.by });
    return { pdfs: inv.pdfs().started, left: r.checks.filter((c) => c.notChecked === TIME_LIMIT_REACHED).length, inventory: r };
  } finally {
    pace.stop();
  }
}
