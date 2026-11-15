// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.12 Text spacing (Plan 4 Task 4.2): applies the WCAG text spacing values and reports text
// that they cut off or make overlap other text. Engine core: no Node-only imports.
import type { ProbeFinding } from '../types.js';
import {
  cutPlaces, describeLayout, dropLayout, LAYOUT_LIMITS, newlyCut, newOverlaps, overlapPlaces, placeFindings, placeRefs, TEXT_SPACING_CSS, textLayout,
  type LayoutElement, type LayoutPlace, type TextLayoutResult,
  excerptFindings, movingFindings, withoutExcerpts,
} from './layout.js';
import { shootElements, timeFor, type ElementHandle } from './evidence.js';
import { frameGapFindings, frameWords, ownFrames } from './frameLayout.js';
import type { PageProbe, ProbeContext } from './types.js';
import { withClipSweep } from './clipSweep.js';

const SPACING = 'line height 1.5, paragraph spacing 2 em, letter spacing 0.12 em, word spacing 0.16 em';

/** Where the spacing cut text off or made it overlap: new problems only, nothing that was already cut off or overlapping. */
export function textSpacingPlaces(res: TextLayoutResult): LayoutPlace[] {
  if (!res.after) return [];
  const cut = newlyCut(res.before, res.after, res.kinds);
  return [...cutPlaces(cut, res.after), ...overlapPlaces(newOverlaps(res.before, res.after, res.kinds))];
}

export const containerSize = (e: LayoutElement | undefined) => (e ? `${e.w}×${e.h} px, overflow ${e.ox === e.oy ? e.ox : `${e.ox} ${e.oy}`}` : 'overflow hidden');

/**
 * Runs in the page (self-contained): applies (`on`) or removes the WCAG spacing as a constructed style
 * sheet kept on the window. Returns true when the sheet is in the state asked for.
 */
export function paintSpacing(arg: { on: boolean; css: string }): boolean {
  const w = window as unknown as { __grntedSpacing?: CSSStyleSheet | HTMLStyleElement };
  const doc = document as Document & { adoptedStyleSheets?: CSSStyleSheet[] };
  if (!arg.on) {
    const had = w.__grntedSpacing;
    if (had instanceof CSSStyleSheet && Array.isArray(doc.adoptedStyleSheets)) doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((x) => x !== had);
    else if (had && 'remove' in had) had.remove();
    delete w.__grntedSpacing;
    return true;
  }
  if (w.__grntedSpacing) return true;
  if (Array.isArray(doc.adoptedStyleSheets) && typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(arg.css);
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
    w.__grntedSpacing = sheet;
    return true;
  }
  const style = document.createElement('style');
  style.textContent = arg.css;
  (document.head ?? document.documentElement).appendChild(style);
  w.__grntedSpacing = style;
  return true;
}

/**
 * Report evidence: the first places the spacing breaks (up to 3), pictured with the spacing painted
 * for that one picture (the test itself measures without painting), the container boxed. The sheet
 * is removed straight after; a page where that cannot be confirmed is not reused by later probes.
 * On the start page, the places are also marked on its first screen (as loaded). Never throws.
 */
async function spacingEvidence(ctx: ProbeContext, places: readonly LayoutPlace[]): Promise<void> {
  const handles: ElementHandle[] = places.slice(0, 3).map((p) => ({ layout: p.el !== undefined ? { el: p.el } : { item: p.items[0]! } }));
  const overlap = places[0]!.kind !== 'cut';
  const alt = (title: string) => `${title ? `The page “${title}”` : 'The page'} with the WCAG text spacing applied: the outlined text ${overlap ? 'runs into other text' : 'is cut off by its box'}.`;
  if (ctx.evidenceHome) await shootElements(ctx, { criterion: '1.4.12', handles, alt, homeOnly: true, align: 'none' });
  if (!ctx.evidence || !(ctx.evidenceWanted?.('1.4.12') ?? false) || !timeFor(ctx, 4000)) return;
  let painted = false;
  try {
    painted = (await ctx.page.evaluate(paintSpacing, { on: true, css: TEXT_SPACING_CSS })) === true;
    if (!painted) return;
    await shootElements(ctx, {
      criterion: '1.4.12', handles, alt,
      caption: overlap ? 'With WCAG text spacing applied, this text overlaps other text' : 'With WCAG text spacing applied, this text is cut off',
    });
  } catch {
    // Evidence never changes the result.
  } finally {
    if (painted) {
      const removed = await ctx.page.evaluate(paintSpacing, { on: false, css: '' }).catch(() => false);
      if (removed !== true) ctx.discardPage?.();
    }
  }
}

