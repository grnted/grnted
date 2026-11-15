// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { checkOffice, officeFindings, OfficeCheckError } from '../../src/documents/office.js';
import { attr, scanXml } from '../../src/documents/ooxml.js';
import { msOnce } from '../helpers/linear.js';
import {
  brokenDocx, brokenPptx, brokenXlsx, cleanDocx, cleanPptx, cleanXlsx, docx, encryptedOffice, fakeHeadingsDocx, legacyDoc, para, pptx, slide, slidePic, wordImage, zip,
} from '../helpers/office.js';

const levels = (c: Parameters<typeof officeFindings>[0]) => officeFindings(c).map((f) => `${f.level}:${f.key}:${f.criterion}`);

describe('Office quick checks: Word', () => {
  it('a clean file: title, language, headings in order, described and decorative images, header rows, link words', async () => {
    const c = await checkOffice(cleanDocx(), 'docx');
    expect(c).toEqual({
      format: 'docx', hasTitle: true, hasLanguage: true, images: 2, imagesWithoutAlt: 0, headings: 4, headingSkips: 0, fakeHeadings: 0,
      tables: 2, tablesWithoutHeader: 0, links: 1, rawUrlLinks: 0,
    });
    expect(officeFindings(c)).toEqual([]);
  });

  it('a broken file: every problem, each with its criterion; restrict editing is recorded, never a finding', async () => {
    const c = await checkOffice(brokenDocx(), 'docx');
    expect(c).toMatchObject({ hasTitle: false, hasLanguage: false, images: 2, imagesWithoutAlt: 2, headings: 2, headingSkips: 1, tables: 1, tablesWithoutHeader: 1, links: 1, rawUrlLinks: 1, editingRestricted: true });
    expect(levels(c)).toEqual([
      'problem:alt:1.1.1', 'hint:tableHeader:1.3.1', 'problem:language:3.1.1', 'problem:title:2.4.2', 'hint:headingOrder:1.3.1', 'hint:linkText:2.4.4',
    ]);
  });

  it('short bold lines are a hint only when the document has no heading styles at all', async () => {
    const c = await checkOffice(fakeHeadingsDocx(), 'docx');
    expect(c).toMatchObject({ headings: 0, fakeHeadings: 3 });
    expect(levels(c)).toEqual(['hint:fakeHeadings:1.3.1']);
    // Two bold lines in a short note: not enough to say anything.
    const short = docx({ title: 'Note', lang: 'en-US', body: '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Hello</w:t></w:r></w:p>' + para('A note.') });
    expect((await checkOffice(short, 'docx')).fakeHeadings).toBe(0);
  });

  it('paragraphs inside a text box (an empty one too) never cut the heading around them', async () => {
    const box = '<w:r><w:drawing><wp:anchor><wp:docPr id="3" name="Text Box 3"/><a:graphic><a:graphicData uri="wps"><wps:wsp xmlns:wps="w"><wps:txbx><w:txbxContent><w:p/><w:p><w:r><w:t>Inside the box</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>';
    const body = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${box}<w:r><w:t>Annual report</w:t></w:r></w:p>${para('Results', 'Heading2')}${para('Text.')}`;
    const c = await checkOffice(docx({ title: 'Report', lang: 'en-US', body }), 'docx');
    expect(c).toMatchObject({ headings: 2, headingSkips: 0, images: 0 });
  });

  it('deep nesting is capped, never a crash or a runaway', async () => {
    const body = '<w:tbl><w:tr><w:tc>'.repeat(50_000) + para('Deep', 'Heading1');
    const t0 = Date.now();
    const c = await checkOffice(docx({ title: 'Deep', lang: 'en-US', body }), 'docx');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(c.format).toBe('docx');
  });

  it('a title that is a file name or a default name is no title', async () => {
    for (const title of ['minutes.docx', 'Document1', 'Microsoft Word - minutes.docx', '  ']) {
      expect((await checkOffice(docx({ title, lang: 'en-US', body: para('Text') }), 'docx')).hasTitle, title).toBe(false);
    }
    expect((await checkOffice(docx({ title: 'Board minutes &amp; votes', lang: 'en-US', body: para('Text') }), 'docx')).hasTitle).toBe(true);
  });
});

describe('Office quick checks: PowerPoint', () => {
  it('a clean deck: titled slides (hidden slides left out), described pictures, a header row, link words', async () => {
    const c = await checkOffice(cleanPptx(), 'pptx');
    expect(c).toEqual({
      format: 'pptx', hasTitle: true, hasLanguage: true, slides: 3, slidesWithoutTitle: 0, images: 2, imagesWithoutAlt: 0, tables: 1, tablesWithoutHeader: 0, links: 1, rawUrlLinks: 0,
    });
    expect(officeFindings(c)).toEqual([]);
  });

  it('a broken deck: slides without titles (an empty title placeholder too), a picture without alt text, no header row, a raw address', async () => {
    const c = await checkOffice(brokenPptx(), 'pptx');
    expect(c).toMatchObject({ hasTitle: false, hasLanguage: false, slides: 3, slidesWithoutTitle: 2, images: 1, imagesWithoutAlt: 1, tables: 1, tablesWithoutHeader: 1, rawUrlLinks: 1 });
    expect(levels(c)).toEqual([
      'problem:alt:1.1.1', 'hint:tableHeader:1.3.1', 'problem:slideTitle:2.4.2', 'problem:language:3.1.1', 'problem:title:2.4.2', 'hint:linkText:2.4.4',
    ]);
  });

  it('reads slides in number order and at most maxSlides of them (the rest marks the file partly checked)', async () => {
    const slides = Array.from({ length: 12 }, (_, i) => slide({ title: `Slide ${i + 1}`, body: 'Text' }));
    const c = await checkOffice(pptx({ title: 'Deck', slides }), 'pptx', { timeoutMs: 5000, maxSlides: 10 });
    expect(c).toMatchObject({ slides: 10, slidesWithoutTitle: 0, partial: true });
  });
});

describe('Office quick checks: Excel', () => {
  it('a clean workbook: named sheets (a hidden default one is left out), a merge below the header, described pictures', async () => {
    const c = await checkOffice(cleanXlsx(), 'xlsx');
    expect(c).toEqual({ format: 'xlsx', hasTitle: true, sheets: 2, defaultSheetNames: 0, mergedHeaderSheets: 0, images: 2, imagesWithoutAlt: 0 });
    expect(officeFindings(c)).toEqual([]);
  });

  it('a broken workbook: default sheet names and header merges are hints; pictures without alt text a problem; no language check', async () => {
    const c = await checkOffice(brokenXlsx(), 'xlsx');
    expect(c).toMatchObject({ hasTitle: false, sheets: 2, defaultSheetNames: 2, mergedHeaderSheets: 1, images: 2, imagesWithoutAlt: 2 });
    expect(c.hasLanguage).toBeUndefined();
    expect(levels(c)).toEqual(['problem:alt:1.1.1', 'problem:title:2.4.2', 'hint:sheetNames:2.4.6', 'hint:mergedCells:1.3.1']);
  });
});

describe('Office quick checks: containers', () => {
  it('a password-protected file is checked: it blocks screen readers', async () => {
    const c = await checkOffice(encryptedOffice(), 'xlsx');
    expect(c).toEqual({ format: 'xlsx', passwordToOpen: true });
    expect(levels(c)).toEqual(['problem:password:1.3.1']);
  });

  it('a legacy binary file is not checked, with the modern format to save it as', async () => {
    await expect(checkOffice(legacyDoc(), 'docx')).rejects.toMatchObject({ kind: 'legacy', message: 'Legacy binary format (.doc); save it as .docx to have it checked' });
  });

  it('refuses what is not OOXML: OpenDocument, a plain zip, junk, a damaged zip', async () => {
    const odt = zip([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.text', method: 'store' }, { name: 'content.xml', data: '<x/>' }]);
    await expect(checkOffice(odt, 'docx')).rejects.toThrow(/OpenDocument/);
    await expect(checkOffice(zip([{ name: 'a.txt', data: 'hi' }]), 'docx')).rejects.toThrow('Not a Word, Excel or PowerPoint file');
    await expect(checkOffice(new TextEncoder().encode('<html>'), 'docx')).rejects.toThrow('Not a Word, Excel or PowerPoint file');
    const damaged = cleanDocx().slice(0, 200);
    await expect(checkOffice(damaged, 'docx')).rejects.toBeInstanceOf(OfficeCheckError);
  });
});

describe('Office quick checks: hostile files stay bounded', () => {
  it('a decompression bomb stops at the per-part cap, whatever the header claims', async () => {
    const body = `<w:p><w:r><w:t>${'x'.repeat(40 * 1024 * 1024)}</w:t></w:r></w:p>`;
    const bomb = docx({ title: 'Bomb', lang: 'en-US', body });
    expect(bomb.length).toBeLessThan(200 * 1024);
    const before = process.memoryUsage().heapUsed;
    const t0 = Date.now();
    const c = await checkOffice(bomb, 'docx', { timeoutMs: 10_000, maxPartBytes: 1024 * 1024 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(c.partial).toBe(true);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 * 1024 * 1024);
    // A header that lies about the size changes nothing.
    const liar = zip([
      { name: 'word/document.xml', data: body, claimedSize: 10 },
      { name: 'docProps/core.xml', data: '<cp:coreProperties xmlns:dc="x"><dc:title>T</dc:title></cp:coreProperties>' },
    ]);
    expect((await checkOffice(liar, 'docx', { timeoutMs: 10_000, maxPartBytes: 1024 * 1024 })).partial).toBe(true);
  }, 30_000);

  it('the total inflate cap stops reading further parts', async () => {
    const slides = Array.from({ length: 6 }, (_, i) => slide({ title: `Slide ${i + 1}`, body: 'y'.repeat(600 * 1024) }));
    const c = await checkOffice(pptx({ title: 'Deck', slides }), 'pptx', { timeoutMs: 10_000, maxTotalBytes: 2 * 1024 * 1024 });
    expect(c.partial).toBe(true);
    expect(c.slides).toBeLessThan(6);
  });

  it('too many parts is refused before anything is inflated', async () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({ name: `x/${i}.xml`, data: '<x/>' }));
    await expect(checkOffice(zip(entries), 'docx', { timeoutMs: 5000, maxEntries: 50 })).rejects.toThrow(/more than 50 parts/);
  });

  it('the time box ends a slow read', async () => {
    const big = docx({ title: 'Big', lang: 'en-US', body: para('word ').repeat(200_000) });
    await expect(checkOffice(big, 'docx', { timeoutMs: 0 })).rejects.toMatchObject({ kind: 'time' });
  });

  it('the XML scan and attribute reader are linear on hostile input', () => {
    // 4 MB of each hostile shape: linear code reads it in milliseconds; quadratic code would take hours.
    // The ceiling is far above any load on a shared machine, so this never fails on timing noise.
    const N = 2_000_000;
    const noop = { open() {}, close() {}, text() {} };
    const cases: [string, () => unknown][] = [
      ['unclosed tags', () => scanXml('<a'.repeat(N), noop)],
      ['unclosed comments', () => scanXml('<!--'.repeat(N / 2), noop)],
      ['unclosed CDATA', () => scanXml('<![CDATA['.repeat(N / 4), noop)],
      ['a long attribute name', () => attr(`<a ${'b'.repeat(2 * N)}>`, 'val')],
      ['equals without quotes', () => attr(`<a ${'b= '.repeat(N)}>`, 'val')],
      ['many attributes', () => attr(`<a ${'x="1" '.repeat(N / 2)}>`, 'val')],
      ['an unclosed value', () => attr(`<a v="${'x'.repeat(2 * N)}`, 'val')],
      ['many small tags', () => scanXml('<p><r><t>x</t></r></p>'.repeat(N / 10), noop)],
    ];
    for (const [name, run] of cases) expect(msOnce(run, 1), name).toBeLessThan(3000);
  });
});

describe('Office quick checks: a file of pictures only (batch 18, a neutral fact for the AI review)', () => {
  it('marks a Word file or a deck that holds pictures and no text at all; never a finding; text anywhere, or no picture, is no such file', async () => {
    const scan = docx({ title: 'Notice', lang: 'en-US', body: wordImage({ descr: 'Scanned notice' }) });
    const c = await checkOffice(scan, 'docx');
    expect(c.pictureOnly).toBe(true);
    expect(officeFindings(c).some((f) => /picture/i.test(f.key))).toBe(false);
    expect((await checkOffice(docx({ title: 'Notice', lang: 'en-US', body: wordImage({ descr: 'Map' }) + para('Directions follow.') }), 'docx')).pictureOnly).toBeUndefined();
    expect((await checkOffice(docx({ title: 'Note', lang: 'en-US', body: para('Only words.') }), 'docx')).pictureOnly).toBeUndefined();
    const deck = pptx({ title: 'Flyer', slides: [slide({ extra: slidePic({ descr: 'Flyer' }) })] });
    expect((await checkOffice(deck, 'pptx')).pictureOnly).toBe(true);
    expect((await checkOffice(cleanPptx(), 'pptx')).pictureOnly).toBeUndefined();
  });
});
