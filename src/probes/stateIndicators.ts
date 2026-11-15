// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.11 for the parts that identify a control or its state (batch 18, visual lane, D12b; docs/atlas/visual.md),
// where the non-text contrast test's fields, toggles and icons do not reach: a switch drawn by the page (role switch)
// whose track and knob are both faint against the page, and the bar that alone marks the selected tab. Decided from the
// page's styles, only where they leave no doubt (solid colours composited from the outermost in; a picture, gradient
// or filter behind leaves it undecided):
// - a switch (role="switch", or a check box styled as one with appearance: none) with no words of its own fails when
//   neither its track (fill or border) nor its knob (::before or ::after fill) reaches 3:1 against what is behind it;
// - a selected tab (aria-selected="true") whose only difference from the other tabs is a bar (a bottom border or an
//   inset shadow) fails when that bar is under 3:1 against the tab's fill.
// Engine core: no Node-only imports.
import type { ProbeFinding } from '../types.js';

export interface FaintIndicator { path: string; what: 'switch' | 'tab'; name: string; colour: string; behind: string; ratio: number }

/** Runs in the page (self-contained). The faint switches and tab bars (see the file comment), at most `max`. */
export function faintIndicators(arg: { max: number }): FaintIndicator[] {
  const out: FaintIndicator[] = [];
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
  /** What is behind `el` (its ancestors' fills, outermost first); null when a picture, gradient or filter is in the way. */
  const behind = (el: Element): number[] | null => {
    const chain: Element[] = [];
    for (let a: Element | null = upOf(el); a; a = upOf(a)) chain.unshift(a);
    let c = [255, 255, 255, 1];
    for (const a of chain) {
      const cs = getComputedStyle(a);
      if (cs.backgroundImage !== 'none' || (cs.filter && cs.filter !== 'none')) return null;
      const bg = rgb(cs.backgroundColor);
      if (bg && bg[3]! > 0) c = over(bg, c);
    }
    return c;
  };
  // Batch 18, round 2: open shadow roots too (a web component's switches and tabs are the page's).
  const upOf = (e: Element): Element | null => e.parentElement ?? ((e.getRootNode() as ShadowRoot).host ?? null);
  const deepQuery = (sel: string): Element[] => {
    const found: Element[] = [];
    const visit = (root: Document | ShadowRoot, depth: number) => {
      found.push(...Array.from(root.querySelectorAll(sel)));
      if (depth > 6) return;
      for (const h of Array.from(root.querySelectorAll('*'))) if (h.shadowRoot) visit(h.shadowRoot, depth + 1);
    };
    visit(document, 0);
    return found;
  };
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
  const nameOf = (e: Element) => (e.getAttribute('aria-label') || (e as HTMLInputElement).labels?.[0]?.textContent || (e as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50);
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width >= 12 && r.height >= 8 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.3;
  };
  const painted = (w: string, st: string, c: string) => parseFloat(w) > 0 && st !== 'none' && st !== 'hidden' && (rgb(c)?.[3] ?? 0) > 0.1;
  // Switches.
  for (const el of deepQuery('[role="switch"], input[type="checkbox"]')) {
    if (out.length >= arg.max) break;
    const cs = getComputedStyle(el);
    if (el.localName === 'input' && cs.appearance !== 'none' && cs.getPropertyValue('-webkit-appearance') !== 'none') continue;
    if (el.localName === 'input' && el.getAttribute('role') !== 'switch' && !(parseFloat(cs.width) > 1.5 * parseFloat(cs.height))) continue;
    if (!shown(el) || (el as HTMLInputElement).disabled || el.getAttribute('aria-disabled') === 'true') continue;
    if (el.localName !== 'input' && ((el as HTMLElement).innerText ?? '').trim()) continue;
    const back = behind(el);
    if (!back || cs.backgroundImage !== 'none') continue;
    const fill = rgb(cs.backgroundColor);
    const track = fill && fill[3]! > 0 ? over(fill, back) : back;
    let best = ratio(track, back);
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      const st = cs as unknown as Record<string, string>;
      if (painted(st[`border${side}Width`]!, st[`border${side}Style`]!, st[`border${side}Color`]!)) best = Math.max(best, ratio(over(rgb(st[`border${side}Color`]!)!, track), back));
    }
    let knob = 0;
    for (const p of ['::before', '::after']) {
      const ps = getComputedStyle(el, p);
      if (!ps.content || ps.content === 'none' || ps.content === 'normal') continue;
      if (ps.backgroundImage !== 'none') { knob = 99; continue; }
      const k = rgb(ps.backgroundColor);
      if (k && k[3]! > 0.1) knob = Math.max(knob, ratio(over(k, track), back));
      if (painted(ps.borderTopWidth, ps.borderTopStyle, ps.borderTopColor)) knob = Math.max(knob, ratio(over(rgb(ps.borderTopColor)!, track), back));
    }
    // A thumb drawn by a child element counts as the knob too (Sol r1, finding 2).
    for (const d of Array.from(el.querySelectorAll('*')).slice(0, 10)) {
      const ds = getComputedStyle(d);
      if (ds.display === 'none' || ds.visibility === 'hidden') continue;
      if (ds.backgroundImage !== 'none') { knob = 99; continue; }
      const k = rgb(ds.backgroundColor);
      if (k && k[3]! > 0.1) knob = Math.max(knob, ratio(over(k, track), back));
      const st = ds as unknown as Record<string, string>;
      if (painted(st.borderTopWidth!, st.borderTopStyle!, st.borderTopColor!)) knob = Math.max(knob, ratio(over(rgb(st.borderTopColor!)!, track), back));
      if (d.localName === 'img' || d.localName === 'canvas' || d.localName === 'video') knob = 99;
      // A part drawn in SVG (a shape's fill or stroke) is read like any other (batch 18, round 2).
      if (d instanceof SVGGeometryElement) {
        const sw = parseFloat(ds.strokeWidth) || 0;
        for (const [paint, op] of [[ds.fill, Number(ds.fillOpacity)], [sw > 0 ? ds.stroke : 'none', Number(ds.strokeOpacity)]] as [string, number][]) {
          if (/url\(/.test(paint)) { knob = 99; continue; }
          const c = rgb(paint);
          if (c && c[3]! * (Number.isFinite(op) ? op : 1) > 0.1) knob = Math.max(knob, ratio(over([c[0]!, c[1]!, c[2]!, c[3]! * (Number.isFinite(op) ? op : 1)], track), back));
        }
      }
    }
    // An outline of 3:1 around the track identifies it too.
    if (painted(cs.outlineWidth, cs.outlineStyle, cs.outlineColor)) best = Math.max(best, ratio(over(rgb(cs.outlineColor)!, back), back));
    if (best >= 3 || knob >= 3) continue;
    out.push({ path: cssPath(el), what: 'switch', name: nameOf(el), colour: hex(track), behind: hex(back), ratio: Math.round(Math.max(best, knob) * 100) / 100 });
  }
  // Selected tab bars.
  for (const tab of deepQuery('[role="tab"][aria-selected="true"]')) {
    if (out.length >= arg.max) break;
    if (!shown(tab)) continue;
    const list = tab.closest('[role="tablist"]');
    const peer = list ? Array.from(list.querySelectorAll('[role="tab"]')).find((t) => t !== tab && t.getAttribute('aria-selected') !== 'true' && shown(t)) : null;
    if (!peer) continue;
    const s = getComputedStyle(tab);
    const p = getComputedStyle(peer);
    // Anything else that tells the selected tab apart (colour, weight, decoration, fill, an icon, a mark or a symbol of
    // its own) is not this rule's (Sol r1, finding 2).
    if (s.color !== p.color || s.fontWeight !== p.fontWeight || s.textDecorationLine !== p.textDecorationLine || s.backgroundColor !== p.backgroundColor) continue;
    const marks = (t: Element) => {
      const kids = Array.from(t.querySelectorAll('*')).map((k) => k.localName).sort().join(',');
      // An empty pseudo-element is a drawn shape (the bar itself, read below), not a mark of its own.
      const pseudo = ['::before', '::after'].map((x) => getComputedStyle(t, x).content).filter((c) => c && c !== 'none' && c !== 'normal' && !/^(""|'')$/.test(c)).join('|');
      const symbols = ((t as HTMLElement).innerText ?? '').replace(/[\p{L}\p{N}\s.,:;'"()-]/gu, '');
      return `${kids}#${pseudo}#${symbols}`;
    };
    if (marks(tab) !== marks(peer)) continue;
    const back = behind(tab);
    if (!back) continue;
    const fill = rgb(s.backgroundColor);
    const base = fill && fill[3]! > 0 ? over(fill, back) : back;
    let bar: number[] | null = null;
    if (painted(s.borderBottomWidth, s.borderBottomStyle, s.borderBottomColor) && !painted(p.borderBottomWidth, p.borderBottomStyle, p.borderBottomColor)) bar = rgb(s.borderBottomColor);
    else if (s.boxShadow !== 'none' && p.boxShadow === 'none') bar = rgb((/(rgba?|color)\([^)]*\)/.exec(s.boxShadow) ?? [''])[0]);
    else {
      // A bar drawn by the selected tab's own ::after or ::before (an empty, thin, filled box) that the others lack
      // (batch 18, round 2).
      for (const x of ['::after', '::before']) {
        const ps = getComputedStyle(tab, x);
        const pp = getComputedStyle(peer, x);
        const drawn = (st: CSSStyleDeclaration) => /^(""|'')$/.test(st.content) && st.display !== 'none' && (rgb(st.backgroundColor)?.[3] ?? 0) > 0.1
          && Math.min(parseFloat(st.height) || 0, parseFloat(st.width) || 0) > 0 && Math.min(parseFloat(st.height) || 99, parseFloat(st.width) || 99) <= 8;
        if (drawn(ps) && (!drawn(pp) || pp.backgroundColor !== ps.backgroundColor)) { bar = rgb(ps.backgroundColor); break; }
      }
    }
    if (!bar || bar[3]! < 0.1) continue;
    const shownBar = over(bar, base);
    const v = ratio(shownBar, base);
    if (v >= 3) continue;
    out.push({ path: cssPath(tab), what: 'tab', name: nameOf(tab), colour: hex(shownBar), behind: hex(base), ratio: Math.round(v * 100) / 100 });
  }
  return out;
}

/** The 1.4.11 findings. */
export function indicatorFindings(list: readonly FaintIndicator[]): ProbeFinding[] {
  return list.map((f) => ({
    criterion: '1.4.11', status: 'failed' as const, target: f.path,
    detail: f.what === 'switch'
      ? `The switch${f.name ? ` “${f.name}”` : ''} is drawn in ${f.colour} on ${f.behind} (${f.ratio.toFixed(1)}:1 at best for its track and knob): the parts that show a control need at least 3:1 against what is next to them.`
      : `The bar that alone marks the selected tab${f.name ? ` “${f.name}”` : ''} is ${f.colour} on ${f.behind} (${f.ratio.toFixed(1)}:1): a state indicator needs at least 3:1.`,
  }));
}
