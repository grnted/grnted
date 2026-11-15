// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Text lost at some window widths only (batch 18, visual lane, D4; docs/atlas/visual.md). A box with a fixed height
// and hidden overflow loses its last line once the text wraps one more time, which depends on the window width (and
// on the fonts). The resize and spacing tests look at one width each (200% zoom as 1280 against 640, spacing at 1280),
// so such a box passes or fails by luck. This sweep finds the boxes that can lose text that way and measures only them
// across the widths people use:
// - 1.4.4: 200% zoom in a window 2W px wide lays the page out W CSS px wide. Text cut off at W (height halved too) and
//   not cut off at 2W (100% in the same window) fails, for windows from 960 to 1920 px;
// - 1.4.12: text the WCAG spacing cuts off at a desktop width (1024, 1280, 1440) and that fits there without it.
// Candidates are decided in the page: a box whose overflow is hidden or clipped and whose height is set (it does not
// follow its content: giving it `height: auto` in the same task changes it), holding at least 20 characters of text;
// never a scrolling box, a carousel, a ticker, an ellipsis or line clamp on purpose, or a box with a control that
// may show the rest (more, expand, next, a disclosure). At 200% a box with any control near it (the resize test's rule)
// fails only for a line cut through, never for whole lines hidden. Cut off: a line whose part outside the box is more than a
// quarter of its height, or a line wholly outside it. Engine core: no Node-only imports.
import type { ProbeFinding } from '../types.js';
import { TEXT_SPACING_CSS } from './layout.js';
import { timeFor } from './evidence.js';
import { ProbeNotTestable, type PageProbe, type ProbeContext } from './types.js';

/** Where the candidate boxes are kept on the window. */
const CLIP_KEY = '__grntedClip';

export const CLIP_LIMITS = {
  /** Candidate boxes per page. */
  boxes: 24,
  /** Zoomed layout widths W (200% in a window of 2W): each is paired with 2W. 640 is the resize test's own. */
  zoomWidths: [400, 480, 576, 720, 800, 960],
  /** Desktop widths the spacing is applied at (1280 is the spacing test's own). */
  spacingWidths: [1024, 1440],
  /** Window height at 100%; at 200% the layout gets half of it. */
  height: 900,
  /** Settle after a resize (a layout script runs on resize). */
  settleMs: 120,
  /** Failures per page and criterion. */
  max: 3,
} as const;

/**
 * One candidate box as measured at one layout. `partial`: a line is cut through (more than a quarter of it outside),
 * not only whole lines hidden. `ctl`: a control is near the box (the resize test's rule, `scrollControlled` in layout.ts).
 */
export interface BoxCut { i: number; path: string; text: string; cut: boolean; partial: boolean; ctl: boolean; px: number }

/**
 * Runs in the page (self-contained). Finds the candidate boxes (see the file comment) and keeps them on the window.
 * Returns how many.
 */
