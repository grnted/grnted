// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.3 for text whose look axe's colour-contrast rule does not model (batch 18, visual lane, D17; docs/atlas/
// visual.md). axe works out contrast from computed colours, so text faded by a filter on it or an ancestor
// (`filter: opacity(.4)`, `brightness(1.8)`), blended with what is behind it (`mix-blend-mode`), cut by a mask, or
// coloured differently on its first line or first letter, can pass axe while the screen shows something else. Such text
// is handed to the screenshot measurement the text-contrast test already uses for what axe could not decide (text
// shown, then hidden), with the same exemptions (inactive, logotype, decoration) and limits. Engine core: no
// Node-only imports.

/** Texts handed to the screenshot measurement per page, at most. */
export const PAINT_EFFECT_MAX = 10;

/**
 * Runs in the page (self-contained). Text elements shown on the page under a paint effect axe does not model (see the
 * file comment), not exempt from 1.4.3 (`exemptKey`: the shared predicate on the window), as CSS selectors.
 */
export function paintEffectTargets(arg: { max: number; exemptKey: string }): { target: string; summary: string }[] {
  const exempt = (window as unknown as Record<string, ((el: Element) => unknown) | undefined>)[arg.exemptKey];
  const out: { target: string; summary: string }[] = [];
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur.id && document.querySelectorAll(`#${CSS.escape(cur.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const parent: Element | null = cur.parentElement;
      if (!parent) {
        parts.unshift(cur.localName);
        break;
      }
      const same = Array.from(parent.children).filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${cur.localName}:nth-of-type(${same.indexOf(cur) + 1})` : cur.localName);
    }
    return parts.join(' > ');
  };
  const effectOf = (el: Element): string | null => {
    for (let a: Element | null = el, depth = 0; a && a !== document.documentElement && depth < 12; a = a.parentElement, depth++) {
      const cs = getComputedStyle(a);
      if (cs.filter && cs.filter !== 'none' && !/^drop-shadow\([^)]*\)$/.test(cs.filter.trim())) return `a filter (${cs.filter.slice(0, 40)})`;
      if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') return `a blend mode (${cs.mixBlendMode})`;
      const mask = cs.getPropertyValue('mask-image') || cs.getPropertyValue('-webkit-mask-image');
      if (mask && mask !== 'none') return 'a mask';
    }
    // A first line or first letter in its own colour cannot be redrawn for the screenshots: `faintFirstParts` reads it.
    return null;
  };
  const seen = new Set<Element>();
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  let n = 0;
  for (let t = walker.nextNode(); t && out.length < arg.max && n < 20_000; t = walker.nextNode(), n++) {
    const el = t.parentElement;
    if (!el || seen.has(el) || !/[\p{L}\p{N}]/u.test(t.nodeValue ?? '')) continue;
    seen.add(el);
    if (el.closest('script, style, noscript, svg, [aria-hidden="true"]')) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) continue;
    const why = effectOf(el);
    if (!why) continue;
    try {
      if (exempt && exempt(el) !== null) continue;
    } catch {
      continue;
    }
    out.push({ target: cssPath(el), summary: `Element's look comes from ${why}, which the colour rule does not model` });
  }
  return out;
}

/** One text whose first line or first letter is coloured too faintly against a solid backdrop. */
export interface FirstPartFailure { target: string; part: 'first line' | 'first letter'; fg: string; bg: string; ratio: number; threshold: number; text: string }

/**
 * Runs in the page (self-contained). Text whose `::first-line` or `::first-letter` colour differs from its own and is
 * under 4.5:1 (3:1 when large) against a solid backdrop (every background behind it a plain colour, composited from
 * the outermost in; a picture or gradient leaves it undecided). Not exempt from 1.4.3 (`exemptKey`). These parts cannot
 * be redrawn for the screenshots, so their colours are read from the styles, where the styles leave no doubt.
 */
