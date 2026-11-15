// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Quick checks on Word, Excel and PowerPoint files (.docx, .xlsx, .pptx): the document title and
// language, images without alt text, headings, table header rows, slide titles, sheet names, link text
// and password protection. Rules only, no AI; read with the bounded zip and XML reader (ooxml.ts).
// Engine core: no Node-only imports.
//
// Problem findings count in the documents check since v10 (docs/scoring.md, Documents). Each
// check is conservative: when the file does not say, the check is left out ("could not tell"), never
// failed. `officeFindings` words them, each with its WCAG criterion and a level: a `problem` (what the
// Office accessibility checker calls an error) or a `hint` (worth a look, may be fine).
import type { OfficeChecks, OfficeFinding, OfficeFormat } from '../types.js';
import { OoxmlError, ZipReader, attr, decodeEntities, isOle, isZip, oleIsEncrypted, onOff, scanXml as scanAll, type XmlHandler, type ZipLimits } from './ooxml.js';

export { OoxmlError as OfficeCheckError } from './ooxml.js';

export interface OfficeLimits {
  /** Time box for reading one file. */
  timeoutMs: number;
  /** Parts (zip entries) in one file. Default 5,000. */
  maxEntries?: number;
  /** Bytes inflated from one part (XML). Default 8 MB. */
  maxPartBytes?: number;
  /** Bytes inflated from the whole file. Default 32 MB. */
  maxTotalBytes?: number;
  /** Slides read. Default 200. */
  maxSlides?: number;
  /** Worksheets and drawings read (each). Default 50. */
  maxSheets?: number;
}

export const DEFAULT_OFFICE_LIMITS: Readonly<Required<OfficeLimits>> = {
  timeoutMs: 5000, maxEntries: 5000, maxPartBytes: 8 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024, maxSlides: 200, maxSheets: 50,
};

/** File extensions by format, for the messages. */
export const OFFICE_EXTENSIONS: Readonly<Record<OfficeFormat, { modern: string; legacy: string; name: string }>> = {
  docx: { modern: '.docx', legacy: '.doc', name: 'Word' },
  xlsx: { modern: '.xlsx', legacy: '.xls', name: 'Excel' },
  pptx: { modern: '.pptx', legacy: '.ppt', name: 'PowerPoint' },
};

/** A legacy binary file's `notChecked`: what it is and how to have it checked. */
export function legacyNote(format: OfficeFormat | undefined): string {
  const e = format ? OFFICE_EXTENSIONS[format] : undefined;
  return e ? `Legacy binary format (${e.legacy}); save it as ${e.modern} to have it checked` : 'Legacy binary format; save it as .docx, .xlsx or .pptx to have it checked';
}

const PLACEHOLDER_TITLE =
  /^(?:untitled(?: document)?|title|document\s*\d*|book\s*\d*|presentation\s*\d*|(?:microsoft )?(?:word|powerpoint|excel)(?: document| presentation| workbook)?(?: - .*)?|powerpoint presentation|.*\.(?:pdf|docx?|pptx?|xlsx?|rtf|odt|txt))$/i;
const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i;
/** Sheet names Excel gives new sheets, in common display languages: the word and a number, no space ("Sheet1"). */
const DEFAULT_SHEET = /^(?:sheet|feuil|hoja|tabelle|foglio|planilha|plan|blad|arkusz|list|munkalap|taulukko|ark)\d+$/i;
/** Link text that is a web address. */
const RAW_URL = /^(?:https?:\/\/|www\.)\S+$/i;

/**
 * Reads one Office file and runs the quick checks. `format` is the type the link or server gave
 * (used for an encrypted file, whose format cannot be read). Throws `OfficeCheckError` (kind `legacy`
 * for a .doc/.xls/.ppt binary, `time` past the time box, else `unreadable`) with a plain message.
 */
