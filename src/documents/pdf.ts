// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Quick PDF structure checks with pdf.js (the serverless build in `unpdf`, which also runs in
// Cloudflare Workers). Rules only, no AI. `unpdf` is imported lazily, so a scan without PDFs never
// loads pdf.js. Engine core: no Node-only imports.
import type * as Unpdf from 'unpdf';
import type { PdfChecks, PdfDetails, PdfField, PdfFigure, PdfHeading } from '../types.js';
import { decodedSizeWithin, PDF_DECODED_LIMIT, PDF_INLINE_IMAGE_PIXELS, withoutImagePixels, type PdfImageScan } from './pdfGuard.js';

/** A document's `notChecked` when the scan's time limit passed before it was read (documents/index.ts). */
export const TIME_LIMIT_REACHED = 'Time limit reached';

type PdfDocument = Awaited<ReturnType<typeof Unpdf.getDocumentProxy>>;
type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>;

export interface PdfLimits {
  /** Pages read for the per-page checks (tags, figures, form fields). */
  maxPages: number;
  /** Time box for reading one PDF. */
  timeoutMs: number;
  /** Pages searched for a text layer. Default 5. */
  textPages?: number;
  /** `checkPdfDetailed` only: pages read for the figure, heading and field lists. Default 30. */
  detailPages?: number;
  /** The most its non-image streams may decompress to (pdfGuard.ts). Default PDF_DECODED_LIMIT. */
  maxDecodedBytes?: number;
}

export const DEFAULT_PDF_LIMITS: PdfLimits = { maxPages: 20, timeoutMs: 5000, textPages: 5 };

/** Caps on the lists in `PdfDetails`. */
export const PDF_DETAIL_LIMITS = { pages: 30, figures: 40, headings: 60, fields: 40, text: 200 } as const;

/** A PDF that could not be read. `blocksAssistiveTech` is set when it needs a password to open. */
export class PdfCheckError extends Error {
  /** `again`: no answer about the PDF itself (the reader was not reachable): a later run may read it. */
  constructor(message: string, readonly blocksAssistiveTech = false, readonly again = false) {
    super(message);
  }
}

// pdf.js PermissionFlag values (the bits of the PDF /P entry).
const COPY = 16;
const COPY_FOR_ACCESSIBILITY = 512;
const WIDGET = 20; // pdf.js AnnotationType.WIDGET

const PLACEHOLDER_TITLE =
  /^(?:untitled(?: document)?|title|document\d*|microsoft (?:word|powerpoint|excel) - .*|.*\.(?:pdf|docx?|pptx?|xlsx?|rtf|odt|indd|txt))$/i;
const LANGUAGE_TAG = /^[a-z]{2,3}(?:[-_][a-z0-9]{1,8})*$/i;

/**
 * Reads one PDF and runs the quick checks. Throws `PdfCheckError` with a plain-language message.
 * The caller's bytes stay usable: pdf.js gets a copy (it takes over, and detaches, its input buffer).
 */
export async function checkPdf(bytes: Uint8Array, limits: PdfLimits = DEFAULT_PDF_LIMITS): Promise<PdfChecks> {
  return (await readPdf(bytes, limits, false)).checks;
}

/**
 * `checkPdf` (same checks, same errors) plus the facts the AI document review needs: dates, title
 * and language text, and the tagged figures, headings and form fields of the first `detailPages`
 * pages. One read of the file; `checks` is identical to what `checkPdf` returns.
 */
export async function checkPdfDetailed(bytes: Uint8Array, limits: PdfLimits = DEFAULT_PDF_LIMITS): Promise<{ checks: PdfChecks; details: PdfDetails }> {
  const r = await readPdf(bytes, limits, true);
  return { checks: r.checks, details: r.details! };
}

/**
 * One PDF's read: the quick checks, its modification date (PDF ModDate, else XMP; the AI document review's
 * sample order) and, when asked for, the facts the AI document review reads (`checkPdfDetailed`).
 */
export interface PdfRead {
  checks: PdfChecks;
  modified?: string;
  details?: PdfDetails;
}

/**
 * Reads one PDF; throws `PdfCheckError` with a plain-language message. The engine reads in its own
 * thread (`readPdfChecks`); the hosted checker passes one that reads in a separate Worker, so a hostile
 * PDF that exhausts memory or CPU ends only that Worker's invocation, never the scan.
 */
