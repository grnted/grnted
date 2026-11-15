// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import {
  classifyHeaders, classifyLink, dispositionFileName, formatInText, isDocumentHost, sniffBytes, typeFromMime,
} from '../../src/documents/detect.js';
import type { DocumentLink } from '../../src/types.js';
import { isDocumentUrl } from '../../src/url.js';

const SITE = 'https://www.district.example/resources';
const cls = (link: Partial<DocumentLink> & { href: string }) => {
  const c = classifyLink({ text: '', ...link }, SITE);
  return [c.verdict, c.type, c.detectedBy ?? null];
};

describe('classifyLink: the detection pipeline', () => {
  it('1. file extension decides at once, query and fragment ignored', () => {
    expect(cls({ href: '/board/packet.PDF?v=2#page=3' })).toEqual(['document', 'pdf', 'extension']);
    expect(cls({ href: '/menu.docx' })).toEqual(['document', 'word', 'extension']);
    expect(cls({ href: '/budget.xlsx' })).toEqual(['document', 'excel', 'extension']);
    expect(cls({ href: '/slides.pptx' })).toEqual(['document', 'powerpoint', 'extension']);
    expect(cls({ href: '/notes.odt' })).toEqual(['document', 'word', 'extension']);
    expect(cls({ href: '/letter.rtf' })).toEqual(['document', 'word', 'extension']);
    expect(isDocumentUrl('https://e.org/notes.ODS')).toBe(true);
  });

  it('known non-document files are never documents, whatever the text says', () => {
    expect(cls({ href: '/photo.jpg', text: 'Download photo (PDF)' })).toEqual(['no', 'other', null]);
    expect(cls({ href: '/archive.zip', text: 'Download all' })).toEqual(['no', 'other', null]);
    expect(cls({ href: 'mailto:office@e.org', text: 'PDF' })).toEqual(['no', 'other', null]);
  });

  it('2. a document type attribute or a download attribute naming a document', () => {
    expect(cls({ href: '/files/tagged', type: 'application/pdf' })).toEqual(['document', 'pdf', 'attribute']);
    expect(cls({ href: '/x', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).toEqual(['document', 'excel', 'attribute']);
    expect(cls({ href: '/get?id=7', download: 'Agenda Oct.docx' })).toEqual(['document', 'word', 'attribute']);
    expect(cls({ href: '/get?id=8', download: 'photo.jpg' })).toEqual(['no', 'other', null]);
    // A bare download attribute is only a hint.
    expect(cls({ href: '/get?id=9', download: '' })).toEqual(['maybe', 'other', 'attribute']);
  });

  it('3. text naming a format or a download gives "maybe"', () => {
    expect(cls({ href: '/agenda', text: 'October agenda (PDF, 2 MB)' })).toEqual(['maybe', 'pdf', 'text']);
    expect(cls({ href: '/minutes', text: 'Minutes', nearby: 'Minutes (Word document, 30 KB)' })).toEqual(['maybe', 'word', 'text']);
    expect(cls({ href: '/handbook', text: 'Download the handbook' })).toEqual(['maybe', 'other', 'text']);
    expect(cls({ href: '/x', text: 'View original' })).toEqual(['maybe', 'other', 'text']);
  });

  it('ordinary words are not formats', () => {
    for (const text of ['A word from the principal', 'Students excel in math', 'Password help', 'Our docs team', 'Keyword search']) {
      expect(formatInText(text), text).toBeUndefined();
    }
    expect(formatInText('Budget (Excel)')).toBe('excel');
    expect(formatInText('Slides in PowerPoint')).toBe('powerpoint');
    expect(formatInText('Form (DOCX)')).toBe('word');
  });

  it('4. document services: a shared file is a document, a folder is not', () => {
    expect(cls({ href: 'https://docs.google.com/document/d/abc123/edit' })).toEqual(['document', 'word', 'host']);
    expect(cls({ href: 'https://docs.google.com/spreadsheets/d/abc/edit#gid=0' })).toEqual(['document', 'excel', 'host']);
    expect(cls({ href: 'https://docs.google.com/presentation/d/abc/pub' })).toEqual(['document', 'powerpoint', 'host']);
    expect(cls({ href: 'https://drive.google.com/file/d/abc/view', text: 'Calendar (PDF)' })).toEqual(['document', 'pdf', 'host']);
    expect(cls({ href: 'https://drive.google.com/drive/folders/abc' })).toEqual(['no', 'other', null]);
    expect(cls({ href: 'https://app.box.com/s/k3y' })).toEqual(['document', 'other', 'host']);
    expect(cls({ href: 'https://www.dropbox.com/scl/fi/abc/report?rlkey=x' })).toEqual(['document', 'other', 'host']);
    expect(cls({ href: 'https://www.dropbox.com/scl/fo/abc/folder' })).toEqual(['no', 'other', null]);
    expect(cls({ href: 'https://contoso.sharepoint.com/:b:/s/site/EaBc' })).toEqual(['document', 'pdf', 'host']);
    expect(cls({ href: 'https://contoso.sharepoint.com/:w:/s/site/EaBc' })).toEqual(['document', 'word', 'host']);
    expect(cls({ href: 'https://contoso.sharepoint.com/:f:/s/site/EaBc' })).toEqual(['no', 'other', null]);
    expect(cls({ href: 'https://1drv.ms/x/s!abc' })).toEqual(['document', 'excel', 'host']);
    // Anything else on a document service is only a hint.
    expect(cls({ href: 'https://contoso.sharepoint.com/sites/hr' })).toEqual(['maybe', 'other', 'host']);
    expect(isDocumentHost('https://docs.google.com/forms/d/x')).toBe(true);
  });

  it('4. CMS download paths give "maybe" on their own', () => {
    expect(cls({ href: '/download/9f8e7d' })).toEqual(['maybe', 'other', 'host']);
    expect(cls({ href: '/fs/resource-manager/view/6a1b' })).toEqual(['maybe', 'other', 'host']);
    expect(cls({ href: '/DocumentCenter/View/123/Budget' })).toEqual(['maybe', 'other', 'host']);
    expect(cls({ href: '/getfile.php?name=agenda.pdf' })).toEqual(['maybe', 'other', 'host']);
    // The listing page itself is not a download path.
    expect(cls({ href: '/documents' })).toEqual(['no', 'other', null]);
    expect(cls({ href: '/about-us' })).toEqual(['no', 'other', null]);
  });

  it('text naming a format plus a download path is strong enough without a probe', () => {
    // The real-world case: an extensionless CMS link whose text names the format.
    expect(cls({ href: '/view/0a1b2c3d', text: 'View original PDF — English' })).toEqual(['document', 'pdf', 'text']);
    expect(classifyLink({ href: '/download/0a1b2c3d', text: 'Download original document — English' }, SITE))
      .toMatchObject({ url: 'https://www.district.example/download/0a1b2c3d', verdict: 'maybe', detectedBy: 'text', addressHint: true });
    // A format named only nearby is not strong enough.
    expect(cls({ href: '/download/0a1b', text: 'Agenda', nearby: 'Agenda (PDF)' })).toEqual(['maybe', 'pdf', 'text']);
  });

  it('normalizes the URL (fragment and tracking parameters removed)', () => {
    expect(classifyLink({ href: '/a.pdf?utm_source=x#p2', text: '' }, SITE).url).toBe('https://www.district.example/a.pdf');
  });
});

describe('headers and magic bytes', () => {
  const bytes = (s: string | number[]) => (typeof s === 'string' ? new TextEncoder().encode(s) : new Uint8Array(s));
  const zip = (...names: string[]) => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytes(`\0\0\0\0${names.join('\0\0PK\x03\x04')}`)]);

  it('maps MIME types and Content-Disposition file names', () => {
    expect(typeFromMime('application/pdf; charset=binary')).toBe('pdf');
    expect(typeFromMime('application/vnd.ms-powerpoint.presentation.macroEnabled.12')).toBe('powerpoint');
    expect(typeFromMime('text/html')).toBeUndefined();
    expect(dispositionFileName('attachment; filename="Board Packet.pdf"')).toBe('Board Packet.pdf');
    expect(dispositionFileName("attachment; filename*=UTF-8''Men%C3%BC%20Oct.docx; filename=menu.docx")).toBe('Menü Oct.docx');
    expect(classifyHeaders('application/octet-stream', 'attachment; filename=a.xlsx')).toEqual({ kind: 'document', type: 'excel' });
    expect(classifyHeaders('application/octet-stream')).toEqual({ kind: 'unknown' });
    expect(classifyHeaders('text/html; charset=utf-8')).toEqual({ kind: 'html' });
    expect(classifyHeaders('image/png')).toEqual({ kind: 'other' });
  });

  it('sniffs PDF, OOXML, OpenDocument, legacy Office and RTF', () => {
    expect(sniffBytes(bytes('%PDF-1.7\n'))).toEqual({ kind: 'document', type: 'pdf' });
    expect(sniffBytes(bytes('\n\n  junk %PDF-1.4'))).toEqual({ kind: 'document', type: 'pdf' });
    expect(sniffBytes(zip('[Content_Types].xml', '_rels/.rels', 'word/document.xml'))).toEqual({ kind: 'document', type: 'word' });
    expect(sniffBytes(zip('[Content_Types].xml', 'xl/workbook.xml'))).toEqual({ kind: 'document', type: 'excel' });
    expect(sniffBytes(zip('[Content_Types].xml', 'ppt/presentation.xml'))).toEqual({ kind: 'document', type: 'powerpoint' });
    expect(sniffBytes(zip('[Content_Types].xml'))).toEqual({ kind: 'document', type: 'other' });
    expect(sniffBytes(zip('mimetypeapplication/vnd.oasis.opendocument.spreadsheet'))).toEqual({ kind: 'document', type: 'excel' });
    expect(sniffBytes(zip('photos/1.jpg'))).toEqual({ kind: 'other' });
    expect(sniffBytes(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]), 'application/msword')).toEqual({ kind: 'document', type: 'word' });
    expect(sniffBytes(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))).toEqual({ kind: 'document', type: 'other' });
    expect(sniffBytes(bytes('{\\rtf1\\ansi'))).toEqual({ kind: 'document', type: 'word' });
  });

  it('a web page is html; a "PDF" that is not one is other', () => {
    expect(sniffBytes(bytes('<!DOCTYPE html><html><title>x</title>'), 'application/octet-stream')).toEqual({ kind: 'html' });
    expect(sniffBytes(bytes('hello'), 'text/html')).toEqual({ kind: 'html' });
    expect(sniffBytes(bytes('not a pdf'), 'application/pdf')).toEqual({ kind: 'other' });
    expect(sniffBytes(bytes('not a pdf'))).toEqual({ kind: 'other' });
  });
});
