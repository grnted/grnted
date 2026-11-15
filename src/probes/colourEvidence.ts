// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Neutral evidence for the AI review (batch 18, visual lane): pictures of the places where colour may carry meaning
// that the open engine's rules cannot judge (WCAG 1.4.1): charts drawn in SVG, canvas or CSS and pictures of charts,
// and rows of small marks told apart by colour (status dots, badges). Each place is a clip of the page with the text
// around it; nothing here judges anything. Attached to the link-colour test's run (`ProbeContext.attach`), never in the
// run, the report or a store.
import type { ProbeContext } from './types.js';

export interface ColourPlace {
  kind: 'chart' | 'marks';
  /** How the place is drawn: 'svg', 'canvas', 'picture' (an image of a chart), 'css' (boxes), 'marks'. */
  technique: string;
  path: string;
  /** The place's box with a margin, in CSS px of the viewport when it was scrolled into view. */
  clip: { x: number; y: number; width: number; height: number };
  /** Text a reader gets with it: its name, caption or nearby heading, and the text next to it (bounded). */
  name?: string;
  near?: string;
  /** Distinct colours the place paints its parts in (bounded). */
  colours: string[];
}

export interface ColourShot extends ColourPlace { picture: Uint8Array }

export const COLOUR_EVIDENCE_LIMITS = { places: 4, margin: 16, near: 400, maxSide: 900 } as const;

/** Runs in the page (self-contained): the candidate places, at most `max`, in document order. */
export function findColourPlaces(arg: { max: number; near: number }): (Omit<ColourPlace, 'clip'> & { ref: number })[] {
  const w = window as unknown as { __grntedColour?: Element[] };
  w.__grntedColour = [];
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width >= 4 && r.height >= 4 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.1;
  };
  const colourOf = (c: string) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return null;
    const v = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
    if ((v[3] ?? 1) < 0.2) return null;
    const [r, g, b] = v as [number, number, number];
    // Greys (black, white and every grey between) do not tell items apart by hue.
    if (Math.max(r, g, b) - Math.min(r, g, b) < 24) return null;
    return `rgb(${r}, ${g}, ${b})`;
  };
  const path = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur && parts.length < 6; cur = cur.parentElement) {
      if (cur.id) { parts.unshift(`#${CSS.escape(cur.id)}`); break; }
      const p = cur.parentElement;
      const same = p ? Array.from(p.children).filter((c) => c.localName === cur!.localName) : [];
      parts.unshift(same.length > 1 ? `${cur.localName}:nth-of-type(${same.indexOf(cur) + 1})` : cur.localName);
    }
    return parts.join(' > ');
  };
  const clean = (s: string | null | undefined, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const nameOf = (el: Element): string => {
    const fig = el.closest('figure');
    const cap = fig?.querySelector('figcaption')?.textContent;
    const label = el.getAttribute('aria-label') || (el as HTMLImageElement).alt || el.querySelector('title')?.textContent || el.getAttribute('title');
    let heading = '';
    for (let a: Element | null = el; a && !heading; a = a.parentElement) {
      for (let s = a.previousElementSibling; s && !heading; s = s.previousElementSibling) if (/^h[1-6]$/.test(s.localName)) heading = s.textContent ?? '';
    }
    return clean([label, cap, heading].filter(Boolean).join(' | '), 200);
  };
  // The text a reader meets with the place: its own box's, then the two elements after it (a key, a data table).
  const nearOf = (el: Element): string => {
    const box = el.closest('figure, table, ul, ol, dl') ?? el;
    const parts = [(box as HTMLElement).innerText ?? box.textContent ?? ''];
    for (let s = box.nextElementSibling, n = 0; s && n < 2; s = s.nextElementSibling, n++) parts.push((s as HTMLElement).innerText ?? s.textContent ?? '');
    return clean(parts.join(' | '), arg.near);
  };
  const out: (Omit<ColourPlace, 'clip'> & { ref: number })[] = [];
  const taken = new Set<Element>();
  const push = (el: Element, kind: ColourPlace['kind'], technique: string, colours: string[]) => {
    if (out.length >= arg.max || taken.has(el) || [...taken].some((t) => t.contains(el) || el.contains(t))) return;
    taken.add(el);
    out.push({ kind, technique, path: path(el), ...(nameOf(el) ? { name: nameOf(el) } : {}), ...(nearOf(el) ? { near: nearOf(el) } : {}), colours: colours.slice(0, 8), ref: w.__grntedColour!.push(el) - 1 });
  };
  // Charts: SVG drawings with several parts in two or more hues, canvas, pictures named like charts, CSS bar rows.
  for (const el of Array.from(document.querySelectorAll('svg, canvas, img, [role="img"], div, ul, ol'))) {
    if (out.length >= arg.max) break;
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    // A drawing needs some size; a row of CSS boxes (a stacked bar) may be a thin strip.
    if (r.width < 120 || r.height < (/^(div|ul|ol)$/.test(el.localName) && el.getAttribute('role') !== 'img' || el.localName === 'div' ? 16 : 60)) continue;
    if (el.localName === 'svg' || (el.getAttribute('role') === 'img' && el.querySelector('svg'))) {
      const svg = el.localName === 'svg' ? el : el.querySelector('svg')!;
      const parts = Array.from(svg.querySelectorAll('path, rect, circle, ellipse, polygon, polyline, line')).slice(0, 400);
      const hues = new Set<string>();
      for (const p of parts) {
        const cs = getComputedStyle(p);
        for (const c of [cs.fill, cs.stroke]) { const h = colourOf(c); if (h) hues.add(h); }
      }
      if (parts.length >= 3 && hues.size >= 2) push(el, 'chart', 'svg', [...hues]);
    } else if (el.localName === 'canvas') {
      push(el, 'chart', 'canvas', []);
    } else if (el.localName === 'img') {
      if (/chart|graph|pie|donut|doughnut|bar|trend|ridership|budget|percent|share|map/i.test(`${(el as HTMLImageElement).alt} ${(el as HTMLImageElement).src.split('/').pop()}`)) push(el, 'chart', 'picture', []);
    } else {
      // Boxes painted in two or more hues, side by side, with no text of their own: CSS bars or segments.
      const kids = Array.from(el.children).filter((k) => shown(k) && !clean(k.textContent, 1));
      if (kids.length < 3 || kids.length > 40) continue;
      const hues = new Set<string>();
      for (const k of kids) { const h = colourOf(getComputedStyle(k).backgroundColor); if (h) hues.add(h); }
      if (hues.size >= 2 && hues.size >= Math.min(3, kids.length - 1)) push(el, 'chart', 'css', [...hues]);
    }
  }
  // Marks: small boxes with no text, painted in two or more hues, repeated inside one list or table.
  if (out.length < arg.max) {
    const groups = new Map<Element, { hues: Set<string>; n: number }>();
    for (const el of Array.from(document.querySelectorAll('span, i, div, b, em, svg, td > *, li > *'))) {
      if (!shown(el) || clean(el.textContent, 1) && el.localName !== 'svg') continue;
      const r = el.getBoundingClientRect();
      if (r.width > 28 || r.height > 28) continue;
      const cs = getComputedStyle(el);
      const h = colourOf(cs.backgroundColor) ?? colourOf(cs.color !== cs.backgroundColor && el.localName === 'svg' ? (el.querySelector('circle, rect, path') ? getComputedStyle(el.querySelector('circle, rect, path')!).fill : '') : '') ?? colourOf(cs.borderTopColor && parseFloat(cs.borderTopWidth) >= 3 ? cs.borderTopColor : '');
      if (!h) continue;
      const group = el.closest('table, ul, ol, dl, [role="list"], [role="table"], [role="grid"]');
      if (!group) continue;
      const g = groups.get(group) ?? { hues: new Set<string>(), n: 0 };
      g.hues.add(h);
      g.n++;
      groups.set(group, g);
    }
    for (const [group, g] of groups) if (g.n >= 3 && g.hues.size >= 2) push(group, 'marks', 'marks', [...g.hues]);
  }
  return out;
}