export function faintFirstParts(arg: { max: number; exemptKey: string }): FirstPartFailure[] {
  const exempt = (window as unknown as Record<string, ((el: Element) => unknown) | undefined>)[arg.exemptKey];
  const out: FirstPartFailure[] = [];
  // Every CSS colour the browser computes (oklch, lab, color(display-p3 …) included) read as sRGB through a 1x1 canvas;
  // a value the canvas does not take is not decided (null).
  const cvs = document.createElement('canvas');
  cvs.width = 1;
  cvs.height = 1;
  const g2 = cvs.getContext('2d', { willReadFrequently: true });
  const memo = new Map<string, [number, number, number, number] | null>();
  const rgb = (c: string): [number, number, number, number] | null => {
    if (!c || c === 'none' || /url\(|gradient\(/.test(c)) return null;
    const hit = memo.get(c);
    if (hit !== undefined) return hit;
    let v: [number, number, number, number] | null = null;
    if (g2) {
      g2.fillStyle = '#010203';
      g2.fillStyle = c;
      if (g2.fillStyle !== '#010203' || /^#010203$/i.test(c.trim())) {
        g2.clearRect(0, 0, 1, 1);
        g2.fillRect(0, 0, 1, 1);
        const d = g2.getImageData(0, 0, 1, 1).data;
        v = [d[0]!, d[1]!, d[2]!, d[3]! / 255];
      }
    }
    memo.set(c, v);
    return v;
  };
  const lum = (c: number[]) => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
  };
  const ratio = (a: number[], b: number[]) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  const over = (t: number[], b: number[]) => [t[0]! * t[3]! + b[0]! * (1 - t[3]!), t[1]! * t[3]! + b[1]! * (1 - t[3]!), t[2]! * t[3]! + b[2]! * (1 - t[3]!), 1];
  const hex = (c: number[]) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const backdrop = (el: Element): number[] | null => {
    const chain: Element[] = [];
    for (let a: Element | null = el; a; a = a.parentElement) chain.unshift(a);
    let c = [255, 255, 255, 1];
    for (const a of chain) {
      const cs = getComputedStyle(a);
      if (cs.backgroundImage !== 'none' || (cs.filter && cs.filter !== 'none') || cs.mixBlendMode !== 'normal') return null;
      const bg = rgb(cs.backgroundColor);
      if (bg && bg[3]! > 0) c = over(bg, c);
    }
    return c;
  };
  const els = document.body ? Array.from(document.body.querySelectorAll('p, li, dd, blockquote, h1, h2, h3, h4, h5, h6, div, td, figcaption')) : [];
  for (const el of els) {
    if (out.length >= arg.max) break;
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue ?? '').join('').trim();
    if (!/[\p{L}\p{N}]/u.test(own)) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden') continue;
    for (const [p, part] of [['::first-line', 'first line'], ['::first-letter', 'first letter']] as const) {
      const ps = getComputedStyle(el, p);
      if (!ps.color || ps.color === cs.color) continue;
      try {
        if (exempt && exempt(el) !== null) break;
      } catch {
        break;
      }
      // A halo or stroke around the letters may give the contrast: not decided here (Sol r1, finding 5).
      if ((ps.textShadow && ps.textShadow !== 'none') || parseFloat(ps.getPropertyValue('-webkit-text-stroke-width')) > 0 || ps.backgroundImage !== 'none') continue;
      const base = backdrop(el);
      const fg = rgb(ps.color);
      if (!base || !fg) continue;
      // The part's own fill is what is behind its letters (a drop cap on its own block of colour).
      const partFill = rgb(ps.backgroundColor);
      const back = partFill && partFill[3]! > 0 ? over(partFill, base) : base;
      const shown = over(fg, back);
      const size = parseFloat(ps.fontSize) || parseFloat(cs.fontSize) || 16;
      const weight = Number(ps.fontWeight) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const threshold = large ? 3 : 4.5;
      const v = ratio(shown, back);
      if (v >= threshold - 0.02) continue;
      const id = el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1 ? `#${CSS.escape(el.id)}` : '';
      const path = id || (() => {
        const parts: string[] = [];
        for (let cur: Element | null = el; cur && cur.nodeType === 1 && parts.length < 8; cur = cur.parentElement) {
          const parent: Element | null = cur.parentElement;
          const same = parent ? Array.from(parent.children).filter((c) => c.localName === cur!.localName) : [];
          parts.unshift(same.length > 1 ? `${cur.localName}:nth-of-type(${same.indexOf(cur) + 1})` : cur.localName);
        }
        return parts.join(' > ');
      })();
      out.push({ target: path, part, fg: hex(shown), bg: hex(back), ratio: Math.round(v * 100) / 100, threshold, text: own.replace(/\s+/g, ' ').slice(0, 60) });
      break;
    }
  }
  return out;
}
