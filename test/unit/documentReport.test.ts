// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { buildReport } from '../../src/report/build.js';
import { documentsLine } from '../../src/report/documents.js';
import { renderTerminal } from '../../src/report/terminal.js';
import type { DocumentCheck, PageAudit } from '../../src/types.js';

const hostile = '<script>alert(1)</script>';
const pages: PageAudit[] = [{ url: 'https://e.org/', status: 'ok', rules: { 'image-alt': 'pass' }, violations: [], incomplete: [], links: [] }];
const checks: DocumentCheck[] = [
  { url: `https://e.org/a.pdf?q=${encodeURIComponent(hostile)}`, type: 'pdf', detectedBy: 'extension', linkedFrom: ['https://e.org/', 'https://e.org/b', 'https://e.org/c'],
    checks: { pages: 40, pagesChecked: 20, tagged: false, hasLanguage: false, hasTitle: true, showsTitle: false, imageOnly: false, figuresWithoutAlt: 2, untitledFormFields: 1 } },
  { url: 'https://e.org/download/0a1b', type: 'pdf', detectedBy: 'probe', linkedFrom: ['https://e.org/'],
    checks: { pages: 1, pagesChecked: 1, tagged: true, hasLanguage: true, hasTitle: true, showsTitle: true, imageOnly: false, figuresWithoutAlt: 0 } },
  { url: 'https://e.org/view/0a1b', type: 'pdf', detectedBy: 'text', linkedFrom: [], error: `Could not download it (HTTP 404) ${hostile}` },
  { url: 'https://e.org/locked', type: 'pdf', detectedBy: 'attribute', linkedFrom: [], error: 'Needs a password to open', checks: { pages: 0, pagesChecked: 0, blocksAssistiveTech: true } },
  { url: 'https://e.org/z.pdf', type: 'pdf', detectedBy: 'extension', linkedFrom: [], notChecked: 'Limit reached (10 PDFs per scan)' },
  { url: 'https://e.org/m.docx', type: 'word', detectedBy: 'extension', linkedFrom: [], notChecked: 'Only PDFs are checked in this version' },
  { url: 'javascript:alert(1)', type: 'other', detectedBy: 'host', linkedFrom: [], notChecked: hostile },
];
const report = buildReport({
  site: 'https://e.org/', pages, documents: checks.map((c) => c.url), documentChecks: checks, skipped: [],
  startedAt: '2026-10-31T00:00:00.000Z', finishedAt: '2026-10-31T00:01:00.000Z', userAgent: 'UA',
});

describe('documents in the report', () => {

  it('keeps the plain URL list and adds the checks, sorted; the checked PDFs with problems are scored (v7)', () => {
    expect(report.documents).toHaveLength(7);
    expect(report.documentChecks!.map((c) => c.url)).toEqual([...checks.map((c) => c.url)].sort());
    // 3 PDFs read (the password-locked one included), 2 with problems: 4 × √(2/3) = 3.27 → 95.
    expect(report.documentScore).toEqual({ scored: true, checked: 3, failed: 2, pointsLost: 5 });
    expect(report.score).toBe(95);
  });

  it('summarises documents in the terminal', () => {
    expect(documentsLine(report)).toBe('7 documents found (3 checked, 2 with problems)');
    expect(renderTerminal(report)).toContain('1/1 page scanned · 7 documents found (3 checked, 2 with problems)');
  });
});
