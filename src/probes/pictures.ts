// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Pictures and the words they draw, on every page that loaded (`everyPage`): an SVG file shown as a picture keeps
// its words as text, so this test reads them and measures what the file draws (src/probes/pictureText.ts), then
// fails only what that shows (src/probes/pictureJudge.ts):
// - 1.4.5 for a picture that is a block of text and nothing else (a notice, a flyer, a schedule set as an image);
// - 1.1.1 for a picture whose words neither its text alternative nor the page's text gives: a block of text, a
//   picture kept from screen readers that draws a statement, one whose alternative only names its kind ("Map") or
//   is a file name, and a CSS background (which has no alternative).
// It reads no bitmap (a photo, a scan, an SVG whose letters are outlines): those are the AI review's.
// Reads only; it changes nothing on the page. Listed, not scored, until calibrated (docs/scoring.md).
// Engine core: no Node-only imports.
import type { ProbeFinding } from '../types.js';
import { before, pageWords, shootElements } from './evidence.js';
import { agreedJudgement, drawnOf, judgePictures } from './pictureJudge.js';
import { measureSvgPictures, PICTURE_LIMITS, readPictures, type PicturesRead, type SvgMeasured, type SvgMeasureError } from './pictureText.js';
import type { PageProbe, ProbeContext } from './types.js';

export const PICTURES_PROBE_ID = 'picture-text';

/** Time kept at the end of the run for the pictures of the failures (ms). */
const EVIDENCE_MS = 3_500;
/** Time for asking the browser for one file's source (ms), and for all of a page's. */
const CDP_FILE_MS = 1_500;
const CDP_ALL_MS = 3_000;

type FrameResource = { url?: string; type?: string; mimeType?: string; contentSize?: number; failed?: boolean; canceled?: boolean };
type ResourceTree = { frame?: { id?: string }; resources?: FrameResource[]; childFrames?: ResourceTree[] };

/** What the browser's own copy of one address gave: its text, or why it is not used. */
export type BrowserCopy = { source: string } | { error: SvgMeasureError };

/** The text of a file the browser handed over, or 'too-large': its length is checked before it is decoded. */
export function decodedCopy(content: string, base64: boolean, maxBytes: number): BrowserCopy {
  if (content.length > (base64 ? Math.ceil(maxBytes / 3) * 4 + 4 : maxBytes)) return { error: 'too-large' };
  if (!base64) return { source: content };
  const bin = atob(content);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.length > maxBytes ? { error: 'too-large' } : { source: text };
}

/**
 * The files' text from the browser's own copy of what the page loaded (CDP `Page.getResourceContent`): no request is
 * made, another site's file needs no sharing header, and the text is the one of the file the browser loaded for the
 * page, not of a newer one. The browser's own record of the file's size is read first (`Page.getResourceTree`): a
 * file over the limit is never asked for, so it is never transferred, decoded or handed to the page. An address the
 * browser has no record of is left out (the page may still have a stored copy of its own site's file). Never throws.
 */
