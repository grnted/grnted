// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.13 Content on hover or focus (Plan 4 Task 4.2): content that appears on hover or focus
// must be dismissible (Escape), hoverable (the pointer can move onto it) and persistent. Engine core:
// no Node-only imports.
import type { ProbeFinding } from '../types.js';
import { excerpt, stoppedSince, type GuardStop } from './layout.js';
import { GUARD_SETTLE_MS } from './motionShared.js';
import { ProbeNotTestable, type PageProbe, type ProbeContext } from './types.js';

/** Listener types that show content on hover, and on focus. */
export const HOVER_TYPES = ['mouseenter', 'mouseover', 'pointerenter', 'pointerover'] as const;
export const FOCUS_TYPES = ['focus', 'focusin'] as const;

/** Timing (ms): wait for content to appear, how long it must stay, and the other waits. */
export const HOVER_TIMING = { reveal: 400, persist: 2000, settle: 300, dismiss: 250, scroll: 150 } as const;
/** Triggers tested per page (one per pattern), and the time kept back before the time box ends. */
export const HOVER_LIMITS = { candidates: 15, reserveMs: 4000 } as const;
/** How far inside the content (px) the pointer first lands, and the pointer's step (px) on the way there. */
export const HOVER_NEAR_INSET = 2;
export const HOVER_STEP_PX = 4;

export interface HoverCandidate {
  i: number;
  how: 'hover' | 'focus';
  /** Where it was found: 'tooltip' (aria-describedby or a tooltip attribute), 'css' (a :hover or :focus rule), 'listener'. */
  source: 'tooltip' | 'css' | 'listener';
  path: string;
  name: string;
}

/**
 * Runs in the page (self-contained). Finds triggers of hover and focus content: elements with hover
 * or focus listeners (`refs`, from the listener hook), elements matched by the trigger part of
 * `:hover`/`:focus`/`:focus-within` rules that change other elements (readable style sheets only),
 * elements whose `aria-describedby` points at hidden content, and tooltip attributes
 * (`data-tooltip`, `data-tippy-content`, `data-bs-toggle="tooltip"`). Native `title` tooltips are
 * drawn by the browser and left out. Visible triggers only, one per pattern (tag, classes, parent),
 * at most `max`, tooltips first. They stay on `window.__grntedHover` for the other functions.
 */
