// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.4 Resize text (Plan 4 Task 4.2): text at 200% must not be cut off, overlap other text or
// push content out of reach, and browser zoom must enlarge it. Engine core: no Node-only imports.
import type { ProbeFinding } from '../types.js';
import {
  cutPlaces, describeLayout, dropLayout, goneShare, groupBy, stoppedSince, LAYOUT_LIMITS, newlyCut, newOverlaps, overlapPlaces, placeFindings, placeRefs,
  excerptFindings, movingFindings, pushedOutOfReach, textLayout, withoutExcerpts,
  type LayoutItem, type LayoutPlace, type LayoutState, type TextLayoutResult,
} from './layout.js';
import { cleanText, layoutTargets, pageWords, scrollWindow, timeFor } from './evidence.js';
import { containerSize } from './textSpacing.js';
import { ProbeNotTestable, type PageProbe, type ProbeContext } from './types.js';
import { axeFailsViewport, pageZoomVerdict } from './metaViewport.js';
import { withClipSweep } from './clipSweep.js';

/** Text whose font size at 200% browser zoom is below this share of its size at 100% is not enlarged (on screen it grows less than 10%). */
export const ZOOM_MIN_RATIO = 0.55;

/** On screen, text within this share of its size at 100% (either way) counts as the same size. */
export const SAME_SIZE_TOLERANCE = 0.1;

/** Batch 19: how much narrower and wider than the zoomed layout (CSS px) the text's size is read again (`stepSized`). */
export const ZOOM_STEP_PX = 40;

/**
 * Batch 19: text whose font size (CSS px) is the same a little narrower and a little wider than the zoomed layout takes
 * its size from the layout at that width (a breakpoint, a clamp() at its bound), not from the window's width (viewport
 * units, F94). Unread sizes are not proof: false.
 */
export function stepSized(atZoom: number | undefined, narrower: number | undefined, wider: number | undefined): boolean {
  if (!atZoom || !narrower || !wider) return false;
  // Viewport units move the size with the width (1.2vw: 7.2, 7.7, 8.2 px at 600, 640, 680): within 0.5% is the same.
  const same = (x: number) => Math.abs(x - atZoom) <= Math.max(0.02, atZoom * 0.005);
  return same(narrower) && same(wider);
}

/**
 * What 200% browser zoom did to text on screen, in plain words, from its CSS font size at 100% (`b`)
 * and at 200% (`z`, on screen × 2): "gets smaller on screen (113 px → 72 px)", "stays the same size on
 * screen (51 px → 51 px)" or "grows only 20% on screen (100 px → 120 px)".
 */
export function zoomSizeWords(b: number, z: number): string {
  const shown = z * 2;
  const sizes = `(${Math.round(b)} px → ${Math.round(shown)} px)`;
  const ratio = shown / b;
  if (ratio < 1 - SAME_SIZE_TOLERANCE - 1e-9) return `gets smaller on screen ${sizes}`;
  if (ratio <= 1 + SAME_SIZE_TOLERANCE + 1e-9) return `stays the same size on screen ${sizes}`;
  return `grows only ${Math.round((ratio - 1) * 100)}% on screen ${sizes}`;
}

/**
 * Problems with the root font size doubled (text-only enlargement): newly cut off text, new overlaps,
 * text and controls pushed out of reach. No longer a failure (2026-11-07): WCAG 1.4.4 is met when the
 * browser's zoom resizes text to 200% (G142), and text-only enlargement made false failures on real
 * sites (overlaps that 200% zoom does not have). Kept for callers that measure it.
 */
export function largeTextPlaces(res: TextLayoutResult): LayoutPlace[] {
  if (!res.after) return [];
  const cut = newlyCut(res.before, res.after, res.kinds);
  const out = pushedOutOfReach(res.before, res.after).filter((i) => !cut.includes(i));
  return [
    ...cutPlaces(cut, res.after),
    ...overlapPlaces(newOverlaps(res.before, res.after, res.kinds)),
    ...[...groupBy(out, (i) => res.after!.items[i]!.wide ?? -1 - i).entries()].map(([wide, items]) => ({ kind: 'reach', ...(wide >= 0 ? { el: wide } : {}), items })),
  ];
}

/**
 * Text that browser zoom does not enlarge (WCAG failure F94, text sized in viewport units): visible
 * at 100% and at 200% zoom, with a font size at 200% (in CSS px) below `ZOOM_MIN_RATIO` of the one
 * at 100%. One place per element.
 */