async function sourcesFromBrowser(ctx: ProbeContext, srcs: readonly string[], until: number, maxBytes: number): Promise<Map<string, BrowserCopy>> {
  const out = new Map<string, BrowserCopy>();
  const cdp = srcs.length ? await ctx.cdp?.().catch(() => undefined) : undefined;
  if (!cdp) return out;
  const stop = Math.min(until, Date.now() + CDP_ALL_MS);
  const work = (async (): Promise<void> => {
    // The browser answers only with its Page domain on; it is put back as it was (off) afterwards.
    await cdp.send('Page.enable');
    try {
      const tree = (await cdp.send('Page.getResourceTree')) as { frameTree?: ResourceTree };
      const frames: ResourceTree[] = [];
      const walk = (t: ResourceTree | undefined) => { if (!t) return; frames.push(t); for (const c of t.childFrames ?? []) walk(c); };
      walk(tree?.frameTree);
      for (const src of srcs) {
        if (Date.now() >= stop || ctx.signal?.aborted) break;
        // The pictures read are the main document's: its frame's record first.
        let frameId: string | undefined;
        let found: FrameResource | undefined;
        for (const f of frames) {
          const r = (f.resources ?? []).find((x) => x.url === src);
          if (r) { frameId = f.frame?.id; found = r; break; }
        }
        if (!frameId || !found) continue;
        if (found.failed || found.canceled) { out.set(src, { error: 'unread' }); continue; }
        // No size on record: nothing is asked for (the page reads its own site's stored copy piece by piece instead).
        if (typeof found.contentSize !== 'number') continue;
        if (found.contentSize > maxBytes) { out.set(src, { error: 'too-large' }); continue; }
        const got = (await before(cdp.send('Page.getResourceContent', { frameId, url: src }), Math.min(stop, Date.now() + CDP_FILE_MS))) as { content?: string; base64Encoded?: boolean } | null;
        if (typeof got?.content !== 'string') continue;
        out.set(src, decodedCopy(got.content, !!got.base64Encoded, maxBytes));
      }
    } finally {
      await cdp.send('Page.disable').catch(() => {});
    }
  })();
  await before(work, stop + 500);
  return out;
}

/**
 * The files' text as the page was given it, kept when each response arrived (`ProbeContext.pictureFile`,
 * `pictureFiles.ts`): no request, no race with the browser's cache. A file whose body could not be had, or that
 * arrived before the store listened, is left out (the resource record and the stored copy are tried for it). Never throws.
 */
async function keptFiles(ctx: ProbeContext, srcs: readonly string[], until: number, maxBytes: number): Promise<Map<string, BrowserCopy>> {
  const out = new Map<string, BrowserCopy>();
  if (!ctx.pictureFile) return out;
  const stop = Math.min(until, Date.now() + CDP_ALL_MS);
  for (const src of srcs) {
    if (Date.now() >= stop || ctx.signal?.aborted) break;
    const got = await before(ctx.pictureFile(src).catch(() => undefined), Math.min(stop, Date.now() + CDP_FILE_MS));
    if (!got || ('error' in got && got.error === 'unread')) continue;
    // A file the address gave differently on two loads is not this path's to choose between (the rule above decides).
    if ('source' in got && !got.identical) continue;
    out.set(src, 'source' in got ? (got.source.length > maxBytes ? { error: 'too-large' } : { source: got.source }) : { error: got.error });
  }
  return out;
}

/** How a file's text was had: kept as its response arrived, the browser's resource record, the page's stored copy, or not at all. */
export type FileRead = 'response' | 'browser' | 'page' | 'none';

/** The distinct SVG files a page shows, the largest shown first, at most `PICTURE_LIMITS.files`. */
export function filesToMeasure(read: PicturesRead, max: number = PICTURE_LIMITS.files): string[] {
  const area = new Map<string, number>();
  for (const p of read.pictures) if (p.svg && p.src) area.set(p.src, Math.max(area.get(p.src) ?? 0, p.width * p.height));
  return [...area.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, max).map(([src]) => src);
}

/**
 * The measurements that still stand after the page was read again: a file whose address the browser loaded more
 * than once in either reading, whose loads the second reading counts otherwise than the first did, or that a picture
 * now shows at another decoded size, may have changed while it was measured, so its measurement is dropped
 * ('reloaded': not testable). Pure.
 */
export function withoutReloaded(measured: ReadonlyMap<string, SvgMeasured>, first: PicturesRead, second: PicturesRead): Map<string, SvgMeasured> {
  const loads = (r: PicturesRead) => {
    const out = new Map<string, number>();
    for (const p of r.pictures) out.set(p.src, Math.max(out.get(p.src) ?? 0, p.loads));
    return out;
  };
  const sizes = (r: PicturesRead) => {
    const out = new Map<string, Set<string>>();
    for (const p of r.pictures) if (p.decoded) { const s = out.get(p.src) ?? new Set<string>(); s.add(p.decoded.join('x')); out.set(p.src, s); }
    return out;
  };
  const [l1, l2, s1, s2] = [loads(first), loads(second), sizes(first), sizes(second)];
  const out = new Map(measured);
  for (const [src, m] of measured) {
    if (m.error || /^data:/i.test(src)) continue;
    const a = l1.get(src), b = l2.get(src);
    const sizeMoved = !!s1.get(src) && !!s2.get(src) && [...s2.get(src)!].some((x) => !s1.get(src)!.has(x));
    // A first load between the readings (a lazy picture) is no reload; a second one, or a record of a load that went
    // away, is.
    if ((b ?? 0) > 1 || (a ?? 0) > 1 || ((a ?? 0) >= 1 && b !== undefined && a !== b) || sizeMoved) out.set(src, { src, error: 'reloaded' });
  }
  return out;
}

