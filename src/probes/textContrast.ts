// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.3 Contrast (minimum), completing axe (Plan 4 Task 4.3): text whose contrast axe could
// not decide (background images, gradients, overlapping boxes, pseudo-elements) is measured from
// screenshots taken with the text shown and hidden. Engine core: no Node-only imports.
import type { AxeRun, Finding, ProbeFinding } from '../types.js';
import { runAxe, type AxeOptions } from '../axeRun.js';
import { mergeViewportRuns } from '../axeMerge.js';
import { asideData, discoveryDetails, multiplePopups, findPopups, incomplete, INCOMPLETE, notAside, setPopupAside, stoppedBetween, timeForAside, type PopupBox } from './popupAside.js';
import { contrastRatio, hex, isLargeText, ratioText, textContrast, type Rgb, type Rgba, type RgbaImage, type TextUnmeasured, type TextVerdict } from './pixels.js';
import { eachBatch, imagesReady, markElements, shoot, SHOT_KEY, toImageBoxes, type MarkedState } from './shots.js';
import { freezePage, type FrozenPage } from './freeze.js';
import { stoppedSince } from './layout.js';
import { before, cleanText, cropAround, shootElements, timeFor } from './evidence.js';
import { CONTRAST_EXEMPT_KEY, installContrastExempt } from './contrastExempt.js';
import { PLACEHOLDER_LIMITS, placeholderFields, placeholderFindings } from './placeholderContrast.js';
import { CONTRAST_KIT_KEY, installContrastKit } from './contrastKit.js';
import { addGap, gapsText, stateContrast, type Gaps } from './stateContrast.js';
import { ProbeNotTestable, type PageProbe, type ProbeContext } from './types.js';
import { graphicControlRefs } from './graphicControls.js';
import { eachPresentation } from './presentations.js';
import { faintFirstParts, PAINT_EFFECT_MAX, paintEffectTargets } from './paintEffects.js';

/** axe rules whose undecided text this probe measures. */
export const CONTRAST_RULES = ['color-contrast'] as const;

export const TEXT_CONTRAST_LIMITS = {
  /** Undecided elements measured per page (axe lists at most 50 per rule). */
  elements: 30,
  /**
   * Scroll positions measured per page (desktop and phone width together), top of the page first.
   * A fixed number, so which text is measured never depends on how fast the browser is; text past
   * it is not measured ('limit'). Each position costs about eleven calls into the browser.
   */
  positions: 12,
  /** Time kept back from the time box to report what was measured. */
  reserveMs: 1500,
  /** Wait before measuring again when the area moved. */
  retryMs: 400,
  /** Longest wait, per place measured, for the pictures behind the text to load (kept back before each place). */
  imagesMs: 1500,
} as const;

/** One element axe could not decide, as the page reports it. */
export interface TextTarget {
  /** axe's selector (parts joined by ' >>> ' across shadow roots and frames). */
  target: string;
  /** Index in the in-page store; -1 when not found. Identity-only look 1 may store an inaccessible frame's prefix. */
  ref: number;
  /**
   * Why it cannot be measured at all: not found (neither by axe's selector nor, when that names an id
   * the page generates anew on each load, by the same selector and markup without the ids), inside a
   * frame from another site, not shown, or its letters are painted with a background
   * (`background-clip: text`), which hiding the text leaves in place.
   */
  why?: 'missing' | 'frame' | 'hidden' | 'painted';
  /**
   * Batch 18, round 2: for letters painted by a gradient (`background-clip: text`) over solid fills only, the
   * gradient's colour stops and the colour behind the painted element, with the text's size, so the contrast can be
   * decided from them (every stop under the threshold: failed; every stop at or above it: passes).
   */
  stops?: { colours: Rgba[]; back: Rgba; fontSize: number; fontWeight: number };
  fg?: Rgba;
  /** `-webkit-text-fill-color` differs from `color` (gradient or image-filled text, or a different fill). */
  fill?: boolean;
  /** The computed `color` and `-webkit-text-fill-color` when read, as `markElements` reports them. */
  colors?: string;
  opacity?: number;
  fontSize?: number;
  fontWeight?: number;
  shadow?: boolean;
  text?: string;
  /** Top of its box in the top page (CSS px), for the measuring order. */
  y?: number;
  /** Graphic evidence: explicit graphic/hidden context, private-use characters, or a verified control name. */
  glyph?: true;
  /** A font-family name suggests graphics, but does not establish which font or glyphs actually rendered. */
  graphicFont?: true;
  /** A possible single-character graphic whose computed control name could not be read. */
  graphicUnknown?: true;
}

/**
 * Runs in the page (self-contained). Finds axe's targets (descending into open shadow roots and
 * same-origin frames), keeps them in the shot store, and reads what the pixels cannot tell: the text
 * colour (converted to sRGB by a canvas), opacity, font size and weight, text shadow.
 */