export type PdfReader = (bytes: Uint8Array, o: { limits: PdfLimits; details: boolean; signal?: AbortSignal }) => Promise<PdfRead>;

/**
 * A read stopped by its caller's signal (the scan's time for documents ended): nothing is known about the
 * PDF, so it is never kept (`again`); the inventory says "Time limit reached".
 */
export const READ_STOPPED = 'The read was stopped';
const stopped = () => new PdfCheckError(READ_STOPPED, false, true);

/** The in-process reader (the command line, and the hosted PDF reader Worker itself). */
export const readPdfChecks: PdfReader = (bytes, o) => readPdf(bytes, o.limits, o.details, o.signal);

async function readPdf(bytes: Uint8Array, limits: PdfLimits, details: boolean, signal?: AbortSignal): Promise<PdfRead> {
  if (signal?.aborted) throw stopped();
  const deadline = Date.now() + limits.timeoutMs;
  const late = () => new PdfCheckError(`Took longer than ${duration(limits.timeoutMs)} to read`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let task: { promise: Promise<PdfDocument>; destroy(): Promise<void> } | undefined;
  let ended = false;
  const read = async () => {
    // pdf.js inflates streams with no bound on their decoded size: what it would decode is measured
    // first (pdfGuard.ts), asynchronously, so a decompression bomb is refused before pdf.js sees it.
    const limit = limits.maxDecodedBytes ?? PDF_DECODED_LIMIT;
    const images: PdfImageScan = { count: 0, unknown: false, spans: [] };
    const verdict = await decodedSizeWithin(bytes, limit, deadline, images);
    if (verdict === 'over') throw new PdfCheckError(`Too large to read: it decompresses to more than ${Math.round(limit / 1024 / 1024)} MB`);
    if (verdict === 'time') throw late();
    const { getResolvedPDFJS } = await import('unpdf');
    const pdfjs = await getResolvedPDFJS();
    if (ended) throw late(); // the time box closed meanwhile: pdf.js is never started
    // verbosity 0: pdf.js would otherwise log every oddity in third-party files to the console.
    // (pdf.js 6 no longer compiles font programs with eval, so there is no isEvalSupported switch.)
    // No image is ever decoded (pdf.js decodes every image of a page whose drawing operators are read, and a
    // scan can be a hundred megabytes of pixels): in the copy pdf.js reads, each image stream is one pixel
    // with no filter (`withoutImagePixels`). Nothing here reads an image's pixels; where an image is drawn,
    // and how large, is in the page's content, which is untouched. Inline images above a small size are dropped.
    task = pdfjs.getDocument({
      data: withoutImagePixels(bytes, images), verbosity: 0, useSystemFonts: false, disableFontFace: true, enableXfa: false, stopAtErrors: false, maxImageSize: PDF_INLINE_IMAGE_PIXELS,
    });
    // What the page draws is measured only when the image scan can be relied on.
    return inspect(await task.promise, limits, details, images.unknown ? undefined : (pdfjs as unknown as { OPS?: Record<string, number> }).OPS);
  };
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(late()), limits.timeoutMs);
        // The caller's stop (the scan's time for documents): pdf.js is destroyed below, at its next step.
        onAbort = () => reject(stopped());
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } catch (err) {
    if (err instanceof PdfCheckError) throw err;
    const name = (err as { name?: string } | null)?.name;
    if (name === 'PasswordException') throw new PdfCheckError('Needs a password to open', true);
    if (name === 'InvalidPDFException') throw new PdfCheckError('Could not read it: the file is damaged or not a valid PDF');
    throw new PdfCheckError('Could not read the PDF');
  } finally {
    ended = true;
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    task?.destroy().catch(() => {});
  }
}

