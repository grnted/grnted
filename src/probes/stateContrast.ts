// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.3 in the hover and keyboard-focus states of a page (2026-11-10): text whose look a style rule changes
// while the pointer is on something or something has focus, and text such a rule shows only then (a hint under
// a button, a drop-down menu), must still reach 4.5:1 (3:1 when large). The SC has no exception for a state; its
// exceptions (inactive components, decoration, logotypes) are applied by the one predicate every contrast path
// shares (./contrastExempt.ts). axe reads the page at rest only.
//
// How:
// 1. Every style rule with `:hover`, `:focus`, `:focus-within` or `:focus-visible` in its selector that can
//    change how text is painted or whether it shows is read from the page's style sheets, the sheets they
//    import, and the sheets in open shadow roots. A sheet the page's scripts may not read (served from another
//    site) is fetched again, or read through the browser's own session; one that still cannot be read is a gap.
// 2. The rule names its subject (what it restyles) and its trigger (the element that carries the state: the
//    subject itself, an ancestor, or an element before it). Subjects that are alike in every way that can matter
//    (the same rules, the same state rules on the elements around them, the same look at rest) are read once.
// 3. Each is read at rest, then in its state: keyboard focus by focusing the trigger in the page; the pointer by
//    the browser's own forced `:hover` (the CDP session) on the trigger and its ancestors ONLY, one trigger at a
//    time, because one pointer is on one element and what contains it (never on two separate elements at once).
// 4. Colours come from ./contrastKit.ts (solid colours, composited; a gradient of plain colours as a range).
//    Text that reaches its threshold at rest and falls below it in the state fails; so does text that is only
//    shown in the state and is below it. Text already failing at rest is axe's (or the pixel test's) to report.
//    A failure here is `minor`.
// Unknown is never clean: whatever was found but could not be measured (a picture behind it, no session to hold
// the pointer state, a style sheet that could not be read, more than the limits) is returned as a gap, and the
// caller reports the criterion as not testable for the page unless a failure decides it.
// Engine core: no Node-only imports.
import type { CDPSessionLike, ProbeFinding } from '../types.js';
import { CONTRAST_EXEMPT_KEY, installContrastExempt } from './contrastExempt.js';
import { CONTRAST_KIT_KEY, installContrastKit, PAINT_GAP_TEXT, paintVerdict, type Paint } from './contrastKit.js';
import { hex, ratioText } from './pixels.js';
import type { ProbeContext } from './types.js';

export const STATE_LIMITS = {
  /** Style rules looked at per page; more is a gap. */
  rules: 60_000,
  /** Style sheets fetched again because the page may not read them, and the time for each. */
  sheets: 8,
  sheetMs: 2500,
  /** Subjects of state rules looked at per page; more is a gap. */
  subjects: 6000,
  /** Different kinds of subject read in their states per page; more is a gap. */
  readings: 40,
  /** Differently painted texts read inside one subject; more is a gap. */
  texts: 6,
  /** Failed findings per page: text whose look changes, and text shown only in a state. */
  findings: 5,
  revealFindings: 3,
  /** A ratio this close under the threshold is not failed (rounding of the colours read). */
  margin: 0.05,
  /** Time for each CDP call, and for the whole check on one page. */
  callMs: 4000,
  budgetMs: 8000,
} as const;

type Mode = 'hover' | 'focus' | 'both';
const KEY = '__grntedStates';

/** What the page's state rules could not be read from. */
export interface RuleGaps {
  /** Style sheets that could not be read (addresses). */
  unread: string[];
  /** More rules than the limit. */
  capped: boolean;
}

/**
 * Runs in the page (self-contained, async): keeps on the window every style rule with a hover or focus state in
 * its selector, from the document's sheets, the sheets they import, adopted sheets and open shadow roots; a sheet
 * the page may not read is fetched again (`fetch`, no credentials) and parsed. Returns what could not be read.
 */
