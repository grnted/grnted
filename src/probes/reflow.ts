// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.10 Reflow (Plan 4 Task 4.2): at 320 CSS px wide (1280 px at 400% zoom) content must fit
// without scrolling sideways, without being cut off and without overlapping. Engine core: no
// Node-only imports.
import type { ProbeFinding } from '../types.js';
import {
  cutPlaces, describeLayout, dropLayout, fixedOverflow, goneShare, groupBy, stoppedSince, LAYOUT_LIMITS, MAX_PLACES, newlyCut, newOverlapPlaces, placeFindings,
  placeRefs, reachableWidth, textLayout,
  type LayoutDescription, type LayoutItem, type LayoutPlace, type LayoutState, type TextLayoutResult,
  excerptFindings, movingFindings, withoutExcerpts,
} from './layout.js';
import { layoutTargets, pageWords, scrollWindow, timeFor } from './evidence.js';
import { frameGapFindings, frameWords, ownFrames } from './frameLayout.js';
import { containerSize } from './textSpacing.js';
import { asideData, discoveryDetails, multiplePopups, findPopups, incomplete, INCOMPLETE, notAside, setPopupAside, stoppedBetween, timeForAside, type PopupAside } from './popupAside.js';
import { ProbeNotTestable, type PageProbe, type ProbeContext } from './types.js';
import { dropProse, keepProse, LOST_EXCLUDED, LOST_KEY, LOST_LIMITS, lostFindings, lostProse, wideText, type WideText } from './lostAtNarrow.js';

/** Neutral evidence for the AI review: prose 320 px removes while a control may show it, with that section's picture. */
export interface NarrowShot { path: string; text: string; controls: string[]; width: number; picture: Uint8Array }

/** Runs in the page: scrolls the section around the hidden block (its parent) into view; its clip in the viewport. */
export function sectionClip(hiddenPath: string): { x: number; y: number; width: number; height: number } | null {
  const hidden = document.querySelector(hiddenPath);
  const sec = hidden?.parentElement;
  if (!sec) return null;
  sec.scrollIntoView({ block: 'start' });
  const r = sec.getBoundingClientRect();
  const x = Math.max(0, r.left), y = Math.max(0, r.top);
  const width = Math.min(innerWidth - x, r.width), height = Math.min(innerHeight - y, r.height, 900);
  return width >= 8 && height >= 8 ? { x, y, width, height } : null;
}

/** WCAG 1.4.10: vertically scrolling content at 320 CSS px wide; horizontally scrolling content (vertical writing) at 256 CSS px high. */
export const REFLOW_VIEWPORT = { width: 320, height: 256 } as const;
export const REFLOW_VERTICAL_VIEWPORT = { width: 1280, height: 256 } as const;

/** Words for reflow's exceptions (`LayoutItem.ex`), as shown in the notes. */
export const REFLOW_EXCEPTIONS: Record<string, string> = {
  table: 'data tables', code: 'code blocks', media: 'images, video, maps, diagrams and other media', toolbar: 'toolbars',
  app: 'applications and grids', scroll: 'content in its own sideways-scrolling region',
};

/**
 * Text (and controls without text) at the narrow width that reaches past the left or right edge of
 * the viewport: it needs scrolling sideways, or is cut off at the edge when the page cannot scroll.
 * Not counted: the exceptions; content entirely off the left edge (skip links: nobody can scroll
 * there); and content positioned or transformed entirely past the right edge (a closed off-canvas
 * menu) unless the page scrolls sideways onto it. Content in the normal flow entirely past the right
 * edge counts: where the page cannot scroll, it is lost.
 */
export function beyondEdge(narrow: LayoutState, kinds: string): number[] {
  const w = narrow.view.w;
  const reach = reachableWidth(narrow.view);
  const out: number[] = [];
  narrow.items.forEach((it, i) => {
    if ((kinds[i] !== 't' && kinds[i] !== 'b') || !it.v || it.cut === 2 || it.ex) return;
    let right = -Infinity;
    let left = Infinity;
    for (let k = 0; k + 3 < it.r.length; k += 4) {
      left = Math.min(left, it.r[k]!);
      right = Math.max(right, it.r[k]! + it.r[k + 2]!);
    }
    const offRight = right > w + 1;
    const offLeft = left < -1;
    if (!offRight && !offLeft) return;
    const straddles = left < w && right > 0;
    if (!straddles) {
      if (right <= 0) return;
      if (it.pos && !(narrow.view.canScrollX && left < reach - 1)) return;
    }
    out.push(i);
  });
  return out;
}