async function inspect(pdf: PdfDocument, limits: PdfLimits, withDetails: boolean, ops?: Record<string, number>): Promise<PdfRead> {
  const pages = pdf.numPages;
  const pagesChecked = Math.min(pages, limits.maxPages);
  const textPages = Math.min(pagesChecked, limits.textPages ?? 5);
  // Details read their own page range; the checks below only ever use pages 1..pagesChecked.
  const detailPages = withDetails ? Math.min(pages, limits.detailPages ?? PDF_DETAIL_LIMITS.pages) : 0;
  const [meta, perms, prefs, fieldObjects] = await Promise.all([
    pdf.getMetadata().catch(() => null),
    pdf.getPermissions().catch(() => null),
    pdf.getViewerPreferences().catch(() => null),
    pdf.getFieldObjects().catch(() => null),
  ]);
  const info = (meta?.info ?? {}) as Record<string, unknown>;
  const hasForm = info.IsAcroFormPresent === true;

  let tagged = false;
  let figuresWithoutAlt = 0;
  let textChars = 0;
  /**
   * Pages read for text that had none, by what tagged figures with alt text hold of them (`describedScan`):
   * unreadable scans, and pages that could not be measured (neither a described scan nor an unreadable one).
   */
  let scans = 0;
  let unmeasured = 0;
  /** Widgets with no field name anywhere (an empty /T): each is a field of its own. */
  let nameless = 0;
  /** Field name → one of its widgets has a tooltip. */
  const fields = new Map<string, boolean>();
  const detail = withDetails ? new DetailLists() : undefined;
  for (let n = 1; n <= Math.max(pagesChecked, detailPages); n++) {
    const page = await pdf.getPage(n);
    const checked = n <= pagesChecked;
    let readForText = false;
    if (checked && n <= textPages && textChars === 0) {
      const text = await page.getTextContent().catch(() => null);
      for (const item of text?.items ?? []) if ('str' in item) textChars += item.str.replace(/\s+/g, '').length;
      readForText = true;
    }
    const tree = (await page.getStructTree().catch(() => null)) as StructNode | null;
    if (checked && tree?.children?.length) {
      tagged = true;
      const bare = countFigures(tree, 0, false);
      figuresWithoutAlt += bare;
    }
    if (readForText && textChars === 0) {
      // A page with no text whose content is in tagged figures with alt text (WCAG technique PDF1): the alt is
      // read in its place. One described figure does not cover a page (review round 1, ruling 14): the
      // described figures must hold what the page draws (`describedScan`: a logo beside an untagged or
      // artifact-marked scanned notice does not). With no figure that has an alternative, it is a scan.
      const held = checked && tree?.children?.length && countFigures(tree, 0, true) > 0 ? await describedScan(page, tree, ops) : 'not';
      if (held === 'not') scans++;
      else if (held === 'unknown') unmeasured++;
    }
    const widgets = hasForm ? ((await page.getAnnotations().catch(() => [])) as Widget[]) : [];
    if (checked) {
      for (const a of widgets) {
        if (a.annotationType !== WIDGET || a.hidden || a.pushButton) continue;
        // No field name on the widget or any parent (pdf.js joins the parents' /T): the field has only its
        // tooltip to be known by (PDF12), so each such widget is a field of its own.
        const key = a.fieldName || `\u0000${n}:${a.id ?? nameless}`;
        if (!a.fieldName) nameless++;
        fields.set(key, (fields.get(key) ?? false) || Boolean(a.alternativeText?.trim()));
      }
    }
    if (detail && n <= detailPages) await detail.addPage(n, page, tree, widgets);
    page.cleanup();
  }

  const parentFields = fieldsWithParents(fieldObjects);
  const xmpTitle = meta?.metadata?.get?.('dc:title');
  const title = (typeof info.Title === 'string' ? info.Title.trim() : '') || (typeof xmpTitle === 'string' ? xmpTitle.trim() : '');
  const lang = typeof info.Language === 'string' ? info.Language.trim() : '';
  const display = prefs instanceof Map ? prefs.get('DisplayDocTitle') : (prefs as Record<string, unknown> | null)?.DisplayDocTitle;
  const checks: PdfChecks = {
    pages,
    pagesChecked,
    tagged,
    hasLanguage: LANGUAGE_TAG.test(lang),
    hasTitle: title !== '' && !PLACEHOLDER_TITLE.test(title),
    // Batch 19: the title itself, so the report can name the document (never a placeholder or a file name).
    ...(title !== '' && !PLACEHOLDER_TITLE.test(title) ? { title: title.replace(/\s+/g, ' ').slice(0, 200) } : {}),
    showsTitle: display === true,
    // No text on the pages read: a scan, unless tagged figures with alt text hold what each of them draws (a
    // described scan). Not said when no page is a plain scan and one of them could not be measured.
    ...(textPages > 0 && (textChars > 0 || scans > 0 || unmeasured === 0) ? { imageOnly: textChars === 0 && scans > 0 } : {}),
    // A text-less page has figures with alternative text, and whether they hold what the page shows could not
    // be shown (review round 2, finding 2): never clean, the report says "not testable" for 1.1.1.
    ...(textPages > 0 && textChars === 0 && scans === 0 && unmeasured > 0 ? { scanUnmeasured: true } : {}),
    figuresWithoutAlt,
    formFields: fields.size,
    // A field whose widgets are kids of a separate field dictionary may keep its tooltip there,
    // where pdf.js cannot see it, so only fields with the tooltip on the widget itself are judged.
    untitledFormFields: [...fields].filter(([name, has]) => !has && !parentFields.has(name)).length,
    xfa: info.IsXFAPresent === true || pdf.isPureXfa === true,
    blocksAssistiveTech: perms !== null && !perms.has(COPY) && !perms.has(COPY_FOR_ACCESSIBILITY),
  };
  const xmpModified = meta?.metadata?.get?.('xmp:modifydate') ?? meta?.metadata?.get?.('xmp:ModifyDate');
  const modified = parsePdfDate(info.ModDate) ?? (typeof xmpModified === 'string' ? isoDate(xmpModified) : undefined);
  if (!detail) return { checks, ...(modified ? { modified } : {}) };
  return {
    checks,
    ...(modified ? { modified } : {}),
    details: {
      ...(title ? { title: title.slice(0, 300) } : {}),
      ...(lang ? { lang: lang.slice(0, 35) } : {}),
      ...(modified ? { modified } : {}),
      pagesRead: detailPages,
      ...detail.result(),
    },
  };
}

