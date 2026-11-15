// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// ARIA state conflicts (WCAG 4.1.2 Name, Role, Value: a control's state must be programmatically
// determinable, and a state that contradicts what the page shows is wrong state), from the DOM at the
// desktop width, on every page that loaded. Only conflicts axe-core's WCAG rules do not report, and
// only where the page shows the contradiction beyond doubt:
// - a control with aria-expanded="true" whose aria-controls targets are all hidden, or a visible one
//   with aria-expanded="false" whose targets are all plainly shown (rendered, on the page, not
//   clipped or transparent, with text);
// - a single-selection tab list, list box or radio group with more than one item selected (checked);
// - a selected tab whose panel (aria-controls) is hidden;
// - an ARIA state that contradicts the element's own HTML state (ARIA in HTML): required with
//   aria-required="false", disabled with aria-disabled="false", readonly with aria-readonly="false",
//   a radio button's checked state, an open or closed <details> whose summary says the opposite, a
//   selected <option> with aria-selected="false" (and the reverse). A native checkbox's aria-checked
//   is axe's aria-conditional-attr, so it is left out.
// Also (2026-11-10): an element the page's own script makes a control with no role (failure F59): a plain
// div, span, paragraph, list item, table cell, image or anchor without href that has a click handler of
// its own (recorded by the listener hook, or an inline onclick) and shows a pointer cursor, is not inside
// a control or a composite widget, holds no control or link itself, and has a short name. Assistive
// technology is told nothing but its text.
// Reads only; it changes nothing on the page. Engine core: no Node-only imports.
import type { FrameLike, ProbeFinding } from '../types.js';
import { pageWords, shootElements } from './evidence.js';
import { FRAME_CALL_MS, frameProbeContext, settleFrames } from './frameContext.js';
import { frameGapFindings, frameWords, ownFrames } from './frameLayout.js';
import type { PageProbe, ProbeContext } from './types.js';

export const ARIA_STATES_PROBE_ID = 'aria-states';

export const ARIA_STATES_LIMITS = {
  /** Elements walked per document; a larger page is read up to here. */
  elements: 200_000,
  /** Conflicts kept per page. */
  conflicts: 200,
} as const;

/** Findings listed per page; the last one counts the rest. */
const PER_PAGE = 5;

export interface AriaConflict {
  kind: 'expanded-hidden' | 'collapsed-shown' | 'multiple-selected' | 'selected-panel-hidden' | 'native-mismatch';
  /** The control's role as screen readers announce it ('button', 'tab', 'textbox'…); for multiple-selected, the items' role. */
  role: string;
  /** Its accessible name (at most 80 characters); '' when it has none. */
  name: string;
  /** CSS path (parts joined by ' >>> ' across shadow roots). */
  target: string;
  /** multiple-selected: how many items are selected. */
  count?: number;
  /** native-mismatch: the ARIA attribute, its value, the HTML state it contradicts, and whether that state is on. */
  attribute?: string;
  value?: string;
  native?: string;
  nativeOn?: boolean;
}

export interface AriaStatesRead {
  conflicts: AriaConflict[];
  /** The page was larger than the read limits, so some conflicts may be missing. */
  truncated: boolean;
}