export function findClipBoxes(arg: { key: string; max: number }): number {
  // Batch 18, round 2: boxes found at earlier widths are kept (a box may clip only inside a width range).
  const kept = (window as unknown as Record<string, Element[] | undefined>)[arg.key];
  const boxes: Element[] = kept ? [...kept] : [];
  const before = boxes.length;
  const MORE = /\b(more|expand|show|read|next|previous|prev|continue|full|all)\b|[›»…]/i;
  const hasText = (e: Element) => ((e as HTMLElement).innerText ?? e.textContent ?? '').replace(/\s+/g, ' ').trim().length >= 20;
  // Batch 18, round 2: boxes in open shadow roots too (a web component's notice).
  const all: Element[] = [];
  const gather = (root: Element | ShadowRoot, depth: number) => {
    for (const e of Array.from(root.querySelectorAll('*'))) {
      if (all.length >= 20_000) return;
      all.push(e);
      if (e.shadowRoot && depth < 6) gather(e.shadowRoot, depth + 1);
    }
  };
  if (document.body) gather(document.body, 0);
  for (let k = 0; k < all.length && boxes.length < arg.max && k < 20_000; k++) {
    const el = all[k]!;
    const cs = getComputedStyle(el);
    // The block axis: vertical text (Sol r1, F10) stacks its lines sideways, so its clipping overflow is the horizontal one.
    const vertical = /^vertical|^sideways/.test(cs.writingMode);
    const clipBlock = vertical ? cs.overflowX === 'hidden' || cs.overflowX === 'clip' : cs.overflowY === 'hidden' || cs.overflowY === 'clip';
    if (!clipBlock || cs.display === 'none' || cs.display === 'inline' || cs.display === 'contents') continue;
    if (el === document.body || el === document.documentElement) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 16 || r.height > 700 || r.width < 60) continue;
    if (!hasText(el)) continue;
    if (cs.textOverflow === 'ellipsis' || (cs.getPropertyValue('-webkit-line-clamp') && cs.getPropertyValue('-webkit-line-clamp') !== 'none')) continue;
    if (el.closest('[aria-roledescription], marquee, [role="marquee"], [role="tabpanel"][hidden]')) continue;
    if (cs.scrollSnapType && cs.scrollSnapType !== 'none') continue;
    if (Array.from(el.querySelectorAll('*')).slice(0, 200).some((d) => {
      const dc = getComputedStyle(d);
      return dc.textOverflow === 'ellipsis' || (dc.getPropertyValue('-webkit-line-clamp') && dc.getPropertyValue('-webkit-line-clamp') !== 'none') || dc.animationName !== 'none';
    })) continue;
    // A control that may show the rest: in the box, or right after it.
    const controls = [...Array.from(el.querySelectorAll('a[href], button, [role="button"], summary, [aria-expanded], [aria-controls]')), ...(el.nextElementSibling ? [el.nextElementSibling] : [])];
    if (controls.some((c) => c.matches('[aria-expanded], [aria-controls], summary') || (c.matches('a[href], button, [role="button"]') && MORE.test(((c as HTMLElement).innerText ?? '') + ' ' + (c.getAttribute('aria-label') ?? ''))))) continue;
    // A height of its own: `height: auto` (and no max-height) changes it, in the same task.
    const h = (el as HTMLElement).style;
    const size = vertical ? 'width' : 'height';
    const maxSize = vertical ? 'max-width' : 'max-height';
    const old = [h.getPropertyValue(size), h.getPropertyPriority(size), h.getPropertyValue(maxSize), h.getPropertyPriority(maxSize)] as const;
    const before = vertical ? r.width : r.height;
    h.setProperty(size, 'auto', 'important');
    h.setProperty(maxSize, 'none', 'important');
    const nr = el.getBoundingClientRect();
    const natural = vertical ? nr.width : nr.height;
    if (old[0]) h.setProperty(size, old[0], old[1]); else h.removeProperty(size);
    if (old[2]) h.setProperty(maxSize, old[2], old[3]); else h.removeProperty(maxSize);
    if (Math.abs(natural - before) < 1 && (vertical ? cs.maxWidth : cs.maxHeight) === 'none') {
      // A box whose content fills its set height exactly reads the same with `height: auto` (batch 18, round 2): a
      // block added for a moment (same task) does not make a fixed box grow, and makes a box that follows its content.
      const extra = document.createElement('div');
      extra.style.cssText = vertical ? 'display:block;width:40px;height:1px;flex:none' : 'display:block;height:40px;width:1px;flex:none';
      el.appendChild(extra);
      const grown = vertical ? el.getBoundingClientRect().width : el.getBoundingClientRect().height;
      extra.remove();
      if (Math.abs(grown - before) >= 1) continue;
    }
    // Inside another candidate: the outer one is measured.
    if (boxes.some((b) => b === el || b.contains(el))) continue;
    boxes.push(el);
  }
  (window as unknown as Record<string, Element[]>)[arg.key] = boxes;
  return boxes.length - before;
}

/**
 * Runs in the page (self-contained). Whether a width-dependent rule (a media or container query on width) sets what
 * makes a box clip: a fixed block size or its maximum, overflow, grid rows or a line clamp. Then the sweep looks for
 * candidate boxes at every width it lays the page out at, not only at the page's own (batch 18, round 2). Style sheets
 * of the document, adopted ones and those of open shadow roots; unreadable ones are skipped.
 */