export function hoverCandidates(arg: { refs: { ref: number; type: string }[]; max: number }): HoverCandidate[] {
  interface Cand { el: Element; how: 'hover' | 'focus'; source: HoverCandidate['source']; reveal: string[]; desc: Element[] }
  const win = window as unknown as { __grntedTarget?: (ref: number) => unknown; __grntedHover?: unknown };
  const clean = (s: string | null | undefined, max: number) => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s);
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && document.querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      if (!parent) { parts.unshift(cur.localName); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${esc(cur.localName)}:nth-of-type(${same.indexOf(cur) + 1})` : esc(cur.localName));
    }
    return parts.join(' > ');
  };
  const shown = (el: Element) => {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4;
  };
  const byEl = new Map<Element, Cand>();
  const order: Cand[] = [];
  const add = (el: Element | null, how: Cand['how'], source: Cand['source'], reveal?: string, desc: Element[] = []) => {
    if (!el || el === document.body || el === document.documentElement) return;
    let c = byEl.get(el);
    if (!c) {
      c = { el, how, source, reveal: [], desc: [] };
      byEl.set(el, c);
      order.push(c);
    } else if (how === 'hover') c.how = 'hover';
    if (reveal && !c.reveal.includes(reveal)) c.reveal.push(reveal);
    c.desc.push(...desc);
    if (source === 'tooltip') c.source = 'tooltip';
  };

  // aria-describedby pointing at hidden content, and tooltip attributes.
  for (const el of document.querySelectorAll('[aria-describedby]')) {
    const targets = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => (id ? document.getElementById(id) : null)).filter((t): t is HTMLElement => !!t);
    const hidden = targets.filter((t) => !shown(t));
    if (!hidden.length) continue;
    add(el, el.matches('input, select, textarea') ? 'focus' : 'hover', 'tooltip', undefined, hidden);
  }
  for (const el of document.querySelectorAll('[data-tooltip], [data-tippy-content], [data-bs-toggle="tooltip"], [data-toggle="tooltip"]')) add(el, 'hover', 'tooltip');

  // Style rules: `trigger:hover target { … }` that change something other than the trigger itself.
  const PSEUDO = /:(?:hover|focus-within|focus-visible|focus)(?![\w-])/g;
  const split = (sel: string): { parts: string[]; joins: string[] } => {
    const parts: string[] = [];
    const joins: string[] = [];
    let cur = '';
    let depth = 0;
    let quote = '';
    for (let k = 0; k < sel.length; k++) {
      const ch = sel[k]!;
      if (quote) { cur += ch; if (ch === quote && sel[k - 1] !== '\\') quote = ''; continue; }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[') depth++;
      if (ch === ')' || ch === ']') depth--;
      if (depth === 0 && (ch === ' ' || ch === '>' || ch === '+' || ch === '~')) {
        let join = ch === ' ' ? ' ' : ch;
        while (sel[k + 1] === ' ' || sel[k + 1] === '>' || sel[k + 1] === '+' || sel[k + 1] === '~') {
          k++;
          if (sel[k] !== ' ') join = sel[k]!;
        }
        if (cur) { parts.push(cur); joins.push(join === ' ' ? ' ' : ` ${join} `); cur = ''; }
        continue;
      }
      cur += ch;
    }
    if (cur) parts.push(cur);
    return { parts, joins };
  };
  const listOf = (sel: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let depth = 0;
    for (const ch of sel) {
      if (ch === '(' || ch === '[') depth++;
      if (ch === ')' || ch === ']') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  const reveals = (s: CSSStyleDeclaration) => (s.display !== '' && s.display !== 'none') || s.visibility === 'visible'
    || (s.opacity !== '' && parseFloat(s.opacity) > 0) || !!(s.maxHeight || s.height || s.transform || s.clip || s.clipPath || s.left || s.top || s.right || s.bottom);
  const cssTriggers: { trigger: string; reveal: string; how: Cand['how'] }[] = [];
  const visit = (rules: CSSRuleList, depth: number) => {
    if (depth > 4) return;
    for (const r of Array.from(rules)) {
      if (cssTriggers.length > 400) return;
      if (r instanceof CSSStyleRule) {
        if (!/:hover|:focus/.test(r.selectorText) || !reveals(r.style)) continue;
        for (const sel of listOf(r.selectorText)) {
          if (sel.includes('::') || !/:hover|:focus/.test(sel)) continue;
          const { parts, joins } = split(sel);
          let k = -1;
          parts.forEach((p, idx) => { if (/:hover|:focus/.test(p)) k = idx; });
          if (k < 0 || k === parts.length - 1) continue; // the hovered element itself changes
          let trigger = '';
          for (let m = 0; m <= k; m++) trigger += (m ? joins[m - 1] : '') + (parts[m]!.replace(PSEUDO, '') || '*');
          let reveal = '';
          for (let m = 0; m < parts.length; m++) reveal += (m ? joins[m - 1] : '') + (parts[m]!.replace(PSEUDO, '') || '*');
          cssTriggers.push({ trigger, reveal, how: /:hover/.test(parts[k]!) ? 'hover' : 'focus' });
        }
      } else if (r instanceof CSSMediaRule) {
        if (window.matchMedia(r.conditionText).matches) visit(r.cssRules, depth + 1);
      } else if ('cssRules' in r && (r as CSSGroupingRule).cssRules) {
        visit((r as CSSGroupingRule).cssRules, depth + 1);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try { visit(sheet.cssRules, 0); } catch { /* a cross-origin style sheet cannot be read */ }
  }
  for (const t of cssTriggers) {
    let found: NodeListOf<Element>;
    try { found = document.querySelectorAll(t.trigger); } catch { continue; }
    let n = 0;
    for (const el of found) {
      if (n++ >= 30) break;
      add(el, t.how, 'css', t.reveal);
    }
  }

  // Hover and focus listeners recorded by the hook.
  for (const { ref, type } of arg.refs) {
    const el = win.__grntedTarget?.(ref);
    if (el instanceof Element) add(el, /^(focus|focusin)$/.test(type) ? 'focus' : 'hover', 'listener');
  }

  // Visible triggers, one per pattern, tooltips first.
  const STATE = /active|current|open|show|selected|hover|focus|first|last|odd|even|\d/i;
  const signature = (c: Cand) => {
    const cls = (el: Element | null) => (el ? [...el.classList].filter((x) => !STATE.test(x)).sort().slice(0, 3).join('.') : '');
    return `${c.how}|${c.el.localName}.${cls(c.el)}|${c.el.parentElement?.localName ?? ''}.${cls(c.el.parentElement)}`;
  };
  const rank = { tooltip: 0, css: 1, listener: 2 } as const;
  const seen = new Set<string>();
  const kept: Cand[] = [];
  for (const c of [...order].sort((a, b) => rank[a.source] - rank[b.source])) {
    if (kept.length >= arg.max) break;
    if ((c.el as HTMLButtonElement).disabled || !shown(c.el)) continue;
    const sig = signature(c);
    if (seen.has(sig)) continue;
    seen.add(sig);
    kept.push(c);
  }
  win.__grntedHover = { cands: kept, revealed: [] as Element[], hidden: null, observer: null, added: [] as Element[] };
  return kept.map((c, i) => ({
    i, how: c.how, source: c.source, path: cssPath(c.el),
    name: clean(c.el.getAttribute('aria-label') || (c.el as HTMLElement).innerText || c.el.textContent || c.el.getAttribute('alt'), 60),
  }));
}

interface HoverStash {
  cands: { el: Element; how: string; reveal: string[]; desc: Element[] }[];
  revealed: Element[];
  hidden: Set<Element> | null;
  observer: MutationObserver | null;
  added: Element[];
  trigger?: Element;
}

/** Runs in the page (self-contained): scrolls the trigger into view and returns its center, if the pointer can reach it there. */
export function hoverPrepare(i: number): { x: number; y: number; ok: boolean } | null {
  const st = (window as unknown as { __grntedHover?: HoverStash }).__grntedHover;
  const c = st?.cands[i];
  if (!st || !c || !c.el.isConnected) return null;
  c.el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
  const r = c.el.getBoundingClientRect();
  const x = Math.round(Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 2));
  const y = Math.round(Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 2));
  const hit = document.elementFromPoint(x, y);
  return { x, y, ok: !!hit && (c.el.contains(hit) || hit.contains(c.el)) };
}

/**
 * Runs in the page (self-contained). `arm` records which elements near the trigger are hidden now
 * (its parent's subtree, the targets of its rule or aria-describedby, tooltips) and starts watching
 * for added elements; `check` returns what has appeared since (and keeps it), with a point on it for
 * the pointer and whether it covers other content; `visible` says whether that content is still shown;
 * `focus` / `blur` move focus to or from the trigger; `done` stops watching.
 */
export function hoverStep(arg: { op: 'arm' | 'check' | 'visible' | 'focus' | 'focusIn' | 'blur' | 'done' | 'otherDismiss'; i: number }): {
  revealed?: number; text?: string; point?: { x: number; y: number }; near?: { x: number; y: number }; edge?: { x: number; y: number }; obscures?: boolean; visible?: boolean; focused?: boolean; other?: string;
} {
  const st = (window as unknown as { __grntedHover?: HoverStash }).__grntedHover;
  const c = st?.cands[arg.i];
  if (!st || !c) return {};
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const shown = (el: Element) => {
    if (!el.isConnected) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
  };
  // The trigger's own targets (its style rule's or aria-describedby's), wherever they are on the page.
  const targets = (): Set<Element> => {
    const set = new Set<Element>(c.desc);
    for (const sel of c.reveal) { try { for (const el of [...document.querySelectorAll(sel)].slice(0, 200)) set.add(el); } catch { /* invalid */ } }
    return set;
  };
  if (arg.op === 'arm') {
    st.observer?.disconnect();
    st.trigger = c.el;
    st.revealed = [];
    st.added = [];
    // Everything hidden now (at most 6000 elements): what appears later is the trigger's content when near it.
    st.hidden = new Set([...(document.body ?? document.documentElement).querySelectorAll('*')].slice(0, 6000).filter((el) => !shown(el)));
    for (const el of targets()) if (!shown(el)) st.hidden.add(el);
    st.observer = new MutationObserver((records) => {
      for (const rec of records) for (const n of rec.addedNodes) if (n instanceof Element && st.added.length < 200) st.added.push(n);
    });
    st.observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true });
    return {};
  }
  if (arg.op === 'focus') { (c.el as HTMLElement).focus?.(); return {}; }
  // Keyboard focus into the trigger: the trigger itself when it takes focus, else the first control inside it.
  if (arg.op === 'focusIn') {
    const sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
    const to = (c.el.matches(sel) ? c.el : c.el.querySelector(sel)) as HTMLElement | null;
    to?.focus?.();
    return { focused: !!to && document.activeElement === to };
  }
  // Another way to dismiss the content that the page offers (Sol r1 S8): a close control in it, keys the trigger or the
  // content names (aria-keyshortcuts), or text on the page that names a key to dismiss, close or hide it.
  if (arg.op === 'otherDismiss') {
    const closeRe = /\b(close|dismiss|hide)\b|[×✕✖]/i;
    for (const r of st.revealed) {
      for (const b of [...r.querySelectorAll('button, [role="button"], a[href]')].slice(0, 20)) {
        const name = (b.getAttribute('aria-label') || (b as HTMLElement).innerText || b.textContent || '').trim();
        if (closeRe.test(name)) return { other: `a control named "${name.slice(0, 40)}" in it` };
      }
    }
    for (const e of [c.el, ...st.revealed]) {
      const keys = e.getAttribute('aria-keyshortcuts') || e.querySelector('[aria-keyshortcuts]')?.getAttribute('aria-keyshortcuts');
      if (keys) return { other: `the key${/\s/.test(keys.trim()) ? 's' : ''} ${keys.trim().slice(0, 30)} it names` };
    }
    const pageText = ((document.body as HTMLElement | null)?.innerText ?? '').slice(0, 20000);
    const m = pageText.match(/\b(?:[Pp]ress|[Uu]se|[Hh]it)\s+(?:the\s+)?([A-Z][\w+-]{0,12}|F\d{1,2}|Esc(?:ape)?)\s+(?:key\s+)?to\s+(?:dismiss|close|hide)\b/);
    if (m) return { other: `the page's own words, "${m[0].slice(0, 60)}"` };
    return {};
  }
  if (arg.op === 'blur') {
    (c.el as HTMLElement).blur?.();
    const a = document.activeElement as HTMLElement | null;
    if (a && a !== document.body && c.el.contains(a)) a.blur?.();
    return {};
  }
  if (arg.op === 'done') {
    st.observer?.disconnect();
    st.observer = null;
    st.hidden = null;
    st.revealed = [];
    st.added = [];
    return {};
  }
  if (arg.op === 'visible') return { visible: st.revealed.some(shown) };

  // 'check': what appeared, near the trigger, with something in it.
  const t = c.el.getBoundingClientRect();
  const near = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.left < t.right + 300 && r.right > t.left - 300 && r.top < t.bottom + 300 && r.bottom > t.top - 300;
  };
  const hasContent = (el: Element) => {
    const r = el.getBoundingClientRect();
    return /\S/.test(el.textContent ?? '') || !!el.querySelector('img, svg, video, canvas') || (r.width >= 24 && r.height >= 24);
  };
  const fresh = new Set<Element>();
  const own = targets();
  for (const el of st.hidden ?? []) if (shown(el) && (own.has(el) || near(el))) fresh.add(el);
  for (const el of st.added) {
    if (!el.isConnected) continue;
    for (const e of [el, ...el.querySelectorAll('*')].slice(0, 200)) if (shown(e) && near(e)) fresh.add(e);
  }
  const candidates = [...fresh].filter((el) => el !== c.el && !el.contains(c.el) && hasContent(el));
  const roots = candidates.filter((el) => !candidates.some((o) => o !== el && o.contains(el)));
  st.revealed = roots;
  if (!roots.length) return { revealed: 0 };
  // A point on the content the pointer can reach, and the point of it nearest the trigger's centre
  // (where the pointer is): a person moves the shortest way onto a tooltip, not to its middle.
  let point: { x: number; y: number } | undefined;
  let nearest: { x: number; y: number } | undefined;
  let edge: { x: number; y: number } | undefined;
  const from = { x: t.left + t.width / 2, y: t.top + t.height / 2 };
  for (const root of roots) {
    const r = root.getBoundingClientRect();
    for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.25], [0.25, 0.5], [0.75, 0.5], [0.5, 0.75], [0.1, 0.1], [0.9, 0.9]] as const) {
      const x = Math.round(Math.min(Math.max(r.left + r.width * fx, 1), vw - 2));
      const y = Math.round(Math.min(Math.max(r.top + r.height * fy, 1), vh - 2));
      const hit = document.elementFromPoint(x, y);
      if (hit && root.contains(hit)) { point = { x, y }; break; }
    }
    if (point) {
      // `nearestPointIn` with HOVER_NEAR_INSET (2 px), inlined: this function runs in the page.
      const inset = Math.min(2, r.width / 2, r.height / 2);
      const nx = Math.round(Math.min(Math.max(Math.min(Math.max(from.x, r.left + inset), r.right - inset), 1), vw - 2));
      const ny = Math.round(Math.min(Math.max(Math.min(Math.max(from.y, r.top + inset), r.bottom - inset), 1), vh - 2));
      const hit = document.elementFromPoint(nx, ny);
      if (hit && root.contains(hit)) {
        nearest = { x: nx, y: ny };
        // The point of the trigger nearest that one (2 px inside): the pointer goes there first, inside
        // the trigger, and then across into the content, so it never cuts a corner outside both boxes.
        const ti = Math.min(2, t.width / 2, t.height / 2);
        edge = {
          x: Math.round(Math.min(Math.max(Math.min(Math.max(nx, t.left + ti), t.right - ti), 1), vw - 2)),
          y: Math.round(Math.min(Math.max(Math.min(Math.max(ny, t.top + ti), t.bottom - ti), 1), vh - 2)),
        };
      }
      break;
    }
  }
  // Content that does not take the pointer at all (pointer-events: none): no point of it answers a hit test,
  // yet the pointer can be moved over where it is shown, and WCAG's "hoverable" asks that it then stays (F95).
  // A point of it that is off the trigger (on the trigger the pointer has not left) is where the pointer goes.
  if (!point) {
    const onTrigger = (x: number, y: number) => { const hit = document.elementFromPoint(x, y); return !!hit && (hit === c.el || c.el.contains(hit)); };
    for (const root of roots) {
      if (getComputedStyle(root).pointerEvents !== 'none') continue;
      const r = root.getBoundingClientRect();
      for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.75], [0.5, 0.25], [0.25, 0.5], [0.75, 0.5], [0.9, 0.9], [0.1, 0.1]] as const) {
        const x = Math.round(Math.min(Math.max(r.left + r.width * fx, 1), vw - 2));
        const y = Math.round(Math.min(Math.max(r.top + r.height * fy, 1), vh - 2));
        if (onTrigger(x, y)) continue;
        point = { x, y };
        break;
      }
      if (!point) continue;
      const inset = Math.min(2, r.width / 2, r.height / 2);
      const nx = Math.round(Math.min(Math.max(Math.min(Math.max(from.x, r.left + inset), r.right - inset), 1), vw - 2));
      const ny = Math.round(Math.min(Math.max(Math.min(Math.max(from.y, r.top + inset), r.bottom - inset), 1), vh - 2));
      if (!onTrigger(nx, ny)) {
        nearest = { x: nx, y: ny };
        const ti = Math.min(2, t.width / 2, t.height / 2);
        edge = {
          x: Math.round(Math.min(Math.max(Math.min(Math.max(nx, t.left + ti), t.right - ti), 1), vw - 2)),
          y: Math.round(Math.min(Math.max(Math.min(Math.max(ny, t.top + ti), t.bottom - ti), 1), vh - 2)),
        };
      }
      break;
    }
  }
  // Does it cover other content (text, images, controls) that was there before?
  const boxes = roots.map((el) => el.getBoundingClientRect());
  const inside = (n: Node) => roots.some((r) => r.contains(n)) || c.el.contains(n);
  const hits = (r: DOMRect) => boxes.some((b) => Math.min(r.right, b.right) - Math.max(r.left, b.left) > 4 && Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top) > 4);
  let obscures = false;
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let count = 0;
  for (let n = walker.nextNode(); n && !obscures && count < 4000; n = walker.nextNode()) {
    if (!/\S/.test(n.nodeValue ?? '') || inside(n)) continue;
    const p = n.parentElement;
    if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
    count++;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) if (hits(r) && shown(p)) { obscures = true; break; }
  }
  if (!obscures) {
    for (const el of document.querySelectorAll('img, video, iframe, input, button, select, textarea')) {
      if (!inside(el) && shown(el) && hits(el.getBoundingClientRect())) { obscures = true; break; }
    }
  }
  const text = (roots.map((el) => (el as HTMLElement).innerText || el.textContent || '').join(' ').replace(/\s+/g, ' ').trim()).slice(0, 120);
  return { revealed: roots.length, text, ...(point ? { point } : {}), ...(nearest ? { near: nearest } : {}), ...(edge ? { edge } : {}), obscures };
}