/** Runs in the page (self-contained). Walks the document (into open shadow roots) and lists the conflicts above. */
export function readAriaStates(limits: { elements: number; conflicts: number }): AriaStatesRead {
  const clean = (s: string | null | undefined, max = 80) => {
    const t = (s ?? '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const cssPath = (el: Element): string => {
    const root = el.getRootNode() as Document | ShadowRoot;
    const parts: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && root.querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      if (!parent) { parts.unshift(esc(cur.localName)); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${esc(cur.localName)}:nth-of-type(${same.indexOf(cur) + 1})` : esc(cur.localName));
    }
    const host = (root as ShadowRoot).host;
    return host ? `${cssPath(host)} >>> ${parts.join(' > ')}` : parts.join(' > ');
  };
  const parentOf = (el: Element): Element | null => {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode() as Node & { host?: Element };
    return root.host ?? null;
  };
  const styleOf = (el: Element) => (el.ownerDocument.defaultView ?? window).getComputedStyle(el);
  const visible = (el: Element, opacity: boolean): boolean => {
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true, opacityProperty: opacity, contentVisibilityAuto: true });
    const s = styleOf(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && (!opacity || s.opacity !== '0') && el.getClientRects().length > 0;
  };
  /** Shown to assistive technology: rendered, and not under aria-hidden or inert. */
  const exposed = (el: Element): boolean => {
    if (!el.isConnected) return false;
    for (let a: Element | null = el; a; a = parentOf(a)) {
      if (a.getAttribute('aria-hidden') === 'true' || a.hasAttribute('inert')) return false;
    }
    let box: Element | null = el;
    while (box && styleOf(box).display === 'contents') box = parentOf(box);
    return !!box && visible(box, false);
  };
  /** Certainly hidden: not rendered (display, visibility, the hidden attribute, a closed content-visibility), or a box of no size. */
  const hidden = (el: Element): boolean => {
    if (styleOf(el).display === 'contents') return false;
    if (!visible(el, false)) return true;
    const r = el.getBoundingClientRect();
    return r.width === 0 && r.height === 0;
  };
  let budget = 0;
  const textOf = (n: Node, depth: number): string => {
    if (depth > 30 || --budget < 0) return '';
    if (n.nodeType === 3) return n.nodeValue ?? '';
    if (n.nodeType !== 1) return '';
    const el = n as Element;
    if (el.getAttribute('aria-hidden') === 'true' || /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/i.test(el.tagName)) return '';
    if (depth > 0) {
      const s = styleOf(el);
      if (s.display === 'none' || s.visibility === 'hidden') return '';
      const label = el.getAttribute('aria-label');
      if (label && label.trim()) return ` ${label} `;
    }
    if (el.matches('img, area, input[type="image"]')) return ` ${el.getAttribute('alt') ?? ''} `;
    if (el.localName === 'svg') return ` ${el.querySelector('title')?.textContent ?? ''} `;
    let out = '';
    const kids = el.shadowRoot ? [...el.shadowRoot.childNodes] : [...el.childNodes];
    for (const k of kids) out += textOf(k, depth + 1);
    return ` ${out} `;
  };
  /**
   * Certainly shown: rendered and not transparent, at least 2×2 px, on the page (not moved off its
   * left or top edge, or past its right edge), not clipped away by an ancestor that hides overflow
   * (at least a quarter of it left), and with text in it.
   */
  const shown = (el: Element): boolean => {
    if (!visible(el, true)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const docWidth = Math.max(document.documentElement.scrollWidth, window.innerWidth);
    if (r.right + window.scrollX <= 0 || r.bottom + window.scrollY <= 0 || r.left + window.scrollX >= docWidth) return false;
    const area = r.width * r.height;
    for (let a = parentOf(el); a && a !== document.documentElement; a = parentOf(a)) {
      const s = styleOf(a);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const p = a.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, p.right) - Math.max(r.left, p.left));
      const h = Math.max(0, Math.min(r.bottom, p.bottom) - Math.max(r.top, p.top));
      if (w * h < 0.25 * area) return false;
    }
    budget = 2000;
    return /[\p{L}\p{N}]/u.test(textOf(el, 0));
  };
  const roleOf = (el: Element): string => {
    const explicit = (el.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = el.localName;
    if (tag === 'button' || tag === 'summary') return 'button';
    if ((tag === 'a' || tag === 'area') && el.hasAttribute('href')) return 'link';
    if (tag === 'select') return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'option') return 'option';
    if (tag === 'input') {
      const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    return tag;
  };
  const byIds = (el: Element, ids: string): Element[] => {
    const root = el.getRootNode() as Document | ShadowRoot;
    return ids.split(/\s+/).filter(Boolean).map((id) => root.getElementById?.(id) ?? el.ownerDocument.getElementById(id)).filter((x): x is HTMLElement => !!x);
  };
  const nameOf = (el: Element): string => {
    budget = 2000;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const s = clean(byIds(el, lb).map((x) => textOf(x, 1)).join(' '));
      if (s) return s;
    }
    const label = clean(el.getAttribute('aria-label'));
    if (label) return label;
    const labels = (el as HTMLInputElement).labels;
    if (labels?.length) {
      const s = clean([...labels].map((x) => textOf(x, 1)).join(' '));
      if (s) return s;
    }
    if (!/^(input|textarea|select)$/.test(el.localName)) {
      const text = clean(textOf(el, 0));
      if (text) return text;
    }
    return clean(el.getAttribute('title') || el.getAttribute('placeholder'));
  };
  const contains = (a: Element, b: Element) => a === b || a.contains(b);

  const conflicts: AriaConflict[] = [];
  let truncated = false;
  const add = (c: AriaConflict) => {
    if (conflicts.length >= limits.conflicts) { truncated = true; return; }
    conflicts.push(c);
  };
  const base = (el: Element) => ({ role: roleOf(el), name: nameOf(el), target: cssPath(el) });
  const SINGLE: Record<string, { item: string; attr: string }> = { tablist: { item: 'tab', attr: 'aria-selected' }, listbox: { item: 'option', attr: 'aria-selected' }, radiogroup: { item: 'radio', attr: 'aria-checked' } };

  const check = (el: Element, assumeExposed = false) => {
    if (!assumeExposed && !exposed(el)) return;
    const role = roleOf(el);
    const expanded = el.getAttribute('aria-expanded');
    const controls = el.getAttribute('aria-controls');
    const targets = controls ? byIds(el, controls) : [];
    const outside = targets.length > 0 && targets.every((t) => !contains(t, el) && !contains(el, t));
    if (expanded === 'true' && outside && targets.every(hidden)) add({ kind: 'expanded-hidden', ...base(el) });
    else if (expanded === 'false' && outside && shown(el) && targets.every(shown)) add({ kind: 'collapsed-shown', ...base(el) });
    if (role === 'tab' && el.getAttribute('aria-selected') === 'true' && outside && targets.every(hidden)) add({ kind: 'selected-panel-hidden', ...base(el) });
    const single = el.hasAttribute('role') ? SINGLE[role] : undefined;
    if (single && !(role !== 'radiogroup' && el.getAttribute('aria-multiselectable') === 'true')) {
      const items = [...el.querySelectorAll(`[role="${single.item}"]`)].filter((i) => {
        let a = parentOf(i);
        while (a && a !== el && !(a.getAttribute('role') ?? '').trim().toLowerCase().startsWith(role)) a = parentOf(a);
        return a === el && i.getAttribute(single.attr) === 'true' && exposed(i);
      });
      if (items.length >= 2) add({ kind: 'multiple-selected', role: single.item, name: nameOf(el), target: cssPath(el), count: items.length });
    }
    const mismatch = (attribute: string, native: string, nativeOn: boolean) => {
      const value = el.getAttribute(attribute);
      if (value === null || (value === 'true') === nativeOn) return;
      if (value !== 'true' && value !== 'false') return;
      add({ kind: 'native-mismatch', ...base(el), attribute, value, native, nativeOn });
    };
    const tag = el.localName;
    if (/^(input|select|textarea)$/.test(tag) && (el as HTMLInputElement).required) mismatch('aria-required', 'required', true);
    if (/^(button|input|select|textarea|optgroup|option|fieldset)$/.test(tag) && el.matches(':disabled')) mismatch('aria-disabled', 'disabled', true);
    if (/^(input|textarea)$/.test(tag) && (el as HTMLInputElement).readOnly) mismatch('aria-readonly', 'read-only', true);
    if (tag === 'input' && (el as HTMLInputElement).type === 'radio' && !el.hasAttribute('role')) mismatch('aria-checked', 'checked', (el as HTMLInputElement).checked);
    if (tag === 'summary' && el.parentElement?.localName === 'details' && el.parentElement.querySelector(':scope > summary') === el && !el.hasAttribute('role')) {
      mismatch('aria-expanded', 'open', (el.parentElement as HTMLDetailsElement).open);
    }
    if (tag === 'option' && el.closest('select') && !el.hasAttribute('role')) mismatch('aria-selected', 'selected', (el as HTMLOptionElement).selected);
  };

  let walked = 0;
  const stack: Node[] = [document];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.nodeType === 1) {
      if (++walked > limits.elements) { truncated = true; break; }
      const el = n as Element;
      if (/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|svg|iframe|frame)$/i.test(el.localName)) continue;
      // <option> is not rendered in a closed <select>: its own state is read from the select.
      if (el.localName === 'option') { const select = el.closest('select'); if (select && exposed(select)) check(el, true); }
      else if (el.attributes.length) check(el);
      const kids = el.shadowRoot ? [...el.shadowRoot.childNodes] : [...el.childNodes];
      for (let i = kids.length - 1; i >= 0; i--) if (kids[i]!.nodeType === 1) stack.push(kids[i]!);
    } else {
      const kids = [...n.childNodes];
      for (let i = kids.length - 1; i >= 0; i--) if (kids[i]!.nodeType === 1) stack.push(kids[i]!);
    }
  }
  return { conflicts, truncated };
}

/** An element the page's script makes a control, with no role (F59). */
export interface RolelessControl {
  /** Its tag ('div', 'span', 'a'…). */
  tag: string;
  /** Its visible text or alternative (at most 80 characters); '' for an icon with none. */
  name: string;
  /** CSS path (parts joined by ' >>> ' across shadow roots). */
  target: string;
}

export const ROLELESS_LIMITS = {
  /** Elements with click handlers looked at per page. */
  candidates: 2_000,
  /** Controls kept per page. */
  kept: 50,
  /** Longest name of a control: a longer text is a passage, not a control. */
  nameChars: 80,
} as const;

/**
 * Runs in the page (self-contained). `refs` are the listener hook's handles of elements with a click
 * handler (`window.__grntedTarget(ref)`); elements with an inline onclick are read from the document.
 */
export function readRoleless(arg: { refs: number[]; candidates: number; kept: number; nameChars: number }): { controls: RolelessControl[]; truncated: boolean } {
  const W = window as unknown as { __grntedTarget?: (ref: number) => unknown };
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const cssPath = (el: Element): string => {
    const root = el.getRootNode() as Document | ShadowRoot;
    const parts: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && root.querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      if (!parent) { parts.unshift(esc(cur.localName)); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${esc(cur.localName)}:nth-of-type(${same.indexOf(cur) + 1})` : esc(cur.localName));
    }
    const host = (root as ShadowRoot).host;
    return host ? `${cssPath(host)} >>> ${parts.join(' > ')}` : parts.join(' > ');
  };
  const TAGS = new Set(['div', 'span', 'p', 'li', 'td', 'i', 'img', 'a']);
  // Inside one of these the element is part of a control, or of a widget whose roles come from its pattern.
  const WITHIN = 'a[href], button, summary, label, select, textarea, [contenteditable=""], [contenteditable="true"], [role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="listbox"], [role="menu"], [role="menubar"], [role="tablist"], [role="tree"], [role="grid"], [role="treegrid"], [role="slider"], [role="application"], [aria-disabled="true"], [aria-hidden="true"], [inert]';
  // Holding one of these it is a wrapper (a clickable card around its own link), not the control.
  const HOLDS = 'a[href], button, input, select, textarea, summary, details, iframe, video, audio, [role], [tabindex], [onclick], [contenteditable]';
  const seen = new Set<Element>();
  const list: Element[] = [];
  const add = (el: unknown) => {
    if (el instanceof Element && !seen.has(el)) { seen.add(el); list.push(el); }
  };
  let truncated = false;
  for (const ref of arg.refs) {
    if (list.length >= arg.candidates) { truncated = true; break; }
    try { add(W.__grntedTarget?.(ref)); } catch { /* the element is gone */ }
  }
  const inline = document.querySelectorAll('[onclick]');
  for (let i = 0; i < inline.length; i++) {
    if (list.length >= arg.candidates) { truncated = true; break; }
    add(inline[i]);
  }
  const vw = window.innerWidth || document.documentElement.clientWidth || 1;
  const vh = window.innerHeight || document.documentElement.clientHeight || 1;
  const found: { el: Element; control: RolelessControl }[] = [];
  for (const el of list) {
    const tag = el.localName;
    if (!el.isConnected || !TAGS.has(tag) || (tag === 'a' && el.hasAttribute('href'))) continue;
    const role = (el.getAttribute('role') ?? '').trim().toLowerCase();
    if (role && role !== 'none' && role !== 'presentation' && role !== 'generic') continue;
    if (el.parentElement?.closest(WITHIN) || el.matches('[aria-disabled="true"], [aria-hidden="true"], [inert], [contenteditable=""], [contenteditable="true"]') || el.querySelector(HOLDS)) continue;
    const c = el as Element & { checkVisibility?: (o: object) => boolean };
    if (typeof c.checkVisibility === 'function' && !c.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.width * r.height > 0.4 * vw * vh) continue;
    if (getComputedStyle(el).cursor !== 'pointer') continue;
    const text = ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const alt = (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.querySelector('img[alt]')?.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
    const icon = tag === 'img' || tag === 'i' || !!el.querySelector('img, svg, i');
    const name = text || alt;
    if ((!name && !icon) || name.length > arg.nameChars) continue;
    found.push({ el, control: { tag, name, target: cssPath(el) } });
  }
  // One control per place: an element that holds another found element is its wrapper.
  const controls = found.filter((f) => !found.some((g) => g !== f && f.el.contains(g.el))).map((f) => f.control);
  if (controls.length > arg.kept) truncated = true;
  return { controls: controls.slice(0, arg.kept), truncated };
}

/** One page's findings from what `readRoleless` reported. */
export function rolelessFindings(controls: readonly RolelessControl[]): ProbeFinding[] {
  const shown = controls.slice(0, PER_PAGE);
  return shown.map((c, i) => {
    const more = i === shown.length - 1 && controls.length > shown.length ? ` (${controls.length - shown.length} more like this on this page)` : '';
    const what = `The ${c.tag === 'a' ? 'link without an address' : c.tag === 'img' ? 'image' : c.tag === 'td' ? 'table cell' : c.tag === 'li' ? 'list item' : c.tag} ${c.name ? `“${c.name}”` : 'with no name'}`;
    return {
      criterion: '4.1.2', status: 'failed', target: c.target,
      detail: `${what} works as a control (the page's script acts when it is clicked, and it shows a pointer cursor) but has no role, so screen readers read it as plain text and do not say it can be pressed${more}`,
    };
  });
}

const ITEMS: Record<string, { many: string; group: string; state: string }> = {
  tab: { many: 'tabs', group: 'tab list', state: 'marked selected' },
  option: { many: 'options', group: 'list box', state: 'marked selected' },
  radio: { many: 'radio buttons', group: 'radio group', state: 'marked checked' },
};

const what = (c: AriaConflict) => `The ${c.role} ${c.name ? `“${c.name}”` : 'with no name'}`;

function detailOf(c: AriaConflict): string {
  switch (c.kind) {
    case 'expanded-hidden': return `${what(c)} tells screen readers it is expanded, but what it opens is hidden`;
    case 'collapsed-shown': return `${what(c)} tells screen readers it is collapsed, but what it opens is shown`;
    case 'selected-panel-hidden': return `${what(c)} is marked selected, but its panel is hidden`;
    case 'multiple-selected': {
      const i = ITEMS[c.role] ?? ITEMS.option!;
      return `${c.count ?? 2} ${i.many} in one ${i.group} are ${i.state}, so screen readers cannot tell which one is current`;
    }
    case 'native-mismatch':
      return c.nativeOn !== false
        ? `${what(c)} is ${c.native}, but ${c.attribute}="${c.value}" tells screen readers it is not`
        : `${what(c)} is not ${c.native}, but ${c.attribute}="${c.value}" tells screen readers it is`;
  }
}

/** One page's findings from what `readAriaStates` reported. */
export function ariaStateFindings(read: Pick<AriaStatesRead, 'conflicts'> & Partial<AriaStatesRead>): ProbeFinding[] {
  const shown = read.conflicts.slice(0, PER_PAGE);
  return shown.map((c, i) => {
    const more = i === shown.length - 1 && read.conflicts.length > shown.length ? ` (${read.conflicts.length - shown.length} more like this on this page)` : '';
    return { criterion: '4.1.2', status: 'failed', target: c.target, detail: `${detailOf(c)}${more}` };
  });
}

/** The first conflicting element boxed, in the main document. */
async function ariaEvidence(ctx: ProbeContext, findings: readonly ProbeFinding[], kind?: 'role'): Promise<void> {
  const first = findings.find((f) => f.status === 'failed' && f.target && !f.target.includes(' >>> '));
  if (!first) return;
  await shootElements(ctx, kind === 'role' ? {
    criterion: '4.1.2', variant: 'role', handles: [{ sel: first.target! }], caption: 'It works as a control but has no role',
    alt: (title) => `${pageWords(title)}: the outlined element works as a control when clicked, but tells screen readers nothing about it.`,
  } : {
    criterion: '4.1.2', handles: [{ sel: first.target! }], caption: 'Its state does not match what the page shows',
    alt: (title) => `${pageWords(title)}: the outlined control tells screen readers a state that does not match what the page shows.`,
  });
}

/**
 * Controls with no role (F59) on a page, with their pictures: from the click handlers the listener hook
 * recorded and inline onclick attributes. Reported by the names test (listed, not scored), not by the scored
 * state test: an element the keyboard test already fails for 2.1.1 must not move the score a second time.
 */
export async function rolelessOnPage(ctx: ProbeContext): Promise<ProbeFinding[]> {
  let refs: number[] = [];
  try {
    refs = [...new Set((await ctx.listeners()).filter((l) => l.type === 'click' && l.target.kind === 'element').map((l) => l.ref))];
  } catch {
    refs = []; // no listener hook on this page: inline handlers only
  }
  const roleless = await ctx.page.evaluate(readRoleless, { refs, candidates: ROLELESS_LIMITS.candidates, kept: ROLELESS_LIMITS.kept, nameChars: ROLELESS_LIMITS.nameChars });
  const noRole = rolelessFindings(roleless.controls);
  if (noRole.length) await ariaEvidence(ctx, noRole, 'role');
  return noRole;
}

/**
 * Runs in a frame's PARENT document, on the frame's own element there: whether that element is offered to assistive
 * technology and to the pointer (no aria-hidden or inert on it or around it in that document, pointer events on). Null
 * when the element is gone or its document has no window: not known.
 */
export function offeredInParent(arg: { el: unknown }): boolean | null {
  const el = arg.el as Element | null;
  if (!el || !el.isConnected) return null;
  if (el.closest('[aria-hidden="true"], [inert]')) return false;
  const view = el.ownerDocument.defaultView;
  if (!view) return null;
  return view.getComputedStyle(el).pointerEvents !== 'none';
}

/**
 * Whether a frame is offered to assistive technology and to the pointer, read from the OUTSIDE (Sol review of batch 17,
 * S7): the frame's element in each document around it, up to the page, through the automation's own handle on it
 * (`frameElement()` in the parent frame). A frame cannot be asked itself: a sandboxed frame (scripts allowed, no
 * `allow-same-origin`) has no `window.frameElement`, so it would read as offered even under aria-hidden. False: it is
 * kept from them (aria-hidden, inert, no pointer events, on it or around it). Undefined: some step could not be read in
 * time (`ms` each), and then it is not known. Never throws.
 */
export async function frameExposure(frame: FrameLike, ms: () => number): Promise<boolean | undefined> {
  const within = async <T>(p: Promise<T>): Promise<T | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), Math.max(50, ms())); })]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    let f: FrameLike | null = frame;
    for (let depth = 0; f && depth < 8; depth++) {
      const parent: FrameLike | null = f.parentFrame();
      if (!parent) return true;
      const handle = await within(f.frameElement());
      if (!handle) return undefined;
      const offered = await within(parent.evaluate(offeredInParent, { el: handle }));
      if (offered === undefined || offered === null) return undefined;
      if (!offered) return false;
      f = parent;
    }
    // Deeper than any frame looked into: not known.
    return f && f.parentFrame() ? undefined : true;
  } catch {
    return undefined;
  }
}

