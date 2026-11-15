// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Single-character controls: graphic evidence shared by the text and non-text contrast probes.
import type { ProbeContext } from './types.js';

interface Candidate { ref: number; character: string; graphic: boolean }

/** Runs in the page. Attribute names only nominate candidates; Chromium supplies the actual name. */
function candidates(key: string): Candidate[] {
  const w = window as unknown as Record<string, unknown>;
  const store = (w[key] ?? []) as Element[];
  const controls: Element[] = [];
  w.__grntedGraphicControls = controls;
  const selector = 'button, a[href], input[type="button"], input[type="submit"], input[type="reset"], summary, [role="button"], [role="link"], [role="checkbox"], [role="combobox"], [role="gridcell"], [role="listbox"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="radio"], [role="scrollbar"], [role="searchbox"], [role="slider"], [role="spinbutton"], [role="switch"], [role="tab"], [role="textbox"], [role="treeitem"]';
  const parentOf = (el: Element): Element | null => el.parentElement ?? (el.getRootNode() as ShadowRoot).host ?? null;
  const visible = (el: Element) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const text = (el: Element) => {
    if (el instanceof HTMLInputElement) return { character: el.value.trim(), holder: el };
    let out = '';
    let holder = el;
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.parentElement || !visible(n.parentElement)) continue;
      const range = el.ownerDocument.createRange();
      range.selectNode(n);
      if ([...range.getClientRects()].some((r) => r.width > 1 && r.height > 1)) {
        out += n.nodeValue ?? '';
        if (/\S/.test(n.nodeValue ?? '')) holder = n.parentElement;
      }
    }
    return { character: out.replace(/\s+/g, '').trim(), holder };
  };
  return store.flatMap((el, ref) => {
    let control: Element | null = el;
    while (control && !control.matches(selector)) control = parentOf(control);
    if (!control) return [];
    const { character, holder } = text(control);
    if ([...character].length !== 1) return [];
    // Other visible graphics or generated content mean this character is not the entire control.
    if ([...control.querySelectorAll('img, svg, canvas, video')].some(visible)) return [];
    if ([control, ...control.querySelectorAll('*')].some((e) => ['::before', '::after'].some((p) => !/^(none|normal|""|'')$/.test(getComputedStyle(e, p).content)))) return [];
    let graphic = /^[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]$/u.test(character);
    for (let a: Element | null = holder; a; a = parentOf(a)) {
      if (a.getAttribute('aria-hidden') === 'true' || /^(img|presentation|none)$/.test(a.getAttribute('role') ?? '')) graphic = true;
    }
    if (!graphic && !['aria-label', 'aria-labelledby', 'title'].some((a) => control!.hasAttribute(a))) return [];
    controls[ref] = control;
    return [{ ref, character, graphic }];
  });
}

/** Only a computed name from an effective naming attribute can establish name-mismatch evidence. */
export async function graphicControlRefs(ctx: Pick<ProbeContext, 'page' | 'cdp' | 'deadline'>, key: string): Promise<{ graphic: Set<number>; unknown: Set<number> }> {
  const found = await ctx.page.evaluate(candidates, key);
  const graphic = new Set(found.filter((c) => c.graphic).map((c) => c.ref));
  const unknown = new Set<number>();
  try {
    const pending = found.filter((c) => !c.graphic);
    if (!pending.length) return { graphic, unknown };
    const cdp = await ctx.cdp?.();
    for (const c of pending) {
      if (!cdp || Date.now() >= ctx.deadline - 1500) { unknown.add(c.ref); continue; }
      let objectId: string | undefined;
      try {
        const ev = await cdp.send('Runtime.evaluate', { expression: `window.__grntedGraphicControls[${c.ref}]`, returnByValue: false }) as { result?: { objectId?: string } };
        objectId = ev?.result?.objectId;
        if (!objectId) { unknown.add(c.ref); continue; }
        const ax = await cdp.send('Accessibility.getPartialAXTree', { objectId, fetchRelatives: false }) as { nodes?: { ignored?: boolean; name?: { value?: unknown; sources?: { attribute?: string; superseded?: boolean; invalid?: boolean; value?: { value?: unknown } }[] } }[] };
        const node = ax?.nodes?.[0];
        if (!node || node.ignored || typeof node.name?.value !== 'string') { unknown.add(c.ref); continue; }
        const name = node.name.value.trim();
        const fromAttribute = node.name.sources?.some((s) => !s.superseded && !s.invalid && /^(aria-label|aria-labelledby|title)$/.test(s.attribute ?? '') && typeof s.value?.value === 'string' && s.value.value.trim());
        if (name && fromAttribute && !name.includes(c.character)) graphic.add(c.ref);
      } catch {
        unknown.add(c.ref);
      } finally {
        if (objectId) await cdp.send('Runtime.releaseObject', { objectId }).catch(() => {});
      }
    }
    return { graphic, unknown };
  } finally {
    await ctx.page.evaluate(() => { delete (window as unknown as Record<string, unknown>).__grntedGraphicControls; }, undefined).catch(() => {});
  }
}
