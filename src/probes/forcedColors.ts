// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Forced colours (plan item C13): what disappears when Windows shows a page in a contrast theme. People
// who use one see every page in a few system colours: backgrounds become the theme's background,
// text, borders and outlines the theme's colours, and box shadows and background gradients are gone.
// Chromium emulates it (`page.emulateMedia({ forcedColors: 'active' })`, CDP
// `Emulation.setEmulatedMedia` with the `forced-colors` feature), drawing the page with a light system
// palette or a dark one chosen by `prefers-color-scheme`; the probe checks both. It compares the page
// as shown with the page in each palette and reports only clear disappearances:
// Every disappearance is a recommendation (batch 19, the lead's ruling D3), never a failure:
// - 1.4.11: an icon-only control, a custom checkbox or radio button, or a styled form field whose
//   pixels (its box and a ring around it) are one colour in a palette while they showed something before
//   (a white icon on a coloured button, an icon drawn with a CSS mask and a background colour, a box drawn
//   only by its fill);
// - 1.4.3: text over a picture, or text that keeps its own colours (`forced-color-adjust: none`), that
//   becomes one colour with what is behind it (white text on the theme's white backplate);
// - 2.4.7: a focus indicator that shows in normal colours and is gone in the dark palette (drawn only
//   with a box shadow or a background colour). A recommendation, never a failure (W3C precision lane,
//   2026-11-11): 2.4.7 asks for "a mode of operation where the keyboard focus indicator is visible", and the
//   indicator in normal colours is one (ACT oj04fd passes such indicators).
// Listed, not scored (scoring v8): it counts once the gold standard proves it never fails a clean page.
// Engine core: no Node-only imports.
import type { PageLike, ProbeFinding } from '../types.js';
import { cleanText, cropAround, timeFor } from './evidence.js';
import { focusTest, navigationRace, pressAndMeasure, startKit } from './keyboard/traverse.js';
import { kitResetStart, kitStop, type KeyCounts, type StopFacts } from './keyboard/page.js';
import { hiddenReason, obscuredBy } from './keyboard/rules.js';
import { locateControls, NON_TEXT_LIMITS, type NonTextLimits, type NonTextTarget } from './nonTextContrast.js';
import { boxPixels, contrastRatio, isMoving, relativeLuminance, type RgbaImage } from './pixels.js';
import { eachBatch, shoot, SHOT_KEY, toImageBoxes, viewElements, type CssBox, type ViewItem } from './shots.js';
import { guarded } from './textContrast.js';
import { ProbeNotTestable, type PageProbe, type ProbeContext } from './types.js';

export type Palette = 'light' | 'dark';
export const PALETTES: readonly Palette[] = ['light', 'dark'];

export const FORCED_COLORS_LIMITS = {
  /** Controls measured per page (icon-only controls, custom checkboxes and radio buttons, styled fields). */
  controls: { ...NON_TEXT_LIMITS, fields: 6, toggles: 6, icons: 12 } satisfies NonTextLimits,
  /** Texts over a picture (or keeping their own colours) measured per page. */
  texts: 8,
  /** Elements the text search looks at, at most. */
  textScan: 3000,
  /** Tab stops whose focus indicator is compared. */
  focusStops: 10,
  /** Scroll positions screenshotted per part (controls, texts). */
  maxBatches: 4,
  /** CSS px around a control's box that belong to what it shows (an edge drawn just outside it). */
  ring: 3,
  /** Time kept back from the time box to report. */
  reserveMs: 1500,
} as const;

/**
 * When something disappears: before, at least `minVisible` pixels contrast with the area's main colour
 * by `visibleRatio` or more (something people saw); after, at most `goneMax` pixels differ from the
 * area's main colour by more than `goneDelta` on any channel (it is one colour; anti-aliasing allowed).
 */
export const VANISH = { visibleRatio: 1.5, minVisible: 12, goneDelta: 24, goneMax: 2 } as const;

