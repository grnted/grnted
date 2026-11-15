// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Runs axe-core in every frame of a page (scoring v2): axe.runPartial in each frame, axe.finishRun in
// the main frame. The driver reaches every frame, cross-origin ones included, so axe never needs to
// message between frames. Scoring v3: frames from another site (registrable domain) are finished on
// their own, in that frame, and returned apart from the scored run. Worker-safe: no Node imports.
import { registrableDomain } from './domain.js';
import { AXE_ENABLED_RULES, AXE_TAGS } from './ruleImpacts.js';
import type { AxeRun, FrameLike, PageLike, ThirdPartyRun, UntestedFrame } from './types.js';
import { CONTRAST_EXEMPT_KEY, installContrastExempt } from './probes/contrastExempt.js';
import { installNamesSomething, NAMES_SOMETHING_KEY } from './probes/namesSomething.js';

/** Limits for the frames of one page at one width (the main frame is not counted or timed). */
export const FRAME_LIMITS = {
  /** Frames tested, nested frames included. */
  maxFrames: 20,
  /** Time box for one frame: loading axe into it and running it there. */
  frameTimeoutMs: 10_000,
  /** Time box for all of the page's frames together. */
  totalMs: 30_000,
};
export type FrameLimits = typeof FRAME_LIMITS;

/** Maximum time for a location call, also bounded by the remaining total frame budget. */
const LOCATE_TIMEOUT_MS = 5_000;

export interface AxeOptions {
  runOnly: { type: 'tag' | 'rule'; values: string[] };
  rules: Record<string, { enabled: boolean }>;
  resultTypes: string[];
}

/** The axe options for every call: the scored rule set, and node details for violations and incomplete only. */
export function axeOptions(): AxeOptions {
  return {
    runOnly: { type: 'tag', values: [...AXE_TAGS] },
    rules: Object.fromEntries(AXE_ENABLED_RULES.map((id) => [id, { enabled: true }])),
    resultTypes: ['violations', 'incomplete'],
  };
}

type Step =
  | { step: 'single' | 'top'; options: AxeOptions }
  | { step: 'child'; options: AxeOptions; context: unknown }
  | { step: 'locate'; el: unknown }
  | { step: 'finish'; options: AxeOptions; partials: (string | null)[] }
  | { step: 'finishFrame'; options: AxeOptions; partials: (string | null)[] };

/** What a step returns. 'single' returns the run's own fields (an `AxeRun`) plus `frames`. */
interface StepResult extends Partial<AxeRun> {
  /** A finished run ('finish', or 'top' when the page has no frames to test). */
  run?: AxeRun;
  /** Addresses of the frames axe will test from here, in axe's order ('single', 'top', 'child'). */
  frames?: string[];
  /** This frame's partial result as JSON ('child'). */
  partial?: string;
  /** The frame's position among its parent's frames, -1 when axe skips it (hidden), and its axe context ('locate'). */
  index?: number;
  context?: unknown;
}

/**
 * Runs inside a frame (serialized into the browser, so it must be self-contained). The main frame
 * keeps its own partial result in `window.__grntedAxe` until 'finish', so a page without frames
 * sends nothing extra back. Test doubles of `PageLike` recognise it by name and may answer with a
 * plain `AxeRun`, which is what the 'single' step (no `frames()`) returns.
 */
