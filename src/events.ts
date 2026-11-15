// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Scan events (Plan 5, Task 5.9): helpers for `ScanOptions.onEvent`, which feeds the live scan screen
// (docs/design/2026-10-31-grnted-site/README.md §3.2, §3.6). Events are observation only. Engine core:
// no Node-only imports.
import { IMPACT_RANK, defaultImpactOf, type ImpactOf } from './score.js';
import type { AxeRun, Impact, PageLike, RuleHit, ScanEvent, WireEl, Wireframe } from './types.js';

/** Bounds of a wireframe and its capture. */
export const WIREFRAME_LIMITS = {
  /** Layout boxes per wireframe. */
  layout: 220,
  /** Failing elements placed per rule. */
  perRule: 6,
  /** Failing elements placed in all. */
  failing: 120,
  /** Characters of text per box. */
  text: 48,
  maxWidth: 4096,
  maxHeight: 20_000,
  /** Cap on the reported DOM element count. */
  maxElements: 1_000_000,
  /** axe targets longer than this are not looked up. */
  maxTarget: 1000,
  /** Candidate elements the page looks at, at most. */
  scan: 5000,
  /** The in-page time budget, and the time box around the whole capture. */
  budgetMs: 1500,
  timeoutMs: 5000,
} as const;

/** A failing element to place in the wireframe: its rule, the rule's impact and its axe target. */
export interface WireTarget {
  id: string;
  impact: Impact;
  target: string;
}

const KINDS: ReadonlySet<string> = new Set<WireEl['t']>(['header', 'main', 'footer', 'h1', 'h2', 'h3', 'p', 'a', 'button', 'img', 'input', 'label']);
const TEXT_KINDS: ReadonlySet<string> = new Set(['h1', 'h2', 'h3', 'a', 'button', 'label']);

export function emptyWireframe(): Wireframe {
  return { W: 0, H: 0, els: [] };
}

/**
 * Rules grouped by id with their failing element counts and scoring impact, worst first (impact
 * weight, then count, then id). Rules with no elements are left out.
 */