/** The most common colour of the pixels `at` (packed 0xRRGGBB). */
function dominant(img: RgbaImage, at: readonly number[]): number {
  const counts = new Map<number, number>();
  let best = 0;
  let bestN = 0;
  for (const p of at) {
    const i = p * 4;
    const c = (img.data[i]! << 16) | (img.data[i + 1]! << 8) | img.data[i + 2]!;
    const n = (counts.get(c) ?? 0) + 1;
    counts.set(c, n);
    if (n > bestN) {
      bestN = n;
      best = c;
    }
  }
  return best;
}

/**
 * Whether what the pixels `at` showed in `before` is gone in `after` (both screenshots of the same
 * area): `before` and `after` count the pixels that stand out in each (see `VANISH`). One pass over
 * the pixels each.
 */
export function vanished(before: RgbaImage, after: RgbaImage, at: readonly number[]): { before: number; after: number; gone: boolean } {
  if (!at.length || before.width !== after.width || before.height !== after.height) return { before: 0, after: 0, gone: false };
  const b = dominant(before, at);
  const bl = relativeLuminance([(b >> 16) & 255, (b >> 8) & 255, b & 255]);
  let shown = 0;
  for (const p of at) {
    const i = p * 4;
    const l = relativeLuminance([before.data[i]!, before.data[i + 1]!, before.data[i + 2]!]);
    if ((Math.max(l, bl) + 0.05) / (Math.min(l, bl) + 0.05) >= VANISH.visibleRatio) shown++;
  }
  const a = dominant(after, at);
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  let left = 0;
  for (const p of at) {
    const i = p * 4;
    if (Math.max(Math.abs(after.data[i]! - ar), Math.abs(after.data[i + 1]! - ag), Math.abs(after.data[i + 2]! - ab)) > VANISH.goneDelta) left++;
  }
  return { before: shown, after: left, gone: shown >= VANISH.minVisible && left <= VANISH.goneMax };
}

// ---------------------------------------------------------------------------------------------
// Findings.

export interface ForcedControlFailure { target: string; kind: NonTextTarget['kind']; graphic?: string; name: string; palettes: Palette[] }
export interface ForcedTextFailure { target: string; text: string; palettes: Palette[] }
export interface ForcedFocusFailure { target: string; name: string; palettes: Palette[] }

export interface ForcedResults {
  /** `found`: candidates on the page; `measured`: compared in at least one palette; `cut`: time ran out first. */
  controls: { found: number; measured: number; cut?: boolean; items: ForcedControlFailure[] };
  texts: { found: number; measured: number; cut?: boolean; items: ForcedTextFailure[] };
  /** `stops`: focus stops reached; `compared`: those with an indicator in normal colours, compared in forced colours. */
  focus: { stops: number; compared: number; cut?: boolean; items: ForcedFocusFailure[] };
}

const themes = (p: readonly Palette[]) => (p.length > 1 ? 'light and dark contrast themes' : `a ${p[0] ?? 'dark'} contrast theme`);
const quoted = (s: string) => (s ? `: “${s}”` : '');
const CONTROL_WORDS = {
  icon: { what: 'An icon-only control', part: 'its icon' },
  toggle: { what: 'A custom checkbox or radio button', part: 'it' },
  field: { what: 'A form field', part: 'its edge' },
} as const;
const TIME_OUT = 'the time for this test ran out before it could measure them';

/**
 * Findings from what was measured. Disappearances are recommendations (batch 19); things found but never measured give one
 * not_testable finding (none measured at all), and a page without any gives not_applicable.
 */