const skipReflow = (narrow: LayoutState) => (it: LayoutItem) => !!it.ex || (it.by !== undefined && !!narrow.els[it.by]?.carousel);

/** Places for content past the edge, one per outermost too-wide container. */
export function widePlaces(beyond: readonly number[], narrow: LayoutState): LayoutPlace[] {
  return [...groupBy(beyond, (i) => narrow.items[i]!.wide ?? -1 - i).entries()].map(([wide, items]) => ({ kind: 'wide', ...(wide >= 0 ? { el: wide } : {}), items }));
}

/**
 * Lines of text wider than the sideways-scrolling region they sit in (`LayoutItem.hw`): reading them
 * means scrolling that region sideways. Not counted: the exceptions (tables, code, media, toolbars…)
 * and carousels (a slide that scrolls into view is not a line scrolled to read it), unless the text wraps: wrapped
 * lines wider than the region are read by scrolling sideways line by line, whatever the region is called (batch 18
 * round 3: a box named like a slider or a scroller held prose columns wider than itself).
 */
export function scrollingLines(narrow: LayoutState, kinds: string, not: ReadonlySet<number> = new Set()): number[] {
  const out: number[] = [];
  narrow.items.forEach((it, i) => {
    if (kinds[i] !== 't' || !it.v || it.cut === 2 || it.hw === undefined || not.has(i)) return;
    if (it.ex && it.ex !== 'scroll') return;
    if (narrow.els[it.hw]?.carousel && !it.wl) return;
    out.push(i);
  });
  return out;
}

/** Every reflow problem at the narrow width, compared with the desktop layout for cut-off text and overlaps. */
export function reflowPlaces(base: LayoutState, narrow: LayoutState, kinds: string): LayoutPlace[] {
  const beyond = beyondEdge(narrow, kinds);
  const skip = skipReflow(narrow);
  const cut = newlyCut(base, narrow, kinds, { partialOnly: true, skip }).filter((i) => !beyond.includes(i));
  const lines = scrollingLines(narrow, kinds, new Set([...beyond, ...cut]));
  return [
    ...widePlaces(beyond, narrow),
    ...cutPlaces(cut, narrow),
    ...newOverlapPlaces(base, narrow, kinds, skip),
    ...[...groupBy(lines, (i) => narrow.items[i]!.hw!).entries()].map(([el, items]) => ({ kind: 'hscroll', el, items })),
    ...fixedOverflow(narrow, kinds, new Set([...beyond, ...cut])),
  ];
}

/** Places found on a fresh measurement at the narrow width (no desktop layout to compare with): content past the edge, lines that scroll, fixed boxes that overflow. */
export function freshReflowPlaces(narrow: LayoutState, kinds: string): LayoutPlace[] {
  const beyond = beyondEdge(narrow, kinds);
  const lines = scrollingLines(narrow, kinds, new Set(beyond));
  return [
    ...widePlaces(beyond, narrow),
    ...[...groupBy(lines, (i) => narrow.items[i]!.hw!).entries()].map(([el, items]) => ({ kind: 'hscroll', el, items })),
    ...fixedOverflow(narrow, kinds, new Set(beyond)),
  ];
}

/** Share of the desktop page's text that a script replaced at the narrow width before the probe measures afresh there. */
export const REPLACED_SHARE = 0.2;

const AT = `At ${REFLOW_VIEWPORT.width} px wide`;