export function ruleHits(rules: readonly { id: string; nodes: readonly unknown[] }[], impactOf: ImpactOf = defaultImpactOf): RuleHit[] {
  const counts = new Map<string, number>();
  for (const r of rules) counts.set(r.id, (counts.get(r.id) ?? 0) + r.nodes.length);
  return [...counts]
    .filter(([, count]) => count > 0)
    .map(([id, count]) => ({ id, impact: impactOf(id), count }))
    .sort((a, b) => IMPACT_RANK[b.impact] - IMPACT_RANK[a.impact] || b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Applicable axe rules in one run: passes + violations + incomplete. */
export function viewportChecks(run: AxeRun): number {
  return run.passes.length + run.violations.length + run.incomplete.length;
}

/**
 * The failing elements to place in a wireframe: up to `perRule` per rule and `failing` in all. A target
 * inside a frame or a shadow root (`a >>> b`) is placed at its frame or host (the first segment).
 */
export function failingTargets(violations: readonly { id: string; nodes: readonly { target: string }[] }[], impactOf: ImpactOf = defaultImpactOf): WireTarget[] {
  const out: WireTarget[] = [];
  for (const v of violations) {
    for (const n of v.nodes.slice(0, WIREFRAME_LIMITS.perRule)) {
      if (out.length >= WIREFRAME_LIMITS.failing) return out;
      const target = String(n.target).split(' >>> ')[0]!.trim();
      if (!target || target.length > WIREFRAME_LIMITS.maxTarget) continue;
      out.push({ id: v.id, impact: impactOf(v.id), target });
    }
  }
  return out;
}

interface InPageArg {
  targets: { id: string; target: string }[];
  layout: number;
  text: number;
  maxHeight: number;
  scan: number;
  budgetMs: number;
}

/**
 * Runs inside the page (self-contained): layout boxes and failing elements, plus the DOM element count.
 * Text comes from text nodes only, never from form fields (input, textarea, select), editable regions
 * or attributes. The result is untrusted: `sanitizeWireframe` checks and bounds it.
 */
export function wireframeInPage(arg: InPageArg): unknown {
  const t0 = performance.now();
  const doc = document.documentElement;
  const W = doc.clientWidth;
  const H = Math.min(doc.scrollHeight, arg.maxHeight);
  const sx = window.scrollX;
  const sy = window.scrollY;
  const KIND: Record<string, string> = {
    HEADER: 'header', NAV: 'header', MAIN: 'main', FOOTER: 'footer', H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h3', H5: 'h3', H6: 'h3', P: 'p',
    A: 'a', BUTTON: 'button', IMG: 'img', SVG: 'img', PICTURE: 'img', VIDEO: 'img', AUDIO: 'img', CANVAS: 'img', IFRAME: 'img',
    OBJECT: 'img', EMBED: 'img', INPUT: 'input', SELECT: 'input', TEXTAREA: 'input', LABEL: 'label',
  };
  const kind = (el: Element): string => KIND[el.tagName.toUpperCase()] ?? 'p';
  const TEXT = /^(h1|h2|h3|a|button|label)$/;
  const NO_TEXT = 'input,textarea,select,option,datalist,script,style,noscript,template,[contenteditable]:not([contenteditable="false"])';
  const textOf = (el: Element): string | undefined => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let s = '';
    for (let n = walker.nextNode(); n && s.length < 200; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (parent && parent.closest(NO_TEXT)) continue;
      s += ` ${String(n.nodeValue ?? '').slice(0, 200)}`;
    }
    s = s.replace(/\s+/g, ' ').trim();
    return s ? s.slice(0, arg.text) : undefined;
  };
  const box = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + sx, y: r.top + sy, w: r.width, h: r.height };
  };
  const inside = (b: { x: number; y: number; w: number; h: number }) => b.x < W && b.y < H && b.x + b.w > 0 && b.y + b.h > 0;
  const els: Record<string, unknown>[] = [];
  const all = document.querySelectorAll('header,main,footer,h1,h2,h3,p,a,button,img,input,select,textarea,label');
  for (let i = 0; i < all.length && i < arg.scan && els.length < arg.layout; i++) {
    if (performance.now() - t0 > arg.budgetMs) break;
    const el = all[i]!;
    if ((el as HTMLInputElement).type === 'hidden' && el.tagName === 'INPUT') continue;
    const b = box(el);
    if (b.w < 4 || b.h < 2 || !inside(b)) continue;
    const visible = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
    if (typeof visible === 'function' && !visible.call(el, { visibilityProperty: true, opacityProperty: true })) continue;
    const t = kind(el);
    const e: Record<string, unknown> = { t, ...b };
    if (TEXT.test(t)) {
      const text = textOf(el);
      if (text) e.text = text;
    }
    els.push(e);
  }
  for (const v of arg.targets) {
    if (performance.now() - t0 > arg.budgetMs) break;
    let el: Element | null = null;
    try {
      el = document.querySelector(v.target);
    } catch {
      continue;
    }
    // The document, its body and head elements cover the whole page or nothing: the rule is listed only.
    if (!el || el === doc || el === document.body || (document.head && document.head.contains(el))) continue;
    const b = box(el);
    if (!(b.w > 0 || b.h > 0) || !inside(b)) continue;
    els.push({ t: kind(el), x: b.x, y: b.y, w: Math.max(b.w, 4), h: Math.max(b.h, 4), rule: v.id });
  }
  return { W, H, elements: document.getElementsByTagName('*').length, els };
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/**
 * Checks and bounds what the page returned: known kinds only, integer boxes clipped to `W` × `H`,
 * text only on text kinds (collapsed, at most `text` characters), failing elements only for rules
 * the engine reported (with the engine's impact), and the caps. Anything malformed gives an empty
 * wireframe.
 */