export function forcedColorsFindings(r: ForcedResults): ProbeFinding[] {
  const out: ProbeFinding[] = [];
  // Batch 19 (precision lane; the lead's ruling D3 in docs/atlas/visual.md): a recommendation (`advice`), never a failure.
  // In forced colors the user agent's theme draws the page: 1.4.11 excepts an appearance "determined by the user agent
  // and not modified by the author", and WCAG asks nothing of a contrast theme's rendering. Never the criterion's result.
  for (const c of r.controls.items) {
    const w = CONTROL_WORDS[c.kind];
    out.push({
      criterion: '1.4.11', status: 'no_failures_found', advice: true, target: c.target,
      detail: `${w.what}${c.kind === 'icon' && c.graphic ? ` (${c.graphic})` : ''} disappears in ${themes(c.palettes)} (forced colors): ${w.part} turns the color of the background, so nothing of it shows; in normal colors it shows. A forced-colors rule (an outline, or a system color for the icon) keeps it in contrast themes too${quoted(c.name)}`,
    });
  }
  if (!r.controls.found) out.push({ criterion: '1.4.11', status: 'not_applicable', detail: 'no icon-only controls, custom checkboxes or radio buttons, or styled form fields on the page' });
  else if (!r.controls.measured) out.push({ criterion: '1.4.11', status: 'not_testable', detail: `the controls on the page could not be compared in forced colors: ${r.controls.cut ? TIME_OUT : 'they kept moving, or sat out of view'}` });
  for (const t of r.texts.items) {
    out.push({ criterion: '1.4.3', status: 'no_failures_found', advice: true, target: t.target, detail: `Text disappears in ${themes(t.palettes)} (forced colors): it turns the color of what is behind it; in normal colors it can be read. A forced-colors rule (a backplate or system colors) keeps it readable in contrast themes too${quoted(t.text)}` });
  }
  if (!r.texts.found) out.push({ criterion: '1.4.3', status: 'not_applicable', detail: 'no text over a picture, and no text that keeps its own colors, on the page' });
  else if (!r.texts.measured) out.push({ criterion: '1.4.3', status: 'not_testable', detail: `the text over pictures could not be compared in forced colors: ${r.texts.cut ? TIME_OUT : 'it kept moving, or sat out of view'}` });
  for (const f of r.focus.items) {
    // A recommendation (`advice`): the indicator shows in normal colors, which meets 2.4.7's "a mode of operation where
    // the keyboard focus indicator is visible". Never the criterion's result, never in the score.
    out.push({
      criterion: '2.4.7', status: 'no_failures_found', advice: true, target: f.target,
      detail: `In ${themes(f.palettes)} (Windows High Contrast, forced colors) the focus indicator disappears: it is drawn with a shadow or a color change and no outline, which the theme removes; in normal colors it shows, which meets 2.4.7. An outline (a transparent one is enough) keeps it in contrast themes too${quoted(f.name)}`,
    });
  }
  if (!r.focus.compared) {
    if (r.focus.cut) out.push({ criterion: '2.4.7', status: 'not_testable', detail: TIME_OUT.replace('them', 'the focus indicators') });
    else out.push({ criterion: '2.4.7', status: 'not_applicable', detail: r.focus.stops ? 'no focus indicator shows in normal colors to compare with' : 'nothing on the page takes keyboard focus' });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// In the page.

/** What the page shows in forced colours, read from a fresh element the page's styles cannot reach. */
export interface ForcedState {
  /** `(forced-colors: active)` matches. */
  active: boolean;
  /** A background colour was replaced by the palette's: the page is really drawn in forced colours. */
  applied: boolean;
  canvas: string;
  text: string;
}

/** Runs in the page (self-contained). */
export function forcedState(): ForcedState {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:hidden';
  const shadow = host.attachShadow({ mode: 'closed' });
  const el = document.createElement('div');
  el.style.cssText = 'background-color: rgb(1, 2, 3); color: rgb(4, 5, 6)';
  shadow.appendChild(el);
  (document.body ?? document.documentElement).appendChild(host);
  try {
    const s = getComputedStyle(el);
    return { active: matchMedia('(forced-colors: active)').matches, applied: s.backgroundColor !== 'rgb(1, 2, 3)', canvas: s.backgroundColor, text: s.color };
  } finally {
    host.remove();
  }
}

export interface ForcedTextTarget {
  ref: number;
  path: string;
  /** The first words (max 60). */
  text: string;
  y: number;
}

/**
 * Runs in the page (self-contained). Finds, in page order, visible elements with words of their own
 * that sit over a picture (a CSS background image on them, an ancestor or an ancestor's ::before or
 * ::after, up to 6 levels; or one of the page's first 200 images, videos or canvases covering most of
 * them) or that keep their own colours
 * (`forced-color-adjust: none`), and keeps the first `max` in the shot store.
 */
export function locateForcedTexts(arg: { key: string; max: number; scan: number }): { targets: ForcedTextTarget[]; found: number } {
  const store: Element[] = [];
  (window as unknown as Record<string, unknown>)[arg.key] = store;
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur.id && document.querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      const name = esc(cur.localName);
      if (!parent) { parts.unshift(name); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${name}:nth-of-type(${same.indexOf(cur) + 1})` : name);
    }
    return parts.join(' > ');
  };
  const WORDS = /[\p{L}\p{N}]/u;
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'option', 'textarea', 'select', 'title', 'head']);
  const ownText = (el: Element) => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue ?? '';
    return t.replace(/\s+/g, ' ').trim();
  };
  const url = (bg: string) => /url\(/i.test(bg);
  // Each element's own picture is read once (a page of deep nesting stays linear).
  const own = new Map<Element, boolean>();
  const hasPicture = (a: Element, pseudo: boolean): boolean => {
    let v = own.get(a);
    if (v === undefined) {
      v = url(getComputedStyle(a).backgroundImage) || (pseudo && (url(getComputedStyle(a, '::before').backgroundImage) || url(getComputedStyle(a, '::after').backgroundImage)));
      own.set(a, v);
    }
    return v;
  };
  // Pictures laid out on the page (images, videos, canvases), the first 200, measured once.
  const media = [...document.querySelectorAll('img, video, canvas')].slice(0, 200).map((m) => ({ m, r: m.getBoundingClientRect() })).filter((x) => x.r.width > 0 && x.r.height > 0);
  const overPicture = (el: Element, r: DOMRect): boolean => {
    let a: Element | null = el;
    for (let depth = 0; a && depth < 7; depth++, a = a.parentElement) if (hasPicture(a, a !== el)) return true;
    // A picture under the text that covers most of it (not one inside the text's own element).
    return media.some(({ m, r: b }) => {
      if (el.contains(m)) return false;
      const w = Math.min(r.right, b.right) - Math.max(r.left, b.left);
      const h = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
      return w > 0 && h > 0 && w * h >= 0.5 * r.width * r.height;
    });
  };
  const out: ForcedTextTarget[] = [];
  let found = 0;
  let scanned = 0;
  const body = document.body;
  if (!body) return { targets: out, found };
  for (const el of body.querySelectorAll('*')) {
    if (++scanned > arg.scan) break;
    if (SKIP.has(el.localName) || el.closest('svg, math')) continue;
    const text = ownText(el);
    if (!WORDS.test(text)) continue;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const keeps = (getComputedStyle(el) as CSSStyleDeclaration & { forcedColorAdjust?: string }).forcedColorAdjust === 'none';
    if (!keeps && !overPicture(el, r)) continue;
    found++;
    if (out.length >= arg.max) continue;
    out.push({ ref: store.push(el) - 1, path: cssPath(el), text: text.length > 60 ? `${text.slice(0, 59)}…` : text, y: r.top + window.scrollY });
  }
  return { targets: out, found };
}

// ---------------------------------------------------------------------------------------------
// The probe.

/** Whether the browser took `contrast` (Playwright 1.51+; others are asked without it). */
interface Emulation { contrast: boolean }

/** Shows the page in a palette's forced colours, or as normal (the context's defaults) with `null`. */
async function setColours(page: PageLike, palette: Palette | null, em: Emulation): Promise<void> {
  const base = palette ? { forcedColors: 'active' as const, colorScheme: palette } : { forcedColors: 'none' as const, colorScheme: 'light' as const };
  if (em.contrast) {
    try {
      await page.emulateMedia!({ ...base, contrast: palette ? 'more' : 'no-preference' });
      return;
    } catch {
      em.contrast = false;
    }
  }
  await page.emulateMedia!(base);
}

/** The same boxes (within 1 px): the forced colours did not move the elements. */
function sameBoxes(a: readonly CssBox[], b: readonly CssBox[]): boolean {
  return a.length === b.length && a.every((x, i) => x.every((v, j) => Math.abs(v - b[i]![j]!) <= 1));
}

interface Compared {
  ref: number;
  /** Palettes it disappeared in; undefined when it could not be compared. */
  gone?: Palette[];
  box?: CssBox;
}

/**
 * Screenshots the elements `refs` of the shot store a batch at a time: as shown, in each palette and as
 * shown again (movement check), and compares each element's area (its boxes, plus `pad` CSS px).
 * After `onBatch` the page is back in normal colours.
 */
async function compareBatches(ctx: ProbeContext, em: Emulation, refs: number[], mode: 'box' | 'text', pad: number, until: number,
  onBatch: (done: Compared[]) => Promise<void>): Promise<{ results: Map<number, Compared>; cut: boolean }> {
  const page = ctx.page;
  const results = new Map<number, Compared>();
  const cdp = await ctx.cdp?.();
  const r = await eachBatch(page, refs, { mode, margin: Math.max(0, pad) + 4, deadline: until, reserveMs: 0, signal: ctx.signal, maxBatches: FORCED_COLORS_LIMITS.maxBatches },
    async (batch: ViewItem[], clip: CssBox, at) => {
      const via = { ...(cdp ? { cdp } : {}), at };
      const shown = await shoot(page, clip, via);
      const forced = new Map<Palette, { img: RgbaImage; moved: Set<number> }>();
      try {
        for (const p of PALETTES) {
          await setColours(page, p, em);
          const view = await page.evaluate(viewElements, { key: SHOT_KEY, refs: batch.map((b) => b.ref), first: batch[0]!.ref, mode });
          const moved = new Set(batch.filter((b, i) => !sameBoxes(b.boxes, view.items[i]?.boxes ?? []) || view.sx !== at.x || view.sy !== at.y).map((b) => b.ref));
          forced.set(p, { img: await shoot(page, clip, via), moved });
        }
      } finally {
        await setColours(page, null, em);
      }
      const again = await shoot(page, clip, via);
      const done: Compared[] = [];
      for (const b of batch) {
        const boxes = toImageBoxes(b.boxes, clip, shown);
        const pixels = boxPixels(shown, boxes, pad * (shown.width / clip[2]));
        if (b.outside > 0.01 || isMoving(shown, again, pixels)) {
          results.set(b.ref, { ref: b.ref });
          continue;
        }
        const gone: Palette[] = [];
        let compared = true;
        for (const p of PALETTES) {
          const f = forced.get(p)!;
          if (f.moved.has(b.ref)) {
            compared = false;
            continue;
          }
          if (vanished(shown, f.img, pixels).gone) gone.push(p);
        }
        const all = b.boxes;
        const x0 = Math.min(...all.map((x) => x[0]));
        const y0 = Math.min(...all.map((x) => x[1]));
        const box: CssBox = [x0, y0, Math.max(...all.map((x) => x[0] + x[2])) - x0, Math.max(...all.map((x) => x[1] + x[3])) - y0];
        const c: Compared = compared || gone.length ? { ref: b.ref, gone, box } : { ref: b.ref };
        results.set(b.ref, c);
        done.push(c);
      }
      await onBatch(done);
    }, () => {});
  return { results, cut: r.cut === 'time' };
}

/**
 * Report evidence for a disappearance: the element in normal colours, then in the palette it
 * disappeared in, side by side. Only while the run still wants a picture of `criterion`. Never throws;
 * the page is left in normal colours.
 */
async function beforeAfter(ctx: ProbeContext, em: Emulation, criterion: string, box: CssBox, palette: Palette, what: string): Promise<void> {
  if (!ctx.evidence || !(ctx.evidenceWanted?.(criterion) ?? false) || !timeFor(ctx, 3000)) return;
  try {
    const rect = { x: box[0], y: box[1], width: box[2], height: box[3] };
    const clip = cropAround([rect], ctx.viewport);
    if (!clip) return;
    const boxes = [{ x: rect.x - clip.x, y: rect.y - clip.y, width: rect.width, height: rect.height, kind: 'fail' as const }];
    const ok = await ctx.evidence({ criterion, clip, boxes, alt: `${what} in normal colors.`, group: 'forced-colors', groupLabel: 'Normal colors' });
    if (!ok || !timeFor(ctx, 2000)) return;
    try {
      await setColours(ctx.page, palette, em);
      await ctx.evidence({
        criterion, clip, boxes, alt: `The same ${what.replace(/^(The|An?) /, '').toLowerCase()} in a ${palette} contrast theme (forced colors): nothing of it shows.`,
        group: 'forced-colors', groupLabel: `${palette === 'light' ? 'Light' : 'Dark'} contrast theme`,
      });
    } finally {
      await setColours(ctx.page, null, em);
    }
  } catch {
    // Evidence never changes the result.
  }
}

async function controlsPart(ctx: ProbeContext, em: Emulation, until: number): Promise<ForcedResults['controls']> {
  const located = await ctx.page.evaluate(locateControls, { key: SHOT_KEY, limits: FORCED_COLORS_LIMITS.controls });
  // Controls the page draws with no words or picture (batch 18, round 2: dots, styled sliders) and controls inside
  // shadow roots (the shared locator reads them since round 2) are the non-text contrast test's; this test keeps to
  // the icons, fields and toggles of the document it judged before.
  const found = { ...located, targets: located.targets.filter((t) => t.graphic !== 'drawn shape' && !t.path.includes(' >>> ')) };
  const byRef = new Map(found.targets.map((t) => [t.ref, t]));
  const order = [...found.targets].sort((a, b) => a.y - b.y).map((t) => t.ref);
  const items: ForcedControlFailure[] = [];
  let pictured = false;
  const { results, cut } = await compareBatches(ctx, em, order, 'box', FORCED_COLORS_LIMITS.ring, until, async (done) => {
    for (const c of done) {
      if (!c.gone?.length) continue;
      const t = byRef.get(c.ref)!;
      items.push({ target: t.path, kind: t.kind, ...(t.graphic ? { graphic: t.graphic } : {}), name: t.name, palettes: c.gone });
      if (!pictured && c.box) {
        pictured = true;
        const w = CONTROL_WORDS[t.kind].what;
        await beforeAfter(ctx, em, '1.4.11', c.box, c.gone[0]!, `The outlined ${w.slice(w.indexOf(' ') + 1)}${t.name ? ` “${cleanText(t.name, 60)}”` : ''}`);
      }
    }
  });
  const measured = [...results.values()].filter((c) => c.gone !== undefined).length;
  return { found: found.targets.length, measured, ...(cut ? { cut } : {}), items };
}

async function textsPart(ctx: ProbeContext, em: Emulation, until: number): Promise<ForcedResults['texts']> {
  const found = await ctx.page.evaluate(locateForcedTexts, { key: SHOT_KEY, max: FORCED_COLORS_LIMITS.texts, scan: FORCED_COLORS_LIMITS.textScan });
  const byRef = new Map(found.targets.map((t) => [t.ref, t]));
  const items: ForcedTextFailure[] = [];
  let pictured = false;
  // The line boxes less 2 px: the theme's backplate fills them, and their fractional edges are not always covered.
  const { results, cut } = await compareBatches(ctx, em, found.targets.map((t) => t.ref), 'text', -2, until, async (done) => {
    for (const c of done) {
      if (!c.gone?.length) continue;
      const t = byRef.get(c.ref)!;
      items.push({ target: t.path, text: t.text, palettes: c.gone });
      if (!pictured && c.box) {
        pictured = true;
        await beforeAfter(ctx, em, '1.4.3', c.box, c.gone[0]!, `The outlined text${t.text ? ` “${cleanText(t.text, 60)}”` : ''}`);
      }
    }
  });
  const measured = [...results.values()].filter((c) => c.gone !== undefined).length;
  return { found: found.targets.length, measured, ...(cut ? { cut } : {}), items };
}

/**
 * Tabs through the first focus stops (as the keyboard test does, with its in-page kit) and, for each
 * stop whose indicator shows in normal colours, measures it again in the dark palette (a box shadow
 * or a background colour is gone in every palette). Hidden, covered, framed stops and text fields
 * (the text cursor shows focus) are not compared.
 */
async function focusPart(ctx: ProbeContext, em: Emulation, until: number): Promise<ForcedResults['focus']> {
  const page = ctx.page;
  const items: ForcedFocusFailure[] = [];
  if (!page.keyboard) return { stops: 0, compared: 0, items };
  await startKit(ctx);
  let stops = 0;
  let compared = 0;
  let cut = false;
  try {
    await page.evaluate(kitResetStart, undefined);
    let keys: KeyCounts | null = null;
    const seen = new Set<number>();
    for (let i = 0; i < FORCED_COLORS_LIMITS.focusStops; i++) {
      if (Date.now() >= until || ctx.signal.aborted) {
        cut = true;
        break;
      }
      const step = await pressAndMeasure(ctx, 'Tab', keys, false);
      keys = step.keys;
      const s: StopFacts = step.facts;
      if (!s.id || s.frame || seen.has(s.id)) break;
      seen.add(s.id);
      stops++;
      if (s.inner || s.textField || (s.facts && hiddenReason(s.facts)) || (s.grid && obscuredBy(s.grid))) continue;
      const normal = await focusTest(ctx, s, false);
      if (normal?.verdict !== 'visible') continue;
      let forced: Awaited<ReturnType<typeof focusTest>>;
      try {
        await setColours(page, 'dark', em);
        forced = await focusTest(ctx, s, false);
      } finally {
        await setColours(page, null, em);
      }
      if (!forced || forced.verdict === 'unknown') continue;
      compared++;
      if (forced.verdict !== 'none' && forced.verdict !== 'unseen') continue;
      // A recommendation (`forcedColorsFindings`): no before-and-after picture, which the report keeps for failures only.
      items.push({ target: s.path ?? '', name: s.name ?? '', palettes: ['dark'] });
    }
  } finally {
    await page.evaluate(kitStop, undefined).catch(() => {});
  }
  return { stops, compared, ...(cut ? { cut } : {}), items };
}

async function forcedColours(ctx: ProbeContext): Promise<ProbeFinding[]> {
  const page = ctx.page;
  const em: Emulation = { contrast: true };
  // The page really is drawn in each palette (a browser that only answers the media query is not testable).
  const palettes: Partial<Record<Palette, string>> = {};
  try {
    for (const p of PALETTES) {
      await setColours(page, p, em);
      const st = await page.evaluate(forcedState, undefined);
      if (!st.active || !st.applied) throw new ProbeNotTestable('the browser could not show the page in forced colors (a contrast theme)');
      palettes[p] = st.canvas;
    }
  } finally {
    await setColours(page, null, em);
  }
  const t0 = Date.now();
  const end = ctx.deadline - FORCED_COLORS_LIMITS.reserveMs;
  const span = Math.max(0, end - t0);
  const controls = await controlsPart(ctx, em, t0 + span * 0.45);
  const texts = await textsPart(ctx, em, t0 + span * 0.65);
  const focus = await focusPart(ctx, em, end);
  ctx.setData?.({
    forcedColors: {
      palettes, controls: { found: controls.found, measured: controls.measured }, texts: { found: texts.found, measured: texts.measured },
      focus: { stops: focus.stops, compared: focus.compared },
    },
  });
  return forcedColorsFindings({ controls, texts, focus });
}

export const forcedColorsProbe: PageProbe = {
  // Listed, not scored until a gold-standard mutation verifies it (docs/scoring.md).
  scored: false,
  id: 'forced-colors',
  criteria: ['1.4.3', '1.4.11', '2.4.7'],
  // Compares the page in two themes: a page still shifting reads as "moving" (gold hazard layout shift).
  waitFor: { layout: true },
  kind: 'render',
  tier: 'deep',
  // A page of its own: it switches the page's colours and presses Tab.
  isolate: true,
  timeoutMs: 30_000,
  note: 'it compares a sample of controls, texts over pictures and focus stops in a light and a dark contrast theme',
  async run(ctx: ProbeContext): Promise<ProbeFinding[]> {
    if (!ctx.page.emulateMedia) throw new ProbeNotTestable('the browser cannot show the page in forced colors (a contrast theme)');
    const mark = ctx.guard.mark();
    try {
      return guarded(ctx, mark, await forcedColours(ctx));
    } catch (err) {
      return navigationRace(ctx, mark, err);
    }
  },
};
