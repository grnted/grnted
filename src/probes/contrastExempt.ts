// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.3's exceptions as ONE predicate, used by every path that judges text contrast: axe's results at rest
// (src/axeRun.ts), placeholder text, text in its hover and focus states, and text shown only on hover or focus.
// "Incidental: Text or images of text that are part of an inactive user interface component, that are pure
// decoration, that are not visible to anyone, or that are part of a picture that contains significant other
// visual content, have no contrast requirement. Logotypes: Text that is part of a logo or brand name has no
// contrast requirement." (SC 1.4.3)
// - inactive: the element or an ancestor is a disabled control (`:disabled`), is marked `aria-disabled="true"`,
//   sits in a disabled fieldset (outside its first legend), or is the label of a disabled control;
// - logotype: the text sits in an element (itself or up to three ancestors) the page marks as its logo (a class
//   or id word of logo, logotype, wordmark, brandmark or navbar-brand; or role=img named a logo or wordmark)
//   that holds no more text than a logo does (80 characters). "logout" or "btn-brand" is not a logo;
// - decoration: its own text is two or more characters with no letter or digit in any script (ACT afw4f7:
//   "does not express anything in human language").
// Text not visible to anyone is never read by those paths in the first place. Engine core: no Node-only imports.

/** Where the predicate is kept on the window (a frame's own window for its elements). */
export const CONTRAST_EXEMPT_KEY = '__grntedContrastExempt';

export type ContrastExemption = 'inactive' | 'logotype' | 'decoration';

/** Runs in the page (self-contained): puts the predicate on the window, once. Reads only; changes nothing else. */
export function installContrastExempt(key: string): void {
  const w = window as unknown as Record<string, unknown>;
  if (typeof w[key] === 'function') return;
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const LOGO_WORD = /(?:^|[-_\s])(?:logo|logotype|wordmark|brandmark|navbar-brand)(?:$|[-_\s])/i;
  const LOGO_NAME = /\b(?:logo|logotype|wordmark)\b/i;
  const LOGO_MAX_TEXT = 80;
  const up = (a: Element): Element | null => a.parentElement ?? ((a.getRootNode() as ShadowRoot).host ?? null);
  const inactive = (el: Element): boolean => {
    for (let a: Element | null = el, i = 0; a && i < 200; a = up(a), i++) {
      if ((a.getAttribute('aria-disabled') ?? '').trim().toLowerCase() === 'true') return true;
      if (a.localName === 'fieldset' && a.hasAttribute('disabled')) {
        // HTML's exception comes first (review r2, finding 9): what sits in a disabled fieldset's first legend child
        // stays active, though the fieldset itself matches `:disabled`. Outside that legend everything is inactive.
        const legend = [...a.children].find((c) => c.localName === 'legend');
        if (!legend || !legend.contains(el)) return true;
        continue;
      }
      let off = false;
      try { off = a.matches(':disabled'); } catch { off = false; }
      if (off) return true;
      if (a.localName === 'label') {
        const control = (a as HTMLLabelElement).control;
        let disabled = false;
        try { disabled = !!control && (control.matches(':disabled') || control.getAttribute('aria-disabled') === 'true'); } catch { disabled = false; }
        if (disabled) return true;
      }
    }
    return false;
  };
  const logotype = (el: Element): boolean => {
    const doc = el.ownerDocument;
    for (let a: Element | null = el, i = 0; a && i < 4 && a !== doc.body && a !== doc.documentElement; a = a.parentElement, i++) {
      const marked = LOGO_WORD.test(`${a.getAttribute('class') ?? ''} ${a.getAttribute('id') ?? ''}`)
        || ((a.getAttribute('role') ?? '').trim().toLowerCase() === 'img' && LOGO_NAME.test(a.getAttribute('aria-label') ?? ''));
      if (marked) return norm(a.textContent).length <= LOGO_MAX_TEXT;
    }
    return false;
  };
  const decoration = (el: Element): boolean => {
    let own = '';
    for (const c of el.childNodes) if (c.nodeType === 3) own += c.nodeValue ?? '';
    return [...own.replace(/\s+/g, '')].length >= 2 && !/[\p{L}\p{N}]/u.test(own);
  };
  // Batch 18, D18: a decorative watermark: text hidden from assistive technology (aria-hidden="true" on it or an
  // ancestor within three) whose words all repeat visible text right beside it (its parent's or grandparent's other
  // text), set at least twice that text's size. It says nothing the page does not say; WCAG's "pure decoration".
  const watermark = (el: Element): boolean => {
    let hidden: Element | null = null;
    for (let a: Element | null = el, i = 0; a && i < 4; a = a.parentElement, i++) if (a.getAttribute('aria-hidden') === 'true') { hidden = a; break; }
    if (!hidden) return false;
    const own = norm(hidden.textContent).toLowerCase();
    const words = own.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!words.length || own.length > 60) return false;
    const size = parseFloat(getComputedStyle(el).fontSize) || 0;
    for (let box: Element | null = hidden.parentElement, i = 0; box && i < 2; box = box.parentElement, i++) {
      for (const sib of Array.from(box.querySelectorAll('h1, h2, h3, h4, h5, h6, p, span, strong, a'))) {
        if (hidden.contains(sib) || sib.contains(hidden) || sib.closest('[aria-hidden="true"]')) continue;
        const t = norm(sib.textContent).toLowerCase();
        if (!t || !words.every((w) => t.includes(w))) continue;
        const s = parseFloat(getComputedStyle(sib).fontSize) || 0;
        if (s > 0 && size >= 2 * s) return true;
      }
    }
    return false;
  };
  w[key] = (el: Element): ContrastExemption | null => {
    try {
      return inactive(el) ? 'inactive' : logotype(el) ? 'logotype' : decoration(el) || watermark(el) ? 'decoration' : null;
    } catch {
      return null;
    }
  };
}