export function locateTexts(arg: { key: string; targets: string[]; html?: string[]; identityOnly?: boolean }): TextTarget[] {
  const w = window as unknown as Record<string, unknown>;
  const store: Element[] = [];
  w[arg.key] = store;
  const canvas = arg.identityOnly ? null : document.createElement('canvas');
  if (canvas) { canvas.width = 1; canvas.height = 1; }
  const g = canvas?.getContext('2d', { willReadFrequently: true });
  const rgba = (c: string): [number, number, number, number] => {
    if (!g) return [0, 0, 0, 1];
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = '#000';
    g.fillStyle = c;
    g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    return [d[0]!, d[1]!, d[2]!, Math.round((d[3]! / 255) * 1000) / 1000];
  };
  const parentOf = (el: Element): Element | null => {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode() as Node & { host?: Element };
    if (root.host) return root.host;
    const fe = el.ownerDocument.defaultView?.frameElement;
    return fe ?? null;
  };
  const clean = (s: string | null | undefined) => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > 80 ? `${t.slice(0, 79)}…` : t;
  };
  // Markup without ids or runs of spaces, to compare an element with axe's copy of it.
  const plain = (h: string) => h.replace(/\s+id\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/\s+/g, ' ').trim();
  const visibleNow = (el: Element) => (typeof el.checkVisibility === 'function' ? el.checkVisibility({ visibilityProperty: true }) : true);
  /**
   * The element by axe's selector with every id replaced by "has an id" (and every attribute value
   * with a long run of digits by "has the attribute"), whose markup (ids left out)
   * is axe's copy: ids a script generates on each load (menus, sliders) differ from the audit's. axe
   * keeps at most 300 characters of markup, so a longer copy is compared as a prefix. The first
   * visible match, else the first. Identity-only look 1 requires exactly one match before excluding a target.
   */
  const again = (root: Document | ShadowRoot, part: string, html: string | undefined): Element | null => {
    if (!html || !/#|\d{6}/.test(part)) return null;
    // Attribute values with a long run of digits (`[data-menu-id="1793558277"]`) become "has the attribute".
    const unstamped = part.replace(/\[([\w:-]+)[~|^$*]?=("[^"]*\d{6,}[^"]*"|'[^']*\d{6,}[^']*')\]/g, '[$1]');
    // Ids outside quoted attribute values (`a[href="#top"]` keeps its value).
    const loose = unstamped.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/)
      .map((piece, k) => (k % 2 ? piece : piece.replace(/#(?:\\[0-9a-fA-F]{1,6} ?|\\.|[\w\u00a0-\uffff-])+/g, '[id]'))).join('');
    let list: Element[] = [];
    try {
      list = [...root.querySelectorAll(loose)];
    } catch {
      return null;
    }
    const want = plain(html);
    const cut = html.length >= 300;
    const same = list.filter((el) => (cut ? plain(el.outerHTML).startsWith(want) : plain(el.outerHTML) === want));
    if (arg.identityOnly) return same.length === 1 ? same[0]! : null;
    return same.find(visibleNow) ?? same[0] ?? null;
  };
  return arg.targets.map((target, ti) => {
    const parts = target.split(' >>> ');
    let root: Document | ShadowRoot = document;
    let el: Element | null = null;
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        if (!el) break;
        if (el.shadowRoot) root = el.shadowRoot;
        else if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          let doc: Document | null = null;
          try {
            doc = (el as HTMLIFrameElement).contentDocument;
          } catch {
            doc = null;
          }
          // The leaf is inaccessible, but this resolved frame still proves ownership for look 1.
          if (!doc) return { target, ref: arg.identityOnly ? store.push(el) - 1 : -1, why: 'frame' as const };
          root = doc;
        } else return { target, ref: -1, why: 'missing' as const };
      }
      try {
        if (arg.identityOnly) {
          const matches: NodeListOf<Element> = root.querySelectorAll(parts[i]!);
          el = matches.length === 1 ? matches[0]! : null;
        } else el = root.querySelector(parts[i]!);
      } catch {
        el = null;
      }
      if (!el && i === parts.length - 1) el = again(root, parts[i]!, arg.html?.[ti]);
    }
    if (!el) return { target, ref: -1, why: 'missing' as const };
    const ref = store.push(el) - 1;
    // Look 1 identifies pop-up descendants only; it reads no text styles or measurements.
    if (arg.identityOnly) return { target, ref };
    // The element whose style draws the text: itself when it has text of its own, else the parent of
    // its first text (a paragraph whose words sit in a span with a colour of its own).
    let tx: Element = el;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && ![...el.childNodes].some((n) => n.nodeType === 3 && /\S/.test(n.nodeValue ?? ''))) {
      const tw = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        if (/\S/.test(n.nodeValue ?? '') && n.parentElement) {
          tx = n.parentElement;
          break;
        }
      }
    }
    const s = getComputedStyle(tx);
    const visible = typeof el.checkVisibility === 'function' ? el.checkVisibility({ visibilityProperty: true }) : s.display !== 'none' && s.visibility !== 'hidden';
    const r = el.getBoundingClientRect();
    if (!visible || r.width < 1 || r.height < 1) return { target, ref, why: 'hidden' as const };
    let opacity = 1;
    let shadow = false;
    let painted = false;
    let painter: Element | null = null;
    let depth = 0;
    for (let a: Element | null = tx; a; a = parentOf(a), depth++) {
      const st = getComputedStyle(a) as CSSStyleDeclaration & { webkitBackgroundClip?: string };
      opacity *= parseFloat(st.opacity) || 0;
      if (st.textShadow && st.textShadow !== 'none') shadow = true;
      if (depth < 4 && /\btext\b/.test(`${st.backgroundClip} ${st.webkitBackgroundClip ?? ''}`) && !painted) { painted = true; painter = a; }
    }
    if (painted) {
      // Round 2: a gradient of plain colour stops over solid fills is decided from its stops.
      const bi = painter ? getComputedStyle(painter).backgroundImage : '';
      const colours = /url\(/.test(bi) ? [] : (bi.match(/rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8}\b/gi) ?? []).map((c) => rgba(c));
      let back: Rgba = [255, 255, 255, 1];
      let solid = colours.length >= 2 && opacity >= 0.99;
      const chain: Element[] = [];
      for (let a = painter ? parentOf(painter) : null; a && solid; a = parentOf(a)) chain.unshift(a);
      for (const a of chain) {
        const st = getComputedStyle(a);
        if (st.backgroundImage !== 'none' || (st.filter && st.filter !== 'none') || st.mixBlendMode !== 'normal') { solid = false; break; }
        const bg = rgba(st.backgroundColor);
        if (bg[3] > 0) back = [bg[0] * bg[3] + back[0] * (1 - bg[3]), bg[1] * bg[3] + back[1] * (1 - bg[3]), bg[2] * bg[3] + back[2] * (1 - bg[3]), 1];
      }
      return { target, ref, why: 'painted' as const, ...(solid ? { stops: { colours, back, fontSize: parseFloat(s.fontSize) || 16, fontWeight: Number(s.fontWeight) || 400 } } : {}) };
    }
    // Batch 18, round 2: text in SVG is painted by its fill (and fill-opacity), not by color.
    const svgText = el instanceof SVGElement;
    if (svgText && /url\(/.test(s.fill)) return { target, ref, why: 'painted' as const };
    const color = svgText ? s.fill : s.color;
    const fillColor = svgText ? s.fill : s.webkitTextFillColor || color;
    const fg0 = rgba(fillColor);
    const fillOpacity = svgText ? Number(s.fillOpacity) : 1;
    const fg: typeof fg0 = svgText && Number.isFinite(fillOpacity) && fillOpacity < 1 ? [fg0[0], fg0[1], fg0[2], fg0[3] * fillOpacity] as typeof fg0 : fg0;
    let y = r.top;
    for (let fe = el.ownerDocument.defaultView?.frameElement; fe; fe = fe.ownerDocument.defaultView?.frameElement) y += fe.getBoundingClientRect().top;
    const own = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? '' : (el.textContent ?? '')).replace(/\s+/g, '');
    // Explicit graphic evidence. A control's computed name is checked separately through CDP.
    const privateUse = /^[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]+$/u.test(own);
    const iconFont = /font[ -]?awesome|material[ -]?(?:icons|symbols)|icomoon|glyphicons/i.test(s.fontFamily);
    let glyph = privateUse;
    for (let a: Element | null = el, i = 0; a && i < 200; a = parentOf(a), i++) {
      if (a.getAttribute('aria-hidden') === 'true' || /^(img|presentation|none)$/.test(a.getAttribute('role') ?? '')) { glyph = true; break; }
    }
    return {
      ...(glyph ? { glyph: true as const } : {}),
      ...(iconFont && !glyph ? { graphicFont: true as const } : {}),
      target, ref, fg, fill: svgText || fillColor !== color, colors: `${color}|${s.webkitTextFillColor}`, opacity: Math.round(opacity * 1000) / 1000,
      fontSize: parseFloat(s.fontSize) || 16, fontWeight: Number(s.fontWeight) || 400, shadow,
      text: clean(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value || el.placeholder : (el as HTMLElement).innerText ?? el.textContent),
      y: y + window.scrollY,
    };
  });
}

/** The color-contrast elements axe could not decide on this page, desktop first, each once. */
export function undecidedTexts(incomplete: readonly Finding[]): { target: string; html?: string; summary?: string; mobileOnly: boolean }[] {
  const seen = new Set<string>();
  const out: { target: string; html?: string; summary?: string; mobileOnly: boolean }[] = [];
  for (const f of incomplete) {
    if (!(CONTRAST_RULES as readonly string[]).includes(f.id)) continue;
    for (const n of f.nodes) {
      if (seen.has(n.target)) continue;
      seen.add(n.target);
      out.push({ target: n.target, ...(n.html ? { html: n.html } : {}), ...(n.failureSummary ? { summary: n.failureSummary } : {}), mobileOnly: !n.viewports.includes('desktop') });
    }
  }
  return out.sort((a, b) => Number(a.mobileOnly) - Number(b.mobileOnly));
}

/** Why axe could not decide, in a few words, from its failure summary. */
export function axeReason(summary: string | undefined): string {
  const s = (summary ?? '').toLowerCase();
  if (/does not model/.test(s)) return 'a filter, blend mode, mask or first-line colour';
  if (/gradient/.test(s)) return 'a gradient';
  if (/background image/.test(s)) return 'a background image';
  if (/obscured|overlap/.test(s)) return 'overlapping content';
  if (/pseudo/.test(s)) return 'a pseudo-element';
  if (/text-shadow|shadow/.test(s)) return 'a text shadow';
  if (/opacity|alpha|transparen/.test(s)) return 'transparency';
  return 'a background axe could not read';
}