/** Runs in the page (self-contained): forgets the triggers. */
export function hoverDrop(): void {
  const w = window as unknown as { __grntedHover?: { observer?: MutationObserver | null } };
  w.__grntedHover?.observer?.disconnect();
  delete w.__grntedHover;
}

/** One trigger's result: what appeared and which of the three requirements it failed. */
export interface HoverResult {
  candidate: HoverCandidate;
  revealed: boolean;
  text?: string;
  obscures?: boolean;
  failed: ('dismissible' | 'hoverable' | 'persistent')[];
  /**
   * Content shown on hover that Escape hides only once keyboard focus is in its trigger (a key handler on the trigger
   * or its wrapper): with the pointer resting on it and focus elsewhere, Escape did nothing (batch 17).
   */
  scopedEscape?: boolean;
  /** Escape did not hide it, and the page offers another way to dismiss it (Sol r1 S8): what that way is. */
  otherDismiss?: string;
  /** The pointer could not reach the trigger (covered by something else). */
  covered?: boolean;
  /** Why the result cannot be trusted: the request guard held a navigation or blocked a request while it was tested. */
  stopped?: GuardStop;
}

/** Finding detail for a trigger that failed (no "a person should check" wording: what was measured). */
export function hoverDetail(r: HoverResult): string {
  const how = r.candidate.how === 'hover' ? 'on hover' : 'on focus';
  const what = r.text ? `“${excerpt(r.text, 60)}”` : 'content';
  const problems: string[] = [];
  if (r.failed.includes('dismissible')) problems.push('pressing Escape does not hide it although it covers other content');
  if (r.failed.includes('hoverable')) problems.push('it disappears when the pointer moves onto it');
  if (r.failed.includes('persistent')) problems.push(`it disappears by itself within ${HOVER_TIMING.persist / 1000} s while the ${r.candidate.how === 'hover' ? 'pointer stays on its trigger' : 'trigger keeps focus'}`);
  return `Content shown ${how} (${what}): ${problems.join('; ')}`;
}