export async function checkOffice(bytes: Uint8Array, format: OfficeFormat | undefined, limits: OfficeLimits = DEFAULT_OFFICE_LIMITS): Promise<OfficeChecks> {
  const lim = { ...DEFAULT_OFFICE_LIMITS, ...limits };
  const deadline = Date.now() + lim.timeoutMs;
  if (isOle(bytes)) {
    if (oleIsEncrypted(bytes)) return { format: format ?? 'docx', passwordToOpen: true };
    throw new OoxmlError(legacyNote(format), 'legacy');
  }
  if (!isZip(bytes)) throw new OoxmlError('Not a Word, Excel or PowerPoint file');
  const zipLimits: ZipLimits = { maxEntries: lim.maxEntries, maxEntryBytes: lim.maxPartBytes, maxTotalBytes: lim.maxTotalBytes, deadline };
  const zip = new ZipReader(bytes, zipLimits);
  const found: OfficeFormat | undefined = zip.has('word/document.xml') ? 'docx' : zip.has('xl/workbook.xml') ? 'xlsx' : zip.has('ppt/presentation.xml') ? 'pptx' : undefined;
  if (!found) {
    if (zip.has('mimetype')) throw new OoxmlError('An OpenDocument file: only Word, Excel and PowerPoint files are checked');
    throw new OoxmlError('Not a Word, Excel or PowerPoint file');
  }
  const checks: OfficeChecks = { format: found, ...(await coreTitle(zip, deadline)) };
  if (found === 'docx') Object.assign(checks, await checkDocx(zip, deadline));
  else if (found === 'pptx') Object.assign(checks, await checkPptx(zip, deadline, lim.maxSlides));
  else Object.assign(checks, await checkXlsx(zip, deadline, lim.maxSheets));
  if (zip.cut) checks.partial = true;
  return checks;
}

/** docProps/core.xml dc:title: set, and not a file name or a default name. */
async function coreTitle(zip: ZipReader, deadline: number): Promise<Pick<OfficeChecks, 'hasTitle'>> {
  const core = await zip.text('docProps/core.xml');
  if (!core) return zip.cut ? {} : { hasTitle: false };
  let inTitle = false;
  let title = '';
  scanXml(core.text, {
    open: (name) => { if (name === 'title') inTitle = true; },
    close: (name) => { if (name === 'title') inTitle = false; },
    text: (raw) => { if (inTitle && title.length < 500) title += raw; },
  }, deadline);
  const t = decodeEntities(title).replace(/\s+/g, ' ').trim();
  return { hasTitle: t !== '' && !PLACEHOLDER_TITLE.test(t) };
}

/**
 * Walks the XML as Office reads it: mc:AlternateContent holds the same object twice (the first choice,
 * then a fallback copy for older readers), so everything inside mc:Fallback is skipped and a picture is
 * never counted twice. Every open of Fallback, an empty one too, is matched by a close (scanXml).
 */
function scanXml(xml: string, h: XmlHandler, deadline?: number): void {
  let skip = 0;
  scanAll(xml, {
    open: (name, tag, self) => {
      if (name === 'Fallback') skip++;
      else if (!skip) h.open(name, tag, self);
    },
    close: (name) => {
      if (name === 'Fallback') skip = Math.max(0, skip - 1);
      else if (!skip) h.close(name);
    },
    ...(h.text ? { text: (raw: string) => { if (!skip) h.text!(raw); } } : {}),
  }, deadline);
}

// Images ----------------------------------------------------------------------------------------

/** An image's description holder (wp:docPr, p:cNvPr, xdr:cNvPr) and whether it is marked decorative. */
interface Pic { described: boolean; decorative: boolean; picture: boolean; inProps: boolean }

const described = (tag: string) => !!(attr(tag, 'descr')?.trim() || attr(tag, 'title')?.trim());

// Word ------------------------------------------------------------------------------------------

interface StyleDef { name: string; outline?: number; basedOn?: string }

/**
 * From word/styles.xml: the paragraph styles that are headings, by style id (level 1–9, from a
 * "heading N" name or an outline level, following basedOn), and whether a default language is set.
 */
