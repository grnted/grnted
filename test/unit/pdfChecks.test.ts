// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { PdfCheckError, checkPdf, pdfCriteria, pdfProblems } from '../../src/documents/pdf.js';
import {
  ALL_PERMISSIONS, NO_COPY_PERMISSIONS, encryptedPdf, formPdf, imageOnlyPdf, namelessFieldPdf, structuredPdf, taggedPdf, titledPdf, untaggedPdf,
} from '../helpers/pdfs.js';

describe('checkPdf (quick structure checks)', () => {
  it('flags an untagged PDF without language or title', async () => {
    const c = await checkPdf(await untaggedPdf());
    expect(c).toMatchObject({
      pages: 1, pagesChecked: 1, tagged: false, hasLanguage: false, hasTitle: false, imageOnly: false,
      figuresWithoutAlt: 0, formFields: 0, untitledFormFields: 0, xfa: false, blocksAssistiveTech: false,
    });
    expect(pdfProblems(c)).toEqual([
      'Not tagged: screen readers cannot tell its headings, lists and tables apart, and may read it out of order.',
      'No document language is set, so screen readers may pronounce it wrongly.',
      'No title is set, so people see the file name instead.',
    ]);
  });

  it('reads the title, the title-bar setting and /Lang, and leaves the caller\'s bytes intact', async () => {
    const bytes = await titledPdf();
    const c = await checkPdf(bytes);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
    expect(c).toMatchObject({ hasTitle: true, showsTitle: true, hasLanguage: true, tagged: false });
  });

  it('spots a scanned, image-only PDF', async () => {
    const c = await checkPdf(await imageOnlyPdf());
    expect(c).toMatchObject({ imageOnly: true, hasTitle: true, showsTitle: false });
    expect(pdfProblems(c)).toContain('No text found: it looks like a scanned image, which screen readers cannot read.');
    expect(pdfProblems(c)).toContain('It has a title, but PDF readers are told to show the file name instead.');
  });

  it('a scanned page tagged as a figure with alt text is not an unreadable scan (WCAG technique PDF1)', async () => {
    // The page is one image with no text layer; its Figure tag carries the text as /Alt, which screen readers read.
    const described = await checkPdf(await structuredPdf({ title: 'Gate notice', lang: 'en', pages: [[{ tag: 'Figure', alt: 'Notice: the east gate is closed on Friday. Use the north entrance on Mill Road.' }]] }));
    expect(described).toMatchObject({ tagged: true, imageOnly: false, figuresWithoutAlt: 0 });
    expect(pdfCriteria(described)).not.toContain('1.1.1');
    // Look-alikes that still fail 1.1.1: the same scan tagged with no alt, and one of two scanned pages left undescribed.
    const bare = await checkPdf(await structuredPdf({ title: 'Gate notice', lang: 'en', pages: [[{ tag: 'Figure' }]] }));
    expect(bare).toMatchObject({ tagged: true, imageOnly: true, figuresWithoutAlt: 1 });
    expect(pdfCriteria(bare)).toContain('1.1.1');
    const half = await checkPdf(await structuredPdf({ title: 'Gate notice', lang: 'en', pages: [[{ tag: 'Figure', alt: 'Notice: the east gate is closed on Friday.' }], [{ tag: 'Figure' }]] }));
    expect(half).toMatchObject({ imageOnly: true, figuresWithoutAlt: 1 });
    // An untagged scan stays what it was.
    expect(pdfCriteria(await checkPdf(await imageOnlyPdf()))).toContain('1.1.1');
  });

  it('one described figure does not cover the page: a tagged logo with alt beside an untagged scanned notice is still an unreadable scan', async () => {
    // The logo's alternative says nothing of the notice, which is an image with no tag and no text.
    const logo = await checkPdf(await structuredPdf({ title: 'Gate notice', lang: 'en', pages: [[{ tag: 'Figure', alt: 'City seal', side: 40 }, { tag: 'Figure', untagged: true, side: 320 }]] }));
    expect(logo).toMatchObject({ tagged: true, imageOnly: true });
    expect(pdfCriteria(logo)).toContain('1.1.1');
    // The same with the notice tagged as a figure that has no alt.
    const bareNotice = await checkPdf(await structuredPdf({ title: 'Gate notice', lang: 'en', pages: [[{ tag: 'Figure', alt: 'City seal', side: 40 }, { tag: 'Figure', side: 320 }]] }));
    expect(bareNotice).toMatchObject({ imageOnly: true, figuresWithoutAlt: 1 });
    // An untagged image beside the described scan, however small, is not shown to be covered (review round 2,
    // finding 2: no share of the image area proves it): neither a scan nor described, and said so.
    const withMark = await checkPdf(await structuredPdf({ title: 'Gate notice', lang: 'en', pages: [[{ tag: 'Figure', alt: 'Notice: the east gate is closed on Friday. Use the north entrance on Mill Road.', side: 320 }, { tag: 'Figure', untagged: true, side: 24 }]] }));
    expect(withMark).toMatchObject({ tagged: true, scanUnmeasured: true });
    expect(withMark.imageOnly).toBeUndefined();
    // Look-alike that is a described scan: the scan's figure has the alt, with a decoration marked as an artifact beside it.
    const withBorder = await checkPdf(await structuredPdf({ title: 'Gate notice', lang: 'en', pages: [[{ tag: 'Figure', artifact: true, side: 60 }, { tag: 'Figure', alt: 'Notice: the east gate is closed on Friday. Use the north entrance on Mill Road.', side: 320 }]] }));
    expect(withBorder).toMatchObject({ tagged: true, imageOnly: false });
    expect(pdfCriteria(withBorder)).not.toContain('1.1.1');
  });

  it('a scan marked as an artifact is not described by the logo beside it: an image hidden from screen readers still counts as what the page shows', async () => {
    // The notice is an image the file calls decoration; the only figure with an alternative is the small seal.
    const hidden = await checkPdf(await structuredPdf({ title: 'Gate notice', lang: 'en', pages: [[{ tag: 'Figure', alt: 'City seal', side: 40 }, { tag: 'Figure', artifact: true, side: 320 }]] }));
    expect(hidden).toMatchObject({ tagged: true, imageOnly: true });
    expect(pdfCriteria(hidden)).toContain('1.1.1');
  });

  it('a page drawn as shapes inside a described figure (a chart, a map, outlined text) is described; shapes outside it are not', async () => {
    const chart = await checkPdf(await structuredPdf({ title: 'Water use', lang: 'en', pages: [[{ tag: 'Figure', vector: true, side: 300, alt: 'Bar chart: water use rose from 40 to 85 million gallons between 2022 and 2025.' }]] }));
    expect(chart).toMatchObject({ tagged: true, imageOnly: false });
    expect(pdfCriteria(chart)).not.toContain('1.1.1');
    // Look-alike: the described figure is a small seal, and the chart is drawn outside any tag.
    const loose = await checkPdf(await structuredPdf({ title: 'Water use', lang: 'en', pages: [[{ tag: 'Figure', vector: true, side: 30, alt: 'City seal' }, { tag: 'Figure', vector: true, untagged: true, side: 300 }, { tag: 'Figure', vector: true, untagged: true, side: 200 }, { tag: 'Figure', vector: true, untagged: true, side: 100 }]] }));
    expect(loose).toMatchObject({ imageOnly: true });
  });

  it('a described scan with a rule or a watermark beside it is still described; what could not be measured is not called a scan', async () => {
    const NOTICE = 'Notice: the east gate is closed on Friday. Use the north entrance on Mill Road.';
    // A thin rule drawn with no tag (a producer's border) beside the described scan.
    const ruled = await checkPdf(await structuredPdf({ title: 'Gate notice', lang: 'en', pages: [[{ tag: 'P', rule: true }, { tag: 'Figure', alt: NOTICE, side: 320 }, { tag: 'P', rule: true }]] }));
    expect(ruled).toMatchObject({ tagged: true, imageOnly: false });
    // A watermark marked as decoration, smaller than the described scan.
    const marked = await checkPdf(await structuredPdf({ title: 'Gate notice', lang: 'en', pages: [[{ tag: 'Figure', alt: NOTICE, side: 320 }, { tag: 'Figure', artifact: true, side: 200 }]] }));
    expect(marked).toMatchObject({ tagged: true, imageOnly: false });
    expect(pdfCriteria(marked)).not.toContain('1.1.1');
    // A file the image scan cannot rely on (content in a filter it does not undo): the described page is not
    // measured, so it is neither a described scan nor an unreadable one: nothing is said.
    const unread = await checkPdf(await structuredPdf({ title: 'Gate notice', lang: 'en', extraStream: 'RunLengthDecode', pages: [[{ tag: 'Figure', alt: NOTICE, side: 320 }]] }));
    expect(unread.tagged).toBe(true);
    expect(unread.imageOnly).toBeUndefined();
    expect(pdfCriteria(unread)).not.toContain('1.1.1');
    // Look-alikes that are still unreadable scans, measured or not: no figure with an alternative on the page at all.
    const untagged = await checkPdf(await structuredPdf({ title: 'Gate notice', lang: 'en', extraStream: 'RunLengthDecode', pages: [[{ tag: 'Figure', side: 320 }]] }));
    expect(untagged).toMatchObject({ imageOnly: true });
  });

  it('review round 2, finding 2: a large described seal beside a small untagged scanned notice is not a described scan, and what could not be shown is said, never clean', async () => {
    // The seal's alternative says nothing of the notice: most of the image area being described proves nothing about it.
    const seal = await checkPdf(await structuredPdf({ title: 'Gate notice', lang: 'en', pages: [[{ tag: 'Figure', alt: 'City seal', side: 320 }, { tag: 'Figure', untagged: true, side: 80 }]] }));
    expect(seal.imageOnly).not.toBe(false);
    expect(seal).toMatchObject({ tagged: true, scanUnmeasured: true });
    expect(seal.imageOnly).toBeUndefined();
    // (In the report such a PDF is "not testable" for 1.1.1, never "no failures found": test/unit/criteria.test.ts.)
    // Look-alikes: a described scan with nothing else drawn is clean (and says nothing is unmeasured); a logo beside a larger untagged scan is still a scan.
    const whole = await checkPdf(await structuredPdf({ title: 'Gate notice', lang: 'en', pages: [[{ tag: 'Figure', alt: 'Notice: the east gate is closed on Friday. Use the north entrance on Mill Road.', side: 320 }]] }));
    expect(whole).toMatchObject({ imageOnly: false });
    expect(whole.scanUnmeasured).toBeUndefined();
    const logo = await checkPdf(await structuredPdf({ title: 'Gate notice', lang: 'en', pages: [[{ tag: 'Figure', alt: 'City seal', side: 40 }, { tag: 'Figure', untagged: true, side: 320 }]] }));
    expect(logo).toMatchObject({ imageOnly: true });
    expect(logo.scanUnmeasured).toBeUndefined();
  });

  it('no image is decoded to measure a scan: the copy pdf.js reads has every image stream cut to one pixel, and the page still measures the same', async () => {
    const { decodedSizeWithin, withoutImagePixels, PDF_INLINE_IMAGE_PIXELS } = await import('../../src/documents/pdfGuard.js');
    const bytes = await structuredPdf({ title: 'Gate notice', lang: 'en', pages: [[{ tag: 'Figure', alt: 'Notice: the east gate is closed on Friday. Use the north entrance on Mill Road.', side: 320 }]] });
    const images = { count: 0, unknown: false, spans: [] as { at: number; length: number; kind: 'number' | 'key' }[] };
    expect(await decodedSizeWithin(bytes, undefined, undefined, images)).toBe('ok');
    expect(images.count).toBeGreaterThanOrEqual(1);
    expect(images.unknown).toBe(false);
    // Each image stream gives its /Width, its /Height and, when it has one, its /Filter key.
    const text = new TextDecoder('windows-1252').decode(bytes);
    for (const sp of images.spans) expect(text.slice(sp.at, sp.at + sp.length)).toMatch(sp.kind === 'number' ? /^\d+$/ : /^\/Filter$/);
    expect(images.spans.filter((x) => x.kind === 'number').length).toBe(images.count * 2);
    // The copy: same length, every image one pixel with no filter, everything else byte for byte.
    const copy = withoutImagePixels(bytes, images);
    const cut = new TextDecoder('windows-1252').decode(copy);
    expect(copy.length).toBe(bytes.length);
    expect(cut.match(/\/Subtype\s*\/Image/g)?.length).toBe(images.count);
    for (const sp of images.spans) expect(cut.slice(sp.at, sp.at + sp.length)).toMatch(sp.kind === 'number' ? /^1 *$/ : /^\/Filtex$/);
    let changed = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== copy[i]) changed++;
    expect(changed).toBeLessThanOrEqual(images.spans.reduce((n, sp) => n + sp.length, 0));
    expect(bytes).not.toEqual(copy); // the caller's bytes are left as they were
    // A large inline image in a page's content (pdf.js would drop it unread) makes the scan unreliable too.
    const side = Math.ceil(Math.sqrt(PDF_INLINE_IMAGE_PIXELS)) + 1;
    const inline = new TextEncoder().encode(`%PDF-1.7\n4 0 obj\n<< /Length 60 >>\nstream\nq 500 0 0 700 0 0 cm BI /W ${side} /H ${side} /BPC 8 /CS /G ID abc EI Q\nendstream\nendobj\n`);
    const withInline = { count: 0, unknown: false, spans: [] as { at: number; length: number; kind: 'number' | 'key' }[] };
    await decodedSizeWithin(inline, undefined, undefined, withInline);
    expect(withInline.unknown).toBe(true);
    const small = new TextEncoder().encode('%PDF-1.7\n4 0 obj\n<< /Length 60 >>\nstream\nq 20 0 0 20 0 0 cm BI /W 16 /H 16 /BPC 8 /CS /G ID abc EI Q\nendstream\nendobj\n');
    const withSmall = { count: 0, unknown: false, spans: [] as { at: number; length: number; kind: 'number' | 'key' }[] };
    await decodedSizeWithin(small, undefined, undefined, withSmall);
    expect(withSmall.unknown).toBe(false);
    // An image whose dictionary is longer than the scan looks back (its start is not found), and a dictionary that
    // does not begin where an object begins: the image may not have been seen, so nothing is measured.
    const longDict = new TextEncoder().encode(`%PDF-1.7\n1 0 obj\n<< /Type /XObject /Subtype /Image /Width 4000 /Height 4000 /Decode [${'0 1 '.repeat(1200)}] /Length 3 >>\nstream\nabc\nendstream\nendobj\n`);
    const far = { count: 0, unknown: false, spans: [] as { at: number; length: number; kind: 'number' | 'key' }[] };
    await decodedSizeWithin(longDict, undefined, undefined, far);
    expect(far.unknown).toBe(true);
    // Many inline images, each small: pdf.js would decode them all. More than a page of icons has is not measured.
    const many = new TextEncoder().encode(`%PDF-1.7\n4 0 obj\n<< /Length 60 >>\nstream\n${'q 20 0 0 20 0 0 cm BI /W 16 /H 16 /BPC 8 /CS /G ID abc EI Q\n'.repeat(120)}endstream\nendobj\n`);
    const withMany = { count: 0, unknown: false, spans: [] as { at: number; length: number; kind: 'number' | 'key' }[] };
    await decodedSizeWithin(many, undefined, undefined, withMany);
    expect(withMany.unknown).toBe(true);
    // An image whose size is not written in its own dictionary cannot be cut: the scan says so, and the page is then not measured (the finding stays).
    const indirect = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<< /Type /XObject /Subtype /Image /Width 9 0 R /Height 4000 /Length 3 >>\nstream\nabc\nendstream\nendobj\n');
    const unknown = { count: 0, unknown: false, spans: [] as { at: number; length: number; kind: 'number' | 'key' }[] };
    await decodedSizeWithin(indirect, undefined, undefined, unknown);
    expect(unknown).toMatchObject({ count: 1, unknown: true });
  });

  it('page content wrapped in ASCII85 or hex, with or without Flate (a common producer\'s default), is looked through like any other', async () => {
    const { decodedSizeWithin, PDF_INLINE_IMAGE_PIXELS } = await import('../../src/documents/pdfGuard.js');
    const { deflateSync } = await import('node:zlib');
    const a85 = (data: Uint8Array): string => {
      let out = '';
      for (let i = 0; i < data.length; i += 4) {
        const n = Math.min(4, data.length - i);
        let v = 0;
        for (let k = 0; k < 4; k++) v = v * 256 + (k < n ? data[i + k]! : 0);
        if (n === 4 && v === 0) { out += 'z'; continue; }
        const c: string[] = [];
        for (let k = 0; k < 5; k++) { c.unshift(String.fromCharCode(33 + (v % 85))); v = Math.floor(v / 85); }
        out += c.slice(0, n + 1).join('');
      }
      return `${out}~>`;
    };
    const hex = (data: Uint8Array): string => `${Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('')}>`;
    const file = (filter: string, body: string) => new TextEncoder().encode(`%PDF-1.7\n4 0 obj\n<< /Filter ${filter} /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`);
    const scan = async (bytes: Uint8Array) => {
      const images = { count: 0, unknown: false, spans: [] as { at: number; length: number; kind: 'number' | 'key' }[] };
      expect(await decodedSizeWithin(bytes, undefined, undefined, images)).toBe('ok');
      return images.unknown;
    };
    const enc = (t: string) => new TextEncoder().encode(t);
    const plain = 'BT /F1 12 Tf (x) Tj ET q 300 0 0 400 20 20 cm /Im1 Do Q\n';
    const side = Math.ceil(Math.sqrt(PDF_INLINE_IMAGE_PIXELS)) + 1;
    const big = `q 500 0 0 700 0 0 cm BI /W ${side} /H ${side} /BPC 8 /CS /G ID abc EI Q\n`;
    // Content with no inline image: looked through, nothing found, the scan can be relied on.
    expect(await scan(file('[ /ASCII85Decode /FlateDecode ]', a85(deflateSync(enc(plain)))))).toBe(false);
    expect(await scan(file('/ASCII85Decode', a85(enc(plain))))).toBe(false);
    expect(await scan(file('[ /ASCIIHexDecode /FlateDecode ]', hex(deflateSync(enc(plain)))))).toBe(false);
    expect(await scan(file('/A85', a85(enc(plain))))).toBe(false);
    // The same wrappers around a large inline image: found.
    expect(await scan(file('[ /ASCII85Decode /FlateDecode ]', a85(deflateSync(enc(big)))))).toBe(true);
    expect(await scan(file('/ASCIIHexDecode', hex(enc(big))))).toBe(true);
    // Bytes the reader and this scan could take differently (a NUL or a form feed inside ASCII85): not relied on.
    const { ascii85Decoded, asciiHexDecoded } = await import('../../src/documents/pdfGuard.js');
    const good = a85(enc(plain));
    expect(ascii85Decoded(enc(good), 1 << 20)).not.toBeNull();
    for (const odd of ['\u0000', '\u000c', '\u000b']) expect(ascii85Decoded(enc(`${good.slice(0, 7)}${odd}${good.slice(7)}`), 1 << 20), JSON.stringify(odd)).toBeNull();
    expect(ascii85Decoded(enc(`${good.slice(0, 7)} \n\t\r${good.slice(7)}`), 1 << 20)).not.toBeNull();
    expect(asciiHexDecoded(enc('4a4b\u00004c>'))).toBeNull();
    expect(Array.from(asciiHexDecoded(enc('4a 4b\n4c>'))!)).toEqual([0x4a, 0x4b, 0x4c]);
    expect(await scan(file('/ASCII85Decode', `${good.slice(0, 7)}\u0000${good.slice(7)}`))).toBe(true);
    // A filter the scan cannot undo (run length), and a chain it does not know: not relied on.
    expect(await scan(file('/RunLengthDecode', 'abc'))).toBe(true);
    expect(await scan(file('[ /FlateDecode /ASCII85Decode ]', 'abc'))).toBe(true);
  });

  it('a form field with no name at all (an empty /T, no tooltip) is an unnamed field (4.1.2, PDF12)', async () => {
    const c = await checkPdf(await namelessFieldPdf());
    // Two nameless text fields, one of them with a tooltip; and one named field with a tooltip.
    expect(c).toMatchObject({ formFields: 3, untitledFormFields: 1 });
    expect(pdfCriteria(c)).toContain('4.1.2');
    expect(pdfCriteria(await checkPdf(await namelessFieldPdf(true)))).not.toContain('4.1.2');
  });

  it('finds tags and counts figures without alt text', async () => {
    const c = await checkPdf(await taggedPdf());
    expect(c).toMatchObject({ tagged: true, figuresWithoutAlt: 1, hasLanguage: true, hasTitle: true, showsTitle: true, imageOnly: false });
    expect(pdfProblems(c)).toEqual(['1 image has no text description (alt text).']);
  });

  it('counts form fields without tooltips and detects XFA', async () => {
    const c = await checkPdf(await formPdf());
    expect(c).toMatchObject({ formFields: 3, untitledFormFields: 2, xfa: true });
    expect(pdfProblems(c)).toEqual(expect.arrayContaining([
      'It uses an XFA form, which most PDF readers and screen readers cannot use.',
      '2 form fields have no name (tooltip) for screen readers.',
    ]));
  });

  it('reports encryption that blocks assistive technology, and not when copying is allowed', async () => {
    expect((await checkPdf(encryptedPdf(NO_COPY_PERMISSIONS))).blocksAssistiveTech).toBe(true);
    expect((await checkPdf(encryptedPdf(ALL_PERMISSIONS))).blocksAssistiveTech).toBe(false);
    expect(pdfProblems({ pages: 1, pagesChecked: 1, blocksAssistiveTech: true })).toEqual([
      'Its security settings stop screen readers from reading the text.',
    ]);
  });

  it('a PDF that needs a password to open fails with blocksAssistiveTech set', async () => {
    const err = await checkPdf(encryptedPdf(ALL_PERMISSIONS, 'secret')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfCheckError);
    expect(err).toMatchObject({ message: 'Needs a password to open', blocksAssistiveTech: true });
  });

  it('a damaged file gives a plain-language error', async () => {
    const err = await checkPdf(new TextEncoder().encode('%PDF-1.4\n%%EOF\n')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfCheckError);
    expect((err as Error).message).toMatch(/^Could not read/);
  });

  it('reads at most maxPages pages and stops at the time box', async () => {
    const c = await checkPdf(await untaggedPdf(5), { maxPages: 2, timeoutMs: 5000 });
    expect(c).toMatchObject({ pages: 5, pagesChecked: 2 });
    const err = await checkPdf(await untaggedPdf(30), { maxPages: 30, timeoutMs: 1 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ message: 'Took longer than 1 ms to read' });
  });

  it('lists no problems for a clean result, and says nothing about checks that could not tell', () => {
    expect(pdfProblems({ pages: 2, pagesChecked: 2, tagged: true, hasLanguage: true, hasTitle: true, showsTitle: true, imageOnly: false })).toEqual([]);
    expect(pdfProblems({ pages: 0, pagesChecked: 0 })).toEqual([]);
  });
});
