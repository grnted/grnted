// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Synthetic Word, Excel and PowerPoint files (OOXML: a zip of XML parts) for the Office document
// tests. Generated here, never third-party files: a clean file and a broken one for each format, plus
// hostile zips (a decompression bomb, a huge entry count). Entries are deflated as Office writes them.
import { crc32, deflateRawSync } from 'node:zlib';

export interface RawEntry {
  name: string;
  data: Uint8Array | string;
  /** 'store' keeps the bytes as they are; default deflate. */
  method?: 'store' | 'deflate';
  /** Overrides the uncompressed size written in the headers (a lying header). */
  claimedSize?: number;
}

/** A zip with the given entries (deflated unless `method: 'store'`), no ZIP64. */
export function zip(entries: readonly RawEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const store = e.method === 'store';
    const body = store ? Buffer.from(raw) : deflateRawSync(raw);
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(raw) >>> 0;
    const size = e.claimedSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(store ? 0 : 8, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(size, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(dir, name);
    offset += local.length + name.length + body.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, dirBuf, end]));
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const X = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DECORATIVE = '<a:extLst><a:ext uri="{C183D7F6-B498-43B3-948B-1728B52AA6E4}"><adec:decorative xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" val="1"/></a:ext></a:extLst>';

const core = (title?: string) => `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">${title === undefined ? '' : `<dc:title>${title}</dc:title>`}<dc:creator>Fixture</dc:creator></cp:coreProperties>`;
const types = (main: string) => `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${main}" ContentType="application/xml"/></Types>`;

// Word ------------------------------------------------------------------------------------------

export interface DocxOptions {
  title?: string;
  /** The default language in styles.xml; undefined: none anywhere. */
  lang?: string;
  /** Body XML (inside w:body). */
  body: string;
  /** Extra word/settings.xml content. */
  settings?: string;
}

const STYLES = (lang?: string) => `${XML}<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr>${lang ? `<w:lang w:val="${lang}" w:eastAsia="en-US" w:bidi="ar-SA"/>` : ''}</w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="SectionTitle"><w:name w:val="Section Title"/><w:basedOn w:val="Heading2"/></w:style>
</w:styles>`;

export function docx(o: DocxOptions): Uint8Array {
  return zip([
    { name: '[Content_Types].xml', data: types('word/document.xml') },
    { name: 'docProps/core.xml', data: core(o.title) },
    { name: 'word/styles.xml', data: STYLES(o.lang) },
    { name: 'word/settings.xml', data: `${XML}<w:settings ${W}>${o.settings ?? ''}</w:settings>` },
    { name: 'word/document.xml', data: `${XML}<w:document ${W}><w:body>${o.body}</w:body></w:document>` },
  ]);
}

