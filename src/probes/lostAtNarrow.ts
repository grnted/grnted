// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.10 Reflow: content removed at 320 CSS px (batch 18, visual lane, D6; docs/atlas/visual.md; failure F102).
// A responsive style that hides a paragraph below some width loses its information for anyone who zooms to 400% or
// reads on a narrow screen, unless the same information is shown elsewhere there or a control shows it. The reflow
// test counted text not shown at 320 px as a closed menu or a slide. Here prose (a sentence or more: at least 40
// characters and six words outside links) shown at the desktop width and removed at 320 px (display none on it or an
// ancestor) fails, unless:
// - it sits in navigation, a header or footer, a dialog, a menu, a details element, or a region a control names
//   (aria-controls), or its hidden ancestor is one;
// - a control that may show it (a button, a disclosure, a summary) is shown at 320 px in its section (the hidden
//   block's parent or grandparent): then it is not decided here;
// - most of its words (80%) are shown elsewhere at 320 px (the same text in another layout).
// Engine core: no Node-only imports.
import type { ProbeFinding } from '../types.js';

/** Where the desktop prose blocks are kept on the window. */
export const LOST_KEY = '__grntedLost';
/** Prose blocks read per page, and failures reported. */
export const LOST_LIMITS = { blocks: 400, max: 3 } as const;

const EXCLUDED = 'nav, header, footer, dialog, details, menu, [role="navigation"], [role="banner"], [role="contentinfo"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="menubar"], [role="tooltip"], [aria-hidden="true"]';

/** Runs in the page (self-contained), at the desktop width: keeps the prose blocks shown now. Returns how many. */
export function keepProse(arg: { key: string; max: number; excluded: string }): number {
  // (Prose hidden at the desktop width too is never kept: only what 320 px takes away counts.)
  const out: Element[] = [];
  const all = document.body ? document.body.querySelectorAll('p, li, dd, blockquote, figcaption, td, div, span, section, article') : [];
  for (let i = 0; i < all.length && out.length < arg.max; i++) {
    const el = all[i]!;
    if (el.closest(arg.excluded)) continue;
    // Its own prose: text nodes directly in it (not in links), a sentence or more.
    let own = '';
    for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) own += n.nodeValue ?? '';
    own = own.replace(/\s+/g, ' ').trim();
    if (own.length < 40 || own.split(' ').length < 6) continue;
    if (!el.getClientRects().length) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.1) continue;
    out.push(el);
  }
  (window as unknown as Record<string, Element[]>)[arg.key] = out;
  return out.length;
}

export interface LostProse {
  path: string;
  text: string;
  hidden: string;
  /** With `controlled` (AI evidence only): the names of the controls that may show it, and its section's box at 320 px. */
  controls?: string[];
  section?: { x: number; y: number; width: number; height: number };
}

/**
 * Runs in the page (self-contained), at 320 px: the kept prose blocks removed here (see the file comment). With
 * `controlled`, instead the blocks left undecided because a control may show them (neutral evidence for the AI review:
 * their text, the controls' names and the section to picture), scrolled into view one at a time by the caller.
 */