export function widthClipRules(): boolean {
  const PROPS = /(?:^|;)\s*(?:height|max-height|block-size|max-block-size|overflow|overflow-y|overflow-x|overflow-block|grid-auto-rows|grid-template-rows|-webkit-line-clamp|line-clamp)\s*:/i;
  const WIDTH = /width|inline-size/i;
  let found = false;
  const walk = (rules: CSSRuleList | undefined, inWidth: boolean, depth: number): void => {
    if (!rules || found || depth > 6) return;
    for (const r of Array.from(rules)) {
      if (found) return;
      const cond = (r as CSSConditionRule).conditionText;
      const here = inWidth || (typeof cond === 'string' && WIDTH.test(cond));
      if (r instanceof CSSStyleRule && here && PROPS.test(r.style.cssText)) { found = true; return; }
      walk((r as CSSGroupingRule).cssRules, here, depth + 1);
    }
  };
  const sheets: CSSStyleSheet[] = [...Array.from(document.styleSheets), ...((document as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? [])];
  const roots = (root: Document | ShadowRoot, depth: number) => {
    if (depth > 6) return;
    for (const h of Array.from(root.querySelectorAll('*'))) {
      if (!h.shadowRoot) continue;
      sheets.push(...Array.from(h.shadowRoot.styleSheets), ...(h.shadowRoot.adoptedStyleSheets ?? []));
      roots(h.shadowRoot, depth + 1);
    }
  };
  roots(document, 0);
  for (const sh of sheets) {
    let rules: CSSRuleList | undefined;
    try { rules = sh.cssRules; } catch { rules = undefined; }
    walk(rules, false, 0);
    if (found) break;
  }
  return found;
}

/**
 * Runs in the page (self-contained). For each kept box: whether text in it is cut off now (see the file comment), with
 * `css` applied as a constructed style sheet inside the same task when given (the page never paints it).
 */
export function clipCuts(arg: { key: string; css?: string }): BoxCut[] {
  const boxes = (window as unknown as Record<string, Element[]>)[arg.key] ?? [];
  const doc = document as Document & { adoptedStyleSheets?: CSSStyleSheet[] };
  let previous: CSSStyleSheet[] | null = null;
  // The spacing reaches open shadow roots as a person's style sheet would (batch 18, round 2): the same sheet adopted
  // by each root a kept box lives in, and taken off again in the same task.
  const shadowSheets: [ShadowRoot, CSSStyleSheet[]][] = [];
  if (arg.css && Array.isArray(doc.adoptedStyleSheets)) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(arg.css);
    previous = [...doc.adoptedStyleSheets];
    doc.adoptedStyleSheets = [...previous, sheet];
    for (const b of (window as unknown as Record<string, Element[]>)[arg.key] ?? []) {
      for (let r = b.getRootNode(); r instanceof ShadowRoot; r = r.host.getRootNode()) {
        if (shadowSheets.some(([x]) => x === r)) break;
        shadowSheets.push([r, [...r.adoptedStyleSheets]]);
        r.adoptedStyleSheets = [...r.adoptedStyleSheets, sheet];
      }
    }
  }
  const segPath = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur && cur.nodeType === 1 && parts.length < 8; cur = cur.parentElement) {
      if (cur.id && (cur.getRootNode() as Document | ShadowRoot).querySelectorAll(`#${CSS.escape(cur.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const parent: Element | null = cur.parentElement;
      const same = parent ? Array.from(parent.children).filter((c) => c.localName === cur!.localName) : [];
      parts.unshift(same.length > 1 ? `${cur.localName}:nth-of-type(${same.indexOf(cur) + 1})` : cur.localName);
    }
    return parts.join(' > ');
  };
  const cssPath = (el: Element): string => {
    const segs: string[] = [];
    for (let e: Element | null = el; e; ) {
      segs.unshift(segPath(e));
      const r = e.getRootNode();
      e = r instanceof ShadowRoot ? r.host : null;
    }
    return segs.join(' >>> ');
  };
  // Any control near the box, as the resize test reads it (layout.ts `scrollControlled`, the lead's ruling after Sol
  // round 3): one whose aria-controls names it, one inside it or in its parent, or one among the siblings of its parent
  // or grandparent. Whole lines hidden in such a box may be scrolled into view by it: not a failure at 200%.
  const CTL = 'button, [role="button"], a[href], input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
  const controlled = (el: Element): boolean => {
    if (el.id && document.querySelector(`[aria-controls~="${CSS.escape(el.id)}"]`)) return true;
    if (el.querySelector(CTL)) return true;
    const parent = el.parentElement;
    if (!parent) return false;
    if (Array.from(parent.querySelectorAll(CTL)).some((c) => !el.contains(c))) return true;
    for (let a: Element | null = parent, k = 0; a && k < 2 && a !== document.documentElement; a = a.parentElement, k++) {
      const up: Element | null = a.parentElement;
      if (!up) break;
      for (const sib of Array.from(up.children) as Element[]) if (sib !== a && (sib.matches(CTL) || sib.querySelector(CTL))) return true;
    }
    return false;
  };
  try {
    return boxes.map((el, i) => {
      const out: BoxCut = { i, path: cssPath(el), text: ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 80), cut: false, partial: false, ctl: false, px: 0 };
      if (!el.isConnected) return out;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return out;
      const vertical = /^vertical|^sideways/.test(cs.writingMode);
      const rl = /-rl$/.test(cs.writingMode) || cs.writingMode === 'vertical-rl' || cs.writingMode === 'sideways-rl';
      // At this layout the box may scroll instead of clipping (Sol r1, finding 1): its lines can then be reached.
      const ov = vertical ? cs.overflowX : cs.overflowY;
      if (ov !== 'hidden' && ov !== 'clip') return out;
      const r = el.getBoundingClientRect();
      const bottom = r.top + (parseFloat(cs.borderTopWidth) || 0) + el.clientHeight;
      const leftEdge = r.left + (parseFloat(cs.borderLeftWidth) || 0);
      const rightEdge = leftEdge + el.clientWidth;
      if ((vertical ? el.clientWidth : el.clientHeight) < 8) return out;
      out.ctl = controlled(el);
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!(n.nodeValue ?? '').trim()) continue;
        const p = n.parentElement;
        if (!p) continue;
        const pc = getComputedStyle(p);
        if (pc.visibility === 'hidden' || pc.display === 'none' || p.closest('[aria-hidden="true"]')) continue;
        // Text positioned out of the flow (a badge, a decoration) is not what the box holds.
        if (p !== el && /^(absolute|fixed)$/.test(pc.position)) continue;
        // Text in a scrolling region inside the box can be scrolled to.
        let scrolls = false;
        for (let a: Element | null = p; a && a !== el; a = a.parentElement) {
          const ac = getComputedStyle(a);
          if (/^(auto|scroll)$/.test(ac.overflowY) || /^(auto|scroll)$/.test(ac.overflowX)) { scrolls = true; break; }
        }
        if (scrolls) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const line of Array.from(range.getClientRects())) {
          if (line.height < 2 || line.width < 2) continue;
          // The block-end side: the bottom for horizontal text, the left (vertical-rl) or right (vertical-lr) for vertical.
          const thick = vertical ? line.width : line.height;
          const lost = vertical ? (rl ? leftEdge - line.left : line.right - rightEdge) : line.bottom - bottom;
          const gone = vertical ? (rl ? line.right <= leftEdge + 0.5 : line.left >= rightEdge - 0.5) : line.top >= bottom - 0.5;
          if (thick < 4) continue;
          if (lost > 0.25 * thick || gone) {
            out.cut = true;
            if (!gone) out.partial = true;
            out.px = Math.max(out.px, Math.round(Math.min(lost, thick)));
          }
        }
      }
      return out;
    });
  } finally {
    if (previous) doc.adoptedStyleSheets = previous;
    for (const [r, was] of shadowSheets) r.adoptedStyleSheets = was;
  }
}

/** Runs in the page: forgets the kept boxes. */
/**
 * Neutral evidence for the AI review (batch 18, visual AI): a box whose whole lines 200% zoom hides while a control is
 * near it (the control-near rule leaves it unjudged), as the page shows it there, with its text and the controls near it.
 * Taken only when the review listens (`ProbeContext.aiEvidence`); attached to the run, never in the report.
 */
export interface ClipShot {
  criterion: '1.4.4';
  /** The layout width (200% zoom in a window twice as wide). */
  width: number;
  path: string;
  /** The box's whole text (bounded), what a person should be able to read. */
  text: string;
  /** The controls near it: their names and boxes in CSS px of the picture. */
  controls: { name: string; box: { x: number; y: number; w: number; h: number } }[];
  /** The box in CSS px of the picture. */
  box: { x: number; y: number; w: number; h: number };
  picture: Uint8Array;
}
export const CLIP_SHOTS_MAX = 3;

/** Runs in the page: the kept box `i` with the controls near it, scrolled into view; the picture's clip and the boxes in it. */
export function clipBoxInfo(arg: { key: string; i: number; margin: number }): { clip: { x: number; y: number; width: number; height: number }; text: string; box: ClipShot['box']; controls: ClipShot['controls'] } | null {
  const el = ((window as unknown as Record<string, Element[]>)[arg.key] ?? [])[arg.i];
  if (!el || !el.isConnected) return null;
  const CTL = 'button, [role="button"], a[href], input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
  const near = new Set<Element>();
  if (el.id) for (const c of Array.from(document.querySelectorAll(`[aria-controls~="${CSS.escape(el.id)}"]`))) near.add(c);
  for (const c of Array.from(el.querySelectorAll(CTL))) near.add(c);
  const parent = el.parentElement;
  if (parent) for (const c of Array.from(parent.querySelectorAll(CTL))) if (!el.contains(c)) near.add(c);
  for (let a: Element | null = parent, k = 0; a && k < 2 && a !== document.documentElement; a = a.parentElement, k++) {
    const up: Element | null = a.parentElement;
    if (!up) break;
    for (const sib of Array.from(up.children)) if (sib !== a) { if (sib.matches(CTL)) near.add(sib); for (const c of Array.from(sib.querySelectorAll(CTL))) near.add(c); }
  }
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  const ctls = [...near].filter((c) => c.getClientRects().length).slice(0, 6);
  let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
  for (const c of ctls) { const b = c.getBoundingClientRect(); x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top); x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom); }
  const x = Math.max(0, x0 - arg.margin), y = Math.max(0, y0 - arg.margin);
  const width = Math.min(innerWidth - x, x1 - x0 + 2 * arg.margin), height = Math.min(innerHeight - y, y1 - y0 + 2 * arg.margin);
  if (width < 8 || height < 8) return null;
  const rel = (b: DOMRect) => ({ x: Math.round(b.left - x), y: Math.round(b.top - y), w: Math.round(b.width), h: Math.round(b.height) });
  const name = (c: Element) => (c.getAttribute('aria-label') || (c as HTMLElement).innerText || c.getAttribute('title') || (c as HTMLInputElement).value || c.localName).replace(/\s+/g, ' ').trim().slice(0, 60);
  return {
    clip: { x, y, width, height }, box: rel(r), text: ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
    controls: ctls.map((c) => ({ name: name(c), box: rel(c.getBoundingClientRect()) })),
  };
}

const clipShots = new WeakMap<object, ClipShot[]>();
/** The pictures `clipSweep` kept for this run (and forgets them). */
export function takeClipShots(ctx: object): ClipShot[] {
  const out = clipShots.get(ctx) ?? [];
  clipShots.delete(ctx);
  return out;
}

export function dropClipBoxes(key: string): void {
  delete (window as unknown as Record<string, unknown>)[key];
}

type Ctx = Pick<ProbeContext, 'page' | 'viewport' | 'deadline' | 'signal' | 'discardPage' | 'aiEvidence'>;

/** Lays the page out at `width` x `height` and measures the kept boxes (with `css` when given). Null when it could not. */
async function at(ctx: Ctx, width: number, height: number, css?: string, find = false): Promise<BoxCut[] | null> {
  try {
    await ctx.page.setViewportSize!({ width, height });
    await ctx.page.waitForTimeout(CLIP_LIMITS.settleMs);
    // Boxes that clip only inside a width range are found where they clip (batch 18, round 2).
    if (find) await ctx.page.evaluate(findClipBoxes, { key: CLIP_KEY, max: CLIP_LIMITS.boxes });
    return await ctx.page.evaluate(clipCuts, { key: CLIP_KEY, ...(css ? { css } : {}) });
  } catch {
    return null;
  }
}

/**
 * The sweep for one criterion: '1.4.4' (zoom pairs) or '1.4.12' (spacing at desktop widths). Failures only; a page with
 * no candidate box pays one in-page read. Puts the viewport back; a page whose viewport could not be put back is not
 * given to later tests. Never throws.
 */
export async function clipSweep(ctx: Ctx, criterion: '1.4.4' | '1.4.12', skip: ReadonlySet<string> = new Set()): Promise<ProbeFinding[]> {
  const page = ctx.page;
  if (!page.setViewportSize || ctx.signal.aborted || !timeFor(ctx, 4000)) return [];
  let n = 0;
  // A rule that makes boxes clip inside a width range only: candidates are looked for at every width (round 2).
  let ranged = false;
  try {
    n = await page.evaluate(findClipBoxes, { key: CLIP_KEY, max: CLIP_LIMITS.boxes });
    ranged = await page.evaluate(widthClipRules, undefined).catch(() => false);
  } catch {
    return [];
  }
  if (!n && !ranged) return [];
  const { width, height } = ctx.viewport;
  const out: ProbeFinding[] = [];
  const reported = new Set<string>(skip);
  try {
    if (criterion === '1.4.4') {
      // With an AI review listening, the resize test's own width (640) is looked at too, for evidence only.
      for (const w of ctx.aiEvidence ? [640, ...CLIP_LIMITS.zoomWidths] : CLIP_LIMITS.zoomWidths) {
        if (out.length >= CLIP_LIMITS.max || ctx.signal.aborted || !timeFor(ctx, 2500)) break;
        // A box that clips only at the zoomed layout is found there first, then measured at both.
        if (ranged && !(await at(ctx, w, Math.round(CLIP_LIMITS.height / 2), undefined, true))) break;
        const full = await at(ctx, w * 2, CLIP_LIMITS.height, undefined, ranged);
        const zoomed = await at(ctx, w, Math.round(CLIP_LIMITS.height / 2));
        if (!full || !zoomed) break;
        for (const z of zoomed) {
          const f = full[z.i];
          if (!z.cut || !f || f.cut || reported.has(z.path) || out.length >= CLIP_LIMITS.max) continue;
          // Only whole lines hidden, in a box with a control near it: never a failure (the resize test's rule). With an
          // AI review listening, its picture there is kept for the review (whether a control can show the lines).
          if (z.ctl && !z.partial) {
            const kept = clipShots.get(ctx) ?? [];
            if (ctx.aiEvidence && kept.length < CLIP_SHOTS_MAX && !kept.some((k) => k.path === z.path) && ctx.page.screenshot) {
              const info = await ctx.page.evaluate(clipBoxInfo, { key: CLIP_KEY, i: z.i, margin: 24 }).catch(() => null);
              const picture = info ? await ctx.page.screenshot({ type: 'png', clip: info.clip }).catch(() => null) : null;
              if (info && picture) {
                kept.push({ criterion: '1.4.4', width: w, path: z.path, text: info.text, controls: info.controls, box: info.box, picture: new Uint8Array(picture) });
                clipShots.set(ctx, kept);
              }
            }
            continue;
          }
          if (w === 640) continue;
          reported.add(z.path);
          out.push({
            criterion: '1.4.4', status: 'failed', target: z.path,
            detail: `At 200% zoom in a window ${w * 2} px wide (the page laid out ${w} CSS px wide), text in this box is cut off by its fixed height (${z.px} px of a line hidden); at 100% in the same window it fits: “${z.text}”`,
          });
        }
      }
    } else {
      // The spacing test's own width (1280) is looked at here too for boxes in shadow roots, which its spacing does not
      // reach (round 2).
      let shadowBoxes = false;
      // What the spacing test judges itself, at its own width, is left to it (its exemptions included, such as an excerpt
      // whose full text is one step away): a box in the document that the spacing cuts here and that fits here without
      // it is never reported by the sweep (round 3: an exact-fit excerpt box was failed at another width although the
      // spacing test passes it, and a box the spacing test fails was reported twice). Shadow-root boxes stay: the
      // spacing test does not reach them.
      const plainHere = await page.evaluate(clipCuts, { key: CLIP_KEY }).catch(() => null);
      const spacedHere = plainHere ? await page.evaluate(clipCuts, { key: CLIP_KEY, css: TEXT_SPACING_CSS }).catch(() => null) : null;
      for (const s of spacedHere ?? []) {
        const p = plainHere?.[s.i];
        if (s.cut && p && !p.cut && !s.path.includes(' >>> ')) reported.add(s.path);
      }
      for (const w of [...CLIP_LIMITS.spacingWidths, 1280]) {
        if (out.length >= CLIP_LIMITS.max || ctx.signal.aborted || !timeFor(ctx, 2500)) break;
        if (w === 1280 && !shadowBoxes) break;
        const plain = await at(ctx, w, CLIP_LIMITS.height, undefined, ranged);
        if (plain?.some((b) => b.path.includes(' >>> '))) shadowBoxes = true;
        const spaced = plain ? await page.evaluate(clipCuts, { key: CLIP_KEY, css: TEXT_SPACING_CSS }).catch(() => null) : null;
        if (!plain || !spaced) break;
        for (const s of spaced) {
          const p = plain[s.i];
          if (w === 1280 && !s.path.includes(' >>> ')) continue;
          if (!s.cut || !p || p.cut || reported.has(s.path) || out.length >= CLIP_LIMITS.max) continue;
          reported.add(s.path);
          out.push({
            criterion: '1.4.12', status: 'failed', target: s.path,
            detail: `With the WCAG text spacing (line height 1.5, paragraph spacing 2em, letter spacing 0.12em, word spacing 0.16em), text in this box is cut off by its fixed height at a window ${w} px wide (${s.px} px of a line hidden); without it the text fits: “${s.text}”`,
          });
        }
      }
    }
  } finally {
    let back = false;
    try {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(CLIP_LIMITS.settleMs);
      back = true;
    } catch {
      back = false;
    }
    await page.evaluate(dropClipBoxes, CLIP_KEY).catch(() => {});
    // A picture for the AI review scrolled a box into view: the page goes back to the top for the next test.
    if (clipShots.get(ctx)?.length) await page.evaluate(() => window.scrollTo(0, 0), undefined).catch(() => {});
    if (!back) ctx.discardPage?.();
  }
  return out;
}

/**
 * `probe` with the sweep for `criterion` run first (its failures kept through `ctx.keep`), then the probe's own test.
 * A failure of the sweep stands when the probe itself ends not testable.
 */
export function withClipSweep(probe: PageProbe, criterion: '1.4.4' | '1.4.12'): PageProbe {
  return {
    ...probe,
    async run(ctx: ProbeContext): Promise<ProbeFinding[]> {
      const sweep = await clipSweep(ctx, criterion);
      if (sweep.length) ctx.keep?.(sweep);
      const shots = takeClipShots(ctx);
      if (shots.length) ctx.attach?.({ clipShots: shots });
      try {
        const own = await probe.run(ctx);
        // One failure per box: one the probe's own test failed too is reported once, by that test (round 3).
        const failedHere = new Set(own.filter((f) => f.status === 'failed' && f.target).map((f) => f.target));
        const extra = sweep.filter((f) => !(f.target && failedHere.has(f.target)));
        return extra.length ? [...extra, ...own] : own;
      } catch (err) {
        if (sweep.length && err instanceof ProbeNotTestable) return sweep;
        throw err;
      }
    },
  };
}