/** Runs in the page: scrolls the place into view and returns its box with the margin, inside the viewport. */
export function placeClip(arg: { ref: number; margin: number; maxSide: number }): ColourPlace['clip'] | null {
  const el = (window as unknown as { __grntedColour?: Element[] }).__grntedColour?.[arg.ref];
  if (!el || !el.isConnected) return null;
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  const x = Math.max(0, r.left - arg.margin);
  const y = Math.max(0, r.top - arg.margin);
  const width = Math.min(innerWidth - x, r.width + 2 * arg.margin, arg.maxSide);
  const height = Math.min(innerHeight - y, r.height + 2 * arg.margin, arg.maxSide);
  return width >= 8 && height >= 8 ? { x, y, width, height } : null;
}

/** The places' pictures (PNG), within the probe's time; an empty list when the page has none or time is short. */
export async function colourShots(ctx: ProbeContext): Promise<ColourShot[]> {
  const page = ctx.page;
  if (!page.screenshot || ctx.signal.aborted || Date.now() > ctx.deadline - 3000) return [];
  const places = await page.evaluate(findColourPlaces, { max: COLOUR_EVIDENCE_LIMITS.places, near: COLOUR_EVIDENCE_LIMITS.near }).catch(() => []) as (Omit<ColourPlace, 'clip'> & { ref: number })[];
  const out: ColourShot[] = [];
  for (const p of places) {
    if (ctx.signal.aborted || Date.now() > ctx.deadline - 1500) break;
    const clip = await page.evaluate(placeClip, { ref: p.ref, margin: COLOUR_EVIDENCE_LIMITS.margin, maxSide: COLOUR_EVIDENCE_LIMITS.maxSide }).catch(() => null);
    if (!clip) continue;
    const picture = await page.screenshot({ type: 'png', clip }).catch(() => null);
    if (!picture) continue;
    const { ref: _ref, ...place } = p;
    out.push({ ...place, clip, picture: new Uint8Array(picture) });
  }
  await page.evaluate(() => { delete (window as unknown as { __grntedColour?: Element[] }).__grntedColour; }, undefined).catch(() => {});
  return out;
}
