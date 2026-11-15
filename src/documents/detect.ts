// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Document detection: is a link a PDF or Office file? Pure functions, no network (see fetch.ts).
// Engine core: no Node-only imports.
import type { DocumentDetectedBy, DocumentLink, DocumentType } from '../types.js';
import { DOCUMENT_EXTENSIONS, isNonPageAsset, normalizeUrl } from '../url.js';

export const EXTENSION_TYPES: Readonly<Record<(typeof DOCUMENT_EXTENSIONS)[number], DocumentType>> = {
  pdf: 'pdf',
  doc: 'word', docx: 'word', odt: 'word', rtf: 'word',
  xls: 'excel', xlsx: 'excel', ods: 'excel',
  ppt: 'powerpoint', pptx: 'powerpoint', ppsx: 'powerpoint', odp: 'powerpoint',
};

/**
 * `document`: a document, no request needed. `maybe`: some evidence; confirm with a probe (only on
 * the site's own host). `no`: not a document.
 */
export type LinkVerdict = 'document' | 'maybe' | 'no';

export interface LinkClass {
  /** Normalized URL (no fragment, tracking parameters removed). Empty when the href is not http(s). */
  url: string;
  verdict: LinkVerdict;
  /** Best guess; 'other' when unknown. */
  type: DocumentType;
  /** The rule that matched (for `maybe`, the first piece of evidence). */
  detectedBy?: DocumentDetectedBy;
  /** For `maybe`: the address itself looks like a document download (CMS path or document host). */
  addressHint?: boolean;
}

/** The type for a file name or path's extension, if it is a document extension. */
export function typeFromFileName(name: string): DocumentType | undefined {
  const m = /\.([a-z0-9]{2,5})$/i.exec(name.trim());
  return m ? (EXTENSION_TYPES as Record<string, DocumentType>)[m[1]!.toLowerCase()] : undefined;
}

/** The type for a MIME type (parameters ignored), if it is a document type. */
export function typeFromMime(mime: string | undefined | null): DocumentType | undefined {
  const t = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  if (!t) return undefined;
  if (t === 'application/pdf' || t === 'application/x-pdf') return 'pdf';
  if (t === 'application/msword' || t === 'application/rtf' || t === 'text/rtf' ||
    t.startsWith('application/vnd.openxmlformats-officedocument.wordprocessingml') ||
    t.startsWith('application/vnd.ms-word') || t === 'application/vnd.oasis.opendocument.text') return 'word';
  if (t === 'application/vnd.ms-excel' || t.startsWith('application/vnd.ms-excel.') ||
    t.startsWith('application/vnd.openxmlformats-officedocument.spreadsheetml') ||
    t === 'application/vnd.oasis.opendocument.spreadsheet') return 'excel';
  if (t === 'application/vnd.ms-powerpoint' || t.startsWith('application/vnd.ms-powerpoint.') ||
    t.startsWith('application/vnd.openxmlformats-officedocument.presentationml') ||
    t === 'application/vnd.oasis.opendocument.presentation') return 'powerpoint';
  return undefined;
}

/** The file name in a Content-Disposition header (`filename*=` preferred), or ''. */
export function dispositionFileName(header: string | undefined | null): string {
  const h = header ?? '';
  const star = /filename\*\s*=\s*(?:[\w-]*'[^']*')?("?)([^";]+)\1/i.exec(h);
  if (star) {
    try {
      return decodeURIComponent(star[2]!.trim());
    } catch {
      return star[2]!.trim();
    }
  }
  const plain = /filename\s*=\s*("?)([^";]+)\1/i.exec(h);
  return plain ? plain[2]!.trim() : '';
}