export function sanitizeWireframe(raw: unknown, targets: readonly WireTarget[]): { wireframe: Wireframe; elements: number } {
  const empty = { elements: 0, wireframe: emptyWireframe() };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const r = raw as Record<string, unknown>;
  if (!finite(r.W) || !finite(r.H) || !Array.isArray(r.els)) return empty;
  const L = WIREFRAME_LIMITS;
  const W = clamp(Math.round(r.W), 0, L.maxWidth);
  const H = clamp(Math.round(r.H), 0, L.maxHeight);
  const elements = finite(r.elements) ? clamp(Math.round(r.elements), 0, L.maxElements) : 0;
  const impacts = new Map(targets.map((t) => [t.id, t.impact]));
  const perRule = new Map<string, number>();
  let layout = 0;
  let failing = 0;
  const els: WireEl[] = [];
  for (const item of (r.els as unknown[]).slice(0, 4 * (L.layout + L.failing))) {
    if (!item || typeof item !== 'object') continue;
    const { t, x, y, w, h, text, rule } = item as Record<string, unknown>;
    if (typeof t !== 'string' || !KINDS.has(t)) continue;
    if (!finite(x) || !finite(y) || !finite(w) || !finite(h)) continue;
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    const left = Math.max(0, x0);
    const top = Math.max(0, y0);
    const right = Math.min(W, x0 + Math.round(w));
    const bottom = Math.min(H, y0 + Math.round(h));
    if (right <= left || bottom <= top) continue;
    const el: WireEl = { t: t as WireEl['t'], x: left, y: top, w: right - left, h: bottom - top };
    if (rule !== undefined) {
      if (typeof rule !== 'string' || !impacts.has(rule)) continue;
      const n = perRule.get(rule) ?? 0;
      if (n >= L.perRule || failing >= L.failing) continue;
      perRule.set(rule, n + 1);
      failing++;
      els.push({ ...el, rule, impact: impacts.get(rule)! });
      continue;
    }
    if (layout >= L.layout) continue;
    layout++;
    if (typeof text === 'string' && TEXT_KINDS.has(t)) {
      const s = text.slice(0, 1000).replace(/\s+/g, ' ').trim().slice(0, L.text);
      if (s) el.text = s;
    }
    els.push(el);
  }
  return { elements, wireframe: { W, H, els } };
}

/**
 * The page's wireframe at its current width, in one `page.evaluate`. Time-boxed; never throws: on any
 * failure or timeout the wireframe is empty and the element count 0.
 */
export async function captureWireframe(
  page: PageLike,
  targets: readonly WireTarget[],
  timeoutMs: number = WIREFRAME_LIMITS.timeoutMs,
): Promise<{ wireframe: Wireframe; elements: number }> {
  const L = WIREFRAME_LIMITS;
  const arg: InPageArg = {
    targets: targets.map((t) => ({ id: t.id, target: t.target })),
    layout: L.layout, text: L.text, maxHeight: L.maxHeight, scan: L.scan, budgetMs: L.budgetMs,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const evaluation = page.evaluate(wireframeInPage, arg);
    // A late rejection (the context closes after a timeout) must not go unhandled.
    evaluation.catch(() => undefined);
    const raw = await Promise.race([
      evaluation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Wireframe timed out')), timeoutMs); }),
    ]);
    return sanitizeWireframe(raw, targets);
  } catch {
    return { elements: 0, wireframe: emptyWireframe() };
  } finally {
    clearTimeout(timer);
  }
}

/** Longest `detail` of a `stage` event (the live view shows it on one line). */
export const STAGE_DETAIL_MAX = 120;

/**
 * Wraps a listener so it can never break the scan: a throw is caught, an async listener's rejection
 * is handled. Undefined without a listener (nothing is computed for events then).
 */
export function safeEmit(listener: ((e: ScanEvent) => void) | undefined): ((e: ScanEvent) => void) | undefined {
  if (!listener) return undefined;
  return (e) => {
    try {
      const result = listener(e) as unknown;
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        (result as PromiseLike<unknown>).then(undefined, () => undefined);
      }
    } catch {
      // A listener's failure is its own: events are observation only.
    }
  };
}
