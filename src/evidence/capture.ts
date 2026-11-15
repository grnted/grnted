// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The evidence pass's browser work (report v2, spec §3.2): loads each planned page once per width
// (desktop, or a phone for the phone start shot and mobile-only rules) the way the audit does, then
// takes the planned images. Every failure (load, lookup,
// screenshot, timeout) only drops that image; nothing here throws. Engine core: no Node-only imports.
import { SETTLE_MS, documentAddress, scrollThrough } from '../audit.js';
import { gateFailure, gateStopsLoad } from '../navigationGate.js';
import { gotoPolitely, type Pace, type PageSlot } from '../pace.js';
import { VIEWPORTS } from '../report/build.js';
import { cleanText } from '../probes/evidence.js';
import { refusedSince, watchStyles, type StyleWatch } from '../styles.js';
import type { BrowserLike, ContextLike, EvidenceBox, EvidenceShot, PageLike } from '../types.js';
import { chooseTargets, type TargetCandidate } from './fit.js';
import { MAX_CANDIDATES, type EvidenceItem, type EvidenceViewport, type StartMark } from './select.js';

/** Padding around the failing elements, in CSS px. */
export const CLIP_PADDING = 24;
/** Largest image, in CSS px (spec §3.1). */
export const MAX_CLIP = { width: 1280, height: 900 } as const;
/** The start page's overview shots: the whole viewport at each width ("Homepage, as checked"). */
export const START_SHOT = { width: 1280, height: 900 } as const;
/** The phone the start page and mobile-only rules are pictured on: 390×844 CSS px at 2× pixels, touch. */
export const PHONE = { width: 390, height: 844, deviceScaleFactor: 2 } as const;
/** Failing elements of one problem outlined on a start page shot, and the most boxes on one shot. */
export const START_MARKS_PER_PROBLEM = 3;
export const MAX_START_BOXES = 24;
export const JPEG_QUALITY = 72;
/** Longest element selector kept on a box (`EvidenceBox.target`); a longer one is left off, never cut. */
export const BOX_TARGET_MAX = 300;
const boxTarget = (t: unknown): { target?: string } => (typeof t === 'string' && t.length > 0 && t.length <= BOX_TARGET_MAX ? { target: t } : {});

export const CAPTURE_DEFAULTS = {
  /** Page load (to the load event). */
  loadTimeoutMs: 30_000,
  /** Everything one page gets: open, load, settle and all its images. */
  pageBudgetMs: 45_000,
  /** One in-page lookup. */
  evalTimeoutMs: 5_000,
  /** One screenshot. */
  shotTimeoutMs: 10_000,
  /** Closing a browser context. */
  closeTimeoutMs: 5_000,
  /** The whole pass: no page starts after this, and a running page gets only what is left. */
  passBudgetMs: 60_000,
} as const;

export type CaptureTimeouts = { [K in keyof typeof CAPTURE_DEFAULTS]: number };

export interface CaptureOptions {
  userAgent: string;
  /** Pages loaded at once (the audit's concurrency). Default 6, clamped to 1–16. */
  concurrency?: number;
  /** Time limits (tests shorten them). */
  timeouts?: Partial<CaptureTimeouts>;
  /**
   * The scan's politeness controller (`src/pace.ts`): a page load waits its turn, and one the site
   * refused is tried once more after a pause (within the first half of the page's time).
   */
  pace?: Pace;
}

/** A taken image: its metadata (no id yet; the recorder assigns it) and the JPEG. */
export interface CapturedShot {
  shot: Omit<EvidenceShot, 'id'>;
  jpeg: Uint8Array;
}

/** One planned image: taken, or why not (plain words for the report's technical details). */
export type CaptureResult = { shot: CapturedShot; missed?: undefined } | { shot: null; missed: string };

/** Why a picture is missing, in the words the report uses after "No picture: ". */
export const MISSED = {
  noTime: 'the scan ran out of time for this picture',
  timeout: 'the page did not load again in time for its picture',
  load: 'the page could not be loaded again for its picture',
  notFound: 'the failing element was not found or not visible when the page was loaded again',
  failed: 'the picture could not be taken',
} as const;

const DESKTOP = VIEWPORTS.find((v) => v.name === 'desktop') ?? { name: 'desktop' as const, width: 1280, height: 900 };