const wait = (ctx: ProbeContext, ms: number) => ctx.page.waitForTimeout(ms);
const AWAY = { x: -1, y: -1 };

/**
 * The point of a box nearest `from`, `inset` px inside it (at most half the box): where a person's
 * pointer first lands when it moves onto content shown next to its trigger. `hoverStep` does the same
 * in the page.
 */
export function nearestPointIn(from: { x: number; y: number }, r: { left: number; top: number; right: number; bottom: number }, inset = HOVER_NEAR_INSET): { x: number; y: number } {
  const i = Math.min(inset, (r.right - r.left) / 2, (r.bottom - r.top) / 2);
  return { x: Math.min(Math.max(from.x, r.left + i), r.right - i), y: Math.min(Math.max(from.y, r.top + i), r.bottom - i) };
}

/**
 * Pointer steps for a move of this length: at most `HOVER_STEP_PX` px apart, so a gap on the way is
 * crossed, never jumped, however long the move. No cap on the count: every point of the path is inside
 * the viewport (the points are clamped to it), so a move is at most its diagonal, about 390 steps at
 * 1280 × 900.
 */
export function pointerSteps(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return Math.max(2, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / HOVER_STEP_PX));
}

/**
 * The pointer's path onto content shown next to its trigger: to the point of the trigger nearest the
 * content (inside the trigger), across to the nearest point of the content, then to a point on it.
 * Each leg stays inside the trigger, inside the content, or crosses straight from one to the other
 * (where they touch it is inside both; a gap between them is crossed point by point).
 */