const spacingDetail = (res: TextLayoutResult) => (p: LayoutPlace, text: (i: number) => string): string => (p.kind === 'cut'
  ? `With the WCAG text spacing applied (${SPACING}), ${res.kinds[p.items[0]!] === 'b' ? 'a form control' : 'text'} is cut off by its container (${containerSize(p.el !== undefined ? res.after!.els[p.el] : undefined)}): ${text(p.items[0]!)}`
  : `With the WCAG text spacing applied (${SPACING}), text overlaps other text: ${text(p.items[0]!)} runs into ${text(p.items[1]!)}`);

/**
 * The same measurement inside the page's own frames (`ownFrames`): each frame's document gets the WCAG spacing
 * and is measured before and after within one task there. Never throws; a frame that cannot be measured adds nothing.
 */
async function frameSpacing(ctx: ProbeContext): Promise<{ findings: ProbeFinding[]; frames: number }> {
  const out: ProbeFinding[] = [];
  const own = await ownFrames(ctx.page);
  const gaps = [...own.gaps];
  for (const f of own.frames) {
    if (!timeFor(ctx, 3000)) { gaps.push({ path: f.path, why: 'the time for this test ran out first' }); continue; }
    try {
      const res = await f.frame.evaluate(textLayout, { phase: 'start', ...LAYOUT_LIMITS, css: TEXT_SPACING_CSS });
      const places = textSpacingPlaces(res);
      if (!places.length) continue;
      const desc = await f.frame.evaluate(describeLayout, { ...placeRefs(places), drop: true });
      const detail = spacingDetail(res);
      for (const x of placeFindings('1.4.12', places, desc, (p, text) => `${frameWords(f)}${detail(p, text)}`)) {
        out.push({ ...x, target: x.target ? `${f.path} >>> ${x.target}` : f.path });
      }
    } catch {
      // What is in it is then not known.
      gaps.push({ path: f.path, why: 'its content could not be measured' });
    } finally {
      await f.frame.evaluate(dropLayout, undefined).catch(() => {});
    }
  }
  return { findings: [...out, ...frameGapFindings('1.4.12', gaps, 'with the WCAG text spacing')], frames: own.frames.length + gaps.length };
}

/**
 * Measures every text node and control (up to 3000 and 600) on the desktop page, applies the WCAG
 * 1.4.12 spacing as a constructed style sheet, measures again and removes it within one task: the
 * page never paints the change, so the probe needs no page of its own. Text cut off by an
 * ancestor's `overflow: hidden|clip` (more than a quarter of a line's height, or more than half a
 * character's width) or overlapping other text after the change but not before is failed. Text cut
 * off with an ellipsis or line clamp on purpose is not counted. The change and both measurements
 * happen inside one task, so the page's own scripts cannot react and nothing it requests can change
 * the result: the request guard's log does not affect this probe. The page's own embedded frames (same
 * origin) are measured the same way inside (`frameSpacing`).
 */
const spacingOnly: PageProbe = {
  id: 'text-spacing',
  // On every page that loaded (2026-11-10, red-team coverage): it shares the every-page tests' page load and takes well under a second.
  everyPage: true,
  criteria: ['1.4.12'],
  kind: 'render',
  tier: 'core',
  timeoutMs: 20_000,
  // It measures the text the page shows: a page still putting its content in is waited for first (bounded,
  // `LATE_CONTENT_MS`), and on the shared page it runs with the other tests that wait, after the keyboard
  // test (`waitersLater`; fix/late-mount).
  waitFor: { content: true },
  async run(ctx): Promise<ProbeFinding[]> {
    const res = await ctx.page.evaluate(textLayout, { phase: 'start', ...LAYOUT_LIMITS, css: TEXT_SPACING_CSS });
    try {
      // A page with no text of its own may still hold its content in frames from this site.
      if (!res.before.items.some((it, i) => res.kinds[i] === 't' && it.v)) {
        const inFrames = await frameSpacing(ctx);
        return inFrames.frames ? inFrames.findings : [{ criterion: '1.4.12', status: 'not_applicable', detail: 'no visible text on the page' }];
      }
      const sorted = await withoutExcerpts(ctx.page, textSpacingPlaces(res));
      const places = sorted.places;
      const unverified: ProbeFinding[] = [...(await excerptFindings(ctx.page, '1.4.12', sorted.unverified, 'With the WCAG text spacing')), ...movingFindings('1.4.12', res.after, res.kinds, 'With the WCAG text spacing')];
      // The page's own frames too (a document viewer or a form from the same site).
      const framed = (await frameSpacing(ctx)).findings;
      if (!places.length) return [...framed, ...unverified];
      await spacingEvidence(ctx, places);
      const desc = await ctx.page.evaluate(describeLayout, { ...placeRefs(places), drop: true });
      return [...placeFindings('1.4.12', places, desc, spacingDetail(res)), ...framed, ...unverified];
    } finally {
      await ctx.page.evaluate(dropLayout, undefined).catch(() => {});
    }
  },
};

/** Batch 18, D4: the spacing test, with the clip sweep at other desktop widths first (./clipSweep.ts). */
export const textSpacingProbe: PageProbe = withClipSweep(spacingOnly, '1.4.12');