/**
 * Batch 17 (the lead's ruling after the cut round's review, 2026-11-12): the picture test's own failures are never
 * reported as failed. Each is listed for a person to check ("flagged", Needs review) with its evidence: the picture,
 * the words quoted and the measurement. Its other results ("not testable", "no failures found", "not applicable") are
 * as the judgement gives them. Pure.
 */
export function forReview(findings: readonly ProbeFinding[]): ProbeFinding[] {
  return findings.map((f) => (f.status === 'failed' ? { ...f, status: 'flagged' as const, detail: `For a person to check: ${f.detail ?? ''}`.trim() } : f));
}

/** The first flagged picture of each criterion boxed, in the main document. */
async function pictureEvidence(ctx: ProbeContext, findings: readonly ProbeFinding[]): Promise<void> {
  const first = (c: string) => findings.find((f) => f.criterion === c && f.status === 'flagged' && f.target && !f.target.includes(' >>> '));
  const text = first('1.4.5');
  if (text) {
    await shootElements(ctx, {
      criterion: '1.4.5', handles: [{ sel: text.target! }], caption: 'For a person to check: a picture that may be only words', target: text.target!,
      alt: (title) => `${pageWords(title)}: the outlined picture appears to be made of words only, drawn as an image; for a person to check.`,
    });
  }
  const alt = first('1.1.1');
  if (alt) {
    await shootElements(ctx, {
      criterion: '1.1.1', handles: [{ sel: alt.target! }], caption: 'For a person to check: its words may be nowhere in the page’s text', target: alt.target!,
      alt: (title) => `${pageWords(title)}: the outlined picture shows words that its text alternative and the page's text appear not to give; for a person to check.`,
    });
  }
}