export function notEnlargedPlaces(base: LayoutState, zoomed: LayoutState, kinds: string): LayoutPlace[] {
  const hits: number[] = [];
  zoomed.items.forEach((z, i) => {
    const b = base.items[i];
    if (kinds[i] !== 't' || !b?.v || !z.v || b.cut === 2 || z.cut === 2 || !b.fs || !z.fs) return;
    // The size it is drawn at (round 2): a page that scales its design to the window undoes the zoom. Moving text
    // (an animated scale) is not judged by its scale.
    const moving = b.mv === 2 || z.mv === 2;
    const drawn = (it: LayoutItem) => it.fs * (moving ? 1 : it.sc ?? 1);
    if (drawn(z) / drawn(b) < ZOOM_MIN_RATIO) hits.push(i);
  });
  return hits.map((i) => ({ kind: 'zoom', items: [i] }));
}

/**
 * Whole lines of text that 200% browser zoom hides inside a box still shown (the box keeps its size in the
 * viewport, e.g. a height in vh, and clips its overflow): text in flow, wholly shown at 100%, wholly cut off at
 * 200% by an ancestor that clips it and is itself at least a line tall there. Not counted: a box that closes to
 * nothing (a collapsed menu or panel), carousels, an ellipsis or line clamp on purpose, and positioned content.
 */
export function vanishedLines(base: LayoutState, zoomed: LayoutState, kinds: string, skip: (it: LayoutItem, i: number) => boolean, scrollable?: number[]): number[] {
  const out: number[] = [];
  zoomed.items.forEach((a, i) => {
    const b = base.items[i];
    if (kinds[i] !== 't' || !b?.v || !a.v || b.cut !== 0 || a.cut !== 2 || a.by === undefined || a.pos || b.pos || a.mv === 2 || b.mv === 2) return;
    const by = zoomed.els[a.by];
    if (!by || by.truncates || by.carousel || by.w < 8 || by.h < Math.max(8, a.fs || 0) || skip(a, i)) return;
    // A box with controls of its own (or beside it) may scroll its lines into view: never a failure (lead's ruling).
    if (by.ctl) { scrollable?.push(i); return; }
    out.push(i);
  });
  return out;
}

/**
 * Problems at 200% browser zoom (the layout at half the viewport) compared with 100%: text (or a
 * control without text) partly cut off by its container, new overlaps, content pushed out of the
 * part of the page that can be reached, and text that does not get larger. Carousels are not counted
 * for cut-off text; items already reported by the first pass (`reported`) are left out.
 */
export function zoomPlaces(base: LayoutState, zoomed: LayoutState, kinds: string, reported: ReadonlySet<number>, scrollable?: number[]): LayoutPlace[] {
  const skip = (it: LayoutState['items'][number], i: number) => reported.has(i) || (it.by !== undefined && !!zoomed.els[it.by]?.carousel);
  const cut = [...newlyCut(base, zoomed, kinds, { partialOnly: true, skip }), ...vanishedLines(base, zoomed, kinds, skip, scrollable)];
  const overlaps = newOverlaps(base, zoomed, kinds).filter(([i, j]) => !reported.has(i) && !reported.has(j));
  const out = pushedOutOfReach(base, zoomed).filter((i) => !reported.has(i) && !cut.includes(i));
  return [
    ...cutPlaces(cut, zoomed, 'zcut'),
    ...overlapPlaces(overlaps, 'zoverlap'),
    ...[...groupBy(out, (i) => zoomed.items[i]!.wide ?? -1 - i).entries()].map(([wide, items]) => ({ kind: 'zreach', ...(wide >= 0 ? { el: wide } : {}), items })),
    ...notEnlargedPlaces(base, zoomed, kinds).filter((p) => !reported.has(p.items[0]!)),
  ];
}

/**
 * Report v2 evidence for the first text that browser zoom does not enlarge: the page at 100% and at
 * 200% (laid out at `half` the viewport again, as the test does), the text boxed and labelled with its
 * font size on screen (at 200%, CSS px × 2). Needs an evidence sink and the time; never throws, and
 * puts the viewport and the scroll position back.
 */