function readStyles(xml: string | undefined, deadline: number): { headings: Map<string, number>; lang: boolean } {
  const defs = new Map<string, StyleDef>();
  let lang = false;
  let cur: (StyleDef & { id: string }) | undefined;
  if (xml) {
    scanXml(xml, {
      open: (name, tag, self) => {
        if (name === 'lang' && !lang) lang = langSet(tag);
        if (name === 'style' && !self) {
          cur = attr(tag, 'type') === 'paragraph' ? { id: attr(tag, 'styleId') ?? '', name: '' } : undefined;
          return;
        }
        if (!cur) return;
        if (name === 'name') cur.name = attr(tag, 'val') ?? '';
        else if (name === 'basedOn') cur.basedOn = attr(tag, 'val');
        else if (name === 'outlineLvl') {
          const v = Number(attr(tag, 'val'));
          if (Number.isInteger(v)) cur.outline = v;
        }
      },
      close: (name) => {
        if (name !== 'style' || !cur) return;
        if (cur.id && !defs.has(cur.id)) defs.set(cur.id, cur);
        cur = undefined;
      },
    }, deadline);
  }
  const headings = new Map<string, number>();
  for (const id of defs.keys()) {
    // Follow basedOn (bounded: a loop in the file never hangs) to the first name or outline level that decides.
    let d = defs.get(id);
    for (let hop = 0; d && hop < 12; hop++, d = d.basedOn ? defs.get(d.basedOn) : undefined) {
      const m = /^heading\s*([1-9])$/i.exec(d.name.trim());
      if (m) {
        headings.set(id, Number(m[1]));
        break;
      }
      if (d.outline !== undefined) {
        if (d.outline >= 0 && d.outline <= 8) headings.set(id, d.outline + 1);
        break;
      }
    }
  }
  // Word's built-in ids, when styles.xml is missing or cut.
  for (let n = 1; n <= 9; n++) if (!defs.has(`Heading${n}`)) headings.set(`Heading${n}`, n);
  return { headings, lang };
}

/** The longest short line that may still be a heading. */
const FAKE_HEADING_MAX = 80;
/** Fake headings counted only in documents with at least this many paragraphs of text. */
const FAKE_HEADING_MIN_PARAGRAPHS = 5;
/** And only when there are at least this many: a letter's bold subject line and signature are not sections. */
const FAKE_HEADING_MIN = 3;
/** w:sz is in half-points: 28 = 14 pt. */
const LARGE_TEXT = 28;
/** Nesting kept per stack (paragraphs in text boxes, tables in cells): deeper is ignored. */
const MAX_NEST = 64;

/** A stack capped at MAX_NEST: an open past the cap is counted, not kept, and its close pops nothing. */
class Nest<T> {
  private readonly items: T[] = [];
  private over = 0;
  push(v: T): void {
    if (this.items.length < MAX_NEST && this.over === 0) this.items.push(v);
    else this.over++;
  }
  pop(): T | undefined {
    if (this.over > 0) {
      this.over--;
      return undefined;
    }
    return this.items.pop();
  }
  /** The innermost kept element; undefined past the cap. */
  top(): T | undefined {
    return this.over > 0 ? undefined : this.items[this.items.length - 1];
  }
  get size(): number {
    return this.items.length + this.over;
  }
}

interface Para { level?: number; text: string; runs: number; plainRuns: number; numbered: boolean; inTable: boolean }
interface Run { bold: boolean; large: boolean; text: boolean; inProps: boolean }
interface Table { rows: number; cols: number; rowCells: number; header: boolean; lookFirstRow: boolean }
const newTable = (): Table => ({ rows: 0, cols: 0, rowCells: 0, header: false, lookFirstRow: false });