export function hoverPath(shown: { point: { x: number; y: number }; near?: { x: number; y: number }; edge?: { x: number; y: number } }): { x: number; y: number }[] {
  return shown.near ? [...(shown.edge ? [shown.edge] : []), shown.near, shown.point] : [shown.point];
}

export async function testTrigger(ctx: ProbeContext, c: HoverCandidate): Promise<HoverResult> {
  const { page } = ctx;
  const mouse = page.mouse!;
  const keyboard = page.keyboard!;
  const step = (op: Parameters<typeof hoverStep>[0]['op']) => page.evaluate(hoverStep, { op, i: c.i });
  const result: HoverResult = { candidate: c, revealed: false, failed: [] };
  const mark = ctx.guard.mark();
  const at = await page.evaluate(hoverPrepare, c.i);
  if (!at) return result;
  if (c.how === 'hover' && !at.ok) return { ...result, covered: true };
  await wait(ctx, HOVER_TIMING.scroll);
  await step('arm');
  const show = async () => {
    if (c.how === 'hover') {
      await mouse.move(AWAY.x, AWAY.y);
      await mouse.move(at.x, at.y, { steps: 2 });
    } else {
      await step('blur');
      await step('focus');
    }
    await wait(ctx, HOVER_TIMING.reveal);
  };
  try {
    await show();
    const shown = await step('check');
    if (!shown.revealed) return result;
    Object.assign(result, { revealed: true, text: shown.text, obscures: !!shown.obscures });
    // Persistent: still shown 2 s after the trigger was hovered or focused, which it still is.
    await wait(ctx, Math.max(0, HOVER_TIMING.persist - HOVER_TIMING.reveal));
    if (!(await step('visible')).visible) {
      result.failed.push('persistent');
      await show();
    }
    // Hoverable: the pointer moves onto the content the shortest way, as a person does (inside the
    // trigger to its point nearest the content, across to the nearest point of the content), and it
    // stays; then on to the content's middle. A gap between trigger and content is crossed in steps of
    // at most 4 px, so content that hides there fails. Looked at once the pointer is on the content
    // (the leg inside the trigger gets no wait: content that hides by itself is timed, see persistent).
    if (c.how === 'hover' && shown.point && (await step('visible')).visible) {
      let pos = { x: at.x, y: at.y };
      let gone = false;
      const path = hoverPath({ point: shown.point, ...(shown.near ? { near: shown.near } : {}), ...(shown.edge ? { edge: shown.edge } : {}) });
      for (const [k, to] of path.entries()) {
        await mouse.move(to.x, to.y, { steps: pointerSteps(pos, to) });
        pos = to;
        if (shown.edge && k === 0 && path.length === 3) continue;
        await wait(ctx, HOVER_TIMING.settle);
        if (!(await step('visible')).visible) { gone = true; break; }
      }
      if (gone) {
        result.failed.push('hoverable');
        await show();
      }
    }
    // Dismissible: Escape hides it without moving the pointer or focus, unless it covers nothing.
    if ((await step('visible')).visible) {
      await keyboard.press('Escape');
      await wait(ctx, HOVER_TIMING.dismiss);
      const other = (await step('visible')).visible && shown.obscures ? (await step('otherDismiss')).other : undefined;
      if (other) result.otherDismiss = other;
      else if ((await step('visible')).visible && shown.obscures) {
        // Batch 17: content shown on hover whose Escape works once keyboard focus is in its trigger (a key handler on
        // the trigger or its wrapper, as many tooltip scripts have). With the pointer resting on it and focus
        // elsewhere Escape did nothing: whether the page's Escape counts as a way to dismiss it is not decided here.
        // The extra focus and key press run under the strict guard (Sol r1 S9): nothing they set off leaves the page.
        if (c.how === 'hover') ctx.guard.latchStrict?.();
        if (c.how === 'hover' && (await step('focusIn')).focused && (await step('visible')).visible) {
          await keyboard.press('Escape');
          await wait(ctx, HOVER_TIMING.dismiss);
          if (!(await step('visible')).visible) result.scopedEscape = true;
          else result.failed.push('dismissible');
        } else result.failed.push('dismissible');
      }
    }
    return result;
  } finally {
    await mouse.move(AWAY.x, AWAY.y).catch(() => {});
    if (c.how === 'focus' || result.scopedEscape !== undefined || result.otherDismiss !== undefined || result.failed.includes('dismissible')) await step('blur').catch(() => {});
    await step('done').catch(() => {});
    await wait(ctx, HOVER_TIMING.settle).catch(() => {});
    // The guard's decisions, and what caused each write it blocked, before its log is read.
    await ctx.guard.settled?.(GUARD_SETTLE_MS).catch(() => false);
    const stopped = stoppedSince(ctx.guard, mark);
    if (stopped) result.stopped = stopped;
  }
}