/** Limits of the look for controls with no role inside the page's own frames (`rolelessInFrames`). */
export const ROLELESS_FRAMES = {
  /** The whole pass, and the wait for a frame still loading (ms). */
  ms: 4000,
  settleMs: 1500,
  /** Frames looked into per page. */
  frames: 4,
} as const;

/**
 * The same rule inside the page's own embedded frames (batch 17, structure lane): a calendar, a form or a map in
 * a frame from the site (or one the page writes itself) is part of the page, and a `div` there that the frame's
 * own script makes a control, with no role, tells assistive technology as little as one in the page. Read with the
 * frame's own listener records; the finding names the element through the frame (`<frame> >>> <element>`). Frames
 * from other sites are never looked into. A frame from this site that should have been looked into and could not
 * be (not loaded in time, not answering, more frames than the limit) leaves 4.1.2 not testable there, never
 * clean. Every call into a frame is bounded, and the pass has a budget of its own. Reads only. Never throws.
 */
export async function rolelessInFrames(ctx: ProbeContext): Promise<ProbeFinding[]> {
  // No child frame that may be the site's own (by its address: from this origin, or written by the page): no
  // browser round trip.
  try {
    const origin = new URL(ctx.page.url?.() ?? '').origin;
    const own = (ctx.page.frames?.() ?? []).some((f) => {
      if (!f.parentFrame()) return false;
      const url = f.url();
      // (A frame that has not loaded yet has no address: it may be the site's own, and the pass waits for it.)
      if (!url) return true;
      try { return /^about:(?:blank|srcdoc)/.test(url) || (/^https?:/i.test(url) && new URL(url).origin === origin); } catch { return false; }
    });
    if (!own) return [];
  } catch { return []; }
  const end = Math.min(Date.now() + ROLELESS_FRAMES.ms, ctx.deadline - 1000);
  // No time left to look: said, never clean.
  if (end - Date.now() < 500) return frameGapFindings('4.1.2', [{ path: '', why: 'the time for looking into frames ran out' }], 'for controls with no role');
  const gaps: { path: string; why: string }[] = [];
  const out: ProbeFinding[] = [];
  try {
    gaps.push(...await settleFrames(ctx.page, Math.min(ROLELESS_FRAMES.settleMs, Math.max(0, end - Date.now())), { guard: ctx.guard, deadline: end, scroll: true }));
    const own = await ownFrames(ctx.page, { callMs: FRAME_CALL_MS, deadline: end }).catch(() => ({ frames: [], gaps: [] }));
    gaps.push(...own.gaps);
    let looked = 0;
    for (const f of own.frames) {
      if (Date.now() >= end - 300) { gaps.push({ path: f.path, why: 'the time for looking into frames ran out' }); continue; }
      const fctx = frameProbeContext({ ...ctx, deadline: end }, f);
      try {
        // A frame the page hides from assistive technology or from the pointer (aria-hidden, inert, no pointer
        // events: a preview, a decoration) is not offered as controls, as an element so hidden in the page is not.
        // Read from the documents around it (Sol review of batch 17, S7); where that cannot be told, a gap.
        const offered = await frameExposure(f.frame, () => Math.min(FRAME_CALL_MS, Math.max(100, end - Date.now())));
        if (offered === undefined) { gaps.push({ path: f.path, why: 'whether the page offers it to assistive technology could not be told' }); continue; }
        if (!offered) continue;
        if (looked >= ROLELESS_FRAMES.frames) { gaps.push({ path: f.path, why: `the test looks for controls with no role in at most ${ROLELESS_FRAMES.frames} frames a page` }); continue; }
        looked++;
        const refs = [...new Set((await fctx.listeners()).filter((l) => l.type === 'click' && l.target.kind === 'element').map((l) => l.ref))];
        const roleless = await fctx.page.evaluate(readRoleless, { refs, candidates: ROLELESS_LIMITS.candidates, kept: ROLELESS_LIMITS.kept, nameChars: ROLELESS_LIMITS.nameChars });
        for (const x of rolelessFindings(roleless.controls)) out.push({ ...x, target: `${f.path} >>> ${x.target}`, detail: `${frameWords(f)}${x.detail}` });
      } catch {
        gaps.push({ path: f.path, why: 'its event listeners could not be read' });
      }
    }
  } catch {
    // What was found stands; nothing more is said.
  }
  return [...out, ...frameGapFindings('4.1.2', gaps, 'for controls with no role')];
}

/** ARIA state conflicts, on every page that loaded (`everyPage`): fails 4.1.2 for each conflict above. */
export const ariaStatesProbe: PageProbe = {
  id: ARIA_STATES_PROBE_ID,
  criteria: ['4.1.2'],
  kind: 'render',
  tier: 'core',
  timeoutMs: 10_000,
  everyPage: true,
  async run(ctx: ProbeContext): Promise<ProbeFinding[]> {
    const read = await ctx.page.evaluate(readAriaStates, ARIA_STATES_LIMITS);
    const findings = ariaStateFindings(read);
    if (!findings.length && read.truncated) {
      return [{ criterion: '4.1.2', status: 'not_testable', detail: 'this page is too large to read every control' }];
    }
    await ariaEvidence(ctx, findings);
    return findings;
  },
};
