// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Synthetic PDFs for the document tests, generated with pdf-lib (dev dependency only). No
// third-party documents. The encrypted one is written by hand: pdf-lib cannot encrypt.
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { PDFBool, PDFDocument, PDFName, PDFNumber, PDFOperator, PDFOperatorNames, PDFString, StandardFonts, rgb, type PDFPage } from 'pdf-lib';
import { createTagger } from './pdfTags.mjs';

/** A small solid RGB PNG: grey, or `color` (0-255 each). */
export function png(width = 8, height = 8, color?: readonly [number, number, number]): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const pixel = Buffer.from(color ?? [0x80, 0x80, 0x80]);
  const row = Buffer.concat([Buffer.from([0]), ...Array.from({ length: width }, () => pixel)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

async function textPage(doc: PDFDocument, text = 'Board meeting minutes'): Promise<PDFPage> {
  const page = doc.addPage([300, 200]);
  page.drawText(text, { x: 20, y: 150, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  return page;
}

/** Text, but no tags, no /Lang and no title. */
export async function untaggedPdf(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) await textPage(doc, `Page ${i + 1}`);
  return doc.save();
}

/** Text with a title (shown in the title bar) and /Lang, still untagged. */
export async function titledPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Board minutes, October', { showInWindowTitleBar: true });
  doc.setLanguage('en-US');
  await textPage(doc);
  return doc.save();
}

/** A scanned page: one image, no text layer. */
export async function imageOnlyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Scanned notice');
  const page = doc.addPage([300, 200]);
  page.drawImage(await doc.embedPng(png()), { x: 0, y: 0, width: 300, height: 200 });
  return doc.save();
}

/**
 * A tagged PDF built from low-level objects: MarkInfo /Marked true and a StructTreeRoot with a
 * paragraph and two figures, one with /Alt and one without, linked to marked content (MCIDs).
 */
export async function taggedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Tagged sample', { showInWindowTitleBar: true });
  doc.setLanguage('en');
  const page = doc.addPage([300, 200]);
  const ctx = doc.context;
  // BDC takes a property dictionary; pdf-lib's operator argument type leaves dictionaries out.
  const props = (mcid: number) => ctx.obj({ MCID: mcid }) as unknown as PDFName;
  const begin = (tag: string, mcid: number) => PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of(tag), props(mcid)]);
  const end = () => PDFOperator.of(PDFOperatorNames.EndMarkedContent);
  const img = await doc.embedPng(png());
  page.pushOperators(begin('P', 0));
  page.drawText('Hello tagged world', { x: 20, y: 150, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  page.pushOperators(end(), begin('Figure', 1));
  page.drawImage(img, { x: 20, y: 20, width: 40, height: 40 });
  page.pushOperators(end(), begin('Figure', 2));
  page.drawImage(img, { x: 100, y: 20, width: 40, height: 40 });
  page.pushOperators(end());

  const [root, document, p, fig1, fig2] = [ctx.nextRef(), ctx.nextRef(), ctx.nextRef(), ctx.nextRef(), ctx.nextRef()];
  ctx.assign(p, ctx.obj({ Type: 'StructElem', S: 'P', P: document, Pg: page.ref, K: 0 }));
  ctx.assign(fig1, ctx.obj({ Type: 'StructElem', S: 'Figure', P: document, Pg: page.ref, K: 1, Alt: PDFString.of('A grey square') }));
  ctx.assign(fig2, ctx.obj({ Type: 'StructElem', S: 'Figure', P: document, Pg: page.ref, K: 2 }));
  ctx.assign(document, ctx.obj({ Type: 'StructElem', S: 'Document', P: root, K: [p, fig1, fig2] }));
  ctx.assign(root, ctx.obj({ Type: 'StructTreeRoot', K: document, ParentTree: ctx.obj({ Nums: [0, [p, fig1, fig2]] }), ParentTreeNextKey: 1 }));
  page.node.set(PDFName.of('StructParents'), PDFNumber.of(0));
  doc.catalog.set(PDFName.of('StructTreeRoot'), root);
  doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: PDFBool.True }));
  return doc.save();
}

/** One tagged element on a page of `structuredPdf`: text drawn in a line, or a small image. */
export interface TaggedElement {
  /** Structure type, e.g. 'H1', 'H2', 'H', 'P', 'Figure'. */
  tag: string;
  /** Drawn text (not for figures). */
  text?: string;
  /** /Alt on the structure element (figures). */
  alt?: string;
  /** Font size; default 18 for headings, 11 otherwise. */
  size?: number;
  /** A figure that is a solid square of this RGB color (0-255 each) instead of the small grey one, so its /Alt can say what it shows. */
  color?: readonly [number, number, number];
  /** Figures: the side of the square it is drawn as, in points (default 40). */
  side?: number;
  /** Figures: drawn with no tag at all (outside any marked content), or as an artifact (decoration: /Artifact). */
  untagged?: boolean;
  artifact?: boolean;
  /** Figures: drawn as shapes (filled rectangles: a chart, a map, outlined text) instead of an image. */
  vector?: boolean;
  /** A thin rule drawn with no tag at all (one stroked line), in place of the element. */
  rule?: boolean;
}

export interface StructuredPdfSpec {
  title?: string;
  lang?: string;
  /** Info /ModDate. */
  modified?: Date;
  /** Elements per page, top to bottom, in tag order. */
  pages: TaggedElement[][];
  /** Adds an unused stream object with this filter name to the file (e.g. 'RunLengthDecode': content a reader cannot look inside without undoing it). */
  extraStream?: string;
}

/**
 * A tagged PDF with any number of pages: each element is marked content (MCID) with its own
 * structure element under one Document element, in the order given (`createTagger`, shared with
 * the document eval golden set). Figures are small grey images.
 */