/** Finding text for a reflow place, measured in `narrow`. */
export function reflowDetail(narrow: LayoutState, kinds: string) {
  return (p: LayoutPlace, text: (i: number) => string): string => {
    const i = p.items[0]!;
    const el = p.el !== undefined ? narrow.els[p.el] : undefined;
    if (p.kind === 'wide') {
      const pageWide = narrow.view.scrollW > narrow.view.w + 1 ? ` (the page is ${narrow.view.scrollW} px wide)` : '';
      const scrolls = narrow.view.canScrollX && reachableWidth(narrow.view) > narrow.view.w + 1;
      const how = scrolls ? `needs scrolling sideways${pageWide}` : 'is cut off at the edge of the screen (the page cannot scroll sideways)';
      const tooWide = el && el.w > narrow.view.w + 1;
      if (kinds[i] === 'b') return `${AT}, ${tooWide ? `a ${el.w} px wide form control does not fit` : 'a form control does not fit in its container'} and ${how}: ${text(i)}`;
      return `${AT}, ${tooWide ? `a ${el.w} px wide container does not fit` : 'content does not fit in its container'} and its text ${how}: ${text(i)}`;
    }
    if (p.kind === 'cut') return `${AT}, ${kinds[i] === 'b' ? 'a form control' : 'text'} is cut off by its container (${containerSize(el)}): ${text(i)}`;
    if (p.kind === 'fixed') return `${AT}, a box fixed to the screen runs past its ${narrow.view.h} px height, so this ${kinds[i] === 'b' ? 'form control' : 'text'} cannot be scrolled to: ${text(i)}`;
    if (p.kind === 'hscroll') return `${AT}, a line of text is wider than the region it scrolls in (${el?.w ?? '?'} px wide), so reading it means scrolling sideways: ${text(i)}`;
    return `${AT}, text overlaps other text: ${text(i)} runs into ${text(p.items[1]!)}`;
  };
}

/** Most boxes in the reflow evidence image. */
const REFLOW_SHOT_BOXES = 3;

/**
 * Report v2 evidence, taken at the narrow width: the window scrolled to the first content that does
 * not fit (content past the edge, lines that scroll sideways), with up to 3 of them boxed (the too-wide
 * container when known). `state` and `places` must be of the layout the page tracks now. Needs an
 * evidence sink and the time; never throws, and puts the scroll position back.
 */
async function reflowEvidence(ctx: ProbeContext, state: LayoutState, places: LayoutPlace[]): Promise<void> {
  if (!ctx.evidence || !timeFor(ctx, 3000)) return;
  const wide = places.filter((p) => p.kind === 'wide' || p.kind === 'hscroll').slice(0, REFLOW_SHOT_BOXES);
  if (!wide.length) return;
  let back: { x: number; y: number } | undefined;
  try {
    const t = await ctx.page.evaluate(layoutTargets, { targets: wide.map((p) => (p.el !== undefined ? { el: p.el } : { item: p.items[0]! })), align: 'top' });
    back = { x: t.sx, y: t.sy };
    const boxes = t.boxes.flatMap((b, k) => {
      if (!b) return [];
      const el = wide[k]!.el !== undefined ? state.els[wide[k]!.el!] : undefined;
      return [{ ...b, kind: 'fail' as const, ...(el && el.w > state.view.w + 1 ? { label: `${Math.round(el.w)} px wide` } : {}) }];
    });
    if (!boxes.length) return;
    const scrolls = state.view.canScrollX && reachableWidth(state.view) > state.view.w + 1;
    await ctx.evidence({
      criterion: '1.4.10', boxes, caption: scrolls ? `Needs scrolling sideways at ${REFLOW_VIEWPORT.width} px wide` : `Cut off at ${REFLOW_VIEWPORT.width} px wide`,
      alt: `${pageWords(t.title)} in a window ${REFLOW_VIEWPORT.width} px wide: the outlined content does not fit and runs off the side of the screen.`,
    });
  } catch {
    // Evidence never changes the result.
  } finally {
    if (back) await ctx.page.evaluate(scrollWindow, back).catch(() => {});
  }
}

/**
 * Reflow inside the page's own frames (`ownFrames`), measured while the page is laid out at 320 px: each frame's
 * document is measured afresh at the width the frame then has (content past its edge, lines that scroll,
 * fixed boxes that overflow; the same exceptions). A frame is no exception for ordinary prose inside it.
 * Never throws; a frame that cannot be measured adds nothing.
 */
async function frameReflow(ctx: ProbeContext, left: number): Promise<ProbeFinding[]> {
  const out: ProbeFinding[] = [];
  const own = await ownFrames(ctx.page);
  const gaps = [...own.gaps];
  for (const f of own.frames) {
    if (out.length >= left) break;
    if (!timeFor(ctx, 3000)) { gaps.push({ path: f.path, why: 'the time for this test ran out first' }); continue; }
    try {
      const res = await f.frame.evaluate(textLayout, { phase: 'start', ...LAYOUT_LIMITS });
      const places = freshReflowPlaces(res.before, res.kinds);
      if (!places.length) continue;
      const desc = await f.frame.evaluate(describeLayout, { ...placeRefs(places), drop: true });
      const detail = reflowDetail(res.before, res.kinds);
      for (const x of placeFindings('1.4.10', places, desc, (p, text) => `${frameWords(f)}${detail(p, text)}`, Math.max(1, left - out.length))) {
        out.push({ ...x, ...(x.target ? { target: `${f.path} >>> ${x.target}` } : { target: f.path }) });
      }
    } catch {
      // What is in it is then not known.
      gaps.push({ path: f.path, why: 'its content could not be measured' });
    } finally {
      await f.frame.evaluate(dropLayout, undefined).catch(() => {});
    }
  }
  return [...out, ...frameGapFindings('1.4.10', gaps, 'at 320 px wide')];
}