async function runAxeInPage(arg: Step): Promise<StepResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  const axe = w.axe;
  // --- Applicability and exceptions axe does not know (the nodes are re-checked here, in the page). ---
  // The element an axe node target names: frame selectors first, then the element (each part a
  // selector, or a list of selectors through shadow roots). null when it cannot be reached (a frame
  // from another origin, or gone) or when a selector does not name exactly one element (duplicate
  // ids): the node is then kept as axe reported it.
  const resolve = (target: unknown): Element | null => {
    try {
      const parts = Array.isArray(target) ? target : [target];
      if (!parts.length) return null;
      const pick = (part: unknown, root: Document): Element | null => {
        const sels = Array.isArray(part) ? part.map(String) : [String(part)];
        let scope: Document | ShadowRoot = root;
        let el: Element | null = null;
        for (let i = 0; i < sels.length; i++) {
          const all: NodeListOf<Element> = scope.querySelectorAll(sels[i]!);
          if (all.length !== 1) return null;
          const one: Element = all[0]!;
          el = one;
          if (i < sels.length - 1) {
            if (!one.shadowRoot) return null;
            scope = one.shadowRoot;
          }
        }
        return el;
      };
      let doc: Document = document;
      for (let i = 0; i < parts.length - 1; i++) {
        const frame = pick(parts[i], doc) as HTMLIFrameElement | null;
        const inner = frame?.contentDocument;
        if (!inner) return null;
        doc = inner;
      }
      return pick(parts[parts.length - 1], doc);
    } catch {
      return null;
    }
  };
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  // ACT 24afc2, 9e45ec, 78fd32 apply to "any HTML element with one or more visible text node
  // children": an !important spacing on a wrapper whose text is all in its children is not applicable
  // (each child takes the user's spacing; its own value is not important). axe's
  // avoid-inline-spacing tests every [style] element with visible text anywhere inside it. Text the
  // element shows without a light-DOM text node child keeps the node (the user's style sheet cannot
  // reach it past the !important either): a form field's value or placeholder, ::before / ::after
  // content, and the text of its own shadow tree.
  const VALUE_FIELD = /^(?:text|search|email|url|tel|number|password|date|datetime-local|month|time|week|button|submit|reset)$/;
  const hasText = (root: Node): boolean => {
    const doc = root.ownerDocument ?? (root as Document);
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (/^(?:STYLE|SCRIPT|TEMPLATE|NOSCRIPT)$/.test(n.parentElement?.tagName ?? '')) continue;
      if (norm(n.nodeValue) !== '') return true;
    }
    return false;
  };
  const ownText = (el: Element): boolean => {
    if ([...el.childNodes].some((c) => c.nodeType === 3 && norm(c.nodeValue) !== '')) return true;
    if (el.localName === 'input') {
      const input = el as HTMLInputElement;
      if (VALUE_FIELD.test(input.type) && (norm(input.value) !== '' || norm(input.placeholder) !== '')) return true;
    }
    if (el.localName === 'textarea') {
      const area = el as HTMLTextAreaElement;
      if (norm(area.value) !== '' || norm(area.placeholder) !== '') return true;
    }
    if (el.localName === 'select' && norm((el as HTMLSelectElement).selectedOptions?.[0]?.textContent) !== '') return true;
    const view = el.ownerDocument.defaultView;
    if (view) {
      for (const pseudo of ['::before', '::after']) {
        const content = view.getComputedStyle(el, pseudo).content;
        // A string (or attr()/counter() output) that is not empty: text the element shows.
        if (content && content !== 'none' && content !== 'normal' && /[^\s"'()]/.test(content.replace(/url\([^)]*\)/g, ''))) return true;
      }
    }
    return !!el.shadowRoot && hasText(el.shadowRoot);
  };
  /**
   * Right under a real heading: the element before it (or before the block it starts) is an h1-h6 or a
   * role=heading. A styled line there is that heading's subtitle (a tagline, a date line), which HTML marks up
   * as a paragraph, not a section heading with no markup (p-as-heading below).
   */
  const underHeading = (el: Element): boolean => {
    const heading = (x: Element | null | undefined) => !!x && (/^H[1-6]$/.test(x.tagName) || (x.getAttribute('role') ?? '').trim().toLowerCase() === 'heading'
      || (x.children.length === 1 && /^(HEADER|HGROUP|DIV)$/.test(x.tagName) && /^H[1-6]$/.test(x.children[0]!.tagName)));
    if (el.closest('hgroup')) return true;
    if (heading(el.previousElementSibling)) return true;
    const p = el.parentElement;
    return !!p && p.firstElementChild === el && p.children.length === 1 && heading(p.previousElementSibling);
  };
  const LIVE_ROLES = new Set(['status', 'alert', 'log', 'marquee', 'timer']);
  /**
   * Inside a live region: an ancestor (through open shadow roots' hosts) with role status, alert, log, marquee or timer,
   * or aria-live polite or assertive. Its bold lines are status messages, not section headings (p-as-heading below).
   */
  const inLiveRegion = (el: Element): boolean => {
    for (let a: Element | null = el, i = 0; a && i < 200; i++) {
      const role = (a.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
      const live = (a.getAttribute('aria-live') ?? '').trim().toLowerCase();
      if (LIVE_ROLES.has(role) || live === 'polite' || live === 'assertive') return true;
      a = a.parentElement ?? ((a.getRootNode() as ShadowRoot).host ?? null);
    }
    return false;
  };
  /** Ask the browser whether a frame can receive focus, including modal and flat-tree inertness. */
  const cannotFocus = (el: Element): boolean => {
    if (!(el instanceof HTMLElement) || !el.isConnected) return false;
    const doc = el.ownerDocument;
    const root = el.getRootNode() as Document | ShadowRoot;
    let previous = doc.activeElement;
    while (previous?.shadowRoot?.activeElement) previous = previous.shadowRoot.activeElement;
    try {
      el.focus({ preventScroll: true });
      return root.activeElement !== el;
    } catch {
      return false; // No browser confirmation: retain axe's finding.
    } finally {
      if (previous !== el) {
        el.blur();
        if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
      }
    }
  };
  /**
   * WCAG 1.4.3's exceptions that axe's color-contrast rule does not apply (logotypes, text that expresses nothing
   * in human language; and inactive components, which axe leaves out too): the one predicate every contrast path
   * shares (`installContrastExempt` in ./probes/contrastExempt.ts, put on this window before axe runs).
   */
  const contrastExempt = (window as unknown as Record<string, ((el: Element) => string | null) | undefined>).__grntedContrastExempt;
  /**
   * Text that names something else (a group's or a region's label, the target of aria-labelledby...) is never an
   * unmarked heading: the one rule the headings test uses too (`installNamesSomething` in ./probes/namesSomething.ts,
   * put on this window before axe runs). axe flags a paragraph only beside a longer one, so the paragraph is alone in
   * no wrapper: the predicate's default (the element itself) is that wrapper.
   */
  const namesSomething = (window as unknown as Record<string, ((el: Element) => boolean) | undefined>).__grntedNamesSomething;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const keepNode = (id: string, n: any): boolean => {
    if (id === 'color-contrast') {
      const el = resolve(n.target);
      return !el || !contrastExempt || contrastExempt(el) === null;
    }
    // frame-focusable-content (2.1.1): a frame that is inert (behind an open modal dialog, or in an inert region) is
    // out of the Tab order whatever its tabindex, as the rest of the page is while the dialog is open: its tabindex=-1
    // keeps nothing from the keyboard (ACT akn7bn applies only to frames in the sequential focus order otherwise).
    if (id === 'frame-focusable-content') {
      const parts = Array.isArray(n.target) ? n.target : [n.target];
      const frame = parts.length > 1 ? resolve(parts.slice(0, -1)) : null;
      return !frame || !cannotFocus(frame);
    }
    // p-as-heading (F2): a bold line inside a live region is a status message, not a section heading (lead's ruling,
    // Sol round 3: a role=status "Saved successfully" cost 5 points); one right under a real heading is its subtitle;
    // one that names something else (a group's or a region's label) is that label. A rule left with no node passes.
    if (id === 'p-as-heading') {
      const el = resolve(n.target);
      return !el || !(inLiveRegion(el) || underHeading(el) || (!!namesSomething && namesSomething(el)));
    }
    if (id !== 'avoid-inline-spacing') return true;
    const el = resolve(n.target);
    return !el || ownText(el);
  };
  // --- Not proven by the rule alone: moved to "needs a human check" (never dropped, never scored). ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const checkData = (n: any, check: string): unknown => {
    for (const c of [...(n.any ?? []), ...(n.all ?? []), ...(n.none ?? [])]) if (c && c.id === check) return c.data;
    return undefined;
  };
  /**
   * Why a node axe failed shows no failure of the WCAG criterion by itself (the reason, recorded on the node), or
   * null. Each is a check stricter than its criterion where the page's own answer is a default the browser gives:
   * - aria-required-attr (4.1.2): the missing states have a resting default that browsers and assistive technology
   *   use, so the state can be programmatically determined; whether it is the one the page shows is a human check.
   *   aria-checked (checkbox, radio, switch, menu item checkbox or radio: not checked), aria-level (heading:
   *   level 2), aria-expanded (combobox: collapsed, and a collapsed combobox needs no aria-controls, as axe itself
   *   accepts for aria-expanded="false"). A missing aria-valuenow (no resting value), or the aria-controls of a
   *   combobox that says it is expanded, stays a failure. The ARIA rule's own W3C mapping says it is stricter than
   *   4.1.2: "browsers and assistive technologies will often fall back on a non-standard default value, which may
   *   be sufficient".
   * - aria-valid-attr-value (4.1.2): only an invalid aria-hidden value ("yes", "1", "hidden"): the browser takes it
   *   as not hidden, so the element stays exposed as it is shown. No name, role, state or value is misstated.
   *   Any other invalid value on the element keeps the failure.
   * - table-fake-caption (1.3.1): a first row that is one header cell (`th`) across the table. As a header it is
   *   programmatically tied to every column under it (a column group header, often named by the headers
   *   attributes below it); whether it is a title that belongs in a caption is a human check. A data cell
   *   (`td`) used as the title stays a failure.
   * - p-as-heading (1.3.1, F2; batch 17, lead's ruling d): every node. A paragraph set bolder or larger than the
   *   one after it may be a sentence, a date, a figure or a callout as well as a section title (37 look-alike lab
   *   pages failed through it, none through the headings test). It is a trigger only: a styled paragraph fails
   *   1.3.1 through the headings test's proofs (set like a real heading, named and set like its neighbours'
   *   headings, named lines of one make, the same line a heading on another scanned page), which read the same
   *   paragraphs on every page.
   */
  /**
   * label-content-name-mismatch (2.5.3; batch 19, precision lane; the lead's ruling): SC 2.5.3 asks that the name CONTAIN
   * the text shown ("the name contains the text that is presented visually"); where it is in the name is best practice
   * only. axe fails a node whose shown words are not all in its name, one after another. Of those, a name that holds
   * only part of the words shown, or holds them abbreviated, is a person's call (Needs review), never a failure:
   * - every word of the name is a word shown, in order: the name drops words ("the full" for "The full label");
   * - the name holds every word shown, in order, with some abbreviated or spelled out ("Department" for "Dept.");
   * - the name holds the component's first block of text, whole and one word after another, anywhere in it, and leaves
   *   out only other text shown in blocks of their own and set apart (smaller, lighter or another colour): a logo's
   *   tagline under the agency's name, a card's description under its title.
   * Stays a failure: a name with words of its own and no whole block of the text shown ("View Kim Ortega" for "View
   * member", an address shown and named "District office address, open in the map", words put between: "Pay your bill
   * online" for "Pay online"), and every name from aria-labelledby (axe's own computation is not repeated here).
   * Returns the reason, with the words, or null.
   */
  const labelLead = (el: Element): string | null => {
    if (el.hasAttribute('aria-labelledby')) return null;
    const label = el.getAttribute('aria-label');
    if (!label || !label.trim()) return null;
    // The label-in-name matching's words (axe's curateTokens, ACT's label in name algorithm): text in parentheses and
    // everything that is neither a letter nor a digit removed, lower case.
    const words = (s: string): string[] => {
      let t = s.normalize('NFKD');
      for (let prev = ''; prev !== t;) { prev = t; t = t.replace(/\([^()]*\)/g, ' '); }
      return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
    };
    const view = el.ownerDocument.defaultView;
    if (!view) return null;
    // The visible text in blocks: a block-level box (blockified flex and grid items too) or a line break starts a new
    // one; inline content stays in its block. Each block keeps the style of its first visible text.
    interface Block { text: string; size: number; weight: number; color: string }
    const blocks: Block[] = [];
    let cur: Block | null = null;
    const close = () => { if (cur && cur.text.trim()) blocks.push(cur); cur = null; };
    const walk = (node: Node, depth: number): void => {
      if (depth > 40 || blocks.length > 12) return;
      if (node.nodeType === 3) {
        const parent = node.parentElement;
        const text = node.nodeValue ?? '';
        if (!parent || !text.trim()) { if (cur) cur.text += text; return; }
        const st = view.getComputedStyle(parent);
        if (st.visibility !== 'visible' || parseFloat(st.opacity) === 0 || parseFloat(st.fontSize) === 0) return;
        if (!cur) cur = { text: '', size: parseFloat(st.fontSize) || 0, weight: Number(st.fontWeight) || 400, color: st.color };
        cur.text += text;
        return;
      }
      if (node.nodeType !== 1) return;
      const e = node as Element;
      if (/^(?:SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(e.tagName)) return;
      if (e.localName === 'br') { close(); return; }
      const st = view.getComputedStyle(e);
      if (st.display === 'none') return;
      // Text clipped away is not shown (a screen-reader-only span): not part of the visible text, as for axe.
      const r = e.getBoundingClientRect();
      if (e !== el && (r.width < 2 || r.height < 2) && (st.overflow !== 'visible' || st.position === 'absolute')) return;
      const block = e !== el && st.display !== 'contents' && !st.display.startsWith('inline');
      if (block) close();
      for (const c of [...e.childNodes]) walk(c, depth + 1);
      if (block) close();
    };
    walk(el, 0);
    close();
    if (!blocks.length) return null;
    const tokens = blocks.map((b) => words(b.text));
    const shown = tokens.flat();
    const name = words(label);
    if (!name.length || !shown.length) return null;
    const clip = (s: string) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > 60 ? `${t.slice(0, 59)}…` : t; };
    const said = (ws: readonly string[]) => clip(ws.join(' '));
    const lettered = (ws: readonly string[]) => ws.some((w) => /\p{L}{2,}/u.test(w));
    // A word and its abbreviation are the same word: both of letters only, the shorter (two letters or more) starts with
    // the longer's first letter and has its letters in the same order ("dept" and "department", "st" and "street").
    const abbreviates = (short: string, long: string) => {
      if (short.length < 2 || short[0] !== long[0]) return false;
      let i = 0;
      for (const ch of long) if (ch === short[i]) i++;
      return i === short.length;
    };
    const same = (a: string, b: string) => a === b || (/^\p{L}{2,}$/u.test(a) && /^\p{L}{2,}$/u.test(b) && (a.length <= b.length ? abbreviates(a, b) : abbreviates(b, a)));
    /** The first index in `hay` where `needle` follows, one word after another (`eq` deciding each word); -1 when none. */
    const contiguous = (hay: readonly string[], needle: readonly string[], eq: (a: string, b: string) => boolean) => {
      for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((w, j) => eq(hay[i + j]!, w))) return i;
      return -1;
    };
    // Every word shown, in order, with some abbreviated or spelled out.
    if (contiguous(name, shown, same) >= 0) return `the name holds the words shown ("${said(shown)}") with some abbreviated or spelled out ("${clip(label)}"); whether that is the label's text is a human check`;
    // Every word of the name is a word shown, in order: words dropped.
    let j = 0;
    let subsequence = true;
    for (const w of name) {
      while (j < shown.length && !same(shown[j]!, w)) j++;
      if (j >= shown.length) { subsequence = false; break; }
      j++;
    }
    if (subsequence && lettered(name)) {
      const kept = new Set(name);
      const dropped = shown.filter((w) => ![...kept].some((k) => same(k, w)));
      return `the name keeps only part of the words shown ("${clip(label)}" of "${said(shown)}", leaving out "${said(dropped)}"); whether the words left out are part of the label is a human check`;
    }
    // The first block, whole, anywhere in the name; the rest in blocks of their own, set apart.
    if (blocks.length < 2) return null;
    let k = 0;
    let lead: string[] = [];
    for (; k < tokens.length - 1; k++) {
      const next = [...lead, ...tokens[k]!];
      if (!tokens[k]!.length || contiguous(name, next, (a, b) => a === b) < 0) break;
      lead = next;
    }
    if (k < 1 || !lettered(lead)) return null;
    const first = blocks[0]!;
    const rest = blocks.slice(k).filter((_, i) => tokens[k + i]!.length);
    if (!rest.length) return null;
    const apart = (b: Block) => b.size < first.size - 0.5 || b.weight < first.weight - 50 || b.color !== first.color;
    if (!rest.every(apart)) return null;
    return `the name holds the words shown first ("${said(lead)}") and leaves out other text set apart inside it ("${clip(rest.map((b) => b.text).join(' '))}"); whether that text is part of the label is a human check`;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reviewNode = (id: string, n: any): { why: string; unknown?: true; flag?: true } | null => {
    if (id === 'label-content-name-mismatch') {
      const el = resolve(n.target);
      const why = el ? labelLead(el) : null;
      return why ? { why, flag: true } : null;
    }
    // link-in-text-block (1.4.1, F73: "links that are not visually evident without color vision" in a block of text;
    // batch 19, real-site dev split): a link in a navigation landmark or a breadcrumb trail is not in running text, and
    // whether colour alone tells it from the words beside it (separators, the current page's name) is a person's call.
    if (id === 'link-in-text-block') {
      const el = resolve(n.target);
      if (el && el.closest('nav, [role="navigation"], [aria-label*="breadcrumb" i], [class*="breadcrumb" i], [id*="breadcrumb" i]')) {
        return { why: 'the link is in a navigation landmark or a breadcrumb trail, not in running text; whether colour alone tells it from the words beside it is a human check', flag: true };
      }
      return null;
    }
    if (id === 'aria-required-attr') {
      const missing = checkData(n, 'aria-required-attr');
      if (!Array.isArray(missing) || !missing.length) return null;
      const m = missing.map(String);
      // Fable review F1: a checked or expanded state left to its default is unknown, not a pass. The scan cannot tell a
      // control that sets it once pressed from one that never does, or one shown "on" at rest (`unknown`: 4.1.2 reads not
      // tested, report/criteria.ts `axeMethod`). A heading's level 2 misstates no state.
      if (m.every((a) => a === 'aria-checked')) return { why: 'the missing aria-checked reads as not checked', unknown: true };
      if (m.every((a) => a === 'aria-level')) return { why: 'the missing aria-level reads as level 2' };
      if (m.includes('aria-expanded') && m.every((a) => a === 'aria-expanded' || a === 'aria-controls')) return { why: 'the missing aria-expanded reads as collapsed', unknown: true };
      return null;
    }
    if (id === 'aria-valid-attr-value') {
      const invalid = checkData(n, 'aria-valid-attr-value');
      if (!Array.isArray(invalid) || !invalid.length || !invalid.every((s) => /^aria-hidden=/i.test(String(s)))) return null;
      return { why: 'an invalid aria-hidden value reads as not hidden' };
    }
    if (id === 'p-as-heading') return { why: 'a paragraph set like a heading is a section heading only where the headings test proves it, and that test decides 1.3.1 for it' };
    if (id === 'table-fake-caption') {
      const table = resolve(n.target) as HTMLTableElement | null;
      const row = table && typeof table.rows !== 'undefined' ? table.rows[0] : undefined;
      if (!row || row.cells.length !== 1) return null;
      const cell = row.cells[0]!;
      const role = (cell.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
      if (cell.localName !== 'th' || (role && role !== 'columnheader')) return null;
      return { why: 'the first row is a header cell over every column' };
    }
    return null;
  };
  /** Rules all of whose nodes were left out above (they pass). */
  const cleared = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lite = (list: any[]) => list.flatMap((x) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodes = x.nodes.filter((n: any) => keepNode(x.id, n));
    if (x.nodes.length && !nodes.length) {
      cleared.add(x.id);
      return [];
    }
    return [{
      id: x.id, impact: x.impact ?? null, help: x.help, helpUrl: x.helpUrl,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nodes: nodes.slice(0, 50).map((n: any) => ({
        target: (n.target as unknown[]).flat(Infinity).map(String).join(' >>> '),
        html: String(n.html).slice(0, 300),
        failureSummary: n.failureSummary ? String(n.failureSummary).slice(0, 500) : undefined,
        ...(n.unknownState ? { unknownState: true as const } : {}),
        ...(n.flag ? { flag: true as const } : {}),
      })),
    }];
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toRun = (r: any, review = true): AxeRun => {
    cleared.clear();
    // Violation nodes the rule alone does not prove (`reviewNode`) join the rule's incomplete result. Not in a frame from
    // another site (`finishFrame`): only its violations are kept, so its nodes keep axe's verdict (Fable review F5).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const moved = new Map<string, any>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proven = (r.violations as any[]).flatMap((x) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out: any[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rest = x.nodes.filter((n: any) => {
        // `keepNode` keeps every node of these rules; `lite` applies it to what stays. p-as-heading is never a failure,
        // in a frame from another site either (where it is then dropped with the rest of the frame's undecided nodes).
        const r2 = review || x.id === 'p-as-heading' ? reviewNode(x.id, n) : null;
        if (r2) out.push({ ...n, ...(r2.unknown ? { unknownState: true } : {}), ...(r2.flag ? { flag: true } : {}), failureSummary: `Not counted as a failure: ${r2.why}; check it by hand. ${n.failureSummary ?? ''}`.trim() });
        return !r2;
      });
      if (out.length) moved.set(x.id, { ...x, nodes: out });
      return rest.length ? [{ ...x, nodes: rest }] : [];
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsure = (r.incomplete as any[]).map((x) => {
      const more = moved.get(x.id);
      moved.delete(x.id);
      return more ? { ...x, nodes: [...x.nodes, ...more.nodes] } : x;
    });
    const violations = lite(proven);
    const incomplete = lite([...unsure, ...moved.values()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const passes: string[] = r.passes.map((x: any) => x.id);
    const failing = new Set([...violations, ...incomplete].map((x) => x.id));
    for (const id of cleared) if (!failing.has(id) && !passes.includes(id)) passes.push(id);
    return {
      violations,
      incomplete,
      passes,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inapplicable: r.inapplicable.map((x: any) => x.id),
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const address = (c: any): string => {
    const el = axe.utils.shadowSelect(c.frameSelector);
    if (!el) return '';
    if (el.hasAttribute('srcdoc')) return 'about:srcdoc';
    return el.src || 'about:blank';
  };
  switch (arg.step) {
    case 'single': {
      const frames = axe.utils.getFrameContexts(document, arg.options).map(address);
      return { ...toRun(await axe.run(document, { ...arg.options, iframes: false })), frames };
    }
    case 'top': {
      const contexts = axe.utils.getFrameContexts(document, arg.options);
      const partial = await axe.runPartial(document, arg.options);
      if (!contexts.length) return { run: toRun(await axe.finishRun([partial], arg.options)) };
      w.__grntedAxe = { partial, contexts };
      return { frames: contexts.map(address) };
    }
    case 'child': {
      const contexts = axe.utils.getFrameContexts(arg.context, arg.options);
      const partial = await axe.runPartial(arg.context, arg.options);
      w.__grntedAxe = { contexts };
      return { partial: JSON.stringify(partial), frames: contexts.map(address) };
    }
    case 'locate': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contexts: any[] = w.__grntedAxe?.contexts ?? [];
      const index = contexts.findIndex((c) => axe.utils.shadowSelect(c.frameSelector) === arg.el);
      return { index, context: index >= 0 ? contexts[index].frameContext : undefined };
    }
    case 'finish': {
      const partials = [w.__grntedAxe.partial, ...arg.partials.map((p) => (p === null ? null : JSON.parse(p)))];
      delete w.__grntedAxe;
      return { run: toRun(await axe.finishRun(partials, arg.options)) };
    }
    case 'finishFrame': {
      // A third-party frame's own partial result and those of the frames inside it, finished in that
      // frame: targets are relative to its document.
      return { run: toRun(await axe.finishRun(arg.partials.map((p) => (p === null ? null : JSON.parse(p))), arg.options), false) };
    }
  }
}

function frameContentType(): string {
  return document.contentType;
}

class FrameTimeout extends Error {}

/** A frame that is not tested on purpose; `message` is the reason. */
class FrameSkipped extends Error {}

async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A late result or error of `work` is dropped; the page's context is closed after the audit.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new FrameTimeout()), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

const REASONS = {
  notLoaded: 'The frame did not load (it failed, was blocked, or never started).',
  notPage: 'The frame shows a file or document, not a web page.',
  limit: (n: number) => `Only the first ${n} frames of a page are tested.`,
  timeLimit: 'The time limit for testing the page\'s frames was reached.',
  timedOut: 'The test inside the frame timed out.',
  failed: (message: string) => `The test could not run inside the frame: ${message}`,
  noFrames: 'This browser connection cannot run tests inside frames.',
  notListed: (message: string) => `The failures inside this frame from another site could not be listed: ${message}`,
};

/**
 * Whether a frame's content belongs to another site: its address is http(s) on a registrable domain
 * that is none of `sites` (the scanned page's, as requested and as loaded). Other addresses
 * (about:blank, about:srcdoc, data:, blob:) are content the frame around them made, so they inherit
 * their parent's side (null).
 */
export function isThirdPartyFrame(url: string, sites: ReadonlySet<string>): boolean | null {
  if (!/^https?:/i.test(url)) return null;
  const domain = registrableDomain(url);
  return domain !== '' && !sites.has(domain);
}

const short = (err: unknown): string => (err instanceof Error ? err.message.split('\n')[0]!.slice(0, 160) : 'unknown error');

/**
 * axe on the page and on every frame axe would test (visible frames, nested ones included, up to
 * `limits.maxFrames`), merged into one run by `axe.finishRun`. Frames axe skips (hidden from
 * assistive technology) are neither tested nor reported. Frames that could not be tested are listed
 * with a reason. Without `page.frames`, axe runs in the main frame only and lists its frames.
 */
export async function runAxe(
  page: PageLike,
  axeSource: string,
  limits: FrameLimits = FRAME_LIMITS,
  opts: {
    /**
     * The scanned page's address: frames on another registrable domain than this one and than the
     * main frame's own address (after redirects) are third-party.
     */
    site?: string;
    /** Other axe options (one rule only: text contrast's second look after a page-load pop-up, probes/popupAside.ts). Default `axeOptions()`. */
    options?: AxeOptions;
  } = {},
): Promise<{ run: AxeRun; untestedFrames: UntestedFrame[]; thirdParty: ThirdPartyRun[] }> {
  const options = opts.options ?? axeOptions();
  const frames = typeof page.frames === 'function' ? page.frames() : [];
  if (!frames.length) {
    await page.addScriptTag({ content: axeSource });
    await page.evaluate(installContrastExempt, CONTRAST_EXEMPT_KEY);
    await page.evaluate(installNamesSomething, NAMES_SOMETHING_KEY);
    const { frames: listed, violations = [], incomplete = [], passes = [], inapplicable = [] } =
      await page.evaluate(runAxeInPage, { step: 'single', options });
    return {
      run: { violations, incomplete, passes, inapplicable },
      untestedFrames: (listed ?? []).map((url) => ({ url, reason: REASONS.noFrames })),
      thirdParty: [],
    };
  }

  const top = frames.find((f) => !f.parentFrame()) ?? frames[0]!;
  const sites = new Set([opts.site ?? '', top.url()].map(registrableDomain).filter(Boolean));
  await top.evaluate(axeSource);
  await top.evaluate(installContrastExempt, CONTRAST_EXEMPT_KEY);
  await top.evaluate(installNamesSomething, NAMES_SOMETHING_KEY);
  const first = await top.evaluate(runAxeInPage, { step: 'top', options });
  if (first.run) return { run: first.run, untestedFrames: [], thirdParty: [] };

  const childrenOf = new Map<FrameLike, FrameLike[]>();
  for (const f of frames) {
    const parent = f.parentFrame();
    if (parent) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), f]);
  }
  const untested: UntestedFrame[] = [];
  /** Third-party frames whose parent is not third-party, each with the partials of its whole subtree. */
  const roots: { url: string; frame: FrameLike; partials: (string | null)[] }[] = [];
  const deadline = Date.now() + limits.totalMs;
  let tested = 0;

  /** Where `child` sits among the frames axe tests from `parent`; null when axe skips it or it is gone. */
  const locate = async (parent: FrameLike, child: FrameLike): Promise<{ index: number; context: unknown } | null> => {
    try {
      let left = deadline - Date.now();
      if (left <= 0) return null;
      const el = await within(Math.min(LOCATE_TIMEOUT_MS, left), child.frameElement());
      left = deadline - Date.now();
      if (left <= 0) return null;
      const at = await within(Math.min(LOCATE_TIMEOUT_MS, left), parent.evaluate(runAxeInPage, { step: 'locate', el }));
      return at.index !== undefined && at.index >= 0 ? { index: at.index, context: at.context } : null;
    } catch {
      return null;
    }
  };

  const testFrame = async (frame: FrameLike, context: unknown): Promise<{ partial: string; frames: string[] }> => {
    const type = await frame.evaluate(frameContentType, undefined);
    if (!/html/i.test(type)) throw new FrameSkipped(REASONS.notPage);
    await frame.evaluate(axeSource);
    await frame.evaluate(installContrastExempt, CONTRAST_EXEMPT_KEY);
    await frame.evaluate(installNamesSomething, NAMES_SOMETHING_KEY);
    const r = await frame.evaluate(runAxeInPage, { step: 'child', options, context });
    return { partial: r.partial!, frames: r.frames ?? [] };
  };

  /**
   * Partial results for the frames under `parent`, in the order axe.finishRun expects: each frame,
   * then its own frames, before its next sibling. `null` stands for a frame that was not tested, and
   * for a third-party frame (outside a third-party subtree): its subtree goes to `roots` instead, so
   * the scored run never contains third-party content. `inThirdParty`: `parent` is third-party content.
   */
  const visit = async (parent: FrameLike, addresses: string[], inThirdParty: boolean): Promise<(string | null)[]> => {
    const slots: { frame: FrameLike; context: unknown }[] = [];
    for (const child of childrenOf.get(parent) ?? []) {
      if (Date.now() >= deadline) break;
      const at = await locate(parent, child);
      if (at && !slots[at.index]) slots[at.index] = { frame: child, context: at.context };
    }
    const out: (string | null)[] = [];
    for (let i = 0; i < addresses.length; i++) {
      const slot = slots[i];
      // A frame that failed to load shows the browser's error page; report the address it asked for.
      const live = slot?.frame.url() ?? '';
      const loaded = !!slot && !/^chrome-error:/i.test(live);
      const url = (loaded && live) || addresses[i] || live;
      const skip = (reason: string): void => {
        untested.push({ url, reason });
        out.push(null);
      };
      if (!loaded) { skip(Date.now() >= deadline ? REASONS.timeLimit : REASONS.notLoaded); continue; }
      if (tested >= limits.maxFrames) { skip(REASONS.limit(limits.maxFrames)); continue; }
      const remaining = deadline - Date.now();
      if (remaining <= 0) { skip(REASONS.timeLimit); continue; }
      tested++;
      try {
        const r = await within(Math.min(limits.frameTimeoutMs, remaining), testFrame(slot.frame, slot.context));
        if (!inThirdParty && isThirdPartyFrame(url, sites) === true) {
          roots.push({ url, frame: slot.frame, partials: [r.partial, ...(await visit(slot.frame, r.frames, true))] });
          out.push(null);
        } else {
          out.push(r.partial, ...(await visit(slot.frame, r.frames, inThirdParty)));
        }
      } catch (err) {
        skip(err instanceof FrameTimeout ? REASONS.timedOut : err instanceof FrameSkipped ? err.message : REASONS.failed(short(err)));
      }
    }
    return out;
  };

  const partials = await visit(top, first.frames ?? [], false);
  const done = await top.evaluate(runAxeInPage, { step: 'finish', options, partials });
  const thirdParty: ThirdPartyRun[] = [];
  // One time box for finishing all of them (finishRun only merges results: milliseconds each).
  const finishBy = Math.min(deadline, Date.now() + limits.frameTimeoutMs);
  for (const root of roots) {
    const left = finishBy - Date.now();
    if (left <= 0) {
      untested.push({ url: root.url, reason: REASONS.notListed('the time limit was reached') });
      continue;
    }
    try {
      const r = await within(left, root.frame.evaluate(runAxeInPage, { step: 'finishFrame', options, partials: root.partials }));
      thirdParty.push({ url: root.url, run: r.run! });
    } catch (err) {
      untested.push({ url: root.url, reason: REASONS.notListed(err instanceof FrameTimeout ? 'it timed out' : short(err)) });
    }
  }
  return { run: done.run!, untestedFrames: untested, thirdParty };
}
