// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 19, first-run correctness: documents served from addresses like /download/<token> could not be told apart:
// the report kept only the address. A document now keeps its link's words, the file name the server gives it
// (Content-Disposition) and the PDF's own title, and the plain HTML report and both fix briefs show them.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixPrompt } from '../../src/report/fixPrompt.js';
import { renderPlainHtml } from '../../src/report/plain.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, DocumentCheck, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';
import { titledPdf, untaggedPdf } from '../helpers/pdfs.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let report: SiteReport;

beforeAll(async () => {
  server = await startFixtureServer('b19-docs', {
    '/download/x7f3': { type: 'application/pdf', body: await untaggedPdf(), headers: { 'content-disposition': 'attachment; filename="budget-2026-27.pdf"' } },
    '/download/k2p9': { type: 'application/pdf', body: await titledPdf() },
  });
  browser = await chromium.launch();
  report = await scanSite(`${server.origin}/`, { browser: browser as unknown as BrowserLike, maxPages: 1, probes: [] });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const doc = (path: string): DocumentCheck => report.documentChecks!.find((d) => d.url === `${server.origin}${path}`)!;

describe('documents keep the words people know them by', () => {
  it('the link text, the file name the server gives, and the PDF title', () => {
    expect(doc('/download/x7f3')).toMatchObject({ linkText: 'Budget 2026-27 (PDF)', fileName: 'budget-2026-27.pdf' });
    expect(doc('/download/k2p9').linkText).toBe('Minutes');
    expect(doc('/download/k2p9').checks?.title).toBe('Board minutes, October');
  });
  it('the plain HTML report and both fix briefs name each document', () => {
    const html = renderPlainHtml(report);
    expect(html).toContain('Budget 2026-27 (PDF)');
    expect(html).toContain('budget-2026-27.pdf');
    expect(html).toContain('Board minutes, October');
    for (const audience of ['developer', 'content'] as const) {
      const brief = fixPrompt(report, { audience });
      if (!brief.includes('document: ')) continue;
      expect(brief, audience).toContain('link text: Budget 2026-27 (PDF)');
      expect(brief, audience).toContain('file name: budget-2026-27.pdf');
      expect(brief, audience).toContain('PDF title: Board minutes, October');
    }
    expect(fixPrompt(report, { audience: 'content' })).toContain('document: ');
  });
});