/** The CSS viewport and pixel ratio of each width the pass pictures. */
const SCREENS: Readonly<Record<EvidenceViewport, { width: number; height: number; deviceScaleFactor: number }>> = {
  desktop: { width: DESKTOP.width, height: DESKTOP.height, deviceScaleFactor: 1 },
  mobile: PHONE,
};
const widthOf = (item: EvidenceItem): EvidenceViewport => (item.kind === 'ai' ? 'desktop' : item.viewport === 'mobile' ? 'mobile' : 'desktop');

class Timeout extends Error {}

/** Resolves like `p`, or rejects after `ms`. The work behind `p` is stopped by closing its context. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Timeout()), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function closeQuietly(ctx: ContextLike, ms: number): Promise<void> {
  try {
    await withTimeout(ctx.close(), ms);
  } catch {
    // A context that will not close is left to the browser's own shutdown.
  }
}

/**
 * Takes the planned images. Returns one entry per item, in plan order: the image, or null when it
 * could not be taken (page failed to load, no target found, screenshot failed, out of time).
 */
export async function captureEvidence(browser: BrowserLike, items: readonly EvidenceItem[], opts: CaptureOptions): Promise<(CapturedShot | null)[]> {
  return (await captureEvidenceResults(browser, items, opts)).map((r) => r.shot);
}