/**
 * The page's result from the triggers tested: failures first; otherwise a clean result only when
 * every trigger found was tested and none was stopped by the guard or out of the pointer's reach.
 */
export function hoverFindings(results: readonly HoverResult[], found: number): ProbeFinding[] {
  const failed = results.filter((r) => r.failed.length && !r.stopped?.navigation);
  if (failed.length) return failed.map((r) => ({ criterion: '1.4.13', status: 'failed' as const, target: r.candidate.path, detail: hoverDetail(r) }));
  const stopped = results.find((r) => r.stopped);
  if (stopped) throw new ProbeNotTestable(stopped.stopped!.reason);
  const offered = results.find((r) => r.otherDismiss);
  if (offered) {
    const what = offered.text ? `“${excerpt(offered.text, 60)}”` : 'content';
    return [{ criterion: '1.4.13', status: 'not_testable', target: offered.candidate.path, detail: `Content shown ${offered.candidate.how === 'hover' ? 'on hover' : 'on focus'} (${what}) covers other content and does not hide when Escape is pressed, but the page offers another way to dismiss it (${offered.otherDismiss}), which the test does not try.` }];
  }
  const scoped = results.find((r) => r.scopedEscape);
  if (scoped) {
    const what = scoped.text ? `“${excerpt(scoped.text, 60)}”` : 'content';
    return [{ criterion: '1.4.13', status: 'not_testable', target: scoped.candidate.path, detail: `Content shown on hover (${what}) covers other content and does not hide when Escape is pressed while the pointer rests on its trigger and keyboard focus is elsewhere; it does hide on Escape once keyboard focus is in its trigger. Whether that is a way to dismiss it without moving the pointer or focus is not decided by this test.` }];
  }
  if (results.length < found) throw new ProbeNotTestable(`the time ran out after ${results.length} of ${found} hover and focus triggers`);
  const covered = results.filter((r) => r.covered).length;
  if (!results.some((r) => r.revealed)) {
    if (covered) throw new ProbeNotTestable(`the pointer could not reach the hover triggers on this page (${covered} of ${found} ${covered === 1 ? 'is' : 'are'} covered by other content)`);
    return [{ criterion: '1.4.13', status: 'not_applicable', detail: found ? 'no content appeared on hover or focus' : 'no hover or focus triggers found' }];
  }
  return [];
}