async function checkDocx(zip: ZipReader, deadline: number): Promise<Partial<OfficeChecks>> {
  const styles = await zip.text('word/styles.xml');
  const { headings, lang: defaultLang } = readStyles(styles?.text, deadline);
  let lang = defaultLang;
  const out: Partial<OfficeChecks> = {};

  const settings = await zip.text('word/settings.xml');
  if (settings) {
    scanXml(settings.text, {
      open: (name, tag) => { if (name === 'documentProtection' && onOffAttr(attr(tag, 'enforcement'))) out.editingRestricted = true; },
      close: () => {},
    }, deadline);
  }

  const doc = await zip.text('word/document.xml');
  if (!doc) {
    if (lang) out.hasLanguage = true;
    return out;
  }

  let images = 0;
  let imagesWithoutAlt = 0;
  const drawings = new Nest<Pic>();
  let lastLevel: number | undefined;
  let headingCount = 0;
  let headingSkips = 0;
  let fakeHeadings = 0;
  let paragraphs = 0;
  const tables = new Nest<Table>();
  let tableCount = 0;
  let tablesWithoutHeader = 0;
  let links = 0;
  let rawUrlLinks = 0;
  let linkDepth = 0;
  let linkText = '';
  const paras = new Nest<Para>();
  const runs = new Nest<Run>();
  let inText = 0;
  let wordText = false;

  scanXml(doc.text, {
    open: (name, tag, self) => {
      const para = paras.top();
      const run = runs.top();
      const table = tables.top();
      switch (name) {
        case 'lang': if (!lang) lang = langSet(tag); break;
        case 'inline': case 'anchor': drawings.push({ described: false, decorative: false, picture: false, inProps: false }); break;
        case 'docPr': { const d = drawings.top(); if (d) { d.described = described(tag); d.inProps = !self; } break; }
        case 'decorative': { const d = drawings.top(); if (d?.inProps && onOff(tag)) d.decorative = true; break; }
        case 'pic': { const d = drawings.top(); if (d) d.picture = true; break; }
        // Every open pushes, an empty element too: scanXml closes it at once, and the close pops it.
        case 'p': paras.push({ text: '', runs: 0, plainRuns: 0, numbered: false, inTable: tables.size > 0 }); break;
        case 'pStyle': if (para && !run) { const l = headings.get(attr(tag, 'val') ?? ''); if (l !== undefined) para.level = l; } break;
        case 'outlineLvl': if (para && !run) { const v = Number(attr(tag, 'val')); if (Number.isInteger(v) && v >= 0 && v <= 8) para.level = v + 1; } break;
        case 'numPr': if (para) para.numbered = true; break;
        case 'r': runs.push({ bold: false, large: false, text: false, inProps: false }); break;
        case 'rPr': if (run) run.inProps = true; break;
        case 'b': if (run?.inProps && onOff(tag)) run.bold = true; break;
        case 'sz': if (run?.inProps && Number(attr(tag, 'val')) >= LARGE_TEXT) run.large = true; break;
        case 't': inText++; break;
        case 'tbl': tables.push(newTable()); break;
        case 'tblLook':
          if (table && table.rows === 0) {
            const first = attr(tag, 'firstRow');
            const val = parseInt(attr(tag, 'val') ?? '', 16);
            table.lookFirstRow = first !== undefined ? onOffAttr(first) : Number.isFinite(val) && (val & 0x20) !== 0;
          }
          break;
        case 'tr': if (table) { table.rows++; table.rowCells = 0; } break;
        case 'tc': if (table) table.rowCells++; break;
        case 'tblHeader': if (table && table.rows === 1 && onOff(tag)) table.header = true; break;
        case 'hyperlink': if (linkDepth++ === 0) linkText = ''; break;
      }
    },
    close: (name) => {
      switch (name) {
        case 'docPr': { const d = drawings.top(); if (d) d.inProps = false; break; }
        case 'inline': case 'anchor': {
          const d = drawings.pop();
          if (d?.picture) {
            images++;
            if (!d.described && !d.decorative) imagesWithoutAlt++;
          }
          break;
        }
        case 't': if (inText > 0) inText--; break;
        case 'rPr': { const r = runs.top(); if (r) r.inProps = false; break; }
        case 'r': {
          const r = runs.pop();
          const p = paras.top();
          if (p && r?.text) {
            p.runs++;
            if (!r.bold && !r.large) p.plainRuns++;
          }
          break;
        }
        case 'p': {
          const p = paras.pop();
          if (!p) break;
          const text = p.text.trim();
          if (text) paragraphs++;
          if (p.level !== undefined && text) {
            if (lastLevel !== undefined && p.level > lastLevel + 1) headingSkips++;
            lastLevel = p.level;
            headingCount++;
          } else if (text && !p.inTable && !p.numbered && p.runs > 0 && p.plainRuns === 0 && text.length <= FAKE_HEADING_MAX && !/[.!?;,]$/.test(text)) {
            fakeHeadings++;
          }
          break;
        }
        case 'tr': { const t = tables.top(); if (t) t.cols = Math.max(t.cols, t.rowCells); break; }
        case 'tbl': {
          const t = tables.pop();
          if (t && t.rows >= 2 && t.cols >= 2) {
            tableCount++;
            if (!t.header && !t.lookFirstRow) {
              tablesWithoutHeader++;
            }
          }
          break;
        }
        case 'hyperlink':
          if (linkDepth > 0 && --linkDepth === 0) {
            const text = decodeEntities(linkText).trim();
            if (text) {
              links++;
              if (RAW_URL.test(text)) rawUrlLinks++;
            }
          }
          break;
      }
    },
    text: (raw) => {
      if (!inText) return;
      if (raw.trim()) wordText = true;
      const p = paras.top();
      const r = runs.top();
      if (p && p.text.length < 400) p.text += decodeEntities(raw);
      if (r && raw.trim()) r.text = true;
      if (linkDepth > 0 && linkText.length < 400) linkText += raw;
    },
  }, deadline);

  if (lang) out.hasLanguage = true;
  else if (!doc.cut && !styles?.cut) out.hasLanguage = false;
  Object.assign(out, {
    images, imagesWithoutAlt,
    headings: headingCount, headingSkips,
    // Short bold or large lines count only in a document with no real headings at all.
    fakeHeadings: headingCount === 0 && paragraphs >= FAKE_HEADING_MIN_PARAGRAPHS && fakeHeadings >= FAKE_HEADING_MIN ? fakeHeadings : 0,
    tables: tableCount, tablesWithoutHeader,
    links, rawUrlLinks,
    // Batch 18: a neutral fact for the AI review (a scanned page pasted in as a picture); no finding reads it.
    ...(images > 0 && !wordText && !doc.cut ? { pictureOnly: true as const } : {}),
  });
  return out;
}