export async function stateRules(arg: { key: string; rules: number; sheets: number; sheetMs: number }): Promise<RuleGaps> {
  const STATE = /:(?:hover|focus-within|focus-visible|focus)(?![\w-])/;
  const kept: { selector: string; style: CSSStyleDeclaration; root: Document | ShadowRoot }[] = [];
  const unread: string[] = [];
  let seen = 0;
  let capped = false;
  const media = (text: string) => { try { return !text || window.matchMedia(text).matches; } catch { return true; } };
  const walk = (list: CSSRuleList, root: Document | ShadowRoot, parent = '') => {
    for (const rule of list) {
      if (++seen > arg.rules) { capped = true; return; }
      if (rule instanceof CSSStyleRule) {
        // A nested rule's `&` stands for its parent's selector.
        const selector = parent ? (rule.selectorText.includes('&') ? rule.selectorText.replace(/&/g, `:is(${parent})`) : `:is(${parent}) ${rule.selectorText}`) : rule.selectorText;
        if (STATE.test(selector)) kept.push({ selector, style: rule.style, root });
        if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules, root, selector);
      } else if (rule instanceof CSSImportRule) {
        if (!media(rule.media.mediaText)) continue;
        try { if (rule.styleSheet) walk(rule.styleSheet.cssRules, root); } catch { unread.push(rule.styleSheet?.href ?? rule.href); }
      } else if (rule instanceof CSSMediaRule) {
        if (media(rule.conditionText)) walk(rule.cssRules, root, parent);
      } else if ('cssRules' in rule) {
        // @supports, @layer, @container, @scope: read as if they apply (what applies is then read from the element).
        try { walk((rule as CSSGroupingRule).cssRules, root, parent); } catch { /* nothing to walk */ }
      }
    }
  };
  const sheetsOf = (root: Document | ShadowRoot) => [...root.styleSheets, ...(root.adoptedStyleSheets ?? [])];
  const roots: (Document | ShadowRoot)[] = [document];
  let looked = 0;
  for (const el of document.querySelectorAll('*')) {
    if (++looked > 20_000) break;
    if (el.shadowRoot) roots.push(el.shadowRoot);
  }
  for (const root of roots) {
    for (const sheet of sheetsOf(root)) {
      if (sheet.disabled || !media(sheet.media.mediaText)) continue;
      try { walk(sheet.cssRules, root); } catch { if (sheet.href) unread.push(sheet.href); }
    }
  }
  // Sheets the page may not read: the same file again, as text.
  const failed: string[] = [];
  let fetched = 0;
  const read = async (href: string, depth: number): Promise<void> => {
    if (fetched++ >= arg.sheets || depth > 2) { failed.push(href); return; }
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), arg.sheetMs);
    try {
      const res = await fetch(href, { mode: 'cors', credentials: 'omit', signal: stop.signal });
      if (!res.ok) throw new Error('not read');
      const text = await res.text();
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text.replace(/@import[^;]+;/gi, ''));
      walk(sheet.cssRules, document);
      for (const m of text.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi)) await read(new URL(m[1]!, href).href, depth + 1);
    } catch {
      failed.push(href);
    } finally {
      clearTimeout(timer);
    }
  };
  for (const href of [...new Set(unread)]) await read(href, 0);
  (window as unknown as Record<string, unknown>)[`${arg.key}Rules`] = kept;
  return { unread: failed, capped };
}

/** Runs in the page (self-contained): adds the state rules of a style sheet given as text (read through the browser's session). False when it holds an import that was not followed. */
export function addStateSheet(arg: { key: string; text: string }): boolean {
  const STATE = /:(?:hover|focus-within|focus-visible|focus)(?![\w-])/;
  const kept = ((window as unknown as Record<string, unknown>)[`${arg.key}Rules`] ??= []) as { selector: string; style: CSSStyleDeclaration; root: Document }[];
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(arg.text.replace(/@import[^;]+;/gi, ''));
  const walk = (list: CSSRuleList, parent = '') => {
    for (const rule of list) {
      if (rule instanceof CSSStyleRule) {
        const selector = parent ? (rule.selectorText.includes('&') ? rule.selectorText.replace(/&/g, `:is(${parent})`) : `:is(${parent}) ${rule.selectorText}`) : rule.selectorText;
        if (STATE.test(selector)) kept.push({ selector, style: rule.style, root: document });
        if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules, selector);
      } else if (rule instanceof CSSMediaRule) {
        let on = true;
        try { on = window.matchMedia(rule.conditionText).matches; } catch { on = true; }
        if (on) walk(rule.cssRules, parent);
      } else if ('cssRules' in rule) {
        try { walk((rule as CSSGroupingRule).cssRules, parent); } catch { /* nothing to walk */ }
      }
    }
  };
  walk(sheet.cssRules);
  return !/@import/i.test(arg.text);
}

/** One kind of restyled text to read in its state. */
export interface StateSubject {
  mode: Mode;
  /** The pointer (or focus) is on the text's own element or on something that contains it; false: on an element before it. */
  own: boolean;
  /** What the trigger is called (its label or words, max 60), for text it does not contain. */
  trigger: string;
  /** For hover: indexes (into the kept node list) of the elements the pointer is on (the text's own element, or the trigger, with its ancestors). */
  chain: number[];
  /** Other texts of the same kind (the same rules around them and the same look at rest): what holds for this one holds for them. */
  others: { path: string; text: string }[];
}

export interface SubjectList {
  subjects: StateSubject[];
  /** Kinds of text beyond the limit: not read. */
  dropped: number;
  /** More subjects or texts than the limits: not all looked at. */
  capped: boolean;
  /** Elements to put the pointer on, for the CDP session (kept on the window in this order). */
  nodes: number;
}

/**
 * Runs in the page (self-contained): from the kept state rules, the texts to read (one of each kind, see the
 * file's comment), kept on the window with their triggers. A text is its own entry: every differently painted
 * text inside what a rule restyles; a subject that does not show at rest is one entry (its texts are whatever it
 * shows in the state).
 */