// Text naming a specific format. Bare "Word" and "Excel" are too common in ordinary link text
// ("A word from the principal"), so they count only next to file words or in brackets.
const FORMAT_TEXT: [RegExp, DocumentType][] = [
  [/\bpdf\b/i, 'pdf'],
  [/\b(?:docx?|odt|rtf)\b|\b(?:microsoft|ms)\s+word\b|\bword\s+(?:document|doc|file|format|version)\b|\(\s*word\b/i, 'word'],
  [/\b(?:xlsx?|ods)\b|\b(?:microsoft|ms)\s+excel\b|\bexcel\s+(?:spreadsheet|workbook|document|file|format|version)\b|\(\s*excel\b/i, 'excel'],
  [/\b(?:pptx?|ppsx|odp)\b|\bpower\s?point\b/i, 'powerpoint'],
];
const DOWNLOAD_TEXT = /\bdownload\b|\bview\s+(?:the\s+)?original\b|\boriginal\s+(?:document|file)\b/i;

/** The format a piece of text names ("Agenda (PDF, 2 MB)" → pdf), if any. */
export function formatInText(text: string | undefined): DocumentType | undefined {
  if (!text) return undefined;
  for (const [re, type] of FORMAT_TEXT) if (re.test(text)) return type;
  return undefined;
}

// Paths school and government CMSs use for file downloads, followed by at least one more segment
// (`/download/<token>`, `/DocumentCenter/View/123/Name`, `/fs/resource-manager/view/<uuid>`).
// Generic vendor patterns only, nothing site-specific.
const CMS_PATH =
  /\/(?:download|downloads|view|viewfile|files?|uploads?|documents?|docs|attachments?|getattachment|getfile|showpublisheddocument|resource-manager|ourpages)\/[^/]+/i;
const FILE_QUERY = new RegExp(`[?&][^=&]*=[^&]*\\.(?:${DOCUMENT_EXTENSIONS.join('|')})(?:&|$)`, 'i');

/** Document services. `file` patterns point at one shared file; anything else on the host is only a hint. */
const DOC_HOSTS: { host: RegExp; file?: RegExp; folder?: RegExp; type?: (u: URL) => DocumentType | undefined }[] = [
  {
    host: /^docs\.google\.com$/,
    file: /^\/(?:document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\//,
    type: (u) => (/^\/document\//.test(u.pathname) ? 'word' : /^\/spreadsheets\//.test(u.pathname) ? 'excel' : /^\/presentation\//.test(u.pathname) ? 'powerpoint' : undefined),
  },
  { host: /^drive\.google\.com$/, file: /^\/(?:file\/d\/|open$|uc$)/, folder: /^\/drive\/folders\// },
  { host: /(?:^|\.)box\.com$/, file: /^\/(?:s|v|file)\/[^/]+/, folder: /^\/folder\// },
  { host: /(?:^|\.)dropbox\.com$/, file: /^\/(?:s|scl\/fi)\/[^/]+/, folder: /^\/(?:sh|scl\/fo)\// },
  { host: /\.sharepoint\.com$/, file: /^\/:[bwxp]:\//, folder: /^\/:f:\//, type: sharePointType },
  { host: /^1drv\.ms$/, file: /^\/[bwxpu]\//, folder: /^\/f\//, type: sharePointType },
  { host: /^onedrive\.live\.com$/, file: /^\/(?:view\.aspx|edit\.aspx|redir|embed)/ },
];

function sharePointType(u: URL): DocumentType | undefined {
  const m = /^\/:?([bwxp])[:/]/.exec(u.pathname);
  return m ? ({ b: 'pdf', w: 'word', x: 'excel', p: 'powerpoint' } as const)[m[1] as 'b' | 'w' | 'x' | 'p'] : undefined;
}

/** True when the host is one of the listed document services. */
export function isDocumentHost(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return DOC_HOSTS.some((h) => h.host.test(host));
}

/** True when the address looks like a CMS file download (path pattern or a document file name in the query). */
export function looksLikeDownloadPath(url: string): boolean {
  const u = new URL(url);
  return CMS_PATH.test(u.pathname) || FILE_QUERY.test(u.search);
}

/**
 * Classifies one link, stopping at the first rule that decides:
 * 1. a document file extension in the path;
 * 2. a document `type` attribute, or a `download` attribute (decisive when it names a file);
 * 3. text: the link's name or the text around it names a format, or says "Download"/"View original";
 * 4. address: a document service (Google Docs, Drive, Box, Dropbox, SharePoint, OneDrive) or a CMS
 *    download path (`/download/<token>`, `/view/<token>`, `/files/…`).
 * Rules 3 and 4 alone give `maybe` (a probe decides). They give `document` together only when the
 * link's own name names a format and the address is a download path, or when the address is a
 * single shared file on a document service.
 */
export function classifyLink(link: DocumentLink, base?: string): LinkClass {
  const url = normalizeUrl(link.href, base);
  if (!url) return { url: '', verdict: 'no', type: 'other' };
  const u = new URL(url);

  // 1. Extension.
  const byExt = typeFromFileName(u.pathname);
  if (byExt) return { url, verdict: 'document', type: byExt, detectedBy: 'extension' };
  if (isNonPageAsset(url)) return { url, verdict: 'no', type: 'other' };

  // 2. Attributes.
  const byMime = typeFromMime(link.type);
  if (byMime) return { url, verdict: 'document', type: byMime, detectedBy: 'attribute' };
  if (link.download !== undefined) {
    const name = link.download.trim();
    const byName = name ? typeFromFileName(name) : undefined;
    if (byName) return { url, verdict: 'document', type: byName, detectedBy: 'attribute' };
    // `download="photo.jpg"` names some other file; a bare `download` is only a hint.
    if (name && /\.[a-z0-9]{2,5}$/i.test(name)) return { url, verdict: 'no', type: 'other' };
  }

  // 3 and 4: gather the softer evidence.
  const ownFormat = formatInText(link.text);
  const nearFormat = ownFormat ? undefined : formatInText(link.nearby);
  const textHint = Boolean(ownFormat || nearFormat || DOWNLOAD_TEXT.test(link.text));
  const host = DOC_HOSTS.find((h) => h.host.test(u.hostname.toLowerCase()));
  if (host?.folder?.test(u.pathname)) return { url, verdict: 'no', type: 'other' };
  const hostFile = Boolean(host?.file?.test(u.pathname));
  const downloadPath = looksLikeDownloadPath(url);
  const guess = ownFormat ?? host?.type?.(u) ?? nearFormat ?? 'other';

  if (hostFile) return { url, verdict: 'document', type: host?.type?.(u) ?? ownFormat ?? 'other', detectedBy: 'host' };
  if (ownFormat && downloadPath) return { url, verdict: 'document', type: ownFormat, detectedBy: 'text' };
  if (link.download !== undefined) return { url, verdict: 'maybe', type: guess, detectedBy: 'attribute', addressHint: downloadPath || Boolean(host) };
  if (textHint) return { url, verdict: 'maybe', type: guess, detectedBy: 'text', addressHint: downloadPath || Boolean(host) };
  if (downloadPath || host) return { url, verdict: 'maybe', type: guess, detectedBy: 'host', addressHint: true };
  return { url, verdict: 'no', type: 'other' };
}

// ---------------------------------------------------------------------------------------------
// Probe answers: content type, file name and magic bytes.

const enc = new TextEncoder();
const PDF_MAGIC = enc.encode('%PDF-');
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const RTF_MAGIC = enc.encode('{\\rtf');

function startsWith(bytes: Uint8Array, magic: ArrayLike<number>, at = 0): boolean {
  if (bytes.length < at + magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[at + i] !== magic[i]) return false;
  return true;
}

/** Where `%PDF-` starts within the first 1024 bytes (pdf.js accepts leading junk), or -1. */
export function pdfHeaderOffset(bytes: Uint8Array): number {
  const end = Math.min(bytes.length - PDF_MAGIC.length, 1024);
  for (let i = 0; i <= end; i++) if (startsWith(bytes, PDF_MAGIC, i)) return i;
  return -1;
}

/** Content types that say nothing about the file, so the bytes must decide. */
export function isGenericBinaryType(contentType: string | undefined | null): boolean {
  const t = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return t === '' || t === 'application/octet-stream' || t === 'binary/octet-stream' || t === 'application/binary' ||
    t === 'application/download' || t === 'application/x-download' || t === 'application/force-download' ||
    t === 'application/unknown' || t === 'application/zip' || t === 'application/x-zip-compressed';
}

export function isHtmlType(contentType: string | undefined | null): boolean {
  return /^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType ?? '');
}

export type Sniffed = { kind: 'document'; type: DocumentType } | { kind: 'html' } | { kind: 'other' } | { kind: 'unknown' };

/** Classifies a response from its headers alone. `unknown` means the bytes must decide. */
export function classifyHeaders(contentType: string | undefined | null, disposition?: string | null): Sniffed {
  const byMime = typeFromMime(contentType);
  if (byMime) return { kind: 'document', type: byMime };
  const byName = typeFromFileName(dispositionFileName(disposition));
  if (byName) return { kind: 'document', type: byName };
  if (isHtmlType(contentType)) return { kind: 'html' };
  if (isGenericBinaryType(contentType)) return { kind: 'unknown' };
  return { kind: 'other' };
}

/**
 * Classifies a response from its first bytes (up to 1024), falling back to its headers:
 * `%PDF-` → PDF; a zip with OOXML or OpenDocument parts → Word/Excel/PowerPoint (an unknown zip is
 * not a document); `D0 CF 11 E0` → legacy Office or encrypted OOXML; `{\rtf` → Word.
 */
export function sniffBytes(bytes: Uint8Array, contentType?: string | null, disposition?: string | null): Sniffed {
  const fromHeaders = classifyHeaders(contentType, disposition);
  const headerType = fromHeaders.kind === 'document' ? fromHeaders.type : undefined;
  if (pdfHeaderOffset(bytes) >= 0) return { kind: 'document', type: 'pdf' };
  if (startsWith(bytes, ZIP_MAGIC)) {
    const head = new TextDecoder('latin1').decode(bytes);
    const odf = /mimetypeapplication\/vnd\.oasis\.opendocument\.(text|spreadsheet|presentation)/.exec(head);
    if (odf) return { kind: 'document', type: odf[1] === 'text' ? 'word' : odf[1] === 'spreadsheet' ? 'excel' : 'powerpoint' };
    if (/\bword\//.test(head)) return { kind: 'document', type: 'word' };
    if (/\bxl\//.test(head)) return { kind: 'document', type: 'excel' };
    if (/\bppt\//.test(head)) return { kind: 'document', type: 'powerpoint' };
    if (head.includes('[Content_Types].xml')) return { kind: 'document', type: headerType ?? 'other' };
    return headerType ? { kind: 'document', type: headerType } : { kind: 'other' };
  }
  if (startsWith(bytes, OLE_MAGIC)) return { kind: 'document', type: headerType ?? 'other' };
  if (startsWith(bytes, RTF_MAGIC)) return { kind: 'document', type: 'word' };
  if (fromHeaders.kind === 'html' || /^\s*<(?:!doctype\s+html|html|head|body)\b/i.test(new TextDecoder().decode(bytes.subarray(0, 256)))) {
    return { kind: 'html' };
  }
  // A PDF always starts with %PDF-; Office types are trusted from the headers.
  if (headerType && headerType !== 'pdf') return { kind: 'document', type: headerType };
  return { kind: 'other' };
}
