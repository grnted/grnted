// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.11 Non-text contrast (Plan 4 Task 4.3): the boundaries of form fields the page styles,
// and the icons of controls that show only an icon, measured from screenshots against 3:1 with the
// colours next to them. Engine core: no Node-only imports.
// Focus indicators (also 1.4.11) are measured with the keyboard probe (Task 4.1): `changeContrast`
// in ./pixels.ts compares a screenshot without focus with one with focus.
import type { ProbeFinding } from '../types.js';
import { boundaryContrast, changeContrast, hex, isMoving, boxPixels, ratioText, MIN_ICON_PIXELS, NON_TEXT_THRESHOLD, type RgbaImage } from './pixels.js';
import { eachBatch, markElements, shoot, SHOT_KEY, toImageBoxes, type CssBox, type ViewItem } from './shots.js';
import { cleanText, cropAround, shootElements, timeFor } from './evidence.js';
import { asideData, discoveryDetails, multiplePopups, findPopups, incomplete, INCOMPLETE, notAside, setPopupAside, timeForAside, type PopupAside } from './popupAside.js';
import { guarded, guardedIn, MOBILE_VIEWPORT } from './textContrast.js';
import type { PageProbe, ProbeContext } from './types.js';
import { graphicControlRefs } from './graphicControls.js';
import { eachPresentation } from './presentations.js';
import { CHART_LIMITS, chartSeriesFindings, faintChartSeries } from './chartMarks.js';
import { faintIndicators, indicatorFindings } from './stateIndicators.js';
import { inOwnFrames } from './ownFrameEval.js';

export const NON_TEXT_LIMITS = {
  /** Elements measured per page and width, by kind, in page order. More of a kind than this is reported as not measured, never as clean. */
  fields: 40,
  toggles: 20,
  icons: 40,
  /** Controls beyond those limits that are still listed (so they can be counted and told apart by width). */
  listed: 400,
  /** Icon-only controls: their box is 8–96 px on each side, and an image or SVG in them at most 64 px and 2.5 times as wide as tall. */
  iconMin: 8,
  iconMax: 96,
  graphicMax: 64,
  graphicAspect: 2.5,
  reserveMs: 1500,
  retryMs: 400,
  /**
   * The second look, at the phone width: only with this much of the test's time left, after waiting
   * `phoneSettleMs` for the narrow layout (and `phoneBackMs` for the desktop one again).
   */
  phoneLeftMs: 5000,
  phoneSettleMs: 400,
  phoneBackMs: 200,
} as const;

/**
 * Debug timing, off by default: when `phone` is set, each look at the phone width (changing the viewport, its settle
 * and back waits, finding and measuring the controls there) reports its page, how long it took and how many controls
 * it measured. Nothing is timed or kept when it is unset. A measurement harness sets it (the batch 15b follow-up
 * measured what the every-page phone look costs).
 */
export const NON_TEXT_TIMING: { phone?: (e: { url: string; ms: number; measured: number }) => void } = {};

/** `NON_TEXT_LIMITS` with other numbers (the forced-colours probe measures fewer controls). */
export type NonTextLimits = { readonly [K in keyof typeof NON_TEXT_LIMITS]: number };

/** A control the probe measures, as the page reports it. */
export interface NonTextTarget {
  ref: number;
  /** 'field': text field, text area or select; 'toggle': a checkbox or radio button drawn by the page; 'icon': a control that shows only an icon. */
  kind: 'field' | 'toggle' | 'icon';
  path: string;
  /** Accessible name or label (max 80), for the report. */
  name: string;
  /** How the icon is drawn (icons only): 'svg', 'img', 'icon font', 'background image' or 'symbol'. */
  graphic?: string;
  /** The icon is the control's own CSS background image. */
  bg?: boolean;
  /** The control itself is cut to the icon's shape (CSS mask): hiding it shows what is behind. */
  mask?: boolean;
  /** Top of the box in the page (CSS px), for the measuring order. */
  y: number;
  /**
   * A short code of the colours the page gives the control, its icon and what is behind it (asked for with
   * `look`): the same control with another code at another width looks different there.
   */
  look?: string;
}

export interface LocatedControls {
  targets: NonTextTarget[];
  /** Fields and toggles left with the browser's own look (exempt from 1.4.11), and disabled controls (exempt too). */
  exempt: number;
  /** Controls of a kind beyond its limit (asked for with `look`): found, not kept for measuring. */
  beyond?: { kind: NonTextTarget['kind']; path: string; look: string }[];
  /** More controls than were looked at or listed. */
  overflow?: boolean;
}

/**
 * Runs in the page (self-contained). Finds, in page order, the visible and enabled form fields and
 * custom-drawn checkboxes and radio buttons whose look the page changed (a field with the browser's
 * own look is exempt: compared with a fresh control of the same type in a closed shadow root, where
 * the page's style sheets do not reach), and the controls that show only an icon (no visible words),
 * and keeps them in the shot store.
 */