/**
 * Finds hover and focus triggers (see `hoverCandidates`) and tests each (at most 15, one per pattern,
 * while the time box allows): hover it with the pointer (or focus it), and when new content appears
 * near it, (1) wait until 2 s after it appeared: it must still be shown; (2) move the pointer onto it:
 * it must stay (also when it does not take the pointer, `pointer-events: none`: the pointer is then moved
 * over where it is shown); (3) press Escape without moving the pointer or focus: it must hide, unless it covers
 * no other content (text, images or controls under it). Failing any of the three is failed, with the
 * trigger as the target. Deep: each trigger takes about 3 s. Content drawn with CSS `::before` or
 * `::after` and native `title` tooltips are not tested (the browser draws the latter).
 */
export const hoverContentProbe: PageProbe = {
  id: 'hover-content',
  criteria: ['1.4.13'],
  kind: 'interaction',
  tier: 'deep',
  timeoutMs: 60_000,
  isolate: true,
  // Its triggers are what the page mounted: a page still putting its content in is waited for first
  // (bounded, `LATE_CONTENT_MS`); hovering is never something a page does by itself (fix/late-mount).
  waitFor: { content: true },
  async run(ctx): Promise<ProbeFinding[]> {
    const { page } = ctx;
    if (!page.mouse || !page.keyboard) throw new ProbeNotTestable('the browser cannot move the pointer or press keys, which this test needs');
    let refs: { ref: number; type: string }[] = [];
    try {
      const types = new Set<string>([...HOVER_TYPES, ...FOCUS_TYPES]);
      refs = (await ctx.listeners()).filter((l) => l.target.kind === 'element' && types.has(l.type)).map((l) => ({ ref: l.ref, type: l.type }));
    } catch {
      // Without the listener hook, style rules and tooltip markup still give triggers.
    }
    const candidates = await page.evaluate(hoverCandidates, { refs, max: HOVER_LIMITS.candidates });
    try {
      const results: HoverResult[] = [];
      for (const c of candidates) {
        if (ctx.signal.aborted || ctx.deadline - Date.now() < HOVER_LIMITS.reserveMs) break;
        results.push(await testTrigger(ctx, c));
      }
      return hoverFindings(results, candidates.length);
    } finally {
      await page.evaluate(hoverDrop, undefined).catch(() => {});
    }
  },
};