async function zoomEvidence(ctx: ProbeContext, places: LayoutPlace[], res: TextLayoutResult, zoomed: LayoutState | undefined, half: { width: number; height: number }): Promise<void> {
  const page = ctx.page;
  if (!ctx.evidence || !zoomed || !page.setViewportSize || !timeFor(ctx, 5000)) return;
  const i = places.find((p) => p.kind === 'zoom')?.items[0];
  if (i === undefined) return;
  const b = res.before.items[i]?.fs;
  const z = zoomed.items[i]?.fs;
  if (!b || !z) return;
  let back: { x: number; y: number } | undefined;
  try {
    const at100 = await page.evaluate(layoutTargets, { targets: [{ item: i }], align: 'center' });
    back = { x: at100.sx, y: at100.sy };
    const box = at100.boxes[0];
    if (!box) return;
    const text = cleanText(at100.texts[0], 60);
    const quoted = text ? ` “${text}”` : '';
    const ok = await ctx.evidence({
      criterion: '1.4.4', boxes: [{ ...box, kind: 'fail', label: `${Math.round(b)} px` }],
      alt: `${pageWords(at100.title)} at 100% browser zoom: the text${quoted} has a font size of ${Math.round(b)} px on screen.`,
      group: 'zoom', groupLabel: 'Browser zoom 100%',
    });
    if (!ok || !timeFor(ctx, 3000)) return;
    const { width, height } = ctx.viewport;
    try {
      await page.setViewportSize(half);
      await page.waitForTimeout(400);
      const at200 = await page.evaluate(layoutTargets, { targets: [{ item: i }], align: 'center' });
      const box200 = at200.boxes[0];
      if (box200) {
        await ctx.evidence({
          criterion: '1.4.4', boxes: [{ ...box200, kind: 'fail', label: `${Math.round(z * 2)} px` }],
          alt: `The same page at 200% browser zoom: the text${quoted} ${zoomSizeWords(b, z)}, so zooming did not make it larger.`,
          group: 'zoom', groupLabel: 'Browser zoom 200%',
        });
      }
    } finally {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(200);
    }
  } catch {
    // Evidence never changes the result.
  } finally {
    if (back) await page.evaluate(scrollWindow, back).catch(() => {});
  }
}

/** Share of the page's text a script replaced at the zoomed width above which the zoom comparison cannot be made. */
export const ZOOM_REPLACED_SHARE = 0.5;

/**
 * Browser zoom at 200% on the desktop page (WCAG G142: the browser's zoom is the resize mechanism): the
 * page laid out at half the viewport (640×450 CSS px, what a 1280×900 window shows at 200% zoom), then
 * the viewport restored. Text whose CSS font size halves or more (on screen, CSS px × 2, it stays the
 * same size or gets smaller: viewport units, WCAG failure F94) is failed; so is text partly cut off (or whole lines cut
 * off in a box still shown, `vanishedLines`),
 * overlapping or pushed out of reach there that was fine at 100% (text already cut off at 100% is not
 * a resize failure). A closed off-canvas menu that replaces the navigation is not counted. Text-only
 * enlargement (the root font size doubled) is no longer tested (2026-11-07 real-site audit: 3 false
 * overlaps at 1280 px that 200% zoom does not have).
 * Zoom being turned off in `<meta name="viewport">` is the axe rule `meta-viewport`; the values that rule does
 * not read as the browser does are read here (`viewportFindings`, which reads the viewport setting the way browsers
 * do, written from the W3C drafts and observed behaviour). When the page
 * goes to another address during the test the result is not_testable; so is a clean result after
 * the guard blocked a request, or when a script replaced most of the text at the zoomed width.
 */