/** As `captureEvidence`, with the reason for each image not taken. Never throws. */
export async function captureEvidenceResults(browser: BrowserLike, items: readonly EvidenceItem[], opts: CaptureOptions): Promise<CaptureResult[]> {
  const t: CaptureTimeouts = { ...CAPTURE_DEFAULTS, ...opts.timeouts };
  const out: CaptureResult[] = items.map(() => ({ shot: null, missed: MISSED.noTime }));
  // Items grouped by page and width, in the order they first appear, so each page loads once per width.
  const groups = new Map<string, number[]>();
  items.forEach((item, i) => {
    const key = `${widthOf(item)}\n${item.page}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  const queue = [...groups.entries()];
  const concurrency = Math.min(Math.max(Math.floor(opts.concurrency ?? 6), 1), 16);
  const deadline = Date.now() + t.passBudgetMs;
  const worker = async (): Promise<void> => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const left = deadline - Date.now();
      if (left <= 0) return;
      const [, indices] = job;
      const url = items[indices[0]!]!.page;
      // Each load takes a turn of the scan's page gate (pages at once of the moment, src/pace.ts), as a page audit does.
      let slot: PageSlot | undefined;
      try {
        slot = opts.pace ? await opts.pace.page() : undefined;
      } catch {
        return; // the scan stopped
      }
      try {
        await capturePage(browser, url, widthOf(items[indices[0]!]!), indices.map((i) => items[i]!), opts.userAgent, { ...t, pageBudgetMs: Math.min(t.pageBudgetMs, Math.max(0, deadline - Date.now())) },
          (k, r) => { out[indices[k]!] = r; }, opts.pace);
      } finally {
        slot?.release();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
}

async function capturePage(
  browser: BrowserLike,
  url: string,
  width: EvidenceViewport,
  items: EvidenceItem[],
  userAgent: string,
  t: CaptureTimeouts,
  put: (k: number, r: CaptureResult) => void,
  pace?: Pace,
): Promise<void> {
  let ctx: ContextLike | undefined;
  let abandoned = false;
  // Why the images not taken are missing, as far as the page got.
  let why: string = MISSED.timeout;
  let loadedOk = false;
  const settled = new Set<number>();
  const give = (k: number, r: CaptureResult) => { settled.add(k); put(k, r); };
  // Pictures wait here until the page is known to have kept its styles to the end.
  const taken: [number, CaptureResult][] = [];
  let styles: StyleWatch | undefined;
  // A wait for a refused load must end in the first half of the page's time, leaving the rest for the pictures.
  const retryBy = Date.now() + t.pageBudgetMs / 2;
  const job = (async () => {
    const screen = SCREENS[width];
    const c = await browser.newContext({
      viewport: { width: screen.width, height: screen.height }, userAgent, reducedMotion: 'reduce', deviceScaleFactor: screen.deviceScaleFactor,
      ...(width === 'mobile' ? { isMobile: true, hasTouch: true } : {}),
    });
    ctx = c;
    // Out of time while the context opened: close it here, nobody else will.
    if (abandoned) return;
    const page = await c.newPage();
    // Hosted use: a page whose gate could not start is not loaded at all (navigationGate).
    if (gateStopsLoad(page)) return;
    // A reload for a picture goes ahead of the probes' loads waiting for the site's crawl gap (it is one
    // of a few, and the last thing the report waits for); a page's widths count as one load.
    // A page whose stylesheet the site refused is unstyled: never pictured as the page (tried again once).
    styles = watchStyles(page, pace, url);
    let loadedUrl: string | undefined;
    const loaded = await gotoPolitely(pace, url, () => (abandoned ? Promise.resolve(null) : page.goto(url, { waitUntil: 'load', timeout: t.loadTimeoutMs })), {
      retries: 1, deadline: retryBy, priority: true, crawlGroup: `evidence\n${url}`, ...(styles ? { styles } : {}),
      // As the audit: the scroll pass inside the settle window, in each try of an HTML page.
      prepare: async (r) => {
        const type = r.headers()['content-type'] ?? '';
        if (type && !/html/i.test(type)) return;
        loadedUrl = documentAddress(page);
        const loadedAt = Date.now();
        // scrollThrough stops at 20 000 px (about 5 s); a page that stalls it still gets its images.
        await withTimeout(page.evaluate(scrollThrough, undefined), t.evalTimeoutMs * 2).catch(() => undefined);
        const remaining = SETTLE_MS - (Date.now() - loadedAt);
        if (remaining > 0) await page.waitForTimeout(remaining);
      },
    });
    const resp = loaded.value;
    if (loaded.refused) {
      why = `${MISSED.load} (${lowerFirst(loaded.refused)})`;
      return;
    }
    if (!resp || resp.status() >= 400) {
      why = resp ? `${MISSED.load} (HTTP ${resp.status()})` : MISSED.load;
      return;
    }
    const type = resp.headers()['content-type'] ?? '';
    if (type && !/html/i.test(type)) {
      why = MISSED.load;
      return;
    }
    // A page that navigates itself away (a redirect script, a meta refresh) is not this page any more.
    // Hosted use: a document came from a refused server address, the gate was lost, or the page is not
    // an http(s) document (navigationGate): no picture of it is kept.
    if (gateFailure(page)) {
      why = MISSED.load;
      return;
    }
    why = MISSED.timeout;
    loadedOk = true;
    const here = () => documentAddress(page);
    for (let k = 0; k < items.length; k++) {
      if (abandoned) return;
      if (here() !== loadedUrl || gateFailure(page)) {
        why = MISSED.load;
        return;
      }
      let shot: CapturedShot | null = null;
      let failed = false;
      try {
        shot = await captureItem(page, items[k]!, url, width, t);
      } catch {
        failed = true;
      }
      // A gate lost while the picture was taken: it is not kept.
      if (gateFailure(page)) {
        why = MISSED.load;
        return;
      }
      taken.push([k, shot ? { shot } : { shot: null, missed: failed ? MISSED.failed : MISSED.notFound }]);
    }
    // A stylesheet the page needs, refused while the pictures were taken (or still on its way): none
    // of them shows the page people get.
    const late = await refusedSince(styles, pace, url);
    if (late) {
      taken.length = 0;
      why = `${MISSED.load} (${lowerFirst(late)})`;
      return;
    }
    if (!abandoned) for (const [k, r] of taken.splice(0)) give(k, r);
  })();
  // A late rejection (after the time box) must not become an unhandled rejection.
  job.catch(() => undefined);
  try {
    await withTimeout(job, t.pageBudgetMs);
  } catch (err) {
    // Load failure, bad response or out of time: the images not taken stay null. A load that failed
    // outright (not a time-out) could not be loaded; anything slower ran out of time.
    if (!loadedOk && !(err instanceof Timeout) && !(err instanceof Error && err.name === 'TimeoutError')) why = MISSED.load;
  } finally {
    abandoned = true;
    // Out of time: the pictures already taken stand unless a stylesheet the page needs was refused so
    // far (the audit's judgement: refused fonts, print sheets and the like do not count).
    if (taken.length && (!styles || (await styles.degraded()).length === 0)) for (const [k, r] of taken.splice(0)) give(k, r);
    for (let k = 0; k < items.length; k++) if (!settled.has(k)) put(k, { shot: null, missed: why });
    if (ctx) await closeQuietly(ctx, t.closeTimeoutMs);
    else void job.finally(() => (ctx ? closeQuietly(ctx, t.closeTimeoutMs) : undefined)).catch(() => undefined);
  }
}

const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

type Rect = { x: number; y: number; width: number; height: number; target?: string };
/** What the in-page lookup returns: the elements' rectangles and the clip, in viewport CSS px (and an image's alt text). */
type Located = { rects: Rect[]; clip: Rect; alt?: string; scroll?: { x: number; y: number } };

async function captureItem(page: PageLike, item: EvidenceItem, url: string, width: EvidenceViewport, t: CaptureTimeouts): Promise<CapturedShot | null> {
  const viewport = { ...SCREENS[width] };
  if (item.kind === 'start') {
    await withTimeout(page.evaluate(scrollTop, undefined), t.evalTimeoutMs);
    const size = { width: Math.min(START_SHOT.width, viewport.width), height: Math.min(START_SHOT.height, viewport.height) };
    // The failing elements on screen now, by problem; a failed lookup only means no boxes.
    const marks = (item.marks ?? []).filter((m) => m && typeof m.problem === 'string' && Array.isArray(m.targets))
      .map((m) => ({ problem: m.problem, targets: m.targets.slice(0, MAX_CANDIDATES) }));
    let raw: unknown = [];
    if (marks.length) raw = await withTimeout(page.evaluate(measureMarks, { marks, per: START_MARKS_PER_PROBLEM }), t.evalTimeoutMs).catch(() => []);
    const boxes = startBoxes(marks, raw, size);
    // The whole viewport as the screen shows it (a phone may show a page laid out wider than 390 px, zoomed out).
    const jpeg = await withTimeout(page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY }), t.shotTimeoutMs);
    const where = width === 'mobile' ? 'a phone screen' : 'a desktop screen';
    const n = new Set(boxes.map((b) => b.problem)).size;
    const alt = `${pageLabel(url)} as it first appears on ${where}${n ? `, with ${n === 1 ? '1 problem' : `${n} problems`} outlined` : ''}`;
    return { shot: { page: url, viewport, width: size.width, height: size.height, area: { x: 0, y: 0, width: size.width, height: size.height }, boxes, alt, for: { rule: '$start' } }, jpeg };
  }
  // A rule's elements, and a scored AI image (scoring v5), get room around them and a box.
  const boxed = item.kind === 'rule' || (item.kind === 'ai' && item.scored === true);
  const arg = { pad: boxed ? CLIP_PADDING : 0, max: { width: Math.min(MAX_CLIP.width, viewport.width), height: Math.min(MAX_CLIP.height, viewport.height) } };
  let raw: unknown;
  if (item.kind === 'rule') {
    // Which of the targets share the image: measured on the page, chosen here, then scrolled to.
    const targets = item.targets.slice(0, MAX_CANDIDATES);
    const chosen = pickTargets(targets, await withTimeout(page.evaluate(measureTargets, targets), t.evalTimeoutMs), arg.pad, arg.max);
    if (!chosen.length) return null;
    raw = await withTimeout(page.evaluate(locateTargets, { ...arg, targets: chosen }), t.evalTimeoutMs);
  } else {
    raw = await withTimeout(page.evaluate(locateImage, { ...arg, src: item.target }), t.evalTimeoutMs);
  }
  const located = sanitize(raw, arg.max);
  if (!located) return null;
  const { clip, rects } = located;
  // Where the image sits on the page (document CSS px), so a later scan can picture the same place.
  const area = located.scroll ? { x: clip.x + located.scroll.x, y: clip.y + located.scroll.y, width: clip.width, height: clip.height } : undefined;
  const boxes: EvidenceBox[] = boxed ? boxesIn(rects, clip) : [];
  if (item.kind === 'rule' && boxes.length === 0) return null;
  const jpeg = await shoot(page, clip, t);
  const shot: Omit<EvidenceShot, 'id'> = item.kind === 'rule'
    ? { page: url, viewport, width: clip.width, height: clip.height, ...(area ? { area } : {}), boxes, alt: ruleAlt(url, boxes.length, item.help), for: { rule: item.rule } }
    : { page: url, viewport, width: clip.width, height: clip.height, ...(area ? { area } : {}), boxes, alt: aiAlt(url, { target: item.target, alt: located.alt, observed: item.observed }), for: { ai: item.target } };
  return { shot, jpeg };
}

async function shoot(page: PageLike, clip: Rect, t: CaptureTimeouts): Promise<Uint8Array> {
  return withTimeout(page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY, clip }), t.shotTimeoutMs);
}

/**
 * The start shot's boxes from what `measureMarks` returned (per mark, rectangles in screen CSS px):
 * whole pixels inside the image, keyed by problem, at most `START_MARKS_PER_PROBLEM` per problem and
 * `MAX_START_BOXES` in all. No labels: the report numbers them by problem. Anything malformed is dropped.
 */
export function startBoxes(marks: readonly StartMark[], measured: unknown, size: { width: number; height: number }): EvidenceBox[] {
  if (!Array.isArray(measured)) return [];
  const out: EvidenceBox[] = [];
  marks.forEach((m, i) => {
    const rects = measured[i];
    if (!Array.isArray(rects)) return;
    let n = 0;
    for (const r of rects.slice(0, START_MARKS_PER_PROBLEM)) {
      if (out.length >= MAX_START_BOXES || n >= START_MARKS_PER_PROBLEM) return;
      const [b] = boxesIn([r as Rect].filter((x) => x && typeof x === 'object' && [x.x, x.y, x.width, x.height].every((v) => typeof v === 'number' && Number.isFinite(v))), { x: 0, y: 0, ...size });
      if (!b) continue;
      out.push({ x: b.x, y: b.y, width: b.width, height: b.height, kind: 'fail', problem: m.problem, ...boxTarget((r as Rect).target) });
      n++;
    }
  });
  return out;
}

/** Boxes relative to the clip, cut to it; numbered when there are several. */
export function boxesIn(rects: readonly Rect[], clip: Rect): EvidenceBox[] {
  const boxes: EvidenceBox[] = [];
  for (const r of rects) {
    const x0 = Math.max(r.x, clip.x);
    const y0 = Math.max(r.y, clip.y);
    const x1 = Math.min(r.x + r.width, clip.x + clip.width);
    const y1 = Math.min(r.y + r.height, clip.y + clip.height);
    // Whole pixels, rounded inwards: the box never reaches past the element's painted area.
    const bx = Math.max(0, Math.ceil(x0 - clip.x - 0.01));
    const by = Math.max(0, Math.ceil(y0 - clip.y - 0.01));
    const bw = Math.floor(x1 - clip.x + 0.01) - bx;
    const bh = Math.floor(y1 - clip.y + 0.01) - by;
    if (bw < 1 || bh < 1) continue;
    boxes.push({ x: bx, y: by, width: bw, height: bh, kind: 'fail', ...boxTarget(r.target) });
  }
  return boxes.length > 1 ? boxes.map((b, i) => ({ ...b, label: String(i + 1) })) : boxes;
}

/** Whole, finite numbers inside the limits from whatever the page returned; null when unusable. */
function sanitize(raw: unknown, max: { width: number; height: number }): Located | null {
  if (!raw || typeof raw !== 'object') return null;
  const rect = (v: unknown): Rect | null => {
    if (!v || typeof v !== 'object') return null;
    const { x, y, width, height } = v as Record<string, unknown>;
    if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    return { x: x as number, y: y as number, width: width as number, height: height as number, ...boxTarget((v as Record<string, unknown>).target) };
  };
  const c = rect((raw as { clip?: unknown }).clip);
  if (!c) return null;
  // Nearest whole pixels: an image at y = 300.5 keeps its own size in the clip.
  const x0 = Math.max(0, Math.round(c.x));
  const y0 = Math.max(0, Math.round(c.y));
  const x1 = Math.min(max.width, Math.round(c.x + c.width));
  const y1 = Math.min(max.height, Math.round(c.y + c.height));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  const list = (raw as { rects?: unknown }).rects;
  const rects = (Array.isArray(list) ? list.slice(0, 3) : []).map(rect).filter((r): r is Rect => r !== null && r.width >= 1 && r.height >= 1);
  const alt = (raw as { alt?: unknown }).alt;
  const sc = (raw as { scroll?: unknown }).scroll as Record<string, unknown> | undefined;
  const scroll = sc && typeof sc === 'object' && [sc.x, sc.y].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 1e7)
    ? { x: Math.round(sc.x as number), y: Math.round(sc.y as number) } : undefined;
  return { clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, rects, ...(typeof alt === 'string' ? { alt: alt.slice(0, 1000) } : {}), ...(scroll ? { scroll } : {}) };
}

/**
 * The targets to box, from what `measureTargets` returned for each (in order): the largest group that
 * fits one image (`chooseTargets`). Anything malformed counts as not found.
 */
export function pickTargets(targets: readonly string[], measured: unknown, pad: number, max: { width: number; height: number }): string[] {
  if (!Array.isArray(measured)) return [];
  const found: { target: string; c: TargetCandidate }[] = [];
  targets.forEach((target, i) => {
    const m = measured[i] as Record<string, unknown> | null | undefined;
    if (!m || typeof m !== 'object') return;
    const { x0, y0, x1, y1 } = m;
    if (![x0, y0, x1, y1].every((n) => typeof n === 'number' && Number.isFinite(n))) return;
    if ((x1 as number) - (x0 as number) < 1 || (y1 as number) - (y0 as number) < 1) return;
    found.push({ target, c: { x0: x0 as number, y0: y0 as number, x1: x1 as number, y1: y1 as number, text: m.text === true } });
  });
  return chooseTargets(found.map((f) => f.c), pad, max).map((i) => found[i]!.target);
}

// ----- Alt text: what the picture shows, in plain words (no rule ids). -----

/** "Home page" for the site root, otherwise "Page /path". */
export function pageLabel(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
    path = decodeURIComponent(path);
  } catch {
    // keep what we have
  }
  if (path === '/' || path === '') return 'Home page';
  return `Page ${path.length > 80 ? `${path.slice(0, 79)}…` : path}`;
}

const clean = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function ruleAlt(url: string, n: number, help: string): string {
  const what = n === 1 ? '1 element outlined that fails' : `${n} elements outlined that fail`;
  return `${pageLabel(url)}: ${what} “${clean(help, 160)}”`;
}

/** Longest alt text or AI description quoted in a thumbnail's alt text. */
const AI_ALT_QUOTE = 120;
/** Longest text looked at (the patterns below stay cheap on it). */
const AI_ALT_SCAN = 600;
/** Addresses in text: a scheme, `//host`, `www.` or a path starting with `/`. */
const ADDRESS_IN_TEXT = /(?:\b(?:https?|data|blob|file|ftp|javascript):|\/\/|\bwww\.)\S*|(?:^|\s)\/\S+/gi;
/** Image file names in text ("IMG_1234.JPG", "ci-a836.webp?w=640"). */
const FILE_IN_TEXT = /[^\s.]*(?:\.[^\s.]+)*\.(?:png|jpe?g|jfif|gif|webp|avif|svg|bmp|tiff?|ico|heic|heif)\b\S*/gi;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The image's file name and its stem (without the extension), when long enough to matter. */
function fileNames(target: string): string[] {
  let base = '';
  try {
    base = new URL(target).pathname.split('/').filter(Boolean).pop() ?? '';
    base = decodeURIComponent(base);
  } catch {
    // keep what we have
  }
  const stem = base.replace(/\.[^.]*$/, '');
  return [base, stem].filter((n) => n.length >= 4);
}

/** Cleaned text with addresses, image file names and the image's own file name taken out. */
function withoutNames(v: unknown, target: string): { text: string; removed: boolean } {
  const text = cleanText(v, AI_ALT_SCAN);
  let out = text.replace(ADDRESS_IN_TEXT, ' ').replace(FILE_IN_TEXT, ' ');
  for (const name of fileNames(target)) out = out.replace(new RegExp(escapeRe(name), 'gi'), ' ');
  out = cleanText(out, AI_ALT_SCAN);
  return { text: out, removed: out !== text };
}

/**
 * Alt text for an AI thumbnail: the image's own alt text (quoted, max 120 characters) when it has
 * words and no address or file name in it, else what the AI saw (addresses and file names taken out),
 * else plain words. Never the file name or an address (spec §3.2).
 */
export function aiAlt(url: string, from: { target: string; alt?: unknown; observed?: unknown }): string {
  const alt = withoutNames(from.alt, from.target);
  if (alt.text && !alt.removed) return `${pageLabel(url)}: the image with the alt text “${cleanText(alt.text, AI_ALT_QUOTE)}”, which the AI review flagged`;
  const seen = withoutNames(from.observed, from.target).text.replace(/[.\s]+$/, '');
  if (seen) return `${pageLabel(url)}: an image the AI review flagged; the AI describes it as “${cleanText(seen, AI_ALT_QUOTE)}”`;
  const label = pageLabel(url);
  return `An image on ${label === 'Home page' ? 'the home page' : `the p${label.slice(1)}`} that the AI review flagged`;
}

// ----- In-page functions (serialised into the page: self-contained, no closures). -----

async function scrollTop(): Promise<void> {
  window.scrollTo({ left: 0, top: 0, behavior: 'instant' as ScrollBehavior });
  await new Promise<void>((r) => { requestAnimationFrame(() => requestAnimationFrame(() => r())); setTimeout(r, 150); });
}

/**
 * Runs in the page (self-contained): for each mark, the rectangles of its targets that are on screen
 * now, in the screen's CSS px (through the visual viewport, so a phone that shows a wide page zoomed
 * out still lines up), at most `per` each. A selector that does not parse, matches nothing (or an
 * element an earlier target of the same mark matched), has no size, is not visible or is off screen
 * is skipped. Main document only.
 */
function measureMarks(arg: { marks: { problem: string; targets: string[] }[]; per: number }): { x: number; y: number; width: number; height: number; target: string }[][] {
  const vv = window.visualViewport;
  const scale = vv && vv.scale > 0 ? vv.scale : 1;
  const ox = vv ? vv.offsetLeft : 0;
  const oy = vv ? vv.offsetTop : 0;
  const sw = vv ? vv.width * scale : window.innerWidth;
  const sh = vv ? vv.height * scale : window.innerHeight;
  return arg.marks.map((m) => {
    const seen: Element[] = [];
    const out: { x: number; y: number; width: number; height: number; target: string }[] = [];
    for (const t of m.targets) {
      if (out.length >= arg.per) break;
      let el: Element | null = null;
      try {
        el = document.querySelector(t);
      } catch {
        el = null;
      }
      if (!el || seen.includes(el)) continue;
      seen.push(el);
      const r = el.getBoundingClientRect();
      if (!(r.width >= 1 && r.height >= 1)) continue;
      try {
        const visible = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility?.({ visibilityProperty: true, opacityProperty: true });
        if (visible === false) continue;
      } catch {
        // older browsers: keep it
      }
      const x = (r.left - ox) * scale;
      const y = (r.top - oy) * scale;
      const w = r.width * scale;
      const h = r.height * scale;
      if (x >= sw || y >= sh || x + w <= 0 || y + h <= 0) continue;
      out.push({ x, y, width: w, height: h, target: t });
    }
    return out;
  });
}

/**
 * Runs in the page (self-contained): each target's box in document CSS px and whether it shows text
 * on screen, or null when its selector does not parse, matches nothing (or an element an earlier
 * target matched), has no size or is not visible. Main document only.
 */
function measureTargets(targets: string[]): ({ x0: number; y0: number; x1: number; y1: number; text: boolean } | null)[] {
  const seen: Element[] = [];
  return targets.map((t) => {
    let el: Element | null = null;
    try {
      el = document.querySelector(t);
    } catch {
      el = null;
    }
    if (!el || seen.includes(el)) return null;
    const r = el.getBoundingClientRect();
    if (!(r.width >= 1 && r.height >= 1)) return null;
    try {
      const visible = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility?.({ visibilityProperty: true, opacityProperty: true });
      if (visible === false) return null;
    } catch {
      // older browsers: keep it
    }
    seen.push(el);
    const text = String((el as HTMLElement).innerText ?? '').trim().length > 0;
    return { x0: r.left + window.scrollX, y0: r.top + window.scrollY, x1: r.right + window.scrollX, y1: r.bottom + window.scrollY, text };
  });
}

/**
 * Finds the chosen targets in the main document (a selector that does not parse, or matches nothing,
 * or has no size, is skipped), scrolls them into view and returns their rectangles and the clip, in
 * viewport CSS px.
 */
async function locateTargets(arg: { targets: string[]; pad: number; max: { width: number; height: number } }): Promise<Located | null> {
  const kept: Element[] = [];
  const keptTargets: string[] = [];
  const box = (el: Element) => el.getBoundingClientRect();
  for (const t of arg.targets) {
    let el: Element | null = null;
    try {
      el = document.querySelector(t);
    } catch {
      el = null;
    }
    if (!el || kept.includes(el)) continue;
    const r = box(el);
    if (!(r.width >= 1 && r.height >= 1)) continue;
    kept.push(el);
    keptTargets.push(t);
  }
  if (!kept.length) return null;
  // Document coordinates, so elements far apart on the page compare correctly.
  const doc = (el: Element) => {
    const r = box(el);
    return { x0: r.left + window.scrollX, y0: r.top + window.scrollY, x1: r.right + window.scrollX, y1: r.bottom + window.scrollY };
  };
  const all = kept.map(doc);
  const u = {
    x0: Math.min(...all.map((d) => d.x0)), y0: Math.min(...all.map((d) => d.y0)),
    x1: Math.max(...all.map((d) => d.x1)), y1: Math.max(...all.map((d) => d.y1)),
  };
  // Put the union's top-left (with padding) at the viewport's top-left, or centre it when it is small.
  const vw = Math.min(window.innerWidth, arg.max.width);
  const vh = Math.min(window.innerHeight, arg.max.height);
  const left = Math.max(0, u.x0 - Math.max(arg.pad, (vw - (u.x1 - u.x0)) / 2));
  const top = Math.max(0, u.y0 - Math.max(arg.pad, (vh - (u.y1 - u.y0)) / 2));
  window.scrollTo({ left, top, behavior: 'instant' as ScrollBehavior });
  await new Promise<void>((r) => { requestAnimationFrame(() => requestAnimationFrame(() => r())); setTimeout(r, 150); });
  // Measured again after the scroll (sticky headers, lazy layout).
  const rects = kept.map((el, i) => {
    const r = box(el);
    return { x: r.left, y: r.top, width: r.width, height: r.height, target: keptTargets[i]! };
  });
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.width));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));
  const docEl = document.documentElement;
  // Not past the document's end (a short page) or the viewport.
  const right = Math.min(vw, Math.max(docEl.scrollWidth, docEl.clientWidth) - window.scrollX);
  const bottom = Math.min(vh, Math.max(docEl.scrollHeight, document.body?.scrollHeight ?? 0, docEl.clientHeight) - window.scrollY);
  const x = Math.max(0, minX - arg.pad);
  const y = Math.max(0, minY - arg.pad);
  const clip = { x, y, width: Math.min(right, maxX + arg.pad) - x, height: Math.min(bottom, maxY + arg.pad) - y };
  return { rects, clip, scroll: { x: window.scrollX, y: window.scrollY } };
}

