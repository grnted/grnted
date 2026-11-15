// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Text that names something else is never an unmarked heading (1.3.1, F2; the semantics lane's rule, review round
// 1, ruling 4): the target of an aria-labelledby or aria-describedby, the text an ancestor's aria-label repeats, and
// the first text of a group, a region, a widget, a fieldset or a figure (its label, whether tied to it or not).
// ONE predicate, shared by every path that judges whether styled text is a heading with no markup: the headings
// test's own F2 reading (`readHeadings` in ./headings.ts) and axe's p-as-heading results (src/axeRun.ts). Both run in
// the page, so the predicate is put on the window first (`installNamesSomething`, as ./contrastExempt.ts does).
// Engine core: no Node-only imports.

/** Where the predicate is kept on the window (a frame's own window for its elements). */
export const NAMES_SOMETHING_KEY = '__grntedNamesSomething';

/**
 * Whether `el`'s text names something else. `at`: the wrapper `el` is alone in (it holds no other text), default `el`
 * itself; `refs`: the ids that aria-labelledby and aria-describedby name in `el`'s tree, default read from that tree
 * (its document or shadow root) now.
 */
export type NamesSomething = (el: Element, at?: Element, refs?: ReadonlySet<string>) => boolean;

/** Runs in the page (self-contained): puts the predicate on the window, once. Reads only; changes nothing else. */
export function installNamesSomething(key: string): void {
  const w = window as unknown as Record<string, unknown>;
  if (typeof w[key] === 'function') return;
  const words = (t: string) => t.replace(/\s+/g, ' ').trim();
  const LABELLED = '[role="group"], [role="radiogroup"], [role="region"], [role="tabpanel"], [role="toolbar"], [role="listbox"], [role="tree"], [role="treegrid"], [role="grid"], [role="form"], [role="search"], [role="figure"], [role="feed"], [role="application"], [role="note"], [role="tooltip"], [role="article"], fieldset, details, figure';
  /** The ids aria-labelledby and aria-describedby name in a document or shadow root (its first 5000 such elements). */
  const refsIn = (root: ParentNode): Set<string> => {
    const refs = new Set<string>();
    const tied = root.querySelectorAll('[aria-labelledby], [aria-describedby]');
    for (let i = 0; i < tied.length && i < 5000; i++) for (const id of `${tied[i]!.getAttribute('aria-labelledby') ?? ''} ${tied[i]!.getAttribute('aria-describedby') ?? ''}`.split(/\s+/)) if (id) refs.add(id);
    return refs;
  };
  const namesSomething = (el: Element, at: Element = el, given?: ReadonlySet<string>): boolean => {
    const refs = given ?? refsIn(el.getRootNode() as Document | ShadowRoot);
    const text = words(el.textContent ?? '');
    // Tied by reference: the element, a wrapper that holds nothing else, or an element inside it that holds all its text.
    for (let a: Element | null = el, i = 0; a && i < 4; a = a.parentElement, i++) {
      if (a.id && refs.has(a.id)) return true;
      if (a === at) break;
    }
    for (const d of Array.from(el.querySelectorAll('[id]')).slice(0, 20)) if (refs.has(d.id) && words(d.textContent ?? '') === text) return true;
    const lower = text.toLowerCase();
    const body = el.ownerDocument.body;
    for (let a: Element | null = el.parentElement, i = 0; a && i < 5 && a !== body; a = a.parentElement, i++) {
      if (words(a.getAttribute('aria-label') ?? '').toLowerCase() === lower) return true;
      if (a.matches(LABELLED)) {
        // Its first text: what a screen reader user, and a sighted one, take for its label.
        const walker = (a.ownerDocument ?? document).createTreeWalker(a, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(), k = 0; n && k < 200; n = walker.nextNode(), k++) {
          if (!(n.nodeValue ?? '').trim()) continue;
          const holder = n.parentElement;
          if (holder && (holder.ownerDocument.defaultView ?? window).getComputedStyle(holder).display === 'none') continue;
          if (el.contains(n)) return true;
          break;
        }
      }
    }
    return false;
  };
  w[key] = namesSomething;
}
