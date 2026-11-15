// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The focus order the keyboard test followed, as evidence for the AI focus-order review (2.4.3): the
// forward Tab stops in order, each with what it is, its name, where it is on the page, its landmark
// and the section heading before it. Plumbing only: it judges nothing. Engine core: no Node-only imports.
import { footerBeforeMain } from './rules.js';
import type { Traversal } from './traverse.js';

/** Version of the focus-order evidence (`ProbeRun.data.focusOrder.v`). */
export const FOCUS_ORDER_DATA_VERSION = 1;
/** Tab stops kept (the core walk follows up to 60; the deep walk more). */
export const FOCUS_ORDER_MAX_STOPS = 80;

export interface FocusOrderStop {
  /** Position in the Tab order, from 1. */
  n: number;
  /** Role, else the element (an input with its type: "input checkbox"). */
  what: string;
  /** The accessible name ("" when it has none). */
  name: string;
  /** Box in page coordinates (CSS px, rounded). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The innermost landmark it is in. */
  region?: string;
  /** The last heading before it in the document. */
  section?: string;
  /** In a fixed or sticky container (it stays on screen while the page scrolls). */
  fixed?: true;
  /** Inside a frame (focus moves into it). */
  frame?: true;
  /** A positive tabindex. */
  tabindex?: number;
  /**
   * Already reported for 2.4.3 by the keyboard test's rules (a positive tabindex, the footer before the
   * main content): the AI review never reports it again.
   */
  known?: true;
}

export interface FocusOrderData {
  v: typeof FOCUS_ORDER_DATA_VERSION;
  /** Forward Tab stops, in order, each element once, up to the first repeat. */
  stops: FocusOrderStop[];
  /** The walk stopped before the end of the page (its stop or time limit). */
  partial: boolean;
  /** The test's viewport height (CSS px). */
  viewportHeight: number;
}

/** Plain words for elements without a role. */
const TAG_WORDS: Record<string, string> = { a: 'link', area: 'link', button: 'button', select: 'select', textarea: 'textarea', summary: 'summary', iframe: 'iframe', video: 'video', audio: 'audio' };

const clip = (s: string | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * The forward Tab order of a traversal. Leaves out moments focus was on nothing or taken away by a
 * script, and stops hidden when focused (the rules report those); each element is listed once, at
 * its first stop.
 */
export function focusOrderData(t: Pick<Traversal, 'forward' | 'partial' | 'viewportHeight' | 'layout'>): FocusOrderData {
  const seen = new Set<number>();
  const flow = t.forward.filter((s) => s.id > 0 && !s.lost && !s.hidden && s.box && s.pageX !== undefined && s.pageY !== undefined);
  const firstMain = flow.findIndex((s) => s.inMain);
  const footerFirst = footerBeforeMain(flow.map((s) => ({ inMain: !!s.inMain, inFooter: !!s.inFooter, fixed: !!s.fixed })), t.layout) > 0;
  const stops: FocusOrderStop[] = [];
  let cycled = false;
  for (let i = 0; i < flow.length; i++) {
    const s = flow[i]!;
    if (seen.has(s.id)) {
      cycled = true;
      break;
    }
    seen.add(s.id);
    if (stops.length >= FOCUS_ORDER_MAX_STOPS) break;
    const what = s.role ? clip(s.role, 30)
      : s.tag === 'input' ? `input ${clip(s.itype ?? 'text', 20)}`
      : TAG_WORDS[s.tag ?? ''] ?? clip(s.tag ?? 'element', 30);
    const footerKnown = footerFirst && !!s.inFooter && !s.fixed && (firstMain < 0 || i < firstMain);
    stops.push({
      n: stops.length + 1,
      what,
      name: clip(s.name, 80),
      x: Math.round(s.pageX!),
      y: Math.round(s.pageY!),
      w: Math.round(s.box!.w),
      h: Math.round(s.box!.h),
      ...(s.region ? { region: s.region } : {}),
      ...(s.section ? { section: clip(s.section, 60) } : {}),
      ...(s.fixed ? { fixed: true as const } : {}),
      ...(s.frame ? { frame: true as const } : {}),
      ...(s.tabIndex && s.tabIndex > 0 ? { tabindex: s.tabIndex } : {}),
      ...((s.tabIndex && s.tabIndex > 0) || footerKnown ? { known: true as const } : {}),
    });
  }
  // A positive tabindex moves focus both to its element and away from it: the stop after it is the
  // same finding's other end.
  for (let i = 1; i < stops.length; i++) if (stops[i - 1]!.tabindex) stops[i]!.known = true;
  return { v: FOCUS_ORDER_DATA_VERSION, stops, partial: t.partial && !cycled, viewportHeight: Math.round(t.viewportHeight) };
}

/** The focus-order evidence in a keyboard run's data, validated; undefined when it has none or it is malformed. */
export function focusOrderFromData(data: unknown): FocusOrderData | undefined {
  const d = (data as { focusOrder?: unknown } | undefined)?.focusOrder as Record<string, unknown> | undefined;
  if (!d || typeof d !== 'object' || d.v !== FOCUS_ORDER_DATA_VERSION || !Array.isArray(d.stops)) return undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);
  const str = (v: unknown, n: number) => (typeof v === 'string' ? clip(v, n) : '');
  const stops: FocusOrderStop[] = [];
  for (const raw of d.stops.slice(0, FOCUS_ORDER_MAX_STOPS) as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object') return undefined;
    const x = num(raw.x), y = num(raw.y), w = num(raw.w), h = num(raw.h);
    if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined;
    const ti = num(raw.tabindex);
    stops.push({
      n: stops.length + 1, what: str(raw.what, 30) || 'element', name: str(raw.name, 80), x, y, w, h,
      ...(typeof raw.region === 'string' && raw.region ? { region: str(raw.region, 20) } : {}),
      ...(typeof raw.section === 'string' && raw.section ? { section: str(raw.section, 60) } : {}),
      ...(raw.fixed === true ? { fixed: true as const } : {}),
      ...(raw.frame === true ? { frame: true as const } : {}),
      ...(ti !== undefined && ti > 0 ? { tabindex: ti } : {}),
      ...(raw.known === true ? { known: true as const } : {}),
    });
  }
  return { v: FOCUS_ORDER_DATA_VERSION, stops, partial: d.partial === true, viewportHeight: num(d.viewportHeight) ?? 0 };
}
