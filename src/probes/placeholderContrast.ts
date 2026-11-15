// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.3 for placeholder text (2026-11-10): a placeholder shown in an empty field is text and needs
// 4.5:1 against what is behind it (3:1 when large). axe's color-contrast rule does not look at it. Decided from the
// page's own colours (./contrastKit.ts: the field's backdrop composited through its ancestors, a gradient of
// plain colours as a range). A placeholder whose colours cannot be told that way (a field over a picture, a
// filter) is a gap, never clean: the caller reports the page as not testable unless a failure decides it. WCAG's
// exceptions come from the predicate every contrast path shares (./contrastExempt.ts: an inactive field).
// One call into the page, no screenshots. Engine core: no Node-only imports.
import type { ProbeFinding } from '../types.js';
import { PAINT_GAP_TEXT, paintVerdict, type Paint } from './contrastKit.js';
import { hex, ratioText } from './pixels.js';

export const PLACEHOLDER_LIMITS = {
  /** Fields with a placeholder read per page (document order); more is a gap. */
  fields: 60,
  /** Failed findings per page. */
  findings: 5,
  /** A ratio this close under the threshold is not failed (rounding of the colours read). */
  margin: 0.05,
} as const;

/** A field whose placeholder shows, as the styles paint it. */
export interface PlaceholderField extends Paint {
  path: string;
  text: string;
}

export interface PlaceholderRead {
  fields: PlaceholderField[];
  /** Fields with a shown placeholder beyond the limit: not read. */
  more: number;
}

/**
 * Runs in the page (self-contained): the text fields whose placeholder shows, at most `max`, each with the
 * colours that paint it (`kit.paint`, or why they cannot be told). Left out, because nobody is asked to read
 * them: a field with a value, an inactive field (no contrast requirement), a field not rendered, one whose
 * placeholder the page makes invisible (alpha or opacity near 0: a floating label takes its place), and one
 * whose middle shows another element (something lies over it).
 */
export function placeholderFields(arg: { max: number; exemptKey: string; kitKey: string }): PlaceholderRead {
  const w = window as unknown as Record<string, unknown>;
  // Without the shared helpers nothing is read: an exemption or a colour is never guessed.
  const exempt = w[arg.exemptKey] as ((el: Element) => string | null) | undefined;
  const kit = w[arg.kitKey] as { paint(el: Element, pseudo?: string): Paint; rgba(c: string): [number, number, number, number] | null } | undefined;
  if (!exempt || !kit) throw new Error('the contrast helpers are not installed');
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s);
  const segPath = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && (cur.getRootNode() as Document | ShadowRoot).querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      if (!parent) { parts.unshift(cur.localName); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${cur.localName}:nth-of-type(${same.indexOf(cur) + 1})` : cur.localName);
    }
    return parts.join(' > ');
  };
  // Batch 18, round 2: fields in open shadow roots are the page's fields (a web component's search box): found there
  // too, named through their hosts ("host >>> inner"), and hit-tested through the shadow roots they sit in.
  const cssPath = (el: Element): string => {
    const segs: string[] = [];
    for (let e: Element | null = el; e; ) {
      segs.unshift(segPath(e));
      const r = e.getRootNode();
      e = r instanceof ShadowRoot ? r.host : null;
    }
    return segs.join(' >>> ');
  };
  const deepQuery = (sel: string): Element[] => {
    const found: Element[] = [];
    const visit = (root: Document | ShadowRoot, depth: number) => {
      found.push(...Array.from(root.querySelectorAll(sel)));
      if (depth > 6) return;
      for (const h of Array.from(root.querySelectorAll('*'))) if (h.shadowRoot) visit(h.shadowRoot, depth + 1);
    };
    visit(document, 0);
    return found;
  };
  const deepHit = (x: number, y: number): Element | null => {
    let hit = document.elementFromPoint(x, y);
    for (let i = 0; hit?.shadowRoot && i < 8; i++) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };
  const TYPES = /^(?:text|search|email|url|tel|number|password|)$/;
  const fields: PlaceholderField[] = [];
  let more = 0;
  for (const el of deepQuery('input, textarea') as (HTMLInputElement | HTMLTextAreaElement)[]) {
    const text = (el.getAttribute('placeholder') ?? '').replace(/\s+/g, ' ').trim();
    if (!text || el.value !== '') continue;
    if (el instanceof HTMLInputElement && !TYPES.test((el.getAttribute('type') ?? '').trim().toLowerCase())) continue;
    let shown = false;
    try { shown = el.matches(':placeholder-shown'); } catch { shown = false; }
    // WCAG 1.4.3's exceptions (an inactive field): the predicate every contrast path shares.
    if (!shown || exempt(el) !== null) continue;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 10 || r.bottom + window.scrollY <= 0 || r.right + window.scrollX <= 0) continue;
    // Made invisible on purpose (a floating label stands where it would be): nobody is asked to read it.
    const ps = getComputedStyle(el, '::placeholder') as CSSStyleDeclaration & { webkitTextFillColor?: string };
    const ink = kit.rgba(ps.webkitTextFillColor && ps.webkitTextFillColor !== ps.color ? ps.webkitTextFillColor : ps.color);
    const opacity = parseFloat(ps.opacity);
    if (ink && Number.isFinite(opacity) && ink[3] * opacity < 0.1) continue;
    // Something lies over the field where its text would be (when that place is on screen now).
    const cx = r.left + Math.min(r.width / 2, 40);
    const cy = r.top + r.height / 2;
    if (cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight) {
      const hit = deepHit(cx, cy);
      if (hit && hit !== el && !el.contains(hit)) continue;
    }
    if (fields.length >= arg.max) { more++; continue; }
    fields.push({ ...kit.paint(el, '::placeholder'), path: cssPath(el), text: text.length > 80 ? `${text.slice(0, 79)}…` : text });
  }
  return { fields, more };
}

/**
 * The failed findings for placeholders below their threshold (4.5:1, or 3:1 for large text), at most
 * `PLACEHOLDER_LIMITS.findings`, and what could not be measured (`gaps`: the reason, with how many fields). Pure.
 */
export function placeholderFindings(read: PlaceholderRead): { findings: ProbeFinding[]; gaps: Map<string, number> } {
  const findings: ProbeFinding[] = [];
  const gaps = new Map<string, number>();
  const gap = (why: string, n = 1) => gaps.set(why, (gaps.get(why) ?? 0) + n);
  if (read.more) gap('more fields with placeholder text than the test reads', read.more);
  for (const f of read.fields) {
    const v = paintVerdict(f, PLACEHOLDER_LIMITS.margin);
    if (v.kind === 'unknown') { gap(`placeholder text where ${PAINT_GAP_TEXT[v.why]}`); continue; }
    if (v.kind === 'pass' || findings.length >= PLACEHOLDER_LIMITS.findings) continue;
    findings.push({
      criterion: '1.4.3', status: 'failed', target: f.path, data: { kind: 'placeholder' },
      detail: `Placeholder text contrast is ${ratioText(v.ratio)} (text ${hex(v.fg)} on ${v.several ? `a gradient, at best ${hex(v.bg)}` : hex(v.bg)}); ${Math.round(f.fontSize * 10) / 10} px text needs at least ${v.threshold}:1: “${f.text}”`,
    });
  }
  return { findings, gaps };
}
