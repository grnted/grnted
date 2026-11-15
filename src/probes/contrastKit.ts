// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The colours that paint a piece of text and what is behind it, worked out from the page's own styles: shared by
// the 1.4.3 checks that read colours instead of screenshots (placeholder text, text in its hover and focus states,
// text shown only on hover or focus). It answers only where the styles leave no doubt, and says why when they
// do not, so that a caller never mistakes "could not be told" for "fine":
// - backgrounds are composited from the outermost ancestor inwards: an opaque colour replaces what is behind it,
//   a see-through colour is blended over it, an opaque gradient of plain colours gives the colours it passes
//   through (its stops and samples between each two) as possible backdrops (the text may sit anywhere on it);
// - an element's `opacity` blends the whole element (its background and its text) with what is behind it;
// - a picture (`url()`), a see-through gradient, a filter, a blend mode, a text shadow, text painted by its
//   background (`background-clip: text`) and an element that floats over the page (absolute or fixed) with no
//   backdrop of its own are not decided: `why` says which.
// Engine core: no Node-only imports.
import { contrastRatio, isLargeText, textThreshold } from './pixels.js';

export const CONTRAST_KIT_KEY = '__grntedContrastKit';

/** Why the colours of a text could not be told from the styles. */
export type PaintGap = 'picture' | 'gradient' | 'filter' | 'floating' | 'shadow' | 'painted' | 'colour';

/** One text as the styles paint it now. */
export interface Paint {
  /** Each possible pair of text colour and backdrop colour (several when the backdrop is a gradient); null when not told. */
  pairs: { fg: [number, number, number]; bg: [number, number, number] }[] | null;
  why?: PaintGap;
  /** A short code of everything that paints the text and its backdrop: the same code in two states means the same look. */
  look: string;
  fontSize: number;
  fontWeight: number;
}

export const PAINT_GAP_TEXT: Record<PaintGap, string> = {
  picture: 'it sits on a picture',
  gradient: 'it sits on a gradient that is partly see-through or too varied to compare with',
  filter: 'a filter or blend mode changes its colors',
  floating: 'it floats over the page with no background of its own',
  shadow: 'it has a text shadow',
  painted: 'it is painted by its background, not by a text color',
  colour: 'its colors are in a form that was not read',
};