const zoomLayoutOnly: PageProbe = {
  id: 'resize-text',
  // On every page that loaded (2026-11-10, red-team coverage): it shares the every-page tests' page load and takes well under a second.
  everyPage: true,
  criteria: ['1.4.4'],
  kind: 'render',
  tier: 'core',
  // An app that mounts its content late is measured with it, never as an empty shell.
  waitFor: { content: true },
  timeoutMs: 20_000,
  async run(ctx): Promise<ProbeFinding[]> {
    const page = ctx.page;
    const mark = ctx.guard.mark();
    const res = await page.evaluate(textLayout, { phase: 'start', ...LAYOUT_LIMITS });
    try {
      if (!res.before.items.some((it, i) => res.kinds[i] === 't' && it.v)) {
        return [{ criterion: '1.4.4', status: 'not_applicable', detail: 'no visible text on the page' }];
      }
      const places: LayoutPlace[] = [];
      const half = { width: Math.round(ctx.viewport.width / 2), height: Math.round(ctx.viewport.height / 2) };
      let zoomed: LayoutState | undefined;
      let untested: string | undefined;
      /** Cut-off excerpts whose "read more" control could not be verified to give the full text: not testable, never exempt. */
      let unverified: ProbeFinding[] = [];
      /** Whole lines hidden in a box whose own controls may scroll them into view (not a failure; may leave it untested). */
      const scrollable: number[] = [];
      if (page.setViewportSize) {
        const { width, height } = ctx.viewport;
        try {
          await page.setViewportSize(half);
          await page.waitForTimeout(400);
          zoomed = (await page.evaluate(textLayout, { phase: 'again', ...LAYOUT_LIMITS })).before;
        } finally {
          await page.setViewportSize({ width, height });
          await page.waitForTimeout(200);
        }
        if (goneShare(res.before, zoomed, res.kinds) > ZOOM_REPLACED_SHARE) {
          untested = 'a script replaced most of the page\'s text when the window was resized, so the 200% browser zoom comparison could not be made';
        } else {
          // Once per container: a container the first pass reported is not reported again for zoom.
          const els = new Set(places.flatMap((p) => (p.el !== undefined ? [p.el] : [])));
          const sorted = await withoutExcerpts(page, zoomPlaces(res.before, zoomed, res.kinds, new Set(places.flatMap((p) => p.items)), scrollable).filter((p) => p.el === undefined || !els.has(p.el)));
          places.push(...sorted.places);
          // Batch 19 (precision lane, real-site dev split): text that zoom does not enlarge fails as F94 ("incorrect use
          // of viewport units") when its size follows the window's width. Text whose size is the same a little narrower
          // and a little wider than the zoomed width takes it from the layout at that width (a breakpoint's type scale,
          // a clamp() at its bound): whether that keeps 1.4.4 is for a person to check (`zoomStep`), never failed.
          const zoomHits = places.filter((p) => p.kind === 'zoom');
          if (zoomHits.length) {
            const { width, height } = ctx.viewport;
            const sizesAt = async (w: number): Promise<LayoutState | undefined> => {
              try {
                await page.setViewportSize!({ width: w, height: half.height });
                await page.waitForTimeout(250);
                return (await page.evaluate(textLayout, { phase: 'again', ...LAYOUT_LIMITS })).before;
              } catch { return undefined; }
            };
            try {
              const narrower = await sizesAt(Math.max(320, half.width - ZOOM_STEP_PX));
              const wider = await sizesAt(half.width + ZOOM_STEP_PX);
              for (const p of zoomHits) {
                const i = p.items[0]!;
                if (stepSized(zoomed.items[i]?.fs, narrower?.items[i]?.fs, wider?.items[i]?.fs)) p.kind = 'zoomStep';
              }
            } finally {
              await page.setViewportSize({ width, height });
              await page.waitForTimeout(200);
            }
          }
          unverified = [
            ...(await excerptFindings(page, '1.4.4', sorted.unverified, `At 200% browser zoom (the page laid out at ${half.width}×${half.height} px)`)),
            ...movingFindings('1.4.4', zoomed, res.kinds, `At 200% browser zoom (the page laid out at ${half.width}×${half.height} px)`),
          ];
          if (scrollable.length && !untested) untested = 'at 200% browser zoom some lines are hidden in a box that has controls of its own, which may scroll them into view; whether every line can still be reached was not tested';
        }
      } else {
        untested = 'the browser cannot change the viewport size, so 200% browser zoom could not be tested';
      }
      const stopped = stoppedSince(ctx.guard, mark);
      if (stopped?.navigation) throw new ProbeNotTestable(stopped.reason);
      if (!places.length) {
        const why = stopped?.reason ?? untested;
        if (why) throw new ProbeNotTestable(why);
        return unverified;
      }
      // Pictures first: they need the tracked nodes, which describing the places drops.
      await zoomEvidence(ctx, places, res, zoomed, half);
      const desc = await page.evaluate(describeLayout, { ...placeRefs(places), drop: true });
      const atZoom = `At 200% browser zoom (the page laid out at ${half.width}×${half.height} px)`;
      const what = (i: number) => (res.kinds[i] === 'b' ? 'a form control' : 'text');
      const findings = [...placeFindings('1.4.4', places, desc, (p, text) => {
        const i = p.items[0]!;
        const at = atZoom;
        const els = zoomed!.els;
        if (p.kind === 'cut' || p.kind === 'zcut') return `${at}, ${what(i)} is cut off by its container (${containerSize(p.el !== undefined ? els[p.el] : undefined)}): ${text(i)}`;
        if (p.kind === 'overlap' || p.kind === 'zoverlap') return `${at}, text overlaps other text: ${text(i)} runs into ${text(p.items[1]!)}`;
        if (p.kind === 'reach' || p.kind === 'zreach') return `${at}, content is pushed off the side of the page where it cannot be scrolled to: ${text(i)}`;
        const b = res.before.items[i]!.fs;
        const z = zoomed?.items[i]?.fs ?? 0;
        if (p.kind === 'zoomStep') return `${atZoom}, this text ${zoomSizeWords(b, z)}: ${text(i)}. Its size comes from the page's layout at that width (it is the same a little narrower and wider), not from viewport units: whether that keeps text resizable to 200% is for a person to check`;
        return `${atZoom}, this text ${zoomSizeWords(b, z)}: ${text(i)}`;
      })];
      // A size the layout sets at the zoomed width (`zoomStep`): for a person to check, never failed.
      const steps = new Set(places.slice(0, findings.length).map((p, k) => (p.kind === 'zoomStep' ? k : -1)).filter((k) => k >= 0));
      return [...findings.map((f, k) => (steps.has(k) ? { ...f, status: 'flagged' as const } : f)), ...unverified];
    } finally {
      await page.evaluate(dropLayout, undefined).catch(() => {});
    }
  },
};