export const picturesProbe: PageProbe = {
  id: PICTURES_PROBE_ID,
  criteria: ['1.1.1', '1.4.5'],
  // Reads the page once: an app that mounts its content late is read with it.
  waitFor: { content: true },
  kind: 'render',
  tier: 'core',
  scored: false,
  timeoutMs: 15_000,
  everyPage: true,
  onlyNavigationVoids: true,
  note: 'it reads the words of SVG pictures only; words in photos, scans and other bitmap pictures are the AI review’s to read',
  async run(ctx: ProbeContext): Promise<ProbeFinding[]> {
    const L = PICTURE_LIMITS;
    const reading = { pictures: L.pictures, elements: L.elements, blocks: L.blocks, blockChars: L.blockChars, pageChars: L.pageChars, sourceChars: L.sourceChars };
    const read = await ctx.page.evaluate(readPictures, reading);
    const files = filesToMeasure(read);
    const measured = new Map<string, SvgMeasured>();
    const reads = new Map<string, FileRead>();
    if (files.length) {
      const limits = { fileBytes: L.fileBytes, texts: L.texts, words: L.words, minSide: L.minSide, maxSide: L.maxSide, budgetMs: Math.max(500, Math.min(L.budgetMs, ctx.deadline - Date.now() - EVIDENCE_MS - 1_500)), drawMs: L.drawMs };
      const until = ctx.deadline - EVIDENCE_MS;
      const local = new Set(read.pictures.filter((p) => p.local).map((p) => p.src));
      // An address the browser loaded more than once for the page may have given two files: which of them a
      // picture shows cannot be told, so it is not read at all.
      const loads = new Map<string, number>();
      for (const p of read.pictures) loads.set(p.src, Math.max(loads.get(p.src) ?? 0, p.loads));
      for (const src of files) {
        if ((loads.get(src) ?? 0) <= 1) continue;
        // Unless every one of those loads was kept as it arrived and was the same file: then it is that file.
        const kept = /^https?:/i.test(src) && ctx.pictureFile ? await before(ctx.pictureFile(src).catch(() => undefined), Math.min(until, Date.now() + CDP_FILE_MS)) : null;
        if (kept && 'source' in kept && kept.identical && kept.responses >= (loads.get(src) ?? 0)) continue;
        measured.set(src, { src, error: 'unread' });
      }
      // The browser's own copy of what the page loaded, first: no request is made for it, another site's file needs
      // no sharing header, and it is the file the page was given. What the browser has no record of, the page reads
      // from its own site's stored copy (never the network): a file that is not stored stays unread.
      // First the file as the page was given it, kept when its response arrived (the lead's route, 2026-11-13: the
      // resource record skips a file with no size on record yet, and the stored copy races the cache's write).
      const wanted = files.filter((src) => /^https?:/i.test(src) && !measured.has(src));
      const handed = await keptFiles(ctx, wanted, until, L.fileBytes);
      for (const src of handed.keys()) reads.set(src, 'response');
      for (const [src, copy] of await sourcesFromBrowser(ctx, wanted.filter((src) => !handed.has(src)), until, L.fileBytes)) { handed.set(src, copy); reads.set(src, 'browser'); }
      const toPage: { src: string; source?: string; read?: boolean }[] = [];
      for (const src of files) {
        if (measured.has(src)) continue;
        const copy = handed.get(src);
        if (copy && 'error' in copy) { measured.set(src, { src, error: copy.error }); continue; }
        if (!copy && local.has(src)) reads.set(src, 'page');
        toPage.push(copy ? { src, source: copy.source } : { src, read: local.has(src) });
      }
      if (toPage.length) {
        const got = await before(ctx.page.evaluate(measureSvgPictures, { files: toPage, limits }), until);
        for (const f of toPage) measured.set(f.src, got?.find((g) => g.src === f.src) ?? { src: f.src, error: 'time' });
      }
    }
    // The page read again after the measuring: a failure stands only when the page as it was before and as it is
    // now both give it (an alternative or a text added meanwhile, a picture changed or gone, takes it away).
    const again = files.length ? await before(ctx.page.evaluate(readPictures, reading), ctx.deadline - EVIDENCE_MS + 500) : read;
    // A file the browser loaded again while it was measured (the same address, given again) may not be the file
    // measured: that measurement does not stand, in either reading (the full-tree review's S5).
    const stands = again && again !== read ? withoutReloaded(measured, read, again) : measured;
    const judged = agreedJudgement(judgePictures(read, stands), again ? judgePictures(again, stands) : undefined);
    const findings = forReview(judged.findings);
    ctx.keep?.(findings.filter((f) => f.status === 'flagged'));
    // How each file's text was had (the run's own record; a 'none' that stayed unread is why it is not testable).
    if (files.length) {
      const loadsOf = (src: string) => Math.max(0, ...read.pictures.filter((p) => p.src === src).map((p) => p.loads));
      ctx.setData?.({ fileReads: files.map((src) => ({ file: src.slice(0, 300), via: /^data:/i.test(src) ? 'address' : reads.get(src) ?? 'none', ...(loadsOf(src) > 1 ? { loads: loadsOf(src) } : {}), ...(stands.get(src)?.error ? { error: stands.get(src)!.error } : {}) })) });
    }
    // Batch 18 (G13, neutral): what each SVG file was measured to draw, for the AI review only (never in the report).
    ctx.attach?.({ files: [...stands.values()].map((m) => (m.measure ? { src: m.src, lines: drawnOf(m.measure).lines.map((l) => l.text) } : { src: m.src, error: m.error ?? 'unread', ...(m.hasText ? { hasText: true } : {}) })) });
    await pictureEvidence(ctx, findings);
    return findings;
  },
};