/** The image whose current or declared address is `src`, scrolled into view and clipped to itself (with its alt text). */
async function locateImage(arg: { src: string; pad: number; max: { width: number; height: number } }): Promise<Located | null> {
  const strip = (u: string) => u.split('#')[0];
  const want = strip(arg.src);
  let img: HTMLImageElement | undefined;
  for (const el of Array.from(document.images)) {
    if (strip(el.currentSrc) === want || strip(el.src) === want) {
      const r = el.getBoundingClientRect();
      if (r.width >= 1 && r.height >= 1) {
        img = el;
        break;
      }
    }
  }
  if (!img) return null;
  const r0 = img.getBoundingClientRect();
  const vw = Math.min(window.innerWidth, arg.max.width);
  const vh = Math.min(window.innerHeight, arg.max.height);
  const left = Math.max(0, r0.left + window.scrollX - Math.max(0, (vw - r0.width) / 2));
  const top = Math.max(0, r0.top + window.scrollY - Math.max(0, (vh - r0.height) / 2));
  window.scrollTo({ left, top, behavior: 'instant' as ScrollBehavior });
  await new Promise<void>((r) => { requestAnimationFrame(() => requestAnimationFrame(() => r())); setTimeout(r, 150); });
  const r = img.getBoundingClientRect();
  const x = Math.max(0, r.left - arg.pad);
  const y = Math.max(0, r.top - arg.pad);
  const rect = { x: r.left, y: r.top, width: r.width, height: r.height };
  const alt = img.getAttribute('alt');
  return { rects: [rect], clip: { x, y, width: Math.min(vw, r.right + arg.pad) - x, height: Math.min(vh, r.bottom + arg.pad) - y }, scroll: { x: window.scrollX, y: window.scrollY }, ...(alt !== null ? { alt: alt.slice(0, 1000) } : {}) };
}