export function stateSubjects(arg: { key: string; subjects: number; readings: number; exemptKey: string }): SubjectList {
  const w = window as unknown as Record<string, unknown>;
  const rules = (w[`${arg.key}Rules`] as { selector: string; style: CSSStyleDeclaration; root: Document | ShadowRoot }[] | undefined) ?? [];
  const exempt = w[arg.exemptKey] as ((el: Element) => string | null) | undefined;
  if (!exempt) throw new Error('the contrast exemptions are not installed');
  const STATE = /:(hover|focus-within|focus-visible|focus)(?![\w-])/g;
  // What a rule must set to matter: how text is painted, or whether something shows (a menu can be opened by size,
  // position or clipping as well as by display). Underlines, outlines, borders and shadows change neither.
  const PAINT = /^(?:color|background|background-color|background-image|opacity|filter|text-shadow|-webkit-text-fill-color|mix-blend-mode|fill)$/;
  const SHOW = /^(?:display|visibility|opacity|clip|clip-path|height|max-height|width|max-width|transform|translate|scale|left|right|top|bottom|inset|margin|margin-left|margin-top|position|overflow|content-visibility|z-index)$/;
  const matters = (st: CSSStyleDeclaration): boolean => {
    for (let i = 0; i < st.length; i++) {
      const name = st[i]!;
      if (name.startsWith('--') || PAINT.test(name) || SHOW.test(name) || name.startsWith('background-') || name.startsWith('inset-') || name.startsWith('overflow-')) return true;
    }
    return false;
  };
  const parts = (sel: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let from = 0;
    for (let i = 0; i < sel.length; i++) {
      const ch = sel[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) { out.push(sel.slice(from, i)); from = i + 1; }
    }
    out.push(sel.slice(from));
    return out.map((x) => x.trim()).filter(Boolean);
  };
  /** The index of each combinator outside parentheses. */
  const combinators = (sel: string): number[] => {
    const out: number[] = [];
    let depth = 0;
    for (let i = 0; i < sel.length; i++) {
      const ch = sel[i]!;
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (depth === 0 && (ch === ' ' || ch === '>' || ch === '+' || ch === '~')) out.push(i);
    }
    return out;
  };
  const strip = (x: string) => x.replace(STATE, '');
  const rendered = (el: Element) => typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const shown = (el: Element) => rendered(el) && el.getBoundingClientRect().width >= 4 && el.getBoundingClientRect().height >= 4;
  const hasWords = (el: Element) => /[\p{L}\p{N}]{2}/u.test(el.textContent ?? '');
  const ownWords = (el: Element) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue ?? '').join(' ').replace(/\s+/g, ' ').trim();
  const up = (a: Element): Element | null => a.parentElement ?? ((a.getRootNode() as ShadowRoot).host ?? null);

  interface Entry { subject: Element; trigger: Element; modes: Set<'hover' | 'focus'>; both: boolean; rules: number[] }
  const entries = new Map<Element, Map<Element, Entry>>();
  /** State rules whose trigger compound matches an element: the look inside it may change when the pointer is in it. */
  const around = new Map<Element, number[]>();
  let count = 0;
  let capped = false;
  rules.forEach((rule, index) => {
    if (capped || !matters(rule.style)) return;
    for (const sel of parts(rule.selector)) {
      if (sel.includes('::') || /:not\([^)]*:(?:hover|focus)/.test(sel)) continue;
      const cuts = combinators(sel);
      // The last compound that carries a state: its element is the trigger.
      const bounds = [0, ...cuts.map((c) => c + 1), sel.length + 1];
      let at = -1;
      for (let i = bounds.length - 2; i >= 0; i--) {
        STATE.lastIndex = 0;
        if (STATE.test(sel.slice(bounds[i]!, bounds[i + 1]! - 1))) { at = i; break; }
      }
      STATE.lastIndex = 0;
      if (at < 0) continue;
      const kinds = new Set<'hover' | 'focus'>();
      for (const m of sel.matchAll(STATE)) kinds.add(m[1] === 'hover' ? 'hover' : 'focus');
      const triggerSel = strip(sel.slice(0, bounds[at + 1]! - 1)).trim();
      const own = at === bounds.length - 2;
      const subjectSel = strip(sel).trim();
      if (!triggerSel || !subjectSel || /[\s>+~]$/.test(triggerSel) || /^[>+~]/.test(subjectSel)) continue;
      let subjects: Element[] = [];
      try { subjects = [...rule.root.querySelectorAll(subjectSel)]; } catch { continue; }
      const matches = (el: Element) => { try { return el.matches(triggerSel); } catch { return false; } };
      for (const subject of subjects) {
        if (count >= arg.subjects) { capped = true; break; }
        if (!hasWords(subject)) continue;
        let trigger: Element | null = own ? subject : null;
        for (let a: Element | null = subject; a && !trigger; a = up(a)) {
          if (a !== subject && matches(a)) { trigger = a; break; }
          for (let x = a.previousElementSibling; x; x = x.previousElementSibling) if (matches(x)) { trigger = x; break; }
        }
        if (!trigger || exempt(trigger) === 'inactive') continue;
        let per = entries.get(subject);
        if (!per) entries.set(subject, per = new Map());
        let e = per.get(trigger);
        if (!e) { per.set(trigger, e = { subject, trigger, modes: new Set(), both: false, rules: [] }); count++; }
        if (kinds.size === 2) e.both = true;
        else for (const k of kinds) e.modes.add(k);
        e.rules.push(index);
        const list = around.get(trigger);
        if (list) { if (list[list.length - 1] !== index) list.push(index); } else around.set(trigger, [index]);
      }
    }
  });

  // The pointer reaches only what is on the page: a skip link kept off screen until it has focus has no hover state.
  // What is not rendered at all may be shown by the pointer being on something around it (a link in a closed menu):
  // the reading with the pointer on it and its ancestors decides.
  const reachable = (el: Element) => {
    if (!rendered(el)) return true;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.bottom + window.scrollY > 0 && r.right + window.scrollX > 0
      && r.left + window.scrollX < Math.max(document.documentElement.scrollWidth, window.innerWidth)
      && r.top + window.scrollY < Math.max(document.documentElement.scrollHeight, window.innerHeight)
      && (cs.clipPath === 'none' || !cs.clipPath) && (cs.clip === 'auto' || !cs.clip);
  };
  // A cheap look at rest, for telling kinds of text apart: colours, the first backdrop above, size class.
  const restLook = (el: Element): string => {
    const st = getComputedStyle(el);
    let behind = '';
    for (let a: Element | null = el; a; a = up(a)) {
      const x = a === el ? st : getComputedStyle(a);
      if (x.backgroundImage !== 'none' || !/^(?:rgba\(0, 0, 0, 0\)|transparent)$/.test(x.backgroundColor)) { behind = `${x.backgroundColor}|${x.backgroundImage}|${x.opacity}`; break; }
    }
    const size = parseFloat(st.fontSize) || 16;
    return `${st.color}|${behind}|${size >= 24 || (size >= 18.66 && Number(st.fontWeight) >= 700) ? 'L' : 'S'}|${el.getAttribute('style') ?? ''}`;
  };
  const chainRules = (from: Element): string => {
    const out: string[] = [];
    for (let a: Element | null = from; a; a = up(a)) out.push(around.get(a)?.join('.') ?? '');
    return out.join('/').replace(/\/+$/, '');
  };
  const esc = (x: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(x) : x);
  const cssPath = (el: Element): string => {
    const out: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && document.querySelectorAll(`#${esc(cur.id)}`).length === 1) { out.unshift(`#${esc(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      if (!parent) { out.unshift(cur.localName); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      out.unshift(same.length > 1 ? `${cur.localName}:nth-of-type(${same.indexOf(cur) + 1})` : cur.localName);
    }
    return out.join(' > ');
  };

  // Every text to read: the texts a shown subject holds, each with the pointer on the text itself when the trigger
  // contains it (one pointer is on the text, the trigger and everything around them at once), on the trigger when
  // the trigger is an element before it; a subject that does not show at rest as one entry.
  interface Item { subject: Element; trigger: Element; text: Element | null; mode: Mode; own: boolean; rules: number[] }
  const items: Item[] = [];
  const MAX_ITEMS = arg.subjects * 2;
  for (const per of entries.values()) {
    for (const e of per.values()) {
      const modes: Mode[] = [...e.modes, ...(e.both ? ['both' as const] : [])];
      const inside = e.trigger === e.subject || e.trigger.contains(e.subject);
      const texts: (Element | null)[] = [];
      if (shown(e.subject)) {
        let scanned = 0;
        for (const el of [e.subject, ...e.subject.querySelectorAll('*')]) {
          if (++scanned > 200) { capped = true; break; }
          if (/[\p{L}\p{N}]{2}/u.test(ownWords(el)) && shown(el) && exempt(el) === null) texts.push(el);
        }
      } else texts.push(null);
      for (const text of texts) {
        for (const mode of modes) {
          if (items.length >= MAX_ITEMS) { capped = true; break; }
          items.push({ subject: e.subject, trigger: e.trigger, text, mode, own: inside, rules: e.rules });
        }
      }
    }
  }
  const at = (it: Item) => it.text ?? it.subject;
  items.sort((a, b) => (at(a) === at(b) ? 0 : at(a).compareDocumentPosition(at(b)) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const kinds = new Map<string, { item: Item; others: { path: string; text: string }[] }>();
  for (const it of items) {
    // Where the pointer is: on the text itself when the trigger contains it, else on the trigger.
    const pointer = it.own ? at(it) : it.trigger;
    if (it.mode !== 'focus' && !reachable(pointer)) continue;
    let depth = 0;
    if (it.text) for (let a: Element | null = it.text; a && a !== it.subject; a = up(a)) depth++;
    const sig = `${it.mode}|${it.rules.join('.')}|${chainRules(pointer)}|${it.own ? 'in' : `after:${chainRules(it.trigger)}`}|${depth}|${it.text ? restLook(it.text) : `hidden|${it.subject.localName}`}`;
    const had = kinds.get(sig);
    if (!had) kinds.set(sig, { item: it, others: [] });
    else if (it.text && had.others.length < 4) { const t = ownWords(it.text); had.others.push({ path: cssPath(it.text), text: t.length > 80 ? `${t.slice(0, 79)}…` : t }); }
  }
  const picked = [...kinds.values()].slice(0, arg.readings);
  const nodes: Element[] = [];
  const indexOf = new Map<Element, number>();
  const nameOf = (t: Element) => {
    const own = (t.getAttribute('aria-label') || ownWords(t) || (t.querySelector('a, button, summary, span') ?? t).textContent || '').replace(/\s+/g, ' ').trim();
    return own.length > 60 ? `${own.slice(0, 59)}…` : own;
  };
  const subjects: StateSubject[] = picked.map(({ item, others }) => {
    const chain: number[] = [];
    if (item.mode !== 'focus') {
      for (let a: Element | null = item.own ? at(item) : item.trigger; a; a = a.parentElement) {
        let i = indexOf.get(a);
        if (i === undefined) { i = nodes.push(a) - 1; indexOf.set(a, i); }
        chain.push(i);
      }
    }
    return { mode: item.mode, own: item.own, trigger: nameOf(item.trigger), chain, others };
  });
  w[arg.key] = picked.map(({ item }) => ({ subject: item.subject, trigger: item.trigger, text: item.text }));
  w[`${arg.key}Nodes`] = nodes;
  return { subjects, dropped: kinds.size - picked.length, capped, nodes: nodes.length };
}

/** One text of a subject as read in one state. */
export interface StateText extends Paint {
  path: string;
  text: string;
  shown: boolean;
}

export interface StateRead {
  /** For a focus reading: the trigger (or something in it) took keyboard focus. */
  focused?: boolean;
  /** The subject shows. */
  shown: boolean;
  texts: StateText[];
  /** Differently painted texts beyond the limit: not read. */
  more: number;
}

/**
 * Runs in the page (self-contained): one kept entry as it is painted now, with transitions and animations off
 * (a colour half way through a transition is no state). `focus`: the trigger (or the first thing in it that takes
 * focus) is focused first and blurred after. An entry with a text gives that text; an entry for a subject that
 * does not show at rest gives nothing at rest and, in the state, the differently painted texts it shows then.
 */
export function readState(arg: { key: string; kitKey: string; exemptKey: string; index: number; rest: boolean; focus: boolean; texts: number }): StateRead {
  const w = window as unknown as Record<string, unknown>;
  const kept = (w[arg.key] as { subject: Element; trigger: Element; text: Element | null }[] | undefined)?.[arg.index];
  const kit = w[arg.kitKey] as { paint(el: Element, pseudo?: string): Paint } | undefined;
  const exempt = w[arg.exemptKey] as ((el: Element) => string | null) | undefined;
  if (!kit || !exempt) throw new Error('the contrast helpers are not installed');
  const none: StateRead = { shown: false, texts: [], more: 0 };
  if (!kept || !kept.subject.isConnected || !kept.trigger.isConnected) return none;
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s);
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && document.querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      if (!parent) { parts.unshift(cur.localName); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${cur.localName}:nth-of-type(${same.indexOf(cur) + 1})` : cur.localName);
    }
    return parts.join(' > ');
  };
  // Shown: rendered, of some size, and not cut away by a box that clips it (a menu kept shut by its height).
  const shown = (el: Element): boolean => {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    let r: { left: number; top: number; right: number; bottom: number } = el.getBoundingClientRect();
    if (r.right - r.left < 4 || r.bottom - r.top < 4) return false;
    for (let a = el.parentElement; a; a = a.parentElement) {
      const st = getComputedStyle(a);
      if (st.overflowX === 'visible' && st.overflowY === 'visible') continue;
      const b = a.getBoundingClientRect();
      r = { left: Math.max(r.left, b.left), top: Math.max(r.top, b.top), right: Math.min(r.right, b.right), bottom: Math.min(r.bottom, b.bottom) };
      if (r.right - r.left < 4 || r.bottom - r.top < 4) return false;
    }
    // Moved off the page (a menu parked at left: -9999px, a skip link above the top).
    return r.right + window.scrollX > 0 && r.bottom + window.scrollY > 0;
  };
  const words = (el: Element) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue ?? '').join(' ').replace(/\s+/g, ' ').trim();
  const textual = (el: Element) => /[\p{L}\p{N}]{2}/u.test(words(el));
  const read = (el: Element): StateText => {
    const t = words(el);
    return { ...kit.paint(el), path: cssPath(el), text: t.length > 80 ? `${t.slice(0, 79)}…` : t, shown: shown(el) };
  };
  /** The differently painted texts the subject shows now (one of each look), and how many more looks there are. */
  const pick = (): { els: Element[]; more: number } => {
    const looks = new Map<string, Element>();
    let scanned = 0;
    for (const el of [kept.subject, ...kept.subject.querySelectorAll('*')]) {
      if (++scanned > 400) break;
      if (!textual(el) || !shown(el) || exempt(el) !== null) continue;
      const look = kit.paint(el).look;
      if (!looks.has(look)) looks.set(look, el);
    }
    const els = [...looks.values()];
    return { els: els.slice(0, arg.texts), more: Math.max(0, els.length - arg.texts) };
  };

  let sheet: CSSStyleSheet | null = null;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync('*, *::before, *::after { transition: none !important; animation: none !important; }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    sheet = null;
  }
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
  const before = document.activeElement;
  let focused: HTMLElement | null = null;
  try {
    if (arg.focus) {
      const t = kept.trigger;
      // The trigger itself when it takes focus; for a container (`:focus-within`), the first thing in it that does and is not inside a subject it only shows.
      const target = (t.matches(FOCUSABLE) ? t : [...t.querySelectorAll(FOCUSABLE)].find((c) => (t === kept.subject || !kept.subject.contains(c)) && shown(c))) as HTMLElement | undefined;
      if (!target) return { ...none, focused: false };
      try { target.focus({ preventScroll: true }); } catch { /* not focusable */ }
      if (document.activeElement !== target) return { ...none, focused: false };
      focused = target;
    }
    const state = arg.focus ? { focused: true } : {};
    if (kept.text) return { ...state, shown: shown(kept.text), texts: [read(kept.text)], more: 0 };
    // A subject that did not show at rest: nothing at rest; in the state, what it shows then.
    if (arg.rest || !shown(kept.subject)) return { ...state, shown: false, texts: [], more: 0 };
    const p = pick();
    return { ...state, shown: true, texts: p.els.map(read), more: p.more };
  } finally {
    if (focused) {
      try { focused.blur(); } catch { /* keep */ }
      if (before instanceof HTMLElement && before !== document.body) { try { before.focus({ preventScroll: true }); } catch { /* keep */ } }
    }
    if (sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== sheet);
  }
}