/** A w:lang / a:lang tag that sets a language (`val` in Word, `lang` in DrawingML). */
function langSet(tag: string): boolean {
  for (const k of ['val', 'eastAsia', 'bidi', 'lang']) {
    const v = attr(tag, k);
    if (v && LANGUAGE_TAG.test(v.trim())) return true;
  }
  return false;
}

// PowerPoint ------------------------------------------------------------------------------------

/** Slide part names in slide order (slide1, slide2…), at most `max`. */
function partsInOrder(zip: ZipReader, pattern: RegExp, max: number): { names: string[]; more: boolean } {
  const all = zip.names().map((n) => ({ n, m: pattern.exec(n) })).filter((x) => x.m).map((x) => ({ n: x.n, k: Number(x.m![1]) }));
  all.sort((a, b) => a.k - b.k);
  return { names: all.slice(0, max).map((x) => x.n), more: all.length > max };
}

async function checkPptx(zip: ZipReader, deadline: number, maxSlides: number): Promise<Partial<OfficeChecks>> {
  const out: Partial<OfficeChecks> = {};
  let lang = false;
  const pres = await zip.text('ppt/presentation.xml');
  if (pres) {
    scanXml(pres.text, {
      open: (name, tag) => {
        if (!lang && (name === 'defRPr' || name === 'rPr' || name === 'endParaRPr') && langSet(tag)) lang = true;
        if (name === 'modifyVerifier') out.editingRestricted = true;
      },
      close: () => {},
    }, deadline);
  }
  const { names, more } = partsInOrder(zip, /^ppt\/slides\/slide(\d+)\.xml$/, maxSlides);
  if (more) zip.cut = true;
  let slides = 0;
  let slidesWithoutTitle = 0;
  let images = 0;
  let imagesWithoutAlt = 0;
  let tables = 0;
  let tablesWithoutHeader = 0;
  let links = 0;
  let rawUrlLinks = 0;
  let anyText = false;

  for (const name of names) {
    const part = await zip.text(name);
    if (!part) break;
    let hidden = false;
    let titled = false;
    // The shape being read: is it a title placeholder, and does it hold text?
    let shape: { title: boolean; text: boolean } | undefined;
    const pics = new Nest<Pic>();
    const tbls = new Nest<Table>();
    let r: { link: boolean; text: string } | undefined;
    let inText = false;
    const counts = { images: 0, missing: 0, tables: 0, noHeader: 0, links: 0, raw: 0 };
    scanXml(part.text, {
      open: (n, tag, self) => {
        switch (n) {
          case 'sld': hidden = attr(tag, 'show') === '0' || attr(tag, 'show') === 'false'; break;
          case 'sp': shape = { title: false, text: false }; break;
          case 'ph': { const t = attr(tag, 'type'); if (shape && (t === 'title' || t === 'ctrTitle')) shape.title = true; break; }
          case 'pic': pics.push({ described: false, decorative: false, picture: true, inProps: false }); break;
          case 'cNvPr': { const p = pics.top(); if (p) { p.described = described(tag); p.inProps = !self; } break; }
          case 'decorative': { const p = pics.top(); if (p?.inProps && onOff(tag)) p.decorative = true; break; }
          case 'tbl': tbls.push(newTable()); break;
          case 'tblPr': { const t = tbls.top(); if (t && onOffAttr(attr(tag, 'firstRow'))) t.header = true; break; }
          case 'tr': { const t = tbls.top(); if (t) { t.rows++; t.rowCells = 0; } break; }
          case 'tc': { const t = tbls.top(); if (t) t.rowCells++; break; }
          case 'r': r = { link: false, text: '' }; break;
          case 'rPr': case 'endParaRPr': case 'defRPr': if (!lang && langSet(tag)) lang = true; break;
          case 'hlinkClick': if (r) r.link = true; break;
          case 't': if (!self) inText = true; break;
        }
      },
      close: (n) => {
        switch (n) {
          case 'sp': if (shape?.title && shape.text) titled = true; shape = undefined; break;
          case 'cNvPr': { const p = pics.top(); if (p) p.inProps = false; break; }
          case 'pic': {
            const p = pics.pop();
            if (p) { counts.images++; if (!p.described && !p.decorative) counts.missing++; }
            break;
          }
          case 'tr': { const t = tbls.top(); if (t) t.cols = Math.max(t.cols, t.rowCells); break; }
          case 'tbl': {
            const t = tbls.pop();
            if (t && t.rows >= 2 && t.cols >= 2) {
              counts.tables++;
              if (!t.header) counts.noHeader++;
            }
            break;
          }
          case 'r': {
            const text = decodeEntities(r?.text ?? '').trim();
            if (r?.link && text) { counts.links++; if (RAW_URL.test(text)) counts.raw++; }
            r = undefined;
            break;
          }
          case 't': inText = false; break;
        }
      },
      text: (raw) => {
        if (!inText || !raw.trim()) return;
        anyText = true;
        if (shape) shape.text = true;
        if (r && r.text.length < 400) r.text += raw;
      },
    }, deadline);
    if (hidden) continue; // never presented
    slides++;
    if (!titled && !part.cut) slidesWithoutTitle++;
    images += counts.images;
    imagesWithoutAlt += counts.missing;
    tables += counts.tables;
    tablesWithoutHeader += counts.noHeader;
    links += counts.links;
    rawUrlLinks += counts.raw;
  }
  Object.assign(out, { slides, slidesWithoutTitle, images, imagesWithoutAlt, tables, tablesWithoutHeader, links, rawUrlLinks });
  // Batch 18: a neutral fact for the AI review (slides that are pictures only); no finding reads it.
  if (images > 0 && !anyText && !zip.cut) out.pictureOnly = true;
  // No text anywhere: nothing to pronounce, so the language is not judged.
  if (lang) out.hasLanguage = true;
  else if (anyText && !zip.cut) out.hasLanguage = false;
  return out;
}