export function lostProse(arg: { key: string; max: number; excluded: string; controlled?: boolean }): LostProse[] {
  const kept = (window as unknown as Record<string, Element[]>)[arg.key] ?? [];
  const out: LostProse[] = [];
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur && cur.nodeType === 1 && parts.length < 8; cur = cur.parentElement) {
      if (cur.id && document.querySelectorAll(`#${CSS.escape(cur.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const parent: Element | null = cur.parentElement;
      const same = parent ? Array.from(parent.children).filter((c) => c.localName === cur!.localName) : [];
      parts.unshift(same.length > 1 ? `${cur.localName}:nth-of-type(${same.indexOf(cur) + 1})` : cur.localName);
    }
    return parts.join(' > ');
  };
  const words = (t: string) => (t.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  let shownText: Set<string> | null = null;
  const seenHidden = new Set<Element>();
  // Whether a readable style sheet of the document (at-rule groups and nested rules walked) has a :target selector.
  let hasTarget: boolean | null = null;
  const targetRules = (): boolean => {
    if (hasTarget !== null) return hasTarget;
    hasTarget = false;
    const walk = (rules: CSSRuleList | undefined, depth: number): void => {
      if (!rules || depth > 4 || hasTarget) return;
      for (const r of Array.from(rules)) {
        if (r instanceof CSSStyleRule && r.selectorText.includes(':target')) { hasTarget = true; return; }
        walk((r as CSSGroupingRule).cssRules, depth + 1);
      }
    };
    for (const sh of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | undefined;
      try { rules = sh.cssRules; } catch { rules = undefined; }
      walk(rules, 0);
    }
    return hasTarget;
  };
  for (const el of kept) {
    if (out.length >= arg.max) break;
    if (!el.isConnected) continue;
    const vis = getComputedStyle(el).visibility;
    if (el.getClientRects().length && vis !== 'hidden' && vis !== 'collapse') continue;
    // Removed by display: none, or hidden with visibility (break-it V11), on it or an ancestor (not moved off screen).
    let hidden: Element | null = null;
    for (let a: Element | null = el; a && a !== document.body; a = a.parentElement) {
      const ac = getComputedStyle(a);
      if (ac.display === 'none') hidden = a;
      else if ((ac.visibility === 'hidden' || ac.visibility === 'collapse') && (!a.parentElement || getComputedStyle(a.parentElement).visibility === 'visible')) hidden = hidden ?? a;
    }
    if (!hidden || seenHidden.has(hidden)) continue;
    seenHidden.add(hidden);
    if (hidden.closest(arg.excluded) || hidden.matches(arg.excluded)) continue;
    const nameOf = (c: Element) => (c.getAttribute('aria-label') || (c as HTMLElement).innerText || c.textContent || c.localName).replace(/\s+/g, ' ').trim().slice(0, 60);
    const sectionBox = (sec: Element | null) => {
      if (!sec) return undefined;
      const r = sec.getBoundingClientRect();
      return { x: Math.max(0, r.left), y: r.top + scrollY, width: Math.min(innerWidth, r.width), height: Math.min(900, r.height) };
    };
    // AI evidence: a block a control may show (aria-controls, a link to it, a control in its section) is listed with
    // the controls' names; never a finding.
    const undecided = (ctls: Element[]) => {
      if (!arg.controlled || out.length >= arg.max) return;
      const sec = hidden!.parentElement;
      const box = sectionBox(sec);
      out.push({ path: cssPath(el), text: ((el as HTMLElement).textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300), hidden: cssPath(hidden!), controls: ctls.slice(0, 4).map(nameOf), ...(box ? { section: box } : {}) });
    };
    const named = [...(hidden.id ? Array.from(document.querySelectorAll(`[aria-controls~="${CSS.escape(hidden.id)}"]`)) : []), ...(el.id ? Array.from(document.querySelectorAll(`[aria-controls~="${CSS.escape(el.id)}"]`)) : [])];
    if (named.length) { undecided(named); continue; }
    // A link to it, or to the hidden block holding it, may show it (a :target disclosure; Sol r1, finding 8). A link to
    // a block further out (a skip link to <main>) counts only when the page's styles use :target at all: otherwise every
    // page with a skip link would hide its lost prose (lab, sticky-header pages).
    let linked = false;
    for (let a: Element | null = el, inside = true; a && a !== document.body && !linked; a = a.parentElement) {
      if (a.id && (inside || targetRules()) && document.querySelector(`a[href="#${CSS.escape(a.id)}"]`)) linked = true;
      if (a === hidden) inside = false;
    }
    if (linked) { undecided(Array.from(document.querySelectorAll('a[href^="#"]')).filter((a) => { const t = document.getElementById(decodeURIComponent((a.getAttribute('href') ?? '').slice(1))); return !!t && (t === el || t.contains(el)); })); continue; }
    // A control in its block that may show it (a disclosure button, a summary, a tab).
    const section = hidden.parentElement;
    const near = section ? Array.from(section.querySelectorAll('button, summary, [aria-expanded], [aria-controls], [role="button"], [role="tab"]')).filter((c) => !hidden!.contains(c) && c.getClientRects().length > 0) : [];
    if (near.length) { undecided(near); continue; }
    if (arg.controlled) continue;
    // The same text shown elsewhere at this width: most of its runs of four words appear in what 320 px shows.
    if (!shownText) {
      const all = words((document.body as HTMLElement).innerText ?? '');
      shownText = new Set(all.slice(3).map((_, i) => all.slice(i, i + 4).join(' ')));
    }
    const mine = words((el as HTMLElement).textContent ?? '');
    if (mine.length < 4) continue;
    const runs = mine.slice(3).map((_, i) => mine.slice(i, i + 4).join(' '));
    const shared = runs.filter((r) => shownText!.has(r)).length;
    if (shared >= 0.6 * runs.length) continue;
    out.push({ path: cssPath(el), text: ((el as HTMLElement).textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100), hidden: cssPath(hidden) });
  }
  return out;
}

/** Runs in the page: forgets the kept blocks. */
export function dropProse(key: string): void {
  delete (window as unknown as Record<string, unknown>)[key];
}

/** The 1.4.10 findings for prose removed at 320 px. */
export function lostFindings(list: readonly LostProse[], width: number): ProbeFinding[] {
  return list.map((l) => ({
    criterion: '1.4.10', status: 'failed' as const, target: l.path,
    detail: `At ${width} px wide this text is removed (display: none on ${l.hidden}) and is shown nowhere else there, with no control to show it: “${l.text}”`,
  }));
}

export const LOST_EXCLUDED = EXCLUDED;

/** Text that makes the whole page scroll sideways at 320 px from where the layout walk does not reach. */
export interface WideText { path: string; text: string; pageWidth: number }

/**
 * Runs in the page (self-contained), at 320 px wide (batch 18, round 2). The layout walk reads the text of the
 * document's own elements; a page can still scroll sideways because of text it does not read: a web component's text
 * in an open shadow root, or a text area with its lines unwrapped. When the page itself is wider than the window by
 * more than 2 px, the first such element whose box runs past the window's right edge is returned (at most `max`). Never
 * content that may need two dimensions (tables, code, maps, graphics, media, frames, data grids, toolbars), never
 * anything inside a scrolling region, never text the walk reads (the light DOM's own text, judged by the walk).
 */
export function wideText(arg: { max: number }): WideText[] {
  const vw = window.innerWidth;
  const pageWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
  if (pageWidth <= vw + 2) return [];
  const EXEMPT = 'table, pre, code, kbd, samp, svg, math, canvas, video, img, picture, iframe, object, embed, map, [role="grid"], [role="treegrid"], [role="toolbar"], [role="img"], [role="application"]';
  const upOf = (e: Element): Element | null => e.parentElement ?? ((e.getRootNode() as ShadowRoot).host ?? null);
  const exempt = (el: Element): boolean => {
    for (let a: Element | null = el; a; a = upOf(a)) {
      if (a.matches(EXEMPT)) return true;
      if (a !== el && a !== document.documentElement && a !== document.body) {
        const cs = getComputedStyle(a);
        if (/^(auto|scroll)$/.test(cs.overflowX)) return true;
      }
    }
    return false;
  };
  const segPath = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur && parts.length < 8; cur = cur.parentElement) {
      if (cur.id && (cur.getRootNode() as Document | ShadowRoot).querySelectorAll(`#${CSS.escape(cur.id)}`).length === 1) { parts.unshift(`#${CSS.escape(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      const same = parent ? Array.from(parent.children).filter((c) => c.localName === cur!.localName) : [];
      parts.unshift(same.length > 1 ? `${cur.localName}:nth-of-type(${same.indexOf(cur) + 1})` : cur.localName);
    }
    return parts.join(' > ');
  };
  const deepPath = (el: Element): string => {
    const segs: string[] = [];
    for (let e: Element | null = el; e; ) {
      segs.unshift(segPath(e));
      const r = e.getRootNode();
      e = r instanceof ShadowRoot ? r.host : null;
    }
    return segs.join(' >>> ');
  };
  const out: WideText[] = [];
  const consider = (el: Element, text: string) => {
    if (out.length >= arg.max || text.length < 20) return;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || r.right <= vw + 2 || r.left >= vw) return;
    if (exempt(el)) return;
    out.push({ path: deepPath(el), text: text.replace(/\s+/g, ' ').trim().slice(0, 100), pageWidth });
  };
  // Text areas whose lines run past the window.
  for (const t of Array.from(document.querySelectorAll('textarea')) as HTMLTextAreaElement[]) consider(t, t.value);
  // Text in open shadow roots: the deepest blocks holding text of their own.
  const visit = (root: Document | ShadowRoot, inShadow: boolean, depth: number) => {
    if (depth > 6 || out.length >= arg.max) return;
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (out.length >= arg.max) return;
      if (el.shadowRoot) visit(el.shadowRoot, true, depth + 1);
      if (!inShadow) continue;
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue ?? '').join(' ').trim();
      if (own) consider(el, own);
    }
  };
  visit(document, false, 0);
  return out;
}