/** Runs in the page (self-contained): puts `paint(el, pseudo?)` on the window, once. Reads only. */
export function installContrastKit(key: string): void {
  const w = window as unknown as Record<string, unknown>;
  if (w[key]) return;
  type Rgb = [number, number, number];
  type Rgba = [number, number, number, number];
  const rgba = (c: string): Rgba | null => {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(c.trim());
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : Number(m[4])];
    // `color(srgb r g b / a)`: what Chromium gives for some modern colour syntax.
    const s = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(c.trim());
    if (s) return [Number(s[1]) * 255, Number(s[2]) * 255, Number(s[3]) * 255, s[4] === undefined ? 1 : s[4].endsWith('%') ? parseFloat(s[4]) / 100 : Number(s[4])];
    return null;
  };
  const over = (top: Rgba, under: Rgb): Rgb => {
    const a = Math.max(0, Math.min(1, top[3]));
    return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a)];
  };
  const mix = (c: Rgb, behind: Rgb, alpha: number): Rgb => [c[0] * alpha + behind[0] * (1 - alpha), c[1] * alpha + behind[1] * (1 - alpha), c[2] * alpha + behind[2] * (1 - alpha)];
  /** The colours a background made only of opaque gradients that cover the box passes through (its stops and samples between them); else why not. */
  const gradient = (image: string, st: CSSStyleDeclaration): Rgb[] | 'picture' | 'gradient' => {
    if (/url\(|image-set\(|element\(|paint\(|cross-fade\(/i.test(image)) return 'picture';
    const found = image.match(/rgba?\([^)]*\)/g) ?? [];
    const rest = image.replace(/rgba?\([^)]*\)/g, '');
    if (!found.length || /(?:color|lab|lch|oklab|oklch|hwb|hsla?)\(|#[0-9a-f]{3,8}\b|\bin\s+[a-z-]+/i.test(rest)) return 'gradient';
    const stops: Rgb[] = [];
    for (const f of found) {
      const c = rgba(f);
      if (!c || c[3] < 0.999) return 'gradient';
      stops.push([c[0], c[1], c[2]]);
    }
    if (stops.length > 8) return 'gradient';
    // The colours the gradient passes through, not only its stops (review r2, finding 2): between two stops it runs
    // in a straight line in sRGB, and contrast with a text colour can be far better midway than at either end
    // (white text over red to green: 4.0:1 at both ends, 7.2:1 in the middle). Each stretch is sampled.
    const STEPS = 16;
    const colours: Rgb[] = [];
    const add = (c: Rgb) => {
      const k: Rgb = [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];
      if (!colours.some((x) => x[0] === k[0] && x[1] === k[1] && x[2] === k[2])) colours.push(k);
    };
    add(stops[0]!);
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1]!;
      const b = stops[i]!;
      for (let k = 1; k <= STEPS; k++) add([a[0] + ((b[0] - a[0]) * k) / STEPS, a[1] + ((b[1] - a[1]) * k) / STEPS, a[2] + ((b[2] - a[2]) * k) / STEPS]);
    }
    // A gradient that does not cover the box leaves what is behind it showing.
    const sizes = st.backgroundSize.split(',').map((s) => s.trim());
    const covers = sizes.every((s) => /^(auto|cover|100% 100%|100%|auto auto|100% auto)$/.test(s)) || !/no-repeat|space/.test(st.backgroundRepeat);
    return covers ? colours : 'gradient';
  };
  const hash = (s: string) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };
  const up = (a: Element): Element | null => a.parentElement ?? ((a.getRootNode() as ShadowRoot).host ?? null);

  const paint = (el: Element, pseudo?: string) => {
    const chain: Element[] = [];
    for (let a: Element | null = el, i = 0; a && i < 300; a = up(a), i++) chain.push(a);
    chain.reverse();
    // What is behind the content of the element being walked: each possible colour, or null with the reason.
    let behind: Rgb[] | null = [[255, 255, 255]];
    let why: string | undefined;
    let fatal: string | undefined;
    const fades: { alpha: number; behind: Rgb[] | null }[] = [];
    const look: string[] = [];
    for (const a of chain) {
      const st = getComputedStyle(a) as CSSStyleDeclaration & { backdropFilter?: string };
      look.push(`${st.backgroundColor}|${st.backgroundImage}|${st.opacity}|${st.filter}|${st.mixBlendMode}`);
      if ((st.filter && st.filter !== 'none') || (st.mixBlendMode && st.mixBlendMode !== 'normal') || (a === el && st.backdropFilter && st.backdropFilter !== 'none')) fatal = 'filter';
      const outside = behind;
      let own = false;
      if (st.backgroundImage && st.backgroundImage !== 'none') {
        const g = gradient(st.backgroundImage, st);
        // A picture or a see-through gradient is a backdrop of its own too, only not one that can be read.
        if (typeof g === 'string') { behind = null; why = g; own = true; } else { behind = g; own = true; }
      } else {
        const c = rgba(st.backgroundColor);
        if (!c) { behind = null; why = 'colour'; } else if (c[3] >= 0.999) { behind = [[c[0], c[1], c[2]]]; own = true; } else if (c[3] > 0.001) behind = behind ? behind.map((b) => over(c, b)) : null;
      }
      // What floats over the page is not over its parent's background: without a backdrop of its own it is over whatever is there.
      if (!own && (st.position === 'absolute' || st.position === 'fixed')) { behind = null; why = 'floating'; }
      const alpha = parseFloat(st.opacity);
      if (Number.isFinite(alpha) && alpha < 0.999) fades.push({ alpha: Math.max(0, alpha), behind: outside });
    }
    const own = getComputedStyle(el) as CSSStyleDeclaration & { webkitTextFillColor?: string; webkitBackgroundClip?: string };
    const s = (pseudo ? getComputedStyle(el, pseudo) : own) as CSSStyleDeclaration & { webkitTextFillColor?: string };
    const fill = s.webkitTextFillColor && s.webkitTextFillColor !== s.color ? s.webkitTextFillColor : s.color;
    look.push(`${fill}|${s.textShadow}|${pseudo ? s.opacity : ''}`);
    const out = {
      pairs: null as { fg: Rgb; bg: Rgb }[] | null, why: undefined as string | undefined, look: hash(look.join('§')),
      fontSize: parseFloat(s.fontSize) || parseFloat(own.fontSize) || 16, fontWeight: Number(s.fontWeight) || Number(own.fontWeight) || 400,
    };
    const ink = rgba(fill);
    if (!ink) { out.why = 'colour'; return out; }
    if (/text/.test(`${own.backgroundClip ?? ''} ${own.webkitBackgroundClip ?? ''}`)) { out.why = 'painted'; return out; }
    if (s.textShadow && s.textShadow !== 'none') { out.why = 'shadow'; return out; }
    if (fatal) { out.why = fatal; return out; }
    if (!behind) { out.why = why ?? 'picture'; return out; }
    // A pseudo-element's own opacity (a placeholder's) fades its text only.
    const pseudoAlpha = pseudo ? parseFloat(s.opacity) : 1;
    const text: Rgba = [ink[0], ink[1], ink[2], ink[3] * (Number.isFinite(pseudoAlpha) ? Math.max(0, Math.min(1, pseudoAlpha)) : 1)];
    // See-through text over a backdrop of several colours, or anything faded over one: not compared colour by colour.
    if (behind.length > 1 && (text[3] < 0.999 || fades.length)) { out.why = 'gradient'; return out; }
    const pairs = behind.map((b) => ({ fg: over(text, b), bg: b }));
    for (const f of fades.reverse()) {
      if (!f.behind || f.behind.length !== 1) { out.why = f.behind ? 'gradient' : (why ?? 'picture'); return out; }
      for (const p of pairs) { p.fg = mix(p.fg, f.behind[0]!, f.alpha); p.bg = mix(p.bg, f.behind[0]!, f.alpha); }
    }
    out.pairs = pairs;
    return out;
  };
  w[key] = { paint, rgba };
}

export type PaintVerdict =
  | { kind: 'pass' | 'fail'; ratio: number; fg: [number, number, number]; bg: [number, number, number]; threshold: number; several: boolean }
  | { kind: 'unknown'; why: PaintGap };

/**
 * Whether a painted text reaches its WCAG 1.4.3 threshold (4.5:1, or 3:1 when large). Over a backdrop of several
 * colours (a gradient: its stops and the colours sampled between them, since contrast midway can be better or
 * worse than at both ends) it passes only when it passes against every one, and fails only when it fails against
 * every one; in between it is not decided. `margin`: a ratio this close under the
 * threshold is not failed (rounding of the colours read).
 */
export function paintVerdict(p: Pick<Paint, 'pairs' | 'why' | 'fontSize' | 'fontWeight'>, margin = 0.05): PaintVerdict {
  if (!p.pairs || !p.pairs.length) return { kind: 'unknown', why: p.why ?? 'picture' };
  const threshold = textThreshold(isLargeText(p.fontSize, p.fontWeight));
  const rated = p.pairs.map((x) => ({ ...x, ratio: contrastRatio(x.fg, x.bg) }));
  const failing = rated.filter((x) => x.ratio < threshold - margin);
  const several = rated.length > 1;
  if (!failing.length) {
    const worst = rated.reduce((a, b) => (b.ratio < a.ratio ? b : a));
    return { kind: 'pass', ratio: worst.ratio, fg: worst.fg, bg: worst.bg, threshold, several };
  }
  if (failing.length === rated.length) {
    // The most favourable colour of the backdrop still fails.
    const best = rated.reduce((a, b) => (b.ratio > a.ratio ? b : a));
    return { kind: 'fail', ratio: best.ratio, fg: best.fg, bg: best.bg, threshold, several };
  }
  return { kind: 'unknown', why: 'gradient' };
}