const onOffAttr = (v: string | undefined) => v !== undefined && /^(?:1|true|on)$/i.test(v);

// Excel -----------------------------------------------------------------------------------------

/** The first two rows are the header area: a merge that starts there is worth a look. */
const HEADER_ROWS = 2;

async function checkXlsx(zip: ZipReader, deadline: number, maxSheets: number): Promise<Partial<OfficeChecks>> {
  const out: Partial<OfficeChecks> = {};
  const wb = await zip.text('xl/workbook.xml');
  let sheets = 0;
  let defaultSheetNames = 0;
  if (wb) {
    scanXml(wb.text, {
      open: (name, tag) => {
        if (name === 'sheet') {
          const state = attr(tag, 'state');
          if (state === 'hidden' || state === 'veryHidden') return;
          sheets++;
          if (DEFAULT_SHEET.test((attr(tag, 'name') ?? '').trim())) defaultSheetNames++;
        } else if (name === 'workbookProtection' && (attr(tag, 'lockStructure') === '1' || attr(tag, 'lockStructure') === 'true')) {
          out.editingRestricted = true;
        }
      },
      close: () => {},
    }, deadline);
  }
  Object.assign(out, { sheets, defaultSheetNames });

  // Merged cells in the header area, per worksheet. The merge list follows the cell data, so a cut
  // sheet says nothing about its merges.
  const ws = partsInOrder(zip, /^xl\/worksheets\/sheet(\d+)\.xml$/, maxSheets);
  if (ws.more) zip.cut = true;
  let mergedHeaderSheets = 0;
  for (const name of ws.names) {
    const part = await zip.text(name);
    if (!part) break;
    let merged = false;
    scanXml(part.text, {
      open: (n, tag) => {
        if (n === 'sheetProtection' && onOffAttr(attr(tag, 'sheet'))) out.editingRestricted = true;
        if (n !== 'mergeCell' || merged) return;
        const m = /^\$?[A-Z]{1,3}\$?(\d{1,7})(?::\$?[A-Z]{1,3}\$?(\d{1,7}))?$/i.exec(attr(tag, 'ref') ?? '');
        if (m && Number(m[1]) <= HEADER_ROWS && rangeWide(attr(tag, 'ref')!)) merged = true;
      },
      close: () => {},
    }, deadline);
    if (merged) mergedHeaderSheets++;
  }
  out.mergedHeaderSheets = mergedHeaderSheets;

  // Pictures in the drawings (charts and shapes are left out).
  const dr = partsInOrder(zip, /^xl\/drawings\/drawing(\d+)\.xml$/, maxSheets);
  if (dr.more) zip.cut = true;
  let images = 0;
  let imagesWithoutAlt = 0;
  for (const name of dr.names) {
    const part = await zip.text(name);
    if (!part) break;
    const pics = new Nest<Pic>();
    scanXml(part.text, {
      open: (n, tag, self) => {
        if (n === 'pic') pics.push({ described: false, decorative: false, picture: true, inProps: false });
        else if (n === 'cNvPr') { const p = pics.top(); if (p) { p.described = described(tag); p.inProps = !self; } }
        else if (n === 'decorative') { const p = pics.top(); if (p?.inProps && onOff(tag)) p.decorative = true; }
      },
      close: (n) => {
        if (n === 'cNvPr') { const p = pics.top(); if (p) p.inProps = false; }
        else if (n === 'pic') { const p = pics.pop(); if (p) { images++; if (!p.described && !p.decorative) imagesWithoutAlt++; } }
      },
    }, deadline);
  }
  Object.assign(out, { images, imagesWithoutAlt });
  return out;
}