export type TextOutcome =
  | { kind: 'verdict'; verdict: Extract<TextVerdict, { kind: 'ok' | 'failed' }> }
  /** Outside the page's area (off-screen) or with no boxes at all: nothing to measure, and not mentioned. */
  | { kind: 'unseen' }
  /**
   * Not shown when measured, so nobody could see it then: not counted. Not on the page as loaded for the
   * test, not displayed or fully transparent (opacity 0 when measured), out of view in a carousel or scrolling area, or nothing of it shows (covered).
   */
  | { kind: 'unshown'; reason: Unshown }
  /** Shown, but its contrast could not be measured: counted against the page's measured share. */
  | { kind: 'unmeasured'; reason: Unmeasured };
type Unshown = 'missing' | 'hidden' | 'clipped' | 'covered' | 'invisible' | 'glyph';
type Unmeasured = Exclude<TextUnmeasured, 'covered'> | 'unmarked' | 'frame' | 'painted' | 'mobile' | 'limit' | 'time' | 'graphic';

const UNSHOWN_TEXT: Record<Unshown, string> = {
  missing: 'not on the page as loaded for the test',
  hidden: 'not displayed or fully transparent',
  clipped: 'out of view in a carousel or scrolling area',
  covered: 'covered by other content or transparent (showing it changed no pixels)',
  invisible: 'in exactly the colour of the background behind all of it, so it is not visible to anyone (incidental text)',
  glyph: 'content marked as a graphic or hidden from assistive technology',
};