/** Collects `PdfDetails` lists page by page, in tag order, within PDF_DETAIL_LIMITS. */
class DetailLists {
  private readonly figures: PdfFigure[] = [];
  private readonly headings: PdfHeading[] = [];
  private readonly fields: PdfField[] = [];
  private readonly fieldNames = new Set<string>();
  private readonly totals = { figures: 0, headings: 0, fields: 0 };

  async addPage(n: number, page: PdfPage, tree: StructNode | null, widgets: readonly Widget[]): Promise<void> {
    const L = PDF_DETAIL_LIMITS;
    const found: { figures: StructNode[]; headings: StructNode[] } = { figures: [], headings: [] };
    if (tree?.children?.length) walkStructure(tree, 0, found);
    found.figures.forEach((f, i) => {
      if (this.totals.figures++ >= L.figures) return;
      const alt = clean(f.alt ?? '', L.text * 2);
      this.figures.push({ page: n, orderOnPage: i + 1, ...(alt ? { alt } : {}) });
    });
    const listed = found.headings.slice(0, Math.max(0, L.headings - this.totals.headings));
    this.totals.headings += found.headings.length;
    if (listed.length) {
      const text = await markedContentText(page);
      for (const h of listed) {
        const ids: string[] = [];
        contentIds(h, 0, ids);
        this.headings.push({ page: n, tag: h.role!, text: clean(ids.map((id) => text.get(id) ?? '').join(' '), L.text) });
      }
    }
    for (const a of widgets) {
      if (a.annotationType !== WIDGET || a.hidden || a.pushButton || !a.fieldName || this.fieldNames.has(a.fieldName)) continue;
      this.fieldNames.add(a.fieldName);
      if (this.totals.fields++ >= L.fields) continue;
      this.fields.push({ page: n, name: clean(a.fieldName, L.text), tooltip: clean(a.alternativeText ?? '', L.text), type: fieldType(a) });
    }
  }

  result(): Pick<PdfDetails, 'figures' | 'headings' | 'fields' | 'totals'> {
    return { figures: this.figures, headings: this.headings, fields: this.fields, totals: { ...this.totals } };
  }
}

const HEADING_ROLE = /^H[1-6]?$/;