/** Runs in the page (self-contained): the writing mode and the page's scroll size. */
function writingFacts(): { vertical: boolean; w: number; h: number; sw: number; sh: number } {
  const el = document.body ?? document.documentElement;
  const root = document.documentElement;
  return {
    vertical: getComputedStyle(el).writingMode.startsWith('vertical') || getComputedStyle(el).writingMode.startsWith('sideways'),
    w: root.clientWidth, h: root.clientHeight, sw: root.scrollWidth, sh: root.scrollHeight,
  };
}

/**
 * Lays the desktop page out at 320×256 CSS px (`setViewportSize`, as zooming to 400% does), compares
 * it with the desktop layout, and restores the viewport. Failed:
 * - text, or a form control without text, that reaches past the edge of the viewport (needs
 *   sideways scrolling, or is cut off where the page cannot scroll), reported at the outermost
 *   container wider than the viewport;
 * - text cut off by its container at 320 px that was not cut off on the desktop (partly cut: text
 *   hidden entirely, like closed menus and other slides, is not counted);
 * - text overlapping other text at 320 px that did not on the desktop;
 * - a line of text wider than the sideways-scrolling region it sits in;
 * - content in a box fixed to the screen (a cookie banner, a header) that runs past the top or bottom
 *   of the 256 px high viewport, where it cannot be scrolled to.
 * WCAG exceptions are not counted: data tables, code blocks (`pre`, `code`), images, video, maps,
 * diagrams and other media (`svg`, `canvas`, `iframe`, `role=img`…), toolbars, applications and grids,
 * and carousels. The page's own embedded frames (same origin) are measured inside too, at the width they
 * have then (`frameReflow`). Pages written vertically are also laid out at 1280×256: scrolling in both directions
 * there is failed. When a script replaced more than a fifth of the page's text at 320 px, what it shows
 * there is also measured afresh (content past the edge, lines that scroll), so a re-rendered page is
 * never reported clean unmeasured. When the page tried to go to another address during the test (a
 * mobile site), the result is not_testable; so is a clean result after the guard blocked a request.
 */
export const reflowProbe: PageProbe = {
  id: 'reflow',
  // On every page that loaded (2026-11-10, red-team coverage): it shares the every-page tests' page load and takes well under a second.
  everyPage: true,
  criteria: ['1.4.10'],
  kind: 'render',
  tier: 'core',
  timeoutMs: 20_000,
  // It lays out the content the page shows: a page still putting its content in is waited for first (bounded,
  // `LATE_CONTENT_MS`), and on the shared page it runs with the other tests that wait, after the keyboard
  // test (`waitersLater`; fix/late-mount).
  waitFor: { content: true },
  async run(ctx): Promise<ProbeFinding[]> {
    if (!ctx.page.setViewportSize) throw new ProbeNotTestable('the browser cannot change the viewport size, which this test needs');
    const mark = ctx.guard.mark();
    // Page-load pop-ups (popupAside.ts): discover and dismiss, then measure the cleared page.
    const found = await findPopups(ctx);
    if (found.boxes.length > 1) return multiplePopups(ctx, found, '1.4.10');
    if (!found.box) {
      const look = await reflowLook(ctx);
      if (!look) return discoveryDetails(ctx, found, [{ criterion: '1.4.10', status: 'not_applicable', detail: 'no visible text on the page' }]);
      return discoveryDetails(ctx, found, notClean(reflowResult(ctx, [{ from: mark }], look.findings), look.truncated));
    }
    const single = { boxes: found.boxes, box: found.box };
    // Look 1 only discovers the box and its dismissal. Lay out only the cleared page at 320 px.
    const windows: { from: number; to?: number }[] = [{ from: mark, to: ctx.guard.mark() }];
    const t1 = Date.now();
    const aside: PopupAside = timeForAside(ctx, 0)
      ? await setPopupAside(ctx, single)
      : notAside(ctx, single, INCOMPLETE.unfinished);
    let findings: ProbeFinding[];
    let truncated = false;
    if (!aside.dismissed) findings = incomplete('1.4.10', aside.why ?? INCOMPLETE.stayed);
    else {
      windows.push({ from: aside.mark });
      try {
        const two = await reflowLook(ctx);
        if (!two) findings = [{ criterion: '1.4.10', status: 'not_applicable', detail: 'no visible text on the page' }];
        else {
          findings = two.findings;
          truncated = two.truncated;
        }
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        findings = incomplete('1.4.10', INCOMPLETE.unfinished);
      }
    }
    ctx.setData?.(asideData(aside, Date.now() - t1));
    return notClean(reflowResult(ctx, windows, findings), truncated);
  },
};