export function locateControls(arg: { key: string; limits: NonTextLimits; look?: boolean }): LocatedControls {
  const w = window as unknown as Record<string, unknown>;
  const store: Element[] = [];
  w[arg.key] = store;
  const L = arg.limits;
  const clean = (s: string | null | undefined) => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > 80 ? `${t.slice(0, 79)}…` : t;
  };
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    const rootNode = el.getRootNode() as Document | ShadowRoot;
    for (let cur: Element | null = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur.id && rootNode.querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      const name = esc(cur.localName);
      if (!parent) { parts.unshift(name); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${name}:nth-of-type(${same.indexOf(cur) + 1})` : name);
    }
    return parts.join(' > ');
  };
  // Batch 18, round 2: controls in open shadow roots are the page's controls (a web component's fields, toggles and
  // buttons): found there too, and named through their hosts ("host >>> inner").
  const shadowPath = (el: Element): string => {
    const segs: string[] = [];
    for (let e: Element | null = el; e; ) {
      segs.unshift(cssPath(e));
      const r = e.getRootNode();
      e = r instanceof ShadowRoot ? r.host : null;
    }
    return segs.join(' >>> ');
  };
  const deepQuery = (sel: string): Element[] => {
    const found: Element[] = [];
    const visit = (root: Document | ShadowRoot, depth: number) => {
      found.push(...Array.from(root.querySelectorAll(sel)));
      if (depth > 6) return;
      for (const h of Array.from(root.querySelectorAll('*'))) if (h.shadowRoot && h !== host) visit(h.shadowRoot, depth + 1);
    };
    visit(document, 0);
    return found;
  };
  const visible = (el: Element) => {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4;
  };
  const disabled = (el: Element) => (el as HTMLInputElement).disabled === true || el.closest('[aria-disabled="true"], [inert], fieldset[disabled]') !== null;
  const nameOf = (el: Element) => {
    const labels = (el as HTMLInputElement).labels;
    const label = labels && labels.length ? labels[0]!.textContent : '';
    const by = el.getAttribute('aria-labelledby');
    const byText = by ? by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ') : '';
    return clean(el.getAttribute('aria-label') || byText || label || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name')
      || el.querySelector('img[alt]')?.getAttribute('alt') || el.querySelector('svg title')?.textContent || el.getAttribute('alt') || '');
  };
  // The browser's own look for a control type, from a fresh control the page's styles cannot reach.
  const LOOK = [
    'appearance', 'backgroundColor', 'backgroundImage', 'boxShadow',
    'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
  ] as const;
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:hidden';
  const shadow = host.attachShadow({ mode: 'closed' });
  (document.body ?? document.documentElement).appendChild(host);
  const defaults = new Map<string, string>();
  const look = (s: CSSStyleDeclaration) => LOOK.map((k) => s[k]).join('|');
  const defaultLook = (el: Element): string => {
    const key = `${el.localName}:${(el as HTMLInputElement).type ?? ''}`;
    let d = defaults.get(key);
    if (d === undefined) {
      const fresh = document.createElement(el.localName);
      if (el instanceof HTMLInputElement) (fresh as HTMLInputElement).type = el.type;
      shadow.appendChild(fresh);
      d = look(getComputedStyle(fresh));
      fresh.remove();
      defaults.set(key, d);
    }
    return d;
  };
  const isDefault = (el: Element) => look(getComputedStyle(el)) === defaultLook(el);

  const WORDS = /[\p{L}\p{N}]/u;
  const visibleWords = (el: Element): string => {
    if (el instanceof HTMLInputElement) return /^(submit|button|reset)$/.test(el.type) ? el.value : '';
    let out = '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !/\S/.test(node.nodeValue ?? '')) continue;
      const r = parent.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2 || !visible(parent)) continue;
      out += `${node.nodeValue} `;
    }
    return out;
  };
  const pseudo = (el: Element) => ['::before', '::after'].some((p) => !/^(none|normal|""|'')$/.test(getComputedStyle(el, p).content));
  const alpha = (c: string) => {
    if (!c || c === 'transparent') return 0;
    const m = /\/\s*([\d.]+)(%?)\s*\)$/.exec(c) ?? /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)(%?)\s*\)$/.exec(c);
    if (!m) return 1;
    const v = parseFloat(m[1]!);
    return m[2] ? v / 100 : v;
  };
  const boxPaints = (st: CSSStyleDeclaration) => alpha(st.backgroundColor) >= 0.1 || (st.boxShadow !== 'none' && st.boxShadow !== '')
    || ['Top', 'Right', 'Bottom', 'Left'].some((side) => {
      const r = st as unknown as Record<string, string>;
      return !/^(none|hidden)$/.test(r[`border${side}Style`]!) && parseFloat(r[`border${side}Width`]!) > 0 && alpha(r[`border${side}Color`]!) >= 0.1;
    });
  const drawnPaints = (el: Element): boolean => {
    if (boxPaints(getComputedStyle(el))) return true;
    for (const pseudoName of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudoName);
      if (!/^(none|normal)$/.test(ps.content) && ps.display !== 'none' && boxPaints(ps)) return true;
    }
    return [...el.querySelectorAll('*')].slice(0, 8).some((d) => {
      const ds = getComputedStyle(d);
      return ds.display !== 'none' && ds.visibility !== 'hidden' && boxPaints(ds);
    });
  };
  const bgUrl = (el: Element) => /url\(/i.test(getComputedStyle(el).backgroundImage);
  const masked = (el: Element) => {
    const st = getComputedStyle(el) as CSSStyleDeclaration & { webkitMaskImage?: string };
    return /url\(|gradient\(/i.test(`${st.maskImage ?? ''} ${st.webkitMaskImage ?? ''}`);
  };
  // An image or SVG larger than an icon, or much wider than tall, is a logo or a picture (logos are
  // exempt from contrast requirements), not an icon.
  const iconSized = (g: Element | null) => {
    if (!g) return false;
    const r = g.getBoundingClientRect();
    return r.width <= L.graphicMax && r.height <= L.graphicMax && Math.max(r.width, r.height) <= L.graphicAspect * Math.max(1, Math.min(r.width, r.height));
  };
  const graphicOf = (el: Element, words: string): { graphic: string; bg?: boolean; mask?: boolean } | undefined => {
    const image = el instanceof HTMLInputElement && el.type === 'image' ? el : el.querySelector('img, picture, canvas');
    if (image) return iconSized(image) ? { graphic: 'img' } : undefined;
    const svg = el.localName === 'svg' ? el : el.querySelector('svg');
    if (svg) return iconSized(svg) ? { graphic: 'svg' } : undefined;
    const parts = [...el.querySelectorAll('*')].slice(0, 8);
    if (parts.some(bgUrl)) return { graphic: 'background image' };
    if (pseudo(el) || parts.some(pseudo)) return { graphic: 'icon font' };
    if (bgUrl(el)) return { graphic: 'background image', bg: true };
    // The control itself is cut to the icon's shape: what shows around it is what is behind it.
    if (masked(el)) return { graphic: 'mask image', mask: true };
    if (parts.some(masked)) return { graphic: 'mask image' };
    if (words.trim()) return { graphic: 'symbol' };
    // Batch 18, round 2: a control with no words and no picture that the page draws itself (a pagination or carousel
    // dot, a slider's track and thumb, a switch or checkbox made of boxes, a menu button of bars): its own fill,
    // border, shadow, pseudo-elements and inner boxes are what identifies it. Measured like an icon cut to its
    // shape (the whole control hidden for the second picture); a control that paints nothing is not one.
    // A range slider the page styles draws its track and thumb in parts no style read reaches: measured the same way.
    if (drawnPaints(el) || (el instanceof HTMLInputElement && el.type === 'range')) return { graphic: 'drawn shape', mask: true };
    return undefined;
  };
  const docY = (el: Element) => el.getBoundingClientRect().top + window.scrollY;
  // What the page paints for the control, the parts of its icon and everything it sits on, as a short code.
  const PAINT = ['color', 'fill', 'stroke', 'opacity', 'filter', 'backgroundColor', 'backgroundImage', 'boxShadow', 'maskImage',
    'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'borderTopWidth', 'borderBottomWidth', 'borderTopStyle', 'borderBottomStyle'] as const;
  const paint = (el: Element, part?: string) => {
    const st = getComputedStyle(el, part) as unknown as Record<string, string>;
    return PAINT.map((k) => st[k] ?? '').join('|');
  };
  const lookOf = (el: Element): string => {
    const parts = [paint(el), paint(el, '::before'), paint(el, '::after')];
    for (const d of [...el.querySelectorAll('*')].slice(0, 8)) parts.push(paint(d), paint(d, '::before'), (d as HTMLImageElement).currentSrc ?? '');
    for (let a = el.parentElement; a; a = a.parentElement) {
      const st = getComputedStyle(a);
      parts.push(`${st.backgroundColor}|${st.backgroundImage}|${st.opacity}|${st.filter}`);
    }
    let h = 5381;
    const all = parts.join('§');
    for (let i = 0; i < all.length; i++) h = ((h << 5) + h + all.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };
  const withLook = (el: Element) => (arg.look ? { look: lookOf(el) } : {});

  const out: NonTextTarget[] = [];
  const beyond: { kind: NonTextTarget['kind']; path: string; look: string }[] = [];
  let overflow = false;
  const over = (kind: NonTextTarget['kind'], el: Element) => {
    if (!arg.look) return;
    if (beyond.length >= L.listed) overflow = true;
    else beyond.push({ kind, path: shadowPath(el), look: lookOf(el) });
  };
  let exempt = 0;
  let fields = 0;
  let toggles = 0;
  let icons = 0;
  const FIELD = 'input:not([type]), input[type="text"], input[type="email"], input[type="search"], input[type="tel"], input[type="url"], input[type="password"], input[type="number"], input[type="date"], input[type="datetime-local"], input[type="month"], input[type="week"], input[type="time"], textarea, select';
  const TOGGLE = 'input[type="checkbox"], input[type="radio"]';
  const CONTROL = 'a[href], button, input[type="button"], input[type="submit"], input[type="reset"], input[type="image"], input[type="range"], summary, [role="button"], [role="link"], [role="checkbox"], [role="combobox"], [role="gridcell"], [role="listbox"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="radio"], [role="scrollbar"], [role="searchbox"], [role="slider"], [role="spinbutton"], [role="switch"], [role="tab"], [role="textbox"], [role="treeitem"]';
  try {
    let scanned = 0;
    for (const el of deepQuery(`${FIELD}, ${TOGGLE}, ${CONTROL}`)) {
      // Huge pages: the first 4000 controls and links are enough.
      if (++scanned > 4000) { overflow = true; break; }
      // Without the list of what lies beyond the limits (`look`), nothing more is needed once every kind is full.
      if (!arg.look && fields >= L.fields && toggles >= L.toggles && icons >= L.icons) break;
      if (!visible(el)) {
        // Batch 18, round 2: a checkbox or radio button hidden for a box its label draws in SVG (a common custom
        // checkbox): that picture is the control's look, measured like an icon cut to its shape.
        if (el.matches(TOGGLE) && !disabled(el) && icons < L.icons) {
          const art = Array.from((el as HTMLInputElement).labels ?? []).map((l) => l.querySelector('svg')).find((g) => g && visible(g) && iconSized(g));
          if (art && !store.includes(art)) {
            icons++;
            out.push({ ref: store.push(art) - 1, kind: 'icon', path: shadowPath(el), name: nameOf(el), graphic: 'drawn shape', mask: true, y: docY(art), ...withLook(art) });
          }
        }
        continue;
      }
      const isField = el.matches(FIELD);
      const isToggle = !isField && el.matches(TOGGLE);
      if (isField || isToggle) {
        if (disabled(el)) { exempt++; continue; }
        // Native checkboxes and radios are drawn by the browser unless the page turns that off.
        if (isToggle && getComputedStyle(el).appearance !== 'none') { exempt++; continue; }
        if (isField && isDefault(el)) { exempt++; continue; }
        if (isField ? fields >= L.fields : toggles >= L.toggles) { over(isField ? 'field' : 'toggle', el); continue; }
        if (isField) fields++;
        else toggles++;
        out.push({ ref: store.push(el) - 1, kind: isField ? 'field' : 'toggle', path: shadowPath(el), name: nameOf(el), y: docY(el), ...withLook(el) });
        continue;
      }
      if ((icons >= L.icons && !arg.look) || disabled(el) || el.parentElement?.closest(CONTROL)) continue;
      // A range slider the browser draws (its own look) is exempt, as native checkboxes are.
      const slider = (el instanceof HTMLInputElement && el.type === 'range') || el.getAttribute('role') === 'slider';
      if (el instanceof HTMLInputElement && el.type === 'range' && getComputedStyle(el).appearance !== 'none') { exempt++; continue; }
      const r = el.getBoundingClientRect();
      // A slider is long and thin: up to 640 px long, an icon's height.
      if (r.width < L.iconMin || r.height < L.iconMin || r.height > L.iconMax || r.width > (slider ? 640 : L.iconMax)) continue;
      const words = visibleWords(el);
      if ((WORDS.test(words) && [...words.replace(/\s+/g, '')].length !== 1) || /\blogo\b/i.test(nameOf(el))) continue;
      if (WORDS.test(words)) {
        const named = ['aria-label', 'aria-labelledby', 'title'].some((a) => el.hasAttribute(a));
        const marked = '[aria-hidden="true"], [role="img"], [role="presentation"], [role="none"]';
        // Ordinary numbered/text buttons are not icon candidates. Naming attributes only nominate
        // the others: the effective source and computed name are still verified through CDP.
        if (!named && !el.closest(marked) && !el.querySelector(marked)) continue;
      }
      const g = graphicOf(el, words);
      if (!g) continue;
      // Symbols need their computed name checked first; rejected text must not use an icon slot (their limit is
      // applied once verified, `locateVerified`). Other icons beyond the limit are listed, never dropped.
      if (g.graphic !== 'symbol') {
        if (icons >= L.icons) { over('icon', el); continue; }
        icons++;
      }
      out.push({ ref: store.push(el) - 1, kind: 'icon', path: shadowPath(el), name: nameOf(el), ...g, y: docY(el), ...withLook(el) });
    }
  } finally {
    host.remove();
  }
  return { targets: out, exempt, ...(arg.look ? { beyond, overflow } : {}) };
}

type Unmeasured = 'moving' | 'busy' | 'no-icon' | 'clipped' | 'time' | 'graphic' | 'limit';
type Outcome =
  | { kind: 'failed'; detail: string }
  | { kind: 'ok' | 'unseen' }
  | { kind: 'unmeasured'; reason: Unmeasured };

const REASON_TEXT: Record<Unmeasured, string> = {
  moving: 'the area around it kept changing (video, animation or loading content)',
  busy: 'the colors around it vary too much to compare with (an image or other content right next to it)',
  'no-icon': 'its icon could not be separated from its background in the screenshots',
  clipped: 'it is out of view inside a scrolling or sliding area',
  time: 'the time for this test ran out first',
  graphic: 'the computed name needed to establish whether the character is an icon could not be read',
  limit: 'the page has more controls of that kind than the test measures',
};

const KIND_TEXT = { field: 'form field', toggle: 'checkbox or radio button', icon: 'icon-only control' } as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The finding for a field or toggle from its boundary measurement, or null when it does not fail. */
export function boundaryOutcome(t: Pick<NonTextTarget, 'kind' | 'name'>, v: ReturnType<typeof boundaryContrast>): Outcome {
  if (!v.measurable) return { kind: 'unmeasured', reason: 'busy' };
  // Nothing marks the field at all: no boundary to judge (WCAG does not require one).
  if (!v.marked || v.ratio >= NON_TEXT_THRESHOLD) return { kind: 'ok' };
  return {
    kind: 'failed',
    detail: `A ${KIND_TEXT[t.kind]}’s boundary has ${ratioText(v.ratio)} contrast with the colors next to it (${
      v.by === 'fill' ? `fill ${hex(v.fill)} on ${hex(v.outside)}` : `edge ${hex(v.edge)} between ${hex(v.outside)} outside and ${hex(v.fill)} inside`}); `
      + `at least 3:1 is needed to see the control${t.name ? `: “${t.name}”` : ''}`,
  };
}

/** The finding for an icon-only control from its change measurement. */
export function iconOutcome(t: Pick<NonTextTarget, 'name' | 'graphic'>, v: ReturnType<typeof changeContrast>): Outcome {
  if (v.pixels < MIN_ICON_PIXELS) return { kind: 'unmeasured', reason: 'no-icon' };
  if (v.ratio >= NON_TEXT_THRESHOLD) return { kind: 'ok' };
  return {
    kind: 'failed',
    detail: `The icon of an icon-only control (${t.graphic ?? 'icon'}) has ${ratioText(v.ratio)} contrast with the color behind it (${hex(v.colour)} on ${hex(v.behind)}); `
      + `at least 3:1 is needed to make it out${t.name ? `: “${t.name}”` : ''}`,
  };
}

/**
 * The page's findings from every measured control. `phone` on an item: measured in the phone-width layout.
 * `notAtPhone`: why the phone-width layout was not looked at at all (then the page is never called clean or
 * without controls: it is not tested there).
 */
export function nonTextFindings(items: readonly { target: NonTextTarget; outcome: Outcome; phone?: boolean }[], exempt: number, notAtPhone?: string): ProbeFinding[] {
  const seen = items.filter((it) => it.outcome.kind !== 'unseen');
  const skipped: ProbeFinding[] = notAtPhone ? [{ criterion: '1.4.11', status: 'not_testable', detail: `Not tested at the phone width: ${notAtPhone}` }] : [];
  if (!seen.length) {
    if (skipped.length) return skipped;
    return [{ criterion: '1.4.11', status: 'not_applicable', detail: exempt ? `no styled form fields or icon-only controls on the page (${plural(exempt, 'control')} with the browser’s own look or disabled, which are exempt)` : 'no form fields or icon-only controls on the page' }];
  }
  const out: ProbeFinding[] = [];
  for (const it of seen) if (it.outcome.kind === 'failed') out.push({ criterion: '1.4.11', status: 'failed', target: it.target.path, detail: it.outcome.detail });
  const unmeasured = seen.filter((it): it is { target: NonTextTarget; outcome: { kind: 'unmeasured'; reason: Unmeasured }; phone?: boolean } => it.outcome.kind === 'unmeasured');
  if (unmeasured.length) {
    const counts = new Map<string, number>();
    for (const it of unmeasured) {
      const why = `${REASON_TEXT[it.outcome.reason]}${it.phone ? ' (at the phone width)' : ''}`;
      counts.set(why, (counts.get(why) ?? 0) + 1);
    }
    out.push({
      criterion: '1.4.11', status: 'not_testable', target: unmeasured[0]!.target.path,
      detail: `${plural(unmeasured.length, 'control')} of ${seen.length} could not be measured: ${[...counts.entries()].map(([r, n]) => `${n} because ${r}`).join('; ')}`,
    });
  }
  return [...out, ...skipped];
}

/**
 * Report evidence for a failing control, taken in its batch (the page as measured): the control's
 * visible box with its measured ratio in the caption; on the start page, its place on the first
 * screen (the desktop look only). Never throws.
 */
async function controlEvidence(ctx: ProbeContext, b: ViewItem, t: NonTextTarget, ratio: number | undefined, phone: boolean): Promise<void> {
  try {
    if (ctx.evidenceHome && !phone) await shootElements(ctx, { criterion: '1.4.11', handles: [{ key: SHOT_KEY, ref: b.ref }], alt: () => '', homeOnly: true, align: 'none' });
    if (!ctx.evidence || !(ctx.evidenceWanted?.('1.4.11') ?? false) || !timeFor(ctx, 2000)) return;
    const parts = b.boxes.filter((x) => x[2] > 0 && x[3] > 0);
    if (!parts.length) return;
    const x0 = Math.min(...parts.map((x) => x[0]));
    const y0 = Math.min(...parts.map((x) => x[1]));
    const box = { x: x0, y: y0, width: Math.max(...parts.map((x) => x[0] + x[2])) - x0, height: Math.max(...parts.map((x) => x[1] + x[3])) - y0 };
    const clip = cropAround([box], phone ? MOBILE_VIEWPORT : ctx.viewport);
    if (!clip) return;
    const what = t.kind === 'icon' ? 'icon-only control' : t.kind === 'toggle' ? 'check box or radio button' : 'form field';
    const named = t.name ? ` “${cleanText(t.name, 60)}”` : '';
    await ctx.evidence({
      criterion: '1.4.11', clip, boxes: [{ x: box.x - clip.x, y: box.y - clip.y, width: box.width, height: box.height, kind: 'fail' }],
      ...(typeof ratio === 'number' && Number.isFinite(ratio) ? { caption: `Contrast ${ratioText(ratio)}; at least 3:1 is needed${phone ? ' (the page at the phone width)' : ''}` } : {}),
      alt: `The outlined ${what}${named} is hard to make out${phone ? ' at the phone width' : ''}: ${t.kind === 'icon' ? 'its icon' : 'its edge'} has too little contrast with the colors around it.`,
    });
  } catch {
    // Evidence never changes the result.
  }
}

/**
 * Measures the located controls where the page shows them now, a batch of controls in view at a time: a
 * screenshot as shown, one with the icons hidden, and one as shown again (movement check). The outcome of
 * each control by its ref; a control the time ran out for has none. A symbol whose effective name could not be
 * read (`unknown`) is not measured (`graphic`). `pictures`: the report's pictures of failures; `phone`: measured
 * in the phone-width layout.
 */
async function measureControls(ctx: ProbeContext, targets: readonly NonTextTarget[], unknown: ReadonlySet<number>, opt: { pictures: boolean; phone?: boolean }): Promise<Map<number, Outcome>> {
  const page = ctx.page;
  const phone = !!opt.phone;
  const byRef = new Map(targets.map((t) => [t.ref, t]));
  const outcomes = new Map<number, Outcome>();
  const ratios = new Map<number, number>();
  for (const t of targets) if (t.graphic === 'symbol' && unknown.has(t.ref)) outcomes.set(t.ref, { kind: 'unmeasured', reason: 'graphic' });
  const order = [...targets].filter((t) => !outcomes.has(t.ref)).sort((a, b) => a.y - b.y).map((t) => t.ref);
  const opts = { mode: 'box' as const, margin: 8, deadline: ctx.deadline, reserveMs: NON_TEXT_LIMITS.reserveMs, signal: ctx.signal };
  // One CDP call per screenshot where the browser has a session (see `shoot`).
  const cdp = await ctx.cdp?.();
  await eachBatch(page, order, opts, async (batch: ViewItem[], clip: CssBox, at) => {
    const via = { ...(cdp ? { cdp } : {}), at };
    const icons = batch.filter((b) => byRef.get(b.ref)!.kind === 'icon').map((b) => ({ ref: b.ref, bg: !!byRef.get(b.ref)!.bg, mask: !!byRef.get(b.ref)!.mask }));
    const measure = async () => {
      const shown = await shoot(page, clip, via);
      let hidden: RgbaImage | undefined;
      if (icons.length) {
        try {
          await page.evaluate(markElements, { key: SHOT_KEY, refs: icons, state: 'icon' as const });
          hidden = await shoot(page, clip, via);
        } finally {
          await page.evaluate(markElements, { key: SHOT_KEY, refs: icons, state: 'show' as const });
        }
      }
      const again = await shoot(page, clip, via);
      return batch.map((b): Outcome => {
        const t = byRef.get(b.ref)!;
        const boxes = toImageBoxes(b.boxes, clip, shown);
        if (isMoving(shown, again, boxPixels(shown, boxes, 8))) return { kind: 'unmeasured', reason: 'moving' };
        if (t.kind === 'icon') {
          const v = changeContrast(hidden!, shown, boxes);
          ratios.set(b.ref, v.ratio);
          return iconOutcome(t, v);
        }
        if (b.outside > 0.01 || boxes.length !== 1) return { kind: 'unmeasured', reason: 'clipped' };
        const v = boundaryContrast(shown, boxes[0]!, shown.width / clip[2]);
        if ('ratio' in v && typeof v.ratio === 'number') ratios.set(b.ref, v.ratio);
        return boundaryOutcome(t, v);
      });
    };
    let results = await measure();
    if (results.some((r) => r.kind === 'unmeasured' && r.reason === 'moving') && Date.now() < ctx.deadline - NON_TEXT_LIMITS.reserveMs - 1000) {
      await page.waitForTimeout(NON_TEXT_LIMITS.retryMs);
      results = await measure();
    }
    batch.forEach((b, i) => outcomes.set(b.ref, results[i]!));
    // Pictures of this batch's failures while the page shows them as measured.
    for (const b of batch) {
      if (!opt.pictures || outcomes.get(b.ref)?.kind !== 'failed') continue;
      const t = byRef.get(b.ref)!;
      await controlEvidence(ctx, b, t, ratios.get(b.ref), phone);
    }
  }, (ref, cause) => outcomes.set(ref, cause === 'clipped' ? { kind: 'unmeasured', reason: 'clipped' } : { kind: 'unseen' }));
  return outcomes;
}

type Measured = { target: NonTextTarget; outcome: Outcome; phone?: boolean };

/**
 * Of the controls found in the phone-width layout, the ones the desktop look did not settle: a control that is
 * not there at the desktop width (or was not shown there), and one that passed there but is painted differently
 * here (its `look` code changed: a media query recolours it or what it sits on). A control that failed at the
 * desktop width is already reported, one that looks the same has the same result, and one the desktop look
 * could not measure or left beyond its limit (`beyond`: paths) is already reported as not measured.
 */
export function phoneOnly(desktop: readonly Measured[], narrow: readonly NonTextTarget[], beyond: ReadonlySet<string> = new Set()): NonTextTarget[] {
  const wide = new Map(desktop.map((it) => [it.target.path, it]));
  return narrow.filter((t) => {
    if (beyond.has(t.path)) return false;
    const d = wide.get(t.path);
    if (!d || d.outcome.kind === 'unseen') return true;
    return d.outcome.kind === 'ok' && d.target.look !== undefined && t.look !== undefined && d.target.look !== t.look;
  });
}

/**
 * A phone-width result as it joins the page's: a failure says where; a control that could not be measured there
 * stays not measured (never left out: what was not measured is not known to be fine); one the layout does not
 * show there is left out.
 */
export function phoneOutcome(o: Outcome | undefined): Outcome {
  if (!o) return { kind: 'unmeasured', reason: 'time' };
  if (o.kind === 'failed') return { kind: 'failed', detail: `At the phone width (${MOBILE_VIEWPORT.width} px): ${o.detail.charAt(0).toLowerCase()}${o.detail.slice(1)}` };
  return o;
}

/**
 * Measures, from screenshots, the form fields whose look the page changed (text fields, text areas,
 * selects; and checkboxes and radio buttons it draws itself), and the controls that show only an
 * icon. Browser-default and disabled controls are exempt (WCAG 1.4.11). Per batch of controls in
 * view: a screenshot as shown, one with the icons hidden, and one as shown again (movement check).
 * - Fields: the best contrast of any line across the edge (border, shadow ring) or of the fill,
 *   against the colours next to it (`boundaryContrast`); below 3:1 is failed. A field that nothing
 *   marks at all is not failed (WCAG does not require a boundary).
 * - Icons: every pixel the icon changes against the pixel it covers (`changeContrast`, 98th
 *   percentile); below 3:1 is failed. Buttons with words are covered by text contrast (1.4.3).
 * Controls that cannot be measured, and controls of a kind beyond its limit, give one not_testable finding with
 * the reasons.
 * Then a second look at the phone width (390×844, the audit's): the controls that are only there (a menu
 * button), and the ones a media query paints differently there, measured the same way (`phoneOnly`). A control
 * that cannot be measured there is reported as not measured at the phone width; and when the phone width is not
 * looked at at all (no time left, or the layout could not be opened) the result says so and is never clean.
 * A control whose box is off the page at that width (a closed menu parked off the side of the screen) is not shown
 * there, as at the desktop width (`eachBatch`: 'offpage').
 */
export const nonTextContrastProbe: PageProbe = {
  id: 'non-text-contrast',
  // On every page that loaded (2026-11-10, red-team coverage): it shares the every-page tests' page load and takes well under a second.
  everyPage: true,
  criteria: ['1.4.11'],
  kind: 'pixels',
  tier: 'core',
  timeoutMs: 15_000,
  // It measures the fields and icons the page shows: a page still putting its content in is waited for first
  // (bounded, `LATE_CONTENT_MS`), as for the layout tests; an empty shell has no controls to measure, and the
  // test then said there were none (the simulation lab's 8 misses, all late-mounting pages).
  waitFor: { content: true },
  async run(ctx: ProbeContext): Promise<ProbeFinding[]> {
    const mark = ctx.guard.mark();
    const found = await findPopups(ctx);
    if (found.boxes.length > 1) return multiplePopups(ctx, found, '1.4.11');
    if (!found.box) {
      // Batch 18, D12: the data of inline SVG charts (read from the page's styles, no screenshots).
      const charts = [
        ...chartSeriesFindings(await ctx.page.evaluate(faintChartSeries, { max: CHART_LIMITS.charts, series: CHART_LIMITS.series }).catch(() => [])),
        // Batch 18, D12b: switches and selected-tab bars too faint to show the control or its state.
        ...indicatorFindings(await ctx.page.evaluate(faintIndicators, { max: 6 }).catch(() => [])),
        // Round 2: the same in the page's own frames.
        ...chartSeriesFindings(await inOwnFrames(ctx.page, faintChartSeries, { max: CHART_LIMITS.charts, series: CHART_LIMITS.series })),
        ...indicatorFindings(await inOwnFrames(ctx.page, faintIndicators, { max: 6 })),
      ];
      if (charts.length) ctx.keep?.(charts);
      const look = await controlsLook(ctx, { pictures: true });
      const dark = await darkSchemeControls(ctx);
      const measured = nonTextFindings(look.items, look.exempt, look.notAtPhone);
      // A drawn control the measurement failed (round 2) is not failed a second time by the style reading (D12b).
      const failedThere = new Set(measured.filter((f) => f.status === 'failed' && f.target).map((f) => f.target));
      const own = charts.filter((f) => !(f.target && failedThere.has(f.target)));
      return discoveryDetails(ctx, found, guarded(ctx, mark, [...measured, ...own, ...dark]));
    }
    const single = { boxes: found.boxes, box: found.box };
    // Look 1 only discovers the box and its dismissal. Measure controls only on the cleared page.
    const windows: { from: number; to?: number }[] = [{ from: mark, to: ctx.guard.mark() }];
    const t1 = Date.now();
    const aside: PopupAside = timeForAside(ctx, 0, NON_TEXT_LIMITS.reserveMs)
      ? await setPopupAside(ctx, single)
      : notAside(ctx, single, INCOMPLETE.unfinished);
    let findings: ProbeFinding[];
    if (!aside.dismissed) findings = incomplete('1.4.11', aside.why ?? INCOMPLETE.stayed);
    else {
      windows.push({ from: aside.mark });
      try {
        const two = await controlsLook(ctx, { pictures: true });
        findings = nonTextFindings(two.items, two.exempt, two.notAtPhone);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        findings = incomplete('1.4.11', INCOMPLETE.unfinished);
      }
    }
    ctx.setData?.(asideData(aside, Date.now() - t1));
    return guardedIn(ctx, windows, findings);
  },
};

type Beyond = NonNullable<LocatedControls['beyond']>[number];

/**
 * Batch 18, D1 (docs/atlas/visual.md): the page's fields, custom toggles and icon-only controls in its own dark colour
 * scheme, measured as at rest (desktop width, the same limits). Only a page whose style sheets define one is
 * switched (`readInventory`). Failures name the presentation; what could not be measured there leaves the result at
 * rest as it is. Never throws.
 */
async function darkSchemeControls(ctx: ProbeContext): Promise<ProbeFinding[]> {
  if (ctx.signal.aborted || !timeFor(ctx, NON_TEXT_LIMITS.phoneLeftMs + 2000)) return [];
  try {
    return await eachPresentation(ctx, async (where) => {
      try {
        const found = await locateVerified(ctx);
        const outcomes = await measureControls(ctx, found.targets, found.unknown, { pictures: false });
        const items = found.targets.map((target) => ({ target, outcome: outcomes.get(target.ref) ?? ({ kind: 'unmeasured', reason: 'time' } as Outcome) }));
        // Charts and state indicators there too (break-it V19).
        const drawn = [
          ...chartSeriesFindings(await ctx.page.evaluate(faintChartSeries, { max: CHART_LIMITS.charts, series: CHART_LIMITS.series }).catch(() => [])),
          ...indicatorFindings(await ctx.page.evaluate(faintIndicators, { max: 6 }).catch(() => [])),
        ];
        return [...nonTextFindings(items, found.exempt).filter((f) => f.status === 'failed'), ...drawn].map((f) => ({ ...f, detail: `${f.detail} (${where})` }));
      } finally {
        await ctx.page.evaluate(markElements, { key: SHOT_KEY, refs: [], state: 'drop' as const }).catch(() => {});
      }
    });
  } catch {
    return [];
  }
}

/**
 * Locates the page's controls as it is laid out now (they are kept in the shot store, `SHOT_KEY`), and keeps the
 * symbol candidates Chromium's effective name shows to be graphic (or leaves unknown: those are reported not
 * measured, `graphic`). The icon limit is applied once that is verified, so text never takes an icon slot; an icon
 * beyond it is listed (`beyond`), never dropped.
 */
async function locateVerified(ctx: ProbeContext): Promise<LocatedControls & { beyond: Beyond[]; overflow: boolean; unknown: Set<number> }> {
  const found = await ctx.page.evaluate(locateControls, { key: SHOT_KEY, limits: NON_TEXT_LIMITS, look: true });
  const controls = await graphicControlRefs(ctx, SHOT_KEY);
  const beyond = [...(found.beyond ?? [])];
  let overflow = !!found.overflow;
  let icons = 0;
  const targets = found.targets.filter((t) => {
    if (t.graphic === 'symbol' && !controls.graphic.has(t.ref) && !controls.unknown.has(t.ref)) return false;
    // Unknown candidates are reported without a screenshot. The limit is on measured icons.
    if (t.kind !== 'icon' || controls.unknown.has(t.ref) || icons++ < NON_TEXT_LIMITS.icons) return true;
    if (beyond.length >= NON_TEXT_LIMITS.listed) overflow = true;
    else beyond.push({ kind: t.kind, path: t.path, look: t.look ?? '' });
    return false;
  });
  return { targets, exempt: found.exempt, beyond, overflow, unknown: controls.unknown };
}

/**
 * One look at the page's controls (the page as it is now: with no page-load pop-up, or with it dismissed): at the
 * desktop width, then the second look at the phone width (`phoneOnly`). What is beyond a limit is not measured
 * (`limit`), never clean; `notAtPhone` says why the phone width was not looked at. `pictures`: the report's
 * pictures of failures. Always removes its marks and restores the viewport.
 */
/** Longest wait, at each width, for the page's entrance animations to end before its controls are measured. */
const ANIMATIONS_SETTLE_MS = 3000;

/**
 * Waits, at most `maxMs` (and never into the time the rest of the test needs), until no finite animation or transition
 * is running or waiting out its delay: a control is measured as it rests, not while the page's blocks still fade and
 * rise in (a page loaded just before this test, whichever tests ran before it on the page). An endless animation (a
 * spinner) is not waited for. One in-page read when nothing moves. Never throws.
 */
async function animationsAtRest(ctx: ProbeContext, maxMs: number): Promise<void> {
  const max = Math.min(maxMs, ctx.deadline - Date.now() - NON_TEXT_LIMITS.phoneLeftMs);
  if (max < 200 || ctx.signal.aborted) return;
  await ctx.page.evaluate(async (m: number) => {
    const busy = () => {
      try {
        return document.getAnimations().some((a) => (a.playState === 'running' || a.pending) && Number.isFinite(Number(a.effect?.getComputedTiming().endTime ?? Infinity)));
      } catch {
        return false;
      }
    };
    const t0 = Date.now();
    while (busy() && Date.now() - t0 < m) await new Promise((r) => setTimeout(r, 100));
  }, max).catch(() => {});
}

async function controlsLook(ctx: ProbeContext, opt: { pictures: boolean }): Promise<{ items: Measured[]; exempt: number; notAtPhone?: string }> {
  const page = ctx.page;
  const items: Measured[] = [];
  let exempt = 0;
  let notAtPhone: string | undefined;
  const limit = (found: { beyond: Beyond[]; overflow: boolean }, phone: boolean, known: ReadonlySet<string>) => {
    let n = 0;
    for (const b of found.beyond) {
      if (known.has(b.path)) continue;
      n++;
      items.push({ target: { ref: -1, kind: b.kind, path: b.path, name: '', y: 0, look: b.look }, outcome: { kind: 'unmeasured', reason: 'limit' }, ...(phone ? { phone: true } : {}) });
    }
    if (found.overflow && !n) items.push({ target: { ref: -1, kind: 'icon', path: '', name: '', y: 0 }, outcome: { kind: 'unmeasured', reason: 'limit' }, ...(phone ? { phone: true } : {}) });
  };
  try {
    await animationsAtRest(ctx, ANIMATIONS_SETTLE_MS);
    const found = await locateVerified(ctx);
    exempt = found.exempt;
    const outcomes = await measureControls(ctx, found.targets, found.unknown, { pictures: opt.pictures });
    for (const target of found.targets) items.push({ target, outcome: outcomes.get(target.ref) ?? { kind: 'unmeasured', reason: 'time' } });
    limit(found, false, new Set());
    const beyondWide = new Set(found.beyond.map((b) => b.path));
    if (!page.setViewportSize) notAtPhone = 'the browser cannot change the viewport size';
    else if (ctx.signal.aborted || !timeFor(ctx, NON_TEXT_LIMITS.phoneLeftMs)) notAtPhone = 'the time for this test ran out first';
    else {
      const { width, height } = ctx.viewport;
      const timed = NON_TEXT_TIMING.phone ? Date.now() : 0;
      let measured = 0;
      try {
        await page.setViewportSize({ ...MOBILE_VIEWPORT });
        await page.waitForTimeout(NON_TEXT_LIMITS.phoneSettleMs);
        await animationsAtRest(ctx, ANIMATIONS_SETTLE_MS);
        const narrow = await locateVerified(ctx);
        const desktop = [...items];
        const fresh = phoneOnly(desktop, narrow.targets, beyondWide);
        if (fresh.length) {
          measured = fresh.length;
          const there = await measureControls(ctx, fresh, narrow.unknown, { pictures: opt.pictures, phone: true });
          const settled = new Set(desktop.filter((it) => it.outcome.kind !== 'unseen').map((it) => it.target.path));
          for (const target of fresh) {
            const outcome = phoneOutcome(there.get(target.ref));
            // A control that passed at the desktop width and passes here too is already counted.
            if (outcome.kind === 'failed' || outcome.kind === 'unmeasured' || (outcome.kind === 'ok' && !settled.has(target.path))) items.push({ target, outcome, phone: true });
          }
        }
        // Controls of a kind beyond its limit at this width, unless the desktop look already said so for them.
        limit(narrow, true, new Set([...beyondWide, ...desktop.map((it) => it.target.path)]));
        if (!desktop.some((it) => it.outcome.kind !== 'unseen')) exempt = Math.max(exempt, narrow.exempt);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        // What the phone-width layout holds is then not known.
        notAtPhone = 'the phone-width layout could not be opened or measured';
      } finally {
        await page.setViewportSize({ width, height }).catch(() => {});
        await page.waitForTimeout(NON_TEXT_LIMITS.phoneBackMs).catch(() => {});
        if (timed) try { NON_TEXT_TIMING.phone?.({ url: ctx.url, ms: Date.now() - timed, measured }); } catch { /* a listener never changes the test */ }
      }
    }
  } finally {
    await page.evaluate(markElements, { key: SHOT_KEY, refs: [], state: 'drop' as const }).catch(() => {});
  }
  return { items, exempt, ...(notAtPhone ? { notAtPhone } : {}) };
}