/** Figures and headings in tag order (a heading's own children are not searched for more headings). */
function walkStructure(node: StructNode, depth: number, out: { figures: StructNode[]; headings: StructNode[] }): void {
  if (depth > 60) return;
  if (node.role === 'Figure') out.figures.push(node);
  else if (node.role && HEADING_ROLE.test(node.role)) {
    out.headings.push(node);
    for (const child of node.children ?? []) if (isStructNode(child) && child.role === 'Figure') out.figures.push(child);
    return;
  }
  for (const child of node.children ?? []) if (isStructNode(child)) walkStructure(child, depth + 1, out);
}

function isStructNode(child: StructNode | { type: string }): child is StructNode {
  return 'role' in child || 'children' in child;
}

/** Marked-content ids (pdf.js `p<ref>R_mc<n>`) under a structure element, in order. */
function contentIds(node: StructNode, depth: number, out: string[]): void {
  if (depth > 60) return;
  for (const child of node.children ?? []) {
    if (isStructNode(child)) contentIds(child, depth + 1, out);
    else if (child.type === 'content' && typeof child.id === 'string') out.push(child.id);
  }
}

/** The text inside each marked-content sequence of a page, by its id. */
async function markedContentText(page: PdfPage): Promise<Map<string, string>> {
  const text = new Map<string, string>();
  const content = await page.getTextContent({ includeMarkedContent: true }).catch(() => null);
  const open: (string | null)[] = [];
  for (const item of content?.items ?? []) {
    if ('str' in item) {
      for (const id of open) if (id) text.set(id, `${text.get(id) ?? ''}${item.str}${item.hasEOL ? ' ' : ''}`);
    } else if (item.type === 'beginMarkedContentProps' || item.type === 'beginMarkedContent') {
      open.push(item.id ?? null);
    } else if (item.type === 'endMarkedContent') {
      open.pop();
    }
  }
  return text;
}

function clean(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function fieldType(a: Widget): string {
  if (a.fieldType === 'Tx') return 'text';
  if (a.fieldType === 'Ch') return 'choice';
  if (a.fieldType === 'Sig') return 'signature';
  if (a.fieldType === 'Btn') return a.checkBox ? 'checkbox' : a.radioButton ? 'radio' : 'other';
  return 'other';
}

/** A PDF date string (`D:YYYYMMDDHHmmSS` with an optional `Z` or `±HH'mm'`) as an ISO date. */
export function parsePdfDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Zz])|([+-])(\d{2})'?(\d{2})?'?)?/.exec(value.trim());
  if (!m) return undefined;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', z, sign, oh, om = '00'] = m;
  const offset = z || !sign ? 'Z' : `${sign}${oh}:${om}`;
  return isoDate(`${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`);
}

function isoDate(s: string): string | undefined {
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

export function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
}

interface StructNode {
  role?: string;
  alt?: string;
  children?: (StructNode | { type: string; id?: string })[];
}

interface Widget {
  id?: string;
  annotationType?: number;
  fieldName?: string;
  alternativeText?: string;
  hidden?: boolean;
  pushButton?: boolean;
  fieldType?: string;
  checkBox?: boolean;
  radioButton?: boolean;
}


/** Marked-content ids (MCIDs) of the page content under figures with alt text, from the page's structure tree. */
function describedContent(node: StructNode, depth: number, inFigure: boolean, out: Set<number>): Set<number> {
  if (depth > 60) return out;
  const described = inFigure || (node.role === 'Figure' && !!node.alt?.trim());
  for (const child of node.children ?? []) {
    if ('role' in child || 'children' in child) describedContent(child as StructNode, depth + 1, described, out);
    else if (described && typeof (child as { id?: string }).id === 'string') {
      const m = /_mc(\d+)$/.exec((child as { id: string }).id);
      if (m) out.add(Number(m[1]));
    }
  }
  return out;
}

/** Operators of one page the walk reads; a page with more is not measured. */
const PAGE_OPERATORS = 200_000;
/** Painted shapes outside the described figures that a described page may have (a rule, a border, a page fill). */
const LOOSE_SHAPES = 4;