/**
 * The findings, unless the request guard stopped something in the windows they rest on (`to` undefined: up to now): a
 * held navigation makes the page unmeasured; a blocked request makes a clean result not testable.
 */
function reflowResult(ctx: ProbeContext, windows: readonly { from: number; to?: number }[], findings: ProbeFinding[]): ProbeFinding[] {
  const stops = windows.map((w) => (w.to === undefined ? stoppedSince(ctx.guard, w.from) : stoppedBetween(ctx.guard, w.from, w.to))).filter((x) => !!x);
  const stopped = stops.find((x) => x.navigation) ?? stops[0];
  if (stopped?.navigation) throw new ProbeNotTestable(stopped.reason);
  if (stopped && !findings.length) throw new ProbeNotTestable(stopped.reason);
  return findings;
}

/** A look that read only part of the page's text or controls (the caps) never makes the page clean: not testable. */
function notClean(findings: ProbeFinding[], truncated: boolean): ProbeFinding[] {
  if (!truncated || findings.some((f) => f.status === 'failed' || f.status === 'not_testable')) return findings;
  return [{
    criterion: '1.4.10', status: 'not_testable',
    detail: `the page has more text or controls than the test reads (${LAYOUT_LIMITS.maxText} pieces of text, ${LAYOUT_LIMITS.maxControls} controls): it was not all laid out at ${REFLOW_VIEWPORT.width} px`,
  }];
}

/**
 * One look at the page: lays it out at 320x256, compares it with the desktop layout (see `reflowProbe`), restores the
 * viewport, and returns the failures (at most `MAX_PLACES` places of each layout, worded at that cap) and whether the
 * layout read only part of the page (the caps); null when the page has no visible text.
 */
