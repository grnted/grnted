// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { criterionScore, pageReportFor, reportCriterionChecks } from '../../src/criterionScore.js';
import { roundScore } from '../../src/scoreCore.js';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderTerminal } from '../../src/report/terminal.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, DocumentCheck, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';
import { brokenDocx } from '../helpers/office.js';
import { NO_COPY_PERMISSIONS, encryptedPdf, formPdf, imageOnlyPdf, structuredPdf, taggedPdf, titledPdf, untaggedPdf } from '../helpers/pdfs.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let report: SiteReport;
let withoutChecks: SiteReport;
const requested: string[] = [];
const timings: Record<string, number> = {};

// Every request the scan makes outside the browser (robots, sitemap, probes, PDF downloads).
const recordingFetch = ((input: string | URL | Request, init?: RequestInit) => {
  requested.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
  return fetch(input, init);
}) as typeof fetch;

const html = (title: string) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1></main></body></html>`;

beforeAll(async () => {
  server = await startFixtureServer('docs', {
    // Extensionless CMS downloads, as some school sites serve them.
    '/download/abc123': { type: 'application/pdf', body: await untaggedPdf() },
    '/view/abc123': { type: 'application/octet-stream', body: await titledPdf() },
    '/download/def456': { type: 'application/octet-stream', body: await imageOnlyPdf() },
    '/files/tagged': { type: 'application/pdf', body: await taggedPdf() },
    '/forms/enroll.pdf': { type: 'application/pdf', body: await formPdf() },
    '/locked.pdf': { type: 'application/pdf', body: encryptedPdf(NO_COPY_PERMISSIONS) },
    '/minutes.docx': { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: brokenDocx() },
    '/download/app': { type: 'text/html; charset=utf-8', body: html('Get our app') },
    '/docs/pdf-help': { type: 'text/html; charset=utf-8', body: html('Opening PDFs') },
    '/private/download/secret': { type: 'application/pdf', body: await untaggedPdf() },
    // An original and the version the site labels accessible, linked side by side.
    '/board/calendar.pdf': { type: 'application/pdf', body: await untaggedPdf() },
    '/board/calendar-accessible.pdf': {
      type: 'application/pdf',
      body: await structuredPdf({ title: 'School calendar', lang: 'en-US', pages: [[{ tag: 'H1', text: 'School calendar' }, { tag: 'P', text: 'First day: September 2.' }]] }),
    },
  });
  browser = await chromium.launch();
  // Three addresses: the home page and the two it links to as pages (one turns out to be a document). With room
  // for more, discovery would read the resources page for further links (crawl.ts `deepen`) and take its other
  // extensionless download for a page too, which the tests below leave to the document probe.
  const opts = { browser: browser as unknown as BrowserLike, maxPages: 3, fetchFn: recordingFetch };
  let t = Date.now();
  withoutChecks = await scanSite(`${server.origin}/`, { ...opts, documents: false });
  timings.off = Date.now() - t;
  requested.length = 0;
  t = Date.now();
  report = await scanSite(`${server.origin}/`, opts);
  timings.on = Date.now() - t;
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const byPath = (r: SiteReport): Record<string, DocumentCheck> =>
  Object.fromEntries(r.documentChecks!.map((d) => [d.url.startsWith(server.origin) ? new URL(d.url).pathname : d.url, d]));

describe('documents: scan of the docs fixture', () => {
  it('finds extensionless documents with the right type and how they were found', () => {
    const docs = byPath(report);
    expect(Object.keys(docs)).toEqual([
      '/board/calendar-accessible.pdf', '/board/calendar.pdf',
      '/download/abc123', '/download/def456', '/files/tagged', '/forms/enroll.pdf', '/locked.pdf', '/minutes.docx', '/old/agenda.pdf', '/view/abc123',
      'https://docs.google.com/document/d/fixture-doc/edit',
    ]);
    expect(report.documents).toEqual(report.documentChecks!.map((d) => d.url));
    const how = Object.fromEntries(Object.entries(docs).map(([k, d]) => [k, `${d.type}/${d.detectedBy}`]));
    expect(how).toEqual({
      '/board/calendar-accessible.pdf': 'pdf/extension', '/board/calendar.pdf': 'pdf/extension',
      '/download/abc123': 'pdf/probe', '/download/def456': 'pdf/probe', '/files/tagged': 'pdf/attribute', '/forms/enroll.pdf': 'pdf/extension',
      '/locked.pdf': 'pdf/extension', '/minutes.docx': 'word/extension', '/old/agenda.pdf': 'pdf/extension', '/view/abc123': 'pdf/text',
      'https://docs.google.com/document/d/fixture-doc/edit': 'word/host',
    });
    expect(docs['/download/abc123']!.linkedFrom).toEqual([`${server.origin}/`, `${server.origin}/resources.html`]);
  });

  it('gets structure results for each PDF', () => {
    const docs = byPath(report);
    expect(docs['/download/abc123']!.checks).toMatchObject({ tagged: false, hasLanguage: false, hasTitle: false, imageOnly: false });
    expect(docs['/view/abc123']!.checks).toMatchObject({ tagged: false, hasLanguage: true, hasTitle: true, showsTitle: true });
    expect(docs['/download/def456']!.checks).toMatchObject({ imageOnly: true });
    expect(docs['/files/tagged']!.checks).toMatchObject({ tagged: true, figuresWithoutAlt: 1 });
    expect(docs['/forms/enroll.pdf']!.checks).toMatchObject({ xfa: true, formFields: 3, untitledFormFields: 2 });
    expect(docs['/locked.pdf']!.checks).toMatchObject({ blocksAssistiveTech: true });
    expect(docs['/old/agenda.pdf']).toMatchObject({ error: 'Could not download it (HTTP 404)' });
    // Office files get their own quick checks (never scored).
    expect(docs['/minutes.docx']).toMatchObject({ officeChecks: { format: 'docx', hasTitle: false, imagesWithoutAlt: 2, tablesWithoutHeader: 1 } });
    expect(docs['/minutes.docx']).not.toHaveProperty('checks');
    expect(docs['https://docs.google.com/document/d/fixture-doc/edit']).toMatchObject({ notChecked: 'Kept on a document service, so it was not downloaded' });
  });

  it('drops links that turn out to be web pages and never asks about robots-blocked ones', () => {
    expect(report.documents.some((d) => /\/download\/app|\/docs\/pdf-help|\/private\//.test(d))).toBe(false);
    expect(requested.filter((r) => r.includes('/private/'))).toEqual([]);
    expect(requested).toContain('HEAD /download/app');
    expect(requested).toContain('GET /docs/pdf-help');
    expect(requested.some((r) => r.includes('docs.google.com'))).toBe(false);
    expect(requested.filter((r) => r.includes('/minutes.docx'))).toEqual(['GET /minutes.docx']);
  });

  it('moves the extensionless document picked as a page out of the pages, so page scoring is unaffected', () => {
    // The document is not a page; each page scores its own results (v8): / is clean, /resources.html has
    // the one cross-page finding (2.4.5, attributed to it). No PDF is part of a page's score.
    expect(report.pages.map((p) => [new URL(p.url).pathname, p.status])).toEqual([['/', 'ok'], ['/resources.html', 'ok']]);
    expect(report.pages[0]!.score).toBe(100);
    expect(report.pages[1]!.score).toBe(roundScore(criterionScore(reportCriterionChecks(pageReportFor(report, report.pages[1]!.url))!)));
    expect(reportCriterionChecks(pageReportFor(report, report.pages[1]!.url))!.map((c) => c.key)).toEqual(['consistency:2.4.5']);
    expect(report.skipped).toEqual([{ url: `${server.origin}/download/abc123`, reason: 'Not a web page: a PDF file, listed under Documents' }]);
    expect(report.meta.pageList).not.toContain(`${server.origin}/download/abc123`);
    // Scoring v7: the pages are clean, the checked PDFs with problems are the one failing check (documents
    // alone keep Access Granted). Without PDF checks nothing is scored for documents.
    expect(report.documentScore).toMatchObject({ scored: true });
    expect(report.documentScore!.failed).toBeGreaterThan(0);
    // Scoring v10: the Word file the quick checks read is one more document in the same share.
    expect(report.documentScore).toMatchObject({ checked: 9, failed: 8 });
    expect([report.status, report.headline]).toEqual(['scored', 'Access Granted']);
    // Scoring v8 also scores the cross-page rules (this fixture's two pages); documents alone cost at most 4.
    const keys = reportCriterionChecks(report)!.map((c) => c.key);
    expect(keys.filter((k) => !k.startsWith('consistency:'))).toEqual(['documents']);
    expect(report.score).toBeGreaterThanOrEqual(90);
    // Without the move this would be "Scan incomplete": only 2 of 3 selected pages loaded.
    // Nothing scored for documents then; the cross-page rules still count (scoring v8).
    expect(reportCriterionChecks(withoutChecks)!.filter((c) => !c.key.startsWith('consistency:'))).toEqual([]);
    expect(withoutChecks.status).toBe(report.status);
    expect(withoutChecks.pages.map((p) => p.url)).toEqual(report.pages.map((p) => p.url));
  });

  it('with documents: false, lists only what links show and checks nothing', () => {
    const docs = byPath(withoutChecks);
    expect(Object.values(docs).every((d) => !d.checks && d.notChecked === 'Document checks were turned off for this scan')).toBe(true);
    expect(Object.keys(docs)).toContain('/download/abc123'); // the page that is a document
    expect(Object.keys(docs)).not.toContain('/download/def456'); // only a probe could tell
  });

  it('summarises documents in the terminal', () => {
    expect(renderTerminal(report)).toContain('2/2 pages scanned · 11 documents found (8 PDFs checked, 7 with problems; 1 Office file checked, 1 with problems)');
    // eslint-disable-next-line no-console
    console.log(`docs fixture scan: ${timings.on} ms with document checks, ${timings.off} ms with documents: false`);
  });
});