export async function structuredPdf(spec: StructuredPdfSpec): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  if (spec.title !== undefined) doc.setTitle(spec.title, { showInWindowTitleBar: true });
  if (spec.lang) doc.setLanguage(spec.lang);
  if (spec.modified) doc.setModificationDate(spec.modified);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const img = await doc.embedPng(png());
  const images = new Map<string, Awaited<ReturnType<typeof doc.embedPng>>>();
  for (const el of spec.pages.flat()) if (el.color && !images.has(el.color.join())) images.set(el.color.join(), await doc.embedPng(png(8, 8, el.color)));
  const tags = createTagger(doc);
  for (const elements of spec.pages) {
    const page = doc.addPage([400, 600]);
    const tagged = tags.page(page);
    let y = 560;
    for (const el of elements) {
      const side = el.side ?? 40;
      const draw = () => {
        if (el.vector) for (let k = 0; k < 4; k++) page.drawRectangle({ x: 20 + k * (side / 4), y: y - side, width: side / 5, height: side * (0.4 + 0.15 * k), color: rgb(0.2, 0.3, 0.5) });
        else page.drawImage(el.color ? images.get(el.color.join()) ?? img : img, { x: 20, y: y - side, width: side, height: side });
        y -= side + 16;
      };
      if (el.rule) { page.drawLine({ start: { x: 20, y }, end: { x: 380, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) }); y -= 8; continue; }
      // An image with no tag, or one marked as an artifact: page content the structure tree does not hold.
      if (el.tag === 'Figure' && el.untagged) { draw(); continue; }
      if (el.tag === 'Figure' && el.artifact) {
        page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContent, [PDFName.of('Artifact')]));
        draw();
        page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
        continue;
      }
      tagged.mark(el.tag, () => {
        if (el.tag === 'Figure') {
          draw();
        } else {
          const heading = /^H\d?$/.test(el.tag);
          const size = el.size ?? (heading ? 18 : 11);
          page.drawText(el.text ?? '', { x: 20, y: y - size, size, font: heading || (el.size ?? 0) > 14 ? bold : font });
          y -= size + 12;
        }
      }, { alt: el.alt });
    }
  }
  tags.finish();
  if (spec.extraStream) doc.context.register(doc.context.stream(new Uint8Array([3, 97, 98, 99, 128]), { Filter: PDFName.of(spec.extraStream) }));
  // (Object streams off: every dictionary is then in the file as plain text, as most producers write them.)
  return doc.save(spec.extraStream ? { useObjectStreams: false } : undefined);
}

/**
 * A form: three text fields whose field and widget share one dictionary (as Acrobat and Word
 * write them), one with a tooltip (/TU), plus an XFA packet in the AcroForm.
 */
export async function formPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Enrollment form');
  doc.setLanguage('en');
  const page = await textPage(doc, 'Enrollment form');
  const ctx = doc.context;
  const field = (name: string, y: number, tooltip?: string) => ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: PDFString.of(name), Rect: [10, y, 110, y + 20], P: page.ref, F: 4,
    ...(tooltip ? { TU: PDFString.of(tooltip) } : {}),
  }));
  const fields = [field('student', 10, 'Student name'), field('grade', 40), field('phone', 70)];
  page.node.set(PDFName.of('Annots'), ctx.obj(fields));
  const xfa = ctx.register(ctx.flateStream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template/></xdp:xdp>'));
  doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: fields, XFA: [PDFString.of('template'), xfa] }));
  return doc.save();
}

/**
 * A fillable form drawn over a page: two text fields with an empty field name (/T), one of them with a
 * tooltip (/TU), and one named field with a tooltip. With `allNamed`, the nameless field without a tooltip gets one.
 */
export async function namelessFieldPdf(allNamed = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Meal request form', { showInWindowTitleBar: true });
  doc.setLanguage('en');
  const page = await textPage(doc, 'Meal request form');
  const ctx = doc.context;
  const field = (name: string, y: number, tooltip?: string) => ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: PDFString.of(name), Rect: [10, y, 110, y + 20], P: page.ref, F: 4,
    ...(tooltip ? { TU: PDFString.of(tooltip) } : {}),
  }));
  const fields = [field('', 10, allNamed ? 'Student name' : undefined), field('', 40, 'Grade'), field('phone', 70, 'Phone number')];
  page.node.set(PDFName.of('Annots'), ctx.obj(fields));
  doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: fields }));
  return doc.save();
}

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
    out[k] = data[k]! ^ s[(s[i]! + s[j]!) & 255]!;
  }
  return out;
}

/**
 * A one-page PDF encrypted with the standard handler (RC4, revision 2) and an empty user
 * password, so it opens without one. `permissions` is the /P value. With `userPassword`, it
 * needs that password to open.
 */
export function encryptedPdf(permissions: number, userPassword = ''): Uint8Array {
  const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
  const pad = (pw: string) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);
  const md5 = (...parts: Buffer[]) => createHash('md5').update(Buffer.concat(parts)).digest();
  const id = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
  const owner = rc4(md5(pad('owner-secret')).subarray(0, 5), pad(userPassword));
  const p = Buffer.alloc(4);
  p.writeInt32LE(permissions | 0);
  const key = md5(pad(userPassword), owner, p, id).subarray(0, 5);
  const user = rc4(key, PAD);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    `<< /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P ${permissions | 0} >>`,
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 4 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, 'latin1'));
}

/** /P values: everything allowed, and no copying at all (not even for accessibility). */
export const ALL_PERMISSIONS = 0xfffffffc | 0;
export const NO_COPY_PERMISSIONS = (0xfffffffc & ~16 & ~512) | 0;
