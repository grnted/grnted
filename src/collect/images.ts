// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import type { ImageCandidate, PageCollector } from '../types.js';

/**
 * Runs inside the page. Images that carry an alt attribute and are exposed to assistive tech, then
 * (with their own cap) images with no text alternative at all, which axe already fails as `image-alt`.
 */
function collectImages(): Omit<ImageCandidate, 'page'>[] {
  const clean = (s: string | null | undefined, max: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const hidden = (img: HTMLImageElement) =>
    !!img.closest('[aria-hidden="true"]') || /^(presentation|none)$/.test(img.getAttribute('role') ?? '');
  // Nearby text (review r2): the text around the image, closest first, up to its section. From the
  // image up, each level adds the text of the siblings of the image's wrapper, nearest first
  // (following, then preceding), and stops at the nearest sectioning element (section, article, main,
  // aside, li, td, th) or at a block that has a heading of its own. Capped at 1,500
  // characters. The model's nearby_text and the check of its claim (altText) both use this text.
  // A figure is not a boundary (scoring v12): its caption comes first (the figure's own text), then the text around
  // the figure, where pages explain a map or a chart, up to the next heading (never into the next section).
  const NEARBY_MAX = 1500;
  const SECTION = 'section, article, main, aside, li, td, th, dialog, body';
  const HEADING = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
  const textOf = (n: Node): string => {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent ?? '';
    if (n.nodeType !== Node.ELEMENT_NODE) return '';
    const el = n as HTMLElement & { checkVisibility?: () => boolean };
    if (/^(script|style|template|noscript)$/.test(el.localName)) return '';
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return '';
    return el.innerText ?? '';
  };
  // Two texts from one walk (review r1, the lead's ruling (b), then its fallback after the second gate run):
  // - context (`nearbyText`, what the model reads): every sibling of the image and of its wrappers, closest first, up to
  //   the section (the ad420af3 walk): a map's list of stops or the paragraph naming its address is adjacent text WCAG
  //   lets supplement an alt, and hiding it made the model call complete alt texts wrong;
  // - claim text (`claimText`, used only by the claim rule, givenShare): the same walk, but after the image it stops
  //   before any sibling that is or holds a heading, and before it stops at the image's own section heading, so words of
  //   another section can never discard a real confirmed failure.
  const nearby = (img: HTMLImageElement): { context: string; claim: string } => {
    const ctx: string[] = [];
    const claim: string[] = [];
    let leftCtx = NEARBY_MAX;
    let leftClaim = NEARBY_MAX;
    const add = (n: Node, toClaim: boolean) => {
      if (leftCtx > 0) {
        const t = clean(textOf(n), leftCtx);
        if (t) { ctx.push(t); leftCtx -= t.length + 1; }
      }
      if (toClaim && leftClaim > 0) {
        const t = clean(textOf(n), leftClaim);
        if (t) { claim.push(t); leftClaim -= t.length + 1; }
      }
    };
    const isHeadingish = (n: Node) => n.nodeType === Node.ELEMENT_NODE && ((n as Element).matches(HEADING) || !!(n as Element).querySelector(HEADING));
    let claimAfterDone = false;
    let claimBeforeDone = false;
    let cur: Element = img;
    for (let i = 0; i < 40 && (leftCtx > 0 || leftClaim > 0); i++) {
      const parent = cur.parentElement;
      if (!parent) break;
      let prev = cur.previousSibling;
      let next = cur.nextSibling;
      while (prev || next) {
        if (next) {
          if (isHeadingish(next)) claimAfterDone = true;
          add(next, !claimAfterDone);
          next = next.nextSibling;
        }
        if (prev) {
          add(prev, !claimBeforeDone);
          if (isHeadingish(prev)) claimBeforeDone = true;
          prev = prev.previousSibling;
        }
      }
      if (parent.matches(SECTION)) break;
      const within = cur;
      if ([...parent.querySelectorAll(HEADING)].some((h) => !within.contains(h))) break;
      cur = parent;
    }
    return { context: clean(ctx.join(' '), NEARBY_MAX), claim: clean(claim.join(' '), NEARBY_MAX) };
  };
  const context = (img: HTMLImageElement) => {
    const a = img.closest('a[href]') as HTMLAnchorElement | null;
    const near = nearby(img);
    return {
      ...(a ? { link: { href: a.href, text: clean(a.innerText, 200) } } : {}),
      ...(img.closest('figure')?.querySelector('figcaption') ? { caption: clean(img.closest('figure')!.querySelector('figcaption')!.textContent, 300) } : {}),
      ...(near.context ? { nearbyText: near.context } : {}),
      // Always present (possibly empty) when the collector ran, so the claim rule never falls back to the wider context.
      claimText: near.claim,
    };
  };
  const out: Omit<ImageCandidate, 'page'>[] = [];
  for (const img of [...document.querySelectorAll('img[alt]')] as HTMLImageElement[]) {
    if (out.length >= 100) break;
    if (hidden(img)) continue;
    const box = img.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    out.push({
      src: img.currentSrc || img.src,
      alt: img.getAttribute('aria-label') ?? img.getAttribute('alt') ?? '',
      width: Math.round(box.width),
      height: Math.round(box.height),
      ...context(img),
    });
  }
  // No alt attribute and no other name (aria-label, aria-labelledby, title): already an axe failure.
  let missing = 0;
  for (const img of [...document.querySelectorAll('img:not([alt])')] as HTMLImageElement[]) {
    if (missing >= 50) break;
    if (hidden(img) || ['aria-label', 'aria-labelledby', 'title'].some((n) => (img.getAttribute(n) ?? '').trim())) continue;
    const box = img.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    out.push({
      src: img.currentSrc || img.src,
      alt: '',
      missingAlt: true,
      width: Math.round(box.width),
      height: Math.round(box.height),
      ...context(img),
    });
    missing++;
  }
  return out;
}

/**
 * Images and their context (desktop): those with an alt attribute (input for the AI alt-text
 * sample), plus those with none at all, marked `missingAlt` (input for alt-text suggestions).
 */
export const imagesCollector: PageCollector<ImageCandidate[]> = {
  id: 'images',
  viewport: 'desktop',
  async collect(page, { url }) {
    const images = await page.evaluate(collectImages, undefined);
    return images.map((img) => ({ page: url, ...img }));
  },
};