export const para = (text: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
export const boldPara = (text: string) => `<w:p><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
export const wordImage = (alt: { descr?: string; title?: string; decorative?: boolean } = {}) =>
  `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="1" name="Picture 1"${alt.descr !== undefined ? ` descr="${alt.descr}"` : ''}${alt.title !== undefined ? ` title="${alt.title}"` : ''}${alt.decorative ? `>${DECORATIVE}</wp:docPr>` : '/>'}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/></pic:nvPicPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
export const wordShape = () =>
  '<w:p><w:r><w:drawing><wp:anchor><wp:docPr id="7" name="Text Box 7"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"/></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>';
export const wordTable = (rows: string[][], header: 'tblHeader' | 'firstRow' | 'none') => {
  const look = header === 'firstRow' ? '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>' : '<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/>';
  const trs = rows.map((cells, i) => `<w:tr>${i === 0 && header === 'tblHeader' ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells.map((c) => `<w:tc>${para(c)}</w:tc>`).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>${look}</w:tblPr><w:tblGrid>${rows[0]!.map(() => '<w:gridCol w:w="2000"/>').join('')}</w:tblGrid>${trs}</w:tbl>`;
};
export const wordLink = (text: string) => `<w:p><w:hyperlink r:id="rId9"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>${text}</w:t></w:r></w:hyperlink></w:p>`;

/** A clean Word file: title, language, headings in order, described image, decorative image, header row, named link. */
export function cleanDocx(): Uint8Array {
  return docx({
    title: 'Family handbook', lang: 'en-US',
    body: [
      para('Family handbook', 'Heading1'), para('School hours, rules and contacts for families.'),
      para('School hours', 'Heading2'), para('Doors open at 8:00.'),
      para('Morning drop-off', 'Heading3'), para('Use the side entrance.'),
      para('Contacts', 'SectionTitle'),
      wordImage({ descr: 'Map of the school grounds with the side entrance marked' }), wordImage({ decorative: true }), wordShape(),
      wordTable([['Day', 'Opens'], ['Monday', '8:00'], ['Tuesday', '8:00']], 'tblHeader'),
      wordTable([['Day', 'Closes'], ['Monday', '15:00']], 'firstRow'),
      // A one-row layout table is never asked for a header row.
      wordTable([['Left', 'Right']], 'none'),
      wordLink('Read the full calendar'),
      boldPara('Bold text inside a section is fine when real headings exist.'),
    ].join(''),
  });
}

/** A broken Word file: no title, no language, an image without alt text, a heading skip, a table without a header, a raw URL link. */
export function brokenDocx(): Uint8Array {
  return docx({
    body: [
      para('Board minutes', 'Heading1'), para('Minutes of the October meeting.'),
      para('Votes', 'Heading3'), para('The board approved the budget.'),
      wordImage(), wordImage({ descr: '', title: '' }),
      wordTable([['Name', 'Vote'], ['Smith', 'Yes'], ['Jones', 'No']], 'none'),
      wordLink('https://example.org/minutes/october'),
    ].join(''),
    settings: '<w:documentProtection w:edit="readOnly" w:enforcement="1"/>',
  });
}

/** Word with no heading styles at all, but short bold lines that look like headings. */
export function fakeHeadingsDocx(): Uint8Array {
  return docx({
    title: 'Newsletter', lang: 'en-US',
    body: [
      boldPara('Welcome back'), para('The school year starts on Monday.'), para('Buses run as usual.'),
      boldPara('Lunch menu'), para('Lunch is free for every student this year.'),
      boldPara('Sports'), para('Tryouts are next week.'), para('Bring water.'),
    ].join(''),
  });
}

// PowerPoint ------------------------------------------------------------------------------------

export interface SlideOptions {
  title?: string;
  /** A title placeholder with no text. */
  emptyTitle?: boolean;
  body?: string;
  lang?: string;
  hidden?: boolean;
  extra?: string;
}

export const slide = (s: SlideOptions) => `${XML}<p:sld ${P}${s.hidden ? ' show="0"' : ''}><p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
${s.title !== undefined || s.emptyTitle ? `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:p>${s.emptyTitle ? '' : `<a:r><a:rPr lang="${s.lang ?? 'en-US'}"/><a:t>${s.title}</a:t></a:r>`}</a:p></p:txBody></p:sp>` : ''}
${s.body ? `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content 2"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:p><a:r>${s.lang === '' ? '<a:rPr/>' : `<a:rPr lang="${s.lang ?? 'en-US'}"/>`}<a:t>${s.body}</a:t></a:r></a:p></p:txBody></p:sp>` : ''}
${s.extra ?? ''}
</p:spTree></p:cSld></p:sld>`;

export const slidePic = (alt: { descr?: string; decorative?: boolean } = {}) =>
  `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 3"${alt.descr !== undefined ? ` descr="${alt.descr}"` : ''}${alt.decorative ? `>${DECORATIVE}</p:cNvPr>` : '/>'}<p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill/><p:spPr/></p:pic>`;
export const slideTable = (rows: string[][], firstRow: boolean) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Table 4"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr${firstRow ? ' firstRow="1" bandRow="1"' : ''}/><a:tblGrid>${rows[0]!.map(() => '<a:gridCol w="100"/>').join('')}</a:tblGrid>${rows.map((r) => `<a:tr h="10">${r.map((c) => `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US"/><a:t>${c}</a:t></a:r></a:p></a:txBody></a:tc>`).join('')}</a:tr>`).join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
export const slideLink = (text: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="6" name="Link"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US"><a:hlinkClick r:id="rId5"/></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;

export function pptx(o: { title?: string; slides: string[]; presentation?: string }): Uint8Array {
  return zip([
    { name: '[Content_Types].xml', data: types('ppt/presentation.xml') },
    { name: 'docProps/core.xml', data: core(o.title) },
    { name: 'ppt/presentation.xml', data: `${XML}<p:presentation ${P}>${o.presentation ?? ''}<p:sldIdLst>${o.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst></p:presentation>` },
    // Not slides: layouts and masters are never read as slides.
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: slide({ body: 'Layout' }) },
    ...o.slides.map((s, i) => ({ name: `ppt/slides/slide${i + 1}.xml`, data: s })),
  ]);
}

export function cleanPptx(): Uint8Array {
  return pptx({
    title: 'Bond measure update',
    slides: [
      slide({ title: 'Bond measure update', body: 'November 2026' }),
      slide({ title: 'What the bond pays for', body: 'Roofs, heating and safety.', extra: slidePic({ descr: 'Chart of spending by school' }) + slidePic({ decorative: true }) }),
      slide({ title: 'Timeline', extra: slideTable([['Year', 'Work'], ['2027', 'Roofs']], true) + slideLink('See the full timeline') }),
      // A hidden slide is never presented, so its missing title does not count.
      slide({ body: 'Speaker notes only', hidden: true }),
    ],
  });
}

export function brokenPptx(): Uint8Array {
  return pptx({
    slides: [
      slide({ body: 'No title on this slide', lang: '' }),
      slide({ emptyTitle: true, body: 'An empty title', lang: '', extra: slidePic() }),
      slide({ title: 'Budget', lang: '', extra: slideTable([['Item', 'Cost'], ['Roof', '$1M']], false) + slideLink('https://example.org/bond') }),
    ].map((s) => s.replace(/ lang="en-US"/g, '')),
  });
}

// Excel -----------------------------------------------------------------------------------------

export function xlsx(o: { title?: string; sheets: { name: string; merges?: string[]; hidden?: boolean }[]; drawing?: string }): Uint8Array {
  return zip([
    { name: '[Content_Types].xml', data: types('xl/workbook.xml') },
    { name: 'docProps/core.xml', data: core(o.title) },
    { name: 'xl/workbook.xml', data: `${XML}<workbook ${X}><sheets>${o.sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    ...o.sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: `${XML}<worksheet ${X}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Header</t></is></c></row></sheetData>${s.merges?.length ? `<mergeCells count="${s.merges.length}">${s.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''}</worksheet>`,
    })),
    ...(o.drawing ? [{ name: 'xl/drawings/drawing1.xml', data: o.drawing }] : []),
  ]);
}