/** Batch 18, D4: the zoom test, with the clip sweep across window widths first (./clipSweep.ts). */
const zoomLayoutProbe: PageProbe = withClipSweep(zoomLayoutOnly, '1.4.4');

/** Runs in the page: the content of every `<meta name="viewport">` that has one, in document order. */
export function viewportContents(): string[] {
  return [...document.querySelectorAll('meta[name="viewport" i]')].map((m) => m.getAttribute('content')).filter((c): c is string => c !== null);
}

/**
 * The viewport setting read the way browsers read it (`./metaViewport.ts`, written from the W3C drafts and observed
 * behaviour): a failure when it turns pinch zoom off or holds it under 200% (WCAG 1.4.4; ACT rule b4f0c3) and the
 * axe rule `meta-viewport`, which reads the setting its own way, does not report it (never both); not_testable when
 * the reader cannot be sure how the browser reads it and axe has no failure either.
 */
export function viewportFindings(contents: readonly string[]): ProbeFinding[] {
  if (contents.some(axeFailsViewport)) return [];
  const v = pageZoomVerdict(contents);
  if (v.kind === 'allowed') return [];
  if (v.kind === 'unknown') return [{ criterion: '1.4.4', status: 'not_testable', target: 'meta[name="viewport"]', detail: `Whether the page lets a phone zoom to 200% could not be told: ${v.why}` }];
  return [{ criterion: '1.4.4', status: 'failed', target: 'meta[name="viewport"]', detail: `The page turns zoom off on phones: its viewport setting has ${v.property}=${v.value || '(no value)'}, ${v.reads}` }];
}

/**
 * The zoom test above, and first the viewport setting (`viewportFindings`): a failure there stands whatever the
 * layout test then finds or cannot test, and a setting that could not be read leaves the page undecided unless
 * the layout test fails it.
 */
export const resizeTextProbe: PageProbe = {
  ...zoomLayoutProbe,
  async run(ctx): Promise<ProbeFinding[]> {
    const contents = await ctx.page.evaluate(viewportContents, undefined).catch(() => null);
    const setting = contents === null
      ? [{ criterion: '1.4.4', status: 'not_testable' as const, target: 'meta[name="viewport"]', detail: 'Whether the page lets a phone zoom to 200% could not be told: its viewport setting could not be read' }]
      : viewportFindings(contents);
    if (!setting.length) return zoomLayoutProbe.run(ctx);
    const failed = setting.filter((f) => f.status === 'failed');
    if (failed.length) ctx.keep?.(failed);
    try {
      const layout = await zoomLayoutProbe.run(ctx);
      // With a failure, only failures are added; with an undecided setting, the layout's result stands beside it.
      return failed.length ? [...failed, ...layout.filter((f) => f.status === 'failed')] : [...layout.filter((f) => f.status !== 'not_applicable' && f.status !== 'no_failures_found'), ...setting];
    } catch (err) {
      if (err instanceof ProbeNotTestable) return failed.length ? failed : setting;
      throw err;
    }
  },
};