const REASON_TEXT: Record<Unmeasured, string> = {
  moving: 'the area behind it kept changing although the page was held still (video, animation or loading content)',
  small: 'too few of its letter pixels show to measure (very small, or mostly covered)',
  close: 'its color could not be confirmed in the pixels and the result is too close to the threshold',
  shadow: 'it has a text shadow in a contrasting color, which may outline it',
  unmarked: 'its letters could not be redrawn for the screenshots, so they could not be found in them',
  frame: 'it is inside a frame from another site',
  painted: 'its letters are painted with a background image or gradient (background-clip: text)',
  graphic: 'whether these characters are text or graphical symbols could not be established',
  mobile: 'the phone-width layout could not be opened',
  limit: `it is further down the page than the ${TEXT_CONTRAST_LIMITS.positions} places the test measures`,
  time: 'the time for this test ran out first',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface TextItem {
  target: string;
  summary?: string;
  text?: string;
  fontSize?: number;
  /** Measured at the phone width (axe found it only there). */
  mobile?: boolean;
  outcome: TextOutcome;
}

/** More than this share of the shown elements unmeasured, and no failure, makes the page not testable. */
export const TEXT_UNMEASURED_SHARE = 1 / 3;

/**
 * The findings for one page from the outcomes per element:
 * - each measured element below its threshold gives a failed finding;
 * - with no failure, the page is not testable only when more than a third of the shown elements
 *   could not be measured (`TEXT_UNMEASURED_SHARE`), otherwise no failures were found;
 * - elements not shown when measured (`unshown`) and off-screen ones are not counted, but a page where
 *   none of them was found at all is not testable;
 * - a summary finding lists the counts and the reasons whenever something was not measured.
 */
export function textContrastFindings(all: readonly TextItem[]): ProbeFinding[] {
  const listed = all.filter((it) => it.outcome.kind !== 'unseen');
  const out: ProbeFinding[] = [];
  for (const it of listed) {
    if (it.outcome.kind !== 'verdict' || it.outcome.verdict.kind !== 'failed') continue;
    const v = it.outcome.verdict;
    const size = it.fontSize ? `${Math.round(it.fontSize * 10) / 10} px ` : '';
    const how = v.confirmed ? '' : ', color read from the screenshot';
    const where = it.mobile ? ' at the phone width' : '';
    out.push({
      criterion: '1.4.3', status: 'failed', target: it.target, data: { kind: 'backdrop' },
      detail: `Text contrast is ${ratioText(v.ratio)}${where} where it sits on ${axeReason(it.summary)} (text ${hex(v.fg)} on ${hex(v.bg)}${
        hex(v.dominant) !== hex(v.bg) ? `, mostly ${hex(v.dominant)}` : ''}${how}); `
        + `${size}text needs at least ${v.threshold}:1${it.text ? `: “${it.text}”` : ''}`,
    });
  }
  const measured = listed.filter((it) => it.outcome.kind === 'verdict').length;
  const unmeasured = listed.filter((it): it is TextItem & { outcome: { kind: 'unmeasured' } } => it.outcome.kind === 'unmeasured');
  const unshown = listed.filter((it): it is TextItem & { outcome: { kind: 'unshown' } } => it.outcome.kind === 'unshown');
  const shown = measured + unmeasured.length;
  if (!shown) {
    // Nothing found at all: the test cannot tell whether that text is still there to see.
    if (unshown.length && unshown.every((it) => it.outcome.reason === 'missing')) {
      return [{ criterion: '1.4.3', status: 'not_testable', target: unshown[0]!.target, detail: `none of the ${plural(unshown.length, 'text element')} axe could not decide was on the page as loaded for the test` }];
    }
    return [{ criterion: '1.4.3', status: 'no_failures_found', detail: 'the text axe could not decide is not shown on the page' }];
  }
  if (!unmeasured.length && !unshown.length) return out;
  const tally = <R extends string>(items: readonly { outcome: { reason: R } }[], words: Record<R, string>, lead: string) => {
    const counts = new Map<R, number>();
    for (const it of items) counts.set(it.outcome.reason, (counts.get(it.outcome.reason) ?? 0) + 1);
    return [...counts.entries()].map(([r, n]) => `${n} ${lead}${words[r]}`).join('; ');
  };
  const parts = [
    `axe could not decide the contrast of ${plural(listed.length, 'text element')} here; ${measured} measured from screenshots`,
    ...(unmeasured.length ? [`${plural(unmeasured.length, 'shown element')} could not be: ${tally(unmeasured, REASON_TEXT, 'because ')}`] : []),
    ...(unshown.length ? [`${plural(unshown.length, 'element')} not shown when measured, so not counted: ${tally(unshown, UNSHOWN_TEXT, '')}`] : []),
  ];
  // Text the time box left unmeasured is unknown, whatever its share: never a clean page (a faster
  // browser might have found it failing). Failures found stand.
  const untestable = unmeasured.length > TEXT_UNMEASURED_SHARE * shown || unmeasured.some((it) => it.outcome.reason === 'time');
  if (out.length) {
    // The failures decide the page; the summary says what else was or was not measured.
    if (untestable) out.push({ criterion: '1.4.3', status: 'not_testable', target: unmeasured[0]!.target, detail: parts.join('; ') });
    return out;
  }
  if (untestable) return [{ criterion: '1.4.3', status: 'not_testable', target: unmeasured[0]!.target, detail: parts.join('; ') }];
  return [{ criterion: '1.4.3', status: 'no_failures_found', detail: parts.join('; ') }];
}

/** What `measureTexts` needs from the probe context. */
type Ctx = Pick<ProbeContext, 'page' | 'deadline' | 'signal' | 'viewport' | 'evidence' | 'evidenceWanted' | 'evidenceHome' | 'cdp' | 'keep'>;

/** The failed findings among the outcomes so far (as `textContrastFindings` words them). */
function failedSoFar(outcomes: ReadonlyMap<string, TextOutcome>, located: ReadonlyMap<string, TextTarget>): ProbeFinding[] {
  const items: TextItem[] = [];
  for (const [target, outcome] of outcomes) {
    if (outcome.kind !== 'verdict' || outcome.verdict.kind !== 'failed') continue;
    const loc = located.get(target);
    if (loc?.graphicFont || loc?.graphicUnknown) continue;
    items.push({ target, ...(loc?.text ? { text: loc.text } : {}), ...(loc?.fontSize ? { fontSize: loc.fontSize } : {}), outcome });
  }
  return textContrastFindings(items).filter((f) => f.status === 'failed');
}

/** "Contrast 2.9:1; text this size needs at least 4.5:1" (large text: 3:1). */
export function contrastCaption(v: { ratio: number; threshold: number }): string {
  return `Contrast ${ratioText(v.ratio)}; ${v.threshold < 4.5 ? 'large text' : 'text this size'} needs at least ${v.threshold}:1`;
}

/**
 * Report evidence for failing text in a batch, taken while the page is still held still and the text
 * shown (the same frame the test measured): the text's visible line boxes, boxed as one, with the
 * measured ratio in the caption; on the start page, its place on the first screen. Desktop width
 * only. Never throws.
 */
async function textEvidence(ctx: Ctx, failed: { ref: number; boxes: [number, number, number, number][]; verdict: { ratio: number; threshold: number }; text?: string }[]): Promise<void> {
  for (const f of failed) {
    try {
      if (ctx.evidenceHome) await shootElements(ctx as ProbeContext, { criterion: '1.4.3', handles: [{ key: SHOT_KEY, ref: f.ref }], alt: () => '', homeOnly: true, align: 'none' });
      if (!ctx.evidence || !(ctx.evidenceWanted?.('1.4.3') ?? false) || !timeFor(ctx, 2000)) continue;
      const parts = f.boxes.filter((b) => b[2] > 0 && b[3] > 0);
      if (!parts.length) continue;
      const x0 = Math.min(...parts.map((b) => b[0]));
      const y0 = Math.min(...parts.map((b) => b[1]));
      const box = { x: x0, y: y0, width: Math.max(...parts.map((b) => b[0] + b[2])) - x0, height: Math.max(...parts.map((b) => b[1] + b[3])) - y0 };
      const clip = cropAround([box], ctx.viewport);
      if (!clip) continue;
      const quoted = f.text ? ` “${cleanText(f.text, 80)}”` : '';
      await ctx.evidence({
        criterion: '1.4.3', clip, boxes: [{ x: box.x - clip.x, y: box.y - clip.y, width: box.width, height: box.height, kind: 'fail' }],
        caption: contrastCaption(f.verdict),
        alt: `The outlined text${quoted} has a contrast of ${ratioText(f.verdict.ratio)} with what is behind it, below the ${f.verdict.threshold}:1 it needs.`,
      });
    } catch {
      // Evidence never changes the result.
    }
  }
}

/**
 * Locates the targets, measures them in batches, and records an outcome per target. Always removes its marks.
 */
/**
 * Batch 18, round 2: letters painted by a gradient of plain colours over solid fills, decided from the gradient's
 * stops: every stop under the text's threshold fails (the lowest stop is reported), every stop at or above it
 * passes; otherwise not measured. Pure.
 */
export function stopsOutcome(st: NonNullable<TextTarget['stops']>): TextOutcome {
  const large = st.fontSize >= 24 || (st.fontSize >= 18.66 && st.fontWeight >= 700);
  const threshold = large ? 3 : 4.5;
  const back: Rgb = [Math.round(st.back[0]), Math.round(st.back[1]), Math.round(st.back[2])];
  const shown = st.colours.map((c): Rgb => [Math.round(c[0] * c[3] + back[0] * (1 - c[3])), Math.round(c[1] * c[3] + back[1] * (1 - c[3])), Math.round(c[2] * c[3] + back[2] * (1 - c[3]))]);
  const ratios = shown.map((c) => contrastRatio(c, back));
  const best = Math.max(...ratios);
  const worst = Math.min(...ratios);
  if (best < threshold) {
    const fg = shown[ratios.indexOf(best)]!;
    return { kind: 'verdict', verdict: { kind: 'failed', ratio: Math.round(best * 100) / 100, threshold, fg, bg: back, dominant: back, confirmed: true, pixels: 0 } };
  }
  if (worst >= threshold) {
    const fg = shown[ratios.indexOf(worst)]!;
    return { kind: 'verdict', verdict: { kind: 'ok', ratio: Math.round(worst * 100) / 100, threshold, fg, bg: back, dominant: back, confirmed: true, pixels: 0 } };
  }
  return { kind: 'unmeasured', reason: 'painted' };
}

async function measureTexts(ctx: Ctx, frozen: FrozenPage, targets: readonly { target: string; html?: string; asShown?: boolean }[], outcomes: Map<string, TextOutcome>, located: Map<string, TextTarget>, positions: number, pictures = false): Promise<number> {
  const page = ctx.page;
  const found = await page.evaluate(locateTexts, { key: SHOT_KEY, targets: targets.map((t) => t.target), html: targets.map((t) => t.html ?? '') });
  try {
    const controls = await graphicControlRefs(ctx, SHOT_KEY);
    const byRef = new Map<number, TextTarget>();
    for (const t of found) {
      if (controls.graphic.has(t.ref)) t.glyph = true;
      if (controls.unknown.has(t.ref)) t.graphicUnknown = true;
      located.set(t.target, t);
      if (t.why === 'missing' || t.why === 'hidden') outcomes.set(t.target, { kind: 'unshown', reason: t.why });
      else if (t.why === 'painted' && t.stops) outcomes.set(t.target, stopsOutcome(t.stops));
      else if (t.why) outcomes.set(t.target, { kind: 'unmeasured', reason: t.why });
      else if (t.glyph) outcomes.set(t.target, { kind: 'unshown', reason: 'glyph' });
      else byRef.set(t.ref, t);
    }
    // Batch 18, D17: text under a paint effect is judged as shown (its style colour is not what the screen shows).
    const asShown = new Set(targets.filter((x) => x.asShown).map((x) => located.get(x.target)?.ref).filter((r): r is number => r !== undefined));
    const order = [...byRef.values()].sort((a, b) => (a.y ?? 0) - (b.y ?? 0)).map((t) => t.ref);
    // A place starts only with room for the longest place so far plus a full picture wait (which the
    // places before may not have needed): a slow place never runs past the time box.
    const opts = { mode: 'text' as const, margin: 4, deadline: ctx.deadline, reserveMs: TEXT_CONTRAST_LIMITS.reserveMs + TEXT_CONTRAST_LIMITS.imagesMs, signal: ctx.signal, maxBatches: positions };
    // One CDP call per screenshot where the browser has a session (see `shoot`).
    const cdp = await ctx.cdp?.();
    const result = await eachBatch(page, order, opts, async (batch, clip, at) => {
      const via = { ...(cdp ? { cdp } : {}), at };
      const refs = batch.map((b) => ({ ref: b.ref, fill: !!byRef.get(b.ref)!.fill }));
      /** Elements whose colour is transparent (as read, unchanged since). */
      const clear = new Set<number>();
      /** Elements at opacity 0 (with their ancestors') when measured: not shown. */
      const faded = new Set<number>();
      // The pictures behind the text first (lazy ones start when scrolled to), so what is measured
      // is the page people see, not a placeholder that the network had not replaced yet.
      await before(page.evaluate(imagesReady, { key: SHOT_KEY, refs: batch.map((b) => b.ref), clip, maxMs: TEXT_CONTRAST_LIMITS.imagesMs }), Date.now() + TEXT_CONTRAST_LIMITS.imagesMs + 1500);
      const measure = async () => {
        // Scrolling may have started animations (content revealed on scrolling): held too.
        await frozen.settle();
        const shown = await shoot(page, clip, via);
        const mark = (state: 'text' | 'black' | 'white' | 'show') => page.evaluate(markElements, { key: SHOT_KEY, refs, state });
        let black: RgbaImage;
        let white: RgbaImage;
        let hidden: RgbaImage;
        let now: MarkedState[] = [];
        try {
          await mark('black');
          black = await shoot(page, clip, via);
          await mark('white');
          white = await shoot(page, clip, via);
          await mark('text');
          hidden = await shoot(page, clip, via);
        } finally {
          // Opacity and colours as shown now: the same in the screenshots before and after, or they count as moving.
          now = await mark('show');
        }
        const again = await shoot(page, clip, via);
        return batch.map((b, i) => {
          const t = byRef.get(b.ref)!;
          const state = now[i];
          if (state && state.opacity <= 0) faded.add(b.ref);
          else faded.delete(b.ref);
          // A colour that changed since the page was read (an effect that ran on scrolling) is not trusted.
          const trusted = !!state && state.color === t.colors && !asShown.has(b.ref);
          const fg: Rgba = trusted ? t.fg ?? [0, 0, 0, 0] : [0, 0, 0, 0];
          if (trusted && t.fg && t.fg[3] === 0 && !t.fill) clear.add(b.ref);
          return textContrast({ shown, hidden, black, white, again }, toImageBoxes(b.boxes, clip, shown), {
            fg, opacity: state?.opacity ?? 1, large: isLargeText(t.fontSize ?? 16, t.fontWeight ?? 400), shadow: !!t.shadow,
            ...(clear.has(b.ref) ? { transparent: true } : {}),
          });
        });
      };
      let verdicts = await measure();
      if (verdicts.some((v) => v.kind === 'unmeasured' && v.reason === 'moving') && Date.now() < ctx.deadline - TEXT_CONTRAST_LIMITS.reserveMs - 1000) {
        await page.waitForTimeout(TEXT_CONTRAST_LIMITS.retryMs);
        verdicts = await measure();
      }
      batch.forEach((b, i) => {
        const v = verdicts[i]!;
        const target = byRef.get(b.ref)!.target;
        // Nothing of it showed in the screenshots: not seen when something else is on top of it there
        // (or it is transparent). Otherwise the page drew its letters in a way the marks did not reach.
        // Text at opacity 0 when measured (a slide faded out) is not shown, whatever the pixels say.
        const out: TextOutcome = faded.has(b.ref) ? { kind: 'unshown', reason: 'hidden' }
          : v.kind !== 'unmeasured' ? { kind: 'verdict', verdict: v }
          : v.reason !== 'covered' ? { kind: 'unmeasured', reason: v.reason }
            : b.covered || clear.has(b.ref) ? { kind: 'unshown', reason: 'covered' } : { kind: 'unmeasured', reason: 'unmarked' };
        outcomes.set(target, out);
      });
      // The failures so far stand even if the time box then cuts the run.
      ctx.keep?.(failedSoFar(outcomes, located));
      // Pictures of this batch's failures while the page still shows them as measured.
      if (pictures) {
        const failed = batch.flatMap((b) => {
          const o = outcomes.get(byRef.get(b.ref)!.target);
          return o?.kind === 'verdict' && o.verdict.kind === 'failed' ? [{ ref: b.ref, boxes: b.boxes, verdict: o.verdict, ...(byRef.get(b.ref)!.text ? { text: byRef.get(b.ref)!.text } : {}) }] : [];
        });
        if (failed.length) await textEvidence(ctx, failed);
      }
    }, (ref, cause) => {
      outcomes.set(byRef.get(ref)!.target, cause === 'offpage' || cause === 'none' ? { kind: 'unseen' } : { kind: 'unshown', reason: 'clipped' });
    });
    // Past the fixed number of places: not measured, the same on any machine (time ran out: 'time', the default).
    if (result.cut === 'limit') for (const ref of result.left) outcomes.set(byRef.get(ref)!.target, { kind: 'unmeasured', reason: 'limit' });
    return result.batches;
  } finally {
    await page.evaluate(markElements, { key: SHOT_KEY, refs: [], state: 'drop' as const }).catch(() => {});
  }
}

/** One element's result in a few words, for the run's data. */
function outcomeWord(o: TextOutcome): string {
  if (o.kind === 'verdict') return `${o.verdict.kind} ${ratioText(o.verdict.ratio)}`;
  return o.kind === 'unseen' ? 'off-screen' : `${o.kind}: ${o.reason}`;
}

/**
 * Measures, from screenshots, the text whose colour contrast axe could not decide on this page
 * (`color-contrast` in the audit's undecided results, at most 30): at the desktop width, then (for
 * elements axe found only at the phone width) at 390×844, as in the audit. First the page is held
 * still (`freezePage`): background video and audio paused on their first frame, animations paused on
 * a fixed frame, transitions off and the page's timers of 1 s or more (carousels) held; it plays
 * again when the test ends. axe's elements are found by its selectors (and, for ids the page
 * generates anew on each load, by the same selector and markup without the ids). For each batch of
 * elements in view: a screenshot with the text shown, one with the text made transparent (the
 * background behind every letter shows), one with it drawn in black and one in white (where the
 * letters are), and one shown again (movement check); see `textContrast` for the rules. Below 4.5:1
 * (3:1 for large text) is failed. Elements not shown when measured (not on the page, not displayed or fully transparent,
 * out of view in a carousel, or covered so that showing them changes no pixel) are not counted, nor
 * is off-screen text. With no failure, the page is not testable only when more than a third of the
 * shown elements could not be measured (`textContrastFindings`). A page where axe decided every
 * element gives no_failures_found, so the criterion counts as checked there. Runs on every page that
 * loaded (`everyPage`). A request the guard blocks cannot change a screenshot, so only a navigation
 * the guard holds voids the result (`onlyNavigationVoids`).
 */
export const textContrastProbe: PageProbe = {
  id: 'text-contrast',
  criteria: ['1.4.3'],
  kind: 'pixels',
  tier: 'core',
  // A safety net: a page measures in a few seconds even on a remote browser (CDP screenshots, at most
  // `positions` places), so the time box decides which text is measured only on a browser far slower
  // than that; then failures found stand (`ctx.keep`) and the rest is not testable, never clean.
  timeoutMs: 45_000,
  // Text over photos, gradients and video is often on one page only, so it runs on every page that loaded.
  everyPage: true,
  onlyNavigationVoids: true,
  // It measures the text axe left undecided once the page had mounted (the audit looks again then): a page still
  // putting its content in is waited for first (bounded, `LATE_CONTENT_MS`), as for the layout tests. Before, it
  // looked at the empty shell, found none of that text and left the page untested (the simulation lab's
  // late-mounting pages with text over a picture or a gradient). A page that is not mounting answers at once.
  waitFor: { content: true },
  async run(ctx: ProbeContext): Promise<ProbeFinding[]> {
    if (!ctx.incomplete) throw new ProbeNotTestable('the audit’s undecided axe results were not available to this test');
    // Page-load pop-ups (popupAside.ts): discover and dismiss, then measure the cleared page.
    const found = await findPopups(ctx);
    if (found.boxes.length > 1) return multiplePopups(ctx, found, '1.4.3');
    if (found.box) return textWithPopups(ctx, { boxes: found.boxes, box: found.box });
    const undecided = undecidedTexts(ctx.incomplete).slice(0, TEXT_CONTRAST_LIMITS.elements);
    const { placeholders, unmeasured } = await ownColours(ctx);
    // Batch 18, D17: text under a paint effect axe does not model is measured from screenshots too.
    const known = new Set(undecided.map((t) => t.target));
    const effects = (await ctx.page.evaluate(paintEffectTargets, { max: PAINT_EFFECT_MAX, exemptKey: CONTRAST_EXEMPT_KEY }).catch(() => []))
      .filter((t) => !known.has(t.target)).map((t) => ({ ...t, mobileOnly: false, asShown: true }));
    const all = [...undecided, ...effects].slice(0, TEXT_CONTRAST_LIMITS.elements + PAINT_EFFECT_MAX);
    // A first line or first letter in its own faint colour (decided from the styles: these parts cannot be redrawn).
    const firstParts = (await ctx.page.evaluate(faintFirstParts, { max: 4, exemptKey: CONTRAST_EXEMPT_KEY }).catch(() => [])).map((f): ProbeFinding => ({
      criterion: '1.4.3', status: 'failed', target: f.target, data: { kind: 'plain' },
      detail: `The ${f.part} of this text is coloured ${f.fg} on ${f.bg} (${f.ratio.toFixed(1)}:1); text needs at least ${f.threshold}:1: “${f.text}”`,
    }));
    if (firstParts.length) {
      placeholders.push(...firstParts);
      ctx.keep?.(placeholders);
    }
    if (placeholders.length) ctx.keep?.(placeholders);
    // Checked: axe settled every text on the page, so nothing is left for the pixels to fail.
    if (!all.length) {
      const dark = await darkSchemeText(ctx);
      return discoveryDetails(ctx, found, placeholders.length || unmeasured.length || dark.length ? [...placeholders, ...unmeasured, ...dark]
        : [{ criterion: '1.4.3', status: 'no_failures_found', detail: 'axe decided the contrast of all text on this page' }]);
    }
    // The failures kept if the run is cut include the placeholders'.
    const kept = ctx.keep;
    if (kept && placeholders.length) ctx = { ...ctx, keep: (fs) => kept([...placeholders, ...fs]) };
    const mark = ctx.guard.mark();
    const look = newLook();
    const frozen = await freezePage(ctx.page);
    try {
      await measureAll(ctx, frozen, all, look, true);
    } finally {
      // A page whose hold could not be confirmed undone (a call into it never answered) may still be
      // held: no later probe uses it (the runner gives them a fresh page).
      if (!(await frozen.thaw())) ctx.discardPage?.();
    }
    const items = itemsFor(ctx, all, look);
    ctx.setData?.({ held: frozen.held, items: items.map((it) => ({ target: it.target.slice(0, 120), result: outcomeWord(it.outcome) })) });
    const dark = await darkSchemeText(ctx);
    return discoveryDetails(ctx, found, guarded(ctx, mark, [...placeholders, ...textContrastFindings(items), ...unmeasured, ...dark], true));
  },
};

/** Text failures reported from the dark colour scheme, at most. */
const DARK_MAX = 8;

/**
 * Batch 18, D1 (docs/atlas/visual.md): text contrast in the page's own dark colour scheme. Only a page whose style
 * sheets define one (`readInventory`) is switched; there axe's colour-contrast rule runs again (its exemptions
 * included) and the text it cannot decide is measured from screenshots as at rest. Each failure names the presentation.
 * What could not be measured there leaves the result at rest as it is (a note in the detail), never a clean claim
 * about the dark scheme. Never throws: a page that cannot be switched gives nothing.
 */
export async function darkSchemeText(ctx: ProbeContext): Promise<ProbeFinding[]> {
  if (!ctx.axeSource || ctx.signal.aborted || Date.now() > ctx.deadline - TEXT_CONTRAST_LIMITS.reserveMs - 6000) return [];
  try {
    return await eachPresentation(ctx, async (where) => {
      const options: AxeOptions = { runOnly: { type: 'rule', values: [...CONTRAST_RULES] }, rules: {}, resultTypes: ['violations', 'incomplete'] };
      const r = await runAxe(ctx.page, ctx.axeSource!, AXE_AGAIN_FRAMES, { site: ctx.url, options });
      const merged = mergeViewportRuns([{ viewport: 'desktop', run: r.run }]);
      const out: ProbeFinding[] = [];
      for (const v of merged.violations) {
        if (!(CONTRAST_RULES as readonly string[]).includes(v.id)) continue;
        for (const n of v.nodes) {
          if (out.length >= DARK_MAX) break;
          out.push({ criterion: '1.4.3', status: 'failed', target: n.target, data: { kind: 'dark' }, detail: `Text contrast fails ${where}: ${(n.failureSummary ?? '').replace(/^Fix any of the following:\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 240)}` });
        }
      }
      // A first line or letter in its own colour there too (Sol r1, F2).
      await ctx.page.evaluate(installContrastExempt, CONTRAST_EXEMPT_KEY).catch(() => {});
      for (const f of await ctx.page.evaluate(faintFirstParts, { max: 2, exemptKey: CONTRAST_EXEMPT_KEY }).catch(() => [])) {
        if (out.length >= DARK_MAX || out.some((o) => o.target === f.target)) continue;
        out.push({ criterion: '1.4.3', status: 'failed', target: f.target, data: { kind: 'dark' }, detail: `The ${f.part} of this text is coloured ${f.fg} on ${f.bg} (${f.ratio.toFixed(1)}:1) ${where}; text needs at least ${f.threshold}:1: “${f.text}”` });
      }
      const undecided = undecidedTexts(merged.incomplete).filter((t) => !t.mobileOnly).slice(0, TEXT_CONTRAST_LIMITS.elements);
      if (undecided.length && out.length < DARK_MAX && Date.now() < ctx.deadline - TEXT_CONTRAST_LIMITS.reserveMs - 3000) {
        const look = newLook();
        const frozen = await freezePage(ctx.page);
        try {
          await measureAll(ctx, frozen, undecided, look, false);
        } finally {
          if (!(await frozen.thaw())) ctx.discardPage?.();
        }
        for (const f of textContrastFindings(itemsFor(ctx, undecided, look))) {
          if (f.status !== 'failed' || out.length >= DARK_MAX) continue;
          out.push({ ...f, data: { ...f.data, kind: 'dark' }, detail: `${f.detail} (${where})` });
        }
      }
      return out;
    });
  } catch {
    return [];
  }
}

type Undecided = ReturnType<typeof undecidedTexts>[number];

/**
 * What axe does not look at, decided from the page's own colours where they leave no doubt (no screenshots), on the
 * page as it is now (with no page-load pop-up, or with it dismissed). Placeholder text (`placeholderContrast.ts`; one
 * call into the page). And text in the states the page gives it: with the pointer on something or with keyboard focus,
 * and text shown only then (`stateContrast.ts`; read from the styles' colours, a `minor` failure). What they find but
 * cannot measure (a picture behind the text, no way to hold the pointer state, a style sheet that cannot be read) is a
 * gap (`unmeasured`): the page is then not testable for 1.4.3 unless a failure decides it, and the test never says
 * axe decided all text.
 */
async function ownColours(ctx: ProbeContext): Promise<{ placeholders: ProbeFinding[]; unmeasured: ProbeFinding[] }> {
  const gaps: Gaps = new Map();
  const placeholders: ProbeFinding[] = [];
  try {
    await ctx.page.evaluate(installContrastExempt, CONTRAST_EXEMPT_KEY);
    await ctx.page.evaluate(installContrastKit, CONTRAST_KIT_KEY);
    const fields = placeholderFindings(await ctx.page.evaluate(placeholderFields, { max: PLACEHOLDER_LIMITS.fields, exemptKey: CONTRAST_EXEMPT_KEY, kitKey: CONTRAST_KIT_KEY }));
    placeholders.push(...fields.findings);
    for (const [why, n] of fields.gaps) addGap(gaps, why, n);
  } catch {
    addGap(gaps, 'the page’s placeholder text could not be read');
  }
  const states = await stateContrast(ctx);
  placeholders.push(...states.findings);
  for (const [why, n] of states.gaps) addGap(gaps, why, n);
  const unmeasured: ProbeFinding[] = gaps.size ? [{ criterion: '1.4.3', status: 'not_testable', detail: `Text contrast was not fully measured: ${gapsText(gaps)}` }] : [];
  return { placeholders, unmeasured };
}

/** One look's measurements, by axe target. */
interface Look { outcomes: Map<string, TextOutcome>; located: Map<string, TextTarget> }
const newLook = (): Look => ({ outcomes: new Map(), located: new Map() });

/**
 * Measures `list` at the desktop width, then (elements axe found only at the phone width) at 390x844, within the fixed
 * number of places (`TEXT_CONTRAST_LIMITS.positions`). `pictures`: the report's pictures of failures (desktop width).
 */
async function measureAll(ctx: Ctx, frozen: FrozenPage, list: readonly Undecided[], look: Look, pictures: boolean): Promise<void> {
  const { outcomes, located } = look;
  const desktop = list.filter((t) => !t.mobileOnly);
  const mobile = list.filter((t) => t.mobileOnly);
  let positions: number = TEXT_CONTRAST_LIMITS.positions;
  if (desktop.length) positions -= await measureTexts(ctx, frozen, desktop, outcomes, located, positions, pictures);
  if (mobile.length && !positions) for (const t of mobile) outcomes.set(t.target, { kind: 'unmeasured', reason: 'limit' });
  else if (mobile.length && ctx.page.setViewportSize && Date.now() < ctx.deadline - TEXT_CONTRAST_LIMITS.reserveMs - 1000) {
    const { width, height } = ctx.viewport;
    try {
      await ctx.page.setViewportSize({ ...MOBILE_VIEWPORT });
      await ctx.page.waitForTimeout(400);
      await measureTexts(ctx, frozen, mobile, outcomes, located, positions, false);
    } finally {
      await ctx.page.setViewportSize({ width, height });
      await ctx.page.waitForTimeout(200);
    }
  }
}

/** The items for the findings, one per element of `list`, with the outcome its look gave it. */
function itemsFor(ctx: Pick<ProbeContext, 'page'>, list: readonly Undecided[], look: Look): TextItem[] {
  return list.map((t): TextItem => {
    const loc = look.located.get(t.target);
    const fallback: TextOutcome = { kind: 'unmeasured', reason: t.mobileOnly && !ctx.page.setViewportSize ? 'mobile' : 'time' };
    return {
      target: t.target, ...(t.summary ? { summary: t.summary } : {}), ...(loc?.text ? { text: loc.text } : {}),
      ...(loc?.fontSize ? { fontSize: loc.fontSize } : {}), ...(t.mobileOnly ? { mobile: true } : {}),
      outcome: incidental(look.outcomes.get(t.target) ?? fallback, loc, t.summary),
    };
  });
}

/** Time kept for axe's second run (desktop and phone width) on top of a look like the first. */
const AXE_AGAIN_MS = 4000;
/** Frames axe's second run tests at most, and the time it gives them (a frame it could not test: look 2 is incomplete). */
const AXE_AGAIN_FRAMES = { maxFrames: 20, frameTimeoutMs: 5_000, totalMs: 8_000 } as const;

/** Look 1 excludes the box's own audit targets by DOM ancestry, including shadow roots and frames. */
async function outsidePopupTexts(ctx: ProbeContext, box: PopupBox): Promise<Undecided[]> {
  const original = undecidedTexts(ctx.incomplete ?? []);
  const located = await ctx.page.evaluate(locateTexts, {
    key: SHOT_KEY, targets: [...original.map((t) => t.target), box.path],
    html: [...original.map((t) => t.html ?? ''), ''], identityOnly: true,
  });
  try {
    const boxRef = located[original.length]!.ref;
    if (boxRef < 0) throw new ProbeNotTestable('the pop-up box could not be identified before dismissal');
    const inside = await ctx.page.evaluate(({ key, refs, boxRef }) => {
      const store = (window as unknown as Record<string, Element[]>)[key] ?? [];
      const box = store[boxRef];
      return refs.map((ref) => {
        for (let n: Node | null = store[ref] ?? null, k = 0; n && k < 10_000; k++) {
          if (n === box) return true;
          n = n.parentNode ?? (n as ShadowRoot).host ?? (n.nodeType === 9 ? (n as Document).defaultView?.frameElement ?? null : null);
        }
        return false;
      });
    }, { key: SHOT_KEY, refs: located.slice(0, original.length).map((t) => t.ref), boxRef });
    return original.filter((_, i) => !inside[i]);
  } finally {
    await ctx.page.evaluate(markElements, { key: SHOT_KEY, refs: [], state: 'drop' as const });
  }
}

/** A page with a page-load pop-up: discover and dismiss it, then measure only the cleared page. */
async function textWithPopups(ctx: ProbeContext, found: { boxes: PopupBox[]; box: PopupBox }): Promise<ProbeFinding[]> {
  const mark = ctx.guard.mark();
  const original = await outsidePopupTexts(ctx, found.box);
  const windows: { from: number; to?: number }[] = [{ from: mark, to: ctx.guard.mark() }];
  const t1 = Date.now();
  const aside = timeForAside(ctx, AXE_AGAIN_MS, TEXT_CONTRAST_LIMITS.reserveMs)
    ? await setPopupAside(ctx, found)
    : notAside(ctx, found, INCOMPLETE.unfinished);
  let frozen: FrozenPage | undefined;
  let two: { list: Undecided[]; look: Look; missing: string[]; own: { placeholders: ProbeFinding[]; unmeasured: ProbeFinding[] } } | null = null;
  try {
    if (aside.dismissed) {
      windows.push({ from: aside.mark });
      try {
        const again = await undecidedAgain(ctx, original);
        const list = again.list.slice(0, TEXT_CONTRAST_LIMITS.elements);
        // Placeholders and text in its pointer and focus states, read on the cleared page as on a page with no pop-up.
        const own = await ownColours(ctx);
        let measuring: ProbeContext = ctx;
        if (own.placeholders.length) {
          ctx.keep?.(own.placeholders);
          const kept = ctx.keep;
          if (kept) measuring = { ...ctx, keep: (fs) => kept([...own.placeholders, ...fs]) };
        }
        frozen = await freezePage(ctx.page);
        const look = newLook();
        if (list.length) await measureAll(measuring, frozen, list, look, true);
        two = { list, look, missing: again.missing, own };
      } catch (err) {
        if (ctx.signal.aborted) throw err;
      }
    }
  } finally {
    if (frozen && !(await frozen.thaw())) ctx.discardPage?.();
  }
  let findings: ProbeFinding[];
  const items = two ? itemsFor(ctx, two.list, two.look) : [];
  if (!aside.dismissed) findings = incomplete('1.4.3', aside.why ?? INCOMPLETE.stayed);
  else if (!two) findings = incomplete('1.4.3', INCOMPLETE.unfinished);
  else {
    const { placeholders, unmeasured } = two.own;
    findings = [
      ...placeholders,
      ...(items.length ? textContrastFindings(items)
        : placeholders.length || unmeasured.length ? [] : [{ criterion: '1.4.3', status: 'no_failures_found', detail: 'no additional contrast failures found in the text axe left undecided' } as ProbeFinding]),
      ...unmeasured,
    ];
    // A target may disappear between identification and measurement too. Neither absence is a pass.
    const missing = new Set([...two.missing, ...[...two.look.located.values()].filter((t) => t.why === 'missing').map((t) => t.target)]);
    if (missing.size) {
      findings = findings.filter((f) => f.status !== 'no_failures_found');
      findings.push(...[...missing].map((target): ProbeFinding => ({
        criterion: '1.4.3', status: 'not_testable', target,
        detail: 'text axe left undecided could not be found on the page in the second look',
      })));
    }
  }
  ctx.setData?.({ held: frozen?.held, items: items.map((it) => ({ target: it.target.slice(0, 120), result: outcomeWord(it.outcome) })), ...asideData(aside, Date.now() - t1) });
  return guardedIn(ctx, windows, findings, true);
}

/**
 * Look 2 discovers axe's undecided text afresh. Text undecided in the audit or at either fresh width that axe now
 * fails is also measured, keeping the failing viewport first. Fresh violations are never scored directly. A third-party
 * frame with unresolved contrast cannot be measured by this probe, so it makes look 2 incomplete.
 */
async function undecidedAgain(ctx: ProbeContext, original: Undecided[]): Promise<{ list: Undecided[]; missing: string[] }> {
  if (!ctx.axeSource) throw new Error('axe is not available to this test');
  const options: AxeOptions = { runOnly: { type: 'rule', values: [...CONTRAST_RULES] }, rules: {}, resultTypes: ['violations', 'incomplete'] };
  const once = async () => {
    const r = await runAxe(ctx.page, ctx.axeSource!, AXE_AGAIN_FRAMES, { site: ctx.url, options });
    if (r.untestedFrames.length) throw new Error(`axe could not test a frame (${r.untestedFrames[0]!.reason})`);
    if (r.thirdParty.some((f) => f.run.violations.length || f.run.incomplete.length)) throw new Error('contrast in a third-party frame could not be established');
    return r.run;
  };
  const runs: { viewport: 'desktop' | 'mobile'; run: AxeRun }[] = [{ viewport: 'desktop', run: await once() }];
  if (ctx.page.setViewportSize) {
    const { width, height } = ctx.viewport;
    try {
      await ctx.page.setViewportSize({ ...MOBILE_VIEWPORT });
      await ctx.page.waitForTimeout(400);
      runs.push({ viewport: 'mobile', run: await once() });
    } finally {
      await ctx.page.setViewportSize({ width, height });
      await ctx.page.waitForTimeout(200);
    }
  }
  const merged = mergeViewportRuns(runs);
  const fresh = undecidedTexts([...merged.violations, ...merged.incomplete]);
  const all = [...original, ...fresh];
  // The existing locator can recover generated selectors from the audit's markup. Compare the actual DOM
  // elements it found, so an alias remains eligible without scoring unrelated fresh axe violations.
  const located = await ctx.page.evaluate(locateTexts, { key: SHOT_KEY, targets: all.map((t) => t.target), html: all.map((t) => t.html ?? '') });
  let matches: boolean[];
  try {
    matches = await ctx.page.evaluate(({ key, original, fresh }) => {
      const store = (window as unknown as Record<string, Element[]>)[key] ?? [];
      const known = new Set(original.filter((ref) => ref >= 0).map((ref) => store[ref]));
      return fresh.map((ref) => ref >= 0 && known.has(store[ref]));
    }, { key: SHOT_KEY, original: located.slice(0, original.length).map((t) => t.ref), fresh: located.slice(original.length).map((t) => t.ref) });
  } finally {
    await ctx.page.evaluate(markElements, { key: SHOT_KEY, refs: [], state: 'drop' as const }).catch(() => {});
  }
  const undecided = new Set([
    ...original.map((t) => t.target), ...undecidedTexts(merged.incomplete).map((t) => t.target),
    ...fresh.filter((_, i) => matches[i]).map((t) => t.target),
  ]);
  const failing = merged.violations.map((f) => ({ ...f, nodes: f.nodes.filter((n) => undecided.has(n.target)) }));
  // A failure's viewport must win over another width's incomplete result for the same target (R4 5B).
  return {
    list: undecidedTexts([...failing, ...merged.incomplete]),
    missing: located.slice(0, original.length).filter((t) => t.ref < 0).map((t) => t.target),
  };
}

/**
 * Text 1.4.3 does not apply to (2026-11-09 benchmark review), not counted: a lone character used as an icon
 * (`TextTarget.glyph`), and text whose colour the page sets to its background's (axe's 1:1 reason), measured so too behind all of it (the
 * lowest contrast part and most of it alike), which WCAG's "incidental" exception names as not visible to anyone. White
 * text half over black is visible there and is measured as before.
 */
export function incidental(o: TextOutcome, loc: Pick<TextTarget, 'glyph' | 'graphicFont' | 'graphicUnknown'> | undefined, summary: string | undefined): TextOutcome {
  if (o.kind !== 'verdict') return o;
  if (loc?.glyph) return { kind: 'unshown', reason: 'glyph' };
  const v = o.verdict;
  if ((loc?.graphicFont || loc?.graphicUnknown) && v.kind === 'failed') return { kind: 'unmeasured', reason: 'graphic' };
  // Only when the page's own colours make it so (axe: "a 1:1 contrast ratio with the background"): white words over
  // a light photo or video are content that cannot be read, and fail, even when the pixels behind them are white.
  if (v.kind === 'failed' && EQUAL_COLOURS.test(summary ?? '') && hex(v.fg) === hex(v.bg) && hex(v.fg) === hex(v.dominant)) return { kind: 'unshown', reason: 'invisible' };
  return o;
}

/** axe's reason for leaving text undecided when its colour is its background's (`equalRatio`). */
const EQUAL_COLOURS = /1:1 contrast ratio/i;

/**
 * The findings, unless the request guard stopped something while the test ran (as for the render
 * probes): a held navigation makes the page unmeasured; a blocked request (not a beacon, not the
 * page's own background traffic) may have kept content from loading, so a clean result is
 * not_testable. `navigationOnly`: blocked requests cannot change what the test reads (styles, or
 * screenshots: the guard stops a request, so its answer never reaches the page).
 */
export function guarded(ctx: Pick<ProbeContext, 'guard'>, mark: number, findings: ProbeFinding[], navigationOnly = false): ProbeFinding[] {
  const stopped = stoppedSince(ctx.guard, mark);
  if (!stopped || (navigationOnly && !stopped.navigation)) return findings;
  if (stopped.navigation || !findings.some((f) => f.status === 'failed')) throw new ProbeNotTestable(stopped.reason);
  return findings;
}

/**
 * `guarded` over windows of the guard log (`to` undefined: up to now): a test that set a page-load pop-up
 * aside rests on its first look and its second, not on the dismissal between them (which `proveDismiss`
 * judges itself: anything the guard held there means the pop-up stayed).
 */
export function guardedIn(ctx: Pick<ProbeContext, 'guard'>, windows: readonly { from: number; to?: number }[], findings: ProbeFinding[], navigationOnly = false): ProbeFinding[] {
  const stops = windows.map((w) => (w.to === undefined ? stoppedSince(ctx.guard, w.from) : stoppedBetween(ctx.guard, w.from, w.to))).filter((x) => !!x);
  const stopped = stops.find((x) => x.navigation) ?? stops[0];
  if (!stopped || (navigationOnly && !stopped.navigation)) return findings;
  if (stopped.navigation || !findings.some((f) => f.status === 'failed')) throw new ProbeNotTestable(stopped.reason);
  return findings;
}

/**
 * The audit's phone viewport (`VIEWPORTS` in report/build.ts, which imports the probe registry, so it
 * is not imported here; a unit test keeps them equal), where axe found the mobile-only elements.
 */
export const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