/** A merge that spans more than one cell. */
function rangeWide(ref: string): boolean {
  const [a, b] = ref.split(':');
  return !!b && a!.replace(/\$/g, '').toUpperCase() !== b.replace(/\$/g, '').toUpperCase();
}

// Findings --------------------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The quick checks' findings in plain words, each with its WCAG criterion and level: `problem` (the
 * file fails the check) or `hint` (worth a look; it may be fine). Empty when nothing was found.
 */
export function officeFindings(c: OfficeChecks): OfficeFinding[] {
  const out: OfficeFinding[] = [];
  const add = (key: OfficeFinding['key'], criterion: string, level: OfficeFinding['level'], text: string) => out.push({ key, criterion, level, text });
  if (c.passwordToOpen) add('password', '1.3.1', 'problem', 'It needs a password to open, so screen readers cannot read it.');
  if (c.imagesWithoutAlt) add('alt', '1.1.1', 'problem', `${plural(c.imagesWithoutAlt, 'image has', 'images have')} no alt text and ${c.imagesWithoutAlt === 1 ? 'is' : 'are'} not marked decorative.`);
  // Header markup does not distinguish layout tables from data tables reliably: always a hint.
  if (c.tablesWithoutHeader) add('tableHeader', '1.3.1', 'hint', `${plural(c.tablesWithoutHeader, 'table has', 'tables have')} no header row marked; it may be a layout table. Data tables need headers.`);
  if (c.slidesWithoutTitle) add('slideTitle', '2.4.2', 'problem', `${plural(c.slidesWithoutTitle, 'slide has', 'slides have')} no title, so people cannot find ${c.slidesWithoutTitle === 1 ? 'it' : 'them'} in the slide list.`);
  if (c.hasLanguage === false) add('language', '3.1.1', 'problem', 'No document language is set, so screen readers may pronounce it wrongly.');
  if (c.hasTitle === false) add('title', '2.4.2', 'problem', 'No title is set, so people see the file name instead.');
  if (c.headingSkips) add('headingOrder', '1.3.1', 'hint', `Heading levels skip ${plural(c.headingSkips, 'time', 'times')} (for example from Heading 1 to Heading 3).`);
  if (c.fakeHeadings) add('fakeHeadings', '1.3.1', 'hint', `No heading styles: ${plural(c.fakeHeadings, 'short bold or large line looks', 'short bold or large lines look')} like a heading. Heading styles let people jump between sections.`);
  if (c.rawUrlLinks) add('linkText', '2.4.4', 'hint', `${plural(c.rawUrlLinks, 'link shows', 'links show')} a web address as ${c.rawUrlLinks === 1 ? 'its' : 'their'} text; words that say where ${c.rawUrlLinks === 1 ? 'it goes read' : 'they go read'} better.`);
  if (c.defaultSheetNames) add('sheetNames', '2.4.6', 'hint', `${plural(c.defaultSheetNames, 'sheet keeps', 'sheets keep')} a default name (like Sheet1); a name that says what is on it helps people find it.`);
  if (c.mergedHeaderSheets) add('mergedCells', '1.3.1', 'hint', `${plural(c.mergedHeaderSheets, 'sheet has', 'sheets have')} merged cells in the top rows, which screen readers can read out of step with the columns.`);
  return out;
}

/** Only the problems (not the hints). */
export const officeProblems = (c: OfficeChecks) => officeFindings(c).filter((f) => f.level === 'problem');

/** The type a link or server gave, as an Office format (undefined for PDFs and other files). */
export function officeFormat(type: string): OfficeFormat | undefined {
  return type === 'word' ? 'docx' : type === 'excel' ? 'xlsx' : type === 'powerpoint' ? 'pptx' : undefined;
}

/** Thrown errors as `OoxmlError` (anything unexpected is "could not read"). */
export function asOfficeError(err: unknown): OoxmlError {
  return err instanceof OoxmlError ? err : new OoxmlError('Could not read the file (it is damaged or not a Word, Excel or PowerPoint file)');
}