/** Runs in the page: forgets everything kept. */
export function dropStates(key: string): void {
  const w = window as unknown as Record<string, unknown>;
  delete w[key];
  delete w[`${key}Nodes`];
  delete w[`${key}Rules`];
}

async function within<T>(ms: number, p: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p.catch(() => fallback), new Promise<T>((r) => { timer = setTimeout(() => r(fallback), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The browser's own `:hover` (CDP `CSS.forcePseudoState`) on chosen elements of the list the page keeps at
 * `window[listKey]`: no pointer moves, nothing scrolls, the page hears no event. `set` puts the pointer on exactly
 * the given elements (a trigger and its ancestors) and takes it off every other; `end` takes it off all of them.
 */
export class HoverForcer {
  private nodes: number[] = [];
  private on = new Set<number>();
  private constructor(private readonly cdp: CDPSessionLike) {}

  private send<R>(method: string, params?: Record<string, unknown>): Promise<R | undefined> {
    return within(STATE_LIMITS.callMs, this.cdp.send(method, params) as Promise<R>, undefined as R | undefined);
  }

  /** Null when the browser has no session or the elements cannot be reached through it. */
  static async start(session: NonNullable<ProbeContext['cdp']>, listKey: string, count: number): Promise<HoverForcer | null> {
    const cdp: CDPSessionLike | undefined = await within(STATE_LIMITS.callMs, session(), undefined);
    if (!cdp) return null;
    const f = new HoverForcer(cdp);
    try {
      await f.send('DOM.enable');
      await f.send('CSS.enable');
      await f.send('DOM.getDocument', { depth: 0 });
      const list = await f.send<{ result?: { objectId?: string } }>('Runtime.evaluate', { expression: `window[${JSON.stringify(listKey)}]`, returnByValue: false });
      const objectId = list?.result?.objectId;
      if (!objectId) { await f.end(); return null; }
      const props = await f.send<{ result?: { name: string; value?: { objectId?: string } }[] }>('Runtime.getProperties', { objectId, ownProperties: true });
      const ids = (props?.result ?? []).filter((p) => /^\d+$/.test(p.name) && p.value?.objectId).sort((a, b) => Number(a.name) - Number(b.name));
      const asked = await Promise.all(ids.map((p) => f.send<{ nodeId?: number }>('DOM.requestNode', { objectId: p.value!.objectId! })));
      if (asked.length !== count || asked.some((n) => typeof n?.nodeId !== 'number' || n.nodeId <= 0)) { await f.end(); return null; }
      f.nodes = asked.map((n) => n!.nodeId!);
      return f;
    } catch {
      await f.end();
      return null;
    }
  }

  /** True when exactly these elements are hovered now. */
  async set(indexes: readonly number[]): Promise<boolean> {
    const want = new Set(indexes);
    const off = [...this.on].filter((i) => !want.has(i));
    const on = [...want].filter((i) => !this.on.has(i));
    const done = await Promise.all([
      ...off.map((i) => this.send<object>('CSS.forcePseudoState', { nodeId: this.nodes[i]!, forcedPseudoClasses: [] })),
      ...on.map((i) => this.send<object>('CSS.forcePseudoState', { nodeId: this.nodes[i]!, forcedPseudoClasses: ['hover'] })),
    ]);
    for (const i of off) this.on.delete(i);
    if (done.some((d) => d === undefined)) return false;
    for (const i of on) this.on.add(i);
    return true;
  }

  async end(): Promise<void> {
    await Promise.all([...this.on].map((i) => this.send('CSS.forcePseudoState', { nodeId: this.nodes[i]!, forcedPseudoClasses: [] })));
    this.on.clear();
    await this.send('CSS.disable');
    await this.send('DOM.disable');
  }
}

/** What one subject showed: at rest, and in the state it was read in. */
export interface SubjectReading {
  subject: StateSubject;
  rest: StateRead;
  /** `'unheld'`: the state could not be held (no session for the pointer). */
  state: StateRead | 'unheld';
}

const sizeText = (px: number) => `${Math.round(px * 10) / 10} px`;
const onText = (v: { bg: [number, number, number]; several: boolean }) => (v.several ? `a gradient, at best ${hex(v.bg)}` : hex(v.bg));

/** What a check found and could not measure, in the report's words, with how many texts each. */
export type Gaps = Map<string, number>;
export const addGap = (gaps: Gaps, why: string, n = 1): void => { gaps.set(why, (gaps.get(why) ?? 0) + n); };

/** The gaps as one reason, for a not_testable finding. */
export function gapsText(gaps: Gaps): string {
  return [...gaps.entries()].map(([why, n]) => (n > 1 ? `${why} (${n})` : why)).join('; ');
}

/**
 * The failed findings and the gaps from the readings. Pure.
 * - Text shown at rest whose look changes in the state: failed when it does not fail at rest and is below its
 *   threshold in the state; a gap when the look changes and the look in the state cannot be told.
 * - Text shown only in the state: failed when below its threshold there; a gap when it cannot be told.
 * One finding per text (naming every state it fails in), and one for each other text of the same kind up to the
 * limit; for text shown only in a state, one per place (a menu's faint links are one finding). `minor` (the text
 * reads at rest, or is not there at rest).
 */
export function stateFindings(readings: readonly SubjectReading[]): { findings: ProbeFinding[]; gaps: Gaps } {
  const gaps: Gaps = new Map();
  interface Hit { path: string; text: string; ratio: number; fg: [number, number, number]; bg: [number, number, number]; several: boolean; threshold: number; fontSize: number; rest?: number; when: Set<Mode>; own: boolean; trigger: string; revealed: boolean; others: { path: string; text: string }[] }
  const hits = new Map<string, Hit>();
  /** Readings that already gave a finding for text shown only in a state. */
  const places = new Set<number>();
  readings.forEach((r, index) => {
    const s = r.subject;
    if (r.state === 'unheld') {
      addGap(gaps, 'the browser could not hold the pointer on an element for the test');
      return;
    }
    // A trigger that does not take keyboard focus has no focus state to read.
    if (s.mode !== 'hover' && r.state.focused === false) return;
    if (r.state.more) addGap(gaps, 'more differently painted texts in one place than the test reads', r.state.more);
    const add = (t: StateText, v: { ratio: number; fg: [number, number, number]; bg: [number, number, number]; several: boolean; threshold: number }, revealed: boolean, rest?: number) => {
      const key = `${revealed}|${t.path}`;
      const had = hits.get(key);
      if (had) {
        had.when.add(s.mode);
        if (v.ratio < had.ratio) Object.assign(had, { ratio: v.ratio, fg: v.fg, bg: v.bg, several: v.several });
        return;
      }
      // The first failing text of a place stands for it.
      if (revealed) { if (places.has(index)) return; places.add(index); }
      hits.set(key, {
        path: t.path, text: t.text, ratio: v.ratio, fg: v.fg, bg: v.bg, several: v.several, threshold: v.threshold, fontSize: t.fontSize, ...(rest !== undefined ? { rest } : {}),
        when: new Set([s.mode]), own: s.own, trigger: s.trigger, revealed, others: revealed ? [] : s.others,
      });
    };
    const was = r.rest.texts[0];
    if (was && was.shown) {
      const now = r.state.texts[0];
      if (!now || !now.shown || was.look === now.look) return;
      const before = paintVerdict(was, STATE_LIMITS.margin);
      // Below its threshold at rest already: reported there (axe, or the pixels), not here.
      if (before.kind === 'fail') return;
      const after = paintVerdict(now, STATE_LIMITS.margin);
      if (after.kind === 'unknown') { addGap(gaps, `text changes its look on hover or focus where ${PAINT_GAP_TEXT[after.why]}`, 1 + s.others.length); return; }
      // What it was at rest may be the pixel test's to say; in the state it is told from colours, and a failure there stands.
      if (after.kind === 'fail') add(now, after, false, before.kind === 'pass' ? before.ratio : undefined);
      return;
    }
    // Not shown at rest: what the state shows.
    for (const now of r.state.texts) {
      if (!now.shown) continue;
      const v = paintVerdict(now, STATE_LIMITS.margin);
      if (v.kind === 'unknown') addGap(gaps, `text shown only on hover or focus where ${PAINT_GAP_TEXT[v.why]}`);
      else if (v.kind === 'fail') add(now, v, true);
    }
  });
  const findings: ProbeFinding[] = [];
  let changed = 0;
  let revealed = 0;
  for (const h of hits.values()) {
    const focus = h.when.has('focus') || h.when.has('both');
    const hover = h.when.has('hover') || h.when.has('both');
    if (h.revealed) {
      if (revealed++ >= STATE_LIMITS.revealFindings) continue;
      const name = h.trigger ? `“${h.trigger}”` : 'a control';
      const when = [focus ? `${name} has keyboard focus` : '', hover ? (focus ? 'the pointer is on it' : `the pointer is on ${name}`) : ''].filter(Boolean).join(' or ');
      findings.push({
        criterion: '1.4.3', status: 'failed', minor: true, target: h.path, data: { kind: 'state' },
        detail: `Text shown only when ${when} has ${ratioText(h.ratio)} contrast (text ${hex(h.fg)} on ${onText(h)}); ${sizeText(h.fontSize)} text needs at least ${h.threshold}:1: “${h.text}”`,
      });
      continue;
    }
    const what = h.own ? 'it' : h.trigger ? `“${h.trigger}”` : 'the element before it';
    const when = [focus ? `when ${what} has keyboard focus` : '', hover ? `when the pointer is on ${what}` : ''].filter(Boolean).join(' and ');
    for (const t of [{ path: h.path, text: h.text }, ...h.others]) {
      if (changed++ >= STATE_LIMITS.findings) break;
      findings.push({
        criterion: '1.4.3', status: 'failed', minor: true, target: t.path, data: { kind: 'state' },
        detail: `Text contrast drops to ${ratioText(h.ratio)} ${when} (text ${hex(h.fg)} on ${onText(h)}${h.rest !== undefined ? `; ${ratioText(h.rest)} at rest` : ''}); ${sizeText(h.fontSize)} text needs at least ${h.threshold}:1: “${t.text}”`,
      });
    }
  }
  return { findings, gaps };
}

/**
 * Text contrast in the hover and keyboard-focus states of this page (see the file's comment). Never throws.
 * `findings`: the failures. `gaps`: what was found and could not be measured; when it is not empty the page's
 * hover and focus states are not fully known, and the caller must not report the criterion clean.
 * Cost: one read of the style rules; then, per kind of restyled text (at most 40), two or three calls into the
 * page and a few CDP calls. A page with no such rule costs the one read.
 */
export async function stateContrast(ctx: Pick<ProbeContext, 'page' | 'cdp'> & Partial<Pick<ProbeContext, 'deadline'>>): Promise<{ findings: ProbeFinding[]; gaps: Gaps }> {
  const { page } = ctx;
  const gaps: Gaps = new Map();
  const end = Math.min(Date.now() + STATE_LIMITS.budgetMs, (ctx.deadline ?? Infinity) - 1500);
  let forcer: HoverForcer | null = null;
  try {
    await page.evaluate(installContrastExempt, CONTRAST_EXEMPT_KEY);
    await page.evaluate(installContrastKit, CONTRAST_KIT_KEY);
    const rules = await page.evaluate(stateRules, { key: KEY, rules: STATE_LIMITS.rules, sheets: STATE_LIMITS.sheets, sheetMs: STATE_LIMITS.sheetMs });
    if (rules.capped) addGap(gaps, 'the page has more style rules than the test reads');
    // What the page's scripts could not read, through the browser's own session.
    let unread = rules.unread;
    if (unread.length && ctx.cdp) {
      const cdp = await within(STATE_LIMITS.callMs, ctx.cdp(), undefined);
      if (cdp) {
        const left: string[] = [];
        await within(STATE_LIMITS.callMs, cdp.send('Page.enable') as Promise<unknown>, undefined);
        const tree = await within(STATE_LIMITS.callMs, cdp.send('Page.getFrameTree') as Promise<{ frameTree?: { frame?: { id?: string } } }>, undefined);
        const frameId = tree?.frameTree?.frame?.id;
        for (const url of unread) {
          const got = frameId ? await within(STATE_LIMITS.callMs, cdp.send('Page.getResourceContent', { frameId, url }) as Promise<{ content?: string; base64Encoded?: boolean }>, undefined) : undefined;
          const whole = got && typeof got.content === 'string' && !got.base64Encoded ? await page.evaluate(addStateSheet, { key: KEY, text: got.content }).catch(() => false) : false;
          if (!whole) left.push(url);
        }
        unread = left;
      }
    }
    if (unread.length) addGap(gaps, 'a style sheet from another site could not be read, so its hover and focus rules are not known', unread.length);

    const list = await page.evaluate(stateSubjects, { key: KEY, subjects: STATE_LIMITS.subjects, readings: STATE_LIMITS.readings, exemptKey: CONTRAST_EXEMPT_KEY });
    if (list.capped) addGap(gaps, 'the page restyles more elements on hover or focus than the test reads');
    if (list.dropped) addGap(gaps, 'more kinds of text restyled on hover or focus than the test reads', list.dropped);
    if (!list.subjects.length) return { findings: [], gaps };
    const read = (index: number, rest: boolean, focus: boolean) => page.evaluate(readState, { key: KEY, kitKey: CONTRAST_KIT_KEY, exemptKey: CONTRAST_EXEMPT_KEY, index, rest, focus, texts: STATE_LIMITS.texts });
    const readings: SubjectReading[] = [];
    if (list.subjects.some((s) => s.mode !== 'focus') && ctx.cdp) forcer = await HoverForcer.start(ctx.cdp, `${KEY}Nodes`, list.nodes);
    for (let i = 0; i < list.subjects.length; i++) {
      const subject = list.subjects[i]!;
      if (Date.now() > end) { addGap(gaps, 'the time for the test ran out before every hover and focus state was read', list.subjects.length - i); break; }
      if (forcer && !(await forcer.set([]))) { forcer = null; }
      const rest = await read(i, true, false);
      if (subject.mode === 'focus') { readings.push({ subject, rest, state: await read(i, false, true) }); continue; }
      if (!forcer || !(await forcer.set(subject.chain))) { readings.push({ subject, rest, state: 'unheld' }); continue; }
      readings.push({ subject, rest, state: await read(i, false, subject.mode === 'both') });
    }
    const out = stateFindings(readings);
    for (const [why, n] of out.gaps) addGap(gaps, why, n);
    return { findings: out.findings, gaps };
  } catch {
    addGap(gaps, 'the page’s hover and focus styles could not be read');
    return { findings: [], gaps };
  } finally {
    if (forcer) await forcer.end().catch(() => undefined);
    await page.evaluate(dropStates, KEY).catch(() => undefined);
  }
}