/**
 * What tagged figures with alt text hold of a text-less page (pure reading of the page's drawing operators;
 * no image is decoded, see `readPdf`):
 * - 'described': every image drawn outside decoration is in marked content of figures with alt text (no share
 *   of the area is enough: an image outside them is not shown to be covered), images marked as artifacts are
 *   no larger than those, and at most `LOOSE_SHAPES` shapes are painted outside them; or, on a page with no
 *   image, its painted shapes (a chart, a map, outlined text) are in those figures;
 * - 'not': most of what the page draws is outside them (under half the image area, artifact-marked images
 *   counted as drawn: a scan the file calls decoration is still what the page shows; or under half the shapes);
 * - 'unknown': neither is proven, or the page could not be measured (its figures hold no marked content, its
 *   content could not be read or is longer than the walk reads). Never called a scan, never called described.
 */
async function describedScan(page: PdfPage, tree: StructNode, ops?: Record<string, number>): Promise<'described' | 'not' | 'unknown'> {
  if (!ops) return 'unknown';
  const described = describedContent(tree, 0, false, new Set<number>());
  if (!described.size) return 'unknown';
  const list = (await (page as unknown as { getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }> }).getOperatorList().catch(() => null));
  if (!list || list.fnArray.length > PAGE_OPERATORS) return 'unknown';
  const known = (...names: string[]) => new Set(names.map((n) => ops[n]).filter((n): n is number => typeof n === 'number'));
  const IMAGES = known('paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintImageXObjectRepeat', 'paintInlineImageXObjectGroup', 'paintImageMaskXObjectGroup', 'paintImageMaskXObjectRepeat', 'paintSolidColorImageMask');
  const PAINTS = known('fill', 'eoFill', 'stroke', 'closeStroke', 'fillStroke', 'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke', 'shadingFill');
  // The current transformation matrix: an image is drawn in the unit square, so its area is the matrix's determinant.
  let m = [1, 0, 0, 1, 0, 0];
  const saved: number[][] = [];
  const marks: (number | 'artifact' | null)[] = [];
  const mul = (a: number[], b: number[]) => [a[0]! * b[0]! + a[2]! * b[1]!, a[1]! * b[0]! + a[3]! * b[1]!, a[0]! * b[2]! + a[2]! * b[3]!, a[1]! * b[2]! + a[3]! * b[3]!, a[0]! * b[4]! + a[2]! * b[5]! + a[4]!, a[1]! * b[4]! + a[3]! * b[5]! + a[5]!];
  const six = (x: unknown): number[] | null => {
    const v = Array.isArray(x) ? x : x && typeof x === 'object' ? Array.from({ length: 6 }, (_, i) => (x as Record<number, unknown>)[i]) : null;
    return v && v.length >= 6 && v.slice(0, 6).every((n) => typeof n === 'number' && Number.isFinite(n)) ? (v.slice(0, 6) as number[]) : null;
  };
  // A marked-content tag as pdf.js gives it: a string, or a name object.
  const tagOf = (x: unknown): string => (typeof x === 'string' ? x : x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string' ? (x as { name: string }).name : '');
  const inFigure = () => marks.some((x) => typeof x === 'number' && described.has(x));
  // Image areas: in described figures, outside them, and marked as artifacts. Shapes: in the figures, and loose.
  let held = 0;
  let outside = 0;
  let decoration = 0;
  let shapes = 0;
  let loose = 0;
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i]!;
    const args = list.argsArray[i] as unknown[] | null;
    if (fn === ops.save) saved.push(m);
    else if (fn === ops.restore) m = saved.pop() ?? m;
    else if (fn === ops.transform) { const t = six(args); if (t) m = mul(m, t); }
    else if (fn === ops.paintFormXObjectBegin) { saved.push(m); const t = six(args?.[0]); if (t) m = mul(m, t); }
    else if (fn === ops.paintFormXObjectEnd) m = saved.pop() ?? m;
    else if (fn === ops.beginMarkedContentProps) marks.push(typeof args?.[1] === 'number' ? args[1] : tagOf(args?.[0]) === 'Artifact' ? 'artifact' : null);
    else if (fn === ops.beginMarkedContent) marks.push(tagOf(args?.[0]) === 'Artifact' ? 'artifact' : null);
    else if (fn === ops.endMarkedContent) marks.pop();
    else if (IMAGES.has(fn)) {
      const area = Math.abs(m[0]! * m[3]! - m[1]! * m[2]!);
      if (!(area > 0)) continue;
      if (marks.includes('artifact')) decoration += area;
      else if (inFigure()) held += area;
      else outside += area;
    } else if (PAINTS.has(fn) || (fn === ops.constructPath && typeof args?.[0] === 'number' && PAINTS.has(args[0]))) {
      // A path that is painted (pdf.js gives the paint with the path, or as the operator after it).
      if (marks.includes('artifact')) continue;
      if (inFigure()) shapes++;
      else loose++;
    }
  }
  const drawn = held + outside + decoration;
  if (drawn > 0) {
    if (held < drawn / 2) return 'not';
    // Any image drawn outside the described figures (and outside decoration) is not shown to be covered: a
    // majority of the image area proves nothing about it (a large described seal beside a small scanned notice).
    return outside === 0 && decoration <= held && loose <= LOOSE_SHAPES ? 'described' : 'unknown';
  }
  if (shapes + loose === 0) return 'unknown';
  if (shapes < (shapes + loose) / 2) return 'not';
  return loose <= LOOSE_SHAPES ? 'described' : 'unknown';
}