async function reflowLook(ctx: ProbeContext): Promise<{ findings: ProbeFinding[]; truncated: boolean } | null> {
  const page = ctx.page;
  const base: TextLayoutResult = await page.evaluate(textLayout, { phase: 'start', ...LAYOUT_LIMITS });
  const { width, height } = ctx.viewport;
  try {
    // No visible text read: none on the page, unless the caps stopped the reading (then not all was read). A page
    // with no text of its own may still hold its content in frames from this site: those are measured below.
    if (!base.before.items.some((it, i) => base.kinds[i] === 't' && it.v)) {
      const own = await ownFrames(page);
      if (!own.frames.length && !own.gaps.length) return base.truncated ? { findings: [], truncated: true } : null;
    }
    let narrow: LayoutState;
    let vertical: ReturnType<typeof writingFacts> | undefined;
    let places: LayoutPlace[] = [];
    let desc: LayoutDescription | undefined;
    // When a script replaced the page's text at the narrow width, what it shows there is measured afresh.
    let fresh: { res: TextLayoutResult; places: LayoutPlace[]; desc?: LayoutDescription } | undefined;
    /** What does not fit inside the page's own frames at this width. */
    let framed: ProbeFinding[] = [];
    /** Cut-off excerpts whose "read more" control could not be verified to give the full text: not testable, never exempt. */
    let unverified: ProbeFinding[] = [];
    // Batch 18, D6: prose shown here, to compare with what 320 px still shows.
    const kept = await page.evaluate(keepProse, { key: LOST_KEY, max: LOST_LIMITS.blocks, excluded: LOST_EXCLUDED }).catch(() => 0);
    let lost: ProbeFinding[] = [];
    let wide: WideText[] = [];
    try {
      await page.setViewportSize!({ ...REFLOW_VIEWPORT });
      await page.waitForTimeout(400);
      narrow = (await page.evaluate(textLayout, { phase: 'again', ...LAYOUT_LIMITS })).before;
      if (kept) lost = lostFindings(await page.evaluate(lostProse, { key: LOST_KEY, max: LOST_LIMITS.max, excluded: LOST_EXCLUDED }).catch(() => []), REFLOW_VIEWPORT.width);
      // AI evidence (batch 18, visual AI): prose 320 px removes while a control may show it, pictured at 320 px with
      // the controls' names; never a finding here. Only when an AI review listens.
      if (kept && ctx.aiEvidence && page.screenshot) {
        const shots: NarrowShot[] = [];
        for (const l of await page.evaluate(lostProse, { key: LOST_KEY, max: 3, excluded: LOST_EXCLUDED, controlled: true }).catch(() => [])) {
          const clip = await page.evaluate(sectionClip, l.hidden).catch(() => null);
          const picture = clip ? await page.screenshot({ type: 'png', clip }).catch(() => null) : null;
          if (picture) shots.push({ path: l.path, text: l.text, controls: l.controls ?? [], width: REFLOW_VIEWPORT.width, picture: new Uint8Array(picture) });
        }
        await page.evaluate(() => window.scrollTo(0, 0), undefined).catch(() => {});
        if (shots.length) ctx.attach?.({ narrowShots: shots });
      }
      const sorted = await withoutExcerpts(page, reflowPlaces(base.before, narrow, base.kinds));
      places = sorted.places;
      unverified = [...(await excerptFindings(page, '1.4.10', sorted.unverified, 'At 320 px wide')), ...movingFindings('1.4.10', narrow, base.kinds, 'At 320 px wide')];
      if (goneShare(base.before, narrow, base.kinds) > REPLACED_SHARE) {
        if (places.length) desc = await page.evaluate(describeLayout, { ...placeRefs(places) });
        const res = await page.evaluate(textLayout, { phase: 'start', ...LAYOUT_LIMITS });
        const found = freshReflowPlaces(res.before, res.kinds);
        fresh = { res, places: found, ...(found.length ? { desc: await page.evaluate(describeLayout, { ...placeRefs(found) }) } : {}) };
      }
      // A picture at this width (the tracked nodes are the fresh ones once measured afresh).
      await reflowEvidence(ctx, fresh ? fresh.res.before : narrow, fresh ? fresh.places : places);
      framed = await frameReflow(ctx, MAX_PLACES);
      // Batch 18, round 2: the page scrolls sideways because of text the layout walk does not read.
      wide = await page.evaluate(wideText, { max: 2 }).catch(() => [] as WideText[]);
      const facts = await page.evaluate(writingFacts, undefined);
      if (facts.vertical) {
        await page.setViewportSize!({ ...REFLOW_VERTICAL_VIEWPORT });
        await page.waitForTimeout(400);
        vertical = await page.evaluate(writingFacts, undefined);
      }
    } finally {
      await page.setViewportSize!({ width, height });
      await page.waitForTimeout(200);
    }
    const findings: ProbeFinding[] = [];
    if (vertical && vertical.sw > vertical.w + 1 && vertical.sh > vertical.h + 1) {
      findings.push({
        criterion: '1.4.10', status: 'failed',
        detail: `The page is written vertically and at ${REFLOW_VERTICAL_VIEWPORT.width}×${REFLOW_VERTICAL_VIEWPORT.height} px it needs scrolling in both directions (${vertical.sw}×${vertical.sh} px of content)`,
      });
    }
    if (places.length && !desc) desc = await page.evaluate(describeLayout, { ...placeRefs(places) });
    if (desc) findings.push(...placeFindings('1.4.10', places, desc, reflowDetail(narrow, base.kinds)));
    if (fresh?.desc) findings.push(...placeFindings('1.4.10', fresh.places, fresh.desc, reflowDetail(fresh.res.before, fresh.res.kinds), Math.max(1, MAX_PLACES - places.length)));
    findings.push(...framed, ...unverified, ...lost);
    // Only where the walk found nothing that does not fit: then this is what makes the page scroll sideways.
    if (!findings.some((f) => f.status === 'failed')) {
      for (const w of wide) {
        findings.push({ criterion: '1.4.10', status: 'failed', target: w.path, detail: `At 320 px wide, content does not fit in its container and its text needs scrolling sideways (the page is ${w.pageWidth} px wide): “${w.text}”` });
      }
    }
    return { findings, truncated: base.truncated || !!fresh?.res.truncated };
  } finally {
    await page.evaluate(dropLayout, undefined).catch(() => {});
    await page.evaluate(dropProse, LOST_KEY).catch(() => {});
  }
}