export const sheetDrawing = (pics: { descr?: string; decorative?: boolean }[]) =>
  `${XML}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${pics.map((p, i) =>
    `<xdr:twoCellAnchor><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="Picture ${i + 1}"${p.descr !== undefined ? ` descr="${p.descr}"` : ''}${p.decorative ? `>${DECORATIVE}</xdr:cNvPr>` : '/>'}<xdr:cNvPicPr/></xdr:nvPicPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`).join('')}</xdr:wsDr>`;

export function cleanXlsx(): Uint8Array {
  return xlsx({
    title: 'Enrollment by school',
    sheets: [{ name: 'Enrollment', merges: ['A10:B10'] }, { name: 'Notes' }, { name: 'Sheet3', hidden: true }],
    drawing: sheetDrawing([{ descr: 'Enrollment trend, rising each year' }, { decorative: true }]),
  });
}

export function brokenXlsx(): Uint8Array {
  return xlsx({
    sheets: [{ name: 'Sheet1', merges: ['A1:D1'] }, { name: 'Sheet2' }],
    drawing: sheetDrawing([{}, { descr: '' }]),
  });
}

// Containers that are not OOXML ----------------------------------------------------------------

const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** An OLE compound file header followed by `streams` names in UTF-16LE (what a directory holds). */
export function oleFile(streams: string[]): Uint8Array {
  const names = Buffer.concat(streams.map((s) => Buffer.from(`${s}\u0000`, 'utf16le')));
  return new Uint8Array(Buffer.concat([Buffer.from(OLE), Buffer.alloc(504), names]));
}

/** A password-protected OOXML file: Office stores it inside an OLE container. */
export const encryptedOffice = () => oleFile(['EncryptionInfo', 'EncryptedPackage']);
/** A legacy binary .doc. */
export const legacyDoc = () => oleFile(['WordDocument', '1Table']);