/** Figures in a page's structure tree with alt text (`withAlt`) or without. */
function countFigures(node: StructNode, depth: number, withAlt: boolean): number {
  if (depth > 60) return 0;
  let n = node.role === 'Figure' && !!node.alt?.trim() === withAlt ? 1 : 0;
  for (const child of node.children ?? []) if ('role' in child || 'children' in child) n += countFigures(child as StructNode, depth + 1, withAlt);
  return n;
}

/** Names of fields whose widgets are kids of a separate field dictionary (its /TU is not visible to pdf.js). */
function fieldsWithParents(objects: unknown): Set<string> {
  const out = new Set<string>();
  const entries = objects instanceof Map ? [...objects.entries()] : objects && typeof objects === 'object' ? Object.entries(objects) : [];
  for (const [name, list] of entries as [string, unknown][]) {
    if (Array.isArray(list) && list.some((o) => Array.isArray((o as { kidIds?: unknown }).kidIds) && (o as { kidIds: unknown[] }).kidIds.length > 0)) out.add(name);
  }
  return out;
}

/** Plain-language problems for a PDF's check results (empty when the quick checks found none). */
export function pdfProblems(c: PdfChecks): string[] {
  const out: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (c.blocksAssistiveTech) out.push('Its security settings stop screen readers from reading the text.');
  if (c.xfa) out.push('It uses an XFA form, which most PDF readers and screen readers cannot use.');
  if (c.imageOnly) out.push('No text found: it looks like a scanned image, which screen readers cannot read.');
  if (c.tagged === false) out.push('Not tagged: screen readers cannot tell its headings, lists and tables apart, and may read it out of order.');
  if (c.figuresWithoutAlt) out.push(`${plural(c.figuresWithoutAlt, 'image has', 'images have')} no text description (alt text).`);
  if (c.untitledFormFields) out.push(`${plural(c.untitledFormFields, 'form field has', 'form fields have')} no name (tooltip) for screen readers.`);
  if (c.hasLanguage === false) out.push('No document language is set, so screen readers may pronounce it wrongly.');
  if (c.hasTitle === false) out.push('No title is set, so people see the file name instead.');
  else if (c.hasTitle && c.showsTitle === false) out.push('It has a title, but PDF readers are told to show the file name instead.');
  return out;
}

/** The quick PDF checks behind each criterion (their problems are worded by `pdfProblems`). */
export const PDF_FIELDS: Readonly<Record<string, readonly (keyof PdfChecks)[]>> = {
  '1.1.1': ['imageOnly', 'figuresWithoutAlt'],
  '1.3.1': ['tagged', 'blocksAssistiveTech'],
  '2.4.2': ['hasTitle', 'showsTitle'],
  '3.1.1': ['hasLanguage'],
  '4.1.2': ['untitledFormFields', 'xfa'],
};

/** The criteria one PDF's quick checks fail, in criterion order. */
export function pdfCriteria(c: PdfChecks): string[] {
  return Object.entries(PDF_FIELDS)
    .filter(([, fields]) => pdfProblems(Object.fromEntries(fields.map((f) => [f, c[f]])) as unknown as PdfChecks).length > 0)
    .map(([criterion]) => criterion);
}
